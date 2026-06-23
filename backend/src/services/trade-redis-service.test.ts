import { TradeRedisService } from './trade-redis-service';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function testRecordEventPersistsSignalId() {
  const queries: { sql: string; params?: any[] }[] = [];
  const db = {
    query: async (sql: string, params?: any[]) => {
      queries.push({ sql, params });
      return { rows: [] };
    }
  };

  await TradeRedisService.recordEvent(db, {
    userId: 7,
    signalId: 246,
    eventType: 'SIGNAL_GENERATED',
    message: 'QQQ PUT signal generated',
    metadata: { symbol: 'QQQ', side: 'PUT' }
  });

  const insert = queries[0];
  assert(insert.sql.includes('signal_id'), 'Event insert should include signal_id');
  assert(insert.params?.[0] === 7, `Expected user id 7, got ${insert.params?.[0]}`);
  assert(insert.params?.[1] === 246, `Expected signal id 246, got ${insert.params?.[1]}`);
  assert(insert.params?.[2] === null, `Expected empty position id, got ${insert.params?.[2]}`);
  assert(insert.params?.[3] === 'SIGNAL_GENERATED', `Expected SIGNAL_GENERATED event type, got ${insert.params?.[3]}`);
}

async function runTests() {
  console.log('Running TradeRedisService tests...');
  await testRecordEventPersistsSignalId();
  console.log('All TradeRedisService tests passed!');
}

runTests().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
