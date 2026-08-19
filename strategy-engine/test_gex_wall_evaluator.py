#!/usr/bin/env python3

import unittest

from gex_wall_evaluator import evaluate_gex_wall

# base aligned to a 900s (15m) boundary so 1-bar-per-5min aggregates cleanly.
BASE = 1_700_000_100  # 1_700_000_100 % 900 == 0
assert BASE % 900 == 0


def _bar(t, o, h, low, c, v=1000):
    return {"time": t, "open": o, "high": h, "low": low, "close": c, "volume": v}


def _trend_bars(n, start_close, step, last_override):
    """One bar per 5-minute bucket; small-bodied trend then a shaped final bar."""
    bars = []
    for k in range(n - 1):
        c = start_close + k * step
        bars.append(_bar(BASE + k * 300, c, c + 0.05, c - 0.05, c))
    o, h, low, c = last_override
    bars.append(_bar(BASE + (n - 1) * 300, o, h, low, c))
    return bars


# `now` sits just past the final bar's bucket so every bar is a *closed* candle.
NOW = BASE + 60 * 300 + 30


class GexWallEvaluatorTest(unittest.TestCase):
    def test_missing_walls_returns_neutral_avoid(self):
        result = evaluate_gex_wall({"regime": "Positive"}, _trend_bars(60, 500, 0.5, (500, 500, 500, 500)), now=NOW)
        self.assertEqual(result["setup_type"], "NONE")
        self.assertEqual(result["verdict"], "AVOID")
        self.assertEqual(result["direction"], "NEUTRAL")
        self.assertIn("missing_walls", result["warnings"])
        self.assertFalse(result["execution_enabled"])

    def test_insufficient_bars_returns_neutral(self):
        short = _trend_bars(8, 500, 0.5, (503, 503.1, 502.9, 503))
        result = evaluate_gex_wall({"call_wall": 560, "put_wall": 525, "regime": "Positive"}, short, now=NOW)
        self.assertEqual(result["setup_type"], "NONE")
        self.assertIn("insufficient_bars", result["warnings"])

    def test_put_wall_bounce_call_participate(self):
        # Rising trend (15m up) + Positive Gamma + hammer touching the put wall.
        bars = _trend_bars(60, 500, 0.5, last_override=(529.8, 530.1, 525.0, 530.0))
        result = evaluate_gex_wall(
            {"call_wall": 560, "put_wall": 525.0, "regime": "Positive"}, bars, now=NOW
        )
        self.assertEqual(result["setup_type"], "PUT_WALL_BOUNCE_CALL")
        self.assertEqual(result["verdict"], "PARTICIPATE")
        self.assertEqual(result["direction"], "CALL")
        self.assertEqual(result["side"], "calls")
        self.assertEqual(result["confidence"], "A")
        self.assertEqual(result["macro"]["trend_15m"], "up")
        self.assertFalse(result["execution_enabled"])
        self.assertEqual(result["mode"], "shadow")

    def test_call_wall_rejection_put_a_plus_in_negative_gamma(self):
        # Falling trend (15m down) + Negative Gamma + shooting star at the call wall.
        bars = _trend_bars(60, 560, -0.5, last_override=(530.3, 535.0, 529.8, 530.0))
        result = evaluate_gex_wall(
            {"call_wall": 535.0, "put_wall": 500.0, "regime": "Negative"}, bars, now=NOW
        )
        self.assertEqual(result["setup_type"], "CALL_WALL_REJECTION_PUT")
        self.assertEqual(result["verdict"], "PARTICIPATE")
        self.assertEqual(result["direction"], "PUT")
        self.assertEqual(result["side"], "puts")
        self.assertEqual(result["confidence"], "A+")
        self.assertEqual(result["macro"]["trend_15m"], "down")
        self.assertTrue(result["regime"]["negative_gamma"])

    def test_call_wall_migration_guard_blocks_fade(self):
        # Same rejection shape, but the call wall migrated up from a prior read.
        bars = _trend_bars(60, 560, -0.5, last_override=(530.3, 535.0, 529.8, 530.0))
        result = evaluate_gex_wall(
            {"call_wall": 535.0, "put_wall": 500.0, "regime": "Negative"},
            bars, now=NOW, previous_walls={"call_wall": 530.0, "put_wall": 500.0},
        )
        self.assertEqual(result["setup_type"], "CALL_WALL_REJECTION_PUT")
        self.assertEqual(result["verdict"], "AVOID")
        self.assertTrue(result["regime"]["wall_migrated_higher"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
