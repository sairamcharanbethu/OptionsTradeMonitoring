import { ProcessWatchdog } from './process-watchdog';
import { ReadinessSnapshot, STARTUP_GRACE_MS } from './trading-readiness';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

const T0 = new Date('2026-10-05T14:00:00.000Z').getTime();

function snapshot(nowMs: number, overrides: Partial<ReadinessSnapshot> = {}): ReadinessSnapshot {
  return {
    dbOk: true,
    redisReady: true,
    marketOpen: true,
    openLivePositions: 1,
    liveEntriesReady: true,
    poller: { pollingEnabled: true, intervalSeconds: 60, lastPollCompletedAt: new Date(nowMs - 20_000).toISOString(), lastPollStartedAt: new Date(nowMs - 21_000).toISOString() },
    exitMonitorStatus: 'UP',
    ibkrStreamConnected: true,
    pendingSync: { intervalSeconds: 60, lastRunAt: new Date(nowMs - 10_000).toISOString(), running: false },
    eventLoopLagMs: null,
    processUptimeMs: STARTUP_GRACE_MS + 1,
    ...overrides
  };
}

function createWatchdog(options: { graceMs?: number; armDelayMs?: number; selfExits?: number | null } = {}) {
  let clock = T0;
  const exits: number[] = [];
  const alerts: string[] = [];
  const logs: string[] = [];
  let current: ReadinessSnapshot = snapshot(clock);
  let selfExitCount = options.selfExits ?? 0;
  const watchdog = new ProcessWatchdog({
    collect: async () => current,
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    onBeforeExit: async (reason) => { alerts.push(reason); },
    countSelfExit: async () => (options.selfExits === null ? null : selfExitCount),
    exit: (code) => { exits.push(code); },
    now: () => clock,
    intervalMs: 30_000,
    graceMs: options.graceMs ?? 5 * 60_000,
    armDelayMs: options.armDelayMs ?? 2 * 60_000
  });
  return {
    watchdog, exits, alerts, logs,
    advance: (ms: number) => { clock += ms; },
    set: (s: ReadinessSnapshot) => { current = s; },
    clock: () => clock,
    bumpSelfExits: () => { selfExitCount += 1; }
  };
}

async function testArmingDelayAndGrace() {
  const h = createWatchdog();
  await h.watchdog.start();
  // Wedged from the first tick, but not armed for 2 minutes and grace is 5.
  const wedged = (ms: number) => snapshot(ms, { poller: { pollingEnabled: true, intervalSeconds: 60, lastPollCompletedAt: new Date(ms - 10 * 60_000).toISOString(), lastPollStartedAt: new Date(ms - 9 * 60_000).toISOString() } });
  for (let i = 0; i < 20; i += 1) {
    h.advance(30_000);
    h.set(wedged(h.clock()));
    await h.watchdog.tick();
    if (h.exits.length) break;
  }
  // Armed at +2m; wedge seen since +0.5m; grace 5m from first sighting -> exit at ~+5.5m, i.e. the 11th tick.
  assert(h.exits.length === 1 && h.exits[0] === 1, `Exits once with code 1 after the grace (${h.exits.length} exits)`);
  const exitAtMs = h.clock() - T0;
  assert(exitAtMs >= 5.5 * 60_000 && exitAtMs <= 6 * 60_000, `Exit happens ~5.5 min in, after arming + grace (got ${exitAtMs / 60_000} min)`);
  assert(h.alerts.length === 1 && h.alerts[0].includes('exit poller last completed'), 'The best-effort alert carries the wedge reason');
  assert(h.watchdog.state().armed && h.watchdog.state().wedgedReasons.length === 1, 'State reports armed and the wedge');
  h.watchdog.stop();
}

async function testClearedWedgeResetsTheClock() {
  const h = createWatchdog({ armDelayMs: 0 });
  await h.watchdog.start();
  const wedged = (ms: number) => snapshot(ms, { pendingSync: { intervalSeconds: 60, lastRunAt: new Date(ms - 20 * 60_000).toISOString(), running: false } });
  for (let i = 0; i < 8; i += 1) { h.advance(30_000); h.set(wedged(h.clock())); await h.watchdog.tick(); }
  assert(h.exits.length === 0 && h.watchdog.state().wedgedSince !== null, 'Four minutes wedged: still inside the grace');
  h.advance(30_000); h.set(snapshot(h.clock())); await h.watchdog.tick();
  assert(h.watchdog.state().wedgedSince === null, 'A clean tick clears the wedge');
  for (let i = 0; i < 8; i += 1) { h.advance(30_000); h.set(wedged(h.clock())); await h.watchdog.tick(); }
  assert(h.exits.length === 0, 'The grace restarts from the new sighting');
  h.watchdog.stop();
}

async function testExternalOutageNeverExits() {
  const h = createWatchdog({ armDelayMs: 0, graceMs: 60_000 });
  await h.watchdog.start();
  const external = (ms: number) => snapshot(ms, {
    dbOk: false, redisReady: false, ibkrStreamConnected: false, exitMonitorStatus: 'DOWN',
    poller: { pollingEnabled: true, intervalSeconds: 60, lastPollCompletedAt: new Date(ms - 30 * 60_000).toISOString(), lastPollStartedAt: null },
    pendingSync: { intervalSeconds: 60, lastRunAt: null, running: false }
  });
  for (let i = 0; i < 20; i += 1) { h.advance(30_000); h.set(external(h.clock())); await h.watchdog.tick(); }
  assert(h.exits.length === 0, 'Postgres/Redis/IBKR/exit-monitor outages never trigger a self-exit');
  assert(h.watchdog.state().lastResult?.degraded.includes('postgres unreachable') === true, 'They are reported as degraded');
  h.watchdog.stop();
}

async function testEventLoopLagFromLateTimer() {
  const h = createWatchdog({ armDelayMs: 0, graceMs: 60_000 });
  await h.watchdog.start();
  h.advance(30_000); await h.watchdog.tick();
  assert(h.watchdog.state().lastLagMs === 0, 'An on-time tick has no lag');
  // The timer fires 2 minutes late: lag 90s+ is a blocked loop.
  h.advance(150_000); await h.watchdog.tick();
  assert((h.watchdog.state().lastLagMs || 0) >= 90_000 && h.watchdog.state().wedgedReasons[0]?.includes('event loop blocked'), 'A late timer is measured as event-loop lag and counts as a wedge');
  h.watchdog.stop();
}

async function testLoopGuardDoublesGrace() {
  const h = createWatchdog({ armDelayMs: 0, graceMs: 60_000, selfExits: 3 });
  await h.watchdog.start();
  assert(h.watchdog.state().graceMs === 120_000 && h.watchdog.state().exitsInWindow === 3, 'Three recent self-exits double the grace at start');
  const wedged = (ms: number) => snapshot(ms, { pendingSync: { intervalSeconds: 60, lastRunAt: new Date(ms - 20 * 60_000).toISOString(), running: false } });
  for (let i = 0; i < 3; i += 1) { h.advance(30_000); h.set(wedged(h.clock())); await h.watchdog.tick(); }
  assert(h.exits.length === 0, 'Within the doubled grace: no exit yet');
  for (let i = 0; i < 3; i += 1) { h.advance(30_000); h.set(wedged(h.clock())); await h.watchdog.tick(); }
  assert(h.exits.length === 1, 'Still exits once the doubled grace elapses — the guard slows, never disables');
  h.watchdog.stop();
}

async function testCollectFailureDoesNotExit() {
  const watchdog = new ProcessWatchdog({
    collect: async () => { throw new Error('boom'); },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    exit: () => { throw new Error('must not exit'); },
    armDelayMs: 0,
    graceMs: 0
  });
  const result = await watchdog.tick();
  assert(result === null, 'A failing collector is a no-op tick');
}

async function runTests() {
  console.log('Running process-watchdog tests...');
  await testArmingDelayAndGrace();
  await testClearedWedgeResetsTheClock();
  await testExternalOutageNeverExits();
  await testEventLoopLagFromLateTimer();
  await testLoopGuardDoublesGrace();
  await testCollectFailureDoesNotExit();
  console.log('All process-watchdog tests passed!');
}

runTests().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
