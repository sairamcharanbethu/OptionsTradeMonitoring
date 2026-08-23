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

  const setDisarmed = async (userId: number, disarmed: boolean) => {
    await fastify.pg.query(
      `INSERT INTO settings (user_id, key, value, updated_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id, key) DO UPDATE
       SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
      [userId, KillSwitchService.DISARM_KEY, disarmed ? 'true' : 'false']
    );
  };

  // One-click disarm: blocks every new live entry (autonomous, AI, or manual)
  // at TradeExecutionService until re-armed. Exits are never blocked.
  fastify.post('/live/disarm', {
    schema: {
      tags: ['Kill Switch'],
      summary: 'Disarm live trading',
      description: 'Immediately blocks all new live entries until re-armed. Open positions and exits are unaffected.',
      security: [{ bearerAuth: [] }]
    }
  }, async (request) => {
    const { id: userId } = (request as any).user;
    await setDisarmed(userId, true);
    fastify.log.warn(`[KillSwitch] Live trading DISARMED by user ${userId}`);
    return { live: await KillSwitchService.evaluate(fastify.pg, 'live', userId) };
  });

  fastify.post('/live/arm', {
    schema: {
      tags: ['Kill Switch'],
      summary: 'Re-arm live trading',
      description: 'Clears the manual disarm. The daily-loss halt still applies independently.',
      security: [{ bearerAuth: [] }]
    }
  }, async (request) => {
    const { id: userId } = (request as any).user;
    await setDisarmed(userId, false);
    fastify.log.warn(`[KillSwitch] Live trading re-armed by user ${userId}`);
    return { live: await KillSwitchService.evaluate(fastify.pg, 'live', userId) };
  });
}
