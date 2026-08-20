#!/usr/bin/env python3

import unittest
from datetime import datetime

from price_structure import (
    acceptance,
    detect_sweep,
    displacement,
    effort_vs_result,
    find_fvgs,
    reference_levels,
    session_levels,
    structure_context,
    velocity,
    ET,
)


def _et_epoch(date: str, hour: int, minute: int) -> float:
    """Epoch seconds for a wall-clock ET time on ``date`` (YYYY-MM-DD)."""
    y, m, d = (int(x) for x in date.split("-"))
    return datetime(y, m, d, hour, minute, tzinfo=ET).timestamp()


def _bar(t, o, h, low, c, v=1000):
    return {"time": t, "open": o, "high": h, "low": low, "close": c, "volume": v}


class SessionLevelsTest(unittest.TestCase):
    def _two_day_bars(self):
        bars = []
        # Prior day RTH (2024-01-02): high 505, low 495, close 500.
        bars.append(_bar(_et_epoch("2024-01-02", 9, 30), 500, 502, 498, 501))
        bars.append(_bar(_et_epoch("2024-01-02", 12, 0), 501, 505, 495, 499))
        bars.append(_bar(_et_epoch("2024-01-02", 15, 55), 499, 501, 497, 500))
        # Overnight (post-close 01-02 -> pre-open 01-03): high 508, low 503.
        bars.append(_bar(_et_epoch("2024-01-02", 20, 0), 500, 508, 503, 506))
        bars.append(_bar(_et_epoch("2024-01-03", 8, 0), 506, 507, 504, 505))
        # Today RTH (2024-01-03): open 506, IB (first 60m) high 510, low 505.
        bars.append(_bar(_et_epoch("2024-01-03", 9, 30), 506, 510, 505, 509))
        bars.append(_bar(_et_epoch("2024-01-03", 10, 20), 509, 511, 508, 510))
        bars.append(_bar(_et_epoch("2024-01-03", 13, 0), 510, 514, 507, 512))
        return bars

    def test_prior_day_levels(self):
        s = session_levels(self._two_day_bars(), now=_et_epoch("2024-01-03", 13, 5))
        self.assertTrue(s["available"])
        self.assertEqual(s["prior_day"]["date"], "2024-01-02")
        self.assertEqual(s["prior_day"]["high"], 505)
        self.assertEqual(s["prior_day"]["low"], 495)
        self.assertEqual(s["prior_day"]["close"], 500)

    def test_today_and_ib_levels(self):
        s = session_levels(self._two_day_bars(), now=_et_epoch("2024-01-03", 13, 5))
        today = s["today"]
        self.assertEqual(today["date"], "2024-01-03")
        self.assertEqual(today["rth_open"], 506)
        self.assertEqual(today["rth_high"], 514)
        self.assertEqual(today["rth_low"], 505)
        # IB = first 60m of RTH: only the 09:30 bar (10:20 is > 10:30? no, 10:20<10:30)
        # 09:30 and 10:20 both fall in the first 60 min window [09:30, 10:30).
        self.assertEqual(today["ib_high"], 511)
        self.assertEqual(today["ib_low"], 505)

    def test_overnight_levels(self):
        s = session_levels(self._two_day_bars(), now=_et_epoch("2024-01-03", 13, 5))
        self.assertIsNotNone(s["overnight"])
        self.assertEqual(s["overnight"]["high"], 508)
        self.assertEqual(s["overnight"]["low"], 503)

    def test_reference_levels_flatten(self):
        s = session_levels(self._two_day_bars(), now=_et_epoch("2024-01-03", 13, 5))
        refs = {r["name"]: r for r in reference_levels(s)}
        self.assertEqual(refs["PDH"]["price"], 505)
        self.assertEqual(refs["PDH"]["kind"], "buy_side")
        self.assertEqual(refs["PDL"]["price"], 495)
        self.assertEqual(refs["PDL"]["kind"], "sell_side")
        self.assertEqual(refs["ONH"]["price"], 508)

    def test_no_bars(self):
        self.assertFalse(session_levels([])["available"])
        self.assertEqual(reference_levels({"available": False}), [])


class SweepTest(unittest.TestCase):
    def test_sell_side_sweep_and_reclaim(self):
        # Level 100: a bar wicks to 99.9 (shallow) then closes back above.
        bars = [
            _bar(1, 101, 101.5, 100.5, 101),
            _bar(2, 101, 101.2, 99.9, 100.6),   # pierce below 100, close back above
            _bar(3, 100.6, 101, 100.4, 100.9),
        ]
        r = detect_sweep(bars, 100.0, side="sell_side")
        self.assertIsNotNone(r)
        self.assertTrue(r["swept"])
        self.assertEqual(r["pierce_extreme"], 99.9)

    def test_buy_side_sweep(self):
        bars = [
            _bar(1, 99, 99.5, 98.5, 99),
            _bar(2, 99, 100.1, 98.9, 99.4),     # pierce above 100, close back below
            _bar(3, 99.4, 99.8, 99, 99.5),
        ]
        r = detect_sweep(bars, 100.0, side="buy_side")
        self.assertIsNotNone(r)
        self.assertEqual(r["pierce_extreme"], 100.1)

    def test_deep_breakthrough_is_not_a_grab(self):
        # Pierce 5% below the level = a trend break, not a shallow stop-grab.
        bars = [
            _bar(1, 101, 101.5, 100.5, 101),
            _bar(2, 101, 101, 95, 96),
            _bar(3, 96, 97, 95, 96.5),
        ]
        self.assertIsNone(detect_sweep(bars, 100.0, side="sell_side"))

    def test_no_reclaim_is_not_a_sweep(self):
        bars = [
            _bar(1, 101, 101.5, 100.5, 101),
            _bar(2, 101, 101, 99.9, 99.85),   # closes below, never reclaims
            _bar(3, 99.85, 99.9, 99.7, 99.8),
        ]
        self.assertIsNone(detect_sweep(bars, 100.0, side="sell_side"))


class AcceptanceTest(unittest.TestCase):
    def test_accepted_above(self):
        bars = [
            _bar(1, 100, 100.5, 99.5, 100.2),
            _bar(2, 100.2, 101, 100, 100.8),   # close above 100
            _bar(3, 100.8, 101.2, 100.5, 101),  # close above 100
        ]
        r = acceptance(bars, 100.0, side="above")
        self.assertTrue(r["accepted"])
        self.assertEqual(r["dwell_bars"], 3)
        self.assertFalse(r["rejected"])

    def test_rejected_above(self):
        bars = [
            _bar(1, 98, 98.5, 97.5, 98),
            _bar(2, 98, 98.5, 97.5, 98.1),
            _bar(3, 98.1, 100.5, 98, 98.2),    # wick above 100, close back below
        ]
        r = acceptance(bars, 100.0, side="above")
        self.assertFalse(r["accepted"])
        self.assertTrue(r["rejected"])


class DisplacementTest(unittest.TestCase):
    def test_displacement_detected(self):
        # Small-bodied lead-in, then a large directional body.
        bars = [_bar(i, 100, 100.3, 99.7, 100) for i in range(1, 11)]
        bars.append(_bar(11, 100, 103, 99.9, 102.9))  # body 2.9, big vs ATR ~0.6
        r = displacement(bars)
        self.assertTrue(r["is_displacement"])
        self.assertEqual(r["direction"], "up")

    def test_doji_is_not_displacement(self):
        bars = [_bar(i, 100, 100.5, 99.5, 100) for i in range(1, 12)]
        r = displacement(bars)
        self.assertFalse(r["is_displacement"])


class FvgTest(unittest.TestCase):
    def test_bullish_fvg_detected(self):
        # bar1.high (100.5) < bar3.low (102) => bullish gap.
        bars = [
            _bar(1, 100, 100.5, 99.5, 100.2),
            _bar(2, 100.5, 103, 100.4, 102.5),   # displacement leg
            _bar(3, 102.5, 103.5, 102, 103),
        ]
        gaps = find_fvgs(bars, min_gap_atr=0.0)
        self.assertTrue(any(g["type"] == "bullish" for g in gaps))
        bull = [g for g in gaps if g["type"] == "bullish"][0]
        self.assertAlmostEqual(bull["bottom"], 100.5)
        self.assertAlmostEqual(bull["top"], 102.0)

    def test_fvg_inversion(self):
        # Bullish gap then price closes fully below it => IFVG (inverted).
        bars = [
            _bar(1, 100, 100.5, 99.5, 100.2),
            _bar(2, 100.5, 103, 100.4, 102.5),
            _bar(3, 102.5, 103.5, 102, 103),
            _bar(4, 102, 102.2, 99, 99.5),        # closes below gap bottom 100.5
        ]
        gaps = find_fvgs(bars, min_gap_atr=0.0)
        bull = [g for g in gaps if g["type"] == "bullish"][0]
        self.assertTrue(bull["filled"])
        self.assertTrue(bull["inverted"])


class VelocityTest(unittest.TestCase):
    def test_fast_move_flagged(self):
        bars = [_bar(i, 100, 100.2, 99.8, 100) for i in range(1, 9)]
        # Then a fast 3-bar ramp far exceeding ATR (~0.4).
        bars += [_bar(9, 100, 101, 100, 101), _bar(10, 101, 102, 101, 102), _bar(11, 102, 103, 102, 103)]
        r = velocity(bars)
        self.assertTrue(r["fast"])
        self.assertEqual(r["direction"], "up")

    def test_slow_move_not_fast(self):
        bars = [_bar(i, 100, 100.5, 99.5, 100 + i * 0.01) for i in range(1, 12)]
        self.assertFalse(velocity(bars)["fast"])


class EffortVsResultTest(unittest.TestCase):
    def test_absorption_like(self):
        # Steady baseline, then a huge-volume tiny-range bar (effort, no result).
        bars = [_bar(i, 100, 101, 99, 100, v=1000) for i in range(1, 11)]
        bars.append(_bar(11, 100, 100.2, 99.9, 100.05, v=5000))
        r = effort_vs_result(bars)
        self.assertTrue(r["absorption_like"])
        self.assertTrue(r["proxy"])

    def test_normal_bar_not_absorption(self):
        bars = [_bar(i, 100, 101, 99, 100, v=1000) for i in range(1, 12)]
        self.assertFalse(effort_vs_result(bars)["absorption_like"])


class StructureContextTest(unittest.TestCase):
    def test_assembles_without_error(self):
        base = _et_epoch("2024-01-03", 10, 0)
        bars = [_bar(base + i * 60, 100 + i * 0.05, 100 + i * 0.05 + 0.2,
                     100 + i * 0.05 - 0.2, 100 + i * 0.05) for i in range(120)]
        ctx = structure_context(bars, now=base + 120 * 60 + 30)
        self.assertEqual(ctx["engine_version"], "price-structure-v1")
        self.assertTrue(ctx["session"]["available"])
        self.assertIn("displacement", ctx)
        self.assertIn("velocity", ctx)
        self.assertIn("fvgs", ctx)
        self.assertGreater(ctx["bars_5m_used"], 0)


if __name__ == "__main__":
    unittest.main()
