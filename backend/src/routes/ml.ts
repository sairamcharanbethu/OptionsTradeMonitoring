
import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { MLService } from '../services/ml-service';
import { z } from 'zod';

export async function mlRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {
    fastify.addHook('onRequest', fastify.authenticate);
    const mlService = new MLService(fastify);
    const Query = z.object({ ticker: z.string().min(1) });
    fastify.get('/forecast', async (req, reply) => {
        const { ticker } = Query.parse(req.query);
        return await mlService.getForecast(ticker);
    });
}
