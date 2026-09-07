import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { TradeRedisService } from '../services/trade-redis-service';

/**
 * Operator decision log. Served from the Redis stream `trade-events:stream`
 * (newest first, resumable via `after` = the stream id of the newest event a
 * client already holds); falls back to Postgres trade_events when Redis is
 * unavailable. Users see their own events; admins may pass user=all or a user id.
 */
export async function tradeEventsRoutes(fastify: FastifyInstance, _options: FastifyPluginOptions) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get('/', {
    schema: {
      tags: ['Trade Events'],
      summary: 'Recent trade events (decision log)',
      description: 'Newest-first trade events from the Redis stream with Postgres fallback. `after` returns only events newer than that stream id.',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 200 },
          after: { type: 'string', description: 'Exclusive stream id cursor (e.g. 1725640000000-0)' },
          types: { type: 'string', description: 'Comma-separated event types to include' },
          user: { type: 'string', description: "'me' (default), 'all' (admin) or a user id (admin)" }
        }
      }
    }
  }, async (request, reply) => {
    const { id: userId, role } = (request as any).user;
    const query = (request.query || {}) as { limit?: number; after?: string; types?: string; user?: string };
    const isAdmin = String(role || '').toUpperCase() === 'ADMIN';
    let targetUserId: number | null = Number(userId);
    const requestedUser = String(query.user || 'me').trim().toLowerCase();
    if (requestedUser !== 'me') {
      if (!isAdmin) return (reply as any).code(403).send({ error: 'Only admins can read other users\' trade events' });
      if (requestedUser === 'all') targetUserId = null;
      else {
        const parsed = Number(requestedUser);
        if (!Number.isInteger(parsed) || parsed <= 0) return (reply as any).code(400).send({ error: 'user must be me, all, or a user id' });
        targetUserId = parsed;
      }
    }
    const types = query.types ? String(query.types).split(',').map((t) => t.trim()).filter(Boolean) : null;
    const page = await TradeRedisService.readEvents(fastify.pg, {
      userId: targetUserId,
      limit: query.limit,
      after: query.after || null,
      types
    });
    return { ...page, limit: query.limit || 200, user: targetUserId ?? 'all' };
  });
}
