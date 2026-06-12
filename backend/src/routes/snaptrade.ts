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
    const result = await snaptradeService.generateConnectionUrl(userId);
    return result; // { redirectURI: "https://..." }
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
