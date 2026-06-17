import cron from 'node-cron';
import { FastifyInstance } from 'fastify';
import { StopLossEngine } from './stop-loss-engine';
import { redis } from '../lib/redis';
import { AIService } from './ai-service';
import { SnaptradeService } from './snaptrade-service';
import { getSettingsWithGlobalFallback } from '../lib/settings-utils';
import WebSocket from 'ws';
import { TradeLifecycleService } from './trade-lifecycle-service';

type ExitQuoteContext = {
  bid?: number;
  ask?: number;
  last?: number;
  mid?: number;
  spreadPct?: number;
  source?: string;
};

export class MarketPoller {
  private fastify: FastifyInstance;
  private aiService: AIService;
  private currentIntervalSeconds: number = 30; // Default 30s
  private timerId: NodeJS.Timeout | null = null;
  private pollingEnabled: boolean = true;
  private redisClient: any;

  // Alpaca WebSocket stream
  private alpacaWs: WebSocket | null = null;
  private alpacaReconnectAttempts: number = 0;
  private alpacaReconnectTimer: NodeJS.Timeout | null = null;
  private alpacaStreamActive: boolean = false;

  constructor(fastify: FastifyInstance, redisClient?: any) {
    this.fastify = fastify;
    this.aiService = new AIService(fastify);
    this.redisClient = redisClient || redis;
  }

  private readonly LOCK_KEY = 'MARKET_POLLER_LEADER';

  public async start() {
    // 1. Fetch the preferred interval and polling enabled state from settings
    try {
      const { rows } = await (this.fastify as any).pg.query(
        "SELECT key, value FROM settings WHERE key IN ('market_poll_interval', 'polling_enabled') ORDER BY updated_at DESC"
      );
      for (const row of rows) {
        if (row.key === 'market_poll_interval') {
          this.currentIntervalSeconds = parseInt(row.value, 10) || 60;
        } else if (row.key === 'polling_enabled') {
          this.pollingEnabled = row.value !== 'false';
        }
      }
    } catch (err) {
      this.fastify.log.error(`[MarketPoller] Failed to load poll settings from DB: ${err}`);
    }

    this.fastify.log.info(`[MarketPoller] Starting with polling ${this.pollingEnabled ? 'ENABLED' : 'DISABLED'}, interval: ${this.currentIntervalSeconds}s`);

    // Start recursive loop
    this.scheduleNextPoll();
    this.startBriefingJob();

    // Start Alpaca WebSocket stream for instant trade update notifications
    this.startAlpacaStream();
  }

  private scheduleNextPoll() {
    if (this.timerId) clearTimeout(this.timerId);

    this.timerId = setTimeout(async () => {
      try {
        if (!this.pollingEnabled) {
          // Skip polling but keep the timer alive so we can resume
          return;
        }

        // Distributed Lock Check
        // Attempt to acquire lock for slightly longer than the interval
        const lockDuration = this.currentIntervalSeconds + 5;
        const acquired = await this.redisClient.setNX(this.LOCK_KEY, 'LOCKED', Math.floor(lockDuration));

        if (acquired) {
          await this.poll();
        }
      } catch (err) {
        this.fastify.log.error(`[MarketPoller] Error during poll execution: ${err}`);
      } finally {
        this.scheduleNextPoll();
      }
    }, this.currentIntervalSeconds * 1000);
  }

  public updateInterval(seconds: number) {
    this.fastify.log.info(`[MarketPoller] Updating poll interval to: ${seconds}s`);
    this.currentIntervalSeconds = seconds;
    this.scheduleNextPoll(); // Reschedule immediately
  }

  /**
   * Stop polling. The timer loop stays alive but skips actual poll calls.
   */
  public stop() {
    this.pollingEnabled = false;
    this.fastify.log.info('[MarketPoller] Polling DISABLED by user.');
  }

  /**
   * Resume polling after being stopped.
   */
  public resume() {
    this.pollingEnabled = true;
    this.fastify.log.info('[MarketPoller] Polling ENABLED by user.');
    this.scheduleNextPoll(); // Kick off immediately
  }

  /**
   * Returns whether polling is currently active.
   */
  public isRunning(): boolean {
    return this.pollingEnabled;
  }

  private startBriefingJob() {
    // Default to 8:30 AM ET
    const schedule = process.env.MORNING_BRIEFING_SCHEDULE || '30 8 * * *';
    this.fastify.log.info(`[MarketPoller] Starting morning briefing job with schedule: ${schedule}`);

    cron.schedule(schedule, async () => {
      try {
        await this.sendMorningBriefings();
      } catch (err) {
        this.fastify.log.error(`[MarketPoller] Error during morning briefing execution: ${err}`);
      }
    });
  }

  public async sendMorningBriefings(ignoreFrequency: boolean = false) {
    this.fastify.log.info(`[MarketPoller] Executing morning briefings (ignoreFrequency: ${ignoreFrequency})...`);
    const { rows: users } = await (this.fastify as any).pg.query('SELECT DISTINCT p.user_id, u.username FROM positions p JOIN users u ON p.user_id = u.id');

    for (const { user_id: userId, username } of users) {
      try {
        // 1. Check user settings for briefing frequency
        const { rows: settingsRows } = await (this.fastify as any).pg.query(
          'SELECT key, value FROM settings WHERE user_id = $1',
          [userId]
        );
        const settings = settingsRows.reduce((acc: any, row: any) => {
          acc[row.key] = row.value;
          return acc;
        }, {});

        const frequency = settings.briefing_frequency || 'disabled';
        if (!ignoreFrequency && frequency === 'disabled') continue;

        // 2. Decide if we should send it today
        if (!ignoreFrequency && !this.shouldSendBriefingToday(frequency)) continue;

        // 3. Fetch open positions
        const { rows: positions } = await (this.fastify as any).pg.query(
          "SELECT p.*, u.username FROM positions p JOIN users u ON p.user_id = u.id WHERE p.user_id = $1 AND p.status = 'OPEN'",
          [userId]
        );

        if (positions.length === 0) continue;

        // 4. Generate AI briefing
        this.fastify.log.info(`[MarketPoller] Generating briefing for user ${userId}...`);
        const briefingData = await this.aiService.generateBriefing(positions);

        // 5. Notify N8n
        await this.notifyN8nBriefing(userId, username, briefingData.briefing, briefingData.discord_message);

      } catch (err) {
        this.fastify.log.error(`[MarketPoller] Failed to send briefing for user ${userId}: ${err}`);
      }
    }
  }

  private shouldSendBriefingToday(frequency: string): boolean {
    const now = new Date();
    // Use ET for consistency
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'long',
    });
    const weekday = formatter.format(now);

    switch (frequency) {
      case 'daily': return true;
      case 'every_2_days':
        // Simple parity check on day of year/month for demo purposes
        // In production, we might store "last_briefing_sent" in DB
        return now.getDate() % 2 === 0;
      case 'monday': return weekday === 'Monday';
      case 'friday': return weekday === 'Friday';
      case 'weekly': return weekday === 'Monday'; // Default weekly to Monday
      default: return false;
    }
  }

  private getNewYorkDateString(date: Date = new Date()): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(date);
    const getPart = (type: string) => parts.find(part => part.type === type)?.value || '';
    return `${getPart('year')}-${getPart('month')}-${getPart('day')}`;
  }

  private async markExitSubmissionFailure(position: any, message: string) {
    await TradeLifecycleService.markExitSubmissionFailure((this.fastify as any).pg, position.id, message);
  }

  private getProfitTrimQuantity(position: any): number {
    const quantity = Math.max(1, Math.floor(Number(position.quantity || 1)));
    if (quantity <= 1) return quantity;
    if (String(position.profit_trim_status || '').toUpperCase() === 'DONE') return quantity;
    return Math.max(1, Math.floor(quantity / 2));
  }

  private isPartialProfitTrim(position: any, exitTriggerType: 'STOP_LOSS' | 'TAKE_PROFIT'): boolean {
    const quantity = Math.max(1, Math.floor(Number(position.quantity || 1)));
    return exitTriggerType === 'TAKE_PROFIT'
      && quantity > 1
      && String(position.profit_trim_status || '').toUpperCase() !== 'DONE';
  }

  private getTakeProfitOrderPreference(position: any, price: number, quote?: ExitQuoteContext): { orderType: 'LIMIT' | 'MARKET'; limitPrice?: string; mode: 'PAST_TP' | 'NEAR_TP' | 'STRUCTURE_TP' | 'EOD_MARKET' } {
    const takeProfit = Number(position.take_profit_trigger || 0);
    const sellablePremium = this.getSellablePremium(price, quote);
    if (this.isLateDayExitWindow()) {
      return { orderType: 'MARKET', mode: 'EOD_MARKET' };
    }
    if (takeProfit > 0 && sellablePremium >= takeProfit) {
      return { orderType: 'MARKET', mode: 'PAST_TP' };
    }
    if (takeProfit > 0) {
      return { orderType: 'LIMIT', limitPrice: takeProfit.toFixed(2), mode: 'NEAR_TP' };
    }
    return { orderType: 'LIMIT', limitPrice: price.toFixed(2), mode: 'STRUCTURE_TP' };
  }

  private getTakeProfitReferencePremium(price: number, quote?: ExitQuoteContext): number {
    const candidates = [quote?.bid, quote?.last, quote?.mid, price]
      .map((value) => Number(value || 0))
      .filter((value) => Number.isFinite(value) && value > 0);
    return candidates.length > 0 ? Number(Math.max(...candidates).toFixed(2)) : 0;
  }

  private normalizeQuoteContext(price: number, quote?: ExitQuoteContext): ExitQuoteContext {
    const bid = Number(quote?.bid || 0);
    const ask = Number(quote?.ask || 0);
    const last = Number(quote?.last || 0);
    const mid = bid > 0 && ask > 0 ? Number(((bid + ask) / 2).toFixed(2)) : Number(quote?.mid || price || 0);
    const spreadPct = bid > 0 && ask > 0 && mid > 0
      ? Number((((ask - bid) / mid) * 100).toFixed(2))
      : Number(quote?.spreadPct || 0);

    return {
      bid: bid > 0 ? bid : undefined,
      ask: ask > 0 ? ask : undefined,
      last: last > 0 ? last : undefined,
      mid: mid > 0 ? mid : undefined,
      spreadPct: spreadPct > 0 ? spreadPct : undefined,
      source: quote?.source
    };
  }

  private getSellablePremium(price: number, quote?: ExitQuoteContext): number {
    return Number((quote?.bid && quote.bid > 0 ? quote.bid : price).toFixed(2));
  }

  private isWideExitSpread(quote?: ExitQuoteContext): boolean {
    return Number(quote?.spreadPct || 0) > 20;
  }

  private isNoBidQuote(quote?: ExitQuoteContext): boolean {
    return Boolean(quote && (!quote.bid || quote.bid <= 0) && ((quote.ask || 0) > 0 || (quote.last || 0) > 0 || (quote.mid || 0) > 0));
  }

  private async isStopLossEngineEnabledForUser(userId: number): Promise<boolean> {
    try {
      const settings = await getSettingsWithGlobalFallback((this.fastify as any).pg, userId);
      return settings.stop_loss_engine_enabled !== 'false';
    } catch (err: any) {
      this.fastify.log.warn(`[MarketPoller] Failed to load stop-loss engine setting for user ${userId}: ${err.message || err}`);
      return true;
    }
  }

  private isLateDayExitWindow(date: Date = new Date()): boolean {
    const parts = this.getNewYorkTimeParts(date);
    return parts.minutes >= (15 * 60 + 45);
  }

  private getNewYorkTimeParts(date: Date = new Date()): { hour: number; minute: number; minutes: number } {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false
    });
    const [hourStr, minuteStr] = formatter.format(date).split(':');
    const hour = parseInt(hourStr, 10);
    const minute = parseInt(minuteStr, 10);
    return { hour, minute, minutes: hour * 60 + minute };
  }

  private async submitSnapTradeExit(
    position: any,
    orderType: 'LIMIT' | 'MARKET',
    limitPrice?: string,
    exitTriggerType: 'STOP_LOSS' | 'TAKE_PROFIT' = 'STOP_LOSS',
    requestedQuantity?: number
  ): Promise<boolean> {
    const accountId = position.account_id;
    if (!accountId) {
      await this.markExitSubmissionFailure(position, 'No SnapTrade account id found for live exit');
      return false;
    }

    const partialTrim = this.isPartialProfitTrim(position, exitTriggerType);
    const exitQuantity = Math.max(1, Math.min(
      Math.floor(Number(requestedQuantity || (partialTrim ? this.getProfitTrimQuantity(position) : position.quantity) || 1)),
      Math.floor(Number(position.quantity || 1))
    ));
    const nextExecutionStatus = partialTrim ? 'PENDING_TRIM' : 'PENDING_EXIT';
    const nextExitReason = partialTrim ? 'PROFIT_TRIM' : 'AUTO_EXIT';
    const claimNote = partialTrim
      ? ` [Profit trim claim created before SnapTrade ${orderType} SELL_TO_CLOSE for ${exitQuantity}/${position.quantity} contracts]`
      : ` [Exit claim created before SnapTrade ${orderType} submission]`;

    const claimResult = await (this.fastify as any).pg.query(
      `UPDATE positions
       SET execution_status = $1::text,
           execution_error = NULL,
           exit_reason = COALESCE(exit_reason, $2),
           exit_order_type = $3,
           exit_requested_at = CURRENT_TIMESTAMP,
           profit_trim_status = CASE WHEN $4::boolean THEN 'PENDING' ELSE profit_trim_status END,
           profit_trim_quantity = CASE WHEN $4::boolean THEN $5 ELSE profit_trim_quantity END,
           notes = COALESCE(notes, '') || $6,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $7
         AND status = 'OPEN'
         AND COALESCE(execution_status, '') NOT IN ('PENDING_EXIT', 'PENDING_TRIM')
         AND broker_exit_order_id IS NULL
       RETURNING id`,
      [nextExecutionStatus, nextExitReason, orderType, partialTrim, exitQuantity, claimNote, position.id]
    );

    if (claimResult.rowCount === 0) {
      this.fastify.log.info(`[MarketPoller] Exit/trim already pending or unavailable for position ${position.id}. Skipping duplicate SELL_TO_CLOSE.`);
      return false;
    }

    try {
      const snaptradeService = new SnaptradeService(this.fastify);
      const osiTicker = this.constructOSITicker(
        position.symbol,
        Number(position.strike_price),
        position.option_type,
        position.expiration_date
      );

      const result = await snaptradeService.placeOptionOrder(
        position.user_id,
        accountId,
        osiTicker,
        'SELL_TO_CLOSE',
        exitQuantity,
        orderType,
        limitPrice
      );

      await (this.fastify as any).pg.query(
        `UPDATE positions
         SET execution_status = $1::text,
             execution_error = NULL,
             broker_exit_order_id = $2,
             broker_exit_trade_id = $3,
             profit_trim_order_id = CASE WHEN $4::boolean THEN $2 ELSE profit_trim_order_id END,
             profit_trim_trade_id = CASE WHEN $4::boolean THEN $3 ELSE profit_trim_trade_id END,
             notes = COALESCE(notes, '') || $5,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $6
           AND status = 'OPEN'
           AND execution_status = $1::text`,
        [
          nextExecutionStatus,
          result.orderId || null,
          result.tradeId || null,
          partialTrim,
          partialTrim
            ? ` [SnapTrade ${orderType} profit trim submitted for ${exitQuantity}/${position.quantity} contracts${result.orderId ? `: ${result.orderId}` : ''}]`
            : ` [SnapTrade ${orderType} exit submitted${result.orderId ? `: ${result.orderId}` : ''}]`,
          position.id
        ]
      );
      return true;
    } catch (err: any) {
      const message = err.message || String(err);
      this.fastify.log.error(`[MarketPoller] Live exit execution failed for position ${position.id}: ${message}`);
      await this.markExitSubmissionFailure(position, message);
      return false;
    }
  }

  private async notifyN8nBriefing(userId: string, username: string, briefing: string, discordMessage: string) {
    const N8N_WEBHOOK_URL = process.env.N8N_ALERT_WEBHOOK_URL;
    if (!N8N_WEBHOOK_URL) return;

    try {
      await fetch(N8N_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'MORNING_BRIEFING',
          notification_type: 'briefing',
          user_id: userId,
          username: username,
          briefing: briefing,
          discord_message: `**[User: ${username}]**\n${discordMessage}`,
          timestamp: new Date().toISOString()
        })
      });
      this.fastify.log.info(`[MarketPoller] Briefing sent to n8n for user ${userId}`);
    } catch (err: any) {
      this.fastify.log.error(`[MarketPoller] Failed to notify n8n for briefing (user ${userId}):`, err.message);
    }
  }

  private constructOSITicker(symbol: string, strike: number, type: 'CALL' | 'PUT', expiration: string | Date): string {
    // Format: AAPL230616C00150000
    // Use string parsing for expiration to avoid timezone shifts
    // Expecting YYYY-MM-DD (Date object or string)
    let dateStr = '';
    if (expiration instanceof Date) {
      // Format to YYYY-MM-DD manually to avoid timezone shift from .toISOString()
      const year = expiration.getFullYear();
      const month = (expiration.getMonth() + 1).toString().padStart(2, '0');
      const day = expiration.getDate().toString().padStart(2, '0');
      dateStr = `${year}-${month}-${day}`;
    } else {
      dateStr = expiration.split('T')[0];
    }

    const parts = dateStr.split('-');
    if (parts.length !== 3) {
      this.fastify.log.warn(`[MarketPoller] Invalid expiration date format: ${expiration}`);
      return `${symbol.toUpperCase()}XXXXXX${type === 'CALL' ? 'C' : 'P'}${Math.round(strike * 1000).toString().padStart(8, '0')}`;
    }

    const YY = parts[0].slice(-2);
    const MM = parts[1].padStart(2, '0');
    const DD = parts[2].padStart(2, '0');

    const side = type === 'CALL' ? 'C' : 'P';
    const strikeValue = Math.round(strike * 1000).toString().padStart(8, '0');

    return `${symbol.toUpperCase()}${YY}${MM}${DD}${side}${strikeValue}`;
  }

  private parseCompactOsiTicker(ticker: string): { root: string; expiration: string; optionType: 'CALL' | 'PUT'; strike: number } | null {
    const match = String(ticker || '').replace(/\s+/g, '').toUpperCase().match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
    if (!match) return null;
    const [, root, expiry, side, strikeRaw] = match;
    return {
      root,
      expiration: `20${expiry.slice(0, 2)}-${expiry.slice(2, 4)}-${expiry.slice(4, 6)}`,
      optionType: side === 'C' ? 'CALL' : 'PUT',
      strike: Number(strikeRaw) / 1000
    };
  }

  private async getOptionPremium(userId: number, symbol: string, strike: number, type: 'CALL' | 'PUT', expiration: string, skipCache: boolean = false): Promise<any | null> {
    const ticker = this.constructOSITicker(symbol, strike, type, expiration);

    try {
      const settings = await getSettingsWithGlobalFallback((this.fastify as any).pg, userId);
      const alpacaKeyId = settings.alpaca_key_id?.trim();
      const alpacaSecretKey = settings.alpaca_secret_key?.trim();

      if (alpacaKeyId && alpacaSecretKey) {
        this.fastify.log.info(`[MarketPoller] Fetching price for ${ticker} via Alpaca API...`);

        // 1. Fetch Option Snapshot
        const optUrl = `https://data.alpaca.markets/v1beta1/options/snapshots?symbols=${ticker}`;
        const optRes = await fetch(optUrl, {
          headers: {
            'APCA-API-KEY-ID': alpacaKeyId,
            'APCA-API-SECRET-KEY': alpacaSecretKey
          }
        });

        if (!optRes.ok) {
          throw new Error(`Alpaca options snapshot API error: Status ${optRes.status}`);
        }
        const optData: any = await optRes.json();
        const snapshot = optData.snapshots?.[ticker];
        if (!snapshot) {
          throw new Error(`Alpaca options snapshot not found for ${ticker}`);
        }

        // Calculate option price (mid-price of bid/ask if valid, else latest trade price)
        const bid = snapshot.latestQuote?.bp || 0;
        const ask = snapshot.latestQuote?.ap || 0;
        const price = (bid > 0 && ask > 0) ? (bid + ask) / 2 : snapshot.latestTrade?.p || 0;

        // 2. Fetch Underlying Price
        let underlyingPrice = 0;
        const stockUrl = `https://data.alpaca.markets/v2/stocks/snapshots?symbols=${symbol}`;
        const stockRes = await fetch(stockUrl, {
          headers: {
            'APCA-API-KEY-ID': alpacaKeyId,
            'APCA-API-SECRET-KEY': alpacaSecretKey
          }
        });
        if (stockRes.ok) {
          const stockData: any = await stockRes.json();
          underlyingPrice = stockData[symbol]?.latestTrade?.p || stockData[symbol]?.latestQuote?.ap || 0;
        } else {
          this.fastify.log.warn(`[MarketPoller] Alpaca stock snapshot query failed: Status ${stockRes.status}`);
        }

        return {
          status: 'ok',
          symbol: ticker,
          price,
          quote: this.normalizeQuoteContext(price, {
            bid,
            ask,
            last: snapshot.latestTrade?.p || 0,
            source: 'alpaca'
          }),
          iv: null,
          underlying_price: underlyingPrice,
          greeks: null,
          metadata: {
            symbol,
            strike,
            type,
            expiration
          }
        };
      }

      // Fallback: Questrade Integration
      const questrade = (this.fastify as any).questrade;

      // 1. Get/Resolve Option Symbol ID
      // We can STILL cache the symbolId for the ticker (it never changes for a specific option)
      const SYMBOL_ID_CACHE_KEY = `SYMBOL_ID:${ticker}`;
      let symbolId: number | null = null;

      const cachedId = await this.redisClient.get(SYMBOL_ID_CACHE_KEY);
      if (cachedId) {
        symbolId = parseInt(cachedId, 10);
      } else {
        this.fastify.log.info(`[MarketPoller] Resolving Questrade Symbol ID for ${ticker}...`);
        symbolId = await questrade.getSymbolId(ticker);
        if (symbolId) {
          await this.redisClient.set(SYMBOL_ID_CACHE_KEY, symbolId.toString(), 86400); // 24h
          await this.redisClient.set(`SYMBOL_NAME:${symbolId}`, ticker, 86400);
        }
      }

      if (!symbolId) {
        this.fastify.log.warn(`[MarketPoller] Could not resolve symbol ID for ${ticker} on Questrade.`);
        return null;
      }

      // 2. Get Quote from Questrade (FRESH EVERY TIME)
      const quote = await questrade.getOptionQuote(symbolId);
      if (!quote) return null;

      // 3. Fetch Underlying Price (Questrade option quote doesn't include it in JSON)
      let underlyingPrice = 0;
      if (quote.underlyingId) {
        const uQuotes = await questrade.getQuote([quote.underlyingId]);
        if (uQuotes && uQuotes.length > 0) {
          underlyingPrice = uQuotes[0].lastTradePrice || 0;
        }
      }

      // Calculate premium (use Mid price if available, else last)
      const bid = quote.bidPrice || 0;
      const ask = quote.askPrice || 0;
      const price = (bid > 0 && ask > 0) ? (bid + ask) / 2 : quote.lastTradePrice || 0;

      const result = {
        status: 'ok',
        symbol: ticker,
        price,
        quote: this.normalizeQuoteContext(price, {
          bid,
          ask,
          last: quote.lastTradePrice || 0,
          source: 'questrade'
        }),
        iv: quote.volatility || 0,
        underlying_price: underlyingPrice,
        greeks: {
          delta: quote.delta || 0,
          gamma: quote.gamma || 0,
          theta: quote.theta || 0,
          vega: quote.vega || 0,
          rho: quote.rho || 0
        },
        metadata: {
          symbol,
          strike,
          type,
          expiration
        }
      };

      // We no longer set PRICE cache in Redis as per user request
      return result;

    } catch (err: any) {
      this.fastify.log.error(`[MarketPoller] Option fetch failed for ${ticker}:`, err.message);
      return null;
    }
  }

  public async syncPrice(symbol: string, skipCache: boolean = false) {
    this.fastify.log.info(`[MarketPoller] TARGETED Sync for symbol: ${symbol}`);
    const { rows: positions } = await (this.fastify as any).pg.query(
      "SELECT p.*, u.username FROM positions p JOIN users u ON p.user_id = u.id WHERE p.symbol = $1 AND p.status = 'OPEN'",
      [symbol]
    );

    if (positions.length === 0) {
      this.fastify.log.info(`[MarketPoller] No active or triggered positions found for ${symbol}.`);
      return null;
    }

    let lastFetchedPrice = null;

    for (const position of positions) {
      const data = await this.getOptionPremium(
        position.user_id,
        position.symbol,
        Number(position.strike_price),
        position.option_type,
        position.expiration_date,
        skipCache
      );

      if (data && data.price !== null) {
        // this.fastify.log.debug(`[MarketPoller] ${position.symbol} ${position.option_type} $${position.strike_price} -> Premium: $${data.price}`);
        this.fastify.log.info(`[MarketPoller] ${position.symbol} Price: ${data.price} IV: ${data.iv} Underlying: ${data.underlying_price} Greeks:`, data.greeks);
        await this.processUpdate(position, data.price, data.greeks, data.iv, data.underlying_price, data.quote);
        lastFetchedPrice = data.price;
      }
    }
    if (lastFetchedPrice !== null) {
      this.fastify.log.info(`[MarketPoller] TARGETED Sync for ${symbol} completed successfully.`);
    } else {
      this.fastify.log.warn(`[MarketPoller] TARGETED Sync for ${symbol} failed or no positions were updated.`);
    }

    return lastFetchedPrice;
  }

  public isMarketOpen(): boolean {
    const now = new Date();
    // Use Intl to get ET time
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour12: false,
      weekday: 'short',
      hour: 'numeric',
      minute: 'numeric',
    });

    const parts = formatter.formatToParts(now);
    const getPart = (type: string) => parts.find(p => p.type === type)?.value;

    const weekday = getPart('weekday');
    const hour = parseInt(getPart('hour') || '0', 10);
    const minute = parseInt(getPart('minute') || '0', 10);

    // Weekend check
    if (weekday === 'Sat' || weekday === 'Sun') return false;

    // Market hours: 9:30 AM - 4:15 PM (16:15) ET
    const currentTimeMinutes = hour * 60 + minute;
    const marketOpenMinutes = 9 * 60 + 30;
    const marketCloseMinutes = 16 * 60 + 15;

    return currentTimeMinutes >= marketOpenMinutes && currentTimeMinutes <= marketCloseMinutes;
  }

  public async poll(force: boolean = false) {
    this.fastify.log.info(`[MarketPoller] Polling job started at ${new Date().toISOString()}...`);

    const { rows: positions } = await (this.fastify as any).pg.query(
      "SELECT p.*, u.username FROM positions p JOIN users u ON p.user_id = u.id WHERE p.status = 'OPEN'"
    );

    if (positions.length === 0) {
      this.fastify.log.info('[MarketPoller] No active positions to poll.');
      return;
    }

    // 0. Hard Time-based Day Trading Cutoffs Enforcements
    const now = new Date();
    const etFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: 'numeric',
        minute: 'numeric',
        hour12: false
    });
    const [etHourStr, etMinuteStr] = etFormatter.format(now).split(':');
    const etHour = parseInt(etHourStr, 10);
    const etMinute = parseInt(etMinuteStr, 10);
    const etTimeMinutes = etHour * 60 + etMinute;

    const todayStr = this.getNewYorkDateString(now);

    const isEodCutoff = etTimeMinutes >= 15 * 60 + 50; // 3:50 PM ET or later
    const isMorningCutoff = etTimeMinutes >= 13 * 60; // 1:00 PM ET or later

    for (const pos of positions) {
        let shouldForceClose = false;
        let reason = '';

        if (['PENDING_EXIT', 'PENDING_TRIM'].includes(String(pos.execution_status || ''))) {
            continue;
        }

        const expDateStr = pos.expiration_date instanceof Date
            ? this.getNewYorkDateString(pos.expiration_date)
            : String(pos.expiration_date).split('T')[0];
        const is0Dte = expDateStr === todayStr;

        if (isEodCutoff) {
            shouldForceClose = true;
            reason = 'EOD Hard Cutoff (3:50 PM ET)';
        } else if (isMorningCutoff && is0Dte) {
            shouldForceClose = true;
            reason = 'Morning 0 DTE Hard Cutoff (1:00 PM ET)';
        }

        if (shouldForceClose) {
            this.fastify.log.info(`[MarketPoller] Force closing position ${pos.id} (${pos.symbol}) due to ${reason}.`);
            let currentPrice = Number(pos.current_price || pos.entry_price);
            
            if (!pos.is_simulated) {
                const submitted = await this.submitSnapTradeExit(pos, 'MARKET');
                if (!submitted) continue;
                await this.notifyN8n(
                    pos,
                    currentPrice,
                    0,
                    0,
                    'FORCE_CLOSE',
                    `Exit order submitted due to ${reason}`,
                    `**[FORCE CLOSE SUBMITTED]** ${reason}. Market SELL_TO_CLOSE was submitted; waiting for broker fill confirmation. Last app price: $${currentPrice}.`
                );
                pos.execution_status = 'PENDING_EXIT';
                continue;
            } else if (pos.account_id === 'alpaca_paper') {
                try {
                    const userSettings = await getSettingsWithGlobalFallback((this.fastify as any).pg, pos.user_id);
                    const alpacaKeyId = userSettings.alpaca_key_id?.trim() || '';
                    const alpacaSecretKey = userSettings.alpaca_secret_key?.trim() || '';
                    const alpacaAutoTrade = userSettings.alpaca_auto_trade?.trim() || 'false';

                    if (alpacaAutoTrade !== 'true') {
                        this.fastify.log.info(`[MarketPoller] Alpaca auto-trade is disabled for user ${pos.user_id}. Skipping automatic force-close for position ${pos.id}.`);
                        continue;
                    }

                    if (alpacaKeyId && alpacaSecretKey) {
                        const osiTicker = this.constructOSITicker(
                            pos.symbol,
                            Number(pos.strike_price),
                            pos.option_type,
                            pos.expiration_date
                        );
                        this.fastify.log.info(`[MarketPoller] Force closing Alpaca paper position ${pos.id} (${osiTicker})...`);
                        const res = await fetch('https://paper-api.alpaca.markets/v2/orders', {
                            method: 'POST',
                            headers: {
                                'APCA-API-KEY-ID': alpacaKeyId,
                                'APCA-API-SECRET-KEY': alpacaSecretKey,
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({
                                symbol: osiTicker,
                                qty: pos.quantity || 1,
                                side: 'sell',
                                type: 'market',
                                time_in_force: 'day'
                            })
                        });
                        if (!res.ok) {
                            const errText = await res.text();
                            throw new Error(`Alpaca paper force close failed: ${res.status} - ${errText}`);
                        }
                        const orderData: any = await res.json();
                        await (this.fastify as any).pg.query(
                            `UPDATE positions
                             SET execution_status = 'PENDING_EXIT',
                                 execution_error = NULL,
                                 broker_exit_order_id = $1,
                                 exit_requested_at = CURRENT_TIMESTAMP,
                                 notes = COALESCE(notes, '') || $2,
                                 updated_at = CURRENT_TIMESTAMP
                             WHERE id = $3 AND status = 'OPEN'`,
                            [orderData.id || null, ` [Alpaca paper force-close submitted${orderData.id ? `: ${orderData.id}` : ''}]`, pos.id]
                        );
                        pos.execution_status = 'PENDING_EXIT';
                        continue;
                    }
                } catch (err: any) {
                    this.fastify.log.error(`[MarketPoller] Failed to execute Alpaca force-close for position ${pos.id}: ${err.message}`);
                    await this.markExitSubmissionFailure(pos, err.message || String(err));
                    continue;
                }
            }

            const realizedPnl = (currentPrice - Number(pos.entry_price)) * pos.quantity * 100;

            await (this.fastify as any).pg.query(
                `UPDATE positions 
                 SET status = 'CLOSED', 
                     realized_pnl = $1,
                     notes = COALESCE(notes, '') || $2,
                     updated_at = CURRENT_TIMESTAMP 
                 WHERE id = $3`,
                [realizedPnl, ` [Force closed: ${reason}]`, pos.id]
            );

            await this.notifyN8n(
                pos, 
                currentPrice, 
                realizedPnl, 
                0, 
                'FORCE_CLOSE', 
                `Position force closed due to ${reason}`, 
                `**[FORCE CLOSE]** Position closed due to ${reason}. Current price: $${currentPrice}. P&L: $${realizedPnl.toFixed(2)}`
            );

            pos.status = 'CLOSED';
        }
    }

    // Refresh active positions list after cutoffs
    const activePositions = positions.filter((p: any) => p.status !== 'CLOSED');
    if (activePositions.length === 0) {
      this.fastify.log.info('[MarketPoller] All active positions were force-closed by cutoffs.');
      return;
    }

    const symbols = [...new Set(activePositions.map((p: any) => p.symbol))];
    const isMarketOpen = this.isMarketOpen();
    const etWeekday = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(new Date());
    const isWeekend = etWeekday === 'Sat' || etWeekday === 'Sun';
    const allowSync = isMarketOpen || isWeekend;

    if (!force && !isMarketOpen) {
      if (isWeekend) {
        this.fastify.log.info('[MarketPoller] Market is closed (Weekend), but weekend testing bypass is active. Price syncing allowed.');
      } else {
        this.fastify.log.info('[MarketPoller] Market is closed. Will only perform housekeeping (auto-expiry).');
      }
    }

    for (const symbol of symbols) {
      // 1. Auto-Close Expired Logic
      // Check for expired positions for this symbol first
      const symbolPositions = positions.filter((p: any) => p.symbol === symbol);
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      for (const pos of symbolPositions) {
        const expDate = new Date(pos.expiration_date);
        expDate.setHours(0, 0, 0, 0);

        // Standard comparison: If expiration date is strictly less than today (yesterday or earlier), it's expired.
        if (expDate < today) {
          this.fastify.log.info(`[MarketPoller] Auto-closing expired position ${pos.id} (${pos.symbol}) as worthless/expired.`);
          // Close with 0 PnL
          await (this.fastify as any).pg.query(
            `UPDATE positions 
                 SET status = 'CLOSED', 
                     exit_price = 0, 
                     realized_pnl = 0, 
                     notes = COALESCE(notes, '') || ' [Auto-closed as Expired]',
                     updated_at = CURRENT_TIMESTAMP 
                 WHERE id = $1`,
            [pos.id]
          );
          // Mark as closed locally so we don't sync it below
          pos.status = 'CLOSED';
        }
      }

      // 2. Price Sync (Only if Market Open or Forced)
      // Filter out positions we just closed
      const activePositions = symbolPositions.filter((p: any) => p.status !== 'CLOSED');

      if ((force || allowSync) && activePositions.length > 0) {
        await this.syncPrice(symbol as string, force);
        // Stay within limits, sequential delay
        await new Promise<void>(resolve => setTimeout(() => resolve(), 5000));
      }
    }
  }

  public async processPositionExitUpdate(position: any, price: number, greeks?: any, iv?: number, underlyingPrice?: number, quote?: ExitQuoteContext) {
    return this.processUpdate(position, price, greeks, iv, underlyingPrice, quote);
  }

  private async processUpdate(position: any, price: number, greeks?: any, iv?: number, underlyingPrice?: number, quote?: ExitQuoteContext) {
    let analysis: any = {};
    let analysisDirty = false;
    try {
      if (position.analysis_data) {
        analysis = typeof position.analysis_data === 'string' ? JSON.parse(position.analysis_data) : position.analysis_data;
      }
    } catch (e) {
      this.fastify.log.warn(`[MarketPoller] Failed to parse analysis_data for position ${position.id}`);
    }

    const quoteContext = this.normalizeQuoteContext(price, quote);
    const sellablePremium = this.getSellablePremium(price, quoteContext);
    const takeProfitReferencePremium = this.getTakeProfitReferencePremium(price, quoteContext);
    const noBidQuote = this.isNoBidQuote(quoteContext);
    const wideExitSpread = this.isWideExitSpread(quoteContext);

    const engineResult = StopLossEngine.evaluate(sellablePremium, {
      entry_price: Number(position.entry_price),
      stop_loss_trigger: Number(position.stop_loss_trigger),
      take_profit_trigger: position.take_profit_trigger ? Number(position.take_profit_trigger) : undefined,
      trailing_high_price: Number(position.trailing_high_price || position.entry_price),
      trailing_stop_loss_pct: position.trailing_stop_loss_pct ? Number(position.trailing_stop_loss_pct) : undefined,
    });

    let triggered = !noBidQuote && engineResult.triggered && engineResult.triggerType === 'TAKE_PROFIT';
    let triggerType: 'STOP_LOSS' | 'TAKE_PROFIT' | undefined = triggered ? 'TAKE_PROFIT' : undefined;
    let lossAvoided = engineResult.lossAvoided;

    const entryPrice = Number(position.entry_price);
    const softPremiumStop = Number(position.stop_loss_trigger);
    const hardPremiumStop = Number(Math.max(entryPrice * 0.65, softPremiumStop * 0.85).toFixed(2));
    const softStopConfirmationMs = 10_000;
    const premiumSoftStopHit = engineResult.triggered && engineResult.triggerType === 'STOP_LOSS';
    const premiumHardStopHit = sellablePremium <= hardPremiumStop;
    const premiumTakeProfit = Number(position.take_profit_trigger || 0);
    const nearTakeProfitThreshold = premiumTakeProfit > 0 ? Number((premiumTakeProfit * 0.95).toFixed(2)) : null;

    // Strategy 1: Underlying structure informs stop-loss confirmation.
    const underlyingStop = position.suggested_stop_loss ? Number(position.suggested_stop_loss) : null;
    const underlyingTarget = position.suggested_take_profit_1 ? Number(position.suggested_take_profit_1) : null;
    const underlyingStopBroken = Boolean(
      underlyingPrice && underlyingStop &&
      (
        (position.option_type === 'CALL' && underlyingPrice <= underlyingStop) ||
        (position.option_type === 'PUT' && underlyingPrice >= underlyingStop)
      )
    );

    const stopLossCandidate = !triggered && (
      (noBidQuote && softPremiumStop > 0) ||
      premiumHardStopHit ||
      premiumSoftStopHit
    );
    const stopLossEngineEnabled = stopLossCandidate ? await this.isStopLossEngineEnabledForUser(Number(position.user_id)) : true;

    if (!triggered && stopLossEngineEnabled) {
      if (noBidQuote && softPremiumStop > 0) {
        triggered = true;
        triggerType = 'STOP_LOSS';
        lossAvoided = entryPrice - sellablePremium;
        analysis.smartStopWarning = {
          status: 'NO_BID_EMERGENCY',
          price,
          sellablePremium,
          bid: quoteContext.bid ?? null,
          ask: quoteContext.ask ?? null,
          triggeredAt: new Date().toISOString()
        };
        analysisDirty = true;
        this.fastify.log.warn(`[MarketPoller] NO-BID emergency stop triggered for position ${position.id}. Quote: bid=${quoteContext.bid ?? 0}, ask=${quoteContext.ask ?? 0}, price=${price}.`);
      } else if (premiumHardStopHit) {
        triggered = true;
        triggerType = 'STOP_LOSS';
        lossAvoided = entryPrice - sellablePremium;
        analysis.smartStopWarning = {
          status: 'HARD_STOP',
          price: sellablePremium,
          hardPremiumStop,
          triggeredAt: new Date().toISOString()
        };
        analysisDirty = true;
        this.fastify.log.info(`[MarketPoller] HARD STOP triggered for position ${position.id}: premium ${price} <= ${hardPremiumStop}`);
      } else if (premiumSoftStopHit) {
        const now = Date.now();
        const existingArmedAt = analysis.smartStopWarning?.armedAt || analysis.smartStopWarning?.triggeredAt;
        const armedAtMs = existingArmedAt ? new Date(existingArmedAt).getTime() : NaN;
        const confirmedByTime = Number.isFinite(armedAtMs) && now - armedAtMs >= softStopConfirmationMs;
        const belowStopCount = Number(analysis.smartStopWarning?.belowStopCount || 0) + 1;
        const confirmedByQuotes = belowStopCount >= 2;

        if (underlyingStopBroken || confirmedByTime || confirmedByQuotes) {
          triggered = true;
          triggerType = 'STOP_LOSS';
          lossAvoided = entryPrice - sellablePremium;
          analysis.smartStopWarning = {
            status: underlyingStopBroken
              ? 'PREMIUM_STOP_STRUCTURE_CONFIRMED'
              : confirmedByQuotes
                ? 'PREMIUM_STOP_QUOTE_CONFIRMED'
                : 'PREMIUM_STOP_TIME_CONFIRMED',
            price: sellablePremium,
            softPremiumStop,
            hardPremiumStop,
            underlyingPrice: underlyingPrice ?? null,
            underlyingStop,
            belowStopCount,
            armedAt: Number.isFinite(armedAtMs) ? existingArmedAt : new Date(now).toISOString(),
            triggeredAt: new Date(now).toISOString()
          };
          analysisDirty = true;
          this.fastify.log.info(`[MarketPoller] Premium STOP confirmed for position ${position.id}: premium ${price} <= displayed stop ${softPremiumStop}.`);
        } else {
          analysis.smartStopWarning = {
            status: 'STOP_ARMED',
            price: sellablePremium,
            softPremiumStop,
            hardPremiumStop,
            underlyingPrice: underlyingPrice ?? null,
            underlyingStop,
            belowStopCount,
            armedAt: Number.isFinite(armedAtMs) ? existingArmedAt : new Date(now).toISOString(),
            confirmationSeconds: softStopConfirmationMs / 1000
          };
          analysisDirty = true;
          this.fastify.log.info(`[MarketPoller] Premium STOP armed for position ${position.id}: premium ${price} <= displayed stop ${softPremiumStop}; waiting ${softStopConfirmationMs / 1000}s or structure break.`);
        }
      } else if (analysis.smartStopWarning) {
        delete analysis.smartStopWarning;
        analysisDirty = true;
        this.fastify.log.info(`[MarketPoller] Smart stop warning cleared for position ${position.id}: premium recovered above ${softPremiumStop}.`);
      }
    } else if (stopLossCandidate && !stopLossEngineEnabled) {
      if (analysis.smartStopWarning) {
        delete analysis.smartStopWarning;
        analysisDirty = true;
      }
      this.fastify.log.info(`[MarketPoller] Stop-loss engine disabled for user ${position.user_id}; skipping automatic stop exit for position ${position.id}.`);
    }

    if (
      !triggered
      && premiumTakeProfit > 0
      && nearTakeProfitThreshold !== null
      && takeProfitReferencePremium >= nearTakeProfitThreshold
      && String(position.profit_trim_status || '').toUpperCase() !== 'DONE'
    ) {
      if (wideExitSpread && sellablePremium < premiumTakeProfit && !this.isLateDayExitWindow()) {
        analysis.takeProfitWarning = {
          status: 'NEAR_TP_WIDE_SPREAD_BLOCKED',
          price,
          sellablePremium,
          referencePremium: takeProfitReferencePremium,
          bid: quoteContext.bid ?? null,
          ask: quoteContext.ask ?? null,
          spreadPct: quoteContext.spreadPct ?? null,
          premiumTakeProfit,
          nearTakeProfitThreshold,
          updatedAt: new Date().toISOString()
        };
        analysisDirty = true;
        this.fastify.log.info(`[MarketPoller] Near-TP limit blocked for position ${position.id}: spread ${quoteContext.spreadPct}% is too wide and bid ${sellablePremium} is below TP ${premiumTakeProfit}.`);
      } else {
        triggered = true;
        triggerType = 'TAKE_PROFIT';
        analysis.takeProfitWarning = {
          status: sellablePremium >= premiumTakeProfit ? 'PAST_TP_MARKET_READY' : 'NEAR_TP_LIMIT_READY',
          price,
          sellablePremium,
          referencePremium: takeProfitReferencePremium,
          bid: quoteContext.bid ?? null,
          ask: quoteContext.ask ?? null,
          spreadPct: quoteContext.spreadPct ?? null,
          premiumTakeProfit,
          nearTakeProfitThreshold,
          triggeredAt: new Date().toISOString()
        };
        analysisDirty = true;
        this.fastify.log.info(`[MarketPoller] Premium TAKE_PROFIT ${sellablePremium >= premiumTakeProfit ? 'past target' : 'near target'} for position ${position.id}: sellable premium ${sellablePremium}, reference premium ${takeProfitReferencePremium}, target ${premiumTakeProfit}.`);
      }
    } else if (analysis.takeProfitWarning && (!nearTakeProfitThreshold || takeProfitReferencePremium < nearTakeProfitThreshold)) {
      delete analysis.takeProfitWarning;
      analysisDirty = true;
    }

    if (underlyingPrice && underlyingTarget && !triggered) {
      const gexRegime = analysis.gexRegime || 'POSITIVE';

      if (gexRegime === 'NEGATIVE') {
        // Dynamic Trailing profit target active
        if (position.option_type === 'CALL') {
          // Check if we already hit target and activated trailing
          const hasReachedTarget = analysis.underlyingTrailingHigh !== undefined || underlyingPrice >= underlyingTarget;
          if (hasReachedTarget) {
            const currentTrailingHigh = analysis.underlyingTrailingHigh || underlyingPrice;
            const newTrailingHigh = Math.max(currentTrailingHigh, underlyingPrice);
            analysis.underlyingTrailingHigh = newTrailingHigh;

            // Trailing stop at 0.2% below trailing high
            const trailingStopPrice = newTrailingHigh * (1 - 0.002);
            this.fastify.log.info(`[MarketPoller] Negative GEX Dynamic Trailing active on position ${position.id}. High: ${newTrailingHigh.toFixed(2)}, Stop: ${trailingStopPrice.toFixed(2)}, Spot: ${underlyingPrice.toFixed(2)}`);

            if (underlyingPrice <= trailingStopPrice) {
              triggered = true;
              triggerType = 'TAKE_PROFIT';
              this.fastify.log.info(`[MarketPoller] Dynamic Trailing TAKE_PROFIT triggered for CALL: Spot ${underlyingPrice.toFixed(2)} <= Trailing Stop ${trailingStopPrice.toFixed(2)}`);
            }

            // Save updated analysis data back to the database
            await (this.fastify as any).pg.query(
              "UPDATE positions SET analysis_data = $1 WHERE id = $2",
              [JSON.stringify(analysis), position.id]
            );
            analysisDirty = false;
          }
        } else if (position.option_type === 'PUT') {
          const hasReachedTarget = analysis.underlyingTrailingLow !== undefined || underlyingPrice <= underlyingTarget;
          if (hasReachedTarget) {
            const currentTrailingLow = analysis.underlyingTrailingLow || underlyingPrice;
            const newTrailingLow = Math.min(currentTrailingLow, underlyingPrice);
            analysis.underlyingTrailingLow = newTrailingLow;

            // Trailing stop at 0.2% above trailing low
            const trailingStopPrice = newTrailingLow * (1 + 0.002);
            this.fastify.log.info(`[MarketPoller] Negative GEX Dynamic Trailing active on position ${position.id}. Low: ${newTrailingLow.toFixed(2)}, Stop: ${trailingStopPrice.toFixed(2)}, Spot: ${underlyingPrice.toFixed(2)}`);

            if (underlyingPrice >= trailingStopPrice) {
              triggered = true;
              triggerType = 'TAKE_PROFIT';
              this.fastify.log.info(`[MarketPoller] Dynamic Trailing TAKE_PROFIT triggered for PUT: Spot ${underlyingPrice.toFixed(2)} >= Trailing Stop ${trailingStopPrice.toFixed(2)}`);
            }

            // Save updated analysis data
            await (this.fastify as any).pg.query(
              "UPDATE positions SET analysis_data = $1 WHERE id = $2",
              [JSON.stringify(analysis), position.id]
            );
            analysisDirty = false;
          }
        }
      } else {
        // Standard fixed take-profit target for Positive GEX mean-reversion
        if (position.option_type === 'CALL' && underlyingPrice >= underlyingTarget) {
          triggered = true;
          triggerType = 'TAKE_PROFIT';
          this.fastify.log.info(`[MarketPoller] Strategy 1 Fixed TAKE_PROFIT triggered via underlying index price: ${underlyingPrice} >= ${underlyingTarget}`);
        } else if (position.option_type === 'PUT' && underlyingPrice <= underlyingTarget) {
          triggered = true;
          triggerType = 'TAKE_PROFIT';
          this.fastify.log.info(`[MarketPoller] Strategy 1 Fixed TAKE_PROFIT triggered via underlying index price: ${underlyingPrice} <= ${underlyingTarget}`);
        }
      }
    }

    // Update Price AND Greeks
    await (this.fastify as any).pg.query(
      `UPDATE positions 
       SET current_price = $1, 
           updated_at = CURRENT_TIMESTAMP,
           delta = $2,
           theta = $3,
           gamma = $4,
           vega = $5,
           iv = $6,
           underlying_price = $7
       WHERE id = $8`,
      [
        price,
        greeks?.delta ?? null,
        greeks?.theta ?? null,
        greeks?.gamma ?? null,
        greeks?.vega ?? null,
        iv ?? null,
        underlyingPrice ?? null,
        position.id
      ]
    );

    if (analysisDirty) {
      await (this.fastify as any).pg.query(
        "UPDATE positions SET analysis_data = $1 WHERE id = $2",
        [JSON.stringify(analysis), position.id]
      );
    }

    await (this.fastify as any).pg.query(
      'INSERT INTO price_history (position_id, price) VALUES ($1, $2)',
      [position.id, price]
    );

    const currentExecutionStatus = String(position.execution_status || '');
    if (currentExecutionStatus.startsWith('EXIT_')) {
      return;
    }

    if (['PENDING_EXIT', 'PENDING_TRIM'].includes(currentExecutionStatus)) {
      const requestedAtMs = position.exit_requested_at ? new Date(position.exit_requested_at).getTime() : NaN;
      const staleLimitExit = String(position.exit_order_type || '').toUpperCase() === 'LIMIT'
        && Number.isFinite(requestedAtMs)
        && Date.now() - requestedAtMs > 120_000;
      if (staleLimitExit) {
        await (this.fastify as any).pg.query(
          `UPDATE positions
           SET execution_status = 'EXIT_STALE',
               execution_error = 'Limit exit order is still pending after 120 seconds; verify/cancel at broker before retrying.',
               notes = COALESCE(notes, '') || $1,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $2 AND execution_status IN ('PENDING_EXIT', 'PENDING_TRIM')`,
          [' [Limit exit marked stale by market poller]', position.id]
        );
      }
      return;
    }

    if (triggered) {
      if (position.status === 'OPEN') {
        const exitTriggerType = triggerType || 'STOP_LOSS';
        const partialTrim = this.isPartialProfitTrim(position, exitTriggerType);
        const exitQuantity = partialTrim ? this.getProfitTrimQuantity(position) : Number(position.quantity || 1);
        const newStatus = 'CLOSED';
        const estimatedExitPrice = exitTriggerType === 'STOP_LOSS' || exitTriggerType === 'TAKE_PROFIT' ? sellablePremium : price;
        const realizedPnl = (estimatedExitPrice - Number(position.entry_price)) * exitQuantity * 100;

        // Execute Live SnapTrade order if not simulated
        if (!position.is_simulated) {
            this.fastify.log.info(`[MarketPoller] LIVE position ${partialTrim ? 'profit trim' : 'exit'} triggered for position ${position.id} (${position.symbol}). Executing SELL_TO_CLOSE ${exitQuantity}/${position.quantity} via SnapTrade...`);
            let limitPrice: string | undefined = undefined;
            let orderType: 'LIMIT' | 'MARKET' = 'MARKET';

            if (exitTriggerType === 'TAKE_PROFIT') {
                const takeProfitOrder = this.getTakeProfitOrderPreference(position, price, quoteContext);
                limitPrice = takeProfitOrder.limitPrice;
                orderType = takeProfitOrder.orderType;
                this.fastify.log.info(`[MarketPoller] TAKE_PROFIT order preference for position ${position.id}: ${orderType}${limitPrice ? ` @ $${limitPrice}` : ''} (${takeProfitOrder.mode}).`);
            }

            const submitted = await this.submitSnapTradeExit(position, orderType, limitPrice, exitTriggerType, exitQuantity);
            if (submitted) {
              await (this.fastify as any).pg.query(
                'INSERT INTO alerts (position_id, trigger_type, trigger_price, actual_price) VALUES ($1, $2, $3, $4)',
                [position.id, exitTriggerType, exitTriggerType === 'TAKE_PROFIT' ? (position.suggested_take_profit_1 || position.take_profit_trigger) : (position.suggested_stop_loss || position.stop_loss_trigger), price]
              );
              this.notifyN8n(
                position,
                price,
                realizedPnl,
                lossAvoided,
                exitTriggerType,
                partialTrim
                  ? `${exitTriggerType} profit trim submitted for ${exitQuantity}/${position.quantity} contracts; waiting for broker fill confirmation.`
                  : `${exitTriggerType} exit order submitted; waiting for broker fill confirmation.`,
                partialTrim
                  ? `**[${exitTriggerType} TRIM SUBMITTED]** ${position.symbol} ${position.option_type} ${position.strike_price}. ${orderType} SELL_TO_CLOSE ${exitQuantity}/${position.quantity} submitted; waiting for broker fill. Last app price: $${price.toFixed(2)}.`
                  : `**[${exitTriggerType} EXIT SUBMITTED]** ${position.symbol} ${position.option_type} ${position.strike_price}. ${orderType} SELL_TO_CLOSE submitted; waiting for broker fill. Last app price: $${price.toFixed(2)}.`
              );
            }
            return;
        } else if (position.account_id === 'alpaca_paper') {
            try {
                const userSettings = await getSettingsWithGlobalFallback((this.fastify as any).pg, position.user_id);
                const alpacaKeyId = userSettings.alpaca_key_id?.trim() || '';
                const alpacaSecretKey = userSettings.alpaca_secret_key?.trim() || '';
                const alpacaAutoTrade = userSettings.alpaca_auto_trade?.trim() || 'false';

                if (alpacaAutoTrade !== 'true') {
                    this.fastify.log.info(`[MarketPoller] Alpaca auto-trade is disabled for user ${position.user_id}. Skipping automatic exit closure for position ${position.id}.`);
                    return;
                }

                if (alpacaKeyId && alpacaSecretKey) {
                    this.fastify.log.info(`[MarketPoller] Alpaca paper position exit triggered for position ${position.id} (${position.symbol}). Executing SELL via Alpaca...`);
                    const osiTicker = this.constructOSITicker(
                        position.symbol, 
                        Number(position.strike_price), 
                        position.option_type, 
                        position.expiration_date
                    );
                    
                    const takeProfitOrder = exitTriggerType === 'TAKE_PROFIT'
                      ? this.getTakeProfitOrderPreference(position, price, quoteContext)
                      : null;
                    const exitLimitPrice = takeProfitOrder?.limitPrice ? Number(takeProfitOrder.limitPrice) : undefined;

                    const exitPayload: any = {
                        symbol: osiTicker,
                        qty: exitQuantity,
                        side: 'sell',
                        type: takeProfitOrder?.orderType === 'LIMIT' ? 'limit' : 'market',
                        time_in_force: 'day'
                    };
                    if (exitLimitPrice) {
                        exitPayload.limit_price = exitLimitPrice.toString();
                    }

                    this.fastify.log.info(`[MarketPoller] Placing Alpaca ${exitPayload.type} exit for position ${position.id} (${osiTicker})${exitLimitPrice ? ` @ limit $${exitLimitPrice}` : ''}`);
                    const res = await fetch('https://paper-api.alpaca.markets/v2/orders', {
                        method: 'POST',
                        headers: {
                            'APCA-API-KEY-ID': alpacaKeyId,
                            'APCA-API-SECRET-KEY': alpacaSecretKey,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(exitPayload)
                    });
                    if (!res.ok) {
                        const errText = await res.text();
                        throw new Error(`Alpaca paper exit failed: ${res.status} - ${errText}`);
                    }
                    const orderData: any = await res.json();
                    await (this.fastify as any).pg.query(
                        `UPDATE positions
                         SET execution_status = $1,
                             execution_error = NULL,
                             broker_exit_order_id = $2,
                             exit_requested_at = CURRENT_TIMESTAMP,
                             exit_reason = COALESCE(exit_reason, $3),
                             profit_trim_status = CASE WHEN $1 = 'PENDING_TRIM' THEN 'PENDING' ELSE profit_trim_status END,
                             profit_trim_quantity = CASE WHEN $1 = 'PENDING_TRIM' THEN $4 ELSE profit_trim_quantity END,
                             profit_trim_order_id = CASE WHEN $1 = 'PENDING_TRIM' THEN $2 ELSE profit_trim_order_id END,
                             notes = COALESCE(notes, '') || $5,
                             updated_at = CURRENT_TIMESTAMP
                         WHERE id = $6 AND status = 'OPEN'`,
                        [
                          partialTrim ? 'PENDING_TRIM' : 'PENDING_EXIT',
                          orderData.id || null,
                          partialTrim ? 'PROFIT_TRIM' : 'AUTO_EXIT',
                          exitQuantity,
                          partialTrim
                            ? ` [Alpaca paper profit trim submitted for ${exitQuantity}/${position.quantity}${orderData.id ? `: ${orderData.id}` : ''}]`
                            : ` [Alpaca paper exit submitted${orderData.id ? `: ${orderData.id}` : ''}]`,
                          position.id
                        ]
                    );
                    this.fastify.log.info(`[MarketPoller] Alpaca paper exit execution successful for position ${position.id}.`);
                    return;
                }
            } catch (err: any) {
                this.fastify.log.error(`[MarketPoller] Alpaca paper exit execution failed for position ${position.id}: ${err.message}`);
                await this.markExitSubmissionFailure(position, err.message || String(err));
                return;
            }
        }

        const updateResult = partialTrim
          ? await (this.fastify as any).pg.query(
              `UPDATE positions
               SET quantity = quantity - $1,
                   realized_pnl = COALESCE(realized_pnl, 0) + $2,
                   profit_trim_status = 'DONE',
                   profit_trim_quantity = $1,
                   profit_trim_price = $3,
                   profit_trimmed_at = CURRENT_TIMESTAMP,
                   stop_loss_trigger = GREATEST(COALESCE(stop_loss_trigger, 0), entry_price),
                   take_profit_trigger = NULL,
                   notes = COALESCE(notes, '') || $4,
                   updated_at = CURRENT_TIMESTAMP
               WHERE id = $5 AND status = 'OPEN' AND quantity > $1`,
              [exitQuantity, realizedPnl, price, ` [Profit trim simulated: sold ${exitQuantity}/${position.quantity} via ${exitTriggerType}]`, position.id]
            )
          : await (this.fastify as any).pg.query(
              `UPDATE positions
                  SET status = $1,
                  loss_avoided = $2,
                  realized_pnl = COALESCE(realized_pnl, 0) + $3,
                  notes = COALESCE(notes, '') || $4,
                  updated_at = CURRENT_TIMESTAMP
                  WHERE id = $5 AND status = 'OPEN'`,
              [newStatus, lossAvoided, realizedPnl, ` [Closed via Underlying-Triggered ${exitTriggerType} Strategy]`, position.id]
            );

        if (updateResult.rowCount === 0) {
          // Already updated or state mismatch, skip AI alert
          return;
        }

        await (this.fastify as any).pg.query(
          'INSERT INTO alerts (position_id, trigger_type, trigger_price, actual_price) VALUES ($1, $2, $3, $4)',
          [position.id, exitTriggerType, exitTriggerType === 'TAKE_PROFIT' ? (position.suggested_take_profit_1 || position.take_profit_trigger) : (position.suggested_stop_loss || position.stop_loss_trigger), price]
        );

        // Generate AI Summary for the alert (Discord Message)
        let aiData = { summary: '', discord_message: '' };
        try {
          aiData = await this.aiService.generateAlertSummary({
            symbol: position.symbol,
            type: position.option_type,
            strike: position.strike_price,
            expiration: position.expiration_date,
            event: exitTriggerType === 'TAKE_PROFIT' ? 'TAKE_PROFIT_TRIGGERED' : 'STOP_LOSS_TRIGGERED',
            price: price,
            pnl: ((price - Number(position.entry_price)) / Number(position.entry_price) * 100).toFixed(2),
            greeks: {
              delta: greeks?.delta ?? position.delta,
              theta: greeks?.theta ?? position.theta,
              iv: iv ?? position.iv
            },
            underlying_price: underlyingPrice ?? position.underlying_price
          }, position.user_id);
        } catch (err) {
          this.fastify.log.error(`[MarketPoller] AI Summary generation failed: ${err}`);
        }

        this.notifyN8n(position, price, realizedPnl, lossAvoided, exitTriggerType, aiData.summary, aiData.discord_message, greeks, iv);
      }
    } else if (engineResult.newHigh || engineResult.newStopLoss) {
      await (this.fastify as any).pg.query(
        `UPDATE positions 
         SET trailing_high_price = COALESCE($1, trailing_high_price),
             stop_loss_trigger = COALESCE($2, stop_loss_trigger),
             updated_at = CURRENT_TIMESTAMP 
         WHERE id = $3`,
        [engineResult.newHigh, engineResult.newStopLoss, position.id]
      );
    }
  }

  private async notifyN8n(position: any, price: number, pnl: number, lossAvoided?: number, type: string = 'STOP_LOSS', aiSummary?: string, discordMessage?: string, greeks?: any, iv?: number) {
    const username = position.username || 'Unknown';
    const N8N_WEBHOOK_URL = process.env.N8N_ALERT_WEBHOOK_URL;
    if (!N8N_WEBHOOK_URL) return;

    try {
      await fetch(N8N_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: type === 'TAKE_PROFIT' ? 'TAKE_PROFIT_TRIGGERED' : 'STOP_LOSS_TRIGGERED',
          notification_type: 'alert',
          username: username,
          symbol: position.symbol,
          ticker: position.symbol,
          option_type: position.option_type,
          strike_price: position.strike_price,
          expiration_date: position.expiration_date,
          price: price,
          pnl: pnl,
          loss_avoided: lossAvoided,
          position_id: position.id,
          ai_summary: aiSummary,
          discord_message: `**[User: ${username}]**\n${discordMessage}`,
          greeks: greeks,
          iv: iv,
          timestamp: new Date().toISOString()
        })
      });
    } catch (err: any) {
      this.fastify.log.error('[MarketPoller] Failed to notify n8n:', err.message);
    }
  }
  // ═══ Alpaca WebSocket Trade Updates Stream ═══════════════════════════════

  /**
   * Connects to Alpaca's paper trading WebSocket stream and subscribes
   * to trade_updates. On fill events, instantly syncs position status
   * in our database and broadcasts to the frontend.
   */
  private async startAlpacaStream() {
    // Find any user with Alpaca credentials configured
    try {
      const { rows } = await (this.fastify as any).pg.query(
        `SELECT s1.user_id, s1.value as key_id, s2.value as secret_key
         FROM settings s1
         JOIN settings s2 ON s1.user_id = s2.user_id AND s2.key = 'alpaca_secret_key'
         WHERE s1.key = 'alpaca_key_id' AND s1.value != '' AND s2.value != ''
         LIMIT 1`
      );

      if (rows.length === 0) {
        this.fastify.log.info('[AlpacaStream] No Alpaca credentials configured. Stream not started.');
        return;
      }

      const { key_id, secret_key } = rows[0];
      this.connectAlpacaStream(key_id.trim(), secret_key.trim());
    } catch (err: any) {
      this.fastify.log.error(`[AlpacaStream] Failed to load Alpaca credentials: ${err.message}`);
    }
  }

  private connectAlpacaStream(keyId: string, secretKey: string) {
    if (this.alpacaWs) {
      try { this.alpacaWs.close(); } catch (_) {}
    }

    this.fastify.log.info('[AlpacaStream] Connecting to wss://paper-api.alpaca.markets/stream...');
    const ws = new WebSocket('wss://paper-api.alpaca.markets/stream');
    this.alpacaWs = ws;

    ws.on('open', () => {
      this.fastify.log.info('[AlpacaStream] Connected. Authenticating...');
      ws.send(JSON.stringify({
        action: 'authenticate',
        data: { key_id: keyId, secret_key: secretKey }
      }));
    });

    ws.on('message', async (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());

        // Authentication response
        if (msg.stream === 'authorization') {
          if (msg.data?.status === 'authorized') {
            this.fastify.log.info('[AlpacaStream] Authenticated. Subscribing to trade_updates...');
            this.alpacaReconnectAttempts = 0;
            this.alpacaStreamActive = true;
            ws.send(JSON.stringify({
              action: 'listen',
              data: { streams: ['trade_updates'] }
            }));
          } else {
            this.fastify.log.error(`[AlpacaStream] Authentication failed: ${JSON.stringify(msg.data)}`);
          }
          return;
        }

        // Subscription confirmation
        if (msg.stream === 'listening') {
          this.fastify.log.info(`[AlpacaStream] Subscribed to streams: ${JSON.stringify(msg.data?.streams)}`);
          return;
        }

        // Trade update events
        if (msg.stream === 'trade_updates') {
          await this.handleAlpacaTradeUpdate(msg.data);
        }
      } catch (parseErr: any) {
        this.fastify.log.error(`[AlpacaStream] Failed to parse message: ${parseErr.message}`);
      }
    });

    ws.on('error', (err: Error) => {
      this.fastify.log.error(`[AlpacaStream] WebSocket error: ${err.message}`);
    });

    ws.on('close', (code: number, reason: Buffer) => {
      this.alpacaStreamActive = false;
      this.fastify.log.warn(`[AlpacaStream] Connection closed (code: ${code}, reason: ${reason.toString()}). Scheduling reconnect...`);
      this.scheduleAlpacaReconnect(keyId, secretKey);
    });
  }

  private scheduleAlpacaReconnect(keyId: string, secretKey: string) {
    if (this.alpacaReconnectTimer) clearTimeout(this.alpacaReconnectTimer);

    // Exponential backoff: 2s, 4s, 8s, 16s, 32s, max 60s
    const delay = Math.min(60000, Math.pow(2, this.alpacaReconnectAttempts + 1) * 1000);
    this.alpacaReconnectAttempts++;

    this.fastify.log.info(`[AlpacaStream] Reconnecting in ${delay / 1000}s (attempt ${this.alpacaReconnectAttempts})...`);
    this.alpacaReconnectTimer = setTimeout(() => {
      this.connectAlpacaStream(keyId, secretKey);
    }, delay);
  }

  private async handleAlpacaTradeUpdate(data: any) {
    const event = data?.event;
    const order = data?.order;

    if (!event || !order) return;

    const orderId = order.id;
    const orderSymbol = order.symbol; // OSI ticker
    const orderSide = order.side; // 'buy' or 'sell'
    const filledQty = Number(order.filled_qty || 0);
    const filledAvgPrice = Number(order.filled_avg_price || 0);
    const orderStatus = order.status;

    this.fastify.log.info(`[AlpacaStream] Trade update: ${event} | ${orderSymbol} | Side: ${orderSide} | Status: ${orderStatus} | Filled: ${filledQty} @ $${filledAvgPrice}`);

    switch (event) {
      case 'fill': {
        // Order fully filled
        if (orderSide === 'buy') {
          // Entry fill — update the position's entry price with actual fill price
          try {
            const { rows } = await (this.fastify as any).pg.query(
              `UPDATE positions
               SET status = 'OPEN',
                   execution_status = 'EXECUTED',
                   entry_price = $1,
                   current_price = $1,
                   trailing_high_price = $1,
                   updated_at = CURRENT_TIMESTAMP
               WHERE account_id = 'alpaca_paper'
                 AND status IN ('PENDING_ORDER', 'OPEN')
                 AND broker_order_id = $2
               RETURNING user_id`,
              [filledAvgPrice, orderId]
            );
            for (const row of rows) {
              await this.redisClient.del(`USER_POSITIONS:${row.user_id}`);
              await this.redisClient.del(`USER_STATS:${row.user_id}`);
            }
            this.fastify.log.info(`[AlpacaStream] Entry fill recorded: ${orderSymbol} @ $${filledAvgPrice}`);
          } catch (err: any) {
            this.fastify.log.error(`[AlpacaStream] Failed to update entry fill: ${err.message}`);
          }
        } else if (orderSide === 'sell') {
          // Exit fill — close the position with actual exit price
          try {
            const parsedOsi = this.parseCompactOsiTicker(orderSymbol);
            const { rows } = await (this.fastify as any).pg.query(
              `SELECT id, entry_price, quantity, user_id, execution_status, exit_reason, profit_trim_quantity FROM positions
               WHERE account_id = 'alpaca_paper'
                 AND status = 'OPEN'
                 AND (
                   broker_exit_order_id = $1
                   OR (
                     $2::text IS NOT NULL
                     AND symbol = $2
                     AND option_type = $3
                     AND strike_price = $4
                     AND expiration_date = $5
                   )
                 )
               ORDER BY
                 CASE WHEN broker_exit_order_id = $1 THEN 0 ELSE 1 END,
                 created_at DESC
               LIMIT 1`,
              [
                orderId,
                parsedOsi?.root || null,
                parsedOsi?.optionType || null,
                parsedOsi?.strike || null,
                parsedOsi?.expiration || null
              ]
            );

            if (rows.length > 0) {
              const pos = rows[0];
              const currentQty = Number(pos.quantity || 1);
              const requestedQty = Number(pos.profit_trim_quantity || filledQty || currentQty);
              const closeQty = Math.min(Number(filledQty || requestedQty || currentQty), currentQty);
              const realizedPnl = (filledAvgPrice - Number(pos.entry_price)) * closeQty * 100;
              const isTrim = (pos.execution_status === 'PENDING_TRIM' || pos.exit_reason === 'PROFIT_TRIM') && closeQty < currentQty;
              if (isTrim) {
                await (this.fastify as any).pg.query(
                  `UPDATE positions
                   SET quantity = quantity - $1,
                       execution_status = 'FILLED',
                       current_price = $2,
                       realized_pnl = COALESCE(realized_pnl, 0) + $3,
                       execution_error = NULL,
                       broker_exit_order_id = NULL,
                       profit_trim_status = 'DONE',
                       profit_trim_quantity = $1,
                       profit_trim_price = $2,
                       profit_trimmed_at = CURRENT_TIMESTAMP,
                       stop_loss_trigger = GREATEST(COALESCE(stop_loss_trigger, 0), entry_price),
                       take_profit_trigger = NULL,
                       updated_at = CURRENT_TIMESTAMP
                   WHERE id = $4`,
                  [closeQty, filledAvgPrice, realizedPnl, pos.id]
                );
                this.fastify.log.info(`[AlpacaStream] Profit trim fill recorded: ${orderSymbol} ${closeQty}/${currentQty} @ $${filledAvgPrice} | P&L: $${realizedPnl.toFixed(2)}`);
              } else {
                await (this.fastify as any).pg.query(
                  `UPDATE positions SET status = 'CLOSED', current_price = $1, exit_price = $1,
                   realized_pnl = COALESCE(realized_pnl, 0) + $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
                  [filledAvgPrice, realizedPnl, pos.id]
                );
                this.fastify.log.info(`[AlpacaStream] Exit fill recorded: ${orderSymbol} @ $${filledAvgPrice} | P&L: $${realizedPnl.toFixed(2)}`);
              }

              // Invalidate frontend caches
              await this.redisClient.del(`USER_POSITIONS:${pos.user_id}`);
              await this.redisClient.del(`USER_STATS:${pos.user_id}`);
            }
          } catch (err: any) {
            this.fastify.log.error(`[AlpacaStream] Failed to update exit fill: ${err.message}`);
          }
        }

        // Broadcast to frontend
        this.broadcastToFrontend({ type: 'ALPACA_FILL', data: { event, symbol: orderSymbol, side: orderSide, price: filledAvgPrice, qty: filledQty } });
        break;
      }

      case 'partial_fill': {
        this.fastify.log.info(`[AlpacaStream] Partial fill: ${orderSymbol} ${filledQty} @ $${filledAvgPrice}`);
        this.broadcastToFrontend({ type: 'ALPACA_PARTIAL_FILL', data: { event, symbol: orderSymbol, side: orderSide, price: filledAvgPrice, qty: filledQty } });
        break;
      }

      case 'canceled':
      case 'rejected': {
        this.fastify.log.warn(`[AlpacaStream] Order ${event}: ${orderSymbol} | ID: ${orderId} | Reason: ${order.reject_reason || 'N/A'}`);
        try {
          const { rows } = await (this.fastify as any).pg.query(
            `UPDATE positions
             SET status = 'CLOSED',
                 execution_status = $1,
                 execution_error = $2,
                 notes = COALESCE(notes, '') || $3,
                 updated_at = CURRENT_TIMESTAMP
             WHERE account_id = 'alpaca_paper'
               AND status = 'PENDING_ORDER'
               AND broker_order_id = $4
             RETURNING user_id`,
            [event.toUpperCase(), order.reject_reason || null, ` [Order ${event}]`, orderId]
          );
          for (const row of rows) {
            await this.redisClient.del(`USER_POSITIONS:${row.user_id}`);
            await this.redisClient.del(`USER_STATS:${row.user_id}`);
          }
        } catch (err: any) {
          this.fastify.log.error(`[AlpacaStream] Failed to update ${event} order state: ${err.message}`);
        }
        this.broadcastToFrontend({ type: 'ALPACA_ORDER_EVENT', data: { event, symbol: orderSymbol, orderId, reason: order.reject_reason } });
        break;
      }

      default:
        this.fastify.log.debug(`[AlpacaStream] Unhandled event: ${event}`);
    }
  }

  private broadcastToFrontend(message: any) {
    if (this.fastify.websocketServer) {
      const payload = JSON.stringify(message);
      this.fastify.websocketServer.clients.forEach((client: any) => {
        if (client.readyState === 1) {
          client.send(payload);
        }
      });
    }
  }
}
