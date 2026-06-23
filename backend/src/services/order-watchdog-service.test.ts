import '@fastify/postgres';
import { OrderWatchdogService } from './order-watchdog-service';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function createFastifyMock() {
  const calls: Array<{ sql: string; params?: any[] }> = [];
  const fastify = {
    log: {
      warn: () => {}
    },
    pg: {
      query: async (sql: string, params?: any[]) => {
        calls.push({ sql, params });
        if (sql.includes('FROM positions')) {
          return {
            rows: [{
              id: 704,
              user_id: 5,
              symbol: 'QQQ',
              option_type: 'PUT',
              strike_price: 737,
              expiration_date: '2026-06-22',
              status: 'PENDING_ORDER',
              execution_status: 'PENDING_RECONCILE',
              exit_order_type: null,
              created_at: new Date(Date.now() - 20_000).toISOString(),
              exit_requested_at: null
            }]
          };
        }
        if (sql.includes('UPDATE positions')) {
          assert(params?.[0] === 'ENTRY_RECONCILE_REQUIRED', `Expected reconcile-required status, got ${params?.[0]}`);
          assert(String(params?.[1] || '').includes('Protected limit entry'), 'Expected protected-limit reconciliation error');
          assert(String(params?.[2] || '').includes('protected limit entry reconcile-required'), 'Expected protected-limit reconciliation note');
          assert(params?.[3] === 704, `Expected position id 704, got ${params?.[3]}`);
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes('FROM settings')) {
          return { rows: [] };
        }
        return { rows: [] };
      }
    }
  } as any;
  return { fastify, calls };
}

async function testProtectedLimitPendingEntryBecomesReconcileRequired() {
  process.env.ORDER_WATCHDOG_ENTRY_STALE_SECONDS = '10';
  const { fastify, calls } = createFastifyMock();
  const watchdog = new OrderWatchdogService(fastify);

  const summary = await watchdog.run();

  assert(summary.checked === 1, `Expected 1 checked order, got ${summary.checked}`);
  assert(summary.entryStale === 1, `Expected 1 stale entry, got ${summary.entryStale}`);
  assert(summary.errors.length === 0, `Expected no watchdog errors, got ${summary.errors.join('; ')}`);
  assert(calls.some((call) => call.sql.includes('ENTRY_RECONCILE_REQUIRED')), 'Expected SQL to guard against repeated reconcile-required updates');
}

async function runTests() {
  console.log('Running OrderWatchdogService tests...');
  await testProtectedLimitPendingEntryBecomesReconcileRequired();
  console.log('All OrderWatchdogService tests passed!');
}

runTests().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
