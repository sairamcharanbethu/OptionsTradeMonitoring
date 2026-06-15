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
    analyzed_support DECIMAL(10, 2),
    analyzed_resistance DECIMAL(10, 2),
    suggested_stop_loss DECIMAL(10, 2),
    suggested_take_profit_1 DECIMAL(10, 2),
    suggested_take_profit_2 DECIMAL(10, 2),
    analysis_data JSONB,
    is_simulated BOOLEAN DEFAULT FALSE,
    account_id VARCHAR(255),
    notes TEXT,
    execution_broker VARCHAR(50),
    broker_order_id VARCHAR(255),
    broker_trade_id VARCHAR(255),
    broker_exit_order_id VARCHAR(255),
    broker_exit_trade_id VARCHAR(255),
    execution_account_id VARCHAR(255),
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
