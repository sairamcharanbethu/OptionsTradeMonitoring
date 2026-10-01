import unittest
from datetime import datetime

import uw_swing_backtest as swing
from uw_backtest import ET

IV = 0.15


def session(date: str, closes: list[float], start_minute: int = 9 * 60 + 30) -> list[dict]:
    """1m bars from ``start_minute`` ET; each bar spans +/-0.05 around its close."""
    day = datetime.strptime(date, "%Y-%m-%d").replace(tzinfo=ET)
    bars = []
    for i, close in enumerate(closes):
        minute = start_minute + i
        stamp = day.replace(hour=minute // 60, minute=minute % 60).timestamp()
        bars.append({"time": stamp, "open": close, "high": close + 0.05, "low": close - 0.05, "close": close})
    return bars


def trade(**overrides) -> dict:
    entry_time = datetime(2026, 9, 28, 10, 0, tzinfo=ET).timestamp()  # Monday
    base = {
        "date": "2026-09-28", "side": "CALL", "strike": 700.0, "expiry": "2026-10-07",
        "entry_time": entry_time, "entry_spot": 700.0, "contracts": 1,
        "trigger": 700.0, "stop": 698.0, "targets": [703.0, 706.0],
        "setup_key": "k", "strategy": "CONTINUATION", "entry_et": "10:00", "lane": "swing",
    }
    base["entry_price"] = round(swing.bs_price(700.0, 700.0, (swing.expiry_close_epoch(base["expiry"]) - entry_time) / 60, IV, "C"), 2)
    base.update(overrides)
    return base


def itm_trade(**overrides) -> dict:
    """Deep ITM call: premium is mostly intrinsic, so theta alone cannot reach
    the 20% premium stop or the +20% profit lock while SPY is flat."""
    t = trade(strike=680.0, stop=650.0, targets=[750.0, 760.0], **overrides)
    t["entry_price"] = round(swing.bs_price(700.0, 680.0, (swing.expiry_close_epoch(t["expiry"]) - t["entry_time"]) / 60, IV, "C"), 2)
    return t


def provider(sessions: dict[str, list[dict]]):
    return lambda date: sessions.get(date)


class PricingTest(unittest.TestCase):
    def test_put_call_parity_and_intrinsic(self):
        minutes = 9 * 24 * 60
        call = swing.bs_price(700, 700, minutes, IV, "C")
        put = swing.bs_price(700, 700, minutes, IV, "P")
        import math
        t = minutes / (365 * 24 * 60)
        self.assertAlmostEqual(call - put, 700 - 700 * math.exp(-swing.RISK_FREE_RATE * t), places=6)
        self.assertGreater(call, 5.0, "a 9-DTE ATM SPY call at 15% IV costs more than the $5 live debit cap")
        self.assertEqual(swing.bs_price(710, 700, 0, IV, "C"), 10)
        self.assertEqual(swing.bs_price(690, 700, 0, IV, "C"), 0)

    def test_thursday_window_rolls_to_monday(self):
        thursday_open = datetime(2026, 10, 1, 9, 30, tzinfo=ET).timestamp()
        expiry, mode, max_dte = swing.swing_expiry(["20261009", "20261012"], thursday_open)
        self.assertEqual((expiry, max_dte), ("20261012", 11))
        self.assertTrue(mode.endswith("WEEKEND_ROLL"))

    def test_profit_lock_ladder(self):
        self.assertEqual(swing._profit_lock_floor(4, 4.7), 0)
        self.assertEqual(swing._profit_lock_floor(4, 4.8), 4)
        self.assertEqual(swing._profit_lock_floor(4, 6.0), 5)


class SwingExitTest(unittest.TestCase):
    def test_position_carries_overnight_and_exits_at_target_2(self):
        t = trade()
        bars = {
            "2026-09-28": session("2026-09-28", [700.0] * 30 + [701.0] * 30),
            "2026-09-29": session("2026-09-29", [702.0, 704.0, 705.0, 706.5]),
        }
        result = swing.simulate_swing_exit(t, provider(bars), lambda d: IV, "2026-10-09")
        self.assertEqual(result["exit_reason"], "TARGET_2")
        self.assertEqual(result["exit_date"], "2026-09-29")
        self.assertEqual(result["sessions_held"], 2)
        self.assertGreater(result["pnl"], 0)
        self.assertEqual(result["underlying_points"], 6.0)
        self.assertTrue(result["t1_hit"])

    def test_overnight_gap_through_stop_fills_at_the_open(self):
        t = trade(stop=699.0)
        bars = {
            "2026-09-28": session("2026-09-28", [700.0] * 60),
            "2026-09-29": session("2026-09-29", [696.0, 695.5]),
        }
        result = swing.simulate_swing_exit(t, provider(bars), lambda d: IV, "2026-10-09")
        self.assertEqual(result["exit_reason"], "GAP_STOP")
        self.assertEqual(result["exit_spot"], 696.0, "a gap through the stop fills at the open, not the stop level")

    def test_premium_stop_before_trail_arms(self):
        t = trade(stop=690.0)
        bars = {"2026-09-28": session("2026-09-28", [699.0] * 35 + [695.5] * 5)}
        result = swing.simulate_swing_exit(t, provider(bars), lambda d: IV, "2026-09-28")
        self.assertEqual(result["exit_reason"], "PREMIUM_STOP")

    def test_profit_lock_arms_trail_and_exits_flat_or_better(self):
        t = trade(stop=690.0, targets=[720.0, 730.0])
        # Premium runs past +20% (lock arms at breakeven), then fades back.
        closes = [700.0] * 30 + [703.5] * 10 + [700.0] * 10 + [699.0] * 10
        bars = {"2026-09-28": session("2026-09-28", closes)}
        result = swing.simulate_swing_exit(t, provider(bars), lambda d: IV, "2026-09-28")
        self.assertEqual(result["exit_reason"], "TRAIL_STOP")
        self.assertGreaterEqual(result["exit_price"], t["entry_price"] - 0.05,
                                "the breakeven floor exits a stalled winner flat (minus spread)")

    def test_exit_before_expiry_at_two_dte(self):
        t = itm_trade()
        flat = [700.0] * 390
        bars = {d: session(d, flat) for d in
                ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-05"]}
        result = swing.simulate_swing_exit(t, provider(bars), lambda d: IV, "2026-10-09")
        self.assertEqual(result["exit_reason"], "EXPIRY_EXIT")
        self.assertEqual(result["exit_date"], "2026-10-05", "Oct 5 is the first session at <= 2 DTE for an Oct 7 expiry")

    def test_max_hold_seven_days(self):
        t = itm_trade(expiry="2026-10-16")
        flat = [700.0] * 390
        dates = ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06"]
        bars = {d: session(d, flat) for d in dates}
        result = swing.simulate_swing_exit(t, provider(bars), lambda d: IV, "2026-10-09")
        self.assertEqual(result["exit_reason"], "MAX_HOLD")
        self.assertEqual(result["exit_date"], "2026-10-05", "10080 minutes after Mon 10:00 is the next Mon 10:00")

    def test_open_at_end_of_data_is_unresolved(self):
        t = trade(stop=650.0, targets=[750.0, 760.0])
        bars = {"2026-09-28": session("2026-09-28", [700.0] * 60)}
        result = swing.simulate_swing_exit(t, provider(bars), lambda d: IV, "2026-09-28")
        self.assertEqual(result["exit_reason"], "UNRESOLVED")
        self.assertIsNone(result["pnl"])


class ExecutorTest(unittest.TestCase):
    def test_single_slot_across_days_and_one_entry_per_setup(self):
        day1 = session("2026-09-28", [700.0] * 30 + [697.0] * 5)  # stop at 698 hits ~10:00
        day2 = session("2026-09-29", [700.0] * 60)
        bars = {"2026-09-28": day1, "2026-09-29": day2}
        first = trade(entry_time=day1[0]["time"] + 5, setup_key="a")
        same_setup = trade(entry_time=day1[33]["time"] + 5, setup_key="a")
        while_open = trade(entry_time=day1[10]["time"] + 5, setup_key="b")
        after_exit = trade(date="2026-09-29", entry_time=day2[1]["time"] + 5, setup_key="c",
                           stop=650.0, targets=[750.0, 760.0])
        trades = swing.execute_swing([after_exit, same_setup, while_open, first],
                                     provider(bars), lambda d: IV, "2026-09-29")
        self.assertEqual([t["setup_key"] for t in trades], ["a", "c"])
        self.assertEqual(trades[0]["exit_reason"], "STOP")
        self.assertEqual(trades[1]["exit_reason"], "UNRESOLVED")


if __name__ == "__main__":
    unittest.main()
