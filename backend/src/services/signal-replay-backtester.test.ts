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
  await testNaiveThetaDataBarsParseAsEasternTime();
  await testEasternDateHelperHandlesStandardTime();
  console.log('All SignalReplayBacktester tests passed!');
}

runTests().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
