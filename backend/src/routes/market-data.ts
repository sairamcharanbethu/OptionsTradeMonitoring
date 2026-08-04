import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';

const PriceUpdateSchema = z.object({
  symbol: z.string().trim().min(1),
  price: z.number().positive(),
});

export async function marketDataRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {
  async function authenticateMarketDataUpdate(request: any, reply: any) {
    const webhookSecret = process.env.MARKET_DATA_WEBHOOK_SECRET;
    const providedSecret = request.headers['x-webhook-secret'] || request.headers['x-market-data-secret'];

    if (webhookSecret && providedSecret === webhookSecret) {
      return;
    }

    try {
      await request.jwtVerify();
      if (request.user?.role !== 'ADMIN') {
        return reply.code(403).send({ error: 'Admin access required' });
      }
    } catch (err) {
      return reply.code(401).send({ error: 'Unauthorized market data update' });
    }
  }

  // POST price update from n8n
  fastify.post('/update-price', { preHandler: authenticateMarketDataUpdate }, async (request, reply) => {
    const { symbol, price } = PriceUpdateSchema.parse(request.body);
    const normalizedSymbol = symbol.toUpperCase();

    // A symbol-only price identifies the underlying, not any particular option
    // contract. Option premiums are updated only from contract-specific IBKR quotes.
    const update = await fastify.pg.query(
      `UPDATE positions
       SET underlying_price = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE symbol = $2 AND status = 'OPEN'`,
      [price, normalizedSymbol]
    );

    return {
      processed: update.rowCount || 0,
      alerts_triggered: 0,
      updates: update.rowCount || 0
    };
  });
}
