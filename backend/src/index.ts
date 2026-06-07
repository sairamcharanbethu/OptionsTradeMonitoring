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
import { settingsRoutes } from './routes/settings';
import { goalRoutes } from './routes/goals';
import { signalRoutes } from './routes/signals';
import jwt from '@fastify/jwt';
import authRoutes from './routes/auth';
import { adminRoutes } from './routes/admin';
import { snaptradeRoutes } from './routes/snaptrade';
import { FastifyRequest, FastifyReply } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: any;
  }
}

const fastify = Fastify({
  logger: {
    level: 'info',
    // transport: {
    //   target: 'pino-pretty', // Install pino-pretty for dev formatted logs
    // }
  },
  disableRequestLogging: false
});

const testConnection = async (connectionString: string, label: string): Promise<boolean> => {
  const isCloud = connectionString.includes('aivencloud');
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 5000,
    ssl: isCloud ? { rejectUnauthorized: false } : undefined
  });
  try {
    fastify.log.info(`[Database] Testing connection to ${label}...`);
    await client.connect();
    await client.query('SELECT 1');
    await client.end();
    fastify.log.info(`[Database] Success: Connected to ${label}`);
    return true;
  } catch (err: any) {
    fastify.log.error(`[Database] Failed to connect to ${label}: ${err.message}`);
    return false;
  }
};

const ensureSchema = async (instance: any) => {
  try {
    instance.log.info('[Database] Verifying database schema...');
    
    // 1. Create stock_history_cache table
    await instance.pg.query(`
      CREATE TABLE IF NOT EXISTS stock_history_cache (
        id SERIAL PRIMARY KEY,
        symbol VARCHAR(20) UNIQUE NOT NULL,
        symbol_id VARCHAR(50),
        data JSONB NOT NULL,
        fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 2. Create goals and goal_entries tables
    await instance.pg.query(`
      CREATE TABLE IF NOT EXISTS goals (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        target_amount DECIMAL(12,2) NOT NULL,
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await instance.pg.query(`
      CREATE TABLE IF NOT EXISTS goal_entries (
        id SERIAL PRIMARY KEY,
        goal_id INTEGER REFERENCES goals(id) ON DELETE CASCADE,
        entry_date DATE NOT NULL,
        amount DECIMAL(12,2) NOT NULL,
        notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(goal_id, entry_date)
      );
    `);

    // 2.5 Create trade signals table
    await instance.pg.query(`
      CREATE TABLE IF NOT EXISTS signals (
        id SERIAL PRIMARY KEY,
        symbol VARCHAR(10) NOT NULL,
        signal_type VARCHAR(10) NOT NULL,
        trade_bias VARCHAR(50) NOT NULL,
        current_price NUMERIC(10, 2) NOT NULL,
        entry_trigger NUMERIC(10, 2),
        stop_loss NUMERIC(10, 2),
        target_price NUMERIC(10, 2),
        confidence_score INTEGER NOT NULL,
        setup_grade VARCHAR(50),
        status VARCHAR(20) DEFAULT 'PENDING',
        indicators JSONB,
        gex JSONB,
        volatility JSONB,
        no_trade_reasons TEXT[],
        option_expiration_date DATE,
        market_date VARCHAR(20),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 3. Ensure all extra columns are added to positions table
    const columns = [
      { name: 'delta', type: 'DECIMAL(10, 4)' },
      { name: 'theta', type: 'DECIMAL(10, 4)' },
      { name: 'gamma', type: 'DECIMAL(10, 4)' },
      { name: 'vega', type: 'DECIMAL(10, 4)' },
      { name: 'iv', type: 'DECIMAL(10, 4)' },
      { name: 'underlying_price', type: 'DECIMAL(10, 2)' },
      { name: 'analyzed_support', type: 'DECIMAL(10, 2)' },
      { name: 'analyzed_resistance', type: 'DECIMAL(10, 2)' },
      { name: 'suggested_stop_loss', type: 'DECIMAL(10, 2)' },
      { name: 'suggested_take_profit_1', type: 'DECIMAL(10, 2)' },
      { name: 'suggested_take_profit_2', type: 'DECIMAL(10, 2)' },
      { name: 'analysis_data', type: 'JSONB' },
      { name: 'is_simulated', type: 'BOOLEAN DEFAULT FALSE' },
      { name: 'account_id', type: 'VARCHAR(255)' }
    ];

    for (const col of columns) {
      await instance.pg.query(`
        ALTER TABLE positions ADD COLUMN IF NOT EXISTS ${col.name} ${col.type};
      `);
    }

    instance.log.info('[Database] Schema verification completed successfully.');

    // 3a. Migrate signals table: add news_context, ai_coach_commentary, token_usage, and ml_probability columns (idempotent)
    await instance.pg.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS news_context TEXT;`);
    await instance.pg.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS ai_coach_commentary TEXT;`);
    await instance.pg.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS token_usage JSONB;`);
    await instance.pg.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS ml_probability NUMERIC(5, 4);`);

    // 4. Create snaptrade tables
    await instance.pg.query(`
      CREATE TABLE IF NOT EXISTS snaptrade_accounts (
        id VARCHAR(255) PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(255),
        number VARCHAR(100),
        status VARCHAR(50),
        unified_type VARCHAR(100),
        raw_data JSONB,
        last_synced_at TIMESTAMPTZ DEFAULT NOW(),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await instance.pg.query(`
      CREATE TABLE IF NOT EXISTS snaptrade_positions (
        id VARCHAR(255) PRIMARY KEY,
        account_id VARCHAR(255) REFERENCES snaptrade_accounts(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        symbol VARCHAR(255) NOT NULL,
        description TEXT,
        asset_type VARCHAR(100),
        price DECIMAL(15, 4),
        units DECIMAL(15, 4),
        average_purchase_price DECIMAL(15, 4),
        open_pnl DECIMAL(15, 4),
        currency VARCHAR(10),
        raw_data JSONB,
        last_synced_at TIMESTAMPTZ DEFAULT NOW(),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Ensure columns are altered in case they were already created with a smaller size
    try {
      await instance.pg.query(`
        ALTER TABLE snaptrade_accounts ALTER COLUMN id TYPE VARCHAR(255);
        ALTER TABLE snaptrade_accounts ALTER COLUMN name TYPE VARCHAR(255);
        ALTER TABLE snaptrade_accounts ALTER COLUMN number TYPE VARCHAR(100);
        ALTER TABLE snaptrade_accounts ALTER COLUMN status TYPE VARCHAR(50);
        ALTER TABLE snaptrade_accounts ALTER COLUMN unified_type TYPE VARCHAR(100);
        
        ALTER TABLE snaptrade_positions ALTER COLUMN id TYPE VARCHAR(255);
        ALTER TABLE snaptrade_positions ALTER COLUMN account_id TYPE VARCHAR(255);
        ALTER TABLE snaptrade_positions ALTER COLUMN symbol TYPE VARCHAR(255);
        ALTER TABLE snaptrade_positions ALTER COLUMN asset_type TYPE VARCHAR(100);
      `);
    } catch (e) {
      instance.log.warn('[Database] Could not alter some snaptrade columns (might not exist yet or conflicting constraint).');
    }



    instance.log.info('[Database] Schema verification completed successfully.');
  } catch (err: any) {
    instance.log.error(`[Database] Schema verification failed: ${err.message}`);
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
        fastify.log.warn('[Database] Primary failed. Attempting Backup...');
        const backupSuccess = await testConnection(backupDbUrl, 'Backup');
        if (backupSuccess) {
          activeDbUrl = backupDbUrl;
          fastify.log.warn('[Database] SWITCHED TO BACKUP DATABASE.');
        } else {
          throw new Error('Both Primary and Backup databases failed.');
        }
      } else {
        throw new Error('Primary database failed and no backup configured.');
      }
    }

    // Log final choice (masking creds)
    fastify.log.info(`[System] Active Database Host: ${activeDbUrl.includes('@') ? activeDbUrl.split('@')[1] : 'localhost'}`);

    await fastify.register(postgres, {
      connectionString: activeDbUrl,
      ssl: activeDbUrl.includes('aivencloud') ? { rejectUnauthorized: false } : undefined,
      max: 20,
      idleTimeoutMillis: 30000
    });

    // Verify and ensure all required database schema elements exist
    await ensureSchema(fastify);

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
          { name: 'AI', description: 'AI-powered analysis' },
          { name: 'Goals', description: 'Goal tracking and earnings log' }
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
    fastify.register(settingsRoutes, { prefix: '/api/settings' });
    fastify.register(goalRoutes, { prefix: '/api/goals' });
    fastify.register(snaptradeRoutes, { prefix: '/api/snaptrade' });
    fastify.register(signalRoutes, { prefix: '/api/signals' });

    fastify.get('/health', async () => {
      return { status: 'ok' };
    });

    // Root route
    fastify.get('/', async () => {
      return { message: 'Options Monitoring API' };
    });

    const { QuestradeService } = await import('./services/questrade-service');
    const questrade = new QuestradeService(fastify);
    fastify.decorate('questrade', questrade);

    // Initialize poller BEFORE listen
    const { MarketPoller } = await import('./services/market-poller');
    const poller = new MarketPoller(fastify);
    fastify.decorate('poller', poller);

    const { SignalScannerService } = await import('./services/signal-scanner-service');
    const scanner = new SignalScannerService(fastify);
    fastify.decorate('scanner', scanner);

    // --- WebSocket & Streaming Setup ---
    await fastify.register(import('@fastify/websocket'));
    const { redis } = await import('./lib/redis');

    const { QuestradeStreamService } = await import('./services/questrade-stream-service');
    const streamer = new QuestradeStreamService(fastify);
    fastify.decorate('streamer', streamer);

    // Broadcast real-time quotes to all connected frontend clients
    streamer.on('quote', async (quote) => {
      // Enrich with Symbol if missing
      if (!quote.symbol && quote.symbolId) {
        const ticker = await redis.get(`SYMBOL_NAME:${quote.symbolId}`);
        if (ticker) quote.symbol = ticker;
      }

      if (fastify.websocketServer) {
        fastify.websocketServer.clients.forEach((client: any) => {
          if (client.readyState === 1) { // WebSocket.OPEN
            client.send(JSON.stringify({ type: 'PRICE_UPDATE', data: quote }));
          }
        });
      }

      // Feed data into Poller for Stop Loss checks (Optimization: Don't wait for poll cycle)
      // poller.onExternalPriceUpdate(quote); // TODO: Implement in MarketPoller
    });

    // Public WebSocket endpoint
    // Note: @fastify/websocket v10+ passes the socket directly, not connection.socket
    fastify.get('/api/ws', { websocket: true }, (socket: any, req: any) => {
      if (!socket) {
        fastify.log.error('[WebSocket] Socket is null');
        return;
      }

      fastify.log.info('[WebSocket] Client connected');

      socket.on('message', (message: any) => {
        // Handle subscriptions from frontend if we want selective streaming
        // For now, we broadcast everything we have.
        try {
          const data = JSON.parse(message.toString());
          fastify.log.info(`[WebSocket] Received: ${JSON.stringify(data)}`);
        } catch (e) {
          // Non-JSON message, ignore
        }
      });

      socket.on('close', () => {
        fastify.log.info('[WebSocket] Client disconnected');
      });

      socket.on('error', (err: any) => {
        fastify.log.error(`[WebSocket] Client error: ${err.message}`);
      });
    });

    const port = Number(process.env.PORT) || 3001;
    await fastify.listen({ port, host: '0.0.0.0' });

    // Start background services
    poller.start();
    scanner.start();
    // streamer.start(); // Disabled: Subscriptions are on-demand via position sync

    fastify.log.info(`Server listening on http://localhost:${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
