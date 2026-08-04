import { FastifyInstance } from 'fastify';

export async function wallReactionRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', (fastify as any).authenticate);

  fastify.get('/', async () => (fastify as any).wallReaction.getState());

  fastify.get('/history', async (request) => {
    const query = request.query as { limit?: string; offset?: string };
    return { items: await (fastify as any).wallReaction.getHistory(Number(query.limit || 50), Number(query.offset || 0)) };
  });

  fastify.get('/paper-account', async () => (fastify as any).wallReactionPaper.getSummary());

  fastify.get('/paper-account/journal', async (request) => {
    const query = request.query as { limit?: string; offset?: string };
    return { items: await (fastify as any).wallReactionPaper.getJournal(Number(query.limit || 100), Number(query.offset || 0)) };
  });

  fastify.post('/candidates/:candidateId/arm', async (request, reply) => {
    if (String((request as any).user?.role || '').toUpperCase() !== 'ADMIN') return reply.code(403).send({ error: 'Admin access required' });
    try {
      return await (fastify as any).wallReactionPaper.arm((request.params as any).candidateId, Number((request as any).user?.id) || null);
    } catch (error: any) {
      return reply.code(error.statusCode || 500).send({ error: error.message });
    }
  });

  fastify.post('/paper-account/pause', async (request, reply) => {
    if (String((request as any).user?.role || '').toUpperCase() !== 'ADMIN') return reply.code(403).send({ error: 'Admin access required' });
    return (fastify as any).wallReactionPaper.setAutomationStatus('PAUSED');
  });

  fastify.post('/paper-account/resume', async (request, reply) => {
    if (String((request as any).user?.role || '').toUpperCase() !== 'ADMIN') return reply.code(403).send({ error: 'Admin access required' });
    return (fastify as any).wallReactionPaper.setAutomationStatus('ACTIVE');
  });

  fastify.post('/paper-account/positions/:positionId/close', async (request, reply) => {
    if (String((request as any).user?.role || '').toUpperCase() !== 'ADMIN') return reply.code(403).send({ error: 'Admin access required' });
    const positionId = Number((request.params as any).positionId);
    if (!Number.isSafeInteger(positionId) || positionId <= 0) return reply.code(400).send({ error: 'A valid position id is required' });
    try { return await (fastify as any).wallReactionPaper.closePosition(positionId); }
    catch (error: any) { return reply.code(error.statusCode || 500).send({ error: error.message }); }
  });
}
