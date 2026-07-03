// US trading-day helpers for the NYSE observed holiday calendar.
export function toMarketDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function parseMarketDate(value: string | Date): Date {
  if (value instanceof Date) {
    return new Date(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
  }
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }
  const parsed = new Date(value);
  return new Date(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate());
}

export function getUSMarketHolidays(year: number): Set<string> {
  const holidays = new Set<string>();

  const add = (m: number, d: number) => {
    let dt = new Date(year, m - 1, d);
    if (dt.getDay() === 6) dt = new Date(year, m - 1, d - 1);
    if (dt.getDay() === 0) dt = new Date(year, m - 1, d + 1);
    holidays.add(toMarketDateKey(dt));
  };

  add(1, 1);
  add(6, 19);
  add(7, 4);
  add(12, 25);

  const nthWeekday = (month: number, weekday: number, n: number): Date => {
    const first = new Date(year, month - 1, 1);
    let day = 1 + ((weekday - first.getDay() + 7) % 7);
    day += (n - 1) * 7;
    return new Date(year, month - 1, day);
  };

  const lastWeekday = (month: number, weekday: number): Date => {
    const last = new Date(year, month, 0);
    const day = last.getDate() - ((last.getDay() - weekday + 7) % 7);
    return new Date(year, month - 1, day);
  };

  holidays.add(toMarketDateKey(nthWeekday(1, 1, 3)));
  holidays.add(toMarketDateKey(nthWeekday(2, 1, 3)));
  holidays.add(toMarketDateKey(lastWeekday(5, 1)));
  holidays.add(toMarketDateKey(nthWeekday(9, 1, 1)));
  holidays.add(toMarketDateKey(nthWeekday(11, 4, 4)));

  const goodFriday = new Date(computeEaster(year));
  goodFriday.setDate(goodFriday.getDate() - 2);
  holidays.add(toMarketDateKey(goodFriday));

  return holidays;
}

export function tradingDaysBetween(from: Date, to: Date): number {
  if (to <= from) return 0;

  const holidays = new Set<string>();
  for (let y = from.getFullYear(); y <= to.getFullYear(); y++) {
    getUSMarketHolidays(y).forEach((holiday) => holidays.add(holiday));
  }

  let count = 0;
  const cursor = new Date(from);
  cursor.setHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setHours(0, 0, 0, 0);

  while (cursor < end) {
    const dow = cursor.getDay();
    if (dow !== 0 && dow !== 6 && !holidays.has(toMarketDateKey(cursor))) count++;
    cursor.setDate(cursor.getDate() + 1);
  }
  return count;
}

export function getNewYorkDateParts(date: Date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
  const parts = formatter.formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value || '';
  const year = Number(get('year'));
  const month = Number(get('month'));
  const day = Number(get('day'));
  const hour = Number(get('hour'));
  const minute = Number(get('minute'));

  return {
    year,
    month,
    day,
    weekday: get('weekday'),
    hour,
    minute,
    minutes: hour * 60 + minute,
    dateKey: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  };
}

export function getNewYorkMarketState(date: Date = new Date(), openMinutes = 9 * 60 + 30, closeMinutes = 16 * 60) {
  const parts = getNewYorkDateParts(date);
  const isWeekend = parts.weekday === 'Sat' || parts.weekday === 'Sun';
  const isHoliday = getUSMarketHolidays(parts.year).has(parts.dateKey);
  const isWithinHours = parts.minutes >= openMinutes && parts.minutes < closeMinutes;
  const reason = isWeekend
    ? 'WEEKEND'
    : isHoliday
      ? 'HOLIDAY'
      : parts.minutes < openMinutes
        ? 'PRE_MARKET'
        : parts.minutes >= closeMinutes
          ? 'AFTER_HOURS'
          : 'OPEN';

  return {
    ...parts,
    isWeekday: !isWeekend,
    isWeekend,
    isHoliday,
    isWithinHours,
    isOpen: !isWeekend && !isHoliday && isWithinHours,
    reason
  };
}

function computeEaster(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}
