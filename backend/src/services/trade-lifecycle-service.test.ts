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

async function runTests() {
  console.log('Running TradeLifecycleService tests...');
  await testEntrySubmittedStatusMapsOrderTypes();
  await testStaleEntryDecisionMapsReviewAndStaleStates();
  await testFinalEntryExecutionStatuses();
  console.log('All TradeLifecycleService tests passed!');
}

runTests().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
