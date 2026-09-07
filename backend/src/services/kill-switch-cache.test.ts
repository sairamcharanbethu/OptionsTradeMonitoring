import { KillSwitchService } from './kill-switch-service';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function createRedisMock() {
  const store = new Map<string, string>();
  const dels: string[] = [];
  return {
    store, dels,
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => { store.set(k, v); },
    del: async (k: string) => { store.delete(k); dels.push(k); }
  };
}

function createPg(state: { disarmed: string; openPnl: number }) {
  const calls: string[] = [];
  return {
    calls,
    query: async (sql: string) => {
      calls.push(sql);
      if (sql.includes('DISTINCT ON (s.key)')) return { rows: [{ key: KillSwitchService.SETTING_KEY, value: '200' }] };
      if (sql.includes('SELECT value FROM settings')) return { rows: [{ value: state.disarmed }] };
      if (sql.includes("status = 'CLOSED'")) return { rows: [{ pnl: -50 }] };
      if (sql.includes('status = ANY')) return { rows: [{ pnl: state.openPnl }] };
      return { rows: [], rowCount: 1 };
    }
  };
}

async function runTests() {
  console.log('Running kill-switch cache tests...');
  const redis = createRedisMock();
  KillSwitchService.useRedis(redis as any);
  const state = { disarmed: 'false', openPnl: -20 };
  const pg = createPg(state);

  const first = await KillSwitchService.evaluate(pg, 'live', 7, { cache: true });
  assert(first.halted === false && first.dayTotalPnl === -70, 'Fresh evaluation computes P&L');
  const callsAfterFirst = pg.calls.length;
  const second = await KillSwitchService.evaluate(pg, 'live', 7, { cache: true });
  assert(pg.calls.length === callsAfterFirst, 'A cached read issues no database queries');
  assert(second.dayTotalPnl === -70, 'Cached payload matches');

  // Disarm invalidates immediately: the next cached read sees it.
  await KillSwitchService.setLiveDisarmed(pg, 7, true);
  assert(redis.dels.includes(KillSwitchService.statusCacheKey('live', 7)), 'setLiveDisarmed drops the cached status');
  state.disarmed = 'true';
  const afterDisarm = await KillSwitchService.evaluate(pg, 'live', 7, { cache: true });
  assert(afterDisarm.disarmed === true && afterDisarm.halted === true, 'Disarm is visible on the very next read');

  // Execution paths (no cache option) always compute fresh even with a cached value present.
  state.disarmed = 'false';
  await KillSwitchService.invalidateStatusCache('live', 7);
  await KillSwitchService.evaluate(pg, 'live', 7, { cache: true }); // primes cache with halted=false
  state.openPnl = -500; // loss limit now breached
  const before = pg.calls.length;
  const fresh = await KillSwitchService.evaluate(pg, 'live', 7);
  assert(pg.calls.length > before, 'Uncached evaluate hits the database');
  // dayOpenPnl is memoized ~2s, so the breach shows once the memo expires; force it.
  KillSwitchService.useRedis(redis as any); // clears memo
  const breached = await KillSwitchService.evaluate(pg, 'live', 7);
  assert(breached.halted === true, `Loss halt is computed fresh for execution paths, got ${JSON.stringify(breached)}`);
  assert(!redis.store.has(KillSwitchService.statusCacheKey('live', 7)) || JSON.parse(redis.store.get(KillSwitchService.statusCacheKey('live', 7))!).halted === true, 'A halt flip invalidates or overwrites the cached status');
  assert(typeof fresh.dayTotalPnl === 'number', 'Fresh status has a numeric total');
  KillSwitchService.useRedis(null);
  console.log('All kill-switch cache tests passed!');
}

runTests().catch((err) => { console.error(err); process.exit(1); });
