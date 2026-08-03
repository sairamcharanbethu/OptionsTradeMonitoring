import { FastifyInstance } from 'fastify';

export async function paperAccountRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', (fastify as any).authenticate);

  fastify.get('/', async (request) => {
    const summary = await (fastify as any).paperTrading.getAccountSummary();
    return { ...summary, canManage: String((request as any).user?.role || '').toUpperCase() === 'ADMIN' };
  });

  fastify.get('/journal', async (request) => {
    const query = request.query as { limit?: string; offset?: string };
    return {
      items: await (fastify as any).paperTrading.getJournal(Number(query.limit || 100), Number(query.offset || 0))
    };
  });

  fastify.get('/reports/:month', async (request, reply) => {
    const { month } = request.params as { month: string };
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return reply.code(400).send({ error: 'Month must use YYYY-MM' });
    }
    return (fastify as any).paperTrading.generateMonthlyReport(month);
  });

  fastify.post('/pause', async (request, reply) => {
    if (String((request as any).user?.role || '').toUpperCase() !== 'ADMIN') {
      return reply.code(403).send({ error: 'Admin access required' });
    }
    return (fastify as any).paperTrading.setAutomationStatus('PAUSED');
  });

  fastify.post('/resume', async (request, reply) => {
    if (String((request as any).user?.role || '').toUpperCase() !== 'ADMIN') {
      return reply.code(403).send({ error: 'Admin access required' });
    }
    return (fastify as any).paperTrading.setAutomationStatus('ACTIVE');
  });

  fastify.post('/positions/:positionId/close', async (request, reply) => {
    if (String((request as any).user?.role || '').toUpperCase() !== 'ADMIN') {
      return reply.code(403).send({ error: 'Admin access required' });
    }
    const positionId = Number((request.params as { positionId?: string }).positionId);
    if (!Number.isSafeInteger(positionId) || positionId <= 0) {
      return reply.code(400).send({ error: 'A valid paper position id is required' });
    }
    const requestedByUserId = Number((request as any).user?.id);
    return (fastify as any).paperTrading.closeOpenPosition(
      positionId,
      Number.isSafeInteger(requestedByUserId) && requestedByUserId > 0 ? requestedByUserId : null
    );
  });
}
