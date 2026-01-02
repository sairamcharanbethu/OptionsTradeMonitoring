"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.marketRoutes = marketRoutes;
async function marketRoutes(fastify, options) {
    fastify.get('/status', async (request, reply) => {
        try {
            const poller = fastify.poller;
            if (!poller) {
                return reply.code(500).send({ error: 'Market poller not initialized' });
            }
            const isOpen = poller.isMarketOpen();
            return {
                open: isOpen,
                timezone: 'America/New_York',
                marketHours: '9:30 AM - 4:15 PM ET, Mon-Fri'
            };
        }
        catch (err) {
            fastify.log.error(err);
            return reply.code(500).send({ error: 'Failed to fetch market status' });
        }
    });
    fastify.post('/force-poll', async (request, reply) => {
        try {
            const poller = fastify.poller;
            if (!poller) {
                return reply.code(500).send({ error: 'Market poller not initialized' });
            }
            console.log('Received force poll request...');
            // Don't await the poll if you want immediate response, 
            // OR await it to confirm completion. User likely wants confirmation it ran.
            // Given it might take time (multiple tickers), let's await it to ensure new data is there when dashboard refreshes.
            await poller.poll(true);
            return { status: 'ok', message: 'Market data sync triggered successfully' };
        }
        catch (err) {
            fastify.log.error(err);
            return reply.code(500).send({ error: 'Failed to force poll market data' });
        }
    });
}
//# sourceMappingURL=market.js.map