import Fastify from 'fastify';
import { manualEntryRoutes } from './manual-entry';
import { SnaptradeService } from '../services/snaptrade-service';
import { TradeRedisService } from '../services/trade-redis-service';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function testAcceptedTrimSurvivesPostCommitRefreshFailure() {
  const originalPlaceOptionOrder = SnaptradeService.prototype.placeOptionOrder;
  const originalAcquireLock = TradeRedisService.acquireLock;
  const originalReleaseLock = TradeRedisService.releaseLock;
  const originalRebuildOpenTrades = TradeRedisService.rebuildOpenTrades;
  const originalRequestBrokerSync = TradeRedisService.requestBrokerSync;
  let committed = false;
  let failureStateRecorded = false;
  const warnings: string[] = [];
  const position = {
    id: 41,
    user_id: 7,
    symbol: 'SPY',
    option_type: 'CALL',
    strike_price: 769,
    expiration_date: '2026-08-04',
    entry_price: 1,
    current_price: 1.2,
    quantity: 2,
    status: 'OPEN',
    execution_status: 'FILLED',
    execution_broker: 'wealthsimple_snaptrade',
    execution_account_id: '7:test-account',
    entry_action: 'BUY_TO_OPEN',
    exit_action: 'SELL_TO_CLOSE',
    analysis_data: { manualEntry: { enabled: true, source: 'manual-entry' } },
    notes: '[Manual Entry]'
  };
  const client = {
    query: async (sql: string) => {
      if (sql === 'COMMIT') {
        committed = true;
        return { rows: [] };
      }
      if (sql.includes('SELECT *') && sql.includes('FROM positions')) return { rows: [position] };
      if (sql.includes('UPDATE positions') && sql.includes('execution_status = CASE')) {
        return {
          rows: [{
            ...position,
            execution_status: 'PENDING_TRIM',
            broker_exit_order_id: 'trim-order-1',
            profit_trim_status: 'PENDING',
            profit_trim_quantity: 1,
            profit_trim_order_id: 'trim-order-1'
          }]
        };
      }
      if (sql.includes("execution_status = $1") && sql.includes('execution_error = $2')) {
        failureStateRecorded = true;
      }
      return { rows: [], rowCount: 1 };
    },
    release: () => {}
  };
  const app = Fastify({ logger: false });
  (app as any).log.warn = (message: string) => warnings.push(message);
  (app as any).decorate('authenticate', async (request: any) => { request.user = { id: 7, role: 'ADMIN' }; });
  (app as any).decorate('pg', {
    query: async () => ({ rows: [] }),
    connect: async () => client
  });

  try {
    (SnaptradeService.prototype as any).placeOptionOrder = async () => ({ orderId: 'trim-order-1', tradeId: null });
    (TradeRedisService as any).acquireLock = async () => ({ key: 'test', token: 'token', acquired: true, degraded: true });
    (TradeRedisService as any).releaseLock = async () => {};
    (TradeRedisService as any).rebuildOpenTrades = async () => { throw new Error('cache unavailable'); };
    (TradeRedisService as any).requestBrokerSync = async () => { throw new Error('queue unavailable'); };

    await app.register(manualEntryRoutes, { prefix: '/api/manual-entry' });
    const response = await app.inject({
      method: 'POST',
      url: '/api/manual-entry/positions/41/trim',
      payload: { quantity: 1 }
    });
    const payload = response.json();

    assert(response.statusCode === 200, `Accepted trim must return 200 after post-commit refresh failure, got ${response.statusCode}: ${response.body}`);
    assert(payload.execution_status === 'PENDING_TRIM', `Expected PENDING_TRIM, got ${payload.execution_status}`);
    assert(payload.broker_exit_order_id === 'trim-order-1', 'Accepted broker order id must be returned');
    assert(committed, 'The accepted trim must commit before cache refresh');
    assert(failureStateRecorded === false, 'Post-commit refresh failure must not rewrite an accepted trim as failed');
    assert(warnings.length === 2, `Both best-effort refresh failures should be logged, got ${warnings.length}`);
  } finally {
    (SnaptradeService.prototype as any).placeOptionOrder = originalPlaceOptionOrder;
    (TradeRedisService as any).acquireLock = originalAcquireLock;
    (TradeRedisService as any).releaseLock = originalReleaseLock;
    (TradeRedisService as any).rebuildOpenTrades = originalRebuildOpenTrades;
    (TradeRedisService as any).requestBrokerSync = originalRequestBrokerSync;
    await app.close();
  }
}

async function runTests() {
  console.log('Running Manual Entry route tests...');
  await testAcceptedTrimSurvivesPostCommitRefreshFailure();
  console.log('All Manual Entry route tests passed!');
}

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
