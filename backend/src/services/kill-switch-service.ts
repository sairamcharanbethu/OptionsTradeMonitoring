import { getGlobalSettings } from '../lib/settings-utils';
import { publishRealtime } from '../lib/realtime';
import { redis as defaultRedis } from '../lib/redis';
import { SHARED_PAPER_ACCOUNT_ID } from './paper-account-constants';

export type KillSwitchScope = 'paper' | 'live';

export interface KillSwitchStatus {
  scope: KillSwitchScope;
  enabled: boolean;        // a positive limit is configured
  limit: number;           // daily loss limit in dollars (0 = disabled)
  dayRealizedPnl: number;  // today's realized P&L (America/New_York)
  dayOpenPnl: number;      // unrealized P&L of currently open positions at last mark
  dayTotalPnl: number;     // realized + open
  disarmed: boolean;       // live scope only: operator manually disarmed new entries
  halted: boolean;         // true => new entries must be blocked
  reason?: string;
}

function parseLimit(raw: unknown): number {
  const n = Number(String(raw ?? '').trim());
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Daily-loss kill-switch. Once a scope's realized P&L for the current ET session
 * falls to or below the negative of the configured limit, new ENTRIES are halted
 * (existing exits/closes are never blocked). The limit is the global admin setting
 * `daily_loss_limit_dollars`; 0 / empty disables the switch.
 */
export class KillSwitchService {
  static readonly SETTING_KEY = 'daily_loss_limit_dollars';
  static readonly DISARM_KEY = 'live_trading_disarmed';
  private static lastHaltBroadcastAt = new Map<string, number>();
  /** Cached GET payload per scope/user; invalidated on arm/disarm and on halt flips. */
  static readonly STATUS_CACHE_TTL_SECONDS = Number(process.env.KILL_SWITCH_CACHE_TTL_SECONDS || 5);
  private static redisClient: { get: (k: string) => Promise<string | null>; set: (k: string, v: string, ttl?: number) => Promise<void>; del: (k: string) => Promise<void> } = defaultRedis;
  private static openPnlMemo = new Map<string, { at: number; value: number }>();
  private static readonly OPEN_PNL_MEMO_MS = 2000;
  private static lastHaltedByKey = new Map<string, boolean>();

  static statusCacheKey(scope: KillSwitchScope, userId?: number) {
    return `KILL_SWITCH:${scope}:${userId ?? 'shared'}`;
  }

  /** Test seam. */
  static useRedis(client: typeof KillSwitchService.redisClient | null) {
    KillSwitchService.redisClient = client || defaultRedis;
    KillSwitchService.openPnlMemo.clear();
    KillSwitchService.lastHaltedByKey.clear();
  }

  static async invalidateStatusCache(scope: KillSwitchScope, userId?: number) {
    await KillSwitchService.redisClient.del(KillSwitchService.statusCacheKey(scope, userId));
    KillSwitchService.openPnlMemo.delete(`${scope}:${userId ?? 'shared'}`);
  }

  /** Persist the manual live disarm flag (shared by the kill-switch and flatten-all routes). */
  static async setLiveDisarmed(pg: any, userId: number, disarmed: boolean): Promise<void> {
    await pg.query(
      `INSERT INTO settings (user_id, key, value, updated_at)
       VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
       ON CONFLICT (user_id, key) DO UPDATE
       SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
      [userId, KillSwitchService.DISARM_KEY, disarmed ? 'true' : 'false']
    );
    // A disarm must be visible on the very next read: drop the cached status.
    await KillSwitchService.invalidateStatusCache('live', userId);
  }

  // Statuses that still carry live option exposure whose loss is not yet realized.
  private static readonly OPEN_EXPOSURE_STATUSES = [
    'OPEN', 'PARTIALLY_FILLED', 'PENDING_EXIT', 'PENDING_TRIM', 'STOP_TRIGGERED'
  ];

  // Reads the disarm flag straight from Postgres, bypassing the settings cache:
  // a disarm must bite on the very next entry attempt, not after the cache TTL.
  static async isLiveTradingDisarmed(pg: any): Promise<boolean> {
    const { rows } = await pg.query(
      `SELECT value FROM settings
        WHERE key = $1 AND value IS NOT NULL AND value != ''
        ORDER BY updated_at DESC
        LIMIT 1`,
      [KillSwitchService.DISARM_KEY]
    );
    return String(rows[0]?.value || '').trim().toLowerCase() === 'true';
  }

  // Unrealized P&L of positions that still carry exposure, at their last recorded
  // mark. On short-dated, day-traded options the open drawdown IS the risk — a halt that only counts realized
  // P&L reports "fine" while the account bleeds in open premium.
  /** dayOpenPnl memoized for ~2s per scope/user to absorb evaluation bursts. */
  static async dayOpenPnlMemoized(pg: any, scope: KillSwitchScope, userId?: number): Promise<number> {
    const key = `${scope}:${userId ?? 'shared'}`;
    const hit = KillSwitchService.openPnlMemo.get(key);
    const now = Date.now();
    if (hit && now - hit.at < KillSwitchService.OPEN_PNL_MEMO_MS) return hit.value;
    const value = await KillSwitchService.dayOpenPnl(pg, scope, userId);
    KillSwitchService.openPnlMemo.set(key, { at: now, value });
    return value;
  }

  static async dayOpenPnl(pg: any, scope: KillSwitchScope, userId?: number): Promise<number> {
    if (scope === 'paper') {
      const { rows } = await pg.query(
        `SELECT COALESCE(SUM((current_price - entry_price) * quantity * 100
                 * CASE WHEN UPPER(COALESCE(entry_action, '')) = 'SELL_TO_OPEN' THEN -1 ELSE 1 END), 0)::float8 AS pnl
           FROM positions
          WHERE paper_account_id = $1
            AND status = ANY($2)
            AND current_price IS NOT NULL
            AND entry_price IS NOT NULL`,
        [SHARED_PAPER_ACCOUNT_ID, KillSwitchService.OPEN_EXPOSURE_STATUSES]
      );
      return Number(rows[0]?.pnl || 0);
    }
    if (userId == null || !Number.isFinite(Number(userId))) {
      throw new Error('KillSwitchService: a userId is required for live scope');
    }
    const { rows } = await pg.query(
      `SELECT COALESCE(SUM((current_price - entry_price) * quantity * 100
               * CASE WHEN UPPER(COALESCE(entry_action, '')) = 'SELL_TO_OPEN' THEN -1 ELSE 1 END), 0)::float8 AS pnl
         FROM positions
        WHERE user_id = $1
          AND status = ANY($2)
          AND COALESCE(is_simulated, false) = false
          AND COALESCE(execution_broker, '') <> 'system_paper'
          AND current_price IS NOT NULL
          AND entry_price IS NOT NULL`,
      [userId, KillSwitchService.OPEN_EXPOSURE_STATUSES]
    );
    return Number(rows[0]?.pnl || 0);
  }

  // Realized P&L booked today (ET) for the given scope. Only CLOSED positions are
  // summed: their realized_pnl is final and their updated_at is the close time, so
  // this reflects P&L actually realized today — not cumulative lifetime P&L of any
  // still-open position that merely got re-priced today.
  static async dayRealizedPnl(pg: any, scope: KillSwitchScope, userId?: number): Promise<number> {
    if (scope === 'paper') {
      const { rows } = await pg.query(
        `SELECT COALESCE(SUM(realized_pnl), 0)::float8 AS pnl
           FROM positions
          WHERE paper_account_id = $1
            AND status = 'CLOSED'
            AND realized_pnl IS NOT NULL
            AND (updated_at AT TIME ZONE 'America/New_York')::date
                = (NOW() AT TIME ZONE 'America/New_York')::date`,
        [SHARED_PAPER_ACCOUNT_ID]
      );
      return Number(rows[0]?.pnl || 0);
    }
    if (userId == null || !Number.isFinite(Number(userId))) {
      // Fail loud: a live kill-switch with no user would silently match no rows
      // (WHERE user_id = NULL) and disable the safety control.
      throw new Error('KillSwitchService: a userId is required for live scope');
    }
    const { rows } = await pg.query(
      `SELECT COALESCE(SUM(realized_pnl), 0)::float8 AS pnl
         FROM positions
        WHERE user_id = $1
          AND status = 'CLOSED'
          AND COALESCE(is_simulated, false) = false
          AND COALESCE(execution_broker, '') <> 'system_paper'
          AND realized_pnl IS NOT NULL
          AND (updated_at AT TIME ZONE 'America/New_York')::date
              = (NOW() AT TIME ZONE 'America/New_York')::date`,
      [userId]
    );
    return Number(rows[0]?.pnl || 0);
  }

  /**
   * Evaluate the kill switch. `options.cache` serves the Redis-cached status
   * (short TTL, invalidated on arm/disarm and halt flips) — for UI reads.
   * Execution paths call without it and always compute fresh.
   */
  static async evaluate(pg: any, scope: KillSwitchScope, userId?: number, options: { cache?: boolean } = {}): Promise<KillSwitchStatus> {
    const cacheKey = KillSwitchService.statusCacheKey(scope, userId);
    if (options.cache) {
      try {
        const cached = await KillSwitchService.redisClient.get(cacheKey);
        if (cached) {
          const parsed = JSON.parse(cached);
          if (parsed && typeof parsed === 'object' && parsed.scope === scope) return parsed as KillSwitchStatus;
        }
      } catch { /* cache miss */ }
    }
    const status = await KillSwitchService.evaluateFresh(pg, scope, userId);
    try {
      await KillSwitchService.redisClient.set(cacheKey, JSON.stringify(status), KillSwitchService.STATUS_CACHE_TTL_SECONDS);
    } catch { /* ignore */ }
    return status;
  }

  private static async evaluateFresh(pg: any, scope: KillSwitchScope, userId?: number): Promise<KillSwitchStatus> {
    const settings = await getGlobalSettings(pg);
    const limit = parseLimit(settings[KillSwitchService.SETTING_KEY]);
    const enabled = limit > 0;
    const disarmed = scope === 'live' ? await KillSwitchService.isLiveTradingDisarmed(pg) : false;
    // Skip the P&L queries entirely when disabled.
    const [dayRealizedPnl, dayOpenPnl] = enabled
      ? await Promise.all([
          KillSwitchService.dayRealizedPnl(pg, scope, userId),
          KillSwitchService.dayOpenPnlMemoized(pg, scope, userId)
        ])
      : [0, 0];
    const dayTotalPnl = dayRealizedPnl + dayOpenPnl;
    const lossHalted = enabled && dayTotalPnl <= -limit;
    const halted = lossHalted || disarmed;
    let reason: string | undefined;
    if (disarmed) {
      reason = 'Live trading is manually disarmed. New entries are blocked until it is re-armed.';
    } else if (lossHalted) {
      reason = `Daily loss limit reached (realized ${dayRealizedPnl.toFixed(2)} + open ${dayOpenPnl.toFixed(2)} = ${dayTotalPnl.toFixed(2)} <= -${limit.toFixed(2)}). New entries are halted for the rest of the session.`;
    }
    const status: KillSwitchStatus = {
      scope,
      enabled,
      limit,
      dayRealizedPnl,
      dayOpenPnl,
      dayTotalPnl,
      disarmed,
      halted,
      reason
    };
    const haltKey = `${scope}:${userId ?? 'shared'}`;
    const previouslyHalted = KillSwitchService.lastHaltedByKey.get(haltKey);
    KillSwitchService.lastHaltedByKey.set(haltKey, halted);
    if (previouslyHalted !== undefined && previouslyHalted !== halted) {
      // Halt flipped: make sure no stale cached status survives.
      await KillSwitchService.invalidateStatusCache(scope, userId);
    }
    if (lossHalted) {
      // Push the halt to the operator UI, at most once per 30s per scope/user.
      const key = haltKey;
      const now = Date.now();
      const last = KillSwitchService.lastHaltBroadcastAt.get(key) || 0;
      if (now - last > 30_000) {
        KillSwitchService.lastHaltBroadcastAt.set(key, now);
        publishRealtime('KILL_SWITCH', { [scope]: status }, { userId: scope === 'live' ? userId ?? null : null });
      }
    }
    return status;
  }
}
