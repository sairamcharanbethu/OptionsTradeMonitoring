import { FastifyInstance, FastifyPluginOptions } from 'fastify';

export async function marketRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {
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
}
