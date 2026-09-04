import { FastifyInstance } from 'fastify';
import { DiscordAlertService } from './discord-alert-service';
import { SnaptradeService } from './snaptrade-service';
import { TradeLifecycleService } from './trade-lifecycle-service';
import { TradeRedisService } from './trade-redis-service';

type WatchdogSummary = {
  checked: number;
  entryStale: number;
  entryCancelRequested: number;
  exitStale: number;
  stillPending: number;
  errors: string[];
};

const PATIENT_ENTRY_CANCEL_NOTE = '[patient-entry cancel requested]';

export class OrderWatchdogService {
  private entryStaleMs: number;
  // Patient-entry mode (spread-drag work): when set, a protected LIMIT entry
  // that is still unfilled after this many seconds is CANCELED at the broker
  // instead of being chased — fill at our price or don't trade. The pending
  // order sync reconciles the cancel (position closed, signal released) or the
  // fill if it raced us. 0 disables (default): current behavior unchanged.
  // Pair with a lower entry_limit_offset_pct to run the mid-fill experiment
  // the UW backtest scored at PF 1.10 vs 0.96.
  private entryUnfilledCancelMs: number;

  constructor(private fastify: FastifyInstance) {
    this.entryStaleMs = Number(process.env.ORDER_WATCHDOG_ENTRY_STALE_SECONDS || 180) * 1000;
    this.entryUnfilledCancelMs = Math.max(0, Number(process.env.ENTRY_UNFILLED_CANCEL_SECONDS || 0)) * 1000;
  }

  async run(): Promise<WatchdogSummary> {
    const { rows } = await this.fastify.pg.query(
      `SELECT id, user_id, symbol, option_type, strike_price, expiration_date, status, execution_status, exit_order_type, created_at, exit_requested_at,
              broker_order_id, account_id, execution_account_id, notes
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
      exitStale: 0,
      stillPending: 0,
      errors: []
    };

    for (const row of rows) {
      try {
        if (row.status === 'PENDING_ORDER') {
          const createdAtMs = new Date(row.created_at).getTime();
          const patientCancelDue = this.entryUnfilledCancelMs > 0
            && row.execution_status === 'PENDING_RECONCILE'
            && Boolean(row.broker_order_id)
            && Number.isFinite(createdAtMs)
            && Date.now() - createdAtMs > this.entryUnfilledCancelMs
            && !String(row.notes || '').includes(PATIENT_ENTRY_CANCEL_NOTE);
          if (patientCancelDue) {
            const accountId = String(row.execution_account_id || row.account_id || '').trim();
            if (accountId) {
              const cancelRecord = await new SnaptradeService(this.fastify).cancelOptionOrder(
                Number(row.user_id), accountId, String(row.broker_order_id)
              );
              const cancelStatus = String((cancelRecord as any)?.status || 'UNKNOWN').toUpperCase();
              await this.fastify.pg.query(
                `UPDATE positions
                 SET notes = COALESCE(notes, '') || $1,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $2
                   AND status = 'PENDING_ORDER'`,
                [` ${PATIENT_ENTRY_CANCEL_NOTE} unfilled after ${Math.round(this.entryUnfilledCancelMs / 1000)}s (broker status ${cancelStatus})`, row.id]
              );
              this.fastify.log.info(`[OrderWatchdog] Patient-entry cancel requested for position ${row.id} (${row.symbol}) after ${Math.round(this.entryUnfilledCancelMs / 1000)}s unfilled; broker status ${cancelStatus}.`);
              summary.entryCancelRequested += 1;
              continue;
            }
          }
          if (Number.isFinite(createdAtMs) && Date.now() - createdAtMs > this.entryStaleMs) {
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
              continue;
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
          } else {
            summary.stillPending += 1;
          }
          continue;
        }

        // Exit stale decisions require broker order status context; SnapTrade reconciliation owns that path.
        summary.stillPending += 1;
      } catch (err: any) {
        const message = `Position ${row.id}: ${err.message || String(err)}`;
        summary.errors.push(message);
        this.fastify.log.warn(`[OrderWatchdog] ${message}`);
      }
    }

    return summary;
  }
}
