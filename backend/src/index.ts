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
import { manualEntryRoutes } from './routes/manual-entry';
import { paperAccountRoutes } from './routes/paper-account';
import { wallReactionRoutes } from './routes/wall-reaction';
import { mcpRoutes } from './routes/mcp';
import jwt from '@fastify/jwt';
import authRoutes from './routes/auth';
import { adminRoutes } from './routes/admin';
import { snaptradeRoutes } from './routes/snaptrade';
import { FastifyRequest, FastifyReply } from 'fastify';
import { normalizeAdapterHealth } from './lib/adapter-health';
import { getIbkrGatewayConfig } from './lib/ibkr-config';

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

function constructOSITicker(symbol: string, strike: number, type: 'CALL' | 'PUT', expiration: string | Date): string {
  const dateStr = expiration instanceof Date ? expiration.toISOString().split('T')[0] : String(expiration).split('T')[0];
  const [year, month, day] = dateStr.split('-');
  const side = type === 'CALL' ? 'C' : 'P';
  return `${symbol.toUpperCase()}${year.slice(-2)}${month}${day}${side}${Math.round(strike * 1000).toString().padStart(8, '0')}`;
}

function streamQuotePayload(quote: any) {
  const bid = Number(quote.bidPrice ?? quote.bid ?? 0);
  const ask = Number(quote.askPrice ?? quote.ask ?? 0);
  const last = Number(quote.lastTradePrice ?? quote.last ?? quote.price ?? 0);
  const mid = bid > 0 && ask > 0 ? Number(((bid + ask) / 2).toFixed(2)) : 0;
  const mark = mid > 0 ? mid : last > 0 ? Number(last.toFixed(2)) : bid > 0 ? Number(bid.toFixed(2)) : ask > 0 ? Number(ask.toFixed(2)) : null;
  return {
    ticker: quote.symbol || null,
    bid: bid > 0 ? bid : null,
    ask: ask > 0 ? ask : null,
    last: last > 0 ? last : null,
    mark,
    spreadPct: bid > 0 && ask > 0 && mid > 0 ? Number((((ask - bid) / mid) * 100).toFixed(2)) : null,
    timestamp: new Date().toISOString()
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: () => T
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback()), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
      CREATE TABLE IF NOT EXISTS wall_reaction_candidates (
        id UUID PRIMARY KEY,
        symbol VARCHAR(10) NOT NULL,
        fingerprint VARCHAR(64) NOT NULL,
        decision_code VARCHAR(40) NOT NULL,
        status VARCHAR(20) NOT NULL,
        context JSONB NOT NULL,
        plan JSONB NOT NULL DEFAULT '{}'::jsonb,
        contract JSONB NOT NULL DEFAULT '{}'::jsonb,
        generated_at TIMESTAMPTZ NOT NULL,
        armed_at TIMESTAMPTZ,
        armed_until TIMESTAMPTZ,
        entered_at TIMESTAMPTZ,
        invalidated_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (symbol, fingerprint)
      );
    `);
    await instance.pg.query(`
      CREATE INDEX IF NOT EXISTS idx_wall_reaction_candidates_symbol_created
        ON wall_reaction_candidates (symbol, created_at DESC);
    `);

    const retiredCalendarSetting = await instance.pg.query(
      `DELETE FROM settings WHERE key = $1`,
      ['trading_economics_api_key']
    );
    if (retiredCalendarSetting.rowCount) {
      instance.log.info('[Database] Removed retired Trading Economics setting');
    }

    await instance.pg.query(`
      ALTER TABLE signals
        ADD COLUMN IF NOT EXISTS engine_version VARCHAR(50),
        ADD COLUMN IF NOT EXISTS strategy_name VARCHAR(50),
        ADD COLUMN IF NOT EXISTS strategy_setup_id UUID,
        ADD COLUMN IF NOT EXISTS lifecycle_status VARCHAR(30),
        ADD COLUMN IF NOT EXISTS entry_allowed BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS policy_fingerprint VARCHAR(64),
        ADD COLUMN IF NOT EXISTS strategy_snapshot JSONB;
    `);

    await instance.pg.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS signals_strategy_setup_id_idx
      ON signals(strategy_setup_id)
      WHERE strategy_setup_id IS NOT NULL;
    `);

    await instance.pg.query(`
      CREATE TABLE IF NOT EXISTS strategy_signal_events (
        id BIGSERIAL PRIMARY KEY,
        setup_id UUID,
        engine_version VARCHAR(50) NOT NULL,
        mode VARCHAR(20) NOT NULL,
        lifecycle_status VARCHAR(30) NOT NULL,
        event_fingerprint VARCHAR(64) NOT NULL UNIQUE,
        policy_fingerprint VARCHAR(64),
        signal_snapshot JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await instance.pg.query(`
      CREATE INDEX IF NOT EXISTS strategy_signal_events_setup_created_idx
      ON strategy_signal_events (setup_id, created_at ASC, id ASC);
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

    await instance.pg.query(`
      CREATE TABLE IF NOT EXISTS option_market_history (
        id BIGSERIAL PRIMARY KEY,
        provider VARCHAR(30) NOT NULL,
        osi_ticker VARCHAR(40) NOT NULL,
        underlying_symbol VARCHAR(20) NOT NULL,
        expiration DATE NOT NULL,
        option_type VARCHAR(4) NOT NULL,
        strike NUMERIC(12, 4) NOT NULL,
        quote_time TIMESTAMPTZ NOT NULL,
        bid NUMERIC(12, 4),
        ask NUMERIC(12, 4),
        last NUMERIC(12, 4),
        mark NUMERIC(12, 4) NOT NULL,
        volume BIGINT,
        open_interest BIGINT,
        iv NUMERIC(12, 6),
        delta NUMERIC(12, 6),
        gamma NUMERIC(12, 6),
        theta NUMERIC(12, 6),
        vega NUMERIC(12, 6),
        underlying_price NUMERIC(12, 4),
        raw_data JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await instance.pg.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_option_market_history_quote
        ON option_market_history (osi_ticker, quote_time, provider);
    `);
    await instance.pg.query(`ALTER TABLE option_market_history ADD COLUMN IF NOT EXISTS underlying_price NUMERIC(12, 4);`);
    await instance.pg.query(`
      CREATE INDEX IF NOT EXISTS idx_option_market_history_lookup
        ON option_market_history (osi_ticker, quote_time DESC);
    `);
    await instance.pg.query(`
      CREATE TABLE IF NOT EXISTS execution_telemetry (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER,
        signal_id INTEGER,
        position_id INTEGER,
        event_type VARCHAR(80) NOT NULL,
        broker VARCHAR(50),
        order_id VARCHAR(255),
        ticker VARCHAR(50),
        bid NUMERIC(12, 4),
        ask NUMERIC(12, 4),
        mark NUMERIC(12, 4),
        intended_price NUMERIC(12, 4),
        fill_price NUMERIC(12, 4),
        slippage_pct NUMERIC(12, 4),
        latency_ms INTEGER,
        metadata JSONB,
        occurred_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await instance.pg.query(`
      CREATE INDEX IF NOT EXISTS idx_execution_telemetry_signal
        ON execution_telemetry (signal_id, occurred_at DESC);
    `);

    await instance.pg.query(`
      CREATE TABLE IF NOT EXISTS paper_accounts (
        id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        currency VARCHAR(10) NOT NULL DEFAULT 'USD',
        initial_equity NUMERIC(16, 2) NOT NULL,
        cash_balance NUMERIC(16, 2) NOT NULL,
        reserved_cash NUMERIC(16, 2) NOT NULL DEFAULT 0,
        equity NUMERIC(16, 2) NOT NULL,
        high_water_mark NUMERIC(16, 2) NOT NULL,
        start_of_day_equity NUMERIC(16, 2) NOT NULL,
        start_of_day_date DATE NOT NULL,
        automation_status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await instance.pg.query(`
      INSERT INTO paper_accounts (
        id, name, initial_equity, cash_balance, equity, high_water_mark,
        start_of_day_equity, start_of_day_date
      ) VALUES ('shared-paper', 'Shared Paper Trading Account', 100000, 100000, 100000, 100000, 100000,
                (NOW() AT TIME ZONE 'America/New_York')::date)
      ON CONFLICT (id) DO NOTHING;
    `);
    await instance.pg.query(`
      CREATE TABLE IF NOT EXISTS paper_strategy_controls (
        strategy_name VARCHAR(50) PRIMARY KEY,
        automation_status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await instance.pg.query(`INSERT INTO paper_strategy_controls (strategy_name) VALUES ('DAY_TRADING'), ('WALL_REACTION') ON CONFLICT (strategy_name) DO NOTHING;`);
    await instance.pg.query(`
      CREATE TABLE IF NOT EXISTS paper_trade_decisions (
        id BIGSERIAL PRIMARY KEY,
        account_id VARCHAR(50) NOT NULL REFERENCES paper_accounts(id),
        setup_id UUID NOT NULL,
        signal_id INTEGER,
        decision VARCHAR(20) NOT NULL,
        risk_tier VARCHAR(20) NOT NULL,
        exit_profile VARCHAR(30) NOT NULL,
        source VARCHAR(20) NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 0,
        max_quantity INTEGER NOT NULL DEFAULT 0,
        debit_budget NUMERIC(16, 2) NOT NULL DEFAULT 0,
        protected_limit NUMERIC(12, 4),
        model VARCHAR(160),
        prompt_version VARCHAR(50) NOT NULL,
        policy_version VARCHAR(50) NOT NULL DEFAULT 'paper-exit-v2',
        trailing_stop_pct NUMERIC(6, 2) NOT NULL DEFAULT 15,
        ai_requested BOOLEAN NOT NULL DEFAULT FALSE,
        ai_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        rationale TEXT,
        risk_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
        evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (account_id, setup_id)
      );
    `);
    await instance.pg.query(`ALTER TABLE paper_trade_decisions ADD COLUMN IF NOT EXISTS ai_requested BOOLEAN NOT NULL DEFAULT FALSE;`);
    await instance.pg.query(`ALTER TABLE paper_trade_decisions ADD COLUMN IF NOT EXISTS ai_reasons JSONB NOT NULL DEFAULT '[]'::jsonb;`);
    await instance.pg.query(`ALTER TABLE paper_trade_decisions ADD COLUMN IF NOT EXISTS prompt_tokens INTEGER NOT NULL DEFAULT 0;`);
    await instance.pg.query(`ALTER TABLE paper_trade_decisions ADD COLUMN IF NOT EXISTS completion_tokens INTEGER NOT NULL DEFAULT 0;`);
    await instance.pg.query(`ALTER TABLE paper_trade_decisions ADD COLUMN IF NOT EXISTS total_tokens INTEGER NOT NULL DEFAULT 0;`);
    await instance.pg.query(`ALTER TABLE paper_trade_decisions ADD COLUMN IF NOT EXISTS policy_version VARCHAR(50) NOT NULL DEFAULT 'paper-exit-v1-legacy';`);
    await instance.pg.query(`ALTER TABLE paper_trade_decisions ALTER COLUMN policy_version SET DEFAULT 'paper-exit-v2';`);
    await instance.pg.query(`ALTER TABLE paper_trade_decisions ADD COLUMN IF NOT EXISTS trailing_stop_pct NUMERIC(6, 2) NOT NULL DEFAULT 15;`);
    await instance.pg.query(`ALTER TABLE paper_trade_decisions ADD COLUMN IF NOT EXISTS strategy_name VARCHAR(50) NOT NULL DEFAULT 'DAY_TRADING';`);
    await instance.pg.query(`
      CREATE TABLE IF NOT EXISTS paper_orders (
        id BIGSERIAL PRIMARY KEY,
        account_id VARCHAR(50) NOT NULL REFERENCES paper_accounts(id),
        decision_id BIGINT REFERENCES paper_trade_decisions(id),
        position_id INTEGER,
        setup_id UUID NOT NULL,
        signal_id INTEGER,
        intent VARCHAR(30) NOT NULL,
        action VARCHAR(20) NOT NULL,
        status VARCHAR(20) NOT NULL,
        osi_ticker VARCHAR(50) NOT NULL,
        option_type VARCHAR(4) NOT NULL,
        strike NUMERIC(12, 4) NOT NULL,
        expiration DATE NOT NULL,
        quantity INTEGER NOT NULL,
        limit_price NUMERIC(12, 4),
        fill_price NUMERIC(12, 4),
        reserved_debit NUMERIC(16, 2) NOT NULL DEFAULT 0,
        quote_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
        failure_reason TEXT,
        expires_at TIMESTAMPTZ,
        filled_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (account_id, setup_id, intent)
      );
    `);
    await instance.pg.query(`
      CREATE TABLE IF NOT EXISTS paper_equity_snapshots (
        id BIGSERIAL PRIMARY KEY,
        account_id VARCHAR(50) NOT NULL REFERENCES paper_accounts(id),
        equity NUMERIC(16, 2) NOT NULL,
        cash_balance NUMERIC(16, 2) NOT NULL,
        reserved_cash NUMERIC(16, 2) NOT NULL,
        realized_pnl NUMERIC(16, 2) NOT NULL,
        unrealized_pnl NUMERIC(16, 2) NOT NULL,
        captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await instance.pg.query(`
      CREATE INDEX IF NOT EXISTS idx_paper_equity_account_time
        ON paper_equity_snapshots (account_id, captured_at DESC);
    `);
    await instance.pg.query(`
      CREATE TABLE IF NOT EXISTS paper_monthly_reports (
        id BIGSERIAL PRIMARY KEY,
        account_id VARCHAR(50) NOT NULL REFERENCES paper_accounts(id),
        month VARCHAR(7) NOT NULL,
        report JSONB NOT NULL,
        generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        discord_sent_at TIMESTAMPTZ,
        UNIQUE (account_id, month)
      );
    `);
    await instance.pg.query(`
      CREATE TABLE IF NOT EXISTS paper_trade_journal (
        id BIGSERIAL PRIMARY KEY,
        account_id VARCHAR(50) NOT NULL REFERENCES paper_accounts(id),
        setup_id UUID,
        decision_id BIGINT REFERENCES paper_trade_decisions(id),
        position_id INTEGER,
        event_type VARCHAR(50) NOT NULL,
        policy_version VARCHAR(50) NOT NULL,
        message TEXT NOT NULL,
        premium NUMERIC(12, 4),
        underlying_price NUMERIC(12, 4),
        quantity INTEGER,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await instance.pg.query(`
      CREATE TABLE IF NOT EXISTS paper_baseline_trades (
        id BIGSERIAL PRIMARY KEY,
        account_id VARCHAR(50) NOT NULL REFERENCES paper_accounts(id),
        decision_id BIGINT NOT NULL REFERENCES paper_trade_decisions(id),
        setup_id UUID NOT NULL,
        position_id INTEGER,
        quantity INTEGER NOT NULL DEFAULT 1,
        status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
        entry_price NUMERIC(12, 4) NOT NULL,
        current_price NUMERIC(12, 4) NOT NULL,
        exit_price NUMERIC(12, 4),
        realized_pnl NUMERIC(16, 2) NOT NULL DEFAULT 0,
        exit_reason VARCHAR(50),
        policy_version VARCHAR(50) NOT NULL,
        trailing_stop_pct NUMERIC(6, 2) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        closed_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (account_id, decision_id)
      );
    `);
    await instance.pg.query(`
      CREATE INDEX IF NOT EXISTS idx_paper_orders_account_status
        ON paper_orders (account_id, status, created_at DESC);
    `);
    await instance.pg.query(`
      CREATE INDEX IF NOT EXISTS idx_paper_decisions_account_created
        ON paper_trade_decisions (account_id, created_at DESC);
    `);
    await instance.pg.query(`CREATE INDEX IF NOT EXISTS idx_paper_journal_account_created ON paper_trade_journal (account_id, created_at DESC);`);
    await instance.pg.query(`CREATE INDEX IF NOT EXISTS idx_paper_baseline_account_status ON paper_baseline_trades (account_id, status, created_at DESC);`);
    await instance.pg.query(`ALTER TABLE paper_orders ADD COLUMN IF NOT EXISTS strategy_name VARCHAR(50) NOT NULL DEFAULT 'DAY_TRADING';`);
    await instance.pg.query(`ALTER TABLE paper_trade_journal ADD COLUMN IF NOT EXISTS strategy_name VARCHAR(50) NOT NULL DEFAULT 'DAY_TRADING';`);

    // 3. Ensure all extra columns are added to positions table
    const columns = [
      { name: 'delta', type: 'DECIMAL(10, 4)' },
      { name: 'theta', type: 'DECIMAL(10, 4)' },
      { name: 'gamma', type: 'DECIMAL(10, 4)' },
      { name: 'vega', type: 'DECIMAL(10, 4)' },
      { name: 'iv', type: 'DECIMAL(10, 4)' },
      { name: 'underlying_price', type: 'DECIMAL(10, 2)' },
      { name: 'underlying_stop_price', type: 'DECIMAL(10, 2)' },
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
      { name: 'entry_action', type: "VARCHAR(20) DEFAULT 'BUY_TO_OPEN'" },
      { name: 'exit_action', type: "VARCHAR(20) DEFAULT 'SELL_TO_CLOSE'" },
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
      { name: 'last_broker_order_status', type: 'VARCHAR(50)' },
      { name: 'max_favorable_price', type: 'DECIMAL(10, 4)' },
      { name: 'max_adverse_price', type: 'DECIMAL(10, 4)' },
      { name: 'mfe_pct', type: 'DECIMAL(10, 4)' },
      { name: 'mae_pct', type: 'DECIMAL(10, 4)' },
      { name: 'signal_id', type: 'INTEGER' },
      { name: 'strategy_setup_id', type: 'UUID' },
      { name: 'strategy_engine_version', type: 'VARCHAR(50)' },
      { name: 'strategy_lifecycle_status', type: 'VARCHAR(50)' },
      { name: 'strategy_policy_fingerprint', type: 'VARCHAR(128)' },
      { name: 'strategy_snapshot', type: 'JSONB' },
      { name: 'strategy_managed', type: 'BOOLEAN DEFAULT FALSE' },
      { name: 'strategy_exit_requested_at', type: 'TIMESTAMPTZ' },
      { name: 'strategy_exit_reason', type: 'VARCHAR(50)' },
      { name: 'paper_account_id', type: 'VARCHAR(50)' },
      { name: 'paper_decision_id', type: 'BIGINT' },
      { name: 'paper_strategy', type: 'VARCHAR(50)' }
    ];

    for (const col of columns) {
      await instance.pg.query(`
        ALTER TABLE positions ADD COLUMN IF NOT EXISTS ${col.name} ${col.type};
      `);
    }

    await instance.pg.query(`
      CREATE INDEX IF NOT EXISTS idx_positions_paper_account_status
        ON positions (paper_account_id, status, created_at DESC);
    `);

    await instance.pg.query(`
      CREATE TABLE IF NOT EXISTS paper_ledger_migrations (
        migration_key VARCHAR(100) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    const ledgerClient = await instance.pg.connect();
    try {
      await ledgerClient.query('BEGIN');
      const legacy = await ledgerClient.query(
        `SELECT id FROM paper_accounts WHERE id IN ('strategy-system', 'wall-reaction-system') FOR UPDATE`
      );
      if (legacy.rows.length) {
        const applied = await ledgerClient.query(
          `INSERT INTO paper_ledger_migrations (migration_key) VALUES ('shared-paper-account-v1') ON CONFLICT DO NOTHING RETURNING migration_key`
        );
        if (applied.rows[0]) {
          await ledgerClient.query(`
            UPDATE positions
               SET paper_strategy = CASE WHEN paper_account_id='wall-reaction-system' OR execution_broker='wall_reaction_paper'
                 THEN 'WALL_REACTION' ELSE 'DAY_TRADING' END
             WHERE paper_account_id IN ('strategy-system', 'wall-reaction-system')
          `);
          await ledgerClient.query(`UPDATE paper_trade_decisions SET strategy_name = CASE WHEN account_id='wall-reaction-system' THEN 'WALL_REACTION' ELSE 'DAY_TRADING' END WHERE account_id IN ('strategy-system', 'wall-reaction-system')`);
          await ledgerClient.query(`UPDATE paper_orders SET strategy_name = CASE WHEN account_id='wall-reaction-system' THEN 'WALL_REACTION' ELSE 'DAY_TRADING' END WHERE account_id IN ('strategy-system', 'wall-reaction-system')`);
          await ledgerClient.query(`UPDATE paper_trade_journal SET strategy_name = CASE WHEN account_id='wall-reaction-system' THEN 'WALL_REACTION' ELSE 'DAY_TRADING' END WHERE account_id IN ('strategy-system', 'wall-reaction-system')`);
          await ledgerClient.query(`
            DELETE FROM paper_monthly_reports legacy
             USING paper_monthly_reports shared
             WHERE legacy.account_id='wall-reaction-system'
               AND shared.account_id='shared-paper'
               AND legacy.month=shared.month
          `);
          for (const table of ['paper_trade_decisions', 'paper_orders', 'paper_equity_snapshots', 'paper_monthly_reports', 'paper_trade_journal', 'paper_baseline_trades', 'positions']) {
            const column = table === 'positions' ? 'paper_account_id' : 'account_id';
            await ledgerClient.query(`UPDATE ${table} SET ${column}='shared-paper' WHERE ${column} IN ('strategy-system', 'wall-reaction-system')`);
          }
          const totals = await ledgerClient.query(`
            SELECT
              COALESCE(SUM(realized_pnl),0)::numeric AS realized_pnl,
              COALESCE(SUM(entry_price*quantity*100) FILTER (WHERE status='OPEN'),0)::numeric AS open_cost,
              COALESCE(SUM(current_price*quantity*100) FILTER (WHERE status='OPEN'),0)::numeric AS market_value
            FROM positions WHERE paper_account_id='shared-paper'
          `);
          const pending = await ledgerClient.query(`
            SELECT COALESCE(SUM(reserved_debit),0)::numeric AS reserved_cash
              FROM paper_orders
             WHERE account_id='shared-paper' AND intent='ENTRY' AND status='PENDING'
          `);
          const cash = 100000 + Number(totals.rows[0]?.realized_pnl || 0) - Number(totals.rows[0]?.open_cost || 0);
          const equity = cash + Number(totals.rows[0]?.market_value || 0);
          await ledgerClient.query(`
            UPDATE paper_accounts
               SET name='Shared Paper Trading Account', initial_equity=100000,
                   cash_balance=$1, reserved_cash=$2, equity=$3,
                   high_water_mark=GREATEST(100000,$3), start_of_day_equity=$3,
                   start_of_day_date=(NOW() AT TIME ZONE 'America/New_York')::date,
                   automation_status='ACTIVE', updated_at=NOW()
             WHERE id='shared-paper'
          `, [cash, Number(pending.rows[0]?.reserved_cash || 0), equity]);
          await ledgerClient.query(`DELETE FROM paper_accounts WHERE id IN ('strategy-system', 'wall-reaction-system')`);
      }
      }
      await ledgerClient.query('COMMIT');
    } catch (error) {
      await ledgerClient.query('ROLLBACK');
      throw error;
    } finally {
      ledgerClient.release();
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
        DROP INDEX IF EXISTS uniq_active_contract_per_user;
        CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_contract_per_user_mode
          ON positions (user_id, symbol, option_type, strike_price, expiration_date, (COALESCE(is_simulated, FALSE)))
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

    const dbQueryTimeoutMs = Number(process.env.DB_QUERY_TIMEOUT_MS || 5000);
    await fastify.register(postgres, {
      connectionString: activeDbUrl,
      ssl: activeDbUrl.includes('aivencloud') ? { rejectUnauthorized: false } : undefined,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 5000),
      query_timeout: dbQueryTimeoutMs,
      statement_timeout: dbQueryTimeoutMs,
      idle_in_transaction_session_timeout: Number(process.env.DB_IDLE_TRANSACTION_TIMEOUT_MS || 10000)
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
          title: 'StrikePilot API',
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
    fastify.register(manualEntryRoutes, { prefix: '/api/manual-entry' });
    fastify.register(mcpRoutes);

    fastify.get('/health', async () => {
      return { status: 'ok' };
    });

    // Root route
    fastify.get('/', async () => {
      return { message: 'StrikePilot — Guarded Options Intelligence API' };
    });

    const { IbkrMarketDataService } = await import('./services/ibkr-market-data-service');
    const ibkrMarketData = new IbkrMarketDataService(fastify);
    fastify.decorate('ibkrMarketData', ibkrMarketData);

    const { WallReactionService } = await import('./services/wall-reaction-service');
    const wallReaction = new WallReactionService(fastify);
    fastify.decorate('wallReaction', wallReaction);
    fastify.addHook('onClose', async () => wallReaction.stop());
    fastify.register(wallReactionRoutes, { prefix: '/api/wall-reaction' });

    const { WallReactionPaperService } = await import('./services/wall-reaction-paper-service');
    const wallReactionPaper = new WallReactionPaperService(fastify);
    fastify.decorate('wallReactionPaper', wallReactionPaper);
    fastify.addHook('onClose', async () => wallReactionPaper.stop());

    // Initialize poller BEFORE listen
    const { MarketPoller } = await import('./services/market-poller');
    const poller = new MarketPoller(fastify);
    fastify.decorate('poller', poller);

    const { SignalScannerService } = await import('./services/signal-scanner-service');
    const scanner = new SignalScannerService(fastify);
    fastify.decorate('scanner', scanner);

    const { StrategyEngineAdapter } = await import('./services/strategy-engine-adapter');
    const { PaperTradingService } = await import('./services/paper-trading-service');
    const paperTrading = new PaperTradingService(fastify);
    fastify.decorate('paperTrading', paperTrading);
    fastify.addHook('onClose', async () => paperTrading.stop());
    const strategyEngine = new StrategyEngineAdapter(fastify);
    fastify.decorate('strategyEngine', strategyEngine);

    fastify.register(paperAccountRoutes, { prefix: '/api/paper-account' });

    // --- WebSocket & Streaming Setup ---
    await fastify.register(import('@fastify/websocket'));
    const { redis } = await import('./lib/redis');

    const { IbkrMarketDataStreamService } = await import('./services/ibkr-market-data-stream-service');
    const ibkrMarketDataStreamer = new IbkrMarketDataStreamService(fastify);
    fastify.decorate('ibkrMarketDataStreamer', ibkrMarketDataStreamer);

    const { LiveExitMonitorService } = await import('./services/live-exit-monitor-service');
    const liveExitMonitor = new LiveExitMonitorService(fastify);
    fastify.decorate('liveExitMonitor', liveExitMonitor);

    const { OptionMarketHistoryCaptureService } = await import('./services/option-market-history-capture-service');
    const optionMarketHistoryCapture = new OptionMarketHistoryCaptureService(fastify);
    fastify.decorate('optionMarketHistoryCapture', optionMarketHistoryCapture);

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

    const manualQuoteSubscriptions = new Map<any, Set<string>>();
    const manualQuoteSubscriptionKeys = new Map<any, Map<string, string>>();

    const removeManualQuoteSubscriptions = (socket: any) => {
      const keys = manualQuoteSubscriptionKeys.get(socket);
      if (keys) {
        for (const key of keys.values()) {
          ibkrMarketDataStreamer.removeTemporarySubscription(key);
        }
      }
      manualQuoteSubscriptionKeys.delete(socket);
      manualQuoteSubscriptions.delete(socket);
    };

    const subscribeManualQuote = async (socket: any, clientId: string, payload: any) => {
      const symbol = String(payload?.symbol || '').trim().toUpperCase();
      const optionType = payload?.optionType === 'PUT' ? 'PUT' : 'CALL';
      const strike = Number(payload?.strike);
      const expiration = String(payload?.expiration || '').trim();
      if (!symbol || !Number.isFinite(strike) || strike <= 0 || !expiration) {
        socket.send(JSON.stringify({ type: 'MANUAL_ENTRY_QUOTE_ERROR', error: 'symbol, optionType, strike, and expiration are required' }));
        return;
      }

      removeManualQuoteSubscriptions(socket);
      const ticker = constructOSITicker(symbol, strike, optionType, expiration);
      const subscriptionKey = `manual-entry:${clientId}:${ticker}:${Date.now()}`;
      manualQuoteSubscriptions.set(socket, new Set([ticker]));
      manualQuoteSubscriptionKeys.set(socket, new Map([[ticker, subscriptionKey]]));
      await ibkrMarketDataStreamer.addTemporarySubscription(subscriptionKey, { symbol, strike, optionType, expiration });
      socket.send(JSON.stringify({ type: 'MANUAL_ENTRY_QUOTE_SUBSCRIBED', data: { ticker, symbol, optionType, strike, expiration } }));
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

      if (quote.symbol) {
        const payload = streamQuotePayload(quote);
        for (const [client, subscriptions] of manualQuoteSubscriptions.entries()) {
          if (client.readyState === 1 && subscriptions.has(quote.symbol)) {
            client.send(JSON.stringify({ type: 'MANUAL_ENTRY_QUOTE_UPDATE', data: payload }));
          }
        }
      }

      // Feed data into the dedicated live exit monitor without waiting for the next poll cycle.
      optionMarketHistoryCapture.handleQuote(quote);
      await liveExitMonitor.handleQuote(quote);
    };

    ibkrMarketDataStreamer.on('quote', handleStreamQuote);

    fastify.get('/api/services/health', { preHandler: fastify.authenticate }, async (request) => {
      const { id: userId } = (request as any).user;
      const generatedAt = new Date().toISOString();
      const resolvedIbkrConfig = await getIbkrGatewayConfig((fastify as any).pg).catch(() => ({
        mode: String(process.env.IBKR_GATEWAY_MODE || '').toLowerCase() === 'paper' ? 'paper' : 'live',
        host: process.env.IBKR_HOST || 'ib_gateway',
        port: Number(process.env.IBKR_PORT || 4003)
      }));
      const ibkrStreamHealth = ibkrMarketDataStreamer.getHealth();
      const liveExitHealth = liveExitMonitor.getHealth();
      const optionHistoryHealth = optionMarketHistoryCapture.getHealth();
      const strategyHealth = strategyEngine.getCurrentState();
      const strategyProviderAgeSeconds = strategyHealth.health?.updated_at
        ? Math.max(0, Date.now() / 1000 - Number(strategyHealth.health.updated_at))
        : null;
      const strategyFresh = strategyHealth.ageSeconds !== null
        && strategyHealth.ageSeconds <= 5
        && strategyProviderAgeSeconds !== null
        && strategyProviderAgeSeconds <= 5;
      const strategyConnected = strategyHealth.health?.connected === true;
      const postgresStartedAt = Date.now();
      const [ibkrHealth, scannerHealth, tradeRedisHealth, postgresHealth] = await Promise.all([
        withTimeout(
          ibkrMarketData.getHealth().catch((err: any) => ({
            status: 'DOWN',
            connected: false,
            provider: 'ibkr',
            mode: resolvedIbkrConfig.mode,
            host: resolvedIbkrConfig.host,
            port: resolvedIbkrConfig.port,
            latencyMs: null,
            lastError: err.message || String(err)
          })),
          3000,
          () => ({
            status: 'DOWN',
            connected: false,
            provider: 'ibkr',
            mode: resolvedIbkrConfig.mode,
            host: resolvedIbkrConfig.host,
            port: resolvedIbkrConfig.port,
            latencyMs: null,
            lastError: 'IBKR health check timed out'
          })
        ),
        withTimeout(
          scanner.getRuntimeStatus(),
          1500,
          () => ({
            status: 'DEGRADED',
            enabled: false,
            marketOpen: false,
            error: 'Scanner health check timed out'
          })
        ),
        withTimeout(
          TradeRedisService.getHealth(),
          1500,
          () => ({
            status: 'DEGRADED',
            connected: false,
            queueDepth: null,
            metrics: {},
            lastError: 'Redis health check timed out'
          })
        ),
        withTimeout(
          fastify.pg.query('SELECT 1')
            .then(() => normalizeAdapterHealth('postgres', {
              status: 'UP',
              latencyMs: Date.now() - postgresStartedAt,
              lastError: null
            }, generatedAt))
            .catch((err: any) => normalizeAdapterHealth('postgres', {
              status: 'DOWN',
              latencyMs: Date.now() - postgresStartedAt,
              lastError: err.message || String(err)
            }, generatedAt)),
          1500,
          () => normalizeAdapterHealth('postgres', {
            status: 'DOWN',
            latencyMs: Date.now() - postgresStartedAt,
            lastError: 'Postgres health check timed out'
          }, generatedAt)
        )
      ]);

      return {
        liveExitMonitor: normalizeAdapterHealth('liveExitMonitor', liveExitHealth, generatedAt),
        optionHistoryCapture: normalizeAdapterHealth('optionHistoryCapture', optionHistoryHealth, generatedAt),
        streams: {
          ibkr: normalizeAdapterHealth('ibkrStream', ibkrStreamHealth, generatedAt)
        },
        marketData: {
          ibkr: normalizeAdapterHealth('ibkr', ibkrHealth, generatedAt)
        },
        poller: normalizeAdapterHealth('marketPoller', {
          status: poller.isRunning() ? 'UP' : 'DOWN',
          running: poller.isRunning()
        }, generatedAt),
        marketDataBuffer: normalizeAdapterHealth('marketDataBuffer', poller.getMarketDataBufferHealth(), generatedAt),
        scanner: normalizeAdapterHealth('signalScanner', scannerHealth, generatedAt),
        strategyEngine: normalizeAdapterHealth('strategyEngine', {
          status: strategyHealth.error
            ? 'DOWN'
            : strategyHealth.signal && strategyFresh && strategyConnected && strategyHealth.health?.status !== 'error'
              ? 'UP'
              : strategyHealth.signal
                ? 'DEGRADED'
                : strategyHealth.mode === 'legacy'
                  ? 'DISABLED'
                  : 'STARTING',
          mode: strategyHealth.mode,
          connected: strategyConnected,
          freshnessMs: strategyHealth.ageSeconds == null ? null : Math.round(strategyHealth.ageSeconds * 1000),
          providerFreshnessMs: strategyProviderAgeSeconds == null ? null : Math.round(strategyProviderAgeSeconds * 1000),
          lastSeen: strategyHealth.receivedAt,
          lastError: strategyHealth.error || strategyHealth.health?.error || strategyHealth.health?.last_error || null,
          transport: strategyHealth.transport
        }, generatedAt),
        paperTrading: normalizeAdapterHealth('paperTrading', paperTrading.getHealth(), generatedAt),
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
    const wsUserIds = new Map<any, number>();

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
          if (data && data.type === 'auth') {
            try {
              const verified = fastify.jwt.verify(data.token || '') as any;
              const verifiedUserId = Number(verified?.id);
              if (Number.isFinite(verifiedUserId) && verifiedUserId > 0) {
                wsUserIds.set(socket, verifiedUserId);
                socket.send(JSON.stringify({ type: 'auth_ok' }));
                return;
              }
            } catch {
              // Fall through to auth error.
            }
            socket.send(JSON.stringify({ type: 'auth_error' }));
            return;
          }
          if (data && data.type === 'MANUAL_ENTRY_SUBSCRIBE_QUOTE') {
            if (!wsUserIds.has(socket)) {
              socket.send(JSON.stringify({ type: 'MANUAL_ENTRY_QUOTE_ERROR', error: 'Authentication is required for manual quote streaming' }));
              return;
            }
            subscribeManualQuote(socket, clientId, data.data).catch((err: any) => {
              fastify.log.warn(`[WebSocket] Manual quote subscribe failed id=${clientId}: ${err.message}`);
              socket.send(JSON.stringify({ type: 'MANUAL_ENTRY_QUOTE_ERROR', error: err.message || 'Manual quote subscribe failed' }));
            });
            return;
          }
          if (data && data.type === 'MANUAL_ENTRY_UNSUBSCRIBE_QUOTE') {
            removeManualQuoteSubscriptions(socket);
            socket.send(JSON.stringify({ type: 'MANUAL_ENTRY_QUOTE_UNSUBSCRIBED' }));
            return;
          }
          fastify.log.info(`[WebSocket] Received: ${JSON.stringify(data)}`);
        } catch (e) {
          // Non-JSON message, ignore
        }
      });

      socket.on('close', () => {
        removeManualQuoteSubscriptions(socket);
        wsClients.delete(socket);
        wsUserIds.delete(socket);
        fastify.log.info(`[WebSocket] Client disconnected id=${clientId} active=${wsClients.size} activeForClient=${getActiveWsCountForClient(clientId)}`);
      });

      socket.on('error', (err: any) => {
        fastify.log.error(`[WebSocket] Client error id=${clientId}: ${err.message}`);
      });
    });

    const port = Number(process.env.PORT) || 3001;
    // Publish the settings-derived IBKR policy before the strategy container is
    // allowed to start, so it never opens a session against stale defaults.
    await strategyEngine.start();
    paperTrading.start();
    await fastify.listen({ port, host: '0.0.0.0' });

    const startBackgroundServices = async () => {
      fastify.log.info('[System] Starting background services...');
      poller.start();
      wallReaction.start();
      wallReactionPaper.start();
      if (strategyEngine.getMode() !== 'primary') {
        scanner.start();
      } else {
        fastify.log.info('[SignalScannerService] Legacy scanner disabled because signal-only-v2 is primary.');
      }
      setInterval(runQueuedBrokerSync, 3000);
      setInterval(runSnaptradePendingOrderSync, Math.max(15, snaptradePendingOrderSyncHealth.intervalSeconds) * 1000);
      runSnaptradePendingOrderSync().catch((err: any) => {
        fastify.log.warn(`[SnapTradePendingSync] Initial run failed: ${err.message}`);
      });
      // Keep the monitor attached while the IBKR stream performs its own
      // reconnect loop. A failed first connection must not leave it inactive.
      liveExitMonitor.start('ibkr');

      try {
        const ibkrStreamStarted = await ibkrMarketDataStreamer.start();
        if (ibkrStreamStarted) {
          fastify.log.info('[Stream] IBKR option market data stream enabled for live exit monitoring.');
        }
        await optionMarketHistoryCapture.rehydrateRecentSignals?.();
      } catch (err: any) {
        fastify.log.warn(`[Stream] IBKR option market data stream failed to start: ${err.message}`);
      }

      if (!ibkrMarketDataStreamer.getHealth().connected) {
        fastify.log.warn('[Stream] IBKR quote stream is reconnecting; live exit monitor remains attached.');
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
