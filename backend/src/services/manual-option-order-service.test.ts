import '@fastify/postgres';
import { assertUsableEntryQuote, resolveManualSyntheticTrailingSettings } from './manual-option-order-service';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function expectBlocked(quote: any, expected: RegExp) {
  let error: Error | null = null;
  try {
    assertUsableEntryQuote(quote, 1, 'MARKET', 'BUY_TO_OPEN');
  } catch (caught: any) {
    error = caught;
  }
  assert(Boolean(error && expected.test(error.message)), `Expected quote to be blocked by ${expected}, got ${error?.message || 'no error'}`);
}

function runTests() {
  console.log('Running ManualOptionOrderService quote tests...');
  assertUsableEntryQuote({ mark: 1, bid: 0.99, ask: 1.01, quoteAgeMs: 250 }, 1, 'MARKET', 'BUY_TO_OPEN');
  expectBlocked({ mark: 1, bid: 0.99, ask: 1.01, quoteAgeMs: null }, /timestamp is missing or invalid/);
  expectBlocked({ mark: 1, bid: 1.01, ask: 0.99, quoteAgeMs: 250 }, /crossed bid\/ask/);
  expectBlocked({ mark: 1, bid: 0.50, ask: 1.50, quoteAgeMs: 250 }, /spread .* too wide/);

  console.log('Running ManualOptionOrderService trailing-stop settings tests...');
  const migrated = resolveManualSyntheticTrailingSettings({
    synthetic_trailing_stop_enabled: 'true',
    synthetic_trailing_stop_pct: '12'
  });
  assert(migrated.enabled === true, 'Legacy shared setting should seed the manual trailing-stop toggle');
  assert(migrated.pct === 12, 'Legacy shared percentage should seed the manual trailing-stop percentage');

  const manualOverride = resolveManualSyntheticTrailingSettings({
    synthetic_trailing_stop_enabled: 'true',
    synthetic_trailing_stop_pct: '12',
    manual_entry_synthetic_trailing_stop_enabled: 'false',
    manual_entry_synthetic_trailing_stop_pct: '20'
  });
  assert(manualOverride.enabled === false, 'Explicit manual setting should override the shared strategy toggle');
  assert(manualOverride.pct === 20, 'Explicit manual percentage should override the shared strategy percentage');

  const invalidPct = resolveManualSyntheticTrailingSettings({
    manual_entry_synthetic_trailing_stop_enabled: 'true',
    manual_entry_synthetic_trailing_stop_pct: 'invalid'
  });
  assert(invalidPct.enabled === true, 'A valid manual toggle should remain enabled when its percentage is invalid');
  assert(invalidPct.pct === 15, 'Invalid manual trailing-stop percentages should fall back to 15%');
  console.log('All ManualOptionOrderService tests passed!');
}

runTests();
