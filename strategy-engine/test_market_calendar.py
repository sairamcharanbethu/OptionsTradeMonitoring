import unittest
from datetime import date

from market_calendar import (
    compute_easter,
    is_trading_day,
    next_trading_day,
    previous_trading_day,
    us_market_holidays,
)


class MarketCalendarTests(unittest.TestCase):
    """Fixtures mirror backend/src/lib/market-calendar.test.ts."""

    def test_2026_holidays_match_backend(self) -> None:
        h = us_market_holidays(2026)
        expected = {
            date(2026, 1, 1),    # New Year's (Thu)
            date(2026, 1, 19),   # MLK
            date(2026, 2, 16),   # Presidents
            date(2026, 4, 3),    # Good Friday (Easter Apr 5)
            date(2026, 5, 25),   # Memorial
            date(2026, 6, 19),   # Juneteenth (Fri)
            date(2026, 7, 3),    # Independence Day observed (Jul 4 is Sat)
            date(2026, 9, 7),    # Labor
            date(2026, 11, 26),  # Thanksgiving
            date(2026, 12, 25),  # Christmas (Fri)
        }
        self.assertEqual(set(h), expected)
        self.assertNotIn(date(2026, 7, 4), h)

    def test_saturday_new_year_is_not_observed_on_dec_31(self) -> None:
        # Jan 1 2028 is a Saturday: NYSE does not close Fri Dec 31 2027.
        self.assertNotIn(date(2027, 12, 31), us_market_holidays(2027))
        self.assertNotIn(date(2028, 1, 1), us_market_holidays(2028))
        # Christmas 2027 is a Saturday -> observed Fri Dec 24 2027.
        self.assertIn(date(2027, 12, 24), us_market_holidays(2027))

    def test_easter_and_good_friday(self) -> None:
        self.assertEqual(compute_easter(2026), date(2026, 4, 5))
        self.assertEqual(compute_easter(2027), date(2027, 3, 28))
        self.assertIn(date(2027, 3, 26), us_market_holidays(2027))

    def test_trading_day_navigation(self) -> None:
        self.assertFalse(is_trading_day(date(2026, 7, 3)))   # observed holiday
        self.assertFalse(is_trading_day(date(2026, 7, 4)))   # Saturday
        self.assertTrue(is_trading_day(date(2026, 7, 6)))
        self.assertEqual(previous_trading_day(date(2026, 7, 6)), date(2026, 7, 2))
        self.assertEqual(next_trading_day(date(2026, 7, 2)), date(2026, 7, 6))
        # Thanksgiving week: Friday Nov 27 2026 is a (half) trading day.
        self.assertTrue(is_trading_day(date(2026, 11, 27)))
        self.assertEqual(next_trading_day(date(2026, 11, 25)), date(2026, 11, 27))


if __name__ == "__main__":
    unittest.main()
