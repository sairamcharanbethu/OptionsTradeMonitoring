import '@fastify/postgres';
import { OrderWatchdogService } from './order-watchdog-service';
import { DiscordAlertService } from './discord-alert-service';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

type Call = { sql: string; params?: any[] };

function baseRow(overrides: Record<string, any> = {}) {
  return {
    id: 704,
    user_id: 5,
    symbol: 'SPY',
    option_type: 'PUT',
    strike_price: 737,
    expiration_date: '2026-10-10',
    status: 'PENDING_ORDER',
    execution_status: 'PENDING_RECONCILE',
    exit_order_type: null,
    created_at: new Date(Date.now() - 20_000).toISOString(),
    exit_requested_at: null,
    broker_order_id: null,
    broker_exit_order_id: null,
    account_id: 'acct-1',
    execution_account_id: null,
    notes: '',
    signal_id: 9001,
    entry_cancel_attempts: 0,
    entry_cancel_requested_at: null,
    last_broker_order_status: null,
    last_broker_sync_at: null,
    ...overrides
  };
}

function createHarness(rows: any[], options: { onUpdate?: (params: any[] | undefined, sql: string) => void } = {}) {
  const calls: Call[] = [];
  const cancels: Array<{ userId: number; accountId: string; brokerOrderId: string }> = [];
  const alerts: any[] = [];
  const fastify = {
    log: { warn: () => {}, info: () => {} },
    pg: {
      query: async (sql: string, params?: any[]) => {
        calls.push({ sql, params });
        if (sql.includes('FROM positions')) return { rows };
        if (sql.includes('UPDATE positions')) {
          options.onUpdate?.(params, sql);
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes('UPDATE signal_user_executions')) return { rowCount: 1, rows: [] };
        return { rows: [] };
      }
    }
  } as any;
  const watchdog = new OrderWatchdogService(fastify);
  watchdog.cancelClientFactory = () => ({
    cancelOptionOrder: async (userId: number, accountId: string, brokerOrderId: string) => {
      cancels.push({ userId, accountId, brokerOrderId });
      return { status: 'PENDING_CANCEL' };
    }
  });
  return { watchdog, calls, cancels, alerts, fastify };
}

let capturedAlerts: any[] = [];
const originalSend = DiscordAlertService.prototype.send;
DiscordAlertService.prototype.send = async function (input: any) {
  capturedAlerts.push(input);
  return true;
};

const updatesOf = (calls: Call[]) => calls.filter(c => c.sql.includes('UPDATE positions'));
const eventsOf = (calls: Call[], type: string) => calls.filter(c => c.sql.includes('INSERT INTO trade_events') && c.params?.[3] === type);

async function testProtectedLimitPendingEntryBecomesReconcileRequired() {
  process.env.ORDER_WATCHDOG_ENTRY_STALE_SECONDS = '10';
  const { watchdog, calls } = createHarness([baseRow()], {
    onUpdate: (params) => {
      assert(params?.[0] === 'ENTRY_RECONCILE_REQUIRED', `Expected reconcile-required status, got ${params?.[0]}`);
      assert(String(params?.[1] || '').includes('Protected limit entry'), 'Expected reconciliation error');
      assert(params?.[3] === 704, `Expected position id 704, got ${params?.[3]}`);
      assert(Array.isArray(params?.[4]) && !params?.[4].includes('FILLED'), 'A pending FILLED row must not be excluded from watchdog recovery');
    }
  });
  const summary = await watchdog.run();
  assert(summary.checked === 1, `Expected 1 checked order, got ${summary.checked}`);
  assert(summary.entryStale === 1, `Expected 1 stale entry, got ${summary.entryStale}`);
  assert(summary.errors.length === 0, `Expected no watchdog errors, got ${summary.errors.join('; ')}`);
  assert(eventsOf(calls, 'ENTRY_STATE_CHANGED').length === 1, 'Expected entry state change event to be recorded');
}

async function testBrokerReportedFillPendingEntryBecomesReconcileRequired() {
  process.env.ORDER_WATCHDOG_ENTRY_STALE_SECONDS = '10';
  // A broker-reported fill with an order id must NOT be cancelled — it needs
  // fill reconciliation, not a cancel that could orphan a real position.
  const { watchdog, calls, cancels } = createHarness([baseRow({
    execution_status: 'FILLED',
    broker_order_id: 'ord-filled',
    created_at: new Date(Date.now() - 600_000).toISOString()
  })], {
    onUpdate: (params) => assert(params?.[0] === 'ENTRY_RECONCILE_REQUIRED', `Expected reconcile-required, got ${params?.[0]}`)
  });
  const summary = await watchdog.run();
  assert(cancels.length === 0, 'A broker-reported fill must never be cancelled');
  assert(summary.entryStale === 1, `Expected broker-reported fill to become reconciliation-required, got ${summary.entryStale}`);
  assert(updatesOf(calls).length === 1, 'Expected broker-reported fill to be updated instead of remaining pending forever');
}

async function testDefaultCancelsUnfilledEntryAfterTwoMinutes() {
  delete process.env.ENTRY_UNFILLED_CANCEL_SECONDS;
  process.env.ORDER_WATCHDOG_ENTRY_STALE_SECONDS = '180';
  const { watchdog, calls, cancels } = createHarness([baseRow({
    broker_order_id: 'ord-1',
    created_at: new Date(Date.now() - 130_000).toISOString()
  })]);
  assert(watchdog.config().entryUnfilledCancelSeconds === 120, 'Default unfilled-entry cancel is 120s');
  const summary = await watchdog.run();
  assert(cancels.length === 1 && cancels[0].brokerOrderId === 'ord-1' && cancels[0].accountId === 'acct-1', 'The broker cancel must be requested with the order and account ids');
  assert(summary.entryCancelRequested === 1 && summary.entryStale === 0, 'A cancel request takes the place of the stale flag on that pass');
  const update = updatesOf(calls)[0];
  assert(update.sql.includes('entry_cancel_attempts = $1') && update.params?.[0] === 1, 'The attempt counter is persisted');
  assert(eventsOf(calls, 'ENTRY_CANCEL_REQUESTED').length === 1, 'The cancel is recorded as a trade event');
}

async function testCancelAppliesToStaleAndReconcileRequiredRows() {
  delete process.env.ENTRY_UNFILLED_CANCEL_SECONDS;
  for (const status of ['ENTRY_STALE', 'ENTRY_RECONCILE_REQUIRED', 'PENDING_RECONCILE', null]) {
    const { watchdog, cancels } = createHarness([baseRow({
      execution_status: status,
      broker_order_id: 'ord-2',
      created_at: new Date(Date.now() - 300_000).toISOString()
    })]);
    await watchdog.run();
    assert(cancels.length === 1, `An unfilled entry in status ${status} must still be cancelled`);
  }
}

async function testCancelRetriesEveryMinuteAndStopsAtThree() {
  delete process.env.ENTRY_UNFILLED_CANCEL_SECONDS;
  const old = new Date(Date.now() - 400_000).toISOString();
  // Requested 10s ago: not due yet.
  const recent = createHarness([baseRow({ broker_order_id: 'ord-3', created_at: old, entry_cancel_attempts: 1, entry_cancel_requested_at: new Date(Date.now() - 10_000).toISOString() })]);
  const recentSummary = await recent.watchdog.run();
  assert(recent.cancels.length === 0 && recentSummary.stillPending === 1, 'A cancel requested 10s ago is not re-requested yet');
  // Requested 70s ago: second attempt.
  const due = createHarness([baseRow({ broker_order_id: 'ord-3', created_at: old, entry_cancel_attempts: 1, entry_cancel_requested_at: new Date(Date.now() - 70_000).toISOString() })]);
  await due.watchdog.run();
  assert(due.cancels.length === 1 && updatesOf(due.calls)[0].params?.[0] === 2, 'A cancel older than the retry interval is re-requested and counted');
  // Three attempts spent: no more cancels, critical alert, row still flagged stale.
  capturedAlerts = [];
  const exhausted = createHarness([baseRow({ broker_order_id: 'ord-3', created_at: old, entry_cancel_attempts: 3, entry_cancel_requested_at: new Date(Date.now() - 70_000).toISOString() })]);
  const exhaustedSummary = await exhausted.watchdog.run();
  assert(exhausted.cancels.length === 0, 'No cancel is sent once the attempt budget is spent');
  assert(exhaustedSummary.entryCancelExhausted === 1, 'The exhausted cancel is counted');
  assert(capturedAlerts.some(a => a.category === 'entry-cancel-failed' && a.severity === 'critical'), 'Exhausting the cancel budget pages the operator');
  assert(exhaustedSummary.entryStale === 1, 'The exhausted row is still marked stale for review');
}

async function testCancelRequestFailureStillCountsAnAttempt() {
  delete process.env.ENTRY_UNFILLED_CANCEL_SECONDS;
  const { watchdog, calls } = createHarness([baseRow({ broker_order_id: 'ord-4', created_at: new Date(Date.now() - 300_000).toISOString() })]);
  watchdog.cancelClientFactory = () => ({ cancelOptionOrder: async () => { throw new Error('snaptrade 502'); } });
  const summary = await watchdog.run();
  assert(summary.errors.length === 0, 'A failed cancel request is handled, not thrown');
  assert(updatesOf(calls)[0].params?.[0] === 1 && String(updatesOf(calls)[0].params?.[1]).includes('snaptrade 502'), 'The failed request consumes an attempt and records the error');
}

async function testDisabledCancelKeepsFlagOnlyBehaviour() {
  process.env.ENTRY_UNFILLED_CANCEL_SECONDS = '0';
  process.env.ORDER_WATCHDOG_ENTRY_STALE_SECONDS = '180';
  const { watchdog, cancels } = createHarness([baseRow({ broker_order_id: 'ord-5', created_at: new Date(Date.now() - 300_000).toISOString() })]);
  const summary = await watchdog.run();
  assert(cancels.length === 0 && summary.entryStale === 1, 'ENTRY_UNFILLED_CANCEL_SECONDS=0 disables cancels and keeps the stale flag');
  delete process.env.ENTRY_UNFILLED_CANCEL_SECONDS;
}

async function testUnresolvedEntryWithoutBrokerIdIsAbandonedAfterGrace() {
  capturedAlerts = [];
  const { watchdog, calls } = createHarness([baseRow({
    broker_order_id: null,
    created_at: new Date(Date.now() - 1_000_000).toISOString(),
    last_broker_order_status: 'UNKNOWN',
    last_broker_sync_at: new Date(Date.now() - 30_000).toISOString(),
    execution_status: 'ENTRY_STALE'
  })]);
  const summary = await watchdog.run();
  assert(summary.entryAbandoned === 1, `Expected the unresolved entry to be abandoned, got ${JSON.stringify(summary)}`);
  const update = updatesOf(calls)[0];
  assert(update.sql.includes("status = 'CLOSED'") && update.sql.includes("execution_status = 'ENTRY_ABANDONED'") && update.sql.includes('broker_order_id IS NULL'),
    'Abandonment closes the row and is guarded on the broker id still being unknown');
  const release = calls.find(c => c.sql.includes('UPDATE signal_user_executions'));
  assert(Boolean(release) && release!.params?.[1] === 5 && release!.params?.[2] === 9001, 'The signal claim is released for the same user/signal');
  assert(capturedAlerts.some(a => a.category === 'entry-abandoned'), 'The operator is told the slot was freed');
}

async function testUnresolvedEntryIsNotAbandonedTooEarlyOrWithoutSync() {
  // Too young.
  const young = createHarness([baseRow({ created_at: new Date(Date.now() - 300_000).toISOString(), last_broker_order_status: 'UNKNOWN', last_broker_sync_at: new Date().toISOString() })]);
  process.env.ORDER_WATCHDOG_ENTRY_STALE_SECONDS = '180';
  const youngSummary = await young.watchdog.run();
  assert(youngSummary.entryAbandoned === 0 && youngSummary.entryStale === 1, 'A 5-minute-old entry is flagged, not abandoned');
  // Old but the sync never ran (no last_broker_sync_at): do not guess.
  const unsynced = createHarness([baseRow({ created_at: new Date(Date.now() - 1_000_000).toISOString(), last_broker_order_status: null, last_broker_sync_at: null })]);
  const unsyncedSummary = await unsynced.watchdog.run();
  assert(unsyncedSummary.entryAbandoned === 0, 'Without a broker sync verdict the entry is never abandoned');
}

async function testStuckMarketExitPagesButLimitExitDoesNot() {
  capturedAlerts = [];
  const { watchdog } = createHarness([
    baseRow({ id: 801, status: 'OPEN', execution_status: 'PENDING_EXIT', exit_order_type: 'MARKET', exit_requested_at: new Date(Date.now() - 200_000).toISOString(), broker_exit_order_id: 'x-1' }),
    baseRow({ id: 802, status: 'OPEN', execution_status: 'PENDING_EXIT', exit_order_type: 'LIMIT', exit_requested_at: new Date(Date.now() - 200_000).toISOString() }),
    baseRow({ id: 803, status: 'OPEN', execution_status: 'PENDING_EXIT', exit_order_type: 'MARKET', exit_requested_at: new Date(Date.now() - 30_000).toISOString() })
  ]);
  const summary = await watchdog.run();
  assert(summary.exitStale === 1, `Only the old MARKET exit is stale (got ${summary.exitStale})`);
  assert(summary.stillPending === 2, 'The LIMIT exit (owned by the sync) and the fresh MARKET exit stay pending');
  const alert = capturedAlerts.find(a => a.category === 'exit-stale-market');
  assert(Boolean(alert) && alert.severity === 'critical' && alert.tradeId === 801, 'A MARKET exit pending for 2+ minutes pages critically');
}

async function runTests() {
  console.log('Running OrderWatchdogService tests...');
  try {
    await testProtectedLimitPendingEntryBecomesReconcileRequired();
    await testBrokerReportedFillPendingEntryBecomesReconcileRequired();
    await testDefaultCancelsUnfilledEntryAfterTwoMinutes();
    await testCancelAppliesToStaleAndReconcileRequiredRows();
    await testCancelRetriesEveryMinuteAndStopsAtThree();
    await testCancelRequestFailureStillCountsAnAttempt();
    await testDisabledCancelKeepsFlagOnlyBehaviour();
    await testUnresolvedEntryWithoutBrokerIdIsAbandonedAfterGrace();
    await testUnresolvedEntryIsNotAbandonedTooEarlyOrWithoutSync();
    await testStuckMarketExitPagesButLimitExitDoesNot();
  } finally {
    DiscordAlertService.prototype.send = originalSend;
  }
  console.log('All OrderWatchdogService tests passed!');
}

runTests().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
