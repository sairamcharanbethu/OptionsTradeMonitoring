import '@fastify/postgres';
import { EventEmitter } from 'events';
import { IbkrMarketDataService } from './ibkr-market-data-service';

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
    }
  } as any;
}

async function testOsiTickerParsing() {
  const service = new IbkrMarketDataService(createFastifyMock());
  const parsed = service.parseCompactOsiTicker('SPY260706C00745000');

  assert(parsed !== null, 'Should parse compact OSI ticker');
  assert(parsed?.symbol === 'SPY', `Expected SPY symbol, got ${parsed?.symbol}`);
  assert(parsed?.expiration === '2026-07-06', `Expected normalized expiration, got ${parsed?.expiration}`);
  assert(parsed?.right === 'call', `Expected call side, got ${parsed?.right}`);
  assert(parsed?.strike === 745, `Expected strike 745, got ${parsed?.strike}`);
}

async function testQuoteNormalization() {
  const service = new IbkrMarketDataService(createFastifyMock());
  const quote = service.normalizeChainQuote({
    symbol: 'SPY',
    expiration: '2026-07-06',
    right: 'call',
    strike: 745
  }, {
    bid: 1.2,
    ask: 1.3,
    last: 1.25,
    volume: 1200,
    openInterest: 8000,
    delta: 0.48,
    gamma: 0.05,
    theta: -0.2,
    impliedVolatility: 0.18,
    timestamp: '2026-07-06T14:30:00.000Z'
  });

  assert(quote.source === 'ibkr_chain', `Expected IBKR chain source, got ${quote.source}`);
  assert(quote.ticker === 'SPY260706C00745000', `Expected OSI ticker, got ${quote.ticker}`);
  assert(quote.mark === 1.25, `Expected midpoint mark 1.25, got ${quote.mark}`);
  assert(quote.spread === 0.1, `Expected spread 0.1, got ${quote.spread}`);
  assert(quote.spreadPct === 8, `Expected spread pct 8, got ${quote.spreadPct}`);
  assert(quote.volume === 1200, `Expected volume 1200, got ${quote.volume}`);
  assert(quote.openInterest === 8000, `Expected OI 8000, got ${quote.openInterest}`);
}

async function testMissingBidAskIsNonExecutableState() {
  const service = new IbkrMarketDataService(createFastifyMock());
  const quote = service.normalizeChainQuote({
    symbol: 'SPY',
    expiration: '2026-07-06',
    right: 'put',
    strike: 745
  }, {
    last: 1.11,
    volume: 0,
    openInterest: 0
  });

  assert(quote.bid === null, 'Missing IBKR bid should remain null');
  assert(quote.ask === null, 'Missing IBKR ask should remain null');
  assert(quote.mark === 1.11, `Expected last-price mark 1.11, got ${quote.mark}`);
  assert(quote.spreadPct === null, 'Missing bid/ask should not invent spread pct');
}

async function testNoTickSnapshotResetsSharedConnection() {
  const service = new IbkrMarketDataService(createFastifyMock());
  const fakeIb = new EventEmitter() as any;
  let canceledReqId: number | null = null;
  let disconnectCount = 0;
  fakeIb.reqMktData = () => {};
  fakeIb.cancelMktData = (reqId: number) => {
    canceledReqId = reqId;
  };
  fakeIb.disconnect = () => {
    disconnectCount++;
  };

  (IbkrMarketDataService as any).sharedApi = fakeIb;
  (IbkrMarketDataService as any).connectedPromise = Promise.resolve();
  (IbkrMarketDataService as any).connectionKey = 'live:ib_gateway:4003:1';

  await (service as any).requestMarketData({}, '', 1, 'test no ticks');

  assert(canceledReqId !== null, 'No-tick snapshot should cancel market data request');
  assert(disconnectCount === 1, `No-tick snapshot should disconnect stale shared API, got ${disconnectCount}`);
  assert((IbkrMarketDataService as any).sharedApi === null, 'No-tick snapshot should clear shared API');
  assert((IbkrMarketDataService as any).connectedPromise === null, 'No-tick snapshot should clear connection promise');
}

async function runTests() {
  console.log('Running IbkrMarketDataService normalization tests...');
  await testOsiTickerParsing();
  await testQuoteNormalization();
  await testMissingBidAskIsNonExecutableState();
  await testNoTickSnapshotResetsSharedConnection();
  console.log('All IbkrMarketDataService normalization tests passed!');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
