import cron from 'node-cron';
import { FastifyInstance } from 'fastify';
import { spawn } from 'child_process';
import { StopLossEngine } from './stop-loss-engine';
import { redis } from '../lib/redis';
import { AIService } from './ai-service';

export class MarketPoller {
  private fastify: FastifyInstance;
  private aiService: AIService;

  constructor(fastify: FastifyInstance) {
    this.fastify = fastify;
    this.aiService = new AIService(fastify);
  }

  public start() {
    const interval = process.env.MARKET_DATA_POLL_INTERVAL || '*/15 * * * *';
    console.log(`[MarketPoller] Starting polling job with interval: ${interval}`);

    cron.schedule(interval, async () => {
      try {
        await this.poll();
      } catch (err) {
        console.error('[MarketPoller] Error during poll execution:', err);
      }
    });

    this.poll().catch(err => console.error('[MarketPoller] Initial poll failed:', err));
    this.startBriefingJob();
  }

  private startBriefingJob() {
    // Default to 8:30 AM ET
    const schedule = process.env.MORNING_BRIEFING_SCHEDULE || '30 8 * * *';
    console.log(`[MarketPoller] Starting morning briefing job with schedule: ${schedule}`);

    cron.schedule(schedule, async () => {
      try {
        await this.sendMorningBriefings();
      } catch (err) {
        console.error('[MarketPoller] Error during morning briefing execution:', err);
      }
    });
  }

  public async sendMorningBriefings(ignoreFrequency: boolean = false) {
    console.log(`[MarketPoller] Executing morning briefings (ignoreFrequency: ${ignoreFrequency})...`);
    const { rows: users } = await this.fastify.pg.query('SELECT DISTINCT p.user_id, u.username FROM positions p JOIN users u ON p.user_id = u.id');

    for (const { user_id: userId, username } of users) {
      try {
        // 1. Check user settings for briefing frequency
        const { rows: settingsRows } = await this.fastify.pg.query(
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
        const { rows: positions } = await this.fastify.pg.query(
          "SELECT p.*, u.username FROM positions p JOIN users u ON p.user_id = u.id WHERE p.user_id = $1 AND p.status != 'CLOSED'",
          [userId]
        );

        if (positions.length === 0) continue;

        // 4. Generate AI briefing
        console.log(`[MarketPoller] Generating briefing for user ${userId}...`);
        const briefingData = await this.aiService.generateBriefing(positions);

        // 5. Notify N8n
        await this.notifyN8nBriefing(userId, username, briefingData.briefing, briefingData.discord_message);

      } catch (err) {
        console.error(`[MarketPoller] Failed to send briefing for user ${userId}:`, err);
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
      console.log(`[MarketPoller] Briefing sent to n8n for user ${userId}`);
    } catch (err: any) {
      console.error(`[MarketPoller] Failed to notify n8n for briefing (user ${userId}):`, err.message);
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
      console.warn(`[MarketPoller] Invalid expiration date format: ${expiration}`);
      return `${symbol.toUpperCase()}XXXXXX${type === 'CALL' ? 'C' : 'P'}${Math.round(strike * 1000).toString().padStart(8, '0')}`;
    }

    const YY = parts[0].slice(-2);
    const MM = parts[1].padStart(2, '0');
    const DD = parts[2].padStart(2, '0');

    const side = type === 'CALL' ? 'C' : 'P';
    const strikeValue = Math.round(strike * 1000).toString().padStart(8, '0');

    return `${symbol.toUpperCase()}${YY}${MM}${DD}${side}${strikeValue}`;
  }

  private async getOptionPremium(symbol: string, strike: number, type: 'CALL' | 'PUT', expiration: string, skipCache: boolean = false): Promise<any | null> {
    const ticker = this.constructOSITicker(symbol, strike, type, expiration);

    // Redis Cache Check
    const CACHE_KEY = `PRICE:${ticker}`;
    const CACHE_TTL = 300; // 5 minutes

    if (!skipCache) {
      const cached = await redis.get(CACHE_KEY);
      if (cached) {
        // console.log(`[MarketPoller] Cache hit for ${ticker}`);
        return JSON.parse(cached);
      }
    } else {
      console.log(`[MarketPoller] Cache bypass (force sync) for ${ticker}`);
    }

    // console.log(`[MarketPoller] Fetching premium for: ${ticker}`);

    return new Promise((resolve) => {
      const pythonProcess = spawn('python3', ['/app/src/scripts/fetch_option_price.py', ticker]);

      let dataString = '';

      pythonProcess.stdout.on('data', (data: Buffer) => {
        dataString += data.toString();
      });

      pythonProcess.stderr.on('data', (data: Buffer) => {
        console.error(`[MarketPoller] Python stderr: ${data}`);
      });

      pythonProcess.on('close', (code: number) => {
        try {
          // Handle potential noisy output from Python dependencies (e.g., "Mibian req...")
          // by scanning lines backwards to find the last valid JSON object
          const lines = dataString.trim().split('\n');
          let result = null;

          for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i].trim();
            if (!line) continue;

            try {
              const parsed = JSON.parse(line);
              // Validate it's our expected response format
              if (parsed && (parsed.status === 'ok' || parsed.status === 'error')) {
                result = parsed;
                break;
              }
            } catch (parseErr) {
              // Not a JSON line, likely a log from a dependency - continue searching
              continue;
            }
          }

          if (!result) {
            console.warn(`[MarketPoller] Failed to find valid JSON in output for ${ticker}. Raw output (first 200 chars): ${dataString.substring(0, 200)}`);
            resolve(null);
            return;
          }

          if (result.status === 'ok' && typeof result.price === 'number') {
            // Enrich with metadata for easier Redis inspection
            result.metadata = {
              symbol: symbol,
              strike: strike,
              type: type,
              expiration: expiration,
            };
            redis.set(CACHE_KEY, JSON.stringify(result), CACHE_TTL).catch(err => console.error('[MarketPoller] Redis set failed:', err));
            resolve(result); // Return full object { price, greeks, iv ... }
          } else {
            console.warn(`[MarketPoller] Retrieval failed for ${ticker}: ${result.message}`);
            resolve(null);
          }
        } catch (e) {
          console.error(`[MarketPoller] Error processing output for ${ticker}:`, e);
          resolve(null);
        }
      });

      pythonProcess.on('error', (err: Error) => {
        console.error(`[MarketPoller] Python process error:`, err);
        resolve(null);
      });
    });
  }

  public async syncPrice(symbol: string, skipCache: boolean = false) {
    console.log(`[MarketPoller] TARGETED Sync for symbol: ${symbol}`);
    const { rows: positions } = await this.fastify.pg.query(
      "SELECT p.*, u.username FROM positions p JOIN users u ON p.user_id = u.id WHERE p.symbol = $1 AND p.status != 'CLOSED'",
      [symbol]
    );

    if (positions.length === 0) {
      console.log(`[MarketPoller] No active or triggered positions found for ${symbol}.`);
      return null;
    }

    let lastFetchedPrice = null;

    for (const position of positions) {
      const data = await this.getOptionPremium(
        position.symbol,
        Number(position.strike_price),
        position.option_type,
        position.expiration_date,
        skipCache
      );

      if (data && data.price !== null) {
        // console.log(`[MarketPoller] ${position.symbol} ${position.option_type} $${position.strike_price} -> Premium: $${data.price}`);
        console.log(`[MarketPoller] ${position.symbol} Price: ${data.price} IV: ${data.iv} Underlying: ${data.underlying_price} Greeks:`, data.greeks);
        await this.processUpdate(position, data.price, data.greeks, data.iv, data.underlying_price);
        lastFetchedPrice = data.price;
      }
    }
    if (lastFetchedPrice !== null) {
      console.log(`[MarketPoller] TARGETED Sync for ${symbol} completed successfully.`);
    } else {
      console.warn(`[MarketPoller] TARGETED Sync for ${symbol} failed or no positions were updated.`);
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
    if (!force && !this.isMarketOpen()) {
      console.log(`[MarketPoller] Skipping scheduled poll at ${new Date().toISOString()}: Market is closed.`);
      return;
    }

    console.log(`[MarketPoller] ${force ? 'FORCED ' : ''}Polling option premiums via yfinance at ${new Date().toISOString()}...`);

    // Poll all non-CLOSED positions so user sees up-to-date price until they manually close
    const { rows: positions } = await this.fastify.pg.query(
      "SELECT p.*, u.username FROM positions p JOIN users u ON p.user_id = u.id WHERE p.status != 'CLOSED'"
    );

    if (positions.length === 0) {
      console.log('[MarketPoller] No active positions to poll.');
      return;
    }

    const symbols = [...new Set(positions.map(p => p.symbol))];

    for (const symbol of symbols) {
      await this.syncPrice(symbol, force);
      // Stay within limits, sequential delay
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  private async processUpdate(position: any, price: number, greeks?: any, iv?: number, underlyingPrice?: number) {
    const engineResult = StopLossEngine.evaluate(price, {
      entry_price: Number(position.entry_price),
      stop_loss_trigger: Number(position.stop_loss_trigger),
      take_profit_trigger: position.take_profit_trigger ? Number(position.take_profit_trigger) : undefined,
      trailing_high_price: Number(position.trailing_high_price || position.entry_price),
      trailing_stop_loss_pct: position.trailing_stop_loss_pct ? Number(position.trailing_stop_loss_pct) : undefined,
    });

    // Update Price AND Greeks
    await this.fastify.pg.query(
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

    await this.fastify.pg.query(
      'INSERT INTO price_history (position_id, price) VALUES ($1, $2)',
      [position.id, price]
    );

    if (engineResult.triggered) {
      // Logic Change: Do NOT close automatically. Just set status to STOP_TRIGGERED or PROFIT_TRIGGERED.
      // Only notify if we haven't already set it to STOP_TRIGGERED/PROFIT_TRIGGERED (avoid spamming n8n every 15 mins)

      if (position.status === 'OPEN') {
        const triggerType = engineResult.triggerType || 'STOP_LOSS';
        const newStatus = triggerType === 'TAKE_PROFIT' ? 'PROFIT_TRIGGERED' : 'STOP_TRIGGERED';

        await this.fastify.pg.query(
          `UPDATE positions 
             SET status = $1, 
                 updated_at = CURRENT_TIMESTAMP 
             WHERE id = $2 AND status = 'OPEN'`,
          [newStatus, position.id]
        );

        await this.fastify.pg.query(
          'INSERT INTO alerts (position_id, trigger_type, trigger_price, actual_price) VALUES ($1, $2, $3, $4)',
          [position.id, triggerType, triggerType === 'TAKE_PROFIT' ? position.take_profit_trigger : position.stop_loss_trigger, price]
        );

        // Generate AI Summary for the alert (Discord Message)
        let aiData = { summary: '', discord_message: '' };
        try {
          aiData = await this.aiService.generateAlertSummary({
            symbol: position.symbol,
            type: position.option_type,
            strike: position.strike_price,
            expiration: position.expiration_date,
            event: triggerType === 'TAKE_PROFIT' ? 'TAKE_PROFIT_TRIGGERED' : 'STOP_LOSS_TRIGGERED',
            price: price,
            pnl: ((price - Number(position.entry_price)) / Number(position.entry_price) * 100).toFixed(2),
            greeks: {
              delta: greeks?.delta ?? position.delta,
              theta: greeks?.theta ?? position.theta,
              iv: iv ?? position.iv
            },
            underlying_price: underlyingPrice ?? position.underlying_price
          });
        } catch (err) {
          console.error('[MarketPoller] AI Summary generation failed:', err);
        }

        // Calculate realized PnL
        const realizedPnl = (price - Number(position.entry_price)) * position.quantity * 100;

        this.notifyN8n(position, price, realizedPnl, engineResult.lossAvoided, triggerType, aiData.summary, aiData.discord_message, greeks, iv);
      }
    } else if (engineResult.newHigh || engineResult.newStopLoss) {
      await this.fastify.pg.query(
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
      console.error('[MarketPoller] Failed to notify n8n:', err.message);
    }
  }
}
