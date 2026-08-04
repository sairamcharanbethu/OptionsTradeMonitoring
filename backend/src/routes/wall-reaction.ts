import { FastifyInstance } from 'fastify';

export async function wallReactionRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', (fastify as any).authenticate);

  fastify.get('/', async () => (fastify as any).wallReaction.getState());

  fastify.get('/history', async (request) => {
    const query = request.query as { limit?: string; offset?: string };
    return { items: await (fastify as any).wallReaction.getHistory(Number(query.limit || 50), Number(query.offset || 0)) };
  });
}
