import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { redis } from '../lib/redis';

export async function marketRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {
    fastify.addHook('onRequest', fastify.authenticate);
    fastify.get('/status', async (request, reply) => {
        try {
            const poller = (fastify as any).poller;
            if (!poller) {
                return reply.code(500).send({ error: 'Market poller not initialized' });
            }

            const isOpen = poller.isMarketOpen();

            return {
                open: isOpen,
                timezone: 'America/New_York',
                marketHours: '9:30 AM - 4:15 PM ET, Mon-Fri'
            };
        } catch (err: any) {
            fastify.log.error(err);
            return reply.code(500).send({ error: 'Failed to fetch market status' });
        }
    });

    fastify.post('/force-poll', async (request, reply) => {
        try {
            const { id: userId } = (request as any).user;
            const poller = (fastify as any).poller;

            if (!poller) {
                return reply.code(500).send({ error: 'Market poller not initialized' });
            }

            console.log(`Received force poll request from user ${userId}...`);
            await poller.poll(true);

            // Invalidate user cache to ensure fresh data on next GET
            await redis.del(`USER_POSITIONS:${userId}`);
            await redis.del(`USER_STATS:${userId}`);

            return { status: 'ok', message: 'Market data sync triggered successfully' };
        } catch (err: any) {
            fastify.log.error(err);
            return reply.code(500).send({ error: 'Failed to force poll market data' });
        }
    });
}
