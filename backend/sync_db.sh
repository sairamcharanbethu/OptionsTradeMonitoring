#!/bin/bash
set -e

echo "[Sync] Starting database synchronization: Cloud -> Local"

# Connection strings from environment
CLOUD_DB_URL=$DATABASE_URL
LOCAL_DB_URL=$BACKUP_DATABASE_URL

if [ -z "$CLOUD_DB_URL" ] || [ -z "$LOCAL_DB_URL" ]; then
    echo "[Error] Missing DATABASE_URL or BACKUP_DATABASE_URL"
    exit 1
fi

echo "[Sync] Exporting Cloud Database..."
# Set PGSSLMODE=no-verify for Aiven cloud connection
# Use pg_dump with --clean to include drop statements for tables
# --no-owner avoids issues with differently named users
PGSSLMODE=no-verify pg_dump "$CLOUD_DB_URL" --clean --if-exists --no-owner --no-privileges > /tmp/cloud_dump.sql

echo "[Sync] Importing into Local Backup..."
# Restore into the local database
psql "$LOCAL_DB_URL" < /tmp/cloud_dump.sql > /dev/null

echo "[Sync] Cleaning up..."
rm /tmp/cloud_dump.sql

echo "[Sync] Success! Databases are now synchronized."
