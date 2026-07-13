import '@fastify/postgres';
import { IbkrMarketDataStreamService } from './ibkr-market-data-stream-service';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function createFastifyMock() {
  return {
    log: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {}
    },
    pg: {
      query: async () => ({ rows: [] })
    }
  } as any;
}

async function testOptionQuotePayloadShape() {
  const service = new IbkrMarketDataStreamService(createFastifyMock());
  let emitted: any = null;
  service.on('quote', (quote) => {
    emitted = quote;
  });

  (service as any).latestUnderlyingPrices.set('SPY', 754.88);

  (service as any).emitQuote({
    reqId: 80001,
    type: 'option',
    symbol: 'SPY260706C00745000',
    contract: { symbol: 'SPY', expiration: '2026-07-06', strike: 745, optionType: 'CALL' },
    snapshot: {
      bid: 1.2,
      ask: 1.3,
      last: 1.25,
      bidSize: 10,
      askSize: 12,
      delta: 0.48,
      gamma: 0.04,
      theta: -0.22,
      volatility: 0.19
    }
  });

  assert(emitted !== null, 'Should emit quote payload');
  assert(emitted.provider === 'ibkr', `Expected provider ibkr, got ${emitted.provider}`);
  assert(emitted.symbol === 'SPY260706C00745000', `Expected OSI symbol, got ${emitted.symbol}`);
  assert(emitted.bidPrice === 1.2, `Expected bid 1.2, got ${emitted.bidPrice}`);
  assert(emitted.askPrice === 1.3, `Expected ask 1.3, got ${emitted.askPrice}`);
  assert(emitted.price === 1.25, `Expected midpoint price 1.25, got ${emitted.price}`);
  assert(emitted.delta === 0.48, `Expected delta 0.48, got ${emitted.delta}`);
  assert(emitted.theta === -0.22, `Expected theta -0.22, got ${emitted.theta}`);
  assert(emitted.underlyingPrice === 754.88, `Expected latest underlying price, got ${emitted.underlyingPrice}`);
}

async function testFreshUnderlyingQuoteIsAvailableToHealthChecks() {
  const service = new IbkrMarketDataStreamService(createFastifyMock());
  (service as any).emitQuote({
    reqId: 80002,
    type: 'stock',
    symbol: 'SPY',
    snapshot: { bid: 749.10, ask: 749.20, last: 749.15 }
  });

  const quote = service.getLatestUnderlyingQuote('SPY');
  assert(quote !== null, 'Fresh SPY stream quote should be available');
  assert(quote?.mark === 749.15, `Expected SPY stream mark 749.15, got ${quote?.mark}`);
}

async function testContractKeyAndOsiSymbol() {
  const service = new IbkrMarketDataStreamService(createFastifyMock());
  const contract = (service as any).toStreamContract('spy', 745, 'CALL', '2026-07-06');
  assert((service as any).contractKey(contract) === 'SPY:20260706:CALL:745000', 'Should build stable contract key');
  assert((service as any).toOsiSymbol(contract) === 'SPY260706C00745000', 'Should build compact OSI ticker');
}

async function testTemporarySubscriptionsUseContractKeys() {
  const service = new IbkrMarketDataStreamService(createFastifyMock());
  const contract = (service as any).toStreamContract('SPY', 745, 'CALL', '2026-07-06');
  (service as any).temporaryContracts.set('client-a', contract);
  (service as any).temporaryContracts.set('client-b', contract);
  (service as any).rebuildActiveContracts();

  const activeContracts = (service as any).activeContracts as Map<string, any>;
  assert(activeContracts.size === 1, `Expected one active contract for duplicate temp subscriptions, got ${activeContracts.size}`);
  assert(activeContracts.has('SPY:20260706:CALL:745000'), 'Active temp contract should be keyed by contract key');

  (service as any).temporaryContracts.delete('client-a');
  (service as any).rebuildActiveContracts();
  assert(((service as any).activeContracts as Map<string, any>).size === 1, 'Removing one duplicate temp subscription should keep contract active');

  (service as any).temporaryContracts.delete('client-b');
  (service as any).rebuildActiveContracts();
  assert(((service as any).activeContracts as Map<string, any>).size === 0, 'Removing final temp subscription should clear active contract');
}

async function testDisconnectSchedulesReconnect() {
  const service = new IbkrMarketDataStreamService(createFastifyMock());
  let reconnectScheduleCount = 0;
  (service as any).isConnected = true;
  (service as any).connectedPromise = Promise.resolve();
  (service as any).scheduleReconnect = () => {
    reconnectScheduleCount++;
  };

  (service as any).handleDisconnected('test disconnect');

  assert((service as any).isConnected === false, 'Disconnect should mark stream disconnected');
  assert((service as any).connectedPromise === null, 'Disconnect should clear pending connection promise');
  assert((service as any).lastError === 'test disconnect', 'Disconnect should record reason');
  assert(reconnectScheduleCount === 1, `Disconnect should schedule reconnect once, got ${reconnectScheduleCount}`);
}

async function runTests() {
  console.log('Running IbkrMarketDataStreamService tests...');
  await testOptionQuotePayloadShape();
  await testFreshUnderlyingQuoteIsAvailableToHealthChecks();
  await testContractKeyAndOsiSymbol();
  await testTemporarySubscriptionsUseContractKeys();
  await testDisconnectSchedulesReconnect();
  console.log('All IbkrMarketDataStreamService tests passed!');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
