import { normalizeAdapterHealth } from './adapter-health';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function testHealthyAdapterGetsLastGoodAtAndFreshness() {
  const health = normalizeAdapterHealth('postgres', {
    status: 'UP',
    latencyMs: 12
  }, '2026-06-22T15:00:00.000Z');

  assert(health.status === 'UP', `Expected UP, got ${health.status}`);
  assert(health.source === 'postgres', `Expected postgres source, got ${health.source}`);
  assert(health.lastGoodAt === '2026-06-22T15:00:00.000Z', `Expected checkedAt lastGoodAt, got ${health.lastGoodAt}`);
  assert(health.freshnessMs === 0, `Expected 0 freshness, got ${health.freshnessMs}`);
  assert(health.degradedReason === null, `Expected no degraded reason, got ${health.degradedReason}`);
}

async function testDegradedAdapterGetsReason() {
  const health = normalizeAdapterHealth('thetadata', {
    status: 'DEGRADED',
    lastMessageAt: '2026-06-22T14:59:00.000Z',
    lastError: 'stream closed'
  }, '2026-06-22T15:00:00.000Z');

  assert(health.lastGoodAt === '2026-06-22T14:59:00.000Z', `Expected last message as lastGoodAt, got ${health.lastGoodAt}`);
  assert(health.freshnessMs === 60_000, `Expected 60s freshness, got ${health.freshnessMs}`);
  assert(health.degradedReason === 'stream closed', `Expected error degraded reason, got ${health.degradedReason}`);
}

async function runTests() {
  console.log('Running adapter health tests...');
  await testHealthyAdapterGetsLastGoodAtAndFreshness();
  await testDegradedAdapterGetsReason();
  console.log('All adapter health tests passed!');
}

runTests().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
