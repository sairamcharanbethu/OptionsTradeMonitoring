#!/usr/bin/env python3

import unittest

from gex_wall_evaluator import evaluate_gex_wall
from signal_engine import _gex_wall_candidate, _higher_score_candidate

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


class WallMergeIntoDayTradingTest(unittest.TestCase):
    """The wall engine, merged into build_signal as a native reaction candidate."""

    # Production gex_ctx carries walls as {"strike", "stage"} dicts.
    def test_participate_produces_native_candidate(self):
        bars = _trend_bars(60, 560, -0.5, last_override=(530.3, 535.0, 529.8, 530.0))
        candidate = _gex_wall_candidate(
            {"atr_5m": 1.0},
            bars[-1],
            530.0,
            {
                "available": True,
                "call_wall": {"strike": 535.0, "stage": "Active"},
                "put_wall": {"strike": 500.0, "stage": "Active"},
                "flip": None,
                "regime": "Negative",
            },
            bars,
            NOW,
        )
        self.assertIsNotNone(candidate)
        self.assertEqual(candidate["strategy"], "GEX_WALL_REJECTION")
        self.assertIn(candidate["strategy"], __import__("signal_engine").FROZEN_SETUP_STRATEGIES)
        self.assertEqual(candidate["side"], "puts")
        self.assertEqual(candidate["score"], 85)
        self.assertEqual(candidate["quality"], "HIGH")
        self.assertTrue(candidate["a_plus"])
        self.assertIn("targets", candidate["risk_plan"])
        self.assertTrue(candidate["risk_plan"]["targets"])

    def test_non_participate_yields_no_candidate(self):
        flat = _trend_bars(60, 500, 0.0, last_override=(500.0, 500.05, 499.95, 500.0))
        candidate = _gex_wall_candidate(
            {"atr_5m": 1.0},
            flat[-1],
            500.0,
            {
                "available": True,
                "call_wall": {"strike": 520.0, "stage": "Active"},
                "put_wall": {"strike": 480.0, "stage": "Active"},
                "flip": None,
                "regime": "Positive",
            },
            flat,
            NOW,
        )
        self.assertIsNone(candidate)

    def test_missing_atr_yields_no_candidate(self):
        bars = _trend_bars(60, 560, -0.5, last_override=(530.3, 535.0, 529.8, 530.0))
        candidate = _gex_wall_candidate(
            {}, bars[-1], 530.0,
            {
                "available": True,
                "call_wall": {"strike": 535.0, "stage": "Active"},
                "put_wall": {"strike": 500.0, "stage": "Active"},
                "flip": None,
                "regime": "Negative",
            },
            bars, NOW,
        )
        self.assertIsNone(candidate)

    def test_higher_score_candidate_selection(self):
        low = {"strategy": "MTF_TREND_BREAK", "base_score": 75}
        high = {"strategy": "GEX_WALL_REJECTION", "base_score": 85}
        self.assertIs(_higher_score_candidate(low, high), high)
        self.assertIs(_higher_score_candidate(high, low), high)  # tie-break keeps left only on equal
        self.assertIs(_higher_score_candidate(low, None), low)
        self.assertIs(_higher_score_candidate(None, high), high)
        self.assertIsNone(_higher_score_candidate(None, None))


if __name__ == "__main__":
    unittest.main(verbosity=2)
