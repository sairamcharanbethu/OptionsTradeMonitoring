import { FastifyInstance } from 'fastify';
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
};

type ReplayScenario = {
  name: 'baseline' | 'macro_aligned' | 'macro_strict';
  description: string;
  trades: ReplayTrade[];
  skippedSignals: number;
  skippedReasons: Record<string, number>;
  summary: ReplaySummary;
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
    scenarios: ReplayScenario[];
  }> {
    const config = this.normalizeConfig(input);
    const signals = await this.loadSignals(config);
    const usableSignals = signals.filter((signal) => this.resolveContract(signal) !== null);
    const missingOptionData = signals.length - usableSignals.length;

    const scenarios: ReplayScenario[] = [
      {
        name: 'baseline',
        description: 'All usable stored signals, with the same TP/SL and daily risk controls.',
        trades: [],
        skippedSignals: 0,
        skippedReasons: {},
        summary: this.emptySummary()
      },
      {
        name: 'macro_aligned',
        description: 'Skips signals where recorded macro direction conflicts with the trade side.',
        trades: [],
        skippedSignals: 0,
        skippedReasons: {},
        summary: this.emptySummary()
      },
      {
        name: 'macro_strict',
        description: 'Requires macro alignment, no recorded macro blockers, and macro score >= 62.',
        trades: [],
        skippedSignals: 0,
        skippedReasons: {},
        summary: this.emptySummary()
      }
    ];

    const historyCache = new Map<string, ReplayBar[]>();
    for (const scenario of scenarios) {
      const state = this.newScenarioState();
      for (const signal of usableSignals) {
        const dateKey = this.getSignalDate(signal);
        const skippedByFilter = this.getScenarioSkipReason(scenario.name, signal);
        if (skippedByFilter) {
          this.noteSkip(scenario, skippedByFilter);
          continue;
        }
        if (this.shouldSkipForDailyControls(state, dateKey, config)) {
          this.noteSkip(scenario, 'daily_control');
          continue;
        }

        const contract = this.resolveContract(signal);
        if (!contract) {
          this.noteSkip(scenario, 'missing_contract');
          continue;
        }

        const cacheKey = `${contract.symbol}:${contract.expiration}:${contract.right}:${contract.strike}:${dateKey}:${config.interval}`;
        let bars = historyCache.get(cacheKey);
        if (!bars) {
          try {
            bars = await this.thetaData.getOptionOhlcHistory(
              userId,
              contract,
              this.dateAtEt(dateKey, 9, 30),
              this.dateAtEt(dateKey, 16, 0),
              config.interval
            );
          } catch (err: any) {
            this.fastify.log.warn(`[SignalReplayBacktester] ThetaData history unavailable for ${cacheKey}: ${err.message || String(err)}`);
            bars = [];
          }
          historyCache.set(cacheKey, bars);
        }

        const trade = this.simulateTrade(signal, contract, bars, config);
        if (!trade) {
          this.noteSkip(scenario, 'missing_price_history');
          continue;
        }

        scenario.trades.push(trade);
        this.applyTradeToState(state, dateKey, trade.pnl, config);
      }
      scenario.summary = this.summarize(scenario.trades, state.dailyPnl, config);
    }

    return {
      config,
      signalsLoaded: signals.length,
      signalsUsable: usableSignals.length,
      missingOptionData,
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
    const signalTime = new Date(signal.created_at);
    const marketDate = this.getSignalDate(signal);
    const sortedBars = bars
      .map((bar) => ({ ...bar, parsedTime: this.parseBarTime(bar.start, marketDate) }))
      .filter((bar) => bar.parsedTime && bar.close > 0)
      .sort((a, b) => (a.parsedTime as Date).getTime() - (b.parsedTime as Date).getTime());

    const entryBar = sortedBars.find((bar) => (bar.parsedTime as Date).getTime() >= signalTime.getTime());
    if (!entryBar) return null;

    const optionMark = Number(signal.option_details?.mark || 0);
    const entryPrice = Number((optionMark > 0 ? optionMark : entryBar.close).toFixed(2));
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

    const pnl = Number(((exitPrice - entryPrice) * config.contractsPerTrade * 100).toFixed(2));
    return {
      signalId: signal.id,
      date: marketDate,
      symbol: signal.symbol,
      optionTicker: this.constructOsiTicker(contract),
      side: signal.signal_type,
      setupGrade: signal.setup_grade,
      confidenceScore: Number(signal.confidence_score || 0),
      macroRegime: signal.volatility?.macroRegime || null,
      entryTime: (entryBar.parsedTime as Date).toISOString(),
      exitTime: (exitBar.parsedTime as Date).toISOString(),
      entryPrice,
      exitPrice: Number(exitPrice.toFixed(2)),
      quantity: config.contractsPerTrade,
      pnl,
      roiPct: Number((((exitPrice - entryPrice) / entryPrice) * 100).toFixed(2)),
      exitReason,
      skippedBy: []
    };
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
    const parsed = new Date(raw);
    if (!/^\d+(\.\d+)?$/.test(raw) && Number.isFinite(parsed.getTime())) return parsed;
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) {
      if (numeric > 1_000_000_000_000) return new Date(numeric);
      const msOfDay = numeric > 100_000 ? numeric : numeric * 1000;
      return this.addMs(new Date(`${dateKey}T00:00:00-04:00`), msOfDay);
    }
    return null;
  }

  private dateAtEt(dateKey: string, hour: number, minute: number): Date {
    return new Date(`${dateKey}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00-04:00`);
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
