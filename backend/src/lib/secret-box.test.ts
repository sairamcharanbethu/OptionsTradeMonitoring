import { _resetSecretBoxWarnings, decryptSecret, encryptSecret, isEncrypted, isSecretSettingKey, protectSettingValue, revealSettingSecrets } from './secret-box';
import { getGlobalSettings } from './settings-utils';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

const KEY = { SETTINGS_ENCRYPTION_KEY: 'unit-test-key-that-is-definitely-longer-than-32-chars' } as NodeJS.ProcessEnv;
const OTHER = { SETTINGS_ENCRYPTION_KEY: 'another-key-that-is-also-longer-than-thirty-two-chars' } as NodeJS.ProcessEnv;
const NONE = {} as NodeJS.ProcessEnv;

async function runTests() {
  console.log('Running secret box tests...');
  assert(isSecretSettingKey('openrouter_key') && isSecretSettingKey('zerogex_api_key') && isSecretSettingKey('snaptrade_user_secret') && isSecretSettingKey('discord_webhook_url'), 'Secret key detection covers keys, secrets and webhooks');
  assert(!isSecretSettingKey('snaptrade_user_id') && !isSecretSettingKey('market_poll_interval') && !isSecretSettingKey('entry_last_minute_et'), 'Non-secret keys are not encrypted');

  const enc = encryptSecret('sk-or-abc123', KEY);
  assert(isEncrypted(enc) && enc !== 'sk-or-abc123', 'Ciphertext carries the prefix and differs from plaintext');
  assert(decryptSecret(enc, KEY) === 'sk-or-abc123', 'Round trip');
  assert(encryptSecret('sk-or-abc123', KEY) !== enc, 'Random IV: same plaintext encrypts differently');
  assert(encryptSecret(enc, KEY) === enc, 'Encrypting an already-encrypted value is a no-op');
  assert(decryptSecret('plain-legacy-value', KEY) === 'plain-legacy-value', 'Legacy plaintext passes through');
  assert(encryptSecret('plain', NONE) === 'plain', 'No key configured: writes stay plaintext');

  let threw = false;
  try { decryptSecret(enc.slice(0, -4) + 'AAAA', KEY); } catch { threw = true; }
  assert(threw, 'Tampered ciphertext fails authentication');
  threw = false;
  try { decryptSecret(enc, OTHER); } catch { threw = true; }
  assert(threw, 'Wrong key fails authentication');

  _resetSecretBoxWarnings();
  const warnings: string[] = [];
  assert(decryptSecret(enc, NONE, { warn: (m) => warnings.push(m) }) === '', 'Encrypted value with no key resolves to unconfigured');
  decryptSecret(enc, NONE, { warn: (m) => warnings.push(m) });
  assert(warnings.length === 1, 'Missing-key warning is logged once');

  assert(protectSettingValue('openrouter_key', 'k', KEY) !== 'k' && protectSettingValue('market_poll_interval', '30', KEY) === '30', 'protectSettingValue encrypts only secrets');
  const revealed = revealSettingSecrets({ openrouter_key: enc, market_poll_interval: '30', zerogex_api_key: 'legacy' }, KEY);
  assert(revealed.openrouter_key === 'sk-or-abc123' && revealed.market_poll_interval === '30' && revealed.zerogex_api_key === 'legacy', 'revealSettingSecrets decrypts secrets and leaves the rest');

  // Read path: getGlobalSettings decrypts an encrypted DB row (Redis is not connected in tests, so the cache is bypassed).
  const previous = process.env.SETTINGS_ENCRYPTION_KEY;
  process.env.SETTINGS_ENCRYPTION_KEY = KEY.SETTINGS_ENCRYPTION_KEY;
  try {
    const pg = { query: async () => ({ rows: [{ key: 'openrouter_key', value: enc }, { key: 'market_poll_interval', value: '45' }] }) };
    const settings = await getGlobalSettings(pg);
    assert(settings.openrouter_key === 'sk-or-abc123', 'getGlobalSettings returns the decrypted secret');
    assert(settings.market_poll_interval === '45', 'Non-secret settings unchanged on the read path');
  } finally {
    if (previous === undefined) delete process.env.SETTINGS_ENCRYPTION_KEY; else process.env.SETTINGS_ENCRYPTION_KEY = previous;
  }
  console.log('All secret box tests passed!');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
