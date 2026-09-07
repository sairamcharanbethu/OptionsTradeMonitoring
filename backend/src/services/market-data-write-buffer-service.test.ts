import { MarketDataWriteBufferService } from './market-data-write-buffer-service';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function createRedisMock() {
  const sets = new Map<string, Set<string>>();
  const hashes = new Map<string, Record<string, string>>();
  const sortedSets = new Map<string, Array<{ score: number; value: string }>>();

  return {
    isReady: () => true,
    sadd: async (key: string, value: string) => {
      const set = sets.get(key) || new Set<string>();
      set.add(value);
      sets.set(key, set);
    },
    smembers: async (key: string) => Array.from(sets.get(key) || []),
    srem: async (key: string, value: string) => {
      sets.get(key)?.delete(value);
    },
    setNX: async () => true,
    delIfValue: async () => true,
    hset: async (key: string, values: Record<string, string | number | null | undefined>) => {
      const hash = hashes.get(key) || {};
      for (const [field, value] of Object.entries(values)) {
        if (value !== undefined) hash[field] = value === null ? '' : String(value);
      }
      hashes.set(key, hash);
    },
    hgetall: async (key: string) => ({ ...(hashes.get(key) || {}) }),
    zadd: async (key: string, score: number, value: string) => {
      const rows = sortedSets.get(key) || [];
      rows.push({ score, value });
      rows.sort((a, b) => a.score - b.score);
      sortedSets.set(key, rows);
    },
    zrange: async (key: string) => (sortedSets.get(key) || []).map((row) => row.value),
    zremrangebyscore: async (key: string, min: number | string, max: number | string) => {
      const minScore = min === '-inf' ? Number.NEGATIVE_INFINITY : Number(min);
      const maxScore = max === '+inf' ? Number.POSITIVE_INFINITY : Number(max);
      const rows = sortedSets.get(key) || [];
      sortedSets.set(key, rows.filter((row) => row.score < minScore || row.score > maxScore));
    },
    zcard: async (key: string) => (sortedSets.get(key) || []).length,
    del: async (key: string) => {
      hashes.delete(key);
      sortedSets.delete(key);
    }
  };
}

function createFastifyMock(onQuery?: (sql: string, params?: any[]) => Promise<void> | void) {
  const queries: Array<{ sql: string; params?: any[] }> = [];
  const client = {
    query: async (sql: string, params?: any[]) => {
      queries.push({ sql, params });
      await onQuery?.(sql, params);
      return { rows: [], rowCount: 1 };
    },
    release: () => {}
  };
  return {
    fastify: {
      log: {
        info: () => {},
        warn: () => {}
      },
      pg: {
        connect: async () => client,
        query: async (sql: string, params?: any[]) => {
          queries.push({ sql, params });
          await onQuery?.(sql, params);
          return { rows: [], rowCount: 1 };
        }
      }
    } as any,
    queries
  };
}

async function testQuotePushIsTargetedToTheOwner() {
  const published: Array<{ type: string; data: any; options: any }> = [];
  const publish = ((type: string, data: any, options: any = {}) => { published.push({ type, data, options }); return 1; }) as any;
  const service = new MarketDataWriteBufferService(createFastifyMock().fastify, createRedisMock(), publish);
  await service.recordQuote({ positionId: 501, userId: 7, price: 1.25, recordedAt: '2026-09-08T14:00:00.000Z' });
  await service.recordQuote({ positionId: 502, price: 2.5, recordedAt: '2026-09-08T14:00:01.000Z' });
  const quotes = published.filter((p) => p.type === 'POSITION_UPDATE' && p.data?.kind === 'quote');
  assert(quotes.length === 2, `Expected two quote pushes, got ${quotes.length}`);
  assert(quotes[0].options?.userId === 7, 'A quote with an owner is targeted to that user');
  assert(quotes[1].options?.userId === null, 'A quote without an owner falls back to broadcast');
}

async function testCriticalFieldsWriteThroughOnChangeOnly() {
  const redis = createRedisMock();
  const { fastify, queries } = createFastifyMock();
  const service = new MarketDataWriteBufferService(fastify, redis);
  const critical = () => queries.filter((q) => q.sql.includes('UPDATE positions') && q.sql.includes('stop_loss_trigger = COALESCE($1'));

  // First sight of a stop: written to Postgres immediately (before any EOD flush).
  await service.recordQuote({ positionId: 7, price: 1.20, stopLossTrigger: 0.96, recordedAt: '2026-09-08T14:00:00.000Z' });
  assert(critical().length === 1, `A new stop is written through immediately, got ${critical().length}`);
  assert(critical()[0].params?.[0] === 0.96 && critical()[0].params?.[3] === '7', 'The stop value and position id are written');
  assert(critical()[0].sql.includes("status = 'OPEN'"), 'Write-through never touches a closed position');

  // Same stop on the next quotes: no DB write per quote.
  await service.recordQuote({ positionId: 7, price: 1.18, stopLossTrigger: 0.96 });
  await service.recordQuote({ positionId: 7, price: 1.25, stopLossTrigger: 0.96 });
  assert(critical().length === 1, `Unchanged stop must not write per quote, got ${critical().length}`);
  assert(queries.filter((q) => q.sql.includes('INSERT INTO price_history')).length === 0, 'Quotes themselves stay buffered');

  // A new trailing high alone (stop unchanged) stays buffered: it decides nothing by itself.
  await service.recordQuote({ positionId: 7, price: 1.30, stopLossTrigger: 0.96, trailingHighPrice: 1.30 });
  assert(critical().length === 1, `A trailing-high move without a stop change stays Redis-only, got ${critical().length}`);

  // Trailing stop ratchets: stop + high written once per change.
  await service.recordQuote({ positionId: 7, price: 1.40, stopLossTrigger: 1.10, trailingHighPrice: 1.40 });
  assert(critical().length === 2 && critical()[1].params?.[0] === 1.10 && critical()[1].params?.[1] === 1.40, 'A changed stop (with its trail) is written through once');

  // analysis_data changes are written; a semantically identical object is not.
  await service.recordQuote({ positionId: 7, price: 1.41, stopLossTrigger: 1.10, analysisData: { thetaStop: { startedAt: 'x' }, a: 1 } });
  await service.recordQuote({ positionId: 7, price: 1.42, stopLossTrigger: 1.10, analysisData: { a: 1, thetaStop: { startedAt: 'x' } } });
  assert(critical().length === 3, `analysis_data change writes once regardless of key order, got ${critical().length}`);
  assert(service.criticalWriteThroughCount === 3, 'Health counter tracks write-throughs');

  // First sight equal to the persisted baseline is NOT a change (restart / first quote of the day).
  const seeded = new MarketDataWriteBufferService(createFastifyMock().fastify, createRedisMock());
  const seededQueries: string[] = [];
  (seeded as any).fastify.pg.query = async (sql: string) => { seededQueries.push(sql); return { rows: [], rowCount: 1 }; };
  await seeded.recordQuote({ positionId: 9, price: 1.0, stopLossTrigger: 0.5, trailingHighPrice: 1.0, baselineStopLossTrigger: 0.5, baselineTrailingHighPrice: 1.0 });
  assert(seeded.criticalWriteThroughCount === 0 && seededQueries.length === 0, 'An ordinary quote carrying the already-persisted stop does not write to Postgres');
  await seeded.recordQuote({ positionId: 9, price: 1.1, stopLossTrigger: 0.55, trailingHighPrice: 1.1, baselineStopLossTrigger: 0.5, baselineTrailingHighPrice: 1.0 });
  assert(seeded.criticalWriteThroughCount === 1, 'A ratchet after the seeded first sight is written through');

  // A DB failure leaves Redis as the source and retries on the next quote.
  const failing = createFastifyMock(async (sql) => { if (sql.includes('stop_loss_trigger = COALESCE($1')) throw new Error('db down'); });
  const failingService = new MarketDataWriteBufferService(failing.fastify, createRedisMock());
  const buffered = await failingService.recordQuote({ positionId: 8, price: 2.0, stopLossTrigger: 1.6 });
  assert(buffered === true && failingService.criticalWriteThroughCount === 0, 'A failed write-through does not break buffering');
}

async function testQuoteTelemetryBuffersUntilFlush() {
  const redis = createRedisMock();
  const { fastify, queries } = createFastifyMock();
  const service = new MarketDataWriteBufferService(fastify, redis);

  const buffered = await service.recordQuote({
    positionId: 42,
    price: 1.23,
    delta: 0.5,
    recordedAt: '2026-07-01T15:30:00.000Z'
  });

  assert(buffered, 'Expected quote to be buffered in Redis');
  assert(queries.length === 0, `Expected no DB writes during quote record, got ${queries.length}`);

  const summary = await service.flushToDatabase();

  assert(summary.checked === 1, `Expected one buffered position, got ${summary.checked}`);
  assert(summary.flushed === 1, `Expected one flushed position, got ${summary.flushed}`);
  assert(summary.historyRows === 1, `Expected one history row, got ${summary.historyRows}`);
  assert(queries.some((query) => query.sql.includes('UPDATE positions')), 'Expected latest quote update during flush');
  assert(queries.some((query) => query.sql.includes("status = 'OPEN'")), 'Buffered quotes must not overwrite a position after its durable close');
  assert(queries.some((query) => query.sql.includes('INSERT INTO price_history')), 'Expected price history insert during flush');
}

async function testBufferedQuoteOverlaysDbPositionRows() {
  const redis = createRedisMock();
  const { fastify } = createFastifyMock();
  const service = new MarketDataWriteBufferService(fastify, redis);

  await service.recordQuote({
    positionId: 42,
    price: 1.44,
    delta: 0.62,
    underlyingPrice: 741.2,
    maxFavorablePrice: 1.44,
    maxAdversePrice: 0.98,
    mfePct: 29.73,
    maePct: -11.71,
    trailingHighPrice: 1.44,
    stopLossTrigger: 1.22,
    analysisData: { smartStopWarning: { status: 'STOP_ARMED', belowStopCount: 1 } },
    recordedAt: '2026-07-01T15:31:00.000Z'
  });

  const [position] = await service.applyLatestToPositions([{
    id: 42,
    status: 'OPEN',
    current_price: 1.11,
    delta: 0.4,
    underlying_price: 740
  } as any]);

  assert(position.current_price === 1.44, `Expected Redis current price overlay, got ${position.current_price}`);
  assert(position.delta === 0.62, `Expected Redis delta overlay, got ${position.delta}`);
  assert(position.underlying_price === 741.2, `Expected Redis underlying overlay, got ${position.underlying_price}`);
  assert(position.max_favorable_price === 1.44, `Expected Redis favorable excursion overlay, got ${position.max_favorable_price}`);
  assert(position.max_adverse_price === 0.98, `Expected Redis adverse excursion overlay, got ${position.max_adverse_price}`);
  assert(position.mfe_pct === 29.73, `Expected Redis MFE overlay, got ${position.mfe_pct}`);
  assert(position.mae_pct === -11.71, `Expected Redis MAE overlay, got ${position.mae_pct}`);
  assert(position.trailing_high_price === 1.44, `Expected Redis trailing high overlay, got ${position.trailing_high_price}`);
  assert(position.stop_loss_trigger === 1.22, `Expected Redis trailing stop overlay, got ${position.stop_loss_trigger}`);
  assert(position.analysis_data?.smartStopWarning?.belowStopCount === 1, 'Expected Redis exit-state analysis overlay');
  assert(position.updated_at === '2026-07-01T15:31:00.000Z', `Expected Redis updated_at overlay, got ${position.updated_at}`);
}

async function testFlushPersistsBufferedExitState() {
  const redis = createRedisMock();
  const { fastify, queries } = createFastifyMock();
  const service = new MarketDataWriteBufferService(fastify, redis);

  await service.recordQuote({
    positionId: 42,
    price: 0.82,
    maxFavorablePrice: 1.44,
    maxAdversePrice: 0.82,
    mfePct: 29.73,
    maePct: -26.13,
    trailingHighPrice: 1.44,
    stopLossTrigger: 1.22,
    analysisData: { smartStopWarning: { status: 'STOP_ARMED', belowStopCount: 1 } },
    recordedAt: '2026-07-01T15:31:00.000Z'
  });

  await service.flushToDatabase();

  // The stop/trail/analysis change is written through immediately; the flush
  // update is the one that carries current_price and the excursions.
  const writeThrough = queries.find((query) => query.sql.includes('stop_loss_trigger = COALESCE($1'));
  assert(Boolean(writeThrough) && writeThrough?.params?.[0] === 1.22 && writeThrough?.params?.[1] === 1.44, 'Stop and trailing high are written through before the flush');
  const update = queries.find((query) => query.sql.includes('UPDATE positions') && query.sql.includes('current_price = $1'));
  assert(Boolean(update), 'Expected buffered position state to be flushed');
  assert(update?.params?.[7] === 1.44, `Expected favorable excursion in flush params, got ${update?.params?.[7]}`);
  assert(update?.params?.[8] === 0.82, `Expected adverse excursion in flush params, got ${update?.params?.[8]}`);
  assert(update?.params?.[9] === 29.73, `Expected MFE in flush params, got ${update?.params?.[9]}`);
  assert(update?.params?.[10] === -26.13, `Expected MAE in flush params, got ${update?.params?.[10]}`);
  assert(update?.params?.[11] === 1.44, `Expected trailing high in flush params, got ${update?.params?.[11]}`);
  assert(update?.params?.[12] === 1.22, `Expected trailing stop in flush params, got ${update?.params?.[12]}`);
  assert(JSON.parse(update?.params?.[13]).smartStopWarning.belowStopCount === 1, 'Expected exit-state analysis in flush params');
}

async function testFlushPreservesQuoteThatArrivesDuringFlush() {
  const redis = createRedisMock();
  let service: MarketDataWriteBufferService;
  let injectedNewerQuote = false;
  const { fastify } = createFastifyMock(async (sql) => {
    if (!injectedNewerQuote && sql.includes('INSERT INTO price_history')) {
      injectedNewerQuote = true;
      await service.recordQuote({
        positionId: 42,
        price: 1.55,
        recordedAt: '2026-07-01T15:32:00.000Z'
      });
    }
  });
  service = new MarketDataWriteBufferService(fastify, redis);

  await service.recordQuote({
    positionId: 42,
    price: 1.23,
    recordedAt: '2026-07-01T15:30:00.000Z'
  });

  const summary = await service.flushToDatabase();
  const remainingHistory = await service.getBufferedPriceHistory(42);
  const current = await service.applyLatestToPosition({ id: 42, status: 'OPEN', current_price: 1.23 } as any);

  assert(summary.flushed === 1, `Expected one flushed position, got ${summary.flushed}`);
  assert(remainingHistory.length === 1, `Expected newer quote history to remain buffered, got ${remainingHistory.length}`);
  assert(remainingHistory[0].price === 1.55, `Expected newer buffered history price 1.55, got ${remainingHistory[0].price}`);
  assert(current.current_price === 1.55, `Expected newer buffered current price 1.55, got ${current.current_price}`);
}

async function runTests() {
  console.log('Running MarketDataWriteBufferService tests...');
  await testQuotePushIsTargetedToTheOwner();
  await testCriticalFieldsWriteThroughOnChangeOnly();
  await testQuoteTelemetryBuffersUntilFlush();
  await testBufferedQuoteOverlaysDbPositionRows();
  await testFlushPersistsBufferedExitState();
  await testFlushPreservesQuoteThatArrivesDuringFlush();
  console.log('All MarketDataWriteBufferService tests passed!');
}

runTests().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
