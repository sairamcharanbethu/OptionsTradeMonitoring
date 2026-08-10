import Fastify from 'fastify';
import { signalRoutes } from './signals';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function testStrategyHistoryIncludesCompactShadowEvidence() {
  let capturedSql = '';
  const entryStructure = {
    mode: 'shadow',
    confluence: { grade: 'TRIPLE_CONFLUENCE', entry_authority: false }
  };
  const app = Fastify({ logger: false });
  (app as any).decorate('authenticate', async (request: any) => {
    request.user = { id: 42 };
  });
  (app as any).decorate('pg', {
    query: async (sql: string, params: unknown[]) => {
      capturedSql = sql;
      assert(params[0] === 42, 'Strategy history must remain scoped to the authenticated user');
      return {
        rows: [{
          id: 1,
          setup_id: 'setup-1',
          side: 'CALL',
          entry_structure_context: entryStructure,
          strategy_family_context: { mode: 'shadow', entry_authority: false },
          trendline_context: { mode: 'shadow' },
          lifecycle_events: [{
            id: 10,
            entryStructure,
            strategyFamilyContext: { mode: 'shadow', entry_authority: false },
            trendlineContext: { mode: 'shadow' }
          }]
        }]
      };
    }
  });

  try {
    await app.register(signalRoutes, { prefix: '/api/signals' });
    const response = await app.inject({
      method: 'GET',
      url: '/api/signals/strategy-history'
    });

    assert(response.statusCode === 200, `Expected 200, got ${response.statusCode}: ${response.body}`);
    assert(capturedSql.includes("'entryStructure'"), 'Lifecycle replay must select compact entry structure evidence');
    assert(capturedSql.includes("'strategyFamilyContext'"), 'Lifecycle replay must select compact strategy family evidence');
    assert(capturedSql.includes("'trendlineContext'"), 'Lifecycle replay must select compact trendline evidence');
    assert(!capturedSql.includes('completed_bars'), 'Strategy history must not return raw completed bars');
    const payload = response.json();
    assert(payload[0].entry_structure_context.mode === 'shadow', 'Setup history must expose shadow entry structure');
    assert(payload[0].strategy_family_context.entry_authority === false, 'Setup history must expose advisory strategy families');
    assert(payload[0].lifecycle_events[0].entryStructure.confluence.entry_authority === false, 'Lifecycle evidence must retain advisory authority');
  } finally {
    await app.close();
  }
}

async function testStrategyFamilyHistoryUsesShadowJournalReader() {
  let requestedLimit = 0;
  const app = Fastify({ logger: false });
  (app as any).decorate('authenticate', async (request: any) => {
    request.user = { id: 42 };
  });
  (app as any).decorate('pg', { query: async () => ({ rows: [] }) });
  (app as any).decorate('strategyEngine', {
    getStrategyFamilyHistory: async (limit: number) => {
      requestedLimit = limit;
      return [{
        event_id: 'orb-index:test',
        family: 'ORB_INDEX',
        entry_authority: false
      }];
    }
  });

  try {
    await app.register(signalRoutes, { prefix: '/api/signals' });
    const response = await app.inject({
      method: 'GET',
      url: '/api/signals/strategy-family-history?limit=25'
    });

    assert(response.statusCode === 200, `Expected 200, got ${response.statusCode}: ${response.body}`);
    assert(requestedLimit === 25, 'Strategy family history must validate and forward the requested limit');
    const payload = response.json();
    assert(payload[0].family === 'ORB_INDEX', 'Strategy family history must return journal candidates');
    assert(payload[0].entry_authority === false, 'Strategy family history must remain non-authoritative');
  } finally {
    await app.close();
  }
}

async function runTests() {
  console.log('Running signal route tests...');
  await testStrategyHistoryIncludesCompactShadowEvidence();
  await testStrategyFamilyHistoryUsesShadowJournalReader();
  console.log('All signal route tests passed!');
}

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
