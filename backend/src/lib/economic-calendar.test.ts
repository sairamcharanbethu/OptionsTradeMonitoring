import { findActiveNoTradeWindow, getEventNoTradeWindows, parseCustomEconomicEvents, parseEtClockMinute } from './economic-calendar';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

const OPEN = 9 * 60 + 30;
const CLOSE = 16 * 60;

async function runTests() {
  console.log('Running economic calendar tests...');

  const cpi = getEventNoTradeWindows('2026-09-11', { openMinute: OPEN, closeMinute: CLOSE });
  assert(cpi.length === 1 && cpi[0].start_minute_et === OPEN && cpi[0].end_minute_et === OPEN + 60, 'CPI day blocks the first hour after the open');
  assert(cpi[0].reason.includes('CPI'), 'CPI window names the event');

  const fomc = getEventNoTradeWindows('2026-09-16', { openMinute: OPEN, closeMinute: CLOSE });
  assert(fomc.length === 1 && fomc[0].start_minute_et === 13 * 60 + 30 && fomc[0].end_minute_et === CLOSE, 'FOMC decision day blocks 13:30 ET through the close');

  const nfp = getEventNoTradeWindows('2026-10-02', { openMinute: OPEN, closeMinute: CLOSE });
  assert(nfp.length === 1 && nfp[0].reason.includes('payrolls'), 'NFP day is recognised');

  assert(getEventNoTradeWindows('2026-09-08', { openMinute: OPEN, closeMinute: CLOSE }).length === 0, 'A plain day has no event windows');
  assert(getEventNoTradeWindows('2026-09-15', { openMinute: OPEN, closeMinute: CLOSE }).length === 0, 'FOMC day one (no statement) is not blacked out');

  const early = getEventNoTradeWindows('2026-12-09', { openMinute: OPEN, closeMinute: 13 * 60 });
  assert(early.length === 0, 'An intraday window entirely after an early close is dropped');

  const custom = parseCustomEconomicEvents('[{"date":"2026-11-03","label":"Election"},{"date":"2026-11-04","label":"Half","start_minute_et":600,"end_minute_et":660}]');
  assert(custom.error === null && custom.events.length === 2, 'Valid custom events parse');
  const election = getEventNoTradeWindows('2026-11-03', { openMinute: OPEN, closeMinute: CLOSE, customEvents: custom.events });
  assert(election.length === 1 && election[0].start_minute_et === OPEN && election[0].end_minute_et === CLOSE, 'A custom event without a window blocks the whole session');
  const half = getEventNoTradeWindows('2026-11-04', { openMinute: OPEN, closeMinute: CLOSE, customEvents: custom.events });
  assert(half.length === 1 && half[0].start_minute_et === 600 && half[0].end_minute_et === 660, 'A custom event keeps its explicit window');

  assert(parseCustomEconomicEvents('').error === null, 'Blank custom events are allowed');
  assert(Boolean(parseCustomEconomicEvents('nope').error), 'Non-JSON is rejected');
  assert(Boolean(parseCustomEconomicEvents('{"date":"2026-01-01"}').error), 'A non-array is rejected');
  assert(Boolean(parseCustomEconomicEvents('[{"date":"1/1/2026"}]').error), 'A malformed date is rejected');
  assert(Boolean(parseCustomEconomicEvents('[{"date":"2026-01-02","start_minute_et":700,"end_minute_et":600}]').error), 'An inverted window is rejected');

  assert(findActiveNoTradeWindow(cpi, OPEN + 30) !== null, 'Minute inside the window is active');
  assert(findActiveNoTradeWindow(cpi, OPEN + 60) === null, 'Window end is exclusive');
  assert(findActiveNoTradeWindow(undefined, OPEN) === null, 'Missing windows never block');

  assert(parseEtClockMinute('11:00') === 660, 'HH:MM parses');
  assert(parseEtClockMinute('9:45') === 585, 'Single-digit hour parses');
  assert(parseEtClockMinute('24:00') === null && parseEtClockMinute('11:60') === null && parseEtClockMinute('') === null, 'Invalid clock strings are rejected');

  console.log('All economic calendar tests passed!');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
