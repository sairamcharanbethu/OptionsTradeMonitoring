#!/bin/bash
# ─── Final Migration: Dump schema+data from old DB ───
# Instead of guessing schema, dump it directly from the old DB.
#
# Usage: chmod +x db/final-migrate.sh && ./db/final-migrate.sh

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

DUMP_FILE="/tmp/app_full_dump.sql"

echo ""
echo "═══════════════════════════════════════"
echo "  Final Migration (schema + data)"
echo "═══════════════════════════════════════"
echo ""

# ─── Step 1: Drop existing app tables ───
echo "1) Cleaning existing app tables..."
docker exec -i "$CONTAINER" psql -U "$NEW_USER" -d "$NEW_DB" <<'EOF'
DROP TABLE IF EXISTS goal_entries CASCADE;
DROP TABLE IF EXISTS goals CASCADE;
DROP TABLE IF EXISTS alerts CASCADE;
DROP TABLE IF EXISTS price_history CASCADE;
DROP TABLE IF EXISTS position_updates CASCADE;
DROP TABLE IF EXISTS settings CASCADE;
DROP TABLE IF EXISTS positions CASCADE;
DROP TABLE IF EXISTS users CASCADE;
EOF
echo "   ✅ Tables dropped"

# ─── Step 2: Dump schema + data from old DB (for app tables only) ───
echo ""
echo "2) Exporting schema + data from old cloud DB..."
docker run --rm \
  --network host \
  -e PGPASSWORD="$OLD_PASS" \
  postgres:16-alpine \
  pg_dump \
    -h "$OLD_HOST" \
    -p "$OLD_PORT" \
    -U "$OLD_USER" \
    -d "$OLD_DB" \
    --no-owner \
    --no-privileges \
    --no-comments \
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

# ─── Step 3: Import schema + data ───
echo ""
echo "3) Importing schema + data into n8n-postgres..."
docker cp "$DUMP_FILE" "${CONTAINER}:/tmp/app_full_dump.sql"
docker exec "$CONTAINER" psql -U "$NEW_USER" -d "$NEW_DB" -f /tmp/app_full_dump.sql 2>&1 | grep -E "^(CREATE|COPY|ERROR|ALTER)" | head -30
echo "   ✅ Import done"

# ─── Step 4: Create goals tables (new, not in old DB) ───
echo ""
echo "4) Creating goals tables..."
docker exec -i "$CONTAINER" psql -U "$NEW_USER" -d "$NEW_DB" <<'EOF'
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
echo "   ✅ Goals tables created"

# ─── Step 5: Verify ───
echo ""
echo "5) Row counts:"
for T in users positions price_history alerts settings goals goal_entries; do
    C=$(docker exec "$CONTAINER" psql -U "$NEW_USER" -d "$NEW_DB" -t -c "SELECT COUNT(*) FROM ${T};" 2>/dev/null | tr -d ' ')
    echo "   ✅ $T: $C rows"
done

# ─── Step 6: Show positions columns (for reference) ───
echo ""
echo "6) Positions table columns (from old DB):"
docker exec "$CONTAINER" psql -U "$NEW_USER" -d "$NEW_DB" -c "\d positions" 2>/dev/null | head -40

# Cleanup
rm -f "$DUMP_FILE"
docker exec "$CONTAINER" rm -f /tmp/app_full_dump.sql

echo ""
echo "═══════════════════════════════════════"
echo "  ✅ Migration complete!"
echo "═══════════════════════════════════════"
