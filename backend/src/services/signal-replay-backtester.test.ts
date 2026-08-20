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

function createVixTermStructureSnapshot(ratio = 1.1) {
  return {
    vix: 20,
    vix3m: Number((20 * ratio).toFixed(2)),
    ratio,
    minimumRatio: 1.05,
    status: ratio >= 1.1 ? 'STRONG_CONTANGO' : ratio >= 1.05 ? 'CONTANGO' : 'NEUTRAL',
    blocker: ratio >= 1.05 ? null : 'VIX term structure is neutral'
  };
}

function createDecisionSnapshot(overrides: Record<string, any> = {}) {
  return {
    version: 1,
    capturedAt: '2026-06-22T13:45:00.000Z',
    symbol: 'QQQ',
    status: 'SIGNAL_GENERATED',
    marketDate: '2026-06-22',
    configSnapshot: {
      scanner: {
        minSignalScore: 82
      }
    },
    macroSnapshot: {
      macroRegime: {
        score: 76,
        directionBias: 'CALL'
      }
    },
    gexSnapshot: {
      regime: 'POSITIVE'
    },
    scoring: {
      winningSide: 'CALL',
      winningScore: 91,
      dynamicMinScore: 82,
      callScore: 91,
      putScore: 42
    },
    optionSelection: {
      candidateSelection: {
        selectedScore: 122
      }
    },
    finalDecision: {
      finalConfidence: 91,
      setupGrade: 'A',
      tradeBias: 'BUY_CALL_ON_DIP',
      signalDecision: createDecision()
    },
    blockers: [],
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
      volume: 2500,
      openInterest: 4500,
      delta: 0.45,
      deltaBucket: 'delta_core_35_60',
      quoteQuality: 'clean',
      pricingWarnings: [],
      warningTypes: ['no_warning'],
      blockers: [],
      planRewardRisk: 2.5,
      planQualityBucket: 'plan_rr_2_3',
      gexContextBucket: 'gex_confirmed',
      rvol: 1.4,
      rvolBucket: 'rvol_1_2_1_5',
      armDistanceCandidate: 'atr_candidate_wider'
    },
    fillRealism: {
      action: 'UNCHANGED',
      score: 100,
      reasons: ['Clean replay fill'],
      adjustedEntryPrice: 1,
      adjustedExitPrice: 1.12,
      adjustedPnl: 60,
      adjustedRoiPct: 12
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
  assert(trade.fillRealism.action === 'UNCHANGED', `Expected clean fill unchanged, got ${trade.fillRealism.action}`);
  assert(trade.fillRealism.adjustedPnl === trade.pnl, `Expected clean adjusted PnL to equal raw PnL, got ${trade.fillRealism.adjustedPnl}`);
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

async function testSignalSnapshotOverridesReplayTradeConfig() {
  const backtester = createBacktester();
  const signal = createSignal({
    option_details: {
      ticker: 'QQQ260622C00741000',
      mark: 1,
      configSnapshot: {
        replay: {
          contractsPerTrade: 2,
          takeProfitPct: 20,
          stopLossPct: 25,
          maxTradesPerDay: 1,
          dailyProfitTarget: 200,
          dailyLossLimit: 80
        }
      },
      decision: createDecision()
    }
  });
  const contract = backtester.resolveContract(signal);
  const bars = [
    { start: '2026-06-22T13:45:00.000Z', open: 1, high: 1.14, low: 0.98, close: 1.15, volume: 100 }
  ];

  const signalConfig = backtester.getSignalReplayConfig(signal, createConfig({ contractsPerTrade: 5, takeProfitPct: 12, stopLossPct: 20 }));
  const trade = backtester.simulateTrade(signal, contract, bars, signalConfig);

  assert(signalConfig.contractsPerTrade === 2, `Expected snapshot contracts 2, got ${signalConfig.contractsPerTrade}`);
  assert(signalConfig.takeProfitPct === 20, `Expected snapshot TP 20, got ${signalConfig.takeProfitPct}`);
  assert(trade !== null, 'Trade should simulate');
  assert(trade.exitReason === 'EOD', `Expected snapshot TP to avoid 12% fallback take-profit, got ${trade.exitReason}`);
  assert(trade.quantity === 2, `Expected snapshot quantity 2, got ${trade.quantity}`);
  assert(trade.pnl === 30, `Expected snapshot PnL 30, got ${trade.pnl}`);
}

async function testSignalSnapshotReplayConfigFallsBackForLegacySignals() {
  const backtester = createBacktester();
  const fallback = createConfig({ contractsPerTrade: 4, takeProfitPct: 11 });
  const signalConfig = backtester.getSignalReplayConfig(createSignal(), fallback);

  assert(signalConfig.contractsPerTrade === 4, `Expected fallback contracts 4, got ${signalConfig.contractsPerTrade}`);
  assert(signalConfig.takeProfitPct === 11, `Expected fallback take profit 11, got ${signalConfig.takeProfitPct}`);
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

async function testStructureGateMirrorsLiveEntryGate() {
  const gate = (s: any): string | null => SignalReplayBacktester.structureGateSkipReason(s);

  // Flip no-man's-land: spot 770.14 within the 0.20%-of-spot floor (~1.54) of flip 770.37 (trade #796).
  const nearFlip = createSignal({ current_price: 770.14, strategy_name: 'GEX_WALL_BREAK_FAIL',
    gex: { flip: 770.37, regime: 'Negative', gamma_regime: 'Trend' } });
  assert(gate(nearFlip) === 'flip_no_mans_land',
    'A directional entry hugging the gamma flip must be gated');

  // Momentum setup in a Positive/Range pin, far from flip (trades #793/#794).
  const pinMomentum = createSignal({ current_price: 771.24, strategy_name: 'CONTINUATION',
    gex: { flip: 760.0, regime: 'Positive', gamma_regime: 'Range' } });
  assert(gate(pinMomentum) === 'momentum_in_positive_range',
    'A momentum setup in a Positive/Range pin must be gated');

  // A fade in the same pin, far from flip, is exempt (meant to trade ranges).
  const pinFade = createSignal({ current_price: 771.24, strategy_name: 'GEX_WALL_BOUNCE',
    gex: { flip: 760.0, regime: 'Positive', gamma_regime: 'Range' } });
  assert(gate(pinFade) === null,
    'A fade in a Positive/Range pin is not gated');

  // A clean momentum trade far from flip in a trend regime passes.
  const cleanTrend = createSignal({ current_price: 780.0, strategy_name: 'CONTINUATION',
    gex: { flip: 760.0, regime: 'Negative', gamma_regime: 'Trend' } });
  assert(gate(cleanTrend) === null,
    'A clean trend-aligned momentum trade far from the flip is allowed');

  // Missing gex context must not skip (baseline behavior preserved).
  const noContext = createSignal({ current_price: null, strategy_name: null, gex: null });
  assert(gate(noContext) === null,
    'Signals without gex/price context are not gated');
}

async function testVixContangoScenarioRequiresStoredTermStructure() {
  const backtester = createBacktester();
  const eligible = createSignal({
    option_details: {
      ...createSignal().option_details,
      decisionSnapshot: { macroSnapshot: { vixTermStructure: createVixTermStructureSnapshot(1.1) } }
    }
  });
  const neutral = createSignal({
    option_details: {
      ...createSignal().option_details,
      decisionSnapshot: { macroSnapshot: { vixTermStructure: createVixTermStructureSnapshot(1.02) } }
    }
  });
  const legacy = createSignal();

  assert(backtester.getScenarioSkipReason('vix_contango', eligible) === null, 'Contango signal should pass the VIX scenario');
  assert(backtester.getScenarioSkipReason('vix_contango', neutral) === 'vix_term_structure_below_floor', 'Neutral signal should fail the VIX scenario');
  assert(backtester.getScenarioSkipReason('vix_contango', legacy) === 'vix_term_structure_unavailable', 'Legacy signal should be excluded without stored VIX evidence');
}

async function testVixResearchReportRequiresComparableSample() {
  const backtester = createBacktester();
  const eligible = createSignal({
    option_details: {
      ...createSignal().option_details,
      decisionSnapshot: { macroSnapshot: { vixTermStructure: createVixTermStructureSnapshot(1.1) } }
    }
  });
  const baseline = { summary: { trades: 25, winRate: 60, totalPnl: 100, profitFactor: 1.2, maxDrawdown: 50 } };
  const candidate = { summary: { trades: 3, winRate: 66.67, totalPnl: 80, profitFactor: 1.4, maxDrawdown: 30 } };
  const report = backtester.buildVixTermStructureResearchReport([eligible, createSignal()], baseline, candidate);

  assert(report.signalsWithTermStructure === 1, `Expected one signal with term structure, got ${report.signalsWithTermStructure}`);
  assert(report.signalsMissingTermStructure === 1, `Expected one signal without term structure, got ${report.signalsMissingTermStructure}`);
  assert(report.status === 'INSUFFICIENT_DATA', `Expected insufficient data status, got ${report.status}`);
  assert(report.delta.totalPnl === -20, `Expected PnL delta -20, got ${report.delta.totalPnl}`);
}

async function testHistoricalVixBackfillUsesSignalTimeBars() {
  const backtester = createBacktester();
  const calls: string[] = [];
  (backtester as any).ibkrMarketData = {
    getHistoricalIndexBars: async (symbol: string) => {
      calls.push(symbol);
      return [{ start: '2026-06-22T13:45:00.000Z', open: 0, high: 0, low: 0, close: symbol === 'VIX' ? 20 : 22, volume: 0 }];
    }
  };
  const signal = createSignal();
  const summary = await (backtester as any).backfillHistoricalVixTermStructure([signal]);

  assert(summary.backfilled === 1, `Expected one historical VIX backfill, got ${summary.backfilled}`);
  assert(summary.unavailable === 0, `Expected no historical VIX backfill failures, got ${summary.unavailable}`);
  assert(calls.sort().join(',') === 'VIX,VIX3M', `Expected VIX and VIX3M history requests, got ${calls.join(',')}`);
  const replayTermStructure = (signal as any).replayVixTermStructure;
  assert(replayTermStructure.ratio === 1.1, `Expected historical ratio 1.1, got ${replayTermStructure.ratio}`);
  assert((backtester as any).getScenarioSkipReason('vix_contango', signal) === null, 'Historical contango evidence should make the signal eligible');
}

async function testScannerLogFallbackBuildsReplaySignal() {
  const backtester = createBacktester();
  const decision = createDecision({
    signalId: undefined,
    symbol: 'SPY',
    contract: { ticker: 'SPY260622C00550000', strike: 550, expiry: '2026-06-22' }
  });
  const signal = (backtester as any).scannerLogToReplaySignal({
    id: 88,
    symbol: 'SPY',
    created_at: '2026-06-22T13:45:00.000Z',
    indicators: {
      signalDecision: decision,
      decisionSnapshot: {
        macroSnapshot: {
          vixTermStructure: createVixTermStructureSnapshot(1.1),
          macroRegime: { directionBias: 'CALL', score: 76, blockers: [] }
        }
      }
    },
    no_trade_reasons: []
  });

  assert(signal !== null, 'Signal-generated scanner log should become a replay signal');
  assert(signal.id === -88, `Expected synthetic scanner log id -88, got ${signal.id}`);
  assert(signal.signal_type === 'CALL', `Expected CALL signal, got ${signal.signal_type}`);
  assert((backtester as any).resolveContract(signal)?.strike === 550, 'Scanner log should preserve the option contract');
  assert((backtester as any).getScenarioSkipReason('vix_contango', signal) === null, 'Scanner log should preserve macro evidence');
}

async function testBlockedScannerLogPreservesCounterfactualContract() {
  const backtester = createBacktester();
  const signal = (backtester as any).scannerLogToReplaySignal({
    id: 89,
    symbol: 'SPY',
    outcome: 'BLOCKED',
    created_at: '2026-06-22T13:45:00.000Z',
    indicators: {
      decisionSnapshot: createDecisionSnapshot({
        status: 'BLOCKED',
        blockers: ['PUT volume 100 did not exceed threshold 200'],
        finalDecision: {
          counterfactual: true,
          signalDecision: createDecision({
            signalId: undefined,
            symbol: 'SPY',
            side: 'PUT',
            contract: { ticker: 'SPY260622P00550000', strike: 550, expiry: '2026-06-22' },
            quote: { mark: 1, bid: 0.99, ask: 1.01, spreadPct: 2, volume: 100, openInterest: 1000 }
          })
        }
      })
    },
    no_trade_reasons: ['PUT volume 100 did not exceed threshold 200']
  });

  assert(signal !== null, 'Blocked scanner log should become a replay signal');
  assert(signal.blocked === true, 'Replay signal should retain blocked status');
  assert((backtester as any).resolveContract(signal)?.right === 'put', 'Blocked replay should retain hypothetical PUT contract');
  assert(signal.option_details.configSnapshot !== undefined, 'Blocked replay should retain scanner replay settings');
}

async function testBlockedReplayAttributesOutcomeAndUsesAIResearchOnly() {
  const backtester = createBacktester();
  (backtester as any).ibkrMarketData = {
    getOptionHistoricalBars: async () => [{
      start: '2026-06-22T13:45:00.000Z',
      open: 1,
      high: 1.2,
      low: 0.98,
      close: 1.15,
      volume: 100
    }]
  };
  (backtester as any).aiService = {
    askTradingJSON: async () => ({
      verdict: 'KEEP_BLOCKED',
      analysis: 'The blocked sample is too small to justify changing the gate.',
      recommendations: ['Collect more comparable blocked replays.']
    })
  };
  const signal = createSignal({
    id: -89,
    signal_type: 'PUT',
    option_details: {
      ticker: 'QQQ260622P00741000',
      mark: 1,
      decision: createDecision({ signalId: undefined, side: 'PUT', contract: { ticker: 'QQQ260622P00741000', strike: 741, expiry: '2026-06-22' } }),
      decisionSnapshot: { blockers: ['PUT volume 100 did not exceed threshold 200'] }
    },
    no_trade_reasons: ['PUT volume 100 did not exceed threshold 200'],
    blocked: true
  });

  const summary = await (backtester as any).replayBlockedSignals(7, [signal], createConfig(), new Map());

  assert(summary.blockedSignals === 1, `Expected one blocked scan, got ${summary.blockedSignals}`);
  assert(summary.replayedTrades === 1, `Expected one counterfactual replay, got ${summary.replayedTrades}`);
  assert(summary.wins === 1, `Expected one counterfactual win, got ${summary.wins}`);
  assert(summary.attribution[0].category === 'volume_confirmation', 'Expected volume blocker attribution');
  assert(summary.ai.status === 'READY', 'Expected AI research readout to be ready');
  assert(summary.ai.verdict === 'KEEP_BLOCKED', 'Expected AI verdict to be preserved');
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

async function testSnapshotDriftReportUsesStoredDecisionSnapshot() {
  const backtester = createBacktester();
  const signal = createSignal({
    option_details: {
      ticker: 'QQQ260622C00741000',
      mark: 1,
      decision: createDecision(),
      decisionSnapshot: createDecisionSnapshot()
    }
  });

  const report = backtester.buildSnapshotDriftReport([signal]);

  assert(report.signalsChecked === 1, `Expected 1 checked signal, got ${report.signalsChecked}`);
  assert(report.withDecisionSnapshot === 1, `Expected 1 signal with decision snapshot, got ${report.withDecisionSnapshot}`);
  assert(report.missingDecisionSnapshot === 0, `Expected 0 missing snapshots, got ${report.missingDecisionSnapshot}`);
  assert(report.driftCounts.score_drift === 0, 'Expected no score drift');
  assert(report.driftCounts.grade_drift === 0, 'Expected no grade drift');
  assert(report.driftCounts.blocker_drift === 0, 'Expected no blocker drift');
  assert(report.driftCounts.contract_selection_drift === 0, 'Expected no contract drift');
  assert(report.examples.length === 0, `Expected no drift examples, got ${JSON.stringify(report.examples)}`);
}

async function testSnapshotDriftReportFlagsChangedThresholdAndContract() {
  const backtester = createBacktester();
  const signal = createSignal({
    confidence_score: 82,
    setup_grade: 'B / LOTTO',
    no_trade_reasons: ['Best setup score 82 is below dynamic minimum 95'],
    option_details: {
      ticker: 'QQQ260622C00742000',
      mark: 1,
      decision: createDecision({
        contract: {
          ticker: 'QQQ260622C00742000',
          strike: 742,
          expiry: '2026-06-22'
        },
        grade: {
          ...createDecision().grade,
          finalConfidence: 82,
          setupGrade: 'B / LOTTO',
          gradeKey: 'B / LOTTO'
        }
      }),
      decisionSnapshot: createDecisionSnapshot({
        scoring: {
          winningSide: 'CALL',
          winningScore: 91,
          dynamicMinScore: 82,
          callScore: 91,
          putScore: 42
        }
      })
    }
  });

  const report = backtester.buildSnapshotDriftReport([signal]);
  const scoreDrift = report.examples.find((example: any) => example.type === 'score_drift');
  const blockerDrift = report.examples.find((example: any) => example.type === 'blocker_drift');

  assert(report.driftCounts.score_drift === 1, 'Expected score drift when replayed score changes');
  assert(report.driftCounts.grade_drift === 1, 'Expected grade drift when replayed grade changes');
  assert(report.driftCounts.blocker_drift === 1, 'Expected blocker drift when changed threshold blocks replayed setup');
  assert(report.driftCounts.contract_selection_drift === 1, 'Expected contract drift when replayed selected ticker changes');
  assert(scoreDrift?.metadata?.scoreDelta === -9, `Expected score delta -9, got ${JSON.stringify(scoreDrift)}`);
  assert(scoreDrift?.metadata?.originalDecision?.dynamicMinScore === 82, 'Expected original dynamic minimum in drift metadata');
  assert(scoreDrift?.metadata?.replayedDecision?.score === 82, 'Expected replayed score in drift metadata');
  assert(blockerDrift?.metadata?.blockerDelta?.added?.[0] === 'Best setup score 82 is below dynamic minimum 95', 'Expected changed threshold blocker delta');
}

async function testSnapshotDriftReportFallsBackForLegacySignals() {
  const backtester = createBacktester();

  const report = backtester.buildSnapshotDriftReport([createSignal()]);

  assert(report.signalsChecked === 1, `Expected 1 checked signal, got ${report.signalsChecked}`);
  assert(report.withDecisionSnapshot === 0, `Expected 0 snapshots, got ${report.withDecisionSnapshot}`);
  assert(report.missingDecisionSnapshot === 1, `Expected 1 missing snapshot, got ${report.missingDecisionSnapshot}`);
  assert(report.driftCounts.missing_decision_snapshot === 1, 'Expected missing snapshot count for legacy signal');
  assert(report.examples[0]?.type === 'missing_decision_snapshot', `Expected missing snapshot example, got ${JSON.stringify(report.examples)}`);
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
  const planQuality = report.dimensions.planRewardRisk.find((bucket: any) => bucket.key === 'plan_rr_2_3');
  const atrCandidate = report.dimensions.armDistanceCandidate.find((bucket: any) => bucket.key === 'atr_candidate_wider');

  assert(report.totalTrades === 3, `Expected 3 calibration trades, got ${report.totalTrades}`);
  assert(qqq?.trades === 2, `Expected 2 QQQ trades, got ${qqq?.trades}`);
  assert(qqq?.winRate === 100, `Expected QQQ 100% win rate, got ${qqq?.winRate}`);
  assert(qqq?.totalPnl === 90, `Expected QQQ total PnL 90, got ${qqq?.totalPnl}`);
  assert(riskOn?.trades === 2, `Expected 2 risk_on trades, got ${riskOn?.trades}`);
  assert(openWindow?.trades === 1, `Expected 1 open window trade, got ${openWindow?.trades}`);
  assert(middayWindow?.trades === 1, `Expected 1 midday trade, got ${middayWindow?.trades}`);
  assert(theoretical?.trades === 1, `Expected 1 theoretical pricing trade, got ${theoretical?.trades}`);
  assert(planQuality?.trades === 1, `Expected plan reward/risk calibration, got ${planQuality?.trades}`);
  assert(atrCandidate?.trades === 1, `Expected fixed-versus-ATR calibration, got ${atrCandidate?.trades}`);
  assert(theoretical?.thresholds.find((threshold: any) => threshold.minConfidence === 80)?.trades === 0, 'Expected theoretical trade below 80 threshold');
  assert(qqq?.thresholds.find((threshold: any) => threshold.minConfidence === 85)?.trades === 2, 'Expected both QQQ trades at confidence >= 85');
}

async function testStrategyTelemetryFeedsReplayCalibration() {
  const backtester = createBacktester();
  const signal = createSignal({
    option_details: {
      ticker: 'QQQ260622C00741000',
      decision_telemetry: {
        state: 'ACTIVE',
        market: { rvol_1m: 1.35 },
        thresholds: {
          arm_enter_dollars_current: 0.08,
          arm_exit_dollars_current: 0.18,
          arm_enter_dollars_atr_candidate: 0.12,
          arm_exit_dollars_atr_candidate: 0.28
        },
        setups: {
          calls: {
            plan_quality: { reward_risk: 2.25 },
            option: { planned_limit_price: 1, spread_pct: 6, volume: 800, open_interest: 1400, delta: 0.42 },
            zerogex: { confirmations: ['positive gamma structure'], warnings: [] }
          }
        },
        blockers: [],
        warnings: []
      }
    }
  });

  const decision = backtester.toReplayTradeDecision(signal, null);
  assert(decision?.planQualityBucket === 'plan_rr_2_3', 'Strategy telemetry must retain frozen plan reward/risk');
  assert(decision?.rvolBucket === 'rvol_1_2_1_5', 'Strategy telemetry must retain relative-volume context');
  assert(decision?.gexContextBucket === 'gex_confirmed', 'Strategy telemetry must retain advisory GEX context');
  assert(decision?.armDistanceCandidate === 'atr_candidate_wider', 'Replay must compare current fixed arming thresholds with the ATR candidate');
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
  assert(trade.signalDecision?.volume === 700, `Expected replay decision volume 700, got ${trade.signalDecision?.volume}`);
  assert(trade.fillRealism.action === 'PENALIZED', `Expected wide spread fill to be penalized, got ${trade.fillRealism.action}`);
  assert(trade.fillRealism.adjustedPnl < trade.pnl, `Expected adjusted PnL below raw PnL, got adjusted ${trade.fillRealism.adjustedPnl} raw ${trade.pnl}`);
}

async function testFillRealismSkipsTheoreticalReplayFill() {
  const backtester = createBacktester();
  const signal = createSignal({
    option_details: {
      ticker: 'QQQ260622C00741000',
      mark: 1,
      decision: createDecision({
        quote: {
          mark: 1,
          bid: 0.95,
          ask: 1.05,
          spreadPct: 10,
          volume: 1000,
          openInterest: 1500,
          usingTheoreticalPricing: true
        },
        grade: {
          ...createDecision().grade,
          pricingWarnings: ['Using theoretical option price fallback']
        }
      })
    }
  });
  const contract = backtester.resolveContract(signal);
  const bars = [
    { start: '2026-06-22T13:45:00.000Z', open: 1, high: 1.14, low: 0.98, close: 1.12, volume: 100 }
  ];

  const trade = backtester.simulateTrade(signal, contract, bars, createConfig());

  assert(trade !== null, 'Trade should simulate');
  assert(trade.pnl === 60, `Expected raw PnL still recorded as 60, got ${trade.pnl}`);
  assert(trade.fillRealism.action === 'SKIPPED', `Expected theoretical fill skipped, got ${trade.fillRealism.action}`);
  assert(trade.fillRealism.adjustedPnl === 0, `Expected skipped fill adjusted PnL 0, got ${trade.fillRealism.adjustedPnl}`);
}

async function testFillRealismSummaryComparesRawAndAdjustedPnl() {
  const backtester = createBacktester();
  const summary = backtester.summarizeFillRealism([
    createReplayTrade(),
    createReplayTrade({
      signalId: 302,
      pnl: 100,
      fillRealism: {
        action: 'PENALIZED',
        score: 70,
        reasons: ['Spread 16% is very wide'],
        adjustedEntryPrice: 1.1,
        adjustedExitPrice: 1.15,
        adjustedPnl: 25,
        adjustedRoiPct: 4.55
      }
    }),
    createReplayTrade({
      signalId: 303,
      pnl: 80,
      fillRealism: {
        action: 'SKIPPED',
        score: 0,
        reasons: ['Theoretical option pricing is not fill-realistic'],
        adjustedEntryPrice: 1,
        adjustedExitPrice: 1,
        adjustedPnl: 0,
        adjustedRoiPct: 0
      }
    })
  ]);

  assert(summary.rawTotalPnl === 240, `Expected raw PnL 240, got ${summary.rawTotalPnl}`);
  assert(summary.realisticTotalPnl === 85, `Expected realistic PnL 85, got ${summary.realisticTotalPnl}`);
  assert(summary.pnlDelta === -155, `Expected PnL delta -155, got ${summary.pnlDelta}`);
  assert(summary.penalizedTrades === 1, `Expected 1 penalized trade, got ${summary.penalizedTrades}`);
  assert(summary.skippedTrades === 1, `Expected 1 skipped trade, got ${summary.skippedTrades}`);
  assert(summary.unchangedTrades === 1, `Expected 1 unchanged trade, got ${summary.unchangedTrades}`);
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

async function testNaiveIbkrBarsParseAsEasternTime() {
  const backtester = createBacktester();

  const parsed = backtester.parseBarTime('2026-06-22T09:45:00.000', '2026-06-22');

  assert(parsed !== null, 'Naive IBKR timestamp should parse');
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
  await testSignalSnapshotOverridesReplayTradeConfig();
  await testSignalSnapshotReplayConfigFallsBackForLegacySignals();
  await testMacroStrictSkipsWeakMacroScore();
  await testVixContangoScenarioRequiresStoredTermStructure();
  await testVixResearchReportRequiresComparableSample();
  await testHistoricalVixBackfillUsesSignalTimeBars();
  await testScannerLogFallbackBuildsReplaySignal();
  await testBlockedScannerLogPreservesCounterfactualContract();
  await testBlockedReplayAttributesOutcomeAndUsesAIResearchOnly();
  await testStoredSignalDecisionDrivesReplayMetadata();
  await testParitySummaryReportsDecisionGaps();
  await testSnapshotDriftReportUsesStoredDecisionSnapshot();
  await testSnapshotDriftReportFlagsChangedThresholdAndContract();
  await testSnapshotDriftReportFallsBackForLegacySignals();
  await testCalibrationReportGroupsReplayOutcomes();
  await testStrategyTelemetryFeedsReplayCalibration();
  await testReplayDecisionAddsAttributionBuckets();
  await testFillRealismSkipsTheoreticalReplayFill();
  await testFillRealismSummaryComparesRawAndAdjustedPnl();
  await testAttributionReportGroupsPostTradeBuckets();
  await testQuoteQualityBuckets();
  await testNaiveIbkrBarsParseAsEasternTime();
  await testEasternDateHelperHandlesStandardTime();
  await testStructureGateMirrorsLiveEntryGate();
  console.log('All SignalReplayBacktester tests passed!');
}

runTests().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
