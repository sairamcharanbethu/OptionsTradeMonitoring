/**
 * Trading-aware readiness, separate from the Docker `/ready` probe (which stays
 * DB-only so the backend keeps running to alert during feed outages).
 *
 * Two kinds of problems are distinguished on purpose:
 *  - `failing`  = INTERNAL WEDGE: something inside this process stopped doing
 *    its job while its dependencies are fine (event loop blocked, exit poller
 *    not completing, broker sync not running). A restart fixes these, so the
 *    process watchdog exits on them.
 *  - `degraded` = EXTERNAL: IBKR, ZeroGEX, Redis, Postgres, exit monitor down.
 *    A restart cannot fix these; the system health evaluator pages instead.
 */
export type ReadinessSnapshot = {
  dbOk: boolean;
  redisReady: boolean;
  marketOpen: boolean;
  openLivePositions: number;
  liveEntriesReady: boolean;
  poller: { pollingEnabled: boolean; intervalSeconds: number; lastPollCompletedAt: string | null; lastPollStartedAt: string | null } | null;
  exitMonitorStatus: string | null;
  ibkrStreamConnected: boolean | null;
  pendingSync: { intervalSeconds: number; lastRunAt: string | null; running: boolean } | null;
  eventLoopLagMs: number | null;
  processUptimeMs: number;
};

export type ReadinessResult = {
  ready: boolean;
  failing: string[];
  degraded: string[];
  evaluatedAt: string;
};

export const EVENT_LOOP_BLOCKED_MS = 90_000;
/** Grace after boot before internal-wedge rules apply (services start lazily). */
export const STARTUP_GRACE_MS = 2 * 60 * 1000;

const ageMs = (iso: string | null | undefined, nowMs: number): number | null => {
  if (!iso) return null;
  const ts = new Date(iso).getTime();
  return Number.isFinite(ts) ? Math.max(0, nowMs - ts) : null;
};

export function evaluateReadiness(snapshot: ReadinessSnapshot, now: Date = new Date()): ReadinessResult {
  const nowMs = now.getTime();
  const failing: string[] = [];
  const degraded: string[] = [];
  const pastGrace = snapshot.processUptimeMs >= STARTUP_GRACE_MS;

  // --- internal wedges (restart fixes) ---------------------------------
  if (snapshot.eventLoopLagMs !== null && snapshot.eventLoopLagMs >= EVENT_LOOP_BLOCKED_MS) {
    failing.push(`event loop blocked for ${Math.round(snapshot.eventLoopLagMs / 1000)}s`);
  }
  if (pastGrace && snapshot.dbOk && snapshot.poller && snapshot.poller.pollingEnabled) {
    const interval = Math.max(60, snapshot.poller.intervalSeconds) * 1000;
    const completedAge = ageMs(snapshot.poller.lastPollCompletedAt, nowMs);
    const startedAge = ageMs(snapshot.poller.lastPollStartedAt, nowMs);
    if (completedAge === null) {
      // Never completed since boot and well past the grace period.
      failing.push('exit poller has never completed a sweep');
    } else if (completedAge > interval * 3) {
      // A sweep that started but never finished is the classic hang; one that
      // is not even being scheduled is a dead timer. Both are internal.
      failing.push(`exit poller last completed ${Math.round(completedAge / 1000)}s ago (interval ${interval / 1000}s)${startedAge !== null && startedAge < completedAge ? ', a sweep is stuck in flight' : ''}`);
    }
  }
  if (pastGrace && snapshot.dbOk && snapshot.pendingSync) {
    const interval = Math.max(15, snapshot.pendingSync.intervalSeconds) * 1000;
    const age = ageMs(snapshot.pendingSync.lastRunAt, nowMs);
    if (age === null) failing.push('broker order sync has never run');
    else if (age > interval * 4) failing.push(`broker order sync last ran ${Math.round(age / 1000)}s ago (interval ${interval / 1000}s)`);
  }

  // --- external degradation (page, do not restart) ---------------------
  if (!snapshot.dbOk) degraded.push('postgres unreachable');
  if (!snapshot.redisReady) degraded.push('redis not ready');
  if (snapshot.ibkrStreamConnected === false) degraded.push('ibkr stream disconnected');
  const exitStatus = String(snapshot.exitMonitorStatus || '').toUpperCase();
  if (exitStatus && exitStatus !== 'UP') degraded.push(`exit monitor ${exitStatus}`);
  if (!snapshot.liveEntriesReady) degraded.push('live entries not yet enabled');

  // Ready = nothing wedged and, when we hold risk during the session, the exit
  // machinery is actually watching.
  const exitBlindWithRisk = snapshot.marketOpen && snapshot.openLivePositions > 0 && (exitStatus === 'DOWN' || !snapshot.dbOk);
  const ready = failing.length === 0 && !exitBlindWithRisk;
  return { ready, failing, degraded, evaluatedAt: now.toISOString() };
}
