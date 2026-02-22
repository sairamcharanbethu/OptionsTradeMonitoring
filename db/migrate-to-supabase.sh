#!/bin/bash

# ==============================================================================
# Database Migration Script: Cloud DB -> Supabase (Oracle Ampere)
# ==============================================================================
# This script dumps the schema and data from the existing Cloud DB and 
# restores it directly into the new Supabase Postgres database.
# 
# Usage:
#   chmod +x migrate-to-supabase.sh
#   ./migrate-to-supabase.sh
# ==============================================================================

# Exit immediately if a command exits with a non-zero status.
set -e

echo "========================================================="
echo "   Options Trade Monitoring - Database Migration Tool    "
echo "========================================================="

# --- CONFIGURATION ---
# Read from .env if available, otherwise ask user for input
if [ -f ../.env ]; then
  source ../.env
fi

# 1. Source Database URL (Current Cloud DB)
SOURCE_DB_URL=${DATABASE_URL:-}
if [ -z "$SOURCE_DB_URL" ]; then
  read -p "Enter SOURCE Database URL (Current Cloud DB): " SOURCE_DB_URL
fi

# 2. Target Database URL (New Supabase DB)
read -p "Enter TARGET Database URL (New Supabase DB e.g., postgres://postgres:password@IP:5432/postgres): " TARGET_DB_URL

if [ -z "$TARGET_DB_URL" ]; then
  echo "Error: Target Database URL is required."
  exit 1
fi

echo ""
echo "Source: $SOURCE_DB_URL"
echo "Target: $TARGET_DB_URL"
echo ""
read -p "Are you sure you want to proceed with this migration? Everything in the target public schema will be overwritten. (y/n) " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Migration cancelled."
    exit 1
fi

TEMP_DUMP_FILE="full_database_dump.sql"

echo ""
echo "Step 1: Dumping data from Source Database..."
# We dump ONLY the public schema to avoid messing with Supabase internal schemas (auth, storage, realtime, etc.)
# We use --clean to drop existing tables in the target public schema before recreating them.
# We use --if-exists to avoid errors dropping tables that don't exist yet.
# We use --no-owner to avoid permission issues when restoring to the Supabase Postgres user.
pg_dump "$SOURCE_DB_URL" \
    --schema=public \
    --clean \
    --if-exists \
    --no-owner \
    --no-privileges \
    -f "$TEMP_DUMP_FILE"

echo "✅ Dump complete. File saved to: $TEMP_DUMP_FILE"

echo ""
echo "Step 2: Restoring data to Target Database (Supabase)..."
# Restore the dump file into the new database
psql "$TARGET_DB_URL" -f "$TEMP_DUMP_FILE"

echo "✅ Restore complete."

echo ""
echo "Step 3: Cleaning up..."
rm "$TEMP_DUMP_FILE"
echo "✅ Temporary dump file removed."

echo ""
echo "========================================================="
echo "🎉 Migration Complete!"
echo "========================================================="
echo "Important Next Steps:"
echo "1. Update your backend .env file to use the new TARGET Database URL:"
echo "   DATABASE_URL=\"$TARGET_DB_URL\""
echo "2. Restart your backend server."
echo "========================================================="
