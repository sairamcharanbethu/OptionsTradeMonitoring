import { FastifyInstance, FastifyPluginOptions } from 'fastify';

export async function liveAnalysisRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {
    fastify.addHook('onRequest', fastify.authenticate);

    // GET /api/live-analysis/candles/:symbol - Fetch recent 1-min candles
    fastify.get('/candles/:symbol', async (request, reply) => {
        try {
            const { symbol } = request.params as { symbol: string };
            const questrade = (fastify as any).questrade;

            if (!questrade) {
                return reply.code(500).send({ error: 'Questrade service not initialized' });
            }

            // 1. Resolve symbol to ID
            const symbolId = await questrade.getSymbolId(symbol.toUpperCase());
            if (!symbolId) {
                return reply.code(404).send({ error: `Symbol ${symbol} not found` });
            }

            // 2. Fetch 1-min candles for today's trading session
            // Market hours: 9:30 AM - 4:00 PM ET
            const now = new Date();
            const etOffset = -5; // EST is UTC-5 (adjust for daylight if needed)
            const nowET = new Date(now.getTime() + (now.getTimezoneOffset() + etOffset * 60) * 60000);

            // Set start to 9:30 AM ET today (or yesterday if before market open)
            const marketOpen = new Date(nowET);
            marketOpen.setHours(9, 30, 0, 0);

            // If we're before market open, use previous trading day
            if (nowET < marketOpen) {
                marketOpen.setDate(marketOpen.getDate() - 1);
            }

            // Convert back to UTC for API call
            const startTime = new Date(marketOpen.getTime() - (now.getTimezoneOffset() + etOffset * 60) * 60000);

            const candles = await questrade.getHistoricalData(symbolId, startTime, now, 'OneMinute');

            // 3. Return candles with calculated fields
            return {
                symbol: symbol.toUpperCase(),
                symbolId,
                interval: 'OneMinute',
                candles: candles.map((c: any) => ({
                    time: c.start,
                    open: c.open,
                    high: c.high,
                    low: c.low,
                    close: c.close,
                    volume: c.volume
                }))
            };
        } catch (err: any) {
            fastify.log.error(err);
            return reply.code(500).send({ error: err.message || 'Failed to fetch candles' });
        }
    });

    // GET /api/live-analysis/search/:query - Symbol search
    fastify.get('/search/:query', async (request, reply) => {
        try {
            const { query } = request.params as { query: string };
            const questrade = (fastify as any).questrade;

            if (!questrade) {
                return reply.code(500).send({ error: 'Questrade service not initialized' });
            }

            // Use Questrade symbol search
            const symbols = await questrade.getSymbols([query.toUpperCase()]);

            return {
                results: symbols.map((s: any) => ({
                    symbol: s.symbol,
                    description: s.description,
                    securityType: s.securityType,
                    listingExchange: s.listingExchange
                }))
            };
        } catch (err: any) {
            fastify.log.error(err);
            return reply.code(500).send({ error: err.message || 'Search failed' });
        }
    });

    // POST /api/live-analysis/subscribe/:symbol - Subscribe to real-time quotes
    fastify.post('/subscribe/:symbol', async (request, reply) => {
        try {
            const { symbol } = request.params as { symbol: string };
            const questrade = (fastify as any).questrade;
            const streamer = (fastify as any).streamer;
            const { redis } = await import('../lib/redis');

            if (!questrade) {
                return reply.code(500).send({ error: 'Questrade service not initialized' });
            }

            if (!streamer) {
                return reply.code(500).send({ error: 'Streaming service not initialized' });
            }

            // 1. Resolve symbol to ID
            const symbolId = await questrade.getSymbolId(symbol.toUpperCase());
            if (!symbolId) {
                return reply.code(404).send({ error: `Symbol ${symbol} not found` });
            }

            // 2. Cache symbol name for quote enrichment
            await redis.set(`SYMBOL_NAME:${symbolId}`, symbol.toUpperCase(), 86400);

            // 3. Subscribe to real-time quotes
            streamer.subscribe([symbolId]);
            console.log(`[LiveAnalysis] Subscribed to real-time quotes for ${symbol} (ID: ${symbolId})`);

            return {
                success: true,
                symbol: symbol.toUpperCase(),
                symbolId,
                message: 'Subscribed to real-time quotes. Updates will be pushed via WebSocket.'
            };
        } catch (err: any) {
            fastify.log.error(err);
            return reply.code(500).send({ error: err.message || 'Subscription failed' });
        }
    });
}
