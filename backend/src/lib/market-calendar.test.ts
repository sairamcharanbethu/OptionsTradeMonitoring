import { getNewYorkMarketState, getUSMarketCloseMinutes, getUSMarketHolidays, parseMarketDate, toExpirationDateKey, tradingDaysBetween } from './market-calendar';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function testObservedIndependenceDay2026() {
  const holidays = getUSMarketHolidays(2026);
  assert(holidays.has('2026-07-03'), 'Expected July 3, 2026 to be a market holiday');
  assert(!holidays.has('2026-07-04'), 'Expected observed holiday, not Saturday July 4, in market holiday set');
}

async function testHolidayMarketState() {
  const state = getNewYorkMarketState(new Date('2026-07-03T15:00:00.000Z'));
  assert(state.dateKey === '2026-07-03', `Expected ET date 2026-07-03, got ${state.dateKey}`);
  assert(state.isHoliday === true, 'Expected July 3, 2026 to be holiday');
  assert(state.isOpen === false, 'Expected market closed on observed Independence Day');
  assert(state.reason === 'HOLIDAY', `Expected HOLIDAY reason, got ${state.reason}`);
}

async function testCloseMinuteIsExclusive() {
  const state = getNewYorkMarketState(new Date('2026-07-06T20:00:00.000Z'), 9 * 60 + 30, 16 * 60);
  assert(state.dateKey === '2026-07-06', `Expected ET date 2026-07-06, got ${state.dateKey}`);
  assert(state.isOpen === false, 'Expected market closed exactly at exclusive 16:00 cutoff');
  assert(state.reason === 'AFTER_HOURS', `Expected AFTER_HOURS reason, got ${state.reason}`);
}

async function testJuly2026TradingDays() {
  const start = parseMarketDate('2026-07-01');
  const endExclusive = parseMarketDate('2026-08-01');
  const count = tradingDaysBetween(start, endExclusive);
  assert(count === 22, `Expected July 2026 to have 22 trading days, got ${count}`);
}

async function testEarlyCloseCalendar() {
  assert(getUSMarketCloseMinutes(new Date('2026-11-27T15:00:00.000Z')) === 13 * 60, 'The day after Thanksgiving must use a 13:00 ET close');
  assert(getUSMarketCloseMinutes(new Date('2026-12-24T15:00:00.000Z')) === 13 * 60, 'Christmas Eve 2026 must use a 13:00 ET close');
  assert(getUSMarketCloseMinutes(new Date('2028-07-03T15:00:00.000Z')) === 13 * 60, 'A trading-day July 3 must use a 13:00 ET close');
  assert(getUSMarketCloseMinutes(new Date('2026-07-02T15:00:00.000Z')) === 16 * 60, 'July 2, 2026 is not an NYSE early close');
  assert(getUSMarketCloseMinutes(new Date('2026-08-03T15:00:00.000Z')) === 16 * 60, 'An ordinary session must close at 16:00 ET');
}

async function testNewYearsOnSaturdayIsNotObserved() {
  // Jan 1, 2022 was a Saturday; NYSE did not close on Fri Dec 31, 2021.
  const holidays = getUSMarketHolidays(2022);
  assert(!holidays.has('2021-12-31'), 'Dec 31 must not be a holiday when New Year\'s Day falls on Saturday');
  assert(!holidays.has('2022-01-01'), 'Saturday Jan 1 itself is not a trading day to mark');
  // Jan 1, 2023 was a Sunday: observed Monday Jan 2 as usual.
  assert(getUSMarketHolidays(2023).has('2023-01-02'), 'Sunday New Year\'s Day must be observed on Monday');
}

async function testExpirationDateKey() {
  // node-pg decodes DATE as local midnight; that must read back as the same calendar day on any host TZ.
  assert(toExpirationDateKey(new Date(2026, 7, 3)) === '2026-08-03', 'Local-midnight DATE must keep its calendar day');
  assert(toExpirationDateKey(new Date('2026-08-03T00:00:00.000Z')) === '2026-08-03', 'UTC-midnight literal must read in UTC');
  assert(toExpirationDateKey('2026-08-03T04:00:00.000Z') === '2026-08-03', 'ISO string keeps its date part');
  assert(toExpirationDateKey('2026-08-03') === '2026-08-03', 'Plain date string passes through');
  assert(toExpirationDateKey(new Date('invalid')) === '', 'Invalid date yields empty key');
}

async function runTests() {
  console.log('Running market calendar tests...');
  await testObservedIndependenceDay2026();
  await testNewYearsOnSaturdayIsNotObserved();
  await testExpirationDateKey();
  await testHolidayMarketState();
  await testCloseMinuteIsExclusive();
  await testJuly2026TradingDays();
  await testEarlyCloseCalendar();
  console.log('All market calendar tests passed!');
}

runTests().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
