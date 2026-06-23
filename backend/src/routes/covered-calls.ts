import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import { CoveredCallService } from '../services/covered-call-service';

const SearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(40)
});

const AnalyzeSchema = z.object({
  symbol: z.string().trim().min(1).max(12),
  profile: z.literal('conservative').optional()
});

export async function coveredCallRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {
  fastify.addHook('onRequest', fastify.authenticate);
  const service = new CoveredCallService(fastify);

  fastify.get('/search', async (request, reply) => {
    const parsed = SearchQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'Search query is required' });

    try {
      return await service.searchSymbols(parsed.data.q);
    } catch (err: any) {
      fastify.log.error(err);
      return reply.code(500).send({ error: err.message || 'Failed to search symbols' });
    }
  });

  fastify.post('/analyze', async (request, reply) => {
    const { id: userId } = (request as any).user;
    const parsed = AnalyzeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Valid symbol is required' });

    try {
      return await service.analyze(parsed.data.symbol, userId);
    } catch (err: any) {
      fastify.log.error(err);
      return reply.code(500).send({ error: err.message || 'Failed to analyze covered calls' });
    }
  });
}
