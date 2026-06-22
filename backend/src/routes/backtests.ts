import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import { SignalReplayBacktester } from '../services/signal-replay-backtester';

const SignalReplaySchema = z.object({
  symbols: z.array(z.string()).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  contractsPerTrade: z.number().positive().optional(),
  takeProfitPct: z.number().positive().optional(),
  stopLossPct: z.number().positive().optional(),
  maxTradesPerDay: z.number().int().positive().optional(),
  dailyProfitTarget: z.number().positive().optional(),
  dailyLossLimit: z.number().positive().optional(),
  interval: z.enum(['1m', '5m', '15m', '1h', '1d']).optional(),
  maxSignals: z.number().int().positive().max(1000).optional()
});

export async function backtestRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.post('/signal-replay', {
    schema: {
      tags: ['Backtests'],
      summary: 'Replay stored signals with ThetaData historical option prices',
      description: 'Simulates TP/SL, contracts, daily profit/loss caps, and macro-filter scenarios over stored generated signals.',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        properties: {
          symbols: { type: 'array', items: { type: 'string' } },
          startDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          endDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          contractsPerTrade: { type: 'number' },
          takeProfitPct: { type: 'number' },
          stopLossPct: { type: 'number' },
          maxTradesPerDay: { type: 'integer' },
          dailyProfitTarget: { type: 'number' },
          dailyLossLimit: { type: 'number' },
          interval: { type: 'string', enum: ['1m', '5m', '15m', '1h', '1d'] },
          maxSignals: { type: 'integer' }
        }
      }
    }
  }, async (request, reply) => {
    const parsed = SignalReplaySchema.safeParse((request as any).body || {});
    if (!parsed.success) {
      return (reply as any).code(400).send({
        error: 'Invalid backtest request',
        details: parsed.error.issues
      });
    }

    try {
      const { id: userId } = (request as any).user;
      const backtester = new SignalReplayBacktester(fastify);
      return await backtester.run(userId, parsed.data);
    } catch (err: any) {
      fastify.log.error(`[Backtests] Signal replay failed: ${err.message || String(err)}`);
      return (reply as any).code(500).send({
        error: 'Signal replay backtest failed',
        message: err.message || String(err)
      });
    }
  });
}
