/**
 * Scheduled macro events that a short-dated options desk does not trade into.
 *
 * Built-in dates are the published 2026 schedules (Federal Reserve FOMC
 * calendar; BLS CPI and Employment Situation release schedules). Operators can
 * add ad-hoc dates through the `event_blackout_dates` setting (JSON array of
 * `{date, label, start_minute_et?, end_minute_et?}`), which is how the file is
 * extended for 2027 without a code change.
 *
 * Windows are expressed in minutes after midnight New York time, half-open
 * `[start, end)`, so they compose with the session policy's open/close/cutoff.
 */

export type EconomicEventKind = 'FOMC' | 'CPI' | 'NFP' | 'CUSTOM';

export interface EconomicEvent {
  date: string; // YYYY-MM-DD (New York)
  kind: EconomicEventKind;
  label: string;
  /** Release time in minutes after midnight ET. 8:30 releases are pre-market. */
  release_minute_et: number;
  /** Explicit window override (custom events); otherwise derived from the release time. */
  start_minute_et?: number;
  end_minute_et?: number;
}

export interface NoTradeWindow {
  start_minute_et: number;
  end_minute_et: number;
  reason: string;
}

const PRE_MARKET_RELEASE_MINUTE = 8 * 60 + 30;
const FOMC_DECISION_MINUTE = 14 * 60;
/** No new entries for this long after the open on a pre-market release day. */
export const PRE_MARKET_EVENT_OPEN_BLACKOUT_MINUTES = 60;
/** No new entries from this long before an intraday release through the close. */
export const INTRADAY_EVENT_LEAD_MINUTES = 30;

// FOMC: the decision day is the second day of each two-day meeting (14:00 ET statement).
const FOMC_2026 = ['2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09'];
// BLS Consumer Price Index, 08:30 ET.
const CPI_2026 = ['2026-01-13', '2026-02-13', '2026-03-11', '2026-04-10', '2026-05-12', '2026-06-10', '2026-07-14', '2026-08-12', '2026-09-11', '2026-10-14', '2026-11-10', '2026-12-10'];
// BLS Employment Situation (nonfarm payrolls), 08:30 ET.
const NFP_2026 = ['2026-02-11', '2026-03-06', '2026-04-03', '2026-05-08', '2026-06-05', '2026-07-02', '2026-08-07', '2026-09-04', '2026-10-02', '2026-11-06', '2026-12-04'];

export const BUILT_IN_ECONOMIC_EVENTS: EconomicEvent[] = [
  ...FOMC_2026.map((date) => ({ date, kind: 'FOMC' as const, label: 'FOMC rate decision', release_minute_et: FOMC_DECISION_MINUTE })),
  ...CPI_2026.map((date) => ({ date, kind: 'CPI' as const, label: 'CPI release', release_minute_et: PRE_MARKET_RELEASE_MINUTE })),
  ...NFP_2026.map((date) => ({ date, kind: 'NFP' as const, label: 'Nonfarm payrolls release', release_minute_et: PRE_MARKET_RELEASE_MINUTE }))
];

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

function isMinute(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 24 * 60;
}

/**
 * Parse the `event_blackout_dates` setting. Returns the parsed events or a
 * human-readable error. A blank value is valid and means "no custom events".
 */
export function parseCustomEconomicEvents(raw: unknown): { events: EconomicEvent[]; error: string | null } {
  const text = String(raw ?? '').trim();
  if (!text) return { events: [], error: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { events: [], error: 'Event blackout dates must be a JSON array' };
  }
  if (!Array.isArray(parsed)) return { events: [], error: 'Event blackout dates must be a JSON array' };
  const events: EconomicEvent[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') return { events: [], error: 'Each event blackout must be an object' };
    const date = String((item as any).date ?? '').trim();
    if (!DATE_KEY.test(date)) return { events: [], error: `Event blackout date "${date}" must be YYYY-MM-DD` };
    const label = String((item as any).label ?? 'Custom event').trim().slice(0, 80) || 'Custom event';
    const start = (item as any).start_minute_et;
    const end = (item as any).end_minute_et;
    if (start !== undefined && !isMinute(start)) return { events: [], error: `Event blackout "${label}" has an invalid start_minute_et` };
    if (end !== undefined && !isMinute(end)) return { events: [], error: `Event blackout "${label}" has an invalid end_minute_et` };
    if (isMinute(start) && isMinute(end) && start >= end) return { events: [], error: `Event blackout "${label}" must end after it starts` };
    events.push({
      date,
      kind: 'CUSTOM',
      label,
      release_minute_et: isMinute(start) ? start : PRE_MARKET_RELEASE_MINUTE,
      ...(isMinute(start) ? { start_minute_et: start } : {}),
      ...(isMinute(end) ? { end_minute_et: end } : {})
    });
  }
  return { events, error: null };
}

export function getEconomicEventsForDate(dateKey: string, customEvents: EconomicEvent[] = []): EconomicEvent[] {
  return [...BUILT_IN_ECONOMIC_EVENTS, ...customEvents].filter((event) => event.date === dateKey);
}

/**
 * No-trade windows for one session. Pre-market releases block the first
 * PRE_MARKET_EVENT_OPEN_BLACKOUT_MINUTES after the open; intraday releases
 * block from INTRADAY_EVENT_LEAD_MINUTES before the release through the close.
 * Custom events without an explicit window block the whole session.
 */
export function getEventNoTradeWindows(
  dateKey: string,
  options: { openMinute: number; closeMinute: number; customEvents?: EconomicEvent[] }
): NoTradeWindow[] {
  const { openMinute, closeMinute } = options;
  const windows: NoTradeWindow[] = [];
  for (const event of getEconomicEventsForDate(dateKey, options.customEvents || [])) {
    let start: number;
    let end: number;
    if (isMinute(event.start_minute_et) || isMinute(event.end_minute_et)) {
      start = isMinute(event.start_minute_et) ? event.start_minute_et : openMinute;
      end = isMinute(event.end_minute_et) ? event.end_minute_et : closeMinute;
    } else if (event.kind === 'CUSTOM') {
      start = openMinute;
      end = closeMinute;
    } else if (event.release_minute_et <= openMinute) {
      start = openMinute;
      end = openMinute + PRE_MARKET_EVENT_OPEN_BLACKOUT_MINUTES;
    } else {
      start = event.release_minute_et - INTRADAY_EVENT_LEAD_MINUTES;
      end = closeMinute;
    }
    start = Math.max(openMinute, start);
    end = Math.min(closeMinute, end);
    if (end <= start) continue;
    windows.push({ start_minute_et: start, end_minute_et: end, reason: `${event.label} (${event.date})` });
  }
  return windows.sort((a, b) => a.start_minute_et - b.start_minute_et);
}

export function findActiveNoTradeWindow(windows: NoTradeWindow[] | undefined | null, minuteEt: number): NoTradeWindow | null {
  if (!Array.isArray(windows)) return null;
  return windows.find((w) => Number.isFinite(Number(w?.start_minute_et)) && Number.isFinite(Number(w?.end_minute_et))
    && minuteEt >= Number(w.start_minute_et) && minuteEt < Number(w.end_minute_et)) || null;
}

/** Parse "HH:MM" (24h, New York) into minutes after midnight, or null. */
export function parseEtClockMinute(value: unknown): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}
