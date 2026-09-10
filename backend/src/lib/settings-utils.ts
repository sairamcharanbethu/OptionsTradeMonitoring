import { redis } from './redis';
import { parseCustomEconomicEvents, parseEtClockMinute } from './economic-calendar';
import { revealSettingSecrets } from './secret-box';

const GLOBAL_SETTING_KEYS = [
  'ai_provider',
  'openrouter_key',
  'ai_model',
  'ibkr_gateway_mode',
  'ibkr_host',
  'ibkr_port',
  'zerogex_api_key',
  'discord_webhook_url',
  'discord_alerts_enabled',
  'market_poll_interval',
  'polling_enabled',
  'daily_loss_limit_dollars',
  'day_trading_symbols',
  'strategy_max_total_debit_dollars',
  'strategy_preferred_contracts',
  'strategy_max_contracts',
  'strategy_max_risk_per_trade_dollars',
  'paper_trailing_stop_pct',
  'mcp_trading_enabled',
  'entry_open_buffer_minutes',
  'entry_last_minute_et',
  'event_blackouts_enabled',
  'event_blackout_dates',
  'strategy_option_expiry_dte',
  'strategy_multi_day_max_hold_minutes',
  'max_same_direction_positions',
  'autonomous_live_ai_mode',
  'autonomous_live_ai_fallback',
  'live_ai_daily_call_budget'
];
const ADMIN_ONLY_GLOBAL_SETTING_KEYS = [
  'max_same_direction_positions',
  'autonomous_live_ai_mode',
  'autonomous_live_ai_fallback',
  'live_ai_daily_call_budget',
  'strategy_option_expiry_dte',
  'strategy_multi_day_max_hold_minutes',
  'entry_open_buffer_minutes',
  'entry_last_minute_et',
  'event_blackouts_enabled',
  'event_blackout_dates',
  'day_trading_symbols',
  'strategy_max_total_debit_dollars',
  'strategy_preferred_contracts',
  'strategy_max_contracts',
  'strategy_max_risk_per_trade_dollars',
  'paper_trailing_stop_pct',
  'market_poll_interval',
  'polling_enabled',
  'daily_loss_limit_dollars',
  'ibkr_gateway_mode',
  'ibkr_host',
  'ibkr_port',
  'zerogex_api_key',
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
  if (cached) return revealSettingSecrets(cached);

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

  // The cache holds the stored (encrypted) form; secrets are revealed on the way out.
  await redis.set(GLOBAL_SETTINGS_CACHE_KEY, JSON.stringify(settings), SETTINGS_CACHE_TTL_SECONDS);
  return revealSettingSecrets(settings);
}

async function getUserSettings(pg: any, userId: number): Promise<Record<string, string>> {
  const cacheKey = userSettingsCacheKey(userId);
  const cached = parseCachedSettings(await redis.get(cacheKey));
  if (cached) return revealSettingSecrets(cached);

  const { rows } = await pg.query('SELECT key, value FROM settings WHERE user_id = $1', [userId]);
  const settings = rows.reduce((acc: Record<string, string>, row: any) => {
    acc[row.key] = row.value;
    return acc;
  }, {});

  await redis.set(cacheKey, JSON.stringify(settings), SETTINGS_CACHE_TTL_SECONDS);
  return revealSettingSecrets(settings);
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
    'strategy_max_contracts',
    'strategy_max_risk_per_trade_dollars',
    'paper_trailing_stop_pct',
    'market_poll_interval',
    'polling_enabled',
    'daily_loss_limit_dollars',
    'entry_open_buffer_minutes',
    'entry_last_minute_et',
    'event_blackouts_enabled',
    'event_blackout_dates',
    'strategy_option_expiry_dte',
    'strategy_multi_day_max_hold_minutes',
    'max_same_direction_positions',
    'autonomous_live_ai_mode',
    'autonomous_live_ai_fallback',
    'live_ai_daily_call_budget'
  ].includes(key);
}

/** Open positions in the same direction (CALL or PUT) allowed at once across lanes/users' pooled SPY/QQQ book. */
export function validateMaxSameDirectionPositionsSetting(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  const count = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(count) || count < 1 || count > 20) {
    return 'Max same-direction positions must be a whole number between 1 and 20';
  }
  return null;
}

export function validateAutonomousLiveAiModeSetting(value: unknown): string | null {
  return ['off', 'advisory', 'gate'].includes(String(value ?? '').trim().toLowerCase())
    ? null
    : 'Autonomous live AI mode must be off, advisory or gate';
}

export function validateAutonomousLiveAiFallbackSetting(value: unknown): string | null {
  return ['trade_cautious', 'skip'].includes(String(value ?? '').trim().toLowerCase())
    ? null
    : 'Autonomous live AI fallback must be trade_cautious or skip';
}

export function validateLiveAiDailyCallBudgetSetting(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  const count = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(count) || count < 0 || count > 500) {
    return 'Live AI daily call budget must be a whole number between 0 and 500';
  }
  return null;
}

/** Minimum calendar days-to-expiry for the primary option chain (0 = same-day 0DTE). */
export function validateOptionExpiryDteSetting(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  const dte = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(dte) || dte < 0 || dte > 10) {
    return 'Option expiry DTE must be a whole number between 0 (same-day) and 10';
  }
  return null;
}

/** Max hold for strategy positions on multi-day contracts, in minutes (0 disables the time stop). */
export function validateMultiDayMaxHoldMinutesSetting(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  const minutes = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(minutes) || minutes < 0 || minutes > 390) {
    return 'Multi-day max hold must be a whole number of minutes between 0 and 390';
  }
  return null;
}

export function resolveOptionExpiryDte(settings: Record<string, string> | undefined, fallback = 3): number {
  return validateOptionExpiryDteSetting(settings?.strategy_option_expiry_dte) === null ? Number(settings!.strategy_option_expiry_dte) : fallback;
}

export function resolveMultiDayMaxHoldMinutes(settings: Record<string, string> | undefined, fallback = 45): number {
  return validateMultiDayMaxHoldMinutesSetting(settings?.strategy_multi_day_max_hold_minutes) === null ? Number(settings!.strategy_multi_day_max_hold_minutes) : fallback;
}

/** Minutes after the 9:30 ET open during which no new entry may be taken (0 disables). */
export function validateEntryOpenBufferMinutesSetting(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  const minutes = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(minutes) || minutes < 0 || minutes > 120) {
    return 'Entry open buffer must be a whole number of minutes between 0 and 120';
  }
  return null;
}

/** Last New York clock time ("HH:MM") at which a new entry may be taken; must sit inside the regular session. */
export function validateEntryLastMinuteSetting(value: unknown): string | null {
  const minute = parseEtClockMinute(value);
  if (minute === null || minute <= 9 * 60 + 30 || minute > 15 * 60) {
    return 'Entry last minute must be HH:MM New York time after 09:30 and no later than 15:00';
  }
  return null;
}

export function validateEventBlackoutDatesSetting(value: unknown): string | null {
  return parseCustomEconomicEvents(value).error;
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

export function validateTakeProfitPctSetting(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const takeProfitPct = Number(raw);
  if (!Number.isFinite(takeProfitPct) || takeProfitPct <= 0 || takeProfitPct > 500) {
    return 'Automatic premium take profit must be greater than 0% and no more than 500%';
  }
  return null;
}

export function validateSyntheticTrailingStopPctSetting(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  const trailingPct = Number(raw);
  if (!Number.isFinite(trailingPct) || trailingPct < 1 || trailingPct > 50) {
    return 'Synthetic trailing stop must be between 1% and 50%';
  }
  return null;
}

export function validateMarketPollIntervalSetting(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  const seconds = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(seconds) || seconds < 1 || seconds > 900) {
    return 'Market poll interval must be a whole number between 1 and 900 seconds';
  }
  return null;
}
