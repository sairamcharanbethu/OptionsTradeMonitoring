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

export class SignalScannerService {
  private fastify: FastifyInstance;
  private aiService: AIService;
  private isRunning: boolean = false;
  private timerId: NodeJS.Timeout | null = null;
  private newsWarmTimerId: NodeJS.Timeout | null = null;
  private scanIntervalMs: number = 5 * 60 * 1000; // 5 minutes

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
  // Fetches news + runs Llama classification and caches results in Redis.
  // When enrichSignalAsync runs, it finds everything pre-cached → only needs Claude.

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

    const key = await this.getAiApiKey(settings.day_trading_ai_provider);
    if (!key) return;

    const symbols: string[] = settings.day_trading_symbols
      .split(',')
      .map((s: string) => s.trim().toUpperCase())
      .filter(Boolean);

    // Get today's NY date string
    const nyDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD

    for (const symbol of symbols) {
      await this.preWarmSymbol(symbol, nyDate, key, settings).catch((e: any) =>
        this.fastify.log.warn(`[NewsPreWarm] Failed for ${symbol}: ${e.message}`)
      );
    }
  }

  /**
   * Pre-warms news cache for a single symbol:
   *   1. Fetches Yahoo Finance + FinancialJuice RSS
   *   2. Computes fingerprint — skips Llama if headlines haven't changed
   *   3. Runs Llama 3.1 70B classification → caches verdict in Redis
   * Result: enrichSignalAsync skips steps 1–3 and only calls Claude Sonnet.
   */
  private async preWarmSymbol(
    symbol: string,
    nyDateStr: string,
    apiKey: string,
    settings: any
  ): Promise<void> {
    const { headlines } = await this.fetchNewsContext(symbol);

    const newFingerprint = this.getNewsFingerprint(headlines);
    const fpRedisKey = `NEWS_FP:${symbol}:${nyDateStr}`;
    const cachedFp = await redis.get(fpRedisKey);

    if (cachedFp === newFingerprint) {
      this.fastify.log.info(`[NewsPreWarm] ${symbol} headlines unchanged — fingerprint match, skipping Llama.`);
      return; // Nothing to do, cache is still fresh
    }

    // Headlines changed — update fingerprint and re-run Llama
    await redis.set(fpRedisKey, newFingerprint, 1800);

    if (headlines.length === 0) {
      await redis.set(
        `NEWS_VERDICT:${symbol}:${nyDateStr}`,
        JSON.stringify({ verdict: 'NEUTRAL', rationale: 'No material news.' }),
        1800
      );
      this.fastify.log.info(`[NewsPreWarm] ${symbol} — no headlines, cached NEUTRAL verdict.`);
      return;
    }

    const classifierModel = settings.day_trading_ai_model || 'meta-llama/llama-3.1-70b-instruct';
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
      const res = await this.callModelDirect(classifierModel, apiKey, classifierPrompt, 150);
        await redis.set(
          `NEWS_VERDICT:${symbol}:${nyDateStr}`,
          JSON.stringify({
            verdict: res.verdict,
            rationale: res.rationale || res.analysis || '',
            usage: res.usage || null
          }),
          1800
        );
        this.fastify.log.info(`[NewsPreWarm] ${symbol} pre-warmed: ${res.verdict} — ${res.rationale || ''} | Tokens: ${res.usage?.total_tokens || 0}`);
    } catch (e: any) {
      this.fastify.log.warn(`[NewsPreWarm] Llama failed for ${symbol}: ${e.message}`);
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
    // 1. Try to find the first user who has polygon_api_key set in the settings table
    const { rows } = await this.fastify.pg.query(`
      SELECT user_id 
      FROM settings 
      WHERE key = 'polygon_api_key' AND value IS NOT NULL AND value != '' 
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

  public async scanAllActiveUsers() {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      const primaryUserId = await this.getPrimaryUserId();
      try {
        await this.scanForUser(primaryUserId);
      } catch (userErr: any) {
        this.fastify.log.error(`[SignalScannerService] Universal scan failed for user ${primaryUserId}: ${userErr.message}`);
      }
    } catch (err: any) {
      this.fastify.log.error(`[SignalScannerService] Failed to execute universal scan: ${err.message}`);
    } finally {
      this.isRunning = false;
    }
  }

  public async getSettingsForUser(userId: number) {
    const { rows } = await this.fastify.pg.query(
      'SELECT key, value FROM settings WHERE user_id = $1',
      [userId]
    );

    const dbSettings = rows.reduce((acc: any, r: any) => {
      acc[r.key] = r.value;
      return acc;
    }, {});

    const defaults = {
      day_trading_enabled: 'true',
      day_trading_symbols: 'QQQ,SPY',
      polygon_api_key: '',
      sscgex_password: '',
      discord_webhook_url: '',
      discord_alerts_enabled: 'false',
      trading_start_time: '09:30',
      trading_cutoff_time: '16:00',
      strike_offset: '0',
      min_signal_score: '70',
      day_trading_ai_enabled: 'true',
      day_trading_ai_provider: 'openrouter',
      day_trading_ai_model: 'meta-llama/llama-3.1-70b-instruct',  // news classifier
      day_trading_coach_model: 'anthropic/claude-sonnet-4-5',       // signal coach
      alpaca_auto_trade: 'false',
      alpaca_auto_trade_mode: 'instant'
    };

    return { ...defaults, ...dbSettings };
  }

  private async scanForUser(userId: number) {
    const settings = await this.getSettingsForUser(userId);
    if (settings.day_trading_enabled !== 'true') return;

    // Auto turn off scanning after 4:30 PM ET (990 minutes)
    const now = new Date();
    const nyParts = this.getNyDateParts(now);
    const cutoffMinutes = 16 * 60 + 30; // 16:30 = 990 minutes

    if (nyParts.minutes >= cutoffMinutes) {
      this.fastify.log.info(`[SignalScannerService] Current Eastern Time is past 4:30 PM ET (${nyParts.hour}:${nyParts.minute}). Auto-disabling day trading scanner for user ${userId}.`);
      
      await this.fastify.pg.query(
        `INSERT INTO settings (user_id, key, value, updated_at) 
         VALUES ($1, 'day_trading_enabled', 'false', CURRENT_TIMESTAMP) 
         ON CONFLICT (user_id, key) DO UPDATE 
         SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
        [userId]
      );
      await redis.set(`USER_SETTINGS:${userId}`, '', 1);

      if (this.fastify.websocketServer) {
        this.fastify.websocketServer.clients.forEach((client: any) => {
          if (client.readyState === 1) {
            client.send(JSON.stringify({ type: 'SETTINGS_UPDATED', data: { userId } }));
          }
        });
      }
      return;
    }

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
    const startMinutes = this.parseTimeStr(settings.trading_start_time);
    const cutoffMinutes = this.parseTimeStr(settings.trading_cutoff_time);
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

    // 4. Fetch VIX Quote
    let vixPrice: number | null = null;
    let vixPreviousClose: number | null = null;
    let vixChangePct: number | null = null;

    try {
      const vixData = await (yahooFinance as any).quote('^VIX');
      vixPrice = vixData.regularMarketPrice ?? null;
      vixPreviousClose = vixData.regularMarketPreviousClose ?? null;
      if (vixPrice && vixPreviousClose) {
        vixChangePct = ((vixPrice - vixPreviousClose) / vixPreviousClose) * 100;
      }
    } catch (vixErr: any) {
      this.fastify.log.warn(`[SignalScannerService] Failed to fetch VIX: ${vixErr.message}`);
    }

    if (vixPrice === null) {
      noTradeReasons.push('VIX data unavailable from Yahoo response');
    }

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
    const winningSide = callScore >= putScore ? 'CALL' : 'PUT';
    const winningScore = winningSide === 'CALL' ? callScore : putScore;

    // Afternoon threshold inflation
    let dynamicMinScore = Number(settings.min_signal_score);
    if (currentMinutes >= 13 * 60 + 30) {
      dynamicMinScore += 15;
    }

    // 7. Check Volatility & Wall Blockers
    const volatilityBlockers = [];
    const maxVixForCalls = 24;
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
    } else if (qqqGexRegime === 'POSITIVE' || currentPrice > vwap) {
      computedRegime = 'BULLISH';
    } else if (qqqGexRegime === 'NEGATIVE' || currentPrice < vwap) {
      computedRegime = 'BEARISH';
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

      // Fetch ATM option contract using Polygon API
      const polygonApiKey = settings.polygon_api_key;
      const strikeOffset = parseInt(settings.strike_offset, 10) || 0;
      const todayDateStr = nyParts.dateStr;

      let chosenContract: any = null;

      if (polygonApiKey) {
        try {
          const contractsRes = await axios.get('https://api.polygon.io/v3/reference/options/contracts', {
            params: {
              underlying_ticker: symbol,
              contract_type: winningSide === 'CALL' ? 'call' : 'put',
              expiration_date: todayDateStr,
              limit: 250,
              sort: 'strike_price',
              order: 'asc',
              apikey: polygonApiKey
            },
            timeout: 8000
          });

          const contracts = (contractsRes.data as any).results || [];
          if (contracts.length > 0) {
            // Parse contracts
            const parsed = contracts
              .map((c: any) => ({
                ticker: c.ticker,
                strike: Number(c.strike_price),
                expiry: c.expiration_date
              }))
              .filter((c: any) => !isNaN(c.strike))
              .sort((a: any, b: any) => a.strike - b.strike);

            // Find closest ATM strike index
            let atmIdx = 0;
            let minDistance = Infinity;
            for (let i = 0; i < parsed.length; i++) {
              const dist = Math.abs(parsed[i].strike - currentPrice);
              if (dist < minDistance) {
                minDistance = dist;
                atmIdx = i;
              }
            }

            // Adjust by offset
            let chosenIdx = atmIdx;
            if (winningSide === 'CALL') {
              chosenIdx = atmIdx + strikeOffset;
            } else {
              chosenIdx = atmIdx - strikeOffset;
            }

            chosenIdx = Math.max(0, Math.min(parsed.length - 1, chosenIdx));
            chosenContract = parsed[chosenIdx];
          }
        } catch (contractErr: any) {
          this.fastify.log.warn(`[SignalScannerService] Polygon reference option call failed: ${contractErr.message}`);
        }
      }

      // 8. Contract pricing (Alpaca live snapshot -> Polygon snapshot -> Black-Scholes fallback)
      let bid: number | null = null;
      let ask: number | null = null;
      let spread: number | null = null;
      let spreadPct: number | null = null;
      let mark: number | null = null;
      let volume: number | null = null;
      let openInterest: number | null = null;
      let usingTheoreticalPricing = true;

      const defaultContractName = `${symbol}${todayDateStr.replace(/-/g, '').slice(2)}${winningSide === 'CALL' ? 'C' : 'P'}${Math.round(currentPrice)}`;
      optionTicker = chosenContract?.ticker || defaultContractName;
      chosenStrike = chosenContract?.strike || Math.round(currentPrice);
      chosenExpiry = chosenContract?.expiry || todayDateStr;

      // Try fetching live option contract snapshot from Alpaca API if credentials exist
      const alpacaKeyId = settings.alpaca_key_id?.trim();
      const alpacaSecretKey = settings.alpaca_secret_key?.trim();

      if (alpacaKeyId && alpacaSecretKey && chosenContract) {
        try {
          const alpacaTicker = chosenContract.ticker.replace(/^O:/, '');
          this.fastify.log.info(`[SignalScannerService] Querying Alpaca live option snapshot for ${alpacaTicker}...`);
          const alpacaRes = await axios.get(`https://data.alpaca.markets/v1beta1/options/snapshots?symbols=${alpacaTicker}`, {
            headers: {
              'APCA-API-KEY-ID': alpacaKeyId,
              'APCA-API-SECRET-KEY': alpacaSecretKey
            },
            timeout: 8000
          });

          const snapData = alpacaRes.data as any;
          const snap = snapData.snapshots?.[alpacaTicker];
          if (snap) {
            bid = snap.latestQuote?.bp || null;
            ask = snap.latestQuote?.ap || null;
            if (bid !== null && ask !== null && bid > 0 && ask > 0) {
              spread = ask - bid;
              const mid = (bid + ask) / 2;
              mark = Number(mid.toFixed(2));
              spreadPct = Number(((spread / mid) * 100).toFixed(2));
              usingTheoreticalPricing = false;
            } else if (snap.latestTrade?.p) {
              mark = snap.latestTrade.p;
              usingTheoreticalPricing = false;
            }
            volume = snap.day?.volume ?? null;
            openInterest = snap.open_interest ?? null;
            this.fastify.log.info(`[SignalScannerService] Alpaca live option price fetched successfully: mark=$${mark}, bid=$${bid}, ask=$${ask}`);
          }
        } catch (alpacaErr: any) {
          this.fastify.log.warn(`[SignalScannerService] Alpaca option snapshot query failed: ${alpacaErr.message}`);
        }
      }

      if (usingTheoreticalPricing && polygonApiKey && chosenContract) {
        try {
          const snapRes = await axios.get(`https://api.polygon.io/v3/snapshot/options/${symbol}/${chosenContract.ticker}`, {
            params: { apikey: polygonApiKey },
            timeout: 8000
          });

          const snapData = snapRes.data as any;
          if (snapData && snapData.status !== 'NOT_AUTHORIZED' && snapData.results) {
            const snap = snapData.results;
            const quote = snap.last_quote || {};
            bid = this.toNumber(quote.bid);
            ask = this.toNumber(quote.ask);
            if (bid !== null && ask !== null) {
              spread = ask - bid;
              const mid = (bid + ask) / 2;
              mark = Number(mid.toFixed(2));
              spreadPct = Number(((spread / mid) * 100).toFixed(2));
              usingTheoreticalPricing = false;
            }
            volume = snap.day?.volume ?? null;
            openInterest = snap.open_interest ?? null;
          }
        } catch (snapErr: any) {
          this.fastify.log.warn(`[SignalScannerService] Polygon option snapshot failed: ${snapErr.message}`);
        }
      }

      if (usingTheoreticalPricing) {
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
      const minOptionMark = 0.30;
      const maxBidAskSpreadPct = 12;
      const minOptionVolume = 200;
      const minOpenInterest = 500;

      const pricingWarnings: string[] = [];
      if (mark !== null && mark < minOptionMark) pricingWarnings.push(`Option premium $${mark} below limit $${minOptionMark}`);
      if (spreadPct !== null && spreadPct > maxBidAskSpreadPct) pricingWarnings.push(`Spread ${spreadPct}% exceeds ceiling ${maxBidAskSpreadPct}%`);
      if (volume !== null && volume < minOptionVolume) pricingWarnings.push(`Volume ${volume} below minimum ${minOptionVolume}`);
      if (openInterest !== null && openInterest < minOpenInterest) pricingWarnings.push(`Open interest ${openInterest} below minimum ${minOpenInterest}`);

      // Apply score adjustments for warnings
      let finalConfidence = Math.max(0, Math.min(100, winningScore - pricingWarnings.length * 10));

      let setupGrade = '🎲 B / LOTTO';
      if (finalConfidence === 100) {
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
        suggestedStopLoss: optionStopLoss,
        suggestedTakeProfit: optionTakeProfit,
        usingTheoreticalPricing
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
          vixChangePercent: vixChangePct
        }),
        noTradeReasons,
        chosenExpiry,
        nyParts.marketDate,
        mlProbability,
        JSON.stringify(pricingData)
      ]);

      const signalId: number = insertResult.rows[0].id;
      this.fastify.log.info(`[SignalScannerService] Signal #${signalId} saved instantly for ${symbol} ${winningSide} with ML Probability: ${mlProbability}.`);

      // Broadcast new signal via WebSocket
      if (this.fastify.websocketServer) {
        this.fastify.websocketServer.clients.forEach((client: any) => {
          if (client.readyState === 1) {
            client.send(JSON.stringify({ type: 'NEW_SIGNAL', data: { id: signalId, symbol } }));
          }
        });
      }

      // ── Alpaca Auto-Trade Execution (Instant Entry, pre-AI) ──
      const autoTradeMode = settings.alpaca_auto_trade_mode || 'instant';
      if (settings.alpaca_auto_trade === 'true' && autoTradeMode === 'instant') {
        setImmediate(() => {
          this.executeAlpacaPaperTrade(
            userId,
            symbol,
            winningSide as 'CALL' | 'PUT',
            chosenStrike as number,
            chosenExpiry || '',
            stopUnderlying,
            targetUnderlying,
            mark,
            signalId
          ).catch((err: any) => {
            this.fastify.log.error(`[SignalScannerService] Alpaca instant auto-execution failed for signal #${signalId}: ${err.message}`);
          });
        });
      }

      // ── STEP 2: Discord – signal alert fires immediately, no AI wait ──
      if (settings.discord_alerts_enabled === 'true' && settings.discord_webhook_url) {
        try {
          const mlProbStr = mlProbability !== null ? ` | ML Prob **${Math.round(mlProbability * 100)}%**` : '';
          const premEntryStr = mark !== null ? `$${mark.toFixed(2)}` : 'N/A';
          const premSlStr = optionStopLoss !== null ? `$${optionStopLoss.toFixed(2)}` : 'N/A';
          const premTpStr = optionTakeProfit !== null ? `$${optionTakeProfit.toFixed(2)}` : 'N/A';
          const embedMessage = {
            content: `🚨 **${symbol} $${chosenStrike}${winningSide === 'CALL' ? 'C' : 'P'}** | ${tradeBias}\n📍 Entry >$${entryTrigger.toFixed(2)} | SL $${stopUnderlying} | TP $${targetUnderlying}\n💰 Premium: Entry: ${premEntryStr} | SL: ${premSlStr} | TP: ${premTpStr}\n🎯 Score **${finalConfidence}** (${setupGrade})${mlProbStr}`
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
            chosenExpiry: chosenExpiry || ''
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

  /**
   * Two-stage AI enrichment pipeline. Runs in the background after signal INSERT.
   *
   * Stage 1 — Meta-Llama 3.1 70B (cheap, fast):
   *   Classifies macro news as RISK_ON / RISK_OFF / NEUTRAL relative to signal direction.
   *   Uses Redis fingerprint to skip if headlines haven't changed since last cycle.
   *
   * Stage 2 — Claude Sonnet (signal understanding):
   *   Writes the full coaching commentary combining signal technicals + Llama's macro verdict.
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
  }): Promise<void> {
    const {
      signalId, symbol, winningSide, chosenStrike, currentPrice, vwap, emaShort, emaLong,
      qqqGexRegime, qqqFlowDirection, stopUnderlying, targetUnderlying, finalConfidence,
      setupGrade, entryTrigger, nyDateStr, settings, userId, mark, chosenExpiry
    } = ctx;

    const key = await this.getAiApiKey(settings.day_trading_ai_provider);
    if (!key) {
      this.fastify.log.warn(`[SignalScannerService] No API key — skipping AI enrichment for signal #${signalId}`);
      return;
    }

    // ── Check pre-warmed cache first (set by news pre-warm loop) ─────────────
    // If the pre-warm job already fetched news + ran Llama, we skip both steps
    // and go straight to Claude Sonnet — cutting latency from ~25s to ~4s.
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
        this.fastify.log.info(`[SignalScannerService] Using pre-warmed cache for ${symbol}: ${macroVerdict} — skipping fetch+Llama.`);
      } catch { /* use defaults */ }

      // Fetch raw text for DB/display (lightweight, no AI call)
      const { raw } = await this.fetchNewsContext(symbol).catch(() => ({ headlines: [], raw: 'News context unavailable.' }));
      newsContextText = raw;
    } else {
      // ❌ Cache miss (first run or race): fall back to reactive fetch + classify
      this.fastify.log.info(`[SignalScannerService] Pre-warm cache miss for ${symbol} — running reactive fetch+Llama.`);
      const { headlines: h, raw } = await this.fetchNewsContext(symbol);
      headlines = h;
      newsContextText = raw;

      newFingerprint = this.getNewsFingerprint(headlines);
      const fpRedisKey = `NEWS_FP:${symbol}:${nyDateStr}`;
      const cachedFp = await redis.get(fpRedisKey);
      const headlinesChanged = cachedFp !== newFingerprint;

      if (headlines.length > 0 && (headlinesChanged || !cachedFp)) {
        await redis.set(fpRedisKey, newFingerprint, 1800);

        const classifierModel = settings.day_trading_ai_model || 'meta-llama/llama-3.1-70b-instruct';
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
          const llamaRes = await this.callModelDirect(
            classifierModel, key, classifierPrompt, 150
          );
          if (llamaRes.verdict && ['RISK_ON', 'RISK_OFF', 'NEUTRAL'].includes(llamaRes.verdict)) {
            macroVerdict = llamaRes.verdict;
            macroRationale = llamaRes.rationale || llamaRes.analysis || macroRationale;
            llamaUsage = llamaRes.usage || null;
          }
          this.fastify.log.info(`[SignalScannerService] Llama macro verdict for ${symbol}: ${macroVerdict} — ${macroRationale} | Tokens: ${llamaRes.usage?.total_tokens || 0}`);
        } catch (llamaErr: any) {
          this.fastify.log.warn(`[SignalScannerService] Llama classifier failed: ${llamaErr.message}`);
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
      JSON.stringify({ verdict: macroVerdict, rationale: macroRationale }),
      1800
    );

    // ── Stage 2: Claude Sonnet — full signal coaching ─────────────────────────
    // Check if we have a cached coaching commentary and verdict for this fingerprint
    const commentaryCacheKey = `COACHING_DATA:${symbol}:${newFingerprint}`;
    const cachedData = await redis.get(commentaryCacheKey);
    let finalCommentary = '';
    let finalVerdict = 'WAIT';

    if (cachedData) {
      try {
        const parsed = JSON.parse(cachedData);
        finalCommentary = parsed.analysis || '';
        finalVerdict = parsed.verdict || 'WAIT';
        this.fastify.log.info(`[SignalScannerService] Reusing cached coaching commentary and verdict (${finalVerdict}) for signal #${signalId}`);
      } catch {
        finalCommentary = cachedData;
      }
    }

    if (!finalCommentary) {
      const coachModel = settings.day_trading_coach_model || 'anthropic/claude-sonnet-4-5';

      // Macro context badge for Sonnet
      const macroBadge =
        macroVerdict === 'RISK_OFF' ? `⚠️ MACRO RISK-OFF: ${macroRationale}` :
        macroVerdict === 'RISK_ON'  ? `✅ MACRO RISK-ON: ${macroRationale}` :
        `ℹ️ MACRO NEUTRAL: ${macroRationale}`;

      const nowNyParts = this.getNyDateParts(new Date());
      const formattedTimeStr = `${nowNyParts.hour.toString().padStart(2, '0')}:${nowNyParts.minute.toString().padStart(2, '0')} ET`;

      const coachPrompt = `You are an expert 0DTE options coach at StockSurfer Capital. Analyze this signal and produce a one-sentence recommendation for a novice trader.

SIGNAL: ${symbol} ${winningSide} $${chosenStrike}
SIGNAL TIME: ${formattedTimeStr} (Date: ${nyDateStr})
Price $${currentPrice.toFixed(2)} | VWAP $${vwap.toFixed(2)} | EMA9 ${emaShort?.toFixed(2)} | EMA21 ${emaLong?.toFixed(2)}
GEX Regime: ${qqqGexRegime} | Flow: ${qqqFlowDirection}
Entry >$${entryTrigger} | SL $${stopUnderlying} | TP $${targetUnderlying}
Score: ${finalConfidence}% | ${setupGrade}

ECONOMIC CALENDAR:
${getEconomicCalendarContext(nyDateStr)}

MACRO CONTEXT (classified by Llama 3.1):
${macroBadge}

RECENT HEADLINES:
${headlines.length > 0 ? headlines.map((h, i) => `${i + 1}. ${h}`).join('\n') : 'None in last 6h.'}

Write a single-sentence recommendation (maximum 25 words) advising whether the trader should HOLD (for a bounce/target), SELL (to take profit or cut loss), or WAIT/ABORT under specific technical conditions. Keep it clear, concise, and direct.

Respond JSON: {"verdict":"GO|WAIT|ABORT","analysis":"your single-sentence recommendation here"}`;

      try {
        const sonnetRes = await this.callModelDirect(coachModel, key, coachPrompt, 800);
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
        this.fastify.log.info(`[SignalScannerService] Sonnet coaching ready for signal #${signalId}: ${finalVerdict} | Tokens: ${sonnetRes.usage?.total_tokens || 0}`);
      } catch (sonnetErr: any) {
        this.fastify.log.error(`[SignalScannerService] Sonnet coach failed for #${signalId}: ${sonnetErr.message}`);
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

      // ── Alpaca Auto-Trade Execution (AI-Confirmed Entry, post-AI) ──
      const autoTradeMode = settings.alpaca_auto_trade_mode || 'instant';
      if (finalVerdict === 'GO' && settings.alpaca_auto_trade === 'true' && autoTradeMode === 'ai_confirmed') {
        await this.executeAlpacaPaperTrade(
          userId,
          symbol,
          winningSide as 'CALL' | 'PUT',
          chosenStrike,
          chosenExpiry,
          stopUnderlying,
          targetUnderlying,
          mark,
          signalId
        );
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
          content: `🧠 **AI Coach · ${symbol} #${signalId}** ${macroIcon} Macro: ${macroVerdict}\n\n${finalCommentary}`
        }, { timeout: 8000 });
      } catch (discErr: any) {
        this.fastify.log.error(`[SignalScannerService] Discord coaching follow-up failed: ${discErr.message}`);
      }
    }
  }

  /**
   * Direct OpenRouter call with an explicit model — used for multi-model routing
   * (Llama for classification, Claude for coaching) without going through AIService's
   * settings-based routing which only reads a single model from the DB.
   */
  private async callModelDirect(
    model: string,
    apiKey: string,
    prompt: string,
    maxTokens: number
  ): Promise<{ verdict: string; analysis: string; [key: string]: any }> {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'http://localhost:3000',
        'X-Title': 'OptionsTradeMonitor',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'You are a concise trading bot. Respond ONLY with valid JSON.' },
          { role: 'user', content: prompt }
        ],
        response_format: { type: 'json_object' },
        temperature: 0,
        max_tokens: maxTokens
      })
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OpenRouter [${model}] error ${response.status}: ${err}`);
    }

    const data = await response.json() as any;
    const text: string = data.choices?.[0]?.message?.content || '{}';
    try {
      const parsed = JSON.parse(text.trim());
      return {
        verdict: parsed.verdict || 'UNKNOWN',
        analysis: parsed.analysis || parsed.rationale || parsed.summary || text,
        usage: data.usage || null,
        ...parsed
      };
    } catch {
      return { verdict: 'Review', analysis: text, usage: data.usage || null };
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

    // If the logged-in user hasn't configured keys, try using the primary user settings
    if (!settings.polygon_api_key && !settings.sscgex_password) {
      const primaryId = await this.getPrimaryUserId();
      if (primaryId !== userId) {
        const primarySettings = await this.getSettingsForUser(primaryId);
        if (primarySettings.polygon_api_key || primarySettings.sscgex_password) {
          targetUserId = primaryId;
          settings = primarySettings;
        }
      }
    }

    const checkLatency = async (fn: () => Promise<void>, isConfigured = true): Promise<{ status: string; latencyMs: number }> => {
      if (!isConfigured) {
        return { status: 'N/A', latencyMs: 0 };
      }
      const start = Date.now();
      try {
        await fn();
        return { status: 'UP', latencyMs: Date.now() - start };
      } catch (e) {
        return { status: 'DOWN', latencyMs: Date.now() - start };
      }
    };

    const yahooCheck = checkLatency(async () => {
      await (yahooFinance as any).quote('QQQ');
    });

    const sscgexCheck = checkLatency(async () => {
      const tokenRes = await axios.post('https://sscgex.up.railway.app/api/auth', {
        password: settings.sscgex_password
      }, { timeout: 4000 });
      const token = (tokenRes.data as any).token;
      await axios.get('https://sscgex.up.railway.app/api/gex/QQQ?strikes=10', {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 4000
      });
    }, !!settings.sscgex_password);

    const polygonCheck = checkLatency(async () => {
      await axios.get('https://api.polygon.io/v3/reference/options/contracts', {
        params: { underlying_ticker: 'QQQ', limit: 1, apikey: settings.polygon_api_key },
        timeout: 4000
      });
    }, !!settings.polygon_api_key);

    const openrouterCheck = checkLatency(async () => {
      const key = await this.getAiApiKey(settings.day_trading_ai_provider);
      if (key) {
        await axios.get('https://openrouter.ai/api/v1/models', {
          headers: { Authorization: `Bearer ${key}` },
          timeout: 4000
        });
      } else {
        throw new Error('No Key');
      }
    }, settings.day_trading_ai_provider === 'openrouter');

    const discordCheck = checkLatency(async () => {
      await axios.get(settings.discord_webhook_url, { timeout: 4000 });
    }, !!settings.discord_webhook_url);

    const alpacaCheck = checkLatency(async () => {
      const keyId = settings.alpaca_key_id?.trim();
      const secretKey = settings.alpaca_secret_key?.trim();
      if (keyId && secretKey) {
        const res = await fetch('https://paper-api.alpaca.markets/v2/account', {
          headers: {
            'APCA-API-KEY-ID': keyId,
            'APCA-API-SECRET-KEY': secretKey
          }
        });
        if (!res.ok) {
          throw new Error(`Alpaca API returned status ${res.status}`);
        }
      } else {
        throw new Error('Alpaca key/secret not set');
      }
    }, !!settings.alpaca_key_id && !!settings.alpaca_secret_key);

    const [yahoo, sscgex, polygon, openrouter, discord, alpaca] = await Promise.all([
      yahooCheck,
      sscgexCheck,
      polygonCheck,
      openrouterCheck,
      discordCheck,
      alpacaCheck
    ]);

    return {
      yahooFinance: yahoo,
      sscgexPortal: sscgex,
      polygon: polygon,
      openRouter: openrouter,
      discord: discord,
      alpaca: alpaca
    };
  }

  private async getAiApiKey(provider: string): Promise<string | null> {
    const { rows } = await this.fastify.pg.query(
      "SELECT value FROM settings WHERE key = 'openrouter_key' ORDER BY updated_at DESC LIMIT 1"
    );
    return rows[0]?.value || null;
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

  public async createSimulatedPositionFromSignal(
    userId: number,
    signalId: number
  ) {
    // 1. Fetch signal from DB
    const { rows } = await this.fastify.pg.query(
      'SELECT * FROM signals WHERE id = $1',
      [signalId]
    );
    if (rows.length === 0) {
      throw new Error(`Signal #${signalId} not found`);
    }
    const signal = rows[0];
    
    // 2. Extract pricing / option details
    const optionDetails = signal.option_details || {};
    const symbol = signal.symbol;
    const winningSide = signal.signal_type || 'CALL';
    const chosenStrike = optionDetails.strike || Math.round(signal.current_price);
    const chosenExpiry = optionDetails.expiry || signal.option_expiration_date || new Date().toISOString().split('T')[0];
    const entryPrice = optionDetails.mark || 1.0;
    const stopUnderlying = signal.stop_loss || signal.current_price * 0.99;
    const targetUnderlying = signal.target_price || signal.current_price * 1.01;

    // 3. Insert into positions table
    const insertQuery = `
      INSERT INTO positions (
        user_id, symbol, option_type, strike_price, expiration_date, 
        entry_price, quantity, stop_loss_trigger, take_profit_trigger,
        trailing_high_price, trailing_stop_loss_pct, current_price,
        status, is_simulated, account_id, notes, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'OPEN', TRUE, 'simulated', $13, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `;

    const values = [
      userId,
      symbol,
      winningSide,
      chosenStrike,
      chosenExpiry,
      entryPrice,
      1, // 1 contract
      stopUnderlying,
      targetUnderlying,
      entryPrice, // trailing_high
      null, // trailing stop pct
      entryPrice, // current_price
      `[Manually executed Simulated Option Position from Signal #${signalId}]`
    ];

    await this.fastify.pg.query(insertQuery, values);
    this.fastify.log.info(`[SignalScannerService] Simulated position recorded in DB for signal #${signalId}.`);

    // 4. Update signal status to EXECUTED
    await this.fastify.pg.query(
      'UPDATE signals SET status = $1 WHERE id = $2',
      ['EXECUTED', signalId]
    );

    // 5. Broadcast signal update
    if (this.fastify.websocketServer) {
      this.fastify.websocketServer.clients.forEach((client: any) => {
        if (client.readyState === 1) {
          client.send(JSON.stringify({ type: 'SIGNAL_UPDATED', data: { id: signalId, symbol } }));
        }
      });
    }

    // 6. Invalidate frontend cache
    await redis.del(`USER_POSITIONS:${userId}`);
    await redis.del(`USER_STATS:${userId}`);
  }

  public async executeAlpacaPaperTrade(
    userId: number,
    symbol: string,
    winningSide: 'CALL' | 'PUT',
    chosenStrike: number,
    chosenExpiry: string,
    stopUnderlying: number,
    targetUnderlying: number,
    mark: number | null,
    signalId: number
  ) {
    const settings = await this.getSettingsForUser(userId);
    const keyId = settings.alpaca_key_id?.trim();
    const secretKey = settings.alpaca_secret_key?.trim();

    if (!keyId || !secretKey) {
      this.fastify.log.warn(`[SignalScannerService] Alpaca credentials not set for user ${userId}. Skipping auto-execution.`);
      return;
    }

    const osiTicker = this.constructOSITicker(symbol, chosenStrike, winningSide, chosenExpiry);
    this.fastify.log.info(`[SignalScannerService] Executing auto paper trade on Alpaca for ${osiTicker}...`);

    try {
      // Use limit order with slippage cap to prevent catastrophic fills in fast 0 DTE markets
      // Cap at 3% above mid-price (mark). Falls back to market if mark is unavailable.
      const useLimitOrder = mark !== null && mark > 0;
      const limitPrice = useLimitOrder ? Number((mark * 1.03).toFixed(2)) : undefined;

      const orderPayload: any = {
        symbol: osiTicker,
        qty: 1,
        side: 'buy',
        type: useLimitOrder ? 'limit' : 'market',
        time_in_force: 'day'
      };
      if (limitPrice) {
        orderPayload.limit_price = limitPrice.toString();
      }

      this.fastify.log.info(`[SignalScannerService] Placing ${orderPayload.type} order for ${osiTicker}${limitPrice ? ` @ limit $${limitPrice}` : ''}`);

      const res = await fetch('https://paper-api.alpaca.markets/v2/orders', {
        method: 'POST',
        headers: {
          'APCA-API-KEY-ID': keyId,
          'APCA-API-SECRET-KEY': secretKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(orderPayload)
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Alpaca API order request failed: ${res.status} - ${errorText}`);
      }

      const orderData: any = await res.json();
      const alpacaOrderId = orderData.id;
      this.fastify.log.info(`[SignalScannerService] Alpaca paper order placed successfully. Order ID: ${alpacaOrderId}`);

      // Query current mark/mid price if not passed to use as accurate entry price
      let entryPrice = mark || 0.0;
      if (entryPrice <= 0) {
        try {
          const snapRes = await fetch(`https://data.alpaca.markets/v1beta1/options/snapshots?symbols=${osiTicker}`, {
            headers: {
              'APCA-API-KEY-ID': keyId,
              'APCA-API-SECRET-KEY': secretKey
            }
          });
          if (snapRes.ok) {
            const snapData: any = await snapRes.json();
            const snap = snapData.snapshots?.[osiTicker];
            if (snap) {
              const bp = snap.latestQuote?.bp || 0;
              const ap = snap.latestQuote?.ap || 0;
              entryPrice = (bp > 0 && ap > 0) ? (bp + ap) / 2 : snap.latestTrade?.p || 0.0;
            }
          }
        } catch (e: any) {
          this.fastify.log.warn(`[SignalScannerService] Failed to query entry premium from Alpaca: ${e.message}`);
        }
      }

      // Default to a fallback if still zero
      if (entryPrice <= 0) entryPrice = 1.0;

      // Insert position into DB
      const insertQuery = `
        INSERT INTO positions (
          user_id, symbol, option_type, strike_price, expiration_date, 
          entry_price, quantity, stop_loss_trigger, take_profit_trigger,
          trailing_high_price, trailing_stop_loss_pct, current_price,
          status, is_simulated, account_id, notes, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'OPEN', TRUE, 'alpaca_paper', $13, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `;

      const values = [
        userId,
        symbol,
        winningSide,
        chosenStrike,
        chosenExpiry,
        entryPrice,
        1, // 1 contract
        stopUnderlying,
        targetUnderlying,
        entryPrice, // trailing_high
        null, // trailing stop pct
        entryPrice, // current_price
        `[Alpaca Auto-executed Paper Trade #${alpacaOrderId} on Signal #${signalId}]`
      ];

      await this.fastify.pg.query(insertQuery, values);
      this.fastify.log.info(`[SignalScannerService] Position recorded in DB for signal #${signalId}.`);

      // Update signal status to EXECUTED
      await this.fastify.pg.query(
        'UPDATE signals SET status = $1 WHERE id = $2',
        ['EXECUTED', signalId]
      );

      // Broadcast signal update
      if (this.fastify.websocketServer) {
        this.fastify.websocketServer.clients.forEach((client: any) => {
          if (client.readyState === 1) {
            client.send(JSON.stringify({ type: 'SIGNAL_UPDATED', data: { id: signalId, symbol } }));
          }
        });
      }

      // Invalidate frontend cache
      await redis.del(`USER_POSITIONS:${userId}`);
      await redis.del(`USER_STATS:${userId}`);

    } catch (err: any) {
      this.fastify.log.error(`[SignalScannerService] Alpaca auto-execution failed for signal #${signalId}: ${err.message}`);
    }
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

