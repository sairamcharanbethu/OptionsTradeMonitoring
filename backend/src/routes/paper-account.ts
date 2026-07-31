import { FastifyInstance } from 'fastify';

export async function paperAccountRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', (fastify as any).authenticate);

  fastify.get('/', async (request) => {
    const summary = await (fastify as any).paperTrading.getAccountSummary();
    return { ...summary, canManage: String((request as any).user?.role || '').toUpperCase() === 'ADMIN' };
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
}
