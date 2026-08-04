import Fastify from 'fastify';
import { marketDataRoutes } from './market-data';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function testSymbolPriceUpdatesUnderlyingOnly() {
  const originalSecret = process.env.MARKET_DATA_WEBHOOK_SECRET;
  process.env.MARKET_DATA_WEBHOOK_SECRET = 'test-secret';
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const app = Fastify({ logger: false });
  (app as any).decorate('pg', {
    query: async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      return { rows: [], rowCount: 2 };
    }
  });

  try {
    await app.register(marketDataRoutes, { prefix: '/api/market-data' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/market-data/update-price',
      headers: { 'x-market-data-secret': 'test-secret' },
      payload: { symbol: 'spy', price: 768.46 }
    });

    assert(response.statusCode === 200, `Expected 200, got ${response.statusCode}: ${response.body}`);
    assert(queries.length === 1, `Expected one database update, got ${queries.length}`);
    assert(queries[0].sql.includes('SET underlying_price = $1'), 'Symbol quote must update underlying_price');
    assert(!queries[0].sql.includes('current_price'), 'Symbol quote must never update an option premium');
    assert(!queries[0].sql.includes('price_history'), 'Underlying quote must not enter option premium history');
    assert(queries[0].params[0] === 768.46 && queries[0].params[1] === 'SPY', 'Expected normalized SPY underlying update');
    const payload = response.json();
    assert(payload.processed === 2 && payload.updates === 2, 'Expected affected position counts in response');
    assert(payload.alerts_triggered === 0, 'Underlying-only updates must not trigger premium exits');
  } finally {
    if (originalSecret === undefined) delete process.env.MARKET_DATA_WEBHOOK_SECRET;
    else process.env.MARKET_DATA_WEBHOOK_SECRET = originalSecret;
    await app.close();
  }
}

async function runTests() {
  console.log('Running market data route tests...');
  await testSymbolPriceUpdatesUnderlyingOnly();
  console.log('All market data route tests passed!');
}

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
