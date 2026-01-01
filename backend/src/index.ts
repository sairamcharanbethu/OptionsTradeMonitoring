import Fastify from 'fastify';
import cors from '@fastify/cors';
import postgres from '@fastify/postgres';
import { positionRoutes } from './routes/positions';
import { marketDataRoutes } from './routes/market-data';
import { marketRoutes } from './routes/market';

const fastify = Fastify({
  logger: true
});

const start = async () => {
  try {
    await fastify.register(postgres, {
      connectionString: process.env.DATABASE_URL || 'postgres://user:password@localhost:5432/options_monitoring'
    });

    await fastify.register(cors, {
      origin: true
    });

    fastify.register(positionRoutes, { prefix: '/api/positions' });
    fastify.register(marketDataRoutes, { prefix: '/api/market-data' });
    fastify.register(marketRoutes, { prefix: '/api/market' });

    fastify.get('/health', async () => {
      return { status: 'ok' };
    });

    // Root route
    fastify.get('/', async () => {
      return { message: 'Options Monitoring API' };
    });

    // Initialize poller BEFORE listen
    const { MarketPoller } = await import('./services/market-poller');
    const poller = new MarketPoller(fastify);
    fastify.decorate('poller', poller);

    const port = Number(process.env.PORT) || 3001;
    await fastify.listen({ port, host: '0.0.0.0' });

    // Start the background cycle
    poller.start();

    console.log(`Server listening on http://localhost:${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
