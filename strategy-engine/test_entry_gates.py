#!/usr/bin/env python3
"""Tests for the late entry-gate that fixes today's 0/8 pin-day failure modes."""

import unittest

from signal_engine import _enforce_entry_gates


def _live(strategy="CONTINUATION", favoring="calls", flip=100.0,
          regime="Negative", gamma="Trend", warnings=None):
    return {
        "state": "ACTIVE",
        "strategy": strategy,
        "favoring": favoring,
        "lifecycle": {"entry_allowed": True},
        "gex": {"flip": flip, "regime": regime, "gamma_regime": gamma},
        "warnings": list(warnings or []),
        "blockers": [],
    }


def _allowed(result):
    return bool((result.get("lifecycle") or {}).get("entry_allowed"))


class EntryGateTest(unittest.TestCase):
    def test_flip_no_mans_land_blocks(self):
        # spot 100.1 within 0.5*ATR(1.0)=0.5 of flip 100.0 -> blocked (today's 8/8).
        r = _enforce_entry_gates(_live(flip=100.0), spot=100.1, atr_5m=1.0)
        self.assertFalse(_allowed(r))
        self.assertTrue(any("gamma flip" in b for b in r["blockers"]))

    def test_far_from_flip_in_trend_allows_momentum(self):
        # spot 105 vs flip 100, ATR 1 -> 5 ATRs away; Negative/Trend -> allowed.
        r = _enforce_entry_gates(_live(flip=100.0, regime="Negative", gamma="Trend"),
                                 spot=105.0, atr_5m=1.0)
        self.assertTrue(_allowed(r))
        self.assertEqual(r["blockers"], [])

    def test_momentum_in_positive_range_pin_blocks(self):
        # CONTINUATION call in Positive/Range (a pin) far from flip -> blocked (793/794).
        r = _enforce_entry_gates(_live(strategy="CONTINUATION", regime="Positive", gamma="Range"),
                                 spot=105.0, atr_5m=1.0)
        self.assertFalse(_allowed(r))
        self.assertTrue(any("Positive/Range" in b for b in r["blockers"]))

    def test_fade_exempt_in_positive_range(self):
        # A mean-reversion fade is meant to trade ranges -> NOT blocked by the pin gate.
        r = _enforce_entry_gates(_live(strategy="MTF_REVERSAL", regime="Positive", gamma="Range"),
                                 spot=105.0, atr_5m=1.0)
        self.assertTrue(_allowed(r))

    def test_incomplete_signal_blocks(self):
        # Null/empty strategy with entry_allowed True (trade #795) -> blocked.
        r = _enforce_entry_gates(_live(strategy="", favoring="calls"), spot=105.0, atr_5m=1.0)
        self.assertFalse(_allowed(r))
        self.assertTrue(any("incomplete" in b for b in r["blockers"]))

    def test_non_directional_side_blocks(self):
        r = _enforce_entry_gates(_live(favoring="no-trade"), spot=105.0, atr_5m=1.0)
        self.assertFalse(_allowed(r))

    def test_activation_window_expired_blocks(self):
        r = _enforce_entry_gates(
            _live(warnings=["activation window expired or move extended; track signal only"]),
            spot=105.0, atr_5m=1.0,
        )
        self.assertFalse(_allowed(r))
        self.assertTrue(any("activation window expired" in b for b in r["blockers"]))

    def test_non_live_signal_untouched(self):
        base = _live()
        base["lifecycle"]["entry_allowed"] = False
        r = _enforce_entry_gates(base, spot=100.05, atr_5m=1.0)  # would trip flip gate if live
        self.assertEqual(r["blockers"], [])  # untouched — never re-enabled or re-blocked

    def test_clean_momentum_far_from_flip_passes(self):
        # The control case: valid CONTINUATION, far from flip, Negative/Trend -> allowed.
        r = _enforce_entry_gates(_live(strategy="CONTINUATION", flip=90.0, regime="Negative", gamma="Trend"),
                                 spot=105.0, atr_5m=1.0)
        self.assertTrue(_allowed(r))


if __name__ == "__main__":
    unittest.main(verbosity=2)
