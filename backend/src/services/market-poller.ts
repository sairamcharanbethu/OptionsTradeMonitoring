import cron from 'node-cron';
import { FastifyInstance } from 'fastify';
import { spawn } from 'child_process';
import { StopLossEngine } from './stop-loss-engine';

export class MarketPoller {
  private fastify: FastifyInstance;

  constructor(fastify: FastifyInstance) {
    this.fastify = fastify;
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

  private async getOptionPremium(symbol: string, strike: number, type: 'CALL' | 'PUT', expiration: string): Promise<any | null> {
    const ticker = this.constructOSITicker(symbol, strike, type, expiration);
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
          // Log raw output for debugging if needed
          // console.log(`[MarketPoller] Raw Python output: ${dataString}`);

          const result = JSON.parse(dataString);
          if (result.status === 'ok' && typeof result.price === 'number') {
            resolve(result); // Return full object { price, greeks, iv ... }
          } else {
            console.warn(`[MarketPoller] Retrieval failed for ${ticker}: ${result.message}`);
            resolve(null);
          }
        } catch (e) {
          console.error(`[MarketPoller] Failed to parse output for ${ticker}:`, e);
          resolve(null);
        }
      });

      pythonProcess.on('error', (err: Error) => {
        console.error(`[MarketPoller] Python process error:`, err);
        resolve(null);
      });
    });
  }

  public async syncPrice(symbol: string) {
    console.log(`[MarketPoller] TARGETED Sync for symbol: ${symbol}`);
    const { rows: positions } = await this.fastify.pg.query(
      "SELECT * FROM positions WHERE symbol = $1 AND status != 'CLOSED'",
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
        position.expiration_date
      );

      if (data && data.price !== null) {
        // console.log(`[MarketPoller] ${position.symbol} ${position.option_type} $${position.strike_price} -> Premium: $${data.price}`);
        console.log(`[MarketPoller] ${position.symbol} Price: ${data.price} IV: ${data.iv} Greeks:`, data.greeks);
        await this.processUpdate(position, data.price, data.greeks, data.iv);
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
      "SELECT * FROM positions WHERE status != 'CLOSED'"
    );

    if (positions.length === 0) {
      console.log('[MarketPoller] No active positions to poll.');
      return;
    }

    const symbols = [...new Set(positions.map(p => p.symbol))];

    for (const symbol of symbols) {
      await this.syncPrice(symbol);
      // Stay within limits, sequential delay
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  private async processUpdate(position: any, price: number, greeks?: any, iv?: number) {
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
           iv = $6
       WHERE id = $7`,
      [
        price,
        greeks?.delta || null,
        greeks?.theta || null,
        greeks?.gamma || null,
        greeks?.vega || null,
        iv || null,
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
           WHERE id = $2`,
          [newStatus, position.id]
        );

        await this.fastify.pg.query(
          'INSERT INTO alerts (position_id, trigger_type, trigger_price, actual_price) VALUES ($1, $2, $3, $4)',
          [position.id, triggerType, triggerType === 'TAKE_PROFIT' ? position.take_profit_trigger : position.stop_loss_trigger, price]
        );

        this.notifyN8n(position, price, 0, engineResult.lossAvoided, triggerType);
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

  private async notifyN8n(position: any, price: number, pnl: number, lossAvoided?: number, type: string = 'STOP_LOSS') {
    const N8N_WEBHOOK_URL = process.env.N8N_ALERT_WEBHOOK_URL;
    if (!N8N_WEBHOOK_URL) return;

    try {
      await fetch(N8N_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: type === 'TAKE_PROFIT' ? 'TAKE_PROFIT_TRIGGERED' : 'STOP_LOSS_TRIGGERED',
          symbol: position.symbol,
          price: price,
          pnl: pnl,
          loss_avoided: lossAvoided,
          position_id: position.id
        })
      });
    } catch (err: any) {
      console.error('[MarketPoller] Failed to notify n8n:', err.message);
    }
  }
}
