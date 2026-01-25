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

            // 2. Fetch 1-min candles for the last hour
            const now = new Date();
            const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

            const candles = await questrade.getHistoricalData(symbolId, oneHourAgo, now, 'OneMinute');

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
}
