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
    current_price DECIMAL(10, 2),
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
