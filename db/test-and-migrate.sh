#!/bin/bash
# ─── Test DB Connection & Run Migrations ───
# Run this on the cloud instance where the n8n-postgres container is running.
#
# Usage:
#   chmod +x db/test-and-migrate.sh
#   ./db/test-and-migrate.sh

set -e

# Config — update these if different
DB_USER="${POSTGRES_USER:-n8n}"
DB_PASS="${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD env var}"
DB_HOST="n8n-postgres"
DB_PORT="5432"
DB_NAME="${POSTGRES_DB:-n8n}"

CONN="postgresql://${DB_USER}:${DB_PASS}@${DB_HOST}:${DB_PORT}/${DB_NAME}"

echo "═══════════════════════════════════════"
echo "  DB Connection & Migration Script"
echo "═══════════════════════════════════════"
echo ""

# ─── Step 1: Test connection ───
echo "1) Testing connection to ${DB_HOST}:${DB_PORT}/${DB_NAME}..."
if docker exec n8n-postgres pg_isready -U "$DB_USER" -d "$DB_NAME" > /dev/null 2>&1; then
    echo "   ✅ Postgres is ready!"
else
    echo "   ❌ Postgres is NOT ready. Is the container running?"
    echo "   Run: docker ps | grep n8n-postgres"
    exit 1
fi

# ─── Step 2: Test authentication ───
echo ""
echo "2) Testing authentication..."
VERSION=$(docker exec n8n-postgres psql -U "$DB_USER" -d "$DB_NAME" -t -c "SELECT version();" 2>&1)
if [ $? -eq 0 ]; then
    echo "   ✅ Connected successfully!"
    echo "   $VERSION"
else
    echo "   ❌ Authentication failed: $VERSION"
    exit 1
fi

# ─── Step 3: Run schema.sql migration ───
echo ""
echo "3) Running schema.sql migration..."
docker exec -i n8n-postgres psql -U "$DB_USER" -d "$DB_NAME" <<'EOF'
-- Users table
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(80) NOT NULL UNIQUE,
  email VARCHAR(200),
  password_hash TEXT NOT NULL,
  role VARCHAR(20) DEFAULT 'USER',
  discord_webhook_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Positions table
CREATE TABLE IF NOT EXISTS positions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  ticker VARCHAR(10) NOT NULL,
  option_type VARCHAR(4) CHECK (option_type IN ('CALL','PUT')),
  strike_price NUMERIC(12,2),
  expiry_date DATE,
  entry_price NUMERIC(12,2),
  quantity INTEGER DEFAULT 1,
  status VARCHAR(10) DEFAULT 'OPEN',
  questrade_symbol_id INTEGER,
  stop_loss_enabled BOOLEAN DEFAULT FALSE,
  stop_loss_trigger NUMERIC(12,2),
  stop_loss_sell_price NUMERIC(12,2),
  close_price NUMERIC(12,2),
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Position updates (price history)
CREATE TABLE IF NOT EXISTS position_updates (
  id SERIAL PRIMARY KEY,
  position_id INTEGER REFERENCES positions(id) ON DELETE CASCADE,
  current_price NUMERIC(12,2),
  bid_price NUMERIC(12,2),
  ask_price NUMERIC(12,2),
  volume INTEGER,
  open_interest INTEGER,
  implied_volatility NUMERIC(8,4),
  delta NUMERIC(8,4),
  gamma NUMERIC(8,4),
  theta NUMERIC(8,4),
  vega NUMERIC(8,4),
  recorded_at TIMESTAMPTZ DEFAULT NOW()
);

-- Settings table
CREATE TABLE IF NOT EXISTS settings (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  key VARCHAR(100) NOT NULL,
  value TEXT,
  UNIQUE(user_id, key)
);

-- Alerts table
CREATE TABLE IF NOT EXISTS alerts (
  id SERIAL PRIMARY KEY,
  position_id INTEGER REFERENCES positions(id) ON DELETE CASCADE,
  alert_type VARCHAR(30) NOT NULL,
  threshold NUMERIC(12,2),
  comparison VARCHAR(5) CHECK (comparison IN ('above','below')),
  triggered BOOLEAN DEFAULT FALSE,
  triggered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
EOF

if [ $? -eq 0 ]; then
    echo "   ✅ schema.sql applied!"
else
    echo "   ❌ schema.sql failed"
    exit 1
fi

# ─── Step 4: Run goals.sql migration ───
echo ""
echo "4) Running goals.sql migration..."
docker exec -i n8n-postgres psql -U "$DB_USER" -d "$DB_NAME" <<'EOF'
CREATE TABLE IF NOT EXISTS goals (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  target_amount NUMERIC(14,2) NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS goal_entries (
  id SERIAL PRIMARY KEY,
  goal_id INTEGER REFERENCES goals(id) ON DELETE CASCADE,
  entry_date DATE NOT NULL,
  amount NUMERIC(14,2) NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(goal_id, entry_date)
);
EOF

if [ $? -eq 0 ]; then
    echo "   ✅ goals.sql applied!"
else
    echo "   ❌ goals.sql failed"
    exit 1
fi

# ─── Step 5: Verify tables ───
echo ""
echo "5) Verifying tables..."
TABLES=$(docker exec n8n-postgres psql -U "$DB_USER" -d "$DB_NAME" -t -c "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;")
echo "   Tables found:"
echo "$TABLES" | while read -r line; do
    [ -n "$line" ] && echo "   ✅ $line"
done

echo ""
echo "═══════════════════════════════════════"
echo "  All done! DB is ready."
echo "═══════════════════════════════════════"
