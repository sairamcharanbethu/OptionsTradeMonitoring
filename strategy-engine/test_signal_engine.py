#!/usr/bin/env python3

from __future__ import annotations

import copy
import unittest
import time
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from zoneinfo import ZoneInfo

from signal_engine import (
    _select_signal_option,
    _frozen_reversal,
    _mandatory_flatten_due,
    _mtf_reversal_candidate,
    _estimated_option_stop_risk,
    _invalidation_exit_decision,
    _plan_quality,
    _select_otm_option,
    _new_entry_window_open,
    _zerogex_context,
    _zerogex_decision_context,
    build_signal,
    calculate_indicators,
    calculate_entry_structure_context,
    calculate_cross_market_context,
    calculate_orb_index_context,
    calculate_vwap_trend_context,
    market_data_readiness,
    render_signal,
)


ET = ZoneInfo("America/New_York")
TEST_SESSION_NOW = datetime(
    2026,
    7,
    29,
    10,
    30,
    tzinfo=ET,
).timestamp()
TEST_SESSION_EXPIRY = datetime.fromtimestamp(
    TEST_SESSION_NOW,
    ET,
).strftime("%Y%m%d")


class InvalidationExitDecisionTest(unittest.TestCase):
    def test_shallow_breach_requires_a_new_completed_one_minute_close(self) -> None:
        first = _invalidation_exit_decision(
            side="calls", spot=99.96, stop=100.0, atr_1m=0.20,
            last_completed_at=120.0, last_close=100.02,
            previous_confirmation=None, now=121.0,
        )
        self.assertFalse(first["exit"])
        self.assertEqual(first["confirmation"]["mode"], "AWAITING_1M_CLOSE")
        confirmed = _invalidation_exit_decision(
            side="calls", spot=100.03, stop=100.0, atr_1m=0.20,
            last_completed_at=180.0, last_close=99.95,
            previous_confirmation=first["confirmation"], now=181.0,
        )
        self.assertTrue(confirmed["exit"])
        self.assertEqual(confirmed["reason"], "one_minute_close")

    def test_hard_breach_requires_two_fresh_snapshots_unless_extreme(self) -> None:
        first = _invalidation_exit_decision(
            side="calls", spot=99.86, stop=100.0, atr_1m=0.20,
            last_completed_at=120.0, last_close=100.02,
            previous_confirmation=None, now=121.0,
        )
        self.assertFalse(first["exit"])
        self.assertEqual(first["confirmation"]["mode"], "HARD_BREACH_PENDING")
        confirmed = _invalidation_exit_decision(
            side="calls", spot=99.84, stop=100.0, atr_1m=0.20,
            last_completed_at=120.0, last_close=100.02,
            previous_confirmation=first["confirmation"], now=122.0,
        )
        self.assertTrue(confirmed["exit"])
        self.assertEqual(confirmed["reason"], "hard_breach")
        extreme = _invalidation_exit_decision(
            side="calls", spot=99.79, stop=100.0, atr_1m=0.20,
            last_completed_at=120.0, last_close=100.02,
            previous_confirmation=None, now=123.0,
        )
        self.assertTrue(extreme["exit"])
        self.assertEqual(extreme["reason"], "extreme_breach")


def et_timestamp(hour: int, minute: int, second: int = 0) -> float:
    day = datetime.now(ET)
    while day.weekday() >= 5:
        day -= timedelta(days=1)
    return day.replace(hour=hour, minute=minute, second=second, microsecond=0).timestamp()


def liquid_contract(
    right: str,
    strike: float,
    mid: float = 1.0,
    *,
    expiry: str | None = None,
) -> dict:
    return {
        "local_symbol": f"SPY {strike}{right}",
        "right": right,
        "strike": strike,
        "expiry": expiry or datetime.now(ET).strftime("%Y%m%d"),
        "bid": round(mid - 0.02, 2),
        "ask": round(mid + 0.02, 2),
        "mid": mid,
        "spread_pct": 4.0,
        "delta": 0.30 if right == "C" else -0.30,
        "volume": 500.0,
        "liquidity": "ok",
        "quote_age_seconds": 1.0,
    }


def family_bar(
    minute: int,
    *,
    open_price: float,
    high: float,
    low: float,
    close: float,
    volume: float = 1_000,
) -> dict:
    start = datetime(2026, 7, 29, 9, 30, tzinfo=ET)
    return {
        "time": (start + timedelta(minutes=minute)).timestamp(),
        "open": open_price,
        "high": high,
        "low": low,
        "close": close,
        "volume": volume,
    }


def structure_bars(*, side: str = "bullish") -> list[dict]:
    bars = []
    for index in range(27):
        bars.append({
            "time": 10_800.0 + index * 60,
            "open": 100.0,
            "high": 100.15,
            "low": 99.85,
            "close": 100.0,
            "volume": 1_000.0,
        })
    close = 101.0 if side == "bullish" else 99.0
    for index in range(27, 30):
        bars.append({
            "time": 10_800.0 + index * 60,
            "open": 100.0,
            "high": 101.2,
            "low": 98.8,
            "close": close,
            "volume": 2_000.0,
        })
    return bars


def wall_break_bars(*, side: str = "bullish", volume: float = 3_000.0) -> list[dict]:
    bars = []
    baseline_close = 99.5 if side == "bullish" else 100.5
    break_close = 100.5 if side == "bullish" else 99.5
    for index in range(35):
        breaking = index >= 30
        close = break_close if breaking else baseline_close
        bars.append({
            "time": 18_000.0 + index * 60,
            "open": baseline_close,
            "high": 101.0 if breaking else close + 0.2,
            "low": 99.0 if breaking else close - 0.2,
            "close": close,
            "volume": volume if breaking else 1_000.0,
        })
    return bars


class EntryStructureContextTest(unittest.TestCase):
    def test_completed_bullish_wick_reclaim_emits_stable_shadow_event(self) -> None:
        bars = structure_bars(side="bullish")

        first = calculate_entry_structure_context(bars)
        duplicate = calculate_entry_structure_context([*bars, dict(bars[-1])])

        self.assertTrue(first["available"])
        self.assertEqual(first["mode"], "shadow")
        event = first["ema_vwap"]["event"]
        self.assertEqual(event["side"], "bullish")
        self.assertEqual(event["timeframe"], "3m")
        self.assertEqual(event["line"], "ema9+vwap")
        self.assertTrue(event["completed_close_confirmed"])
        self.assertEqual(event["event_id"], duplicate["ema_vwap"]["event"]["event_id"])

    def test_completed_bearish_wick_rejection_is_detected(self) -> None:
        context = calculate_entry_structure_context(
            structure_bars(side="bearish")
        )

        event = context["ema_vwap"]["event"]
        self.assertEqual(event["side"], "bearish")
        self.assertLess(event["close"], event["ema9"])
        self.assertLess(event["close"], event["vwap"])

    def test_wick_without_close_reclaim_does_not_emit_event(self) -> None:
        bars = structure_bars(side="bullish")
        for bar in bars[-3:]:
            bar["close"] = 100.0

        context = calculate_entry_structure_context(bars)

        self.assertTrue(context["available"])
        self.assertIsNone(context["ema_vwap"]["event"])
        self.assertIn("no completed EMA9/VWAP rejection", context["observation"])

    def test_incomplete_candle_cannot_create_rejection(self) -> None:
        bars = structure_bars(side="bullish")
        for bar in bars[-3:]:
            bar["complete"] = False

        context = calculate_entry_structure_context(bars)

        self.assertIsNone(context["ema_vwap"]["event"])

    def test_conflicting_ema_and_vwap_rejections_do_not_emit_direction(self) -> None:
        bars = []
        for index in range(30):
            early = index < 3
            latest = index >= 27
            close = 102.0 if early else 100.0 if latest else 99.0
            bars.append({
                "time": 10_800.0 + index * 60,
                "open": close,
                "high": 103.0 if latest else close + 0.2,
                "low": 98.0 if latest else close - 0.2,
                "close": close,
                "volume": 100_000.0 if early else 100.0,
            })

        context = calculate_entry_structure_context(bars)

        self.assertIsNone(context["ema_vwap"]["event"])
        self.assertTrue(
            context["ema_vwap"]["timeframes"]["3m"]["conflicted_rejection"]
        )

class OrbIndexContextTest(unittest.TestCase):
    def opening_range(self) -> list[dict]:
        return [
            family_bar(0, open_price=100.0, high=100.4, low=99.8, close=100.2),
            family_bar(1, open_price=100.2, high=100.8, low=100.0, close=100.5),
            family_bar(2, open_price=100.5, high=101.0, low=100.3, close=100.7),
            family_bar(3, open_price=100.7, high=100.9, low=99.5, close=99.9),
            family_bar(4, open_price=99.9, high=100.3, low=99.0, close=99.8),
        ]

    def calculate(self, bars: list[dict], minute: int) -> dict:
        now = datetime(2026, 7, 29, 9, 30, tzinfo=ET) + timedelta(minutes=minute)
        return calculate_orb_index_context(bars, now=now.timestamp())

    def test_completed_close_confirms_fresh_bullish_break(self) -> None:
        bars = self.opening_range() + [
            family_bar(5, open_price=100.0, high=101.3, low=99.9, close=101.2),
        ]
        context = self.calculate(bars, 6)

        self.assertTrue(context["available"])
        self.assertEqual(context["opening_range"]["high"], 101.0)
        self.assertEqual(context["opening_range"]["low"], 99.0)
        self.assertEqual(context["candidate"]["side"], "calls")
        self.assertTrue(context["candidate"]["fresh"])
        self.assertTrue(context["candidate"]["completed_close_confirmed"])
        self.assertFalse(context["entry_authority"])

    def test_bearish_break_uses_second_confirmation_bar(self) -> None:
        bars = self.opening_range() + [
            family_bar(5, open_price=99.8, high=100.2, low=99.1, close=99.4),
            family_bar(6, open_price=99.4, high=99.5, low=98.6, close=98.8),
        ]
        context = self.calculate(bars, 7)

        self.assertEqual(context["candidate"]["side"], "puts")
        self.assertEqual(context["candidate"]["bar_time"], bars[-1]["time"])

    def test_wick_crossing_and_late_close_do_not_trigger(self) -> None:
        bars = self.opening_range() + [
            family_bar(5, open_price=100.0, high=101.4, low=99.8, close=100.8),
            family_bar(6, open_price=100.8, high=101.1, low=100.2, close=100.9),
            family_bar(7, open_price=100.9, high=101.4, low=100.8, close=101.2),
        ]
        context = self.calculate(bars, 8)

        self.assertIsNone(context["candidate"])
        self.assertEqual(context["status"], "WINDOW_CLOSED")

    def test_missing_opening_minute_is_unavailable(self) -> None:
        context = self.calculate(self.opening_range()[:-1], 35)

        self.assertFalse(context["available"])
        self.assertEqual(context["reason"], "opening_range_incomplete")

    def test_break_freshness_and_duplicate_event_are_deterministic(self) -> None:
        break_bar = family_bar(
            5, open_price=100.0, high=101.3, low=99.9, close=101.2
        )
        bars = self.opening_range() + [break_bar]
        fresh = self.calculate(bars, 6)
        duplicate = self.calculate([*bars, dict(break_bar)], 6)
        expired = self.calculate(bars, 12)

        self.assertEqual(duplicate, fresh)
        self.assertEqual(
            duplicate["candidate"]["event_id"],
            fresh["candidate"]["event_id"],
        )
        self.assertFalse(expired["candidate"]["fresh"])
        self.assertEqual(expired["status"], "EXPIRED_BREAK")

    def test_incomplete_break_bar_is_ignored(self) -> None:
        break_bar = family_bar(
            5, open_price=100.0, high=101.3, low=99.9, close=101.2
        )
        break_bar["complete"] = False
        context = self.calculate([*self.opening_range(), break_bar], 6)

        self.assertIsNone(context["candidate"])
        self.assertEqual(context["confirmation_bars_seen"], 0)

    def test_future_completed_bar_is_not_visible_before_its_close(self) -> None:
        break_bar = family_bar(
            5, open_price=100.0, high=101.3, low=99.9, close=101.2
        )
        before_close = calculate_orb_index_context(
            [*self.opening_range(), break_bar],
            now=datetime(2026, 7, 29, 9, 35, 59, tzinfo=ET).timestamp(),
        )
        after_close = calculate_orb_index_context(
            [*self.opening_range(), break_bar],
            now=datetime(2026, 7, 29, 9, 36, tzinfo=ET).timestamp(),
        )

        self.assertIsNone(before_close["candidate"])
        self.assertEqual(after_close["candidate"]["side"], "calls")

    def test_gex_alignment_is_advisory_only(self) -> None:
        bars = self.opening_range() + [
            family_bar(5, open_price=100.0, high=101.3, low=99.9, close=101.2),
        ]
        now = datetime(2026, 7, 29, 9, 36, tzinfo=ET).timestamp()
        context = calculate_orb_index_context(
            bars,
            now=now,
            gex_context={
                "available": True,
                "call_wall": {"strike": 102.0},
                "put_wall": {"strike": 98.0},
                "gamma_flip": 100.0,
            },
        )

        self.assertEqual(context["gex_alignment"]["alignment"], "HEADWIND")
        self.assertFalse(context["gex_alignment"]["entry_authority"])

    def test_gex_alignment_reads_normalized_flip_field(self) -> None:
        bars = self.opening_range() + [
            family_bar(5, open_price=100.0, high=101.3, low=99.9, close=101.2),
        ]
        context = calculate_orb_index_context(
            bars,
            now=datetime(2026, 7, 29, 9, 36, tzinfo=ET).timestamp(),
            gex_context={
                "available": True,
                "flip": 100.0,
            },
        )

        self.assertEqual(context["gex_alignment"]["gamma_flip"], 100.0)
        self.assertEqual(context["gex_alignment"]["alignment"], "ALIGNED")


class VwapTrendContextTest(unittest.TestCase):
    def bullish_cycle(self) -> list[dict]:
        bars = []
        for minute in range(8):
            base = 100.0 + minute * 0.10
            bars.append(family_bar(
                minute,
                open_price=base,
                high=base + 0.12,
                low=base - 0.04,
                close=base + 0.08,
            ))
        bars.append(family_bar(
            8,
            open_price=100.78,
            high=100.82,
            low=100.35,
            close=100.46,
        ))
        bars.append(family_bar(
            9,
            open_price=100.46,
            high=101.05,
            low=100.42,
            close=101.0,
            volume=1_500,
        ))
        return bars

    def calculate(self, bars: list[dict], minute: int = 10) -> dict:
        now = datetime(2026, 7, 29, 9, 30, tzinfo=ET) + timedelta(minutes=minute)
        return calculate_vwap_trend_context(
            bars,
            now=now.timestamp(),
            slope_lookback_bars=5,
            minimum_slope_bps=1.0,
            hold_bars=3,
            pullback_band_pct=0.15,
            chop_lookback_bars=10,
            max_vwap_crosses=2,
        )

    def test_bullish_pullback_reclaim_confirms_candidate(self) -> None:
        context = self.calculate(self.bullish_cycle())

        self.assertTrue(context["available"])
        self.assertEqual(context["trend"]["side"], "calls")
        self.assertGreater(context["trend"]["slope_bps"], 1.0)
        self.assertEqual(context["candidate"]["side"], "calls")
        self.assertTrue(context["candidate"]["fresh"])
        self.assertFalse(context["entry_authority"])

    def test_flat_vwap_does_not_qualify(self) -> None:
        bars = [
            family_bar(
                minute,
                open_price=100.0,
                high=100.1,
                low=99.9,
                close=100.0,
            )
            for minute in range(10)
        ]
        context = self.calculate(bars)

        self.assertIsNone(context["candidate"])
        self.assertEqual(context["status"], "NO_TREND")

    def test_bearish_pullback_rejection_confirms_candidate(self) -> None:
        bars = []
        for minute in range(8):
            base = 100.8 - minute * 0.10
            bars.append(family_bar(
                minute,
                open_price=base,
                high=base + 0.04,
                low=base - 0.12,
                close=base - 0.08,
            ))
        bars.extend([
            family_bar(
                8,
                open_price=100.02,
                high=100.45,
                low=99.98,
                close=100.34,
            ),
            family_bar(
                9,
                open_price=100.34,
                high=100.38,
                low=99.45,
                close=99.50,
                volume=1_500,
            ),
        ])

        context = self.calculate(bars)

        self.assertEqual(context["trend"]["side"], "puts")
        self.assertEqual(context["candidate"]["side"], "puts")
        self.assertTrue(context["candidate"]["completed_close_confirmed"])

    def test_chop_kill_switch_suppresses_reclaim(self) -> None:
        bars = self.bullish_cycle()
        for index, bar in enumerate(bars[2:8], start=2):
            bar["close"] = 100.25 + (0.20 if index % 2 else -0.20)
        context = self.calculate(bars)

        self.assertTrue(context["kill_switch"]["active"])
        self.assertIsNone(context["candidate"])

    def test_duplicate_cycle_has_stable_event_id_and_expires(self) -> None:
        bars = self.bullish_cycle()
        fresh = self.calculate(bars, 10)
        duplicate = self.calculate([*bars, dict(bars[-1])], 10)
        expired = self.calculate(bars, 16)

        self.assertEqual(duplicate, fresh)
        self.assertEqual(
            duplicate["candidate"]["event_id"],
            fresh["candidate"]["event_id"],
        )
        self.assertFalse(expired["candidate"]["fresh"])

    def test_incomplete_reclaim_bar_is_ignored(self) -> None:
        bars = self.bullish_cycle()
        bars[-1]["complete"] = False
        context = self.calculate(bars)

        self.assertIsNone(context["candidate"])

    def test_future_reclaim_bar_is_not_visible_before_its_close(self) -> None:
        bars = self.bullish_cycle()
        before_close = self.calculate(bars, 9)
        after_close = self.calculate(bars, 10)

        self.assertIsNone(before_close["candidate"])
        self.assertEqual(after_close["candidate"]["side"], "calls")

    def test_new_pullback_cycle_creates_a_new_event_after_cooldown(self) -> None:
        first_bars = self.bullish_cycle()
        first = self.calculate(first_bars, 10)
        later = [
            family_bar(10, open_price=101.0, high=101.2, low=100.95, close=101.15),
            family_bar(11, open_price=101.15, high=101.3, low=101.1, close=101.25),
            family_bar(12, open_price=101.25, high=101.4, low=101.2, close=101.35),
            family_bar(13, open_price=101.35, high=100.82, low=100.55, close=100.70),
            family_bar(14, open_price=100.70, high=101.55, low=100.65, close=101.50),
        ]
        second = calculate_vwap_trend_context(
            [*first_bars, *later],
            now=datetime(2026, 7, 29, 9, 45, tzinfo=ET).timestamp(),
            previous_context=first,
        )

        self.assertIsNotNone(second["candidate"])
        self.assertNotEqual(
            second["candidate"]["event_id"], first["candidate"]["event_id"]
        )

    def test_repeat_cycle_inside_cooldown_is_recorded_but_suppressed(self) -> None:
        first_bars = self.bullish_cycle()
        later = [
            family_bar(10, open_price=101.0, high=101.2, low=100.95, close=101.15),
            family_bar(11, open_price=101.15, high=101.3, low=101.1, close=101.25),
            family_bar(12, open_price=100.75, high=100.82, low=100.5, close=100.65),
            family_bar(13, open_price=100.65, high=101.45, low=100.6, close=101.4),
        ]
        context = self.calculate([*first_bars, *later], 14)

        self.assertEqual(context["status"], "REENTRY_COOLDOWN")
        self.assertIsNone(context["candidate"])
        self.assertEqual(context["suppressed_candidate"]["side"], "calls")

    def test_batch_and_incremental_calculations_match(self) -> None:
        bars = self.bullish_cycle()
        first = self.calculate(bars[:-1], 9)
        batch = self.calculate(bars, 10)
        incremental = calculate_vwap_trend_context(
            bars,
            now=datetime(2026, 7, 29, 9, 40, tzinfo=ET).timestamp(),
            previous_context=first,
        )

        self.assertEqual(incremental, batch)


class PrimaryStrategyFamilySignalTest(unittest.TestCase):
    def build(
        self,
        bars: list[dict],
        now: float,
        spot: float,
        *,
        strategy_families: dict | None = None,
        previous_signal: dict | None = None,
        include_indicator_vwap: bool = True,
    ) -> dict:
        expiry = datetime.fromtimestamp(now, ET).strftime("%Y%m%d")
        market = {
            "generated_at": now,
            "symbols": {
                "SPY": {
                    "spot": spot,
                    "quote_age_seconds": 0.1,
                    "bars": bars,
                }
            },
        }
        spy_indicators = {
            "atr_5m": 0.40,
            "rvol": 1.0,
            "completed_bar_age_seconds": 60,
        }
        if include_indicator_vwap:
            spy_indicators["vwap"] = 100.0
        indicators = {"SPY": spy_indicators}
        options = {
            "expiry": expiry,
            "contracts": [
                liquid_contract(right, strike, expiry=expiry)
                for strike in range(97, 105)
                for right in ("C", "P")
            ],
        }
        gex = {
            "fetched_at": now,
            "data": {
                "SPY": {
                    "gamma_regime": "Trend",
                    "regime": "Negative",
                    "rolling": "FLOOR_UP",
                    "flip": 100.0,
                    "call_wall": {"strike": 103.0, "stage": "Fresh"},
                    "put_wall": {"strike": 97.0, "stage": "Fresh"},
                },
                "VIX": {"gamma_regime": "Range"},
            },
        }
        with patch("signal_engine.time.time", return_value=now), patch(
            "signal_engine._regular_session_open", return_value=True
        ), patch("signal_engine._new_entry_window_open", return_value=True), patch(
            "signal_engine._mandatory_flatten_due", return_value=False
        ), patch("signal_engine._mtf_reversal_candidate", return_value=None):
            return build_signal(
                market,
                indicators,
                options,
                gex,
                previous_signal=previous_signal,
                strategy_families=strategy_families or {
                    "enabled": True,
                    "mode": "primary",
                },
            )

    def test_primary_orb_activates_before_twenty_two_completed_bars(self) -> None:
        bars = OrbIndexContextTest().opening_range() + [
            family_bar(5, open_price=100.0, high=101.3, low=99.9, close=101.2),
        ]
        now = datetime(2026, 7, 29, 9, 36, 5, tzinfo=ET).timestamp()

        signal = self.build(
            bars,
            now,
            101.22,
            include_indicator_vwap=False,
        )

        self.assertEqual(len(bars), 6)
        self.assertEqual(signal["strategy"], "ORB_INDEX")
        self.assertEqual(signal["state"], "ACTIVE")
        self.assertTrue(signal["lifecycle"]["entry_allowed"])
        self.assertEqual(signal["call_setup"]["source_event_id"], signal["reversal_setup"]["event_id"])
        self.assertEqual(signal["paper_policy"]["premium_stop_pct"], 35.0)
        self.assertEqual(signal["paper_policy"]["trim_ladder_pct"], [25.0, 45.0, 75.0])
        self.assertNotIn("insufficient completed intraday bars", signal["blockers"])

    def test_active_orb_keeps_tracking_after_family_freshness_expires(self) -> None:
        bars = OrbIndexContextTest().opening_range() + [
            family_bar(5, open_price=100.0, high=101.3, low=99.9, close=101.2),
        ]
        first_now = datetime(2026, 7, 29, 9, 36, 5, tzinfo=ET).timestamp()
        first = self.build(bars, first_now, 101.22)
        later_bars = [
            *bars,
            *[
                family_bar(
                    minute,
                    open_price=101.20,
                    high=101.30,
                    low=101.10,
                    close=101.20,
                )
                for minute in range(6, 12)
            ],
        ]
        later_now = datetime(2026, 7, 29, 9, 42, 5, tzinfo=ET).timestamp()
        previous = copy.deepcopy(first)
        previous["generated_at"] = later_now - 1
        previous["lifecycle"]["last_trusted_tracking_at"] = later_now - 1

        later = self.build(
            later_bars,
            later_now,
            101.20,
            previous_signal=previous,
        )

        self.assertEqual(len(later_bars), 12)
        self.assertEqual(later["strategy"], "ORB_INDEX")
        self.assertEqual(later["state"], "ACTIVE")
        self.assertEqual(later["paper_policy"]["premium_stop_pct"], 35.0)
        self.assertNotIn("insufficient completed intraday bars", later["blockers"])

    def test_terminal_family_event_cannot_reenter_from_same_completed_bar(self) -> None:
        bars = OrbIndexContextTest().opening_range() + [
            family_bar(5, open_price=100.0, high=101.3, low=99.9, close=101.2),
        ]
        first_now = datetime(2026, 7, 29, 9, 36, 5, tzinfo=ET).timestamp()
        first = self.build(bars, first_now, 101.22)
        retry_now = first_now + 20
        terminal = copy.deepcopy(first)
        terminal.update(state="FAILED", generated_at=retry_now - 16)
        terminal["lifecycle"].update(
            status="FAILED",
            entry_allowed=False,
            paper_position_open=False,
            closed_at=retry_now - 16,
        )

        retry = self.build(
            bars,
            retry_now,
            101.22,
            previous_signal=terminal,
            include_indicator_vwap=False,
        )

        self.assertNotEqual(retry.get("state"), "ACTIVE")
        self.assertFalse((retry.get("lifecycle") or {}).get("entry_allowed", False))

    def test_primary_vwap_reclaim_activates_without_mtf_confirmation(self) -> None:
        bars = VwapTrendContextTest().bullish_cycle()
        now = datetime(2026, 7, 29, 9, 40, 5, tzinfo=ET).timestamp()

        signal = self.build(
            bars,
            now,
            101.01,
            strategy_families={
                "enabled": True,
                "mode": "primary",
                "orb_index": {"enabled": False},
            },
        )

        self.assertEqual(signal["strategy"], "VWAP_TREND")
        self.assertEqual(signal["state"], "ACTIVE")
        self.assertTrue(signal["lifecycle"]["entry_allowed"])
        self.assertIn("completed pullback-and-reclaim", signal["confirmations"][0])
        self.assertEqual(signal["strategy_family_context"]["mode"], "primary")
        self.assertTrue(signal["strategy_family_context"]["entry_authority"])


class ZeroGEXShadowContextTest(unittest.TestCase):
    def setUp(self) -> None:
        self.now = 1_785_162_000.0
        provider_time = datetime.fromtimestamp(
            self.now - 30, timezone.utc
        ).isoformat()
        self.snapshot = {
            "fetched_at": self.now - 5,
            "source": "zerogex",
            "mode": "shadow",
            "symbol": "SPY",
            "trade_bias": {
                "bias_score": -60.95,
                "direction": "short",
                "state": "baseline",
                "confidence": 52.42,
                "setup": "Mean Reversion",
                "timestamp": provider_time,
                "has_data": True,
            },
            "gex_summary": {
                "timestamp": provider_time,
                "spot_price": 741.5,
                "gamma_flip": 747.66,
                "call_wall": 745.0,
                "put_wall": 740.0,
                "net_gex": -3_800_000_000,
            },
            "basic_signals": {
                "tape_flow_bias": {
                    "score": -52.0,
                    "clamped_score": -0.52,
                    "direction": "bearish",
                    "timestamp": provider_time,
                    "context_values": {"large": "not copied into signal journal"},
                }
            },
        }
        self.gex = {
            "source": "sscgex",
            "call_wall": {"strike": 745.0},
            "put_wall": {"strike": 740.0},
            "heatmap": {
                "api_flip": 675.0,
                "nearest_zero_cross": 744.5,
            },
        }

    def test_shadow_flags_triangulated_sscgex_flip_outlier(self) -> None:
        context = _zerogex_context(
            self.snapshot,
            self.gex,
            741.5,
            now=self.now,
        )

        self.assertTrue(context["available"])
        self.assertTrue(context["fresh"])
        self.assertFalse(context["entry_authority"])
        self.assertTrue(context["comparison"]["sscgex_api_flip_outlier"])
        self.assertTrue(context["comparison"]["walls_aligned"])
        self.assertEqual(context["comparison"]["api_flip_gap_dollars"], 72.66)
        self.assertEqual(
            context["basic_signals"]["tape_flow_bias"]["context_values"],
            {"large": "not copied into signal journal"},
        )

    def test_stale_shadow_remains_non_authoritative(self) -> None:
        self.snapshot["fetched_at"] = self.now - 60
        context = _zerogex_context(
            self.snapshot,
            self.gex,
            741.5,
            now=self.now,
        )

        self.assertTrue(context["available"])
        self.assertFalse(context["fresh"])
        self.assertFalse(context["entry_authority"])

    def test_minute_bucket_age_uses_precision_allowance(self) -> None:
        now = self.now + 8
        minute_bucket = datetime.fromtimestamp(
            now - 128,
            timezone.utc,
        ).isoformat()
        self.snapshot["fetched_at"] = now - 2
        self.snapshot["gex_summary"]["timestamp"] = minute_bucket
        context = _zerogex_context(
            self.snapshot,
            self.gex,
            741.5,
            now=now,
        )

        freshness = context["data_freshness"]["gex_summary"]
        self.assertTrue(context["fresh"])
        self.assertEqual(freshness["raw_age_seconds"], 128.0)
        self.assertEqual(freshness["age_seconds"], 68.0)
        self.assertEqual(freshness["precision_grace_seconds"], 60.0)

    def test_render_labels_shadow_as_not_a_trigger(self) -> None:
        context = _zerogex_context(
            self.snapshot,
            self.gex,
            741.5,
            now=self.now,
        )
        text = render_signal(
            {
                "state": "WAIT",
                "signal_phase": "WAIT",
                "spot": 741.5,
                "favoring": "mixed/range",
                "blockers": [],
                "warnings": [],
                "gex": {},
                "zerogex_shadow": context,
                "execution_enabled": False,
            },
            details=True,
        )

        self.assertIn("ZEROGEX SHADOW (not a trigger)", text)
        self.assertIn("SSCGEX API flip outlier", text)

    def test_primary_role_is_authoritative_and_rendered_explicitly(self) -> None:
        provider_time = datetime.fromtimestamp(
            self.now - 30, timezone.utc
        ).isoformat()
        self.snapshot["composite"] = {
            "timestamp": provider_time,
            "score": 74.0,
        }
        self.snapshot["playbook"] = {
            "timestamp": provider_time,
            "state": "stand_down",
            "pattern": "stand_down",
            "direction": "non_directional",
            "confidence": 0.0,
            "near_misses": [
                {
                    "pattern": "call_wall_fade",
                    "missing": ["long-gamma backdrop is missing"],
                }
            ],
        }
        context = _zerogex_context(
            self.snapshot,
            {"source": "zerogex"},
            741.5,
            now=self.now,
            role="primary",
        )
        text = render_signal(
            {
                "state": "WAIT",
                "signal_phase": "WAIT",
                "spot": 741.5,
                "favoring": "mixed/range",
                "blockers": [],
                "warnings": [],
                "gex": {
                    "source": "zerogex",
                    "regime": "Negative",
                    "gamma_regime": "Trend",
                    "flip": 747.66,
                    "put_wall": {"strike": 740.0, "stage": "External"},
                    "call_wall": {"strike": 745.0, "stage": "External"},
                },
                "zerogex_shadow": context,
                "zerogex_decision": _zerogex_decision_context(context),
                "execution_enabled": False,
            },
            details=True,
        )

        self.assertTrue(context["gex_primary"])
        self.assertFalse(context["entry_authority"])
        self.assertIn("GEX [ZeroGEX]", text)
        self.assertIn("flip 747.66", text)
        self.assertIn("ZEROGEX BIAS (context; GEX summary is primary)", text)
        self.assertIn("ZEROGEX DECISION: STAND DOWN", text)
        self.assertIn("ZEROGEX NEAR MISS: call_wall_fade", text)

    def test_primary_stand_down_is_context_not_an_entry_veto(self) -> None:
        self.snapshot["composite"] = {
            "timestamp": datetime.fromtimestamp(
                self.now - 20, timezone.utc
            ).isoformat(),
            "score": 74.0,
        }
        self.snapshot["playbook"] = {
            "timestamp": datetime.fromtimestamp(
                self.now - 20, timezone.utc
            ).isoformat(),
            "state": "stand_down",
            "pattern": "stand_down",
            "direction": "non_directional",
            "confidence": 0.0,
            "near_misses": [{"pattern": "call_wall_fade", "missing": ["not ready"]}],
        }
        context = _zerogex_context(
            self.snapshot,
            {"source": "zerogex"},
            741.5,
            now=self.now,
            role="primary",
        )
        decision = _zerogex_decision_context(context)

        self.assertEqual(decision["composite"]["posture"], "trend_expansion")
        self.assertTrue(decision["gates"]["calls"]["entry_allowed"])
        self.assertTrue(decision["gates"]["puts"]["entry_allowed"])
        self.assertEqual(decision["gates"]["calls"]["blockers"], [])
        self.assertIn(
            "ZeroGEX has no confirming playbook setup",
            decision["gates"]["calls"]["warnings"],
        )

    def test_unavailable_components_are_availability_not_risk_warnings(self) -> None:
        # Missing/stale playbook and composite are missing *context*, not
        # adverse evidence: they must land in the gate's `availability` list,
        # never in `warnings` (which the AI-unavailable path force-SKIPs on).
        self.snapshot.pop("playbook", None)
        self.snapshot.pop("composite", None)
        context = _zerogex_context(
            self.snapshot,
            {"source": "zerogex"},
            741.5,
            now=self.now,
            role="primary",
        )
        decision = _zerogex_decision_context(context)

        for side in ("calls", "puts"):
            gate = decision["gates"][side]
            self.assertIn(
                "ZeroGEX playbook unavailable or stale; using GEX and local structure only",
                gate["availability"],
            )
            self.assertIn(
                "ZeroGEX MSI composite unavailable or stale",
                gate["availability"],
            )
            self.assertFalse(
                any("unavailable or stale" in warning for warning in gate["warnings"])
            )

    def test_primary_high_confidence_opposing_playbook_is_an_entry_veto(self) -> None:
        timestamp = datetime.fromtimestamp(
            self.now - 20, timezone.utc
        ).isoformat()
        self.snapshot["composite"] = {
            "timestamp": timestamp,
            "score": 74.0,
        }
        self.snapshot["playbook"] = {
            "timestamp": timestamp,
            "state": "candidate",
            "pattern": "bearish_continuation",
            "direction": "bearish",
            "confidence": 0.75,
            "near_misses": [],
        }
        context = _zerogex_context(
            self.snapshot,
            {"source": "zerogex"},
            741.5,
            now=self.now,
            role="primary",
        )
        decision = _zerogex_decision_context(context)

        self.assertFalse(decision["gates"]["calls"]["entry_allowed"])
        self.assertIn(
            "ZeroGEX playbook strongly opposes calls",
            decision["gates"]["calls"]["blockers"],
        )
        self.assertTrue(decision["gates"]["puts"]["entry_allowed"])

    def test_range_break_readiness_without_direction_is_not_a_directional_vote(self) -> None:
        timestamp = datetime.fromtimestamp(
            self.now - 20, timezone.utc
        ).isoformat()
        self.snapshot["advanced_signals"] = {
            "range_break_imminence": {
                "timestamp": timestamp,
                "triggered": True,
                "imminence": 76.0,
                "score": -7.0,
                "direction": "bearish",
            }
        }
        context = _zerogex_context(
            self.snapshot,
            {"source": "zerogex"},
            741.5,
            now=self.now,
            role="primary",
        )
        decision = _zerogex_decision_context(context)

        self.assertEqual(len(decision["active_advanced"]), 1)
        self.assertFalse(decision["active_advanced"][0]["directional"])
        self.assertFalse(
            any(
                "advanced conflicts" in warning
                for warning in decision["gates"]["calls"]["warnings"]
            )
        )

    def test_discrepancy_context_is_not_overstated_as_four_confirmations(self) -> None:
        timestamp = datetime.fromtimestamp(
            self.now - 20, timezone.utc
        ).isoformat()
        self.snapshot["trade_bias"].update(
            {
                "bias_score": -55.6,
                "direction": "short",
                "confidence": 45.59,
                "setup": "Mean Reversion",
                "bias": {
                    "code": "RANGE_FADE",
                    "label": "Range Fade",
                    "trend": "bearish",
                },
                "structural_bias": {
                    "code": "RANGE_FADE",
                    "label": "Range Fade",
                    "trend": "neutral",
                },
                "market_state": "CHOP",
                "conviction_driven": False,
            }
        )
        self.snapshot["basic_signals"]["positioning_trap"] = {
            "score": 55.93,
            "clamped_score": 0.5593,
            "direction": "bullish",
            "timestamp": timestamp,
        }
        self.snapshot["composite"] = {
            "timestamp": timestamp,
            "score": 79.0,
        }
        self.snapshot["playbook"] = {
            "timestamp": timestamp,
            "state": "stand_down",
            "pattern": "stand_down",
            "direction": "non_directional",
            "confidence": 0.0,
            "near_misses": [],
        }
        self.snapshot["advanced_signals"] = {
            "squeeze_setup": {
                "timestamp": timestamp,
                "triggered": True,
                "score": -78.54,
                "direction": "bearish",
                "context_values": {
                    "accel_dn": False,
                    "accel_up": False,
                },
            },
            "vol_expansion": {
                "timestamp": timestamp,
                "triggered": True,
                "score": -91.58,
                "direction": "bearish",
                "expansion": 87.0,
            },
            "range_break_imminence": {
                "timestamp": timestamp,
                "triggered": True,
                "score": -66.0,
                "direction": "bearish",
                "label": "Break Watch",
                "imminence": 70.73,
            },
            "zero_dte_position_imbalance": {
                "timestamp": timestamp,
                "triggered": True,
                "score": -75.0,
                "direction": "bearish",
                "context_values": {"flow_source": "zero_dte"},
            },
            "market_pressure": {
                "timestamp": timestamp,
                "triggered": False,
                "score": -0.09,
                "direction": "bearish",
                "label": "Discharged",
                "loading": 0.17,
            },
        }

        context = _zerogex_context(
            self.snapshot,
            {"source": "zerogex"},
            736.23,
            now=self.now,
            role="primary",
        )
        decision = _zerogex_decision_context(context)
        put_gate = decision["gates"]["puts"]

        self.assertTrue(put_gate["entry_allowed"])
        self.assertEqual(put_gate["blockers"], [])
        self.assertFalse(
            any(
                "Trade Bias aligns puts" in message
                for message in put_gate["confirmations"]
            )
        )
        self.assertTrue(
            any(
                "Range Fade / CHOP" in message
                for message in put_gate["warnings"]
            )
        )
        self.assertTrue(
            any(
                "Positioning Trap" in message
                for message in put_gate["warnings"]
            )
        )
        self.assertTrue(
            any(
                "Break Watch" in message and "break and retest" in message
                for message in put_gate["warnings"]
            )
        )
        momentum_confirmations = [
            message
            for message in put_gate["confirmations"]
            if "momentum/expansion family" in message
        ]
        self.assertEqual(len(momentum_confirmations), 1)
        squeeze = next(
            item
            for item in decision["active_advanced"]
            if item["name"] == "squeeze_setup"
        )
        self.assertFalse(squeeze["directional"])
        self.assertEqual(
            decision["advanced_status"]["market_pressure"]["label"],
            "Discharged",
        )

    def test_breakout_mode_is_qualified_confirmation_not_entry_authority(self) -> None:
        timestamp = datetime.fromtimestamp(
            self.now - 20, timezone.utc
        ).isoformat()
        self.snapshot["advanced_signals"] = {
            "range_break_imminence": {
                "timestamp": timestamp,
                "triggered": True,
                "score": -82.0,
                "direction": "bearish",
                "label": "Breakout Mode",
                "imminence": 86.0,
            }
        }
        context = _zerogex_context(
            self.snapshot,
            {"source": "zerogex"},
            736.23,
            now=self.now,
            role="primary",
        )
        decision = _zerogex_decision_context(context)

        self.assertTrue(
            any(
                "Breakout Mode aligns puts" in message
                and "local break/retest is still required" in message
                for message in decision["gates"]["puts"]["confirmations"]
            )
        )
        self.assertTrue(decision["gates"]["puts"]["entry_allowed"])


class MultiTimeframeReversalTest(unittest.TestCase):
    def setUp(self) -> None:
        # Observed near the July 20 14:20 ET SPY reversal.
        self.spy = {
            "vwap": 745.69,
            "atr_5m": 0.54,
            "ema9_5m": 744.77,
            "ema21_5m": 744.85,
            "ema9_15m": 744.85,
            "ema21_15m": 745.64,
            "ema9_60m": 745.22,
            "ema21_60m": 745.44,
        }
        self.latest = {
            "open": 745.15,
            "high": 745.19,
            "low": 744.82,
            "close": 744.98,
        }
        self.gex = {
            "gamma_regime": "Trend",
            "regime": "Negative",
            "rolling": "CEILING_DOWN",
        }

    def test_744_81_short_is_detected_before_continuation_chase(self) -> None:
        setup = _mtf_reversal_candidate(self.spy, self.latest, 744.81, self.gex)

        self.assertIsNotNone(setup)
        self.assertEqual(setup["strategy"], "MTF_TREND_BREAK")
        self.assertEqual(setup["side"], "puts")
        self.assertEqual(setup["score"], 90)
        self.assertEqual(setup["risk_plan"]["entry"], 744.81)
        self.assertEqual(setup["risk_plan"]["stop"], 745.27)
        self.assertEqual(setup["risk_plan"]["targets"], [744.35, 744.0, 743.54])
        self.assertEqual(
            setup["risk_plan"]["method"],
            "structure+0.15x_5m_atr_buffer",
        )

    def test_trigger_remains_frozen_during_pullback(self) -> None:
        setup = _mtf_reversal_candidate(self.spy, self.latest, 744.81, self.gex)
        setup.update(armed_at=1_000.0, frozen_until=1_900.0)
        previous = {"reversal_setup": setup}

        frozen = _frozen_reversal(previous, now=1_300.0, spot=744.30)

        self.assertIsNotNone(frozen)
        self.assertEqual(frozen["risk_plan"]["entry"], 744.81)

    def test_frozen_setup_expires_at_stop(self) -> None:
        setup = _mtf_reversal_candidate(self.spy, self.latest, 744.81, self.gex)
        setup.update(armed_at=1_000.0, frozen_until=1_900.0)

        self.assertIsNone(
            _frozen_reversal({"reversal_setup": setup}, now=1_300.0, spot=745.62)
        )

    def test_fresh_positive_node_rejection_is_separate_strategy(self) -> None:
        spy = {
            "vwap": 100.0,
            "atr_5m": 0.50,
            "ema9_5m": 100.20,
            "ema21_5m": 100.00,
            "ema9_15m": 100.15,
            "ema21_15m": 100.00,
            "ema9_60m": 100.00,
            "ema21_60m": 99.90,
        }
        latest = {
            "open": 100.05,
            "high": 100.25,
            "low": 99.98,
            "close": 100.20,
        }
        gex = {
            "gamma_regime": "Range",
            "regime": "Positive",
            "rolling": "FLOOR_UP",
            "heatmap": {
                "fresh": True,
                "positive_nodes": [{"strike": 100.0, "gex": 5_000_000}],
                "negative_nodes": [],
                "flip": 99.5,
            },
        }

        setup = _mtf_reversal_candidate(spy, latest, 100.20, gex)

        self.assertIsNotNone(setup)
        self.assertEqual(setup["strategy"], "GEX_REJECTION")
        self.assertEqual(setup["side"], "calls")
        self.assertTrue(setup["a_plus"])

    def test_trend_break_is_a_plus_only_with_negative_node_and_flip(self) -> None:
        gex = {
            **self.gex,
            "heatmap": {
                "fresh": True,
                "positive_nodes": [],
                "negative_nodes": [{"strike": 744.8, "gex": -4_000_000}],
                "flip": 745.0,
            },
        }

        setup = _mtf_reversal_candidate(self.spy, self.latest, 744.81, gex)

        self.assertEqual(setup["strategy"], "MTF_TREND_BREAK")
        self.assertTrue(setup["a_plus"])

    def test_positive_node_requires_actual_touch_and_rejection(self) -> None:
        spy = {
            "vwap": 100.0, "atr_5m": 0.50,
            "ema9_5m": 100.20, "ema21_5m": 100.00,
            "ema9_15m": 100.15, "ema21_15m": 100.00,
            "ema9_60m": 100.10, "ema21_60m": 100.00,
        }
        latest = {"open": 100.40, "high": 100.60, "low": 100.35, "close": 100.55}
        gex = {
            "gamma_regime": "Range", "regime": "Positive", "rolling": "FLOOR_UP",
            "heatmap": {
                "fresh": True,
                "positive_nodes": [{
                    "strike": 100.25, "gex": 5_000_000,
                    "magnitude_ratio": 1.0, "trend": "building",
                }],
                "negative_nodes": [],
                "dominant_migration": {"toward_spot": True},
                "flip": 99.5,
            },
        }

        setup = _mtf_reversal_candidate(spy, latest, 100.55, gex)

        self.assertNotEqual((setup or {}).get("strategy"), "GEX_REJECTION")

    def test_fading_or_low_magnitude_node_cannot_create_rejection(self) -> None:
        spy = {
            "vwap": 100.0, "atr_5m": 0.50,
            "ema9_5m": 100.20, "ema21_5m": 100.00,
            "ema9_15m": 100.15, "ema21_15m": 100.00,
            "ema9_60m": 100.10, "ema21_60m": 100.00,
        }
        latest = {"open": 100.05, "high": 100.25, "low": 99.98, "close": 100.20}
        for trend, ratio in (("fading", 1.0), ("building", 0.25)):
            gex = {
                "gamma_regime": "Range", "regime": "Positive", "rolling": "FLOOR_UP",
                "heatmap": {
                    "fresh": True,
                    "positive_nodes": [{
                        "strike": 100.0, "gex": 5_000_000,
                        "magnitude_ratio": ratio, "trend": trend,
                    }],
                    "negative_nodes": [],
                    "dominant_migration": {"toward_spot": True},
                    "flip": 99.5,
                },
            }
            setup = _mtf_reversal_candidate(spy, latest, 100.20, gex)
            self.assertNotEqual((setup or {}).get("strategy"), "GEX_REJECTION")

    def test_whipsaw_is_warning_not_veto_for_aligned_reversal(self) -> None:
        now = TEST_SESSION_NOW
        minute = int(now // 60) * 60
        bars = []
        for index in range(30):
            close = 746.0 - index * 0.03
            bars.append(
                {
                    "time": minute - (30 - index) * 60,
                    "open": close + 0.05,
                    "high": close + 0.10,
                    "low": close - 0.10,
                    "close": close,
                    "volume": 10_000,
                }
            )
        bars[-1].update(open=745.15, high=745.19, low=744.82, close=744.98)
        market = {
            "generated_at": now,
            "symbols": {"SPY": {"spot": 744.90, "quote_age_seconds": 0.1, "bars": bars}},
        }
        indicators = {
            "SPY": {
                **self.spy,
                "completed_bar_age_seconds": 60,
                "rvol": 0.9,
                "ema9_5m": 744.77,
                "ema21_5m": 744.85,
            }
        }
        options = {
            "expiry": TEST_SESSION_EXPIRY,
            "contracts": [
                liquid_contract(
                    right,
                    strike,
                    expiry=TEST_SESSION_EXPIRY,
                )
                for strike in range(741, 749)
                for right in ("C", "P")
            ],
        }
        gex = {
            "fetched_at": now,
            "data": {
                "SPY": {
                    "gamma_regime": "Trend",
                    "regime": "Negative",
                    "rolling": "CEILING_DOWN",
                    "call_wall": {"strike": 745.0, "stage": "Spent"},
                    "put_wall": {"strike": 742.0, "stage": "Fresh"},
                },
                "VIX": {"gamma_regime": "Whipsaw"},
            },
        }

        with patch("signal_engine.time.time", return_value=now), patch(
            "signal_engine._regular_session_open", return_value=True
        ), patch(
            "signal_engine._new_entry_window_open", return_value=True
        ), patch("signal_engine._mandatory_flatten_due", return_value=False):
            signal = build_signal(market, indicators, options, gex)

        self.assertEqual(signal["state"], "ARMED")
        self.assertEqual(signal["strategy"], "MTF_TREND_BREAK")
        self.assertEqual(signal["favoring"], "puts")
        self.assertEqual(signal["confidence_score"], 75)
        self.assertFalse(signal["blockers"])
        self.assertTrue(any("stronger confirmation" in warning for warning in signal["warnings"]))


class OtmOptionSelectionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.options = {
            "expiry": datetime.now(ZoneInfo("America/New_York")).strftime("%Y%m%d"),
            "contracts": [
                liquid_contract(right, strike)
                for strike in range(738, 748)
                for right in ("C", "P")
            ],
        }

    def test_second_otm_call_and_put_are_selected(self) -> None:
        call = _select_otm_option(self.options, "C", 742.10, steps=2)
        put = _select_otm_option(self.options, "P", 742.10, steps=2)
        self.assertEqual(call["target_strike"], 744.0)
        self.assertEqual(put["target_strike"], 740.0)
        self.assertTrue(call["eligible"])
        self.assertTrue(put["eligible"])

    def test_signal_option_prefers_delta_spread_and_volume_over_fixed_offset(self) -> None:
        call_one = next(
            contract for contract in self.options["contracts"]
            if contract["right"] == "C" and contract["strike"] == 743
        )
        call_two = next(
            contract for contract in self.options["contracts"]
            if contract["right"] == "C" and contract["strike"] == 744
        )
        call_one.update(delta=0.40, spread_pct=2.0, volume=2_000)
        call_two.update(delta=0.20, spread_pct=10.0, volume=50)

        selected = _select_signal_option(self.options, "C", 742.10)

        self.assertEqual(selected["target_strike"], 743.0)
        self.assertEqual(selected["selection"], "DELTA/LIQ OTM+1")

    def test_budget_selector_prefers_quality_over_contract_count(self) -> None:
        quality_contract = next(
            contract
            for contract in self.options["contracts"]
            if contract["right"] == "C" and contract["strike"] == 743
        )
        quality_contract.update(
            bid=1.47,
            ask=1.49,
            mid=1.48,
            delta=0.40,
            spread_pct=1.4,
            volume=2_000,
        )
        two_contract = next(
            contract
            for contract in self.options["contracts"]
            if contract["right"] == "C" and contract["strike"] == 745
        )
        two_contract.update(
            bid=0.96,
            ask=0.98,
            mid=0.97,
            delta=0.16,
            spread_pct=4.9,
            volume=10,
        )

        selected = _select_signal_option(
            self.options,
            "C",
            742.10,
            max_total_debit_dollars=200,
            preferred_contracts=2,
            limit_price_offset=0.01,
            max_otm_steps=6,
            max_spread_pct=5,
        )

        self.assertEqual(selected["target_strike"], 743.0)
        self.assertEqual(selected["planned_contracts"], 1)
        self.assertEqual(selected["planned_limit_price"], 1.50)
        self.assertEqual(selected["planned_total_debit"], 150.0)

    def test_selector_uses_open_interest_as_a_quality_tiebreaker(self) -> None:
        call_one = next(
            contract for contract in self.options["contracts"]
            if contract["right"] == "C" and contract["strike"] == 743
        )
        call_two = next(
            contract for contract in self.options["contracts"]
            if contract["right"] == "C" and contract["strike"] == 744
        )
        call_one.update(delta=0.40, spread_pct=2.0, volume=500, open_interest=10_000)
        call_two.update(delta=0.40, spread_pct=2.0, volume=500, open_interest=0)

        selected = _select_signal_option(self.options, "C", 742.10)

        self.assertEqual(selected["target_strike"], 743.0)
        self.assertGreater(selected["selection_quality"]["open_interest_credit"], 0)

    def test_selector_safely_clamps_negative_liquidity_fields(self) -> None:
        selected_contract = next(
            contract for contract in self.options["contracts"]
            if contract["right"] == "C" and contract["strike"] == 743
        )
        rejected_contract = next(
            contract for contract in self.options["contracts"]
            if contract["right"] == "C" and contract["strike"] == 744
        )
        selected_contract.update(
            delta=0.40,
            spread_pct=1.0,
            volume=2_000,
            open_interest=-100,
        )
        rejected_contract.update(volume=-100, open_interest=-100)

        selected = _select_signal_option(self.options, "C", 742.10)

        self.assertEqual(selected["target_strike"], 743.0)
        self.assertEqual(selected["selection_quality"]["open_interest_credit"], 0)

    def test_budget_selector_falls_back_to_one_quality_contract(self) -> None:
        preferred = next(
            contract
            for contract in self.options["contracts"]
            if contract["right"] == "C" and contract["strike"] == 743
        )
        preferred.update(
            bid=1.47,
            ask=1.49,
            mid=1.48,
            delta=0.40,
            spread_pct=1.4,
            volume=2_000,
        )

        selected = _select_signal_option(
            self.options,
            "C",
            742.10,
            max_total_debit_dollars=200,
            preferred_contracts=2,
            limit_price_offset=0.01,
            max_otm_steps=3,
            max_spread_pct=5,
        )

        self.assertEqual(selected["target_strike"], 743.0)
        self.assertEqual(selected["planned_contracts"], 1)
        self.assertEqual(selected["planned_total_debit"], 150.0)

    def test_budget_selector_rejects_when_no_contract_is_affordable(self) -> None:
        for contract in self.options["contracts"]:
            if contract["right"] == "C":
                contract.update(
                    bid=2.08,
                    ask=2.10,
                    mid=2.09,
                    spread_pct=1.0,
                )

        selected = _select_signal_option(
            self.options,
            "C",
            742.10,
            max_total_debit_dollars=200,
            preferred_contracts=2,
            limit_price_offset=0.01,
            max_otm_steps=6,
            max_spread_pct=5,
        )

        self.assertFalse(selected["eligible"])
        self.assertEqual(selected["planned_contracts"], 0)
        self.assertIn("BUDGET BLOCKED", selected["selection"])
        self.assertTrue(
            any(
                "$200 total-debit budget" in reason
                for reason in selected["rejection_reasons"]
            )
        )

    def test_budget_selector_does_not_buy_cheap_sub_delta_contract(self) -> None:
        cheap = next(
            contract
            for contract in self.options["contracts"]
            if contract["right"] == "C" and contract["strike"] == 746
        )
        cheap.update(
            bid=0.48,
            ask=0.50,
            mid=0.49,
            delta=0.10,
            spread_pct=4.0,
            volume=5_000,
        )

        selected = _select_signal_option(
            self.options,
            "C",
            742.10,
            max_total_debit_dollars=200,
            preferred_contracts=2,
            limit_price_offset=0.01,
            max_otm_steps=6,
            min_abs_delta=0.15,
            max_spread_pct=5,
        )

        self.assertNotEqual(selected["target_strike"], 746.0)
        self.assertGreaterEqual(abs(float(selected["delta"])), 0.15)

    def test_atm_hysteresis_prevents_half_strike_option_flapping(self) -> None:
        first = _select_otm_option(self.options, "P", 742.51, steps=2)
        self.assertEqual(first["atm_strike"], 743.0)
        self.assertEqual(first["target_strike"], 741.0)

        midpoint_tick = _select_otm_option(
            self.options, "P", 742.50, steps=2, preferred=first
        )
        self.assertEqual(midpoint_tick["atm_strike"], 743.0)
        self.assertEqual(midpoint_tick["target_strike"], 741.0)

        crossed_buffer = _select_otm_option(
            self.options, "P", 742.39, steps=2, preferred=midpoint_tick
        )
        self.assertEqual(crossed_buffer["atm_strike"], 742.0)
        self.assertEqual(crossed_buffer["target_strike"], 740.0)

    def test_next_listed_expiry_is_eligible_and_labeled_1dte(self) -> None:
        tomorrow = (datetime.now(ET) + timedelta(days=1)).strftime("%Y%m%d")
        options = {
            "expiry": tomorrow,
            "expiry_mode": "1DTE_NEXT_LISTED",
            "generated_at": et_timestamp(13, 0),
            "contracts": [
                {**liquid_contract(right, strike), "expiry": tomorrow}
                for strike in range(738, 748)
                for right in ("C", "P")
            ],
        }
        put = _select_otm_option(options, "P", 742.10, steps=2)
        self.assertTrue(put["eligible"])
        self.assertEqual(put["expiry"], tomorrow)
        self.assertEqual(put["expiry_mode"], "1DTE_NEXT_LISTED")
        rendered = render_signal({
            "state": "WAIT",
            "favoring": "puts",
            "spot": 742.10,
            "put_setup": {
                "status": "ready",
                "trigger": 741,
                "invalidation": 741.5,
                "targets": [740],
                "option": put,
            },
            "call_setup": {},
        }, details=True)
        self.assertIn("OTM-2 1DTE", rendered)

    def test_after_1pm_zero_dte_snapshot_is_rejected_as_safety_backstop(self) -> None:
        options = {
            **self.options,
            "expiry_mode": "0DTE",
            "generated_at": et_timestamp(13, 0),
        }
        put = _select_otm_option(options, "P", 742.10, steps=2)
        self.assertFalse(put["eligible"])
        self.assertIn(
            "0DTE contracts are prohibited for new setups at/after 1:00 PM ET",
            put["rejection_reasons"],
        )

    def test_exact_otm_contract_is_rejected_when_quote_missing(self) -> None:
        target = next(
            contract
            for contract in self.options["contracts"]
            if contract["right"] == "C" and contract["strike"] == 744
        )
        target.update(bid=None, ask=None, mid=None, spread_pct=None, liquidity="noquote")
        selected = _select_otm_option(self.options, "C", 742.10, steps=2)
        self.assertFalse(selected["eligible"])
        self.assertIn("live bid/ask quote is unavailable", selected["rejection_reasons"])

    def test_exact_otm_contract_is_rejected_when_quote_is_stale(self) -> None:
        target = next(
            contract
            for contract in self.options["contracts"]
            if contract["right"] == "C" and contract["strike"] == 744
        )
        target["quote_age_seconds"] = 16.0
        selected = _select_otm_option(self.options, "C", 742.10, steps=2)
        self.assertFalse(selected["eligible"])
        self.assertIn("option quote is 16.0s old", selected["rejection_reasons"])

    def test_option_spread_tolerance_uses_fifteen_percent_signal_quality_limit(self) -> None:
        target = next(
            contract
            for contract in self.options["contracts"]
            if contract["right"] == "C" and contract["strike"] == 744
        )
        target["spread_pct"] = 14.9
        self.assertTrue(_select_otm_option(self.options, "C", 742.10, steps=2)["eligible"])
        target["spread_pct"] = 15.1
        selected = _select_otm_option(self.options, "C", 742.10, steps=2)
        self.assertFalse(selected["eligible"])
        self.assertIn("spread 15.1% exceeds 15%", selected["rejection_reasons"])

    def test_rendered_signal_names_contract_and_premium_targets(self) -> None:
        call = _select_otm_option(self.options, "C", 742.10, steps=2)
        text = render_signal(
            {
                "state": "ARMED",
                "favoring": "calls",
                "spot": 742.10,
                "call_setup": {"trigger": 743, "invalidation": 742.5, "targets": [744], "option": call},
                "put_setup": {"trigger": 741, "invalidation": 741.5, "targets": [740], "option": None},
            },
            details=True,
        )
        self.assertIn("SPY", text)
        self.assertIn("744.0C", text)
        self.assertIn("signal only | PT 1.1/1.2", text)

    def test_colored_render_highlights_state_and_invalidation_without_polluting_plain_logs(self) -> None:
        call = _select_otm_option(self.options, "C", 742.10, steps=2)
        payload = {
            "state": "ACTIVE",
            "favoring": "calls",
            "spot": 742.10,
            "execution_enabled": False,
            "call_setup": {"status": "active_latched", "trigger": 743, "invalidation": 742.5, "targets": [744], "option": call},
            "put_setup": {"status": "ready", "trigger": 741, "invalidation": 741.5, "targets": [740], "option": None},
        }
        colored = render_signal(payload, color=True)
        plain = render_signal(payload)
        self.assertIn("\033[", colored)
        self.assertIn("invalid below", colored)
        self.assertNotIn("\033[", plain)

    def test_missing_market_data_renders_outage_without_fake_setups(self) -> None:
        text = render_signal(
            {
                "state": "WAIT",
                "favoring": "no-trade",
                "spot": None,
                "blockers": ["IBKR Gateway is disconnected"],
                "market_data_readiness": {"status": "BLOCKED"},
                "execution_enabled": False,
            }
        )
        self.assertIn(
            "NO TRADE | SPY unavailable | IBKR Gateway is disconnected",
            text,
        )
        self.assertIn("SPY unavailable", text)
        self.assertNotIn("CALL  [READY]", text)
        self.assertNotIn("PUT  [READY]", text)
        self.assertNotIn("None", text)

    def test_armed_blocked_shows_only_favored_side(self) -> None:
        call = _select_otm_option(self.options, "C", 742.10, steps=2)
        put = _select_otm_option(self.options, "P", 742.10, steps=2)
        put.update(eligible=False, rejection_reasons=["spread 40.0% exceeds 15%"])
        text = render_signal(
            {
                "state": "ARMED",
                "favoring": "puts",
                "spot": 742.10,
                "call_setup": {"status": "ready", "trigger": 743, "invalidation": 742.5, "targets": [744], "option": call},
                "put_setup": {"status": "ready", "trigger": 741, "invalidation": 741.5, "targets": [740], "option": put},
            }
        )
        self.assertIn("WAIT | SPY 742.1 | PUT setup armed", text)
        self.assertIn("PAPER TRIGGER: completed 1m close below 741", text)
        self.assertNotIn("option", text.lower())

    def test_wait_with_directional_bias_shows_only_favored_side(self) -> None:
        call = _select_otm_option(self.options, "C", 742.10, steps=2)
        put = _select_otm_option(self.options, "P", 742.10, steps=2)
        text = render_signal(
            {
                "state": "WAIT",
                "favoring": "calls",
                "spot": 742.10,
                "call_setup": {"status": "ready", "trigger": 743, "invalidation": 742.5, "targets": [744], "option": call},
                "put_setup": {"status": "ready", "trigger": 741, "invalidation": 741.5, "targets": [740], "option": put},
            }
        )
        self.assertIn("WAIT | SPY 742.1 | CALL setup not confirmed", text)
        self.assertNotIn("option", text.lower())

    def test_quick_read_resolves_manage_versus_stand_down_at_a_glance(self) -> None:
        text = render_signal(
            {
                "state": "MANAGE",
                "signal_phase": "TARGET_1_REACHED",
                "favoring": "puts",
                "spot": 737.26,
                "execution_enabled": False,
                "call_setup": {},
                "put_setup": {
                    "status": "manage_t1",
                    "trigger": 739.44,
                    "invalidation": 740.36,
                    "targets": [738.06, 737.14, 735.76],
                },
                "lifecycle": {
                    "status": "MANAGE",
                    "targets_hit": 1,
                    "entry_allowed": False,
                    "premium": {"return_pct": 78.7},
                },
                "market_context": {"rvol_1m": 0.61},
                "gex": {
                    "source": "zerogex",
                    "regime": "Negative",
                    "gamma_regime": "Trend",
                },
                "zerogex_decision": {
                    "gex_primary": True,
                    "entry_authority": False,
                    "playbook": {"state": "stand_down"},
                    "active_advanced": [
                        {
                            "name": "vol_expansion",
                            "direction": "bearish",
                            "side": "puts",
                            "directional": True,
                        },
                        {
                            "name": "range_break_imminence",
                            "direction": "bearish",
                            "side": "puts",
                            "directional": True,
                        },
                    ],
                },
                "blockers": [],
                "warnings": [],
            }
        )
        lines = text.splitlines()

        self.assertEqual(
            lines[0],
            "MANAGE | SPY 737.26 | PAPER PUT | T1 reached",
        )
        self.assertEqual(
            lines[1],
            "NEXT: T2 737.14 → T3 735.76 — CLOSE PAPER POSITION | "
            "invalid above 740.36",
        )
        self.assertEqual(
            lines[2],
            "CONTEXT: Negative/Trend GEX | CAUTION: weak volume (RVOL 0.61); "
            "ZeroGEX has no confirming setup",
        )
        self.assertNotIn("DETAILS (audit trail)", text)

    def test_quick_read_wait_names_confirmation_and_wrong_level(self) -> None:
        text = render_signal(
            {
                "state": "WAIT",
                "signal_phase": "WAIT",
                "favoring": "calls",
                "spot": 742.10,
                "call_setup": {
                    "status": "ready",
                    "trigger": 743.0,
                    "invalidation": 742.5,
                    "targets": [744.0],
                },
                "put_setup": {},
                "gex": {"regime": "Positive", "gamma_regime": "Range"},
                "blockers": [],
                "warnings": [],
            }
        )

        self.assertIn("WAIT | SPY 742.1 | CALL setup not confirmed", text)
        self.assertIn(
            "PAPER TRIGGER: completed 1m close above 743 | "
            "invalid below 742.5 | T1 744",
            text,
        )
        self.assertIn("CONTEXT: Positive/Range GEX", text)

    def test_quick_read_surfaces_target_pullback_bias_conflict_and_stale_gex(self) -> None:
        text = render_signal(
            {
                "state": "EXTENDED",
                "signal_phase": "TARGET_2_REACHED",
                "favoring": "puts",
                "spot": 737.39,
                "execution_enabled": False,
                "call_setup": {},
                "put_setup": {
                    "status": "extended_t2",
                    "trigger": 739.44,
                    "invalidation": 740.36,
                    "targets": [738.06, 737.14, 735.76],
                },
                "lifecycle": {
                    "status": "EXTENDED",
                    "targets_hit": 2,
                    "entry_allowed": False,
                    "premium": {"return_pct": 63.9},
                },
                "market_context": {"rvol_1m": 0.96},
                "gex": {
                    "source": "zerogex",
                    "regime": "Negative",
                    "gamma_regime": "Trend",
                },
                "zerogex_decision": {
                    "gex_primary": True,
                    "entry_authority": False,
                    "trade_bias": {
                        "fresh": True,
                        "direction": "long",
                        "side": "calls",
                        "score": 56.3,
                        "confidence": 46.2,
                    },
                    "playbook": {"state": "stand_down"},
                    "active_advanced": [
                        {
                            "name": "vol_expansion",
                            "direction": "bullish",
                            "side": "calls",
                            "directional": True,
                        },
                        {
                            "name": "range_break_imminence",
                            "direction": "bearish",
                            "side": "puts",
                            "directional": False,
                        },
                    ],
                },
                "blockers": ["GEX snapshot stale (>20s); new entries blocked"],
                "warnings": [],
            }
        )

        self.assertIn(
            "MANAGE | SPY 737.39 | PAPER PUT | T2 reached",
            text,
        )
        self.assertIn(
            "NEXT: T3 735.76 — CLOSE PAPER POSITION | invalid above 740.36",
            text,
        )
        self.assertIn("CONTEXT: Negative/Trend GEX", text)
        self.assertIn("weak volume (RVOL 0.96)", text)
        self.assertNotIn("DETAILS (audit trail)", text)

    def test_t2_policy_hides_t3_and_formats_contract_for_management(self) -> None:
        text = render_signal(
            {
                "state": "MANAGE",
                "signal_phase": "TARGET_1_REACHED",
                "favoring": "puts",
                "spot": 736.92,
                "paper_policy": {"exit_after_target": 2},
                "put_setup": {
                    "status": "manage_t1",
                    "trigger": 737.14,
                    "invalidation": 737.85,
                    "targets": [736.95, 736.61, 736.16],
                    "option": {
                        "local_symbol": "SPY   260727P00736000",
                        "right": "P",
                        "target_strike": 736.0,
                        "expiry": "20260727",
                    },
                },
                "call_setup": {},
                "lifecycle": {
                    "status": "MANAGE",
                    "targets_hit": 1,
                    "premium": {"return_pct": 16.9},
                },
                "blockers": [],
                "warnings": [],
            }
        )

        self.assertIn(
            "NEXT: T2 736.61 — CLOSE PAPER POSITION | invalid above 737.85",
            text,
        )
        self.assertNotIn("T3", text)
        self.assertIn(
            "PAPER OPTION: SPY 2026-07-27 736P | mark +16.9%",
            text,
        )
        self.assertNotIn("P00736000", text)

    def test_active_snapshot_is_not_repeated_as_a_new_entry(self) -> None:
        payload = {
            "state": "ACTIVE",
            "signal_phase": "TRIGGERED",
            "favoring": "puts",
            "spot": 737.14,
            "paper_policy": {"exit_after_target": 2},
            "put_setup": {
                "trigger": 737.14,
                "invalidation": 737.85,
                "targets": [736.95, 736.61, 736.16],
            },
            "call_setup": {},
            "lifecycle": {
                "status": "ACTIVE",
                "targets_hit": 0,
                "premium": {"hit_10_at": None, "hit_20_at": None},
            },
            "blockers": [],
            "warnings": [],
        }

        entry = render_signal(payload, entry_event=True)
        snapshot = render_signal(payload)
        self.assertIn("PAPER ENTRY | SPY 737.14 | PUT trigger confirmed", entry)
        self.assertIn("PAPER ACTIVE | SPY 737.14 | PUT plan in progress", snapshot)
        self.assertIn("T2 736.61 — CLOSE PAPER POSITION", entry)
        self.assertNotIn("T3", entry)

    def test_active_snapshot_hides_expired_entry_window_from_compact_risks(self) -> None:
        text = render_signal(
            {
                "state": "ACTIVE",
                "signal_phase": "TRIGGERED",
                "favoring": "puts",
                "spot": 736.32,
                "paper_policy": {"exit_after_target": 2},
                "put_setup": {
                    "trigger": 736.2,
                    "invalidation": 737.31,
                    "targets": [735.63, 735.0, 734.4],
                },
                "call_setup": {},
                "lifecycle": {
                    "status": "ACTIVE",
                    "entry_allowed": False,
                    "paper_position_open": True,
                },
                "gex": {
                    "regime": "Negative",
                    "gamma_regime": "Trend",
                },
                "warnings": [
                    "activation window expired or move extended; track signal only",
                ],
                "blockers": [],
            }
        )

        self.assertNotIn("paper-entry window expired", text)
        self.assertIn("PAPER TRACKING ONLY", text)
        self.assertIn("new-entry gate is closed", text)


class RelativeVolumeTest(unittest.TestCase):
    def test_historical_same_time_rvol_is_preferred_when_available(self) -> None:
        today = datetime.now(ET).replace(hour=10, minute=1, second=30, microsecond=0)
        bars = []
        for days_back in range(1, 4):
            prior = today - timedelta(days=days_back)
            for offset in range(-2, 3):
                stamp = prior.replace(hour=10, minute=0) + timedelta(minutes=offset)
                bars.append({
                    "time": stamp.timestamp(), "open": 100, "high": 100.1,
                    "low": 99.9, "close": 100, "volume": 100,
                })
        session_start = today.replace(hour=9, minute=35)
        for offset in range(26):
            stamp = session_start + timedelta(minutes=offset)
            bars.append({
                "time": stamp.timestamp(), "open": 100, "high": 100.1,
                "low": 99.9, "close": 100,
                "volume": 200 if stamp.minute == 0 and stamp.hour == 10 else 50,
            })

        with patch("signal_engine.time.time", return_value=today.timestamp()):
            indicators = calculate_indicators(bars)

        self.assertEqual(indicators["rvol_method"], "historical_same_time")
        self.assertEqual(indicators["rvol_reference_samples"], 15)
        self.assertEqual(indicators["rvol"], 2.0)
        self.assertIsNotNone(indicators["last_completed_5m_at"])
        self.assertIsNotNone(indicators["last_close_5m"])


class SessionCutoffTest(unittest.TestCase):
    def test_new_entry_cutoff_is_one_hour_before_regular_close(self) -> None:
        self.assertTrue(_new_entry_window_open(et_timestamp(14, 59, 59)))
        self.assertFalse(_new_entry_window_open(et_timestamp(15, 0, 0)))
        self.assertFalse(_new_entry_window_open(et_timestamp(16, 0, 0)))

    def test_mandatory_flatten_begins_forty_minutes_before_regular_close(self) -> None:
        self.assertFalse(_mandatory_flatten_due(et_timestamp(15, 19, 59)))
        self.assertTrue(_mandatory_flatten_due(et_timestamp(15, 20, 0)))
        self.assertTrue(_mandatory_flatten_due(et_timestamp(16, 0, 0)))

    def test_backend_policy_supports_early_close(self) -> None:
        policy = {
            "market_date": "2026-11-27",
            "is_trading_day": True,
            "open_minute_et": 9 * 60 + 30,
            "close_minute_et": 13 * 60,
            "entry_cutoff_minute_et": 12 * 60,
            "flatten_minute_et": 12 * 60 + 20,
            "source": "backend-market-calendar-v1",
        }
        before_cutoff = datetime(2026, 11, 27, 11, 59, 59, tzinfo=ET).timestamp()
        at_cutoff = datetime(2026, 11, 27, 12, 0, 0, tzinfo=ET).timestamp()
        at_flatten = datetime(2026, 11, 27, 12, 20, 0, tzinfo=ET).timestamp()
        self.assertTrue(_new_entry_window_open(before_cutoff, policy))
        self.assertFalse(_new_entry_window_open(at_cutoff, policy))
        self.assertFalse(_mandatory_flatten_due(at_cutoff, policy))
        self.assertTrue(_mandatory_flatten_due(at_flatten, policy))

    def test_stale_backend_policy_fails_closed(self) -> None:
        stale = {
            "market_date": "2026-11-26",
            "is_trading_day": True,
            "open_minute_et": 9 * 60 + 30,
            "close_minute_et": 13 * 60,
            "entry_cutoff_minute_et": 12 * 60,
            "flatten_minute_et": 12 * 60 + 20,
        }
        now = datetime(2026, 11, 27, 10, 0, 0, tzinfo=ET).timestamp()
        self.assertFalse(_new_entry_window_open(now, stale))


class StrategyQualityTest(unittest.TestCase):
    def test_plan_quality_uses_frozen_trigger_stop_and_configured_target(self) -> None:
        quality = _plan_quality(550, 548, [552, 555], "calls", 2)

        self.assertEqual(quality["reward_risk"], 2.5)
        self.assertTrue(quality["meets_minimum"])

    def test_plan_quality_rejects_subminimum_setup(self) -> None:
        quality = _plan_quality(550, 548, [551, 552], "calls", 2)

        self.assertEqual(quality["reward_risk"], 1.0)
        self.assertFalse(quality["meets_minimum"])

    def test_option_stop_risk_uses_delta_gamma_and_buffer(self) -> None:
        risk = _estimated_option_stop_risk({
            "planned_limit_price": 2,
            "planned_contracts": 2,
            "delta": 0.4,
            "gamma": 0.05,
        }, 1.5)

        self.assertEqual(risk["method"], "delta_gamma_plus_10pct_premium_buffer")
        self.assertEqual(risk["per_contract_dollars"], 85.63)
        self.assertEqual(risk["total_dollars"], 171.25)


class ContinuationStateTest(unittest.TestCase):
    def setUp(self) -> None:
        self.now = TEST_SESSION_NOW
        self.time_patcher = patch(
            "signal_engine.time.time",
            return_value=self.now,
        )
        self.time_patcher.start()
        self.addCleanup(self.time_patcher.stop)
        now = self.now
        minute = int(now // 60) * 60
        self.bars = []
        for index in range(30):
            close = 99.5 + index * 0.005
            self.bars.append({
                "time": minute - (30 - index) * 60,
                "open": close - 0.02,
                "high": close + 0.08,
                "low": close - 0.08,
                "close": close,
                "volume": 10_000,
            })
        for bar in self.bars[-7:-1]:
            bar.update(open=99.80, high=100.00, low=99.70, close=99.85)
        self.bars[-1].update(open=99.90, high=100.30, low=99.80, close=100.20, volume=20_000)
        self.market = {
            "generated_at": now,
            "symbols": {"SPY": {"spot": 100.20, "quote_age_seconds": 0.1, "bars": self.bars}},
        }
        self.indicators = {
            "SPY": {
                "vwap": 99.50,
                "atr_5m": 0.40,
                "rvol": 1.5,
                "ema9_5m": 100.0,
                "ema21_5m": 99.5,
                "ema9_15m": 100.0,
                "ema21_15m": 99.5,
                "ema9_60m": 100.0,
                "ema21_60m": 99.5,
                "completed_bar_age_seconds": 60,
            }
        }
        self.options = {
            "expiry": TEST_SESSION_EXPIRY,
            "contracts": [
                liquid_contract(
                    right,
                    strike,
                    expiry=TEST_SESSION_EXPIRY,
                )
                for strike in range(96, 106)
                for right in ("C", "P")
            ],
        }
        self.gex = {
            "fetched_at": now,
            "data": {
                "SPY": {
                    "gamma_regime": "Trend",
                    "regime": "Negative",
                    "rolling": "FLOOR_UP",
                    "call_wall": {"strike": 102.0, "stage": "Fresh"},
                    "put_wall": {"strike": 98.0, "stage": "Fresh"},
                },
                "VIX": {"gamma_regime": "Range"},
            },
        }

    def build(
        self,
        previous=None,
        spot=None,
        *,
        zerogex=None,
        zerogex_role="shadow",
        zerogex_features=None,
        paper_exit_target=2,
        **paper_policy,
    ):
        if spot is not None:
            self.market["symbols"]["SPY"]["spot"] = spot
            self.market["generated_at"] = time.time()
            self.gex["fetched_at"] = time.time()
        with patch("signal_engine._regular_session_open", return_value=True), patch(
            "signal_engine._new_entry_window_open", return_value=True
        ), patch("signal_engine._mandatory_flatten_due", return_value=False), patch(
            "signal_engine._mtf_reversal_candidate", return_value=None
        ):
            return build_signal(
                self.market,
                self.indicators,
                self.options,
                self.gex,
                previous_signal=previous,
                zerogex=zerogex,
                zerogex_role=zerogex_role,
                zerogex_features=zerogex_features,
                paper_exit_target=paper_exit_target,
                **paper_policy,
            )

    def test_continuation_uses_atr_risk(self) -> None:
        signal = self.build()
        self.assertEqual(signal["state"], "ACTIVE")
        self.assertEqual(signal["signal_phase"], "TRIGGERED")
        self.assertEqual(signal["strategy"], "CONTINUATION")
        self.assertEqual(signal["call_setup"]["risk_method"], "0.75x_5m_atr")
        self.assertEqual(signal["call_setup"]["risk_dollars"], 0.30)
        self.assertEqual(signal["call_setup"]["invalidation"], 99.70)
        self.assertGreaterEqual(signal["confidence_score"], 90)
        self.assertEqual(signal["continuation_quality"]["calls"]["grade"], "A+")
        self.assertIn("gex_trend_context", signal["continuation_quality"]["calls"]["components"])

    def test_shadow_entry_structure_does_not_change_signal_authority(self) -> None:
        baseline = self.build()
        unavailable = {
            "version": "entry-structure-v1",
            "available": False,
            "reason": "test_unavailable",
            "mode": "shadow",
            "ema_vwap": {"event": None, "timeframes": {}},
            "observation": "SHADOW: unavailable",
        }
        with patch(
            "signal_engine.calculate_entry_structure_context",
            return_value=unavailable,
        ):
            without_context = self.build()

        for field in (
            "state",
            "signal_phase",
            "favoring",
            "strategy",
            "confidence_score",
            "call_setup",
            "put_setup",
            "lifecycle",
            "blockers",
            "confirmations",
        ):
            self.assertEqual(without_context.get(field), baseline.get(field))
        self.assertEqual(
            baseline["decision_telemetry"]["entry_structure_context"]["mode"],
            "shadow",
        )

    def test_shadow_qqq_breadth_does_not_become_cross_market_gate(self) -> None:
        baseline = self.build()
        self.market["symbols"]["QQQ"] = {
            "spot": 500.0,
            "quote_age_seconds": 0.1,
            "bars": self.bars,
        }
        self.indicators["QQQ"] = {
            "ema9_5m": 499.0,
            "ema21_5m": 500.0,
            "ema9_15m": 498.0,
            "ema21_15m": 500.0,
            "completed_bar_age_seconds": 60,
        }

        shadow = self.build(cross_market_confirmation="shadow")
        required = self.build(cross_market_confirmation="required")

        for field in (
            "state",
            "signal_phase",
            "favoring",
            "strategy",
            "confidence_score",
            "call_setup",
            "put_setup",
            "lifecycle",
            "blockers",
            "confirmations",
        ):
            self.assertEqual(shadow.get(field), baseline.get(field))
        self.assertEqual(shadow["confirmation_mode"], "SPY_QQQ_SHADOW")
        self.assertEqual(
            shadow["entry_structure_context"]["cross_market"]["alignment"],
            "DIVERGENT",
        )
        self.assertNotEqual(required["state"], "ACTIVE")

        self.market["symbols"]["QQQ"]["quote_age_seconds"] = 30.0
        stale_shadow = self.build(cross_market_confirmation="shadow")
        self.assertEqual(stale_shadow["state"], baseline["state"])
        self.assertFalse(
            stale_shadow["entry_structure_context"]["cross_market"]["available"]
        )
        self.assertNotIn(
            "QQQ",
            " ".join(stale_shadow.get("blockers") or []),
        )

    def test_cross_market_confirmation_rejects_unknown_mode(self) -> None:
        with self.assertRaisesRegex(ValueError, "cross_market_confirmation"):
            self.build(cross_market_confirmation="live")

    def test_shadow_strategy_families_do_not_change_signal_authority(self) -> None:
        disabled = self.build(strategy_families={
            "enabled": False,
            "mode": "shadow",
        })
        enabled = self.build(strategy_families={
            "enabled": True,
            "mode": "shadow",
        })

        authority_fields = (
            "state",
            "signal_phase",
            "favoring",
            "strategy",
            "confidence_score",
            "call_setup",
            "put_setup",
            "lifecycle",
            "blockers",
            "confirmations",
        )
        for field in authority_fields:
            self.assertEqual(enabled.get(field), disabled.get(field))
        self.assertFalse(enabled["strategy_family_context"]["entry_authority"])
        self.assertEqual(
            enabled["decision_telemetry"]["strategy_family_context"]["mode"],
            "shadow",
        )
        self.assertEqual(
            enabled["strategy_family_context"]["shared_risk"]["trim_ladder_pct"],
            [25.0, 45.0, 75.0],
        )

    def test_zerogex_stand_down_does_not_block_confirmed_continuation(self) -> None:
        now = time.time()
        provider_time = datetime.fromtimestamp(
            now - 20, timezone.utc
        ).isoformat()
        zerogex = {
            "fetched_at": now - 2,
            "source": "zerogex",
            "symbol": "SPY",
            "gex_summary": {
                "timestamp": provider_time,
                "spot_price": 100.2,
                "gamma_flip": 99.0,
                "call_wall": 102.0,
                "put_wall": 98.0,
                "net_gex": -1_000_000,
            },
            "trade_bias": {
                "timestamp": provider_time,
                "direction": "long",
                "bias_score": 55,
                "confidence": 50,
            },
            "playbook": {
                "timestamp": provider_time,
                "state": "stand_down",
                "pattern": "stand_down",
                "direction": "non_directional",
                "confidence": 0.0,
                "near_misses": [],
            },
        }

        signal = self.build(
            zerogex=zerogex,
            zerogex_role="primary",
        )

        self.assertEqual(signal["state"], "ACTIVE")
        self.assertFalse(signal["execution_enabled"])
        self.assertIn(
            "ZeroGEX has no confirming playbook setup",
            signal["warnings"],
        )
        self.assertNotIn("ZeroGEX playbook is STAND_DOWN", signal["blockers"])

    def test_primary_opposing_playbook_blocks_confirmed_continuation(self) -> None:
        now = time.time()
        provider_time = datetime.fromtimestamp(
            now - 20, timezone.utc
        ).isoformat()
        zerogex = {
            "fetched_at": now - 2,
            "source": "zerogex",
            "symbol": "SPY",
            "gex_summary": {
                "timestamp": provider_time,
                "spot_price": 100.2,
                "gamma_flip": 99.0,
                "call_wall": 102.0,
                "put_wall": 98.0,
                "net_gex": -1_000_000,
            },
            "playbook": {
                "timestamp": provider_time,
                "state": "candidate",
                "pattern": "bearish_continuation",
                "direction": "bearish",
                "confidence": 0.75,
                "near_misses": [],
            },
        }

        signal = self.build(zerogex=zerogex, zerogex_role="primary")

        self.assertNotEqual(signal["state"], "ACTIVE")
        self.assertFalse((signal.get("lifecycle") or {}).get("entry_allowed", False))
        self.assertIn(
            "ZeroGEX playbook strongly opposes calls",
            signal["blockers"],
        )

    def test_zerogex_candidate_cannot_trigger_without_local_structure(self) -> None:
        now = time.time()
        provider_time = datetime.fromtimestamp(
            now - 20, timezone.utc
        ).isoformat()
        zerogex = {
            "fetched_at": now - 2,
            "source": "zerogex",
            "symbol": "SPY",
            "gex_summary": {
                "timestamp": provider_time,
                "spot_price": 99.0,
                "gamma_flip": 98.0,
                "call_wall": 102.0,
                "put_wall": 97.0,
                "net_gex": -1_000_000,
            },
            "playbook": {
                "timestamp": provider_time,
                "state": "candidate",
                "pattern": "squeeze_breakout",
                "direction": "bullish",
                "confidence": 0.8,
                "near_misses": [],
            },
        }
        self.bars[-1].update(
            open=99.80,
            high=99.90,
            low=99.70,
            close=99.85,
        )
        self.market["symbols"]["SPY"]["spot"] = 99.85

        signal = self.build(
            zerogex=zerogex,
            zerogex_role="primary",
        )

        self.assertNotEqual(signal["state"], "ACTIVE")
        self.assertFalse((signal.get("lifecycle") or {}).get("entry_allowed", False))

    def test_zerogex_flow_is_context_and_structure_can_supply_targets(self) -> None:
        now = time.time()
        provider_time = datetime.fromtimestamp(
            now - 20,
            timezone.utc,
        ).isoformat()
        zerogex = {
            "fetched_at": now - 2,
            "source": "zerogex",
            "symbol": "SPY",
            "gex_summary": {
                "timestamp": provider_time,
                "spot_price": 100.2,
                "gamma_flip": 99.0,
                "call_wall": 103.0,
                "put_wall": 98.0,
                "net_gex": -1_000_000,
            },
            "strike_context": {
                "status": "ok",
                "timestamp": provider_time,
                "flip": 99.0,
                "positive_nodes": [
                    {
                        "strike": 101.0,
                        "gex": 500_000,
                        "magnitude_ratio": 1.0,
                        "trend": "building",
                    }
                ],
                "negative_nodes": [],
                "wall_strength": {
                    "call": {
                        "strike": 103.0,
                        "gex": 400_000,
                        "strength_ratio": 0.8,
                        "trend": "building",
                        "migrated": True,
                        "previous_strike": 102.0,
                    }
                },
            },
            "flow_context": {
                "timestamp": provider_time,
                "direction": "calls",
                "strength": 0.60,
                "smart_money": {
                    "direction": "calls",
                    "strength": 0.50,
                    "heuristic": True,
                },
            },
        }
        signal = self.build(
            zerogex=zerogex,
            zerogex_role="primary",
            zerogex_features={
                "structure_context": True,
                "flow_context": True,
                "session_levels": False,
                "late_day_forced_flow": False,
            },
        )
        self.assertEqual(signal["state"], "ACTIVE")
        self.assertEqual(signal["gex"]["heatmap"]["status"], "ok")
        self.assertIn(101.0, signal["call_setup"]["targets"])
        self.assertIn(
            "ZeroGEX premium flow aligns calls (correlated context)",
            signal["confirmations"],
        )
        self.assertFalse(signal["zerogex_decision"]["entry_authority"])

    def test_disabled_zerogex_flow_feature_removes_flow_vote(self) -> None:
        now = time.time()
        provider_time = datetime.fromtimestamp(
            now - 20,
            timezone.utc,
        ).isoformat()
        zerogex = {
            "fetched_at": now - 2,
            "source": "zerogex",
            "symbol": "SPY",
            "gex_summary": {
                "timestamp": provider_time,
                "spot_price": 100.2,
                "gamma_flip": 99.0,
                "call_wall": 102.0,
                "put_wall": 98.0,
            },
            "flow_context": {
                "timestamp": provider_time,
                "direction": "calls",
                "strength": 0.9,
            },
        }
        signal = self.build(
            zerogex=zerogex,
            zerogex_role="primary",
            zerogex_features={
                "flow_context": False,
                "structure_context": False,
                "session_levels": False,
                "late_day_forced_flow": False,
            },
        )
        self.assertNotIn(
            "ZeroGEX premium flow aligns calls (correlated context)",
            signal["confirmations"],
        )
        self.assertEqual(
            signal["zerogex_shadow"]["data_freshness"]["flow_context"][
                "reason"
            ],
            "disabled_by_runtime_config",
        )

    def test_session_cutoff_hard_blocks_new_entry(self) -> None:
        with patch("signal_engine._regular_session_open", return_value=True), patch(
            "signal_engine._new_entry_window_open", return_value=False
        ), patch("signal_engine._mandatory_flatten_due", return_value=False), patch(
            "signal_engine._mtf_reversal_candidate", return_value=None
        ):
            blocked = build_signal(self.market, self.indicators, self.options, self.gex)
        self.assertEqual(blocked["state"], "WAIT")
        self.assertEqual(blocked["favoring"], "no-trade")
        self.assertTrue(any("3:00 PM ET" in item for item in blocked["blockers"]))

    def test_session_flatten_forces_open_position_to_time_exit(self) -> None:
        active = self.build()
        self.market["generated_at"] = time.time()
        self.gex["fetched_at"] = time.time()
        with patch("signal_engine._regular_session_open", return_value=True), patch(
            "signal_engine._new_entry_window_open", return_value=False
        ), patch("signal_engine._mandatory_flatten_due", return_value=True), patch(
            "signal_engine._mtf_reversal_candidate", return_value=None
        ):
            exited = build_signal(
                self.market,
                self.indicators,
                self.options,
                self.gex,
                previous_signal=active,
            )
        self.assertEqual(exited["state"], "FAILED")
        self.assertEqual(exited["favoring"], "no-trade")
        self.assertEqual(exited["lifecycle"]["close_reason"], "end_of_day_flatten")
        self.assertFalse(exited["lifecycle"]["entry_allowed"])
        self.assertEqual(exited["call_setup"]["status"], "time_exit")

    def test_local_gex_is_labeled_as_secondary_confirmation(self) -> None:
        self.gex["source"] = "ibkr-local-oi-model"
        self.gex["selected_source"] = "ibkr-local-oi-model"
        signal = self.build()
        self.assertEqual(signal["state"], "ACTIVE")
        self.assertTrue(any("inferred dealer signs" in warning for warning in signal["warnings"]))

    def test_extended_breakout_is_not_a_new_entry(self) -> None:
        self.bars[-1].update(high=100.55, close=100.50)
        signal = self.build(spot=100.50)
        self.assertEqual(signal["state"], "WAIT")
        self.assertEqual(signal["favoring"], "calls")
        self.assertTrue(any("extended beyond 0.75R" in blocker for blocker in signal["blockers"]))

    def test_active_continuation_latches_until_exit(self) -> None:
        first = self.build()
        self.bars[-1]["close"] = 99.90
        second = self.build(previous=first, spot=100.05)
        self.assertEqual(second["state"], "ACTIVE")
        self.assertEqual(second["call_setup"]["status"], "active_latched")
        self.assertEqual(second["call_setup"]["trigger"], first["call_setup"]["trigger"])
        self.assertEqual(
            second["call_setup"]["option"]["target_strike"],
            first["call_setup"]["option"]["target_strike"],
        )
        self.assertTrue(second["call_setup"]["option"]["locked_at_activation"])

    def test_first_target_transitions_to_manage_and_blocks_new_entry(self) -> None:
        first = self.build()
        managed = self.build(previous=first, spot=first["call_setup"]["targets"][0])
        self.assertEqual(managed["state"], "MANAGE")
        self.assertEqual(managed["signal_phase"], "TARGET_1_REACHED")
        self.assertEqual(managed["call_setup"]["status"], "manage_t1")
        self.assertEqual(managed["lifecycle"]["targets_hit"], 1)
        self.assertFalse(managed["lifecycle"]["entry_allowed"])
        rendered = render_signal(managed)
        self.assertIn("MANAGE", rendered)
        self.assertIn("PAPER OPTION:", rendered)

    def test_second_target_closes_paper_position_by_default(self) -> None:
        first = self.build()
        completed = self.build(previous=first, spot=first["call_setup"]["targets"][1])
        self.assertEqual(completed["state"], "WAIT")
        self.assertEqual(completed["signal_phase"], "COMPLETED")
        self.assertEqual(completed["call_setup"]["status"], "completed")
        self.assertEqual(completed["lifecycle"]["status"], "COMPLETED")
        self.assertEqual(completed["lifecycle"]["close_reason"], "planned_target_exit")
        self.assertEqual(completed["lifecycle"]["targets_hit"], 2)
        self.assertEqual(completed["lifecycle"]["exit_target_index"], 2)
        self.assertEqual(
            completed["lifecycle"]["exit_target_level"],
            first["call_setup"]["targets"][1],
        )
        self.assertFalse(completed["lifecycle"]["entry_allowed"])
        self.assertFalse(completed["lifecycle"]["paper_position_open"])
        rendered = render_signal(completed)
        self.assertIn("CLOSED", rendered)
        self.assertIn("PAPER CALL CLOSED at T2", rendered)
        self.assertIn("wait for cooldown and a fresh setup", rendered)

    def test_t3_policy_can_keep_a_runner_after_t2(self) -> None:
        first = self.build(paper_exit_target=3)
        extended = self.build(
            previous=first,
            spot=first["call_setup"]["targets"][1],
            paper_exit_target=3,
        )
        self.assertEqual(extended["state"], "EXTENDED")
        self.assertEqual(extended["call_setup"]["status"], "extended_t2")
        self.assertTrue(extended["lifecycle"]["paper_position_open"])

    def test_target_progress_does_not_revert_after_pullback(self) -> None:
        first = self.build()
        managed = self.build(previous=first, spot=first["call_setup"]["targets"][0])
        pulled_back = self.build(previous=managed, spot=100.05)
        self.assertEqual(pulled_back["state"], "MANAGE")
        self.assertEqual(pulled_back["lifecycle"]["targets_hit"], 1)

    def test_t1_moves_protection_to_trigger_and_closes_on_pullback(self) -> None:
        first = self.build()
        managed = self.build(
            previous=first,
            spot=first["call_setup"]["targets"][0],
        )
        self.assertEqual(
            managed["lifecycle"]["protected_invalidation"],
            first["call_setup"]["trigger"],
        )
        pending = self.build(
            previous=managed,
            spot=first["call_setup"]["trigger"] - 0.11,
        )
        self.assertEqual(pending["signal_phase"], "TARGET_1_REACHED")
        protected = self.build(
            previous=pending,
            spot=first["call_setup"]["trigger"] - 0.11,
        )
        self.assertEqual(protected["signal_phase"], "COMPLETED")
        self.assertEqual(
            protected["lifecycle"]["close_reason"],
            "t1_protected_stop",
        )
        self.assertFalse(protected["lifecycle"]["paper_position_open"])
        self.assertIn("T1 protected stop", render_signal(protected))

    def test_t1_premium_lock_closes_when_return_falls_to_floor(self) -> None:
        first = self.build()
        managed = self.build(
            previous=first,
            spot=first["call_setup"]["targets"][0],
        )
        entry = managed["lifecycle"]["premium"]["entry_reference"]
        strike = first["call_setup"]["option"]["target_strike"]
        contract = next(
            item
            for item in self.options["contracts"]
            if item["right"] == "C" and item["strike"] == strike
        )
        contract.update(bid=round(entry * 1.25, 3), ask=round(entry * 1.27, 3))
        lock_armed = self.build(previous=managed, spot=100.10)
        self.assertTrue(lock_armed["lifecycle"]["premium_lock_armed"])
        contract.update(bid=round(entry * 1.10, 3), ask=round(entry * 1.12, 3))
        protected = self.build(previous=lock_armed, spot=100.10)
        self.assertEqual(
            protected["lifecycle"]["close_reason"],
            "t1_premium_lock",
        )
        self.assertFalse(protected["lifecycle"]["paper_position_open"])
        self.assertIn("T1 premium profit lock", render_signal(protected))

    def test_active_tracking_gap_aborts_stale_lifecycle(self) -> None:
        first = self.build()
        first["lifecycle"]["last_trusted_tracking_at"] = time.time() - 31
        aborted = self.build(previous=first, spot=100.20)
        self.assertEqual(aborted["state"], "FAILED")
        self.assertEqual(aborted["signal_phase"], "TRACKING_ABORTED")
        self.assertEqual(
            aborted["lifecycle"]["close_reason"],
            "tracking_gap_abort",
        )
        self.assertFalse(aborted["lifecycle"]["paper_position_open"])
        self.assertIn("ABORTED", render_signal(aborted))

    def test_stale_market_data_pauses_without_dropping_open_lifecycle(self) -> None:
        first = self.build()
        trusted_at = first["lifecycle"]["last_trusted_tracking_at"]
        self.market["generated_at"] = time.time() - 10
        paused = self.build(previous=first)
        self.assertEqual(paused["state"], "ACTIVE")
        self.assertEqual(paused["signal_phase"], "TRACKING_PAUSED")
        self.assertTrue(paused["lifecycle"]["paper_position_open"])
        self.assertFalse(paused["lifecycle"]["entry_allowed"])
        self.assertTrue(paused["lifecycle"]["tracking_suspended"])
        self.assertEqual(
            paused["lifecycle"]["last_trusted_tracking_at"],
            trusted_at,
        )
        paused_again = self.build(previous=paused)
        self.assertEqual(
            paused_again["lifecycle"]["last_trusted_tracking_at"],
            trusted_at,
        )
        self.assertIn("PAUSED", render_signal(paused_again))

    def test_activation_contract_does_not_recenter_with_spot(self) -> None:
        first = self.build()
        first["call_setup"]["targets"] = [101.0, 102.0, 103.0]
        locked_strike = first["call_setup"]["option"]["target_strike"]
        continued = self.build(previous=first, spot=100.60)
        self.assertEqual(continued["state"], "ACTIVE")
        self.assertEqual(continued["call_setup"]["option"]["target_strike"], locked_strike)

    def test_armed_contract_is_frozen_before_activation(self) -> None:
        armed = self.build(
            option_max_total_debit_dollars=200,
            option_preferred_contracts=2,
            option_limit_price_offset=0.01,
            option_max_otm_steps=6,
            option_max_spread_pct=5,
        )
        armed["state"] = "ARMED"
        armed["signal_phase"] = "ARMED"
        armed["lifecycle"] = {}
        armed["call_setup"]["status"] = "armed_latched"
        armed["armed_until"] = time.time() + 60
        locked_strike = armed["call_setup"]["option"]["target_strike"]
        alternative = next(
            item
            for item in self.options["contracts"]
            if item["right"] == "C"
            and item["strike"] != locked_strike
            and item["strike"] > 100
        )
        alternative.update(
            bid=0.96,
            ask=0.98,
            mid=0.97,
            delta=0.40,
            spread_pct=1.0,
            volume=10_000,
        )

        activated = self.build(
            previous=armed,
            spot=100.20,
            option_max_total_debit_dollars=200,
            option_preferred_contracts=2,
            option_limit_price_offset=0.01,
            option_max_otm_steps=6,
            option_max_spread_pct=5,
        )

        self.assertEqual(activated["state"], "ACTIVE")
        self.assertEqual(
            activated["call_setup"]["option"]["target_strike"],
            locked_strike,
        )
        self.assertTrue(
            activated["call_setup"]["option"]["locked_at_activation"],
        )

    def test_active_continuation_fails_at_frozen_stop(self) -> None:
        first = self.build()
        pending = self.build(
            previous=first,
            spot=first["call_setup"]["invalidation"] - 0.11,
        )
        self.assertEqual(pending["state"], "ACTIVE")
        stopped = self.build(
            previous=pending,
            spot=first["call_setup"]["invalidation"] - 0.11,
        )
        self.assertEqual(stopped["state"], "FAILED")
        self.assertIn("invalidated", stopped["blockers"][-1])
        self.assertNotIn("reversal_cooldown_until", stopped)
        self.assertIn("continuation_cooldown_until", stopped)
        still_stopped = self.build(previous=stopped, spot=99.80)
        self.assertEqual(still_stopped["state"], "FAILED")
        self.assertEqual(still_stopped["lifecycle"]["closed_at"], stopped["lifecycle"]["closed_at"])

    def test_t3_policy_completes_at_final_target(self) -> None:
        first = self.build(paper_exit_target=3)
        final_target = first["call_setup"]["targets"][-1]
        completed = self.build(
            previous=first,
            spot=final_target,
            paper_exit_target=3,
        )
        self.assertEqual(completed["state"], "WAIT")
        self.assertIn("planned T3 paper exit reached", completed["confirmations"][0])
        self.assertEqual(completed["lifecycle"]["status"], "COMPLETED")
        still_completed = self.build(
            previous=completed,
            spot=final_target - 0.10,
            paper_exit_target=3,
        )
        self.assertEqual(still_completed["lifecycle"]["status"], "COMPLETED")
        self.assertEqual(still_completed["lifecycle"]["closed_at"], completed["lifecycle"]["closed_at"])

    def test_penalized_reversal_below_70_cannot_arm(self) -> None:
        self.indicators["SPY"]["rvol"] = 0.9
        self.gex["data"]["VIX"]["gamma_regime"] = "Whipsaw"
        candidate = {
            "strategy": "MTF_REVERSAL",
            "side": "calls",
            "score": 70,
            "base_score": 70,
            "quality": "MEDIUM",
            "timeframes": {"5m": "up", "15m": "up", "60m": "up"},
            "setup": "test aligned setup",
            "risk_plan": {
                "entry": 100.30,
                "stop": 99.70,
                "targets": [100.90, 101.30, 102.00],
                "method": "1.5x_5m_atr",
            },
        }
        with patch("signal_engine._regular_session_open", return_value=True), patch(
            "signal_engine._new_entry_window_open", return_value=True
        ), patch("signal_engine._mandatory_flatten_due", return_value=False), patch(
            "signal_engine._mtf_reversal_candidate", return_value=candidate
        ):
            signal = build_signal(self.market, self.indicators, self.options, self.gex)
        self.assertNotEqual(signal.get("strategy"), "MTF_REVERSAL")
        self.assertTrue(any("below 70" in warning for warning in signal["warnings"]))

    def test_gex_older_than_20_seconds_blocks_new_entry(self) -> None:
        self.gex["fetched_at"] = time.time() - 21
        signal = self.build()
        self.assertEqual(signal["state"], "WAIT")
        self.assertTrue(any("new entries blocked" in blocker for blocker in signal["blockers"]))

    def test_planned_target_exit_can_reenter_on_next_qualified_setup(self) -> None:
        first = self.build()
        completed = self.build(previous=first, spot=first["call_setup"]["targets"][-1])
        completed["lifecycle"]["closed_at"] = time.time() - 16
        resumed = self.build(previous=completed, spot=100.20)
        self.assertEqual(resumed["state"], "ACTIVE")
        self.assertFalse(any("cooldown/reset" in blocker for blocker in resumed["blockers"]))

    def test_continuation_can_reenter_after_cooldown_and_structural_reset(self) -> None:
        first = self.build()
        completed = self.build(previous=first, spot=first["call_setup"]["targets"][-1])
        completed["continuation_cooldown_until"] = time.time() - 1
        completed["continuation_reset_after_bar"] = -1
        completed["continuation_reset_observed"] = True
        completed["lifecycle"]["closed_at"] = time.time() - 16
        resumed = self.build(previous=completed, spot=100.20)
        self.assertEqual(resumed["state"], "ACTIVE")

    def test_invalidated_continuation_still_blocks_immediate_same_side_reentry(self) -> None:
        first = self.build()
        pending = self.build(
            previous=first,
            spot=first["call_setup"]["invalidation"] - 0.11,
        )
        stopped = self.build(
            previous=pending,
            spot=first["call_setup"]["invalidation"] - 0.11,
        )
        stopped["lifecycle"]["closed_at"] = time.time() - 16
        immediate = self.build(previous=stopped, spot=100.20)
        self.assertNotEqual(immediate["state"], "ACTIVE")
        self.assertTrue(any("cooldown/reset" in blocker for blocker in immediate["blockers"]))

    def test_same_side_cooldown_does_not_block_opposite_side_breakdown(self) -> None:
        first = self.build()
        completed = self.build(previous=first, spot=first["call_setup"]["targets"][-1])
        completed["lifecycle"]["closed_at"] = time.time() - 16
        self.bars[-1].update(open=99.80, high=99.85, low=99.55, close=99.60, volume=20_000)
        self.indicators["SPY"].update(
            vwap=100.0,
            ema9_5m=99.5,
            ema21_5m=100.0,
            ema9_15m=99.5,
            ema21_15m=100.0,
        )
        opposite = self.build(previous=completed, spot=99.60)
        self.assertEqual(opposite["state"], "ACTIVE")
        self.assertEqual(opposite["favoring"], "puts")
        self.assertFalse(any("cooldown/reset" in blocker for blocker in opposite["blockers"]))

    def test_continuation_requires_five_and_fifteen_minute_alignment(self) -> None:
        self.indicators["SPY"].update(ema9_15m=99.0, ema21_15m=100.0)
        blocked = self.build()
        self.assertNotEqual(blocked["state"], "ACTIVE")
        self.assertTrue(any("15m EMA structure" in item for item in blocked["blockers"]))
        self.indicators["SPY"].update(ema9_15m=100.0, ema21_15m=99.5)
        self.assertEqual(self.build()["state"], "ACTIVE")

    def test_unconfirmed_cross_retry_trigger_uses_only_completed_bars(self) -> None:
        self.indicators["SPY"].update(ema9_15m=99.0, ema21_15m=100.0)
        first = self.build(spot=100.50)
        second = self.build(previous=first, spot=100.80)

        self.assertEqual(first["call_setup"]["status"], "reset_after_unconfirmed_cross")
        self.assertEqual(second["call_setup"]["status"], "reset_after_unconfirmed_cross")
        self.assertEqual(first["call_setup"]["trigger"], 100.31)
        self.assertEqual(second["call_setup"]["trigger"], 100.31)

    def test_two_same_side_failures_require_fifteen_minute_reset(self) -> None:
        prior = {
            "same_side_failure_side": "calls",
            "same_side_failure_count": 2,
            "same_side_failure_last_at": time.time(),
            "same_side_15m_reset_required": True,
            "same_side_failure_reset_after_bar": 100,
        }
        self.indicators["SPY"].update(
            ema9_15m=99.0,
            ema21_15m=100.0,
            last_completed_15m_at=100,
        )
        blocked = self.build(previous=prior)
        self.assertNotEqual(blocked["state"], "ACTIVE")
        self.assertTrue(any("two call invalidations" in item for item in blocked["blockers"]))
        self.indicators["SPY"].update(ema9_15m=100.0, ema21_15m=99.5)
        same_bar = self.build(previous=prior)
        self.assertNotEqual(same_bar["state"], "ACTIVE")
        self.indicators["SPY"]["last_completed_15m_at"] = 200
        reset = self.build(previous=same_bar)
        self.assertEqual(reset["state"], "ACTIVE")
        self.assertNotIn("same_side_15m_reset_required", reset)

    def test_spent_wall_with_less_than_one_point_five_r_is_entry_blocker(self) -> None:
        self.gex["data"]["SPY"]["call_wall"] = {"strike": 100.25, "stage": "Spent"}
        blocked = self.build()
        self.assertEqual(blocked["state"], "WAIT")
        self.assertTrue(any("less than 1.5R" in item for item in blocked["blockers"]))

    def test_ineligible_confirmed_contract_is_watch_not_armed(self) -> None:
        for contract in self.options["contracts"]:
            if contract["right"] == "C":
                contract.update(spread_pct=40.0)
        watched = self.build()
        self.assertEqual(watched["state"], "WATCH")
        self.assertEqual(watched["favoring"], "calls")
        self.assertIn("rejected", watched["blockers"][0])

    def test_armed_hysteresis_ignores_small_quote_retreat(self) -> None:
        self.bars[-1].update(open=99.90, high=99.99, low=99.80, close=99.95)
        armed = self.build(spot=99.94)
        self.assertEqual(armed["state"], "ARMED")
        still_armed = self.build(previous=armed, spot=99.83)
        self.assertEqual(still_armed["state"], "ARMED")
        disarmed = self.build(previous=still_armed, spot=99.81)
        self.assertEqual(disarmed["state"], "WAIT")

    def test_mtf_trigger_requires_1m_alignment_at_medium_score(self) -> None:
        candidate = {
            "strategy": "MTF_REVERSAL", "side": "calls", "score": 75, "base_score": 75,
            "quality": "MEDIUM", "timeframes": {"5m": "up", "15m": "up", "60m": "up"},
            "setup": "test aligned setup",
            "risk_plan": {"entry": 100.20, "stop": 99.60, "targets": [100.80, 101.20, 101.80], "method": "1.5x_5m_atr"},
        }
        self.indicators["SPY"].update(ema9=99.9, ema21=100.0)
        with patch("signal_engine._regular_session_open", return_value=True), patch(
            "signal_engine._new_entry_window_open", return_value=True
        ), patch("signal_engine._mandatory_flatten_due", return_value=False), patch(
            "signal_engine._mtf_reversal_candidate", return_value=candidate
        ):
            signal = build_signal(self.market, self.indicators, self.options, self.gex)
        self.assertEqual(signal["state"], "ARMED")
        self.assertTrue(any("EMA confirmation" in warning for warning in signal["warnings"]))

    def test_local_gex_cannot_bypass_mtf_one_minute_confirmation(self) -> None:
        candidate = {
            "strategy": "MTF_REVERSAL", "side": "calls", "score": 85, "base_score": 85,
            "quality": "HIGH", "timeframes": {"5m": "up", "15m": "up", "60m": "up"},
            "setup": "test high-quality setup",
            "risk_plan": {"entry": 100.20, "stop": 99.60, "targets": [100.80, 101.20, 101.80], "method": "1.5x_5m_atr"},
        }
        self.gex["source"] = "ibkr-local-oi-model"
        self.gex["selected_source"] = "ibkr-local-oi-model"
        self.indicators["SPY"].update(ema9=99.9, ema21=100.0)
        with patch("signal_engine._regular_session_open", return_value=True), patch(
            "signal_engine._new_entry_window_open", return_value=True
        ), patch("signal_engine._mandatory_flatten_due", return_value=False), patch(
            "signal_engine._mtf_reversal_candidate", return_value=candidate
        ):
            signal = build_signal(self.market, self.indicators, self.options, self.gex)
        self.assertEqual(signal["state"], "ARMED")
        self.assertTrue(any("EMA confirmation" in warning for warning in signal["warnings"]))

    def test_primary_gex_high_score_cannot_bypass_one_minute_confirmation(self) -> None:
        candidate = {
            "strategy": "GEX_REJECTION", "side": "calls", "score": 90, "base_score": 90,
            "quality": "HIGH", "a_plus": True,
            "timeframes": {"5m": "up", "15m": "up", "60m": "up"},
            "setup": "test A+ setup",
            "risk_plan": {"entry": 100.20, "stop": 99.60, "targets": [100.80, 101.20, 101.80], "method": "structure"},
        }
        self.indicators["SPY"].update(ema9=99.9, ema21=100.0)
        with patch("signal_engine._regular_session_open", return_value=True), patch(
            "signal_engine._new_entry_window_open", return_value=True
        ), patch("signal_engine._mandatory_flatten_due", return_value=False), patch(
            "signal_engine._mtf_reversal_candidate", return_value=candidate
        ):
            signal = build_signal(self.market, self.indicators, self.options, self.gex)
        self.assertEqual(signal["state"], "ARMED")
        self.assertEqual(signal["signal_phase"], "ARMED")
        self.assertTrue(any("EMA confirmation" in warning for warning in signal["warnings"]))

    def test_active_mtf_position_never_reverts_to_armed(self) -> None:
        candidate = {
            "strategy": "MTF_REVERSAL", "side": "calls", "score": 75, "base_score": 75,
            "quality": "MEDIUM", "timeframes": {"5m": "up", "15m": "up", "60m": "up"},
            "setup": "test aligned setup",
            "risk_plan": {"entry": 100.20, "stop": 99.60, "targets": [100.80, 101.20, 101.80], "method": "1.5x_5m_atr"},
        }
        self.indicators["SPY"].update(ema9=100.1, ema21=100.0)
        with patch("signal_engine._regular_session_open", return_value=True), patch(
            "signal_engine._new_entry_window_open", return_value=True
        ), patch("signal_engine._mandatory_flatten_due", return_value=False), patch(
            "signal_engine._mtf_reversal_candidate", return_value=candidate
        ):
            active = build_signal(self.market, self.indicators, self.options, self.gex)
        self.assertEqual(active["state"], "ACTIVE")
        self.assertEqual(active["call_setup"]["risk_dollars"], 0.60)
        held = self.build(previous=active, spot=100.10)
        self.assertEqual(held["state"], "ACTIVE")
        self.assertEqual(held["strategy"], "MTF_REVERSAL")

    def test_locked_option_tracks_paper_premium_milestones(self) -> None:
        first = self.build()
        strike = first["call_setup"]["option"]["target_strike"]
        contract = next(
            contract for contract in self.options["contracts"]
            if contract["right"] == "C" and contract["strike"] == strike
        )
        contract.update(bid=1.23, ask=1.24, mid=1.235, spread_pct=0.8)
        managed = self.build(previous=first, spot=100.30)
        premium = managed["lifecycle"]["premium"]
        self.assertIsNotNone(premium["hit_10_at"])
        self.assertIsNotNone(premium["hit_20_at"])
        self.assertEqual(premium["max_bid"], 1.23)


class MarketDataReadinessTest(unittest.TestCase):
    def test_reports_precise_ibkr_outage_codes(self) -> None:
        now = TEST_SESSION_NOW
        readiness = market_data_readiness(
            {
                "generated_at": now,
                "transport": {"connected": False},
                "symbols": {"SPY": {"spot": None, "quote_age_seconds": None, "bars": []}},
            },
            {"SPY": {}},
            now=now,
            stale_after=5,
        )
        self.assertEqual(readiness["status"], "BLOCKED")
        self.assertIn("IBKR_GATEWAY_DISCONNECTED", readiness["codes"])
        self.assertIn("SPY_QUOTE_MISSING", readiness["codes"])
        self.assertIn("SPY_BARS_MISSING", readiness["codes"])
        self.assertEqual(readiness["summary"], "IBKR Gateway is disconnected")

    def test_keeps_warming_up_bars_distinct_from_an_ibkr_outage(self) -> None:
        now = TEST_SESSION_NOW
        bars = [
            {
                "time": now - (index + 1) * 60,
                "open": 600.0,
                "high": 600.2,
                "low": 599.8,
                "close": 600.1,
                "volume": 1_000,
            }
            for index in range(6)
        ]
        readiness = market_data_readiness(
            {
                "generated_at": now,
                "transport": {"connected": True},
                "symbols": {"SPY": {"spot": 600.1, "quote_age_seconds": 1, "bars": bars}},
            },
            {"SPY": {"vwap": 600.0, "completed_bar_age_seconds": 60}},
            now=now,
            stale_after=5,
        )
        self.assertEqual(readiness["status"], "DEGRADED")
        self.assertTrue(readiness["entry_ready"])
        self.assertEqual(readiness["codes"], ["SPY_BARS_INSUFFICIENT"])


if __name__ == "__main__":
    unittest.main()
