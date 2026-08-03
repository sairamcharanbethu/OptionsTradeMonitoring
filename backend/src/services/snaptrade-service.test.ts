import '@fastify/postgres';
import { SnaptradeService, SnapTradeRateLimitError } from './snaptrade-service';

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

async function testPlaceOptionOrderReturnsActionableRateLimitError() {
  const service = new SnaptradeService(createFastifyMock());

  (service as any).getSnaptradeClient = async () => ({
    userIdStr: 'snap-user',
    userSecret: 'snap-secret',
    snaptrade: {
      trading: {
        placeForceOrder: async () => {
          throw new Error('Request failed after 3 retries due to 429 (rate limit) errors.');
        }
      }
    }
  });

  let caught: any = null;
  try {
    await service.placeOptionOrder(
      7,
      'snaptrade-account',
      'SPY260731C00745000',
      'BUY_TO_OPEN',
      1,
      'LIMIT',
      '1.42'
    );
  } catch (err: any) {
    caught = err;
  }

  assert(caught instanceof SnapTradeRateLimitError, 'Should return a typed SnapTrade rate-limit error');
  assert(caught.statusCode === 429, `Should expose HTTP 429, got ${caught.statusCode}`);
  assert(caught.code === 'SNAPTRADE_RATE_LIMITED', `Should expose a stable error code, got ${caught.code}`);
  assert(caught.message.includes('Check Wealthsimple'), 'Should tell the trader to reconcile at Wealthsimple before retrying');
  assert(caught.message.includes('wait 60 seconds'), 'Should include the entry retry cooldown');
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

async function testPartialEntryRemainsPendingUntilRemainderIsResolved() {
  const position = {
    id: 77,
    user_id: 7,
    symbol: 'SPY',
    option_type: 'CALL',
    strike_price: 755,
    expiration_date: '2026-08-03',
    entry_price: 0.49,
    current_price: 0.49,
    quantity: 2,
    contracts_requested: 2,
    status: 'PENDING_ORDER',
    execution_status: 'ACCEPTED',
    execution_broker: 'wealthsimple_snaptrade',
    broker_order_id: 'partial-order',
    broker_trade_id: null,
    execution_account_id: '7:snap-account',
    account_id: '7:snap-account',
    entry_action: 'BUY_TO_OPEN'
  };
  let returnedPendingRows = false;
  let partialUpdate: any[] | null = null;
  const service = new SnaptradeService(createFastifyMockWithQueries(async (sql: string, params: any[] = []) => {
    if (sql.includes('FROM positions') && sql.includes("status = 'PENDING_ORDER'") && !returnedPendingRows) {
      returnedPendingRows = true;
      return { rows: [position] };
    }
    if (sql.includes("key = 'take_profit_pct'")) return { rows: [] };
    if (sql.includes("SET status = 'PENDING_ORDER'") && sql.includes("execution_status = 'PARTIALLY_FILLED'")) {
      partialUpdate = params;
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  }));
  (service as any).getSnaptradeClient = async () => ({
    userIdStr: 'snap-user',
    userSecret: 'snap-secret',
    snaptrade: {
      accountInformation: {
        getUserAccountRecentOrders: async () => ({
          data: [{
            brokerage_order_id: 'partial-order',
            status: 'PARTIALLY_FILLED',
            filled_quantity: 1,
            execution_price: 0.50
          }]
        })
      }
    }
  });

  const summary = await service.syncPendingBrokerOrders(7);
  const params = partialUpdate as unknown as any[];
  assert(Boolean(params), 'A partial entry must persist an explicit reconciliation state');
  assert(params[0] === 1 && params[1] === 0.5, `Expected one filled contract at $0.50, got ${JSON.stringify(params)}`);
  assert(summary.opened === 0 && summary.stillPending === 1, 'A working partial entry must not be treated as a fully open position');
  assert(summary.orders[0]?.action === 'partially_filled', 'A partial fill must be visible in broker reconciliation output');
}

async function testPartialExitDoesNotCloseRemainingPosition() {
  const position = {
    id: 78,
    user_id: 7,
    symbol: 'SPY',
    option_type: 'CALL',
    strike_price: 755,
    expiration_date: '2026-08-03',
    entry_price: 0.49,
    current_price: 0.60,
    quantity: 2,
    status: 'OPEN',
    execution_status: 'PENDING_EXIT',
    execution_broker: 'wealthsimple_snaptrade',
    broker_exit_order_id: 'partial-exit',
    execution_account_id: '7:snap-account',
    account_id: '7:snap-account',
    entry_action: 'BUY_TO_OPEN'
  };
  let returnedPendingRows = false;
  let partialExitUpdate: any[] | null = null;
  const service = new SnaptradeService(createFastifyMockWithQueries(async (sql: string, params: any[] = []) => {
    if (sql.includes('FROM positions') && sql.includes("status = 'PENDING_ORDER'") && !returnedPendingRows) {
      returnedPendingRows = true;
      return { rows: [position] };
    }
    if (sql.includes("key = 'take_profit_pct'")) return { rows: [] };
    if (sql.includes('SET execution_status = $1') && String(params[1] || '').includes('partially filled')) {
      partialExitUpdate = params;
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  }));
  (service as any).getSnaptradeClient = async () => ({
    userIdStr: 'snap-user',
    userSecret: 'snap-secret',
    snaptrade: {
      accountInformation: {
        getUserAccountRecentOrders: async () => ({
          data: [{
            brokerage_order_id: 'partial-exit',
            status: 'PARTIALLY_FILLED',
            filled_quantity: 1,
            execution_price: 0.61
          }]
        })
      }
    }
  });

  const summary = await service.syncPendingBrokerOrders(7);
  assert(Boolean(partialExitUpdate), 'A partial exit must retain an explicit pending-exit state');
  assert(summary.closed === 0 && summary.stillPending === 1, 'A partial exit must not close the remaining local position');
  assert(summary.orders[0]?.action === 'exit_partially_filled', 'A partial exit must be visible in broker reconciliation output');
}

async function runTests() {
  console.log('Running SnaptradeService order payload tests...');
  await testPlaceOptionOrderUsesSingleLegForceOrderPayload();
  await testPlaceOptionOrderUsesLimitPriceForForceOrder();
  await testPlaceOptionOrderRejectsInvalidLimitPriceBeforeBrokerCall();
  await testPlaceOptionOrderReturnsActionableRateLimitError();
  await testOrderStatusRepairsClosedAcceptedEntry();
  await testPartialEntryRemainsPendingUntilRemainderIsResolved();
  await testPartialExitDoesNotCloseRemainingPosition();
  console.log('All SnaptradeService order payload tests passed!');
}

runTests().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
