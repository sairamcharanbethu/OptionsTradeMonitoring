/**
 * At-rest encryption for secret values in the `settings` table.
 *
 * Format: `enc:v1:<iv_b64>:<tag_b64>:<ciphertext_b64>` (AES-256-GCM, 12-byte IV).
 * The key is derived from SETTINGS_ENCRYPTION_KEY (any string of 32+ chars,
 * hashed to 32 bytes). Values without the prefix are legacy plaintext and pass
 * through unchanged, so enabling the key later needs no downtime: new writes are
 * encrypted, old rows keep working until `scripts/encrypt-settings-secrets.ts`
 * rewrites them.
 *
 * Failure policy: a missing key never crashes the process — writes stay
 * plaintext and a single startup warning is logged. An encrypted value that
 * cannot be decrypted because the key is missing resolves to '' (unconfigured),
 * so callers fall back to their env defaults instead of sending ciphertext to a
 * vendor. A value that fails authentication (tampered / wrong key) throws.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

const PREFIX = 'enc:v1:';
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const MIN_KEY_CHARS = 32;

/** Settings keys whose values are secrets: *_key, *_secret, *_token, *webhook*. */
const SECRET_KEY_PATTERN = /(_key$|_secret$|_token$|webhook)/i;
/** Explicit non-secrets that match the pattern. */
const SECRET_KEY_EXCEPTIONS = new Set(['snaptrade_user_id']);

let warnedMissingKey = false;

export function isSecretSettingKey(key: string): boolean {
  const normalized = String(key || '').trim();
  if (!normalized || SECRET_KEY_EXCEPTIONS.has(normalized)) return false;
  return SECRET_KEY_PATTERN.test(normalized);
}

export function isEncrypted(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

export function encryptionConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.SETTINGS_ENCRYPTION_KEY || '').trim().length >= MIN_KEY_CHARS;
}

function deriveKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = String(env.SETTINGS_ENCRYPTION_KEY || '').trim();
  if (raw.length < MIN_KEY_CHARS) return null;
  return createHash('sha256').update(raw, 'utf8').digest();
}

export function encryptSecret(plain: string, env: NodeJS.ProcessEnv = process.env): string {
  if (typeof plain !== 'string' || plain === '' || isEncrypted(plain)) return plain;
  const key = deriveKey(env);
  if (!key) return plain; // no key configured: plaintext (warned once at startup)
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

export function decryptSecret(value: string, env: NodeJS.ProcessEnv = process.env, log?: { warn: (msg: string) => void }): string {
  if (!isEncrypted(value)) return value; // legacy plaintext passes through
  const key = deriveKey(env);
  if (!key) {
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      (log || console).warn('[SecretBox] An encrypted setting exists but SETTINGS_ENCRYPTION_KEY is not set; treating it as unconfigured.');
    }
    return '';
  }
  const parts = value.slice(PREFIX.length).split(':');
  if (parts.length !== 3) throw new Error('SecretBox: malformed encrypted value');
  const [ivB64, tagB64, ctB64] = parts;
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  // Throws on a bad tag (tampered ciphertext or wrong key).
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

/** Encrypt the value if the key is a secret setting; otherwise return it unchanged. */
export function protectSettingValue(key: string, value: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  if (!isSecretSettingKey(key) || typeof value !== 'string') return value;
  return encryptSecret(value, env);
}

/** Decrypt every secret setting in a settings map (non-secret keys untouched). */
export function revealSettingSecrets<T extends Record<string, any>>(settings: T, env: NodeJS.ProcessEnv = process.env, log?: { warn: (msg: string) => void }): T {
  const out: Record<string, any> = { ...settings };
  for (const [key, value] of Object.entries(out)) {
    if (isSecretSettingKey(key) && isEncrypted(value)) {
      try {
        out[key] = decryptSecret(value, env, log);
      } catch (err: any) {
        (log || console).warn(`[SecretBox] Could not decrypt setting ${key}: ${err?.message || String(err)}; treating as unconfigured.`);
        out[key] = '';
      }
    }
  }
  return out as T;
}

/** One startup log line describing the at-rest posture. */
export function logSecretsPosture(log: { warn: (msg: string) => void; info: (msg: string) => void }, env: NodeJS.ProcessEnv = process.env): void {
  if (encryptionConfigured(env)) {
    log.info('[Security] Settings secrets are encrypted at rest (SETTINGS_ENCRYPTION_KEY set).');
  } else {
    log.warn('[Security] SETTINGS_ENCRYPTION_KEY is not set: API keys and webhooks in the settings table are stored in plaintext. Set a 32+ char key and run `npx ts-node src/scripts/encrypt-settings-secrets.ts --apply`.');
  }
}

/** Test hook. */
export function _resetSecretBoxWarnings(): void {
  warnedMissingKey = false;
}
