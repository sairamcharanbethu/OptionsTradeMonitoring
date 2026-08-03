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
import { TradeRedisService } from './trade-redis-service';
import { getSettingsWithGlobalFallback } from '../lib/settings-utils';
import { IbkrMarketDataService, IbkrOptionChainQuote, IbkrOptionQuote } from './ibkr-market-data-service';
import { SignalDecision, SignalGradeDiagnostics, tradingEventBus } from '../lib/trading-events';
import { normalizeAdapterHealth } from '../lib/adapter-health';
import { getNewYorkMarketState } from '../lib/market-calendar';
import { getIbkrGatewayConfig } from '../lib/ibkr-config';

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

type VolumeAnomaly = {
  confirmed: boolean;
  sampleSize: number;
  sma: number | null;
  stdev: number | null;
  threshold: number | null;
  triggerVolume: number;
};

type CandleSource = 'ibkr' | 'yahoo';

type CandleFetchResult = {
  candles: Candle[];
  source: CandleSource;
  fetchedAt: string;
  fallbackReason: string | null;
};

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

type OptionChainQuote = IbkrOptionChainQuote;

type OptionChainCacheEntry = {
  fetchedAt: number;
  chain: OptionChainQuote[];
};

type TriggerWatchState = {
  userId: number;
  signalId: number;
  symbol: string;
  winningSide: 'CALL' | 'PUT';
  tradeBias: string;
  chosenStrike: number;
  chosenExpiry: string;
  optionTicker: string | null;
  entryTrigger: number;
  stopUnderlying: number;
  targetUnderlying: number;
  mark: number | null;
  settings: any;
  autoTradeMode: 'instant' | 'ai_confirmed';
  startedAtMs: number;
  expiresAtMs: number;
  armedAtMs: number | null;
  armedPrice: number | null;
};

type ScannerNyDateParts = {
  year: string;
  month: string;
  day: string;
  hour: number;
  minute: number;
  minutes: number;
  dateStr: string;
  marketDate: string;
};

type ScannerMarketPhase = 'PRE_MARKET' | 'OPEN' | 'AFTER_CUTOFF' | 'CLOSED';

type ScannerCycleContext = {
  cycleId: string;
  userId: number;
  symbols: string[];
  startedAt: string;
  startedAtDate: Date;
  nyParts: ScannerNyDateParts;
  marketPhase: ScannerMarketPhase;
  force: boolean;
  phaseTimingsMs: Record<string, number>;
};

type OptionQuoteCandidate = OptionContractCandidate & {
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
  quoteAgeMs?: number | null;
  markLastDivergencePct?: number | null;
  failedFilters: string[];
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
  private isRunning: boolean = false;
  private timerId: NodeJS.Timeout | null = null;
  private newsWarmTimerId: NodeJS.Timeout | null = null;
  private scanIntervalMs: number = 5 * 60 * 1000; // 5 minutes
  private lastScanSkippedReason: string | null = null;
  private lastScanAt: string | null = null;
  private liveMacroSnapshot: LiveMacroSnapshot | null = null;
  private liveMacroSnapshotFetchedAt = 0;
  private optionChainCache = new Map<string, OptionChainCacheEntry>();
  private readonly optionChainCacheTtlMs = Number(process.env.OPTION_CHAIN_CACHE_TTL_MS || 15_000);
  private triggerWatchers = new Map<number, NodeJS.Timeout>();

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
    for (const timer of this.triggerWatchers.values()) {
      clearTimeout(timer);
    }
    this.triggerWatchers.clear();
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
    // Use the first user because signal-critical runtime settings are global.
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
    const marketState = getNewYorkMarketState(now, startMinutes, cutoffMinutes);

    return {
      isOpen: marketState.isOpen,
      isWeekday: marketState.isWeekday,
      nowLabel: `${String(nyParts.hour).padStart(2, '0')}:${String(nyParts.minute).padStart(2, '0')}`,
      startTime,
      cutoffTime
    };
  }

  private getScannerMarketPhase(input: {
    settings: any;
    now: Date;
    nyParts: ScannerNyDateParts;
  }): ScannerMarketPhase {
    const startMinutes = this.parseTimeToMinutes(input.settings.trading_start_time, '09:30');
    const cutoffMinutes = this.parseTimeToMinutes(input.settings.trading_cutoff_time, '16:00');
    const weekday = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short'
    }).format(input.now);
    if (weekday === 'Sat' || weekday === 'Sun') return 'CLOSED';
    if (input.nyParts.minutes < startMinutes) return 'PRE_MARKET';
    if (input.nyParts.minutes >= cutoffMinutes) return 'AFTER_CUTOFF';
    return 'OPEN';
  }

  private getDirectionalDecision(callScore: number, putScore: number, minimumEdge = 5): {
    leader: 'CALL' | 'PUT';
    side: 'CALL' | 'PUT' | 'NONE';
    edge: number;
    minimumEdge: number;
    hasEdge: boolean;
  } {
    const safeCallScore = Number.isFinite(callScore) ? callScore : 0;
    const safePutScore = Number.isFinite(putScore) ? putScore : 0;
    const safeMinimumEdge = Number.isFinite(minimumEdge) && minimumEdge >= 0 ? minimumEdge : 5;
    const leader: 'CALL' | 'PUT' = safeCallScore > safePutScore ? 'CALL' : 'PUT';
    const edge = Math.abs(safeCallScore - safePutScore);
    const hasEdge = edge >= safeMinimumEdge;
    return {
      leader,
      side: hasEdge ? leader : 'NONE',
      edge,
      minimumEdge: safeMinimumEdge,
      hasEdge
    };
  }

  private getMarketPhaseBlocker(marketPhase: ScannerMarketPhase, settings: any): string | null {
    if (marketPhase === 'PRE_MARKET') return `Before trade start time ${settings.trading_start_time} ET`;
    if (marketPhase === 'AFTER_CUTOFF') return `After trade cutoff ${settings.trading_cutoff_time} ET`;
    if (marketPhase === 'CLOSED') return 'Market closed — no live 0DTE entries outside regular trading hours';
    return null;
  }

  private buildScannerCycleContext(input: {
    userId: number;
    symbols: string[];
    settings: any;
    force?: boolean;
    now?: Date;
  }): ScannerCycleContext {
    const startedAtDate = input.now || new Date();
    const nyParts = this.getNyDateParts(startedAtDate);
    return {
      cycleId: crypto.randomUUID(),
      userId: input.userId,
      symbols: [...input.symbols],
      startedAt: startedAtDate.toISOString(),
      startedAtDate,
      nyParts,
      marketPhase: this.getScannerMarketPhase({
        settings: input.settings,
        now: startedAtDate,
        nyParts
      }),
      force: Boolean(input.force),
      phaseTimingsMs: {}
    };
  }

  private getPhaseTimingsForSymbol(cycle: ScannerCycleContext, symbol?: string): Record<string, number> {
    if (!symbol) return { ...cycle.phaseTimingsMs };
    const prefix = `${symbol}.`;
    return Object.fromEntries(
      Object.entries(cycle.phaseTimingsMs)
        .filter(([phase]) => phase.startsWith(prefix))
        .map(([phase, durationMs]) => [phase.slice(prefix.length), durationMs])
    );
  }

  private getCycleSnapshot(cycle: ScannerCycleContext, symbol?: string) {
    return {
      cycleId: cycle.cycleId,
      startedAt: cycle.startedAt,
      userId: cycle.userId,
      symbols: cycle.symbols,
      marketPhase: cycle.marketPhase,
      force: cycle.force,
      phaseTimingsMs: this.getPhaseTimingsForSymbol(cycle, symbol),
      ny: {
        dateStr: cycle.nyParts.dateStr,
        marketDate: cycle.nyParts.marketDate,
        hour: cycle.nyParts.hour,
        minute: cycle.nyParts.minute,
        minutes: cycle.nyParts.minutes
      }
    };
  }

  private async timeScannerPhase<T>(cycle: ScannerCycleContext, phase: string, operation: () => Promise<T>): Promise<T> {
    const startedAtMs = Date.now();
    try {
      return await operation();
    } finally {
      cycle.phaseTimingsMs[phase] = Date.now() - startedAtMs;
    }
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

      const scanStartedAt = new Date();
      const windowState = this.getTradingWindowState(settings, scanStartedAt);
      if (!force && !windowState.isOpen) {
        this.lastScanSkippedReason = 'MARKET_CLOSED';
        this.fastify.log.info(`[SignalScannerService] Market-hours gate is closed (${windowState.nowLabel} ET, ${windowState.startTime}-${windowState.cutoffTime}). Skipping background scan.`);
        return;
      }

      try {
        const cycle = await this.scanForUser(primaryUserId, { force, now: scanStartedAt });
        this.lastScanAt = cycle?.startedAt || scanStartedAt.toISOString();
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
      max_correlated_positions: '1',
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

  private async scanForUser(userId: number, options: { force?: boolean; now?: Date } = {}): Promise<ScannerCycleContext | null> {
    const settings = await this.getSettingsForUser(userId);
    if (settings.day_trading_enabled !== 'true') return null;

    const symbols = settings.day_trading_symbols
      .split(',')
      .map((s: string) => s.trim().toUpperCase())
      .filter(Boolean);

    const cycle = this.buildScannerCycleContext({
      userId,
      symbols,
      settings,
      force: options.force,
      now: options.now
    });

    this.fastify.log.info(`[SignalScannerService] Scanning symbols: ${symbols.join(', ')} for user ${userId} cycle=${cycle.cycleId} phase=${cycle.marketPhase}`);

    for (const symbol of symbols) {
      try {
        await this.evaluateSymbol(symbol, userId, settings, cycle);
      } catch (err: any) {
        this.fastify.log.error(`[SignalScannerService] Failed to scan ${symbol} for user ${userId}: ${err.message}`);
      }
    }

    return cycle;
  }

  private async evaluateSymbol(symbol: string, userId: number, settings: any, cycle: ScannerCycleContext) {
    const now = cycle.startedAtDate;
    const nyParts = cycle.nyParts;

    // 1. Check Trading Window Blocker
    const currentMinutes = nyParts.minutes;

    const noTradeReasons: string[] = [];

    const marketPhaseBlocker = this.getMarketPhaseBlocker(cycle.marketPhase, settings);
    if (marketPhaseBlocker) noTradeReasons.push(marketPhaseBlocker);

    // The current strategy engine owns GEX evaluation. Keep the legacy scanner
    // fail-closed instead of calling the retired SSCGEX portal.
    let gexData: any = null;
    let gexAvailable = false;

    // 3. Fetch price candles. Non-IBKR fallback data is retained for diagnostics,
    // but getLiveCandleSourceBlocker below prevents it from driving live entries.
    let candleFetch: CandleFetchResult;
    try {
      candleFetch = await this.timeScannerPhase(cycle, `${symbol}.candles`, () => this.fetchScannerCandles({
        symbol,
        now
      }));
    } catch (err: any) {
      this.fastify.log.error(`[SignalScannerService] Candle fetch failed for ${symbol}: ${err.message}`);
      return;
    }

    if (!gexAvailable) {
      noTradeReasons.push('Legacy scanner GEX is retired; strategy signals are produced by the strategy engine');
    }

    let sortedCandles = candleFetch.candles;
    const rawCandleCount = sortedCandles.length;
    sortedCandles = this.getCompletedCandles(sortedCandles, now, 5);
    if (sortedCandles.length < rawCandleCount) {
      this.fastify.log.info(`[SignalScannerService] Ignoring ${rawCandleCount - sortedCandles.length} incomplete ${symbol} candle(s) before signal evaluation.`);
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

    let liveUnderlyingQuote: IbkrOptionQuote | null = null;
    let liveUnderlyingQuoteBlocker: string | null = null;
    if (cycle.marketPhase === 'OPEN') {
      try {
        const ibkr = new IbkrMarketDataService(this.fastify);
        liveUnderlyingQuote = await this.timeScannerPhase(
          cycle,
          `${symbol}.underlyingQuote`,
          async () => {
            await ibkr.assertLiveMarketData();
            return ibkr.getUnderlyingQuote(symbol);
          }
        );
        liveUnderlyingQuoteBlocker = this.getLiveUnderlyingQuoteBlocker(symbol, liveUnderlyingQuote);
      } catch (err: any) {
        liveUnderlyingQuoteBlocker = `Live IBKR spot unavailable for ${symbol}: ${err.message || String(err)}`;
        this.fastify.log.warn(`[SignalScannerService] ${liveUnderlyingQuoteBlocker}`);
      }
      if (liveUnderlyingQuoteBlocker) {
        noTradeReasons.push(liveUnderlyingQuoteBlocker);
      }
    }

    const liveUnderlyingQuoteUsable = liveUnderlyingQuote !== null && liveUnderlyingQuoteBlocker === null;
    const currentPrice = liveUnderlyingQuoteUsable ? liveUnderlyingQuote!.mark : latest.close;
    const candleFreshnessMs = this.getCandleFreshnessMs(latest, now);
    const candleFreshnessBlocker = this.getCandleFreshnessBlocker({
      source: candleFetch.source,
      freshnessMs: candleFreshnessMs
    });
    if (candleFreshnessBlocker) {
      noTradeReasons.push(candleFreshnessBlocker);
    }
    const liveCandleSourceBlocker = this.getLiveCandleSourceBlocker(candleFetch);
    if (liveCandleSourceBlocker) {
      noTradeReasons.push(liveCandleSourceBlocker);
    }

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

    // Volume Breakout Check: trigger volume must be a structural anomaly versus the prior 20 RTH candles.
    const volumeAnomaly = this.computeVolumeAnomaly(rthCandles, latest);
    const hasBullishVolumeBreakout = volumeAnomaly.confirmed && latest.close >= latest.open;
    const hasBearishVolumeBreakout = volumeAnomaly.confirmed && latest.close <= latest.open;

    const atr14 = this.computeAtr(rthCandles, 14) || 1.0;

    const previousClose = previous.close;
    const sessionChangePct = ((currentPrice - previousClose) / previousClose) * 100;
    const candleChangePct = ((latest.close - previous.close) / previous.close) * 100;

    // 4. Start live macro context fetch early; await after independent internals fetch.
    const macroSnapshotPromise = this.timeScannerPhase(
      cycle,
      `${symbol}.macro`,
      () => this.getCurrentMacroSnapshot({ forceRefresh: true, currentMinutes, now })
    );

    // 5. Fetch Mega-Cap Internals
    let bullishInternals = 0;
    let bearishInternals = 0;
    let applePct: number | null = null;
    let microsoftPct: number | null = null;
    let nvidiaPct: number | null = null;

    await this.timeScannerPhase(cycle, `${symbol}.internals`, async () => {
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
    });

    const macroSnapshot = await macroSnapshotPromise;
    const vixSnapshot = macroSnapshot.assets.vix;
    const tenYearSnapshot = macroSnapshot.assets.tenYear;
    const dxySnapshot = macroSnapshot.assets.dxy;
    const oilSnapshot = macroSnapshot.assets.oil;
    const goldSnapshot = macroSnapshot.assets.gold;
    const vixPrice = macroSnapshot.vixQuote;
    const vixChangePct = macroSnapshot.vixChangePercent;
    const tenYearYield = macroSnapshot.tenYearYield;
    const tenYearChangePct = macroSnapshot.tenYearChangePercent;
    const tenYearChangeBps = macroSnapshot.tenYearChangeBps;

    if (vixPrice === null) {
      noTradeReasons.push(vixSnapshot.error
        ? `VIX data unavailable from IBKR: ${vixSnapshot.error}`
        : 'VIX data unavailable from IBKR response');
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
      const callHoldingSupport = currentPrice >= openingRangeLow && currentPrice <= openingRangeLow * 1.002;
      const callReclaiming = latest.close > latest.open && latest.close >= previous.high;
      addScore(callScoreParts, callHoldingSupport, weights.supportResistanceHold, 'Price holding Opening Range Low support');
      addScore(callScoreParts, rsi5 <= 30, weights.rsiReversal, 'Short-term RSI is oversold (RSI5 <= 30)');
      addScore(callScoreParts, latest.close > latest.open, weights.candleReversal, 'Latest candle closed green (reversal)');
      addScore(callScoreParts, currentPrice < vwap && callHoldingSupport && callReclaiming, weights.oversoldDip, 'Price is below VWAP while holding support and reclaiming');
      addScore(callScoreParts, hasBullishInternals, weights.internals, 'Mega-Caps support reversal');
      addScore(callScoreParts, qqqGexRegime === 'POSITIVE' && qqqFlowDirection !== 'bearish', weights.flowDirection, 'Positive GEX and neutral/bullish flow');
      addScore(callScoreParts, qqqGexRegime === 'POSITIVE' && qqqKingNode !== null && qqqGexFlip !== null && currentPrice > qqqGexFlip && currentPrice < qqqKingNode, weights.gravityNode, 'Price between GEX Flip and King Node');

      // PUT
      const putRejectingResistance = currentPrice <= openingRangeHigh && currentPrice >= openingRangeHigh * 0.998;
      const putBreakingDown = latest.close < latest.open && latest.close <= previous.low;
      addScore(putScoreParts, putRejectingResistance, weights.supportResistanceHold, 'Price rejecting Opening Range High resistance');
      addScore(putScoreParts, rsi5 >= 70, weights.rsiReversal, 'Short-term RSI is overbought (RSI5 >= 70)');
      addScore(putScoreParts, latest.close < latest.open, weights.candleReversal, 'Latest candle closed red (reversal)');
      addScore(putScoreParts, currentPrice > vwap && putRejectingResistance && putBreakingDown, weights.oversoldDip, 'Price is above VWAP while rejecting resistance and breaking down');
      addScore(putScoreParts, hasBearishInternals, weights.internals, 'Mega-Caps support rejection');
      addScore(putScoreParts, qqqGexRegime === 'POSITIVE' && qqqFlowDirection !== 'bullish', weights.flowDirection, 'Positive GEX and neutral/bearish flow');
      addScore(putScoreParts, qqqGexRegime === 'POSITIVE' && qqqKingNode !== null && currentPrice > qqqKingNode, weights.gravityNode, 'Price above King Node');
    }

    const callScore = callScoreParts.reduce((sum, item) => sum + item.points, 0);
    const putScore = putScoreParts.reduce((sum, item) => sum + item.points, 0);
    const directionalDecision = this.getDirectionalDecision(callScore, putScore);
    const winningSide = directionalDecision.leader;
    const directionalSide = directionalDecision.side;
    if (!directionalDecision.hasEdge) {
      noTradeReasons.push(`No directional edge: CALL score ${callScore} vs PUT score ${putScore} (minimum edge ${directionalDecision.minimumEdge})`);
    }
    const winningScore = winningSide === 'CALL' ? callScore : putScore;
    const macroRegime = this.assessMacroRegime({
      winningSide,
      currentMinutes,
      vix: vixSnapshot,
      vix3m: macroSnapshot.assets.vix3m,
      tenYear: tenYearSnapshot,
      dxy: dxySnapshot,
      oil: oilSnapshot,
      gold: goldSnapshot
    });

    // Afternoon threshold inflation
    const dynamicMinScore = this.getDynamicMinimumScore(settings, currentMinutes, macroRegime);

    // 7. Check Volatility & Wall Blockers
    const volatilityBlockers = [];
    const maxVixForCalls = 30;
    const minVixForPuts = 13;

    if (directionalDecision.hasEdge) {
      if (winningSide === 'CALL' && vixPrice !== null && vixPrice > maxVixForCalls) {
        volatilityBlockers.push(`VIX ${vixPrice.toFixed(2)} is above call risk limit ${maxVixForCalls}`);
      }
      if (winningSide === 'PUT' && vixPrice !== null && vixPrice < minVixForPuts) {
        volatilityBlockers.push(`VIX ${vixPrice.toFixed(2)} is below put volatility floor ${minVixForPuts}`);
      }
    }

    volatilityBlockers.push(...this.buildVolatilityCompressionBlockers({
      symbol,
      currentMinutes,
      atr14,
      currentPrice,
      vixChangePct: vixSnapshot.changePct
    }));

    if (directionalDecision.hasEdge) {
      if (winningSide === 'CALL' && hasBearishInternals) {
        volatilityBlockers.push(`Mega-Caps are bearish. Avoid going long ${symbol}.`);
      }
      if (winningSide === 'PUT' && hasBullishInternals) {
        volatilityBlockers.push(`Mega-Caps are bullish. Avoid shorting ${symbol}.`);
      }
    }

    for (const blocker of macroRegime.blockers) {
      volatilityBlockers.push(blocker);
    }

    if (directionalDecision.hasEdge) {
      volatilityBlockers.push(...this.buildGexProximityBlockers({
        winningSide,
        currentPrice,
        callWall: qqqCallWall,
        putWall: qqqPutWall,
        kingNode: qqqKingNode,
        floor: qqqFloor,
        ceiling: qqqCeiling,
        regime
      }));
    }

    // Append blockers to reasons
    for (const blocker of volatilityBlockers) {
      noTradeReasons.push(blocker);
    }

    if (directionalDecision.hasEdge) {
      noTradeReasons.push(...this.buildMeanReversionTrendBlockers({
        regime,
        winningSide,
        currentPrice,
        latest,
        previous,
        emaShort,
        emaLong,
        openingRangeLow,
        openingRangeHigh
      }));

      noTradeReasons.push(...this.buildStrictSetupModelBlockers({
        winningSide,
        currentPrice,
        vwap,
        emaShort,
        emaLong,
        latest,
        previous,
        hasBullishVolumeBreakout,
        hasBearishVolumeBreakout,
        volumeAnomaly,
        gexRegime: qqqGexRegime,
        flowDirection: qqqFlowDirection,
        flipStrike: qqqGexFlip
      }));
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
    const minOptionMark = 0.30;
    const maxBidAskSpreadPct = 5;
    const minOptionVolume = 200;
    const minOpenInterest = 500;
    const configSnapshot = this.buildSignalConfigSnapshot(settings, {
      minOptionMark,
      maxBidAskSpreadPct,
      minOptionVolume,
      minOpenInterest
    }, cycle.startedAt);
    const indicatorSnapshot = {
      vwap: Number(vwap.toFixed(2)),
      openingRangeHigh: Number(openingRangeHigh.toFixed(2)),
      openingRangeLow: Number(openingRangeLow.toFixed(2)),
      atr14: Number(atr14.toFixed(2)),
      volumeAnomaly: {
        triggerVolume: volumeAnomaly.triggerVolume,
        sampleSize: volumeAnomaly.sampleSize,
        sma20: volumeAnomaly.sma !== null ? Number(volumeAnomaly.sma.toFixed(2)) : null,
        stdev20: volumeAnomaly.stdev !== null ? Number(volumeAnomaly.stdev.toFixed(2)) : null,
        threshold: volumeAnomaly.threshold !== null ? Number(volumeAnomaly.threshold.toFixed(2)) : null,
        confirmed: volumeAnomaly.confirmed
      },
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
    };
    const gexSnapshotPayload = {
      netGex: qqqNetGex,
      netChex: qqqNetChex,
      regime: qqqGexRegime,
      flipStrike: qqqGexFlip,
      callWall: qqqCallWall,
      putWall: qqqPutWall,
      kingNode: qqqKingNode,
      flowDirection: qqqFlowDirection,
      ceiling: qqqCeiling,
      floor: qqqFloor
    };
    const macroSnapshotPayload = {
      vixQuote: vixPrice,
      vixChangePercent: vixChangePct,
      vix3mQuote: macroSnapshot.vix3mQuote,
      vixTermStructure: macroSnapshot.vixTermStructure,
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
    };
    const decisionSnapshotBase = {
      capturedAt: cycle.startedAt,
      symbol,
      marketDate: nyParts.marketDate,
      candle: {
        source: candleFetch.source,
        fetchedAt: candleFetch.fetchedAt,
        fallbackReason: candleFetch.fallbackReason,
        rawCount: rawCandleCount,
        completedCount: sortedCandles.length,
        freshnessMs: candleFreshnessMs,
        timestamp: latest.datetime,
        open: latest.open,
        high: latest.high,
        low: latest.low,
        close: latest.close,
        volume: latest.volume,
        previousClose,
        sessionChangePct: Number(sessionChangePct.toFixed(4)),
        candleChangePct: Number(candleChangePct.toFixed(4))
      },
      spot: {
        source: liveUnderlyingQuoteUsable ? 'ibkr' : 'completed_candle_fallback',
        liveMark: liveUnderlyingQuote?.mark ?? null,
        quoteAgeMs: liveUnderlyingQuote?.quoteAgeMs ?? null,
        timestamp: liveUnderlyingQuote?.timestamp ?? null,
        valueUsed: Number(currentPrice.toFixed(2)),
        candleClose: Number(latest.close.toFixed(2)),
        blocker: liveUnderlyingQuoteBlocker
      },
      configSnapshot,
      macroSnapshot: macroSnapshotPayload,
      gexSnapshot: gexSnapshotPayload,
      internals: {
        bullishCount: bullishInternals,
        bearishCount: bearishInternals,
        hasBullishInternals,
        hasBearishInternals,
        megaCaps: indicatorSnapshot.megaCaps
      },
      scoring: {
        regime,
        weights,
        callScoreParts,
        putScoreParts,
        callScore,
        putScore,
        winningSide: directionalSide,
        scoreLeader: winningSide,
        directionalEdge: directionalDecision.edge,
        directionalEdgeMinimum: directionalDecision.minimumEdge,
        winningScore,
        dynamicMinScore,
        macroThresholdAdjustment: macroRegime.thresholdAdjustment
      }
    };

    if (cycle.marketPhase !== 'OPEN') {
      noTradeReasons.splice(0, noTradeReasons.length, marketPhaseBlocker || 'Market closed — no live 0DTE entries outside regular trading hours');
    }

    const isActionable = noTradeReasons.length === 0;

    if (isActionable) {
      signalType = winningSide;
      if (regime === 'BREAKOUT') {
        tradeBias = winningSide === 'CALL' ? 'BUY_CALL_ON_BREAKOUT' : 'BUY_PUT_ON_BREAKDOWN';
      } else {
        tradeBias = winningSide === 'CALL' ? 'BUY_CALL_ON_DIP' : 'BUY_PUT_ON_RIP';
      }

      // Fetch the expiry chain from IBKR and select the cleanest nearby contract.
      const strikeOffset = parseInt(settings.strike_offset, 10) || 0;
      const todayDateStr = nyParts.dateStr;
      const targetExpiryDateStr = this.getTargetDayTradeExpiry(todayDateStr, nyParts.minutes, settings.day_trading_expiry_mode || 'adaptive');
      if (targetExpiryDateStr !== todayDateStr) {
        this.fastify.log.info(`[SignalScannerService] ${symbol} scan is after 1:00 PM ET. Selecting 1DTE expiry ${targetExpiryDateStr} instead of 0DTE ${todayDateStr}.`);
      }

      let chosenContract: OptionContractCandidate | null = null;
      let contractCandidates: OptionContractCandidate[] = [];
      let preferredStrike = Math.round(currentPrice);

      // 8. Contract pricing (IBKR chain snapshot -> Black-Scholes fallback)
      let bid: number | null = null;
      let ask: number | null = null;
      let spread: number | null = null;
      let spreadPct: number | null = null;
      let mark: number | null = null;
      let volume: number | null = null;
      let openInterest: number | null = null;
      let usingTheoreticalPricing = true;
      let candidateSelection: any = null;
      let chainSelectionRejected = false;
      let chainRejectionDetail: string | null = null;
      let selectedQuoteAgeMs: number | null = null;
      let selectedThetaDragPct: number | null = null;

      const defaultContractName = this.buildOsiTicker(symbol, targetExpiryDateStr, winningSide, Math.round(currentPrice));
      optionTicker = defaultContractName;
      chosenStrike = Math.round(currentPrice);
      chosenExpiry = targetExpiryDateStr;

      try {
        const chainSnapshot = await this.timeScannerPhase(
          cycle,
          `${symbol}.optionChain`,
          () => this.getCachedOptionChainSnapshot({
            userId,
            symbol,
            expiration: targetExpiryDateStr,
            side: winningSide,
            windowKey: `${nyParts.marketDate}:${Math.floor(nyParts.minutes / 5) * 5}`,
            forceRefresh: cycle.force
          })
        );
        const chain = chainSnapshot.chain;
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
          this.fastify.log.info(`[SignalScannerService] Querying IBKR option chain for ${contractCandidates.length}/${chain.length} ${symbol} candidates...`);
          const selection = this.fetchBestIBKROptionCandidate({
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
            source: 'ibkr_chain',
            cache: chainSnapshot.cache,
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
              failedFilters: candidate.failedFilters,
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
            selectedQuoteAgeMs = selected.quoteAgeMs ?? null;
            selectedThetaDragPct = this.getThetaDragPct(selected.theta ?? null, selected.mark);
            usingTheoreticalPricing = false;
            this.fastify.log.info(`[SignalScannerService] Selected ${selected.ticker} from ${selection.ranked.length} IBKR candidates: strike=${selected.strike}, mark=$${mark}, spread=${spreadPct}%, volume=${volume}, OI=${openInterest}, score=${selected.score}.`);
          } else if (selection.ranked.length > 0) {
            chainSelectionRejected = true;
            const bestRejected = selection.ranked[0];
            const bestRejectedReasons = bestRejected.failedFilters.length > 0 ? bestRejected.failedFilters : bestRejected.reasons;
            chainRejectionDetail = `Best rejected ${bestRejected.ticker}: ${bestRejectedReasons.join('; ')}`;
            this.fastify.log.warn(`[SignalScannerService] No IBKR ${symbol} contract passed liquidity filters. Best rejected ${bestRejected.ticker}: mark=${bestRejected.mark}, spread=${bestRejected.spreadPct}%, volume=${bestRejected.volume}, OI=${bestRejected.openInterest}, score=${bestRejected.score}, failedFilters=${bestRejected.failedFilters.join('; ') || 'none'}, reasons=${bestRejected.reasons.join('; ')}.`);
          }
        }
      } catch (ibkrErr: any) {
        this.fastify.log.warn(`[SignalScannerService] IBKR option chain selection failed: ${ibkrErr.message}`);
      }

      if (usingTheoreticalPricing && chosenContract) {
        try {
          const ibkr = new IbkrMarketDataService(this.fastify);
          const quote = await ibkr.getOptionQuote(userId, {
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
            selectedQuoteAgeMs = quote.quoteAgeMs ?? null;
            selectedThetaDragPct = null;
            usingTheoreticalPricing = false;
          }
        } catch (quoteErr: any) {
          this.fastify.log.warn(`[SignalScannerService] IBKR single-contract quote fallback failed: ${quoteErr.message}`);
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
      if (chainSelectionRejected) pricingWarnings.push('No IBKR option candidate passed liquidity/spread filters');
      if (chainRejectionDetail) pricingWarnings.push(chainRejectionDetail);
      if (usingTheoreticalPricing && mark !== null && bid !== null && ask !== null) pricingWarnings.push('Using theoretical option price fallback');
      if (mark !== null && mark < minOptionMark) pricingWarnings.push(`Option premium $${mark} below limit $${minOptionMark}`);
      if (spreadPct !== null && spreadPct > maxBidAskSpreadPct) pricingWarnings.push(`Spread ${spreadPct}% exceeds ceiling ${maxBidAskSpreadPct}%`);
      if (selectedQuoteAgeMs !== null && selectedQuoteAgeMs > 15_000) pricingWarnings.push(`Option quote stale ${Math.round(selectedQuoteAgeMs / 1000)}s`);
      if (selectedThetaDragPct !== null && selectedThetaDragPct > 45) pricingWarnings.push(`Option theta drag ${selectedThetaDragPct.toFixed(1)}%`);
      const contractConsistencyBlockers = this.buildContractConsistencyBlockers({
        symbol,
        side: winningSide as 'CALL' | 'PUT',
        expiry: chosenExpiry,
        strike: chosenStrike,
        ticker: optionTicker
      });
      for (const blocker of contractConsistencyBlockers) pricingWarnings.push(blocker);
      const eventRiskBlockers = this.buildEventRiskExecutionBlockers({
        marketDate: nyParts.dateStr,
        expiry: chosenExpiry
      });
      for (const blocker of eventRiskBlockers) pricingWarnings.push(blocker);
      if (volume !== null && volume < minOptionVolume) pricingWarnings.push(`Volume ${volume} below minimum ${minOptionVolume}`);
      if (openInterest !== null && openInterest < minOpenInterest) pricingWarnings.push(`Open interest ${openInterest} below minimum ${minOpenInterest}`);

      // Apply score adjustments for macro regime and pricing warnings.
      const pricingPenalty = this.getPricingWarningPenalty(pricingWarnings);
      let finalConfidence = Math.max(0, Math.min(100, winningScore + macroRegime.confidenceAdjustment - pricingPenalty));

      let setupGrade = '🎲 B / LOTTO';
      if (finalConfidence >= 92 && macroRegime.score >= 70 && pricingWarnings.length === 0) {
        setupGrade = '🔥 A+ / FULL';
      } else if (finalConfidence >= 85) {
        setupGrade = '⚡ A / STANDARD';
      }

      const executionRealism = this.buildExecutionRealismDiagnostics({
        mark,
        spreadPct,
        volume,
        openInterest,
        usingTheoreticalPricing,
        pricingWarnings
      });
      const executionBlockers = this.buildPricingExecutionBlockers({
        chainSelectionRejected,
        selectedQuoteAgeMs,
        selectedThetaDragPct,
        contractConsistencyBlockers,
        eventRiskBlockers,
        pricingWarnings,
        executionRealism
      });
      if (executionBlockers.length > 0) {
        finalConfidence = Math.min(finalConfidence, 84);
        setupGrade = '🎲 B / LOTTO';
      }

      const gradeDiagnostics = this.buildSignalGradeDiagnostics({
        baseScore: winningScore,
        macroRegime,
        pricingWarnings,
        pricingPenalty,
        executionRealism,
        executionBlockers,
        finalConfidence,
        setupGrade
      });
      const signalDecision = this.buildSignalDecision({
        symbol,
        winningSide: winningSide as 'CALL' | 'PUT',
        optionTicker,
        chosenStrike,
        chosenExpiry,
        mark,
        bid,
        ask,
        spreadPct,
        volume,
        openInterest,
        usingTheoreticalPricing,
        grade: gradeDiagnostics,
        createdAt: cycle.startedAt
      });

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
        macroConfidenceAdjustment: macroRegime.confidenceAdjustment,
        decision: signalDecision,
        gradeDiagnostics,
        configSnapshot
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
      const autoExecutionBlockers = this.buildAutoExecutionBlockers({
        tradeBias,
        currentPrice,
        entryTrigger,
        executionBlockers
      });
      pricingData.autoExecutionBlockers = autoExecutionBlockers;

      planData = {
        entryTriggerUnderlying: Number(entryTrigger.toFixed(2)),
        stopUnderlying,
        targetUnderlying,
        note: winningSide === 'CALL'
          ? `Use only if ${symbol} reclaims the latest 5-minute high and holds above VWAP.`
          : `Use only if ${symbol} breaks the latest 5-minute low and stays below VWAP.`
      };
      pricingData.decisionSnapshot = this.buildDecisionSnapshot({
        ...decisionSnapshotBase,
        cycle: this.getCycleSnapshot(cycle, symbol),
        status: 'SIGNAL_GENERATED',
        optionSelection: {
          candidateSelection,
          chainSelectionRejected,
          pricingWarnings
        },
        finalDecision: {
          signalDecision,
          finalConfidence,
          setupGrade,
          tradeBias,
          entryTriggerUnderlying: Number(entryTrigger.toFixed(2)),
          stopUnderlying,
          targetUnderlying,
          autoExecutionBlockers
        },
        blockers: executionBlockers
      });

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
        JSON.stringify(indicatorSnapshot),
        JSON.stringify(gexSnapshotPayload),
        JSON.stringify(macroSnapshotPayload),
        noTradeReasons,
        chosenExpiry,
        nyParts.marketDate,
        mlProbability,
        JSON.stringify(pricingData)
      ]);

      const signalId: number = insertResult.rows[0].id;
      signalDecision.signalId = signalId;
      const optionHistoryCapture = (this.fastify as any).optionMarketHistoryCapture;
      if (optionHistoryCapture?.registerSignal && chosenStrike !== null && chosenExpiry) {
        optionHistoryCapture.registerSignal(signalId, {
          symbol,
          strike: chosenStrike,
          optionType: winningSide,
          expiration: chosenExpiry
        }).catch((err: any) => {
          this.fastify.log.warn(`[SignalScannerService] Failed to start option history capture for signal #${signalId}: ${err.message || String(err)}`);
        });
      }
      tradingEventBus.publish({
        type: 'SIGNAL_GENERATED',
        createdAt: cycle.startedAt,
        signalId,
        symbol,
        data: signalDecision
      }, {
        [`signal:${signalId}:decision`]: signalDecision,
        [`symbol:${symbol}:latestDecision`]: signalDecision
      });
      try {
        await TradeRedisService.recordEvent(this.fastify.pg, {
          userId,
          signalId,
          eventType: 'SIGNAL_GENERATED',
          message: `${symbol} ${winningSide} signal generated`,
          metadata: {
            symbol,
            side: winningSide,
            setupGrade,
            confidenceScore: finalConfidence,
            optionTicker,
            executionRealism: gradeDiagnostics.executionRealism
          }
        });
      } catch (err: any) {
        this.fastify.log.warn(`[SignalScannerService] Failed to record signal audit event for #${signalId}: ${err.message || String(err)}`);
      }
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
      const autoTradeMode = settings.auto_trade_mode || 'instant';
      if (this.isAutoExecutionEnabled(settings) && autoTradeMode === 'instant') {
        if (autoExecutionBlockers.length > 0) {
          if (executionBlockers.length === 0 && this.hasEntryTriggerBlocker(autoExecutionBlockers)) {
            this.startTriggerWatch({
              userId,
              signalId,
              symbol,
              winningSide: winningSide as 'CALL' | 'PUT',
              tradeBias,
              chosenStrike: chosenStrike as number,
              chosenExpiry: chosenExpiry || '',
              optionTicker,
              entryTrigger,
              stopUnderlying,
              targetUnderlying,
              mark,
              settings,
              autoTradeMode: 'instant',
              startedAtMs: Date.now(),
              expiresAtMs: Date.now() + this.getTriggerWatchWindowMs(),
              armedAtMs: null,
              armedPrice: null
            });
          } else {
            this.fastify.log.warn(`[SignalScannerService] Auto-execution blocked for signal #${signalId}: ${autoExecutionBlockers.join('; ')}`);
            TradeRedisService.recordEvent(this.fastify.pg, {
              userId,
              signalId,
              eventType: 'SIGNAL_AUTO_EXECUTION_BLOCKED',
              message: autoExecutionBlockers.join('; '),
              metadata: { symbol, side: winningSide, tradeBias, entryTrigger, currentPrice }
            }).catch((err: any) => {
              this.fastify.log.warn(`[SignalScannerService] Failed to record auto-execution blocker for #${signalId}: ${err.message || String(err)}`);
            });
          }
        } else {
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
          ...indicatorSnapshot,
          macroRegime: {
            regime: macroRegime.regime,
            score: macroRegime.score,
            directionBias: macroRegime.directionBias,
            confidenceAdjustment: macroRegime.confidenceAdjustment,
            thresholdAdjustment: macroRegime.thresholdAdjustment,
            blockers: macroRegime.blockers,
            warnings: macroRegime.warnings
          },
          signalDecision,
          decisionSnapshot: pricingData?.decisionSnapshot || null
        }),
        'SIGNAL_GENERATED',
        []
      ]);
    } else {
      let blockedCounterfactual: any = null;
      if (cycle.marketPhase === 'OPEN') {
        try {
          blockedCounterfactual = await this.buildBlockedCounterfactualOption({
            userId,
            symbol,
            winningSide: winningSide as 'CALL' | 'PUT',
            currentPrice,
            marketDate: nyParts.dateStr,
            minutes: nyParts.minutes,
            expiryMode: settings.day_trading_expiry_mode || 'adaptive',
            strikeOffset: parseInt(settings.strike_offset, 10) || 0,
            forceRefresh: cycle.force,
            minOptionMark,
            maxBidAskSpreadPct,
            minOptionVolume,
            minOpenInterest
          });
        } catch (err: any) {
          this.fastify.log.warn(`[SignalScannerService] Blocked counterfactual option capture failed for ${symbol}: ${err.message || String(err)}`);
        }
      }

      const blockedContract = cycle.marketPhase === 'OPEN' ? (blockedCounterfactual?.contract || {
        ticker: this.buildOsiTicker(
          symbol,
          this.getTargetDayTradeExpiry(nyParts.dateStr, nyParts.minutes, settings.day_trading_expiry_mode || 'adaptive'),
          winningSide as 'CALL' | 'PUT',
          Math.round(currentPrice)
        ),
        strike: Math.round(currentPrice),
        expiry: this.getTargetDayTradeExpiry(nyParts.dateStr, nyParts.minutes, settings.day_trading_expiry_mode || 'adaptive')
      }) : { ticker: null, strike: null, expiry: null };
      const blockedQuote = blockedCounterfactual?.quote || {};
      const blockedSignalDecision = {
        symbol,
        side: winningSide,
        createdAt: cycle.startedAt,
        contract: blockedContract,
        quote: {
          mark: blockedQuote.mark ?? null,
          bid: blockedQuote.bid ?? null,
          ask: blockedQuote.ask ?? null,
          spreadPct: blockedQuote.spreadPct ?? null,
          volume: blockedQuote.volume ?? null,
          openInterest: blockedQuote.openInterest ?? null,
          usingTheoreticalPricing: false
        },
        grade: {
          finalConfidence: winningScore,
          setupGrade: 'BLOCKED',
          executable: false,
          blockers: noTradeReasons,
          reasons: noTradeReasons
        }
      };
      const blockedDecisionSnapshot = this.buildDecisionSnapshot({
        ...decisionSnapshotBase,
        cycle: this.getCycleSnapshot(cycle, symbol),
        status: 'BLOCKED',
        optionSelection: {
          counterfactual: blockedCounterfactual,
          candidateSelection: blockedCounterfactual?.candidateSelection || null
        },
        finalDecision: {
          counterfactual: true,
          signalDecision: blockedSignalDecision,
          finalConfidence: winningScore,
          setupGrade: 'BLOCKED'
        },
        blockers: noTradeReasons
      });

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
          ...indicatorSnapshot,
          macroRegime: {
            regime: macroRegime.regime,
            score: macroRegime.score,
            directionBias: macroRegime.directionBias,
            confidenceAdjustment: macroRegime.confidenceAdjustment,
            thresholdAdjustment: macroRegime.thresholdAdjustment,
            blockers: macroRegime.blockers,
            warnings: macroRegime.warnings
          },
          decisionSnapshot: blockedDecisionSnapshot
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
         AND status IN ('PENDING', 'PENDING_TRIGGER')
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

  private positiveNumberSetting(value: any, fallback: number): number {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
  }

  private positiveIntSetting(value: any, fallback: number): number {
    const numeric = Math.floor(Number(value));
    return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
  }

  private cloneSnapshot<T>(value: T): T {
    return JSON.parse(JSON.stringify(value));
  }

  private getSetupGradeKey(setupGrade: string): SignalGradeDiagnostics['gradeKey'] {
    const normalized = String(setupGrade || '').toUpperCase();
    if (normalized.includes('A+')) return 'A+';
    if (/(^|[^A-Z])A([^A-Z+]|$)/.test(normalized)) return 'A';
    if (normalized.includes('B') || normalized.includes('LOTTO')) return 'B';
    return 'UNKNOWN';
  }

  private buildSignalGradeDiagnostics(input: {
    baseScore: number;
    macroRegime: MacroRegimeAssessment;
    pricingWarnings: string[];
    pricingPenalty: number;
    executionRealism: SignalGradeDiagnostics['executionRealism'];
    executionBlockers?: string[];
    finalConfidence: number;
    setupGrade: string;
  }): SignalGradeDiagnostics {
    const thresholds = { standard: 85, full: 92, fullMacro: 70 };
    const gradeKey = this.getSetupGradeKey(input.setupGrade);
    const blockers = [...input.macroRegime.blockers, ...(input.executionBlockers || [])];
    const reasons: string[] = [];

    if (gradeKey === 'A+') {
      reasons.push('A+ because confidence, macro score, and pricing quality all passed full-size thresholds');
    } else if (gradeKey === 'A') {
      reasons.push('A because confidence passed the standard threshold');
      if (input.finalConfidence >= thresholds.full && input.macroRegime.score < thresholds.fullMacro) {
        reasons.push(`Not A+ because macro score ${input.macroRegime.score} is below ${thresholds.fullMacro}`);
      }
      if (input.pricingWarnings.length > 0) {
        reasons.push('Not A+ because pricing warnings are present');
      }
    } else {
      reasons.push(`Lotto because confidence ${input.finalConfidence} is below ${thresholds.standard}`);
      if (input.macroRegime.confidenceAdjustment < 0) {
        reasons.push(`Macro reduced confidence by ${Math.abs(input.macroRegime.confidenceAdjustment)} point(s)`);
      }
      if (input.pricingWarnings.length > 0) {
        reasons.push(`Pricing warnings subtracted ${input.pricingPenalty} point(s)`);
      }
    }

    return {
      baseScore: input.baseScore,
      macroScore: input.macroRegime.score,
      macroConfidenceAdjustment: input.macroRegime.confidenceAdjustment,
      pricingPenalty: input.pricingPenalty * -1,
      finalConfidence: input.finalConfidence,
      setupGrade: input.setupGrade,
      gradeKey,
      executable: (gradeKey === 'A+' || gradeKey === 'A') && blockers.length === 0 && input.executionRealism.executable,
      thresholds,
      reasons,
      warnings: input.macroRegime.warnings,
      blockers,
      pricingWarnings: input.pricingWarnings,
      executionRealism: input.executionRealism
    };
  }

  private getPricingWarningPenalty(pricingWarnings: string[]): number {
    const missingLiveQuote = pricingWarnings.includes('No usable live option quote selected');
    const chainRejected = pricingWarnings.includes('No IBKR option candidate passed liquidity/spread filters');
    const theoreticalFallback = pricingWarnings.includes('Using theoretical option price fallback');
    const groupedWarnings = new Set([
      'No usable live option quote selected',
      'No IBKR option candidate passed liquidity/spread filters',
      'Using theoretical option price fallback'
    ]);
    let penalty = 0;

    if (missingLiveQuote || theoreticalFallback) {
      penalty += 20;
    } else if (chainRejected) {
      penalty += 5;
    }

    for (const warning of pricingWarnings) {
      if (!groupedWarnings.has(warning) && !warning.startsWith('Best rejected ')) {
        penalty += 10;
      }
    }

    return penalty;
  }

  private buildPricingExecutionBlockers(input: {
    chainSelectionRejected: boolean;
    selectedQuoteAgeMs: number | null;
    selectedThetaDragPct: number | null;
    contractConsistencyBlockers?: string[];
    eventRiskBlockers?: string[];
    pricingWarnings: string[];
    executionRealism: SignalGradeDiagnostics['executionRealism'];
  }): string[] {
    const blockers = new Set<string>();
    if (input.chainSelectionRejected) {
      blockers.add('Option chain selection rejected every candidate; live auto-trading blocked');
    }
    if (input.selectedQuoteAgeMs !== null && input.selectedQuoteAgeMs > 15_000) {
      blockers.add(`Option quote is stale (${Math.round(input.selectedQuoteAgeMs / 1000)}s old)`);
    }
    if (input.selectedThetaDragPct !== null && input.selectedThetaDragPct > 45) {
      blockers.add(`Option theta drag is extreme (${input.selectedThetaDragPct.toFixed(1)}%)`);
    }
    for (const blocker of input.contractConsistencyBlockers || []) {
      blockers.add(blocker);
    }
    for (const blocker of input.eventRiskBlockers || []) {
      blockers.add(blocker);
    }
    for (const warning of input.pricingWarnings) {
      const normalized = warning.toLowerCase();
      if (normalized.includes('stale quote')) {
        blockers.add(warning);
      }
      if (normalized.includes('theta drag')) {
        blockers.add(warning);
      }
    }
    if (!input.executionRealism.executable) {
      blockers.add(`Execution realism score ${input.executionRealism.score} is below ${input.executionRealism.threshold}`);
    }
    return Array.from(blockers);
  }

  private buildContractConsistencyBlockers(input: {
    symbol: string;
    side: 'CALL' | 'PUT';
    expiry: string | null;
    strike: number | null;
    ticker: string | null;
  }): string[] {
    if (!input.ticker || input.strike === null || !input.expiry) return [];
    const parsed = this.parseOsiTicker(input.ticker);
    if (!parsed) return [`Option ticker ${input.ticker} is not a valid OSI contract`];

    const blockers: string[] = [];
    const expectedExpiry = String(input.expiry).split('T')[0];
    if (parsed.symbol !== input.symbol.toUpperCase()) {
      blockers.push(`Option ticker symbol ${parsed.symbol} does not match signal symbol ${input.symbol.toUpperCase()}`);
    }
    if (parsed.side !== input.side) {
      blockers.push(`Option ticker side ${parsed.side} does not match selected side ${input.side}`);
    }
    if (parsed.expiry !== expectedExpiry) {
      blockers.push(`Option ticker expiry ${parsed.expiry} does not match selected expiry ${expectedExpiry}`);
    }
    if (Math.abs(parsed.strike - Number(input.strike)) > 0.001) {
      blockers.push(`Option ticker strike ${parsed.strike} does not match selected strike ${input.strike}`);
    }
    return blockers;
  }

  private buildEventRiskExecutionBlockers(input: {
    marketDate: string;
    expiry: string | null;
  }): string[] {
    if (!input.expiry || input.expiry !== input.marketDate) return [];
    const context = getEconomicCalendarContext(input.marketDate);
    if (!context.includes('HIGH EVENT RISK')) return [];
    return [`High-impact economic event today; 0DTE auto-trading blocked (${context.split('\n')[0]})`];
  }

  private buildMeanReversionTrendBlockers(input: {
    regime: string;
    winningSide: 'CALL' | 'PUT';
    currentPrice: number;
    latest: Candle;
    previous: Candle;
    emaShort: number | null;
    emaLong: number | null;
    openingRangeLow: number;
    openingRangeHigh: number;
  }): string[] {
    if (input.regime !== 'MEAN_REVERSION') return [];
    const strongDowntrend = input.emaShort !== null && input.emaLong !== null && input.emaShort < input.emaLong && input.currentPrice < input.emaShort;
    const strongUptrend = input.emaShort !== null && input.emaLong !== null && input.emaShort > input.emaLong && input.currentPrice > input.emaShort;
    const callConfirmed = input.currentPrice >= input.openingRangeLow && input.latest.close > input.latest.open && input.latest.close >= input.previous.high;
    const putConfirmed = input.currentPrice <= input.openingRangeHigh && input.latest.close < input.latest.open && input.latest.close <= input.previous.low;

    if (input.winningSide === 'CALL' && strongDowntrend && !callConfirmed) {
      return ['Mean-reversion CALL blocked: strong downtrend requires support hold and reclaim confirmation'];
    }
    if (input.winningSide === 'PUT' && strongUptrend && !putConfirmed) {
      return ['Mean-reversion PUT blocked: strong uptrend requires resistance rejection and breakdown confirmation'];
    }
    return [];
  }

  private computeVolumeAnomaly(candles: Candle[], latest: Candle, window = 20, stdevMultiplier = 1.5): VolumeAnomaly {
    const priorCandles = candles
      .filter(candle => candle.timestamp < latest.timestamp && Number.isFinite(Number(candle.volume)) && Number(candle.volume) > 0)
      .slice(-window);
    const volumes = priorCandles.map(candle => Number(candle.volume));
    const triggerVolume = Number(latest.volume || 0);

    if (volumes.length < window) {
      return {
        confirmed: false,
        sampleSize: volumes.length,
        sma: null,
        stdev: null,
        threshold: null,
        triggerVolume
      };
    }

    const sma = volumes.reduce((sum, volume) => sum + volume, 0) / volumes.length;
    const variance = volumes.reduce((sum, volume) => sum + Math.pow(volume - sma, 2), 0) / volumes.length;
    const stdev = Math.sqrt(variance);
    const threshold = sma + stdevMultiplier * stdev;

    return {
      confirmed: triggerVolume > threshold,
      sampleSize: volumes.length,
      sma,
      stdev,
      threshold,
      triggerVolume
    };
  }

  private formatVolumeAnomalyBlocker(side: 'CALL' | 'PUT', anomaly?: VolumeAnomaly, candleMatchesSide = false, actualCandleColor = 'unknown'): string {
    const candleColor = side === 'CALL' ? 'green' : 'red';
    if (!anomaly || anomaly.sampleSize < 20 || anomaly.threshold === null) {
      return `Strict setup blocked: ${side} requires high-volume ${candleColor} confirmation candle with a 20-candle volume baseline`;
    }
    if (anomaly.confirmed && !candleMatchesSide) {
      return `Strict setup blocked: ${side} volume passed the anomaly threshold (${anomaly.triggerVolume.toFixed(0)} > ${anomaly.threshold.toFixed(0)}), but the latest candle was ${actualCandleColor}; a ${candleColor} confirmation candle is required`;
    }
    return `Strict setup blocked: ${side} volume ${anomaly.triggerVolume.toFixed(0)} did not exceed the volume anomaly threshold ${anomaly.threshold.toFixed(0)} (SMA20 ${anomaly.sma!.toFixed(0)} + 1.5 stdev ${anomaly.stdev!.toFixed(0)})`;
  }

  private buildVolatilityCompressionBlockers(input: {
    symbol: string;
    currentMinutes: number;
    atr14: number;
    currentPrice: number;
    vixChangePct: number | null;
  }): string[] {
    if (String(input.symbol || '').toUpperCase() !== 'SPY') return [];

    const blockers: string[] = [];
    const minAtr = 0.15;

    if (Number.isFinite(input.atr14) && input.atr14 < minAtr) {
      blockers.push(`Volatility gateway blocked: SPY ATR14 ${input.atr14.toFixed(2)} is below minimum structural movement ${minAtr.toFixed(2)}`);
    }
    if (input.vixChangePct !== null && input.vixChangePct <= -8) {
      blockers.push(`Volatility gateway blocked: VIX compression ${input.vixChangePct.toFixed(2)}% is too steep for directional 0DTE auto-entry`);
    }

    return blockers;
  }

  private buildStrictSetupModelBlockers(input: {
    winningSide: 'CALL' | 'PUT';
    currentPrice: number;
    vwap: number;
    emaShort: number | null;
    emaLong: number | null;
    latest: Candle;
    previous: Candle;
    hasBullishVolumeBreakout: boolean;
    hasBearishVolumeBreakout: boolean;
    volumeAnomaly?: VolumeAnomaly;
    gexRegime: string;
    flowDirection: string;
    flipStrike: number | null;
  }): string[] {
    const blockers: string[] = [];
    const flow = String(input.flowDirection || '').toLowerCase();
    const regime = String(input.gexRegime || '').toUpperCase();
    const aboveFlip = input.flipStrike !== null && input.currentPrice > input.flipStrike;
    const belowFlip = input.flipStrike !== null && input.currentPrice < input.flipStrike;

    if (input.winningSide === 'CALL') {
      const gammaAligned = flow === 'bullish' || (flow === 'amplifying' && aboveFlip) || (regime === 'NEGATIVE' && aboveFlip);
      const emaStacked = input.emaShort !== null && input.emaLong !== null && input.emaShort > input.emaLong && input.currentPrice > input.emaShort;
      const vwapAligned = input.currentPrice >= input.vwap;
      const volumeConfirmed = input.hasBullishVolumeBreakout;
      const triggerConfirmed = input.latest.close > input.latest.open && input.latest.close >= input.previous.high;

      if (!gammaAligned) blockers.push('Strict setup blocked: CALL requires bullish gamma direction or price above gamma flip');
      if (!emaStacked) blockers.push('Strict setup blocked: CALL requires price > EMA9 > EMA21');
      if (!vwapAligned) blockers.push('Strict setup blocked: CALL requires price above or reclaiming VWAP');
      if (!volumeConfirmed) blockers.push(this.formatVolumeAnomalyBlocker('CALL', input.volumeAnomaly, input.latest.close >= input.latest.open, input.latest.close > input.latest.open ? 'green' : input.latest.close < input.latest.open ? 'red' : 'flat'));
      if (!triggerConfirmed) blockers.push('Strict setup blocked: CALL requires reclaim/break confirmation above the prior candle high');
      return blockers;
    }

    const gammaAligned = flow === 'bearish' || (flow === 'amplifying' && belowFlip) || (regime === 'NEGATIVE' && belowFlip);
    const emaStacked = input.emaShort !== null && input.emaLong !== null && input.emaShort < input.emaLong && input.currentPrice < input.emaShort;
    const vwapAligned = input.currentPrice <= input.vwap;
    const volumeConfirmed = input.hasBearishVolumeBreakout;
    const triggerConfirmed = input.latest.close < input.latest.open && input.latest.close <= input.previous.low;

    if (!gammaAligned) blockers.push('Strict setup blocked: PUT requires bearish gamma direction or price below gamma flip');
    if (!emaStacked) blockers.push('Strict setup blocked: PUT requires price < EMA9 < EMA21');
    if (!vwapAligned) blockers.push('Strict setup blocked: PUT requires price below or rejecting VWAP');
    if (!volumeConfirmed) blockers.push(this.formatVolumeAnomalyBlocker('PUT', input.volumeAnomaly, input.latest.close <= input.latest.open, input.latest.close > input.latest.open ? 'green' : input.latest.close < input.latest.open ? 'red' : 'flat'));
    if (!triggerConfirmed) blockers.push('Strict setup blocked: PUT requires breakdown/rejection confirmation below the prior candle low');
    return blockers;
  }

  private buildAutoExecutionBlockers(input: {
    tradeBias: string;
    currentPrice: number;
    entryTrigger: number;
    executionBlockers: string[];
  }): string[] {
    const blockers = [...input.executionBlockers];
    if (input.tradeBias === 'BUY_CALL_ON_DIP' && input.currentPrice < input.entryTrigger) {
      blockers.push(`Mean-reversion CALL has not reclaimed entry trigger ${input.entryTrigger.toFixed(2)}; current ${input.currentPrice.toFixed(2)}`);
    }
    if (input.tradeBias === 'BUY_PUT_ON_RIP' && input.currentPrice > input.entryTrigger) {
      blockers.push(`Mean-reversion PUT has not broken entry trigger ${input.entryTrigger.toFixed(2)}; current ${input.currentPrice.toFixed(2)}`);
    }
    return blockers;
  }

  private getThetaDragPct(theta: number | null | undefined, mark: number | null | undefined): number | null {
    const numericTheta = Number(theta);
    const numericMark = Number(mark);
    if (!Number.isFinite(numericTheta) || !Number.isFinite(numericMark) || numericMark <= 0) return null;
    return Math.abs(numericTheta / numericMark) * 100;
  }

  private buildGexProximityBlockers(input: {
    winningSide: 'CALL' | 'PUT';
    currentPrice: number;
    callWall: number | null;
    putWall: number | null;
    kingNode: number | null;
    floor: number | null;
    ceiling: number | null;
    regime: string;
  }): string[] {
    const blockers: string[] = [];
    const proximity = 0.50;
    const sameStrikeTolerance = 0.01;
    const kingNodePinned = input.kingNode !== null && Math.abs(input.currentPrice - input.kingNode) <= proximity;
    const callWallPinned = input.winningSide === 'CALL' &&
      input.callWall !== null &&
      input.currentPrice < input.callWall &&
      input.callWall - input.currentPrice <= proximity;
    const putWallPinned = input.winningSide === 'PUT' &&
      input.putWall !== null &&
      input.currentPrice > input.putWall &&
      input.currentPrice - input.putWall <= proximity;

    if (callWallPinned && kingNodePinned && input.callWall !== null && input.kingNode !== null && Math.abs(input.callWall - input.kingNode) <= sameStrikeTolerance) {
      blockers.push(`Blocked: Spot ($${input.currentPrice.toFixed(2)}) is pinned near Call Wall / King Node ($${input.callWall.toFixed(2)})`);
    } else if (putWallPinned && kingNodePinned && input.putWall !== null && input.kingNode !== null && Math.abs(input.putWall - input.kingNode) <= sameStrikeTolerance) {
      blockers.push(`Blocked: Spot ($${input.currentPrice.toFixed(2)}) is pinned near Put Wall / King Node ($${input.putWall.toFixed(2)})`);
    } else {
      if (callWallPinned && input.callWall !== null) {
        blockers.push(`Blocked: Spot ($${input.currentPrice.toFixed(2)}) is too close to Call Wall ($${input.callWall.toFixed(2)})`);
      }
      if (putWallPinned && input.putWall !== null) {
        blockers.push(`Blocked: Spot ($${input.currentPrice.toFixed(2)}) is too close to Put Wall ($${input.putWall.toFixed(2)})`);
      }
      if (kingNodePinned && input.kingNode !== null) {
        blockers.push(`Blocked: Spot ($${input.currentPrice.toFixed(2)}) is pinned to King Node ($${input.kingNode.toFixed(2)})`);
      }
    }

    if (input.regime === 'BREAKOUT' && input.floor !== null && input.ceiling !== null && input.ceiling - input.floor <= 2.0) {
      blockers.push(`Blocked: Pinned in tight GEX range ($${input.floor}-$${input.ceiling}), breakout unlikely.`);
    }

    return blockers;
  }

  private getDynamicMinimumScore(settings: any, currentMinutes: number, macroRegime: Pick<MacroRegimeAssessment, 'thresholdAdjustment'>): number {
    let dynamicMinScore = Number(settings.min_signal_score);
    if (!Number.isFinite(dynamicMinScore) || dynamicMinScore <= 0) {
      dynamicMinScore = 70;
    }
    if (currentMinutes >= 13 * 60 + 30) {
      dynamicMinScore += 15;
    }
    dynamicMinScore += macroRegime.thresholdAdjustment;
    return dynamicMinScore;
  }

  private normalizeCandleQuote(quote: any, dateValue: any): Candle | null {
    const open = this.toNumber(quote.open ?? quote.o);
    const high = this.toNumber(quote.high ?? quote.h);
    const low = this.toNumber(quote.low ?? quote.l);
    const close = this.toNumber(quote.close ?? quote.c);
    const volume = this.toNumber(quote.volume ?? quote.v ?? 0) ?? 0;
    if (!dateValue || open === null || high === null || low === null || close === null) return null;

    const dateObj = dateValue instanceof Date ? dateValue : new Date(dateValue);
    if (!Number.isFinite(dateObj.getTime())) return null;
    const datetime = dateObj.toISOString();
    const nyCandleParts = this.getNyDateParts(dateObj);
    const isRTH = nyCandleParts.minutes >= (9 * 60 + 30) && nyCandleParts.minutes < (16 * 60);

    return {
      datetime,
      nyDateStr: nyCandleParts.dateStr,
      isRTH,
      open,
      high,
      low,
      close,
      volume,
      timestamp: Math.floor(dateObj.getTime() / 1000)
    };
  }

  private parseYahooChartQuotes(quotes: any[]): Candle[] {
    return quotes
      .map((quote: any) => this.normalizeCandleQuote(quote, quote.date))
      .filter((candle: Candle | null): candle is Candle => candle !== null);
  }

  private parseIbkrHistoricalBars(bars: Array<{ start: string; open: number; high: number; low: number; close: number; volume: number }>): Candle[] {
    return bars
      .map((bar) => this.normalizeCandleQuote({
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume
      }, bar.start))
      .filter((candle: Candle | null): candle is Candle => candle !== null);
  }

  private async fetchScannerCandles(input: {
    symbol: string;
    now: Date;
    yahooChart?: (symbol: string, options: any) => Promise<any>;
  }): Promise<CandleFetchResult> {
    const fiveDaysAgo = new Date(input.now);
    fiveDaysAgo.setDate(input.now.getDate() - 5);
    const yahooChart = input.yahooChart || ((symbol: string, options: any) => (yahooFinance as any).chart(symbol, options));
    let fallbackReason: string | null = null;

    try {
      const ibkr = new IbkrMarketDataService(this.fastify);
      await ibkr.assertLiveMarketData();
      const bars = await ibkr.getHistoricalBars(input.symbol, '5 D', '5 mins');
      const candles = this.parseIbkrHistoricalBars(bars);
      if (candles.length > 0) {
        return {
          candles,
          source: 'ibkr',
          fetchedAt: input.now.toISOString(),
          fallbackReason: null
        };
      }
      fallbackReason = 'IBKR returned no usable bars';
    } catch (err: any) {
      fallbackReason = `IBKR bars failed: ${err.message || String(err)}`;
      this.fastify.log.warn(`[SignalScannerService] ${fallbackReason}`);
    }

    const chartData = await yahooChart(input.symbol, {
      interval: '5m',
      period1: fiveDaysAgo,
      period2: input.now,
      includePrePost: true
    });
    const candles = this.parseYahooChartQuotes(chartData?.quotes || []);
    if (candles.length === 0) {
      throw new Error(`No usable Yahoo candles for ${input.symbol}`);
    }

    return {
      candles,
      source: 'yahoo',
      fetchedAt: input.now.toISOString(),
      fallbackReason
    };
  }

  private getLiveCandleSourceBlocker(candleFetch: CandleFetchResult): string | null {
    if (candleFetch.source === 'ibkr') return null;
    const reason = candleFetch.fallbackReason ? ` (${candleFetch.fallbackReason})` : '';
    return `Live entry blocked: IBKR live candles required; received ${candleFetch.source} candle data${reason}`;
  }

  private getLiveUnderlyingQuoteBlocker(symbol: string, quote: IbkrOptionQuote | null): string | null {
    if (!quote || !Number.isFinite(quote.mark) || quote.mark <= 0) {
      return `Live IBKR spot unavailable for ${symbol}`;
    }

    const maxAgeMs = Number(process.env.IBKR_UNDERLYING_QUOTE_MAX_AGE_MS || 5_000);
    const safeMaxAgeMs = Number.isFinite(maxAgeMs) && maxAgeMs > 0 ? maxAgeMs : 5_000;
    if (!quote.timestamp || quote.quoteAgeMs === null || !Number.isFinite(quote.quoteAgeMs)) {
      return `Live IBKR spot timestamp unavailable for ${symbol}`;
    }
    if (quote.quoteAgeMs > safeMaxAgeMs) {
      return `Live IBKR spot stale for ${symbol}: quote is ${Math.round(quote.quoteAgeMs / 1000)}s old`;
    }
    return null;
  }

  private getCandleFreshnessMs(candle: Candle, now: Date, intervalMinutes = 5): number {
    const completedAtMs = candle.timestamp * 1000 + intervalMinutes * 60 * 1000;
    return Math.max(0, now.getTime() - completedAtMs);
  }

  private getCandleFreshnessBlocker(input: { source: CandleSource; freshnessMs: number; intervalMinutes?: number }): string | null {
    const intervalMinutes = input.intervalMinutes ?? 5;
    const maxFreshnessMs = (intervalMinutes + 2) * 60 * 1000;
    if (input.freshnessMs <= maxFreshnessMs) return null;
    return `Candle data stale from ${input.source}: latest completed candle closed ${Math.round(input.freshnessMs / 1000)}s ago`;
  }

  private buildExecutionRealismDiagnostics(input: {
    mark: number | null;
    spreadPct: number | null;
    volume: number | null;
    openInterest: number | null;
    usingTheoreticalPricing: boolean;
    pricingWarnings: string[];
  }): SignalGradeDiagnostics['executionRealism'] {
    const threshold = 70;
    const reasons: string[] = [];
    let score = 100;

    if (input.usingTheoreticalPricing) {
      score -= 45;
      reasons.push('Theoretical option pricing cannot be used for live execution');
    }
    if (input.mark === null || input.mark <= 0) {
      score -= 35;
      reasons.push('No live option mark is available');
    } else if (input.mark < 0.2) {
      score -= 15;
      reasons.push(`Option premium $${input.mark} is thin`);
    }

    if (input.spreadPct === null) {
      score -= 20;
      reasons.push('Bid/ask spread is unavailable');
    } else if (input.spreadPct > 20) {
      score -= 35;
      reasons.push(`Bid/ask spread ${input.spreadPct}% is extreme`);
    } else if (input.spreadPct > 12) {
      score -= 25;
      reasons.push(`Bid/ask spread ${input.spreadPct}% is very wide`);
    } else if (input.spreadPct > 8) {
      score -= 12;
      reasons.push(`Bid/ask spread ${input.spreadPct}% is above the preferred range`);
    }

    if (input.volume === null) {
      score -= 10;
      reasons.push('Option volume is unavailable');
    } else if (input.volume < 100) {
      score -= 20;
      reasons.push(`Option volume ${input.volume} is too light`);
    } else if (input.volume < 500) {
      score -= 10;
      reasons.push(`Option volume ${input.volume} is below preferred liquidity`);
    }

    if (input.openInterest === null) {
      score -= 10;
      reasons.push('Open interest is unavailable');
    } else if (input.openInterest < 250) {
      score -= 15;
      reasons.push(`Open interest ${input.openInterest} is thin`);
    } else if (input.openInterest < 1000) {
      score -= 5;
      reasons.push(`Open interest ${input.openInterest} is below preferred depth`);
    }

    if (input.pricingWarnings.length > 0) {
      score -= Math.min(20, input.pricingWarnings.length * 5);
    }

    const boundedScore = Math.max(0, Math.min(100, score));
    return {
      score: boundedScore,
      executable: boundedScore >= threshold,
      threshold,
      reasons: reasons.length > 0 ? reasons : ['Live quote, spread, and liquidity passed execution realism checks']
    };
  }

  private buildSignalConfigSnapshot(settings: any, thresholds: {
    minOptionMark: number;
    maxBidAskSpreadPct: number;
    minOptionVolume: number;
    minOpenInterest: number;
  }, capturedAt: string = new Date().toISOString()) {
    return {
      version: 1,
      capturedAt,
      scanner: {
        tradingStartTime: settings.trading_start_time || '09:30',
        tradingCutoffTime: settings.trading_cutoff_time || '16:00',
        minSignalScore: this.finiteNumber(settings.min_signal_score) ?? 70,
        strikeOffset: parseInt(settings.strike_offset, 10) || 0,
        minOptionMark: thresholds.minOptionMark,
        maxBidAskSpreadPct: thresholds.maxBidAskSpreadPct,
        minOptionVolume: thresholds.minOptionVolume,
        minOpenInterest: thresholds.minOpenInterest,
        expiryMode: settings.day_trading_expiry_mode || 'adaptive',
        deltaRange: { min: 0.30, max: 0.65 }
      },
      replay: {
        contractsPerTrade: this.positiveIntSetting(settings.contracts_per_trade, 1),
        takeProfitPct: this.positiveNumberSetting(settings.take_profit_pct, 12),
        stopLossPct: 20,
        maxTradesPerDay: this.positiveIntSetting(settings.max_trades_per_day, 2),
        dailyProfitTarget: 400,
        dailyLossLimit: this.positiveNumberSetting(settings.max_daily_loss_dollars, 200),
        maxPremiumRisk: this.positiveNumberSetting(settings.max_premium_risk_dollars, 500),
        maxConsecutiveLosses: this.positiveIntSetting(settings.max_consecutive_losses, 3),
        lossCooldownMinutes: this.positiveIntSetting(settings.loss_cooldown_minutes, 30),
        maxCorrelatedPositions: this.positiveIntSetting(settings.max_correlated_positions, 1),
        shadowTradingEnabled: settings.shadow_trading_enabled === 'true'
      },
      execution: {
        broker: settings.execution_broker || 'none',
        orderType: settings.order_type || 'LIMIT',
        entrySlippagePct: this.positiveNumberSetting(settings.entry_slippage_pct, 3),
        autoTradeMode: settings.auto_trade_mode || 'instant',
        snaptradeAutoTrade: settings.snaptrade_auto_trade === 'true'
      }
    };
  }

  private async buildBlockedCounterfactualOption(input: {
    userId: number;
    symbol: string;
    winningSide: 'CALL' | 'PUT';
    currentPrice: number;
    marketDate: string;
    minutes: number;
    expiryMode: string;
    strikeOffset: number;
    forceRefresh: boolean;
    minOptionMark: number;
    maxBidAskSpreadPct: number;
    minOptionVolume: number;
    minOpenInterest: number;
  }): Promise<Record<string, any>> {
    const expiry = this.getTargetDayTradeExpiry(input.marketDate, input.minutes, input.expiryMode);
    const defaultStrike = Math.round(input.currentPrice);
    const defaultContract = {
      ticker: this.buildOsiTicker(input.symbol, expiry, input.winningSide, defaultStrike),
      strike: defaultStrike,
      expiry
    };
    const fallback = {
      source: 'counterfactual_default',
      selected: false,
      contract: defaultContract,
      quote: {
        bid: null,
        ask: null,
        spreadPct: null,
        mark: null,
        volume: null,
        openInterest: null
      },
      candidateSelection: null,
      error: null
    };

    try {
      const chainSnapshot = await this.getCachedOptionChainSnapshot({
        userId: input.userId,
        symbol: input.symbol,
        expiration: expiry,
        side: input.winningSide,
        windowKey: `${input.marketDate}:${Math.floor(input.minutes / 5) * 5}`,
        forceRefresh: input.forceRefresh
      });
      const parsed = chainSnapshot.chain
        .map((quote) => ({ ticker: quote.ticker, strike: quote.strike, expiry: quote.expiration }))
        .filter((candidate, idx, arr) => Number.isFinite(candidate.strike) && arr.findIndex((other) => other.ticker === candidate.ticker) === idx)
        .sort((a, b) => a.strike - b.strike);
      if (parsed.length === 0) {
        return { ...fallback, error: 'IBKR returned an empty option chain', candidateSelection: { source: 'ibkr_chain', cache: chainSnapshot.cache, candidates: [] } };
      }

      let atmIdx = 0;
      let minDistance = Infinity;
      for (let index = 0; index < parsed.length; index++) {
        const distance = Math.abs(parsed[index].strike - input.currentPrice);
        if (distance < minDistance) {
          minDistance = distance;
          atmIdx = index;
        }
      }
      const preferredIdx = Math.max(
        0,
        Math.min(parsed.length - 1, input.winningSide === 'CALL' ? atmIdx + input.strikeOffset : atmIdx - input.strikeOffset)
      );
      const preferredStrike = parsed[preferredIdx]?.strike || parsed[atmIdx]?.strike || defaultStrike;
      const candidates = this.getContractWindow(parsed, atmIdx, input.winningSide, input.strikeOffset);
      const selection = this.fetchBestIBKROptionCandidate({
        chain: chainSnapshot.chain,
        candidates,
        preferredStrike,
        minOptionMark: input.minOptionMark,
        maxBidAskSpreadPct: input.maxBidAskSpreadPct,
        minOptionVolume: input.minOptionVolume,
        minOpenInterest: input.minOpenInterest
      });
      const selected = selection.selected || selection.ranked[0] || null;
      if (!selected) {
        return { ...fallback, error: 'IBKR returned no replayable option candidate', candidateSelection: { source: 'ibkr_chain', cache: chainSnapshot.cache, preferredStrike, candidates: [] } };
      }

      return {
        source: 'ibkr_chain_counterfactual',
        selected: Boolean(selection.selected),
        contract: { ticker: selected.ticker, strike: selected.strike, expiry: selected.expiry },
        quote: {
          bid: selected.bid,
          ask: selected.ask,
          spreadPct: selected.spreadPct,
          mark: selected.mark,
          volume: selected.volume,
          openInterest: selected.openInterest
        },
        candidateSelection: {
          source: 'ibkr_chain',
          cache: chainSnapshot.cache,
          preferredStrike,
          selectedScore: selection.selected?.score ?? null,
          selectedReasons: selection.selected?.reasons ?? [],
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
            failedFilters: candidate.failedFilters,
            score: candidate.score,
            reasons: candidate.reasons
          }))
        },
        rejected: !selection.selected,
        rejectionReasons: selected.failedFilters.length > 0 ? selected.failedFilters : selected.reasons
      };
    } catch (err: any) {
      return { ...fallback, error: err.message || String(err) };
    }
  }

  private buildSignalDecision(input: {
    symbol: string;
    winningSide: 'CALL' | 'PUT';
    optionTicker: string | null;
    chosenStrike: number | null;
    chosenExpiry: string | null;
    mark: number | null;
    bid: number | null;
    ask: number | null;
    spreadPct: number | null;
    volume: number | null;
    openInterest: number | null;
    usingTheoreticalPricing: boolean;
    grade: SignalGradeDiagnostics;
    createdAt?: string;
  }): SignalDecision {
    return {
      symbol: input.symbol,
      side: input.winningSide,
      createdAt: input.createdAt || new Date().toISOString(),
      contract: {
        ticker: input.optionTicker,
        strike: input.chosenStrike,
        expiry: input.chosenExpiry
      },
      quote: {
        mark: input.mark,
        bid: input.bid,
        ask: input.ask,
        spreadPct: input.spreadPct,
        volume: input.volume,
        openInterest: input.openInterest,
        usingTheoreticalPricing: input.usingTheoreticalPricing
      },
      grade: input.grade
    };
  }

  private buildDecisionSnapshot(input: {
    symbol: string;
    status: 'SIGNAL_GENERATED' | 'BLOCKED';
    marketDate: string;
    candle: Record<string, any>;
    configSnapshot: Record<string, any>;
    macroSnapshot: Record<string, any>;
    gexSnapshot: Record<string, any>;
    internals: Record<string, any>;
    scoring: Record<string, any>;
    capturedAt?: string;
    cycle?: Record<string, any>;
    optionSelection?: Record<string, any> | null;
    finalDecision?: Record<string, any> | null;
    blockers: string[];
  }) {
    return this.cloneSnapshot({
      version: 1,
      capturedAt: input.capturedAt || new Date().toISOString(),
      symbol: input.symbol,
      status: input.status,
      marketDate: input.marketDate,
      cycle: input.cycle || null,
      candle: input.candle,
      configSnapshot: input.configSnapshot,
      macroSnapshot: input.macroSnapshot,
      gexSnapshot: input.gexSnapshot,
      internals: input.internals,
      scoring: input.scoring,
      optionSelection: input.optionSelection || null,
      finalDecision: input.finalDecision || null,
      blockers: input.blockers
    });
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

  private async getCachedOptionChainSnapshot(input: {
    userId: number;
    symbol: string;
    expiration: string;
    side: 'CALL' | 'PUT';
    windowKey: string;
    forceRefresh?: boolean;
    nowMs?: number;
    marketData?: Pick<IbkrMarketDataService, 'getOptionChainSnapshot'>;
  }): Promise<{ chain: OptionChainQuote[]; cache: { key: string; hit: boolean; ageMs: number | null; ttlMs: number } }> {
    const nowMs = input.nowMs ?? Date.now();
    const key = [
      input.userId,
      input.symbol.toUpperCase(),
      input.expiration,
      input.side,
      input.windowKey
    ].join(':');
    const cached = this.optionChainCache.get(key);
    if (!input.forceRefresh && cached && nowMs - cached.fetchedAt <= this.optionChainCacheTtlMs) {
      return {
        chain: cached.chain,
        cache: {
          key,
          hit: true,
          ageMs: nowMs - cached.fetchedAt,
          ttlMs: this.optionChainCacheTtlMs
        }
      };
    }

    const marketData = input.marketData || new IbkrMarketDataService(this.fastify);
    const chain = await marketData.getOptionChainSnapshot(
      input.userId,
      input.symbol,
      input.expiration,
      input.side === 'CALL' ? 'call' : 'put'
    );
    this.optionChainCache.set(key, { fetchedAt: nowMs, chain });
    return {
      chain,
      cache: {
        key,
        hit: false,
        ageMs: null,
        ttlMs: this.optionChainCacheTtlMs
      }
    };
  }

  private scoreOptionCandidate(candidate: Omit<OptionQuoteCandidate, 'score' | 'reasons' | 'failedFilters'>, preferredStrike: number, minOptionMark: number, maxBidAskSpreadPct: number, minOptionVolume: number, minOpenInterest: number): { score: number; reasons: string[] } {
    const reasons: string[] = [];
    let score = 100;

    const mark = Number(candidate.mark || 0);
    const spreadPct = candidate.spreadPct === null ? null : Number(candidate.spreadPct);
    const spread = candidate.spread === null ? null : Number(candidate.spread);
    const volume = candidate.volume === null ? null : Number(candidate.volume || 0);
    const openInterest = candidate.openInterest === null ? null : Number(candidate.openInterest || 0);
    const bid = Number(candidate.bid || 0);
    const ask = Number(candidate.ask || 0);
    const absDelta = candidate.delta === null || candidate.delta === undefined ? null : Math.abs(Number(candidate.delta));
    const absTheta = candidate.theta === null || candidate.theta === undefined ? null : Math.abs(Number(candidate.theta));
    const quoteAgeMs = candidate.quoteAgeMs === undefined ? null : candidate.quoteAgeMs;
    const markLastDivergencePct = candidate.markLastDivergencePct === undefined ? null : candidate.markLastDivergencePct;

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

    if (spread !== null && mark > 0) {
      const spreadCostDollars = spread * 100;
      if (spreadCostDollars > 25) {
        score -= Math.min(20, (spreadCostDollars - 25) / 2);
        reasons.push(`spread cost $${spreadCostDollars.toFixed(0)}/contract`);
      } else if (spreadCostDollars <= 10) {
        score += 4;
        reasons.push('low spread cost');
      }
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
    } else if (absDelta < 0.30) {
      score -= Math.min(25, (0.30 - absDelta) * 100);
      reasons.push(`delta too low ${absDelta.toFixed(2)}`);
    } else if (absDelta > 0.65) {
      score -= Math.min(20, (absDelta - 0.65) * 80);
      reasons.push(`delta too high ${absDelta.toFixed(2)}`);
    } else {
      score += Math.max(0, 12 - Math.abs(absDelta - 0.45) * 40);
      if (absDelta >= 0.35 && absDelta <= 0.6) reasons.push('delta in quick-profit band');
    }

    if (quoteAgeMs !== null) {
      if (quoteAgeMs > 10_000) {
        score -= Math.min(50, Math.max(15, (quoteAgeMs - 10_000) / 1_000));
        reasons.push(`stale quote ${Math.round(quoteAgeMs / 1000)}s`);
      } else if (quoteAgeMs <= 2_000) {
        score += 5;
        reasons.push('fresh quote');
      }
    }

    if (markLastDivergencePct !== null) {
      if (markLastDivergencePct > 12) {
        score -= Math.min(35, markLastDivergencePct * 2);
        reasons.push(`unstable mark/last ${markLastDivergencePct.toFixed(1)}%`);
      } else if (markLastDivergencePct <= 3) {
        score += 4;
        reasons.push('stable mark/last');
      }
    }

    if (absTheta !== null && mark > 0) {
      const thetaDragPct = Math.abs(absTheta / mark) * 100;
      if (thetaDragPct > 35) {
        score -= Math.min(35, (thetaDragPct - 35) * 0.8);
        reasons.push(`theta drag ${thetaDragPct.toFixed(1)}%`);
      } else if (thetaDragPct <= 18) {
        score += 3;
        reasons.push('controlled theta drag');
      }
    }

    score -= Math.abs(candidate.strike - preferredStrike) * 2;

    return { score: Number(score.toFixed(2)), reasons };
  }

  private getOptionQuoteAgeMs(quote: any): number | null {
    const rawTimestamp = quote?.timestamp ?? quote?.time ?? quote?.datetime ?? quote?.date ?? quote?.raw?.timestamp ?? quote?.raw?.time ?? quote?.raw?.datetime ?? quote?.raw?.date;
    if (rawTimestamp === null || rawTimestamp === undefined || rawTimestamp === '') return null;
    const numeric = Number(rawTimestamp);
    const timestampMs = Number.isFinite(numeric)
      ? numeric > 1_000_000_000_000 ? numeric : numeric * 1000
      : new Date(rawTimestamp).getTime();
    if (!Number.isFinite(timestampMs)) return null;
    return Math.max(0, Date.now() - timestampMs);
  }

  private getMarkLastDivergencePct(mark: number | null, last: number | null): number | null {
    if (mark === null || last === null || mark <= 0 || last <= 0) return null;
    return Number((Math.abs(mark - last) / mark * 100).toFixed(2));
  }

  private getOptionCandidateFailedFilters(candidate: Omit<OptionQuoteCandidate, 'score' | 'reasons' | 'failedFilters'>, input: {
    minOptionMark: number;
    maxBidAskSpreadPct: number;
    minOptionVolume: number;
    minOpenInterest: number;
  }): string[] {
    const failedFilters: string[] = [];
    const mark = candidate.mark === null ? null : Number(candidate.mark);
    const bid = candidate.bid === null ? null : Number(candidate.bid);
    const ask = candidate.ask === null ? null : Number(candidate.ask);
    const spread = candidate.spread === null ? null : Number(candidate.spread);
    const spreadPct = candidate.spreadPct === null ? null : Number(candidate.spreadPct);
    const volume = candidate.volume === null ? null : Number(candidate.volume);
    const openInterest = candidate.openInterest === null ? null : Number(candidate.openInterest);
    const quoteAgeMs = candidate.quoteAgeMs === undefined ? null : candidate.quoteAgeMs;
    const markLastDivergencePct = candidate.markLastDivergencePct === undefined ? null : candidate.markLastDivergencePct;
    const theta = candidate.theta === null || candidate.theta === undefined ? null : Number(candidate.theta);
    const absDelta = candidate.delta === null || candidate.delta === undefined ? null : Math.abs(Number(candidate.delta));
    const strongVolumeThreshold = Math.max(input.minOptionVolume * 3, 500);
    const hasStrongVolume = volume !== null && Number.isFinite(volume) && volume >= strongVolumeThreshold;

    if (mark === null || !Number.isFinite(mark) || mark < input.minOptionMark) {
      failedFilters.push(mark === null || !Number.isFinite(mark)
        ? 'missing usable mark'
        : `premium below ${input.minOptionMark}`);
    }
    if (bid === null || ask === null || !Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) {
      failedFilters.push('missing usable bid/ask');
    }
    if (spreadPct === null || !Number.isFinite(spreadPct)) {
      failedFilters.push('missing spread');
    } else if (spreadPct > input.maxBidAskSpreadPct) {
      failedFilters.push(`wide spread ${spreadPct.toFixed(1)}%`);
    }
    if (spread !== null && Number.isFinite(spread) && spread * 100 > 35) {
      failedFilters.push(`spread cost $${(spread * 100).toFixed(0)}/contract`);
    }
    if (quoteAgeMs !== null && quoteAgeMs > 15_000) {
      failedFilters.push(`stale quote ${Math.round(quoteAgeMs / 1000)}s`);
    }
    if (markLastDivergencePct !== null && markLastDivergencePct > 15) {
      failedFilters.push(`unstable mark/last ${markLastDivergencePct.toFixed(1)}%`);
    }
    if (absDelta === null || !Number.isFinite(absDelta)) {
      failedFilters.push('delta unavailable');
    } else if (absDelta < 0.30 || absDelta > 0.65) {
      failedFilters.push(`delta outside 0.30-0.65 (${absDelta.toFixed(2)})`);
    }
    if (theta !== null && Number.isFinite(theta) && mark !== null && Number.isFinite(mark) && mark > 0) {
      const thetaDragPct = Math.abs(theta / mark) * 100;
      if (thetaDragPct > 45) failedFilters.push(`theta drag ${thetaDragPct.toFixed(1)}%`);
    }
    if (volume !== null && Number.isFinite(volume) && volume < input.minOptionVolume) {
      failedFilters.push(`volume below ${input.minOptionVolume}`);
    }
    if (openInterest === null || !Number.isFinite(openInterest)) {
      if (!hasStrongVolume) failedFilters.push(`OI unavailable and volume below ${strongVolumeThreshold}`);
    } else if (openInterest < input.minOpenInterest && !hasStrongVolume) {
      failedFilters.push(`OI below ${input.minOpenInterest}`);
    }

    return failedFilters;
  }

  private getCompletedCandles(candles: Candle[], now = new Date(), intervalMinutes = 5): Candle[] {
    const cutoffSeconds = Math.floor((now.getTime() - intervalMinutes * 60 * 1000) / 1000);
    return candles.filter((candle) => candle.timestamp <= cutoffSeconds);
  }

  private fetchBestIBKROptionCandidate(input: {
    chain: OptionChainQuote[];
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
        source: quote?.source ?? 'ibkr_chain',
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
        impliedVolatility: quote?.impliedVolatility ?? null,
        quoteAgeMs: this.getOptionQuoteAgeMs(quote),
        markLastDivergencePct: this.getMarkLastDivergencePct(quote?.mark ?? null, quote?.last ?? null)
      };
      const scored = this.scoreOptionCandidate(
        base,
        input.preferredStrike,
        input.minOptionMark,
        input.maxBidAskSpreadPct,
        input.minOptionVolume,
        input.minOpenInterest
      );
      const failedFilters = this.getOptionCandidateFailedFilters(base, {
        minOptionMark: input.minOptionMark,
        maxBidAskSpreadPct: input.maxBidAskSpreadPct,
        minOptionVolume: input.minOptionVolume,
        minOpenInterest: input.minOpenInterest
      });
      if (
        failedFilters.every((reason) => !reason.startsWith('OI ')) &&
        (base.openInterest === null || Number(base.openInterest) < input.minOpenInterest) &&
        base.volume !== null &&
        Number(base.volume) >= Math.max(input.minOptionVolume * 3, 500)
      ) {
        scored.reasons.push('strong volume offsets open interest gap');
      }
      return { ...base, ...scored, failedFilters };
    }).sort((a, b) => b.score - a.score);

    const selected = ranked.find((candidate) => candidate.failedFilters.length === 0) || null;

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

  private parseOsiTicker(ticker: string): { symbol: string; expiry: string; side: 'CALL' | 'PUT'; strike: number } | null {
    const match = String(ticker || '').replace(/\s+/g, '').toUpperCase().match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
    if (!match) return null;
    const [, symbol, expiry, side, strikeRaw] = match;
    return {
      symbol,
      expiry: `20${expiry.slice(0, 2)}-${expiry.slice(2, 4)}-${expiry.slice(4, 6)}`,
      side: side === 'C' ? 'CALL' : 'PUT',
      strike: Number(strikeRaw) / 1000
    };
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
      const autoTradeMode = settings.auto_trade_mode || 'instant';
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
      } else if (aiSettings.ai_provider === 'ollama') {
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

  private getTargetDayTradeExpiry(nyDateStr: string, nyMinutes: number, expiryMode = 'adaptive'): string {
    const onePmMinutes = 13 * 60;
    const normalizedMode = String(expiryMode || 'adaptive').toLowerCase();
    if (normalizedMode === '0dte') return nyDateStr;
    if (normalizedMode !== '1dte' && nyMinutes < onePmMinutes) return nyDateStr;

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
    if (settings.shadow_trading_enabled === 'true') return true;
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
      if ((targetSettings.auto_trade_mode || 'instant') !== autoTradeMode) continue;

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

  private getTriggerWatchWindowMs(): number {
    const configured = Number(process.env.TRIGGER_WATCH_WINDOW_MS || 10 * 60 * 1000);
    return Number.isFinite(configured) && configured > 0 ? configured : 10 * 60 * 1000;
  }

  private getTriggerWatchPollMs(): number {
    const configured = Number(process.env.TRIGGER_WATCH_POLL_MS || 15_000);
    return Number.isFinite(configured) && configured > 0 ? configured : 15_000;
  }

  private hasEntryTriggerBlocker(blockers: string[]): boolean {
    return blockers.some((blocker) => blocker.includes('entry trigger'));
  }

  private isEntryTriggerHit(input: { tradeBias: string; price: number; entryTrigger: number }): boolean {
    if (input.tradeBias === 'BUY_CALL_ON_DIP') return input.price >= input.entryTrigger;
    if (input.tradeBias === 'BUY_PUT_ON_RIP') return input.price <= input.entryTrigger;
    return true;
  }

  private async fetchUnderlyingSpotPrice(symbol: string): Promise<number | null> {
    const quote = await (yahooFinance as any).quote(symbol);
    return this.finiteNumber(
      quote?.regularMarketPrice ??
      quote?.postMarketPrice ??
      quote?.preMarketPrice ??
      quote?.bid ??
      quote?.ask
    );
  }

  private async validateTriggerEntryQuote(state: TriggerWatchState): Promise<{ mark: number | null; blockers: string[] }> {
    const ticker = state.optionTicker || this.buildOsiTicker(state.symbol, state.chosenExpiry, state.winningSide, state.chosenStrike);
    const contractBlockers = this.buildContractConsistencyBlockers({
      symbol: state.symbol,
      side: state.winningSide,
      expiry: state.chosenExpiry,
      strike: state.chosenStrike,
      ticker
    });
    const quote = await new IbkrMarketDataService(this.fastify).getOptionQuoteForOsi(state.userId, ticker);
    const pricingWarnings: string[] = [...contractBlockers];

    if (!quote) {
      pricingWarnings.push('No usable live option quote selected');
      const executionRealism = this.buildExecutionRealismDiagnostics({
        mark: null,
        spreadPct: null,
        volume: null,
        openInterest: null,
        usingTheoreticalPricing: false,
        pricingWarnings
      });
      return {
        mark: null,
        blockers: this.buildPricingExecutionBlockers({
          chainSelectionRejected: false,
          selectedQuoteAgeMs: null,
          selectedThetaDragPct: null,
          contractConsistencyBlockers: contractBlockers,
          eventRiskBlockers: [],
          pricingWarnings,
          executionRealism
        })
      };
    }

    if (quote.quoteAgeMs !== null && quote.quoteAgeMs > 15_000) {
      pricingWarnings.push(`Option quote stale ${Math.round(quote.quoteAgeMs / 1000)}s`);
    }
    if (quote.spreadPct !== null && quote.spreadPct > 12) {
      pricingWarnings.push(`Spread ${quote.spreadPct}% exceeds ceiling 12%`);
    }
    const executionRealism = this.buildExecutionRealismDiagnostics({
      mark: quote.mark,
      spreadPct: quote.spreadPct,
      volume: null,
      openInterest: null,
      usingTheoreticalPricing: false,
      pricingWarnings
    });

    return {
      mark: quote.mark,
      blockers: this.buildPricingExecutionBlockers({
        chainSelectionRejected: false,
        selectedQuoteAgeMs: quote.quoteAgeMs,
        selectedThetaDragPct: null,
        contractConsistencyBlockers: contractBlockers,
        eventRiskBlockers: [],
        pricingWarnings,
        executionRealism
      })
    };
  }

  private startTriggerWatch(state: TriggerWatchState) {
    const existing = this.triggerWatchers.get(state.signalId);
    if (existing) clearTimeout(existing);

    this.fastify.pg.query(
      `UPDATE signals
       SET status = 'PENDING_TRIGGER'
       WHERE id = $1 AND status = 'PENDING'`,
      [state.signalId]
    ).catch((err: any) => {
      this.fastify.log.warn(`[SignalScannerService] Failed to mark signal #${state.signalId} pending trigger: ${err.message || String(err)}`);
    });

    TradeRedisService.recordEvent(this.fastify.pg, {
      userId: state.userId,
      signalId: state.signalId,
      eventType: 'SIGNAL_TRIGGER_WATCH_STARTED',
      message: `${state.symbol} ${state.winningSide} waiting for entry trigger ${state.entryTrigger.toFixed(2)}`,
      metadata: {
        symbol: state.symbol,
        side: state.winningSide,
        tradeBias: state.tradeBias,
        entryTrigger: state.entryTrigger,
        expiresAt: new Date(state.expiresAtMs).toISOString()
      }
    }).catch((err: any) => {
      this.fastify.log.warn(`[SignalScannerService] Failed to record trigger watch event for #${state.signalId}: ${err.message || String(err)}`);
    });

    this.scheduleTriggerWatchTick(state, 0);
  }

  private scheduleTriggerWatchTick(state: TriggerWatchState, delayMs = this.getTriggerWatchPollMs()) {
    const timer = setTimeout(() => {
      this.evaluateTriggerWatch(state).catch((err: any) => {
        this.fastify.log.warn(`[SignalScannerService] Trigger watch failed for signal #${state.signalId}: ${err.message || String(err)}`);
        this.triggerWatchers.delete(state.signalId);
      });
    }, delayMs);
    this.triggerWatchers.set(state.signalId, timer);
  }

  private async cancelTriggerWatch(state: TriggerWatchState, reason: string, eventType = 'SIGNAL_TRIGGER_WATCH_CANCELLED') {
    const timer = this.triggerWatchers.get(state.signalId);
    if (timer) clearTimeout(timer);
    this.triggerWatchers.delete(state.signalId);
    await this.fastify.pg.query(
      `UPDATE signals
       SET status = 'CANCELLED',
           no_trade_reasons = array_append(COALESCE(no_trade_reasons, ARRAY[]::TEXT[]), $2)
       WHERE id = $1 AND status IN ('PENDING', 'PENDING_TRIGGER')`,
      [state.signalId, reason]
    );
    await TradeRedisService.recordEvent(this.fastify.pg, {
      userId: state.userId,
      signalId: state.signalId,
      eventType,
      message: reason,
      metadata: {
        symbol: state.symbol,
        side: state.winningSide,
        tradeBias: state.tradeBias,
        entryTrigger: state.entryTrigger,
        armedPrice: state.armedPrice
      }
    });
  }

  private async evaluateTriggerWatch(state: TriggerWatchState) {
    const statusResult = await this.fastify.pg.query('SELECT status FROM signals WHERE id = $1', [state.signalId]);
    const status = statusResult.rows[0]?.status;
    if (!status || !['PENDING', 'PENDING_TRIGGER'].includes(status)) {
      this.triggerWatchers.delete(state.signalId);
      return;
    }

    const now = Date.now();
    if (now >= state.expiresAtMs) {
      await this.cancelTriggerWatch(state, `Entry trigger was not confirmed before watch expired`, 'SIGNAL_TRIGGER_WATCH_EXPIRED');
      return;
    }

    const price = await this.fetchUnderlyingSpotPrice(state.symbol);
    if (price === null) {
      this.scheduleTriggerWatchTick(state);
      return;
    }

    const triggerHit = this.isEntryTriggerHit({ tradeBias: state.tradeBias, price, entryTrigger: state.entryTrigger });
    if (!triggerHit) {
      if (state.armedAtMs !== null) {
        await this.cancelTriggerWatch(state, `Entry trigger failed after first touch; ${state.symbol} is back at ${price.toFixed(2)}`, 'SIGNAL_TRIGGER_FAILED');
        return;
      }
      this.scheduleTriggerWatchTick(state);
      return;
    }

    if (state.armedAtMs === null) {
      this.scheduleTriggerWatchTick({
        ...state,
        armedAtMs: now,
        armedPrice: price
      });
      return;
    }

    const quoteValidation = await this.validateTriggerEntryQuote(state);
    if (quoteValidation.blockers.length > 0) {
      await this.cancelTriggerWatch(state, quoteValidation.blockers.join('; '), 'SIGNAL_TRIGGER_QUOTE_BLOCKED');
      return;
    }

    const timer = this.triggerWatchers.get(state.signalId);
    if (timer) clearTimeout(timer);
    this.triggerWatchers.delete(state.signalId);
    const updateResult = await this.fastify.pg.query(
      `UPDATE signals
       SET status = 'PENDING',
           current_price = $2,
           option_details = jsonb_set(COALESCE(option_details, '{}'::jsonb), '{triggerWatch}', $3::jsonb, true)
       WHERE id = $1 AND status IN ('PENDING', 'PENDING_TRIGGER')`,
      [state.signalId, price, JSON.stringify({
        confirmedAt: new Date(now).toISOString(),
        confirmedPrice: price,
        armedAt: state.armedAtMs ? new Date(state.armedAtMs).toISOString() : null,
        armedPrice: state.armedPrice,
        quoteMark: quoteValidation.mark
      })]
    );
    if ((updateResult.rowCount || 0) === 0) {
      return;
    }
    await TradeRedisService.recordEvent(this.fastify.pg, {
      userId: state.userId,
      signalId: state.signalId,
      eventType: 'SIGNAL_TRIGGER_CONFIRMED',
      message: `${state.symbol} ${state.winningSide} trigger confirmed at ${price.toFixed(2)}`,
      metadata: {
        symbol: state.symbol,
        side: state.winningSide,
        tradeBias: state.tradeBias,
        entryTrigger: state.entryTrigger,
        price,
        quoteMark: quoteValidation.mark
      }
    });

    await this.executeSignalForEligibleUsers({
      userId: state.userId,
      signalId: state.signalId,
      symbol: state.symbol,
      winningSide: state.winningSide,
      chosenStrike: state.chosenStrike,
      chosenExpiry: state.chosenExpiry,
      stopUnderlying: state.stopUnderlying,
      targetUnderlying: state.targetUnderlying,
      mark: quoteValidation.mark ?? state.mark,
      settings: state.settings,
      autoTradeMode: state.autoTradeMode
    });
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
    const currentPrice = Number(signal.current_price);
    const winningSide = signal.signal_type === 'PUT' ? 'PUT' : 'CALL';
    return this.executeSignalWithConfiguredBroker({
      userId,
      signalId,
      symbol: signal.symbol,
      winningSide,
      chosenStrike: Number(optionDetails.strike || Math.round(currentPrice)),
      chosenExpiry: optionDetails.expiry
        || signal.option_expiration_date
        || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
      stopUnderlying: Number(signal.stop_loss || currentPrice * 0.99),
      targetUnderlying: Number(signal.target_price || currentPrice * 1.01),
      mark: optionDetails.mark != null ? Number(optionDetails.mark) : null,
      settings: settingsOverride
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
