import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { SnaptradeService } from '../services/snaptrade-service';
import { AIService } from '../services/ai-service';

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
      security: [{ bearerAuth: [] }]
    }
  }, async (request, reply) => {
    const { id: userId } = (request as any).user;
    try {
      const portfolio = await snaptradeService.getPortfolio(userId);
      
      // We need the AIService to generate the briefing
      const aiService = new AIService(fastify);
      
      const briefing = await aiService.generateWealthsimpleBriefing(portfolio.positions);
      return briefing;
    } catch (err: any) {
      fastify.log.error(`[SnapTradeBriefing] Failed to generate briefing: ${err.message}`);
      return {
        briefing: `⚠️ **AI Briefing Generation Failed**\n\nThe AI model was unable to analyze your portfolio. This is typically caused by:\n- Missing or invalid OpenRouter API key in your settings\n- Insufficient OpenRouter credits/balance\n- Temporary API timeout or model rate limits\n\n*Technical Details: ${err.message}*`
      };
    }
  });
}
