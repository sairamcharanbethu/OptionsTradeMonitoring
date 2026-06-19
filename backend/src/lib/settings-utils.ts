const GLOBAL_SETTING_KEYS = [
  'ai_provider',
  'openrouter_key',
  'ai_model',
  'alpaca_key_id',
  'alpaca_secret_key',
  'alpaca_options_feed',
  'thetadata_api_key',
  'thetadata_base_url',
  'thetadata_stream_url',
  'sscgex_password',
  'discord_webhook_url',
  'discord_alerts_enabled',
  'day_trading_ai_provider',
  'day_trading_ai_model',
  'day_trading_coach_model'
];

export async function getGlobalSettings(pg: any): Promise<Record<string, string>> {
  const { rows } = await pg.query(
    `SELECT DISTINCT ON (s.key) s.key, s.value
     FROM settings s
     LEFT JOIN users u ON u.id = s.user_id
     WHERE s.key = ANY($1)
       AND s.value IS NOT NULL
       AND s.value != ''
     ORDER BY
       s.key,
       CASE WHEN u.role = 'ADMIN' THEN 0 ELSE 1 END,
       s.updated_at DESC`,
    [GLOBAL_SETTING_KEYS]
  );

  return rows.reduce((acc: Record<string, string>, row: any) => {
    acc[row.key] = row.value;
    return acc;
  }, {});
}

export async function getSettingsWithGlobalFallback(pg: any, userId: number): Promise<Record<string, string>> {
  const [globalRes, userRes] = await Promise.all([
    getGlobalSettings(pg),
    pg.query('SELECT key, value FROM settings WHERE user_id = $1', [userId])
  ]);

  const userSettings = userRes.rows.reduce((acc: Record<string, string>, row: any) => {
    acc[row.key] = row.value;
    return acc;
  }, {});

  // Global keys are platform-level; user rows for these keys must not override them.
  for (const key of GLOBAL_SETTING_KEYS) {
    delete userSettings[key];
  }

  return { ...globalRes, ...userSettings };
}

export function isGlobalSettingKey(key: string): boolean {
  return GLOBAL_SETTING_KEYS.includes(key);
}
