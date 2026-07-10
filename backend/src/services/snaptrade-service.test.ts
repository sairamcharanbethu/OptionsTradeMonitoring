import '@fastify/postgres';
import { SnaptradeService } from './snaptrade-service';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function createFastifyMock() {
  return {
    log: {
      info: () => {},
      warn: () => {},
      error: () => {}
    },
    pg: {
      query: async () => ({ rows: [] })
    }
  } as any;
}

function createFastifyMockWithQueries(handler: (sql: string, params?: any[]) => Promise<any>) {
  return {
    log: {
      info: () => {},
      warn: () => {},
      error: () => {}
    },
    pg: {
      query: handler
    }
  } as any;
}

async function testPlaceOptionOrderUsesSingleLegForceOrderPayload() {
  const service = new SnaptradeService(createFastifyMock());
  let forcePayload: any = null;
  let mlegCalled = false;

  (service as any).getSnaptradeClient = async () => ({
    userIdStr: 'snap-user',
    userSecret: 'snap-secret',
    snaptrade: {
      trading: {
        getOrderImpact: async () => {
          throw new Error('Impact should be skipped for manual speed path');
        },
        placeForceOrder: async (payload: any) => {
          forcePayload = payload;
          return { data: { brokerage_order_id: 'broker-order-1' } };
        },
        placeMlegOrder: async () => {
          mlegCalled = true;
          throw new Error('Multi-leg endpoint should not be used for single-leg option orders');
        }
      }
    }
  });

  const result = await service.placeOptionOrder(
    7,
    '7:ee576918-ffd1-4908-9cc5-ca2469759e83',
    'SPY260629C00737000',
    'BUY_TO_OPEN',
    1,
    'MARKET',
    undefined,
    { skipImpact: true }
  );

  assert(result.orderId === 'broker-order-1', 'Should return force-order brokerage order id');
  assert(mlegCalled === false, 'Should not call multi-leg order endpoint');
  assert(forcePayload.account_id === 'ee576918-ffd1-4908-9cc5-ca2469759e83', 'Should strip local user prefix from SnapTrade account id');
  assert(forcePayload.symbol === 'SPY   260629C00737000', `Should send OCC padded option symbol, got ${forcePayload.symbol}`);
  assert(forcePayload.universal_symbol_id === null, 'Should force symbol-based lookup instead of universal symbol id');
  assert(forcePayload.action === 'BUY_TO_OPEN', 'Should preserve option action');
  assert(forcePayload.order_type === 'Market', 'Should use SnapTrade force-order casing for market orders');
  assert(forcePayload.units === 1, 'Should send contract quantity');
}

async function testPlaceOptionOrderUsesLimitPriceForForceOrder() {
  const service = new SnaptradeService(createFastifyMock());
  let forcePayload: any = null;
  let impactCalled = false;

  (service as any).getSnaptradeClient = async () => ({
    userIdStr: 'snap-user',
    userSecret: 'snap-secret',
    snaptrade: {
      trading: {
        getOrderImpact: async () => {
          impactCalled = true;
          throw new Error('Impact preview should not run for OCC option symbol orders');
        },
        placeForceOrder: async (payload: any) => {
          forcePayload = payload;
          return { data: { brokerage_order_id: 'broker-order-2' } };
        }
      }
    }
  });

  await service.placeOptionOrder(
    7,
    'snaptrade-account',
    'QQQ260629P00738000',
    'SELL_TO_CLOSE',
    2,
    'LIMIT',
    '1.23'
  );

  assert(forcePayload.order_type === 'Limit', 'Should use SnapTrade force-order casing for limit orders');
  assert(forcePayload.price === 1.23, `Should send numeric limit price, got ${forcePayload.price}`);
  assert(forcePayload.symbol === 'QQQ   260629P00738000', `Should send OCC padded option symbol, got ${forcePayload.symbol}`);
  assert(impactCalled === false, 'Should skip impact preview for OCC option symbol orders');
}

async function testPlaceOptionOrderRejectsInvalidLimitPriceBeforeBrokerCall() {
  const service = new SnaptradeService(createFastifyMock());
  let forceCalled = false;

  (service as any).getSnaptradeClient = async () => ({
    userIdStr: 'snap-user',
    userSecret: 'snap-secret',
    snaptrade: {
      trading: {
        placeForceOrder: async () => {
          forceCalled = true;
          return { data: { brokerage_order_id: 'broker-order-3' } };
        }
      }
    }
  });

  let rejected = false;
  try {
    await service.placeOptionOrder(
      7,
      'snaptrade-account',
      'QQQ260629P00738000',
      'SELL_TO_CLOSE',
      2,
      'LIMIT',
      'not-a-price'
    );
  } catch (err: any) {
    rejected = /Limit price is required/.test(err.message || '');
  }

  assert(rejected, 'Should reject invalid limit price');
  assert(forceCalled === false, 'Should not call broker with invalid limit price');
}

async function testOrderStatusRepairsClosedAcceptedEntry() {
  const localClosedPosition = {
    id: 42,
    symbol: 'SPY',
    option_type: 'CALL',
    strike_price: 755,
    expiration_date: '2026-07-10',
    status: 'CLOSED',
    execution_status: 'ACCEPTED',
    broker_order_id: 'order-accepted',
    broker_trade_id: null,
    broker_exit_order_id: null,
    broker_exit_trade_id: null,
    account_id: '7:snap-account',
    execution_account_id: '7:snap-account',
    last_broker_order_status: 'ACCEPTED',
    last_broker_sync_at: null
  };
  let repaired = false as boolean;
  const service = new SnaptradeService(createFastifyMockWithQueries(async (sql: string) => {
    if (sql.includes('FROM positions') && sql.includes('broker_order_id = $2')) {
      return { rows: [localClosedPosition] };
    }
    if (sql.includes("key = 'snaptrade_trading_account_id'")) {
      return { rows: [{ value: '7:snap-account' }] };
    }
    if (sql.includes('FROM snaptrade_accounts')) {
      return { rows: [] };
    }
    if (sql.includes("SET status = 'PENDING_ORDER'")) {
      repaired = true;
      return { rows: [{ ...localClosedPosition, status: 'PENDING_ORDER', execution_status: 'ACCEPTED' }] };
    }
    return { rows: [] };
  }));

  (service as any).getSnaptradeClient = async () => ({
    userIdStr: 'snap-user',
    userSecret: 'snap-secret',
    snaptrade: {
      accountInformation: {
        getUserAccountRecentOrders: async () => ({
          data: [{
            brokerage_order_id: 'order-accepted',
            status: 'ACCEPTED',
            filled_quantity: 0,
            execution_price: null,
            time_executed: null,
            open_quantity: '1.00'
          }]
        })
      }
    }
  });

  const status = await service.getRecentOrderStatusById(7, 'order-accepted');
  assert(status.found === true, 'Should find accepted broker order');
  assert(status.status === 'ACCEPTED', `Expected ACCEPTED broker status, got ${status.status}`);
  assert(status.localPosition.status === 'PENDING_ORDER', `Expected local repair to PENDING_ORDER, got ${status.localPosition.status}`);
  assert(status.repairedLocalStatus === true, 'Should report local status repair');
  assert(repaired === true, 'Should update the local position');
}

async function runTests() {
  console.log('Running SnaptradeService order payload tests...');
  await testPlaceOptionOrderUsesSingleLegForceOrderPayload();
  await testPlaceOptionOrderUsesLimitPriceForForceOrder();
  await testPlaceOptionOrderRejectsInvalidLimitPriceBeforeBrokerCall();
  await testOrderStatusRepairsClosedAcceptedEntry();
  console.log('All SnaptradeService order payload tests passed!');
}

runTests().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
