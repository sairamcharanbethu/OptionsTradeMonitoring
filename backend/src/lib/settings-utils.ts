const GLOBAL_SETTING_KEYS = [
  'ai_provider',
  'openrouter_key',
  'ai_model',
  'alpaca_key_id',
  'alpaca_secret_key',
  'alpaca_options_feed',
  'polygon_api_key',
  'sscgex_password',
  'day_trading_ai_provider',
  'day_trading_ai_model',
  'day_trading_coach_model'
];

export async function getSettingsWithGlobalFallback(pg: any, userId: number): Promise<Record<string, string>> {
  const [globalRes, userRes] = await Promise.all([
    pg.query(
      `SELECT DISTINCT ON (key) key, value
       FROM settings
       WHERE key = ANY($1)
         AND value IS NOT NULL
         AND value != ''
       ORDER BY key, updated_at DESC`,
      [GLOBAL_SETTING_KEYS]
    ),
    pg.query('SELECT key, value FROM settings WHERE user_id = $1', [userId])
  ]);

  const globalSettings = globalRes.rows.reduce((acc: Record<string, string>, row: any) => {
    acc[row.key] = row.value;
    return acc;
  }, {});

  const userSettings = userRes.rows.reduce((acc: Record<string, string>, row: any) => {
    acc[row.key] = row.value;
    return acc;
  }, {});

  // User-specific settings win except blank values for global keys, which fall back to shared config.
  for (const key of GLOBAL_SETTING_KEYS) {
    if (userSettings[key] === '') {
      delete userSettings[key];
    }
  }

  return { ...globalSettings, ...userSettings };
}

export function isGlobalSettingKey(key: string): boolean {
  return GLOBAL_SETTING_KEYS.includes(key);
}
