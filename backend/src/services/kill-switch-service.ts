import { getGlobalSettings } from '../lib/settings-utils';
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
  // mark. On 0DTE the open drawdown IS the risk — a halt that only counts realized
  // P&L reports "fine" while the account bleeds in open premium.
  static async dayOpenPnl(pg: any, scope: KillSwitchScope, userId?: number): Promise<number> {
    if (scope === 'paper') {
      const { rows } = await pg.query(
        `SELECT COALESCE(SUM((current_price - entry_price) * quantity * 100), 0)::float8 AS pnl
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
      `SELECT COALESCE(SUM((current_price - entry_price) * quantity * 100), 0)::float8 AS pnl
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

  static async evaluate(pg: any, scope: KillSwitchScope, userId?: number): Promise<KillSwitchStatus> {
    const settings = await getGlobalSettings(pg);
    const limit = parseLimit(settings[KillSwitchService.SETTING_KEY]);
    const enabled = limit > 0;
    const disarmed = scope === 'live' ? await KillSwitchService.isLiveTradingDisarmed(pg) : false;
    // Skip the P&L queries entirely when disabled.
    const [dayRealizedPnl, dayOpenPnl] = enabled
      ? await Promise.all([
          KillSwitchService.dayRealizedPnl(pg, scope, userId),
          KillSwitchService.dayOpenPnl(pg, scope, userId)
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
    return {
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
  }
}
