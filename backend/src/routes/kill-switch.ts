import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { KillSwitchService } from '../services/kill-switch-service';
import { publishRealtime } from '../lib/realtime';

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
    // UI read: served from the short-TTL Redis cache (invalidated on arm/disarm/halt).
    const [paper, live] = await Promise.all([
      KillSwitchService.evaluate(fastify.pg, 'paper', undefined, { cache: true }),
      KillSwitchService.evaluate(fastify.pg, 'live', userId, { cache: true })
    ]);
    return { paper, live };
  });

  const setDisarmed = async (userId: number, disarmed: boolean) => {
    await KillSwitchService.setLiveDisarmed(fastify.pg, userId, disarmed);
    const live = await KillSwitchService.evaluate(fastify.pg, 'live', userId);
    publishRealtime('KILL_SWITCH', { live }, { userId });
    return live;
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
    const live = await setDisarmed(userId, true);
    fastify.log.warn(`[KillSwitch] Live trading DISARMED by user ${userId}`);
    return { live };
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
    const live = await setDisarmed(userId, false);
    fastify.log.warn(`[KillSwitch] Live trading re-armed by user ${userId}`);
    return { live };
  });
}
