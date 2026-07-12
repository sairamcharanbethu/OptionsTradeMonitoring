import '@fastify/postgres';
import '@fastify/websocket';
import { SignalScannerService } from './signal-scanner-service';

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

function createScanner() {
  return new SignalScannerService(createFastifyMock()) as any;
}

function macroSnapshot(overrides: Record<string, any>) {
  return {
    symbol: overrides.symbol || 'TEST',
    label: overrides.label || 'Test',
    value: overrides.value ?? null,
    previousClose: overrides.previousClose ?? null,
    changePct: overrides.changePct ?? null,
    changeBps: overrides.changeBps ?? null,
    source: 'test',
    error: null,
    ...overrides
  };
}

async function testVixTermStructureRequiresContango() {
  const scanner = createScanner();

  const strongContango = scanner.assessVixTermStructure(20, 22, 1.05);
  assert(strongContango.status === 'STRONG_CONTANGO', `Expected strong contango, got ${strongContango.status}`);
  assert(strongContango.ratio === 1.1, `Expected ratio 1.1, got ${strongContango.ratio}`);
  assert(strongContango.blocker === null, 'Strong contango should not block entries');

  const neutral = scanner.assessVixTermStructure(20, 20.4, 1.05);
  assert(neutral.status === 'NEUTRAL', `Expected neutral term structure, got ${neutral.status}`);
  assert(Boolean(neutral.blocker), 'Neutral term structure should block entries');

  const unavailable = scanner.assessVixTermStructure(20, null, 1.05);
  assert(unavailable.status === 'UNAVAILABLE', `Expected unavailable term structure, got ${unavailable.status}`);
  assert(Boolean(unavailable.blocker), 'Unavailable term structure should block entries');
}

async function testIBKRMissingVolumeDoesNotRejectLiquidCandidate() {
  const scanner = createScanner();

  const result = scanner.fetchBestIBKROptionCandidate({
    chain: [{
      ticker: 'QQQ260622C00741000',
      symbol: 'QQQ',
      expiration: '2026-06-22',
      right: 'CALL',
      strike: 741,
      bid: 3.6,
      ask: 3.68,
      mark: 3.64,
      spread: 0.08,
      spreadPct: 2.2,
      volume: null,
      openInterest: 842,
      last: null,
      delta: 0.4674,
      gamma: null,
      theta: -0.543,
      impliedVolatility: 0.132,
      timestamp: new Date().toISOString()
    }],
    candidates: [{
      ticker: 'QQQ260622C00741000',
      strike: 741,
      expiry: '2026-06-22'
    }],
    preferredStrike: 741,
    minOptionMark: 0.5,
    maxBidAskSpreadPct: 8,
    minOptionVolume: 200,
    minOpenInterest: 200
  });

  assert(result.selected !== null, 'Missing IBKR volume should be treated as unknown, not failed');
  assert(result.selected?.ticker === 'QQQ260622C00741000', `Expected selected contract, got ${result.selected?.ticker}`);
  assert(result.ranked[0].reasons.includes('volume unavailable'), 'Ranked candidate should explain unknown volume');
}

async function testIBKRKnownLowVolumeStillRejectsCandidate() {
  const scanner = createScanner();

  const result = scanner.fetchBestIBKROptionCandidate({
    chain: [{
      ticker: 'QQQ260622C00741000',
      symbol: 'QQQ',
      expiration: '2026-06-22',
      right: 'CALL',
      strike: 741,
      bid: 3.6,
      ask: 3.68,
      mark: 3.64,
      spread: 0.08,
      spreadPct: 2.2,
      volume: 25,
      openInterest: 842,
      last: null,
      delta: 0.4674,
      gamma: null,
      theta: -0.543,
      impliedVolatility: 0.132,
      timestamp: new Date().toISOString()
    }],
    candidates: [{
      ticker: 'QQQ260622C00741000',
      strike: 741,
      expiry: '2026-06-22'
    }],
    preferredStrike: 741,
    minOptionMark: 0.5,
    maxBidAskSpreadPct: 8,
    minOptionVolume: 200,
    minOpenInterest: 200
  });

  assert(result.selected === null, 'Known low volume should still reject the candidate');
  assert(result.ranked[0].reasons.includes('volume below 200'), 'Ranked candidate should explain low volume');
  assert(result.ranked[0].failedFilters.includes('volume below 200'), 'Failed filters should include low volume');
}

async function testIBKRStrongVolumeOffsetsMissingOpenInterest() {
  const scanner = createScanner();

  const result = scanner.fetchBestIBKROptionCandidate({
    chain: [{
      ticker: 'QQQ260622C00741000',
      symbol: 'QQQ',
      expiration: '2026-06-22',
      right: 'CALL',
      strike: 741,
      bid: 1.18,
      ask: 1.22,
      mark: 1.2,
      spread: 0.04,
      spreadPct: 3.3,
      volume: 900,
      openInterest: null,
      last: 1.2,
      delta: 0.45,
      gamma: null,
      theta: -0.2,
      impliedVolatility: 0.18,
      timestamp: new Date().toISOString()
    }],
    candidates: [{
      ticker: 'QQQ260622C00741000',
      strike: 741,
      expiry: '2026-06-22'
    }],
    preferredStrike: 741,
    minOptionMark: 0.5,
    maxBidAskSpreadPct: 8,
    minOptionVolume: 200,
    minOpenInterest: 500
  });

  assert(result.selected?.ticker === 'QQQ260622C00741000', `Expected strong-volume candidate, got ${result.selected?.ticker}`);
  assert(result.ranked[0].failedFilters.length === 0, `Expected no failed filters, got ${result.ranked[0].failedFilters.join(', ')}`);
  assert(result.ranked[0].reasons.includes('strong volume offsets open interest gap'), 'Ranked candidate should explain OI override');
}

async function testIBKRMissingOpenInterestRequiresStrongVolume() {
  const scanner = createScanner();

  const result = scanner.fetchBestIBKROptionCandidate({
    chain: [{
      ticker: 'QQQ260622C00741000',
      symbol: 'QQQ',
      expiration: '2026-06-22',
      right: 'CALL',
      strike: 741,
      bid: 1.18,
      ask: 1.22,
      mark: 1.2,
      spread: 0.04,
      spreadPct: 3.3,
      volume: 250,
      openInterest: null,
      last: 1.2,
      delta: 0.45,
      gamma: null,
      theta: -0.2,
      impliedVolatility: 0.18,
      timestamp: new Date().toISOString()
    }],
    candidates: [{
      ticker: 'QQQ260622C00741000',
      strike: 741,
      expiry: '2026-06-22'
    }],
    preferredStrike: 741,
    minOptionMark: 0.5,
    maxBidAskSpreadPct: 8,
    minOptionVolume: 200,
    minOpenInterest: 500
  });

  assert(result.selected === null, 'Missing OI with ordinary volume should reject the candidate');
  assert(result.ranked[0].failedFilters.some((reason: string) => reason.includes('OI unavailable')), 'Failed filters should explain missing OI');
}

async function testIBKRPrefersUsefulDeltaOverExactOffset() {
  const scanner = createScanner();

  const result = scanner.fetchBestIBKROptionCandidate({
    chain: [
      {
        ticker: 'QQQ260622C00741000',
        symbol: 'QQQ',
        expiration: '2026-06-22',
        right: 'CALL',
        strike: 741,
        bid: 1.18,
        ask: 1.22,
        mark: 1.20,
        spread: 0.04,
        spreadPct: 3.3,
        volume: 1400,
        openInterest: 2500,
        last: null,
        delta: 0.12,
        gamma: null,
        theta: -0.28,
        impliedVolatility: 0.18,
        timestamp: new Date().toISOString()
      },
      {
        ticker: 'QQQ260622C00742000',
        symbol: 'QQQ',
        expiration: '2026-06-22',
        right: 'CALL',
        strike: 742,
        bid: 1.16,
        ask: 1.20,
        mark: 1.18,
        spread: 0.04,
        spreadPct: 3.4,
        volume: 1300,
        openInterest: 2400,
        last: null,
        delta: 0.45,
        gamma: null,
        theta: -0.31,
        impliedVolatility: 0.18,
        timestamp: new Date().toISOString()
      }
    ],
    candidates: [
      {
        ticker: 'QQQ260622C00741000',
        strike: 741,
        expiry: '2026-06-22'
      },
      {
        ticker: 'QQQ260622C00742000',
        strike: 742,
        expiry: '2026-06-22'
      }
    ],
    preferredStrike: 741,
    minOptionMark: 0.5,
    maxBidAskSpreadPct: 8,
    minOptionVolume: 200,
    minOpenInterest: 200
  });

  assert(result.selected?.ticker === 'QQQ260622C00742000', `Expected useful-delta contract, got ${result.selected?.ticker}`);
  assert(result.ranked[0].reasons.includes('delta in quick-profit band'), 'Selected candidate should explain useful delta');
  assert(result.ranked[1].reasons.includes('delta too low 0.12'), 'Rejected candidate should explain weak delta');
}

async function testIBKRRejectsStaleOptionQuoteCandidate() {
  const scanner = createScanner();

  const result = scanner.fetchBestIBKROptionCandidate({
    chain: [{
      ticker: 'QQQ260622C00741000',
      symbol: 'QQQ',
      expiration: '2026-06-22',
      right: 'CALL',
      strike: 741,
      bid: 1.18,
      ask: 1.22,
      mark: 1.20,
      spread: 0.04,
      spreadPct: 3.3,
      volume: 1400,
      openInterest: 2500,
      last: 1.19,
      delta: 0.45,
      gamma: null,
      theta: -0.2,
      impliedVolatility: 0.18,
      timestamp: new Date(Date.now() - 20_000).toISOString()
    }],
    candidates: [{
      ticker: 'QQQ260622C00741000',
      strike: 741,
      expiry: '2026-06-22'
    }],
    preferredStrike: 741,
    minOptionMark: 0.5,
    maxBidAskSpreadPct: 8,
    minOptionVolume: 200,
    minOpenInterest: 200
  });

  assert(result.selected === null, 'Stale option quote should not be auto-selected');
  assert(result.ranked[0].reasons.some((reason: string) => reason.includes('stale quote')), 'Ranked candidate should explain stale quote');
}

async function testIBKRRejectsUnstableMarkLastCandidate() {
  const scanner = createScanner();

  const result = scanner.fetchBestIBKROptionCandidate({
    chain: [{
      ticker: 'QQQ260622C00741000',
      symbol: 'QQQ',
      expiration: '2026-06-22',
      right: 'CALL',
      strike: 741,
      bid: 1.18,
      ask: 1.22,
      mark: 1.20,
      spread: 0.04,
      spreadPct: 3.3,
      volume: 1400,
      openInterest: 2500,
      last: 0.95,
      delta: 0.45,
      gamma: null,
      theta: -0.2,
      impliedVolatility: 0.18,
      timestamp: new Date().toISOString()
    }],
    candidates: [{
      ticker: 'QQQ260622C00741000',
      strike: 741,
      expiry: '2026-06-22'
    }],
    preferredStrike: 741,
    minOptionMark: 0.5,
    maxBidAskSpreadPct: 8,
    minOptionVolume: 200,
    minOpenInterest: 200
  });

  assert(result.selected === null, 'Unstable mark/last quote should not be auto-selected');
  assert(result.ranked[0].reasons.some((reason: string) => reason.includes('unstable mark/last')), 'Ranked candidate should explain mark/last instability');
}

async function testIBKRRejectsHighSpreadCostCandidate() {
  const scanner = createScanner();

  const result = scanner.fetchBestIBKROptionCandidate({
    chain: [{
      ticker: 'QQQ260622C00741000',
      symbol: 'QQQ',
      expiration: '2026-06-22',
      right: 'CALL',
      strike: 741,
      bid: 4.8,
      ask: 5.2,
      mark: 5,
      spread: 0.4,
      spreadPct: 8,
      volume: 1400,
      openInterest: 2500,
      last: 5,
      delta: 0.45,
      gamma: null,
      theta: -0.4,
      impliedVolatility: 0.18,
      timestamp: new Date().toISOString()
    }],
    candidates: [{
      ticker: 'QQQ260622C00741000',
      strike: 741,
      expiry: '2026-06-22'
    }],
    preferredStrike: 741,
    minOptionMark: 0.5,
    maxBidAskSpreadPct: 8,
    minOptionVolume: 200,
    minOpenInterest: 200
  });

  assert(result.selected === null, 'High dollar spread cost should not be auto-selected');
  assert(result.ranked[0].reasons.some((reason: string) => reason.includes('spread cost')), 'Ranked candidate should explain spread cost');
}

async function testIBKRRejectsHighThetaDragCandidate() {
  const scanner = createScanner();

  const result = scanner.fetchBestIBKROptionCandidate({
    chain: [{
      ticker: 'QQQ260622C00741000',
      symbol: 'QQQ',
      expiration: '2026-06-22',
      right: 'CALL',
      strike: 741,
      bid: 1.18,
      ask: 1.22,
      mark: 1.20,
      spread: 0.04,
      spreadPct: 3.3,
      volume: 1400,
      openInterest: 2500,
      last: 1.20,
      delta: 0.45,
      gamma: null,
      theta: -0.6,
      impliedVolatility: 0.18,
      timestamp: new Date().toISOString()
    }],
    candidates: [{
      ticker: 'QQQ260622C00741000',
      strike: 741,
      expiry: '2026-06-22'
    }],
    preferredStrike: 741,
    minOptionMark: 0.5,
    maxBidAskSpreadPct: 8,
    minOptionVolume: 200,
    minOpenInterest: 200
  });

  assert(result.selected === null, 'High theta drag should not be auto-selected');
  assert(result.ranked[0].reasons.some((reason: string) => reason.includes('theta drag')), 'Ranked candidate should explain theta drag');
}

async function testOptionChainCacheReusesSnapshotWithinWindow() {
  const scanner = createScanner();
  let fetchCount = 0;
  const marketData = {
    getOptionChainSnapshot: async () => {
      fetchCount++;
      return [{
        ticker: 'QQQ260622C00741000',
        symbol: 'QQQ',
        expiration: '2026-06-22',
        right: 'CALL',
        strike: 741,
        bid: 1.18,
        ask: 1.22,
        mark: 1.2,
        spread: 0.04,
        spreadPct: 3.3,
        volume: 1400,
        openInterest: 2500,
        last: 1.2,
        delta: 0.45,
        gamma: null,
        theta: -0.2,
        impliedVolatility: 0.18,
        timestamp: new Date().toISOString()
      }];
    }
  };

  const first = await scanner.getCachedOptionChainSnapshot({
    userId: 1,
    symbol: 'QQQ',
    expiration: '2026-06-22',
    side: 'CALL',
    windowKey: '2026-06-22:570',
    nowMs: 1_000,
    marketData
  });
  const second = await scanner.getCachedOptionChainSnapshot({
    userId: 1,
    symbol: 'QQQ',
    expiration: '2026-06-22',
    side: 'CALL',
    windowKey: '2026-06-22:570',
    nowMs: 2_000,
    marketData
  });

  assert(fetchCount === 1, `Expected one chain fetch within cache window, got ${fetchCount}`);
  assert(first.cache.hit === false, 'First chain lookup should miss cache');
  assert(second.cache.hit === true, 'Second chain lookup should hit cache');
  assert(second.cache.ageMs === 1000, `Expected 1000ms cache age, got ${second.cache.ageMs}`);
  assert(second.chain === first.chain, 'Cached chain should reuse the normalized snapshot object');
}

async function testOptionChainCacheIgnoresStaleSnapshotAfterTtl() {
  const scanner = createScanner();
  let fetchCount = 0;
  const marketData = {
    getOptionChainSnapshot: async () => {
      fetchCount++;
      return [{
        ticker: `QQQ260622C0074${fetchCount}000`,
        symbol: 'QQQ',
        expiration: '2026-06-22',
        right: 'CALL',
        strike: 741 + fetchCount,
        bid: 1.18,
        ask: 1.22,
        mark: 1.2,
        spread: 0.04,
        spreadPct: 3.3,
        volume: 1400,
        openInterest: 2500,
        last: 1.2,
        delta: 0.45,
        gamma: null,
        theta: -0.2,
        impliedVolatility: 0.18,
        timestamp: new Date().toISOString()
      }];
    }
  };

  await scanner.getCachedOptionChainSnapshot({
    userId: 1,
    symbol: 'QQQ',
    expiration: '2026-06-22',
    side: 'CALL',
    windowKey: '2026-06-22:570',
    nowMs: 1_000,
    marketData
  });
  const refreshed = await scanner.getCachedOptionChainSnapshot({
    userId: 1,
    symbol: 'QQQ',
    expiration: '2026-06-22',
    side: 'CALL',
    windowKey: '2026-06-22:570',
    nowMs: 30_000,
    marketData
  });

  assert(fetchCount === 2, `Expected stale cache to refetch, got ${fetchCount}`);
  assert(refreshed.cache.hit === false, 'Stale chain lookup should miss cache');
  assert(refreshed.chain[0].strike === 743, `Expected refreshed chain contents, got ${refreshed.chain[0].strike}`);
}

async function testOptionChainCacheBypassesSnapshotOnForceRefresh() {
  const scanner = createScanner();
  let fetchCount = 0;
  const marketData = {
    getOptionChainSnapshot: async () => {
      fetchCount++;
      return [{
        ticker: `QQQ260622C0074${fetchCount}000`,
        symbol: 'QQQ',
        expiration: '2026-06-22',
        right: 'CALL',
        strike: 741 + fetchCount,
        bid: 1.18,
        ask: 1.22,
        mark: 1.2,
        spread: 0.04,
        spreadPct: 3.3,
        volume: 1400,
        openInterest: 2500,
        last: 1.2,
        delta: 0.45,
        gamma: null,
        theta: -0.2,
        impliedVolatility: 0.18,
        timestamp: new Date().toISOString()
      }];
    }
  };

  await scanner.getCachedOptionChainSnapshot({
    userId: 1,
    symbol: 'QQQ',
    expiration: '2026-06-22',
    side: 'CALL',
    windowKey: '2026-06-22:570',
    nowMs: 1_000,
    marketData
  });
  const refreshed = await scanner.getCachedOptionChainSnapshot({
    userId: 1,
    symbol: 'QQQ',
    expiration: '2026-06-22',
    side: 'CALL',
    windowKey: '2026-06-22:570',
    forceRefresh: true,
    nowMs: 2_000,
    marketData
  });

  assert(fetchCount === 2, `Expected force refresh to bypass cache, got ${fetchCount} fetch(es)`);
  assert(refreshed.cache.hit === false, 'Force-refreshed chain lookup should miss cache');
  assert(refreshed.chain[0].strike === 743, `Expected forced refresh chain contents, got ${refreshed.chain[0].strike}`);
}

async function testScannerUsesOnlyCompletedCandles() {
  const scanner = createScanner();
  const candles = [
    {
      datetime: '2026-06-22T13:40:00.000Z',
      nyDateStr: '2026-06-22',
      isRTH: true,
      open: 100,
      high: 101,
      low: 99,
      close: 100.5,
      volume: 1000,
      timestamp: Date.parse('2026-06-22T13:40:00.000Z') / 1000
    },
    {
      datetime: '2026-06-22T13:45:00.000Z',
      nyDateStr: '2026-06-22',
      isRTH: true,
      open: 100.5,
      high: 102,
      low: 100,
      close: 101.5,
      volume: 1200,
      timestamp: Date.parse('2026-06-22T13:45:00.000Z') / 1000
    }
  ];

  const beforeClose = scanner.getCompletedCandles(candles, new Date('2026-06-22T13:49:00.000Z'), 5);
  const afterClose = scanner.getCompletedCandles(candles, new Date('2026-06-22T13:50:00.000Z'), 5);

  assert(beforeClose.length === 1, `Expected 1 completed candle before 13:45 bar close, got ${beforeClose.length}`);
  assert(beforeClose[0].datetime === '2026-06-22T13:40:00.000Z', 'Should keep the last fully closed candle');
  assert(afterClose.length === 2, `Expected 2 completed candles after 13:45 bar close, got ${afterClose.length}`);
}

async function testScannerCandlesPreferAlpacaBarsWhenCredentialsExist() {
  const scanner = createScanner();
  let yahooCalled = false;
  const result = await scanner.fetchScannerCandles({
    symbol: 'QQQ',
    now: new Date('2026-06-22T14:00:00.000Z'),
    settings: {
      alpaca_key_id: 'key',
      alpaca_secret_key: 'secret'
    },
    alpacaGet: async () => ({
      data: {
        bars: {
          QQQ: [{
            t: '2026-06-22T13:55:00Z',
            o: 741,
            h: 742,
            l: 740.5,
            c: 741.5,
            v: 1000
          }]
        }
      }
    }),
    yahooChart: async () => {
      yahooCalled = true;
      return { quotes: [] };
    }
  });

  assert(result.source === 'alpaca', `Expected Alpaca candle source, got ${result.source}`);
  assert(result.candles.length === 1, `Expected one Alpaca candle, got ${result.candles.length}`);
  assert(result.candles[0].close === 741.5, `Expected Alpaca close 741.5, got ${result.candles[0].close}`);
  assert(yahooCalled === false, 'Yahoo fallback should not run when Alpaca bars are usable');
}

async function testScannerCandlesUseAlpacaEnvCredentialsFallback() {
  const scanner = createScanner();
  const previousKey = process.env.ALPACA_KEY;
  const previousSecret = process.env.ALPACA_SECRET;
  process.env.ALPACA_KEY = 'env-key';
  process.env.ALPACA_SECRET = 'env-secret';

  try {
    let receivedKey = '';
    let receivedSecret = '';
    const result = await scanner.fetchScannerCandles({
      symbol: 'QQQ',
      now: new Date('2026-06-22T14:00:00.000Z'),
      settings: {},
      alpacaGet: async (_url: string, options: any) => {
        receivedKey = options.headers['APCA-API-KEY-ID'];
        receivedSecret = options.headers['APCA-API-SECRET-KEY'];
        return {
          data: {
            bars: {
              QQQ: [{
                t: '2026-06-22T13:55:00Z',
                o: 741,
                h: 742,
                l: 740.5,
                c: 741.5,
                v: 1000
              }]
            }
          }
        };
      },
      yahooChart: async () => ({ quotes: [] })
    });

    assert(result.source === 'alpaca', `Expected Alpaca env candle source, got ${result.source}`);
    assert(receivedKey === 'env-key', `Expected env Alpaca key, got ${receivedKey}`);
    assert(receivedSecret === 'env-secret', `Expected env Alpaca secret, got ${receivedSecret}`);
  } finally {
    if (previousKey === undefined) delete process.env.ALPACA_KEY;
    else process.env.ALPACA_KEY = previousKey;
    if (previousSecret === undefined) delete process.env.ALPACA_SECRET;
    else process.env.ALPACA_SECRET = previousSecret;
  }
}

async function testScannerAlpacaSettingsCredentialsBeatEnvCredentials() {
  const scanner = createScanner();
  const previousKey = process.env.ALPACA_KEY;
  const previousSecret = process.env.ALPACA_SECRET;
  process.env.ALPACA_KEY = 'env-key';
  process.env.ALPACA_SECRET = 'env-secret';

  try {
    const credentials = scanner.getAlpacaMarketDataCredentials({
      alpaca_key_id: 'settings-key',
      alpaca_secret_key: 'settings-secret'
    });

    assert(credentials.source === 'settings', `Expected settings credential source, got ${credentials.source}`);
    assert(credentials.keyId === 'settings-key', `Expected settings key, got ${credentials.keyId}`);
    assert(credentials.secretKey === 'settings-secret', `Expected settings secret, got ${credentials.secretKey}`);
  } finally {
    if (previousKey === undefined) delete process.env.ALPACA_KEY;
    else process.env.ALPACA_KEY = previousKey;
    if (previousSecret === undefined) delete process.env.ALPACA_SECRET;
    else process.env.ALPACA_SECRET = previousSecret;
  }
}

async function testScannerCandlesFallbackToYahooWhenAlpacaFails() {
  const scanner = createScanner();
  const result = await scanner.fetchScannerCandles({
    symbol: 'QQQ',
    now: new Date('2026-06-22T14:00:00.000Z'),
    settings: {
      alpaca_key_id: 'key',
      alpaca_secret_key: 'secret'
    },
    alpacaGet: async () => {
      throw new Error('alpaca unavailable');
    },
    yahooChart: async () => ({
      quotes: [{
        date: new Date('2026-06-22T13:55:00.000Z'),
        open: 741,
        high: 742,
        low: 740.5,
        close: 741.4,
        volume: 1000
      }]
    })
  });

  assert(result.source === 'yahoo', `Expected Yahoo fallback source, got ${result.source}`);
  assert(result.fallbackReason.includes('alpaca unavailable'), `Expected Alpaca failure reason, got ${result.fallbackReason}`);
  assert(result.candles[0].close === 741.4, `Expected Yahoo close 741.4, got ${result.candles[0].close}`);
}

async function testStaleScannerCandlesProduceBlocker() {
  const scanner = createScanner();
  const candle = {
    datetime: '2026-06-22T13:30:00.000Z',
    nyDateStr: '2026-06-22',
    isRTH: true,
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 1000,
    timestamp: Date.parse('2026-06-22T13:30:00.000Z') / 1000
  };
  const freshnessMs = scanner.getCandleFreshnessMs(candle, new Date('2026-06-22T14:00:00.000Z'));
  const blocker = scanner.getCandleFreshnessBlocker({ source: 'yahoo', freshnessMs });

  assert(freshnessMs === 25 * 60 * 1000, `Expected 25m candle freshness after bar close, got ${freshnessMs}`);
  assert(blocker?.includes('Candle data stale from yahoo'), `Expected stale candle blocker, got ${blocker}`);
}

async function testCompletedFiveMinuteCandleWithinCurrentWindowIsFresh() {
  const scanner = createScanner();
  const candle = {
    datetime: '2026-06-22T13:45:00.000Z',
    nyDateStr: '2026-06-22',
    isRTH: true,
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 1000,
    timestamp: Date.parse('2026-06-22T13:45:00.000Z') / 1000
  };
  const freshnessMs = scanner.getCandleFreshnessMs(candle, new Date('2026-06-22T13:52:52.000Z'));
  const blocker = scanner.getCandleFreshnessBlocker({ source: 'ibkr', freshnessMs });

  assert(freshnessMs === 172 * 1000, `Expected 172s candle freshness after bar close, got ${freshnessMs}`);
  assert(blocker === null, `Expected 172s completed candle freshness to be allowed, got ${blocker}`);
}

async function testScannerCycleContextUsesFixedClock() {
  const scanner = createScanner();
  const cycle = scanner.buildScannerCycleContext({
    userId: 7,
    symbols: ['QQQ', 'SPY'],
    settings: {
      trading_start_time: '09:30',
      trading_cutoff_time: '16:00'
    },
    force: true,
    now: new Date('2026-06-22T17:45:00.000Z')
  });

  assert(cycle.startedAt === '2026-06-22T17:45:00.000Z', `Expected fixed cycle start, got ${cycle.startedAt}`);
  assert(cycle.nyParts.dateStr === '2026-06-22', `Expected NY date 2026-06-22, got ${cycle.nyParts.dateStr}`);
  assert(cycle.nyParts.minutes === 13 * 60 + 45, `Expected 13:45 ET, got ${cycle.nyParts.minutes}`);
  assert(cycle.marketPhase === 'OPEN', `Expected OPEN market phase, got ${cycle.marketPhase}`);
  assert(cycle.symbols.join(',') === 'QQQ,SPY', 'Cycle should freeze the selected symbol list');
  assert(Boolean(cycle.cycleId), 'Cycle should include an audit id');
}

async function testFixedClockDrivesExpiryAndAfternoonThreshold() {
  const scanner = createScanner();
  const morningCycle = scanner.buildScannerCycleContext({
    userId: 1,
    symbols: ['QQQ'],
    settings: {
      trading_start_time: '09:30',
      trading_cutoff_time: '16:00'
    },
    now: new Date('2026-06-22T14:15:00.000Z')
  });
  const afternoonCycle = scanner.buildScannerCycleContext({
    userId: 1,
    symbols: ['QQQ'],
    settings: {
      trading_start_time: '09:30',
      trading_cutoff_time: '16:00'
    },
    now: new Date('2026-06-22T17:45:00.000Z')
  });
  const settings = { min_signal_score: '70' };
  const macroRegime = { thresholdAdjustment: 0 };

  const morningExpiry = scanner.getTargetDayTradeExpiry(morningCycle.nyParts.dateStr, morningCycle.nyParts.minutes);
  const afternoonExpiry = scanner.getTargetDayTradeExpiry(afternoonCycle.nyParts.dateStr, afternoonCycle.nyParts.minutes);
  const morningThreshold = scanner.getDynamicMinimumScore(settings, morningCycle.nyParts.minutes, macroRegime);
  const afternoonThreshold = scanner.getDynamicMinimumScore(settings, afternoonCycle.nyParts.minutes, macroRegime);

  assert(morningExpiry === '2026-06-22', `Expected morning 0DTE expiry, got ${morningExpiry}`);
  assert(afternoonExpiry === '2026-06-23', `Expected afternoon 1DTE expiry, got ${afternoonExpiry}`);
  assert(morningThreshold === 70, `Expected morning threshold 70, got ${morningThreshold}`);
  assert(afternoonThreshold === 85, `Expected afternoon threshold 85, got ${afternoonThreshold}`);
}

async function testFixedClockMacroAssessmentIsDeterministic() {
  const scanner = createScanner();
  const cycle = scanner.buildScannerCycleContext({
    userId: 1,
    symbols: ['QQQ'],
    settings: {
      trading_start_time: '09:30',
      trading_cutoff_time: '16:00'
    },
    now: new Date('2026-06-22T17:45:00.000Z')
  });
  const input = {
    winningSide: 'PUT',
    currentMinutes: cycle.nyParts.minutes,
    vix: macroSnapshot({ symbol: '^VIX', label: 'VIX', value: 17.5, previousClose: 18.4, changePct: -4.89 }),
    tenYear: macroSnapshot({ symbol: '^TNX', label: 'US 10Y', value: 42.8, previousClose: 43.2, changePct: -0.93, changeBps: -4 }),
    dxy: macroSnapshot({ symbol: 'DX-Y.NYB', label: 'DXY', value: 103.7, previousClose: 104.1, changePct: -0.38 }),
    oil: macroSnapshot({ symbol: 'CL=F', label: 'Oil', value: 77.6, previousClose: 77.8, changePct: -0.26 }),
    gold: macroSnapshot({ symbol: 'GC=F', label: 'Gold', value: 2329, previousClose: 2335, changePct: -0.26 })
  };

  const first = scanner.assessMacroRegime(input);
  const second = scanner.assessMacroRegime(input);

  assert(JSON.stringify(first) === JSON.stringify(second), 'Macro assessment should be deterministic for the same fixed clock inputs');
  assert(first.thresholdAdjustment === 8, `Expected mixed near-close macro threshold adjustment 8, got ${first.thresholdAdjustment}`);
  assert(first.warnings.some((item: string) => item.includes('Near close')), 'Near-close weak macro warning should be deterministic');
}

async function testScannerPhaseTimingEvidenceIsCapturedInDecisionSnapshot() {
  const scanner = createScanner();
  const cycle = scanner.buildScannerCycleContext({
    userId: 1,
    symbols: ['QQQ'],
    settings: {
      trading_start_time: '09:30',
      trading_cutoff_time: '16:00'
    },
    now: new Date('2026-06-22T14:15:00.000Z')
  });

  const result = await scanner.timeScannerPhase(cycle, 'QQQ.macro', async () => 'macro-ok');
  const snapshot = scanner.buildDecisionSnapshot({
    capturedAt: cycle.startedAt,
    cycle: scanner.getCycleSnapshot(cycle, 'QQQ'),
    symbol: 'QQQ',
    status: 'BLOCKED',
    marketDate: cycle.nyParts.marketDate,
    candle: { timestamp: '2026-06-22T14:10:00.000Z', close: 741.2 },
    configSnapshot: { version: 1, scanner: { minSignalScore: 70 } },
    macroSnapshot: { vixQuote: 17.5 },
    gexSnapshot: { regime: 'POSITIVE' },
    internals: { bullishCount: 2, bearishCount: 1 },
    scoring: { winningSide: 'CALL', winningScore: 71, dynamicMinScore: 80 },
    optionSelection: null,
    finalDecision: null,
    blockers: ['Best setup score 71 is below dynamic minimum 80']
  });

  assert(result === 'macro-ok', `Expected timed operation result, got ${result}`);
  assert(snapshot.cycle.phaseTimingsMs.macro >= 0, 'Decision snapshot should include macro phase timing evidence');
}

async function testScoringDiagnosticsStableForSameNormalizedInputs() {
  const scanner = createScanner();
  const macroRegime = scanner.assessMacroRegime({
    winningSide: 'CALL',
    currentMinutes: 10 * 60,
    vix: macroSnapshot({ symbol: '^VIX', label: 'VIX', value: 17.5, previousClose: 18.4, changePct: -4.89 }),
    tenYear: macroSnapshot({ symbol: '^TNX', label: 'US 10Y', value: 42.8, previousClose: 43.2, changePct: -0.93, changeBps: -4 }),
    dxy: macroSnapshot({ symbol: 'DX-Y.NYB', label: 'DXY', value: 103.7, previousClose: 104.1, changePct: -0.38 }),
    oil: macroSnapshot({ symbol: 'CL=F', label: 'Oil', value: 77.6, previousClose: 77.8, changePct: -0.26 }),
    gold: macroSnapshot({ symbol: 'GC=F', label: 'Gold', value: 2329, previousClose: 2335, changePct: -0.26 })
  });
  const input = {
    baseScore: 92,
    macroRegime,
    pricingWarnings: [],
    pricingPenalty: 0,
    executionRealism: {
      score: 94,
      executable: true,
      threshold: 70,
      reasons: ['Live quote, spread, and liquidity passed execution realism checks']
    },
    finalConfidence: 100,
    setupGrade: '🔥 A+ / FULL'
  };

  const first = scanner.buildSignalGradeDiagnostics(input);
  const second = scanner.buildSignalGradeDiagnostics(input);

  assert(JSON.stringify(first) === JSON.stringify(second), 'Scoring diagnostics should not change for the same normalized inputs');
  assert(first.gradeKey === 'A+', `Expected stable A+ grade key, got ${first.gradeKey}`);
}

async function testMacroBlocksCallsWhenVixIsTooHighOrSpiking() {
  const scanner = createScanner();

  const result = scanner.assessMacroRegime({
    winningSide: 'CALL',
    currentMinutes: 10 * 60,
    vix: macroSnapshot({ symbol: '^VIX', label: 'VIX', value: 31.5, previousClose: 26.8, changePct: 17.54 }),
    tenYear: macroSnapshot({ symbol: '^TNX', label: 'US 10Y', value: 43.2, previousClose: 43.1, changePct: 0.23, changeBps: 1 }),
    dxy: macroSnapshot({ symbol: 'DX-Y.NYB', label: 'DXY', value: 104.1, previousClose: 104.0, changePct: 0.1 }),
    oil: macroSnapshot({ symbol: 'CL=F', label: 'Oil', value: 78, previousClose: 77.8, changePct: 0.26 }),
    gold: macroSnapshot({ symbol: 'GC=F', label: 'Gold', value: 2340, previousClose: 2335, changePct: 0.21 })
  });

  assert(result.blockers.some((item: string) => item.includes('VIX')), 'High/spiking VIX should block bullish calls');
  assert(result.confidenceAdjustment < 0, 'High/spiking VIX should reduce confidence');
}

async function testMacroBlocksCallsWhenDxyAndTenYearRiseTogether() {
  const scanner = createScanner();

  const result = scanner.assessMacroRegime({
    winningSide: 'CALL',
    currentMinutes: 10 * 60 + 30,
    vix: macroSnapshot({ symbol: '^VIX', label: 'VIX', value: 18.2, previousClose: 18.1, changePct: 0.55 }),
    tenYear: macroSnapshot({ symbol: '^TNX', label: 'US 10Y', value: 43.7, previousClose: 43.1, changePct: 1.39, changeBps: 6 }),
    dxy: macroSnapshot({ symbol: 'DX-Y.NYB', label: 'DXY', value: 104.6, previousClose: 104.1, changePct: 0.48 }),
    oil: macroSnapshot({ symbol: 'CL=F', label: 'Oil', value: 78, previousClose: 77.8, changePct: 0.26 }),
    gold: macroSnapshot({ symbol: 'GC=F', label: 'Gold', value: 2340, previousClose: 2335, changePct: 0.21 })
  });

  assert(result.blockers.some((item: string) => item.includes('DXY') && item.includes('10Y')), 'DXY + 10Y risk-off combo should block bullish calls');
  assert(result.thresholdAdjustment > 0, 'Risk-off macro should tighten the entry threshold');
}

async function testMacroRewardsRiskOnCallSetups() {
  const scanner = createScanner();

  const result = scanner.assessMacroRegime({
    winningSide: 'CALL',
    currentMinutes: 10 * 60,
    vix: macroSnapshot({ symbol: '^VIX', label: 'VIX', value: 17.5, previousClose: 18.4, changePct: -4.89 }),
    tenYear: macroSnapshot({ symbol: '^TNX', label: 'US 10Y', value: 42.8, previousClose: 43.2, changePct: -0.93, changeBps: -4 }),
    dxy: macroSnapshot({ symbol: 'DX-Y.NYB', label: 'DXY', value: 103.7, previousClose: 104.1, changePct: -0.38 }),
    oil: macroSnapshot({ symbol: 'CL=F', label: 'Oil', value: 77.6, previousClose: 77.8, changePct: -0.26 }),
    gold: macroSnapshot({ symbol: 'GC=F', label: 'Gold', value: 2329, previousClose: 2335, changePct: -0.26 })
  });

  assert(result.blockers.length === 0, 'Supportive risk-on macro should not block calls');
  assert(result.directionBias === 'CALL', `Expected CALL macro bias, got ${result.directionBias}`);
  assert(result.confidenceAdjustment > 0, 'Supportive risk-on macro should improve confidence');
}

async function testLottoDiagnosticsExplainScoreAndPricingPenalty() {
  const scanner = createScanner();
  const macroRegime = {
    regime: 'NEUTRAL',
    score: 55,
    directionBias: 'MIXED',
    confidenceAdjustment: -4,
    thresholdAdjustment: 0,
    blockers: [],
    warnings: ['Macro mixed'],
    contributors: [],
    assets: {
      vix: macroSnapshot({ symbol: '^VIX', label: 'VIX', value: 18 }),
      tenYear: macroSnapshot({ symbol: '^TNX', label: 'US 10Y', value: 43 }),
      dxy: macroSnapshot({ symbol: 'DX-Y.NYB', label: 'DXY', value: 104 }),
      oil: macroSnapshot({ symbol: 'CL=F', label: 'Oil', value: 78 }),
      gold: macroSnapshot({ symbol: 'GC=F', label: 'Gold', value: 2340 })
    }
  };

  const diagnostics = scanner.buildSignalGradeDiagnostics({
    baseScore: 82,
    macroRegime,
    pricingWarnings: ['Spread 14% exceeds ceiling 8%'],
    pricingPenalty: scanner.getPricingWarningPenalty(['Spread 14% exceeds ceiling 8%']),
    executionRealism: scanner.buildExecutionRealismDiagnostics({
      mark: 1.1,
      spreadPct: 14,
      volume: 90,
      openInterest: 200,
      usingTheoreticalPricing: false,
      pricingWarnings: ['Spread 14% exceeds ceiling 8%']
    }),
    finalConfidence: 68,
    setupGrade: 'B / LOTTO'
  });

  assert(diagnostics.gradeKey === 'B', `Expected B grade key, got ${diagnostics.gradeKey}`);
  assert(diagnostics.executable === false, 'Lotto diagnostics should mark setup non-executable');
  assert(diagnostics.pricingPenalty === -10, `Expected one pricing warning to subtract 10, got ${diagnostics.pricingPenalty}`);
  assert(diagnostics.reasons.some((reason: string) => reason.includes('Lotto because confidence 68')), 'Should explain lotto confidence threshold');
  assert(diagnostics.pricingWarnings[0].includes('Spread'), 'Should preserve pricing warning detail');
  assert(diagnostics.executionRealism.score < diagnostics.executionRealism.threshold, 'Poor spread/liquidity should lower execution realism below threshold');
  assert(diagnostics.executionRealism.executable === false, 'Poor execution realism should be non-executable for live entry');
}

async function testRelatedMissingQuoteWarningsUseSingleCappedPenalty() {
  const scanner = createScanner();

  const penalty = scanner.getPricingWarningPenalty([
    'No usable live option quote selected',
    'No IBKR option candidate passed liquidity/spread filters'
  ]);

  assert(penalty === 20, `Expected missing live quote warnings to cap at 20, got ${penalty}`);
}

async function testLiveQuoteFallbackAfterChainRejectionUsesSmallPenalty() {
  const scanner = createScanner();

  const penalty = scanner.getPricingWarningPenalty([
    'No IBKR option candidate passed liquidity/spread filters'
  ]);

  assert(penalty === 5, `Expected live quote fallback after chain rejection to subtract 5, got ${penalty}`);
}

async function testChainRejectionBlocksExecutionGrade() {
  const scanner = createScanner();
  const macroRegime = scanner.assessMacroRegime({
    winningSide: 'CALL',
    currentMinutes: 10 * 60,
    vix: macroSnapshot({ symbol: '^VIX', label: 'VIX', value: 17.5, previousClose: 18.4, changePct: -4.89 }),
    tenYear: macroSnapshot({ symbol: '^TNX', label: 'US 10Y', value: 42.8, previousClose: 43.2, changePct: -0.93, changeBps: -4 }),
    dxy: macroSnapshot({ symbol: 'DX-Y.NYB', label: 'DXY', value: 103.7, previousClose: 104.1, changePct: -0.38 }),
    oil: macroSnapshot({ symbol: 'CL=F', label: 'Oil', value: 77.6, previousClose: 77.8, changePct: -0.26 }),
    gold: macroSnapshot({ symbol: 'GC=F', label: 'Gold', value: 2329, previousClose: 2335, changePct: -0.26 })
  });
  const executionRealism = scanner.buildExecutionRealismDiagnostics({
    mark: 1.2,
    spreadPct: 1,
    volume: 5000,
    openInterest: 8000,
    usingTheoreticalPricing: false,
    pricingWarnings: ['No IBKR option candidate passed liquidity/spread filters']
  });
  const executionBlockers = scanner.buildPricingExecutionBlockers({
    chainSelectionRejected: true,
    selectedQuoteAgeMs: null,
    selectedThetaDragPct: null,
    pricingWarnings: ['No IBKR option candidate passed liquidity/spread filters'],
    executionRealism
  });
  const diagnostics = scanner.buildSignalGradeDiagnostics({
    baseScore: 105,
    macroRegime,
    pricingWarnings: ['No IBKR option candidate passed liquidity/spread filters'],
    pricingPenalty: 5,
    executionRealism,
    executionBlockers,
    finalConfidence: 84,
    setupGrade: '🎲 B / LOTTO'
  });

  assert(executionBlockers.some((item: string) => item.includes('chain selection rejected')), `Expected chain rejection blocker, got ${executionBlockers.join(', ')}`);
  assert(diagnostics.executable === false, 'Chain rejection should make the grade non-executable');
  assert(diagnostics.blockers.some((item: string) => item.includes('auto-trading blocked')), `Expected grade blockers to include chain rejection, got ${diagnostics.blockers.join(', ')}`);
}

async function testStaleQuoteAndThetaDragBlockExecution() {
  const scanner = createScanner();
  const executionRealism = scanner.buildExecutionRealismDiagnostics({
    mark: 1.69,
    spreadPct: 0.59,
    volume: 1000,
    openInterest: 1000,
    usingTheoreticalPricing: false,
    pricingWarnings: ['Best rejected SPY260702C00750000: stale quote 14400s; theta drag 272.4%']
  });
  const blockers = scanner.buildPricingExecutionBlockers({
    chainSelectionRejected: false,
    selectedQuoteAgeMs: 16_000,
    selectedThetaDragPct: 196.3,
    pricingWarnings: ['Best rejected SPY260702C00750000: stale quote 14400s; theta drag 272.4%'],
    executionRealism
  });

  assert(blockers.some((item: string) => item.includes('stale')), `Expected stale quote blocker, got ${blockers.join(', ')}`);
  assert(blockers.some((item: string) => item.includes('theta drag')), `Expected theta drag blocker, got ${blockers.join(', ')}`);
}

async function testContractMismatchBlocksExecution() {
  const scanner = createScanner();

  const blockers = scanner.buildContractConsistencyBlockers({
    symbol: 'SPY',
    side: 'CALL',
    expiry: '2026-07-02',
    strike: 748,
    ticker: 'SPY260702C00749000'
  });

  assert(blockers.some((item: string) => item.includes('strike 749') && item.includes('selected strike 748')), `Expected strike mismatch blocker, got ${blockers.join(', ')}`);
}

async function testHighImpactEventBlocksZeroDteAutoTrading() {
  const scanner = createScanner();

  const zeroDteBlockers = scanner.buildEventRiskExecutionBlockers({
    marketDate: '2026-07-02',
    expiry: '2026-07-02'
  });
  const oneDteBlockers = scanner.buildEventRiskExecutionBlockers({
    marketDate: '2026-07-02',
    expiry: '2026-07-06'
  });

  assert(zeroDteBlockers.some((item: string) => item.includes('High-impact economic event')), `Expected 0DTE event blocker, got ${zeroDteBlockers.join(', ')}`);
  assert(oneDteBlockers.length === 0, `Expected no 1DTE event blocker, got ${oneDteBlockers.join(', ')}`);
}

async function testMeanReversionTrendBlockersRequireStrongerConfirmation() {
  const scanner = createScanner();
  const latestRed = {
    datetime: '2026-07-02T14:30:00.000Z',
    nyDateStr: '2026-07-02',
    isRTH: true,
    open: 748.5,
    high: 748.8,
    low: 747.6,
    close: 747.9,
    volume: 1000,
    timestamp: Date.parse('2026-07-02T14:30:00.000Z') / 1000
  };
  const previous = {
    datetime: '2026-07-02T14:25:00.000Z',
    nyDateStr: '2026-07-02',
    isRTH: true,
    open: 749.5,
    high: 749.8,
    low: 748.4,
    close: 748.6,
    volume: 1000,
    timestamp: Date.parse('2026-07-02T14:25:00.000Z') / 1000
  };

  const blockers = scanner.buildMeanReversionTrendBlockers({
    regime: 'MEAN_REVERSION',
    winningSide: 'CALL',
    currentPrice: 747.9,
    latest: latestRed,
    previous,
    emaShort: 748.2,
    emaLong: 749.4,
    openingRangeLow: 747.6,
    openingRangeHigh: 750,
  });

  assert(blockers.some((item: string) => item.includes('strong downtrend')), `Expected strong downtrend blocker, got ${blockers.join(', ')}`);
}

async function testVolumeAnomalyUsesTwentyCandleSmaAndStandardDeviation() {
  const scanner = createScanner();
  const baseTime = Date.parse('2026-07-02T13:30:00.000Z') / 1000;
  const candles = Array.from({ length: 20 }, (_, idx) => ({
    datetime: new Date((baseTime + idx * 300) * 1000).toISOString(),
    nyDateStr: '2026-07-02',
    isRTH: true,
    open: 748,
    high: 749,
    low: 747,
    close: 748.5,
    volume: idx % 2 === 0 ? 1000 : 1200,
    timestamp: baseTime + idx * 300
  }));
  const latest = {
    datetime: new Date((baseTime + 20 * 300) * 1000).toISOString(),
    nyDateStr: '2026-07-02',
    isRTH: true,
    open: 749,
    high: 750,
    low: 748.8,
    close: 749.8,
    volume: 1400,
    timestamp: baseTime + 20 * 300
  };

  const anomaly = scanner.computeVolumeAnomaly([...candles, latest], latest);

  assert(anomaly.sampleSize === 20, `Expected 20-candle volume baseline, got ${anomaly.sampleSize}`);
  assert(anomaly.sma === 1100, `Expected SMA20 1100, got ${anomaly.sma}`);
  assert(Math.abs(anomaly.stdev - 100) < 0.0001, `Expected stdev 100, got ${anomaly.stdev}`);
  assert(anomaly.threshold === 1250, `Expected RVOL threshold 1250, got ${anomaly.threshold}`);
  assert(anomaly.confirmed === true, 'Trigger volume above SMA20 + 1.5 stdev should confirm');

  const weakLatest = { ...latest, volume: 1249 };
  const weakAnomaly = scanner.computeVolumeAnomaly([...candles, weakLatest], weakLatest);
  assert(weakAnomaly.confirmed === false, 'Trigger volume below threshold should not confirm');
}

async function testVolumeAnomalyRequiresFullBaseline() {
  const scanner = createScanner();
  const baseTime = Date.parse('2026-07-02T13:30:00.000Z') / 1000;
  const candles = Array.from({ length: 8 }, (_, idx) => ({
    datetime: new Date((baseTime + idx * 300) * 1000).toISOString(),
    nyDateStr: '2026-07-02',
    isRTH: true,
    open: 748,
    high: 749,
    low: 747,
    close: 748.5,
    volume: 1000,
    timestamp: baseTime + idx * 300
  }));
  const latest = {
    datetime: new Date((baseTime + 8 * 300) * 1000).toISOString(),
    nyDateStr: '2026-07-02',
    isRTH: true,
    open: 749,
    high: 750,
    low: 748.8,
    close: 749.8,
    volume: 5000,
    timestamp: baseTime + 8 * 300
  };

  const anomaly = scanner.computeVolumeAnomaly([...candles, latest], latest);
  const blockers = scanner.buildStrictSetupModelBlockers({
    winningSide: 'CALL',
    currentPrice: 750,
    vwap: 749,
    emaShort: 749.4,
    emaLong: 748.9,
    latest,
    previous: candles[candles.length - 1],
    hasBullishVolumeBreakout: anomaly.confirmed,
    hasBearishVolumeBreakout: false,
    volumeAnomaly: anomaly,
    gexRegime: 'NEGATIVE',
    flowDirection: 'bullish',
    flipStrike: 749
  });

  assert(anomaly.sampleSize === 8, `Expected 8 baseline samples, got ${anomaly.sampleSize}`);
  assert(anomaly.confirmed === false, 'Insufficient baseline should not confirm volume anomaly');
  assert(blockers.some((item: string) => item.includes('20-candle RVOL baseline')), `Expected RVOL baseline blocker, got ${blockers.join(', ')}`);
}

async function testVolatilityGatewayBlocksSpyCompression() {
  const scanner = createScanner();

  const blockers = scanner.buildVolatilityCompressionBlockers({
    symbol: 'SPY',
    currentMinutes: 12 * 60,
    atr14: 0.12,
    currentPrice: 750,
    vixChangePct: -9.2
  });
  const qqqBlockers = scanner.buildVolatilityCompressionBlockers({
    symbol: 'QQQ',
    currentMinutes: 12 * 60,
    atr14: 0.12,
    currentPrice: 750,
    vixChangePct: -9.2
  });

  assert(blockers.some((item: string) => item.includes('SPY ATR14')), `Expected SPY ATR blocker, got ${blockers.join(', ')}`);
  assert(blockers.some((item: string) => item.includes('VIX compression')), `Expected VIX compression blocker, got ${blockers.join(', ')}`);
  assert(qqqBlockers.length === 0, `Expected QQQ to skip SPY-specific volatility gateway, got ${qqqBlockers.join(', ')}`);
}

async function testStrictSetupModelRequiresGammaEmaVolumeAndTrigger() {
  const scanner = createScanner();
  const previous = {
    datetime: '2026-07-02T14:25:00.000Z',
    nyDateStr: '2026-07-02',
    isRTH: true,
    open: 748.2,
    high: 748.8,
    low: 747.9,
    close: 748.4,
    volume: 1000,
    timestamp: Date.parse('2026-07-02T14:25:00.000Z') / 1000
  };
  const bullishLatest = {
    datetime: '2026-07-02T14:30:00.000Z',
    nyDateStr: '2026-07-02',
    isRTH: true,
    open: 748.6,
    high: 750.2,
    low: 748.5,
    close: 750,
    volume: 2200,
    timestamp: Date.parse('2026-07-02T14:30:00.000Z') / 1000
  };
  const bearishLatest = {
    datetime: '2026-07-02T14:30:00.000Z',
    nyDateStr: '2026-07-02',
    isRTH: true,
    open: 748.2,
    high: 748.3,
    low: 746.8,
    close: 747,
    volume: 2200,
    timestamp: Date.parse('2026-07-02T14:30:00.000Z') / 1000
  };

  const cleanCall = scanner.buildStrictSetupModelBlockers({
    winningSide: 'CALL',
    currentPrice: 750,
    vwap: 749,
    emaShort: 749.4,
    emaLong: 748.9,
    latest: bullishLatest,
    previous,
    hasBullishVolumeBreakout: true,
    hasBearishVolumeBreakout: false,
    gexRegime: 'NEGATIVE',
    flowDirection: 'bullish',
    flipStrike: 749
  });
  const missingCallVolume = scanner.buildStrictSetupModelBlockers({
    winningSide: 'CALL',
    currentPrice: 750,
    vwap: 749,
    emaShort: 749.4,
    emaLong: 748.9,
    latest: bullishLatest,
    previous,
    hasBullishVolumeBreakout: false,
    hasBearishVolumeBreakout: false,
    gexRegime: 'NEGATIVE',
    flowDirection: 'bullish',
    flipStrike: 749
  });
  const cleanPut = scanner.buildStrictSetupModelBlockers({
    winningSide: 'PUT',
    currentPrice: 747,
    vwap: 747.8,
    emaShort: 747.5,
    emaLong: 748.1,
    latest: bearishLatest,
    previous,
    hasBullishVolumeBreakout: false,
    hasBearishVolumeBreakout: true,
    gexRegime: 'NEGATIVE',
    flowDirection: 'bearish',
    flipStrike: 748
  });
  const badGammaCall = scanner.buildStrictSetupModelBlockers({
    winningSide: 'CALL',
    currentPrice: 747.93,
    vwap: 748.5,
    emaShort: 748.2,
    emaLong: 749.4,
    latest: bearishLatest,
    previous,
    hasBullishVolumeBreakout: false,
    hasBearishVolumeBreakout: true,
    gexRegime: 'POSITIVE',
    flowDirection: 'amplifying',
    flipStrike: 750
  });

  assert(cleanCall.length === 0, `Expected clean CALL strict setup, got ${cleanCall.join(', ')}`);
  assert(missingCallVolume.some((item: string) => item.includes('high-volume green')), `Expected CALL volume blocker, got ${missingCallVolume.join(', ')}`);
  assert(cleanPut.length === 0, `Expected clean PUT strict setup, got ${cleanPut.join(', ')}`);
  assert(badGammaCall.some((item: string) => item.includes('CALL requires bullish gamma')), `Expected CALL gamma blocker, got ${badGammaCall.join(', ')}`);
}

async function testMeanReversionRequiresEntryConfirmationForAutoExecution() {
  const scanner = createScanner();
  const callBlocked = scanner.buildAutoExecutionBlockers({
    tradeBias: 'BUY_CALL_ON_DIP',
    currentPrice: 747.93,
    entryTrigger: 749.79,
    executionBlockers: []
  });
  const callReclaimed = scanner.buildAutoExecutionBlockers({
    tradeBias: 'BUY_CALL_ON_DIP',
    currentPrice: 750,
    entryTrigger: 749.79,
    executionBlockers: []
  });
  const putBlocked = scanner.buildAutoExecutionBlockers({
    tradeBias: 'BUY_PUT_ON_RIP',
    currentPrice: 750.12,
    entryTrigger: 748.25,
    executionBlockers: []
  });
  const putBroken = scanner.buildAutoExecutionBlockers({
    tradeBias: 'BUY_PUT_ON_RIP',
    currentPrice: 748,
    entryTrigger: 748.25,
    executionBlockers: []
  });

  assert(callBlocked.some((item: string) => item.includes('has not reclaimed entry trigger')), `Expected reclaim blocker, got ${callBlocked.join(', ')}`);
  assert(callReclaimed.length === 0, `Expected no reclaim blocker after trigger reclaim, got ${callReclaimed.join(', ')}`);
  assert(putBlocked.some((item: string) => item.includes('has not broken entry trigger')), `Expected PUT break blocker, got ${putBlocked.join(', ')}`);
  assert(putBroken.length === 0, `Expected no PUT blocker after trigger break, got ${putBroken.join(', ')}`);
  assert(scanner.isEntryTriggerHit({ tradeBias: 'BUY_CALL_ON_DIP', price: 750, entryTrigger: 749.79 }) === true, 'CALL trigger should be hit after reclaim');
  assert(scanner.isEntryTriggerHit({ tradeBias: 'BUY_PUT_ON_RIP', price: 748, entryTrigger: 748.25 }) === true, 'PUT trigger should be hit after breakdown');
}

async function testGexProximityDeduplicatesCallWallAndKingNodeAtSameStrike() {
  const scanner = createScanner();

  const blockers = scanner.buildGexProximityBlockers({
    winningSide: 'CALL',
    currentPrice: 739.66,
    callWall: 740,
    putWall: null,
    kingNode: 740,
    floor: null,
    ceiling: null,
    regime: 'MEAN_REVERSION'
  });

  assert(blockers.length === 1, `Expected one combined GEX blocker, got ${blockers.length}`);
  assert(blockers[0].includes('Call Wall / King Node'), `Expected combined wall/node reason, got ${blockers[0]}`);
}

async function testExecutionRealismScoresCleanQuoteAsExecutable() {
  const scanner = createScanner();

  const diagnostics = scanner.buildExecutionRealismDiagnostics({
    mark: 1.25,
    spreadPct: 3,
    volume: 2500,
    openInterest: 4500,
    usingTheoreticalPricing: false,
    pricingWarnings: []
  });

  assert(diagnostics.score === 100, `Expected clean quote realism score 100, got ${diagnostics.score}`);
  assert(diagnostics.executable === true, 'Clean quote should pass execution realism');
  assert(diagnostics.reasons[0].includes('passed'), 'Clean quote should explain passed execution checks');
}

async function testSignalConfigSnapshotCapturesReplayAndExecutionSettings() {
  const scanner = createScanner();
  const snapshot = scanner.buildSignalConfigSnapshot({
    trading_start_time: '09:45',
    trading_cutoff_time: '15:45',
    min_signal_score: '82',
    strike_offset: '1',
    contracts_per_trade: '3',
    take_profit_pct: '18',
    max_trades_per_day: '4',
    execution_broker: 'wealthsimple_snaptrade',
    order_type: 'LIMIT',
    entry_slippage_pct: '4',
    alpaca_auto_trade_mode: 'instant',
    snaptrade_auto_trade: 'true'
  }, {
    minOptionMark: 0.3,
    maxBidAskSpreadPct: 5,
    minOptionVolume: 200,
    minOpenInterest: 500
  });

  assert(snapshot.version === 1, `Expected snapshot version 1, got ${snapshot.version}`);
  assert(snapshot.scanner.minSignalScore === 82, `Expected min signal score 82, got ${snapshot.scanner.minSignalScore}`);
  assert(snapshot.scanner.maxBidAskSpreadPct === 5, `Expected spread threshold 5, got ${snapshot.scanner.maxBidAskSpreadPct}`);
  assert(snapshot.replay.contractsPerTrade === 3, `Expected replay contracts 3, got ${snapshot.replay.contractsPerTrade}`);
  assert(snapshot.replay.takeProfitPct === 18, `Expected replay take profit 18, got ${snapshot.replay.takeProfitPct}`);
  assert(snapshot.execution.broker === 'wealthsimple_snaptrade', `Expected broker snapshot, got ${snapshot.execution.broker}`);
  assert(snapshot.execution.snaptradeAutoTrade === true, 'Expected SnapTrade auto trade snapshot');
}

async function testGeneratedDecisionSnapshotCapturesInputsImmutably() {
  const scanner = createScanner();
  const configSnapshot = scanner.buildSignalConfigSnapshot({
    min_signal_score: '82',
    strike_offset: '1',
    contracts_per_trade: '3',
    execution_broker: 'wealthsimple_snaptrade'
  }, {
    minOptionMark: 0.3,
    maxBidAskSpreadPct: 5,
    minOptionVolume: 200,
    minOpenInterest: 500
  });
  const macroSnapshot = {
    vixQuote: 17.5,
    macroRegime: {
      regime: 'RISK_ON',
      score: 74,
      directionBias: 'CALL',
      confidenceAdjustment: 8,
      thresholdAdjustment: 0,
      blockers: [],
      warnings: [],
      contributors: ['+10: VIX falling supports risk-on calls']
    }
  };
  const candidateSelection = {
    selectedScore: 122,
    candidates: [{ ticker: 'QQQ260622C00741000', strike: 741, score: 122 }]
  };

  const snapshot = scanner.buildDecisionSnapshot({
    symbol: 'QQQ',
    status: 'SIGNAL_GENERATED',
    marketDate: '06/22/2026',
    candle: { timestamp: '2026-06-22T14:30:00.000Z', close: 741.2 },
    configSnapshot,
    macroSnapshot,
    gexSnapshot: { regime: 'POSITIVE', flipStrike: 740, callWall: 745 },
    internals: { bullishCount: 2, bearishCount: 1, megaCaps: { AAPL: 0.2, MSFT: 0.4, NVDA: -0.1 } },
    scoring: {
      regime: 'MEAN_REVERSION',
      callScore: 91,
      putScore: 42,
      winningSide: 'CALL',
      winningScore: 91,
      dynamicMinScore: 82
    },
    optionSelection: { candidateSelection, pricingWarnings: [] },
    finalDecision: { finalConfidence: 99, setupGrade: 'A+ / FULL', tradeBias: 'BUY_CALL_ON_DIP' },
    blockers: []
  });

  configSnapshot.scanner.minSignalScore = 10;
  macroSnapshot.macroRegime.score = 1;
  candidateSelection.candidates[0].score = 1;

  assert(snapshot.version === 1, `Expected decision snapshot version 1, got ${snapshot.version}`);
  assert(snapshot.status === 'SIGNAL_GENERATED', `Expected generated status, got ${snapshot.status}`);
  assert(snapshot.configSnapshot.scanner.minSignalScore === 82, 'Decision snapshot should freeze config inputs');
  assert(snapshot.macroSnapshot.macroRegime.score === 74, 'Decision snapshot should freeze macro inputs');
  assert(snapshot.optionSelection.candidateSelection.candidates[0].score === 122, 'Decision snapshot should freeze option selection evidence');
  assert(snapshot.scoring.winningSide === 'CALL', 'Decision snapshot should capture scoring winner');
}

async function testBlockedDecisionSnapshotCapturesBlockersAndNoOptionSelection() {
  const scanner = createScanner();

  const snapshot = scanner.buildDecisionSnapshot({
    symbol: 'SPY',
    status: 'BLOCKED',
    marketDate: '06/22/2026',
    candle: { timestamp: '2026-06-22T14:35:00.000Z', close: 544.1 },
    configSnapshot: { version: 1, scanner: { minSignalScore: 90 } },
    macroSnapshot: { vixQuote: 31.4, macroRegime: { score: 20, directionBias: 'PUT' } },
    gexSnapshot: { regime: 'NEGATIVE' },
    internals: { bullishCount: 0, bearishCount: 3 },
    scoring: {
      regime: 'BREAKOUT',
      callScore: 78,
      putScore: 81,
      winningSide: 'PUT',
      winningScore: 81,
      dynamicMinScore: 95
    },
    optionSelection: null,
    finalDecision: null,
    blockers: ['Best setup score 81 is below dynamic minimum 95']
  });

  assert(snapshot.status === 'BLOCKED', `Expected blocked status, got ${snapshot.status}`);
  assert(snapshot.optionSelection === null, 'Blocked snapshot should not claim option selection evidence');
  assert(snapshot.finalDecision === null, 'Blocked snapshot should not claim final executable decision');
  assert(snapshot.blockers[0].includes('dynamic minimum'), 'Blocked snapshot should capture blockers');
  assert(snapshot.scoring.dynamicMinScore === 95, 'Blocked snapshot should capture dynamic threshold');
}

async function runTests() {
  console.log('Running SignalScannerService candidate and macro tests...');
  await testVixTermStructureRequiresContango();
  await testIBKRMissingVolumeDoesNotRejectLiquidCandidate();
  await testIBKRKnownLowVolumeStillRejectsCandidate();
  await testIBKRStrongVolumeOffsetsMissingOpenInterest();
  await testIBKRMissingOpenInterestRequiresStrongVolume();
  await testIBKRPrefersUsefulDeltaOverExactOffset();
  await testIBKRRejectsStaleOptionQuoteCandidate();
  await testIBKRRejectsUnstableMarkLastCandidate();
  await testIBKRRejectsHighSpreadCostCandidate();
  await testIBKRRejectsHighThetaDragCandidate();
  await testOptionChainCacheReusesSnapshotWithinWindow();
  await testOptionChainCacheIgnoresStaleSnapshotAfterTtl();
  await testOptionChainCacheBypassesSnapshotOnForceRefresh();
  await testScannerUsesOnlyCompletedCandles();
  await testScannerCandlesPreferAlpacaBarsWhenCredentialsExist();
  await testScannerCandlesUseAlpacaEnvCredentialsFallback();
  await testScannerAlpacaSettingsCredentialsBeatEnvCredentials();
  await testScannerCandlesFallbackToYahooWhenAlpacaFails();
  await testStaleScannerCandlesProduceBlocker();
  await testCompletedFiveMinuteCandleWithinCurrentWindowIsFresh();
  await testScannerCycleContextUsesFixedClock();
  await testFixedClockDrivesExpiryAndAfternoonThreshold();
  await testFixedClockMacroAssessmentIsDeterministic();
  await testScannerPhaseTimingEvidenceIsCapturedInDecisionSnapshot();
  await testScoringDiagnosticsStableForSameNormalizedInputs();
  await testMacroBlocksCallsWhenVixIsTooHighOrSpiking();
  await testMacroBlocksCallsWhenDxyAndTenYearRiseTogether();
  await testMacroRewardsRiskOnCallSetups();
  await testLottoDiagnosticsExplainScoreAndPricingPenalty();
  await testRelatedMissingQuoteWarningsUseSingleCappedPenalty();
  await testLiveQuoteFallbackAfterChainRejectionUsesSmallPenalty();
  await testChainRejectionBlocksExecutionGrade();
  await testStaleQuoteAndThetaDragBlockExecution();
  await testContractMismatchBlocksExecution();
  await testHighImpactEventBlocksZeroDteAutoTrading();
  await testMeanReversionTrendBlockersRequireStrongerConfirmation();
  await testVolumeAnomalyUsesTwentyCandleSmaAndStandardDeviation();
  await testVolumeAnomalyRequiresFullBaseline();
  await testVolatilityGatewayBlocksSpyCompression();
  await testStrictSetupModelRequiresGammaEmaVolumeAndTrigger();
  await testMeanReversionRequiresEntryConfirmationForAutoExecution();
  await testGexProximityDeduplicatesCallWallAndKingNodeAtSameStrike();
  await testExecutionRealismScoresCleanQuoteAsExecutable();
  await testSignalConfigSnapshotCapturesReplayAndExecutionSettings();
  await testGeneratedDecisionSnapshotCapturesInputsImmutably();
  await testBlockedDecisionSnapshotCapturesBlockersAndNoOptionSelection();
  console.log('All SignalScannerService candidate and macro tests passed!');
}

runTests().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
