"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.marketDataRoutes = marketDataRoutes;
const zod_1 = require("zod");
const stop_loss_engine_1 = require("../services/stop-loss-engine");
const ai_service_1 = require("../services/ai-service");
const PriceUpdateSchema = zod_1.z.object({
    symbol: zod_1.z.string(),
    price: zod_1.z.number(),
});
async function marketDataRoutes(fastify, options) {
    const aiService = new ai_service_1.AIService(fastify);
    // POST price update from n8n
    fastify.post('/update-price', async (request, reply) => {
        const { symbol, price } = PriceUpdateSchema.parse(request.body);
        // 1. Find all OPEN positions for this symbol
        const { rows: positions } = await fastify.pg.query('SELECT * FROM positions WHERE symbol = $1 AND status = \'OPEN\'', [symbol]);
        const results = {
            processed: positions.length,
            alerts_triggered: 0,
            updates: 0
        };
        for (const position of positions) {
            // 2. Update current_price and record price history
            await fastify.pg.query('UPDATE positions SET current_price = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [price, position.id]);
            await fastify.pg.query('INSERT INTO price_history (position_id, price) VALUES ($1, $2)', [position.id, price]);
            // 3. Evaluate Trailing Stop-Loss
            const engineResult = stop_loss_engine_1.StopLossEngine.evaluate(price, {
                entry_price: Number(position.entry_price),
                stop_loss_trigger: Number(position.stop_loss_trigger),
                trailing_high_price: Number(position.trailing_high_price || position.entry_price),
                trailing_stop_loss_pct: position.trailing_stop_loss_pct ? Number(position.trailing_stop_loss_pct) : undefined,
            });
            // 4. Handle Results (Updates or Triggers)
            if (engineResult.triggered) {
                results.alerts_triggered++;
                // Calculate realized PnL and Loss Avoided
                // Assuming 100 contracts per position for options
                const pnl = (price - Number(position.entry_price)) * position.quantity * 100;
                // Close the position
                await fastify.pg.query(`UPDATE positions 
           SET status = 'CLOSED', 
               realized_pnl = $1, 
               loss_avoided = $2,
               updated_at = CURRENT_TIMESTAMP 
           WHERE id = $3`, [pnl, engineResult.lossAvoided, position.id]);
                // Record the Alert
                await fastify.pg.query('INSERT INTO alerts (position_id, trigger_type, trigger_price, actual_price) VALUES ($1, $2, $3, $4)', [position.id, 'STOP_LOSS', position.stop_loss_trigger, price]);
                // Generate AI Summary for the alert (Discord Message)
                let aiData = { summary: '', discord_message: '' };
                try {
                    aiData = await aiService.generateAlertSummary({
                        symbol: position.symbol,
                        type: position.option_type,
                        strike: position.strike_price,
                        expiration: position.expiration_date,
                        event: 'STOP_LOSS_TRIGGERED',
                        price: price,
                        pnl: ((price - Number(position.entry_price)) / Number(position.entry_price) * 100).toFixed(2),
                        greeks: {
                            delta: position.delta,
                            theta: position.theta,
                            iv: position.iv
                        }
                    });
                }
                catch (err) {
                    fastify.log.error(err, 'AI Summary generation failed');
                }
                // 6. Alert Fan-out (Call n8n)
                const N8N_WEBHOOK_URL = process.env.N8N_ALERT_WEBHOOK_URL;
                if (N8N_WEBHOOK_URL) {
                    try {
                        await fetch(N8N_WEBHOOK_URL, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                event: 'STOP_LOSS_TRIGGERED',
                                symbol: position.symbol,
                                ticker: position.symbol,
                                option_type: position.option_type,
                                strike_price: position.strike_price,
                                expiration_date: position.expiration_date,
                                price: price,
                                pnl: pnl,
                                loss_avoided: engineResult.lossAvoided,
                                position_id: position.id,
                                ai_summary: aiData.summary,
                                discord_message: aiData.discord_message,
                                timestamp: new Date().toISOString()
                            })
                        });
                    }
                    catch (err) {
                        fastify.log.error({ err }, 'Failed to notify n8n');
                    }
                }
            }
            else if (engineResult.newHigh || engineResult.newStopLoss) {
                results.updates++;
                // Update the peak/stop-loss triggers
                await fastify.pg.query(`UPDATE positions 
           SET trailing_high_price = COALESCE($1, trailing_high_price),
               stop_loss_trigger = COALESCE($2, stop_loss_trigger),
               updated_at = CURRENT_TIMESTAMP 
           WHERE id = $3`, [engineResult.newHigh, engineResult.newStopLoss, position.id]);
            }
        }
        return results;
    });
}
//# sourceMappingURL=market-data.js.map