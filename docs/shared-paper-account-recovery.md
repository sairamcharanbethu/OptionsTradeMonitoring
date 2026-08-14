# Shared paper account recovery

The shared-paper migration can consolidate ledgers already present in the active database during backend startup. If the deployment connected to a new or recreated database, use this importer to copy the historical paper ledger from the old database or a backup.

The importer is deliberately safe by default:

- It only reads from `PAPER_LEGACY_DATABASE_URL`.
- It performs a dry run unless `--apply` is supplied.
- It refuses to merge with a destination that already has shared-paper activity.
- It preserves each transaction's Day Trading or Wall Reaction label and recalculates one $100,000 shared cash balance from the imported positions and P&L.

## CI/CD recovery

Both deployment workflows automatically run the importer before starting the new backend when the deployment environment contains `PAPER_LEGACY_DATABASE_URL`. Store that value in the deployment secret manager as the old database or backup connection; do not set it to the same value as `DATABASE_URL`. The import is idempotent, so later deployments detect its completion and continue without copying records again.

1. Stop paper automation on the destination and take a database backup.
2. Set `DATABASE_URL` to the current destination database and `PAPER_LEGACY_DATABASE_URL` to the old database or backup.
3. Build the backend, then run the dry run:

   ```bash
   cd backend
   npm run build
   npm run migrate:shared-paper
   ```

4. Review the counts, then run the one-time import:

   ```bash
   npm run migrate:shared-paper -- --apply
   ```

Do not point both variables to the same database. If the prior database volume and all backups were deleted, the old ledger cannot be reconstructed by this script.
