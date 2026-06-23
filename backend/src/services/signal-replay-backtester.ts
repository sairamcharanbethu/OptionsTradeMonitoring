import { FastifyInstance } from 'fastify';
import { SignalDecision } from '../lib/trading-events';
import { ThetaDataContract, ThetaDataService } from './thetadata-service';

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

type ReplayScenario = {
  name: 'baseline' | 'macro_aligned' | 'macro_strict';
  description: string;
  trades: ReplayTrade[];
  skippedSignals: number;
  skippedReasons: Record<string, number>;
  summary: ReplaySummary;
  fillRealism: ReplayFillRealismSummary;
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
  private thetaData: ThetaDataService;

  constructor(private fastify: FastifyInstance) {
    this.thetaData = new ThetaDataService(fastify);
  }

  public async run(userId: number, input: Partial<ReplayConfig>): Promise<{
    config: ReplayConfig;
    signalsLoaded: number;
    signalsUsable: number;
    missingOptionData: number;
    parity: ReplayParitySummary;
    calibration: ReplayCalibrationReport;
    attribution: ReplayAttributionReport;
    scenarios: ReplayScenario[];
  }> {
    const config = this.normalizeConfig(input);
    const signals = await this.loadSignals(config);
    const usableSignals = signals.filter((signal) => this.resolveContract(signal) !== null);
    const missingOptionData = signals.length - usableSignals.length;
    const parity = this.buildParitySummary(signals);

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
            bars = await this.thetaData.getOptionOhlcHistory(
              userId,
              contract,
              this.dateAtEt(dateKey, 9, 30),
              this.dateAtEt(dateKey, 16, 0),
              signalConfig.interval
            );
          } catch (err: any) {
            this.fastify.log.warn(`[SignalReplayBacktester] ThetaData history unavailable for ${cacheKey}: ${err.message || String(err)}`);
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
    const calibration = this.buildCalibrationReport(baseline.trades);
    const attribution = this.buildAttributionReport(baseline.trades);

    return {
      config,
      signalsLoaded: signals.length,
      signalsUsable: usableSignals.length,
      missingOptionData,
      parity,
      calibration,
      attribution,
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

    const { rows } = await (this.fastify as any).pg.query(
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
    return rows;
  }

  private resolveContract(signal: ReplaySignal): ThetaDataContract | null {
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

  private simulateTrade(signal: ReplaySignal, contract: ThetaDataContract, bars: ReplayBar[], config: ReplayConfig): ReplayTrade | null {
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

  private isExecutableGrade(setupGrade: string | null): boolean {
    return ['A+', 'A', 'B'].includes(String(setupGrade || '').toUpperCase());
  }

  private normalizeTicker(value: any): string | null {
    const ticker = String(value || '').replace(/\s+/g, '').toUpperCase();
    return ticker || null;
  }

  private finiteNumber(value: any): number | null {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  private getScenarioSkipReason(scenario: ReplayScenario['name'], signal: ReplaySignal): string | null {
    if (scenario === 'baseline') return null;
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

  private parseOsiTicker(ticker: any): ThetaDataContract | null {
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

  private constructOsiTicker(contract: ThetaDataContract): string {
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
