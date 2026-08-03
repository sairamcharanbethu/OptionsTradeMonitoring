import '@fastify/postgres';
import { assertUsableEntryQuote } from './manual-option-order-service';

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
  console.log('All ManualOptionOrderService quote tests passed!');
}

runTests();
