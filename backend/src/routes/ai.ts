
import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { AIService } from '../services/ai-service';

export async function aiRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {
    const aiService = new AIService(fastify);

    fastify.post('/analyze', async (request, reply) => {
        const { positionId } = request.body as { positionId: number };

        if (!positionId) {
            return reply.code(400).send({ error: 'Position ID is required' });
        }

        try {
            // Fetch clean position data
            const res = await fastify.pg.query(
                `SELECT * FROM positions WHERE id = $1`,
                [positionId]
            );

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
                }
            });

            return analysis;

        } catch (err: any) {
            fastify.log.error(err);
            return reply.code(500).send({ error: err.message || 'AI Analysis Failed' });
        }
    });
}
