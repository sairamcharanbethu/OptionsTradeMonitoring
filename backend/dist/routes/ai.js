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
            }, userId);
            return analysis;
        }
        catch (err) {
            fastify.log.error(err);
            const msg = err.message || '';
            const isRateLimit = msg.includes('Too Many') || msg.includes('429') || msg.includes('Rate');
            if (isRateLimit) {
                if (msg.includes('OpenRouter')) {
                    return reply.code(429).send({
                        error: 'Rate Limited (OpenRouter)',
                        message: 'OpenRouter AI service rate limit reached. Please check your limits or wait a few minutes.',
                        retryAfter: 60
                    });
                }
                return reply.code(429).send({
                    error: 'Rate Limited',
                    message: 'AI service rate limit reached. Please wait a few minutes.',
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
            return {
                briefing: `⚠️ **AI Briefing Generation Failed**\n\nThe AI model was unable to analyze your options portfolio. This is typically caused by:\n- Missing or invalid OpenRouter API key in your settings\n- Insufficient OpenRouter credits/balance\n- Temporary API timeout or model rate limits\n\n*Technical Details: ${err.message}*`,
                discord_message: `AI Briefing failed: ${err.message}`
            };
        }
    });
}
//# sourceMappingURL=ai.js.map