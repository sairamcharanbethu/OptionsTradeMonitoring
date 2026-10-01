import { evaluateReadiness, ReadinessSnapshot, STARTUP_GRACE_MS } from './trading-readiness';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

const NOW = new Date('2026-10-05T14:00:00.000Z');

function healthy(overrides: Partial<ReadinessSnapshot> = {}): ReadinessSnapshot {
  return {
    dbOk: true,
    redisReady: true,
    marketOpen: true,
    openLivePositions: 1,
    liveEntriesReady: true,
    poller: { pollingEnabled: true, intervalSeconds: 60, lastPollCompletedAt: new Date(NOW.getTime() - 30_000).toISOString(), lastPollStartedAt: new Date(NOW.getTime() - 31_000).toISOString() },
    exitMonitorStatus: 'UP',
    ibkrStreamConnected: true,
    pendingSync: { intervalSeconds: 60, lastRunAt: new Date(NOW.getTime() - 20_000).toISOString(), running: false },
    eventLoopLagMs: 0,
    processUptimeMs: STARTUP_GRACE_MS + 1,
    ...overrides
  };
}

function run() {
  console.log('Running trading-readiness tests...');

  const ok = evaluateReadiness(healthy(), NOW);
  assert(ok.ready && ok.failing.length === 0 && ok.degraded.length === 0, 'A healthy snapshot is ready with nothing failing');

  // Internal wedges -> failing (restart fixes).
  const lag = evaluateReadiness(healthy({ eventLoopLagMs: 120_000 }), NOW);
  assert(!lag.ready && lag.failing[0].includes('event loop blocked'), 'A blocked event loop is an internal wedge');
  const stalePoll = evaluateReadiness(healthy({ poller: { pollingEnabled: true, intervalSeconds: 60, lastPollCompletedAt: new Date(NOW.getTime() - 4 * 60_000).toISOString(), lastPollStartedAt: new Date(NOW.getTime() - 2 * 60_000).toISOString() } }), NOW);
  assert(!stalePoll.ready && stalePoll.failing[0].includes('exit poller last completed') && stalePoll.failing[0].includes('stuck in flight'), 'A poller sweep that never finished is an internal wedge');
  const neverPolled = evaluateReadiness(healthy({ poller: { pollingEnabled: true, intervalSeconds: 60, lastPollCompletedAt: null, lastPollStartedAt: null } }), NOW);
  assert(!neverPolled.ready && neverPolled.failing[0].includes('never completed'), 'A poller that never completed past the grace period is a wedge');
  const staleSync = evaluateReadiness(healthy({ pendingSync: { intervalSeconds: 60, lastRunAt: new Date(NOW.getTime() - 10 * 60_000).toISOString(), running: false } }), NOW);
  assert(!staleSync.ready && staleSync.failing[0].includes('broker order sync last ran'), 'A dead broker sync loop is a wedge');

  // The same symptoms while Postgres is DOWN are not internal: nothing to restart for.
  const dbDown = evaluateReadiness(healthy({ dbOk: false, poller: { pollingEnabled: true, intervalSeconds: 60, lastPollCompletedAt: new Date(NOW.getTime() - 10 * 60_000).toISOString(), lastPollStartedAt: null }, pendingSync: { intervalSeconds: 60, lastRunAt: null, running: false } }), NOW);
  assert(dbDown.failing.length === 0 && dbDown.degraded.includes('postgres unreachable'), 'With the DB down a stalled poller/sync is degradation, not a wedge');
  assert(!dbDown.ready, 'Holding a position in-session with the DB down is not ready');
  const dbDownFlat = evaluateReadiness(healthy({ dbOk: false, openLivePositions: 0 }), NOW);
  assert(dbDownFlat.ready && dbDownFlat.degraded.includes('postgres unreachable'), 'Flat with the DB down: degraded but not blocking readiness');

  // Startup grace: a fresh process is not judged on poller/sync yet.
  const booting = evaluateReadiness(healthy({ processUptimeMs: 10_000, poller: { pollingEnabled: true, intervalSeconds: 60, lastPollCompletedAt: null, lastPollStartedAt: null }, pendingSync: { intervalSeconds: 60, lastRunAt: null, running: false } }), NOW);
  assert(booting.failing.length === 0, 'No internal-wedge verdicts during the startup grace');

  // Disabled polling is never a wedge.
  const disabled = evaluateReadiness(healthy({ poller: { pollingEnabled: false, intervalSeconds: 60, lastPollCompletedAt: null, lastPollStartedAt: null } }), NOW);
  assert(disabled.failing.length === 0, 'A deliberately disabled poller is not a wedge');

  // External degradation never appears in failing.
  const external = evaluateReadiness(healthy({ redisReady: false, ibkrStreamConnected: false, exitMonitorStatus: 'DEGRADED', liveEntriesReady: false }), NOW);
  assert(external.failing.length === 0 && external.degraded.length === 4 && external.ready, 'Redis/IBKR/exit-monitor degradation is reported, not treated as a wedge');
  const blind = evaluateReadiness(healthy({ exitMonitorStatus: 'DOWN' }), NOW);
  assert(!blind.ready && blind.failing.length === 0, 'Exit monitor DOWN with an open position in-session is not ready but not a restart reason');
  const blindClosed = evaluateReadiness(healthy({ exitMonitorStatus: 'DOWN', marketOpen: false }), NOW);
  assert(blindClosed.ready, 'Exit monitor DOWN after hours does not block readiness');

  console.log('All trading-readiness tests passed!');
}

try {
  run();
} catch (err) {
  console.error(err);
  process.exitCode = 1;
}
