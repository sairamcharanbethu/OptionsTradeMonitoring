import { FastifyInstance } from 'fastify';
import axios from 'axios';
import YahooFinance from 'yahoo-finance2';
import { AIService } from './ai-service';
import { TradeExecutionService } from './trade-execution-service';
import { getSettingsWithGlobalFallback } from '../lib/settings-utils';
import { IbkrMarketDataService } from './ibkr-market-data-service';
import { normalizeAdapterHealth } from '../lib/adapter-health';
import { getNewYorkMarketState } from '../lib/market-calendar';
import { getIbkrGatewayConfig } from '../lib/ibkr-config';

const yahooFinance = new YahooFinance({ suppressNotices: ['ripHistorical', 'yahooSurvey'] });

// The legacy in-process scanner (signal generation, enrichment, trigger watch,
// ML predictor) was removed: signal-only-v2 (the Python strategy engine) is the
// sole signal source. This service retains only the live, still-routed surface:
// - executeSignalForUser: execution shim used by autonomous + manual entry
// - getCurrentMacroSnapshot: live macro metrics for the UI
// - runHealthCheck: third-party API health probe
// - getRuntimeStatus: health-endpoint stub reporting the scanner as retired

type MacroAssetSnapshot = {
  symbol: string;
  label: string;
  value: number | null;
  previousClose: number | null;
  changePct: number | null;
  changeBps?: number | null;
  source: string;
  error?: string | null;
};

type MacroRegimeAssessment = {
  regime: 'RISK_ON' | 'NEUTRAL' | 'RISK_OFF';
  score: number;
  directionBias: 'CALL' | 'PUT' | 'MIXED';
  confidenceAdjustment: number;
  thresholdAdjustment: number;
  blockers: string[];
  warnings: string[];
  contributors: string[];
  assets: {
    vix: MacroAssetSnapshot;
    vix3m?: MacroAssetSnapshot;
    tenYear: MacroAssetSnapshot;
    dxy: MacroAssetSnapshot;
    oil: MacroAssetSnapshot;
    gold: MacroAssetSnapshot;
  };
};

export type LiveMacroSnapshot = {
  generatedAt: string;
  vixQuote: number | null;
  vixChangePercent: number | null;
  vix3mQuote: number | null;
  vixTermStructure: {
    vix: number | null;
    vix3m: number | null;
    ratio: number | null;
    minimumRatio: number;
    status: 'STRONG_CONTANGO' | 'CONTANGO' | 'NEUTRAL' | 'BACKWARDATION' | 'UNAVAILABLE';
    blocker: string | null;
  };
  tenYearYield: number | null;
  tenYearChangePercent: number | null;
  tenYearChangeBps: number | null;
  dxy: MacroAssetSnapshot;
  oil: MacroAssetSnapshot;
  gold: MacroAssetSnapshot;
  assets: {
    vix: MacroAssetSnapshot;
    vix3m: MacroAssetSnapshot;
    tenYear: MacroAssetSnapshot;
    dxy: MacroAssetSnapshot;
    oil: MacroAssetSnapshot;
    gold: MacroAssetSnapshot;
  };
  assessments: {
    CALL: MacroRegimeAssessment;
    PUT: MacroRegimeAssessment;
  };
};

export class SignalScannerService {
  private fastify: FastifyInstance;
  private aiService: AIService;
  private liveMacroSnapshot: LiveMacroSnapshot | null = null;
  private liveMacroSnapshotFetchedAt = 0;

  constructor(fastify: FastifyInstance) {
    this.fastify = fastify;
    this.aiService = new AIService(fastify);
  }

  private async getPrimaryUserId(): Promise<number> {
    // Use the first user because signal-critical runtime settings are global.
    const { rows: users } = await this.fastify.pg.query(`
      SELECT id FROM users ORDER BY id ASC LIMIT 1
    `);
    if (users.length > 0) {
      return users[0].id;
    }

    return 1; // Default fallback ID if no users exist
  }

  public async getSettingsForUser(userId: number): Promise<Record<string, string>> {
    const dbSettings = await getSettingsWithGlobalFallback(this.fastify.pg, userId);

    const defaults = {
      day_trading_enabled: 'true',
      day_trading_symbols: 'QQQ,SPY',
      strategy_max_total_debit_dollars: '500',
      strategy_preferred_contracts: '1',
      strategy_max_contracts: '1',
      discord_webhook_url: '',
      discord_alerts_enabled: 'false',
      trading_start_time: '09:30',
      trading_cutoff_time: '16:00',
      strike_offset: '0',
      min_signal_score: '70',
      day_trading_ai_enabled: 'true',
      day_trading_ai_provider: 'openrouter',
      day_trading_ai_model: 'deepseek/deepseek-chat',
      day_trading_coach_model: 'deepseek/deepseek-chat',
      execution_broker: 'none',
      auto_trade_mode: 'instant',
      snaptrade_auto_trade: 'false',
      autonomous_live_entry_enabled: 'false',
      snaptrade_trading_account_id: '',
      max_trades_per_day: '2',
      contracts_per_trade: '1',
      max_daily_loss_dollars: '200',
      max_consecutive_losses: '3',
      loss_cooldown_minutes: '30',
      max_premium_risk_dollars: '500',
      max_correlated_positions: '3',
      shadow_trading_enabled: 'false',
      day_trading_expiry_mode: 'adaptive',
      order_type: 'LIMIT',
      entry_slippage_pct: '3',
      take_profit_pct: '',
      stop_loss_engine_enabled: 'true',
      synthetic_trailing_stop_enabled: 'false',
      synthetic_trailing_stop_pct: '15',
      live_trading_acknowledged: 'false'
    };

    return { ...defaults, ...dbSettings };
  }

  private parseTimeToMinutes(value: string | undefined, fallback: string): number {
    const [hourRaw, minuteRaw] = (value || fallback).split(':');
    const hour = Number(hourRaw);
    const minute = Number(minuteRaw);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
      return this.parseTimeToMinutes(fallback, '09:30');
    }
    return hour * 60 + minute;
  }

  private getNyDateParts(date: Date) {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
    const parts = formatter.formatToParts(date);
    const t: any = {};
    for (const p of parts) {
      t[p.type] = p.value;
    }
    const hour = parseInt(t.hour, 10) % 24;
    const minute = parseInt(t.minute, 10);
    return {
      year: t.year,
      month: t.month,
      day: t.day,
      hour,
      minute,
      minutes: hour * 60 + minute,
      dateStr: `${t.year}-${t.month}-${t.day}`,
      marketDate: `${t.month}/${t.day}/${t.year}`
    };
  }

  private getTradingWindowState(settings: any, now: Date = new Date()) {
    const nyParts = this.getNyDateParts(now);
    const startTime = settings.trading_start_time || '09:30';
    const cutoffTime = settings.trading_cutoff_time || '16:00';
    const startMinutes = this.parseTimeToMinutes(startTime, '09:30');
    const cutoffMinutes = this.parseTimeToMinutes(cutoffTime, '16:00');
    const marketState = getNewYorkMarketState(now, startMinutes, cutoffMinutes);

    return {
      isOpen: marketState.isOpen,
      isWeekday: marketState.isWeekday,
      nowLabel: `${String(nyParts.hour).padStart(2, '0')}:${String(nyParts.minute).padStart(2, '0')}`,
      startTime,
      cutoffTime
    };
  }

  public async getRuntimeStatus() {
    try {
      const primaryUserId = await this.getPrimaryUserId();
      const settings = await this.getSettingsForUser(primaryUserId);
      const windowState = this.getTradingWindowState(settings);

      return {
        status: 'DISABLED',
        enabled: false,
        marketOpen: windowState.isOpen,
        window: {
          start: windowState.startTime,
          cutoff: windowState.cutoffTime,
          now: windowState.nowLabel,
          timezone: 'America/New_York'
        },
        signalSourceUserId: primaryUserId,
        lastScanAt: null,
        lastSkippedReason: 'LEGACY_SCANNER_RETIRED',
        intervalSeconds: 0
      };
    } catch (err: any) {
      return {
        status: 'DEGRADED',
        enabled: false,
        marketOpen: false,
        error: err.message || String(err)
      };
    }
  }

  private finiteNumber(value: any): number | null {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  private buildMacroSnapshot(input: {
    symbol: string;
    label: string;
    value: number | null;
    previousClose: number | null;
    source?: string;
    changeBps?: number | null;
    error?: string | null;
  }): MacroAssetSnapshot {
    const changePct = input.value !== null && input.previousClose !== null && input.previousClose !== 0
      ? Number((((input.value - input.previousClose) / input.previousClose) * 100).toFixed(2))
      : null;

    return {
      symbol: input.symbol,
      label: input.label,
      value: input.value,
      previousClose: input.previousClose,
      changePct,
      changeBps: input.changeBps ?? null,
      source: input.source || 'yahoo',
      error: input.error || null
    };
  }

  private async fetchYahooMacroSnapshot(symbols: string | string[], label: string): Promise<MacroAssetSnapshot> {
    const candidates = Array.isArray(symbols) ? symbols : [symbols];
    let lastError: string | null = null;

    for (const symbol of candidates) {
      try {
        const quote = await (yahooFinance as any).quote(symbol);
        const value = this.finiteNumber(quote?.regularMarketPrice);
        const previousClose = this.finiteNumber(quote?.regularMarketPreviousClose);
        if (value !== null && previousClose !== null) {
          return this.buildMacroSnapshot({
            symbol,
            label,
            value,
            previousClose,
            source: 'yahoo'
          });
        }
        lastError = `Missing value or previous close for ${symbol}`;
      } catch (err: any) {
        lastError = err.message || String(err);
        this.fastify.log.warn(`[SignalScannerService] Failed to fetch macro ${label} (${symbol}): ${lastError}`);
      }
    }

    return this.buildMacroSnapshot({
      symbol: candidates[0] || label,
      label,
      value: null,
      previousClose: null,
      source: 'yahoo',
      error: lastError || 'No Yahoo macro candidate returned usable data'
    });
  }

  private async fetchIbkrIndexMacroSnapshot(symbol: string, label: string): Promise<MacroAssetSnapshot> {
    try {
      const quote = await new IbkrMarketDataService(this.fastify).getIndexQuote(symbol);
      return this.buildMacroSnapshot({
        symbol,
        label,
        value: quote.mark,
        previousClose: quote.close > 0 ? quote.close : null,
        source: 'ibkr'
      });
    } catch (err: any) {
      const error = err.message || String(err);
      this.fastify.log.warn(`[SignalScannerService] Failed to fetch macro ${label} from IBKR: ${error}`);
      return this.buildMacroSnapshot({
        symbol,
        label,
        value: null,
        previousClose: null,
        source: 'ibkr',
        error
      });
    }
  }

  private async fetchVixMacroSnapshot(symbol: string, label: string, yahooSymbol: string): Promise<MacroAssetSnapshot> {
    const ibkrSnapshot = await this.fetchIbkrIndexMacroSnapshot(symbol, label);
    if (ibkrSnapshot.value !== null) return ibkrSnapshot;

    const yahooSnapshot = await this.fetchYahooMacroSnapshot(yahooSymbol, label);
    if (yahooSnapshot.value !== null) {
      return {
        ...yahooSnapshot,
        source: 'yahoo_finance_fallback',
        error: null
      };
    }

    return {
      ...ibkrSnapshot,
      error: [ibkrSnapshot.error, yahooSnapshot.error].filter(Boolean).join('; ') || 'IBKR and Yahoo Finance returned no usable value'
    };
  }

  public assessVixTermStructure(vix: number | null, vix3m: number | null, minimumRatio = 1.05) {
    const ratio = vix !== null && vix > 0 && vix3m !== null && vix3m > 0
      ? Number((vix3m / vix).toFixed(4))
      : null;
    const safeMinimumRatio = Number.isFinite(minimumRatio) && minimumRatio > 0 ? minimumRatio : 1.05;
    let status: 'STRONG_CONTANGO' | 'CONTANGO' | 'NEUTRAL' | 'BACKWARDATION' | 'UNAVAILABLE' = 'UNAVAILABLE';
    let blocker: string | null = null;

    if (ratio === null) {
      blocker = 'VIX term structure unavailable — VIX/VIX3M data required before new entries';
    } else if (ratio >= 1.1) {
      status = 'STRONG_CONTANGO';
    } else if (ratio >= safeMinimumRatio) {
      status = 'CONTANGO';
    } else if (ratio < 1) {
      status = 'BACKWARDATION';
      blocker = `VIX term structure is backwardated (${ratio.toFixed(2)}); minimum contango ratio is ${safeMinimumRatio.toFixed(2)}`;
    } else {
      status = 'NEUTRAL';
      blocker = `VIX term structure is neutral (${ratio.toFixed(2)}); minimum contango ratio is ${safeMinimumRatio.toFixed(2)}`;
    }

    return {
      vix,
      vix3m,
      ratio,
      minimumRatio: safeMinimumRatio,
      status,
      blocker
    };
  }

  public async getCurrentMacroSnapshot(options: {
    forceRefresh?: boolean;
    currentMinutes?: number;
    now?: Date;
  } = {}): Promise<LiveMacroSnapshot> {
    const cacheTtlMs = 15_000;
    const nowMs = options.now?.getTime() ?? Date.now();
    if (!options.forceRefresh && this.liveMacroSnapshot && nowMs - this.liveMacroSnapshotFetchedAt < cacheTtlMs) {
      return this.liveMacroSnapshot;
    }

    const [vixSnapshot, vix3mSnapshot, rawTenYearSnapshot, dxySnapshot, oilSnapshot, goldSnapshot] = await Promise.all([
      this.fetchVixMacroSnapshot('VIX', 'VIX', '^VIX'),
      this.fetchVixMacroSnapshot('VIX3M', 'VIX3M', '^VIX3M'),
      this.fetchYahooMacroSnapshot('^TNX', 'US 10Y'),
      this.fetchYahooMacroSnapshot(['DX-Y.NYB', 'UUP'], 'DXY'),
      this.fetchYahooMacroSnapshot('CL=F', 'Oil'),
      this.fetchYahooMacroSnapshot('GC=F', 'Gold')
    ]);
    const tenYearChangeBps = rawTenYearSnapshot.value !== null && rawTenYearSnapshot.previousClose !== null
      ? Number(((rawTenYearSnapshot.value - rawTenYearSnapshot.previousClose) * 10).toFixed(1))
      : null;
    const tenYearSnapshot = {
      ...rawTenYearSnapshot,
      changeBps: tenYearChangeBps
    };
    const currentMinutes = options.currentMinutes ?? this.getNyDateParts(options.now || new Date()).minutes;
    const vixTermStructure = this.assessVixTermStructure(
      vixSnapshot.value,
      vix3mSnapshot.value,
      Number(process.env.VIX_TERM_STRUCTURE_MIN_RATIO || 1.05)
    );
    const assets = {
      vix: vixSnapshot,
      vix3m: vix3mSnapshot,
      tenYear: tenYearSnapshot,
      dxy: dxySnapshot,
      oil: oilSnapshot,
      gold: goldSnapshot
    };
    const snapshot: LiveMacroSnapshot = {
      generatedAt: (options.now || new Date()).toISOString(),
      vixQuote: vixSnapshot.value,
      vixChangePercent: vixSnapshot.changePct,
      vix3mQuote: vix3mSnapshot.value,
      vixTermStructure,
      tenYearYield: tenYearSnapshot.value,
      tenYearChangePercent: tenYearSnapshot.changePct,
      tenYearChangeBps,
      dxy: dxySnapshot,
      oil: oilSnapshot,
      gold: goldSnapshot,
      assets,
      assessments: {
        CALL: this.assessMacroRegime({ winningSide: 'CALL', currentMinutes, ...assets }),
        PUT: this.assessMacroRegime({ winningSide: 'PUT', currentMinutes, ...assets })
      }
    };

    this.liveMacroSnapshot = snapshot;
    this.liveMacroSnapshotFetchedAt = nowMs;
    return snapshot;
  }

  private assessMacroRegime(input: {
    winningSide: 'CALL' | 'PUT';
    currentMinutes: number;
    vix: MacroAssetSnapshot;
    vix3m?: MacroAssetSnapshot;
    tenYear: MacroAssetSnapshot;
    dxy: MacroAssetSnapshot;
    oil: MacroAssetSnapshot;
    gold: MacroAssetSnapshot;
  }): MacroRegimeAssessment {
    const { winningSide, currentMinutes, vix, vix3m, tenYear, dxy, oil, gold } = input;
    const blockers: string[] = [];
    const warnings: string[] = [];
    const contributors: string[] = [];
    if (vix3m !== undefined) {
      const vixTermStructure = this.assessVixTermStructure(
        vix.value,
        vix3m.value,
        Number(process.env.VIX_TERM_STRUCTURE_MIN_RATIO || 1.05)
      );
      if (vixTermStructure.blocker) {
        blockers.push(vixTermStructure.blocker);
      } else {
        contributors.push(`${vixTermStructure.status === 'STRONG_CONTANGO' ? 'Strong ' : ''}VIX contango ${vixTermStructure.ratio?.toFixed(2)} supports directional entries`);
      }
    }
    let score = 50;
    let rawAdjustment = 0;

    const add = (points: number, reason: string) => {
      score += points;
      rawAdjustment += points * 0.45;
      contributors.push(`${points > 0 ? '+' : ''}${points}: ${reason}`);
    };

    const warn = (points: number, reason: string) => {
      score += points;
      rawAdjustment += points * 0.45;
      warnings.push(reason);
      contributors.push(`${points}: ${reason}`);
    };

    if (vix.value !== null) {
      if (vix.value >= 15 && vix.value <= 22) {
        add(8, `VIX ${vix.value.toFixed(2)} is in the normal 0DTE range`);
      } else if (vix.value > 30) {
        warn(-22, `VIX ${vix.value.toFixed(2)} is above the 30 panic threshold`);
        if (winningSide === 'CALL') blockers.push(`Macro guard: VIX ${vix.value.toFixed(2)} is above 30, blocking bullish 0DTE calls`);
      } else if (vix.value < 12) {
        warn(-5, `VIX ${vix.value.toFixed(2)} is very compressed, reducing directional edge`);
      } else if (vix.value > 24) {
        warn(-10, `VIX ${vix.value.toFixed(2)} is elevated`);
      }
    } else {
      warn(-6, 'VIX data unavailable');
    }

    if (vix.changePct !== null) {
      if (vix.changePct <= -3) {
        if (winningSide === 'CALL') add(10, `VIX falling ${vix.changePct.toFixed(2)}% supports risk-on calls`);
        else warn(-4, `VIX falling ${vix.changePct.toFixed(2)}% works against bearish puts`);
      } else if (vix.changePct >= 15) {
        warn(-18, `VIX spiking ${vix.changePct.toFixed(2)}% intraday`);
        if (winningSide === 'CALL') blockers.push(`Macro guard: VIX is spiking ${vix.changePct.toFixed(2)}%, blocking bullish 0DTE calls`);
      } else if (vix.changePct >= 10) {
        warn(-12, `VIX up ${vix.changePct.toFixed(2)}%, market is too unstable for easy quick-profit calls`);
      }
    }

    const tenYearBps = tenYear.changeBps ?? null;
    if (tenYearBps !== null && dxy.changePct !== null) {
      if (tenYearBps >= 4 && dxy.changePct >= 0.25) {
        const msg = `DXY +${dxy.changePct.toFixed(2)}% and 10Y +${tenYearBps.toFixed(1)} bps are rising together`;
        if (winningSide === 'CALL') {
          warn(-18, msg);
          blockers.push(`Macro guard: ${msg}, blocking bullish 0DTE calls`);
        } else {
          add(8, `${msg}, supporting bearish puts`);
        }
      }
    }

    if (dxy.changePct !== null) {
      if (dxy.changePct <= -0.20) {
        if (winningSide === 'CALL') add(7, `DXY falling ${dxy.changePct.toFixed(2)}% supports Nasdaq calls`);
        else warn(-3, `DXY falling ${dxy.changePct.toFixed(2)}% works against puts`);
      } else if (dxy.changePct >= 0.30) {
        if (winningSide === 'CALL') warn(-8, `DXY rising ${dxy.changePct.toFixed(2)}% pressures equities`);
        else add(5, `DXY rising ${dxy.changePct.toFixed(2)}% supports risk-off puts`);
      }
    } else {
      warnings.push('DXY data unavailable');
    }

    if (tenYearBps !== null) {
      if (tenYearBps <= -3) {
        if (winningSide === 'CALL') add(6, `10Y yield down ${tenYearBps.toFixed(1)} bps supports risk assets`);
        else warn(-3, `10Y yield down ${tenYearBps.toFixed(1)} bps works against puts`);
      } else if (tenYearBps >= 5) {
        if (winningSide === 'CALL') warn(-7, `10Y yield up ${tenYearBps.toFixed(1)} bps pressures growth equities`);
        else add(4, `10Y yield up ${tenYearBps.toFixed(1)} bps supports bearish pressure`);
      }
    } else {
      warnings.push('10Y yield change unavailable');
    }

    if (oil.changePct !== null && gold.changePct !== null) {
      if (oil.changePct >= 1.5 && gold.changePct >= 0.5) {
        const reason = `Oil +${oil.changePct.toFixed(2)}% and gold +${gold.changePct.toFixed(2)}% indicate inflation/risk-off pressure`;
        if (winningSide === 'CALL') warn(-6, reason);
        else add(3, reason);
      } else if (gold.changePct >= 1.0) {
        if (winningSide === 'CALL') warn(-4, `Gold +${gold.changePct.toFixed(2)}% suggests defensive flows`);
        else add(2, `Gold +${gold.changePct.toFixed(2)}% supports defensive/risk-off flows`);
      }
    }

    const firstNinetyMinutes = currentMinutes >= 9 * 60 + 30 && currentMinutes < 11 * 60;
    const nearClose = currentMinutes >= 13 * 60 + 30;
    if (firstNinetyMinutes) {
      rawAdjustment *= 1.15;
      contributors.push('First 90 minutes: macro adjustment amplified');
    }

    score = Math.max(0, Math.min(100, Math.round(score)));
    const regime = score >= 62 ? 'RISK_ON' : score <= 42 ? 'RISK_OFF' : 'NEUTRAL';
    let directionBias: MacroRegimeAssessment['directionBias'] = 'MIXED';
    if (score >= 62) directionBias = 'CALL';
    if (score <= 42) directionBias = 'PUT';

    let thresholdAdjustment = 0;
    if ((winningSide === 'CALL' && directionBias === 'PUT') || (winningSide === 'PUT' && directionBias === 'CALL')) {
      thresholdAdjustment += 10;
    } else if (directionBias === 'MIXED') {
      thresholdAdjustment += 3;
    }
    if (nearClose && directionBias !== winningSide) {
      thresholdAdjustment += 5;
      warnings.push('Near close with weak macro confirmation, tightening entry threshold');
    }

    return {
      regime,
      score,
      directionBias,
      confidenceAdjustment: Math.max(-25, Math.min(12, Math.round(rawAdjustment))),
      thresholdAdjustment,
      blockers,
      warnings,
      contributors,
      assets: { vix, vix3m, tenYear, dxy, oil, gold }
    };
  }

  public async runHealthCheck(userId: number): Promise<any> {
    const targetUserId = userId;
    const settings = await this.getSettingsForUser(targetUserId);

    const checkLatency = async (
      fn: () => Promise<void>,
      isConfigured = true,
      endpoint?: string,
      source = 'unknown'
    ): Promise<any> => {
      const checkedAt = new Date().toISOString();
      if (!isConfigured) {
        return normalizeAdapterHealth(source, { status: 'N/A', latencyMs: 0, endpoint, lastError: 'Not configured', checkedAt }, checkedAt);
      }
      const start = Date.now();
      try {
        await fn();
        return normalizeAdapterHealth(source, { status: 'UP', latencyMs: Date.now() - start, endpoint, lastError: null, checkedAt }, checkedAt);
      } catch (e) {
        const err: any = e;
        return normalizeAdapterHealth(source, {
          status: 'DOWN',
          latencyMs: Date.now() - start,
          endpoint,
          lastError: err?.response?.data?.error || err?.response?.statusText || err?.message || String(e),
          checkedAt
        }, checkedAt);
      }
    };

    const yahooCheck = checkLatency(async () => {
      await (yahooFinance as any).quote('QQQ');
    }, true, 'yahooFinance.quote(QQQ)', 'yahooFinance');

    const ibkrConfig = await getIbkrGatewayConfig(this.fastify.pg);
    const ibkrCheck = checkLatency(async () => {
      const ibkr = new IbkrMarketDataService(this.fastify);
      const health = await ibkr.getHealth();
      if (!health.connected) throw new Error(health.lastError || 'IBKR unavailable');
    }, true, `${ibkrConfig.host}:${ibkrConfig.port}`, 'ibkr');

    const openrouterCheck = checkLatency(async () => {
      const aiSettings = await this.aiService.getSettings(targetUserId);
      if (aiSettings.ai_provider === 'openrouter' && aiSettings.openrouter_key) {
        await axios.get('https://openrouter.ai/api/v1/models', {
          headers: { Authorization: `Bearer ${aiSettings.openrouter_key}` },
          timeout: 4000
        });
      } else if (aiSettings.ai_provider === 'headroom' || aiSettings.ai_provider === 'ollama') {
        await this.aiService.checkHealth(targetUserId);
      } else {
        throw new Error('No AI provider key configured');
      }
    }, settings.day_trading_ai_enabled === 'true', 'https://openrouter.ai/api/v1/models', 'openRouter');

    const discordCheck = checkLatency(async () => {
      await axios.get(settings.discord_webhook_url, { timeout: 4000 });
    }, !!settings.discord_webhook_url, settings.discord_webhook_url ? 'configured Discord webhook URL' : undefined, 'discord');

    const [yahoo, ibkr, openrouter, discord] = await Promise.all([
      yahooCheck,
      ibkrCheck,
      openrouterCheck,
      discordCheck
    ]);

    return {
      yahooFinance: yahoo,
      ibkr,
      openRouter: openrouter,
      discord: discord
    };
  }

  private async executeSignalWithConfiguredBroker(input: {
    userId: number;
    signalId: number;
    symbol: string;
    winningSide: 'CALL' | 'PUT';
    chosenStrike: number;
    chosenExpiry: string;
    stopUnderlying: number;
    targetUnderlying: number;
    mark: number | null;
    settings?: any;
  }) {
    const service = new TradeExecutionService(this.fastify);
    return service.executeSignal({
      userId: input.userId,
      signalId: input.signalId,
      symbol: input.symbol,
      winningSide: input.winningSide,
      chosenStrike: input.chosenStrike,
      chosenExpiry: input.chosenExpiry,
      stopUnderlying: input.stopUnderlying,
      targetUnderlying: input.targetUnderlying,
      mark: input.mark
    }, input.settings);
  }

  public async executeSignalForUser(userId: number, signalId: number, settingsOverride?: any) {
    const { rows } = await this.fastify.pg.query(
      'SELECT * FROM signals WHERE id = $1',
      [signalId]
    );
    if (rows.length === 0) {
      throw new Error(`Signal #${signalId} not found`);
    }

    const signal = rows[0];
    if (signal.status !== 'PENDING') {
      throw new Error(`Signal #${signalId} is ${signal.status} and cannot be executed`);
    }
    if (signal.signal_type === 'NONE') {
      throw new Error(`Signal #${signalId} is a no-trade scanner record and cannot be executed`);
    }

    const optionDetails = signal.option_details || {};
    const winningSide = signal.signal_type === 'PUT' ? 'PUT' : 'CALL';
    const chosenStrike = Number(optionDetails.strike);
    const chosenExpiry = optionDetails.expiry || signal.option_expiration_date;
    const stopUnderlying = Number(signal.stop_loss);
    const targetUnderlying = Number(signal.target_price);
    const missing: string[] = [];
    if (!Number.isFinite(chosenStrike) || chosenStrike <= 0) missing.push('option strike');
    if (!chosenExpiry) missing.push('option expiry');
    if (!Number.isFinite(stopUnderlying) || stopUnderlying <= 0) missing.push('stop loss');
    if (!Number.isFinite(targetUnderlying) || targetUnderlying <= 0) missing.push('target price');
    if (missing.length > 0) {
      throw new Error(`Signal #${signalId} is missing a complete trade plan (${missing.join(', ')}); refusing to execute with fabricated defaults`);
    }
    return this.executeSignalWithConfiguredBroker({
      userId,
      signalId,
      symbol: signal.symbol,
      winningSide,
      chosenStrike,
      chosenExpiry,
      stopUnderlying,
      targetUnderlying,
      mark: optionDetails.mark != null ? Number(optionDetails.mark) : null,
      settings: settingsOverride
    });
  }
}
