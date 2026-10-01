import '@fastify/postgres';
import { SystemHealthEvaluator, SystemHealthSnapshot, HealthTransition, parseRestartWindow, minutesInWindow } from './system-health-evaluator';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

// Monday 2026-10-05 10:00 ET = 14:00Z (session open); 03:00 ET = 07:00Z (closed).
const OPEN = new Date('2026-10-05T14:00:00.000Z');
const CLOSED = new Date('2026-10-05T07:00:00.000Z');

function healthySnapshot(nowMs: number, overrides: Partial<SystemHealthSnapshot> = {}): SystemHealthSnapshot {
  return {
    engine: { updatedAtEpoch: nowMs / 1000 - 2, status: 'ok', connected: true, kernel: 'rust', startedAt: 1_000_000, error: null },
    ibkrStream: { status: 'UP', connected: true, lastError: null },
    zerogex: { status: 'ok', updatedAtEpoch: nowMs / 1000 - 5, error: null, startedAt: 2_000_000 },
    redisReady: true,
    poller: { status: 'UP', lastPollCompletedAt: new Date(nowMs - 20_000).toISOString(), intervalSeconds: 60, pollingEnabled: true },
    postgres: { ok: true, error: null },
    backendRestartsLastHour: 1,
    heartbeatConfigured: true,
    ...overrides
  };
}

function createEvaluator(options: { heartbeatUrl?: string | null; restartWindow?: string | null } = {}) {
  const notifications: HealthTransition[] = [];
  const pings: Array<{ url: string; method: string | undefined; body: any }> = [];
  const fastify = { log: { info: () => {}, warn: () => {}, error: () => {} }, pg: { query: async () => ({ rows: [] }) } } as any;
  let snapshot: SystemHealthSnapshot = healthySnapshot(OPEN.getTime());
  let clock = OPEN.getTime();
  const evaluator = new SystemHealthEvaluator(fastify, {
    collect: async () => snapshot,
    now: () => new Date(clock),
    heartbeatUrl: options.heartbeatUrl ?? null,
    restartWindow: options.restartWindow ?? null,
    notify: async (t) => { notifications.push(t); },
    fetchImpl: (async (url: any, init: any) => { pings.push({ url: String(url), method: init?.method, body: init?.body }); return { ok: true } as any; }) as any
  });
  return {
    evaluator,
    notifications,
    pings,
    setSnapshot: (s: SystemHealthSnapshot) => { snapshot = s; },
    at: (ms: number) => { clock = ms; return new Date(ms); },
    clock: () => clock
  };
}

async function testRestartWindowParsing() {
  const w = parseRestartWindow('23:30-00:15');
  assert(w !== null && w.start === 23 * 60 + 30 && w.end === 15, 'Window parses');
  assert(minutesInWindow(23 * 60 + 45, w) && minutesInWindow(5, w) && !minutesInWindow(12 * 60, w), 'Window crossing midnight matches both sides');
  assert(parseRestartWindow('garbage') === null && parseRestartWindow('') === null, 'Bad windows are rejected');
}

async function testHoldPreventsBlipAndFiresAfterHold() {
  const h = createEvaluator();
  const t0 = OPEN.getTime();
  // Engine heartbeat goes stale: engine_stale needs 90s of hold.
  const stale = healthySnapshot(t0, { engine: { updatedAtEpoch: t0 / 1000 - 120, status: 'ok', connected: true, kernel: 'rust', startedAt: 1, error: null } });
  let transitions = h.evaluator.evaluate(stale, h.at(t0));
  assert(transitions.length === 0, 'A single stale tick is suspect, not firing');
  assert(h.evaluator.summary().checks.find((c) => c.id === 'engine_stale')?.state === 'suspect', 'State is suspect during the hold');
  // Blip recovers before the hold elapses: back to ok, no notification.
  transitions = h.evaluator.evaluate(healthySnapshot(t0 + 30_000), h.at(t0 + 30_000));
  assert(transitions.length === 0 && h.evaluator.summary().checks.find((c) => c.id === 'engine_stale')?.state === 'ok', 'A blip never pages');
  // Sustained: fires once the hold is exceeded.
  h.evaluator.evaluate(healthySnapshot(t0 + 60_000, { engine: { ...stale.engine!, updatedAtEpoch: t0 / 1000 - 200 } }), h.at(t0 + 60_000));
  transitions = h.evaluator.evaluate(healthySnapshot(t0 + 160_000, { engine: { ...stale.engine!, updatedAtEpoch: t0 / 1000 - 300 } }), h.at(t0 + 160_000));
  assert(transitions.length === 1 && transitions[0].kind === 'fired' && transitions[0].id === 'engine_stale' && transitions[0].severity === 'critical',
    `Sustained staleness fires once (got ${JSON.stringify(transitions)})`);
  assert(h.evaluator.summary().overall === 'CRITICAL', 'A firing critical check makes the overall CRITICAL');
  // Still failing a tick later: no duplicate notification.
  transitions = h.evaluator.evaluate(healthySnapshot(t0 + 190_000, { engine: { ...stale.engine!, updatedAtEpoch: t0 / 1000 - 300 } }), h.at(t0 + 190_000));
  assert(transitions.length === 0, 'No re-notification right after firing');
}

async function testEscalationAndRecovery() {
  const h = createEvaluator();
  const t0 = OPEN.getTime();
  const down = (ms: number) => healthySnapshot(ms, { redisReady: false });
  h.evaluator.evaluate(down(t0), h.at(t0));
  let transitions = h.evaluator.evaluate(down(t0 + 125_000), h.at(t0 + 125_000));
  assert(transitions.some((t) => t.id === 'redis_down' && t.kind === 'fired'), 'redis_down fires after its 120s hold');
  const firedAt = t0 + 125_000;
  transitions = h.evaluator.evaluate(down(firedAt + 16 * 60_000), h.at(firedAt + 16 * 60_000));
  assert(transitions.length === 1 && transitions[0].kind === 'renotify' && transitions[0].stage === 1, 'Re-notifies at +15m (stage 1)');
  transitions = h.evaluator.evaluate(down(firedAt + 30 * 60_000), h.at(firedAt + 30 * 60_000));
  assert(transitions.length === 0, 'Nothing between stages');
  transitions = h.evaluator.evaluate(down(firedAt + 61 * 60_000), h.at(firedAt + 61 * 60_000));
  assert(transitions.length === 1 && transitions[0].stage === 2, 'Re-notifies at +60m (stage 2)');
  transitions = h.evaluator.evaluate(down(firedAt + 3 * 60 * 60_000), h.at(firedAt + 3 * 60 * 60_000));
  assert(transitions.length === 0, 'No re-notification before the 4h period elapses');
  transitions = h.evaluator.evaluate(down(firedAt + (61 + 4 * 60 + 1) * 60_000), h.at(firedAt + (61 + 4 * 60 + 1) * 60_000));
  assert(transitions.length === 1 && transitions[0].stage === 3, 'Then every 4h (stage 3)');
  // Recovery needs two consecutive healthy passes, then one notice.
  const back = firedAt + (61 + 4 * 60 + 2) * 60_000;
  transitions = h.evaluator.evaluate(healthySnapshot(back), h.at(back));
  assert(transitions.length === 0 && h.evaluator.summary().checks.find((c) => c.id === 'redis_down')?.state === 'firing', 'One healthy pass is not recovery');
  transitions = h.evaluator.evaluate(healthySnapshot(back + 30_000), h.at(back + 30_000));
  assert(transitions.length === 1 && transitions[0].kind === 'recovered' && transitions[0].title.includes('RECOVERED after'), `Second healthy pass recovers (${JSON.stringify(transitions)})`);
  assert(h.evaluator.summary().overall === 'OK', 'Overall returns to OK');
  transitions = h.evaluator.evaluate(healthySnapshot(back + 60_000), h.at(back + 60_000));
  assert(transitions.length === 0, 'Recovery is announced once');
}

async function testMarketHoursGatingAndRestartWindow() {
  const h = createEvaluator({ restartWindow: '23:30-00:15' });
  const t0 = CLOSED.getTime();
  const disconnected = (ms: number) => healthySnapshot(ms, {
    engine: { updatedAtEpoch: ms / 1000 - 1, status: 'closed', connected: false, kernel: 'rust', startedAt: 1, error: null },
    ibkrStream: { status: 'DOWN', connected: false, lastError: 'socket closed' },
    zerogex: { status: 'error', updatedAtEpoch: ms / 1000 - 500, error: 'timeout', startedAt: 2 }
  });
  h.evaluator.evaluate(disconnected(t0), h.at(t0));
  let transitions = h.evaluator.evaluate(disconnected(t0 + 10 * 60_000), h.at(t0 + 10 * 60_000));
  assert(transitions.length === 0, 'Off-hours: IBKR/zerogex problems do not page within 10 minutes');
  transitions = h.evaluator.evaluate(disconnected(t0 + 31 * 60_000), h.at(t0 + 31 * 60_000));
  assert(transitions.length === 1 && transitions[0].id === 'engine_disconnected_offhours' && transitions[0].severity === 'warning',
    `Off-hours disconnect becomes a warning after 30 min (got ${JSON.stringify(transitions.map((t) => t.id))})`);

  // In-session the same state pages critically after 3 min.
  const s = createEvaluator();
  const o0 = OPEN.getTime();
  s.evaluator.evaluate(disconnected(o0), s.at(o0));
  transitions = s.evaluator.evaluate(disconnected(o0 + 185_000), s.at(o0 + 185_000));
  const ids = transitions.map((t) => t.id).sort();
  assert(ids.includes('engine_disconnected') && ids.includes('ibkr_stream'), `In-session disconnect pages critically (${ids})`);
  assert(!ids.includes('zerogex_stale'), 'zerogex_stale still holding (300s)');
  transitions = s.evaluator.evaluate(disconnected(o0 + 310_000), s.at(o0 + 310_000));
  assert(transitions.some((t) => t.id === 'zerogex_stale' && t.severity === 'warning'), 'zerogex_stale fires after 5 min in-session');

  // Inside the IB restart window (23:45 ET = 03:45Z next day) disconnects are suppressed.
  const w = createEvaluator({ restartWindow: '23:30-00:15' });
  const w0 = new Date('2026-10-06T03:45:00.000Z').getTime();
  w.evaluator.evaluate(disconnected(w0), w.at(w0));
  transitions = w.evaluator.evaluate(disconnected(w0 + 40 * 60_000), w.at(w0 + 40 * 60_000));
  assert(!transitions.some((t) => t.id.startsWith('engine_disconnected') || t.id === 'ibkr_stream'), 'Disconnects inside the restart window never page');
}

async function testImmediateChecksAndInfo() {
  const h = createEvaluator();
  const t0 = OPEN.getTime();
  const transitions = h.evaluator.evaluate(healthySnapshot(t0, {
    zerogex: { status: 'auth_error', updatedAtEpoch: t0 / 1000, error: '401', startedAt: 2 },
    poller: { status: 'STALE', lastPollCompletedAt: new Date(t0 - 10 * 60_000).toISOString(), intervalSeconds: 60, pollingEnabled: true },
    engine: { updatedAtEpoch: t0 / 1000 - 1, status: 'ok', connected: true, kernel: 'python', startedAt: 1, error: null },
    heartbeatConfigured: false,
    backendRestartsLastHour: 5
  }), h.at(t0));
  const ids = transitions.map((t) => t.id).sort();
  assert(ids.includes('zerogex_auth') && ids.includes('poller_stalled') && ids.includes('kernel_not_rust') && ids.includes('heartbeat_unconfigured') && ids.includes('restart_loop'),
    `Zero-hold checks fire on the first tick (${ids})`);
  const summary = h.evaluator.summary();
  assert(summary.overall === 'CRITICAL', 'auth_error / stalled poller are critical');
  assert(summary.checks.find((c) => c.id === 'heartbeat_unconfigured')?.severity === 'info', 'Missing heartbeat is informational');
}

async function testEngineRestartLoopDetection() {
  const h = createEvaluator();
  const t0 = OPEN.getTime();
  const all: HealthTransition[] = [];
  for (let i = 0; i < 5; i += 1) {
    const ms = t0 + i * 60_000;
    all.push(...h.evaluator.evaluate(healthySnapshot(ms, { engine: { updatedAtEpoch: ms / 1000, status: 'ok', connected: true, kernel: 'rust', startedAt: 5_000 + i, error: null } }), h.at(ms)));
  }
  const fired = all.filter((t) => t.id === 'restart_loop');
  assert(fired.length === 1 && fired[0].kind === 'fired' && fired[0].message.includes('engine restarted 4x'),
    `More than three distinct engine start times in an hour is a restart loop, reported once (${JSON.stringify(fired)})`);
  // A stable start time for a while clears it (two healthy passes).
  const later = t0 + 70 * 60_000;
  h.evaluator.evaluate(healthySnapshot(later, { engine: { updatedAtEpoch: later / 1000, status: 'ok', connected: true, kernel: 'rust', startedAt: 5_004, error: null } }), h.at(later));
  const recovered = h.evaluator.evaluate(healthySnapshot(later + 30_000, { engine: { updatedAtEpoch: (later + 30_000) / 1000, status: 'ok', connected: true, kernel: 'rust', startedAt: 5_004, error: null } }), h.at(later + 30_000));
  assert(recovered.some((t) => t.id === 'restart_loop' && t.kind === 'recovered'), 'Once the hour window passes with a stable start time the loop alert recovers');
}

async function testHeartbeatPingsOkOrFail() {
  const h = createEvaluator({ heartbeatUrl: 'https://hc-ping.com/abc' });
  await h.evaluator.tick();
  assert(h.pings.length === 1 && h.pings[0].url === 'https://hc-ping.com/abc' && h.pings[0].method === 'GET', 'Healthy: plain ping');
  h.setSnapshot(healthySnapshot(h.clock(), { postgres: { ok: false, error: 'ECONNREFUSED' } }));
  h.at(h.clock() + 65_000);
  await h.evaluator.tick();
  h.at(h.clock() + 65_000);
  await h.evaluator.tick();
  const last = h.pings[h.pings.length - 1];
  assert(last.url === 'https://hc-ping.com/abc/fail' && last.method === 'POST' && String(last.body).includes('postgres_down'), `Critical: /fail ping with the firing ids (${JSON.stringify(last)})`);
  assert(h.evaluator.summary().heartbeat.mode === 'fail' && h.evaluator.summary().heartbeat.lastPingOk === true, 'Heartbeat state reflects the last ping');
  assert(h.notifications.some((n) => n.id === 'postgres_down' && n.kind === 'fired'), 'tick() dispatches notifications');
}

// Sunday 16:00-16:30 ET posts the weekly IB re-auth reminder once and clears silently.
async function testSundayReauthReminder() {
  const h = createEvaluator();
  const sunday = new Date('2026-10-04T20:05:00.000Z'); // Sun 16:05 ET
  const fired = h.evaluator.evaluate(healthySnapshot(sunday.getTime()), h.at(sunday.getTime()));
  assert(fired.some((t) => t.id === 'ib_weekly_reauth_due' && t.severity === 'info'), `Sunday 16:05 ET fires the re-auth reminder (${JSON.stringify(fired.map((t) => t.id))})`);
  const later = sunday.getTime() + 40 * 60_000; // 16:45 ET, outside the window
  h.evaluator.evaluate(healthySnapshot(later), h.at(later));
  const cleared = h.evaluator.evaluate(healthySnapshot(later + 30_000), h.at(later + 30_000));
  assert(!cleared.some((t) => t.id === 'ib_weekly_reauth_due'), 'Info checks recover silently (no RECOVERED notice)');
  assert(h.evaluator.summary().checks.find((c) => c.id === 'ib_weekly_reauth_due')?.state === 'ok', 'The reminder is back to ok after the window');
  const monday = new Date('2026-10-05T20:05:00.000Z').getTime();
  const weekday = h.evaluator.evaluate(healthySnapshot(monday), h.at(monday));
  assert(!weekday.some((t) => t.id === 'ib_weekly_reauth_due'), 'Monday 16:05 ET does not remind');
}

async function testCollectFailureIsSwallowed() {
  const fastify = { log: { info: () => {}, warn: () => {}, error: () => {} }, pg: { query: async () => ({ rows: [] }) } } as any;
  const evaluator = new SystemHealthEvaluator(fastify, { collect: async () => { throw new Error('boom'); }, heartbeatUrl: null, notify: async () => {} });
  const transitions = await evaluator.tick();
  assert(transitions.length === 0 && evaluator.summary().overall === 'OK', 'A failing collector does not throw or page');
}

async function runTests() {
  console.log('Running SystemHealthEvaluator tests...');
  await testRestartWindowParsing();
  await testHoldPreventsBlipAndFiresAfterHold();
  await testEscalationAndRecovery();
  await testMarketHoursGatingAndRestartWindow();
  await testImmediateChecksAndInfo();
  await testEngineRestartLoopDetection();
  await testHeartbeatPingsOkOrFail();
  await testCollectFailureIsSwallowed();
  await testSundayReauthReminder();
  console.log('All SystemHealthEvaluator tests passed!');
}

runTests().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
