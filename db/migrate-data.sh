#!/bin/bash
# ─── Migrate Data: Old Cloud DB → n8n-postgres (Docker-only) ───
# Usage: chmod +x db/migrate-data.sh && ./db/migrate-data.sh

# ─── Old Cloud DB ───
OLD_HOST="140.245.28.181"
OLD_PORT="5432"
OLD_USER="appuser"
OLD_PASS="Lassi626!1995"
OLD_DB="appdb"

# ─── New DB ───
NEW_USER="n8n"
NEW_DB="n8n"
CONTAINER="n8n-postgres"

DUMP_FILE="/tmp/app_data_dump.sql"

echo ""
echo "═══════════════════════════════════════"
echo "  Data Migration: Old Cloud → n8n-postgres"
echo "═══════════════════════════════════════"
echo ""
echo "  Source: ${OLD_USER}@${OLD_HOST}/${OLD_DB}"
echo "  Target: ${NEW_USER}@${CONTAINER}/${NEW_DB}"
echo ""

# ─── Step 1: Export via Docker ───
echo "1) Exporting data from old cloud DB (via Docker)..."
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
    -t position_updates \
    -t settings \
    -t alerts \
  > "$DUMP_FILE"

if [ $? -ne 0 ] || [ ! -s "$DUMP_FILE" ]; then
    echo "   ❌ Export failed. Check credentials/network."
    cat "$DUMP_FILE" 2>/dev/null
    exit 1
fi

SIZE=$(du -h "$DUMP_FILE" | cut -f1)
echo "   ✅ Export complete! ($SIZE)"

# ─── Step 2: Import into n8n-postgres ───
echo ""
echo "2) Importing into n8n-postgres..."
docker cp "$DUMP_FILE" "${CONTAINER}:/tmp/app_data_dump.sql"
docker exec "$CONTAINER" psql -U "$NEW_USER" -d "$NEW_DB" -f /tmp/app_data_dump.sql
if [ $? -eq 0 ]; then
    echo "   ✅ Import complete!"
else
    echo "   ❌ Import failed"
    exit 1
fi

# ─── Step 3: Fix sequences ───
echo ""
echo "3) Fixing auto-increment sequences..."
docker exec "$CONTAINER" psql -U "$NEW_USER" -d "$NEW_DB" -c "
SELECT setval('users_id_seq', COALESCE((SELECT MAX(id) FROM users), 0) + 1, false);
SELECT setval('positions_id_seq', COALESCE((SELECT MAX(id) FROM positions), 0) + 1, false);
SELECT setval('position_updates_id_seq', COALESCE((SELECT MAX(id) FROM position_updates), 0) + 1, false);
SELECT setval('settings_id_seq', COALESCE((SELECT MAX(id) FROM settings), 0) + 1, false);
SELECT setval('alerts_id_seq', COALESCE((SELECT MAX(id) FROM alerts), 0) + 1, false);
SELECT setval('goals_id_seq', COALESCE((SELECT MAX(id) FROM goals), 0) + 1, false);
SELECT setval('goal_entries_id_seq', COALESCE((SELECT MAX(id) FROM goal_entries), 0) + 1, false);
"
echo "   ✅ Sequences fixed!"

# ─── Step 4: Verify ───
echo ""
echo "4) Row counts in new DB:"
for T in users positions position_updates settings alerts; do
    C=$(docker exec "$CONTAINER" psql -U "$NEW_USER" -d "$NEW_DB" -t -c "SELECT COUNT(*) FROM ${T};" | tr -d ' ')
    echo "   ✅ $T: $C rows"
done

# Cleanup
rm -f "$DUMP_FILE"
docker exec "$CONTAINER" rm -f /tmp/app_data_dump.sql

echo ""
echo "═══════════════════════════════════════"
echo "  ✅ Migration complete!"
echo "═══════════════════════════════════════"
