import Fastify from 'fastify';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
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
import { tradeRoutes } from './routes/trades';
import { backtestRoutes } from './routes/backtests';
import { coveredCallRoutes } from './routes/covered-calls';
import jwt from '@fastify/jwt';
import authRoutes from './routes/auth';
import { adminRoutes } from './routes/admin';
import { snaptradeRoutes } from './routes/snaptrade';
import { FastifyRequest, FastifyReply } from 'fastify';
import { normalizeAdapterHealth } from './lib/adapter-health';

function loadEnvFile(filePath: string) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    if (!key || process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, '');
  }
}

loadEnvFile(path.join(__dirname, '../../.env'));
loadEnvFile(path.join(process.cwd(), '.env'));

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
        option_details JSONB,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 2.6 Create scanner logs table
    await instance.pg.query(`
      CREATE TABLE IF NOT EXISTS scanner_logs (
        id SERIAL PRIMARY KEY,
        symbol VARCHAR(10) NOT NULL,
        spot_price NUMERIC(10, 2) NOT NULL,
        regime VARCHAR(30) NOT NULL,
        vix NUMERIC(5, 2),
        gex_available BOOLEAN NOT NULL,
        indicators JSONB,
        outcome VARCHAR(30) NOT NULL,
        no_trade_reasons TEXT[],
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await instance.pg.query(`
      CREATE TABLE IF NOT EXISTS signal_user_executions (
        signal_id INTEGER REFERENCES signals(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        execution_broker VARCHAR(50),
        broker_order_id VARCHAR(255),
        broker_trade_id VARCHAR(255),
        execution_status VARCHAR(50),
        execution_error TEXT,
        contracts_requested INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (signal_id, user_id)
      );
    `);

    await instance.pg.query(`
      CREATE TABLE IF NOT EXISTS trade_events (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        signal_id INTEGER,
        position_id INTEGER,
        event_type VARCHAR(80) NOT NULL,
        message TEXT,
        metadata JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
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
      { name: 'account_id', type: 'VARCHAR(255)' },
      { name: 'notes', type: 'TEXT' },
      { name: 'exit_price', type: 'DECIMAL(10, 2)' },
      { name: 'execution_broker', type: 'VARCHAR(50)' },
      { name: 'broker_order_id', type: 'VARCHAR(255)' },
      { name: 'broker_trade_id', type: 'VARCHAR(255)' },
      { name: 'broker_exit_order_id', type: 'VARCHAR(255)' },
      { name: 'broker_exit_trade_id', type: 'VARCHAR(255)' },
      { name: 'execution_account_id', type: 'VARCHAR(255)' },
      { name: 'execution_status', type: 'VARCHAR(50)' },
      { name: 'execution_error', type: 'TEXT' },
      { name: 'contracts_requested', type: 'INTEGER' },
      { name: 'exit_requested_at', type: 'TIMESTAMPTZ' },
      { name: 'exit_reason', type: 'VARCHAR(50)' },
      { name: 'exit_order_type', type: 'VARCHAR(20)' },
      { name: 'profit_trim_status', type: 'VARCHAR(50)' },
      { name: 'profit_trim_quantity', type: 'INTEGER' },
      { name: 'profit_trim_price', type: 'DECIMAL(10, 2)' },
      { name: 'profit_trim_order_id', type: 'VARCHAR(255)' },
      { name: 'profit_trim_trade_id', type: 'VARCHAR(255)' },
      { name: 'profit_trimmed_at', type: 'TIMESTAMPTZ' },
      { name: 'exit_retry_count', type: 'INTEGER DEFAULT 0' },
      { name: 'last_broker_sync_at', type: 'TIMESTAMPTZ' },
      { name: 'last_broker_order_status', type: 'VARCHAR(50)' }
    ];

    for (const col of columns) {
      await instance.pg.query(`
        ALTER TABLE positions ADD COLUMN IF NOT EXISTS ${col.name} ${col.type};
      `);
    }

    await instance.pg.query(`
      ALTER TABLE trade_events ADD COLUMN IF NOT EXISTS signal_id INTEGER;
    `);

    await instance.pg.query(`
      CREATE INDEX IF NOT EXISTS idx_positions_broker_pending
        ON positions (user_id, execution_broker, status, execution_status, updated_at DESC);
    `);
    await instance.pg.query(`
      CREATE INDEX IF NOT EXISTS idx_trade_events_position_created
        ON trade_events (position_id, created_at DESC);
    `);
    await instance.pg.query(`
      CREATE INDEX IF NOT EXISTS idx_trade_events_user_created
        ON trade_events (user_id, created_at DESC);
    `);
    await instance.pg.query(`
      CREATE INDEX IF NOT EXISTS idx_trade_events_signal_created
        ON trade_events (signal_id, created_at DESC);
    `);
    try {
      await instance.pg.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_contract_per_user
          ON positions (user_id, symbol, option_type, strike_price, expiration_date)
          WHERE status IN ('OPEN', 'PENDING_ORDER');
      `);
    } catch (err: any) {
      instance.log.warn(`[Database] Active-contract unique index skipped: ${err.message}`);
    }
    try {
      await instance.pg.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint
            WHERE conname = 'chk_positions_exit_retry_count'
          ) THEN
            ALTER TABLE positions
              ADD CONSTRAINT chk_positions_exit_retry_count
              CHECK (exit_retry_count IS NULL OR (exit_retry_count >= 0 AND exit_retry_count <= 5))
              NOT VALID;
          END IF;
        END $$;
      `);
    } catch (err: any) {
      instance.log.warn(`[Database] Exit retry check constraint skipped: ${err.message}`);
    }

    instance.log.info('[Database] Schema verification completed successfully.');

    // 3a. Migrate signals table: add news_context, ai_coach_commentary, token_usage, ml_probability, and option_details columns (idempotent)
    await instance.pg.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS news_context TEXT;`);
    await instance.pg.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS ai_coach_commentary TEXT;`);
    await instance.pg.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS token_usage JSONB;`);
    await instance.pg.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS ml_probability NUMERIC(5, 4);`);
    await instance.pg.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS option_details JSONB;`);
    await instance.pg.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS execution_broker VARCHAR(50);`);
    await instance.pg.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS broker_order_id VARCHAR(255);`);
    await instance.pg.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS broker_trade_id VARCHAR(255);`);
    await instance.pg.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS execution_status VARCHAR(50);`);
    await instance.pg.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS execution_error TEXT;`);
    await instance.pg.query(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS contracts_requested INTEGER;`);

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

    await instance.pg.query(`
      CREATE TABLE IF NOT EXISTS snaptrade_briefings (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        briefing JSONB NOT NULL,
        last_reviewed_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
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
    fastify.register(tradeRoutes, { prefix: '/api/trades' });
    fastify.register(signalRoutes, { prefix: '/api/signals' });
    fastify.register(backtestRoutes, { prefix: '/api/backtests' });
    fastify.register(coveredCallRoutes, { prefix: '/api/covered-calls' });

    fastify.get('/health', async () => {
      return { status: 'ok' };
    });

    // Root route
    fastify.get('/', async () => {
      return { message: 'Options Monitoring API' };
    });

    const { ThetaDataService } = await import('./services/thetadata-service');
    const thetaData = new ThetaDataService(fastify);
    fastify.decorate('thetaData', thetaData);

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

    const { ThetaDataStreamService } = await import('./services/thetadata-stream-service');
    const thetaDataStreamer = new ThetaDataStreamService(fastify);
    fastify.decorate('thetaDataStreamer', thetaDataStreamer);

    const { AlpacaMarketDataStreamService } = await import('./services/alpaca-market-data-stream-service');
    const alpacaMarketDataStreamer = new AlpacaMarketDataStreamService(fastify);
    fastify.decorate('alpacaMarketDataStreamer', alpacaMarketDataStreamer);

    const { LiveExitMonitorService } = await import('./services/live-exit-monitor-service');
    const liveExitMonitor = new LiveExitMonitorService(fastify);
    fastify.decorate('liveExitMonitor', liveExitMonitor);

    const { SnaptradeService } = await import('./services/snaptrade-service');
    const snaptradeOrderSync = new SnaptradeService(fastify);
    const { OrderWatchdogService } = await import('./services/order-watchdog-service');
    const orderWatchdog = new OrderWatchdogService(fastify);
    const { TradeRedisService } = await import('./services/trade-redis-service');
    const snaptradePendingOrderSyncHealth = {
      status: 'IDLE',
      running: false,
      lastRunAt: null as string | null,
      lastResult: null as any,
      lastWatchdogResult: null as any,
      lastError: null as string | null,
      intervalSeconds: Number(process.env.SNAPTRADE_PENDING_SYNC_INTERVAL_SECONDS || 15),
      redisRehydratedAt: null as string | null,
      redisRehydratedUsers: 0,
      queuedSyncLastRunAt: null as string | null,
      queuedSyncProcessed: 0
    };

    const hydrateTradeRedisReadModels = async () => {
      const { rows } = await fastify.pg.query(
        `SELECT DISTINCT user_id
         FROM positions
         WHERE execution_broker = 'wealthsimple_snaptrade'
           AND status IN ('PENDING_ORDER', 'OPEN')`
      );
      for (const row of rows) {
        await TradeRedisService.rebuildOpenTrades(fastify.pg, Number(row.user_id), fastify);
      }
      snaptradePendingOrderSyncHealth.redisRehydratedAt = new Date().toISOString();
      snaptradePendingOrderSyncHealth.redisRehydratedUsers = rows.length;
      if (rows.length > 0) {
        fastify.log.info(`[TradeRedis] Rehydrated active trade read models for ${rows.length} user(s).`);
      }
    };

    hydrateTradeRedisReadModels().catch((err: any) => {
      fastify.log.warn(`[TradeRedis] Startup rehydration failed: ${err.message}`);
    });

    const runSnaptradePendingOrderSync = async () => {
      if (snaptradePendingOrderSyncHealth.running) return;
      snaptradePendingOrderSyncHealth.running = true;
      snaptradePendingOrderSyncHealth.status = 'RUNNING';
      snaptradePendingOrderSyncHealth.lastRunAt = new Date().toISOString();
      try {
        const result = await snaptradeOrderSync.syncAllPendingBrokerOrders();
        const watchdogResult = await orderWatchdog.run();
        snaptradePendingOrderSyncHealth.lastResult = result;
        snaptradePendingOrderSyncHealth.lastWatchdogResult = watchdogResult;
        snaptradePendingOrderSyncHealth.lastError = null;
        snaptradePendingOrderSyncHealth.status = 'UP';
        if (result.checked > 0 || watchdogResult.checked > 0) {
          fastify.log.info(`[BrokerReconciliation] checked=${result.checked} opened=${result.opened} closed=${result.closed} pending=${result.stillPending} unmatched=${result.unmatched} watchdogEntryStale=${watchdogResult.entryStale} watchdogExitStale=${watchdogResult.exitStale}`);
        }
      } catch (err: any) {
        snaptradePendingOrderSyncHealth.lastError = err.message;
        snaptradePendingOrderSyncHealth.status = 'ERROR';
        fastify.log.warn(`[SnapTradePendingSync] Failed: ${err.message}`);
      } finally {
        snaptradePendingOrderSyncHealth.running = false;
      }
    };

    const runQueuedBrokerSync = async () => {
      let processed = 0;
      for (let i = 0; i < 10; i += 1) {
        const queuedUserId = await TradeRedisService.popBrokerSyncRequest();
        if (!queuedUserId) break;
        try {
          await snaptradeOrderSync.syncPendingBrokerOrders(queuedUserId);
          processed += 1;
        } catch (err: any) {
          fastify.log.warn(`[BrokerSyncQueue] Failed queued sync for user ${queuedUserId}: ${err.message}`);
          if (!String(err.message || '').includes('already running')) {
            await TradeRedisService.requestBrokerSync(queuedUserId);
          }
        }
      }
      if (processed > 0) {
        snaptradePendingOrderSyncHealth.queuedSyncLastRunAt = new Date().toISOString();
        snaptradePendingOrderSyncHealth.queuedSyncProcessed += processed;
      }
    };

    // Broadcast real-time quotes to all connected frontend clients
    const handleStreamQuote = async (quote: any) => {
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

      // Feed data into the dedicated live exit monitor without waiting for the next poll cycle.
      await liveExitMonitor.handleQuote(quote);
    };

    thetaDataStreamer.on('quote', handleStreamQuote);
    alpacaMarketDataStreamer.on('quote', handleStreamQuote);

    fastify.get('/api/services/health', { preHandler: fastify.authenticate }, async (request) => {
      const { id: userId } = (request as any).user;
      const generatedAt = new Date().toISOString();
      const alpacaHealth = alpacaMarketDataStreamer.getHealth();
      const thetaDataHealth = thetaDataStreamer.getHealth();
      const thetaDataTerminalHealth = await thetaData.getHealth(userId).catch((err: any) => ({
        status: 'DOWN',
        connected: false,
        provider: 'thetadata',
        baseUrl: process.env.THETADATA_BASE_URL || 'http://127.0.0.1:25503',
        latencyMs: null,
        lastError: err.message || String(err)
      }));
      const liveExitHealth = liveExitMonitor.getHealth();
      const scannerHealth = await scanner.getRuntimeStatus();
      const tradeRedisHealth = await TradeRedisService.getHealth();
      const postgresStartedAt = Date.now();
      const postgresHealth = await fastify.pg.query('SELECT 1')
        .then(() => normalizeAdapterHealth('postgres', {
          status: 'UP',
          latencyMs: Date.now() - postgresStartedAt,
          lastError: null
        }, generatedAt))
        .catch((err: any) => normalizeAdapterHealth('postgres', {
          status: 'DOWN',
          latencyMs: Date.now() - postgresStartedAt,
          lastError: err.message || String(err)
        }, generatedAt));

      return {
        liveExitMonitor: normalizeAdapterHealth('liveExitMonitor', liveExitHealth, generatedAt),
        streams: {
          alpaca: normalizeAdapterHealth('alpaca', alpacaHealth, generatedAt),
          thetadata: normalizeAdapterHealth('thetadataStream', thetaDataHealth, generatedAt)
        },
        marketData: {
          thetadata: normalizeAdapterHealth('thetadata', thetaDataTerminalHealth, generatedAt)
        },
        poller: normalizeAdapterHealth('marketPoller', {
          status: poller.isRunning() ? 'UP' : 'DOWN',
          running: poller.isRunning()
        }, generatedAt),
        scanner: normalizeAdapterHealth('signalScanner', scannerHealth, generatedAt),
        snaptradePendingOrders: normalizeAdapterHealth('snaptradePendingOrders', snaptradePendingOrderSyncHealth, generatedAt),
        tradeRedis: normalizeAdapterHealth('tradeRedis', tradeRedisHealth, generatedAt),
        postgres: postgresHealth,
        generatedAt
      };
    });

    fastify.post('/api/services/dev/quote', { preHandler: fastify.authenticate }, async (request, reply) => {
      const devTestsEnabled = process.env.NODE_ENV !== 'production' || process.env.ENABLE_DEV_TRADING_TESTS === 'true';
      if (!devTestsEnabled) {
        return reply.code(404).send({ error: 'Dev trade testing is disabled' });
      }

      const { role } = (request as any).user;
      if (role !== 'ADMIN') {
        return reply.code(403).send({ error: 'Admin access required' });
      }

      const body = request.body as {
        provider?: string;
        symbol?: string;
        optionType?: 'CALL' | 'PUT';
        strike?: number | string;
        expiration?: string;
        bid?: number | string;
        ask?: number | string;
        last?: number | string;
        underlyingPrice?: number | string;
      };

      const symbol = String(body.symbol || '').trim().toUpperCase();
      const optionType = body.optionType;
      const strike = Number(body.strike);
      const expiration = String(body.expiration || '').trim();

      if (!symbol || !optionType || !Number.isFinite(strike) || !expiration) {
        return reply.code(400).send({ error: 'symbol, optionType, strike, and expiration are required' });
      }

      const dateParts = expiration.split('-');
      if (dateParts.length !== 3) {
        return reply.code(400).send({ error: 'expiration must use YYYY-MM-DD' });
      }

      const osiSymbol = `${symbol}${dateParts[0].slice(-2)}${dateParts[1].padStart(2, '0')}${dateParts[2].padStart(2, '0')}${optionType === 'CALL' ? 'C' : 'P'}${Math.round(strike * 1000).toString().padStart(8, '0')}`;
      const quote = {
        provider: body.provider || 'dev',
        symbol: osiSymbol,
        bidPrice: Number(body.bid || 0) || undefined,
        askPrice: Number(body.ask || 0) || undefined,
        lastTradePrice: Number(body.last || 0) || undefined,
        underlyingPrice: Number(body.underlyingPrice || 0) || undefined,
        injected: true
      };

      await liveExitMonitor.handleQuote(quote);
      return {
        status: 'ok',
        quote,
        health: liveExitMonitor.getHealth()
      };
    });

    const wsClients = new Map<any, string>();

    const getLegacyWsClientId = (req: any) => {
      const fingerprint = [
        req.ip || req.headers?.['x-forwarded-for'] || 'unknown',
        req.headers?.['user-agent'] || 'unknown',
        req.headers?.['accept-language'] || 'unknown'
      ].join('|');
      return `legacy-${crypto.createHash('sha1').update(fingerprint).digest('hex').slice(0, 10)}`;
    };

    const getActiveWsCountForClient = (clientId: string) => {
      let count = 0;
      for (const activeClientId of wsClients.values()) {
        if (activeClientId === clientId) count++;
      }
      return count;
    };

    // Public WebSocket endpoint
    // Note: @fastify/websocket v10+ passes the socket directly, not connection.socket
    fastify.get('/api/ws', { websocket: true }, (socket: any, req: any) => {
      if (!socket) {
        fastify.log.error('[WebSocket] Socket is null');
        return;
      }

      const query = req.query as { wsClientId?: string } | undefined;
      const hasBrowserClientId = Boolean(query?.wsClientId);
      const clientId = query?.wsClientId || getLegacyWsClientId(req);
      wsClients.set(socket, clientId);
      const activeForClient = getActiveWsCountForClient(clientId);

      fastify.log.info(
        `[WebSocket] Client connected id=${clientId} legacy=${!hasBrowserClientId} active=${wsClients.size} activeForClient=${activeForClient} remote=${req.ip || 'unknown'}`
      );

      socket.on('message', (message: any) => {
        try {
          const data = JSON.parse(message.toString());
          if (data && data.type === 'ping') {
            socket.send(JSON.stringify({ type: 'pong' }));
            return;
          }
          fastify.log.info(`[WebSocket] Received: ${JSON.stringify(data)}`);
        } catch (e) {
          // Non-JSON message, ignore
        }
      });

      socket.on('close', () => {
        wsClients.delete(socket);
        fastify.log.info(`[WebSocket] Client disconnected id=${clientId} active=${wsClients.size} activeForClient=${getActiveWsCountForClient(clientId)}`);
      });

      socket.on('error', (err: any) => {
        fastify.log.error(`[WebSocket] Client error id=${clientId}: ${err.message}`);
      });
    });

    const port = Number(process.env.PORT) || 3001;
    await fastify.listen({ port, host: '0.0.0.0' });

    const startBackgroundServices = async () => {
      fastify.log.info('[System] Starting background services...');
      poller.start();
      scanner.start();
      setInterval(runQueuedBrokerSync, 3000);
      setInterval(runSnaptradePendingOrderSync, Math.max(15, snaptradePendingOrderSyncHealth.intervalSeconds) * 1000);
      runSnaptradePendingOrderSync().catch((err: any) => {
        fastify.log.warn(`[SnapTradePendingSync] Initial run failed: ${err.message}`);
      });
      let liveExitStreamStarted = false;

      try {
        const thetaDataStreamStarted = await thetaDataStreamer.start();
        if (thetaDataStreamStarted) {
          liveExitMonitor.start('thetadata');
          fastify.log.info('[Stream] ThetaData option market data stream enabled for live exit monitoring.');
          liveExitStreamStarted = true;
        }
      } catch (err: any) {
        fastify.log.warn(`[Stream] ThetaData option market data stream failed to start: ${err.message}`);
      }

      if (!liveExitStreamStarted) {
        const alpacaStreamStarted = await alpacaMarketDataStreamer.start();
        if (alpacaStreamStarted) {
          liveExitMonitor.start('alpaca');
          fastify.log.info('[Stream] Alpaca option market data stream enabled for live exit monitoring.');
          liveExitStreamStarted = true;
        }
      }

      if (!liveExitStreamStarted) {
        fastify.log.warn('[Stream] No option market data stream started for live exit monitoring.');
      }
    };

    const backgroundStartDelayMs = Number(process.env.BACKGROUND_START_DELAY_MS || 15000);
    fastify.log.info(`[System] Background services scheduled in ${backgroundStartDelayMs}ms`);
    setTimeout(() => {
      startBackgroundServices().catch((err: any) => {
        fastify.log.error(`[System] Background services failed to start: ${err.message}`);
      });
    }, Math.max(0, backgroundStartDelayMs));

    fastify.log.info(`Server listening on http://localhost:${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
