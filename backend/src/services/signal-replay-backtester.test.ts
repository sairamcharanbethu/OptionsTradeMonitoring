import '@fastify/postgres';
import { SignalReplayBacktester } from './signal-replay-backtester';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function createFastifyMock() {
  return {
    log: {
      warn: () => {},
      error: () => {},
      info: () => {}
    },
    pg: {
      query: async () => ({ rows: [] })
    }
  } as any;
}

function createBacktester() {
  return new SignalReplayBacktester(createFastifyMock()) as any;
}

function createDecision(overrides: Record<string, any> = {}) {
  return {
    signalId: 101,
    symbol: 'QQQ',
    side: 'CALL',
    createdAt: '2026-06-22T13:45:00.000Z',
    contract: {
      ticker: 'QQQ260622C00741000',
      strike: 741,
      expiry: '2026-06-22'
    },
    quote: {
      mark: 1,
      bid: 0.99,
      ask: 1.01,
      spreadPct: 2,
      volume: 500,
      openInterest: 1000,
      usingTheoreticalPricing: false
    },
    grade: {
      baseScore: 82,
      macroScore: 76,
      macroConfidenceAdjustment: 4,
      pricingPenalty: 0,
      finalConfidence: 91,
      setupGrade: 'A',
      gradeKey: 'A',
      executable: true,
      thresholds: {
        minExecutable: 70,
        minA: 85,
        minB: 70
      },
      reasons: ['strong setup'],
      warnings: [],
      blockers: [],
      pricingWarnings: []
    },
    ...overrides
  };
}

function createSignal(overrides: Record<string, any> = {}) {
  return {
    id: 101,
    symbol: 'QQQ',
    signal_type: 'CALL',
    confidence_score: 91,
    setup_grade: 'A',
    created_at: '2026-06-22T13:45:00.000Z',
    market_date: '2026-06-22',
    option_expiration_date: '2026-06-22',
    option_details: {
      ticker: 'QQQ260622C00741000',
      mark: 1,
      decision: createDecision()
    },
    volatility: {
      macroRegime: {
        score: 76,
        directionBias: 'CALL',
        blockers: []
      }
    },
    no_trade_reasons: [],
    ...overrides
  };
}

function createConfig(overrides: Record<string, any> = {}) {
  return {
    contractsPerTrade: 5,
    takeProfitPct: 12,
    stopLossPct: 20,
    maxTradesPerDay: 5,
    dailyProfitTarget: 400,
    dailyLossLimit: 100,
    interval: '1m',
    ...overrides
  };
}

function createReplayTrade(overrides: Record<string, any> = {}) {
  return {
    signalId: 301,
    date: '2026-06-22',
    symbol: 'QQQ',
    optionTicker: 'QQQ260622C00741000',
    side: 'CALL',
    setupGrade: 'A',
    confidenceScore: 91,
    macroRegime: {
      regime: 'RISK_ON',
      directionBias: 'CALL'
    },
    entryTime: '2026-06-22T13:45:00.000Z',
    exitTime: '2026-06-22T13:55:00.000Z',
    entryPrice: 1,
    exitPrice: 1.12,
    quantity: 5,
    pnl: 60,
    roiPct: 12,
    exitReason: 'TAKE_PROFIT',
    skippedBy: [],
    signalDecision: {
      gradeKey: 'A',
      executable: true,
      usingTheoreticalPricing: false,
      spreadPct: 2,
      spreadBucket: 'spread_tight_lte_5',
      delta: 0.45,
      deltaBucket: 'delta_core_35_60',
      quoteQuality: 'clean',
      pricingWarnings: [],
      warningTypes: ['no_warning'],
      blockers: []
    },
    ...overrides
  };
}

async function testTakeProfitUsesOptionOhlcTarget() {
  const backtester = createBacktester();
  const signal = createSignal();
  const contract = backtester.resolveContract(signal);
  const bars = [
    { start: '2026-06-22T13:45:00.000Z', open: 1, high: 1.05, low: 0.98, close: 1.01, volume: 100 },
    { start: '2026-06-22T13:46:00.000Z', open: 1.01, high: 1.14, low: 1, close: 1.12, volume: 200 }
  ];

  const trade = backtester.simulateTrade(signal, contract, bars, createConfig());

  assert(trade !== null, 'Trade should simulate');
  assert(trade.exitReason === 'TAKE_PROFIT', `Expected TAKE_PROFIT, got ${trade.exitReason}`);
  assert(trade.pnl === 60, `Expected $60 PnL for 5 contracts at 12%, got ${trade.pnl}`);
}

async function testAmbiguousBarUsesStopFirst() {
  const backtester = createBacktester();
  const signal = createSignal();
  const contract = backtester.resolveContract(signal);
  const bars = [
    { start: '2026-06-22T13:45:00.000Z', open: 1, high: 1.2, low: 0.75, close: 1.05, volume: 100 }
  ];

  const trade = backtester.simulateTrade(signal, contract, bars, createConfig());

  assert(trade !== null, 'Trade should simulate');
  assert(trade.exitReason === 'AMBIGUOUS_BAR_STOP_FIRST', `Expected conservative ambiguous stop, got ${trade.exitReason}`);
  assert(trade.pnl === -100, `Expected -$100 PnL for 5 contracts at 20% stop, got ${trade.pnl}`);
}

async function testMacroStrictSkipsWeakMacroScore() {
  const backtester = createBacktester();
  const signal = createSignal({
    volatility: {
      macroRegime: {
        score: 55,
        directionBias: 'CALL',
        blockers: []
      }
    }
  });

  assert(backtester.getScenarioSkipReason('baseline', signal) === null, 'Baseline should not macro-filter');
  assert(backtester.getScenarioSkipReason('macro_aligned', signal) === null, 'Macro aligned should allow matching direction');
  assert(backtester.getScenarioSkipReason('macro_strict', signal) === 'macro_score_below_62', 'Strict macro should require score >= 62');
}

async function testStoredSignalDecisionDrivesReplayMetadata() {
  const backtester = createBacktester();
  const signal = createSignal({
    confidence_score: 80,
    option_details: {
      ticker: 'QQQ260622C00741000',
      mark: 1,
      decision: createDecision({
        quote: {
          mark: 1.25,
          bid: 1.24,
          ask: 1.26,
          spreadPct: 1.6,
          volume: 700,
          openInterest: 1200,
          usingTheoreticalPricing: false
        },
        grade: {
          ...createDecision().grade,
          finalConfidence: 88,
          setupGrade: 'B',
          gradeKey: 'B'
        }
      })
    }
  });
  const contract = backtester.resolveContract(signal);
  const bars = [
    { start: '2026-06-22T13:45:00.000Z', open: 1.25, high: 1.41, low: 1.2, close: 1.35, volume: 100 }
  ];

  const trade = backtester.simulateTrade(signal, contract, bars, createConfig());

  assert(trade !== null, 'Trade should simulate');
  assert(trade.entryPrice === 1.25, `Expected stored decision mark entry price, got ${trade.entryPrice}`);
  assert(trade.confidenceScore === 88, `Expected stored decision confidence, got ${trade.confidenceScore}`);
  assert(trade.setupGrade === 'B', `Expected stored decision setup grade, got ${trade.setupGrade}`);
  assert(trade.signalDecision?.gradeKey === 'B', `Expected compact decision metadata, got ${JSON.stringify(trade.signalDecision)}`);
  assert(trade.exitReason === 'TAKE_PROFIT', `Expected TAKE_PROFIT, got ${trade.exitReason}`);
}

async function testParitySummaryReportsDecisionGaps() {
  const backtester = createBacktester();
  const signals = [
    createSignal({
      id: 201,
      option_details: {
        ticker: 'QQQ260622C00741000',
        mark: 1
      }
    }),
    createSignal({
      id: 202,
      option_details: {
        ticker: 'QQQ260622C00741000',
        mark: 1,
        decision: createDecision({
          side: 'PUT',
          quote: {
            mark: 1,
            bid: 0.5,
            ask: 1.5,
            spreadPct: 100,
            volume: 0,
            openInterest: 0,
            usingTheoreticalPricing: true
          },
          grade: {
            ...createDecision().grade,
            finalConfidence: 55,
            setupGrade: 'NO_SETUP',
            gradeKey: 'UNKNOWN',
            executable: false,
            pricingWarnings: ['wide spread']
          }
        })
      }
    })
  ];

  const summary = backtester.buildParitySummary(signals);

  assert(summary.signalsChecked === 2, `Expected 2 checked signals, got ${summary.signalsChecked}`);
  assert(summary.withSignalDecision === 1, `Expected 1 signal with decision, got ${summary.withSignalDecision}`);
  assert(summary.missingSignalDecision === 1, `Expected 1 missing decision, got ${summary.missingSignalDecision}`);
  assert(summary.gaps.missing_signal_decision === 1, 'Expected missing SignalDecision gap');
  assert(summary.gaps.side_mismatch === 1, 'Expected side mismatch gap');
  assert(summary.gaps.grade_mismatch === 1, 'Expected grade mismatch gap');
  assert(summary.gaps.confidence_mismatch === 1, 'Expected confidence mismatch gap');
  assert(summary.gaps.executable_mismatch === 1, 'Expected executable mismatch gap');
  assert(summary.gaps.theoretical_pricing === 1, 'Expected theoretical pricing gap');
  assert(summary.gaps.pricing_warning === 1, 'Expected pricing warning gap');
}

async function testCalibrationReportGroupsReplayOutcomes() {
  const backtester = createBacktester();
  const report = backtester.buildCalibrationReport([
    createReplayTrade(),
    createReplayTrade({
      signalId: 302,
      symbol: 'SPY',
      confidenceScore: 78,
      macroRegime: {
        regime: 'RISK_OFF',
        directionBias: 'PUT'
      },
      entryTime: '2026-06-22T17:15:00.000Z',
      pnl: -100,
      roiPct: -20,
      setupGrade: 'B',
      signalDecision: {
        gradeKey: 'B',
        executable: true,
        usingTheoreticalPricing: true,
        spreadPct: 30,
        quoteQuality: 'theoretical_pricing',
        pricingWarnings: ['theoretical price'],
        blockers: []
      }
    }),
    createReplayTrade({
      signalId: 303,
      symbol: 'QQQ',
      confidenceScore: 86,
      macroRegime: {
        regime: 'RISK_ON',
        directionBias: 'CALL'
      },
      entryTime: '2026-06-22T19:45:00.000Z',
      pnl: 30,
      roiPct: 6,
      signalDecision: {
        gradeKey: 'A',
        executable: true,
        usingTheoreticalPricing: false,
        spreadPct: 11,
        quoteQuality: 'acceptable_spread',
        pricingWarnings: [],
        blockers: []
      }
    })
  ]);

  const qqq = report.dimensions.symbol.find((bucket: any) => bucket.key === 'QQQ');
  const riskOn = report.dimensions.regime.find((bucket: any) => bucket.key === 'risk_on');
  const openWindow = report.dimensions.timeWindow.find((bucket: any) => bucket.key === 'open_0930_1030');
  const middayWindow = report.dimensions.timeWindow.find((bucket: any) => bucket.key === 'midday_1200_1400');
  const theoretical = report.dimensions.quoteQuality.find((bucket: any) => bucket.key === 'theoretical_pricing');

  assert(report.totalTrades === 3, `Expected 3 calibration trades, got ${report.totalTrades}`);
  assert(qqq?.trades === 2, `Expected 2 QQQ trades, got ${qqq?.trades}`);
  assert(qqq?.winRate === 100, `Expected QQQ 100% win rate, got ${qqq?.winRate}`);
  assert(qqq?.totalPnl === 90, `Expected QQQ total PnL 90, got ${qqq?.totalPnl}`);
  assert(riskOn?.trades === 2, `Expected 2 risk_on trades, got ${riskOn?.trades}`);
  assert(openWindow?.trades === 1, `Expected 1 open window trade, got ${openWindow?.trades}`);
  assert(middayWindow?.trades === 1, `Expected 1 midday trade, got ${middayWindow?.trades}`);
  assert(theoretical?.trades === 1, `Expected 1 theoretical pricing trade, got ${theoretical?.trades}`);
  assert(theoretical?.thresholds.find((threshold: any) => threshold.minConfidence === 80)?.trades === 0, 'Expected theoretical trade below 80 threshold');
  assert(qqq?.thresholds.find((threshold: any) => threshold.minConfidence === 85)?.trades === 2, 'Expected both QQQ trades at confidence >= 85');
}

async function testReplayDecisionAddsAttributionBuckets() {
  const backtester = createBacktester();
  const signal = createSignal({
    option_details: {
      ticker: 'QQQ260622C00741000',
      mark: 1,
      candidateSelection: {
        candidates: [
          {
            ticker: 'QQQ260622C00741000',
            delta: -0.44
          }
        ]
      },
      decision: createDecision({
        quote: {
          mark: 1.25,
          bid: 1.15,
          ask: 1.35,
          spreadPct: 16,
          volume: 700,
          openInterest: 1200,
          usingTheoreticalPricing: false
        },
        grade: {
          ...createDecision().grade,
          pricingWarnings: ['Spread 16% exceeds ceiling 12%']
        }
      })
    }
  });
  const contract = backtester.resolveContract(signal);
  const bars = [
    { start: '2026-06-22T13:45:00.000Z', open: 1.25, high: 1.41, low: 1.2, close: 1.35, volume: 100 }
  ];

  const trade = backtester.simulateTrade(signal, contract, bars, createConfig());

  assert(trade !== null, 'Trade should simulate');
  assert(trade.signalDecision?.delta === -0.44, `Expected selected contract delta, got ${trade.signalDecision?.delta}`);
  assert(trade.signalDecision?.deltaBucket === 'delta_core_35_60', `Expected core delta bucket, got ${trade.signalDecision?.deltaBucket}`);
  assert(trade.signalDecision?.spreadBucket === 'spread_very_wide_12_20', `Expected spread bucket, got ${trade.signalDecision?.spreadBucket}`);
  assert(trade.signalDecision?.warningTypes.includes('spread_warning'), `Expected spread warning type, got ${trade.signalDecision?.warningTypes}`);
}

async function testAttributionReportGroupsPostTradeBuckets() {
  const backtester = createBacktester();
  const report = backtester.buildAttributionReport([
    createReplayTrade(),
    createReplayTrade({
      signalId: 302,
      confidenceScore: 82,
      setupGrade: 'B',
      macroRegime: {
        regime: 'RISK_OFF',
        directionBias: 'PUT'
      },
      entryTime: '2026-06-22T18:30:00.000Z',
      pnl: -100,
      roiPct: -20,
      signalDecision: {
        gradeKey: 'B',
        executable: true,
        usingTheoreticalPricing: false,
        spreadPct: 18,
        spreadBucket: 'spread_very_wide_12_20',
        delta: 0.22,
        deltaBucket: 'delta_low_lt_25',
        quoteQuality: 'wide_spread',
        pricingWarnings: ['Spread 18% exceeds ceiling 12%'],
        warningTypes: ['spread_warning'],
        blockers: []
      }
    }),
    createReplayTrade({
      signalId: 303,
      confidenceScore: 78,
      setupGrade: 'B',
      macroRegime: {
        regime: 'RISK_OFF',
        directionBias: 'PUT'
      },
      entryTime: '2026-06-22T19:45:00.000Z',
      pnl: -50,
      roiPct: -10,
      signalDecision: {
        gradeKey: 'B',
        executable: true,
        usingTheoreticalPricing: true,
        spreadPct: 30,
        spreadBucket: 'spread_extreme_gt_20',
        delta: null,
        deltaBucket: 'delta_unknown',
        quoteQuality: 'theoretical_pricing',
        pricingWarnings: ['Using theoretical option price fallback'],
        warningTypes: ['theoretical_pricing'],
        blockers: []
      }
    })
  ]);

  const gradeB = report.dimensions.grade.find((bucket: any) => bucket.key === 'B');
  const spreadWarning = report.dimensions.warningType.find((bucket: any) => bucket.key === 'spread_warning');
  const theoretical = report.dimensions.warningType.find((bucket: any) => bucket.key === 'theoretical_pricing');
  const lowDelta = report.dimensions.deltaBucket.find((bucket: any) => bucket.key === 'delta_low_lt_25');
  const extremeSpread = report.dimensions.spreadBucket.find((bucket: any) => bucket.key === 'spread_extreme_gt_20');
  const afternoon = report.dimensions.timeOfDay.find((bucket: any) => bucket.key === 'afternoon_1400_1530');

  assert(report.totalTrades === 3, `Expected 3 attribution trades, got ${report.totalTrades}`);
  assert(gradeB?.trades === 2, `Expected 2 B trades, got ${gradeB?.trades}`);
  assert(gradeB?.winRate === 0, `Expected B trades to have 0% win rate, got ${gradeB?.winRate}`);
  assert(gradeB?.totalPnl === -150, `Expected B total PnL -150, got ${gradeB?.totalPnl}`);
  assert(spreadWarning?.trades === 1, `Expected 1 spread warning trade, got ${spreadWarning?.trades}`);
  assert(theoretical?.trades === 1, `Expected 1 theoretical pricing trade, got ${theoretical?.trades}`);
  assert(lowDelta?.trades === 1, `Expected 1 low delta trade, got ${lowDelta?.trades}`);
  assert(extremeSpread?.trades === 1, `Expected 1 extreme spread trade, got ${extremeSpread?.trades}`);
  assert(afternoon?.trades === 1, `Expected 1 afternoon trade, got ${afternoon?.trades}`);
}

async function testQuoteQualityBuckets() {
  const backtester = createBacktester();

  assert(backtester.getQuoteQualityBucket(createDecision()) === 'clean', 'Expected clean quote bucket');
  assert(backtester.getQuoteQualityBucket(createDecision({ quote: { ...createDecision().quote, spreadPct: 10 } })) === 'acceptable_spread', 'Expected acceptable spread bucket');
  assert(backtester.getQuoteQualityBucket(createDecision({ quote: { ...createDecision().quote, spreadPct: 20 } })) === 'wide_spread', 'Expected wide spread bucket');
  assert(backtester.getQuoteQualityBucket(createDecision({ quote: { ...createDecision().quote, usingTheoreticalPricing: true } })) === 'theoretical_pricing', 'Expected theoretical pricing bucket');
  assert(backtester.getQuoteQualityBucket(createDecision({ quote: { ...createDecision().quote, mark: null } })) === 'missing_quote', 'Expected missing quote bucket');
}

async function testNaiveThetaDataBarsParseAsEasternTime() {
  const backtester = createBacktester();

  const parsed = backtester.parseBarTime('2026-06-22T09:45:00.000', '2026-06-22');

  assert(parsed !== null, 'Naive ThetaData timestamp should parse');
  assert(parsed.toISOString() === '2026-06-22T13:45:00.000Z', `Expected 09:45 ET -> 13:45Z, got ${parsed.toISOString()}`);
}

async function testEasternDateHelperHandlesStandardTime() {
  const backtester = createBacktester();

  const parsed = backtester.dateAtEt('2026-01-15', 9, 30);

  assert(parsed.toISOString() === '2026-01-15T14:30:00.000Z', `Expected 09:30 ET winter -> 14:30Z, got ${parsed.toISOString()}`);
}

async function runTests() {
  console.log('Running SignalReplayBacktester tests...');
  await testTakeProfitUsesOptionOhlcTarget();
  await testAmbiguousBarUsesStopFirst();
  await testMacroStrictSkipsWeakMacroScore();
  await testStoredSignalDecisionDrivesReplayMetadata();
  await testParitySummaryReportsDecisionGaps();
  await testCalibrationReportGroupsReplayOutcomes();
  await testReplayDecisionAddsAttributionBuckets();
  await testAttributionReportGroupsPostTradeBuckets();
  await testQuoteQualityBuckets();
  await testNaiveThetaDataBarsParseAsEasternTime();
  await testEasternDateHelperHandlesStandardTime();
  console.log('All SignalReplayBacktester tests passed!');
}

runTests().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
