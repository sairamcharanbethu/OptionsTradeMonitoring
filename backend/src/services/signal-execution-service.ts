import { FastifyInstance } from 'fastify';
import axios from 'axios';
import YahooFinance from 'yahoo-finance2';
import { AIService } from './ai-service';
import { TradeExecutionService } from './trade-execution-service';
import { IbkrMarketDataService } from './ibkr-market-data-service';
import { getSettingsWithGlobalFallback } from '../lib/settings-utils';
import { normalizeAdapterHealth } from '../lib/adapter-health';
import { getNewYorkMarketState, getUSMarketCloseMinutes } from '../lib/market-calendar';
import { getIbkrGatewayConfig } from '../lib/ibkr-config';

const yahooFinance = new YahooFinance({ suppressNotices: ['ripHistorical', 'yahooSurvey'] });

/**
 * Execution shim for signal-only-v2 signals plus the two small status probes
 * the UI still reads. This is what remains of the legacy in-process scanner:
 * signal generation, its trading window, macro regime scoring and the related
 * per-user settings were retired — the Python strategy engine is the sole
 * signal source and the session policy owns the entry window.
 */
export class SignalExecutionService {
  private fastify: FastifyInstance;
  private aiService: AIService;

  constructor(fastify: FastifyInstance) {
    this.fastify = fastify;
    this.aiService = new AIService(fastify);
  }

  public async getSettingsForUser(userId: number): Promise<Record<string, string>> {
    const dbSettings = await getSettingsWithGlobalFallback(this.fastify.pg, userId);
    const defaults = {
      day_trading_enabled: 'true',
      strategy_max_total_debit_dollars: '500',
      strategy_preferred_contracts: '1',
      strategy_max_contracts: '1',
      discord_webhook_url: '',
      discord_alerts_enabled: 'false',
      day_trading_ai_enabled: 'true',
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

  /** Minimal status for the services-health card: regular-session gate only. */
  public async getRuntimeStatus(): Promise<Record<string, any>> {
    const now = new Date();
    const closeMinutes = getUSMarketCloseMinutes(now);
    const market = getNewYorkMarketState(now, 9 * 60 + 30, closeMinutes);
    const pad = (value: number) => String(value).padStart(2, '0');
    return {
      status: 'DISABLED',
      enabled: false,
      marketOpen: market.isOpen,
      window: {
        start: '09:30',
        cutoff: `${pad(Math.floor(closeMinutes / 60))}:${pad(closeMinutes % 60)}`,
        now: `${pad(Math.floor(market.minutes / 60))}:${pad(market.minutes % 60)}`,
        timezone: 'America/New_York'
      },
      lastScanAt: null,
      lastSkippedReason: 'LEGACY_SCANNER_RETIRED',
      intervalSeconds: 0
    };
  }

  public async runHealthCheck(userId: number): Promise<any> {
    const settings = await this.getSettingsForUser(userId);

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
      const aiSettings = await this.aiService.getSettings(userId);
      if (aiSettings.ai_provider === 'openrouter' && aiSettings.openrouter_key) {
        await axios.get('https://openrouter.ai/api/v1/models', {
          headers: { Authorization: `Bearer ${aiSettings.openrouter_key}` },
          timeout: 4000
        });
      } else if (aiSettings.ai_provider === 'ollama') {
        await this.aiService.checkHealth(userId);
      } else {
        throw new Error('No AI provider key configured');
      }
    }, settings.day_trading_ai_enabled === 'true', 'https://openrouter.ai/api/v1/models', 'openRouter');

    const discordCheck = checkLatency(async () => {
      await axios.get(settings.discord_webhook_url, { timeout: 4000 });
    }, !!settings.discord_webhook_url, settings.discord_webhook_url ? 'configured Discord webhook URL' : undefined, 'discord');

    const [yahoo, ibkr, openrouter, discord] = await Promise.all([yahooCheck, ibkrCheck, openrouterCheck, discordCheck]);
    let redisHealth: any = { status: 'UNKNOWN' };
    try {
      const { TradeRedisService } = await import('./trade-redis-service');
      const { getRealtimeHealth } = await import('../lib/realtime');
      const base = await TradeRedisService.getHealth();
      const realtime = getRealtimeHealth();
      redisHealth = {
        ...base,
        pubsubSubscribed: realtime.busSubscribed,
        eventStreamLength: base.eventStreamLength,
        lastPublishAt: realtime.lastPublishAt,
        lastPublishAgeMs: realtime.lastPublishAgeMs,
        realtime
      };
    } catch (err: any) {
      redisHealth = { status: 'DEGRADED', connected: false, lastError: err?.message || String(err) };
    }
    return { yahooFinance: yahoo, ibkr, openRouter: openrouter, discord, redis: redisHealth };
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
    const { rows } = await this.fastify.pg.query('SELECT * FROM signals WHERE id = $1', [signalId]);
    if (rows.length === 0) {
      throw new Error(`Signal #${signalId} not found`);
    }

    const signal = rows[0];
    if (signal.status !== 'PENDING') {
      throw new Error(`Signal #${signalId} is ${signal.status} and cannot be executed`);
    }
    if (signal.signal_type === 'NONE') {
      throw new Error(`Signal #${signalId} is a no-trade record and cannot be executed`);
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
