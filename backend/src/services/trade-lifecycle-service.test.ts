import { TradeLifecycleService } from './trade-lifecycle-service';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function testEntrySubmittedStatusMapsOrderTypes() {
  const limit = TradeLifecycleService.entrySubmittedStatus('LIMIT');
  const market = TradeLifecycleService.entrySubmittedStatus('MARKET');

  assert(limit.state === 'PENDING_RECONCILE', `Expected LIMIT state PENDING_RECONCILE, got ${limit.state}`);
  assert(limit.executionStatus === 'PENDING_RECONCILE', `Expected LIMIT execution status PENDING_RECONCILE, got ${limit.executionStatus}`);
  assert(market.state === 'SUBMITTED', `Expected MARKET state SUBMITTED, got ${market.state}`);
  assert(market.executionStatus === 'PENDING', `Expected MARKET execution status PENDING, got ${market.executionStatus}`);
}

async function testStaleEntryDecisionMapsReviewAndStaleStates() {
  const protectedLimit = TradeLifecycleService.staleEntryDecision('PENDING_RECONCILE');
  const market = TradeLifecycleService.staleEntryDecision('PENDING');

  assert(protectedLimit.state === 'REVIEW_REQUIRED', `Expected protected limit to require review, got ${protectedLimit.state}`);
  assert(protectedLimit.executionStatus === 'ENTRY_RECONCILE_REQUIRED', `Expected protected limit execution status ENTRY_RECONCILE_REQUIRED, got ${protectedLimit.executionStatus}`);
  assert(market.state === 'STALE', `Expected market pending to become STALE, got ${market.state}`);
  assert(market.executionStatus === 'ENTRY_STALE', `Expected market execution status ENTRY_STALE, got ${market.executionStatus}`);
}

async function testFinalEntryExecutionStatuses() {
  assert(TradeLifecycleService.isFinalEntryExecutionStatus('FILLED_FULLY'), 'FILLED_FULLY should be final');
  assert(TradeLifecycleService.isFinalEntryExecutionStatus('ENTRY_RECONCILE_REQUIRED'), 'ENTRY_RECONCILE_REQUIRED should be final for watchdog updates');
  assert(!TradeLifecycleService.isFinalEntryExecutionStatus('PENDING_RECONCILE'), 'PENDING_RECONCILE should not be final');
}

async function testMarkExitSubmittedRecordsPendingTrimMetadata() {
  const captured: Array<{ sql: string; params?: any[] }> = [];
  const db = {
    query: async (sql: string, params?: any[]) => {
      captured.push({ sql, params });
      return { rows: [{ id: 42, execution_status: 'PENDING_TRIM', profit_trim_quantity: params?.[7] }] };
    }
  };

  const result = await TradeLifecycleService.markExitSubmitted(db, 42, { orderId: 'order-1', tradeId: 'trade-1' }, {
    reason: 'MANUAL_TRIM',
    orderType: 'MARKET',
    note: ' trim note',
    trimQuantity: 3
  });

  assert(result.execution_status === 'PENDING_TRIM', 'Mocked trim result should return PENDING_TRIM');
  const query = captured[0];
  assert(query.sql.includes("THEN 'PENDING_TRIM' ELSE 'PENDING_EXIT'"), 'Exit submission SQL should map partial trims to PENDING_TRIM');
  assert(query.sql.includes("profit_trim_status = CASE"), 'Exit submission SQL should set trim metadata for partial trims');
  assert(query.params?.[0] === 'order-1', 'Should store broker exit order id');
  assert(query.params?.[2] === 'MANUAL_TRIM', 'Should store trim exit reason');
  assert(query.params?.[7] === 3, `Should pass trim quantity param, got ${query.params?.[7]}`);
}

async function testMarkExitSubmittedDoesNotMarkTrimWithoutTrimQuantity() {
  const captured: Array<{ params?: any[] }> = [];
  const db = {
    query: async (_sql: string, params?: any[]) => {
      captured.push({ params });
      return { rows: [{ id: 43, execution_status: 'PENDING_EXIT' }] };
    }
  };

  await TradeLifecycleService.markExitSubmitted(db, 43, { orderId: 'order-2' }, {
    reason: 'MANUAL_TRIM_FULL',
    orderType: 'MARKET',
    note: ' full trim note',
    trimQuantity: null
  });

  const query = captured[0];
  assert(query.params?.[2] === 'MANUAL_TRIM_FULL', 'Should preserve full trim reason');
  assert(query.params?.[7] === null, 'Full trim should not pass partial trim quantity');
}

async function testShortOptionLifecycleHelpers() {
  const longCall = { option_type: 'CALL', entry_action: 'BUY_TO_OPEN', entry_price: 1.5 };
  const shortCall = { option_type: 'CALL', entry_action: 'SELL_TO_OPEN', entry_price: 1.5 };
  const shortPut = { option_type: 'PUT', entry_action: 'SELL_TO_OPEN', entry_price: 1.5 };

  assert(TradeLifecycleService.getExitAction(longCall) === 'SELL_TO_CLOSE', 'Long options should close with SELL_TO_CLOSE');
  assert(TradeLifecycleService.getExitAction(shortCall) === 'BUY_TO_CLOSE', 'Short options should close with BUY_TO_CLOSE');
  assert(TradeLifecycleService.calculateRealizedPnl(longCall, 2, 1) === 50, 'Long option PnL should increase when premium rises');
  assert(TradeLifecycleService.calculateRealizedPnl(shortCall, 1, 1) === 50, 'Short option PnL should increase when premium falls');
  assert(TradeLifecycleService.isUnderlyingStopBroken(shortCall, 505, 500), 'Short call stop should break when underlying rises through stop');
  assert(!TradeLifecycleService.isUnderlyingStopBroken(shortCall, 495, 500), 'Short call stop should not break below stop');
  assert(TradeLifecycleService.isUnderlyingStopBroken(shortPut, 495, 500), 'Short put stop should break when underlying falls through stop');
}

async function runTests() {
  console.log('Running TradeLifecycleService tests...');
  await testEntrySubmittedStatusMapsOrderTypes();
  await testStaleEntryDecisionMapsReviewAndStaleStates();
  await testFinalEntryExecutionStatuses();
  await testMarkExitSubmittedRecordsPendingTrimMetadata();
  await testMarkExitSubmittedDoesNotMarkTrimWithoutTrimQuantity();
  await testShortOptionLifecycleHelpers();
  console.log('All TradeLifecycleService tests passed!');
}

runTests().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
