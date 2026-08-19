"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.marketDataRoutes = marketDataRoutes;
const zod_1 = require("zod");
const PriceUpdateSchema = zod_1.z.object({
    symbol: zod_1.z.string().trim().min(1),
    price: zod_1.z.number().positive(),
});
async function marketDataRoutes(fastify, options) {
    async function authenticateMarketDataUpdate(request, reply) {
        const webhookSecret = process.env.MARKET_DATA_WEBHOOK_SECRET;
        const providedSecret = request.headers['x-webhook-secret'] || request.headers['x-market-data-secret'];
        if (webhookSecret && providedSecret === webhookSecret) {
            return;
        }
        try {
            await request.jwtVerify();
            if (request.user?.role !== 'ADMIN') {
                return reply.code(403).send({ error: 'Admin access required' });
            }
        }
        catch (err) {
            return reply.code(401).send({ error: 'Unauthorized market data update' });
        }
    }
    // POST price update from n8n
    fastify.post('/update-price', { preHandler: authenticateMarketDataUpdate }, async (request, reply) => {
        const { symbol, price } = PriceUpdateSchema.parse(request.body);
        const normalizedSymbol = symbol.toUpperCase();
        // A symbol-only price identifies the underlying, not any particular option
        // contract. Option premiums are updated only from contract-specific IBKR quotes.
        const update = await fastify.pg.query(`UPDATE positions
       SET underlying_price = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE symbol = $2 AND status = 'OPEN'`, [price, normalizedSymbol]);
        return {
            processed: update.rowCount || 0,
            alerts_triggered: 0,
            updates: update.rowCount || 0
        };
    });
}
//# sourceMappingURL=market-data.js.map