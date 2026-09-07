/**
 * One-off: encrypt plaintext secret rows in `settings` in place.
 *
 *   SETTINGS_ENCRYPTION_KEY=<32+ chars> npx ts-node src/scripts/encrypt-settings-secrets.ts          # dry run
 *   SETTINGS_ENCRYPTION_KEY=<32+ chars> npx ts-node src/scripts/encrypt-settings-secrets.ts --apply  # rewrite
 *
 * Idempotent: rows already carrying the enc:v1: prefix are skipped. Secret keys
 * are those matched by isSecretSettingKey (*_key, *_secret, *_token, *webhook*).
 */
import dotenv from 'dotenv';
import path from 'path';
import pg from 'pg';
import { encryptSecret, encryptionConfigured, isEncrypted, isSecretSettingKey } from '../lib/secret-box';

dotenv.config({ path: path.join(__dirname, '../../../.env') });

const APPLY = process.argv.includes('--apply');

async function main() {
  if (!encryptionConfigured()) {
    console.error('SETTINGS_ENCRYPTION_KEY is missing or shorter than 32 characters; nothing to do.');
    process.exit(1);
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is required.');
    process.exit(1);
  }
  const pool = new pg.Pool({
    connectionString,
    ssl: connectionString.includes('aivencloud') || connectionString.includes('render') ? { rejectUnauthorized: false } : undefined
  });
  try {
    const { rows } = await pool.query(`SELECT user_id, key, value FROM settings WHERE value IS NOT NULL AND value <> ''`);
    const candidates = rows.filter((row: any) => isSecretSettingKey(row.key) && !isEncrypted(row.value));
    const skipped = rows.filter((row: any) => isSecretSettingKey(row.key) && isEncrypted(row.value)).length;
    console.log(`${rows.length} settings rows; ${candidates.length} plaintext secret rows to encrypt; ${skipped} already encrypted.`);
    for (const row of candidates) {
      console.log(`  ${APPLY ? 'encrypting' : 'would encrypt'} user=${row.user_id} key=${row.key}`);
      if (!APPLY) continue;
      await pool.query(
        `UPDATE settings SET value = $3, updated_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND key = $2 AND value = $4`,
        [row.user_id, row.key, encryptSecret(String(row.value)), row.value]
      );
    }
    if (!APPLY) console.log('Dry run. Re-run with --apply to write.');
    else console.log('Done. Restart the backend (or wait for the settings cache TTL) so cached plaintext is replaced.');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
