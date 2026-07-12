import { FastifyInstance } from 'fastify';
import { SignalDecision } from '../lib/trading-events';
import { IbkrMarketDataService, IbkrOptionContract } from './ibkr-market-data-service';

type ReplayBar = {
  start: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type ReplaySignal = {
  id: number;
  symbol: string;
  signal_type: 'CALL' | 'PUT';
  confidence_score: number;
  setup_grade: string | null;
  created_at: string | Date;
  market_date: string | null;
  option_expiration_date: string | null;
  option_details: any;
  volatility: any;
  no_trade_reasons: string[] | null;
  replayVixTermStructure?: any;
};

type ReplayVixBackfillSummary = {
  backfilled: number;
  unavailable: number;
};

type ReplayConfig = {
  symbols?: string[];
  startDate: string;
  endDate: string;
  contractsPerTrade: number;
  takeProfitPct: number;
  stopLossPct: number;
  maxTradesPerDay: number;
  dailyProfitTarget: number;
  dailyLossLimit: number;
  interval: string;
  maxSignals: number;
};

type ReplayTrade = {
  signalId: number;
  date: string;
  symbol: string;
  optionTicker: string;
  side: 'CALL' | 'PUT';
  setupGrade: string | null;
  confidenceScore: number;
  macroRegime: any;
  entryTime: string;
  exitTime: string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  pnl: number;
  roiPct: number;
  exitReason: string;
  skippedBy: string[];
  signalDecision: ReplayTradeDecision | null;
  fillRealism: ReplayFillRealism;
};

type ReplayTradeDecision = {
  gradeKey: string | null;
  executable: boolean | null;
  usingTheoreticalPricing: boolean;
  spreadPct: number | null;
  spreadBucket: string;
  volume: number | null;
  openInterest: number | null;
  delta: number | null;
  deltaBucket: string;
  quoteQuality: ReplayQuoteQualityBucket;
  pricingWarnings: string[];
  warningTypes: string[];
  blockers: string[];
};

type ReplayFillRealismAction = 'UNCHANGED' | 'PENALIZED' | 'SKIPPED';

type ReplayFillRealism = {
  action: ReplayFillRealismAction;
  score: number;
  reasons: string[];
  adjustedEntryPrice: number;
  adjustedExitPrice: number;
  adjustedPnl: number;
  adjustedRoiPct: number;
};

type ReplayQuoteQualityBucket =
  | 'clean'
  | 'acceptable_spread'
  | 'wide_spread'
  | 'theoretical_pricing'
  | 'missing_quote';

type ReplayParityGapType =
  | 'missing_signal_decision'
  | 'contract_mismatch'
  | 'side_mismatch'
  | 'grade_mismatch'
  | 'confidence_mismatch'
  | 'executable_mismatch'
  | 'theoretical_pricing'
  | 'pricing_warning';

type ReplayParityGap = {
  signalId: number;
  symbol: string;
  type: ReplayParityGapType;
  message: string;
  metadata?: Record<string, any>;
};

type ReplayParitySummary = {
  signalsChecked: number;
  withSignalDecision: number;
  missingSignalDecision: number;
  gaps: Record<ReplayParityGapType, number>;
  examples: ReplayParityGap[];
};

type ReplaySnapshotDriftType =
  | 'missing_decision_snapshot'
  | 'side_drift'
  | 'score_drift'
  | 'grade_drift'
  | 'blocker_drift'
  | 'contract_selection_drift';

type ReplaySnapshotDecisionSummary = {
  side: string | null;
  score: number | null;
  grade: string | null;
  blockers: string[];
  contractTicker: string | null;
  dynamicMinScore: number | null;
};

type ReplaySnapshotDriftExample = {
  signalId: number;
  symbol: string;
  type: ReplaySnapshotDriftType;
  message: string;
  metadata?: Record<string, any>;
};

type ReplaySnapshotDriftReport = {
  signalsChecked: number;
  withDecisionSnapshot: number;
  missingDecisionSnapshot: number;
  driftCounts: Record<ReplaySnapshotDriftType, number>;
  examples: ReplaySnapshotDriftExample[];
};

type ReplayScenario = {
  name: 'baseline' | 'macro_aligned' | 'macro_strict' | 'vix_contango';
  description: string;
  trades: ReplayTrade[];
  skippedSignals: number;
  skippedReasons: Record<string, number>;
  summary: ReplaySummary;
  fillRealism: ReplayFillRealismSummary;
};

type ReplayResearchReport = {
  experiment: 'vix_term_structure';
  candidateScenario: 'vix_contango';
  minimumRatio: number;
  signalsWithTermStructure: number;
  signalsMissingTermStructure: number;
  signalsBackfilledFromIbkr: number;
  signalsUnavailableForBackfill: number;
  minimumComparableTrades: number;
  status: 'INSUFFICIENT_DATA' | 'READY_FOR_REVIEW';
  baseline: {
    trades: number;
    winRate: number;
    totalPnl: number;
    profitFactor: number;
    maxDrawdown: number;
  };
  candidate: {
    trades: number;
    winRate: number;
    totalPnl: number;
    profitFactor: number;
    maxDrawdown: number;
  };
  delta: {
    trades: number;
    winRate: number;
    totalPnl: number;
    profitFactor: number;
    maxDrawdown: number;
  };
  notes: string[];
};

type ReplayFillRealismSummary = {
  rawTotalPnl: number;
  realisticTotalPnl: number;
  pnlDelta: number;
  skippedTrades: number;
  penalizedTrades: number;
  unchangedTrades: number;
};

type ReplayCalibrationThreshold = {
  minConfidence: number;
  trades: number;
  wins: number;
  winRate: number;
  totalPnl: number;
  averageRoiPct: number;
  profitFactor: number;
};

type ReplayCalibrationBucket = {
  key: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  averagePnl: number;
  averageRoiPct: number;
  averageConfidence: number;
  profitFactor: number;
  gradeMix: Record<string, number>;
  thresholds: ReplayCalibrationThreshold[];
};

type ReplayCalibrationReport = {
  scenario: 'baseline';
  totalTrades: number;
  dimensions: {
    symbol: ReplayCalibrationBucket[];
    regime: ReplayCalibrationBucket[];
    timeWindow: ReplayCalibrationBucket[];
    quoteQuality: ReplayCalibrationBucket[];
  };
};

type ReplayAttributionReport = {
  scenario: 'baseline';
  totalTrades: number;
  dimensions: {
    grade: ReplayCalibrationBucket[];
    regime: ReplayCalibrationBucket[];
    warningType: ReplayCalibrationBucket[];
    deltaBucket: ReplayCalibrationBucket[];
    spreadBucket: ReplayCalibrationBucket[];
    timeOfDay: ReplayCalibrationBucket[];
  };
};

type ReplaySummary = {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  averageWin: number;
  averageLoss: number;
  profitFactor: number;
  maxDrawdown: number;
  daysTested: number;
  greenDays: number;
  redDays: number;
  targetDays: number;
  lossLimitDays: number;
};

export class SignalReplayBacktester {
  private ibkrMarketData: IbkrMarketDataService;

  constructor(private fastify: FastifyInstance) {
    this.ibkrMarketData = new IbkrMarketDataService(fastify);
  }

  public async run(userId: number, input: Partial<ReplayConfig>): Promise<{
    config: ReplayConfig;
    signalsLoaded: number;
    signalsUsable: number;
    missingOptionData: number;
    parity: ReplayParitySummary;
    snapshotDrift: ReplaySnapshotDriftReport;
    calibration: ReplayCalibrationReport;
    attribution: ReplayAttributionReport;
    research: ReplayResearchReport;
    scenarios: ReplayScenario[];
  }> {
    const config = this.normalizeConfig(input);
    const signals = await this.loadSignals(config);
    const usableSignals = signals.filter((signal) => this.resolveContract(signal) !== null);
    const historicalVixBackfill = await this.backfillHistoricalVixTermStructure(usableSignals);
    const missingOptionData = signals.length - usableSignals.length;
    const parity = this.buildParitySummary(signals);
    const snapshotDrift = this.buildSnapshotDriftReport(signals);

    const scenarios: ReplayScenario[] = [
      {
        name: 'baseline',
        description: 'All usable stored signals, with the same TP/SL and daily risk controls.',
        trades: [],
        skippedSignals: 0,
        skippedReasons: {},
        summary: this.emptySummary(),
        fillRealism: this.emptyFillRealismSummary()
      },
      {
        name: 'macro_aligned',
        description: 'Skips signals where recorded macro direction conflicts with the trade side.',
        trades: [],
        skippedSignals: 0,
        skippedReasons: {},
        summary: this.emptySummary(),
        fillRealism: this.emptyFillRealismSummary()
      },
      {
        name: 'macro_strict',
        description: 'Requires macro alignment, no recorded macro blockers, and macro score >= 62.',
        trades: [],
        skippedSignals: 0,
        skippedReasons: {},
        summary: this.emptySummary(),
        fillRealism: this.emptyFillRealismSummary()
      },
      {
        name: 'vix_contango',
        description: 'Requires stored or signal-time IBKR historical VIX3M/VIX evidence at or above the configured 1.05 contango floor.',
        trades: [],
        skippedSignals: 0,
        skippedReasons: {},
        summary: this.emptySummary(),
        fillRealism: this.emptyFillRealismSummary()
      }
    ];

    const historyCache = new Map<string, ReplayBar[]>();
    for (const scenario of scenarios) {
      const state = this.newScenarioState();
      for (const signal of usableSignals) {
        const dateKey = this.getSignalDate(signal);
        const signalConfig = this.getSignalReplayConfig(signal, config);
        const skippedByFilter = this.getScenarioSkipReason(scenario.name, signal);
        if (skippedByFilter) {
          this.noteSkip(scenario, skippedByFilter);
          continue;
        }
        if (this.shouldSkipForDailyControls(state, dateKey, signalConfig)) {
          this.noteSkip(scenario, 'daily_control');
          continue;
        }

        const contract = this.resolveContract(signal);
        if (!contract) {
          this.noteSkip(scenario, 'missing_contract');
          continue;
        }

        const cacheKey = `${contract.symbol}:${contract.expiration}:${contract.right}:${contract.strike}:${dateKey}:${signalConfig.interval}`;
        let bars = historyCache.get(cacheKey);
        if (!bars) {
          try {
            bars = await this.ibkrMarketData.getOptionHistoricalBars(
              contract,
              this.dateAtEt(dateKey, 16, 0),
              this.historyDuration(signalConfig.interval),
              this.historyBarSize(signalConfig.interval)
            );
          } catch (err: any) {
            this.fastify.log.warn(`[SignalReplayBacktester] IBKR history unavailable for ${cacheKey}: ${err.message || String(err)}`);
            bars = [];
          }
          historyCache.set(cacheKey, bars);
        }

        const trade = this.simulateTrade(signal, contract, bars, signalConfig);
        if (!trade) {
          this.noteSkip(scenario, 'missing_price_history');
          continue;
        }

        scenario.trades.push(trade);
        this.applyTradeToState(state, dateKey, trade.pnl, signalConfig);
      }
      scenario.summary = this.summarize(scenario.trades, state.dailyPnl, config);
      scenario.fillRealism = this.summarizeFillRealism(scenario.trades);
    }
    const baseline = scenarios.find((scenario) => scenario.name === 'baseline') as ReplayScenario;
    const vixContango = scenarios.find((scenario) => scenario.name === 'vix_contango') as ReplayScenario;
    const calibration = this.buildCalibrationReport(baseline.trades);
    const attribution = this.buildAttributionReport(baseline.trades);
    const research = this.buildVixTermStructureResearchReport(signals, baseline, vixContango, historicalVixBackfill);

    return {
      config,
      signalsLoaded: signals.length,
      signalsUsable: usableSignals.length,
      missingOptionData,
      parity,
      snapshotDrift,
      calibration,
      attribution,
      research,
      scenarios
    };
  }

  private normalizeConfig(input: Partial<ReplayConfig>): ReplayConfig {
    const today = new Date().toISOString().split('T')[0];
    const defaultStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    return {
      symbols: input.symbols?.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean),
      startDate: input.startDate || defaultStart,
      endDate: input.endDate || today,
      contractsPerTrade: this.positiveInt(input.contractsPerTrade, 5),
      takeProfitPct: this.positiveNumber(input.takeProfitPct, 12),
      stopLossPct: this.positiveNumber(input.stopLossPct, 20),
      maxTradesPerDay: this.positiveInt(input.maxTradesPerDay, 5),
      dailyProfitTarget: this.positiveNumber(input.dailyProfitTarget, 400),
      dailyLossLimit: this.positiveNumber(input.dailyLossLimit, 100),
      interval: input.interval || '1m',
      maxSignals: Math.min(this.positiveInt(input.maxSignals, 250), 1000)
    };
  }

  private getSignalReplayConfig(signal: ReplaySignal, fallback: ReplayConfig): ReplayConfig {
    const snapshot = signal.option_details?.configSnapshot?.replay;
    if (!snapshot || typeof snapshot !== 'object') return fallback;
    return {
      ...fallback,
      contractsPerTrade: this.positiveInt(snapshot.contractsPerTrade, fallback.contractsPerTrade),
      takeProfitPct: this.positiveNumber(snapshot.takeProfitPct, fallback.takeProfitPct),
      stopLossPct: this.positiveNumber(snapshot.stopLossPct, fallback.stopLossPct),
      maxTradesPerDay: this.positiveInt(snapshot.maxTradesPerDay, fallback.maxTradesPerDay),
      dailyProfitTarget: this.positiveNumber(snapshot.dailyProfitTarget, fallback.dailyProfitTarget),
      dailyLossLimit: this.positiveNumber(snapshot.dailyLossLimit, fallback.dailyLossLimit)
    };
  }

  private async loadSignals(config: ReplayConfig): Promise<ReplaySignal[]> {
    const params: any[] = [config.startDate, config.endDate, config.maxSignals];
    const symbolFilter = config.symbols && config.symbols.length > 0
      ? `AND symbol = ANY($4::text[])`
      : '';
    if (symbolFilter) params.push(config.symbols);

    const { rows: signalRows } = await (this.fastify as any).pg.query(
      `SELECT id, symbol, signal_type, confidence_score, setup_grade, created_at, market_date,
              option_expiration_date, option_details, volatility, no_trade_reasons
       FROM signals
       WHERE signal_type IN ('CALL', 'PUT')
         AND COALESCE(market_date, created_at::date::text) >= $1
         AND COALESCE(market_date, created_at::date::text) <= $2
         ${symbolFilter}
       ORDER BY created_at ASC
       LIMIT $3`,
      params
    );
    const { rows: scannerLogRows } = await (this.fastify as any).pg.query(
      `SELECT id, symbol, indicators, no_trade_reasons, created_at
       FROM scanner_logs
       WHERE outcome = 'SIGNAL_GENERATED'
         AND created_at::date >= $1
         AND created_at::date <= $2
         ${symbolFilter}
       ORDER BY created_at ASC
       LIMIT $3`,
      params
    );

    const merged = new Map<string, ReplaySignal>();
    for (const signal of signalRows) {
      merged.set(`signal:${signal.id}`, signal);
    }
    for (const row of scannerLogRows) {
      const scannerSignal = this.scannerLogToReplaySignal(row);
      if (!scannerSignal) continue;
      const key = scannerSignal.id > 0 ? `signal:${scannerSignal.id}` : `log:${row.id}`;
      const existing = merged.get(key);
      merged.set(key, existing ? this.mergeReplaySignals(existing, scannerSignal) : scannerSignal);
    }

    return [...merged.values()]
      .filter((signal) => signal.signal_type === 'CALL' || signal.signal_type === 'PUT')
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
      .slice(0, config.maxSignals);
  }

  private scannerLogToReplaySignal(row: any): ReplaySignal | null {
    const indicators = typeof row.indicators === 'string'
      ? this.parseJsonObject(row.indicators)
      : row.indicators || {};
    const decision = indicators.signalDecision || indicators.decisionSnapshot?.finalDecision?.signalDecision;
    const side = String(decision?.side || '').trim().toUpperCase();
    if (side !== 'CALL' && side !== 'PUT') return null;

    const createdAt = new Date(row.created_at);
    const decisionSnapshot = indicators.decisionSnapshot || null;
    const macroSnapshot = decisionSnapshot?.macroSnapshot || indicators.macroSnapshot || {};
    const macroRegime = macroSnapshot.macroRegime || indicators.macroRegime || null;
    const contract = decision?.contract || {};
    const quote = decision?.quote || {};
    const signalId = Number(decision?.signalId);
    const id = Number.isInteger(signalId) && signalId > 0 ? signalId : -Number(row.id || 0);

    return {
      id,
      symbol: String(row.symbol || decision?.symbol || '').toUpperCase(),
      signal_type: side,
      confidence_score: Number(decision?.grade?.finalConfidence || decisionSnapshot?.finalDecision?.finalConfidence || 0),
      setup_grade: decision?.grade?.setupGrade || decisionSnapshot?.finalDecision?.setupGrade || null,
      created_at: row.created_at,
      market_date: Number.isFinite(createdAt.getTime()) ? this.getNewYorkDateKey(createdAt) : null,
      option_expiration_date: contract.expiry || null,
      option_details: {
        ticker: contract.ticker || null,
        symbol: contract.ticker || null,
        strike: contract.strike ?? null,
        expiry: contract.expiry || null,
        mark: quote.mark ?? null,
        decision,
        decisionSnapshot,
        candidateSelection: decisionSnapshot?.optionSelection?.candidateSelection || null
      },
      volatility: {
        ...macroSnapshot,
        macroRegime
      },
      no_trade_reasons: Array.isArray(row.no_trade_reasons) ? row.no_trade_reasons : []
    };
  }

  private mergeReplaySignals(canonical: ReplaySignal, fallback: ReplaySignal): ReplaySignal {
    const canonicalDetails = canonical.option_details || {};
    const fallbackDetails = fallback.option_details || {};
    return {
      ...fallback,
      ...canonical,
      option_details: {
        ...fallbackDetails,
        ...canonicalDetails,
        decision: canonicalDetails.decision || fallbackDetails.decision,
        decisionSnapshot: canonicalDetails.decisionSnapshot || fallbackDetails.decisionSnapshot,
        candidateSelection: canonicalDetails.candidateSelection || fallbackDetails.candidateSelection
      },
      volatility: {
        ...(fallback.volatility || {}),
        ...(canonical.volatility || {})
      }
    };
  }

  private parseJsonObject(value: string): Record<string, any> {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  private resolveContract(signal: ReplaySignal): IbkrOptionContract | null {
    const decision = this.getSignalDecision(signal);
    if (decision?.contract?.ticker) {
      const parsedDecisionTicker = this.parseOsiTicker(decision.contract.ticker);
      if (parsedDecisionTicker) return parsedDecisionTicker;
    }

    const details = signal.option_details || {};
    const ticker = details.ticker || details.symbol;
    const parsed = this.parseOsiTicker(ticker);
    if (parsed) return parsed;

    const strike = Number(details.strike);
    const expiration = String(details.expiry || details.expiration || signal.option_expiration_date || '');
    if (!Number.isFinite(strike) || !expiration) return null;
    return {
      symbol: signal.symbol,
      expiration: expiration.replace(/-/g, ''),
      right: signal.signal_type === 'CALL' ? 'call' : 'put',
      strike
    };
  }

  private simulateTrade(signal: ReplaySignal, contract: IbkrOptionContract, bars: ReplayBar[], config: ReplayConfig): ReplayTrade | null {
    const decision = this.getSignalDecision(signal);
    const signalTime = new Date(signal.created_at);
    const marketDate = this.getSignalDate(signal);
    const sortedBars = bars
      .map((bar) => ({ ...bar, parsedTime: this.parseBarTime(bar.start, marketDate) }))
      .filter((bar) => bar.parsedTime && bar.close > 0)
      .sort((a, b) => (a.parsedTime as Date).getTime() - (b.parsedTime as Date).getTime());

    const entryBar = sortedBars.find((bar) => (bar.parsedTime as Date).getTime() >= signalTime.getTime());
    if (!entryBar) return null;

    const decisionMark = Number(decision?.quote?.mark || 0);
    const optionMark = Number(signal.option_details?.mark || 0);
    const storedMark = decisionMark > 0 ? decisionMark : optionMark;
    const entryPrice = Number((storedMark > 0 ? storedMark : entryBar.close).toFixed(2));
    if (entryPrice <= 0) return null;

    const targetPrice = Number((entryPrice * (1 + config.takeProfitPct / 100)).toFixed(2));
    const stopPrice = Number((entryPrice * (1 - config.stopLossPct / 100)).toFixed(2));
    let exitBar = entryBar;
    let exitPrice = entryBar.close;
    let exitReason = 'EOD';

    const startIndex = sortedBars.indexOf(entryBar);
    for (let idx = Math.max(0, startIndex); idx < sortedBars.length; idx++) {
      const bar = sortedBars[idx];
      const hitStop = bar.low <= stopPrice;
      const hitTarget = bar.high >= targetPrice;
      if (hitStop && hitTarget) {
        exitBar = bar;
        exitPrice = stopPrice;
        exitReason = 'AMBIGUOUS_BAR_STOP_FIRST';
        break;
      }
      if (hitTarget) {
        exitBar = bar;
        exitPrice = targetPrice;
        exitReason = 'TAKE_PROFIT';
        break;
      }
      if (hitStop) {
        exitBar = bar;
        exitPrice = stopPrice;
        exitReason = 'STOP_LOSS';
        break;
      }
      exitBar = bar;
      exitPrice = bar.close;
    }

    const roundedExitPrice = Number(exitPrice.toFixed(2));
    const pnl = Number(((exitPrice - entryPrice) * config.contractsPerTrade * 100).toFixed(2));
    const signalDecision = this.toReplayTradeDecision(signal, decision);
    return {
      signalId: signal.id,
      date: marketDate,
      symbol: signal.symbol,
      optionTicker: this.constructOsiTicker(contract),
      side: signal.signal_type,
      setupGrade: decision?.grade?.setupGrade || signal.setup_grade,
      confidenceScore: Number(decision?.grade?.finalConfidence ?? signal.confidence_score ?? 0),
      macroRegime: signal.volatility?.macroRegime || null,
      entryTime: (entryBar.parsedTime as Date).toISOString(),
      exitTime: (exitBar.parsedTime as Date).toISOString(),
      entryPrice,
      exitPrice: roundedExitPrice,
      quantity: config.contractsPerTrade,
      pnl,
      roiPct: Number((((exitPrice - entryPrice) / entryPrice) * 100).toFixed(2)),
      exitReason,
      skippedBy: [],
      signalDecision,
      fillRealism: this.buildFillRealism(signalDecision, entryPrice, roundedExitPrice, config.contractsPerTrade)
    };
  }

  private buildParitySummary(signals: ReplaySignal[]): ReplayParitySummary {
    const gaps = this.emptyParityGaps();
    const examples: ReplayParityGap[] = [];
    let withSignalDecision = 0;

    for (const signal of signals) {
      const signalGaps = this.collectParityGaps(signal);
      if (this.getSignalDecision(signal)) withSignalDecision++;
      for (const gap of signalGaps) {
        gaps[gap.type]++;
        if (examples.length < 50) examples.push(gap);
      }
    }

    return {
      signalsChecked: signals.length,
      withSignalDecision,
      missingSignalDecision: signals.length - withSignalDecision,
      gaps,
      examples
    };
  }

  private collectParityGaps(signal: ReplaySignal): ReplayParityGap[] {
    const decision = this.getSignalDecision(signal);
    if (!decision) {
      return [this.parityGap(signal, 'missing_signal_decision', 'Signal has no stored SignalDecision in option_details.decision.')];
    }

    const gaps: ReplayParityGap[] = [];
    const details = signal.option_details || {};
    const decisionTicker = this.normalizeTicker(decision.contract?.ticker);
    const storedTicker = this.normalizeTicker(details.ticker || details.symbol);
    if (decisionTicker && storedTicker && decisionTicker !== storedTicker) {
      gaps.push(this.parityGap(signal, 'contract_mismatch', 'Stored SignalDecision contract ticker differs from option_details ticker.', {
        decisionTicker,
        storedTicker
      }));
    }

    const decisionSide = String(decision.side || '').toUpperCase();
    if (decisionSide && decisionSide !== signal.signal_type) {
      gaps.push(this.parityGap(signal, 'side_mismatch', 'Stored SignalDecision side differs from signal_type.', {
        decisionSide,
        signalType: signal.signal_type
      }));
    }

    const decisionGrade = decision.grade?.setupGrade || decision.grade?.gradeKey || null;
    if (decisionGrade && signal.setup_grade && decisionGrade !== signal.setup_grade) {
      gaps.push(this.parityGap(signal, 'grade_mismatch', 'Stored SignalDecision grade differs from signal setup_grade.', {
        decisionGrade,
        setupGrade: signal.setup_grade
      }));
    }

    const decisionConfidence = Number(decision.grade?.finalConfidence);
    const signalConfidence = Number(signal.confidence_score);
    if (Number.isFinite(decisionConfidence) && Number.isFinite(signalConfidence) && Math.abs(decisionConfidence - signalConfidence) > 0.01) {
      gaps.push(this.parityGap(signal, 'confidence_mismatch', 'Stored SignalDecision final confidence differs from signal confidence_score.', {
        decisionConfidence,
        signalConfidence
      }));
    }

    const expectedExecutable = this.isExecutableGrade(signal.setup_grade);
    if (typeof decision.grade?.executable === 'boolean' && decision.grade.executable !== expectedExecutable) {
      gaps.push(this.parityGap(signal, 'executable_mismatch', 'Stored SignalDecision executable flag differs from replay grade executable assumption.', {
        decisionExecutable: decision.grade.executable,
        replayExecutable: expectedExecutable,
        setupGrade: signal.setup_grade
      }));
    }

    if (decision.quote?.usingTheoreticalPricing) {
      gaps.push(this.parityGap(signal, 'theoretical_pricing', 'Stored SignalDecision used theoretical option pricing.', {
        ticker: decision.contract?.ticker || storedTicker || null
      }));
    }

    const pricingWarnings = Array.isArray(decision.grade?.pricingWarnings) ? decision.grade.pricingWarnings : [];
    if (pricingWarnings.length > 0) {
      gaps.push(this.parityGap(signal, 'pricing_warning', 'Stored SignalDecision includes pricing warnings.', {
        pricingWarnings: pricingWarnings.slice(0, 5)
      }));
    }

    return gaps;
  }

  private buildSnapshotDriftReport(signals: ReplaySignal[]): ReplaySnapshotDriftReport {
    const driftCounts = this.emptySnapshotDriftCounts();
    const examples: ReplaySnapshotDriftExample[] = [];
    let withDecisionSnapshot = 0;

    for (const signal of signals) {
      const snapshot = this.getDecisionSnapshot(signal);
      if (snapshot) withDecisionSnapshot++;
      const signalDrifts = this.collectSnapshotDrifts(signal);
      for (const drift of signalDrifts) {
        driftCounts[drift.type]++;
        if (examples.length < 50) examples.push(drift);
      }
    }

    return {
      signalsChecked: signals.length,
      withDecisionSnapshot,
      missingDecisionSnapshot: signals.length - withDecisionSnapshot,
      driftCounts,
      examples
    };
  }

  private collectSnapshotDrifts(signal: ReplaySignal): ReplaySnapshotDriftExample[] {
    const snapshot = this.getDecisionSnapshot(signal);
    if (!snapshot) {
      return [this.snapshotDrift(signal, 'missing_decision_snapshot', 'Signal has no immutable decisionSnapshot in option_details.decisionSnapshot.')];
    }

    const drifts: ReplaySnapshotDriftExample[] = [];
    const originalDecision = this.summarizeSnapshotDecision(snapshot);
    const replayedDecision = this.summarizeCurrentDecision(signal);
    const commonMetadata = { originalDecision, replayedDecision };

    if (originalDecision.side && replayedDecision.side && originalDecision.side !== replayedDecision.side) {
      drifts.push(this.snapshotDrift(signal, 'side_drift', 'Snapshot side differs from replayed signal side.', {
        ...commonMetadata,
        originalSide: originalDecision.side,
        replayedSide: replayedDecision.side
      }));
    }

    if (originalDecision.score !== null && replayedDecision.score !== null && Math.abs(originalDecision.score - replayedDecision.score) > 0.01) {
      drifts.push(this.snapshotDrift(signal, 'score_drift', 'Snapshot score differs from replayed signal confidence.', {
        ...commonMetadata,
        scoreDelta: Number((replayedDecision.score - originalDecision.score).toFixed(2))
      }));
    }

    if (originalDecision.grade && replayedDecision.grade && originalDecision.grade !== replayedDecision.grade) {
      drifts.push(this.snapshotDrift(signal, 'grade_drift', 'Snapshot grade differs from replayed signal grade.', {
        ...commonMetadata,
        originalGrade: originalDecision.grade,
        replayedGrade: replayedDecision.grade
      }));
    }

    const blockerDelta = this.diffStringLists(originalDecision.blockers, replayedDecision.blockers);
    if (blockerDelta.added.length > 0 || blockerDelta.removed.length > 0) {
      drifts.push(this.snapshotDrift(signal, 'blocker_drift', 'Snapshot blockers differ from replayed blockers.', {
        ...commonMetadata,
        blockerDelta
      }));
    }

    if (
      originalDecision.contractTicker &&
      replayedDecision.contractTicker &&
      originalDecision.contractTicker !== replayedDecision.contractTicker
    ) {
      drifts.push(this.snapshotDrift(signal, 'contract_selection_drift', 'Snapshot selected contract differs from replayed contract.', {
        ...commonMetadata,
        originalContractTicker: originalDecision.contractTicker,
        replayedContractTicker: replayedDecision.contractTicker
      }));
    }

    return drifts;
  }

  private getDecisionSnapshot(signal: ReplaySignal): any | null {
    const snapshot = signal.option_details?.decisionSnapshot;
    return snapshot && typeof snapshot === 'object' ? snapshot : null;
  }

  private summarizeSnapshotDecision(snapshot: any): ReplaySnapshotDecisionSummary {
    const signalDecision = snapshot.finalDecision?.signalDecision || {};
    return {
      side: this.normalizeSide(signalDecision.side || snapshot.scoring?.winningSide),
      score: this.finiteNumber(snapshot.finalDecision?.finalConfidence ?? signalDecision.grade?.finalConfidence ?? snapshot.scoring?.winningScore),
      grade: this.normalizeGrade(snapshot.finalDecision?.setupGrade || signalDecision.grade?.setupGrade || signalDecision.grade?.gradeKey),
      blockers: this.normalizeStringList(snapshot.blockers),
      contractTicker: this.normalizeTicker(signalDecision.contract?.ticker || snapshot.optionSelection?.selectedContract?.ticker),
      dynamicMinScore: this.finiteNumber(snapshot.scoring?.dynamicMinScore)
    };
  }

  private summarizeCurrentDecision(signal: ReplaySignal): ReplaySnapshotDecisionSummary {
    const decision = this.getSignalDecision(signal);
    return {
      side: this.normalizeSide(decision?.side || signal.signal_type),
      score: this.finiteNumber(decision?.grade?.finalConfidence ?? signal.confidence_score),
      grade: this.normalizeGrade(decision?.grade?.setupGrade || decision?.grade?.gradeKey || signal.setup_grade),
      blockers: this.normalizeStringList(signal.no_trade_reasons),
      contractTicker: this.normalizeTicker(decision?.contract?.ticker || signal.option_details?.ticker || signal.option_details?.symbol),
      dynamicMinScore: null
    };
  }

  private getSignalDecision(signal: ReplaySignal): SignalDecision | null {
    const decision = signal.option_details?.decision;
    return decision && typeof decision === 'object' ? decision as SignalDecision : null;
  }

  private toReplayTradeDecision(signal: ReplaySignal, decision: SignalDecision | null): ReplayTradeDecision | null {
    if (!decision) return null;
    const spreadPct = this.finiteNumber(decision.quote?.spreadPct);
    const volume = this.finiteNumber(decision.quote?.volume);
    const openInterest = this.finiteNumber(decision.quote?.openInterest);
    const delta = this.getDecisionDelta(signal, decision);
    const pricingWarnings = Array.isArray(decision.grade?.pricingWarnings) ? decision.grade.pricingWarnings : [];
    const blockers = Array.isArray(decision.grade?.blockers) ? decision.grade.blockers : [];
    const warnings = Array.isArray(decision.grade?.warnings) ? decision.grade.warnings : [];
    return {
      gradeKey: decision.grade?.gradeKey || null,
      executable: typeof decision.grade?.executable === 'boolean' ? decision.grade.executable : null,
      usingTheoreticalPricing: Boolean(decision.quote?.usingTheoreticalPricing),
      spreadPct,
      spreadBucket: this.getSpreadBucket(spreadPct),
      volume,
      openInterest,
      delta,
      deltaBucket: this.getDeltaBucket(delta),
      quoteQuality: this.getQuoteQualityBucket(decision),
      pricingWarnings,
      warningTypes: this.getWarningTypes(pricingWarnings, warnings, blockers),
      blockers
    };
  }

  private buildCalibrationReport(trades: ReplayTrade[]): ReplayCalibrationReport {
    return {
      scenario: 'baseline',
      totalTrades: trades.length,
      dimensions: {
        symbol: this.buildCalibrationBuckets(trades, (trade) => trade.symbol),
        regime: this.buildCalibrationBuckets(trades, (trade) => this.getCalibrationRegimeKey(trade)),
        timeWindow: this.buildCalibrationBuckets(trades, (trade) => this.getTimeWindowKey(trade.entryTime)),
        quoteQuality: this.buildCalibrationBuckets(trades, (trade) => trade.signalDecision?.quoteQuality || 'missing_quote')
      }
    };
  }

  private buildAttributionReport(trades: ReplayTrade[]): ReplayAttributionReport {
    return {
      scenario: 'baseline',
      totalTrades: trades.length,
      dimensions: {
        grade: this.buildCalibrationBuckets(trades, (trade) => this.getGradeKey(trade)),
        regime: this.buildCalibrationBuckets(trades, (trade) => this.getCalibrationRegimeKey(trade)),
        warningType: this.buildMultiKeyBuckets(trades, (trade) => trade.signalDecision?.warningTypes || ['no_warning']),
        deltaBucket: this.buildCalibrationBuckets(trades, (trade) => trade.signalDecision?.deltaBucket || 'delta_unknown'),
        spreadBucket: this.buildCalibrationBuckets(trades, (trade) => trade.signalDecision?.spreadBucket || 'spread_unknown'),
        timeOfDay: this.buildCalibrationBuckets(trades, (trade) => this.getTimeWindowKey(trade.entryTime))
      }
    };
  }

  private buildFillRealism(decision: ReplayTradeDecision | null, entryPrice: number, exitPrice: number, quantity: number): ReplayFillRealism {
    const reasons: string[] = [];
    let penaltyPct = 0;
    let score = 100;
    let action: ReplayFillRealismAction = 'UNCHANGED';

    if (!decision) {
      return this.fillRealismResult('PENALIZED', 70, ['No stored decision metadata; applying conservative fill penalty'], entryPrice, exitPrice, quantity, 4);
    }
    if (decision.usingTheoreticalPricing || decision.warningTypes.includes('theoretical_pricing')) {
      return this.fillRealismResult('SKIPPED', 0, ['Theoretical option pricing is not fill-realistic'], entryPrice, exitPrice, quantity, 100);
    }
    if (decision.spreadPct === null) {
      score -= 20;
      penaltyPct += 4;
      reasons.push('Spread unavailable');
    } else if (decision.spreadPct > 20) {
      return this.fillRealismResult('SKIPPED', 10, [`Spread ${decision.spreadPct}% is too extreme for realistic replay fill`], entryPrice, exitPrice, quantity, 100);
    } else if (decision.spreadPct > 12) {
      score -= 25;
      penaltyPct += 10;
      reasons.push(`Spread ${decision.spreadPct}% is very wide`);
    } else if (decision.spreadPct > 8) {
      score -= 12;
      penaltyPct += 5;
      reasons.push(`Spread ${decision.spreadPct}% is above preferred range`);
    }

    if (decision.volume !== null && decision.volume < 100) {
      return this.fillRealismResult('SKIPPED', 15, [`Volume ${decision.volume} is too light for realistic replay fill`], entryPrice, exitPrice, quantity, 100);
    }
    if (decision.volume === null) {
      score -= 8;
      penaltyPct += 2;
      reasons.push('Volume unavailable');
    } else if (decision.volume < 500) {
      score -= 10;
      penaltyPct += 3;
      reasons.push(`Volume ${decision.volume} is below preferred liquidity`);
    }

    if (decision.openInterest !== null && decision.openInterest < 250) {
      return this.fillRealismResult('SKIPPED', 20, [`Open interest ${decision.openInterest} is too thin for realistic replay fill`], entryPrice, exitPrice, quantity, 100);
    }
    if (decision.openInterest === null) {
      score -= 8;
      penaltyPct += 2;
      reasons.push('Open interest unavailable');
    } else if (decision.openInterest < 1000) {
      score -= 5;
      penaltyPct += 2;
      reasons.push(`Open interest ${decision.openInterest} is below preferred depth`);
    }

    if (decision.warningTypes.includes('quote_warning')) {
      score -= 15;
      penaltyPct += 5;
      reasons.push('Quote warning present');
    }

    if (penaltyPct > 0) action = 'PENALIZED';
    return this.fillRealismResult(action, Math.max(0, score), reasons.length > 0 ? reasons : ['Clean replay fill'], entryPrice, exitPrice, quantity, penaltyPct);
  }

  private fillRealismResult(action: ReplayFillRealismAction, score: number, reasons: string[], entryPrice: number, exitPrice: number, quantity: number, penaltyPct: number): ReplayFillRealism {
    const adjustedEntryPrice = action === 'SKIPPED' ? entryPrice : Number((entryPrice * (1 + penaltyPct / 100)).toFixed(2));
    const adjustedExitPrice = action === 'SKIPPED' ? entryPrice : Number((exitPrice * (1 - Math.min(penaltyPct / 2, 8) / 100)).toFixed(2));
    const adjustedPnl = action === 'SKIPPED' ? 0 : Number(((adjustedExitPrice - adjustedEntryPrice) * quantity * 100).toFixed(2));
    return {
      action,
      score,
      reasons,
      adjustedEntryPrice,
      adjustedExitPrice,
      adjustedPnl,
      adjustedRoiPct: adjustedEntryPrice > 0 ? Number((((adjustedExitPrice - adjustedEntryPrice) / adjustedEntryPrice) * 100).toFixed(2)) : 0
    };
  }

  private summarizeFillRealism(trades: ReplayTrade[]): ReplayFillRealismSummary {
    const rawTotalPnl = Number(trades.reduce((sum, trade) => sum + trade.pnl, 0).toFixed(2));
    const realisticTotalPnl = Number(trades.reduce((sum, trade) => sum + trade.fillRealism.adjustedPnl, 0).toFixed(2));
    return {
      rawTotalPnl,
      realisticTotalPnl,
      pnlDelta: Number((realisticTotalPnl - rawTotalPnl).toFixed(2)),
      skippedTrades: trades.filter((trade) => trade.fillRealism.action === 'SKIPPED').length,
      penalizedTrades: trades.filter((trade) => trade.fillRealism.action === 'PENALIZED').length,
      unchangedTrades: trades.filter((trade) => trade.fillRealism.action === 'UNCHANGED').length
    };
  }

  private buildCalibrationBuckets(trades: ReplayTrade[], getKey: (trade: ReplayTrade) => string): ReplayCalibrationBucket[] {
    const groups = new Map<string, ReplayTrade[]>();
    for (const trade of trades) {
      const key = getKey(trade) || 'unknown';
      const group = groups.get(key) || [];
      group.push(trade);
      groups.set(key, group);
    }
    return [...groups.entries()]
      .map(([key, groupTrades]) => this.summarizeCalibrationBucket(key, groupTrades))
      .sort((a, b) => b.trades - a.trades || a.key.localeCompare(b.key));
  }

  private buildMultiKeyBuckets(trades: ReplayTrade[], getKeys: (trade: ReplayTrade) => string[]): ReplayCalibrationBucket[] {
    const groups = new Map<string, ReplayTrade[]>();
    for (const trade of trades) {
      const keys = getKeys(trade).filter(Boolean);
      for (const key of keys.length > 0 ? keys : ['unknown']) {
        const group = groups.get(key) || [];
        group.push(trade);
        groups.set(key, group);
      }
    }
    return [...groups.entries()]
      .map(([key, groupTrades]) => this.summarizeCalibrationBucket(key, groupTrades))
      .sort((a, b) => b.trades - a.trades || a.key.localeCompare(b.key));
  }

  private summarizeCalibrationBucket(key: string, trades: ReplayTrade[]): ReplayCalibrationBucket {
    const wins = trades.filter((trade) => trade.pnl > 0);
    const losses = trades.filter((trade) => trade.pnl <= 0);
    const totalPnl = Number(trades.reduce((sum, trade) => sum + trade.pnl, 0).toFixed(2));
    const gradeMix: Record<string, number> = {};
    for (const trade of trades) {
      const grade = this.getGradeKey(trade);
      gradeMix[grade] = (gradeMix[grade] || 0) + 1;
    }

    return {
      key,
      trades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: this.percent(wins.length, trades.length),
      totalPnl,
      averagePnl: trades.length > 0 ? Number((totalPnl / trades.length).toFixed(2)) : 0,
      averageRoiPct: this.average(trades.map((trade) => trade.roiPct)),
      averageConfidence: this.average(trades.map((trade) => trade.confidenceScore)),
      profitFactor: this.profitFactor(trades),
      gradeMix,
      thresholds: this.buildThresholdCalibration(trades)
    };
  }

  private buildThresholdCalibration(trades: ReplayTrade[]): ReplayCalibrationThreshold[] {
    return [70, 80, 85, 90, 92].map((minConfidence) => {
      const thresholdTrades = trades.filter((trade) => trade.confidenceScore >= minConfidence);
      const wins = thresholdTrades.filter((trade) => trade.pnl > 0);
      return {
        minConfidence,
        trades: thresholdTrades.length,
        wins: wins.length,
        winRate: this.percent(wins.length, thresholdTrades.length),
        totalPnl: Number(thresholdTrades.reduce((sum, trade) => sum + trade.pnl, 0).toFixed(2)),
        averageRoiPct: this.average(thresholdTrades.map((trade) => trade.roiPct)),
        profitFactor: this.profitFactor(thresholdTrades)
      };
    });
  }

  private getCalibrationRegimeKey(trade: ReplayTrade): string {
    const macro = trade.macroRegime || {};
    return String(macro.regime || macro.directionBias || 'unknown').toLowerCase();
  }

  private getTimeWindowKey(value: string): string {
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) return 'unknown';
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      hourCycle: 'h23'
    });
    const parts = formatter.formatToParts(parsed);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value || 0);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value || 0);
    const minutes = hour * 60 + minute;
    if (minutes < 570 || minutes >= 960) return 'outside_regular_hours';
    if (minutes < 630) return 'open_0930_1030';
    if (minutes < 720) return 'morning_1030_1200';
    if (minutes < 840) return 'midday_1200_1400';
    if (minutes < 930) return 'afternoon_1400_1530';
    return 'power_hour_1530_1600';
  }

  private getQuoteQualityBucket(decision: SignalDecision): ReplayQuoteQualityBucket {
    if (decision.quote?.usingTheoreticalPricing) return 'theoretical_pricing';
    const mark = this.finiteNumber(decision.quote?.mark);
    if (mark === null || mark <= 0) return 'missing_quote';
    const spreadPct = this.finiteNumber(decision.quote?.spreadPct);
    const pricingWarnings = Array.isArray(decision.grade?.pricingWarnings) ? decision.grade.pricingWarnings : [];
    if ((spreadPct !== null && spreadPct > 15) || pricingWarnings.length > 0) return 'wide_spread';
    if (spreadPct !== null && spreadPct > 8) return 'acceptable_spread';
    return 'clean';
  }

  private getGradeKey(trade: ReplayTrade): string {
    return trade.signalDecision?.gradeKey || String(trade.setupGrade || 'unknown').toUpperCase();
  }

  private getDecisionDelta(signal: ReplaySignal, decision: SignalDecision): number | null {
    const decisionTicker = this.normalizeTicker(decision.contract?.ticker);
    const candidates = Array.isArray(signal.option_details?.candidateSelection?.candidates)
      ? signal.option_details.candidateSelection.candidates
      : [];
    const selected = candidates.find((candidate: any) => this.normalizeTicker(candidate?.ticker) === decisionTicker);
    return this.finiteNumber(selected?.delta);
  }

  private getDeltaBucket(delta: number | null): string {
    if (delta === null) return 'delta_unknown';
    const absDelta = Math.abs(delta);
    if (absDelta < 0.25) return 'delta_low_lt_25';
    if (absDelta < 0.35) return 'delta_25_35';
    if (absDelta <= 0.6) return 'delta_core_35_60';
    if (absDelta <= 0.7) return 'delta_high_60_70';
    return 'delta_too_high_gt_70';
  }

  private getSpreadBucket(spreadPct: number | null): string {
    if (spreadPct === null) return 'spread_unknown';
    if (spreadPct <= 5) return 'spread_tight_lte_5';
    if (spreadPct <= 8) return 'spread_ok_5_8';
    if (spreadPct <= 12) return 'spread_wide_8_12';
    if (spreadPct <= 20) return 'spread_very_wide_12_20';
    return 'spread_extreme_gt_20';
  }

  private getWarningTypes(pricingWarnings: string[], warnings: string[], blockers: string[]): string[] {
    const warningText = [...pricingWarnings, ...warnings, ...blockers].join(' ').toLowerCase();
    const types = new Set<string>();
    if (warningText.includes('theoretical')) types.add('theoretical_pricing');
    if (warningText.includes('spread')) types.add('spread_warning');
    if (warningText.includes('volume')) types.add('volume_warning');
    if (warningText.includes('open interest') || /\boi\b/.test(warningText)) types.add('open_interest_warning');
    if (warningText.includes('premium')) types.add('premium_warning');
    if (warningText.includes('quote') || warningText.includes('bid') || warningText.includes('ask')) types.add('quote_warning');
    if (warningText.includes('macro') || warningText.includes('vix') || warningText.includes('dxy') || warningText.includes('10y')) types.add('macro_warning');
    return types.size > 0 ? [...types].sort() : ['no_warning'];
  }

  private profitFactor(trades: ReplayTrade[]): number {
    const totalGains = trades.filter((trade) => trade.pnl > 0).reduce((sum, trade) => sum + trade.pnl, 0);
    const totalLosses = Math.abs(trades.filter((trade) => trade.pnl <= 0).reduce((sum, trade) => sum + trade.pnl, 0));
    return totalLosses > 0 ? Number((totalGains / totalLosses).toFixed(2)) : totalGains > 0 ? 99.99 : 0;
  }

  private average(values: number[]): number {
    const finiteValues = values.filter((value) => Number.isFinite(value));
    if (finiteValues.length === 0) return 0;
    return Number((finiteValues.reduce((sum, value) => sum + value, 0) / finiteValues.length).toFixed(2));
  }

  private percent(part: number, total: number): number {
    return total > 0 ? Number(((part / total) * 100).toFixed(2)) : 0;
  }

  private parityGap(signal: ReplaySignal, type: ReplayParityGapType, message: string, metadata?: Record<string, any>): ReplayParityGap {
    return {
      signalId: signal.id,
      symbol: signal.symbol,
      type,
      message,
      ...(metadata ? { metadata } : {})
    };
  }

  private emptyParityGaps(): Record<ReplayParityGapType, number> {
    return {
      missing_signal_decision: 0,
      contract_mismatch: 0,
      side_mismatch: 0,
      grade_mismatch: 0,
      confidence_mismatch: 0,
      executable_mismatch: 0,
      theoretical_pricing: 0,
      pricing_warning: 0
    };
  }

  private snapshotDrift(signal: ReplaySignal, type: ReplaySnapshotDriftType, message: string, metadata?: Record<string, any>): ReplaySnapshotDriftExample {
    return {
      signalId: signal.id,
      symbol: signal.symbol,
      type,
      message,
      ...(metadata ? { metadata } : {})
    };
  }

  private emptySnapshotDriftCounts(): Record<ReplaySnapshotDriftType, number> {
    return {
      missing_decision_snapshot: 0,
      side_drift: 0,
      score_drift: 0,
      grade_drift: 0,
      blocker_drift: 0,
      contract_selection_drift: 0
    };
  }

  private diffStringLists(original: string[], replayed: string[]): { added: string[]; removed: string[] } {
    const originalSet = new Set(original);
    const replayedSet = new Set(replayed);
    return {
      added: replayed.filter((item) => !originalSet.has(item)),
      removed: original.filter((item) => !replayedSet.has(item))
    };
  }

  private isExecutableGrade(setupGrade: string | null): boolean {
    return ['A+', 'A', 'B'].includes(String(setupGrade || '').toUpperCase());
  }

  private normalizeSide(value: any): string | null {
    const side = String(value || '').trim().toUpperCase();
    return side === 'CALL' || side === 'PUT' ? side : null;
  }

  private normalizeGrade(value: any): string | null {
    const grade = String(value || '').trim().toUpperCase();
    return grade || null;
  }

  private normalizeTicker(value: any): string | null {
    const ticker = String(value || '').replace(/\s+/g, '').toUpperCase();
    return ticker || null;
  }

  private normalizeStringList(value: any): string[] {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))].sort();
  }

  private finiteNumber(value: any): number | null {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  private getScenarioSkipReason(scenario: ReplayScenario['name'], signal: ReplaySignal): string | null {
    if (scenario === 'baseline') return null;
    if (scenario === 'vix_contango') {
      const termStructure = this.getVixTermStructure(signal);
      if (!termStructure) return 'vix_term_structure_unavailable';
      const ratio = this.finiteNumber(termStructure.ratio);
      const minimumRatio = this.finiteNumber(termStructure.minimumRatio) ?? 1.05;
      if (ratio === null) return 'vix_term_structure_unavailable';
      return ratio >= minimumRatio ? null : 'vix_term_structure_below_floor';
    }
    const macro = signal.volatility?.macroRegime;
    if (!macro) return 'macro_unavailable';
    const directionBias = String(macro.directionBias || 'MIXED');
    const side = signal.signal_type;
    if (directionBias !== 'MIXED' && directionBias !== side) return 'macro_conflict';
    if (scenario === 'macro_strict') {
      if (Array.isArray(macro.blockers) && macro.blockers.length > 0) return 'macro_blocker';
      if (Number(macro.score || 0) < 62) return 'macro_score_below_62';
    }
    return null;
  }

  private getVixTermStructure(signal: ReplaySignal): any | null {
    const candidates = [
      signal.replayVixTermStructure,
      signal.option_details?.decisionSnapshot?.macroSnapshot?.vixTermStructure,
      signal.option_details?.macroSnapshot?.vixTermStructure,
      signal.volatility?.vixTermStructure,
      signal.volatility?.macroSnapshot?.vixTermStructure
    ];
    return candidates.find((candidate) => candidate && typeof candidate === 'object') || null;
  }

  private async backfillHistoricalVixTermStructure(signals: ReplaySignal[]): Promise<ReplayVixBackfillSummary> {
    const signalsNeedingBackfill = signals.filter((signal) => !this.hasUsableVixTermStructure(signal));
    if (signalsNeedingBackfill.length === 0) return { backfilled: 0, unavailable: 0 };

    const historyByDate = new Map<string, Promise<{ vix: ReplayBar[]; vix3m: ReplayBar[] }>>();
    const loadDateHistory = (dateKey: string) => {
      const cached = historyByDate.get(dateKey);
      if (cached) return cached;
      const request = Promise.all([
        this.ibkrMarketData.getHistoricalIndexBars('VIX', this.dateAtEt(dateKey, 16, 0), '1 D', '5 mins').catch((err: any) => {
          this.fastify.log.warn(`[SignalReplayBacktester] IBKR VIX history unavailable for ${dateKey}: ${err.message || String(err)}`);
          return [];
        }),
        this.ibkrMarketData.getHistoricalIndexBars('VIX3M', this.dateAtEt(dateKey, 16, 0), '1 D', '5 mins').catch((err: any) => {
          this.fastify.log.warn(`[SignalReplayBacktester] IBKR VIX3M history unavailable for ${dateKey}: ${err.message || String(err)}`);
          return [];
        })
      ]).then(([vix, vix3m]) => ({ vix, vix3m }));
      historyByDate.set(dateKey, request);
      return request;
    };

    let backfilled = 0;
    let unavailable = 0;
    for (const signal of signalsNeedingBackfill) {
      const dateKey = this.getSignalDate(signal);
      const signalTime = new Date(signal.created_at);
      if (!Number.isFinite(signalTime.getTime())) {
        unavailable++;
        continue;
      }
      const history = await loadDateHistory(dateKey);
      const vixBar = this.latestHistoricalBarAtOrBefore(history.vix, signalTime, dateKey);
      const vix3mBar = this.latestHistoricalBarAtOrBefore(history.vix3m, signalTime, dateKey);
      const vix = vixBar ? this.finiteNumber(vixBar.close) : null;
      const vix3m = vix3mBar ? this.finiteNumber(vix3mBar.close) : null;
      if (vix === null || vix3m === null || vix <= 0 || vix3m <= 0) {
        unavailable++;
        continue;
      }

      const ratio = Number((vix3m / vix).toFixed(4));
      const minimumRatio = 1.05;
      signal.replayVixTermStructure = {
        vix,
        vix3m,
        ratio,
        minimumRatio,
        status: ratio >= 1.1 ? 'STRONG_CONTANGO' : ratio >= minimumRatio ? 'CONTANGO' : 'NEUTRAL',
        blocker: ratio >= minimumRatio ? null : 'VIX term structure is neutral',
        source: 'ibkr_historical',
        capturedAt: vixBar && vix3mBar
          ? new Date(Math.max(new Date(vixBar.start).getTime(), new Date(vix3mBar.start).getTime())).toISOString()
          : signalTime.toISOString()
      };
      backfilled++;
    }

    return { backfilled, unavailable };
  }

  private hasUsableVixTermStructure(signal: ReplaySignal): boolean {
    const termStructure = this.getVixTermStructure(signal);
    return this.finiteNumber(termStructure?.vix) !== null &&
      this.finiteNumber(termStructure?.vix3m) !== null &&
      this.finiteNumber(termStructure?.ratio) !== null;
  }

  private latestHistoricalBarAtOrBefore(bars: ReplayBar[], signalTime: Date, dateKey: string): ReplayBar | null {
    return bars
      .map((bar) => ({ bar, time: this.parseBarTime(bar.start, dateKey) }))
      .filter((item): item is { bar: ReplayBar; time: Date } => item.time instanceof Date && this.getNewYorkDateKey(item.time) === dateKey && item.time.getTime() <= signalTime.getTime())
      .sort((a, b) => b.time.getTime() - a.time.getTime())[0]?.bar || null;
  }

  private getNewYorkDateKey(date: Date): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(date);
  }

  private buildVixTermStructureResearchReport(
    signals: ReplaySignal[],
    baseline: ReplayScenario,
    candidate: ReplayScenario,
    historicalBackfill: ReplayVixBackfillSummary = { backfilled: 0, unavailable: 0 }
  ): ReplayResearchReport {
    const termStructureSignals = signals.filter((signal) => this.hasUsableVixTermStructure(signal));
    const minimumRatio = termStructureSignals
      .map((signal) => this.finiteNumber(this.getVixTermStructure(signal)?.minimumRatio))
      .find((value): value is number => value !== null) ?? 1.05;
    const minimumComparableTrades = 20;
    const project = (summary: ReplaySummary) => ({
      trades: summary.trades,
      winRate: summary.winRate,
      totalPnl: summary.totalPnl,
      profitFactor: summary.profitFactor,
      maxDrawdown: summary.maxDrawdown
    });
    const baselineMetrics = project(baseline.summary);
    const candidateMetrics = project(candidate.summary);
    const delta = {
      trades: candidateMetrics.trades - baselineMetrics.trades,
      winRate: Number((candidateMetrics.winRate - baselineMetrics.winRate).toFixed(2)),
      totalPnl: Number((candidateMetrics.totalPnl - baselineMetrics.totalPnl).toFixed(2)),
      profitFactor: Number((candidateMetrics.profitFactor - baselineMetrics.profitFactor).toFixed(2)),
      maxDrawdown: Number((candidateMetrics.maxDrawdown - baselineMetrics.maxDrawdown).toFixed(2))
    };
    const notes = [
      'This is a comparison report, not an automatic strategy approval.',
      `IBKR historical backfill added VIX/VIX3M evidence to ${historicalBackfill.backfilled} signals; ${historicalBackfill.unavailable} remained unavailable.`,
      'The candidate uses stored or signal-time IBKR historical VIX/VIX3M evidence; it does not use current macro data for past signals.',
      'Signals without usable term-structure evidence are excluded from the candidate scenario.'
    ];
    if (candidateMetrics.trades < minimumComparableTrades) {
      const exclusions = Object.entries(candidate.skippedReasons || {})
        .map(([reason, count]) => `${reason}=${count}`)
        .join(', ');
      notes.push(`Candidate has ${candidateMetrics.trades} trades; at least ${minimumComparableTrades} are required before review${exclusions ? ` (${exclusions})` : ''}.`);
    }

    return {
      experiment: 'vix_term_structure',
      candidateScenario: 'vix_contango',
      minimumRatio,
      signalsWithTermStructure: termStructureSignals.length,
      signalsMissingTermStructure: signals.length - termStructureSignals.length,
      signalsBackfilledFromIbkr: historicalBackfill.backfilled,
      signalsUnavailableForBackfill: historicalBackfill.unavailable,
      minimumComparableTrades,
      status: candidateMetrics.trades >= minimumComparableTrades ? 'READY_FOR_REVIEW' : 'INSUFFICIENT_DATA',
      baseline: baselineMetrics,
      candidate: candidateMetrics,
      delta,
      notes
    };
  }

  private shouldSkipForDailyControls(state: ReturnType<SignalReplayBacktester['newScenarioState']>, dateKey: string, config: ReplayConfig): boolean {
    const dailyTrades = state.dailyTrades.get(dateKey) || 0;
    const dailyPnl = state.dailyPnl.get(dateKey) || 0;
    return dailyTrades >= config.maxTradesPerDay ||
      dailyPnl >= config.dailyProfitTarget ||
      dailyPnl <= -config.dailyLossLimit;
  }

  private applyTradeToState(state: ReturnType<SignalReplayBacktester['newScenarioState']>, dateKey: string, pnl: number, config: ReplayConfig) {
    state.dailyTrades.set(dateKey, (state.dailyTrades.get(dateKey) || 0) + 1);
    state.dailyPnl.set(dateKey, Number(((state.dailyPnl.get(dateKey) || 0) + pnl).toFixed(2)));
  }

  private summarize(trades: ReplayTrade[], dailyPnl: Map<string, number>, config: ReplayConfig): ReplaySummary {
    const wins = trades.filter((trade) => trade.pnl > 0);
    const losses = trades.filter((trade) => trade.pnl <= 0);
    const totalGains = wins.reduce((sum, trade) => sum + trade.pnl, 0);
    const totalLosses = Math.abs(losses.reduce((sum, trade) => sum + trade.pnl, 0));
    let equity = 0;
    let peak = 0;
    let maxDrawdown = 0;
    for (const trade of trades) {
      equity += trade.pnl;
      peak = Math.max(peak, equity);
      maxDrawdown = Math.max(maxDrawdown, peak - equity);
    }
    const dayValues = [...dailyPnl.values()];
    return {
      trades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: trades.length > 0 ? Number(((wins.length / trades.length) * 100).toFixed(2)) : 0,
      totalPnl: Number(trades.reduce((sum, trade) => sum + trade.pnl, 0).toFixed(2)),
      averageWin: wins.length > 0 ? Number((totalGains / wins.length).toFixed(2)) : 0,
      averageLoss: losses.length > 0 ? Number((-totalLosses / losses.length).toFixed(2)) : 0,
      profitFactor: totalLosses > 0 ? Number((totalGains / totalLosses).toFixed(2)) : totalGains > 0 ? 99.99 : 0,
      maxDrawdown: Number(maxDrawdown.toFixed(2)),
      daysTested: dayValues.length,
      greenDays: dayValues.filter((pnl) => pnl > 0).length,
      redDays: dayValues.filter((pnl) => pnl < 0).length,
      targetDays: dayValues.filter((pnl) => pnl >= config.dailyProfitTarget).length,
      lossLimitDays: dayValues.filter((pnl) => pnl <= -config.dailyLossLimit).length
    };
  }

  private noteSkip(scenario: ReplayScenario, reason: string) {
    scenario.skippedSignals++;
    scenario.skippedReasons[reason] = (scenario.skippedReasons[reason] || 0) + 1;
  }

  private emptySummary(): ReplaySummary {
    return {
      trades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      totalPnl: 0,
      averageWin: 0,
      averageLoss: 0,
      profitFactor: 0,
      maxDrawdown: 0,
      daysTested: 0,
      greenDays: 0,
      redDays: 0,
      targetDays: 0,
      lossLimitDays: 0
    };
  }

  private emptyFillRealismSummary(): ReplayFillRealismSummary {
    return {
      rawTotalPnl: 0,
      realisticTotalPnl: 0,
      pnlDelta: 0,
      skippedTrades: 0,
      penalizedTrades: 0,
      unchangedTrades: 0
    };
  }

  private newScenarioState() {
    return {
      dailyTrades: new Map<string, number>(),
      dailyPnl: new Map<string, number>()
    };
  }

  private historyDuration(interval: string): string {
    if (interval === '1d') return '1 Y';
    if (interval === '1h') return '10 D';
    return '1 D';
  }

  private historyBarSize(interval: string): string {
    if (interval === '1m') return '1 min';
    if (interval === '5m') return '5 mins';
    if (interval === '15m') return '15 mins';
    if (interval === '1h') return '1 hour';
    return '1 day';
  }

  private parseOsiTicker(ticker: any): IbkrOptionContract | null {
    const match = String(ticker || '').replace(/\s+/g, '').toUpperCase().match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
    if (!match) return null;
    const [, symbol, expiry, side, strikeRaw] = match;
    return {
      symbol,
      expiration: `20${expiry}`,
      right: side === 'C' ? 'call' : 'put',
      strike: Number(strikeRaw) / 1000
    };
  }

  private constructOsiTicker(contract: IbkrOptionContract): string {
    const cleanDate = contract.expiration.replace(/-/g, '');
    const yy = cleanDate.slice(2, 4);
    const mm = cleanDate.slice(4, 6);
    const dd = cleanDate.slice(6, 8);
    const side = contract.right === 'call' ? 'C' : 'P';
    return `${contract.symbol.toUpperCase()}${yy}${mm}${dd}${side}${Math.round(contract.strike * 1000).toString().padStart(8, '0')}`;
  }

  private parseBarTime(value: string, dateKey: string): Date | null {
    const raw = String(value || '').trim();
    if (!raw) return null;
    if (!/^\d+(\.\d+)?$/.test(raw)) {
      const hasExplicitTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
      if (hasExplicitTimezone) {
        const parsed = new Date(raw);
        return Number.isFinite(parsed.getTime()) ? parsed : null;
      }

      const match = raw.match(/^(?:\d{4}-\d{2}-\d{2}T)?(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/);
      if (match) {
        return this.dateAtEt(dateKey, Number(match[1]), Number(match[2]), Number(match[3] || 0), Number((match[4] || '0').padEnd(3, '0')));
      }

      const dateTimeMatch = raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/);
      if (dateTimeMatch) {
        return this.dateAtEt(dateTimeMatch[1], Number(dateTimeMatch[2]), Number(dateTimeMatch[3]), Number(dateTimeMatch[4] || 0), Number((dateTimeMatch[5] || '0').padEnd(3, '0')));
      }
    }
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) {
      if (numeric > 1_000_000_000_000) return new Date(numeric);
      const msOfDay = numeric > 100_000 ? numeric : numeric * 1000;
      return this.addMs(this.dateAtEt(dateKey, 0, 0), msOfDay);
    }
    return null;
  }

  private dateAtEt(dateKey: string, hour: number, minute: number, second = 0, millisecond = 0): Date {
    const [year, month, day] = dateKey.split('-').map((part) => Number(part));
    const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond));
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      hourCycle: 'h23'
    });
    const parts = formatter.formatToParts(utcGuess);
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value || 0);
    const representedEtAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'), millisecond);
    const intendedEtAsUtc = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
    return new Date(utcGuess.getTime() + (intendedEtAsUtc - representedEtAsUtc));
  }

  private getSignalDate(signal: ReplaySignal): string {
    return String(signal.market_date || new Date(signal.created_at).toISOString().split('T')[0]).slice(0, 10);
  }

  private positiveNumber(value: any, fallback: number): number {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
  }

  private positiveInt(value: any, fallback: number): number {
    const numeric = Math.floor(Number(value));
    return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
  }

  private addMs(date: Date, ms: number): Date {
    return new Date(date.getTime() + ms);
  }
}
