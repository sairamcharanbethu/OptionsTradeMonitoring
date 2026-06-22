import cron from 'node-cron';
import { FastifyInstance } from 'fastify';
import axios from 'axios';
import YahooFinance from 'yahoo-finance2';
import { AIService } from './ai-service';
import { redis } from '../lib/redis';
import crypto from 'crypto';
import { execFile } from 'child_process';
import path from 'path';
import fs from 'fs';
import { TradeExecutionService } from './trade-execution-service';
import { getSettingsWithGlobalFallback } from '../lib/settings-utils';
import { ThetaDataOptionChainQuote, ThetaDataService } from './thetadata-service';

const yahooFinance = new YahooFinance({ suppressNotices: ['ripHistorical', 'yahooSurvey'] });

// ── 2026 High-Impact Economic Calendar ─────────────────────────────────────
// Hardcoded from official sources: Fed Reserve, BLS, CME — no API needed.
// Dates are in YYYY-MM-DD format (ET). Update annually.
const HIGH_IMPACT_EVENTS_2026: Record<string, string[]> = {
  // FOMC Meeting Dates (decision day = second day of 2-day meeting)
  '2026-01-28': ['FOMC Rate Decision at 2:00 PM ET'],
  '2026-03-18': ['FOMC Rate Decision at 2:00 PM ET'],
  '2026-04-29': ['FOMC Rate Decision at 2:00 PM ET + Press Conference at 2:30 PM ET'],
  '2026-06-17': ['FOMC Rate Decision at 2:00 PM ET + Press Conference + SEP at 2:30 PM ET'],
  '2026-07-29': ['FOMC Rate Decision at 2:00 PM ET'],
  '2026-09-16': ['FOMC Rate Decision at 2:00 PM ET + Press Conference + SEP at 2:30 PM ET'],
  '2026-11-04': ['FOMC Rate Decision at 2:00 PM ET'],
  '2026-12-16': ['FOMC Rate Decision at 2:00 PM ET + Press Conference + SEP at 2:30 PM ET'],
  // CPI Releases (approx BLS schedule — 3rd week of month)
  '2026-01-14': ['CPI Inflation Report (Dec 2025) at 8:30 AM ET'],
  '2026-02-11': ['CPI Inflation Report (Jan 2026) at 8:30 AM ET'],
  '2026-03-11': ['CPI Inflation Report (Feb 2026) at 8:30 AM ET'],
  '2026-04-10': ['CPI Inflation Report (Mar 2026) at 8:30 AM ET'],
  '2026-05-13': ['CPI Inflation Report (Apr 2026) at 8:30 AM ET'],
  '2026-06-10': ['CPI Inflation Report (May 2026) at 8:30 AM ET'],
  '2026-07-14': ['CPI Inflation Report (Jun 2026) at 8:30 AM ET'],
  '2026-08-12': ['CPI Inflation Report (Jul 2026) at 8:30 AM ET'],
  '2026-09-11': ['CPI Inflation Report (Aug 2026) at 8:30 AM ET'],
  '2026-10-14': ['CPI Inflation Report (Sep 2026) at 8:30 AM ET'],
  '2026-11-13': ['CPI Inflation Report (Oct 2026) at 8:30 AM ET'],
  '2026-12-11': ['CPI Inflation Report (Nov 2026) at 8:30 AM ET'],
  // NFP Jobs Report (first Friday of the month)
  '2026-01-09': ['NFP Jobs Report (Dec 2025) at 8:30 AM ET'],
  '2026-02-06': ['NFP Jobs Report (Jan 2026) at 8:30 AM ET'],
  '2026-03-06': ['NFP Jobs Report (Feb 2026) at 8:30 AM ET'],
  '2026-04-03': ['NFP Jobs Report (Mar 2026) at 8:30 AM ET'],
  '2026-05-01': ['NFP Jobs Report (Apr 2026) at 8:30 AM ET'],
  '2026-06-05': ['NFP Jobs Report (May 2026) at 8:30 AM ET'],
  '2026-07-02': ['NFP Jobs Report (Jun 2026) at 8:30 AM ET'],
  '2026-08-07': ['NFP Jobs Report (Jul 2026) at 8:30 AM ET'],
  '2026-09-04': ['NFP Jobs Report (Aug 2026) at 8:30 AM ET'],
  '2026-10-02': ['NFP Jobs Report (Sep 2026) at 8:30 AM ET'],
  '2026-11-06': ['NFP Jobs Report (Oct 2026) at 8:30 AM ET'],
  '2026-12-04': ['NFP Jobs Report (Nov 2026) at 8:30 AM ET'],
  // PCE Price Index (monthly, end of month)
  '2026-01-30': ['PCE Price Index (Dec 2025) at 8:30 AM ET'],
  '2026-02-27': ['PCE Price Index (Jan 2026) at 8:30 AM ET'],
  '2026-03-27': ['PCE Price Index (Feb 2026) at 8:30 AM ET'],
  '2026-04-30': ['PCE Price Index (Mar 2026) at 8:30 AM ET', 'GDP Q1 Advance at 8:30 AM ET'],
  '2026-05-29': ['PCE Price Index (Apr 2026) at 8:30 AM ET'],
  '2026-06-26': ['PCE Price Index (May 2026) at 8:30 AM ET'],
  '2026-07-31': ['PCE Price Index (Jun 2026) at 8:30 AM ET', 'GDP Q2 Advance at 8:30 AM ET'],
  '2026-08-28': ['PCE Price Index (Jul 2026) at 8:30 AM ET'],
  '2026-09-25': ['PCE Price Index (Aug 2026) at 8:30 AM ET'],
  '2026-10-30': ['PCE Price Index (Sep 2026) at 8:30 AM ET', 'GDP Q3 Advance at 8:30 AM ET'],
  '2026-11-25': ['PCE Price Index (Oct 2026) at 8:30 AM ET'],
  '2026-12-23': ['PCE Price Index (Nov 2026) at 8:30 AM ET'],
};

/**
 * Returns today's high-impact economic events as a formatted string.
 * Also checks tomorrow for pre-event positioning risk (e.g., FOMC eve).
 * Zero-cost, zero-latency — pure lookup.
 */
function getEconomicCalendarContext(nyDateStr: string): string {
  const today = new Date(nyDateStr + 'T12:00:00-04:00');
  const todayKey = today.toISOString().split('T')[0];
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowKey = tomorrow.toISOString().split('T')[0];

  const todayEvents = HIGH_IMPACT_EVENTS_2026[todayKey] || [];
  const tomorrowEvents = HIGH_IMPACT_EVENTS_2026[tomorrowKey] || [];

  const parts: string[] = [];
  if (todayEvents.length > 0) {
    parts.push(`🔴 TODAY (${todayKey}): ${todayEvents.join(', ')} — HIGH EVENT RISK`);
  }
  if (tomorrowEvents.length > 0) {
    parts.push(`🟡 TOMORROW (${tomorrowKey}): ${tomorrowEvents.join(', ')} — Pre-event caution`);
  }
  return parts.length > 0 ? parts.join('\n') : '🟢 No high-impact economic events today or tomorrow.';
}


interface Candle {
  datetime: string;
  nyDateStr: string;
  isRTH: boolean;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;
}

type TradePlanMode = 'HOLD_FOR_TP2' | 'BOOK_GREEN_FAST';

type TradeManagementPlan = {
  mode: TradePlanMode;
  bull_case: string;
  bear_case: string;
  tp1: {
    underlying: number | null;
    option_bid: number | null;
    action: string;
  };
  tp2: {
    underlying: number | null;
    option_bid: number | null;
    action: string;
  };
  out: {
    underlying: number | null;
    option_bid: number | null;
    action: string;
  };
  reason: string;
};

type OptionContractCandidate = {
  ticker: string;
  strike: number;
  expiry: string;
};

type OptionQuoteCandidate = OptionContractCandidate & {
  alpacaTicker: string;
  source?: string;
  bid: number | null;
  ask: number | null;
  spread: number | null;
  spreadPct: number | null;
  mark: number | null;
  volume: number | null;
  openInterest: number | null;
  last: number | null;
  delta?: number | null;
  gamma?: number | null;
  theta?: number | null;
  impliedVolatility?: number | null;
  score: number;
  reasons: string[];
};

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
    tenYear: MacroAssetSnapshot;
    dxy: MacroAssetSnapshot;
    oil: MacroAssetSnapshot;
    gold: MacroAssetSnapshot;
  };
};

export class SignalScannerService {
  private fastify: FastifyInstance;
  private aiService: AIService;
  private isRunning: boolean = false;
  private timerId: NodeJS.Timeout | null = null;
  private newsWarmTimerId: NodeJS.Timeout | null = null;
  private scanIntervalMs: number = 5 * 60 * 1000; // 5 minutes
  private lastScanSkippedReason: string | null = null;
  private lastScanAt: string | null = null;

  constructor(fastify: FastifyInstance) {
    this.fastify = fastify;
    this.aiService = new AIService(fastify);
  }

  private runLocalMLPredictor(features: {
    signal_score: number;
    vix_price: number;
    rsi5: number;
    rsi14: number;
    vwap_dist_pct: number;
    flow_direction: number;
    trend_aligned: number;
    internals_aligned: number;
    signal_type: string;
  }): Promise<number | null> {
    return new Promise((resolve) => {
      const scriptPath = path.join(__dirname, '..', 'scripts', 'predict.py');
      const featuresJson = JSON.stringify(features);

      execFile('python3', [scriptPath, featuresJson], { env: process.env, timeout: 1000 }, (error, stdout, stderr) => {
        if (error) {
          this.fastify.log.warn(`[MLPredictor] Execution error: ${error.message}`);
          resolve(null);
          return;
        }
        try {
          const res = JSON.parse(stdout.trim());
          if (res.error) {
            this.fastify.log.warn(`[MLPredictor] Python script error: ${res.error}`);
            resolve(null);
          } else {
            resolve(typeof res.probability === 'number' ? res.probability : null);
          }
        } catch (e: any) {
          this.fastify.log.warn(`[MLPredictor] Failed to parse output: ${stdout}. Error: ${e.message}`);
          resolve(null);
        }
      });
    });
  }

  private runNightlyModelTraining(): Promise<void> {
    const scriptPath = path.join(__dirname, '..', 'scripts', 'train.py');
    return new Promise((resolve) => {
      execFile('python3', [scriptPath], { env: process.env }, (error, stdout, stderr) => {
        if (error) {
          this.fastify.log.error(`[NightlyTraining] Retraining execution failed: ${error.message}`);
          resolve();
          return;
        }
        try {
          const res = JSON.parse(stdout.trim());
          if (res.error) {
            this.fastify.log.error(`[NightlyTraining] Training failed: ${res.error}`);
          } else {
            this.fastify.log.info(`[NightlyTraining] Retraining completed: ${res.status} | Msg: ${res.message} | Accuracy: ${res.accuracy || 'N/A'}`);
          }
        } catch (e: any) {
          this.fastify.log.error(`[NightlyTraining] Failed to parse output: ${stdout}. Error: ${e.message}`);
        }
        resolve();
      });
    });
  }

  public start() {
    this.fastify.log.info('[SignalScannerService] Starting background signal scanner loop...');
    this.scheduleNextScan(10000); // Wait 10s before first scan
    this.scheduleNextNewsWarm(8000); // Pre-warm news 8s after start (before first scan)

    // Schedule nightly model training at midnight ET
    cron.schedule('0 0 * * *', async () => {
      this.fastify.log.info('[SignalScannerService] Triggering nightly model training...');
      await this.runNightlyModelTraining();
    }, {
      timezone: "America/New_York"
    });

    // Check if ML model is missing, trigger background training immediately
    const modelPath = path.join(__dirname, '..', 'scripts', 'options_model.joblib');
    if (!fs.existsSync(modelPath)) {
      this.fastify.log.info('[SignalScannerService] Local ML model file not found. Triggering initial training run...');
      setImmediate(() => {
        this.runNightlyModelTraining().catch((err) => {
          this.fastify.log.warn(`[SignalScannerService] Initial background training failed: ${err.message}`);
        });
      });
    }
  }

  public stop() {
    if (this.timerId) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
    if (this.newsWarmTimerId) {
      clearTimeout(this.newsWarmTimerId);
      this.newsWarmTimerId = null;
    }
    this.fastify.log.info('[SignalScannerService] Stopped background scanner loop.');
  }

  // ── News Pre-Warm Loop ────────────────────────────────────────────────────
  // Runs every 5 minutes, offset 2 min BEFORE the signal scanner.
  // Fetches news + runs configured AI classification and caches results in Redis.
  // When enrichSignalAsync runs, it finds everything pre-cached and only needs trade coaching.

  private scheduleNextNewsWarm(delayMs: number = this.scanIntervalMs) {
    if (this.newsWarmTimerId) clearTimeout(this.newsWarmTimerId);
    this.newsWarmTimerId = setTimeout(async () => {
      try {
        await this.preWarmNewsForAllUsers();
      } catch (err: any) {
        this.fastify.log.warn(`[SignalScannerService] News pre-warm failed: ${err.message}`);
      } finally {
        this.scheduleNextNewsWarm();
      }
    }, delayMs);
  }

  private async preWarmNewsForAllUsers(): Promise<void> {
    try {
      const { rows } = await this.fastify.pg.query(`
        SELECT DISTINCT user_id FROM settings
        WHERE key = 'day_trading_enabled' AND value = 'true'
      `);
      for (const row of rows) {
        await this.preWarmNewsForUser(row.user_id).catch((e: any) =>
          this.fastify.log.warn(`[NewsPreWarm] Failed for user ${row.user_id}: ${e.message}`)
        );
      }
    } catch (err: any) {
      this.fastify.log.warn(`[NewsPreWarm] Could not load users: ${err.message}`);
    }
  }

  private async preWarmNewsForUser(userId: number): Promise<void> {
    const settings = await this.getSettingsForUser(userId);
    if (settings.day_trading_ai_enabled !== 'true') return;
    if (settings.day_trading_enabled !== 'true') return;

    const windowState = this.getTradingWindowState(settings);
    if (!windowState.isOpen) {
      this.fastify.log.info(`[NewsPreWarm] Market-hours gate is closed (${windowState.nowLabel} ET). Skipping news pre-warm for user ${userId}.`);
      return;
    }

    const aiSettings = await this.aiService.getSettings(userId);
    if (aiSettings.ai_provider === 'openrouter' && !aiSettings.openrouter_key) return;

    const symbols: string[] = settings.day_trading_symbols
      .split(',')
      .map((s: string) => s.trim().toUpperCase())
      .filter(Boolean);

    // Get today's NY date string
    const nyDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD

    for (const symbol of symbols) {
      await this.preWarmSymbol(symbol, nyDate, userId).catch((e: any) =>
        this.fastify.log.warn(`[NewsPreWarm] Failed for ${symbol}: ${e.message}`)
      );
    }
  }

  /**
   * Pre-warms news cache for a single symbol:
   *   1. Fetches Yahoo Finance + FinancialJuice RSS
   *   2. Computes fingerprint — skips AI classification if headlines haven't changed
   *   3. Runs the configured AI model classification → caches verdict in Redis
   * Result: enrichSignalAsync skips steps 1–3 and only calls the trade coach.
   */
  private async preWarmSymbol(
    symbol: string,
    nyDateStr: string,
    userId: number
  ): Promise<void> {
    const { headlines } = await this.fetchNewsContext(symbol);

    const newFingerprint = this.getNewsFingerprint(headlines);
    const fpRedisKey = `NEWS_FP:${symbol}:${nyDateStr}`;
    const cachedFp = await redis.get(fpRedisKey);

    if (cachedFp === newFingerprint) {
      const verdictKey = `NEWS_VERDICT:${symbol}:${nyDateStr}`;
      const cachedVerdict = await redis.get(verdictKey);
      if (cachedVerdict) {
        try {
          const parsed = JSON.parse(cachedVerdict);
          await redis.set(
            verdictKey,
            JSON.stringify({ ...parsed, generatedAt: new Date().toISOString() }),
            1800
          );
          this.fastify.log.info(`[NewsPreWarm] ${symbol} headlines unchanged — refreshed cached guardrail timestamp.`);
          return;
        } catch {
          this.fastify.log.warn(`[NewsPreWarm] ${symbol} cached verdict could not be parsed. Reclassifying.`);
        }
      }
    }

    // Headlines changed — update fingerprint and re-run AI classification
    await redis.set(fpRedisKey, newFingerprint, 1800);

    if (headlines.length === 0) {
      await redis.set(
        `NEWS_VERDICT:${symbol}:${nyDateStr}`,
        JSON.stringify({ verdict: 'NEUTRAL', rationale: 'No material news.', generatedAt: new Date().toISOString() }),
        1800
      );
      this.fastify.log.info(`[NewsPreWarm] ${symbol} — no headlines, cached NEUTRAL verdict.`);
      return;
    }

    const classifierPrompt = `You are a macro news classifier for equity options trading.

SIGNAL CONTEXT: ${symbol} — classify whether the macro environment is bullish or bearish for equity markets.

HEADLINES (last 6h):
${headlines.map((h, i) => `${i + 1}. ${h}`).join('\n')}

Respond ONLY with valid JSON:
{"verdict":"RISK_ON|RISK_OFF|NEUTRAL","rationale":"1 sentence, cite specific headline"}

Rules:
- RISK_ON = bullish/Nasdaq-positive environment
- RISK_OFF = downside pressure (geopolitical, Fed hawkish, macro fear)
- NEUTRAL = no material market-moving news`;

    try {
      const res = await this.aiService.askTradingJSON(classifierPrompt, userId, 150);
        await redis.set(
          `NEWS_VERDICT:${symbol}:${nyDateStr}`,
          JSON.stringify({
            verdict: res.verdict,
            rationale: res.rationale || res.analysis || '',
            usage: res.usage || null,
            generatedAt: new Date().toISOString()
          }),
          1800
        );
        this.fastify.log.info(`[NewsPreWarm] ${symbol} pre-warmed: ${res.verdict} — ${res.rationale || ''} | Tokens: ${res.usage?.total_tokens || 0}`);
    } catch (e: any) {
      this.fastify.log.warn(`[NewsPreWarm] AI classifier failed for ${symbol}: ${e.message}`);
    }
  }

  private getIndicatorWeights(regime: string, vix: number | null): Record<string, number> {
    const isHighVix = vix !== null && vix > 20;

    if (regime === 'BREAKOUT') {
      return {
        rangeBreak: isHighVix ? 35 : 30,         // ORH/ORL breakouts
        trendAlignment: 20,                       // Price > EMA9 > EMA21
        volumeBreakout: 15,                       // high-volume candle
        overnightBreak: 20,                       // ONH/ONL breakouts
        pdBreak: 20,                              // PDH/PDL breakouts
        internals: 10,                            // AAPL/MSFT/NVDA co-trend
        flowDirection: 15,                        // GEX flow
        rsiMomentum: 15                           // RSI5 > 50
      };
    } else {
      // MEAN_REVERSION
      return {
        supportResistanceHold: isHighVix ? 25 : 35, // holding ORL/ORH support/resistance
        rsiReversal: isHighVix ? 20 : 30,           // RSI5 <= 30 / RSI5 >= 70
        candleReversal: 20,                         // Reversal close color
        oversoldDip: 15,                            // Spot under/above VWAP
        internals: 10,                              // AAPL/MSFT/NVDA alignment
        flowDirection: 15,                          // GEX flow support
        gravityNode: 15                             // Spot between Flip and King / above King
      };
    }
  }

  private scheduleNextScan(delayMs: number = this.scanIntervalMs) {
    if (this.timerId) clearTimeout(this.timerId);
    this.timerId = setTimeout(async () => {
      try {
        await this.scanAllActiveUsers();
      } catch (err: any) {
        this.fastify.log.error(`[SignalScannerService] Error during scan cycle: ${err.message}`);
      } finally {
        this.scheduleNextScan();
      }
    }, delayMs);
  }

  private async getPrimaryUserId(): Promise<number> {
    // Use the first user with signal-critical credentials, then fall back to the first user.
    const { rows } = await this.fastify.pg.query(`
      SELECT user_id
      FROM settings
      WHERE key IN ('thetadata_base_url', 'sscgex_password') AND value IS NOT NULL AND value != ''
      ORDER BY user_id ASC
      LIMIT 1
    `);
    if (rows.length > 0) {
      return rows[0].user_id;
    }

    // 2. Fallback to the first user in the users table
    const { rows: users } = await this.fastify.pg.query(`
      SELECT id FROM users ORDER BY id ASC LIMIT 1
    `);
    if (users.length > 0) {
      return users[0].id;
    }
    
    return 1; // Default fallback ID if no users exist
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

  private getTradingWindowState(settings: any, now: Date = new Date()) {
    const nyParts = this.getNyDateParts(now);
    const startTime = settings.trading_start_time || '09:30';
    const cutoffTime = settings.trading_cutoff_time || '16:00';
    const startMinutes = this.parseTimeToMinutes(startTime, '09:30');
    const cutoffMinutes = this.parseTimeToMinutes(cutoffTime, '16:00');
    const weekday = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short'
    }).format(now);
    const isWeekday = weekday !== 'Sat' && weekday !== 'Sun';

    return {
      isOpen: isWeekday && nyParts.minutes >= startMinutes && nyParts.minutes < cutoffMinutes,
      isWeekday,
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
      const enabled = settings.day_trading_enabled === 'true';

      return {
        status: !enabled ? 'DISABLED' : this.isRunning ? 'RUNNING' : windowState.isOpen ? 'SCANNING' : 'MARKET_CLOSED',
        enabled,
        marketOpen: windowState.isOpen,
        window: {
          start: windowState.startTime,
          cutoff: windowState.cutoffTime,
          now: windowState.nowLabel,
          timezone: 'America/New_York'
        },
        signalSourceUserId: primaryUserId,
        lastScanAt: this.lastScanAt,
        lastSkippedReason: this.lastScanSkippedReason,
        intervalSeconds: Math.round(this.scanIntervalMs / 1000)
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

  public async scanAllActiveUsers(force: boolean = false) {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      const primaryUserId = await this.getPrimaryUserId();
      const settings = await this.getSettingsForUser(primaryUserId);
      this.fastify.log.info(`[SignalScannerService] Using user ${primaryUserId} as the global signal source. Eligible users execute from their own broker settings.`);
      if (settings.day_trading_enabled !== 'true') {
        this.lastScanSkippedReason = 'DISABLED';
        this.fastify.log.info(`[SignalScannerService] Scanner disabled for user ${primaryUserId}. Skipping background scan.`);
        return;
      }

      const windowState = this.getTradingWindowState(settings);
      if (!force && !windowState.isOpen) {
        this.lastScanSkippedReason = 'MARKET_CLOSED';
        this.fastify.log.info(`[SignalScannerService] Market-hours gate is closed (${windowState.nowLabel} ET, ${windowState.startTime}-${windowState.cutoffTime}). Skipping background scan.`);
        return;
      }

      try {
        await this.scanForUser(primaryUserId);
        this.lastScanAt = new Date().toISOString();
        this.lastScanSkippedReason = null;
      } catch (userErr: any) {
        this.fastify.log.error(`[SignalScannerService] Universal scan failed for user ${primaryUserId}: ${userErr.message}`);
      }
    } catch (err: any) {
      this.fastify.log.error(`[SignalScannerService] Failed to execute universal scan: ${err.message}`);
    } finally {
      this.isRunning = false;
    }
  }

  public async getSettingsForUser(userId: number): Promise<Record<string, string>> {
    const dbSettings = await getSettingsWithGlobalFallback(this.fastify.pg, userId);

    const defaults = {
      day_trading_enabled: 'true',
      day_trading_symbols: 'QQQ,SPY',
      sscgex_password: '',
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
      alpaca_key_id: '',
      alpaca_secret_key: '',
      alpaca_auto_trade_mode: 'instant',
      snaptrade_auto_trade: 'false',
      snaptrade_trading_account_id: '',
      max_trades_per_day: '2',
      contracts_per_trade: '1',
      order_type: 'LIMIT',
      entry_slippage_pct: '3',
      take_profit_pct: '',
      stop_loss_engine_enabled: 'true',
      live_trading_acknowledged: 'false'
    };

    return { ...defaults, ...dbSettings };
  }

  private async scanForUser(userId: number) {
    const settings = await this.getSettingsForUser(userId);
    if (settings.day_trading_enabled !== 'true') return;

    const symbols = settings.day_trading_symbols
      .split(',')
      .map((s: string) => s.trim().toUpperCase())
      .filter(Boolean);

    this.fastify.log.info(`[SignalScannerService] Scanning symbols: ${symbols.join(', ')} for user ${userId}`);

    for (const symbol of symbols) {
      try {
        await this.evaluateSymbol(symbol, userId, settings);
      } catch (err: any) {
        this.fastify.log.error(`[SignalScannerService] Failed to scan ${symbol} for user ${userId}: ${err.message}`);
      }
    }
  }

  private async evaluateSymbol(symbol: string, userId: number, settings: any) {
    const now = new Date();
    const nyParts = this.getNyDateParts(now);

    // 1. Check Trading Window Blocker
    const startMinutes = this.parseTimeToMinutes(settings.trading_start_time, '09:30');
    const cutoffMinutes = this.parseTimeToMinutes(settings.trading_cutoff_time, '16:00');
    const currentMinutes = nyParts.minutes;

    const noTradeReasons: string[] = [];

    if (currentMinutes < startMinutes) {
      noTradeReasons.push(`Before trade start time ${settings.trading_start_time} ET`);
    }
    if (currentMinutes >= cutoffMinutes) {
      noTradeReasons.push(`After trade cutoff ${settings.trading_cutoff_time} ET`);
    }

    // 2. Fetch GEX regime token and details
    let gexData: any = null;
    let gexAvailable = false;
    if (settings.sscgex_password) {
      try {
        const tokenCacheKey = `CACHE:GEX_AUTH_TOKEN:${settings.sscgex_password}`;
        let token = await redis.get(tokenCacheKey);

        if (!token) {
          this.fastify.log.info('[SignalScannerService] Fetching fresh GEX auth token...');
          const tokenRes = await axios.post('https://sscgex.up.railway.app/api/auth', {
            password: settings.sscgex_password
          }, { timeout: 8000 });
          token = (tokenRes.data as any).token;
          if (token) {
            await redis.set(tokenCacheKey, token, 600); // cache for 10 minutes
          }
        }

        if (token) {
          const gexCacheKey = `CACHE:GEX_DATA:${symbol}`;
          const cachedGexStr = await redis.get(gexCacheKey);
          let fetchSucceeded = false;

          try {
            const gexRes = await axios.get(`https://sscgex.up.railway.app/api/gex/${symbol}?strikes=50`, {
              headers: { Authorization: `Bearer ${token}` },
              timeout: 8000
            });
            gexData = gexRes.data;
            gexAvailable = typeof gexData.spot === 'number' && Boolean(gexData.regime);
            if (gexAvailable) {
              fetchSucceeded = true;
              await redis.set(gexCacheKey, JSON.stringify(gexData), 60); // cache for 60 seconds
            }
          } catch (fetchErr: any) {
            this.fastify.log.warn(`[SignalScannerService] Live GEX fetch failed for ${symbol}: ${fetchErr.message}. Checking fallback cache.`);
          }

          if (!fetchSucceeded && cachedGexStr) {
            try {
              gexData = JSON.parse(cachedGexStr);
              gexAvailable = typeof gexData.spot === 'number' && Boolean(gexData.regime);
              if (gexAvailable) {
                this.fastify.log.info(`[SignalScannerService] Successfully recovered GEX data from fallback cache for ${symbol}`);
              }
            } catch (err: any) {
              this.fastify.log.error(`[SignalScannerService] Failed to parse cached GEX data: ${err.message}`);
            }
          }
        }
      } catch (err: any) {
        this.fastify.log.warn(`[SignalScannerService] GEX Portal fetch failed for ${symbol}: ${err.message}`);
      }
    }

    if (!gexAvailable) {
      noTradeReasons.push('GEX data unavailable — regime unknown, skipping to prevent silent strategy flip');
    }

    // 3. Fetch Yahoo Finance Price Candles (5-minute for 5 days)
    let sortedCandles: Candle[] = [];
    try {
      const now = new Date();
      const fiveDaysAgo = new Date();
      fiveDaysAgo.setDate(now.getDate() - 5);

      const chartData = await (yahooFinance as any).chart(symbol, {
        interval: '5m',
        period1: fiveDaysAgo,
        period2: now,
        includePrePost: true
      });

      const result = chartData?.quotes || [];

      for (let i = 0; i < result.length; i++) {
        const quote = result[i];
        const open = this.toNumber(quote.open);
        const high = this.toNumber(quote.high);
        const low = this.toNumber(quote.low);
        const close = this.toNumber(quote.close);
        const volume = this.toNumber(quote.volume ?? 0) ?? 0;

        if (quote.date && open !== null && high !== null && low !== null && close !== null) {
          const dateObj = quote.date instanceof Date ? quote.date : new Date(quote.date);
          const datetime = dateObj.toISOString();
          const nyCandleParts = this.getNyDateParts(dateObj);
          const isRTH = nyCandleParts.minutes >= (9 * 60 + 30) && nyCandleParts.minutes < (16 * 60);
          const timestamp = Math.floor(dateObj.getTime() / 1000);

          sortedCandles.push({
            datetime,
            nyDateStr: nyCandleParts.dateStr,
            isRTH,
            open,
            high,
            low,
            close,
            volume,
            timestamp
          });
        }
      }
    } catch (err: any) {
      this.fastify.log.error(`[SignalScannerService] Yahoo Finance fetch failed for ${symbol}: ${err.message}`);
      return;
    }

    if (sortedCandles.length < 30) {
      this.fastify.log.warn(`[SignalScannerService] Not enough candles (${sortedCandles.length}) for ${symbol}. Skipping.`);
      return;
    }

    // Identify session groupings
    const latestDateStr = sortedCandles[sortedCandles.length - 1].nyDateStr;
    const rthCandles = sortedCandles.filter(c => c.isRTH);
    const currentSessionRTHCandles = rthCandles.filter(c => c.nyDateStr === latestDateStr);

    const dates = [...new Set(rthCandles.map(c => c.nyDateStr))];
    let previousDateStr = null;
    if (dates.length > 1) {
      previousDateStr = dates[dates.indexOf(latestDateStr) - 1];
    }

    let pdh: number | null = null;
    let pdl: number | null = null;
    let onh: number | null = null;
    let onl: number | null = null;

    if (previousDateStr) {
      const previousSessionRTH = rthCandles.filter(c => c.nyDateStr === previousDateStr);
      if (previousSessionRTH.length > 0) {
        pdh = Math.max(...previousSessionRTH.map(c => c.high));
        pdl = Math.min(...previousSessionRTH.map(c => c.low));
      }

      // Overnight candles: between end of previous RTH and start of current RTH
      const lastPrevRTH = previousSessionRTH[previousSessionRTH.length - 1];
      const firstCurrRTH = currentSessionRTHCandles[0];
      if (lastPrevRTH) {
        const overnightCandles = sortedCandles.filter(c =>
          c.timestamp > lastPrevRTH.timestamp &&
          (!firstCurrRTH || c.timestamp < firstCurrRTH.timestamp)
        );
        if (overnightCandles.length > 0) {
          onh = Math.max(...overnightCandles.map(c => c.high));
          onl = Math.min(...overnightCandles.map(c => c.low));
        }
      }
    }

    const sessionCandles = currentSessionRTHCandles.length >= 2
      ? currentSessionRTHCandles
      : sortedCandles.filter(c => c.nyDateStr === latestDateStr);

    const latest = sessionCandles[sessionCandles.length - 1] || sortedCandles[sortedCandles.length - 1];
    const previous = sessionCandles[sessionCandles.length - 2] || sortedCandles[sortedCandles.length - 2];
    const closes = rthCandles.map(c => c.close);

    const currentPrice = latest.close;

    // Technical calculations
    const rsi5 = this.computeRsi(closes, 5) || 50;
    const rsi14 = this.computeRsi(closes, 14) || 50;
    const emaShort = this.computeEma(closes, 9);
    const emaLong = this.computeEma(closes, 21);

    // Calculate VWAP (RTH only)
    let cumulativePv = 0;
    let cumulativeVolume = 0;
    for (const candle of sessionCandles) {
      const typicalPrice = (candle.high + candle.low + candle.close) / 3;
      cumulativePv += typicalPrice * candle.volume;
      cumulativeVolume += candle.volume;
    }
    const vwap = cumulativeVolume > 0 ? cumulativePv / cumulativeVolume : currentPrice;

    if (cumulativeVolume === 0) {
      noTradeReasons.push('Intraday volume unavailable, VWAP is degraded');
    }

    // Opening Range High/Low (first 15m of session)
    const rangeMinutes = 15;
    const candlesPerRange = Math.max(1, Math.round(rangeMinutes / 5));
    const openingRangeCandles = sessionCandles.slice(0, Math.min(candlesPerRange, sessionCandles.length));
    const openingRangeHigh = openingRangeCandles.length > 0
      ? Math.max(...openingRangeCandles.map(c => c.high))
      : latest.high;
    const openingRangeLow = openingRangeCandles.length > 0
      ? Math.min(...openingRangeCandles.map(c => c.low))
      : latest.low;

    // Volume Breakout Check
    const last10 = rthCandles.slice(Math.max(0, rthCandles.length - 10));
    const avgVolume = last10.reduce((sum, c) => sum + c.volume, 0) / (last10.length || 1);
    const hasVolumeBreakout = latest.volume > (avgVolume * 1.5);
    const hasBullishVolumeBreakout = hasVolumeBreakout && latest.close >= latest.open;
    const hasBearishVolumeBreakout = hasVolumeBreakout && latest.close <= latest.open;

    const atr14 = this.computeAtr(rthCandles, 14) || 1.0;

    const previousClose = previous.close;
    const sessionChangePct = ((currentPrice - previousClose) / previousClose) * 100;
    const candleChangePct = ((latest.close - previous.close) / previous.close) * 100;

    // 4. Fetch macro context used by 0DTE regime guards
    let vixPrice: number | null = null;
    let vixPreviousClose: number | null = null;
    let vixChangePct: number | null = null;
    const vixSnapshot = await this.fetchYahooMacroSnapshot('^VIX', 'VIX');
    vixPrice = vixSnapshot.value;
    vixPreviousClose = vixSnapshot.previousClose;
    vixChangePct = vixSnapshot.changePct;

    if (vixPrice === null) {
      noTradeReasons.push('VIX data unavailable from Yahoo response');
    }

    let tenYearYield: number | null = null;
    let tenYearPreviousClose: number | null = null;
    let tenYearChangePct: number | null = null;
    let tenYearChangeBps: number | null = null;
    const rawTenYearSnapshot = await this.fetchYahooMacroSnapshot('^TNX', 'US 10Y');
    if (rawTenYearSnapshot.value !== null && rawTenYearSnapshot.previousClose !== null) {
      tenYearChangeBps = Number(((rawTenYearSnapshot.value - rawTenYearSnapshot.previousClose) * 10).toFixed(1));
    }
    const tenYearSnapshot = {
      ...rawTenYearSnapshot,
      changeBps: tenYearChangeBps
    };
    tenYearYield = tenYearSnapshot.value;
    tenYearPreviousClose = tenYearSnapshot.previousClose;
    tenYearChangePct = tenYearSnapshot.changePct;

    const [dxySnapshot, oilSnapshot, goldSnapshot] = await Promise.all([
      this.fetchYahooMacroSnapshot(['DX-Y.NYB', 'UUP'], 'DXY'),
      this.fetchYahooMacroSnapshot('CL=F', 'Oil'),
      this.fetchYahooMacroSnapshot('GC=F', 'Gold')
    ]);

    // 5. Fetch Mega-Cap Internals
    let bullishInternals = 0;
    let bearishInternals = 0;
    let applePct: number | null = null;
    let microsoftPct: number | null = null;
    let nvidiaPct: number | null = null;

    let fetchedFromAlpaca = false;
    const alpacaKeyId = settings.alpaca_key_id?.trim();
    const alpacaSecretKey = settings.alpaca_secret_key?.trim();

    if (alpacaKeyId && alpacaSecretKey) {
      try {
        this.fastify.log.info('[SignalScannerService] Fetching mega-caps snapshots from Alpaca...');
        const stockUrl = 'https://data.alpaca.markets/v2/stocks/snapshots?symbols=AAPL,MSFT,NVDA';
        const stockRes = await axios.get(stockUrl, {
          headers: {
            'APCA-API-KEY-ID': alpacaKeyId,
            'APCA-API-SECRET-KEY': alpacaSecretKey
          },
          timeout: 5000
        });

        const stockData = stockRes.data as any;
        const processAlpacaStock = (sym: string) => {
          const snap = stockData[sym];
          if (!snap) return null;
          const current = snap.latestTrade?.p || snap.latestQuote?.ap || 0;
          const prev = snap.prevDailyBar?.c || 0;
          if (current > 0 && prev > 0) {
            return Number((((current - prev) / prev) * 100).toFixed(2));
          }
          return null;
        };

        applePct = processAlpacaStock('AAPL');
        microsoftPct = processAlpacaStock('MSFT');
        nvidiaPct = processAlpacaStock('NVDA');

        if (applePct !== null && microsoftPct !== null && nvidiaPct !== null) {
          fetchedFromAlpaca = true;
          this.fastify.log.info(`[SignalScannerService] Mega-caps fetched from Alpaca: AAPL=${applePct}%, MSFT=${microsoftPct}%, NVDA=${nvidiaPct}%`);
          
          if (applePct > 0) bullishInternals++; else if (applePct < 0) bearishInternals++;
          if (microsoftPct > 0) bullishInternals++; else if (microsoftPct < 0) bearishInternals++;
          if (nvidiaPct > 0) bullishInternals++; else if (nvidiaPct < 0) bearishInternals++;
        }
      } catch (err: any) {
        this.fastify.log.warn(`[SignalScannerService] Failed to fetch mega-caps from Alpaca: ${err.message}`);
      }
    }

    if (!fetchedFromAlpaca) {
      try {
        const internals = await (yahooFinance as any).quote(['AAPL', 'MSFT', 'NVDA']);
        const internalsList = Array.isArray(internals) ? internals : [internals];

        for (const stock of internalsList) {
          const change = stock.regularMarketChangePercent ?? 0;
          if (stock.symbol === 'AAPL') applePct = change;
          if (stock.symbol === 'MSFT') microsoftPct = change;
          if (stock.symbol === 'NVDA') nvidiaPct = change;

          if (change > 0) bullishInternals++;
          if (change < 0) bearishInternals++;
        }
      } catch (internalErr: any) {
        this.fastify.log.warn(`[SignalScannerService] Yahoo mega-caps check failed: ${internalErr.message}`);
      }
    }

    const hasBullishInternals = bullishInternals >= 2;
    const hasBearishInternals = bearishInternals >= 2;

    // Parse GEX
    const qqqNetGex = gexData ? (this.toNumber(gexData.net_gex) ?? 0) : 0;
    const qqqGexRegime = gexData ? String(gexData.regime || '').toUpperCase() : 'NEUTRAL';
    const qqqGexFlip = gexData ? this.toNumber(gexData.flip) : null;
    const qqqCallWall = gexData ? this.toNumber(gexData.call_wall?.strike) : null;
    const qqqPutWall = gexData ? this.toNumber(gexData.put_wall?.strike) : null;
    const qqqFloor = gexData ? this.toNumber(gexData.floor?.strike) : null;
    const qqqCeiling = gexData ? this.toNumber(gexData.ceiling?.strike) : null;
    const qqqKingNode = gexData ? this.toNumber(gexData.king_node?.strike) : null;
    const qqqFlowDirection = gexData ? String(gexData.flow_direction || 'neutral').toLowerCase() : 'neutral';
    const qqqNetChex = gexData ? (this.toNumber(gexData.net_chex) ?? 0) : 0;

    // 6. Score setups based on Regime (BREAKOUT vs MEAN_REVERSION)
    const callScoreParts: Array<{ points: number; reason: string }> = [];
    const putScoreParts: Array<{ points: number; reason: string }> = [];

    const addScore = (bucket: any[], condition: boolean, points: number, reason: string) => {
      if (condition) bucket.push({ points, reason });
    };

    let regime = qqqGexRegime === 'NEGATIVE' ? 'BREAKOUT' : 'MEAN_REVERSION';
    const weights = this.getIndicatorWeights(regime, vixPrice);

    if (regime === 'BREAKOUT') {
      // CALL
      addScore(callScoreParts, currentPrice >= openingRangeHigh, weights.rangeBreak, 'Price broke above Opening Range High');
      addScore(callScoreParts, currentPrice > vwap, weights.trendAlignment, 'Price is above VWAP');
      addScore(callScoreParts, emaShort !== null && emaLong !== null && emaShort > emaLong && currentPrice > emaShort, weights.trendAlignment, 'Bullish trend alignment (Price > EMA9 > EMA21)');
      addScore(callScoreParts, rsi5 > 50 && rsi5 > rsi14, weights.rsiMomentum, 'Momentum is bullish (RSI5 > 50 and RSI5 > RSI14)');
      addScore(callScoreParts, hasBullishVolumeBreakout, weights.volumeBreakout, 'Bullish volume breakout (high-volume green candle)');
      addScore(callScoreParts, onh !== null && currentPrice >= onh, weights.overnightBreak, 'Price broke above Overnight High (ONH)');
      addScore(callScoreParts, pdh !== null && currentPrice >= pdh, weights.pdBreak, 'Price broke above Previous Day High (PDH)');
      addScore(callScoreParts, hasBullishInternals, weights.internals, 'Mega-Caps are bullish');
      addScore(callScoreParts, qqqFlowDirection === 'bullish', weights.flowDirection, 'Options flow is bullish (GEX flow)');

      // PUT
      addScore(putScoreParts, currentPrice <= openingRangeLow, weights.rangeBreak, 'Price broke below Opening Range Low');
      addScore(putScoreParts, currentPrice < vwap, weights.trendAlignment, 'Price is below VWAP');
      addScore(putScoreParts, emaShort !== null && emaLong !== null && emaShort < emaLong && currentPrice < emaShort, weights.trendAlignment, 'Bearish trend alignment (Price < EMA9 < EMA21)');
      addScore(putScoreParts, rsi5 < 50 && rsi5 < rsi14, weights.rsiMomentum, 'Momentum is bearish (RSI5 < 50 and RSI5 < RSI14)');
      addScore(putScoreParts, hasBearishVolumeBreakout, weights.volumeBreakout, 'Bearish volume breakout (high-volume red candle)');
      addScore(putScoreParts, onl !== null && currentPrice <= onl, weights.overnightBreak, 'Price broke below Overnight Low (ONL)');
      addScore(putScoreParts, pdl !== null && currentPrice <= pdl, weights.pdBreak, 'Price broke below Previous Day Low (PDL)');
      addScore(putScoreParts, hasBearishInternals, weights.internals, 'Mega-Caps are bearish');
      addScore(putScoreParts, qqqFlowDirection === 'bearish', weights.flowDirection, 'Options flow is bearish (GEX flow)');
    } else {
      // MEAN_REVERSION
      // CALL
      addScore(callScoreParts, currentPrice >= openingRangeLow && currentPrice <= openingRangeLow * 1.002, weights.supportResistanceHold, 'Price holding Opening Range Low support');
      addScore(callScoreParts, rsi5 <= 30, weights.rsiReversal, 'Short-term RSI is oversold (RSI5 <= 30)');
      addScore(callScoreParts, latest.close > latest.open, weights.candleReversal, 'Latest candle closed green (reversal)');
      addScore(callScoreParts, currentPrice < vwap, weights.oversoldDip, 'Price is below VWAP (oversold dip)');
      addScore(callScoreParts, hasBullishInternals, weights.internals, 'Mega-Caps support reversal');
      addScore(callScoreParts, qqqGexRegime === 'POSITIVE' && qqqFlowDirection !== 'bearish', weights.flowDirection, 'Positive GEX and neutral/bullish flow');
      addScore(callScoreParts, qqqGexRegime === 'POSITIVE' && qqqKingNode !== null && qqqGexFlip !== null && currentPrice > qqqGexFlip && currentPrice < qqqKingNode, weights.gravityNode, 'Price between GEX Flip and King Node');

      // PUT
      addScore(putScoreParts, currentPrice <= openingRangeHigh && currentPrice >= openingRangeHigh * 0.998, weights.supportResistanceHold, 'Price rejecting Opening Range High resistance');
      addScore(putScoreParts, rsi5 >= 70, weights.rsiReversal, 'Short-term RSI is overbought (RSI5 >= 70)');
      addScore(putScoreParts, latest.close < latest.open, weights.candleReversal, 'Latest candle closed red (reversal)');
      addScore(putScoreParts, currentPrice > vwap, weights.oversoldDip, 'Price is above VWAP (overextended rip)');
      addScore(putScoreParts, hasBearishInternals, weights.internals, 'Mega-Caps support rejection');
      addScore(putScoreParts, qqqGexRegime === 'POSITIVE' && qqqFlowDirection !== 'bullish', weights.flowDirection, 'Positive GEX and neutral/bearish flow');
      addScore(putScoreParts, qqqGexRegime === 'POSITIVE' && qqqKingNode !== null && currentPrice > qqqKingNode, weights.gravityNode, 'Price above King Node');
    }

    const callScore = callScoreParts.reduce((sum, item) => sum + item.points, 0);
    const putScore = putScoreParts.reduce((sum, item) => sum + item.points, 0);
    const winningSide: 'CALL' | 'PUT' = callScore >= putScore ? 'CALL' : 'PUT';
    const winningScore = winningSide === 'CALL' ? callScore : putScore;
    const macroRegime = this.assessMacroRegime({
      winningSide,
      currentMinutes,
      vix: vixSnapshot,
      tenYear: tenYearSnapshot,
      dxy: dxySnapshot,
      oil: oilSnapshot,
      gold: goldSnapshot
    });

    // Afternoon threshold inflation
    let dynamicMinScore = Number(settings.min_signal_score);
    if (!Number.isFinite(dynamicMinScore) || dynamicMinScore <= 0) {
      dynamicMinScore = 70;
    }
    if (currentMinutes >= 13 * 60 + 30) {
      dynamicMinScore += 15;
    }
    dynamicMinScore += macroRegime.thresholdAdjustment;

    // 7. Check Volatility & Wall Blockers
    const volatilityBlockers = [];
    const maxVixForCalls = 30;
    const minVixForPuts = 13;

    if (winningSide === 'CALL' && vixPrice !== null && vixPrice > maxVixForCalls) {
      volatilityBlockers.push(`VIX ${vixPrice.toFixed(2)} is above call risk limit ${maxVixForCalls}`);
    }
    if (winningSide === 'PUT' && vixPrice !== null && vixPrice < minVixForPuts) {
      volatilityBlockers.push(`VIX ${vixPrice.toFixed(2)} is below put volatility floor ${minVixForPuts}`);
    }

    if (winningSide === 'CALL' && hasBearishInternals) {
      volatilityBlockers.push(`Mega-Caps are bearish. Avoid going long ${symbol}.`);
    }
    if (winningSide === 'PUT' && hasBullishInternals) {
      volatilityBlockers.push(`Mega-Caps are bullish. Avoid shorting ${symbol}.`);
    }

    for (const blocker of macroRegime.blockers) {
      volatilityBlockers.push(blocker);
    }

    // GEX proximity blockers
    if (winningSide === 'CALL' && qqqCallWall !== null && currentPrice < qqqCallWall) {
      if (qqqCallWall - currentPrice <= 0.50) {
        volatilityBlockers.push(`Blocked: Spot ($${currentPrice.toFixed(2)}) is too close to Call Wall ($${qqqCallWall.toFixed(2)})`);
      }
    }
    if (winningSide === 'PUT' && qqqPutWall !== null && currentPrice > qqqPutWall) {
      if (currentPrice - qqqPutWall <= 0.50) {
        volatilityBlockers.push(`Blocked: Spot ($${currentPrice.toFixed(2)}) is too close to Put Wall ($${qqqPutWall.toFixed(2)})`);
      }
    }

    if (regime === 'BREAKOUT' && qqqFloor !== null && qqqCeiling !== null) {
      if (qqqCeiling - qqqFloor <= 2.0) {
        volatilityBlockers.push(`Blocked: Pinned in tight GEX range ($${qqqFloor}–$${qqqCeiling}), breakout unlikely.`);
      }
    }

    if (qqqKingNode !== null && Math.abs(currentPrice - qqqKingNode) <= 0.50) {
      volatilityBlockers.push(`Blocked: Spot ($${currentPrice.toFixed(2)}) is pinned to King Node ($${qqqKingNode.toFixed(2)})`);
    }

    // Append blockers to reasons
    for (const blocker of volatilityBlockers) {
      noTradeReasons.push(blocker);
    }

    if (winningScore < dynamicMinScore) {
      noTradeReasons.push(`Best setup score ${winningScore} is below dynamic minimum ${dynamicMinScore}`);
    }

    // DYNAMIC OVERALL MARKET REGIME CLASSIFICATION
    let computedRegime = 'NEUTRAL';
    if (qqqGexRegime === 'POSITIVE' && vixPrice !== null && vixPrice <= 13.5 && hasBullishInternals) {
      computedRegime = 'EUPHORIA';
    } else if (qqqGexRegime === 'NEGATIVE' || currentPrice < vwap) {
      computedRegime = 'BEARISH';
    } else if (qqqGexRegime === 'POSITIVE' || currentPrice > vwap) {
      computedRegime = 'BULLISH';
    }

    // Resolve Contract ATM selection if actionable
    let signalType = 'NONE';
    let tradeBias = 'NO_TRADE';
    let optionTicker: string | null = null;
    let chosenStrike: number | null = null;
    let chosenExpiry: string | null = null;
    let pricingData: any = null;
    let planData: any = null;

    const isActionable = noTradeReasons.length === 0;

    if (isActionable) {
      signalType = winningSide;
      if (regime === 'BREAKOUT') {
        tradeBias = winningSide === 'CALL' ? 'BUY_CALL_ON_BREAKOUT' : 'BUY_PUT_ON_BREAKDOWN';
      } else {
        tradeBias = winningSide === 'CALL' ? 'BUY_CALL_ON_DIP' : 'BUY_PUT_ON_RIP';
      }

      // Fetch the expiry chain from ThetaData and select the cleanest nearby contract.
      const strikeOffset = parseInt(settings.strike_offset, 10) || 0;
      const todayDateStr = nyParts.dateStr;
      const targetExpiryDateStr = this.getTargetDayTradeExpiry(todayDateStr, nyParts.minutes);
      if (targetExpiryDateStr !== todayDateStr) {
        this.fastify.log.info(`[SignalScannerService] ${symbol} scan is after 1:00 PM ET. Selecting 1DTE expiry ${targetExpiryDateStr} instead of 0DTE ${todayDateStr}.`);
      }

      let chosenContract: OptionContractCandidate | null = null;
      let contractCandidates: OptionContractCandidate[] = [];
      let preferredStrike = Math.round(currentPrice);

      // 8. Contract pricing (ThetaData chain snapshot -> Black-Scholes fallback)
      let bid: number | null = null;
      let ask: number | null = null;
      let spread: number | null = null;
      let spreadPct: number | null = null;
      let mark: number | null = null;
      let volume: number | null = null;
      let openInterest: number | null = null;
      let usingTheoreticalPricing = true;
      const minOptionMark = 0.30;
      const maxBidAskSpreadPct = 12;
      const minOptionVolume = 200;
      const minOpenInterest = 500;
      let candidateSelection: any = null;
      let chainSelectionRejected = false;

      const defaultContractName = this.buildOsiTicker(symbol, targetExpiryDateStr, winningSide, Math.round(currentPrice));
      optionTicker = defaultContractName;
      chosenStrike = Math.round(currentPrice);
      chosenExpiry = targetExpiryDateStr;

      try {
        const thetaData = new ThetaDataService(this.fastify);
        const chain = await thetaData.getOptionChainSnapshot(
          userId,
          symbol,
          targetExpiryDateStr,
          winningSide === 'CALL' ? 'call' : 'put'
        );
        const parsed = chain
          .map((quote) => ({
            ticker: quote.ticker,
            strike: quote.strike,
            expiry: quote.expiration
          }))
          .filter((candidate, idx, arr) =>
            Number.isFinite(candidate.strike) &&
            arr.findIndex((other) => other.ticker === candidate.ticker) === idx
          )
          .sort((a, b) => a.strike - b.strike);

        if (parsed.length > 0) {
          let atmIdx = 0;
          let minDistance = Infinity;
          for (let i = 0; i < parsed.length; i++) {
            const dist = Math.abs(parsed[i].strike - currentPrice);
            if (dist < minDistance) {
              minDistance = dist;
              atmIdx = i;
            }
          }

          const preferredIdx = Math.max(
            0,
            Math.min(parsed.length - 1, winningSide === 'CALL' ? atmIdx + strikeOffset : atmIdx - strikeOffset)
          );
          chosenContract = parsed[preferredIdx];
          preferredStrike = chosenContract?.strike || parsed[atmIdx]?.strike || Math.round(currentPrice);
          contractCandidates = this.getContractWindow(parsed, atmIdx, winningSide, strikeOffset);
        }

        if (contractCandidates.length > 0) {
          this.fastify.log.info(`[SignalScannerService] Querying ThetaData option chain for ${contractCandidates.length}/${chain.length} ${symbol} candidates...`);
          const selection = this.fetchBestThetaDataOptionCandidate({
            chain,
            candidates: contractCandidates,
            preferredStrike,
            minOptionMark,
            maxBidAskSpreadPct,
            minOptionVolume,
            minOpenInterest
          });

          const selected = selection.selected;
          candidateSelection = {
            source: 'thetadata_chain',
            preferredStrike,
            selectedScore: selected?.score ?? null,
            selectedReasons: selected?.reasons ?? [],
            candidates: selection.ranked.slice(0, 9).map((candidate) => ({
              ticker: candidate.ticker,
              strike: candidate.strike,
              bid: candidate.bid,
              ask: candidate.ask,
              mark: candidate.mark,
              spreadPct: candidate.spreadPct,
              volume: candidate.volume,
              openInterest: candidate.openInterest,
              delta: candidate.delta ?? null,
              gamma: candidate.gamma ?? null,
              theta: candidate.theta ?? null,
              impliedVolatility: candidate.impliedVolatility ?? null,
              score: candidate.score,
              reasons: candidate.reasons
            }))
          };

          if (selected) {
            chosenContract = {
              ticker: selected.ticker,
              strike: selected.strike,
              expiry: selected.expiry
            };
            optionTicker = selected.ticker;
            chosenStrike = selected.strike;
            chosenExpiry = selected.expiry;
            bid = selected.bid;
            ask = selected.ask;
            spread = selected.spread;
            spreadPct = selected.spreadPct;
            mark = selected.mark;
            volume = selected.volume;
            openInterest = selected.openInterest;
            usingTheoreticalPricing = false;
            this.fastify.log.info(`[SignalScannerService] Selected ${selected.ticker} from ${selection.ranked.length} ThetaData candidates: strike=${selected.strike}, mark=$${mark}, spread=${spreadPct}%, volume=${volume}, OI=${openInterest}, score=${selected.score}.`);
          } else if (selection.ranked.length > 0) {
            chainSelectionRejected = true;
            const bestRejected = selection.ranked[0];
            this.fastify.log.warn(`[SignalScannerService] No ThetaData ${symbol} contract passed liquidity filters. Best rejected ${bestRejected.ticker}: mark=${bestRejected.mark}, spread=${bestRejected.spreadPct}%, volume=${bestRejected.volume}, OI=${bestRejected.openInterest}, score=${bestRejected.score}, reasons=${bestRejected.reasons.join('; ')}.`);
          }
        }
      } catch (thetaErr: any) {
        this.fastify.log.warn(`[SignalScannerService] ThetaData option chain selection failed: ${thetaErr.message}`);
      }

      if (usingTheoreticalPricing && chosenContract && !chainSelectionRejected) {
        try {
          const thetaData = new ThetaDataService(this.fastify);
          const quote = await thetaData.getOptionQuote(userId, {
            symbol,
            expiration: chosenContract.expiry,
            right: winningSide === 'CALL' ? 'call' : 'put',
            strike: chosenContract.strike
          });
          if (quote) {
            optionTicker = quote.ticker;
            bid = quote.bid;
            ask = quote.ask;
            spread = bid > 0 && ask > 0 ? Number((ask - bid).toFixed(2)) : null;
            spreadPct = quote.spreadPct;
            mark = quote.mark;
            volume = null;
            openInterest = null;
            usingTheoreticalPricing = false;
          }
        } catch (quoteErr: any) {
          this.fastify.log.warn(`[SignalScannerService] ThetaData single-contract quote fallback failed: ${quoteErr.message}`);
        }
      }

      if (usingTheoreticalPricing && !chainSelectionRejected) {
        // Black-Scholes option pricing model fallback
        const S = currentPrice;
        const K = chosenStrike ?? Math.round(currentPrice);
        const minutesRemaining = Math.max(5, 16 * 60 - currentMinutes);
        const T = minutesRemaining / (60 * 24 * 365);
        const r = 0.05; // 5% risk free
        const sigma = vixPrice !== null ? vixPrice / 100 : 0.18;

        const nd = (x: number): number => {
          const t = 1 / (1 + 0.2316419 * Math.abs(x));
          const d = 0.3989423 * Math.exp(-x * x / 2);
          const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
          return x >= 0 ? 1 - p : p;
        };

        try {
          const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
          const d2 = d1 - sigma * Math.sqrt(T);
          let bsPrice = 0.05;
          if (winningSide === 'CALL') {
            bsPrice = S * nd(d1) - K * Math.exp(-r * T) * nd(d2);
          } else {
            bsPrice = K * Math.exp(-r * T) * nd(-d2) - S * nd(-d1);
          }
          mark = Number(Math.max(0.05, bsPrice).toFixed(2));
          bid = Number((mark * 0.95).toFixed(2));
          ask = Number((mark * 1.05).toFixed(2));
          spread = Number((ask - bid).toFixed(2));
          spreadPct = Number(((spread / mark) * 100).toFixed(2));
          volume = 1200; // Mocked
          openInterest = 2500; // Mocked
        } catch (bsErr) {
          mark = 0.10;
          bid = 0.08;
          ask = 0.12;
          spread = 0.04;
          spreadPct = 40;
        }
      }

      // Check premium actionability constraints
      const pricingWarnings: string[] = [];
      if (mark === null || bid === null || ask === null) pricingWarnings.push('No usable live option quote selected');
      if (chainSelectionRejected) pricingWarnings.push('No ThetaData option candidate passed liquidity/spread filters');
      if (usingTheoreticalPricing) pricingWarnings.push('Using theoretical option price fallback');
      if (mark !== null && mark < minOptionMark) pricingWarnings.push(`Option premium $${mark} below limit $${minOptionMark}`);
      if (spreadPct !== null && spreadPct > maxBidAskSpreadPct) pricingWarnings.push(`Spread ${spreadPct}% exceeds ceiling ${maxBidAskSpreadPct}%`);
      if (volume !== null && volume < minOptionVolume) pricingWarnings.push(`Volume ${volume} below minimum ${minOptionVolume}`);
      if (openInterest !== null && openInterest < minOpenInterest) pricingWarnings.push(`Open interest ${openInterest} below minimum ${minOpenInterest}`);

      // Apply score adjustments for macro regime and pricing warnings.
      let finalConfidence = Math.max(0, Math.min(100, winningScore + macroRegime.confidenceAdjustment - pricingWarnings.length * 10));

      let setupGrade = '🎲 B / LOTTO';
      if (finalConfidence >= 92 && macroRegime.score >= 70 && pricingWarnings.length === 0) {
        setupGrade = '🔥 A+ / FULL';
      } else if (finalConfidence >= 85) {
        setupGrade = '⚡ A / STANDARD';
      }

      const optionStopLoss = mark !== null ? Number((mark * 0.8).toFixed(2)) : null;
      const optionTakeProfit = mark !== null ? Number((mark * 1.4).toFixed(2)) : null;

      pricingData = {
        ticker: optionTicker,
        side: winningSide,
        strike: chosenStrike,
        expiry: chosenExpiry,
        bid,
        ask,
        spread,
        spreadPct,
        mark,
        volume,
        openInterest,
        candidateSelection,
        suggestedStopLoss: optionStopLoss,
        suggestedTakeProfit: optionTakeProfit,
        usingTheoreticalPricing,
        macroConfidenceAdjustment: macroRegime.confidenceAdjustment
      };

      const entryTrigger = winningSide === 'CALL' ? latest.high : latest.low;
      const invalidationLevel = winningSide === 'CALL' ? latest.low : latest.high;
      const targetUnderlying = winningSide === 'CALL'
        ? Number((currentPrice * 1.0035).toFixed(2))
        : Number((currentPrice * 0.9965).toFixed(2));
      const minStopDistance = Math.max(1.0, atr14 * 0.5);
      const stopUnderlying = winningSide === 'CALL'
        ? Number(Math.min(invalidationLevel - 0.05, currentPrice - minStopDistance).toFixed(2))
        : Number(Math.max(invalidationLevel + 0.05, currentPrice + minStopDistance).toFixed(2));

      planData = {
        entryTriggerUnderlying: Number(entryTrigger.toFixed(2)),
        stopUnderlying,
        targetUnderlying,
        note: winningSide === 'CALL'
          ? `Use only if ${symbol} reclaims the latest 5-minute high and holds above VWAP.`
          : `Use only if ${symbol} breaks the latest 5-minute low and stays below VWAP.`
      };

      // Extract features for ML predictor
      const flowDirNum = qqqFlowDirection === 'bullish' ? 1.0 : (qqqFlowDirection === 'bearish' ? -1.0 : 0.0);
      const vwapDistPct = vwap ? ((currentPrice - vwap) / vwap) * 100 : 0.0;
      const trendAlignedNum = (winningSide === 'CALL' && emaShort !== null && emaLong !== null && emaShort > emaLong) ||
                              (winningSide === 'PUT' && emaShort !== null && emaLong !== null && emaShort < emaLong) ? 1.0 : 0.0;
      const internalsAlignedNum = (winningSide === 'CALL' && hasBullishInternals) ||
                                  (winningSide === 'PUT' && hasBearishInternals) ? 1.0 : 0.0;

      const mlFeatures = {
        signal_score: finalConfidence,
        vix_price: vixPrice ?? 15,
        rsi5,
        rsi14,
        vwap_dist_pct: Number(vwapDistPct.toFixed(4)),
        flow_direction: flowDirNum,
        trend_aligned: trendAlignedNum,
        internals_aligned: internalsAlignedNum,
        signal_type: winningSide
      };

      const mlProbability = await this.runLocalMLPredictor(mlFeatures);

      // ── STEP 1: Persist signal IMMEDIATELY (signal-first, AI follows async) ──
      // Signal is saved to DB right away so the UI shows it in real-time.
      // AI enrichment (news + coaching) happens in a fire-and-forget background task.
      const insertResult = await this.fastify.pg.query(`
        INSERT INTO signals (
          symbol, signal_type, trade_bias, current_price, entry_trigger, stop_loss, target_price,
          confidence_score, setup_grade, status, indicators, gex, volatility, no_trade_reasons,
          option_expiration_date, market_date, ml_probability, option_details
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
        RETURNING id
      `, [
        symbol,
        winningSide,
        tradeBias,
        currentPrice,
        Number(entryTrigger.toFixed(2)),
        stopUnderlying,
        targetUnderlying,
        finalConfidence,
        setupGrade,
        'PENDING',
        JSON.stringify({
          vwap: Number(vwap.toFixed(2)),
          openingRangeHigh: Number(openingRangeHigh.toFixed(2)),
          openingRangeLow: Number(openingRangeLow.toFixed(2)),
          atr14: Number(atr14.toFixed(2)),
          ema9: emaShort !== null ? Number(emaShort.toFixed(2)) : null,
          ema21: emaLong !== null ? Number(emaLong.toFixed(2)) : null,
          rsi5: Number(rsi5.toFixed(2)),
          rsi14: Number(rsi14.toFixed(2)),
          internalsBullish: hasBullishInternals,
          internalsBearish: hasBearishInternals,
          megaCaps: {
            AAPL: applePct,
            MSFT: microsoftPct,
            NVDA: nvidiaPct
          }
        }),
        JSON.stringify({
          netGex: qqqNetGex,
          regime: qqqGexRegime,
          flipStrike: qqqGexFlip,
          callWall: qqqCallWall,
          putWall: qqqPutWall,
          kingNode: qqqKingNode,
          flowDirection: qqqFlowDirection,
          ceiling: qqqCeiling,
          floor: qqqFloor
        }),
        JSON.stringify({
          vixQuote: vixPrice,
          vixChangePercent: vixChangePct,
          tenYearYield,
          tenYearChangePercent: tenYearChangePct,
          tenYearChangeBps,
          dxy: {
            symbol: dxySnapshot.symbol,
            value: dxySnapshot.value,
            changePercent: dxySnapshot.changePct
          },
          oil: {
            symbol: oilSnapshot.symbol,
            value: oilSnapshot.value,
            changePercent: oilSnapshot.changePct
          },
          gold: {
            symbol: goldSnapshot.symbol,
            value: goldSnapshot.value,
            changePercent: goldSnapshot.changePct
          },
          macroRegime: {
            regime: macroRegime.regime,
            score: macroRegime.score,
            directionBias: macroRegime.directionBias,
            confidenceAdjustment: macroRegime.confidenceAdjustment,
            thresholdAdjustment: macroRegime.thresholdAdjustment,
            blockers: macroRegime.blockers,
            warnings: macroRegime.warnings,
            contributors: macroRegime.contributors
          }
        }),
        noTradeReasons,
        chosenExpiry,
        nyParts.marketDate,
        mlProbability,
        JSON.stringify(pricingData)
      ]);

      const signalId: number = insertResult.rows[0].id;
      this.fastify.log.info(`[SignalScannerService] Signal #${signalId} saved instantly for ${symbol} ${winningSide} with ML Probability: ${mlProbability}.`);

      const cancelledResult = await this.retireOlderPendingSignals(symbol, signalId, winningSide as 'CALL' | 'PUT');
      if (cancelledResult > 0) {
        this.fastify.log.info(`[SignalScannerService] Retired ${cancelledResult} older pending ${symbol} setup(s) after signal #${signalId}.`);
      }

      // Broadcast new signal via WebSocket
      if (this.fastify.websocketServer) {
        this.fastify.websocketServer.clients.forEach((client: any) => {
          if (client.readyState === 1) {
            client.send(JSON.stringify({ type: 'NEW_SIGNAL', data: { id: signalId, symbol } }));
          }
        });
      }

      // ── Broker Auto-Trade Execution (Instant Entry, pre-AI) ──
      const autoTradeMode = settings.alpaca_auto_trade_mode || 'instant';
      if (this.isAutoExecutionEnabled(settings) && autoTradeMode === 'instant') {
        setImmediate(() => {
          this.executeSignalForEligibleUsers({
            userId,
            signalId,
            symbol,
            winningSide: winningSide as 'CALL' | 'PUT',
            chosenStrike: chosenStrike as number,
            chosenExpiry: chosenExpiry || '',
            stopUnderlying,
            targetUnderlying,
            mark,
            settings,
            autoTradeMode: 'instant'
          }).catch((err: any) => {
            this.fastify.log.error(`[SignalScannerService] Instant auto-execution failed for signal #${signalId}: ${err.message}`);
          });
        });
      }

      // ── STEP 2: Discord – signal alert fires immediately, no AI wait ──
      if (settings.discord_alerts_enabled === 'true' && settings.discord_webhook_url) {
        try {
          const premEntryStr = mark !== null ? `$${mark.toFixed(2)}` : 'N/A';
          const premSlStr = optionStopLoss !== null ? `$${optionStopLoss.toFixed(2)}` : 'N/A';
          const premTpStr = optionTakeProfit !== null ? `$${optionTakeProfit.toFixed(2)}` : 'N/A';
          const guardrail = await this.getCachedNewsGuardrail(symbol, nyParts.dateStr, winningSide as 'CALL' | 'PUT');
          const embedMessage = {
            content: [
              `🚨 **${symbol} ${chosenStrike}${winningSide === 'CALL' ? 'C' : 'P'}** | ${tradeBias}`,
              '',
              `**Entry:** ${symbol} above $${entryTrigger.toFixed(2)}`,
              `**Stop:** $${stopUnderlying}`,
              `**Target:** $${targetUnderlying}`,
              '',
              '**Option plan:**',
              `Entry premium: ${premEntryStr}`,
              `Stop premium: ${premSlStr}`,
              `Target premium: ${premTpStr}`,
              '',
              `**Score:** ${finalConfidence} / ${setupGrade}${mlProbability !== null ? ` | ML probability: ${Math.round(mlProbability * 100)}%` : ''}`,
              `**Macro:** ${macroRegime.regime} (${macroRegime.score}/100, ${macroRegime.directionBias})`,
              '',
              `**News risk:** ${guardrail.status} (${guardrail.verdict}, ${guardrail.freshness})`,
              `**Why:** ${guardrail.rationale}`,
              `**Suggestion:** ${guardrail.suggestion}`
            ].join('\n')
          };
          await axios.post(settings.discord_webhook_url, embedMessage, { timeout: 8000 });
        } catch (discErr: any) {
          this.fastify.log.error(`[SignalScannerService] Discord signal alert failed: ${discErr.message}`);
        }
      }

      // ── STEP 3: Fire-and-forget AI enrichment (runs in background, never blocks signal) ──
      if (settings.day_trading_ai_enabled === 'true') {
        setImmediate(() => {
          this.enrichSignalAsync({
            signalId,
            symbol,
            winningSide,
            chosenStrike: chosenStrike as number,
            currentPrice,
            vwap,
            emaShort,
            emaLong,
            qqqGexRegime,
            qqqFlowDirection,
            stopUnderlying,
            targetUnderlying,
            finalConfidence,
            setupGrade,
            entryTrigger: Number(entryTrigger.toFixed(2)),
            nyDateStr: nyParts.dateStr,
            settings,
            userId,
            mark,
            chosenExpiry: chosenExpiry || '',
            mlProbability,
            rsi5,
            rsi14,
            openingRangeHigh,
            openingRangeLow,
            previousDayHigh: pdh,
            previousDayLow: pdl,
            overnightHigh: onh,
            overnightLow: onl,
            atr14,
            latestCandle: latest.close >= latest.open ? 'green' : 'red',
            optionDetails: pricingData,
            marketStructure: {
              netGex: qqqNetGex,
              netChex: qqqNetChex,
              regime: qqqGexRegime,
              flipStrike: qqqGexFlip,
              callWall: qqqCallWall,
              putWall: qqqPutWall,
              floor: qqqFloor,
              ceiling: qqqCeiling,
              kingNode: qqqKingNode,
              flowDirection: qqqFlowDirection
            },
            marketContext: {
              vix: vixPrice,
              vixChangePct,
              tenYearYield,
              tenYearChangePct,
              tenYearChangeBps,
              dxy: dxySnapshot,
              oil: oilSnapshot,
              gold: goldSnapshot,
              macroRegime
            },
            internals: {
              aaplChangePct: applePct,
              msftChangePct: microsoftPct,
              nvdaChangePct: nvidiaPct,
              alignment: winningSide === 'CALL'
                ? (hasBullishInternals ? 'bullish' : hasBearishInternals ? 'bearish' : 'mixed')
                : (hasBearishInternals ? 'bearish' : hasBullishInternals ? 'bullish' : 'mixed')
            },
            riskFlags: {
              lateDayRisk: currentMinutes >= 13 * 60 + 30,
              optionSpreadAcceptable: spreadPct !== null ? spreadPct <= maxBidAskSpreadPct : false,
              liquidityAcceptable: (volume === null || volume >= minOptionVolume) && (openInterest ?? 0) >= minOpenInterest,
              flowAlignedWithSignal: winningSide === 'CALL'
                ? qqqFlowDirection === 'bullish'
                : qqqFlowDirection === 'bearish',
              internalsAlignedWithSignal: winningSide === 'CALL' ? hasBullishInternals : hasBearishInternals,
              trendAlignedWithSignal: Boolean(trendAlignedNum),
              macroSupportsSignal: macroRegime.directionBias === 'MIXED' || macroRegime.directionBias === winningSide
            }
          }).catch((err: any) => {
            this.fastify.log.error(`[SignalScannerService] enrichSignalAsync failed for #${signalId}: ${err.message}`);
          });
        });
      }

      // Also write to scanner_logs for complete historical transparency (outcome = SIGNAL_GENERATED)
      await this.fastify.pg.query(`
        INSERT INTO scanner_logs (
          symbol, spot_price, regime, vix, gex_available, indicators, outcome, no_trade_reasons
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [
        symbol,
        currentPrice,
        qqqGexRegime,
        vixPrice,
        gexAvailable,
        JSON.stringify({
          vwap: Number(vwap.toFixed(2)),
          openingRangeHigh: Number(openingRangeHigh.toFixed(2)),
          openingRangeLow: Number(openingRangeLow.toFixed(2)),
          atr14: Number(atr14.toFixed(2)),
          ema9: emaShort !== null ? Number(emaShort.toFixed(2)) : null,
          ema21: emaLong !== null ? Number(emaLong.toFixed(2)) : null,
          rsi5: Number(rsi5.toFixed(2)),
          rsi14: Number(rsi14.toFixed(2)),
          internalsBullish: hasBullishInternals,
          internalsBearish: hasBearishInternals,
          megaCaps: {
            AAPL: applePct,
            MSFT: microsoftPct,
            NVDA: nvidiaPct
          },
          macroRegime: {
            regime: macroRegime.regime,
            score: macroRegime.score,
            directionBias: macroRegime.directionBias,
            confidenceAdjustment: macroRegime.confidenceAdjustment,
            thresholdAdjustment: macroRegime.thresholdAdjustment,
            blockers: macroRegime.blockers,
            warnings: macroRegime.warnings
          }
        }),
        'SIGNAL_GENERATED',
        []
      ]);
    } else {
      // Save to scanner_logs table
      await this.fastify.pg.query(`
        INSERT INTO scanner_logs (
          symbol, spot_price, regime, vix, gex_available, indicators, outcome, no_trade_reasons
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [
        symbol,
        currentPrice,
        qqqGexRegime,
        vixPrice,
        gexAvailable,
        JSON.stringify({
          vwap: Number(vwap.toFixed(2)),
          openingRangeHigh: Number(openingRangeHigh.toFixed(2)),
          openingRangeLow: Number(openingRangeLow.toFixed(2)),
          atr14: Number(atr14.toFixed(2)),
          ema9: emaShort !== null ? Number(emaShort.toFixed(2)) : null,
          ema21: emaLong !== null ? Number(emaLong.toFixed(2)) : null,
          rsi5: Number(rsi5.toFixed(2)),
          rsi14: Number(rsi14.toFixed(2)),
          internalsBullish: hasBullishInternals,
          internalsBearish: hasBearishInternals,
          megaCaps: {
            AAPL: applePct,
            MSFT: microsoftPct,
            NVDA: nvidiaPct
          },
          macroRegime: {
            regime: macroRegime.regime,
            score: macroRegime.score,
            directionBias: macroRegime.directionBias,
            confidenceAdjustment: macroRegime.confidenceAdjustment,
            thresholdAdjustment: macroRegime.thresholdAdjustment,
            blockers: macroRegime.blockers,
            warnings: macroRegime.warnings
          }
        }),
        'BLOCKED',
        noTradeReasons
      ]);

      // Broadcast new scan log via WebSocket
      if (this.fastify.websocketServer) {
        this.fastify.websocketServer.clients.forEach((client: any) => {
          if (client.readyState === 1) {
            client.send(JSON.stringify({ type: 'NEW_SCAN_LOG', data: { symbol } }));
          }
        });
      }
    }
  }

  // ── Async Signal Enrichment (fires after signal is already saved) ─────────

  private async retireOlderPendingSignals(symbol: string, latestSignalId: number, latestSide: 'CALL' | 'PUT'): Promise<number> {
    const { rowCount } = await this.fastify.pg.query(
      `UPDATE signals
       SET status = 'CANCELLED'
       WHERE symbol = $1
         AND id <> $2
         AND status = 'PENDING'
         AND signal_type != 'NONE'
         AND (
           signal_type <> $3
           OR created_at < (SELECT created_at FROM signals WHERE id = $2)
         )`,
      [symbol, latestSignalId, latestSide]
    );

    await this.fastify.pg.query(
      `INSERT INTO signal_user_executions (signal_id, user_id, status, updated_at)
       SELECT s.id, sue.user_id, 'CANCELLED', CURRENT_TIMESTAMP
       FROM signals s
       JOIN signal_user_executions sue ON sue.signal_id = s.id
       WHERE s.symbol = $1
         AND s.id <> $2
         AND s.status = 'CANCELLED'
         AND sue.status = 'PENDING'
         AND sue.execution_broker IS NULL
         AND sue.broker_order_id IS NULL
         AND sue.execution_status IS NULL
       ON CONFLICT (signal_id, user_id) DO UPDATE
       SET status = 'CANCELLED',
           updated_at = CURRENT_TIMESTAMP`,
      [symbol, latestSignalId]
    );

    return rowCount || 0;
  }

  private isASetupGrade(setupGrade: string): boolean {
    const normalized = String(setupGrade || '').toUpperCase();
    return normalized.includes('A+') || /(^|[^A-Z])A([^A-Z+]|$)/.test(normalized);
  }

  private finiteNumber(value: any): number | null {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  private roundTo(value: any, decimals = 2): number | null {
    const numeric = this.finiteNumber(value);
    if (numeric === null) return null;
    const multiplier = Math.pow(10, decimals);
    return Math.round(numeric * multiplier) / multiplier;
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

  private assessMacroRegime(input: {
    winningSide: 'CALL' | 'PUT';
    currentMinutes: number;
    vix: MacroAssetSnapshot;
    tenYear: MacroAssetSnapshot;
    dxy: MacroAssetSnapshot;
    oil: MacroAssetSnapshot;
    gold: MacroAssetSnapshot;
  }): MacroRegimeAssessment {
    const { winningSide, currentMinutes, vix, tenYear, dxy, oil, gold } = input;
    const blockers: string[] = [];
    const warnings: string[] = [];
    const contributors: string[] = [];
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
      assets: { vix, tenYear, dxy, oil, gold }
    };
  }

  private optionBidEstimate(mark: number | null, target: number | null, progress: number): number | null {
    if (mark === null || target === null || target <= mark) return mark;
    return this.roundTo(mark + (target - mark) * progress);
  }

  private chooseDirectionalLevel(side: string, currentPrice: number, targetUnderlying: number, candidates: Array<number | null | undefined>): number {
    const unique = [...new Set(candidates
      .map((value) => this.finiteNumber(value))
      .filter((value): value is number => value !== null && value > 0)
      .map((value) => Number(value.toFixed(2))))];

    const directional = side === 'CALL'
      ? unique.filter((value) => value > currentPrice && value <= Math.max(targetUnderlying, currentPrice))
      : unique.filter((value) => value < currentPrice && value >= Math.min(targetUnderlying, currentPrice));

    if (directional.length === 0) return Number(targetUnderlying.toFixed(2));
    return side === 'CALL'
      ? directional.sort((a, b) => a - b)[0]
      : directional.sort((a, b) => b - a)[0];
  }

  private buildFallbackTradePlan(ctx: {
    winningSide: string;
    currentPrice: number;
    targetUnderlying: number;
    stopUnderlying: number;
    optionDetails?: any;
    openingRangeHigh?: number;
    openingRangeLow?: number;
    previousDayHigh?: number | null;
    previousDayLow?: number | null;
    overnightHigh?: number | null;
    overnightLow?: number | null;
    vwap: number;
    marketStructure?: any;
  }): TradeManagementPlan {
    const optionMark = this.roundTo(ctx.optionDetails?.mark);
    const optionTarget = this.roundTo(ctx.optionDetails?.suggestedTakeProfit);
    const optionStop = this.roundTo(ctx.optionDetails?.suggestedStopLoss ?? (optionMark !== null ? optionMark * 0.92 : null));
    const tp1Underlying = this.chooseDirectionalLevel(ctx.winningSide, ctx.currentPrice, ctx.targetUnderlying, [
      ctx.openingRangeHigh,
      ctx.openingRangeLow,
      ctx.previousDayHigh,
      ctx.previousDayLow,
      ctx.overnightHigh,
      ctx.overnightLow,
      ctx.vwap,
      ctx.marketStructure?.flipStrike,
      ctx.marketStructure?.callWall,
      ctx.marketStructure?.putWall,
      ctx.marketStructure?.floor,
      ctx.marketStructure?.ceiling,
      ctx.marketStructure?.kingNode
    ]);

    return {
      mode: 'BOOK_GREEN_FAST',
      bull_case: 'Scanner produced an A/A+ setup, but AI trade-plan output was unavailable or invalid.',
      bear_case: '0DTE uncertainty requires using conservative scanner exits until a valid plan is available.',
      tp1: {
        underlying: tp1Underlying,
        option_bid: this.optionBidEstimate(optionMark, optionTarget, 0.4),
        action: 'Book partial profit or move stop to breakeven at the first nearby structural level.'
      },
      tp2: {
        underlying: this.roundTo(ctx.targetUnderlying),
        option_bid: optionTarget,
        action: 'Close the remaining position at the scanner target.'
      },
      out: {
        underlying: this.roundTo(ctx.stopUnderlying),
        option_bid: optionStop,
        action: 'Exit if the underlying stop breaks or option bid loses breakeven protection.'
      },
      reason: 'Fallback plan uses scanner-derived TP/OUT levels because model output was not trusted.'
    };
  }

  private normalizeTradePlan(raw: any, fallback: TradeManagementPlan): TradeManagementPlan {
    const mode = raw?.mode === 'HOLD_FOR_TP2' || raw?.mode === 'BOOK_GREEN_FAST'
      ? raw.mode
      : fallback.mode;

    const normalizeLeg = (rawLeg: any, fallbackLeg: TradeManagementPlan['tp1']) => ({
      underlying: this.roundTo(rawLeg?.underlying) ?? fallbackLeg.underlying,
      option_bid: this.roundTo(rawLeg?.option_bid) ?? fallbackLeg.option_bid,
      action: String(rawLeg?.action || fallbackLeg.action).slice(0, 180)
    });

    return {
      mode,
      bull_case: String(raw?.bull_case || fallback.bull_case).slice(0, 220),
      bear_case: String(raw?.bear_case || fallback.bear_case).slice(0, 220),
      tp1: normalizeLeg(raw?.tp1, fallback.tp1),
      tp2: normalizeLeg(raw?.tp2, fallback.tp2),
      out: normalizeLeg(raw?.out, fallback.out),
      reason: String(raw?.reason || fallback.reason).slice(0, 240)
    };
  }

  private formatTradeLevel(level: number | null | undefined, prefix = '$'): string {
    return level === null || level === undefined ? 'N/A' : `${prefix}${Number(level).toFixed(2)}`;
  }

  private formatTradePlanCommentary(plan: TradeManagementPlan): string {
    const label = plan.mode === 'HOLD_FOR_TP2' ? 'HOLD FOR TP2' : 'BOOK GREEN FAST';
    return [
      `${label}`,
      `TP1: underlying ${this.formatTradeLevel(plan.tp1.underlying)} / option bid ~${this.formatTradeLevel(plan.tp1.option_bid)} - ${plan.tp1.action}`,
      `TP2: underlying ${this.formatTradeLevel(plan.tp2.underlying)} / option bid ~${this.formatTradeLevel(plan.tp2.option_bid)} - ${plan.tp2.action}`,
      `OUT: underlying ${this.formatTradeLevel(plan.out.underlying)} / option bid ~${this.formatTradeLevel(plan.out.option_bid)} - ${plan.out.action}`,
      `Reason: ${plan.reason}`
    ].join('\n');
  }

  private formatDiscordTradePlan(symbol: string, signalId: number, plan: TradeManagementPlan, macroVerdict: string): string {
    const icon = plan.mode === 'HOLD_FOR_TP2' ? '🟢' : '🔴';
    const label = plan.mode === 'HOLD_FOR_TP2' ? 'HOLD FOR TP2' : 'BOOK GREEN FAST';
    return [
      `${icon} **${label} · ${symbol} #${signalId}** · Macro: ${macroVerdict}`,
      '',
      `**TP1:** ${symbol} ${this.formatTradeLevel(plan.tp1.underlying)} / option bid ~${this.formatTradeLevel(plan.tp1.option_bid)} — ${plan.tp1.action}`,
      `**TP2:** ${symbol} ${this.formatTradeLevel(plan.tp2.underlying)} / option bid ~${this.formatTradeLevel(plan.tp2.option_bid)} — ${plan.tp2.action}`,
      `**OUT:** ${symbol} ${this.formatTradeLevel(plan.out.underlying)} / option bid ~${this.formatTradeLevel(plan.out.option_bid)} — ${plan.out.action}`,
      '',
      `**Reason:** ${plan.reason}`
    ].join('\n');
  }

  private getContractWindow(parsedContracts: OptionContractCandidate[], atmIdx: number, side: string, strikeOffset: number): OptionContractCandidate[] {
    const preferredIdx = Math.max(
      0,
      Math.min(
        parsedContracts.length - 1,
        side === 'CALL' ? atmIdx + strikeOffset : atmIdx - strikeOffset
      )
    );

    const indices = new Set<number>();
    for (let delta = -4; delta <= 4; delta++) {
      const idx = preferredIdx + delta;
      if (idx >= 0 && idx < parsedContracts.length) indices.add(idx);
    }
    indices.add(atmIdx);
    indices.add(preferredIdx);

    return [...indices]
      .sort((a, b) => a - b)
      .map((idx) => parsedContracts[idx])
      .filter(Boolean);
  }

  private scoreOptionCandidate(candidate: Omit<OptionQuoteCandidate, 'score' | 'reasons'>, preferredStrike: number, minOptionMark: number, maxBidAskSpreadPct: number, minOptionVolume: number, minOpenInterest: number): { score: number; reasons: string[] } {
    const reasons: string[] = [];
    let score = 100;

    const mark = Number(candidate.mark || 0);
    const spreadPct = candidate.spreadPct === null ? null : Number(candidate.spreadPct);
    const volume = candidate.volume === null ? null : Number(candidate.volume || 0);
    const openInterest = candidate.openInterest === null ? null : Number(candidate.openInterest || 0);
    const bid = Number(candidate.bid || 0);
    const ask = Number(candidate.ask || 0);
    const absDelta = candidate.delta === null || candidate.delta === undefined ? null : Math.abs(Number(candidate.delta));

    if (mark <= 0) {
      score -= 80;
      reasons.push('missing usable mark');
    } else if (mark < minOptionMark) {
      score -= 25;
      reasons.push(`premium below ${minOptionMark}`);
    } else if (mark >= 0.75 && mark <= 2.5) {
      score += 8;
      reasons.push('premium in quick-profit band');
    } else if (mark > 4) {
      score -= Math.min(18, (mark - 4) * 3);
      reasons.push(`premium above quick-profit band ${mark.toFixed(2)}`);
    }

    if (bid <= 0 || ask <= 0) {
      score -= 45;
      reasons.push('missing bid/ask');
    }

    if (spreadPct === null) {
      score -= 25;
      reasons.push('missing spread');
    } else if (spreadPct > maxBidAskSpreadPct) {
      score -= Math.min(45, (spreadPct - maxBidAskSpreadPct) * 3);
      reasons.push(`wide spread ${spreadPct.toFixed(1)}%`);
    } else {
      score += Math.max(0, maxBidAskSpreadPct - spreadPct);
    }

    if (volume === null) {
      reasons.push('volume unavailable');
    } else if (volume < minOptionVolume) {
      score -= 15;
      reasons.push(`volume below ${minOptionVolume}`);
    } else {
      score += Math.min(12, Math.log10(volume + 1) * 3);
    }

    if (openInterest === null) {
      score -= 10;
      reasons.push('OI unavailable');
    } else if (openInterest < minOpenInterest) {
      score -= 10;
      reasons.push(`OI below ${minOpenInterest}`);
    } else {
      score += Math.min(10, Math.log10(openInterest + 1) * 2);
    }

    if (absDelta === null || !Number.isFinite(absDelta)) {
      score -= 3;
      reasons.push('delta unavailable');
    } else if (absDelta < 0.25) {
      score -= Math.min(25, (0.25 - absDelta) * 100);
      reasons.push(`delta too low ${absDelta.toFixed(2)}`);
    } else if (absDelta > 0.7) {
      score -= Math.min(20, (absDelta - 0.7) * 80);
      reasons.push(`delta too high ${absDelta.toFixed(2)}`);
    } else {
      score += Math.max(0, 12 - Math.abs(absDelta - 0.45) * 40);
      if (absDelta >= 0.35 && absDelta <= 0.6) reasons.push('delta in quick-profit band');
    }

    score -= Math.abs(candidate.strike - preferredStrike) * 2;

    return { score: Number(score.toFixed(2)), reasons };
  }

  private fetchBestThetaDataOptionCandidate(input: {
    chain: ThetaDataOptionChainQuote[];
    candidates: OptionContractCandidate[];
    preferredStrike: number;
    minOptionMark: number;
    maxBidAskSpreadPct: number;
    minOptionVolume: number;
    minOpenInterest: number;
  }): { selected: OptionQuoteCandidate | null; ranked: OptionQuoteCandidate[] } {
    const uniqueCandidates = input.candidates.filter((candidate, idx, arr) =>
      candidate?.ticker && arr.findIndex((other) => other.ticker === candidate.ticker) === idx
    );
    if (uniqueCandidates.length === 0) return { selected: null, ranked: [] };

    const chainByTicker = new Map(input.chain.map((quote) => [quote.ticker, quote]));
    const ranked = uniqueCandidates.map((candidate) => {
      const quote = chainByTicker.get(candidate.ticker);
      const base = {
        ...candidate,
        alpacaTicker: candidate.ticker,
        source: 'thetadata_chain',
        bid: quote?.bid ?? null,
        ask: quote?.ask ?? null,
        spread: quote?.spread ?? null,
        spreadPct: quote?.spreadPct ?? null,
        mark: quote?.mark ?? null,
        volume: quote?.volume ?? null,
        openInterest: quote?.openInterest ?? null,
        last: quote?.last ?? null,
        delta: quote?.delta ?? null,
        gamma: quote?.gamma ?? null,
        theta: quote?.theta ?? null,
        impliedVolatility: quote?.impliedVolatility ?? null
      };
      const scored = this.scoreOptionCandidate(
        base,
        input.preferredStrike,
        input.minOptionMark,
        input.maxBidAskSpreadPct,
        input.minOptionVolume,
        input.minOpenInterest
      );
      return { ...base, ...scored };
    }).sort((a, b) => b.score - a.score);

    const selected = ranked.find((candidate) =>
      candidate.mark !== null &&
      candidate.mark >= input.minOptionMark &&
      candidate.bid !== null &&
      candidate.ask !== null &&
      candidate.bid > 0 &&
      candidate.ask > 0 &&
      candidate.spreadPct !== null &&
      candidate.spreadPct <= input.maxBidAskSpreadPct &&
      (candidate.volume === null || Number(candidate.volume) >= input.minOptionVolume) &&
      candidate.openInterest !== null &&
      Number(candidate.openInterest) >= input.minOpenInterest
    ) || null;

    return { selected, ranked };
  }

  private buildOsiTicker(symbol: string, expiration: string, side: 'CALL' | 'PUT', strike: number): string {
    const cleanDate = expiration.replace(/-/g, '');
    const yy = cleanDate.slice(2, 4);
    const mm = cleanDate.slice(4, 6);
    const dd = cleanDate.slice(6, 8);
    const right = side === 'CALL' ? 'C' : 'P';
    const strikeValue = Math.round(strike * 1000).toString().padStart(8, '0');
    return `${symbol.toUpperCase()}${yy}${mm}${dd}${right}${strikeValue}`;
  }

  /**
   * Two-stage AI enrichment pipeline. Runs in the background after signal INSERT.
   *
   * Stage 1 — Configured AI model:
   *   Classifies macro news as RISK_ON / RISK_OFF / NEUTRAL relative to signal direction.
   *   Uses Redis fingerprint to skip if headlines haven't changed since last cycle.
   *
   * Stage 2 — Configured AI model:
   *   Writes the full coaching commentary combining signal technicals + macro verdict.
   *   Produces: action line, thesis, ⚠️ PITFALL / ✅ CATALYST tags, concise coaching.
   *
   * Final result is written back to the signals row via UPDATE and posted to Discord.
   */
  private async enrichSignalAsync(ctx: {
    signalId: number;
    symbol: string;
    winningSide: string;
    chosenStrike: number;
    currentPrice: number;
    vwap: number;
    emaShort: number | null;
    emaLong: number | null;
    qqqGexRegime: string;
    qqqFlowDirection: string;
    stopUnderlying: number;
    targetUnderlying: number;
    finalConfidence: number;
    setupGrade: string;
    entryTrigger: number;
    nyDateStr: string;
    settings: any;
    userId: number;
    mark: number | null;
    chosenExpiry: string;
    mlProbability?: number | null;
    rsi5?: number;
    rsi14?: number;
    openingRangeHigh?: number;
    openingRangeLow?: number;
    previousDayHigh?: number | null;
    previousDayLow?: number | null;
    overnightHigh?: number | null;
    overnightLow?: number | null;
    atr14?: number;
    latestCandle?: string;
    optionDetails?: any;
    marketStructure?: any;
    marketContext?: any;
    internals?: any;
    riskFlags?: any;
  }): Promise<void> {
    const {
      signalId, symbol, winningSide, chosenStrike, currentPrice, vwap, emaShort, emaLong,
      qqqGexRegime, qqqFlowDirection, stopUnderlying, targetUnderlying, finalConfidence,
      setupGrade, entryTrigger, nyDateStr, settings, userId, mark, chosenExpiry,
      mlProbability, rsi5, rsi14, openingRangeHigh, openingRangeLow, previousDayHigh,
      previousDayLow, overnightHigh, overnightLow, atr14, latestCandle, optionDetails,
      marketStructure, marketContext, internals, riskFlags
    } = ctx;

    const aiSettings = await this.aiService.getSettings(userId);
    if (aiSettings.ai_provider === 'openrouter' && !aiSettings.openrouter_key) {
      this.fastify.log.warn(`[SignalScannerService] OpenRouter selected without API key — skipping AI enrichment for signal #${signalId}`);
      return;
    }

    // ── Check pre-warmed cache first (set by news pre-warm loop) ─────────────
    // If the pre-warm job already fetched news + classified it, we skip both steps
    // and go straight to trade coaching.
    const preWarmVerdictKey = `NEWS_VERDICT:${symbol}:${nyDateStr}`;
    const preWarmNewsKey = `NEWS_FP:${symbol}:${nyDateStr}`;
    const preWarmVerdict = await redis.get(preWarmVerdictKey);
    const preWarmFp = await redis.get(preWarmNewsKey);

    let headlines: string[] = [];
    let newsContextText = 'No material news in the last 6 hours.';
    let macroVerdict = 'NEUTRAL';
    let macroRationale = 'No conflicting macro news detected.';
    let newFingerprint = '';
    let llamaUsage: any = null;
    let claudeUsage: any = null;

    if (preWarmVerdict && preWarmFp) {
      // ✅ Cache hit: pre-warm loop already did the work
      try {
        const parsed = JSON.parse(preWarmVerdict);
        macroVerdict = parsed.verdict || 'NEUTRAL';
        macroRationale = parsed.rationale || macroRationale;
        llamaUsage = parsed.usage || null;
        newFingerprint = preWarmFp;
        this.fastify.log.info(`[SignalScannerService] Using pre-warmed cache for ${symbol}: ${macroVerdict} — skipping fetch+AI classification.`);
      } catch { /* use defaults */ }

      // Fetch raw text for DB/display (lightweight, no AI call)
      const { raw } = await this.fetchNewsContext(symbol).catch(() => ({ headlines: [], raw: 'News context unavailable.' }));
      newsContextText = raw;
    } else {
      // ❌ Cache miss (first run or race): fall back to reactive fetch + classify
      this.fastify.log.info(`[SignalScannerService] Pre-warm cache miss for ${symbol} — running reactive fetch+AI classification.`);
      const { headlines: h, raw } = await this.fetchNewsContext(symbol);
      headlines = h;
      newsContextText = raw;

      newFingerprint = this.getNewsFingerprint(headlines);
      const fpRedisKey = `NEWS_FP:${symbol}:${nyDateStr}`;
      const cachedFp = await redis.get(fpRedisKey);
      const headlinesChanged = cachedFp !== newFingerprint;

      if (headlines.length > 0 && (headlinesChanged || !cachedFp)) {
        await redis.set(fpRedisKey, newFingerprint, 1800);

        const classifierPrompt = `You are a macro news classifier for equity options trading.

SIGNAL: ${symbol} ${winningSide} — directional bias is ${winningSide === 'CALL' ? 'BULLISH' : 'BEARISH'}

HEADLINES (last 6h):
${headlines.map((h, i) => `${i + 1}. ${h}`).join('\n')}

Respond ONLY with valid JSON:
{"verdict":"RISK_ON|RISK_OFF|NEUTRAL","rationale":"1 sentence max, cite specific headline if relevant"}

Rules:
- RISK_ON = headlines support a bullish/Nasdaq-positive environment
- RISK_OFF = headlines create downside pressure (geopolitical, Fed hawkish, macro fear)
- NEUTRAL = no material market-moving news`;

        try {
          const llamaRes = await this.aiService.askTradingJSON(classifierPrompt, userId, 150);
          if (llamaRes.verdict && ['RISK_ON', 'RISK_OFF', 'NEUTRAL'].includes(llamaRes.verdict)) {
            macroVerdict = llamaRes.verdict;
            macroRationale = llamaRes.rationale || llamaRes.analysis || macroRationale;
            llamaUsage = llamaRes.usage || null;
          }
          this.fastify.log.info(`[SignalScannerService] AI macro verdict for ${symbol}: ${macroVerdict} — ${macroRationale} | Tokens: ${llamaRes.usage?.total_tokens || 0}`);
        } catch (llamaErr: any) {
          this.fastify.log.warn(`[SignalScannerService] AI classifier failed: ${llamaErr.message}`);
        }
      } else if (cachedFp) {
        // Headlines unchanged — reuse cached macro verdict
        const cachedVerdict = await redis.get(`NEWS_VERDICT:${symbol}:${nyDateStr}`);
        if (cachedVerdict) {
          try {
            const parsed = JSON.parse(cachedVerdict);
            macroVerdict = parsed.verdict || 'NEUTRAL';
            macroRationale = parsed.rationale || macroRationale;
            llamaUsage = parsed.usage || null;
          } catch { /* use defaults */ }
        }
      }
    }

    // Cache the macro verdict for 30 min
    await redis.set(
      `NEWS_VERDICT:${symbol}:${nyDateStr}`,
      JSON.stringify({ verdict: macroVerdict, rationale: macroRationale, generatedAt: new Date().toISOString() }),
      1800
    );

    // ── Stage 2: configured AI model — full signal coaching ───────────────────
    // Check if we have a cached coaching commentary and verdict for this exact setup.
    const isASetup = this.isASetupGrade(setupGrade);
    const setupCacheFingerprint = [
      newFingerprint || 'no-news',
      winningSide,
      chosenStrike,
      chosenExpiry,
      entryTrigger,
      stopUnderlying,
      targetUnderlying,
      setupGrade
    ].join(':');
    const commentaryCacheKey = `COACHING_DATA:${symbol}:${setupCacheFingerprint}`;
    const cachedData = await redis.get(commentaryCacheKey);
    let finalCommentary = '';
    let finalVerdict = 'WAIT';
    let finalDiscordContent = '';

    if (cachedData) {
      try {
        const parsed = JSON.parse(cachedData);
        finalCommentary = parsed.analysis || '';
        finalVerdict = parsed.verdict || 'WAIT';
        finalDiscordContent = parsed.discordContent || '';
        this.fastify.log.info(`[SignalScannerService] Reusing cached coaching commentary and verdict (${finalVerdict}) for signal #${signalId}`);
      } catch {
        finalCommentary = cachedData;
      }
    }

    if (!finalCommentary) {
      // Macro context badge for AI coach
      const macroBadge =
        macroVerdict === 'RISK_OFF' ? `⚠️ MACRO RISK-OFF: ${macroRationale}` :
        macroVerdict === 'RISK_ON'  ? `✅ MACRO RISK-ON: ${macroRationale}` :
        `ℹ️ MACRO NEUTRAL: ${macroRationale}`;

      const nowNyParts = this.getNyDateParts(new Date());
      const formattedTimeStr = `${nowNyParts.hour.toString().padStart(2, '0')}:${nowNyParts.minute.toString().padStart(2, '0')} ET`;

      const fallbackPlan = this.buildFallbackTradePlan({
        winningSide,
        currentPrice,
        targetUnderlying,
        stopUnderlying,
        optionDetails,
        openingRangeHigh,
        openingRangeLow,
        previousDayHigh,
        previousDayLow,
        overnightHigh,
        overnightLow,
        vwap,
        marketStructure
      });

      if (isASetup) {
        const macroNewsSupportsSignal = macroVerdict === 'NEUTRAL'
          ? null
          : winningSide === 'CALL'
            ? macroVerdict === 'RISK_ON'
            : macroVerdict === 'RISK_OFF';
        const scannerMacroSupportsSignal = typeof riskFlags?.macroSupportsSignal === 'boolean'
          ? riskFlags.macroSupportsSignal
          : null;
        const enrichedRiskFlags = {
          ...(riskFlags || {}),
          macroNewsSupportsSignal,
          scannerMacroSupportsSignal,
          macroSupportsSignal: scannerMacroSupportsSignal === false || macroNewsSupportsSignal === false
            ? false
            : scannerMacroSupportsSignal === true || macroNewsSupportsSignal === true
              ? true
              : null
        };
        const scannerData = {
          symbol,
          side: winningSide,
          strike: chosenStrike,
          expiry: chosenExpiry,
          signal_time_et: formattedTimeStr,
          setup_grade: setupGrade,
          confidence_score: finalConfidence,
          ml_probability: mlProbability ?? null,
          underlying: {
            price: this.roundTo(currentPrice),
            vwap: this.roundTo(vwap),
            ema9: this.roundTo(emaShort),
            ema21: this.roundTo(emaLong),
            rsi5: this.roundTo(rsi5),
            rsi14: this.roundTo(rsi14),
            opening_range_high: this.roundTo(openingRangeHigh),
            opening_range_low: this.roundTo(openingRangeLow),
            previous_day_high: this.roundTo(previousDayHigh),
            previous_day_low: this.roundTo(previousDayLow),
            overnight_high: this.roundTo(overnightHigh),
            overnight_low: this.roundTo(overnightLow),
            atr14: this.roundTo(atr14),
            latest_candle: latestCandle || 'unknown',
            price_vs_vwap: currentPrice >= vwap ? 'above' : 'below',
            trend_alignment: enrichedRiskFlags.trendAlignedWithSignal ? 'aligned' : 'not_aligned'
          },
          trade_plan: {
            entry_trigger_underlying: this.roundTo(entryTrigger),
            stop_underlying: this.roundTo(stopUnderlying),
            target_underlying: this.roundTo(targetUnderlying),
            distance_to_stop: this.roundTo(Math.abs(currentPrice - stopUnderlying)),
            distance_to_target: this.roundTo(Math.abs(targetUnderlying - currentPrice))
          },
          option_contract: {
            ticker: optionDetails?.ticker || null,
            bid: this.roundTo(optionDetails?.bid),
            ask: this.roundTo(optionDetails?.ask),
            mark: this.roundTo(optionDetails?.mark ?? mark),
            spread_pct: this.roundTo(optionDetails?.spreadPct),
            volume: this.finiteNumber(optionDetails?.volume),
            open_interest: this.finiteNumber(optionDetails?.openInterest),
            using_theoretical_pricing: Boolean(optionDetails?.usingTheoreticalPricing),
            suggested_premium_stop: this.roundTo(optionDetails?.suggestedStopLoss),
            suggested_premium_target: this.roundTo(optionDetails?.suggestedTakeProfit)
          },
          market_structure: marketStructure || {},
          market_context: {
            vix: this.roundTo(marketContext?.vix),
            vix_change_pct: this.roundTo(marketContext?.vixChangePct),
            us_10y_yield: this.roundTo(marketContext?.tenYearYield, 3),
            us_10y_change_pct: this.roundTo(marketContext?.tenYearChangePct),
            us_10y_change_bps: this.roundTo(marketContext?.tenYearChangeBps, 1),
            dxy: {
              symbol: marketContext?.dxy?.symbol || null,
              value: this.roundTo(marketContext?.dxy?.value),
              change_pct: this.roundTo(marketContext?.dxy?.changePct)
            },
            oil: {
              symbol: marketContext?.oil?.symbol || null,
              value: this.roundTo(marketContext?.oil?.value),
              change_pct: this.roundTo(marketContext?.oil?.changePct)
            },
            gold: {
              symbol: marketContext?.gold?.symbol || null,
              value: this.roundTo(marketContext?.gold?.value),
              change_pct: this.roundTo(marketContext?.gold?.changePct)
            },
            macro_regime: marketContext?.macroRegime ? {
              regime: marketContext.macroRegime.regime,
              score: marketContext.macroRegime.score,
              direction_bias: marketContext.macroRegime.directionBias,
              confidence_adjustment: marketContext.macroRegime.confidenceAdjustment,
              threshold_adjustment: marketContext.macroRegime.thresholdAdjustment,
              warnings: marketContext.macroRegime.warnings || [],
              contributors: marketContext.macroRegime.contributors || []
            } : null,
            macro_news_verdict: macroVerdict,
            macro_news_rationale: macroRationale,
            economic_calendar: getEconomicCalendarContext(nyDateStr)
          },
          internals: internals || {},
          risk_flags: enrichedRiskFlags,
          allowed_levels: {
            tp1_candidates: [
              openingRangeHigh,
              openingRangeLow,
              previousDayHigh,
              previousDayLow,
              overnightHigh,
              overnightLow,
              vwap,
              marketStructure?.flipStrike,
              marketStructure?.callWall,
              marketStructure?.putWall,
              marketStructure?.floor,
              marketStructure?.ceiling,
              marketStructure?.kingNode
            ].map((value) => this.roundTo(value)).filter((value) => value !== null),
            tp2_default_underlying: this.roundTo(targetUnderlying),
            out_default_underlying: this.roundTo(stopUnderlying),
            option_stop_default: this.roundTo(optionDetails?.suggestedStopLoss),
            option_target_default: this.roundTo(optionDetails?.suggestedTakeProfit)
          }
        };

        const coachPrompt = `You are a 0DTE options trade-management judge.

Return one actionable management plan for this A/A+ setup.

No neutral answer is allowed.

Modes:
- HOLD_FOR_TP2 = setup quality supports holding for TP2 while OUT remains valid.
- BOOK_GREEN_FAST = setup is valid, but risk is high enough that profit should be taken quickly.

Use a Bull/Bear/Judge process:
1. BULL CASE: strongest evidence for holding.
2. BEAR CASE: strongest evidence for booking profit fast.
3. JUDGE: choose exactly one mode and produce TP1, TP2, and OUT.

Rules:
- Use only levels present in SCANNER_DATA.allowed_levels or trade_plan. Do not invent unrelated prices.
- TP1 must be the nearest meaningful level in the trade direction.
- TP2 must be the scanner target or the next major structural/GEX level from allowed_levels.
- OUT must be the scanner stop, VWAP failure, or option bid losing breakeven/protection.
- Distinguish underlying levels from option bid levels.
- Never use overconfident language like guaranteed, safe without conditions, or certain.
- If data is missing, treat it as uncertainty; for 0DTE uncertainty favors BOOK_GREEN_FAST.
- Keep each action under 22 words.
- Return valid JSON only.

SCANNER_DATA:
${JSON.stringify(scannerData, null, 2)}

Return exactly this JSON shape:
{
  "bull_case": "one sentence",
  "bear_case": "one sentence",
  "mode": "HOLD_FOR_TP2|BOOK_GREEN_FAST",
  "tp1": {"underlying": 0, "option_bid": 0, "action": "one sentence"},
  "tp2": {"underlying": 0, "option_bid": 0, "action": "one sentence"},
  "out": {"underlying": 0, "option_bid": 0, "action": "one sentence"},
  "reason": "one sentence"
}`;

        try {
          const sonnetRes = await this.aiService.askTradingJSON(coachPrompt, userId, 1000);
          const plan = this.normalizeTradePlan(sonnetRes, fallbackPlan);
          finalCommentary = this.formatTradePlanCommentary(plan);
          finalDiscordContent = this.formatDiscordTradePlan(symbol, signalId, plan, macroVerdict);
          finalVerdict = 'GO';
          claudeUsage = sonnetRes.usage || null;
          await redis.set(
            commentaryCacheKey,
            JSON.stringify({ verdict: finalVerdict, analysis: finalCommentary, discordContent: finalDiscordContent, plan }),
            1800
          );
          this.fastify.log.info(`[SignalScannerService] AI trade plan ready for signal #${signalId}: ${plan.mode} | Tokens: ${sonnetRes.usage?.total_tokens || 0}`);
        } catch (sonnetErr: any) {
          this.fastify.log.error(`[SignalScannerService] AI trade-plan judge failed for #${signalId}: ${sonnetErr.message}`);
          const plan = fallbackPlan;
          finalCommentary = this.formatTradePlanCommentary(plan);
          finalDiscordContent = this.formatDiscordTradePlan(symbol, signalId, plan, macroVerdict);
          finalVerdict = 'GO';
        }
      } else {
        const coachPrompt = `You are an expert 0DTE options coach at StockSurfer Capital. Analyze this signal and produce a one-sentence recommendation for a novice trader.

SIGNAL: ${symbol} ${winningSide} $${chosenStrike}
SIGNAL TIME: ${formattedTimeStr} (Date: ${nyDateStr})
Price $${currentPrice.toFixed(2)} | VWAP $${vwap.toFixed(2)} | EMA9 ${emaShort?.toFixed(2)} | EMA21 ${emaLong?.toFixed(2)}
GEX Regime: ${qqqGexRegime} | Flow: ${qqqFlowDirection}
Entry >$${entryTrigger} | SL $${stopUnderlying} | TP $${targetUnderlying}
Score: ${finalConfidence}% | ${setupGrade}

ECONOMIC CALENDAR:
${getEconomicCalendarContext(nyDateStr)}

MACRO CONTEXT (classified by configured AI model):
${macroBadge}

RECENT HEADLINES:
${headlines.length > 0 ? headlines.map((h, i) => `${i + 1}. ${h}`).join('\n') : 'None in last 6h.'}

Write a single-sentence recommendation (maximum 25 words) advising whether the trader should HOLD (for a bounce/target), SELL (to take profit or cut loss), or WAIT/ABORT under specific technical conditions. Keep it clear, concise, and direct.

Respond JSON: {"verdict":"GO|WAIT|ABORT","analysis":"your single-sentence recommendation here"}`;

        try {
          const sonnetRes = await this.aiService.askTradingJSON(coachPrompt, userId, 800);
          finalCommentary = sonnetRes.analysis || sonnetRes.verdict || '';
          finalVerdict = sonnetRes.verdict || 'WAIT';
          claudeUsage = sonnetRes.usage || null;
          if (finalCommentary) {
            await redis.set(
              commentaryCacheKey,
              JSON.stringify({ verdict: finalVerdict, analysis: finalCommentary }),
              1800
            );
          }
          this.fastify.log.info(`[SignalScannerService] AI coaching ready for signal #${signalId}: ${finalVerdict} | Tokens: ${sonnetRes.usage?.total_tokens || 0}`);
        } catch (sonnetErr: any) {
          this.fastify.log.error(`[SignalScannerService] AI coach failed for #${signalId}: ${sonnetErr.message}`);
        }
      }
    } else {
      this.fastify.log.info(`[SignalScannerService] Reusing cached coaching commentary for signal #${signalId}`);
    }

    // ── Write back to DB ──────────────────────────────────────────────────────
    try {
      const tokenUsage = {
        classifier: llamaUsage,
        coach: claudeUsage
      };
      await this.fastify.pg.query(
        `UPDATE signals SET news_context = $1, ai_coach_commentary = $2, token_usage = $3 WHERE id = $4`,
        [newsContextText || null, finalCommentary || null, JSON.stringify(tokenUsage), signalId]
      );
      this.fastify.log.info(`[SignalScannerService] Signal #${signalId} enriched with AI commentary. Token usage tracked.`);

      // ── Broker Auto-Trade Execution (AI-Confirmed Entry, post-AI) ──
      const autoTradeMode = settings.alpaca_auto_trade_mode || 'instant';
      if (finalVerdict === 'GO' && this.isAutoExecutionEnabled(settings) && autoTradeMode === 'ai_confirmed') {
        await this.executeSignalForEligibleUsers({
          userId,
          signalId,
          symbol,
          winningSide: winningSide as 'CALL' | 'PUT',
          chosenStrike,
          chosenExpiry,
          stopUnderlying,
          targetUnderlying,
          mark,
          settings,
          autoTradeMode: 'ai_confirmed'
        });
      }

      // Broadcast signal update via WebSocket
      if (this.fastify.websocketServer) {
        this.fastify.websocketServer.clients.forEach((client: any) => {
          if (client.readyState === 1) {
            client.send(JSON.stringify({ type: 'SIGNAL_UPDATED', data: { id: signalId, symbol } }));
          }
        });
      }
    } catch (dbErr: any) {
      this.fastify.log.error(`[SignalScannerService] DB update failed for signal #${signalId}: ${dbErr.message}`);
    }

    // ── Discord follow-up: post AI coaching as a second message ──────────────
    if (settings.discord_alerts_enabled === 'true' && settings.discord_webhook_url && finalCommentary) {
      try {
        const macroIcon = macroVerdict === 'RISK_OFF' ? '⚠️' : macroVerdict === 'RISK_ON' ? '✅' : 'ℹ️';
        await axios.post(settings.discord_webhook_url, {
          content: finalDiscordContent || `🧠 **AI Coach · ${symbol} #${signalId}** ${macroIcon} Macro: ${macroVerdict}\n\n${finalCommentary}`
        }, { timeout: 8000 });
      } catch (discErr: any) {
        this.fastify.log.error(`[SignalScannerService] Discord coaching follow-up failed: ${discErr.message}`);
      }
    }
  }

  // ── News Context Helpers ──────────────────────────────────────────────────


  /**
   * Dual-source news fetcher (both free, no API keys required):
   *   Source 1 — Yahoo Finance search: ticker-specific news (QQQ/SPY/etc)
   *   Source 2 — FinancialJuice RSS:   macro/geopolitical market-moving headlines
   *
   * Returns caveman-compressed headlines for the AI prompt and raw text for display.
   */
  private async fetchNewsContext(symbol: string): Promise<{ headlines: string[]; raw: string }> {
    const now = Date.now();
    const sixHoursAgo = now - 6 * 60 * 60 * 1000;

    const compressed: string[] = [];
    const rawLines: string[] = [];

    // ── Source 1: Yahoo Finance (ticker-specific) ──────────────────────────
    try {
      const result = await (yahooFinance as any).search(symbol, { newsCount: 12 });
      const articles = (result.news || []).filter((n: any) => {
        const isRecent = (n.providerPublishTime * 1000) >= sixHoursAgo;
        const upperSymbol = symbol.toUpperCase();
        const isRelevant =
          (n.relatedTickers || []).some((t: string) =>
            ['SPY', 'QQQ', upperSymbol].includes(t.toUpperCase())
          ) || (n.title || '').toLowerCase().includes(symbol.toLowerCase());
        return isRecent && isRelevant;
      });

      // Rank Yahoo articles by keyword importance score, then by time (newest first)
      const scoredArticles = articles
        .map((n: any) => ({
          article: n,
          score: this.getHeadlineScore(n.title || '')
        }))
        .sort((a: any, b: any) => {
          if (b.score !== a.score) {
            return b.score - a.score;
          }
          return b.article.providerPublishTime - a.article.providerPublishTime;
        })
        .slice(0, 3)
        .map((x: any) => x.article);

      for (const n of scoredArticles) {
        const minsAgo = Math.round((now - n.providerPublishTime * 1000) / 60000);
        const c = this.compressHeadline(n.title || '');
        compressed.push(`${c} (Yahoo/${n.publisher}, ${minsAgo}m ago)`);
        rawLines.push(`• [${symbol}] "${n.title}" — ${n.publisher}, ${minsAgo}m ago`);
      }
    } catch (err: any) {
      this.fastify.log.warn(`[SignalScannerService] Yahoo news fetch failed for ${symbol}: ${err.message}`);
    }

    // ── Source 2: FinancialJuice RSS (macro/geopolitical headlines) ────────
    // Free public RSS feed — no API key, no registration required.
    // Parses the XML with a lightweight regex to avoid adding an npm dependency.
    try {
      const redisCacheKey = 'CACHE:FINANCIAL_JUICE_XML';
      let xml = await redis.get(redisCacheKey);

      if (!xml) {
        this.fastify.log.info('[SignalScannerService] Fetching fresh FinancialJuice RSS XML from server...');
        const fjRes = await axios.get(
          'https://www.financialjuice.com/feed.ashx?action=main&culture=en-US&pager=0&format=json',
          { timeout: 5000, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' } }
        );
        xml = String(fjRes.data);
        await redis.set(redisCacheKey, xml, 180); // cache for 180s (3 minutes)
      } else {
        this.fastify.log.info('[SignalScannerService] Using cached FinancialJuice RSS XML.');
      }

      // Extract all <item> blocks then pull <title> and <pubDate>
      const itemMatches = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];

      const macroKeywords = /fed|fomc|rates?|cpi|pce|gdp|jobs|payroll|inflation|tariff|recession|bank|treasury|yields?|nasdaq|s&p|market|economy|trade|war|escalat|geopolit|china|russia|iran|oil|energy|crash|rally|selloff|rout|powell|yellen|fiscal|deficit|debt|middle east|bomber|military|strait|hormuz/i;

      const candidates: Array<{ title: string; pubDate: Date; minsAgo: number; score: number }> = [];

      for (const item of itemMatches) {
        const titleMatch = item.match(/<title>([\s\S]*?)<\/title>/);
        const dateMatch  = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
        if (!titleMatch || !dateMatch) continue;

        // Strip "FinancialJuice: " prefix and CDATA if present
        const rawTitle = titleMatch[1]
          .replace(/<!\[CDATA\[|\]\]>/g, '')
          .replace(/^FinancialJuice:\s*/i, '')
          .trim();

        const pubDate = new Date(dateMatch[1].trim());
        if (isNaN(pubDate.getTime()) || pubDate.getTime() < sixHoursAgo) continue;
        if (!macroKeywords.test(rawTitle)) continue; // only market-moving macro headlines

        const minsAgo = Math.round((now - pubDate.getTime()) / 60000);
        const score = this.getHeadlineScore(rawTitle);

        candidates.push({
          title: rawTitle,
          pubDate,
          minsAgo,
          score
        });
      }

      // Sort candidates by score descending, then by pubDate descending (newest first)
      const topMacro = candidates
        .sort((a, b) => {
          if (b.score !== a.score) {
            return b.score - a.score;
          }
          return b.pubDate.getTime() - a.pubDate.getTime();
        })
        .slice(0, 3);

      for (const item of topMacro) {
        const c = this.compressHeadline(item.title);
        compressed.push(`[MACRO] ${c} (FinancialJuice, ${item.minsAgo}m ago)`);
        rawLines.push(`• [MACRO] "${item.title}" — FinancialJuice, ${item.minsAgo}m ago`);
      }
    } catch (err: any) {
      this.fastify.log.warn(`[SignalScannerService] FinancialJuice fetch failed: ${err.message}`);
    }

    if (compressed.length === 0) {
      return { headlines: [], raw: 'No material news in the last 6 hours.' };
    }

    return { headlines: compressed, raw: rawLines.join('\n') };
  }

  /**
   * Assigns an importance score to a news headline based on critical financial/macro/geopolitical keywords.
   */
  private getHeadlineScore(title: string): number {
    const t = title.toLowerCase();
    let score = 0;

    // High Impact Macro (Tier 1): Federal Reserve, CPI/PCE inflation, Job payrolls
    if (/\b(cpi|pce|inflation|fomc|fed\b|federal reserve|interest rates?|rate hikes?|rate cuts?|payrolls?|nfp|gdp|recession)\b/i.test(t)) {
      score += 10;
    }

    // Medium Impact Macro / Major Geopolitics (Tier 2): Wars, oil shocks, tariffs, central bank decisions
    if (/\b(war\b|geopolitical|missiles?|attacks?|clashes?|tariffs?|trade war|yields?|treasuries|oil prices?|crude\b|escalat|china\b|russia\b|iran\b|nuclear|sanctions?|middle east|bomber|military|strait|hormuz)\b/i.test(t)) {
      score += 5;
    }

    // Market specific (Tier 3): Nasdaq, S&P 500, crash, rally, earnings, downgrade, upgrade
    if (/\b(nasdaq|s&p|dow jones|crash|panic|selloff|rout|rally|earnings|guidance|upgrade|downgrade)\b/i.test(t)) {
      score += 3;
    }

    return score;
  }

  /**
   * Strip high-frequency filler words from a news headline to cut input tokens ~40%.
   * Inspired by the caveman-style compression already used in ai-service.ts.
   */
  private compressHeadline(title: string): string {
    const fillers = /\b(the|a|an|and|of|to|for|with|on|in|at|by|as|after|about|from|into|over|through|is|are|was|were|be|been|being|its|their|has|have|had|will|would|could|should|may|might|that|this|these|those|which|who|what|how|when|where|but|or|nor|so|yet|both|either|neither|just|very|also|then|than|if|not|no|all|more|most|some|any|each|every|due|amid|says|said|per|via)\b/gi;
    return title
      .replace(fillers, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, 90); // hard cap — headlines rarely need more than 90 chars compressed
  }

  /**
   * Compute a short MD5 fingerprint of the compressed headlines array.
   * Used to detect when news has actually changed between 5-min scan cycles.
   */
  private getNewsFingerprint(headlines: string[]): string {
    const joined = headlines.sort().join('|');
    return crypto.createHash('md5').update(joined).digest('hex').slice(0, 12);
  }

  // Latency Healthcheck Evaluator
  public async runHealthCheck(userId: number): Promise<any> {
    let targetUserId = userId;
    let settings = await this.getSettingsForUser(targetUserId);

    // If the logged-in user hasn't configured signal keys, try using the primary user settings.
    if (!settings.thetadata_base_url && !settings.sscgex_password) {
      const primaryId = await this.getPrimaryUserId();
      if (primaryId !== userId) {
        const primarySettings = await this.getSettingsForUser(primaryId);
        if (primarySettings.thetadata_base_url || primarySettings.sscgex_password) {
          targetUserId = primaryId;
          settings = primarySettings;
        }
      }
    }

    const checkLatency = async (
      fn: () => Promise<void>,
      isConfigured = true,
      endpoint?: string
    ): Promise<{ status: string; latencyMs: number; endpoint?: string; lastError: string | null; checkedAt: string }> => {
      const checkedAt = new Date().toISOString();
      if (!isConfigured) {
        return { status: 'N/A', latencyMs: 0, endpoint, lastError: 'Not configured', checkedAt };
      }
      const start = Date.now();
      try {
        await fn();
        return { status: 'UP', latencyMs: Date.now() - start, endpoint, lastError: null, checkedAt };
      } catch (e) {
        const err: any = e;
        return {
          status: 'DOWN',
          latencyMs: Date.now() - start,
          endpoint,
          lastError: err?.response?.data?.error || err?.response?.statusText || err?.message || String(e),
          checkedAt
        };
      }
    };

    const yahooCheck = checkLatency(async () => {
      await (yahooFinance as any).quote('QQQ');
    }, true, 'yahooFinance.quote(QQQ)');

    const sscgexCheck = checkLatency(async () => {
      const tokenRes = await axios.post('https://sscgex.up.railway.app/api/auth', {
        password: settings.sscgex_password
      }, { timeout: 4000 });
      const token = (tokenRes.data as any).token;
      await axios.get('https://sscgex.up.railway.app/api/gex/QQQ?strikes=10', {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 4000
      });
    }, !!settings.sscgex_password, 'https://sscgex.up.railway.app/api/gex/QQQ?strikes=10');

    const thetaDataCheck = checkLatency(async () => {
      const thetaData = new ThetaDataService(this.fastify);
      const health = await thetaData.getHealth(targetUserId);
      if (!health.connected) throw new Error(health.lastError || 'ThetaData unavailable');
    }, !!settings.thetadata_base_url || !!process.env.THETADATA_BASE_URL, `${settings.thetadata_base_url || process.env.THETADATA_BASE_URL || 'http://127.0.0.1:25503'}/v3/terminal/mdds/status`);

    const openrouterCheck = checkLatency(async () => {
      const aiSettings = await this.aiService.getSettings(targetUserId);
      if (aiSettings.ai_provider === 'openrouter' && aiSettings.openrouter_key) {
        await axios.get('https://openrouter.ai/api/v1/models', {
          headers: { Authorization: `Bearer ${aiSettings.openrouter_key}` },
          timeout: 4000
        });
      } else if (aiSettings.ai_provider === 'ollama') {
        await this.aiService.checkHealth(targetUserId);
      } else {
        throw new Error('No AI provider key configured');
      }
    }, settings.day_trading_ai_enabled === 'true', 'https://openrouter.ai/api/v1/models');

    const discordCheck = checkLatency(async () => {
      await axios.get(settings.discord_webhook_url, { timeout: 4000 });
    }, !!settings.discord_webhook_url, settings.discord_webhook_url ? 'configured Discord webhook URL' : undefined);

    const [yahoo, sscgex, thetaData, openrouter, discord] = await Promise.all([
      yahooCheck,
      sscgexCheck,
      thetaDataCheck,
      openrouterCheck,
      discordCheck
    ]);

    return {
      yahooFinance: yahoo,
      sscgexPortal: sscgex,
      thetaData,
      openRouter: openrouter,
      discord: discord
    };
  }

  // --- Utility functions ---
  private toNumber(val: any): number | null {
    const parsed = Number.parseFloat(val);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private parseTimeStr(timeStr: string): number {
    const [h, m] = String(timeStr).split(':').map(part => parseInt(part, 10));
    return h * 60 + m;
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

  private getTargetDayTradeExpiry(nyDateStr: string, nyMinutes: number): string {
    const onePmMinutes = 13 * 60;
    if (nyMinutes < onePmMinutes) return nyDateStr;

    const [year, month, day] = nyDateStr.split('-').map((value) => parseInt(value, 10));
    const expiryDate = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));

    do {
      expiryDate.setUTCDate(expiryDate.getUTCDate() + 1);
    } while (expiryDate.getUTCDay() === 0 || expiryDate.getUTCDay() === 6);

    return expiryDate.toISOString().split('T')[0];
  }

  private computeRsi(values: number[], length: number): number | null {
    if (values.length <= length) return null;
    let gains = 0;
    let losses = 0;
    for (let i = values.length - length; i < values.length; i++) {
      const delta = values[i] - values[i - 1];
      if (delta >= 0) gains += delta;
      else losses += Math.abs(delta);
    }
    if (losses === 0) return 100;
    const avgGain = gains / length;
    const avgLoss = losses / length;
    return 100 - 100 / (1 + avgGain / avgLoss);
  }

  private computeEma(values: number[], length: number): number | null {
    if (values.length < length) return null;
    const k = 2 / (length + 1);
    let ema = values.slice(0, length).reduce((sum, val) => sum + val, 0) / length;
    for (let i = length; i < values.length; i++) {
      ema = values[i] * k + ema * (1 - k);
    }
    return ema;
  }

  private computeAtr(candles: any[], length: number): number | null {
    if (candles.length <= length) return null;
    let trSum = 0;
    for (let i = candles.length - length; i < candles.length; i++) {
      const high = candles[i].high;
      const low = candles[i].low;
      const prevClose = candles[i - 1].close;
      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      trSum += tr;
    }
    return trSum / length;
  }

  private async getCachedNewsGuardrail(symbol: string, nyDateStr: string, winningSide: 'CALL' | 'PUT') {
    const cachedVerdict = await redis.get(`NEWS_VERDICT:${symbol}:${nyDateStr}`);
    if (!cachedVerdict) {
      return {
        status: 'UNAVAILABLE',
        verdict: 'UNKNOWN',
        rationale: 'No cached AI news guardrail is available yet.',
        freshness: 'unavailable',
        suggestion: 'MANUAL REVIEW'
      };
    }

    try {
      const parsed = JSON.parse(cachedVerdict);
      const verdict = parsed.verdict || 'NEUTRAL';
      const rationale = parsed.rationale || 'No rationale provided.';
      const generatedAt = parsed.generatedAt ? new Date(parsed.generatedAt) : null;
      const ageSeconds = generatedAt ? Math.floor((Date.now() - generatedAt.getTime()) / 1000) : null;
      const isStale = ageSeconds === null || ageSeconds > 5 * 60;

      if (isStale) {
        return {
          status: 'STALE',
          verdict,
          rationale,
          freshness: ageSeconds === null ? 'unknown age' : `${Math.floor(ageSeconds / 60)}m old`,
          suggestion: 'MANUAL REVIEW'
        };
      }

      const opposingRisk = (winningSide === 'CALL' && verdict === 'RISK_OFF') || (winningSide === 'PUT' && verdict === 'RISK_ON');
      const supportingContext = (winningSide === 'CALL' && verdict === 'RISK_ON') || (winningSide === 'PUT' && verdict === 'RISK_OFF');
      const status = opposingRisk ? 'HIGH RISK' : supportingContext || verdict === 'NEUTRAL' ? 'CLEAR' : 'CAUTION';
      const suggestion = status === 'HIGH RISK'
        ? 'REVIEW / REDUCE SIZE'
        : status === 'CLEAR'
          ? 'HOLD PLAN'
          : 'WAIT FOR CONFIRMATION';

      return {
        status,
        verdict,
        rationale,
        freshness: `${ageSeconds}s old`,
        suggestion
      };
    } catch (err: any) {
      return {
        status: 'UNAVAILABLE',
        verdict: 'UNKNOWN',
        rationale: `Could not parse cached AI news guardrail: ${err.message}`,
        freshness: 'unavailable',
        suggestion: 'MANUAL REVIEW'
      };
    }
  }

  private isAutoExecutionEnabled(settings: any): boolean {
    const broker = settings.execution_broker || 'none';
    if (broker === 'wealthsimple_snaptrade') return settings.snaptrade_auto_trade === 'true';
    return settings.snaptrade_auto_trade === 'true';
  }

  private async getAutoExecutionTargets(primaryUserId: number, symbol: string, autoTradeMode: 'instant' | 'ai_confirmed') {
    const { rows } = await this.fastify.pg.query(
      `SELECT id AS user_id
       FROM users
       ORDER BY id ASC`
    );

    const userIds = [...new Set([primaryUserId, ...rows.map((row: any) => Number(row.user_id)).filter(Boolean)])];
    const targets: Array<{ userId: number; settings: any }> = [];

    for (const targetUserId of userIds) {
      const targetSettings = await this.getSettingsForUser(targetUserId);
      if (targetSettings.day_trading_enabled !== 'true') continue;
      if (!this.isAutoExecutionEnabled(targetSettings)) continue;
      if ((targetSettings.alpaca_auto_trade_mode || 'instant') !== autoTradeMode) continue;

      const symbols = String(targetSettings.day_trading_symbols || '')
        .split(',')
        .map((value: string) => value.trim().toUpperCase())
        .filter(Boolean);
      if (symbols.length > 0 && !symbols.includes(symbol)) continue;

      targets.push({ userId: targetUserId, settings: targetSettings });
    }

    return targets;
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

  private async executeSignalForEligibleUsers(input: {
    userId: number;
    signalId: number;
    symbol: string;
    winningSide: 'CALL' | 'PUT';
    chosenStrike: number;
    chosenExpiry: string;
    stopUnderlying: number;
    targetUnderlying: number;
    mark: number | null;
    settings: any;
    autoTradeMode: 'instant' | 'ai_confirmed';
  }) {
    const targets = await this.getAutoExecutionTargets(input.userId, input.symbol, input.autoTradeMode);
    if (targets.length === 0) return;

    for (const target of targets) {
      try {
        await this.executeSignalWithConfiguredBroker({
          userId: target.userId,
          signalId: input.signalId,
          symbol: input.symbol,
          winningSide: input.winningSide,
          chosenStrike: input.chosenStrike,
          chosenExpiry: input.chosenExpiry,
          stopUnderlying: input.stopUnderlying,
          targetUnderlying: input.targetUnderlying,
          mark: input.mark,
          settings: target.settings
        });
      } catch (err: any) {
        this.fastify.log.error(`[SignalScannerService] Auto-execution failed for signal #${input.signalId}, user ${target.userId}: ${err.message}`);
      }
    }
  }

  public async executeSignalForUser(userId: number, signalId: number) {
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
    const currentPrice = Number(signal.current_price);
    const winningSide = signal.signal_type === 'PUT' ? 'PUT' : 'CALL';
    return this.executeSignalWithConfiguredBroker({
      userId,
      signalId,
      symbol: signal.symbol,
      winningSide,
      chosenStrike: Number(optionDetails.strike || Math.round(currentPrice)),
      chosenExpiry: optionDetails.expiry || signal.option_expiration_date || new Date().toISOString().split('T')[0],
      stopUnderlying: Number(signal.stop_loss || currentPrice * 0.99),
      targetUnderlying: Number(signal.target_price || currentPrice * 1.01),
      mark: optionDetails.mark != null ? Number(optionDetails.mark) : null
    });
  }

  private constructOSITicker(symbol: string, strike: number, type: 'CALL' | 'PUT', expiration: string | Date): string {
    let dateStr = '';
    if (expiration instanceof Date) {
      const year = expiration.getFullYear();
      const month = (expiration.getMonth() + 1).toString().padStart(2, '0');
      const day = expiration.getDate().toString().padStart(2, '0');
      dateStr = `${year}-${month}-${day}`;
    } else {
      dateStr = expiration.split('T')[0];
    }

    const parts = dateStr.split('-');
    if (parts.length !== 3) {
      return `${symbol.toUpperCase()}XXXXXX${type === 'CALL' ? 'C' : 'P'}${Math.round(strike * 1000).toString().padStart(8, '0')}`;
    }

    const YY = parts[0].slice(-2);
    const MM = parts[1].padStart(2, '0');
    const DD = parts[2].padStart(2, '0');
    const side = type === 'CALL' ? 'C' : 'P';
    const strikeFormatted = Math.round(strike * 1000).toString().padStart(8, '0');

    return `${symbol.toUpperCase()}${YY}${MM}${DD}${side}${strikeFormatted}`;
  }
}
