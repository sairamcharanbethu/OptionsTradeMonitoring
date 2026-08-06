import time
import unittest

from signal_engine import (
    ENGINE_VERSION,
    provider_timestamp_freshness,
    validate_trendline_structure_config,
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

    def test_trendline_runtime_config_is_shadow_only(self):
        config = validate_trendline_structure_config(None)
        self.assertEqual(config, {
            "enabled": True,
            "mode": "shadow",
            "length": 14,
            "slope_method": "ATR",
            "slope_multiplier": 1.0,
            "retest_window_bars": 5,
        })
        with self.assertRaisesRegex(ValueError, "mode must be shadow"):
            validate_trendline_structure_config({"mode": "primary"})

    def test_trendline_runtime_config_rejects_invalid_values(self):
        invalid = (
            {"enabled": "true"},
            {"length": 0},
            {"slope_method": "linear"},
            {"slope_multiplier": 0},
            {"retest_window_bars": -1},
        )
        for config in invalid:
            with self.subTest(config=config), self.assertRaises(ValueError):
                validate_trendline_structure_config(config)


if __name__ == "__main__":
    unittest.main()
