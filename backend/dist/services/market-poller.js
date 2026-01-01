"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MarketPoller = void 0;
const node_cron_1 = __importDefault(require("node-cron"));
const child_process_1 = require("child_process");
const stop_loss_engine_1 = require("./stop-loss-engine");
class MarketPoller {
    fastify;
    constructor(fastify) {
        this.fastify = fastify;
    }
    start() {
        const interval = process.env.MARKET_DATA_POLL_INTERVAL || '*/15 * * * *';
        console.log(`[MarketPoller] Starting polling job with interval: ${interval}`);
        node_cron_1.default.schedule(interval, async () => {
            try {
                await this.poll();
            }
            catch (err) {
                console.error('[MarketPoller] Error during poll execution:', err);
            }
        });
        this.poll().catch(err => console.error('[MarketPoller] Initial poll failed:', err));
    }
    constructOSITicker(symbol, strike, type, expiration) {
        // Format: AAPL230616C00150000
        const date = new Date(expiration);
        const YY = date.getUTCFullYear().toString().slice(-2);
        const MM = (date.getUTCMonth() + 1).toString().padStart(2, '0');
        const DD = date.getUTCDate().toString().padStart(2, '0');
        const side = type === 'CALL' ? 'C' : 'P';
        const strikeValue = Math.round(strike * 1000).toString().padStart(8, '0');
        return `${symbol.toUpperCase()}${YY}${MM}${DD}${side}${strikeValue}`;
    }
    async getOptionPremium(symbol, strike, type, expiration) {
        const ticker = this.constructOSITicker(symbol, strike, type, expiration);
        // console.log(`[MarketPoller] Fetching premium for: ${ticker}`);
        return new Promise((resolve) => {
            const pythonProcess = (0, child_process_1.spawn)('python3', ['/app/src/scripts/fetch_option_price.py', ticker]);
            let dataString = '';
            pythonProcess.stdout.on('data', (data) => {
                dataString += data.toString();
            });
            pythonProcess.stderr.on('data', (data) => {
                console.error(`[MarketPoller] Python stderr: ${data}`);
            });
            pythonProcess.on('close', (code) => {
                try {
                    // Log raw output for debugging if needed
                    // console.log(`[MarketPoller] Raw Python output: ${dataString}`);
                    const result = JSON.parse(dataString);
                    if (result.status === 'ok' && typeof result.price === 'number') {
                        resolve(result.price);
                    }
                    else {
                        console.warn(`[MarketPoller] Retrieval failed for ${ticker}: ${result.message}`);
                        resolve(null);
                    }
                }
                catch (e) {
                    console.error(`[MarketPoller] Failed to parse output for ${ticker}:`, e);
                    resolve(null);
                }
            });
            pythonProcess.on('error', (err) => {
                console.error(`[MarketPoller] Python process error:`, err);
                resolve(null);
            });
        });
    }
    async syncPrice(symbol) {
        const { rows: positions } = await this.fastify.pg.query("SELECT * FROM positions WHERE symbol = $1 AND status = 'OPEN'", [symbol]);
        if (positions.length === 0)
            return null;
        let lastFetchedPrice = null;
        for (const position of positions) {
            const price = await this.getOptionPremium(position.symbol, Number(position.strike_price), position.option_type, position.expiration_date);
            if (price !== null) {
                console.log(`[MarketPoller] ${position.symbol} ${position.option_type} $${position.strike_price} -> Premium: $${price}`);
                await this.processUpdate(position, price);
                lastFetchedPrice = price;
            }
        }
        return lastFetchedPrice;
    }
    async poll() {
        console.log(`[MarketPoller] Polling option premiums via MarketData.app at ${new Date().toISOString()}...`);
        const { rows: positions } = await this.fastify.pg.query("SELECT * FROM positions WHERE status = 'OPEN'");
        if (positions.length === 0) {
            console.log('[MarketPoller] No open positions to poll.');
            return;
        }
        const symbols = [...new Set(positions.map(p => p.symbol))];
        for (const symbol of symbols) {
            await this.syncPrice(symbol);
            // Stay within limits, sequential delay
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
    async processUpdate(position, price) {
        const engineResult = stop_loss_engine_1.StopLossEngine.evaluate(price, {
            entry_price: Number(position.entry_price),
            stop_loss_trigger: Number(position.stop_loss_trigger),
            trailing_high_price: Number(position.trailing_high_price || position.entry_price),
            trailing_stop_loss_pct: position.trailing_stop_loss_pct ? Number(position.trailing_stop_loss_pct) : undefined,
        });
        await this.fastify.pg.query('UPDATE positions SET current_price = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [price, position.id]);
        await this.fastify.pg.query('INSERT INTO price_history (position_id, price) VALUES ($1, $2)', [position.id, price]);
        if (engineResult.triggered) {
            const pnl = (price - Number(position.entry_price)) * position.quantity * 100;
            await this.fastify.pg.query(`UPDATE positions 
         SET status = 'CLOSED', 
             realized_pnl = $1, 
             loss_avoided = $2,
             updated_at = CURRENT_TIMESTAMP 
         WHERE id = $3`, [pnl, engineResult.lossAvoided, position.id]);
            await this.fastify.pg.query('INSERT INTO alerts (position_id, trigger_type, trigger_price, actual_price) VALUES ($1, $2, $3, $4)', [position.id, 'STOP_LOSS', position.stop_loss_trigger, price]);
            this.notifyN8n(position, price, pnl, engineResult.lossAvoided);
        }
        else if (engineResult.newHigh || engineResult.newStopLoss) {
            await this.fastify.pg.query(`UPDATE positions 
         SET trailing_high_price = COALESCE($1, trailing_high_price),
             stop_loss_trigger = COALESCE($2, stop_loss_trigger),
             updated_at = CURRENT_TIMESTAMP 
         WHERE id = $3`, [engineResult.newHigh, engineResult.newStopLoss, position.id]);
        }
    }
    async notifyN8n(position, price, pnl, lossAvoided) {
        const N8N_WEBHOOK_URL = process.env.N8N_ALERT_WEBHOOK_URL;
        if (!N8N_WEBHOOK_URL)
            return;
        try {
            await fetch(N8N_WEBHOOK_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    event: 'STOP_LOSS_TRIGGERED',
                    symbol: position.symbol,
                    price: price,
                    pnl: pnl,
                    loss_avoided: lossAvoided,
                    position_id: position.id
                })
            });
        }
        catch (err) {
            console.error('[MarketPoller] Failed to notify n8n:', err.message);
        }
    }
}
exports.MarketPoller = MarketPoller;
//# sourceMappingURL=market-poller.js.map