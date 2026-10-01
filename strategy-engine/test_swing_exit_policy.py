import unittest

import swing_exit_policy as policy


class SwingExitPolicyParityTests(unittest.TestCase):
    def test_embedded_defaults_match_shared_json(self) -> None:
        shared = policy.load_shared_policy()
        self.assertIsNotNone(shared, f"shared/swing-exit-policy.json missing at {policy.SHARED_POLICY_PATH}")
        self.assertEqual(shared, policy.embedded_defaults(), "Python mirror drifted from shared/swing-exit-policy.json")

    def test_module_constants_derive_from_policy(self) -> None:
        self.assertEqual(policy.SWING_MIN_DTE, 9)
        self.assertEqual(policy.SWING_MAX_DTE, 10)
        self.assertEqual(policy.EXIT_BEFORE_EXPIRY_DTE, 2)
        self.assertEqual(policy.MAX_HOLD_MINUTES, 7 * 24 * 60)
        self.assertEqual(policy.PREMIUM_STOP_PCT, 20.0)
        self.assertEqual(policy.TRAIL_PCT, 15.0)
        self.assertEqual((policy.PROFIT_LOCK_TRIGGER_MULT, policy.PROFIT_LOCK_RUNG2_MULT, policy.PROFIT_LOCK_RUNG2_FLOOR_MULT), (1.2, 1.5, 1.25))
        self.assertEqual((policy.T1_LOCK_ARM_PCT, policy.T1_LOCK_FLOOR_PCT), (20.0, 10.0))
        self.assertEqual(policy.MAX_TOTAL_DEBIT_DOLLARS, 500.0)

    def test_backtest_and_engine_consume_the_policy(self) -> None:
        import uw_swing_backtest as swing
        import signal_engine
        import inspect

        self.assertEqual(swing.PREMIUM_STOP_PCT, policy.PREMIUM_STOP_PCT)
        self.assertEqual(swing.TRAIL_PCT, policy.TRAIL_PCT)
        self.assertEqual(swing.EXIT_BEFORE_EXPIRY_DTE, policy.EXIT_BEFORE_EXPIRY_DTE)
        self.assertEqual(swing.MAX_HOLD_MINUTES, policy.MAX_HOLD_MINUTES)
        self.assertEqual(swing.PROFIT_LOCK_TRIGGER_MULT, policy.PROFIT_LOCK_TRIGGER_MULT)
        self.assertAlmostEqual(swing.T1_LOCK_ARM_RETURN, policy.T1_LOCK_ARM_PCT / 100)
        self.assertAlmostEqual(swing.T1_LOCK_FLOOR_RETURN, policy.T1_LOCK_FLOOR_PCT / 100)
        self.assertEqual(swing.LIVE_MAX_TOTAL_DEBIT, policy.MAX_TOTAL_DEBIT_DOLLARS)
        params = inspect.signature(signal_engine.build_signal).parameters
        self.assertEqual(params["t1_premium_lock_arm_pct"].default, policy.T1_LOCK_ARM_PCT)
        self.assertEqual(params["t1_premium_lock_floor_pct"].default, policy.T1_LOCK_FLOOR_PCT)


if __name__ == "__main__":
    unittest.main()
