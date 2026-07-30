import { redis } from './redis';

const GLOBAL_SETTING_KEYS = [
  'ai_provider',
  'openrouter_key',
  'ai_model',
  'ibkr_gateway_mode',
  'ibkr_host',
  'ibkr_port',
  'sscgex_password',
  'discord_webhook_url',
  'discord_alerts_enabled',
  'day_trading_symbols',
  'strategy_max_total_debit_dollars',
  'strategy_preferred_contracts',
  'strategy_max_contracts',
  'mcp_trading_enabled',
  'day_trading_ai_provider',
  'day_trading_ai_model',
  'day_trading_coach_model'
];
const ADMIN_ONLY_GLOBAL_SETTING_KEYS = [
  'day_trading_symbols',
  'strategy_max_total_debit_dollars',
  'strategy_preferred_contracts',
  'strategy_max_contracts',
  'ibkr_gateway_mode',
  'ibkr_host',
  'ibkr_port',
  'mcp_trading_enabled'
];
const SETTINGS_CACHE_TTL_SECONDS = Number(process.env.SETTINGS_CACHE_TTL_SECONDS || 300);
const GLOBAL_SETTINGS_CACHE_KEY = 'SETTINGS:GLOBAL';
const userSettingsCacheKey = (userId: number) => `SETTINGS:USER:${userId}`;

function parseCachedSettings(value: string | null): Record<string, string> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return Object.entries(parsed).reduce((acc: Record<string, string>, [key, settingValue]) => {
      if (typeof settingValue === 'string') acc[key] = settingValue;
      return acc;
    }, {});
  } catch {
    return null;
  }
}

export async function getGlobalSettings(pg: any): Promise<Record<string, string>> {
  const cached = parseCachedSettings(await redis.get(GLOBAL_SETTINGS_CACHE_KEY));
  if (cached) return cached;

  const { rows } = await pg.query(
     `SELECT DISTINCT ON (s.key) s.key, s.value
      FROM settings s
      LEFT JOIN users u ON u.id = s.user_id
      WHERE s.key = ANY($1)
        AND s.value IS NOT NULL
        AND s.value != ''
        AND (s.key != ALL($2) OR u.role = 'ADMIN')
      ORDER BY
       s.key,
       CASE WHEN u.role = 'ADMIN' THEN 0 ELSE 1 END,
       s.updated_at DESC`,
    [GLOBAL_SETTING_KEYS, ADMIN_ONLY_GLOBAL_SETTING_KEYS]
  );

  const settings = rows.reduce((acc: Record<string, string>, row: any) => {
    acc[row.key] = row.value;
    return acc;
  }, {});

  await redis.set(GLOBAL_SETTINGS_CACHE_KEY, JSON.stringify(settings), SETTINGS_CACHE_TTL_SECONDS);
  return settings;
}

async function getUserSettings(pg: any, userId: number): Promise<Record<string, string>> {
  const cacheKey = userSettingsCacheKey(userId);
  const cached = parseCachedSettings(await redis.get(cacheKey));
  if (cached) return cached;

  const { rows } = await pg.query('SELECT key, value FROM settings WHERE user_id = $1', [userId]);
  const settings = rows.reduce((acc: Record<string, string>, row: any) => {
    acc[row.key] = row.value;
    return acc;
  }, {});

  await redis.set(cacheKey, JSON.stringify(settings), SETTINGS_CACHE_TTL_SECONDS);
  return settings;
}

export async function getSettingsWithGlobalFallback(pg: any, userId: number): Promise<Record<string, string>> {
  const [globalRes, userRes] = await Promise.all([
    getGlobalSettings(pg),
    getUserSettings(pg, userId)
  ]);

  const userSettings = { ...userRes };

  // Global keys are platform-level; user rows for these keys must not override them.
  for (const key of GLOBAL_SETTING_KEYS) {
    delete userSettings[key];
  }

  return { ...globalRes, ...userSettings };
}

export async function invalidateSettingsCache(userId: number, changedKeys: string[] = []): Promise<void> {
  const invalidateGlobal = changedKeys.some((key) => GLOBAL_SETTING_KEYS.includes(key));
  await Promise.all([
    redis.del(userSettingsCacheKey(userId)),
    invalidateGlobal ? redis.del(GLOBAL_SETTINGS_CACHE_KEY) : Promise.resolve()
  ]);
}

export function isGlobalSettingKey(key: string): boolean {
  return GLOBAL_SETTING_KEYS.includes(key);
}

export function isPublicGlobalSettingKey(key: string): boolean {
  return [
    'day_trading_symbols',
    'strategy_max_total_debit_dollars',
    'strategy_preferred_contracts',
    'strategy_max_contracts'
  ].includes(key);
}

export function resolveMcpTradingEnabled(settings: Record<string, string>, envValue = process.env.MCP_TRADING_ENABLED): boolean {
  const settingValue = String(settings.mcp_trading_enabled || '').trim().toLowerCase();
  if (settingValue) return settingValue === 'true';
  return String(envValue || '').trim().toLowerCase() === 'true';
}

export function applyMcpTradingEnabledFallback(settings: Record<string, string>, envValue = process.env.MCP_TRADING_ENABLED): Record<string, string> {
  if (String(settings.mcp_trading_enabled || '').trim()) return settings;
  if (!String(envValue || '').trim()) return settings;
  return {
    ...settings,
    mcp_trading_enabled: String(envValue || '').trim().toLowerCase() === 'true' ? 'true' : 'false'
  };
}
