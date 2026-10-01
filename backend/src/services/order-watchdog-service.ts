import { FastifyInstance } from 'fastify';
import { DiscordAlertService } from './discord-alert-service';
import { SnaptradeService } from './snaptrade-service';
import { TradeLifecycleService } from './trade-lifecycle-service';
import { TradeRedisService } from './trade-redis-service';

type WatchdogSummary = {
  checked: number;
  entryStale: number;
  entryCancelRequested: number;
  entryCancelExhausted: number;
  entryAbandoned: number;
  exitStale: number;
  stillPending: number;
  errors: string[];
};

type CancelClient = { cancelOptionOrder(userId: number, accountId: string, brokerOrderId: string): Promise<any> };

/**
 * Keeps the single swing slot from being held hostage by an order that never
 * resolves. The slot query counts PENDING_ORDER rows, so an entry that sits
 * unfilled (or whose broker id was never learned) blocks every future trade
 * until a human intervenes. This service turns those states into bounded,
 * audited actions:
 *
 *  - unfilled protected LIMIT entry with a broker id  -> cancel at the broker
 *    (default after 120s; re-requested every 60s, at most 3 attempts, then a
 *    critical alert). The pending-order sync reconciles the cancel (position
 *    CLOSED, signal released) or the fill if it raced us.
 *  - entry with NO broker id whose broker sync keeps reporting UNKNOWN for
 *    15 minutes -> abandoned locally and the signal claim released. If the
 *    order did fill unseen, the broker position reconciler adopts it.
 *  - MARKET exit still pending after 120s -> critical alert (a market order
 *    that does not fill is a broker/session problem the operator must see).
 */
export class OrderWatchdogService {
  static readonly DEFAULT_ENTRY_UNFILLED_CANCEL_SECONDS = 120;
  static readonly DEFAULT_ENTRY_CANCEL_RETRY_SECONDS = 60;
  static readonly DEFAULT_ENTRY_CANCEL_MAX_ATTEMPTS = 3;
  static readonly DEFAULT_ENTRY_UNRESOLVED_RELEASE_SECONDS = 900;
  static readonly DEFAULT_EXIT_MARKET_STALE_SECONDS = 120;

  private entryStaleMs: number;
  private entryUnfilledCancelMs: number;
  private entryCancelRetryMs: number;
  private entryCancelMaxAttempts: number;
  private entryUnresolvedReleaseMs: number;
  private exitMarketStaleMs: number;
  /** Seam for tests; production uses a fresh SnaptradeService per cancel. */
  public cancelClientFactory: () => CancelClient = () => new SnaptradeService(this.fastify);
  public now: () => number = () => Date.now();

  constructor(private fastify: FastifyInstance) {
    const seconds = (name: string, fallback: number, allowZero = false) => {
      const raw = Number(process.env[name]);
      if (!Number.isFinite(raw)) return fallback;
      if (raw <= 0) return allowZero ? 0 : fallback;
      return raw;
    };
    this.entryStaleMs = seconds('ORDER_WATCHDOG_ENTRY_STALE_SECONDS', 180) * 1000;
    // 0 disables broker cancels (flag-only mode, the pre-2026-10 behaviour).
    this.entryUnfilledCancelMs = seconds('ENTRY_UNFILLED_CANCEL_SECONDS', OrderWatchdogService.DEFAULT_ENTRY_UNFILLED_CANCEL_SECONDS, true) * 1000;
    this.entryCancelRetryMs = seconds('ENTRY_CANCEL_RETRY_SECONDS', OrderWatchdogService.DEFAULT_ENTRY_CANCEL_RETRY_SECONDS) * 1000;
    this.entryCancelMaxAttempts = Math.max(1, Math.floor(seconds('ENTRY_CANCEL_MAX_ATTEMPTS', OrderWatchdogService.DEFAULT_ENTRY_CANCEL_MAX_ATTEMPTS)));
    this.entryUnresolvedReleaseMs = seconds('ENTRY_UNRESOLVED_RELEASE_SECONDS', OrderWatchdogService.DEFAULT_ENTRY_UNRESOLVED_RELEASE_SECONDS, true) * 1000;
    this.exitMarketStaleMs = seconds('EXIT_MARKET_STALE_SECONDS', OrderWatchdogService.DEFAULT_EXIT_MARKET_STALE_SECONDS) * 1000;
  }

  /** Effective knobs, for the startup banner and health surfaces. */
  config() {
    return {
      entryStaleSeconds: this.entryStaleMs / 1000,
      entryUnfilledCancelSeconds: this.entryUnfilledCancelMs / 1000,
      entryCancelRetrySeconds: this.entryCancelRetryMs / 1000,
      entryCancelMaxAttempts: this.entryCancelMaxAttempts,
      entryUnresolvedReleaseSeconds: this.entryUnresolvedReleaseMs / 1000,
      exitMarketStaleSeconds: this.exitMarketStaleMs / 1000
    };
  }

  async run(): Promise<WatchdogSummary> {
    const { rows } = await this.fastify.pg.query(
      `SELECT id, user_id, symbol, option_type, strike_price, expiration_date, status, execution_status, exit_order_type, created_at, exit_requested_at,
              broker_order_id, broker_exit_order_id, account_id, execution_account_id, notes, signal_id,
              entry_cancel_attempts, entry_cancel_requested_at, last_broker_order_status, last_broker_sync_at
       FROM positions
       WHERE execution_broker = 'wealthsimple_snaptrade'
         AND (
           status = 'PENDING_ORDER'
           OR (status = 'OPEN' AND execution_status IN ('PENDING_EXIT', 'PENDING_TRIM'))
         )`
    );

    const summary: WatchdogSummary = {
      checked: rows.length,
      entryStale: 0,
      entryCancelRequested: 0,
      entryCancelExhausted: 0,
      entryAbandoned: 0,
      exitStale: 0,
      stillPending: 0,
      errors: []
    };

    for (const row of rows) {
      try {
        if (row.status === 'PENDING_ORDER') {
          await this.handlePendingEntry(row, summary);
          continue;
        }
        await this.handlePendingExit(row, summary);
      } catch (err: any) {
        const message = `Position ${row.id}: ${err.message || String(err)}`;
        summary.errors.push(message);
        this.fastify.log.warn(`[OrderWatchdog] ${message}`);
      }
    }

    return summary;
  }

  private async handlePendingEntry(row: any, summary: WatchdogSummary): Promise<void> {
    const now = this.now();
    const createdAtMs = new Date(row.created_at).getTime();
    const ageMs = Number.isFinite(createdAtMs) ? now - createdAtMs : NaN;
    const brokerOrderId = String(row.broker_order_id || '').trim();
    const executionStatus = String(row.execution_status || '').toUpperCase();
    const brokerSaysFilled = ['FILLED', 'FILLED_FULLY', 'EXECUTED'].includes(executionStatus)
      || ['FILLED', 'FILLED_FULLY', 'EXECUTED'].includes(String(row.last_broker_order_status || '').toUpperCase());

    // 1. Unfilled entry WITH a broker id: cancel at the broker, bounded.
    //    Never cancel what the broker already reports as filled — that row
    //    needs fill reconciliation, which the pending-order sync owns.
    if (this.entryUnfilledCancelMs > 0 && brokerOrderId && !brokerSaysFilled && Number.isFinite(ageMs) && ageMs > this.entryUnfilledCancelMs) {
      const attempts = Number(row.entry_cancel_attempts || 0);
      const lastRequestMs = row.entry_cancel_requested_at ? new Date(row.entry_cancel_requested_at).getTime() : NaN;
      const retryDue = !Number.isFinite(lastRequestMs) || now - lastRequestMs >= this.entryCancelRetryMs;
      if (attempts >= this.entryCancelMaxAttempts) {
        if (retryDue) await this.alertCancelExhausted(row, attempts);
        summary.entryCancelExhausted += 1;
        // Fall through to the stale marking below so the row is also flagged.
      } else if (retryDue) {
        const accountId = String(row.execution_account_id || row.account_id || '').trim();
        if (accountId) {
          await this.requestEntryCancel(row, accountId, brokerOrderId, attempts, ageMs);
          summary.entryCancelRequested += 1;
          return;
        }
        this.fastify.log.warn(`[OrderWatchdog] Position ${row.id} has an unfilled broker order but no account id; cannot cancel.`);
      } else {
        summary.stillPending += 1;
        return;
      }
    }

    // 2. Entry with NO broker id that the sync has never been able to match:
    //    release the slot locally after the grace period. The reconciler will
    //    adopt the position if the order did fill unseen.
    if (
      this.entryUnresolvedReleaseMs > 0
      && !brokerOrderId
      && Number.isFinite(ageMs)
      && ageMs > this.entryUnresolvedReleaseMs
      && String(row.last_broker_order_status || '').toUpperCase() === 'UNKNOWN'
      && row.last_broker_sync_at
    ) {
      const abandoned = await this.abandonUnresolvedEntry(row, ageMs);
      if (abandoned) {
        summary.entryAbandoned += 1;
        return;
      }
    }

    // 3. Flag-only stale marking (unchanged behaviour): surface the state and
    //    page once; the cancel/abandon paths above act on it.
    if (Number.isFinite(ageMs) && ageMs > this.entryStaleMs) {
      const staleDecision = TradeLifecycleService.staleEntryDecision(row.execution_status);
      const staleUpdate = await this.fastify.pg.query(
        `UPDATE positions
         SET execution_status = $1,
             execution_error = $2,
             notes = COALESCE(notes, '') || $3,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $4
           AND status = 'PENDING_ORDER'
           AND NOT (COALESCE(execution_status, '') = ANY($5::text[]))`,
        [
          staleDecision.executionStatus,
          staleDecision.message,
          ` [Watchdog marked ${staleDecision.noteLabel} after ${Math.round(this.entryStaleMs / 1000)}s]`,
          row.id,
          TradeLifecycleService.FINAL_ENTRY_EXECUTION_STATUSES.filter(status => !['FILLED', 'FILLED_FULLY'].includes(status))
        ]
      );
      if (staleUpdate.rowCount === 0) {
        summary.stillPending += 1;
        return;
      }
      try {
        await TradeRedisService.recordEvent(this.fastify.pg, {
          userId: Number(row.user_id),
          positionId: row.id,
          eventType: 'ENTRY_STATE_CHANGED',
          message: staleDecision.message,
          metadata: {
            from: row.execution_status || null,
            to: staleDecision.executionStatus,
            state: staleDecision.state,
            source: 'order-watchdog',
            staleAfterSeconds: Math.round(this.entryStaleMs / 1000)
          }
        });
      } catch (err: any) {
        this.fastify.log.warn(`[OrderWatchdog] Failed to record entry state event for position ${row.id}: ${err.message || String(err)}`);
      }
      await new DiscordAlertService(this.fastify).send({
        userId: Number(row.user_id),
        title: 'Entry order stale',
        message: `Position #${row.id} ${row.symbol} ${row.option_type} ${Number(row.strike_price)} has been pending for more than ${Math.round(this.entryStaleMs / 1000)} seconds. Verify Wealthsimple before placing another entry.`,
        severity: 'warning',
        category: 'stale-entry',
        tradeId: row.id,
        dedupeKey: `entry-stale:${row.id}`,
        dedupeSeconds: 3600
      });
      summary.entryStale += 1;
      return;
    }
    summary.stillPending += 1;
  }

  private async requestEntryCancel(row: any, accountId: string, brokerOrderId: string, attempts: number, ageMs: number): Promise<void> {
    let cancelStatus = 'REQUEST_FAILED';
    let cancelError: string | null = null;
    try {
      const cancelRecord = await this.cancelClientFactory().cancelOptionOrder(Number(row.user_id), accountId, brokerOrderId);
      cancelStatus = String((cancelRecord as any)?.status || 'UNKNOWN').toUpperCase();
    } catch (err: any) {
      cancelError = err?.message || String(err);
      this.fastify.log.warn(`[OrderWatchdog] Cancel request for position ${row.id} failed: ${cancelError}`);
    }
    const attemptNumber = attempts + 1;
    await this.fastify.pg.query(
      `UPDATE positions
       SET entry_cancel_attempts = $1,
           entry_cancel_requested_at = CURRENT_TIMESTAMP,
           notes = COALESCE(notes, '') || $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3
         AND status = 'PENDING_ORDER'`,
      [
        attemptNumber,
        ` [Entry cancel ${attemptNumber}/${this.entryCancelMaxAttempts}: unfilled after ${Math.round(ageMs / 1000)}s (broker status ${cancelStatus}${cancelError ? `: ${cancelError}` : ''})]`,
        row.id
      ]
    );
    this.fastify.log.info(`[OrderWatchdog] Entry cancel ${attemptNumber}/${this.entryCancelMaxAttempts} requested for position ${row.id} (${row.symbol}) after ${Math.round(ageMs / 1000)}s unfilled; broker status ${cancelStatus}.`);
    try {
      await TradeRedisService.recordEvent(this.fastify.pg, {
        userId: Number(row.user_id),
        positionId: row.id,
        eventType: 'ENTRY_CANCEL_REQUESTED',
        message: `Unfilled entry: broker cancel requested (attempt ${attemptNumber}/${this.entryCancelMaxAttempts}, broker status ${cancelStatus})`,
        metadata: {
          attempt: attemptNumber,
          maxAttempts: this.entryCancelMaxAttempts,
          brokerOrderId,
          brokerStatus: cancelStatus,
          error: cancelError,
          unfilledSeconds: Math.round(ageMs / 1000),
          source: 'order-watchdog'
        }
      });
    } catch (err: any) {
      this.fastify.log.warn(`[OrderWatchdog] Failed to record cancel event for position ${row.id}: ${err.message || String(err)}`);
    }
  }

  private async alertCancelExhausted(row: any, attempts: number): Promise<void> {
    await new DiscordAlertService(this.fastify).send({
      userId: Number(row.user_id),
      title: 'Entry cancel failed — swing slot blocked',
      message: `Position #${row.id} ${row.symbol} ${row.option_type} ${Number(row.strike_price)} is still PENDING_ORDER after ${attempts} broker cancel requests. The swing slot stays blocked until this order is resolved at Wealthsimple.`,
      severity: 'critical',
      category: 'entry-cancel-failed',
      tradeId: row.id,
      dedupeKey: `entry-cancel-failed:${row.id}`,
      dedupeSeconds: 30 * 60
    });
  }

  private async abandonUnresolvedEntry(row: any, ageMs: number): Promise<boolean> {
    const message = `Entry never received a broker order id and the broker sync reported UNKNOWN for ${Math.round(ageMs / 60000)} min; abandoned locally to free the swing slot. If the order filled unseen, the broker position reconciler will adopt it.`;
    const update = await this.fastify.pg.query(
      `UPDATE positions
       SET status = 'CLOSED',
           execution_status = 'ENTRY_ABANDONED',
           execution_error = $1,
           notes = COALESCE(notes, '') || $2,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $3
         AND status = 'PENDING_ORDER'
         AND broker_order_id IS NULL`,
      [message, ` [Watchdog abandoned unresolved entry after ${Math.round(ageMs / 1000)}s]`, row.id]
    );
    if (update.rowCount === 0) return false;
    if (row.signal_id) {
      await this.fastify.pg.query(
        `UPDATE signal_user_executions
         SET status = 'CANCELLED',
             execution_status = 'ENTRY_ABANDONED',
             execution_error = $1,
             updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $2
           AND signal_id = $3
           AND status <> 'EXECUTED'`,
        [message, Number(row.user_id), Number(row.signal_id)]
      );
    }
    try {
      await TradeRedisService.recordEvent(this.fastify.pg, {
        userId: Number(row.user_id),
        positionId: row.id,
        eventType: 'ENTRY_STATE_CHANGED',
        message,
        metadata: { from: row.execution_status || null, to: 'ENTRY_ABANDONED', state: 'ABANDONED', source: 'order-watchdog' }
      });
    } catch (err: any) {
      this.fastify.log.warn(`[OrderWatchdog] Failed to record abandon event for position ${row.id}: ${err.message || String(err)}`);
    }
    await new DiscordAlertService(this.fastify).send({
      userId: Number(row.user_id),
      title: 'Unresolved entry abandoned',
      message: `Position #${row.id} ${row.symbol} ${row.option_type} ${Number(row.strike_price)}: ${message}`,
      severity: 'warning',
      category: 'entry-abandoned',
      tradeId: row.id,
      dedupeKey: `entry-abandoned:${row.id}`,
      dedupeSeconds: 6 * 3600
    });
    this.fastify.log.warn(`[OrderWatchdog] ${message} (position ${row.id})`);
    return true;
  }

  private async handlePendingExit(row: any, summary: WatchdogSummary): Promise<void> {
    // LIMIT exits are escalated (cancel + re-arm) by the SnapTrade pending
    // sync, which has the broker order context. A MARKET exit has nothing to
    // escalate to: if it is still pending after the grace period the broker
    // session or the contract itself is the problem, so page immediately.
    const orderType = String(row.exit_order_type || '').toUpperCase();
    const requestedAtMs = row.exit_requested_at ? new Date(row.exit_requested_at).getTime() : NaN;
    if (orderType === 'MARKET' && Number.isFinite(requestedAtMs) && this.now() - requestedAtMs > this.exitMarketStaleMs) {
      await new DiscordAlertService(this.fastify).send({
        userId: Number(row.user_id),
        title: 'MARKET exit not filled',
        message: `Position #${row.id} ${row.symbol} ${row.option_type} ${Number(row.strike_price)}: MARKET exit requested ${Math.round((this.now() - requestedAtMs) / 1000)}s ago is still pending (broker order ${row.broker_exit_order_id || 'unknown'}). Check Wealthsimple now.`,
        severity: 'critical',
        category: 'exit-stale-market',
        tradeId: row.id,
        dedupeKey: `exit-stale-market:${row.id}`,
        dedupeSeconds: 30 * 60
      });
      summary.exitStale += 1;
      return;
    }
    summary.stillPending += 1;
  }
}
