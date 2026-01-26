"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.aiRoutes = aiRoutes;
const ai_service_1 = require("../services/ai-service");
const prediction_service_1 = require("../services/prediction-service");
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
            if (err.message?.includes('Too Many') || err.message?.includes('429') || err.message?.includes('Rate')) {
                return reply.code(429).send({
                    error: 'Rate Limited',
                    message: 'Questrade API rate limit reached. Please wait a few minutes.',
                    retryAfter: 60
                });
            }
            return reply.code(500).send({ error: err.message || 'AI Analysis Failed' });
        }
    });
    // Holistic Portfolio Briefing
    fastify.get('/briefing', async (request, reply) => {
        const { id: userId } = request.user;
        try {
            // Fetch all active/relevant positions for this user
            const { rows: positions } = await fastify.pg.query(`SELECT * FROM positions 
                 WHERE user_id = $1 AND status IN ('OPEN', 'STOP_TRIGGERED', 'PROFIT_TRIGGERED')
                 ORDER BY expiration_date ASC`, [userId]);
            if (positions.length === 0) {
                return { briefing: "You have no active positions to analyze.", discord_message: "No active positions." };
            }
            const briefing = await aiService.generateBriefing(positions);
            return briefing;
        }
        catch (err) {
            fastify.log.error(err);
            return reply.code(500).send({ error: err.message || 'AI Briefing Failed' });
        }
    });
    fastify.get('/predict/:symbol', async (request, reply) => {
        const { symbol } = request.params;
        const predictionService = new prediction_service_1.PredictionService(fastify);
        try {
            const result = await predictionService.analyzeStock(symbol);
            return result;
        }
        catch (err) {
            // Check for rate limit errors and return user-friendly response
            if (err.message?.includes('Too Many') || err.message?.includes('429') || err.message?.includes('Rate')) {
                return reply.code(429).send({
                    error: 'Rate Limited',
                    message: 'Questrade API rate limit reached. Please wait 2-3 minutes before trying again. The system processes many market data requests for historical analysis.',
                    retryAfter: 180 // 3 minutes in seconds
                });
            }
            // For other errors, return 500 with message
            fastify.log.error(err);
            return reply.code(500).send({
                error: 'Prediction Failed',
                message: err.message || 'An unexpected error occurred during stock analysis.'
            });
        }
    });
}
//# sourceMappingURL=ai.js.map