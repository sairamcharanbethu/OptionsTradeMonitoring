#!/usr/bin/env python3

import unittest

from zerogex_prefetch_service import (
    _apply_lane_result,
    _health_payload,
    _merge_cached_context,
    _polling_status,
)


class ZeroGEXPrefetchServiceTest(unittest.TestCase):
    def test_background_context_merge_does_not_replace_main_freshness(self) -> None:
        main = {
            "fetched_at": 200.0,
            "gex_summary": {"call_wall": 740},
            "trade_bias": {},
            "market_quote": {},
            "market_bars": [],
        }
        core = {
            "fetched_at": 150.0,
            "trade_bias": {"direction": "long"},
            "basic_signals": {},
            "composite": {"score": 42},
            "playbook": {"state": "stand_down"},
            "market_quote": {"close": 738.5},
            "market_bars": [{"close": 738.4}],
            "endpoint_errors": {"market_bars": "slow"},
        }

        errors = _apply_lane_result(main, "core", core)

        self.assertEqual(main["fetched_at"], 200.0)
        self.assertEqual(main["gex_summary"]["call_wall"], 740)
        self.assertEqual(main["market_quote"]["close"], 738.5)
        self.assertEqual(errors, {"market_bars": "slow"})

    def test_new_main_snapshot_reuses_cached_context_only(self) -> None:
        current = {
            "fetched_at": 205.0,
            "gex_summary": {"call_wall": 741},
            "trade_bias": {},
            "advanced_signals": {},
        }
        previous = {
            "fetched_at": 200.0,
            "gex_summary": {"call_wall": 740},
            "trade_bias": {"direction": "short"},
            "advanced_signals": {"range_break": {"triggered": True}},
        }

        _merge_cached_context(current, previous)

        self.assertEqual(current["fetched_at"], 205.0)
        self.assertEqual(current["gex_summary"]["call_wall"], 741)
        self.assertEqual(current["trade_bias"]["direction"], "short")
        self.assertTrue(current["advanced_signals"]["range_break"]["triggered"])

    def test_lane_freshness_merge_is_scoped_to_lane_components(self) -> None:
        main = {
            "fetched_at": 200.0,
            "gex_summary": {"call_wall": 740},
            "freshness": {"gex_summary": {"freshness_status": "fresh"}},
        }
        core = {
            "fetched_at": 150.0,
            "trade_bias": {"direction": "long"},
            "basic_signals": {},
            "composite": {},
            "playbook": {},
            "market_quote": {},
            "market_bars": [],
            "freshness": {
                "trade_bias": {"freshness_status": "aging"},
                # A stale gex entry inside a lane snapshot (e.g. carried
                # forward by the client) must never clobber the live one.
                "gex_summary": {"freshness_status": "stale"},
            },
        }

        _apply_lane_result(main, "core", core)

        self.assertEqual(
            main["freshness"]["gex_summary"]["freshness_status"], "fresh"
        )
        self.assertEqual(
            main["freshness"]["trade_bias"]["freshness_status"], "aging"
        )

    def test_cached_context_merge_keeps_lane_freshness(self) -> None:
        current = {
            "fetched_at": 205.0,
            "gex_summary": {"call_wall": 741},
            "freshness": {"gex_summary": {"freshness_status": "fresh"}},
        }
        previous = {
            "fetched_at": 200.0,
            "gex_summary": {"call_wall": 740},
            "freshness": {
                "gex_summary": {"freshness_status": "stale"},
                "advanced:squeeze_setup": {"freshness_status": "fresh"},
                "strike_profile": {"freshness_status": "aging"},
            },
        }

        _merge_cached_context(current, previous)

        self.assertEqual(
            current["freshness"]["gex_summary"]["freshness_status"], "fresh"
        )
        self.assertEqual(
            current["freshness"]["strike_profile"]["freshness_status"],
            "aging",
        )
        self.assertIn("advanced:squeeze_setup", current["freshness"])

    def test_health_exposes_independent_polling_lanes(self) -> None:
        lane_state = {
            "core": {
                "future": object(),
                "last_started_at": 100.0,
                "last_completed_at": 95.0,
            },
            "deep": {
                "future": None,
                "last_started_at": 90.0,
                "last_completed_at": 92.0,
            },
        }
        polling = _polling_status(
            lane_state,
            gex_interval=5,
            core_interval=15,
            deep_interval=30,
        )
        health = _health_payload(
            "ok",
            symbol="SPY",
            mode="primary",
            snapshot={"fetched_at": 110.0, "gex_summary": {}},
            polling=polling,
        )

        self.assertEqual(health["polling"]["gex_summary_interval_seconds"], 5)
        self.assertTrue(health["polling"]["core_in_flight"])
        self.assertFalse(health["polling"]["deep_in_flight"])


if __name__ == "__main__":
    unittest.main()
