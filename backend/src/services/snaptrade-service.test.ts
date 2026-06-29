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

async function runTests() {
  console.log('Running SnaptradeService order payload tests...');
  await testPlaceOptionOrderUsesSingleLegForceOrderPayload();
  await testPlaceOptionOrderUsesLimitPriceForForceOrder();
  await testPlaceOptionOrderRejectsInvalidLimitPriceBeforeBrokerCall();
  console.log('All SnaptradeService order payload tests passed!');
}

runTests().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
