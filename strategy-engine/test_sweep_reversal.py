#!/usr/bin/env python3
"""Sweep-and-reclaim shadow candidate: fires once on a fresh reclaim, never on
a trend break-through, and never when the sweep is too deep to trade."""
from __future__ import annotations
import unittest
from datetime import datetime
from zoneinfo import ZoneInfo

from sweep_reversal import STRATEGY, sweep_reclaim_candidate

ET = ZoneInfo("America/New_York")


def _ts(day: int, hour: int, minute: int) -> float:
    return datetime(2026, 7, day, hour, minute, tzinfo=ET).timestamp()


def _bar(t: float, o: float, h: float, low: float, c: float) -> dict:
    return {"time": t, "open": o, "high": h, "low": low, "close": c, "volume": 1000.0}


def _flat_session(day: int, price: float, low: float | None = None, high: float | None = None) -> list[dict]:
    """A full RTH session of quiet 1m bars; optional single-minute low/high spike."""
    bars = []
    for i in range(390):
        t = _ts(day, 9, 30) + i * 60
        lo = low if (low is not None and i == 200) else price - 0.05
        hi = high if (high is not None and i == 200) else price + 0.05
        bars.append(_bar(t, price, hi, lo, price))
    return bars


class SweepReclaimCandidateTest(unittest.TestCase):
    def setUp(self) -> None:
        # Prior day (Mon 07-20) prints PDL = 740.00; today trades ~741.
        self.prior = _flat_session(20, 741.0, low=740.0)
        self.today: list[dict] = []
        for i in range(90):  # 09:30 .. 10:59 quiet
            t = _ts(21, 9, 30) + i * 60
            self.today.append(_bar(t, 741.0, 741.05, 740.95, 741.0))

    def _with_sweep(self, pierce_low: float, reclaim_close: float = 740.40) -> list[dict]:
        bars = list(self.prior) + list(self.today)
        # 11:00-11:04 5m bucket: pierce PDL 740.00 down to pierce_low, close back above.
        t0 = _ts(21, 11, 0)
        bars.append(_bar(t0, 740.60, 740.65, 740.20, 740.25))
        bars.append(_bar(t0 + 60, 740.25, 740.30, pierce_low, pierce_low + 0.05))
        bars.append(_bar(t0 + 120, pierce_low + 0.05, 740.20, pierce_low, 740.15))
        bars.append(_bar(t0 + 180, 740.15, 740.45, 740.10, 740.35))
        bars.append(_bar(t0 + 240, 740.35, 740.50, 740.30, reclaim_close))
        return bars

    def test_shallow_sweep_of_pdl_reclaimed_emits_calls_once(self) -> None:
        bars = self._with_sweep(pierce_low=739.70)
        now = _ts(21, 11, 5) + 5
        cand = sweep_reclaim_candidate(bars, spot=740.45, atr_5m=0.80, now=now,
                                       gex_ctx={"regime": "Positive"})
        self.assertIsNotNone(cand)
        self.assertEqual(cand["strategy"], STRATEGY)
        self.assertTrue(cand["shadow"])
        self.assertEqual(cand["side"], "calls")
        self.assertEqual(cand["level"]["name"], "PDL")
        plan = cand["risk_plan"]
        self.assertEqual(plan["entry"], 740.66)          # reclaim 5m bar high + 0.01
        self.assertLess(plan["stop"], 739.70)             # below the sweep extreme
        self.assertEqual(len(plan["targets"]), 3)
        self.assertGreater(plan["targets"][0], plan["entry"])
        self.assertGreaterEqual(cand["score"], 80)        # +10 positive gamma, +5 HTF level
        # Five minutes later the reclaim is no longer the latest closed bar -> no re-fire.
        bars.append(_bar(_ts(21, 11, 5), 740.40, 740.55, 740.35, 740.50))
        for k in range(1, 5):
            bars.append(_bar(_ts(21, 11, 5) + 60 * k, 740.50, 740.55, 740.45, 740.50))
        later = sweep_reclaim_candidate(bars, spot=740.50, atr_5m=0.80, now=_ts(21, 11, 10) + 5)
        self.assertIsNone(later)

    def test_deep_pierce_is_a_break_not_a_sweep(self) -> None:
        # 740 * 0.15% = 1.11; a pierce to 738.5 is a trend break-through.
        bars = self._with_sweep(pierce_low=738.50)
        cand = sweep_reclaim_candidate(bars, spot=740.45, atr_5m=0.80, now=_ts(21, 11, 5) + 5)
        self.assertIsNone(cand)

    def test_no_reclaim_no_candidate(self) -> None:
        bars = self._with_sweep(pierce_low=739.70, reclaim_close=739.90)  # closes below PDL
        cand = sweep_reclaim_candidate(bars, spot=739.90, atr_5m=0.60, now=_ts(21, 11, 5) + 5)
        self.assertIsNone(cand)

    def test_spot_back_below_level_cancels(self) -> None:
        bars = self._with_sweep(pierce_low=739.70)
        cand = sweep_reclaim_candidate(bars, spot=739.95, atr_5m=0.60, now=_ts(21, 11, 5) + 5)
        self.assertIsNone(cand)

    def test_risk_too_wide_for_atr_is_skipped(self) -> None:
        bars = self._with_sweep(pierce_low=739.70)
        # Small ATR: risk (~1.05) exceeds 1.5 x ATR -> no tradable plan.
        cand = sweep_reclaim_candidate(bars, spot=740.45, atr_5m=0.60, now=_ts(21, 11, 5) + 5)
        self.assertIsNone(cand)


if __name__ == "__main__":
    unittest.main()
