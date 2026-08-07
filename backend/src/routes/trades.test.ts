import { buildCommandReplayEventsQuery } from '../lib/trade-command-events';
import {
  expectedTradeVoidConfirmation,
  getTradeVoidEligibility,
  isTradeExpired,
  isTradeVoidConfirmationValid,
  newYorkDateKey,
  tradeVoidSignalErrorPattern
} from '../lib/trade-void';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function testCommandReplayEventsQueryIncludesSignalAndPositionEvents() {
  const query = buildCommandReplayEventsQuery(7, 704, 246);

  assert(query.text.includes('position_id = $2'), 'Command replay should include position-linked events');
  assert(query.text.includes('signal_id = $3::integer'), 'Command replay should include signal-linked events');
  assert(query.text.includes('ORDER BY created_at ASC, id ASC'), 'Command replay should preserve deterministic event order');
  assert(query.values[0] === 7, `Expected user id 7, got ${query.values[0]}`);
  assert(query.values[1] === 704, `Expected position id 704, got ${query.values[1]}`);
  assert(query.values[2] === 246, `Expected signal id 246, got ${query.values[2]}`);
}

async function testCommandReplayEventsQueryHandlesMissingSignal() {
  const query = buildCommandReplayEventsQuery(7, 704, null);

  assert(query.values[2] === null, 'Missing signal id should be a null query parameter');
  assert(query.text.includes('$3::integer IS NOT NULL'), 'Missing signal id should not match every null signal event');
}

async function testExpiredExitReviewPositionCanBeVoided() {
  const result = getTradeVoidEligibility({
    status: 'OPEN',
    execution_status: 'EXIT_REJECTED',
    execution_broker: 'wealthsimple_snaptrade',
    expiration_date: '2026-08-06',
    is_simulated: false
  }, new Date('2026-08-07T16:00:00Z'));

  assert(result.allowed, result.reason || 'Expected expired live exit-review position to be voidable');
}

async function testVoidRequiresExpiredContractAndUnresolvedExit() {
  const base = {
    status: 'OPEN',
    execution_status: 'EXIT_REJECTED',
    execution_broker: 'wealthsimple_snaptrade',
    expiration_date: '2026-08-07',
    is_simulated: false
  };
  const now = new Date('2026-08-07T16:00:00Z');

  assert(!getTradeVoidEligibility(base, now).allowed, 'Same-day contract must not be voidable');
  assert(!getTradeVoidEligibility({ ...base, expiration_date: '2026-08-08' }, now).allowed, 'Future contract must not be voidable');
  assert(!getTradeVoidEligibility({ ...base, expiration_date: '2026-08-06', execution_status: 'FILLED' }, now).allowed, 'Clean open position must not be voidable');
  assert(!getTradeVoidEligibility({ ...base, expiration_date: '2026-08-06', status: 'CLOSED' }, now).allowed, 'Closed position must not be voidable');
  assert(!getTradeVoidEligibility({ ...base, expiration_date: '2026-08-06', is_simulated: true }, now).allowed, 'Simulated position must not use live cleanup');
  assert(isTradeExpired({ expiration_date: '2026-08-06' }, now), 'Prior-day contract should be recognized as expired');
  assert(!isTradeExpired({ expiration_date: '2026-08-07' }, now), 'Same-day contract should not be recognized as expired');
}

async function testVoidExpiryUsesNewYorkTradingDate() {
  const beforeMidnight = new Date('2026-08-07T03:59:00Z');
  const afterMidnight = new Date('2026-08-07T04:01:00Z');
  assert(newYorkDateKey(beforeMidnight) === '2026-08-06', 'Trading date should remain Aug 6 before New York midnight');
  assert(newYorkDateKey(afterMidnight) === '2026-08-07', 'Trading date should advance after New York midnight');
}

async function testVoidConfirmationAndSignalPatternAreExact() {
  assert(expectedTradeVoidConfirmation(732) === 'VOID 732', 'Expected position-specific confirmation phrase');
  assert(isTradeVoidConfirmationValid(732, ' VOID 732 '), 'Whitespace around exact confirmation should be accepted');
  assert(!isTradeVoidConfirmationValid(732, 'VOID 733'), 'Different position id must be rejected');
  assert(!isTradeVoidConfirmationValid(732, 'void 732'), 'Confirmation should be case-sensitive');
  assert(tradeVoidSignalErrorPattern(732) === '%Position #732:%', 'Only the exact failed position dependency should be resolved');
}

async function runTests() {
  console.log('Running trade route helper tests...');
  await testCommandReplayEventsQueryIncludesSignalAndPositionEvents();
  await testCommandReplayEventsQueryHandlesMissingSignal();
  await testExpiredExitReviewPositionCanBeVoided();
  await testVoidRequiresExpiredContractAndUnresolvedExit();
  await testVoidExpiryUsesNewYorkTradingDate();
  await testVoidConfirmationAndSignalPatternAreExact();
  console.log('All trade route helper tests passed!');
}

runTests().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
