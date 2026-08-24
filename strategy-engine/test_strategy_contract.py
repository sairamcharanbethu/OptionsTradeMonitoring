import time
import unittest

from signal_engine import (
    ENGINE_VERSION,
    provider_timestamp_freshness,
    validate_strategy_families_config,
)


class StrategyContractTest(unittest.TestCase):
    def test_engine_remains_signal_only_v2(self):
        self.assertEqual(ENGINE_VERSION, "signal-only-v2")

    def test_future_provider_timestamp_fails_closed(self):
        now = time.time()
        result = provider_timestamp_freshness(
            now + 30,
            now=now,
            max_age=120,
            minute_bucket_grace_seconds=60,
        )
        self.assertFalse(result["fresh"])

    def test_stale_provider_timestamp_fails_closed(self):
        now = time.time()
        result = provider_timestamp_freshness(
            now - 181,
            now=now,
            max_age=120,
            minute_bucket_grace_seconds=60,
        )
        self.assertFalse(result["fresh"])

    def test_strategy_family_runtime_config_defaults_to_shadow_and_allows_primary(self):
        config = validate_strategy_families_config(None)

        self.assertTrue(config["orb_index"]["enabled"])
        self.assertTrue(config["vwap_trend"]["enabled"])
        self.assertEqual(config["mode"], "shadow")
        self.assertEqual(
            validate_strategy_families_config({"mode": "primary"})["mode"],
            "primary",
        )
        with self.assertRaisesRegex(ValueError, "mode must be shadow or primary"):
            validate_strategy_families_config({"mode": "live"})

    def test_strategy_family_runtime_config_rejects_invalid_values(self):
        invalid = (
            {"enabled": "true"},
            {"orb_index": []},
            {"orb_index": {"trigger_bar_count": 0}},
            {"orb_index": {"freshness_seconds": 30}},
            {"vwap_trend": {"hold_bars": 1}},
            {"vwap_trend": {"pullback_band_pct": 0}},
            {"vwap_trend": {"max_vwap_crosses": -1}},
        )
        for config in invalid:
            with self.subTest(config=config), self.assertRaises(ValueError):
                validate_strategy_families_config(config)


if __name__ == "__main__":
    unittest.main()
