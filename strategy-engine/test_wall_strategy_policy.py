"""GEX_WALL_BOUNCE is disabled on replay evidence — pin that policy.

UW replay 2026-04-14..08-20: bounce n=12, 17% win, mean -$40.42 ± $13.08 SE
per contract (~3.1 SE below zero). The other wall reactions stay enabled.
"""
from __future__ import annotations

import unittest
from unittest import mock

import signal_engine


def _evaluation(setup_type: str, side: str) -> dict:
    return {
        "verdict": "PARTICIPATE",
        "setup_type": setup_type,
        "side": side,
        "confidence": "A",
        "invalidation": 99.0,
        "regime": "Negative",
        "reason": "test setup",
        "macro": {"trend_15m": "down"},
        "levels": {"call_wall": 102.0, "put_wall": 98.0},
    }


def _candidate(setup_type: str, side: str):
    spy = {"atr_5m": 1.0, "vwap": 100.0}
    latest = {"high": 100.5, "low": 99.5, "close": 100.0}
    gex_ctx = {
        "call_wall": {"strike": 102.0},
        "put_wall": {"strike": 98.0},
        "flip": 100.0,
        "regime": "Negative",
        "net_gex": -2.0e9,
        "heatmap": {},
    }
    with mock.patch.object(
        signal_engine, "evaluate_gex_wall", return_value=_evaluation(setup_type, side)
    ):
        return signal_engine._gex_wall_candidate(
            spy, latest, 100.0, gex_ctx, completed=[], now=1_756_000_000.0
        )


class WallStrategyPolicyTest(unittest.TestCase):
    def test_bounce_is_in_the_disabled_set(self):
        self.assertIn("GEX_WALL_BOUNCE", signal_engine.DISABLED_WALL_STRATEGIES)

    def test_bounce_setup_never_becomes_a_candidate(self):
        self.assertIsNone(_candidate("PUT_WALL_BOUNCE_CALL", "calls"))

    def test_rejection_still_arms(self):
        candidate = _candidate("CALL_WALL_REJECTION_PUT", "puts")
        self.assertIsNotNone(candidate)
        self.assertEqual(candidate["strategy"], "GEX_WALL_REJECTION")

    def test_failed_break_still_arms(self):
        candidate = _candidate("CALL_WALL_FAILED_BREAKOUT_PUT", "puts")
        self.assertIsNotNone(candidate)
        self.assertEqual(candidate["strategy"], "GEX_WALL_BREAK_FAIL")


if __name__ == "__main__":
    unittest.main()
