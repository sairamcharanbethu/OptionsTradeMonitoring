"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.aiRoutes = aiRoutes;
const ai_service_1 = require("../services/ai-service");
async function aiRoutes(fastify, options) {
    fastify.addHook('onRequest', fastify.authenticate);
    const aiService = new ai_service_1.AIService(fastify);
    fastify.post('/analyze', async (request, reply) => {
        const { id: userId } = request.user;
        const { positionId } = request.body;
        if (!positionId) {
            return reply.code(400).send({ error: 'Position ID is required' });
        }
        try {
            // Fetch clean position data and verify ownership
            const res = await fastify.pg.query(`SELECT * FROM positions WHERE id = $1 AND user_id = $2`, [positionId, userId]);
            if (res.rows.length === 0) {
                return reply.code(404).send({ error: 'Position not found' });
            }
            const pos = res.rows[0];
            const analysis = await aiService.generateAnalysis({
                symbol: pos.symbol,
                price: Number(pos.current_price),
                entry: Number(pos.entry_price),
                type: pos.option_type,
                strike: Number(pos.strike_price),
                expiration: pos.expiration_date,
                greeks: {
                    delta: pos.delta ? Number(pos.delta) : null,
                    theta: pos.theta ? Number(pos.theta) : null,
                    gamma: pos.gamma ? Number(pos.gamma) : null,
                    vega: pos.vega ? Number(pos.vega) : null,
                    iv: pos.iv ? Number(pos.iv) : null
                },
                underlying_price: pos.underlying_price ? Number(pos.underlying_price) : null
            });
            return analysis;
        }
        catch (err) {
            fastify.log.error(err);
            return reply.code(500).send({ error: err.message || 'AI Analysis Failed' });
        }
    });
}
//# sourceMappingURL=ai.js.map