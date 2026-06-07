import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';

const UpdateStatusSchema = z.object({
  status: z.enum(['PENDING', 'EXECUTED', 'CANCELLED'])
});

export async function signalRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /api/signals - Fetch latest 100 signals
  fastify.get('/', {
    schema: {
      tags: ['Signals'],
      summary: 'Get day trading signals',
      description: 'Retrieve latest trade signals from the database.',
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'integer' },
              symbol: { type: 'string' },
              signal_type: { type: 'string' },
              trade_bias: { type: 'string' },
              current_price: { type: 'number' },
              entry_trigger: { type: 'number', nullable: true },
              stop_loss: { type: 'number', nullable: true },
              target_price: { type: 'number', nullable: true },
              confidence_score: { type: 'integer' },
              setup_grade: { type: 'string', nullable: true },
              status: { type: 'string' },
              indicators: { type: 'object', nullable: true, additionalProperties: true },
              gex: { type: 'object', nullable: true, additionalProperties: true },
              volatility: { type: 'object', nullable: true, additionalProperties: true },
              no_trade_reasons: { type: 'array', items: { type: 'string' }, nullable: true },
              option_expiration_date: { type: 'string', format: 'date', nullable: true },
              market_date: { type: 'string', nullable: true },
              created_at: { type: 'string', format: 'date-time' }
            }
          }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const query = `
        SELECT 
          id, 
          symbol, 
          signal_type, 
          trade_bias, 
          current_price::double precision, 
          entry_trigger::double precision, 
          stop_loss::double precision, 
          target_price::double precision, 
          confidence_score, 
          setup_grade, 
          status, 
          indicators, 
          gex, 
          volatility, 
          no_trade_reasons, 
          option_expiration_date, 
          market_date, 
          created_at 
        FROM signals 
        ORDER BY created_at DESC 
        LIMIT 100
      `;
      const { rows } = await fastify.pg.query(query);
      return rows;
    } catch (err: any) {
      fastify.log.error(err);
      return (reply as any).code(500).send({ error: 'Failed to fetch trade signals' });
    }
  });

  // PUT /api/signals/:id/status - Update signal status
  fastify.put('/:id/status', {
    schema: {
      tags: ['Signals'],
      summary: 'Update signal status',
      description: 'Set signal status to EXECUTED, CANCELLED, or PENDING.',
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'integer' }
        }
      },
      body: {
        type: 'object',
        required: ['status'],
        properties: {
          status: { type: 'string', enum: ['PENDING', 'EXECUTED', 'CANCELLED'] }
        }
      },
      response: {
        200: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            status: { type: 'string' }
          }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { id } = request.params as { id: number };
      const { status } = UpdateStatusSchema.parse(request.body);

      const query = 'UPDATE signals SET status = $1 WHERE id = $2 RETURNING id, status';
      const { rows } = await fastify.pg.query(query, [status, id]);

      if (rows.length === 0) {
        return (reply as any).code(404).send({ error: 'Signal not found' });
      }

      return rows[0];
    } catch (err: any) {
      fastify.log.error(err);
      return (reply as any).code(500).send({ error: err.message || 'Failed to update signal status' });
    }
  });

  // DELETE /api/signals - Clear all signals
  fastify.delete('/', {
    schema: {
      tags: ['Signals'],
      summary: 'Clear all signals',
      description: 'Wipe all records from the signals table.',
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' }
          }
        }
      }
    }
  }, async (request, reply) => {
    try {
      await fastify.pg.query('DELETE FROM signals');
      return { success: true, message: 'All day trading signals cleared successfully.' };
    } catch (err: any) {
      fastify.log.error(err);
      return (reply as any).code(500).send({ error: 'Failed to clear signals' });
    }
  });

  // POST /api/signals/seed - Seed database with mock signals
  fastify.post('/seed', {
    schema: {
      tags: ['Signals'],
      summary: 'Seed sample trade signals',
      description: 'Inserts dummy setups into the signals table for testing.',
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            insertedCount: { type: 'integer' }
          }
        }
      }
    }
  }, async (request, reply) => {
    const client = await fastify.pg.connect();
    try {
      await client.query('BEGIN');

      const today = new Date().toISOString().split('T')[0];
      const marketDateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' });

      // Signal 1: QQQ Breakout CALL
      const sig1 = [
        'QQQ', 'CALL', 'BUY_CALL_ON_BREAKOUT', 482.50, 483.00, 481.20, 486.00, 88, 'A+ / FULL', 'PENDING',
        JSON.stringify({ vwap: 481.80, ema9: 482.10, ema21: 481.50, atr14: 1.25, openingRangeHigh: 482.80, openingRangeLow: 480.90 }),
        JSON.stringify({ netGex: 450000, regime: 'BULLISH', flipStrike: 480.00, callWall: 485.00, putWall: 475.00, flowDirection: 'BUYING_PRESSURE' }),
        JSON.stringify({ vixQuote: 13.42, vixChangePercent: -2.5 }),
        [], today, marketDateStr
      ];

      // Signal 2: SPY Rebound PUT
      const sig2 = [
        'SPY', 'PUT', 'BUY_PUT_ON_RIP', 528.10, 527.80, 529.50, 524.00, 75, 'B / LOTTO', 'PENDING',
        JSON.stringify({ vwap: 528.90, ema9: 528.20, ema21: 528.50, atr14: 1.95, openingRangeHigh: 530.10, openingRangeLow: 527.50 }),
        JSON.stringify({ netGex: -120000, regime: 'BEARISH', flipStrike: 530.00, callWall: 535.00, putWall: 525.00, flowDirection: 'SELLING_PRESSURE' }),
        JSON.stringify({ vixQuote: 13.42, vixChangePercent: -2.5 }),
        [], today, marketDateStr
      ];

      // Signal 3: Blocked Setup
      const sig3 = [
        'QQQ', 'NONE', 'NO_TRADE', 482.50, null, null, null, 40, 'C / LOTTO', 'CANCELLED',
        JSON.stringify({ vwap: 482.30, ema9: 482.40, ema21: 482.50, atr14: 1.25 }),
        JSON.stringify({ netGex: 25000, regime: 'CONSOLIDATING', flipStrike: 480.00 }),
        JSON.stringify({ vixQuote: 13.42, vixChangePercent: -2.5 }),
        ['RSI overbought (>70) on 5m chart', 'Inside Opening Range 15m bracket', 'GEX Flip Strike too close'],
        today, marketDateStr
      ];

      const query = `
        INSERT INTO signals (
          symbol, signal_type, trade_bias, current_price, entry_trigger, stop_loss, target_price, confidence_score, setup_grade, status,
          indicators, gex, volatility, no_trade_reasons, option_expiration_date, market_date
        ) VALUES 
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16),
        ($17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32),
        ($33, $34, $35, $36, $37, $38, $39, $40, $41, $42, $43, $44, $45, $46, $47, $48)
      `;

      await client.query(query, [...sig1, ...sig2, ...sig3]);
      await client.query('COMMIT');

      return { success: true, insertedCount: 3 };
    } catch (err: any) {
      await client.query('ROLLBACK');
      fastify.log.error(err);
      return (reply as any).code(500).send({ error: 'Failed to seed sample signals' });
    } finally {
      client.release();
    }
  });

  // GET /api/signals/health - Check health of all external APIs
  fastify.get('/health', {
    schema: {
      tags: ['Signals'],
      summary: 'Get day trading API health metrics',
      description: 'Check connectivity status and response times of third-party options and market data APIs.',
      security: [{ bearerAuth: [] }]
    }
  }, async (request, reply) => {
    try {
      const { id: userId } = (request as any).user;
      const scanner = (fastify as any).scanner;
      if (!scanner) {
        return (reply as any).code(500).send({ error: 'Scanner service not initialized' });
      }
      const health = await scanner.runHealthCheck(userId);
      return health;
    } catch (err: any) {
      fastify.log.error(err);
      return (reply as any).code(500).send({ error: 'Failed to evaluate API health' });
    }
  });

  // POST /api/signals/trigger - Manually fire a scan cycle immediately (for testing/dev)
  fastify.post('/trigger', {
    schema: {
      tags: ['Signals'],
      summary: 'Manually trigger a scan cycle',
      description: 'Fires an immediate signal scan for all active symbols. Useful for testing the enrichment pipeline without waiting for the 5-minute scheduler.',
      security: [{ bearerAuth: [] }]
    }
  }, async (request, reply) => {
    try {
      const scanner = (fastify as any).scanner;
      if (!scanner) {
        return (reply as any).code(500).send({ error: 'Scanner service not initialized' });
      }
      setImmediate(() => {
        scanner.scanAllActiveUsers().catch((err: any) => {
          fastify.log.error(`[ManualTrigger] Scan failed: ${err.message}`);
        });
      });
      return { success: true, message: 'Scan cycle triggered. Signals will appear within 15–30 seconds.' };
    } catch (err: any) {
      fastify.log.error(err);
      return (reply as any).code(500).send({ error: 'Failed to trigger scan' });
    }
  });
}

