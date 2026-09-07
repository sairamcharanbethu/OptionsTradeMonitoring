import { ZeroGexArchiveService, extractFrames, frameTimestamp, normalizeSessionDates, unwrapEnvelope } from './zerogex-archive-service';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function createPg() {
  const queries: Array<{ sql: string; values: any[] }> = [];
  const client = {
    query: async (sql: string, values: any[] = []) => { queries.push({ sql, values }); return { rows: [] }; },
    release: () => undefined
  };
  return {
    queries,
    query: async (sql: string, values: any[] = []) => {
      queries.push({ sql, values });
      if (sql.includes('FROM zerogex_replay_sessions') && sql.includes('frame_count > 0')) {
        return { rows: [{ session_date: '2026-09-04' }] };
      }
      return { rows: [] };
    },
    connect: async () => client
  };
}

async function runTests() {
  console.log('Running ZeroGexArchiveService tests...');

  assert(unwrapEnvelope({ data: [1], freshness: {} })[0] === 1, 'v2 envelope unwraps data');
  assert(Array.isArray(unwrapEnvelope([1, 2])), 'bare arrays pass through');

  const dates = normalizeSessionDates({ sessions: ['2026-09-04', { date: '2026-09-03T00:00:00Z' }, { session_date: '2026-09-05' }, 'garbage'] });
  assert(JSON.stringify(dates) === JSON.stringify(['2026-09-05', '2026-09-04', '2026-09-03']), `sessions normalise to unique dates newest first, got ${dates}`);

  assert(frameTimestamp({ ts: '2026-09-04T13:31:00Z' })?.toISOString() === '2026-09-04T13:31:00.000Z', 'ISO ts parses');
  assert(frameTimestamp({ timestamp: 1788010260 })?.toISOString() === '2026-08-29T13:31:00.000Z', 'epoch seconds parse');
  assert(frameTimestamp({ t: 1788010260000 })?.toISOString() === '2026-08-29T13:31:00.000Z', 'epoch millis parse');
  assert(frameTimestamp({ nothing: true }) === null, 'frames without a time are dropped');

  assert(extractFrames({ frames: [{ ts: 1 }] }).length === 1, 'frames key');
  assert(extractFrames({ meta: {}, series: [{ ts: 1 }, { ts: 2 }] }).length === 2, 'series key');
  assert(extractFrames({ meta: {}, whatever: [{ ts: 1 }] }).length === 1, 'unknown array key is found by shape');
  assert(extractFrames({ meta: {} }).length === 0, 'no frames -> empty');

  const pg = createPg();
  const calls: Array<{ path: string; params: any }> = [];
  const fetcher = async (path: string, params: any) => {
    calls.push({ path, params });
    if (path === '/replay/sessions') return { data: ['2026-09-05', '2026-09-04'] };
    if (path === '/replay/range') {
      return { data: { frames: [
        { ts: `${params.date}T13:31:00Z`, flip: 640.5, call_wall: 645, put_wall: 635 },
        { ts: `${params.date}T13:30:00Z`, flip: 640.4, call_wall: 645, put_wall: 635 },
        { no_time: true }
      ] } };
    }
    throw new Error(`unexpected path ${path}`);
  };
  const service = new ZeroGexArchiveService({ pg, log: { info: () => {}, warn: () => {}, error: () => {} } } as any, fetcher);
  process.env.ZEROGEX_API_KEY = 'test-key';
  const summary = await service.backfill({ symbol: 'spy' });
  assert(summary.listed.length === 2, 'both sessions listed');
  assert(summary.skipped.includes('2026-09-04'), 'already-archived session is skipped');
  assert(summary.archived.length === 1 && summary.archived[0] === '2026-09-05', `only the missing session is archived, got ${JSON.stringify(summary)}`);
  assert(summary.frames === 2, 'frames without a timestamp are not counted');
  assert(calls.filter((c) => c.path === '/replay/range').length === 1, 'range fetched once');
  const insertFrames = pg.queries.find((q) => q.sql.includes('INSERT INTO zerogex_replay_frames'));
  assert(Boolean(insertFrames) && insertFrames!.values[2] === '2026-09-05T13:30:00.000Z', 'frames are inserted in time order with ISO timestamps');
  const upsertSession = pg.queries.find((q) => q.sql.includes('INSERT INTO zerogex_replay_sessions'));
  assert(Boolean(upsertSession) && upsertSession!.values[2] === 2 && upsertSession!.values[6] === null, 'session row records the frame count and drops raw when frames parsed');
  assert(pg.queries.some((q) => q.sql === 'COMMIT'), 'transaction committed');

  // Unparsable payload keeps the raw body.
  const pg2 = createPg();
  const service2 = new ZeroGexArchiveService({ pg: pg2, log: { info: () => {}, warn: () => {}, error: () => {} } } as any,
    async (path: string) => path === '/replay/sessions' ? ['2026-09-05'] : { data: { meta: { note: 'no frames' } } });
  const summary2 = await service2.backfill({ symbol: 'SPY' });
  assert(summary2.failed.length === 1 && summary2.archived.length === 0, 'a frame-less payload is reported as failed');
  const raw = pg2.queries.find((q) => q.sql.includes('INSERT INTO zerogex_replay_sessions'));
  assert(Boolean(raw) && typeof raw!.values[6] === 'string' && raw!.values[6].includes('no frames'), 'raw payload is kept when frames cannot be parsed');

  // No key: skipped without throwing.
  delete process.env.ZEROGEX_API_KEY;
  const pg3 = createPg();
  const service3 = new ZeroGexArchiveService({ pg: pg3, log: { info: () => {}, warn: () => {}, error: () => {} } } as any, async () => { throw new Error('must not be called'); });
  (service3 as any).resolveApiKey = async () => null;
  const summary3 = await service3.backfill();
  assert(summary3.listed.length === 0 && summary3.failed.length === 0, 'missing key skips cleanly');

  console.log('All ZeroGexArchiveService tests passed!');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
