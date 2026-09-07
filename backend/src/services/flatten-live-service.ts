import { KillSwitchService } from './kill-switch-service';
import { TradeLifecycleService } from './trade-lifecycle-service';
import { TradeRedisService } from './trade-redis-service';

export type FlattenLiveSummary = {
  requested: number;
  submitted: number;
  skipped: Array<{ id: number; reason: string }>;
  disarmed: boolean;
};

export type FlattenLiveDeps = {
  pg: any;
  poller: { submitSnapTradeExit: (position: any, orderType: 'MARKET' | 'LIMIT', limitPrice: string | undefined, trigger: any, quantity?: number) => Promise<boolean> } | null | undefined;
  recordEvent?: typeof TradeRedisService.recordEvent;
  setLiveDisarmed?: typeof KillSwitchService.setLiveDisarmed;
  log?: { warn?: (msg: string) => void; info?: (msg: string) => void };
};

/**
 * Operator "flatten all live" — one MARKET exit per open live position that is
 * not already leaving, then (optionally) disarm live entries. Idempotent:
 * positions with a pending or under-review exit are reported as skipped.
 */
export async function flattenLivePositions(
  deps: FlattenLiveDeps,
  input: { userId: number; disarm: boolean }
): Promise<FlattenLiveSummary> {
  const recordEvent = deps.recordEvent || ((db: any, event: any) => TradeRedisService.recordEvent(db, event));
  const setLiveDisarmed = deps.setLiveDisarmed || ((pg: any, userId: number, disarmed: boolean) => KillSwitchService.setLiveDisarmed(pg, userId, disarmed));
  // Disarm FIRST so the autonomous adapter cannot open a fresh position in the
  // seconds it takes to submit the exits below.
  let disarmed = false;
  if (input.disarm) {
    await setLiveDisarmed(deps.pg, input.userId, true);
    disarmed = true;
  }
  const { rows } = await deps.pg.query(
    `SELECT *
       FROM positions
      WHERE user_id = $1
        AND status = 'OPEN'
        AND COALESCE(is_simulated, false) = false
        AND execution_broker = 'wealthsimple_snaptrade'
      ORDER BY created_at ASC`,
    [input.userId]
  );
  const summary: FlattenLiveSummary = { requested: rows.length, submitted: 0, skipped: [], disarmed: false };
  if (!deps.poller?.submitSnapTradeExit) {
    for (const position of rows) summary.skipped.push({ id: Number(position.id), reason: 'exit engine unavailable' });
  } else {
    for (const position of rows) {
      const executionStatus = String(position.execution_status || '');
      if (TradeLifecycleService.isPendingExitStatus(executionStatus) || TradeLifecycleService.isBrokerExitReviewStatus(executionStatus)) {
        summary.skipped.push({ id: Number(position.id), reason: `exit already ${executionStatus}` });
        continue;
      }
      let ok = false;
      try {
        ok = await deps.poller.submitSnapTradeExit(position, 'MARKET', undefined, 'MANUAL_FLATTEN_ALL', Number(position.quantity));
      } catch (err: any) {
        deps.log?.warn?.(`[FlattenLive] position ${position.id}: ${err?.message || String(err)}`);
      }
      if (ok) {
        summary.submitted += 1;
        try {
          await recordEvent(deps.pg, {
            userId: input.userId,
            positionId: Number(position.id),
            signalId: position.signal_id ? Number(position.signal_id) : undefined,
            eventType: 'MANUAL_FLATTEN_ALL',
            message: `Operator flatten-all: MARKET exit submitted for ${position.symbol} ${position.option_type} ${position.strike_price}`,
            metadata: { quantity: Number(position.quantity), disarm: input.disarm }
          });
        } catch (err: any) {
          deps.log?.warn?.(`[FlattenLive] event record failed for ${position.id}: ${err?.message || String(err)}`);
        }
      } else {
        summary.skipped.push({ id: Number(position.id), reason: 'exit not submitted (see position notes)' });
      }
    }
  }
  summary.disarmed = disarmed;
  return summary;
}
