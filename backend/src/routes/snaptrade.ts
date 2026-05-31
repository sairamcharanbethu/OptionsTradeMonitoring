import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { SnaptradeService } from '../services/snaptrade-service';

export async function snaptradeRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {
  fastify.addHook('onRequest', fastify.authenticate);
  const snaptradeService = new SnaptradeService(fastify);

  // We are currently hardcoding the userId and userSecret based on our previous testing.
  // In a production app, you would retrieve these from the user's profile in the database.
  const SNAPTRADE_USER_ID = "sbethu";
  const SNAPTRADE_USER_SECRET = "264a905e-d75b-4f3b-939e-9c58f01c5375";

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
    const result = await snaptradeService.syncPortfolio(userId, SNAPTRADE_USER_ID, SNAPTRADE_USER_SECRET);
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
    const portfolio = await snaptradeService.getPortfolio(userId);
    
    // We need the AIService to generate the briefing
    const { AIService } = await import('../services/ai-service');
    const aiService = new AIService(fastify);
    
    const briefing = await aiService.generateWealthsimpleBriefing(portfolio.positions);
    return briefing;
  });
}
