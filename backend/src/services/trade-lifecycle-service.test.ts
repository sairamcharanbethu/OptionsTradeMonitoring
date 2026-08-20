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
  const reportedFill = TradeLifecycleService.staleEntryDecision('FILLED');
  const market = TradeLifecycleService.staleEntryDecision('PENDING');

  assert(protectedLimit.state === 'REVIEW_REQUIRED', `Expected protected limit to require review, got ${protectedLimit.state}`);
  assert(protectedLimit.executionStatus === 'ENTRY_RECONCILE_REQUIRED', `Expected protected limit execution status ENTRY_RECONCILE_REQUIRED, got ${protectedLimit.executionStatus}`);
  assert(reportedFill.state === 'REVIEW_REQUIRED', `Expected broker-reported fill to require review, got ${reportedFill.state}`);
  assert(reportedFill.executionStatus === 'ENTRY_RECONCILE_REQUIRED', `Expected broker-reported fill to require reconciliation, got ${reportedFill.executionStatus}`);
  assert(reportedFill.message.includes('reports this entry as filled'), `Expected broker-reported fill explanation, got ${reportedFill.message}`);
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

async function testExitSubmissionFailureSeparatesRetryableAndAmbiguousOutcomes() {
  const captured: Array<{ params?: any[] }> = [];
  const db = {
    query: async (_sql: string, params?: any[]) => {
      captured.push({ params });
      return { rows: [], rowCount: 1 };
    }
  };

  await TradeLifecycleService.markExitSubmissionFailure(db, 44, 'broker rejected request');
  await TradeLifecycleService.markExitSubmissionFailure(db, 45, 'request timed out', 'Exit failed', {
    ambiguous: true,
    orderId: 'possible-order',
    requestedQuantity: 1
  });

  assert(captured[0].params?.[0] === 'EXIT_RETRYABLE', 'A definite pre-acceptance failure must remain retryable');
  assert(captured[1].params?.[0] === 'EXIT_RECONCILE_REQUIRED', 'An ambiguous submission must require reconciliation');
  assert(captured[1].params?.[2] === 'possible-order', 'A returned broker id must survive a local persistence failure');
  assert(captured[1].params?.[4] === 1, 'An ambiguous trim must retain its requested quantity for exact reconciliation');
  assert(TradeLifecycleService.canRetryExit({ status: 'OPEN', execution_status: 'EXIT_RETRYABLE', exit_retry_count: 0 }).allowed,
    'A definite failed submission must be retryable without a broker order id');
  assert(!TradeLifecycleService.canRetryExit({ status: 'OPEN', execution_status: 'EXIT_RECONCILE_REQUIRED', exit_retry_count: 0 }).allowed,
    'An ambiguous submission must never be retried without broker reconciliation');
}

async function testAutonomousExitRetryRequiresFreshTerminalBrokerEvidence() {
  const now = new Date().toISOString();
  const confirmedRejected = TradeLifecycleService.canAutoRetryExit({
    status: 'OPEN',
    execution_status: 'EXIT_REJECTED',
    broker_exit_order_id: 'exit-order-1',
    last_broker_order_status: 'REJECTED',
    last_broker_sync_at: now,
    exit_retry_count: 0
  });
  const unknownBrokerState = TradeLifecycleService.canAutoRetryExit({
    status: 'OPEN',
    execution_status: 'EXIT_REJECTED',
    broker_exit_order_id: 'exit-order-1',
    last_broker_order_status: 'UNKNOWN',
    last_broker_sync_at: now,
    exit_retry_count: 0
  });
  const staleEvidence = TradeLifecycleService.canAutoRetryExit({
    status: 'OPEN',
    execution_status: 'EXIT_REJECTED',
    broker_exit_order_id: 'exit-order-1',
    last_broker_order_status: 'REJECTED',
    last_broker_sync_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    exit_retry_count: 0
  });
  const definitePreAcceptanceFailure = TradeLifecycleService.canAutoRetryExit({
    status: 'OPEN',
    execution_status: 'EXIT_RETRYABLE',
    broker_exit_order_id: null,
    broker_exit_trade_id: null,
    exit_retry_count: 0
  });
  const retryLimitReached = TradeLifecycleService.canAutoRetryExit({
    status: 'OPEN',
    execution_status: 'EXIT_REJECTED',
    broker_exit_order_id: 'exit-order-1',
    last_broker_order_status: 'REJECTED',
    last_broker_sync_at: now,
    exit_retry_count: TradeLifecycleService.MAX_EXIT_RETRIES
  });

  assert(confirmedRejected.allowed, 'A freshly broker-confirmed rejected exit should be safe for bounded autonomous retry');
  assert(!unknownBrokerState.allowed, 'UNKNOWN broker state must never authorize an autonomous close retry');
  assert(!staleEvidence.allowed, 'Stale terminal broker evidence must not authorize an autonomous close retry');
  assert(definitePreAcceptanceFailure.allowed, 'A definite pre-acceptance failure without a broker id should remain autonomously retryable');
  assert(!retryLimitReached.allowed, 'Autonomous close retry must respect the existing retry limit');
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
  await testExitSubmissionFailureSeparatesRetryableAndAmbiguousOutcomes();
  await testAutonomousExitRetryRequiresFreshTerminalBrokerEvidence();
  await testShortOptionLifecycleHelpers();
  await testTradeExcursionAccumulatesExtremes();
  console.log('All TradeLifecycleService tests passed!');
}

async function testTradeExcursionAccumulatesExtremes() {
  // Long premium: favorable = higher mark, adverse = lower; extremes accumulate.
  const up = TradeLifecycleService.calculateTradeExcursion({ entry_price: 2 }, 2.5);
  assert(up.mfePct === 25 && up.maePct === 0 && up.changed, `long up: ${JSON.stringify(up)}`);
  const down = TradeLifecycleService.calculateTradeExcursion(
    { entry_price: 2, max_favorable_price: 2.5, max_adverse_price: 2 }, 1.5);
  assert(down.mfePct === 25 && down.maePct === 25 && down.changed, `long preserves MFE, adds MAE: ${JSON.stringify(down)}`);
  const flat = TradeLifecycleService.calculateTradeExcursion(
    { entry_price: 2, max_favorable_price: 2.5, max_adverse_price: 1.5 }, 2.0);
  assert(flat.changed === false, `no new extreme -> unchanged: ${JSON.stringify(flat)}`);
  // Short premium: a premium DROP is favorable.
  const short = TradeLifecycleService.calculateTradeExcursion({ entry_price: 2, entry_action: 'SELL_TO_OPEN' }, 1.5);
  assert(short.mfePct === 25 && short.maePct === 0, `short favorable on premium drop: ${JSON.stringify(short)}`);
}

runTests().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
