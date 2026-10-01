"""US equity-market holiday calendar for the strategy engine.

Port of ``backend/src/lib/market-calendar.ts`` (``getUSMarketHolidays``) so the
engine and the backend agree on which days have no session. Rules:

- New Year's Day, Juneteenth, Independence Day, Christmas: observed on the
  preceding Friday when they fall on a Saturday and the following Monday when
  on a Sunday. NYSE exception: when New Year's Day is a Saturday the preceding
  Friday (Dec 31) is NOT a holiday.
- MLK Day (3rd Mon Jan), Presidents Day (3rd Mon Feb), Memorial Day (last Mon
  May), Labor Day (1st Mon Sep), Thanksgiving (4th Thu Nov), Good Friday.

Keep ``test_market_calendar.py`` in step with ``market-calendar.test.ts``.
"""
from __future__ import annotations

from datetime import date, timedelta
from functools import lru_cache


def compute_easter(year: int) -> date:
    """Anonymous Gregorian algorithm (same as the backend's computeEaster)."""
    a = year % 19
    b = year // 100
    c = year % 100
    d = b // 4
    e = b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i = c // 4
    k = c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month = (h + l - 7 * m + 114) // 31
    day = ((h + l - 7 * m + 114) % 31) + 1
    return date(year, month, day)


def _nth_weekday(year: int, month: int, weekday: int, n: int) -> date:
    """``weekday``: Monday=0 … Sunday=6 (Python convention)."""
    first = date(year, month, 1)
    offset = (weekday - first.weekday()) % 7
    return first + timedelta(days=offset + (n - 1) * 7)


def _last_weekday(year: int, month: int, weekday: int) -> date:
    last = date(year + (month // 12), (month % 12) + 1, 1) - timedelta(days=1)
    return last - timedelta(days=(last.weekday() - weekday) % 7)


@lru_cache(maxsize=64)
def us_market_holidays(year: int) -> frozenset[date]:
    holidays: set[date] = set()

    def add_observed(month: int, day: int) -> None:
        dt = date(year, month, day)
        if dt.weekday() == 5:  # Saturday
            if month == 1 and day == 1:
                return  # NYSE: Dec 31 is not a holiday for a Saturday New Year
            dt = dt - timedelta(days=1)
        elif dt.weekday() == 6:  # Sunday
            dt = dt + timedelta(days=1)
        holidays.add(dt)

    add_observed(1, 1)
    add_observed(6, 19)
    add_observed(7, 4)
    add_observed(12, 25)
    holidays.add(_nth_weekday(year, 1, 0, 3))   # MLK
    holidays.add(_nth_weekday(year, 2, 0, 3))   # Presidents
    holidays.add(_last_weekday(year, 5, 0))     # Memorial
    holidays.add(_nth_weekday(year, 9, 0, 1))   # Labor
    holidays.add(_nth_weekday(year, 11, 3, 4))  # Thanksgiving (Thu=3)
    holidays.add(compute_easter(year) - timedelta(days=2))  # Good Friday
    return frozenset(holidays)


def is_market_holiday(day: date) -> bool:
    return day in us_market_holidays(day.year)


def is_trading_day(day: date) -> bool:
    return day.weekday() < 5 and not is_market_holiday(day)


def previous_trading_day(day: date) -> date:
    cursor = day - timedelta(days=1)
    while not is_trading_day(cursor):
        cursor -= timedelta(days=1)
    return cursor


def next_trading_day(day: date) -> date:
    cursor = day + timedelta(days=1)
    while not is_trading_day(cursor):
        cursor += timedelta(days=1)
    return cursor
