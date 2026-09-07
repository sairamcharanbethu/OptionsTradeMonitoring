import { TradeRedisService } from './trade-redis-service';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

/** In-memory stand-in for the Redis stream commands used by TradeRedisService. */
function createStreamMock(ready = true) {
  const entries: Array<[string, string[]]> = [];
  let seq = 0;
  return {
    entries,
    isReady: () => ready,
    xadd: async (_key: string, _maxLen: number, fields: Record<string, any>) => {
      seq += 1;
      const id = `${1725640000000 + seq}-0`;
      const flat: string[] = [];
      for (const [k, v] of Object.entries(fields)) { if (v !== undefined) flat.push(k, v === null ? '' : String(v)); }
      entries.push([id, flat]);
      return id;
    },
    xrevrange: async (_key: string, _start = '+', _end = '-', count?: number) => entries.slice().reverse().slice(0, count || entries.length),
    xrange: async (_key: string, start = '-', _end = '+', count?: number) => {
      const exclusive = start.startsWith('(') ? start.slice(1) : null;
      const rows = exclusive ? entries.filter(([id]) => id > exclusive) : entries.slice();
      return rows.slice(0, count || rows.length);
    },
    xlen: async () => entries.length
  };
}

async function runTests() {
  console.log('Running trade-events stream tests...');
  const stream = createStreamMock();
  TradeRedisService.useStreamClient(stream as any);
  const pgWrites: string[] = [];
  const pg = { query: async (sql: string) => { pgWrites.push(sql); return { rows: [], rowCount: 1 }; } };

  await TradeRedisService.recordEvent(pg, { userId: 7, signalId: 1, eventType: 'AI_LIVE_GATE', message: 'gate TRADE', metadata: { decision: 'TRADE' } });
  await TradeRedisService.recordEvent(pg, { userId: 9, signalId: 2, eventType: 'ENTRY_FILLED', message: 'other user' });
  await TradeRedisService.recordEvent(pg, { userId: 7, positionId: 55, eventType: 'POSITION_CLOSED', message: 'closed', metadata: { fillPrice: 1.2 } });
  assert(stream.entries.length === 3, 'Every recorded event is appended to the stream');
  assert(pgWrites.some((sql) => sql.includes('INSERT INTO trade_events')), 'Postgres remains the durable record');

  const mine = await TradeRedisService.readEvents(pg, { userId: 7, limit: 10 });
  assert(mine.source === 'redis', 'Stream is the source when Redis is ready');
  assert(mine.events.length === 2 && mine.events[0].event_type === 'POSITION_CLOSED' && mine.events[1].event_type === 'AI_LIVE_GATE', 'Newest first, filtered to the user');
  assert(mine.events[0].metadata.fillPrice === 1.2 && mine.events[0].position_id === 55, 'Metadata and ids round-trip through the stream');
  assert(mine.cursor === mine.events[0].stream_id, 'Cursor is the newest stream id in the page');

  const all = await TradeRedisService.readEvents(pg, { userId: null, limit: 10 });
  assert(all.events.length === 3, 'Admin (userId null) sees every user');

  const typed = await TradeRedisService.readEvents(pg, { userId: null, types: ['ai_live_gate'] });
  assert(typed.events.length === 1 && typed.events[0].event_type === 'AI_LIVE_GATE', 'Type filter is case-insensitive');

  const firstId = stream.entries[0][0];
  const newer = await TradeRedisService.readEvents(pg, { userId: null, after: firstId });
  assert(newer.events.length === 2 && newer.events.every((e) => String(e.stream_id) > firstId), '`after` returns only events newer than the cursor');

  // Redis down: Postgres fallback with the same shape.
  TradeRedisService.useStreamClient(createStreamMock(false) as any);
  const dbPg = {
    query: async (sql: string, params: any[] = []) => {
      assert(sql.includes('FROM trade_events') && sql.includes('ORDER BY created_at DESC'), 'Fallback queries trade_events newest first');
      assert(params[0] === 7, 'Fallback filters by user');
      return { rows: [{ id: 1, user_id: 7, signal_id: null, position_id: 55, event_type: 'POSITION_CLOSED', message: 'db', metadata: {}, created_at: new Date('2026-09-06T14:00:00Z') }] };
    }
  };
  const fallback = await TradeRedisService.readEvents(dbPg, { userId: 7, limit: 5 });
  assert(fallback.source === 'db' && fallback.events.length === 1 && fallback.events[0].stream_id === null && fallback.cursor === null, 'Postgres fallback reports its source and no cursor');
  TradeRedisService.useStreamClient(null);
  console.log('All trade-events stream tests passed!');
}

runTests().catch((err) => { console.error(err); process.exit(1); });
