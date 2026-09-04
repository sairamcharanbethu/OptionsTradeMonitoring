#!/usr/bin/env python3

import unittest

from gex_wall_evaluator import evaluate_gex_wall
from signal_engine import (
    GEX_WALL_MAX_OFFSET,
    GEX_WALL_MIN_ABS_DELTA,
    GEX_WALL_MIN_OFFSET,
    GEX_WALL_PREFERRED_OFFSET,
    GEX_WALL_TARGET_DELTA,
    _gex_wall_candidate,
    _higher_score_candidate,
    _select_signal_option,
)

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
        # Falling trend (15m down) + measured Negative Gamma + shooting star at
        # the call wall. The percentile is what makes the negative gamma
        # "strong" — regime sign alone must not reach A+ (see next test).
        bars = _trend_bars(60, 560, -0.5, last_override=(530.3, 535.0, 529.8, 530.0))
        result = evaluate_gex_wall(
            {"call_wall": 535.0, "put_wall": 500.0, "regime": "Negative", "net_gex_percentile": 5},
            bars, now=NOW,
        )
        self.assertEqual(result["setup_type"], "CALL_WALL_REJECTION_PUT")
        self.assertEqual(result["verdict"], "PARTICIPATE")
        self.assertEqual(result["direction"], "PUT")
        self.assertEqual(result["side"], "puts")
        self.assertEqual(result["confidence"], "A+")
        self.assertEqual(result["macro"]["trend_15m"], "down")
        self.assertTrue(result["regime"]["negative_gamma"])
        self.assertTrue(result["regime"]["negative_gamma_confident"])

    def test_sign_only_negative_gamma_cannot_upgrade_to_a_plus(self):
        # Same setup but the regime sign is the ONLY negative-gamma evidence
        # (no percentile, no net_gex). Demote-never-promote: the short still
        # PARTICIPATEs on the 15m-down alignment, but caps at A.
        bars = _trend_bars(60, 560, -0.5, last_override=(530.3, 535.0, 529.8, 530.0))
        result = evaluate_gex_wall(
            {"call_wall": 535.0, "put_wall": 500.0, "regime": "Negative"}, bars, now=NOW
        )
        self.assertEqual(result["setup_type"], "CALL_WALL_REJECTION_PUT")
        self.assertEqual(result["verdict"], "PARTICIPATE")
        self.assertEqual(result["confidence"], "A")
        self.assertTrue(result["regime"]["negative_gamma"])
        self.assertFalse(result["regime"]["negative_gamma_confident"])

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


class RegimePercentileAndVolumeTest(unittest.TestCase):
    """Tier-2 percentile gate + Tier-3 volume-exhaustion guard."""

    def _rejection(self, gex_extra, last_volume=1000):
        bars = _trend_bars(60, 560, -0.5, last_override=(530.3, 535.0, 529.8, 530.0))
        bars[-1]["volume"] = last_volume
        gex = {"call_wall": 535.0, "put_wall": 500.0, "regime": "Negative"}
        gex.update(gex_extra)
        return evaluate_gex_wall(gex, bars, now=NOW)

    def test_percentile_marks_negative_gamma_even_if_regime_positive(self):
        r = self._rejection({"regime": "Positive", "net_gex_percentile": 5})
        self.assertTrue(r["regime"]["negative_gamma"])

    def test_high_percentile_wins_over_absolute_net_gex(self):
        # Percentile (60) takes priority: not strong negative gamma, even at -2e9.
        r = self._rejection({"net_gex": -2.0e9, "net_gex_percentile": 60})
        self.assertFalse(r["regime"]["negative_gamma"])

    def test_fade_downgraded_when_volume_expands_into_wall(self):
        r = self._rejection({"net_gex": -2.0e9}, last_volume=5000)  # 5x the 1000 avg
        self.assertEqual(r["setup_type"], "CALL_WALL_REJECTION_PUT")
        self.assertTrue(r["volume"]["expanding"])
        self.assertEqual(r["verdict"], "CAUTION")

    def test_fade_participates_on_normal_volume(self):
        r = self._rejection({"net_gex": -2.0e9}, last_volume=1000)
        self.assertFalse(r["volume"]["expanding"])
        self.assertEqual(r["verdict"], "PARTICIPATE")


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
            net_gex_percentile=5,
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

    def _rejection_candidate(self, net_gex):
        # Falling trend (15m down) + shooting star at the call wall.
        bars = _trend_bars(60, 560, -0.5, last_override=(530.3, 535.0, 529.8, 530.0))
        return _gex_wall_candidate(
            {"atr_5m": 1.0},
            bars[-1],
            530.0,
            {
                "available": True,
                "call_wall": {"strike": 535.0, "stage": "Active"},
                "put_wall": {"strike": 500.0, "stage": "Active"},
                "flip": None,
                "regime": "Negative",
                "net_gex": net_gex,
            },
            bars,
            NOW,
        )

    def test_strong_negative_gamma_grades_a_plus(self):
        # net_gex below -1.5e9 => strong negative gamma tailwind => A+ (score 85).
        candidate = self._rejection_candidate(-2.0e9)
        self.assertEqual(candidate["wall_evaluation"]["confidence"], "A+")
        self.assertEqual(candidate["score"], 85)
        self.assertTrue(candidate["a_plus"])
        self.assertTrue(candidate["gex_alignment"]["regime"]["negative_gamma"])

    def test_mild_negative_gamma_grades_a_not_a_plus(self):
        # net_gex above the -1.5e9 magnitude gate => NOT strong negative gamma,
        # so the same rejection grades A (75), matching the source strategy.
        candidate = self._rejection_candidate(-0.5e9)
        self.assertEqual(candidate["wall_evaluation"]["confidence"], "A")
        self.assertEqual(candidate["score"], 75)
        self.assertFalse(candidate["a_plus"])
        self.assertFalse(candidate["gex_alignment"]["regime"]["negative_gamma"])

    def test_vwap_confluence_boosts_a_to_a_plus(self):
        # 15m down + Positive gamma => rejection grades A (75). VWAP on the wall
        # boosts to A+ (85); VWAP away from the wall leaves it at A.
        bars = _trend_bars(60, 560, -0.5, last_override=(530.3, 535.0, 529.8, 530.0))
        gex_ctx = {
            "available": True,
            "call_wall": {"strike": 535.0, "stage": "Active"},
            "put_wall": {"strike": 500.0, "stage": "Active"},
            "flip": None,
            "regime": "Positive",
        }
        confluent = _gex_wall_candidate(
            {"atr_5m": 1.0, "vwap": 535.0}, bars[-1], 530.0, gex_ctx, bars, NOW
        )
        self.assertEqual(confluent["score"], 85)
        self.assertTrue(confluent["gex_alignment"]["vwap_confluent"])
        plain = _gex_wall_candidate(
            {"atr_5m": 1.0, "vwap": 510.0}, bars[-1], 530.0, gex_ctx, bars, NOW
        )
        self.assertEqual(plain["score"], 75)
        self.assertFalse(plain["gex_alignment"]["vwap_confluent"])

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


def _call_option(strike, delta, mid=1.5):
    return {
        "local_symbol": f"SPY {strike}C",
        "right": "C",
        "strike": float(strike),
        "expiry": "20260101",
        "bid": round(mid - 0.02, 2),
        "ask": round(mid + 0.02, 2),
        "mid": mid,
        "spread_pct": 3.0,
        "delta": delta,
        "volume": 800.0,
        "liquidity": "ok",
        "quote_age_seconds": 1.0,
    }


class NearAtmContractSelectionTest(unittest.TestCase):
    """Wall setups must trade a near-the-money contract, not the default OTM pick."""

    OPTIONS = {
        "expiry": "20260101",
        "contracts": [
            _call_option(498, 0.62),
            _call_option(499, 0.56),
            _call_option(500, 0.50),  # ATM (spot 500)
            _call_option(501, 0.42),
            _call_option(502, 0.34),
        ],
    }

    def test_default_selection_stays_otm(self):
        selected = _select_signal_option(self.OPTIONS, "C", 500.0)
        self.assertGreater(selected["strike"], 500.0)  # OTM

    def test_wall_near_atm_selection_picks_atm(self):
        selected = _select_signal_option(
            self.OPTIONS, "C", 500.0,
            min_offset=GEX_WALL_MIN_OFFSET,
            max_otm_steps=GEX_WALL_MAX_OFFSET,
            target_delta=GEX_WALL_TARGET_DELTA,
            preferred_offset=GEX_WALL_PREFERRED_OFFSET,
            min_abs_delta=GEX_WALL_MIN_ABS_DELTA,
        )
        self.assertEqual(selected["strike"], 500.0)
        self.assertGreaterEqual(abs(selected["delta"]), 0.45)
        self.assertEqual(selected["otm_offset"], 0)


class StructureConfluenceTest(unittest.TestCase):
    """Tier-A price-structure confluence layered onto the wall setups."""

    def test_sweep_reclaim_boosts_break_fail_to_a_plus(self):
        # The final bar sweeps just below the put wall (524.7 < 525, shallow) and
        # reclaims strongly on the close. A sweep-and-reclaim of the wall *is* the
        # failed-breakdown setup (Check 4); the sweep confluence boosts A -> A+.
        bars = _trend_bars(60, 500, 0.5, last_override=(529.8, 530.1, 524.7, 530.0))
        result = evaluate_gex_wall(
            {"call_wall": 560, "put_wall": 525.0, "regime": "Positive"}, bars, now=NOW
        )
        self.assertEqual(result["setup_type"], "PUT_WALL_FAILED_BREAKDOWN_CALL")
        self.assertEqual(result["verdict"], "PARTICIPATE")
        self.assertEqual(result["confidence"], "A+")
        notes = result["structure"]["notes"]
        self.assertTrue(any("liquidity sweep" in n for n in notes))
        self.assertIsNotNone(result["structure"]["sweep"])

    def test_bounce_without_sweep_stays_a(self):
        # Final low sits exactly at the wall (no pierce) — no sweep, no boost.
        bars = _trend_bars(60, 500, 0.5, last_override=(529.8, 530.1, 525.0, 530.0))
        result = evaluate_gex_wall(
            {"call_wall": 560, "put_wall": 525.0, "regime": "Positive"}, bars, now=NOW
        )
        self.assertEqual(result["setup_type"], "PUT_WALL_BOUNCE_CALL")
        self.assertEqual(result["confidence"], "A")
        self.assertIsNone(result["structure"]["sweep"])

    def test_structure_block_always_present(self):
        bars = _trend_bars(60, 500, 0.5, last_override=(529.8, 530.1, 525.0, 530.0))
        result = evaluate_gex_wall(
            {"call_wall": 560, "put_wall": 525.0, "regime": "Positive"}, bars, now=NOW
        )
        structure = result["structure"]
        self.assertEqual(structure["engine_version"], "price-structure-v1")
        self.assertIn("displacement", structure)
        self.assertIn("acceptance", structure)
        self.assertIn("fvg_count", structure)


if __name__ == "__main__":
    unittest.main(verbosity=2)
