import { buildCommandReplayEventsQuery } from '../lib/trade-command-events';

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

async function runTests() {
  console.log('Running trade route helper tests...');
  await testCommandReplayEventsQueryIncludesSignalAndPositionEvents();
  await testCommandReplayEventsQueryHandlesMissingSignal();
  console.log('All trade route helper tests passed!');
}

runTests().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
