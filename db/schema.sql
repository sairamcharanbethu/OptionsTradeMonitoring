-- Users Table
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) DEFAULT 'USER',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Positions Table
CREATE TABLE IF NOT EXISTS positions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    symbol VARCHAR(20) NOT NULL,
    option_type VARCHAR(10) NOT NULL, -- CALL, PUT
    strike_price DECIMAL(10, 2) NOT NULL,
    expiration_date DATE NOT NULL,
    entry_price DECIMAL(10, 2) NOT NULL,
    quantity INTEGER NOT NULL,
    stop_loss_trigger DECIMAL(10, 2),
    take_profit_trigger DECIMAL(10, 2),
    trailing_high_price DECIMAL(10, 2),
    trailing_stop_loss_pct DECIMAL(5, 2),
    delta DECIMAL(10, 4),
    theta DECIMAL(10, 4),
    gamma DECIMAL(10, 4),
    vega DECIMAL(10, 4),
    iv DECIMAL(10, 4),
    realized_pnl DECIMAL(10, 2),
    loss_avoided DECIMAL(10, 2),
    exit_price DECIMAL(10, 2),
    current_price DECIMAL(10, 2),
    underlying_price DECIMAL(10, 2),
    underlying_stop_price DECIMAL(10, 2),
    analyzed_support DECIMAL(10, 2),
    analyzed_resistance DECIMAL(10, 2),
    suggested_stop_loss DECIMAL(10, 2),
    suggested_take_profit_1 DECIMAL(10, 2),
    suggested_take_profit_2 DECIMAL(10, 2),
    analysis_data JSONB,
    signal_id INTEGER,
    strategy_setup_id UUID,
    strategy_engine_version VARCHAR(50),
    strategy_lifecycle_status VARCHAR(50),
    strategy_policy_fingerprint VARCHAR(128),
    strategy_snapshot JSONB,
    strategy_managed BOOLEAN DEFAULT FALSE,
    strategy_exit_requested_at TIMESTAMP WITH TIME ZONE,
    strategy_exit_reason VARCHAR(50),
    paper_account_id VARCHAR(50),
    paper_decision_id BIGINT,
    paper_strategy VARCHAR(50),
    is_simulated BOOLEAN DEFAULT FALSE,
    account_id VARCHAR(255),
    notes TEXT,
    execution_broker VARCHAR(50),
    broker_order_id VARCHAR(255),
    broker_trade_id VARCHAR(255),
    broker_exit_order_id VARCHAR(255),
    broker_exit_trade_id VARCHAR(255),
    execution_account_id VARCHAR(255),
    entry_action VARCHAR(20) DEFAULT 'BUY_TO_OPEN',
    exit_action VARCHAR(20) DEFAULT 'SELL_TO_CLOSE',
    execution_status VARCHAR(50),
    execution_error TEXT,
    contracts_requested INTEGER,
    exit_requested_at TIMESTAMP WITH TIME ZONE,
    exit_reason VARCHAR(50),
    exit_order_type VARCHAR(20),
    status VARCHAR(20) DEFAULT 'OPEN', -- OPEN, CLOSED
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Price History for monitoring/charting later
CREATE TABLE IF NOT EXISTS price_history (
    id SERIAL PRIMARY KEY,
    position_id INTEGER REFERENCES positions(id) ON DELETE CASCADE,
    price DECIMAL(10, 2) NOT NULL,
    recorded_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Triggered Alerts
CREATE TABLE IF NOT EXISTS alerts (
    id SERIAL PRIMARY KEY,
    position_id INTEGER REFERENCES positions(id) ON DELETE CASCADE,
    trigger_type VARCHAR(20) NOT NULL, -- STOP_LOSS, TAKE_PROFIT
    trigger_price DECIMAL(10, 2) NOT NULL,
    actual_price DECIMAL(10, 2) NOT NULL,
    notified_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Settings Table
CREATE TABLE IF NOT EXISTS settings (
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    key VARCHAR(50) NOT NULL,
    value TEXT,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS paper_accounts (
    id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    currency VARCHAR(10) NOT NULL DEFAULT 'USD',
    initial_equity NUMERIC(16,2) NOT NULL,
    cash_balance NUMERIC(16,2) NOT NULL,
    reserved_cash NUMERIC(16,2) NOT NULL DEFAULT 0,
    equity NUMERIC(16,2) NOT NULL,
    high_water_mark NUMERIC(16,2) NOT NULL,
    start_of_day_equity NUMERIC(16,2) NOT NULL,
    start_of_day_date DATE NOT NULL,
    automation_status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO paper_accounts (
    id, name, initial_equity, cash_balance, equity, high_water_mark,
    start_of_day_equity, start_of_day_date
) VALUES (
    'shared-paper', 'Shared Paper Trading Account', 100000, 100000, 100000, 100000,
    100000, (NOW() AT TIME ZONE 'America/New_York')::date
) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS paper_strategy_controls (
    strategy_name VARCHAR(50) PRIMARY KEY,
    automation_status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO paper_strategy_controls (strategy_name) VALUES
    ('DAY_TRADING'), ('WALL_REACTION')
ON CONFLICT (strategy_name) DO NOTHING;

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
    debit_budget NUMERIC(16,2) NOT NULL DEFAULT 0,
    protected_limit NUMERIC(12,4),
    model VARCHAR(160),
    prompt_version VARCHAR(50) NOT NULL,
    policy_version VARCHAR(50) NOT NULL DEFAULT 'paper-exit-v2',
    trailing_stop_pct NUMERIC(6,2) NOT NULL DEFAULT 15,
    ai_requested BOOLEAN NOT NULL DEFAULT FALSE,
    ai_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    rationale TEXT,
    risk_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
    evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
    strategy_name VARCHAR(50) NOT NULL DEFAULT 'DAY_TRADING',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (account_id, setup_id)
);

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
    strike NUMERIC(12,4) NOT NULL,
    expiration DATE NOT NULL,
    quantity INTEGER NOT NULL,
    limit_price NUMERIC(12,4),
    fill_price NUMERIC(12,4),
    reserved_debit NUMERIC(16,2) NOT NULL DEFAULT 0,
    quote_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    failure_reason TEXT,
    expires_at TIMESTAMPTZ,
    filled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    strategy_name VARCHAR(50) NOT NULL DEFAULT 'DAY_TRADING',
    UNIQUE (account_id, setup_id, intent)
);

CREATE TABLE IF NOT EXISTS paper_equity_snapshots (
    id BIGSERIAL PRIMARY KEY,
    account_id VARCHAR(50) NOT NULL REFERENCES paper_accounts(id),
    equity NUMERIC(16,2) NOT NULL,
    cash_balance NUMERIC(16,2) NOT NULL,
    reserved_cash NUMERIC(16,2) NOT NULL,
    realized_pnl NUMERIC(16,2) NOT NULL,
    unrealized_pnl NUMERIC(16,2) NOT NULL,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS paper_monthly_reports (
    id BIGSERIAL PRIMARY KEY,
    account_id VARCHAR(50) NOT NULL REFERENCES paper_accounts(id),
    month VARCHAR(7) NOT NULL,
    report JSONB NOT NULL,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    discord_sent_at TIMESTAMPTZ,
    UNIQUE (account_id, month)
);

CREATE TABLE IF NOT EXISTS paper_trade_journal (
    id BIGSERIAL PRIMARY KEY,
    account_id VARCHAR(50) NOT NULL REFERENCES paper_accounts(id),
    setup_id UUID,
    decision_id BIGINT REFERENCES paper_trade_decisions(id),
    position_id INTEGER,
    event_type VARCHAR(50) NOT NULL,
    policy_version VARCHAR(50) NOT NULL,
    message TEXT NOT NULL,
    premium NUMERIC(12,4),
    underlying_price NUMERIC(12,4),
    quantity INTEGER,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    strategy_name VARCHAR(50) NOT NULL DEFAULT 'DAY_TRADING',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS paper_baseline_trades (
    id BIGSERIAL PRIMARY KEY,
    account_id VARCHAR(50) NOT NULL REFERENCES paper_accounts(id),
    decision_id BIGINT NOT NULL REFERENCES paper_trade_decisions(id),
    setup_id UUID NOT NULL,
    position_id INTEGER,
    quantity INTEGER NOT NULL DEFAULT 1,
    status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
    entry_price NUMERIC(12,4) NOT NULL,
    current_price NUMERIC(12,4) NOT NULL,
    exit_price NUMERIC(12,4),
    realized_pnl NUMERIC(16,2) NOT NULL DEFAULT 0,
    exit_reason VARCHAR(50),
    policy_version VARCHAR(50) NOT NULL,
    trailing_stop_pct NUMERIC(6,2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (account_id, decision_id)
);

CREATE INDEX IF NOT EXISTS idx_positions_paper_account_status
    ON positions (paper_account_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_paper_orders_account_status
    ON paper_orders (account_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_paper_decisions_account_created
    ON paper_trade_decisions (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_paper_journal_account_created
    ON paper_trade_journal (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_paper_baseline_account_status
    ON paper_baseline_trades (account_id, status, created_at DESC);

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

CREATE INDEX IF NOT EXISTS idx_wall_reaction_candidates_symbol_created
    ON wall_reaction_candidates (symbol, created_at DESC);

-- Goals Table
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

-- Goal Entries (daily earnings log)
CREATE TABLE IF NOT EXISTS goal_entries (
    id SERIAL PRIMARY KEY,
    goal_id INTEGER REFERENCES goals(id) ON DELETE CASCADE,
    entry_date DATE NOT NULL,
    amount DECIMAL(12,2) NOT NULL,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(goal_id, entry_date)
);

-- Stock History Cache Table
CREATE TABLE IF NOT EXISTS stock_history_cache (
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(20) UNIQUE NOT NULL,
    symbol_id VARCHAR(50),
    data JSONB NOT NULL,
    fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- DayTrading Scanner Execution Logs Table
CREATE TABLE IF NOT EXISTS scanner_logs (
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(10) NOT NULL,
    spot_price NUMERIC(10, 2) NOT NULL,
    regime VARCHAR(30) NOT NULL,
    vix NUMERIC(5, 2),
    gex_available BOOLEAN NOT NULL,
    indicators JSONB,
    outcome VARCHAR(30) NOT NULL, -- 'SIGNAL_GENERATED' or 'BLOCKED'
    no_trade_reasons TEXT[],
    execution_broker VARCHAR(50),
    broker_order_id VARCHAR(255),
    broker_trade_id VARCHAR(255),
    execution_status VARCHAR(50),
    execution_error TEXT,
    contracts_requested INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
