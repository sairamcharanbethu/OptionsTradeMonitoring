import { FastifyInstance } from 'fastify';
import { DiscordAlertService } from './discord-alert-service';

type WatchdogSummary = {
  checked: number;
  entryStale: number;
  exitStale: number;
  stillPending: number;
  errors: string[];
};

export class OrderWatchdogService {
  private entryStaleMs: number;

  constructor(private fastify: FastifyInstance) {
    this.entryStaleMs = Number(process.env.ORDER_WATCHDOG_ENTRY_STALE_SECONDS || 180) * 1000;
  }

  async run(): Promise<WatchdogSummary> {
    const { rows } = await this.fastify.pg.query(
      `SELECT id, user_id, symbol, option_type, strike_price, expiration_date, status, execution_status, exit_order_type, created_at, exit_requested_at
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
      exitStale: 0,
      stillPending: 0,
      errors: []
    };

    for (const row of rows) {
      try {
        if (row.status === 'PENDING_ORDER') {
          const createdAtMs = new Date(row.created_at).getTime();
          if (Number.isFinite(createdAtMs) && Date.now() - createdAtMs > this.entryStaleMs) {
            const isProtectedLimitPending = row.execution_status === 'PENDING_RECONCILE';
            const nextExecutionStatus = isProtectedLimitPending ? 'ENTRY_RECONCILE_REQUIRED' : 'ENTRY_STALE';
            const executionError = isProtectedLimitPending
              ? 'Protected limit entry is still pending after watchdog timeout; broker reconciliation is required before another entry.'
              : 'Entry order is still pending after watchdog timeout; broker reconciliation is required before another entry.';
            const staleUpdate = await this.fastify.pg.query(
              `UPDATE positions
               SET execution_status = $1,
                   execution_error = $2,
                   notes = COALESCE(notes, '') || $3,
                   updated_at = CURRENT_TIMESTAMP
               WHERE id = $4
                 AND status = 'PENDING_ORDER'
                 AND COALESCE(execution_status, '') NOT IN ('EXECUTED', 'FILLED', 'FILLED_FULLY', 'ENTRY_STALE', 'ENTRY_RECONCILE_REQUIRED')`,
              [
                nextExecutionStatus,
                executionError,
                ` [Watchdog marked ${isProtectedLimitPending ? 'protected limit entry reconcile-required' : 'entry stale'} after ${Math.round(this.entryStaleMs / 1000)}s]`,
                row.id
              ]
            );
            if (staleUpdate.rowCount === 0) {
              summary.stillPending += 1;
              continue;
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
