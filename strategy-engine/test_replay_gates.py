"""Tests for the replay_gates harness protocol.

The gate SEMANTICS are covered by test_entry_gates.py against
signal_engine._enforce_entry_gates directly; these tests cover what the
harness adds: snapshot re-arming, spot/atr fallbacks, blocker diffing, and
per-line error isolation.
"""
from __future__ import annotations

import io
import json
import unittest
from contextlib import redirect_stdout
from unittest import mock

import replay_gates


def _run_lines(lines: list[str]) -> list[dict]:
    stdout = io.StringIO()
    with mock.patch("sys.stdin", io.StringIO("\n".join(lines) + "\n")):
        with redirect_stdout(stdout):
            replay_gates.main()
    return [json.loads(line) for line in stdout.getvalue().splitlines() if line]


class ReplayGatesTest(unittest.TestCase):
    def test_rearms_snapshot_before_gating(self):
        # A snapshot recorded as gated (entry_allowed False, state MANAGE)
        # must still be judged fresh: replay asks what the CURRENT code says.
        record = {
            "id": "a",
            "snapshot": {
                "state": "MANAGE",
                "lifecycle": {"entry_allowed": False},
                "strategy": "CONTINUATION",
                "favoring": "calls",
                "gex": {"flip": 700.0, "regime": "Negative", "gamma_regime": "Trend"},
            },
            "spot": 710.0,
            "atr_5m": 1.0,
        }
        result = replay_gates.evaluate(record)
        self.assertTrue(result["entry_allowed"])
        self.assertEqual(result["gates"], [])

    def test_reports_only_new_blockers(self):
        record = {
            "id": "b",
            "snapshot": {
                "strategy": "CONTINUATION",
                "favoring": "calls",
                "blockers": ["pre-existing blocker from live run"],
                "gex": {"flip": 760.0, "regime": "Positive", "gamma_regime": "Range"},
            },
            "spot": 771.24,
            "atr_5m": 1.0,
        }
        result = replay_gates.evaluate(record)
        self.assertFalse(result["entry_allowed"])
        self.assertEqual(len(result["gates"]), 1)
        self.assertIn("Positive/Range pin", result["gates"][0])
        self.assertNotIn("pre-existing blocker from live run", result["gates"])

    def test_spot_and_atr_fall_back_to_snapshot_fields(self):
        record = {
            "id": "c",
            "snapshot": {
                "strategy": "GEX_WALL_BREAK_FAIL",
                "favoring": "puts",
                "spot": 770.14,
                "market_context": {"atr_5m": 1.0},
                "gex": {"flip": 770.37, "regime": "Negative", "gamma_regime": "Trend"},
            },
        }
        result = replay_gates.evaluate(record)
        self.assertFalse(result["entry_allowed"])
        self.assertIn("gamma flip", result["gates"][0])

    def test_missing_strategy_trips_completeness_gate(self):
        result = replay_gates.evaluate({"id": "d", "snapshot": {"favoring": "calls"}})
        self.assertFalse(result["entry_allowed"])
        self.assertIn("incomplete signal", result["gates"][0])

    def test_bad_line_does_not_kill_the_batch(self):
        good = json.dumps({
            "id": 1,
            "snapshot": {"strategy": "CONTINUATION", "favoring": "calls",
                         "gex": {"regime": "Negative", "gamma_regime": "Trend"}},
            "spot": 700.0,
            "atr_5m": 1.0,
        })
        outputs = _run_lines(["not-json", good])
        self.assertEqual(len(outputs), 2)
        self.assertIn("error", outputs[0])
        self.assertTrue(outputs[1]["entry_allowed"])
        self.assertEqual(outputs[1]["id"], 1)


if __name__ == "__main__":
    unittest.main()
