import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { KillSwitchService } from '../services/kill-switch-service';

export async function killSwitchRoutes(fastify: FastifyInstance, _options: FastifyPluginOptions) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET the daily-loss kill-switch status for the shared paper account and the
  // authenticated user's live account. Drives the halt banner in the UI.
  fastify.get('/', {
    schema: {
      tags: ['Kill Switch'],
      summary: 'Daily-loss kill-switch status',
      description: 'Returns whether new entries are halted (paper and live) because the configured daily loss limit has been reached.',
      security: [{ bearerAuth: [] }]
    }
  }, async (request) => {
    const { id: userId } = (request as any).user;
    const [paper, live] = await Promise.all([
      KillSwitchService.evaluate(fastify.pg, 'paper'),
      KillSwitchService.evaluate(fastify.pg, 'live', userId)
    ]);
    return { paper, live };
  });
}
