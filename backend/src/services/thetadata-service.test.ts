import { ThetaDataService } from './thetadata-service';

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

function createService(fetchJson: (config: any, path: string) => Promise<any>) {
  const service = new ThetaDataService(createFastifyMock());
  (service as any).getConfig = async () => ({ baseUrl: 'http://127.0.0.1:25503' });
  (service as any).fetchJson = fetchJson;
  return service;
}

async function testNestedQuoteResponseParsesBidAsk() {
  const service = createService(async (_config, path) => {
    assert(path.startsWith('/v3/option/snapshot/quote?'), 'Should call the v3 option quote endpoint');
    return {
      response: [{
        contract: {
          symbol: 'QQQ',
          expiration: '2026-06-22',
          strike: 741,
          right: 'CALL'
        },
        data: [{
          bid: 3.6,
          ask: 3.68,
          timestamp: '2026-06-18T16:15:00.082'
        }]
      }]
    };
  });

  const quote = await service.getOptionQuote(null, {
    symbol: 'QQQ',
    expiration: '20260622',
    right: 'call',
    strike: 741
  });

  assert(quote !== null, 'Quote should parse from nested v3 response');
  assert(quote?.bid === 3.6, `Expected bid 3.6, got ${quote?.bid}`);
  assert(quote?.ask === 3.68, `Expected ask 3.68, got ${quote?.ask}`);
  assert(quote?.mark === 3.64, `Expected midpoint mark 3.64, got ${quote?.mark}`);
  assert(quote?.ticker === 'QQQ260622C00741000', `Expected OSI ticker, got ${quote?.ticker}`);
}

async function testChainUsesFirstOrderGreeksAndMergesOpenInterest() {
  const paths: string[] = [];
  const service = createService(async (_config, path) => {
    paths.push(path);
    if (path.startsWith('/v3/option/snapshot/greeks/first_order?')) {
      return {
        response: [{
          contract: {
            symbol: 'QQQ',
            expiration: '2026-06-22',
            strike: 741,
            right: 'CALL'
          },
          data: [{
            bid: 3.6,
            ask: 3.68,
            delta: 0.4674,
            theta: -0.543,
            vega: 30.7532,
            implied_vol: 0.132,
            timestamp: '2026-06-18T16:15:00.082'
          }]
        }]
      };
    }
    if (path.startsWith('/v3/option/snapshot/open_interest?')) {
      return {
        response: [{
          contract: {
            symbol: 'QQQ',
            expiration: '2026-06-22',
            strike: 741,
            right: 'CALL'
          },
          data: [{ open_interest: 842 }]
        }]
      };
    }
    if (path.startsWith('/v3/option/snapshot/ohlc?')) {
      return {
        response: [{
          contract: {
            symbol: 'QQQ',
            expiration: '2026-06-22',
            strike: 741,
            right: 'CALL'
          },
          data: [{
            open: 3.7,
            high: 3.82,
            low: 3.18,
            close: 3.64,
            volume: 1182,
            count: 244
          }]
        }]
      };
    }
    throw new Error(`Unexpected path ${path}`);
  });

  const chain = await service.getOptionChainSnapshot(null, 'QQQ', '20260622', 'call');

  assert(paths.some((path) => path.startsWith('/v3/option/snapshot/greeks/first_order?')), 'Should use Standard-compatible first-order Greeks endpoint');
  assert(paths.some((path) => path.startsWith('/v3/option/snapshot/open_interest?')), 'Should request open interest for merge');
  assert(paths.some((path) => path.startsWith('/v3/option/snapshot/ohlc?')), 'Should request OHLC snapshot for same-day volume');
  assert(chain.length === 1, `Expected one chain row, got ${chain.length}`);
  assert(chain[0].bid === 3.6, `Expected bid 3.6, got ${chain[0].bid}`);
  assert(chain[0].ask === 3.68, `Expected ask 3.68, got ${chain[0].ask}`);
  assert(chain[0].ticker === 'QQQ260622C00741000', `Expected OSI ticker, got ${chain[0].ticker}`);
  assert(chain[0].last === 3.64, `Expected last to use OHLC close 3.64, got ${chain[0].last}`);
  assert(chain[0].volume === 1182, `Expected volume 1182 from OHLC snapshot, got ${chain[0].volume}`);
  assert(chain[0].delta === 0.4674, `Expected delta 0.4674, got ${chain[0].delta}`);
  assert(chain[0].impliedVolatility === 0.132, `Expected IV 0.132, got ${chain[0].impliedVolatility}`);
  assert(chain[0].openInterest === 842, `Expected OI 842, got ${chain[0].openInterest}`);
}

async function testNestedOhlcResponseFlattensBars() {
  const service = createService(async (_config, path) => {
    assert(path.startsWith('/v3/option/history/ohlc?'), 'Should call the v3 option OHLC endpoint');
    assert(path.includes('start_date=20260618'), `Should use UTC start date 20260618, got ${path}`);
    assert(path.includes('end_date=20260618'), `Should use UTC end date 20260618, got ${path}`);
    return {
      response: [{
        contract: {
          symbol: 'QQQ',
          expiration: '2026-06-22',
          strike: 741,
          right: 'CALL'
        },
        data: [
          { timestamp: '2026-06-18T09:30:00.000', open: 3.7, high: 3.7, low: 3.17, close: 3.22, volume: 39 },
          { timestamp: '2026-06-18T09:31:00.000', open: 3.2, high: 3.3, low: 3.18, close: 3.18, volume: 6 }
        ]
      }]
    };
  });

  const candles = await service.getOptionOhlcHistory(
    null,
    { symbol: 'QQQ', expiration: '20260622', right: 'call', strike: 741 },
    new Date('2026-06-18T00:00:00Z'),
    new Date('2026-06-18T00:00:00Z'),
    '1m'
  );

  assert(candles.length === 2, `Expected two candles, got ${candles.length}`);
  assert(candles[0].start === '2026-06-18T09:30:00.000', `Unexpected first candle timestamp ${candles[0].start}`);
  assert(candles[1].close === 3.18, `Expected second close 3.18, got ${candles[1].close}`);
}

async function testBaseUrlNormalizesToIntegratedTerminal() {
  const service = createService(async () => ({}));
  const normalize = (value: string, env = '') => (service as any).normalizeBaseUrl(value, env);

  assert(normalize('http://thetadata:25503') === 'http://127.0.0.1:25503', 'Should normalize sidecar host to integrated backend terminal');
  assert(normalize('http://thetadata:25510') === 'http://127.0.0.1:25503', 'Should normalize old sidecar HTTP port to integrated backend terminal');
  assert(normalize('http://127.0.0.1:25510') === 'http://127.0.0.1:25503', 'Should normalize old local HTTP port');
  assert(normalize('http://127.0.0.1:25503', 'http://127.0.0.1:25503') === 'http://127.0.0.1:25503', 'Should keep integrated env URL');
}

async function runTests() {
  console.log('Running ThetaDataService v3 response tests...');
  await testNestedQuoteResponseParsesBidAsk();
  await testChainUsesFirstOrderGreeksAndMergesOpenInterest();
  await testNestedOhlcResponseFlattensBars();
  await testBaseUrlNormalizesToIntegratedTerminal();
  console.log('All ThetaDataService v3 response tests passed!');
}

runTests().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
