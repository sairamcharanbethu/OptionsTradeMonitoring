import time
import unittest

from signal_engine import ENGINE_VERSION, provider_timestamp_freshness


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


if __name__ == "__main__":
    unittest.main()
