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

async function testThetaDataMissingVolumeDoesNotRejectLiquidCandidate() {
  const scanner = createScanner();

  const result = scanner.fetchBestThetaDataOptionCandidate({
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

  assert(result.selected !== null, 'Missing ThetaData volume should be treated as unknown, not failed');
  assert(result.selected?.ticker === 'QQQ260622C00741000', `Expected selected contract, got ${result.selected?.ticker}`);
  assert(result.ranked[0].reasons.includes('volume unavailable'), 'Ranked candidate should explain unknown volume');
}

async function testThetaDataKnownLowVolumeStillRejectsCandidate() {
  const scanner = createScanner();

  const result = scanner.fetchBestThetaDataOptionCandidate({
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
}

async function testThetaDataPrefersUsefulDeltaOverExactOffset() {
  const scanner = createScanner();

  const result = scanner.fetchBestThetaDataOptionCandidate({
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

async function testThetaDataRejectsStaleOptionQuoteCandidate() {
  const scanner = createScanner();

  const result = scanner.fetchBestThetaDataOptionCandidate({
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

async function testThetaDataRejectsUnstableMarkLastCandidate() {
  const scanner = createScanner();

  const result = scanner.fetchBestThetaDataOptionCandidate({
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

async function testThetaDataRejectsHighSpreadCostCandidate() {
  const scanner = createScanner();

  const result = scanner.fetchBestThetaDataOptionCandidate({
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

async function testThetaDataRejectsHighThetaDragCandidate() {
  const scanner = createScanner();

  const result = scanner.fetchBestThetaDataOptionCandidate({
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
  const thetaData = {
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
    thetaData
  });
  const second = await scanner.getCachedOptionChainSnapshot({
    userId: 1,
    symbol: 'QQQ',
    expiration: '2026-06-22',
    side: 'CALL',
    windowKey: '2026-06-22:570',
    nowMs: 2_000,
    thetaData
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
  const thetaData = {
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
    thetaData
  });
  const refreshed = await scanner.getCachedOptionChainSnapshot({
    userId: 1,
    symbol: 'QQQ',
    expiration: '2026-06-22',
    side: 'CALL',
    windowKey: '2026-06-22:570',
    nowMs: 30_000,
    thetaData
  });

  assert(fetchCount === 2, `Expected stale cache to refetch, got ${fetchCount}`);
  assert(refreshed.cache.hit === false, 'Stale chain lookup should miss cache');
  assert(refreshed.chain[0].strike === 743, `Expected refreshed chain contents, got ${refreshed.chain[0].strike}`);
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
    maxBidAskSpreadPct: 12,
    minOptionVolume: 200,
    minOpenInterest: 500
  });

  assert(snapshot.version === 1, `Expected snapshot version 1, got ${snapshot.version}`);
  assert(snapshot.scanner.minSignalScore === 82, `Expected min signal score 82, got ${snapshot.scanner.minSignalScore}`);
  assert(snapshot.scanner.maxBidAskSpreadPct === 12, `Expected spread threshold 12, got ${snapshot.scanner.maxBidAskSpreadPct}`);
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
    maxBidAskSpreadPct: 12,
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
  await testThetaDataMissingVolumeDoesNotRejectLiquidCandidate();
  await testThetaDataKnownLowVolumeStillRejectsCandidate();
  await testThetaDataPrefersUsefulDeltaOverExactOffset();
  await testThetaDataRejectsStaleOptionQuoteCandidate();
  await testThetaDataRejectsUnstableMarkLastCandidate();
  await testThetaDataRejectsHighSpreadCostCandidate();
  await testThetaDataRejectsHighThetaDragCandidate();
  await testOptionChainCacheReusesSnapshotWithinWindow();
  await testOptionChainCacheIgnoresStaleSnapshotAfterTtl();
  await testScannerUsesOnlyCompletedCandles();
  await testMacroBlocksCallsWhenVixIsTooHighOrSpiking();
  await testMacroBlocksCallsWhenDxyAndTenYearRiseTogether();
  await testMacroRewardsRiskOnCallSetups();
  await testLottoDiagnosticsExplainScoreAndPricingPenalty();
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
