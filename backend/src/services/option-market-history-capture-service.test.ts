import '@fastify/postgres';
import { OptionMarketHistoryCaptureService } from './option-market-history-capture-service';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function testCaptureNormalizesAndFlushesOptionQuotes() {
  const queries: Array<{ sql: string; params?: any[] }> = [];
  const fastify = {
    log: { warn: () => {} },
    pg: { query: async (sql: string, params?: any[]) => { queries.push({ sql, params }); return { rows: [] }; } }
  } as any;
  const service = new OptionMarketHistoryCaptureService(fastify);

  service.handleQuote({
    provider: 'ibkr',
    symbol: 'SPY260712C00755000',
    bidPrice: 1.2,
    askPrice: 1.3,
    lastTradePrice: 1.25,
    volume: 900,
    openInterest: 2_000,
    delta: 0.45,
    gamma: 0.08,
    theta: -0.2,
    volatility: 0.22,
    quoteTimestamp: '2026-07-12T14:30:00.000Z'
  });
  await service.flush();

  assert(queries.length === 1, 'Expected one persistence query');
  assert(queries[0].sql.includes('option_market_history'), 'Expected option history insert');
  assert(queries[0].params?.includes('SPY260712C00755000') === true, 'Expected normalized OSI ticker in insert');
  assert(queries[0].params?.includes(1.25) === true, 'Expected midpoint mark in insert');
}

async function testCaptureIgnoresNonOptionQuotes() {
  const queries: Array<{ sql: string; params?: any[] }> = [];
  const service = new OptionMarketHistoryCaptureService({
    log: { warn: () => {} },
    pg: { query: async (sql: string, params?: any[]) => { queries.push({ sql, params }); return { rows: [] }; } }
  } as any);
  service.handleQuote({ provider: 'ibkr', symbol: 'SPY', price: 755 });
  await service.flush();
  assert(queries.length === 0, 'Underlying quotes should not be persisted as option history');
}

async function runTests() {
  console.log('Running option market history capture tests...');
  await testCaptureNormalizesAndFlushesOptionQuotes();
  await testCaptureIgnoresNonOptionQuotes();
  console.log('All option market history capture tests passed!');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
