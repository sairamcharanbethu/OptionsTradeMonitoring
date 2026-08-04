import unittest
from datetime import datetime, time

from premarket_bias_scanner_v5 import (
    ET,
    GapInfo,
    MacroEvent,
    SymbolContext,
    compute_gap,
    evaluate_context,
    imminence_regime,
    msi_regime,
)


NOW = datetime(2026, 8, 3, 9, 37, tzinfo=ET)


def base_context(**overrides):
    values = {
        "symbol": "SPY",
        "now_et": NOW,
        "spot": 751.90,
        "levels_age_seconds": 8.0,
        "net_gex": 9.33e9,
        "gamma_flip": 748.00,
        "call_wall": 752.00,
        "put_wall": 745.00,
        "max_pain": 750.00,
        "msi": 30.0,
        "gap": GapInfo("opening_gap", 0.30, 749.00, 751.25),
        "trap": {
            "triggered": True,
            "signal": "bearish_fade",
            "breakout_up": True,
            "breakout_down": False,
            "call_wall_migrated_up": False,
            "put_wall_migrated_down": False,
            "context_values": {"gamma_strengthening": True},
        },
        "range_break": {
            "triggered": False,
            "imminence": 30.0,
            "direction": "neutral",
            "label": "Range Fade",
        },
        "market_pressure": {
            "triggered": False,
            "loading": 20.0,
            "direction": "neutral",
        },
        "trade_bias": {"direction": "bearish", "confidence": 0.65},
        "basic_signals": {
            "signals": {"dealer_delta_pressure": {"score": 0.0, "direction": "neutral"}}
        },
        "action_card": {
            "action": "SELL_CALL_SPREAD",
            "direction": "bearish",
            "confidence": 0.68,
        },
        "zero_dte": {},
        "gamma_vwap": {},
        "volatility": {},
        "session_levels": {},
        "warnings": [],
    }
    values.update(overrides)
    return SymbolContext(**values)


class RegimeTests(unittest.TestCase):
    def test_msi_7_7_is_high_risk_reversal_not_bearish(self):
        self.assertEqual(msi_regime(7.7), "High-Risk Reversal")

    def test_imminence_59_6_is_weak_range(self):
        self.assertEqual(imminence_regime(59.6), "Weak Range")


class WallDecisionTests(unittest.TestCase):
    def test_positive_gex_supports_confirmed_call_wall_fade(self):
        decision = evaluate_context(base_context())

        self.assertEqual(decision.code, "CALL_WALL_FADE")
        self.assertGreaterEqual(decision.confidence, 8)
        self.assertEqual(decision.risk_multiplier, 0.50)
        self.assertIn("Positive GEX supports wall absorption", decision.reasons)

    def test_negative_gex_suppresses_wall_fade(self):
        decision = evaluate_context(base_context(net_gex=-2.0e9))

        self.assertEqual(decision.code, "STAND_DOWN")
        self.assertEqual(decision.risk_multiplier, 0.0)

    def test_msi_7_7_reduces_size_without_creating_direction(self):
        decision = evaluate_context(base_context(msi=7.7))

        self.assertEqual(decision.code, "CALL_WALL_FADE")
        self.assertEqual(decision.direction, "bearish")
        self.assertEqual(decision.risk_multiplier, 0.25)

    def test_weak_range_reduces_size(self):
        context = base_context(
            range_break={
                "triggered": False,
                "imminence": 59.6,
                "direction": "bullish",
                "label": "Weak Range",
            }
        )
        decision = evaluate_context(context)

        self.assertEqual(decision.code, "CALL_WALL_FADE")
        self.assertEqual(decision.risk_multiplier, 0.25)

    def test_wick_without_trap_signal_is_not_an_entry(self):
        trap = dict(base_context().trap)
        trap.update({"triggered": False, "signal": "none"})
        decision = evaluate_context(base_context(trap=trap))

        self.assertEqual(decision.code, "WAIT_FOR_TRAP")
        self.assertEqual(decision.risk_multiplier, 0.0)

    def test_loaded_opposing_pressure_suppresses_fade(self):
        pressure = {"triggered": True, "loading": 72.0, "direction": "bullish"}
        decision = evaluate_context(base_context(market_pressure=pressure))

        self.assertEqual(decision.code, "STAND_DOWN")
        self.assertIn("Loaded market pressure", decision.action)

    def test_migration_exits_puts_without_unconfirmed_flip(self):
        trap = dict(base_context().trap)
        trap["call_wall_migrated_up"] = True
        decision = evaluate_context(base_context(trap=trap))

        self.assertEqual(decision.code, "EXIT_PUTS")
        self.assertEqual(decision.risk_multiplier, 0.0)
        self.assertIn("Do not auto-flip", decision.action)

    def test_migration_with_two_break_signals_creates_watch_not_entry(self):
        trap = dict(base_context().trap)
        trap["call_wall_migrated_up"] = True
        context = base_context(
            trap=trap,
            range_break={
                "triggered": True,
                "imminence": 72.0,
                "direction": "bullish",
            },
            market_pressure={
                "triggered": True,
                "loading": 65.0,
                "direction": "bullish",
            },
        )
        decision = evaluate_context(context)

        self.assertEqual(decision.code, "CALL_BREAKOUT_WATCH")
        self.assertEqual(decision.risk_multiplier, 0.0)
        self.assertIn("successful retest", decision.action)

    def test_stale_levels_fail_closed(self):
        decision = evaluate_context(base_context(levels_age_seconds=90.0))

        self.assertEqual(decision.code, "STAND_DOWN")
        self.assertEqual(decision.setup, "stale_data")

    def test_known_macro_window_blocks_new_entry(self):
        event = MacroEvent("ISM Manufacturing PMI", "high", time(10, 0))
        decision = evaluate_context(base_context(now_et=NOW.replace(minute=39)), event)

        self.assertEqual(decision.code, "STAND_DOWN")
        self.assertEqual(decision.setup, "macro_window")


class GapTests(unittest.TestCase):
    def test_opening_gap_uses_first_rth_open_not_latest_price(self):
        historical = [
            {
                "timestamp": "2026-08-03T13:30:00Z",
                "open": 751.00,
                "close": 751.40,
            },
            {
                "timestamp": "2026-08-03T13:37:00Z",
                "open": 755.50,
                "close": 756.00,
            },
        ]
        closes = {
            "current_session_close": 750.00,
            "current_session_close_ts": "2026-07-31T20:00:00Z",
            "prior_session_close": 748.00,
        }

        gap = compute_gap(historical, closes, NOW)

        self.assertEqual(gap.basis, "opening_gap")
        self.assertAlmostEqual(gap.percent, (751.00 - 750.00) / 750.00 * 100.0)
        self.assertEqual(gap.reference_price, 751.00)


if __name__ == "__main__":
    unittest.main()
