import Fastify from 'fastify';
import cors from '@fastify/cors';
import postgres from '@fastify/postgres';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { Client } from 'pg';
import { positionRoutes } from './routes/positions';
import { marketDataRoutes } from './routes/market-data';
import { marketRoutes } from './routes/market';
import { aiRoutes } from './routes/ai';
import { mlRoutes } from './routes/ml';
import { settingsRoutes } from './routes/settings';
import jwt from '@fastify/jwt';
import authRoutes from './routes/auth';
import { adminRoutes } from './routes/admin';
import { FastifyRequest, FastifyReply } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: any;
  }
}

const fastify = Fastify({
  logger: {
    level: 'warn'
  },
  disableRequestLogging: true
});

const testConnection = async (connectionString: string, label: string): Promise<boolean> => {
  const isCloud = connectionString.includes('aivencloud');
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 5000,
    ssl: isCloud ? { rejectUnauthorized: false } : undefined
  });
  try {
    console.log(`[Database] Testing connection to ${label}...`);
    await client.connect();
    await client.query('SELECT 1');
    await client.end();
    console.log(`[Database] Success: Connected to ${label}`);
    return true;
  } catch (err: any) {
    console.error(`[Database] Failed to connect to ${label}: ${err.message}`);
    return false;
  }
};

const start = async () => {
  try {
    let activeDbUrl = process.env.DATABASE_URL || 'postgres://user:password@localhost:5432/options_monitoring';
    const backupDbUrl = process.env.BACKUP_DATABASE_URL;

    // 1. Try Primary
    const primarySuccess = await testConnection(activeDbUrl, 'Primary');

    if (!primarySuccess) {
      if (backupDbUrl) {
        console.warn('[Database] Primary failed. Attempting Backup...');
        const backupSuccess = await testConnection(backupDbUrl, 'Backup');
        if (backupSuccess) {
          activeDbUrl = backupDbUrl;
          console.warn('[Database] SWITCHED TO BACKUP DATABASE.');
        } else {
          throw new Error('Both Primary and Backup databases failed.');
        }
      } else {
        throw new Error('Primary database failed and no backup configured.');
      }
    }

    // Log final choice (masking creds)
    console.log(`[System] Active Database Host: ${activeDbUrl.includes('@') ? activeDbUrl.split('@')[1] : 'localhost'}`);

    await fastify.register(postgres, {
      connectionString: activeDbUrl,
      ssl: activeDbUrl.includes('aivencloud') ? { rejectUnauthorized: false } : undefined,
      max: 20,
      idleTimeoutMillis: 30000
    });

    await fastify.register(cors, {
      origin: true
    });

    // Swagger/OpenAPI configuration
    await fastify.register(swagger, {
      openapi: {
        openapi: '3.0.0',
        info: {
          title: 'Options Trade Monitoring API',
          description: 'API for tracking and monitoring options trading positions with real-time price updates, alerts, and portfolio analytics.',
          version: '1.0.0'
        },
        // Empty servers array = Swagger uses relative URLs (works on any host/port)
        servers: [],
        components: {
          securitySchemes: {
            bearerAuth: {
              type: 'http',
              scheme: 'bearer',
              bearerFormat: 'JWT',
              description: 'Enter your JWT token obtained from /api/auth/signin'
            }
          }
        },
        tags: [
          { name: 'Auth', description: 'Authentication endpoints' },
          { name: 'Positions', description: 'Options positions management' },
          { name: 'Settings', description: 'User settings' },
          { name: 'Admin', description: 'Admin operations' },
          { name: 'Market', description: 'Market data and status' },
          { name: 'AI', description: 'AI-powered analysis' }
        ]
      }
    });

    await fastify.register(swaggerUi, {
      routePrefix: '/docs',
      uiConfig: {
        docExpansion: 'list',
        deepLinking: true,
        persistAuthorization: true
      }
    });

    if (!process.env.JWT_SECRET) {
      throw new Error('JWT_SECRET environment variable is required');
    }

    await fastify.register(jwt, {
      secret: process.env.JWT_SECRET
    });

    fastify.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await request.jwtVerify();
      } catch (err) {
        reply.send(err);
      }
    });

    fastify.register(authRoutes, { prefix: '/api/auth' });
    fastify.register(adminRoutes, { prefix: '/api/admin' });
    fastify.register(positionRoutes, { prefix: '/api/positions' });
    fastify.register(marketDataRoutes, { prefix: '/api/market-data' });
    fastify.register(marketRoutes, { prefix: '/api/market' });
    fastify.register(aiRoutes, { prefix: '/api/ai' });
    fastify.register(mlRoutes, { prefix: '/api/v1/ml' });
    fastify.register(settingsRoutes, { prefix: '/api/settings' });

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
