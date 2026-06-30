import { parseMarketDate, tradingDaysBetween, getUSMarketHolidays } from './goals';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function testJuly2026TradingDays() {
  const start = parseMarketDate('2026-07-01');
  const endExclusive = parseMarketDate('2026-08-01');
  const count = tradingDaysBetween(start, endExclusive);

  assert(count === 22, `Expected July 2026 to have 22 trading days, got ${count}`);
}

async function testObservedIndependenceDay2026() {
  const holidays = getUSMarketHolidays(2026);

  assert(holidays.has('2026-07-03'), 'Expected July 3, 2026 to be a market holiday');
  assert(!holidays.has('2026-07-04'), 'Expected observed holiday, not Saturday July 4, in market holiday set');
}

async function testIsoDateStringsDoNotShiftMonth() {
  const start = parseMarketDate('2026-07-01T00:00:00.000Z');
  const endExclusive = parseMarketDate('2026-08-01T00:00:00.000Z');
  const count = tradingDaysBetween(start, endExclusive);

  assert(count === 22, `Expected ISO July 2026 dates to have 22 trading days, got ${count}`);
}

async function runTests() {
  console.log('Running goal trading-day tests...');
  await testJuly2026TradingDays();
  await testObservedIndependenceDay2026();
  await testIsoDateStringsDoNotShiftMonth();
  console.log('All goal trading-day tests passed!');
}

runTests().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
