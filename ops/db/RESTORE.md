# Postgres backups and restore drill

The live ledger (positions, claims, trade events, settings, kill switch) lives in
Postgres. Without a backup a disk failure on the Coolify host loses the trading
history and the operator settings in one go.

## Step 0 — which Postgres is live?

`DATABASE_URL` is set in Coolify's Environment Variables panel (the MCP exposes
names only). Check its host:

- `*.aivencloud.com` → Aiven manages daily backups (and PITR on paid tiers).
  Verify retention in the Aiven console, keep the weekly off-provider dump
  below as a second copy, and treat the compose `db` service as dead weight.
- `db` (the in-stack service) → enable the `db-backup` sidecar below.

## Enabling the sidecar (in-stack Postgres)

`docker-compose.coolify.yml` ships a `db-backup` service behind the `backup`
compose profile, so it only runs when you opt in. In Coolify's env panel set:

```
COMPOSE_PROFILES=backup
BACKUP_S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com   # or B2 / OCI S3 endpoint
BACKUP_S3_BUCKET=strikepilot-backups
BACKUP_S3_ACCESS_KEY_ID=...
BACKUP_S3_SECRET_ACCESS_KEY=...
BACKUP_S3_REGION=auto                                            # R2: auto; B2: us-west-004 etc.
BACKUP_SCHEDULE=0 2 * * *                                        # 02:00 UTC = 22:00 ET (EDT); adjust in winter
BACKUP_KEEP_DAYS=14
```

Then **Deploy** (not Restart — profiles are resolved at compose time). The
sidecar (`eeshugerman/postgres-backup-s3:15`) runs `pg_dump` on the schedule,
uploads `strikepilot/db/<db>_<timestamp>.dump` to the bucket and prunes files
older than `BACKUP_KEEP_DAYS`.

Verify after the first night: the bucket has one object, and
`docker logs <stack>-db-backup-1` shows `Backup complete`.

## Restore drill (monthly, ~5 minutes)

Run from the Coolify host (or via a Coolify scheduled task on the `db` service):

```bash
# 1. Pull the latest dump (any S3 client; aws cli shown)
aws --endpoint-url "$BACKUP_S3_ENDPOINT" s3 cp \
  "s3://$BACKUP_S3_BUCKET/strikepilot/db/$(aws --endpoint-url "$BACKUP_S3_ENDPOINT" s3 ls "s3://$BACKUP_S3_BUCKET/strikepilot/db/" | sort | tail -1 | awk '{print $4}')" \
  /tmp/latest.dump

# 2. Restore into a scratch database inside the db container
DB=$(docker ps --format '{{.Names}}' | grep -- '-db-1$' | head -1)
docker exec -i "$DB" psql -U "$POSTGRES_USER" -c "DROP DATABASE IF EXISTS options_restore_test;"
docker exec -i "$DB" psql -U "$POSTGRES_USER" -c "CREATE DATABASE options_restore_test;"
docker exec -i "$DB" pg_restore -U "$POSTGRES_USER" -d options_restore_test --no-owner < /tmp/latest.dump

# 3. Sanity-check the ledger came back
docker exec -i "$DB" psql -U "$POSTGRES_USER" -d options_restore_test -c \
  "SELECT count(*) AS positions, max(created_at) AS newest FROM positions;"

# 4. Clean up
docker exec -i "$DB" psql -U "$POSTGRES_USER" -c "DROP DATABASE options_restore_test;"
```

Record the drill below. If step 3 returns zero rows or an error, the backup is
not usable — fix it before the next trading day.

| Date | Dump used | positions count | Result | By |
|------|-----------|-----------------|--------|----|
|      |           |                 |        |    |

## Full restore (disaster)

1. Stop the backend (`control stop` in Coolify) so nothing writes.
2. `pg_restore --clean --if-exists -d <db>` the chosen dump into the live
   database (same commands as the drill, target the real DB).
3. Start the backend. It re-runs `ensureSchema` (idempotent `CREATE ... IF NOT
   EXISTS`) and the broker position reconciler re-checks the ledger against
   Wealthsimple on the first pending-order sync; expect `broker-reconcile`
   alerts for anything that moved between the dump and the restore.
