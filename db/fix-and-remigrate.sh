#!/bin/bash
# ─── Fix Schema & Re-migrate Data ───
# Drops the wrongly-created tables, recreates with correct schema,
# then re-imports data from the old cloud DB.
#
# Usage: chmod +x db/fix-and-remigrate.sh && ./db/fix-and-remigrate.sh

# ─── Old Cloud DB ───
OLD_HOST="${OLD_DB_HOST:?Set OLD_DB_HOST env var}"
OLD_PORT="${OLD_DB_PORT:-5432}"
OLD_USER="${OLD_DB_USER:?Set OLD_DB_USER env var}"
OLD_PASS="${OLD_DB_PASS:?Set OLD_DB_PASS env var}"
OLD_DB="${OLD_DB_NAME:?Set OLD_DB_NAME env var}"

# ─── New DB ───
NEW_USER="${POSTGRES_USER:-n8n}"
NEW_DB="${POSTGRES_DB:-n8n}"
CONTAINER="n8n-postgres"

DUMP_FILE="/tmp/app_data_dump.sql"

echo ""
echo "═══════════════════════════════════════"
echo "  Fix Schema & Re-migrate Data"
echo "═══════════════════════════════════════"
echo ""

# ─── Step 1: Drop wrongly-created tables and recreate with correct schema ───
echo "1) Dropping wrong tables and recreating with correct schema..."
docker exec -i "$CONTAINER" psql -U "$NEW_USER" -d "$NEW_DB" <<'EOF'
-- Drop in reverse dependency order
DROP TABLE IF EXISTS goal_entries CASCADE;
DROP TABLE IF EXISTS goals CASCADE;
DROP TABLE IF EXISTS alerts CASCADE;
DROP TABLE IF EXISTS price_history CASCADE;
DROP TABLE IF EXISTS position_updates CASCADE;
DROP TABLE IF EXISTS settings CASCADE;
DROP TABLE IF EXISTS positions CASCADE;
DROP TABLE IF EXISTS users CASCADE;

-- Recreate with the CORRECT schema matching the old DB
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) DEFAULT 'USER',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE positions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    symbol VARCHAR(20) NOT NULL,
    option_type VARCHAR(10) NOT NULL,
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
    underlying_price DECIMAL(10, 2),
    status VARCHAR(20) DEFAULT 'OPEN',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE price_history (
    id SERIAL PRIMARY KEY,
    position_id INTEGER REFERENCES positions(id) ON DELETE CASCADE,
    price DECIMAL(10, 2) NOT NULL,
    recorded_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE alerts (
    id SERIAL PRIMARY KEY,
    position_id INTEGER REFERENCES positions(id) ON DELETE CASCADE,
    trigger_type VARCHAR(20) NOT NULL,
    trigger_price DECIMAL(10, 2) NOT NULL,
    actual_price DECIMAL(10, 2) NOT NULL,
    notified_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE settings (
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    key VARCHAR(50) NOT NULL,
    value TEXT,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, key)
);

-- Goals tables (new, no data to migrate)
CREATE TABLE goals (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(200) NOT NULL,
    target_amount NUMERIC(14,2) NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE goal_entries (
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
    echo "   ✅ Schema recreated correctly!"
else
    echo "   ❌ Schema creation failed"
    exit 1
fi

# ─── Step 2: Export data from old DB ───
echo ""
echo "2) Exporting data from old cloud DB..."
docker run --rm \
  --network host \
  -e PGPASSWORD="$OLD_PASS" \
  postgres:16-alpine \
  pg_dump \
    -h "$OLD_HOST" \
    -p "$OLD_PORT" \
    -U "$OLD_USER" \
    -d "$OLD_DB" \
    --data-only \
    --no-owner \
    --no-privileges \
    --disable-triggers \
    -t users \
    -t positions \
    -t price_history \
    -t alerts \
    -t settings \
  > "$DUMP_FILE"

if [ $? -ne 0 ] || [ ! -s "$DUMP_FILE" ]; then
    echo "   ❌ Export failed"
    exit 1
fi

SIZE=$(du -h "$DUMP_FILE" | cut -f1)
echo "   ✅ Export complete! ($SIZE)"

# ─── Step 3: Import ───
echo ""
echo "3) Importing data..."
docker cp "$DUMP_FILE" "${CONTAINER}:/tmp/app_data_dump.sql"
docker exec "$CONTAINER" psql -U "$NEW_USER" -d "$NEW_DB" -f /tmp/app_data_dump.sql

if [ $? -eq 0 ]; then
    echo "   ✅ Import complete!"
else
    echo "   ⚠️  Import had some errors (check above)"
fi

# ─── Step 4: Fix sequences ───
echo ""
echo "4) Fixing auto-increment sequences..."
docker exec "$CONTAINER" psql -U "$NEW_USER" -d "$NEW_DB" -c "
SELECT setval('users_id_seq', COALESCE((SELECT MAX(id) FROM users), 0) + 1, false);
SELECT setval('positions_id_seq', COALESCE((SELECT MAX(id) FROM positions), 0) + 1, false);
SELECT setval('price_history_id_seq', COALESCE((SELECT MAX(id) FROM price_history), 0) + 1, false);
SELECT setval('alerts_id_seq', COALESCE((SELECT MAX(id) FROM alerts), 0) + 1, false);
SELECT setval('goals_id_seq', COALESCE((SELECT MAX(id) FROM goals), 0) + 1, false);
SELECT setval('goal_entries_id_seq', COALESCE((SELECT MAX(id) FROM goal_entries), 0) + 1, false);
"
echo "   ✅ Sequences fixed!"

# ─── Step 5: Verify ───
echo ""
echo "5) Row counts:"
for T in users positions price_history alerts settings goals goal_entries; do
    C=$(docker exec "$CONTAINER" psql -U "$NEW_USER" -d "$NEW_DB" -t -c "SELECT COUNT(*) FROM ${T};" 2>/dev/null | tr -d ' ')
    echo "   ✅ $T: $C rows"
done

# Cleanup
rm -f "$DUMP_FILE"
docker exec "$CONTAINER" rm -f /tmp/app_data_dump.sql

echo ""
echo "═══════════════════════════════════════"
echo "  ✅ All done! Data migrated correctly."
echo "═══════════════════════════════════════"
