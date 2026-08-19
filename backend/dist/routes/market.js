"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.marketRoutes = marketRoutes;
const redis_1 = require("../lib/redis");
const ibkr_market_data_service_1 = require("../services/ibkr-market-data-service");
async function marketRoutes(fastify, options) {
    fastify.addHook('onRequest', fastify.authenticate);
    fastify.get('/status', async (request, reply) => {
        try {
            const poller = fastify.poller;
            if (!poller) {
                return reply.code(500).send({ error: 'Market poller not initialized' });
            }
            const isOpen = poller.isMarketOpen();
            const ibkr = fastify.ibkrMarketData || new ibkr_market_data_service_1.IbkrMarketDataService(fastify);
            // Check if IBKR Gateway/API is reachable.
            let connectionStatus = 'DISCONNECTED';
            try {
                const health = await ibkr.getHealth();
                connectionStatus = health.connected ? 'CONNECTED' : 'DISCONNECTED';
            }
            catch (e) {
                connectionStatus = 'DISCONNECTED';
            }
            return {
                open: isOpen,
                timezone: 'America/New_York',
                marketHours: '9:30 AM - 4:15 PM ET, Mon-Fri',
                connectionStatus
            };
        }
        catch (err) {
            fastify.log.error(err);
            return reply.code(500).send({ error: 'Failed to fetch market status' });
        }
    });
    fastify.post('/force-poll', async (request, reply) => {
        try {
            const { id: userId } = request.user;
            const poller = fastify.poller;
            if (!poller) {
                return reply.code(500).send({ error: 'Market poller not initialized' });
            }
            console.log(`Received force poll request from user ${userId}...`);
            await poller.poll(true);
            // Invalidate user cache to ensure fresh data on next GET
            await redis_1.redis.del(`USER_POSITIONS:${userId}`);
            await redis_1.redis.del(`USER_STATS:${userId}`);
            return { status: 'ok', message: 'Market data sync triggered successfully' };
        }
        catch (err) {
            fastify.log.error(err);
            return reply.code(500).send({ error: 'Failed to force poll market data' });
        }
    });
}
//# sourceMappingURL=market.js.map