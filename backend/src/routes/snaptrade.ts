import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { SnaptradeService } from '../services/snaptrade-service';
import { AIService } from '../services/ai-service';
import { redis } from '../lib/redis';

export async function snaptradeRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {
  fastify.addHook('onRequest', fastify.authenticate);
  const snaptradeService = new SnaptradeService(fastify);

  // POST /connect
  fastify.post('/connect', {
    schema: {
      tags: ['SnapTrade'],
      summary: 'Generate Connection URL',
      description: 'Generates a unique redirect URI so the user can securely login to their Wealthsimple broker.',
      security: [{ bearerAuth: [] }]
    }
  }, async (request, reply) => {
    const { id: userId } = (request as any).user;
    try {
      const result = await snaptradeService.generateConnectionUrl(userId);
      return result; // { redirectURI: "https://..." }
    } catch (err: any) {
      fastify.log.warn(`[SnapTradeConnect] Failed for user ${userId}: ${err.message}`);
      return reply.code(400).send({ error: err.message || 'Failed to generate Wealthsimple connection URL' });
    }
  });

  // GET /connections
  fastify.get('/connections', {
    schema: {
      tags: ['SnapTrade'],
      summary: 'Get Wealthsimple Connection Status',
      description: 'Returns SnapTrade brokerage authorization types so read-only vs trade-enabled connections are visible.',
      security: [{ bearerAuth: [] }]
    }
  }, async (request, reply) => {
    const { id: userId } = (request as any).user;
    return snaptradeService.getConnectionStatus(userId);
  });

  // POST /reset-readonly-connections
  fastify.post('/reset-readonly-connections', {
    schema: {
      tags: ['SnapTrade'],
      summary: 'Remove Read-Only Wealthsimple Connections',
      description: 'Removes read-only Wealthsimple SnapTrade authorizations so the user can reconnect with trading access.',
      security: [{ bearerAuth: [] }]
    }
  }, async (request, reply) => {
    const { id: userId } = (request as any).user;
    return snaptradeService.resetReadOnlyWealthsimpleConnections(userId);
  });

  // POST /sync
  fastify.post('/sync', {
    schema: {
      tags: ['SnapTrade'],
      summary: 'Sync Wealthsimple Portfolio',
      description: 'Fetches latest open self-directed accounts and positions from SnapTrade and saves them.',
      security: [{ bearerAuth: [] }]
    }
  }, async (request, reply) => {
    const { id: userId } = (request as any).user;
    const result = await snaptradeService.syncPortfolio(userId);
    return result;
  });

  // POST /sync-pending-orders
  fastify.post('/sync-pending-orders', {
    schema: {
      tags: ['SnapTrade'],
      summary: 'Sync Pending Wealthsimple Orders',
      description: 'Checks recent SnapTrade orders and promotes pending Wealthsimple executions to open or closed positions.',
      security: [{ bearerAuth: [] }]
    }
  }, async (request, reply) => {
    const { id: userId } = (request as any).user;
    try {
      const result = await snaptradeService.syncPendingBrokerOrders(userId);
      return result;
    } catch (err: any) {
      if (String(err.message || '').includes('already running')) {
        return reply.code(409).send({ error: err.message });
      }
      throw err;
    }
  });

  // POST /dev/place-option-order
  fastify.post('/dev/place-option-order', {
    schema: {
      tags: ['SnapTrade'],
      summary: 'Place Dev Wealthsimple Option Order',
      description: 'Dev-only endpoint that places a live SnapTrade option order and records it as a pending app position.',
      security: [{ bearerAuth: [] }]
    }
  }, async (request, reply) => {
    const devTestsEnabled = process.env.NODE_ENV !== 'production' || process.env.ENABLE_DEV_TRADING_TESTS === 'true';
    if (!devTestsEnabled) {
      return reply.code(404).send({ error: 'Dev trade testing is disabled' });
    }

    const { id: userId } = (request as any).user;
    const body = request.body as {
      symbol?: string;
      optionType?: 'CALL' | 'PUT';
      strike?: number | string;
      expiration?: string;
      quantity?: number | string;
      orderType?: 'LIMIT' | 'MARKET';
      limitPrice?: number | string;
      mark?: number | string;
      confirmation?: string;
    };

    const symbol = String(body.symbol || '').trim().toUpperCase();
    const optionType = body.optionType;
    const strike = Number(body.strike);
    const expiration = String(body.expiration || '').trim();
    const quantity = Number(body.quantity || 1);
    const orderType = body.orderType === 'MARKET' ? 'MARKET' : 'LIMIT';
    const limitPrice = body.limitPrice !== undefined && body.limitPrice !== '' ? Number(body.limitPrice) : undefined;
    const mark = body.mark !== undefined && body.mark !== '' ? Number(body.mark) : undefined;

    if (body.confirmation !== 'PLACE LIVE ORDER') {
      return reply.code(400).send({ error: 'Type PLACE LIVE ORDER to confirm this live SnapTrade test order' });
    }
    if (!symbol || !optionType || !Number.isFinite(strike) || !expiration || !Number.isFinite(quantity) || quantity <= 0) {
      return reply.code(400).send({ error: 'symbol, optionType, strike, expiration, and positive quantity are required' });
    }
    if (orderType === 'LIMIT' && (!Number.isFinite(limitPrice) || Number(limitPrice) <= 0)) {
      return reply.code(400).send({ error: 'limitPrice is required for LIMIT orders' });
    }

    try {
      const result = await snaptradeService.placeTrackedTestOptionOrder(userId, {
        symbol,
        optionType,
        strike,
        expiration,
        quantity,
        orderType,
        limitPrice,
        mark
      });
      return result;
    } catch (err: any) {
      fastify.log.error(`[SnapTradeDevOrder] Failed to place dev option order: ${err.message}`);
      return reply.code(400).send({ error: err.message || 'Failed to place SnapTrade dev option order' });
    }
  });

  // GET /portfolio
  fastify.get('/portfolio', {
    schema: {
      tags: ['SnapTrade'],
      summary: 'Get Wealthsimple Portfolio',
      description: 'Retrieves synced Wealthsimple accounts and positions from the database.',
      security: [{ bearerAuth: [] }]
    }
  }, async (request, reply) => {
    const { id: userId } = (request as any).user;
    const portfolio = await snaptradeService.getPortfolio(userId);
    return portfolio;
  });

  // GET /briefing
  fastify.get('/briefing', {
    schema: {
      tags: ['SnapTrade'],
      summary: 'Get Wealthsimple AI Briefing',
      description: 'Generates an AI briefing for the Wealthsimple portfolio.',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          refresh: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { id: userId } = (request as any).user;
    const forceRefresh = (request.query as any)?.refresh === 'true';

    try {
      if (!forceRefresh) {
        const { rows } = await (fastify as any).pg.query(
          'SELECT briefing, last_reviewed_at FROM snaptrade_briefings WHERE user_id = $1',
          [userId]
        );
        if (rows.length > 0) {
          return {
            briefing: rows[0].briefing,
            lastReviewedAt: rows[0].last_reviewed_at
          };
        }
      }

      const portfolio = await snaptradeService.getPortfolio(userId);
      
      // We need the AIService to generate the briefing
      const aiService = new AIService(fastify);
      
      const briefingResult = await aiService.generateWealthsimpleBriefing(portfolio.positions, userId);
      
      // Save or update in database
      await (fastify as any).pg.query(
        `INSERT INTO snaptrade_briefings (user_id, briefing, last_reviewed_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (user_id) DO UPDATE
         SET briefing = EXCLUDED.briefing, last_reviewed_at = NOW()`,
        [userId, JSON.stringify(briefingResult.briefing)]
      );

      return {
        briefing: briefingResult.briefing,
        lastReviewedAt: new Date().toISOString()
      };
    } catch (err: any) {
      fastify.log.error(`[SnapTradeBriefing] Failed to generate briefing: ${err.message}`);
      return {
        briefing: {
          summary: `⚠️ **AI Briefing Generation Failed**\n\nThe AI model was unable to analyze your portfolio. Technical Details: ${err.message}`,
          actionRequired: [],
          holdWatch: []
        },
        lastReviewedAt: null
      };
    }
  });
}
