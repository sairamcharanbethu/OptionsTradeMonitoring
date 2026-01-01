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

  private constructOSITicker(symbol: string, strike: number, type: 'CALL' | 'PUT', expiration: string): string {
    // Format: AAPL230616C00150000
    const date = new Date(expiration);
    const YY = date.getUTCFullYear().toString().slice(-2);
    const MM = (date.getUTCMonth() + 1).toString().padStart(2, '0');
    const DD = date.getUTCDate().toString().padStart(2, '0');

    const side = type === 'CALL' ? 'C' : 'P';
    const strikeValue = Math.round(strike * 1000).toString().padStart(8, '0');

    return `${symbol.toUpperCase()}${YY}${MM}${DD}${side}${strikeValue}`;
  }

  private async getOptionPremium(symbol: string, strike: number, type: 'CALL' | 'PUT', expiration: string): Promise<number | null> {
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
            resolve(result.price);
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
    const { rows: positions } = await this.fastify.pg.query(
      "SELECT * FROM positions WHERE symbol = $1 AND status = 'OPEN'",
      [symbol]
    );

    if (positions.length === 0) return null;

    let lastFetchedPrice = null;

    for (const position of positions) {
      const price = await this.getOptionPremium(
        position.symbol,
        Number(position.strike_price),
        position.option_type,
        position.expiration_date
      );

      if (price !== null) {
        console.log(`[MarketPoller] ${position.symbol} ${position.option_type} $${position.strike_price} -> Premium: $${price}`);
        await this.processUpdate(position, price);
        lastFetchedPrice = price;
      }
    }
    return lastFetchedPrice;
  }

  private async poll() {
    console.log(`[MarketPoller] Polling option premiums via MarketData.app at ${new Date().toISOString()}...`);

    // Poll both OPEN and STOP_TRIGGERED positions so user sees up-to-date price before engaging manual close
    const { rows: positions } = await this.fastify.pg.query(
      "SELECT * FROM positions WHERE status IN ('OPEN', 'STOP_TRIGGERED')"
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

  private async processUpdate(position: any, price: number) {
    const engineResult = StopLossEngine.evaluate(price, {
      entry_price: Number(position.entry_price),
      stop_loss_trigger: Number(position.stop_loss_trigger),
      take_profit_trigger: position.take_profit_trigger ? Number(position.take_profit_trigger) : undefined,
      trailing_high_price: Number(position.trailing_high_price || position.entry_price),
      trailing_stop_loss_pct: position.trailing_stop_loss_pct ? Number(position.trailing_stop_loss_pct) : undefined,
    });

    await this.fastify.pg.query(
      'UPDATE positions SET current_price = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [price, position.id]
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
