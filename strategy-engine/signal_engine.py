#!/usr/bin/env python3
"""Deterministic, execution-free SPY signal calculations.

This module consumes normalized IBKR market/options snapshots plus the existing
GEX prefetch file.  It never connects to a broker and never places orders.
"""

from __future__ import annotations

import copy
import math
import statistics
import time
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
ENGINE_VERSION = "signal-only-v2"
MAX_GEX_ENTRY_AGE_SECONDS = 20
MAX_ZEROGEX_FETCH_AGE_SECONDS = 30
MAX_ZEROGEX_DATA_AGE_SECONDS = 120
MAX_ZEROGEX_EXTENDED_AGE_SECONDS = 180
ZEROGEX_MINUTE_BUCKET_GRACE_SECONDS = 60
MAX_OPTION_SPREAD_PCT = 15.0
MIN_PLAN_REWARD_RISK = 1.5
MIN_CONTINUATION_CONFIDENCE = 70
FROZEN_SETUP_STRATEGIES = {"MTF_REVERSAL", "MTF_TREND_BREAK", "GEX_REJECTION"}
CONTINUATION_OPEN_STATES = {"ACTIVE", "MANAGE", "EXTENDED"}
WATCH_STATES = {"WATCH", "ARMED"}
ARM_ENTER_DISTANCE = 0.08
ARM_EXIT_DISTANCE = 0.18
ARM_LIFETIME_SECONDS = 5 * 60
CONTINUATION_COOLDOWN_SECONDS = 15 * 60
MAX_ACTIVE_TRACKING_GAP_SECONDS = 30
SAME_SIDE_FAILURE_LIMIT = 2
SAME_SIDE_FAILURE_WINDOW_SECONDS = 60 * 60
TERMINAL_SIGNAL_LATCH_SECONDS = 15
AUTONOMOUS_ENTRY_CUTOFF_MINUTES_BEFORE_CLOSE = 60
MANDATORY_FLATTEN_MINUTES_BEFORE_CLOSE = 40
REGULAR_CLOSE_MINUTE_ET = 16 * 60
REGULAR_OPEN_MINUTE_ET = 9 * 60 + 30
DEFAULT_TRENDLINE_STRUCTURE_CONFIG = {
    "enabled": True,
    "mode": "shadow",
    "length": 14,
    "slope_method": "ATR",
    "slope_multiplier": 1.0,
    "retest_window_bars": 5,
}


def _session_policy(
    now: float | None = None,
    policy: dict[str, Any] | None = None,
) -> dict[str, Any]:
    stamp = datetime.fromtimestamp(time.time() if now is None else now, ET)
    date_key = stamp.strftime("%Y-%m-%d")
    default_close = REGULAR_CLOSE_MINUTE_ET
    fallback = {
        "market_date": date_key,
        "is_trading_day": stamp.weekday() < 5,
        "open_minute_et": REGULAR_OPEN_MINUTE_ET,
        "close_minute_et": default_close,
        "entry_cutoff_minute_et": (
            default_close - AUTONOMOUS_ENTRY_CUTOFF_MINUTES_BEFORE_CLOSE
        ),
        "flatten_minute_et": (
            default_close - MANDATORY_FLATTEN_MINUTES_BEFORE_CLOSE
        ),
        "source": "signal-engine-default",
        "valid": policy is None,
        "reason": None if policy is None else "session policy is stale or invalid",
    }
    if not isinstance(policy, dict):
        return fallback
    if policy.get("valid") is False:
        return fallback
    try:
        open_minute = int(policy.get("open_minute_et"))
        close_minute = int(policy.get("close_minute_et"))
        entry_cutoff = int(policy.get("entry_cutoff_minute_et"))
        flatten_minute = int(policy.get("flatten_minute_et"))
    except (TypeError, ValueError):
        return fallback
    valid = bool(
        policy.get("market_date") == date_key
        and isinstance(policy.get("is_trading_day"), bool)
        and 0 <= open_minute < entry_cutoff <= flatten_minute < close_minute <= 24 * 60
    )
    if not valid:
        return fallback
    return {
        "market_date": date_key,
        "is_trading_day": policy["is_trading_day"],
        "open_minute_et": open_minute,
        "close_minute_et": close_minute,
        "entry_cutoff_minute_et": entry_cutoff,
        "flatten_minute_et": flatten_minute,
        "source": str(policy.get("source") or "backend-market-calendar"),
        "valid": True,
        "reason": None,
    }


def _format_et_minute(minutes: int) -> str:
    hour = minutes // 60
    suffix = "PM" if hour >= 12 else "AM"
    display_hour = hour % 12 or 12
    return f"{display_hour}:{minutes % 60:02d} {suffix} ET"


def _regular_session_open(
    now: float | None = None,
    session_policy: dict[str, Any] | None = None,
) -> bool:
    stamp = datetime.fromtimestamp(time.time() if now is None else now, ET)
    minutes = stamp.hour * 60 + stamp.minute
    session = _session_policy(now, session_policy)
    return bool(
        session["valid"]
        and session["is_trading_day"]
        and session["open_minute_et"] <= minutes < session["close_minute_et"]
    )


def _new_entry_window_open(
    now: float | None = None,
    session_policy: dict[str, Any] | None = None,
) -> bool:
    stamp = datetime.fromtimestamp(time.time() if now is None else now, ET)
    minutes = stamp.hour * 60 + stamp.minute
    session = _session_policy(now, session_policy)
    return bool(
        session["valid"]
        and session["is_trading_day"]
        and session["open_minute_et"] <= minutes < session["entry_cutoff_minute_et"]
    )


def _mandatory_flatten_due(
    now: float | None = None,
    session_policy: dict[str, Any] | None = None,
) -> bool:
    stamp = datetime.fromtimestamp(time.time() if now is None else now, ET)
    minutes = stamp.hour * 60 + stamp.minute
    session = _session_policy(now, session_policy)
    return bool(
        session["valid"]
        and session["is_trading_day"]
        and minutes >= session["flatten_minute_et"]
    )


def _number(value: Any) -> bool:
    return (
        not isinstance(value, bool)
        and isinstance(value, (int, float))
        and math.isfinite(value)
    )


def _journal_fields(payload: Any, fields: tuple[str, ...]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    return {
        key: copy.deepcopy(payload[key])
        for key in fields
        if key in payload
    }


def _compact_zerogex_playbook(payload: Any) -> dict[str, Any]:
    compact = _journal_fields(
        payload,
        (
            "fresh",
            "state",
            "pattern",
            "direction",
            "side",
            "confidence",
            "rationale",
        ),
    )
    near_misses = payload.get("near_misses") if isinstance(payload, dict) else None
    if isinstance(near_misses, list):
        compact["near_miss_count"] = len(near_misses)
        if near_misses and isinstance(near_misses[0], dict):
            compact["closest_near_miss"] = _journal_fields(
                near_misses[0],
                ("pattern", "direction", "side", "confidence", "missing"),
            )
    return compact


def _compact_zerogex_context(
    payload: Any,
    *,
    normalized: bool,
) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    compact = _journal_fields(
        payload,
        (
            "source",
            "symbol",
            "available",
            "fresh",
            "provider_age_seconds",
            "provider_raw_age_seconds",
            "provider_timestamp_precision_grace_seconds",
            "fetched_age_seconds",
            "gex_primary",
            "entry_authority",
            "mode",
            "endpoint_errors",
        ),
    )
    trade_bias_fields = (
        "fresh",
        "code",
        "label",
        "direction",
        "side",
        "score",
        "confidence",
        "setup",
        "style",
        "market_state",
        "directional_confirmation",
        "conviction_driven",
    ) if normalized else (
        "direction",
        "bias",
        "bias_score",
        "confidence",
        "setup",
        "state",
        "market_state",
        "conviction_driven",
        "timestamp",
    )
    compact["trade_bias"] = _journal_fields(
        payload.get("trade_bias"),
        trade_bias_fields,
    )
    compact["playbook"] = _compact_zerogex_playbook(payload.get("playbook"))
    compact["composite"] = _journal_fields(
        payload.get("composite"),
        ("fresh", "score", "posture", "timestamp"),
    )
    if normalized:
        compact["gates"] = copy.deepcopy(payload.get("gates") or {})
        compact["positioning_trap"] = _journal_fields(
            payload.get("positioning_trap"),
            ("fresh", "strong", "direction", "score", "style"),
        )
        compact["active_advanced"] = [
            _journal_fields(
                item,
                (
                    "name",
                    "fresh",
                    "side",
                    "direction",
                    "directional",
                    "score",
                    "confidence",
                    "label",
                ),
            )
            for item in payload.get("active_advanced") or []
            if isinstance(item, dict)
        ]
    else:
        compact["gex_summary"] = _journal_fields(
            payload.get("gex_summary"),
            (
                "fresh",
                "net_gex",
                "gamma_flip",
                "put_wall",
                "call_wall",
                "regime",
                "timestamp",
            ),
        )
        freshness = payload.get("data_freshness") or {}
        compact["data_freshness"] = {
            key: _journal_fields(
                value,
                (
                    "fresh",
                    "age_seconds",
                    "raw_age_seconds",
                    "precision_grace_seconds",
                    "timestamp",
                    "error",
                ),
            )
            for key, value in freshness.items()
            if isinstance(value, dict)
        }
    return compact


def _compact_trendline_context(payload: Any) -> dict[str, Any]:
    compact = _journal_fields(
        payload,
        (
            "version",
            "available",
            "reason",
            "enabled",
            "mode",
            "length",
            "slope_method",
            "slope_multiplier",
            "retest_window_bars",
            "upper_line",
            "lower_line",
            "upper_slope",
            "lower_slope",
            "pivot_high",
            "pivot_low",
            "upper_age_bars",
            "lower_age_bars",
            "upper_touch_count",
            "lower_touch_count",
            "break",
            "retest",
            "observation",
        ),
    )
    return compact


def _compact_entry_structure_context(payload: Any) -> dict[str, Any]:
    return _journal_fields(
        payload,
        (
            "version",
            "available",
            "reason",
            "mode",
            "ema_vwap",
            "gex_range",
            "observation",
        ),
    )


def compact_signal_for_journal(signal: dict[str, Any]) -> dict[str, Any]:
    """Keep replay fields while removing repeated ZeroGEX endpoint payloads."""
    compact = {
        key: copy.deepcopy(value)
        for key, value in signal.items()
        if key not in {
            "entry_structure_context",
            "trendline_context",
            "zerogex_shadow",
            "zerogex_decision",
        }
    }
    if "entry_structure_context" in signal:
        compact["entry_structure_context"] = _compact_entry_structure_context(
            signal.get("entry_structure_context")
        )
    if "trendline_context" in signal:
        compact["trendline_context"] = _compact_trendline_context(
            signal.get("trendline_context")
        )
    if "zerogex_shadow" in signal:
        compact["zerogex_shadow"] = _compact_zerogex_context(
            signal.get("zerogex_shadow"),
            normalized=False,
        )
    if "zerogex_decision" in signal:
        compact["zerogex_decision"] = _compact_zerogex_context(
            signal.get("zerogex_decision"),
            normalized=True,
        )
    return compact


def _ema(values: list[float], period: int) -> float | None:
    if not values:
        return None
    alpha = 2 / (period + 1)
    result = values[0]
    for value in values[1:]:
        result = value * alpha + result * (1 - alpha)
    return round(result, 4)


def _session_bars(
    bars: list[dict[str, Any]],
    *,
    now: float | None = None,
) -> list[dict[str, Any]]:
    current = time.time() if now is None else now
    today = datetime.fromtimestamp(current, ET).date()
    result = []
    for bar in bars:
        try:
            stamp = datetime.fromtimestamp(float(bar["time"]), ET)
        except (KeyError, TypeError, ValueError, OSError):
            continue
        if stamp.date() == today:
            result.append(bar)
    return result


def _completed_bars(bars: list[dict[str, Any]]) -> list[dict[str, Any]]:
    minute_start = int(time.time() // 60) * 60
    return [bar for bar in bars if float(bar.get("time", 0)) < minute_start]


def _aggregate_bars(bars: list[dict[str, Any]], minutes: int) -> list[dict[str, Any]]:
    groups: dict[int, list[dict[str, Any]]] = {}
    seconds = minutes * 60
    for bar in bars:
        bucket = int(float(bar["time"]) // seconds) * seconds
        groups.setdefault(bucket, []).append(bar)
    output = []
    for stamp, items in sorted(groups.items()):
        output.append(
            {
                "time": stamp,
                "open": items[0]["open"],
                "high": max(item["high"] for item in items),
                "low": min(item["low"] for item in items),
                "close": items[-1]["close"],
                "volume": sum(item.get("volume", 0) or 0 for item in items),
            }
        )
    current_bucket = int(time.time() // seconds) * seconds
    return [bar for bar in output if bar["time"] < current_bucket]


def _aggregate_5m(bars: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return _aggregate_bars(bars, 5)


def _normalized_completed_structure_bars(
    completed_bars: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    normalized: dict[float, dict[str, Any]] = {}
    for bar in completed_bars:
        if not isinstance(bar, dict) or bar.get("complete") is False:
            continue
        if not all(
            _number(bar.get(field))
            for field in ("time", "open", "high", "low", "close")
        ):
            continue
        stamp = float(bar["time"])
        normalized[stamp] = {
            "time": stamp,
            "open": float(bar["open"]),
            "high": float(bar["high"]),
            "low": float(bar["low"]),
            "close": float(bar["close"]),
            "volume": max(0.0, float(bar.get("volume", 0) or 0)),
        }
    return [normalized[stamp] for stamp in sorted(normalized)]


def _completed_vwap(
    bars: list[dict[str, Any]],
    cutoff: float,
) -> float | None:
    eligible = [bar for bar in bars if float(bar["time"]) < cutoff]
    volume = sum(float(bar["volume"]) for bar in eligible)
    if volume <= 0:
        return None
    weighted = sum(
        (
            float(bar["open"])
            + float(bar["high"])
            + float(bar["low"])
            + float(bar["close"])
        )
        / 4
        * float(bar["volume"])
        for bar in eligible
    )
    return round(weighted / volume, 4)


def _ema_vwap_rejection_event(
    source_bars: list[dict[str, Any]],
    timeframe_minutes: int,
) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    aggregated = _aggregate_bars(source_bars, timeframe_minutes)
    timeframe = f"{timeframe_minutes}m"
    if len(aggregated) < 9:
        return None, {
            "available": False,
            "reason": "insufficient_completed_bars",
            "completed_bars": len(aggregated),
        }

    closes = [float(bar["close"]) for bar in aggregated]
    latest = aggregated[-1]
    ema9 = _ema(closes, 9)
    cutoff = float(latest["time"]) + timeframe_minutes * 60
    vwap = _completed_vwap(source_bars, cutoff)
    if not (_number(ema9) and _number(vwap)):
        return None, {
            "available": False,
            "reason": "missing_ema_or_vwap",
            "completed_bars": len(aggregated),
        }

    close = float(latest["close"])
    low = float(latest["low"])
    high = float(latest["high"])
    bullish_lines = [
        name
        for name, value in (("ema9", float(ema9)), ("vwap", float(vwap)))
        if low <= value and close > value
    ]
    bearish_lines = [
        name
        for name, value in (("ema9", float(ema9)), ("vwap", float(vwap)))
        if high >= value and close < value
    ]
    conflicted = bool(bullish_lines and bearish_lines)
    side = (
        "bullish"
        if bullish_lines and not bearish_lines
        else "bearish"
        if bearish_lines and not bullish_lines
        else None
    )
    lines = bullish_lines if side == "bullish" else bearish_lines
    line = "+".join(lines) if lines else None

    touch_count = 0
    if side and line:
        for index in range(max(8, len(aggregated) - 6), len(aggregated)):
            candidate = aggregated[index]
            candidate_ema = _ema(
                [float(bar["close"]) for bar in aggregated[: index + 1]],
                9,
            )
            candidate_cutoff = (
                float(candidate["time"]) + timeframe_minutes * 60
            )
            candidate_vwap = _completed_vwap(source_bars, candidate_cutoff)
            if not (_number(candidate_ema) and _number(candidate_vwap)):
                continue
            values = {
                "ema9": float(candidate_ema),
                "vwap": float(candidate_vwap),
            }
            candidate_close = float(candidate["close"])
            held = all(
                (
                    float(candidate["low"]) <= values[name]
                    and candidate_close > values[name]
                )
                if side == "bullish"
                else (
                    float(candidate["high"]) >= values[name]
                    and candidate_close < values[name]
                )
                for name in lines
            )
            touch_count += int(held)

    fifteen = _aggregate_bars(source_bars, 15)
    fifteen_closes = [float(bar["close"]) for bar in fifteen]
    fifteen_ema9 = _ema(fifteen_closes, 9)
    higher_timeframe_bias = "unavailable"
    if _number(fifteen_ema9) and len(fifteen_closes) >= 2:
        if all(value > float(fifteen_ema9) for value in fifteen_closes[-2:]):
            higher_timeframe_bias = "bullish"
        elif all(value < float(fifteen_ema9) for value in fifteen_closes[-2:]):
            higher_timeframe_bias = "bearish"
        else:
            higher_timeframe_bias = "mixed"

    status = {
        "available": True,
        "completed_bars": len(aggregated),
        "ema9": ema9,
        "vwap": vwap,
        "last_completed_at": latest["time"],
        "relationship": (
            "established_hold" if touch_count >= 2 else "first_confirmed_touch"
            if side else "no_rejection"
        ),
        "touch_count": touch_count,
        "higher_timeframe_bias": higher_timeframe_bias,
        "conflicted_rejection": conflicted,
    }
    if not side or not line:
        return None, status
    event = {
        "side": side,
        "timeframe": timeframe,
        "line": line,
        "bar_time": latest["time"],
        "close": close,
        "ema9": ema9,
        "vwap": vwap,
        "completed_close_confirmed": True,
        "relationship": status["relationship"],
        "touch_count": touch_count,
        "higher_timeframe_bias": higher_timeframe_bias,
        "event_id": (
            f"ema-vwap:{timeframe}:{side}:{line}:{int(float(latest['time']))}"
        ),
    }
    return event, status


def calculate_entry_structure_context(
    completed_bars: list[dict[str, Any]],
) -> dict[str, Any]:
    """Calculate replayable entry timing evidence without signal authority."""
    bars = _normalized_completed_structure_bars(completed_bars)
    events = []
    timeframes = {}
    for minutes in (3, 5):
        event, status = _ema_vwap_rejection_event(bars, minutes)
        timeframes[f"{minutes}m"] = status
        if event:
            events.append(event)
    available = any(status.get("available") for status in timeframes.values())
    event = max(
        events,
        key=lambda item: (
            float(item["bar_time"]),
            1 if item["timeframe"] == "5m" else 0,
        ),
        default=None,
    )
    if event:
        observation = (
            "SHADOW: "
            f"{event['side']} {event['line'].replace('+', ' and ')} "
            f"rejection confirmed on completed {event['timeframe']} candle"
        )
    elif available:
        observation = "SHADOW: no completed EMA9/VWAP rejection is active"
    else:
        observation = "SHADOW: EMA9/VWAP rejection data is unavailable"
    return {
        "version": "entry-structure-v1",
        "available": available,
        "reason": None if available else "insufficient_completed_bars",
        "mode": "shadow",
        "ema_vwap": {
            "event": event,
            "timeframes": timeframes,
        },
        "observation": observation,
    }


def calculate_gex_range_context(
    spot: Any,
    *,
    atr_5m: Any,
    gex_context: dict[str, Any] | None,
) -> dict[str, Any]:
    """Classify GEX range location as shadow context, never as an entry gate."""
    context = gex_context or {}

    def active_wall(kind: str) -> float | None:
        wall = context.get(f"{kind}_wall")
        if isinstance(wall, dict):
            if wall.get("stage") in {"Delivered", "Spent"}:
                return None
            value = wall.get("strike")
        else:
            value = wall
        return float(value) if _number(value) else None

    floor = active_wall("put")
    ceiling = active_wall("call")
    if (
        context.get("available") is not True
        or not _number(spot)
        or not _number(atr_5m)
        or float(atr_5m) <= 0
        or floor is None
        or ceiling is None
        or floor >= ceiling
    ):
        return {
            "available": False,
            "mode": "shadow",
            "reason": "fresh_ordered_gex_boundaries_unavailable",
            "floor": floor,
            "ceiling": ceiling,
            "location": "UNAVAILABLE",
            "range_play_eligible": False,
            "suggested_side": None,
            "advisory": "observe_only",
        }

    price = float(spot)
    atr = float(atr_5m)
    width = ceiling - floor
    boundary_zone = max(0.05, atr * 0.50)
    floor_distance = abs(price - floor)
    ceiling_distance = abs(price - ceiling)
    position = (price - floor) / width
    if floor_distance <= boundary_zone:
        location = "AT_FLOOR"
    elif ceiling_distance <= boundary_zone:
        location = "AT_CEILING"
    elif price < floor:
        location = "BELOW_FLOOR"
    elif price > ceiling:
        location = "ABOVE_CEILING"
    elif position < 1 / 3:
        location = "LOWER_THIRD"
    elif position > 2 / 3:
        location = "UPPER_THIRD"
    else:
        location = "MID_RANGE"

    positive_range = bool(
        context.get("regime") == "Positive"
        and context.get("gamma_regime") == "Range"
    )
    suggested_side = (
        "calls" if location == "AT_FLOOR"
        else "puts" if location == "AT_CEILING"
        else None
    )
    range_play_eligible = bool(positive_range and suggested_side)
    advisory = (
        "boundary_rejection_watch"
        if range_play_eligible
        else "avoid_mid_range"
        if location == "MID_RANGE"
        else "range_fade_not_supported"
        if not positive_range
        else "observe_only"
    )
    return {
        "available": True,
        "mode": "shadow",
        "reason": None,
        "regime": context.get("regime"),
        "gamma_regime": context.get("gamma_regime"),
        "floor": round(floor, 4),
        "ceiling": round(ceiling, 4),
        "range_width": round(width, 4),
        "range_width_atr": round(width / atr, 3),
        "boundary_zone": round(boundary_zone, 4),
        "position_in_range": round(position, 4),
        "distance_to_floor_atr": round(floor_distance / atr, 3),
        "distance_to_ceiling_atr": round(ceiling_distance / atr, 3),
        "nearest_boundary": (
            "floor" if floor_distance <= ceiling_distance else "ceiling"
        ),
        "location": location,
        "range_play_eligible": range_play_eligible,
        "suggested_side": suggested_side,
        "advisory": advisory,
    }


def _atr(bars: list[dict[str, Any]], period: int = 14) -> float | None:
    if len(bars) < 2:
        return None
    ranges = []
    for previous, current in zip(bars, bars[1:]):
        ranges.append(
            max(
                float(current["high"]) - float(current["low"]),
                abs(float(current["high"]) - float(previous["close"])),
                abs(float(current["low"]) - float(previous["close"])),
            )
        )
    window = ranges[-period:]
    return round(sum(window) / len(window), 4) if window else None


def validate_trendline_structure_config(
    config: dict[str, Any] | None,
) -> dict[str, Any]:
    if config is not None and not isinstance(config, dict):
        raise ValueError("trendline_structure must be an object")
    resolved = {
        **DEFAULT_TRENDLINE_STRUCTURE_CONFIG,
        **(config or {}),
    }
    if not isinstance(resolved["enabled"], bool):
        raise ValueError("trendline_structure enabled must be true or false")
    if resolved["mode"] != "shadow":
        raise ValueError("trendline_structure mode must be shadow")
    if (
        isinstance(resolved["length"], bool)
        or not isinstance(resolved["length"], int)
        or not 1 <= resolved["length"] <= 250
    ):
        raise ValueError("trendline_structure length must be between 1 and 250")
    if str(resolved["slope_method"]).upper() != "ATR":
        raise ValueError("trendline_structure slope_method must be ATR")
    if (
        isinstance(resolved["slope_multiplier"], bool)
        or not _number(resolved["slope_multiplier"])
        or resolved["slope_multiplier"] <= 0
    ):
        raise ValueError("trendline_structure slope_multiplier must be greater than zero")
    if (
        isinstance(resolved["retest_window_bars"], bool)
        or not isinstance(resolved["retest_window_bars"], int)
        or not 0 <= resolved["retest_window_bars"] <= 100
    ):
        raise ValueError(
            "trendline_structure retest_window_bars must be between 0 and 100"
        )
    resolved["slope_method"] = "ATR"
    resolved["slope_multiplier"] = float(resolved["slope_multiplier"])
    return resolved


def _empty_trendline_context(
    *,
    length: int,
    slope_method: str,
    slope_multiplier: float,
    retest_window_bars: int,
    reason: str,
) -> dict[str, Any]:
    return {
        "version": "trendline-structure-v1",
        "available": False,
        "reason": reason,
        "enabled": reason != "disabled_by_runtime_config",
        "mode": "shadow",
        "length": length,
        "slope_method": slope_method,
        "slope_multiplier": slope_multiplier,
        "retest_window_bars": retest_window_bars,
        "upper_line": None,
        "lower_line": None,
        "upper_slope": None,
        "lower_slope": None,
        "pivot_high": None,
        "pivot_low": None,
        "upper_age_bars": None,
        "lower_age_bars": None,
        "upper_touch_count": 0,
        "lower_touch_count": 0,
        "break": {
            "side": None,
            "confirmed": False,
            "confirmed_at": None,
            "line_value": None,
            "close": None,
            "distance_atr": None,
            "event_id": None,
        },
        "retest": {
            "status": "none",
            "bars_since_break": None,
            "line_value": None,
            "extreme": None,
        },
        "observation": "SHADOW: trendline structure is unavailable",
    }


def _trendline_bars(completed_bars: list[dict[str, Any]]) -> list[dict[str, float]]:
    normalized: dict[float, dict[str, float]] = {}
    for bar in completed_bars:
        if not isinstance(bar, dict) or any(
            bar.get(flag) is False
            for flag in ("complete", "completed", "is_complete")
            if flag in bar
        ):
            continue
        values = {
            key: bar.get(key)
            for key in ("time", "open", "high", "low", "close", "volume")
        }
        if not all(_number(values[key]) for key in ("time", "open", "high", "low", "close")):
            continue
        high = float(values["high"])
        low = float(values["low"])
        if high < low:
            continue
        stamp = float(values["time"])
        normalized[stamp] = {
            "time": stamp,
            "open": float(values["open"]),
            "high": high,
            "low": low,
            "close": float(values["close"]),
            "volume": float(values["volume"] or 0) if _number(values["volume"]) else 0.0,
        }
    return [normalized[stamp] for stamp in sorted(normalized)]


def _rma_atr_values(
    bars: list[dict[str, float]],
    length: int,
) -> list[float | None]:
    true_ranges = []
    for index, bar in enumerate(bars):
        previous_close = bars[index - 1]["close"] if index else None
        true_ranges.append(
            max(
                bar["high"] - bar["low"],
                abs(bar["high"] - previous_close) if previous_close is not None else 0,
                abs(bar["low"] - previous_close) if previous_close is not None else 0,
            )
        )
    values: list[float | None] = [None] * len(bars)
    if len(true_ranges) < length:
        return values
    current = sum(true_ranges[:length]) / length
    values[length - 1] = current
    for index in range(length, len(true_ranges)):
        current = ((current * (length - 1)) + true_ranges[index]) / length
        values[index] = current
    return values


def _trendline_event_id(side: str, pivot_time: float, confirmed_at: float) -> str:
    def stable(value: float) -> str:
        return str(int(value)) if value.is_integer() else format(value, ".9g")

    return (
        f"trendline-break-v1:{side}:{stable(pivot_time)}:"
        f"{stable(confirmed_at)}"
    )


def calculate_trendline_context(
    completed_bars: list[dict[str, Any]],
    *,
    length: int = 14,
    slope_multiplier: float = 1.0,
    slope_method: str = "ATR",
    previous_context: dict[str, Any] | None = None,
    retest_window_bars: int = 5,
) -> dict[str, Any]:
    """Calculate confirmed pivot trendlines without lookahead or backpainting."""
    config = validate_trendline_structure_config({
        "enabled": True,
        "mode": "shadow",
        "length": length,
        "slope_method": slope_method,
        "slope_multiplier": slope_multiplier,
        "retest_window_bars": retest_window_bars,
    })
    incoming_bars = _trendline_bars(completed_bars)
    previous_state = (previous_context or {}).get("_calculation_state") or {}
    state_config = {
        "length": length,
        "slope_method": config["slope_method"],
        "slope_multiplier": config["slope_multiplier"],
        "retest_window_bars": retest_window_bars,
    }
    previous_bars = _trendline_bars(
        previous_state.get("completed_bars") or []
    ) if previous_state.get("config") == state_config else []
    bars = (
        _trendline_bars([*previous_bars, *incoming_bars])
        if previous_bars and len(incoming_bars) <= 1
        else incoming_bars
    )

    def with_state(context: dict[str, Any]) -> dict[str, Any]:
        context["_calculation_state"] = {
            "config": state_config,
            "completed_bars": bars,
        }
        return context

    if len(bars) < 2 * length + 1:
        return with_state(_empty_trendline_context(
            length=length,
            slope_method=config["slope_method"],
            slope_multiplier=config["slope_multiplier"],
            retest_window_bars=retest_window_bars,
            reason="insufficient_completed_bars",
        ))
    atr_values = _rma_atr_values(bars, length)
    if not any(_number(value) and float(value) > 0 for value in atr_values):
        return with_state(_empty_trendline_context(
            length=length,
            slope_method=config["slope_method"],
            slope_multiplier=config["slope_multiplier"],
            retest_window_bars=retest_window_bars,
            reason="missing_atr",
        ))

    upper_line = lower_line = None
    upper_previous_line = lower_previous_line = None
    upper_slope = lower_slope = None
    pivot_high = pivot_low = None
    upper_age = lower_age = None
    upper_touches = lower_touches = 0
    upper_broken_pivots: set[float] = set()
    lower_broken_pivots: set[float] = set()
    latest_break = _empty_trendline_context(
        length=length,
        slope_method=config["slope_method"],
        slope_multiplier=config["slope_multiplier"],
        retest_window_bars=retest_window_bars,
        reason="initializing",
    )["break"]
    retest = {
        "status": "none",
        "bars_since_break": None,
        "line_value": None,
        "extreme": None,
    }
    active_break: dict[str, Any] | None = None

    for index, bar in enumerate(bars):
        upper_replaced = lower_replaced = False
        upper_previous_line = upper_line
        lower_previous_line = lower_line
        if upper_line is not None:
            upper_line -= float(upper_slope)
            upper_age = int(upper_age or 0) + 1
        if lower_line is not None:
            lower_line += float(lower_slope)
            lower_age = int(lower_age or 0) + 1

        pivot_index = index - length
        if pivot_index >= length:
            candidate = bars[pivot_index]
            left = bars[pivot_index - length:pivot_index]
            right = bars[pivot_index + 1:index + 1]
            atr = atr_values[index]
            if _number(atr) and float(atr) > 0 and all(
                candidate["high"] > other["high"]
                for other in (*left, *right)
            ):
                pivot_high = {
                    "price": candidate["high"],
                    "bar_time": candidate["time"],
                    "confirmed_at": bar["time"],
                }
                upper_line = candidate["high"]
                upper_slope = float(atr) / length * config["slope_multiplier"]
                upper_age = 0
                upper_touches = 0
                upper_replaced = True
            if _number(atr) and float(atr) > 0 and all(
                candidate["low"] < other["low"]
                for other in (*left, *right)
            ):
                pivot_low = {
                    "price": candidate["low"],
                    "bar_time": candidate["time"],
                    "confirmed_at": bar["time"],
                }
                lower_line = candidate["low"]
                lower_slope = float(atr) / length * config["slope_multiplier"]
                lower_age = 0
                lower_touches = 0
                lower_replaced = True

        previous_close = bars[index - 1]["close"] if index else None
        bullish_break = bool(
            not upper_replaced
            and upper_line is not None
            and upper_previous_line is not None
            and previous_close is not None
            and previous_close <= upper_previous_line
            and bar["close"] > upper_line
            and pivot_high is not None
            and pivot_high["bar_time"] not in upper_broken_pivots
        )
        bearish_break = bool(
            not lower_replaced
            and lower_line is not None
            and lower_previous_line is not None
            and previous_close is not None
            and previous_close >= lower_previous_line
            and bar["close"] < lower_line
            and pivot_low is not None
            and pivot_low["bar_time"] not in lower_broken_pivots
        )
        break_side = "bullish" if bullish_break else "bearish" if bearish_break else None
        if break_side is not None:
            is_bullish = break_side == "bullish"
            origin = pivot_high if is_bullish else pivot_low
            line_value = float(upper_line if is_bullish else lower_line)
            slope = float(upper_slope if is_bullish else lower_slope)
            if is_bullish:
                upper_broken_pivots.add(float(origin["bar_time"]))
                distance = bar["close"] - line_value
            else:
                lower_broken_pivots.add(float(origin["bar_time"]))
                distance = line_value - bar["close"]
            atr = atr_values[index]
            latest_break = {
                "side": break_side,
                "confirmed": True,
                "confirmed_at": bar["time"],
                "line_value": round(line_value, 6),
                "close": bar["close"],
                "distance_atr": (
                    round(distance / float(atr), 6)
                    if _number(atr) and float(atr) > 0
                    else None
                ),
                "event_id": _trendline_event_id(
                    break_side,
                    float(origin["bar_time"]),
                    bar["time"],
                ),
            }
            active_break = {
                "side": break_side,
                "index": index,
                "line_value": line_value,
                "slope": slope,
            }
            retest = {
                "status": "awaiting",
                "bars_since_break": 0,
                "line_value": round(line_value, 6),
                "extreme": None,
            }
        elif active_break is not None and retest["status"] == "awaiting":
            bars_since = index - int(active_break["index"])
            direction = -1 if active_break["side"] == "bullish" else 1
            line_value = (
                float(active_break["line_value"])
                + direction * float(active_break["slope"]) * bars_since
            )
            extreme = bar["low"] if active_break["side"] == "bullish" else bar["high"]
            held = (
                bar["low"] <= line_value and bar["close"] >= line_value
                if active_break["side"] == "bullish"
                else bar["high"] >= line_value and bar["close"] <= line_value
            )
            status = (
                "confirmed"
                if held
                else "expired"
                if bars_since > retest_window_bars
                else "awaiting"
            )
            retest = {
                "status": status,
                "bars_since_break": bars_since,
                "line_value": round(line_value, 6),
                "extreme": extreme,
            }

        if (
            not bullish_break
            and not upper_replaced
            and upper_line is not None
            and bar["high"] >= upper_line
            and bar["close"] <= upper_line
        ):
            upper_touches += 1
        if (
            not bearish_break
            and not lower_replaced
            and lower_line is not None
            and bar["low"] <= lower_line
            and bar["close"] >= lower_line
        ):
            lower_touches += 1

    if latest_break["confirmed"]:
        observation = f"SHADOW: {latest_break['side']} trendline break confirmed"
        if retest["status"] == "awaiting":
            observation += "; awaiting retest"
    elif upper_line is not None and lower_line is not None:
        observation = "SHADOW: price remains between active trendlines"
    else:
        observation = "SHADOW: waiting for confirmed pivot trendlines"
    return with_state({
        "version": "trendline-structure-v1",
        "available": True,
        "reason": None,
        "enabled": True,
        "mode": "shadow",
        "length": length,
        "slope_method": config["slope_method"],
        "slope_multiplier": config["slope_multiplier"],
        "retest_window_bars": retest_window_bars,
        "upper_line": round(upper_line, 6) if upper_line is not None else None,
        "lower_line": round(lower_line, 6) if lower_line is not None else None,
        "upper_slope": round(upper_slope, 6) if upper_slope is not None else None,
        "lower_slope": round(lower_slope, 6) if lower_slope is not None else None,
        "pivot_high": pivot_high,
        "pivot_low": pivot_low,
        "upper_age_bars": upper_age,
        "lower_age_bars": lower_age,
        "upper_touch_count": upper_touches,
        "lower_touch_count": lower_touches,
        "break": latest_break,
        "retest": retest,
        "observation": observation,
    })


def _median_volume(completed: list[dict[str, Any]], window: int = 20) -> float | None:
    volumes = [float(bar.get("volume", 0)) for bar in completed[-window:] if bar.get("volume", 0) > 0]
    if not volumes:
        return None
    first = statistics.median(volumes)
    filtered = [volume for volume in volumes if volume <= first * 3]
    return statistics.median(filtered or volumes)


def _time_of_day_rvol(
    latest: dict[str, Any] | None,
    all_completed: list[dict[str, Any]],
    *,
    minute_tolerance: int = 2,
) -> tuple[float | None, int]:
    """Compare the latest minute with prior sessions at the same time of day."""
    if not latest or not _number(latest.get("time")):
        return None, 0
    latest_stamp = datetime.fromtimestamp(float(latest["time"]), ET)
    latest_minute = latest_stamp.hour * 60 + latest_stamp.minute
    reference = []
    for bar in all_completed:
        if not (_number(bar.get("time")) and _number(bar.get("volume"))):
            continue
        stamp = datetime.fromtimestamp(float(bar["time"]), ET)
        minute = stamp.hour * 60 + stamp.minute
        if (
            stamp.date() != latest_stamp.date()
            and abs(minute - latest_minute) <= minute_tolerance
            and float(bar["volume"]) > 0
        ):
            reference.append(float(bar["volume"]))
    latest_volume = float(latest.get("volume", 0) or 0)
    baseline = statistics.median(reference) if len(reference) >= 10 else None
    return (
        latest_volume / baseline if latest_volume > 0 and baseline else None,
        len(reference),
    )


def calculate_indicators(bars: list[dict[str, Any]]) -> dict[str, Any]:
    session = _session_bars(bars)
    completed = _completed_bars(session)
    all_completed = _completed_bars(bars)
    closes = [float(bar["close"]) for bar in completed]
    volume_sum = sum(float(bar.get("volume", 0) or 0) for bar in session)
    vwap_numerator = sum(
        ((float(bar["high"]) + float(bar["low"]) + float(bar["close"])) / 3)
        * float(bar.get("volume", 0) or 0)
        for bar in session
    )
    five = _aggregate_bars(all_completed, 5)
    fifteen = _aggregate_bars(all_completed, 15)
    hourly = _aggregate_bars(all_completed, 60)
    five_closes = [float(bar["close"]) for bar in five]
    fifteen_closes = [float(bar["close"]) for bar in fifteen]
    hourly_closes = [float(bar["close"]) for bar in hourly]
    median_volume = _median_volume(completed)
    latest_volume = float(completed[-1].get("volume", 0)) if completed else None
    historical_rvol, historical_samples = _time_of_day_rvol(
        completed[-1] if completed else None,
        all_completed,
    )
    rolling_rvol = latest_volume / median_volume if latest_volume and median_volume else None
    rvol = historical_rvol if historical_rvol is not None else rolling_rvol
    return {
        "bars_1m": len(session),
        "completed_1m": len(completed),
        "completed_5m": len(five),
        "last_completed_at": completed[-1]["time"] if completed else None,
        "completed_bar_age_seconds": round(time.time() - float(completed[-1]["time"]), 1) if completed else None,
        "last_close": closes[-1] if closes else None,
        "ema9": _ema(closes, 9),
        "ema21": _ema(closes, 21),
        "vwap": round(vwap_numerator / volume_sum, 4) if volume_sum else None,
        "median_volume_20": round(median_volume, 0) if median_volume else None,
        "last_volume": latest_volume,
        "rvol": round(rvol, 2) if rvol else None,
        "rvol_method": "historical_same_time" if historical_rvol is not None else "rolling_20",
        "rvol_reference_samples": historical_samples,
        "ema9_5m": _ema(five_closes, 9),
        "ema21_5m": _ema(five_closes, 21),
        "last_completed_5m_at": five[-1]["time"] if five else None,
        "last_close_5m": five_closes[-1] if five_closes else None,
        "ema9_15m": _ema(fifteen_closes, 9),
        "ema21_15m": _ema(fifteen_closes, 21),
        "last_completed_15m_at": fifteen[-1]["time"] if fifteen else None,
        "last_close_15m": fifteen_closes[-1] if fifteen_closes else None,
        "ema9_60m": _ema(hourly_closes, 9),
        "ema21_60m": _ema(hourly_closes, 21),
        "last_close_60m": hourly_closes[-1] if hourly_closes else None,
        "atr_5m": _atr(five),
        "recent_high_5m": round(max(float(bar["high"]) for bar in five[-3:]), 4) if five else None,
        "recent_low_5m": round(min(float(bar["low"]) for bar in five[-3:]), 4) if five else None,
    }


def _heatmap_context(heatmap: dict[str, Any] | None) -> dict[str, Any]:
    interpretation = (heatmap or {}).get("interpretation") or {}
    age = time.time() - float((heatmap or {}).get("fetched_at", 0) or 0)
    status = interpretation.get("status") or "unavailable"
    return {
        "status": status,
        "age_seconds": round(age, 1),
        "fresh": status == "ok" and age <= MAX_GEX_ENTRY_AGE_SECONDS,
        "positive_nodes": interpretation.get("positive_nodes") or [],
        "negative_nodes": interpretation.get("negative_nodes") or [],
        "strongest_nodes": interpretation.get("strongest_nodes") or [],
        "building_positive": interpretation.get("building_positive") or [],
        "building_negative": interpretation.get("building_negative") or [],
        "dominant_migration": interpretation.get("dominant_migration"),
        "api_flip": interpretation.get("api_flip"),
        "nearest_zero_cross": interpretation.get("nearest_zero_cross"),
        "flip": interpretation.get("api_flip")
        if _number(interpretation.get("api_flip"))
        else interpretation.get("nearest_zero_cross"),
        "net_gex": interpretation.get("net_gex"),
    }


def _gex_context(
    gex: dict[str, Any] | None,
    heatmap: dict[str, Any] | None = None,
) -> dict[str, Any]:
    spy = ((gex or {}).get("data") or {}).get("SPY") or {}
    vix = ((gex or {}).get("data") or {}).get("VIX") or {}
    available = bool(
        isinstance(spy, dict)
        and not spy.get("error")
        and spy.get("stale") is not True
        and spy.get("regime") in {"Positive", "Negative"}
        and spy.get("gamma_regime") in {"Range", "Trend", "Whipsaw"}
    )
    return {
        "age_seconds": round(time.time() - float((gex or {}).get("fetched_at", 0)), 1),
        "available": available,
        "source": (gex or {}).get("selected_source") or (gex or {}).get("source"),
        "model": (gex or {}).get("model"),
        "model_confidence": spy.get("model_confidence"),
        "coverage_ratio": spy.get("coverage_ratio"),
        "served_expiry": spy.get("served_expiry"),
        "flip": spy.get("flip"),
        "flip_distance": spy.get("flip_distance"),
        "max_pain": spy.get("max_pain"),
        "put_call_ratio": spy.get("put_call_ratio"),
        "convexity_risk": spy.get("convexity_risk"),
        "gamma_regime": spy.get("gamma_regime"),
        "regime": spy.get("regime"),
        "rolling": spy.get("rolling"),
        "call_wall": spy.get("call_wall"),
        "put_wall": spy.get("put_wall"),
        "vix_gamma_regime": vix.get("gamma_regime"),
        "heatmap": _heatmap_context(heatmap),
    }


def _provider_timestamp(value: Any) -> float | None:
    if _number(value):
        return float(value)
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return datetime.fromisoformat(value.strip().replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError, OSError):
        return None


def provider_timestamp_freshness(
    value: Any,
    *,
    now: float,
    max_age: float,
    minute_bucket_grace_seconds: float = ZEROGEX_MINUTE_BUCKET_GRACE_SECONDS,
) -> dict[str, Any]:
    """Measure provider age without treating a minute bucket as an exact instant."""
    timestamp = _provider_timestamp(value)
    future = timestamp is not None and timestamp > now
    raw_age = (
        max(0.0, now - timestamp)
        if timestamp is not None
        else None
    )
    minute_bucket = False
    if isinstance(value, str) and value.strip():
        try:
            parsed = datetime.fromisoformat(
                value.strip().replace("Z", "+00:00")
            )
        except (TypeError, ValueError, OSError):
            parsed = None
        minute_bucket = bool(
            parsed is not None
            and parsed.second == 0
            and parsed.microsecond == 0
        )
    precision_grace = (
        float(minute_bucket_grace_seconds)
        if minute_bucket and minute_bucket_grace_seconds > 0
        else 0.0
    )
    age = (
        max(0.0, raw_age - precision_grace)
        if raw_age is not None
        else None
    )
    return {
        "timestamp": timestamp,
        "raw_age_seconds": (
            round(raw_age, 1)
            if raw_age is not None
            else None
        ),
        "precision_grace_seconds": round(precision_grace, 1),
        "age_seconds": round(age, 1) if age is not None else None,
        "future": future,
        "fresh": not future and age is not None and age <= max_age,
    }


def _zerogex_context(
    snapshot: dict[str, Any] | None,
    gex_ctx: dict[str, Any],
    spot: float | None,
    *,
    now: float | None = None,
    role: str = "shadow",
    minute_bucket_grace_seconds: float = (
        ZEROGEX_MINUTE_BUCKET_GRACE_SECONDS
    ),
) -> dict[str, Any]:
    """Normalize ZeroGEX evidence while keeping its configured role explicit."""
    current = time.time() if now is None else now
    base: dict[str, Any] = {
        "source": "zerogex",
        "mode": role,
        "gex_primary": role == "primary",
        "entry_authority": False,
        "available": False,
        "fresh": False,
    }
    if not isinstance(snapshot, dict):
        return base

    bias = snapshot.get("trade_bias") or {}
    external_gex = snapshot.get("gex_summary") or {}
    basic = snapshot.get("basic_signals") or {}
    fetched_at = snapshot.get("fetched_at")
    fetch_age = (
        max(0.0, current - float(fetched_at))
        if _number(fetched_at)
        else None
    )
    composite = snapshot.get("composite") or {}
    playbook = snapshot.get("playbook") or {}
    advanced = snapshot.get("advanced_signals") or {}
    gex_history = snapshot.get("gex_history") or {}
    market_volatility = snapshot.get("market_volatility") or {}
    strike_context = snapshot.get("strike_context") or {}
    flow_context = snapshot.get("flow_context") or {}
    session_context = snapshot.get("session_context") or {}
    dealer_hedging = snapshot.get("dealer_hedging") or {}
    forced_flow = snapshot.get("forced_flow") or {}

    def freshness(payload: Any, max_age: float) -> dict[str, Any]:
        return provider_timestamp_freshness(
            (
                (payload or {}).get("timestamp")
                if isinstance(payload, dict)
                else None
            ),
            now=current,
            max_age=max_age,
            minute_bucket_grace_seconds=minute_bucket_grace_seconds,
        )

    data_freshness = {
        "gex_summary": freshness(external_gex, MAX_ZEROGEX_DATA_AGE_SECONDS),
        "trade_bias": freshness(bias, MAX_ZEROGEX_DATA_AGE_SECONDS),
        "composite": freshness(composite, MAX_ZEROGEX_DATA_AGE_SECONDS),
        "playbook": freshness(playbook, MAX_ZEROGEX_DATA_AGE_SECONDS),
        "gex_history": freshness(
            gex_history,
            MAX_ZEROGEX_EXTENDED_AGE_SECONDS,
        ),
        "market_volatility": freshness(
            market_volatility,
            MAX_ZEROGEX_EXTENDED_AGE_SECONDS,
        ),
        "strike_context": freshness(
            strike_context,
            MAX_ZEROGEX_EXTENDED_AGE_SECONDS,
        ),
        "flow_context": freshness(
            flow_context,
            MAX_ZEROGEX_EXTENDED_AGE_SECONDS,
        ),
        "session_context": freshness(
            session_context,
            MAX_ZEROGEX_EXTENDED_AGE_SECONDS,
        ),
        "dealer_hedging": freshness(
            dealer_hedging,
            MAX_ZEROGEX_EXTENDED_AGE_SECONDS,
        ),
        "forced_flow": freshness(
            forced_flow,
            MAX_ZEROGEX_EXTENDED_AGE_SECONDS,
        ),
    }
    advanced_freshness = {
        str(name): freshness(
            value,
            MAX_ZEROGEX_EXTENDED_AGE_SECONDS,
        )
        for name, value in advanced.items()
        if isinstance(value, dict)
    }
    basic_freshness = {
        str(name): freshness(
            value,
            MAX_ZEROGEX_DATA_AGE_SECONDS,
        )
        for name, value in basic.items()
        if isinstance(value, dict)
    }
    data_freshness["basic_signals"] = basic_freshness
    data_freshness["advanced_signals"] = advanced_freshness
    provider_timestamp = data_freshness["gex_summary"]["timestamp"]
    provider_age = data_freshness["gex_summary"]["age_seconds"]
    provider_raw_age = data_freshness["gex_summary"]["raw_age_seconds"]
    provider_precision_grace = data_freshness["gex_summary"][
        "precision_grace_seconds"
    ]
    symbol = str(snapshot.get("symbol") or external_gex.get("symbol") or "").upper()
    available = bool(
        snapshot.get("source") == "zerogex"
        and symbol == "SPY"
        and (bias or external_gex)
    )
    fresh = bool(
        available
        and fetch_age is not None
        and fetch_age <= MAX_ZEROGEX_FETCH_AGE_SECONDS
        and data_freshness["gex_summary"]["fresh"]
    )

    compact_basic = {}
    for name, value in basic.items() if isinstance(basic, dict) else ():
        if value is None:
            compact_basic[str(name)] = None
        elif isinstance(value, dict):
            compact_basic[str(name)] = {
                field: value.get(field)
                for field in (
                    "score",
                    "clamped_score",
                    "direction",
                    "timestamp",
                    "source",
                    "context_values",
                )
                if field in value
            }

    comparison_enabled = gex_ctx.get("source") == "sscgex"
    heatmap = gex_ctx.get("heatmap") or {}
    sscgex_api_flip = heatmap.get("api_flip") if comparison_enabled else None
    sscgex_zero_cross = (
        heatmap.get("nearest_zero_cross") if comparison_enabled else None
    )
    zerogex_flip = external_gex.get("gamma_flip")
    call_wall = (
        (gex_ctx.get("call_wall") or {}).get("strike")
        if comparison_enabled
        else None
    )
    put_wall = (
        (gex_ctx.get("put_wall") or {}).get("strike")
        if comparison_enabled
        else None
    )
    external_call_wall = external_gex.get("call_wall")
    external_put_wall = external_gex.get("put_wall")

    def gap(left: Any, right: Any) -> float | None:
        return (
            round(abs(float(left) - float(right)), 2)
            if _number(left) and _number(right)
            else None
        )

    api_flip_outlier = bool(
        _number(spot)
        and spot > 0
        and _number(sscgex_api_flip)
        and _number(sscgex_zero_cross)
        and _number(zerogex_flip)
        and abs(float(sscgex_api_flip) - float(spot)) / float(spot) >= 0.05
        and abs(float(sscgex_zero_cross) - float(spot)) / float(spot) <= 0.02
        and abs(float(zerogex_flip) - float(spot)) / float(spot) <= 0.02
    )
    walls_aligned = bool(
        _number(call_wall)
        and _number(put_wall)
        and _number(external_call_wall)
        and _number(external_put_wall)
        and abs(float(call_wall) - float(external_call_wall)) <= 1
        and abs(float(put_wall) - float(external_put_wall)) <= 1
    )

    base.update(
        available=available,
        fresh=fresh,
        symbol=symbol or None,
        fetched_age_seconds=round(fetch_age, 1) if fetch_age is not None else None,
        provider_age_seconds=round(provider_age, 1) if provider_age is not None else None,
        provider_raw_age_seconds=(
            round(provider_raw_age, 1)
            if provider_raw_age is not None
            else None
        ),
        provider_timestamp_precision_grace_seconds=provider_precision_grace,
        data_freshness=data_freshness,
        trade_bias={
            field: copy.deepcopy(bias.get(field))
            for field in (
                "bias_score",
                "direction",
                "state",
                "confidence",
                "confidence_raw",
                "regime_label",
                "regime_desc",
                "setup",
                "expected_behavior",
                "timestamp",
                "has_data",
                "tenor",
                "playbook",
                "checklist",
                "watching",
                "inputs",
                "structural_bias",
                "tactical",
                "market_state",
                "regime",
                "bias",
                "conviction_driven",
                "breadth",
                "override",
                "aggregate",
                "max_confidence_raw",
            )
            if field in bias
        },
        gex_summary={
            field: external_gex.get(field)
            for field in (
                "timestamp",
                "spot_price",
                "gamma_flip",
                "call_wall",
                "put_wall",
                "net_gex",
                "net_gex_at_spot",
                "put_call_ratio",
            )
            if field in external_gex
        },
        basic_signals=compact_basic,
        composite=copy.deepcopy(composite),
        playbook=copy.deepcopy(playbook),
        advanced_signals=copy.deepcopy(advanced),
        gex_history=copy.deepcopy(gex_history),
        market_volatility=copy.deepcopy(market_volatility),
        strike_context=copy.deepcopy(strike_context),
        flow_context=copy.deepcopy(flow_context),
        session_context=copy.deepcopy(session_context),
        dealer_hedging=copy.deepcopy(dealer_hedging),
        forced_flow=copy.deepcopy(forced_flow),
        endpoint_errors=copy.deepcopy(snapshot.get("endpoint_errors") or {}),
        comparison={
            "source": "sscgex" if comparison_enabled else None,
            "sscgex_api_flip": sscgex_api_flip,
            "sscgex_heatmap_zero_cross": sscgex_zero_cross,
            "zerogex_gamma_flip": zerogex_flip,
            "api_flip_gap_dollars": gap(sscgex_api_flip, zerogex_flip),
            "heatmap_zero_gap_dollars": gap(sscgex_zero_cross, zerogex_flip),
            "sscgex_api_flip_outlier": api_flip_outlier,
            "walls_aligned": walls_aligned,
            "sscgex_call_wall": call_wall,
            "sscgex_put_wall": put_wall,
            "zerogex_call_wall": external_call_wall,
            "zerogex_put_wall": external_put_wall,
        },
    )
    return base


def _apply_zerogex_primary_structure(
    gex_ctx: dict[str, Any],
    zerogex_ctx: dict[str, Any],
    *,
    now: float | None = None,
) -> None:
    """Install fresh ZeroGEX structure as GEX context, never as a trigger."""
    if (
        zerogex_ctx.get("gex_primary") is not True
        or zerogex_ctx.get("fresh") is not True
    ):
        return
    freshness = zerogex_ctx.get("data_freshness") or {}
    strike = zerogex_ctx.get("strike_context") or {}
    strike_freshness = freshness.get("strike_context") or {}
    if (
        strike.get("status") == "ok"
        and strike_freshness.get("fresh") is True
    ):
        normalized = copy.deepcopy(strike)
        normalized["fresh"] = True
        normalized["age_seconds"] = strike_freshness.get("age_seconds")
        gex_ctx["heatmap"] = normalized
        wall_strength = strike.get("wall_strength") or {}
        for kind in ("call", "put"):
            wall = gex_ctx.get(f"{kind}_wall")
            evidence = wall_strength.get(kind) or {}
            if (
                isinstance(wall, dict)
                and _number(wall.get("strike"))
                and _number(evidence.get("strike"))
                and float(wall["strike"]) == float(evidence["strike"])
            ):
                wall.update(
                    gex=evidence.get("gex"),
                    strength_ratio=evidence.get("strength_ratio"),
                    trend=evidence.get("trend"),
                    migrated=evidence.get("migrated"),
                    previous_strike=evidence.get("previous_strike"),
                )
                if evidence.get("migrated") is True:
                    wall["stage"] = "Fresh"
    if (freshness.get("session_context") or {}).get("fresh") is True:
        gex_ctx["session_context"] = copy.deepcopy(
            zerogex_ctx.get("session_context") or {}
        )
    current_et = datetime.fromtimestamp(
        time.time() if now is None else now,
        ET,
    )
    late_day = (
        current_et.hour > 14
        or (current_et.hour == 14 and current_et.minute >= 30)
    )
    if (
        late_day
        and (freshness.get("forced_flow") or {}).get("fresh") is True
    ):
        gex_ctx["forced_flow"] = copy.deepcopy(
            zerogex_ctx.get("forced_flow") or {}
        )


def _zerogex_side(direction: Any) -> str | None:
    value = str(direction or "").strip().lower()
    if value in {"bullish", "long", "calls", "up"}:
        return "calls"
    if value in {"bearish", "short", "puts", "down"}:
        return "puts"
    return None


def _zerogex_posture(score: Any) -> str:
    if not _number(score):
        return "unavailable"
    value = float(score)
    if value >= 70:
        return "trend_expansion"
    if value >= 40:
        return "controlled_trend"
    if value >= 20:
        return "chop_range"
    return "high_risk_reversal"


def _zerogex_bias_style(bias: dict[str, Any]) -> str:
    """Classify provider bias by playbook type, not by its long/short label."""
    raw_bias = bias.get("bias") if isinstance(bias.get("bias"), dict) else {}
    structural = (
        bias.get("structural_bias")
        if isinstance(bias.get("structural_bias"), dict)
        else {}
    )
    terms = " ".join(
        str(value or "")
        for value in (
            raw_bias.get("code"),
            raw_bias.get("label"),
            structural.get("code"),
            structural.get("label"),
            bias.get("setup"),
            bias.get("market_state"),
            bias.get("regime_label"),
        )
    ).lower()
    if any(token in terms for token in ("range", "fade", "mean reversion", "chop")):
        return "mean_reversion"
    if any(token in terms for token in ("continuation", "breakout", "trend")):
        return "continuation"
    return "directional"


def _zerogex_advanced_family(name: str) -> str:
    if name in {"squeeze_setup", "vol_expansion"}:
        return "momentum_expansion"
    if name == "range_break_imminence":
        return "range_break_regime"
    if name == "market_pressure":
        return "dealer_pressure"
    return name


def _zerogex_advanced_active(name: str, signal: dict[str, Any]) -> tuple[bool, bool]:
    """Return (active, directional) without inventing a direction from readiness alone."""
    context = (
        signal.get("context_values")
        if isinstance(signal.get("context_values"), dict)
        else {}
    )
    triggered = (
        signal.get("triggered")
        if "triggered" in signal
        else context.get("triggered")
    )
    if name == "range_break_imminence":
        imminence = (
            signal.get("imminence")
            if _number(signal.get("imminence"))
            else context.get("imminence")
        )
        label = str(signal.get("label") or context.get("label") or "").lower()
        active = bool(
            triggered is True
            or (_number(imminence) and float(imminence) >= 65)
        )
        breakout_mode = bool(
            "breakout mode" in label
            or (not label and _number(imminence) and float(imminence) >= 80)
        )
        directional = bool(
            active
            and breakout_mode
            and _zerogex_side(signal.get("direction") or context.get("direction"))
        )
        return active, directional

    if triggered is True:
        if name == "squeeze_setup":
            side = _zerogex_side(signal.get("direction") or context.get("direction"))
            acceleration_field = (
                "accel_up" if side == "calls" else "accel_dn" if side == "puts" else None
            )
            if acceleration_field and acceleration_field in context:
                return True, context.get(acceleration_field) is True
        return True, True
    if name == "vol_expansion":
        expansion = signal.get("expansion")
        direction_score = signal.get("direction_score")
        active = bool(
            _number(expansion)
            and float(expansion) >= 60
            and _number(direction_score)
            and abs(float(direction_score)) >= 50
        )
        return active, active
    if name == "eod_pressure":
        score = signal.get("score")
        time_ramp = signal.get("time_ramp")
        active = bool(
            _number(time_ramp)
            and float(time_ramp) >= 0.5
            and _number(score)
            and abs(float(score)) >= 50
        )
        return active, active
    return False, False


def _zerogex_decision_context(
    context: dict[str, Any],
    *,
    now: float | None = None,
) -> dict[str, Any]:
    """Build a transparent, signal-only filter over ZeroGEX's richer reads."""
    current = time.time() if now is None else now
    freshness = context.get("data_freshness") or {}
    composite = context.get("composite") or {}
    playbook = context.get("playbook") or {}
    bias = context.get("trade_bias") or {}
    basic = context.get("basic_signals") or {}
    advanced = context.get("advanced_signals") or {}
    flow_context = context.get("flow_context") or {}
    session_context = context.get("session_context") or {}
    dealer_hedging = context.get("dealer_hedging") or {}
    forced_flow = context.get("forced_flow") or {}
    playbook_fresh = bool((freshness.get("playbook") or {}).get("fresh"))
    bias_fresh = bool((freshness.get("trade_bias") or {}).get("fresh"))
    composite_fresh = bool((freshness.get("composite") or {}).get("fresh"))
    flow_fresh = bool((freshness.get("flow_context") or {}).get("fresh"))
    session_fresh = bool((freshness.get("session_context") or {}).get("fresh"))
    dealer_fresh = bool((freshness.get("dealer_hedging") or {}).get("fresh"))
    forced_flow_fresh = bool((freshness.get("forced_flow") or {}).get("fresh"))
    current_et = datetime.fromtimestamp(current, ET)
    late_day_active = (
        current_et.hour > 14
        or (current_et.hour == 14 and current_et.minute >= 30)
    )
    active_advanced = []
    for name, signal in advanced.items():
        if not isinstance(signal, dict):
            continue
        if not (
            ((freshness.get("advanced_signals") or {}).get(name) or {}).get("fresh")
        ):
            continue
        active, directional = _zerogex_advanced_active(str(name), signal)
        if not active:
            continue
        active_advanced.append(
            {
                "name": str(name),
                "direction": signal.get("direction"),
                "side": _zerogex_side(signal.get("direction")),
                "score": signal.get("score"),
                "signal": signal.get("signal"),
                "label": signal.get("label"),
                "playbook": signal.get("playbook"),
                "triggered": signal.get("triggered"),
                "family": _zerogex_advanced_family(str(name)),
                "directional": directional,
                "imminence": signal.get("imminence"),
                "expansion": signal.get("expansion"),
                "context_values": copy.deepcopy(
                    signal.get("context_values") or {}
                ),
            }
        )

    advanced_status = {}
    for name, signal in advanced.items():
        if not isinstance(signal, dict):
            continue
        if not (
            ((freshness.get("advanced_signals") or {}).get(name) or {}).get("fresh")
        ):
            continue
        advanced_status[str(name)] = {
            field: copy.deepcopy(signal.get(field))
            for field in (
                "direction",
                "score",
                "triggered",
                "signal",
                "label",
                "playbook",
                "imminence",
                "loading",
                "context_values",
            )
            if field in signal
        }

    history = context.get("gex_history") or {}
    history_fresh = bool((freshness.get("gex_history") or {}).get("fresh"))
    net_history = ((history.get("metrics") or {}).get("net_gex_at_spot") or {})
    thirty_day = ((net_history.get("windows") or {}).get("30d") or {})
    percentile = thirty_day.get("percentile") if history_fresh else None
    history_extreme = (
        "extreme_negative"
        if _number(percentile) and float(percentile) <= 10
        else "extreme_positive"
        if _number(percentile) and float(percentile) >= 90
        else "normal"
        if _number(percentile)
        else "unavailable"
    )
    bias_style = _zerogex_bias_style(bias)
    raw_bias = bias.get("bias") if isinstance(bias.get("bias"), dict) else {}
    structural_bias = (
        bias.get("structural_bias")
        if isinstance(bias.get("structural_bias"), dict)
        else {}
    )
    positioning_trap = (
        basic.get("positioning_trap")
        if isinstance(basic.get("positioning_trap"), dict)
        else {}
    )
    positioning_trap_fresh = bool(
        ((freshness.get("basic_signals") or {}).get("positioning_trap") or {}).get(
            "fresh"
        )
    )
    positioning_trap_score = (
        positioning_trap.get("score") if positioning_trap_fresh else None
    )
    strong_positioning_trap = bool(
        _number(positioning_trap_score)
        and abs(float(positioning_trap_score)) >= 50
    )

    decision: dict[str, Any] = {
        "gex_primary": context.get("gex_primary") is True,
        "entry_authority": False,
        "fresh": context.get("fresh") is True,
        "composite": {
            "fresh": composite_fresh,
            "score": composite.get("score"),
            "posture": (
                _zerogex_posture(composite.get("score"))
                if composite_fresh
                else "unavailable"
            ),
            "timestamp": composite.get("timestamp"),
        },
        "playbook": {
            "fresh": playbook_fresh,
            "state": playbook.get("state") if playbook_fresh else "unavailable",
            "pattern": playbook.get("pattern") if playbook_fresh else None,
            "direction": playbook.get("direction") if playbook_fresh else None,
            "side": (
                _zerogex_side(playbook.get("direction"))
                if playbook_fresh
                else None
            ),
            "confidence": playbook.get("confidence") if playbook_fresh else None,
            "rationale": playbook.get("rationale") if playbook_fresh else None,
            "near_misses": playbook.get("near_misses") if playbook_fresh else [],
        },
        "trade_bias": {
            "fresh": bias_fresh,
            "direction": bias.get("direction") if bias_fresh else None,
            "side": _zerogex_side(bias.get("direction")) if bias_fresh else None,
            "score": bias.get("bias_score") if bias_fresh else None,
            "confidence": bias.get("confidence") if bias_fresh else None,
            "setup": bias.get("setup") if bias_fresh else None,
            "style": bias_style if bias_fresh else "unavailable",
            "directional_confirmation": bool(
                bias_fresh
                and bias_style in {"continuation", "directional"}
                and bias.get("conviction_driven") is not False
            ),
            "code": (
                raw_bias.get("code") or structural_bias.get("code")
                if bias_fresh
                else None
            ),
            "label": (
                raw_bias.get("label") or structural_bias.get("label")
                if bias_fresh
                else None
            ),
            "market_state": bias.get("market_state") if bias_fresh else None,
            "regime_description": bias.get("regime_desc") if bias_fresh else None,
            "conviction_driven": (
                bias.get("conviction_driven") if bias_fresh else None
            ),
            "playbook": (
                copy.deepcopy(bias.get("playbook") or []) if bias_fresh else []
            ),
        },
        "positioning_trap": {
            "fresh": positioning_trap_fresh,
            "score": positioning_trap_score,
            "direction": (
                positioning_trap.get("direction")
                if positioning_trap_fresh
                else None
            ),
            "strong": strong_positioning_trap,
            "style": "mean_reversion",
        },
        "active_advanced": active_advanced,
        "advanced_status": advanced_status,
        "gex_history": {
            "fresh": history_fresh,
            "net_gex_30d_percentile": percentile,
            "net_gex_30d_z_score": (
                thirty_day.get("z_score") if history_fresh else None
            ),
            "extremity": history_extreme,
        },
        "market_volatility": copy.deepcopy(context.get("market_volatility") or {}),
        "flow_context": {
            **copy.deepcopy(flow_context),
            "fresh": flow_fresh,
            "family": "correlated_flow_context",
        },
        "session_context": {
            **copy.deepcopy(session_context),
            "fresh": session_fresh,
        },
        "late_day_context": {
            "active": late_day_active,
            "dealer_hedging": (
                copy.deepcopy(dealer_hedging) if dealer_fresh else {}
            ),
            "forced_flow": (
                copy.deepcopy(forced_flow) if forced_flow_fresh else {}
            ),
        },
        "endpoint_errors": copy.deepcopy(context.get("endpoint_errors") or {}),
        "gates": {},
    }

    for side in ("calls", "puts"):
        blockers: list[str] = []
        warnings: list[str] = []
        confirmations: list[str] = []
        if decision["gex_primary"]:
            playbook_state = decision["playbook"]["state"]
            playbook_side = decision["playbook"]["side"]
            playbook_confidence = decision["playbook"]["confidence"]
            if playbook_state == "stand_down":
                warnings.append("ZeroGEX has no confirming playbook setup")
            elif playbook_state == "candidate" and playbook_side:
                if playbook_side == side:
                    confirmations.append(
                        f"ZeroGEX playbook aligns {side}"
                    )
                elif (
                    _number(playbook_confidence)
                    and float(playbook_confidence) >= 0.5
                ):
                    warnings.append(
                        f"ZeroGEX playbook strongly opposes {side}"
                    )
                else:
                    warnings.append(
                        f"ZeroGEX playbook leans against {side}"
                    )
            elif playbook_state == "unavailable":
                warnings.append(
                    "ZeroGEX playbook unavailable or stale; using GEX and local structure only"
                )

            bias_side = decision["trade_bias"]["side"]
            bias_score = decision["trade_bias"]["score"]
            bias_confidence = decision["trade_bias"]["confidence"]
            meaningful_bias = bool(
                bias_side
                and _number(bias_score)
                and abs(float(bias_score)) >= 30
                and _number(bias_confidence)
                and float(bias_confidence) >= 30
            )
            bias_is_directional = decision["trade_bias"][
                "directional_confirmation"
            ]
            if decision["trade_bias"]["style"] == "mean_reversion":
                bias_label = (
                    decision["trade_bias"].get("label")
                    or decision["trade_bias"].get("code")
                    or "range fade"
                )
                market_state = decision["trade_bias"].get("market_state")
                state_text = f" / {market_state}" if market_state else ""
                warnings.append(
                    f"ZeroGEX Trade Bias is {bias_label}{state_text}; "
                    "it is mean-reversion context, not continuation confirmation"
                )
            elif meaningful_bias and bias_is_directional and bias_side == side:
                confirmations.append(f"ZeroGEX Trade Bias aligns {side}")
            elif meaningful_bias and bias_is_directional and bias_side != side:
                warnings.append(f"ZeroGEX Trade Bias conflicts with {side}")

            if decision["positioning_trap"]["strong"]:
                trap_score = decision["positioning_trap"]["score"]
                warnings.append(
                    "Strong ZeroGEX Positioning Trap "
                    f"({float(trap_score):+.0f}) is mean-reversion context, "
                    "not continuation confirmation"
                )

            range_break = next(
                (
                    signal
                    for signal in active_advanced
                    if signal.get("name") == "range_break_imminence"
                ),
                None,
            )
            if range_break and not range_break.get("directional"):
                direction = str(range_break.get("direction") or "").lower()
                direction_text = f"{direction} " if direction else ""
                warnings.append(
                    f"ZeroGEX {direction_text}Break Watch is preparation only; "
                    "wait for a clean break and retest"
                )

            aligned_families: dict[str, list[str]] = {}
            conflicting_families: dict[str, list[str]] = {}
            for signal in active_advanced:
                if not signal.get("directional"):
                    continue
                family = str(signal.get("family") or signal.get("name") or "")
                target = (
                    aligned_families
                    if signal.get("side") == side
                    else conflicting_families
                    if signal.get("side") not in {None, side}
                    else None
                )
                if target is not None:
                    target.setdefault(family, []).append(str(signal["name"]))

            family_labels = {
                "momentum_expansion": "momentum/expansion family",
                "range_break_regime": "Breakout Mode",
                "dealer_pressure": "dealer-pressure family",
                "zero_dte_position_imbalance": "0DTE positioning",
                "gamma_vwap_confluence": "gamma/VWAP confluence",
                "trap_detection": "trap detection",
                "eod_pressure": "EOD pressure",
            }
            for family in aligned_families:
                label = family_labels.get(family, family.replace("_", " "))
                suffix = (
                    "; local break/retest is still required"
                    if family == "range_break_regime"
                    else ""
                )
                confirmations.append(
                    f"ZeroGEX {label} aligns {side}{suffix}"
                )
            for family in conflicting_families:
                label = family_labels.get(family, family.replace("_", " "))
                warnings.append(f"ZeroGEX {label} conflicts with {side}")
            if len(conflicting_families) >= 2 and not aligned_families:
                warnings.append(
                    f"multiple independent ZeroGEX evidence families oppose {side}"
                )

            flow = decision["flow_context"]
            flow_direction = _zerogex_side(flow.get("direction"))
            flow_strength = flow.get("strength")
            smart_money = (
                flow.get("smart_money")
                if isinstance(flow.get("smart_money"), dict)
                else {}
            )
            smart_direction = _zerogex_side(smart_money.get("direction"))
            smart_strength = smart_money.get("strength")
            if (
                flow.get("fresh") is True
                and flow_direction
                and _number(flow_strength)
                and float(flow_strength) >= 0.20
            ):
                message = (
                    f"ZeroGEX premium flow {'aligns' if flow_direction == side else 'conflicts with'} "
                    f"{side} (correlated context)"
                )
                (
                    confirmations
                    if flow_direction == side
                    else warnings
                ).append(message)
            if (
                flow.get("fresh") is True
                and smart_direction
                and _number(smart_strength)
                and float(smart_strength) >= 0.20
            ):
                message = (
                    f"ZeroGEX smart-money flow {'aligns' if smart_direction == side else 'conflicts with'} "
                    f"{side} (heuristic context)"
                )
                (
                    confirmations
                    if smart_direction == side
                    else warnings
                ).append(message)
            if (
                flow.get("fresh") is True
                and flow_direction
                and smart_direction
                and flow_direction != smart_direction
            ):
                warnings.append(
                    "ZeroGEX premium and smart-money flow are split"
                )

            divergence = (
                decision["session_context"].get("momentum_divergence")
                if isinstance(
                    decision["session_context"].get("momentum_divergence"),
                    dict,
                )
                else {}
            )
            divergence_side = _zerogex_side(divergence.get("direction"))
            divergence_label = str(
                divergence.get("divergence_signal") or ""
            ).strip()
            if (
                decision["session_context"].get("fresh") is True
                and divergence_side
                and divergence_label
            ):
                message = (
                    f"ZeroGEX momentum/flow divergence {'aligns' if divergence_side == side else 'conflicts with'} "
                    f"{side}"
                )
                (
                    confirmations
                    if divergence_side == side
                    else warnings
                ).append(message)

            dealer = decision["late_day_context"].get("dealer_hedging") or {}
            expected_hedge_shares = dealer.get("expected_hedge_shares")
            if (
                decision["late_day_context"].get("active") is True
                and _number(expected_hedge_shares)
                and abs(float(expected_hedge_shares)) >= 1_000_000
            ):
                # Negative expected shares imply dealer buying pressure; positive
                # shares imply dealer selling pressure. This remains a late-day
                # confirmation/warning and never creates an entry on its own.
                hedge_side = (
                    "calls"
                    if float(expected_hedge_shares) < 0
                    else "puts"
                )
                message = (
                    f"ZeroGEX late-day dealer hedging pressure {'aligns' if hedge_side == side else 'conflicts with'} "
                    f"{side}"
                )
                (
                    confirmations
                    if hedge_side == side
                    else warnings
                ).append(message)

            posture = decision["composite"]["posture"]
            if posture == "chop_range":
                warnings.append("ZeroGEX MSI posture favors chop/range")
            elif posture == "high_risk_reversal":
                warnings.append("ZeroGEX MSI posture favors high-risk reversal")
            elif posture == "unavailable":
                warnings.append("ZeroGEX MSI composite unavailable or stale")
            if history_extreme == "extreme_negative":
                warnings.append(
                    "ZeroGEX GEX is at a 30d negative extreme; confirmed moves may amplify"
                )
            elif history_extreme == "extreme_positive":
                warnings.append(
                    "ZeroGEX GEX is at a 30d positive extreme; pinning risk is elevated"
                )
        decision["gates"][side] = {
            "entry_allowed": not blockers,
            "blockers": blockers,
            "warnings": warnings,
            "confirmations": confirmations,
        }
    return decision


def _select_otm_option(
    options: dict[str, Any],
    right: str,
    spot: float,
    steps: int = 2,
    preferred: dict[str, Any] | None = None,
    atm_hysteresis: float = 0.10,
    *,
    max_total_debit_dollars: float = 0,
    preferred_contracts: int = 1,
    limit_price_offset: float = 0,
    min_abs_delta: float = 0.15,
    max_spread_pct: float = MAX_OPTION_SPREAD_PCT,
) -> dict[str, Any] | None:
    """Select N strikes from ATM, retaining the prior anchor near strike midpoints."""
    contracts = [
        contract
        for contract in options.get("contracts") or []
        if contract.get("right") == right and _number(contract.get("strike"))
    ]
    strikes = sorted({float(contract["strike"]) for contract in contracts})
    label = f"OTM+{steps}" if right == "C" else f"OTM-{steps}"
    if not strikes:
        return {
            "selection": label,
            "eligible": False,
            "target_strike": None,
            "rejection_reasons": ["no listed strikes are subscribed"],
        }
    atm_strike = min(strikes, key=lambda strike: (abs(strike - spot), strike))
    preferred_atm_value = (preferred or {}).get("atm_strike")
    preferred_atm = float(preferred_atm_value) if _number(preferred_atm_value) else None
    preferred_expiry = str((preferred or {}).get("expiry") or "")
    current_expiry = str(options.get("expiry") or "")
    if (
        preferred_atm is not None
        and float(preferred_atm) in strikes
        and (not preferred_expiry or preferred_expiry == current_expiry)
        and (preferred or {}).get("right") in {None, right}
    ):
        preferred_index = strikes.index(float(preferred_atm))
        lower_bound = float("-inf")
        upper_bound = float("inf")
        if preferred_index > 0:
            lower_bound = (strikes[preferred_index - 1] + float(preferred_atm)) / 2 - atm_hysteresis
        if preferred_index < len(strikes) - 1:
            upper_bound = (float(preferred_atm) + strikes[preferred_index + 1]) / 2 + atm_hysteresis
        if lower_bound <= spot <= upper_bound:
            atm_strike = float(preferred_atm)
    atm_index = strikes.index(atm_strike)
    target_index = atm_index + steps if right == "C" else atm_index - steps
    if target_index < 0 or target_index >= len(strikes):
        return {
            "selection": label,
            "eligible": False,
            "atm_strike": atm_strike,
            "target_strike": None,
            "rejection_reasons": [f"the subscribed chain does not reach {steps} strikes from ATM {atm_strike}"],
        }
    target_strike = strikes[target_index]
    matches = [contract for contract in contracts if float(contract["strike"]) == target_strike]
    if not matches:
        return {
            "selection": label,
            "eligible": False,
            "target_strike": target_strike,
            "rejection_reasons": ["target contract is missing"],
        }

    return _evaluate_option_contract(
        options,
        matches[0],
        selection=label,
        atm_strike=atm_strike,
        target_strike=target_strike,
        max_total_debit_dollars=max_total_debit_dollars,
        preferred_contracts=preferred_contracts,
        limit_price_offset=limit_price_offset,
        min_abs_delta=min_abs_delta,
        max_spread_pct=max_spread_pct,
    )


def _evaluate_option_contract(
    options: dict[str, Any],
    contract: dict[str, Any],
    *,
    selection: str,
    atm_strike: float | None,
    target_strike: float,
    max_total_debit_dollars: float = 0,
    preferred_contracts: int = 1,
    limit_price_offset: float = 0,
    min_abs_delta: float = 0.15,
    max_spread_pct: float = MAX_OPTION_SPREAD_PCT,
) -> dict[str, Any]:
    """Normalize eligibility and premium guidance for one exact contract."""
    contract = dict(contract)
    reasons: list[str] = []
    expiry = str(contract.get("expiry") or options.get("expiry") or "")
    bid, ask = contract.get("bid"), contract.get("ask")
    mid, spread = contract.get("mid"), contract.get("spread_pct")
    volume = contract.get("volume")
    delta = contract.get("delta")
    quote_age = contract.get("quote_age_seconds")
    selected_expiry = str(options.get("expiry") or "")
    expiry_mode = str(options.get("expiry_mode") or "")
    options_generated_at = options.get("generated_at")
    if not expiry or expiry != selected_expiry:
        reasons.append(f"expiry {expiry or '-'} does not match selected expiry {selected_expiry or '-'}")
    if expiry_mode and _number(options_generated_at):
        option_stamp = datetime.fromtimestamp(float(options_generated_at), ET)
        option_minutes = option_stamp.hour * 60 + option_stamp.minute
        if option_minutes >= 13 * 60 and expiry_mode.startswith("0DTE"):
            reasons.append("0DTE contracts are prohibited for new setups at/after 1:00 PM ET")
        elif option_minutes < 13 * 60 and expiry_mode == "1DTE_NEXT_LISTED":
            reasons.append("next-listed expiry is not selected before 1:00 PM ET")
    if not (_number(bid) and _number(ask) and bid > 0 and ask >= bid):
        reasons.append("live bid/ask quote is unavailable")
    if _number(quote_age) is None or float(quote_age) < 0:
        reasons.append("option quote timestamp is unavailable")
    elif float(quote_age) > 15:
        reasons.append(f"option quote is {float(quote_age):.1f}s old")
    if not (_number(mid) and mid > 0):
        reasons.append("mid premium is unavailable")
    if not _number(spread):
        reasons.append("bid/ask spread is unavailable")
    elif spread > max_spread_pct:
        reasons.append(
            f"spread {spread:.1f}% exceeds {max_spread_pct:g}%"
        )
    if not (_number(volume) and volume > 0):
        reasons.append("reported volume is zero or unavailable")
    if not _number(delta):
        reasons.append("option delta is unavailable")
    elif not min_abs_delta <= abs(float(delta)) <= 0.65:
        reasons.append(
            f"absolute delta {abs(float(delta)):.2f} is outside "
            f"{min_abs_delta:.2f}–0.65"
        )

    quality_eligible = not reasons
    planned_limit_price = None
    planned_contracts = None
    planned_total_debit = None
    if (
        quality_eligible
        and max_total_debit_dollars > 0
        and _number(ask) is not None
        and float(ask) > 0
    ):
        planned_limit_price = round(
            float(ask) + float(limit_price_offset) + 1e-9,
            2,
        )
        planned_contracts = min(
            int(preferred_contracts),
            math.floor(
                float(max_total_debit_dollars)
                / (planned_limit_price * 100)
            ),
        )
        if planned_contracts < 1:
            reasons.append(
                f"one contract at ${planned_limit_price:.2f} exceeds the "
                f"${max_total_debit_dollars:g} total-debit budget"
            )
        else:
            planned_total_debit = round(
                planned_contracts * planned_limit_price * 100,
                2,
            )

    contract.update(
        selection=selection,
        atm_strike=atm_strike,
        target_strike=target_strike,
        quality_eligible=quality_eligible,
        eligible=not reasons,
        rejection_reasons=reasons,
        planned_limit_price=planned_limit_price,
        planned_contracts=planned_contracts,
        planned_total_debit=planned_total_debit,
        max_total_debit_dollars=(
            float(max_total_debit_dollars)
            if max_total_debit_dollars > 0
            else None
        ),
        entry_order="SIGNAL_ONLY",
        premium_target_10=round(float(mid) * 1.10, 2) if _number(mid) and mid > 0 else None,
        premium_target_20=round(float(mid) * 1.20, 2) if _number(mid) and mid > 0 else None,
        expiry_mode=expiry_mode or "0DTE",
    )
    return contract


def _select_signal_option(
    options: dict[str, Any],
    right: str,
    spot: float,
    *,
    preferred: dict[str, Any] | None = None,
    max_total_debit_dollars: float = 0,
    preferred_contracts: int = 1,
    limit_price_offset: float = 0,
    max_otm_steps: int = 3,
    min_abs_delta: float = 0.15,
    max_spread_pct: float = MAX_OPTION_SPREAD_PCT,
) -> dict[str, Any] | None:
    """Choose a liquid near-ATM contract using delta, spread, volume, and stability."""
    contracts = [
        contract for contract in options.get("contracts") or []
        if contract.get("right") == right and _number(contract.get("strike"))
    ]
    strikes = sorted({float(contract["strike"]) for contract in contracts})
    if not strikes:
        return _select_otm_option(
            options,
            right,
            spot,
            steps=2,
            preferred=preferred,
            max_total_debit_dollars=max_total_debit_dollars,
            preferred_contracts=preferred_contracts,
            limit_price_offset=limit_price_offset,
            min_abs_delta=min_abs_delta,
            max_spread_pct=max_spread_pct,
        )
    atm = min(strikes, key=lambda strike: (abs(strike - spot), strike))
    atm_index = strikes.index(atm)
    candidates: list[tuple[float, int, int, dict[str, Any]]] = []
    budget_blocked: list[tuple[float, int, dict[str, Any]]] = []
    for offset in range(1, max_otm_steps + 1):
        index = atm_index + offset if right == "C" else atm_index - offset
        if index < 0 or index >= len(strikes):
            continue
        strike = strikes[index]
        contract = next(
            item for item in contracts if float(item["strike"]) == strike
        )
        evaluated = _evaluate_option_contract(
            options,
            contract,
            selection=f"DELTA/LIQ OTM{offset:+d}",
            atm_strike=atm,
            target_strike=strike,
            max_total_debit_dollars=max_total_debit_dollars,
            preferred_contracts=preferred_contracts,
            limit_price_offset=limit_price_offset,
            min_abs_delta=min_abs_delta,
            max_spread_pct=max_spread_pct,
        )
        delta = abs(float(evaluated["delta"])) if _number(evaluated.get("delta")) else None
        spread = float(evaluated.get("spread_pct") or max_spread_pct)
        volume = max(
            0,
            float(evaluated["volume"])
            if _number(evaluated.get("volume"))
            else 0,
        )
        open_interest = (
            max(0, float(evaluated["open_interest"]))
            if _number(evaluated.get("open_interest"))
            else 0
        )
        delta_penalty = abs(delta - 0.40) * 4 if delta is not None else 1.0
        spread_penalty = spread / max_spread_pct
        volume_credit = min(math.log10(volume + 1) / 4, 1)
        open_interest_credit = min(math.log10(open_interest + 1) / 4, 1)
        offset_penalty = abs(offset - 2) * 0.05
        score = (
            delta_penalty + spread_penalty + offset_penalty
            - volume_credit - 0.25 * open_interest_credit
        )
        evaluated["selection_score"] = round(score, 4)
        evaluated["selection_quality"] = {
            "delta_penalty": round(delta_penalty, 4),
            "spread_penalty": round(spread_penalty, 4),
            "volume_credit": round(volume_credit, 4),
            "open_interest_credit": round(open_interest_credit, 4),
            "offset_penalty": round(offset_penalty, 4),
        }
        evaluated["otm_offset"] = offset
        if evaluated.get("eligible") is True:
            planned_quantity = int(
                evaluated.get("planned_contracts")
                or preferred_contracts
            )
            candidates.append(
                (score, -planned_quantity, offset, evaluated)
            )
        elif (
            evaluated.get("quality_eligible") is True
            and evaluated.get("planned_contracts") == 0
        ):
            budget_blocked.append((score, offset, evaluated))
    if not candidates:
        if budget_blocked:
            budget_blocked.sort(
                key=lambda item: (
                    float(item[2].get("planned_limit_price") or math.inf),
                    item[0],
                )
            )
            blocked = budget_blocked[0][2]
            blocked["selection"] += " BUDGET BLOCKED"
            return blocked
        return _select_otm_option(
            options,
            right,
            spot,
            steps=2,
            preferred=preferred,
            max_total_debit_dollars=max_total_debit_dollars,
            preferred_contracts=preferred_contracts,
            limit_price_offset=limit_price_offset,
            min_abs_delta=min_abs_delta,
            max_spread_pct=max_spread_pct,
        )
    candidates.sort(key=lambda item: (item[0], item[1], abs(item[2] - 2)))
    best_score, _, _, best = candidates[0]
    preferred_strike = (preferred or {}).get("target_strike")
    if _number(preferred_strike):
        retained = next(
            (
                item for item in candidates
                if float(item[3]["target_strike"]) == float(preferred_strike)
                and item[0] <= best_score + 0.10
            ),
            None,
        )
        if retained:
            best = retained[3]
            best["selection"] += " RETAINED"
    return best


def _refresh_locked_option(
    options: dict[str, Any],
    locked: dict[str, Any] | None,
    *,
    max_total_debit_dollars: float = 0,
    preferred_contracts: int = 1,
    limit_price_offset: float = 0,
    min_abs_delta: float = 0.15,
    max_spread_pct: float = MAX_OPTION_SPREAD_PCT,
) -> dict[str, Any] | None:
    """Refresh quotes for the activation contract without selecting a new strike."""
    if not locked:
        return locked
    right = locked.get("right")
    strike = locked.get("target_strike", locked.get("strike"))
    expiry = str(locked.get("expiry") or "")
    matches = [
        contract
        for contract in options.get("contracts") or []
        if contract.get("right") == right
        and _number(contract.get("strike"))
        and _number(strike)
        and float(contract["strike"]) == float(strike)
        and str(contract.get("expiry") or options.get("expiry") or "") == expiry
    ]
    if not matches:
        unavailable = dict(locked)
        unavailable.update(
            eligible=False,
            rejection_reasons=["locked activation contract is not currently subscribed"],
            bid=None,
            ask=None,
            mid=None,
            spread_pct=None,
            premium_target_10=None,
            premium_target_20=None,
            locked_at_activation=bool(locked.get("locked_at_activation")),
            locked_at_armed=bool(locked.get("locked_at_armed")),
        )
        return unavailable
    refreshed = _evaluate_option_contract(
        options,
        matches[0],
        selection=str(locked.get("selection") or "OTM at activation"),
        atm_strike=locked.get("atm_strike"),
        target_strike=float(strike),
        max_total_debit_dollars=max_total_debit_dollars,
        preferred_contracts=preferred_contracts,
        limit_price_offset=limit_price_offset,
        min_abs_delta=min_abs_delta,
        max_spread_pct=max_spread_pct,
    )
    refreshed["locked_at_activation"] = bool(
        locked.get("locked_at_activation")
    )
    refreshed["locked_at_armed"] = bool(locked.get("locked_at_armed"))
    refreshed["locked_at"] = locked.get("locked_at")
    refreshed["expiry_mode"] = locked.get("expiry_mode") or refreshed.get("expiry_mode")
    return refreshed


def _target_count(side: str, spot: float, targets: list[Any]) -> int:
    """Count reached targets in order for a long-call or long-put plan."""
    if side == "calls":
        return sum(1 for target in targets if _number(target) and spot >= float(target))
    return sum(1 for target in targets if _number(target) and spot <= float(target))


def _entry_not_extended(side: str, spot: float, trigger: Any, risk_dollars: Any) -> bool:
    """Allow a new entry only within 0.75R of its frozen underlying trigger."""
    if not (_number(trigger) and _number(risk_dollars)):
        return False
    move = float(spot) - float(trigger) if side == "calls" else float(trigger) - float(spot)
    return move <= float(risk_dollars) * 0.75


def _plan_quality(
    entry: Any,
    stop: Any,
    targets: list[Any],
    side: str,
    exit_target_number: int,
) -> dict[str, Any]:
    valid_targets = [float(target) for target in targets if _number(target)]
    if not (_number(entry) and _number(stop)) or not valid_targets:
        return {
            "available": False,
            "reward_risk": None,
            "minimum_reward_risk": MIN_PLAN_REWARD_RISK,
            "meets_minimum": False,
        }
    selected_index = min(max(1, int(exit_target_number)), len(valid_targets)) - 1
    entry_value = float(entry)
    stop_value = float(stop)
    selected_target = valid_targets[selected_index]
    risk = (
        stop_value - entry_value
        if side == "puts"
        else entry_value - stop_value
    )
    reward = (
        entry_value - selected_target
        if side == "puts"
        else selected_target - entry_value
    )
    reward_risk = reward / risk if risk > 0 and reward > 0 else None
    return {
        "available": reward_risk is not None,
        "entry": round(entry_value, 2),
        "stop": round(stop_value, 2),
        "target": round(selected_target, 2),
        "target_number": selected_index + 1,
        "risk_points": round(risk, 3) if risk > 0 else None,
        "reward_points": round(reward, 3) if reward > 0 else None,
        "reward_risk": round(reward_risk, 3) if reward_risk is not None else None,
        "minimum_reward_risk": MIN_PLAN_REWARD_RISK,
        "meets_minimum": bool(
            reward_risk is not None and reward_risk >= MIN_PLAN_REWARD_RISK
        ),
    }


def _estimated_option_stop_risk(
    option: dict[str, Any] | None,
    underlying_risk: Any,
) -> dict[str, Any] | None:
    option = option or {}
    premium = option.get("planned_limit_price") or option.get("ask") or option.get("mid")
    quantity = option.get("planned_contracts")
    if not (_number(premium) and float(premium) > 0 and _number(quantity) and int(quantity) > 0):
        return None
    debit_per_contract = float(premium) * 100
    delta = abs(float(option["delta"])) if _number(option.get("delta")) else None
    gamma = abs(float(option["gamma"])) if _number(option.get("gamma")) else 0.0
    if delta is not None and _number(underlying_risk) and float(underlying_risk) > 0:
        move = float(underlying_risk)
        modeled_premium_loss = delta * move + 0.5 * gamma * move * move
        buffered_premium_loss = modeled_premium_loss + float(premium) * 0.10
        loss_per_contract = min(debit_per_contract, buffered_premium_loss * 100)
        method = "delta_gamma_plus_10pct_premium_buffer"
    else:
        loss_per_contract = debit_per_contract * 0.40
        method = "40pct_debit_fallback"
    contracts = int(quantity)
    return {
        "method": method,
        "per_contract_dollars": round(loss_per_contract, 2),
        "total_dollars": round(loss_per_contract * contracts, 2),
        "contracts": contracts,
        "max_debit_dollars": round(debit_per_contract * contracts, 2),
    }


def _enrich_setup_quality(
    setup: dict[str, Any],
    side: str,
    exit_target_number: int,
) -> None:
    setup["plan_quality"] = _plan_quality(
        setup.get("trigger"),
        setup.get("invalidation"),
        list(setup.get("targets") or []),
        side,
        exit_target_number,
    )
    option = setup.get("option")
    if isinstance(option, dict):
        option["estimated_stop_risk"] = _estimated_option_stop_risk(
            option,
            setup.get("risk_dollars"),
        )


def _plan_quality_blocker(setup: dict[str, Any], side: str) -> str | None:
    quality = setup.get("plan_quality") or {}
    if quality.get("available") is not True:
        return f"{side} plan reward/risk is unavailable"
    if quality.get("meets_minimum") is not True:
        return (
            f"{side} plan reward/risk {float(quality.get('reward_risk') or 0):.2f}:1 "
            f"is below {MIN_PLAN_REWARD_RISK:.2f}:1"
        )
    return None


def _premium_lifecycle(
    previous: dict[str, Any] | None,
    option: dict[str, Any] | None,
    now: float,
    *,
    activate: bool = False,
) -> dict[str, Any] | None:
    """Track conservative alert-ask to live-bid paper outcomes for the locked contract."""
    option = option or {}
    prior = dict(previous or {})
    if activate:
        ask = option.get("ask")
        if not (_number(ask) and ask > 0):
            return None
        entry = float(ask)
        prior = {
            "entry_reference": round(entry, 3),
            "entry_source": "alert_ask",
            "target_10": round(entry * 1.10, 3),
            "target_20": round(entry * 1.20, 3),
            "activated_at": now,
            "hit_10_at": None,
            "hit_20_at": None,
            "max_bid": None,
            "min_bid": None,
        }
    if not prior:
        return None
    bid = option.get("bid")
    if _number(bid) and bid > 0:
        bid = float(bid)
        prior["last_bid"] = round(bid, 3)
        prior["max_bid"] = round(max(bid, float(prior.get("max_bid") or bid)), 3)
        prior["min_bid"] = round(min(bid, float(prior.get("min_bid") or bid)), 3)
        entry = prior.get("entry_reference")
        if _number(entry) and entry > 0:
            prior["return_pct"] = round((bid / float(entry) - 1) * 100, 1)
        if not prior.get("hit_10_at") and _number(prior.get("target_10")) and bid >= prior["target_10"]:
            prior["hit_10_at"] = now
        if not prior.get("hit_20_at") and _number(prior.get("target_20")) and bid >= prior["target_20"]:
            prior["hit_20_at"] = now
    return prior


def _apply_same_side_reentry_reset(
    result: dict[str, Any],
    *,
    side: str,
    now: float,
    indicators: dict[str, Any],
    cooldown_seconds: float,
) -> None:
    """Require time plus a new completed 5m reset after a protective or failed exit."""
    result.update(
        continuation_cooldown_until=now + cooldown_seconds,
        continuation_reset_after_bar=(
            indicators.get("last_completed_5m_at")
            or indicators.get("last_completed_at")
        ),
        continuation_reset_timeframe="5m",
        continuation_reset_side=side,
        continuation_reset_observed=False,
    )


def _preserve_open_tracking_during_data_block(
    previous_signal: dict[str, Any],
    result: dict[str, Any],
    *,
    now: float,
    blocker: str,
) -> dict[str, Any] | None:
    """Keep an open paper lifecycle intact while fresh pricing is unavailable."""
    lifecycle = previous_signal.get("lifecycle") or {}
    if (
        previous_signal.get("state") not in CONTINUATION_OPEN_STATES
        or previous_signal.get("favoring") not in {"calls", "puts"}
        or lifecycle.get("paper_position_open") is not True
    ):
        return None
    preserved = copy.deepcopy(previous_signal)
    preserved.update(
        generated_at=now,
        execution_enabled=False,
        engine_version=ENGINE_VERSION,
        gex=result.get("gex"),
        zerogex_shadow=result.get("zerogex_shadow"),
        zerogex_decision=result.get("zerogex_decision"),
        blockers=[blocker],
        warnings=[
            "paper lifecycle preserved, but tracking decisions are paused "
            "until fresh market data returns"
        ],
    )
    preserved_lifecycle = copy.deepcopy(lifecycle)
    preserved_lifecycle.update(
        entry_allowed=False,
        tracking_suspended=True,
        tracking_blocker=blocker,
        last_trusted_tracking_at=(
            lifecycle.get("last_trusted_tracking_at")
            or previous_signal.get("generated_at")
            or now
        ),
    )
    preserved["lifecycle"] = preserved_lifecycle
    return _dedupe_messages(preserved)


def _dedupe_messages(result: dict[str, Any]) -> dict[str, Any]:
    result["blockers"] = list(dict.fromkeys(str(item) for item in result.get("blockers") or []))
    result["warnings"] = list(dict.fromkeys(str(item) for item in result.get("warnings") or []))
    state = str(result.get("state") or "WAIT").upper()
    lifecycle = result.get("lifecycle") or {}
    lifecycle_status = str(lifecycle.get("status") or "").upper()
    targets_hit = int(lifecycle.get("targets_hit", 0) or 0)
    if lifecycle_status == "COMPLETED":
        phase = "COMPLETED"
    elif state == "FAILED":
        close_reason = lifecycle.get("close_reason")
        phase = (
            "SESSION_CLOSED"
            if close_reason == "end_of_day_flatten"
            else "TRACKING_ABORTED"
            if close_reason == "tracking_gap_abort"
            else "INVALIDATED"
        )
    elif lifecycle.get("tracking_suspended"):
        phase = "TRACKING_PAUSED"
    elif targets_hit >= 2 or state == "EXTENDED":
        phase = f"TARGET_{max(2, targets_hit)}_REACHED"
    elif targets_hit == 1 or state == "MANAGE":
        phase = "TARGET_1_REACHED"
    elif state == "ACTIVE":
        phase = "TRIGGERED"
    elif state in {"ARMED", "WATCH"}:
        phase = state
    elif result.get("favoring") == "no-trade":
        phase = "NO_TRADE"
    else:
        phase = "WAIT"
    result["signal_phase"] = phase
    favored_setup = (
        result.get("call_setup")
        if result.get("favoring") == "calls"
        else result.get("put_setup")
        if result.get("favoring") == "puts"
        else None
    ) or {}
    result["plan_quality"] = copy.deepcopy(favored_setup.get("plan_quality"))
    zero_gates = ((result.get("zerogex_decision") or {}).get("gates") or {})
    market_context = result.get("market_context") or {}
    atr_5m = market_context.get("atr_5m")
    candidate_arm_enter = (
        round(max(0.05, min(0.15, float(atr_5m) * 0.25)), 3)
        if _number(atr_5m)
        else None
    )
    candidate_arm_exit = (
        round(max(0.12, min(0.30, float(atr_5m) * 0.75)), 3)
        if _number(atr_5m)
        else None
    )
    result["decision_telemetry"] = {
        "version": "strategy-decision-v1",
        "state": state,
        "phase": phase,
        "favoring": result.get("favoring"),
        "confidence_score": result.get("confidence_score"),
        "market": {
            "spot": result.get("spot"),
            "vwap": market_context.get("vwap"),
            "rvol_1m": market_context.get("rvol_1m"),
            "atr_5m": atr_5m,
        },
        "thresholds": {
            "minimum_plan_reward_risk": MIN_PLAN_REWARD_RISK,
            "minimum_continuation_confidence": MIN_CONTINUATION_CONFIDENCE,
            "rvol_minimum": 1.2,
            "max_trigger_extension_r": 0.75,
            "arm_enter_dollars_current": ARM_ENTER_DISTANCE,
            "arm_exit_dollars_current": ARM_EXIT_DISTANCE,
            "arm_enter_dollars_atr_candidate": candidate_arm_enter,
            "arm_exit_dollars_atr_candidate": candidate_arm_exit,
        },
        "setups": {
            side: {
                "plan_quality": copy.deepcopy((result.get(f"{side[:-1]}_setup") or {}).get("plan_quality")),
                "continuation_quality": copy.deepcopy((result.get("continuation_quality") or {}).get(side)),
                "option": _journal_fields(
                    (result.get(f"{side[:-1]}_setup") or {}).get("option"),
                    (
                        "local_symbol", "delta", "gamma", "spread_pct",
                        "volume", "open_interest", "planned_contracts",
                        "planned_limit_price", "planned_total_debit",
                        "selection_score", "estimated_stop_risk",
                    ),
                ),
                "zerogex": {
                    "warnings": copy.deepcopy((zero_gates.get(side) or {}).get("warnings") or []),
                    "confirmations": copy.deepcopy((zero_gates.get(side) or {}).get("confirmations") or []),
                },
            }
            for side in ("calls", "puts")
        },
        "blockers": copy.deepcopy(result["blockers"]),
        "warnings": copy.deepcopy(result["warnings"]),
        "session": copy.deepcopy(result.get("session_policy")),
        "entry_structure_context": _compact_entry_structure_context(
            result.get("entry_structure_context")
        ),
        "trendline_context": _compact_trendline_context(
            result.get("trendline_context")
        ),
    }
    return result


def _option_eligible(option: dict[str, Any] | None) -> bool:
    return bool(option and option.get("eligible") is True)


def _option_blocker(option: dict[str, Any] | None, side: str) -> str:
    if not option:
        return f"no eligible {side} signal contract candidate"
    strike = option.get("target_strike")
    right = "P" if side == "put" else "C"
    reasons = ", ".join(option.get("rejection_reasons") or ["candidate is not eligible"])
    return f"{side} {strike if strike is not None else '-'}{right} rejected: {reasons}"


def _trend_direction(indicators: dict[str, Any], suffix: str) -> str:
    fast = indicators.get(f"ema9_{suffix}")
    slow = indicators.get(f"ema21_{suffix}")
    if not (_number(fast) and _number(slow)):
        return "unknown"
    if fast > slow:
        return "up"
    if fast < slow:
        return "down"
    return "flat"


def _atr_plan(entry: float, side: str, atr_5m: float) -> dict[str, Any]:
    risk = round(max(0.10, atr_5m * 1.5), 2)
    if side == "puts":
        stop = round(entry + risk, 2)
        targets = [round(entry - multiple * risk, 2) for multiple in (1.5, 2.5, 4.0)]
    else:
        stop = round(entry - risk, 2)
        targets = [round(entry + multiple * risk, 2) for multiple in (1.5, 2.5, 4.0)]
    return {
        "entry": round(entry, 2),
        "stop": stop,
        "risk_dollars": risk,
        "targets": targets,
        "method": "1.5x_5m_atr",
    }


def _continuation_atr_plan(entry: float, side: str, atr_5m: float) -> dict[str, Any]:
    """Volatility-scaled continuation risk with a smaller stop than MTF setups."""
    risk = round(max(0.15, atr_5m * 0.75), 2)
    if side == "puts":
        stop = round(entry + risk, 2)
        targets = [round(entry - multiple * risk, 2) for multiple in (1.5, 2.5, 4.0)]
    else:
        stop = round(entry - risk, 2)
        targets = [round(entry + multiple * risk, 2) for multiple in (1.5, 2.5, 4.0)]
    return {
        "entry": round(entry, 2),
        "stop": stop,
        "risk_dollars": risk,
        "targets": targets,
        "method": "0.75x_5m_atr",
    }


def _continuation_confidence(
    *,
    breakout: bool,
    trend_5m: bool,
    trend_15m: bool,
    cross_market: bool,
    use_cross_market: bool,
    vwap_aligned: bool,
    rvol: float,
    spot: float,
    trigger: float,
    channel_width: float,
    atr_5m: float,
    gamma_regime: str | None,
) -> dict[str, Any]:
    """Score continuation strength without changing the existing entry gates."""
    safe_atr = max(float(atr_5m), 0.01)
    channel_atr = max(0.0, float(channel_width)) / safe_atr
    trigger_distance_atr = abs(float(spot) - float(trigger)) / safe_atr
    components = {
        "completed_breakout": 20 if breakout else 0,
        "trend_5m": 10 if trend_5m else 0,
        "trend_15m": 15 if trend_15m else 0,
        "cross_market": 5 if use_cross_market and cross_market else 0,
        "vwap_alignment": 10 if vwap_aligned else 0,
        "volume_expansion": 15 if rvol >= 1.2 else 0,
        "strong_volume_bonus": 5 if rvol >= 1.5 else 0,
        "gex_trend_context": 10 if gamma_regime == "Trend" else 5 if gamma_regime == "Range" else 0,
        "channel_quality": min(10, round(channel_atr * 10)),
        "trigger_proximity": 5 if trigger_distance_atr <= 0.25 else 3 if trigger_distance_atr <= 0.50 else 1 if trigger_distance_atr <= 0.75 else 0,
    }
    maximum = 105 if use_cross_market else 100
    score = round(min(100, sum(components.values()) / maximum * 100))
    return {
        "score": score,
        "grade": "A+" if score >= 90 else "A" if score >= 70 else "B",
        "components": components,
        "channel_width_atr": round(channel_atr, 3),
        "trigger_distance_atr": round(trigger_distance_atr, 3),
        "gamma_regime": gamma_regime,
    }


def _nearest_heatmap_node(
    nodes: list[dict[str, Any]],
    spot: float,
    atr_5m: float,
) -> dict[str, Any] | None:
    valid = [
        node for node in nodes
        if _number(node.get("strike")) and _number(node.get("gex"))
    ]
    if not valid:
        return None
    node = min(valid, key=lambda item: abs(float(item["strike"]) - spot))
    distance_atr = abs(float(node["strike"]) - spot) / max(atr_5m, 0.01)
    max_magnitude = max(abs(float(item["gex"])) for item in valid)
    magnitude_ratio = (
        float(node.get("magnitude_ratio"))
        if _number(node.get("magnitude_ratio"))
        else abs(float(node["gex"])) / max_magnitude
    )
    return {
        **node,
        "distance_atr": round(distance_atr, 2),
        "magnitude_ratio": round(magnitude_ratio, 3),
        "trend": node.get("trend") or "stable",
    }


def _structure_plan(
    entry: float,
    side: str,
    atr_5m: float,
    stop_anchor: float,
    structural_levels: list[Any],
) -> dict[str, Any]:
    """Build a swing/GEX-anchored plan with ATR fallback targets."""
    minimum_risk = max(0.10, atr_5m * 0.50)
    if side == "calls":
        stop = min(stop_anchor, entry - minimum_risk)
    else:
        stop = max(stop_anchor, entry + minimum_risk)
    stop = round(stop, 2)
    risk = round(abs(entry - stop), 2)
    fallback = [
        entry + multiple * risk if side == "calls" else entry - multiple * risk
        for multiple in (1.0, 1.75, 2.75)
    ]
    favorable = [
        float(level) for level in structural_levels
        if _number(level)
        and (
            float(level) >= entry + risk * 0.75
            if side == "calls"
            else float(level) <= entry - risk * 0.75
        )
    ]
    targets = _blend_structural_targets(
        fallback,
        favorable,
        entry=entry,
        side=side,
        risk=risk,
    )
    return {
        "entry": round(entry, 2),
        "stop": stop,
        "risk_dollars": risk,
        "targets": targets,
        "method": "structure+0.15x_5m_atr_buffer",
    }


def _blend_structural_targets(
    fallback: list[float],
    structural_levels: list[Any],
    *,
    entry: float,
    side: str,
    risk: float,
) -> list[float]:
    """Snap ATR targets to nearby provider/session structure without chasing it."""
    favorable = sorted(
        {
            round(float(level), 2)
            for level in structural_levels
            if _number(level)
            and (
                float(level) >= entry + risk * 0.75
                if side == "calls"
                else float(level) <= entry - risk * 0.75
            )
        },
        reverse=side == "puts",
    )
    used: set[float] = set()
    blended = []
    tolerance = max(0.05, risk * 0.75)
    for fallback_level in fallback[:3]:
        available = [level for level in favorable if level not in used]
        nearest = (
            min(available, key=lambda level: abs(level - fallback_level))
            if available
            else None
        )
        selected = (
            nearest
            if nearest is not None
            and abs(nearest - fallback_level) <= tolerance
            else round(float(fallback_level), 2)
        )
        if nearest is not None and selected == nearest:
            used.add(nearest)
        blended.append(round(float(selected), 2))
    return sorted(set(blended), reverse=side == "puts")[:3]


def _gex_target_levels(gex_ctx: dict[str, Any]) -> list[Any]:
    heatmap = gex_ctx.get("heatmap") or {}
    call_wall = gex_ctx.get("call_wall") or {}
    put_wall = gex_ctx.get("put_wall") or {}
    session = gex_ctx.get("session_context") or {}
    session_levels = session.get("levels") or {}
    opening_range = session.get("opening_range") or {}
    forced_flow = gex_ctx.get("forced_flow") or {}
    return [
        *[
            node.get("strike")
            for node in [
                *(heatmap.get("positive_nodes") or []),
                *(heatmap.get("negative_nodes") or []),
            ]
            if node.get("trend") != "fading"
        ],
        heatmap.get("flip")
        if heatmap.get("fresh")
        else gex_ctx.get("flip"),
        call_wall.get("strike")
        if call_wall.get("stage") not in {"Delivered", "Spent"}
        else None,
        put_wall.get("strike")
        if put_wall.get("stage") not in {"Delivered", "Spent"}
        else None,
        session_levels.get("premarket_high"),
        session_levels.get("premarket_low"),
        session_levels.get("prev_session_high"),
        session_levels.get("prev_session_low"),
        opening_range.get("orb_high"),
        opening_range.get("orb_low"),
        forced_flow.get("zero_flow_level"),
    ]


def _mtf_reversal_candidate(
    spy: dict[str, Any],
    latest: dict[str, Any],
    spot: float,
    gex_ctx: dict[str, Any],
) -> dict[str, Any] | None:
    directions = {
        timeframe: _trend_direction(spy, timeframe)
        for timeframe in ("5m", "15m", "60m")
    }
    atr_5m = spy.get("atr_5m")
    vwap = spy.get("vwap")
    if not (_number(atr_5m) and _number(vwap)):
        return None

    bearish_bar = float(latest["close"]) < float(latest["open"])
    bullish_bar = float(latest["close"]) > float(latest["open"])
    negative_gex = gex_ctx.get("regime") == "Negative"
    positive_gex = gex_ctx.get("regime") == "Positive"
    trend_regime = gex_ctx.get("gamma_regime") == "Trend"
    ceiling_down = gex_ctx.get("rolling") == "CEILING_DOWN"
    floor_up = gex_ctx.get("rolling") == "FLOOR_UP"
    heatmap = gex_ctx.get("heatmap") or {}
    heatmap_fresh = heatmap.get("fresh") is True
    positive_node = _nearest_heatmap_node(
        heatmap.get("positive_nodes") or [], spot, float(atr_5m)
    ) if heatmap_fresh else None
    negative_node = _nearest_heatmap_node(
        heatmap.get("negative_nodes") or [], spot, float(atr_5m)
    ) if heatmap_fresh else None
    flip = heatmap.get("flip") if heatmap_fresh else gex_ctx.get("flip")
    migration = heatmap.get("dominant_migration") or {}
    migration_not_away = migration.get("toward_spot") is not False
    structural_levels = _gex_target_levels(gex_ctx)

    # A positive high-magnitude node can act like a trampoline. It becomes a
    # rejection setup only after the bar and 5m/15m structure turn away from it.
    if (
        positive_node
        and float(positive_node["distance_atr"]) <= 0.50
        and float(positive_node["magnitude_ratio"]) >= 0.50
        and positive_node.get("trend") != "fading"
        and migration_not_away
    ):
        node_strike = float(positive_node["strike"])
        node_below = node_strike <= spot
        node_above = node_strike >= spot
        call_touch_reject = (
            float(latest["low"]) <= node_strike + float(atr_5m) * 0.10
            and float(latest["close"]) >= node_strike + float(atr_5m) * 0.20
        )
        put_touch_reject = (
            float(latest["high"]) >= node_strike - float(atr_5m) * 0.10
            and float(latest["close"]) <= node_strike - float(atr_5m) * 0.20
        )
        rejection_score = 30
        rejection_side = None
        if (
            node_below
            and call_touch_reject
            and bullish_bar
            and directions["5m"] == directions["15m"] == "up"
            and spot > vwap
        ):
            rejection_side = "calls"
            rejection_score += 15 + 15 + 10
            rejection_score += 10 if positive_gex else 0
        elif (
            node_above
            and put_touch_reject
            and bearish_bar
            and directions["5m"] == directions["15m"] == "down"
            and spot < vwap
        ):
            rejection_side = "puts"
            rejection_score += 15 + 15 + 10
            rejection_score += 10 if positive_gex else 0
        if rejection_side:
            rejection_score += 5 if positive_node.get("trend") == "building" else 0
            rejection_score += 5 if migration.get("toward_spot") is True else 0
        if rejection_side and rejection_score >= 70:
            entry = round(
                float(latest["high"]) + 0.01
                if rejection_side == "calls"
                else float(latest["low"]) - 0.01,
                2,
            )
            return {
                "strategy": "GEX_REJECTION",
                "side": rejection_side,
                "score": rejection_score,
                "base_score": rejection_score,
                "quality": "HIGH" if rejection_score >= 80 else "MEDIUM",
                "timeframes": directions,
                "setup": (
                    f"fresh +GEX node {node_strike:g} rejected with 5m + 15m confirmation"
                ),
                "gex_alignment": {
                    "node": positive_node,
                    "flip": flip,
                    "heatmap_status": "fresh",
                },
                "a_plus": (
                    positive_gex
                    and rejection_score >= 80
                    and float(positive_node["magnitude_ratio"]) >= 0.50
                ),
                "risk_plan": _structure_plan(
                    entry,
                    rejection_side,
                    float(atr_5m),
                    (
                        min(node_strike, float(latest["low"])) - float(atr_5m) * 0.15
                        if rejection_side == "calls"
                        else max(node_strike, float(latest["high"])) + float(atr_5m) * 0.15
                    ),
                    structural_levels,
                ),
            }

    short_score = sum(
        (
            15 if directions["5m"] == "down" else 0,
            15 if directions["15m"] == "down" else 0,
            15 if directions["60m"] == "down" else 0,
            15 if spot < vwap else 0,
            10 if bearish_bar else 0,
            10 if negative_gex else 0,
            5 if trend_regime else 0,
            5 if ceiling_down else 0,
            5 if _number(flip) and spot < float(flip) else 0,
        )
    )
    long_score = sum(
        (
            15 if directions["5m"] == "up" else 0,
            15 if directions["15m"] == "up" else 0,
            15 if directions["60m"] == "up" else 0,
            15 if spot > vwap else 0,
            10 if bullish_bar else 0,
            10 if negative_gex else 0,
            5 if trend_regime else 0,
            5 if floor_up else 0,
            5 if _number(flip) and spot > float(flip) else 0,
        )
    )

    if short_score >= 70 and directions["5m"] == directions["15m"] == directions["60m"] == "down":
        entry = round(float(latest["low"]) - 0.01, 2)
        return {
            "strategy": "MTF_TREND_BREAK",
            "side": "puts",
            "score": short_score,
            "base_score": short_score,
            "quality": "HIGH" if short_score >= 80 else "MEDIUM",
            "timeframes": directions,
            "setup": "5m + 15m aligned breakdown with 1h downtrend",
            "gex_alignment": {
                "node": negative_node,
                "flip": flip,
                "heatmap_status": "fresh" if heatmap_fresh else "unavailable",
            },
            "a_plus": bool(
                negative_node
                and float(negative_node["distance_atr"]) <= 0.50
                and float(negative_node["magnitude_ratio"]) >= 0.50
                and negative_node.get("trend") != "fading"
                and migration_not_away
                and negative_gex
                and (_number(flip) and spot < float(flip))
            ),
            "risk_plan": _structure_plan(
                entry,
                "puts",
                float(atr_5m),
                float(latest["high"]) + float(atr_5m) * 0.15,
                structural_levels,
            ),
        }
    if long_score >= 70 and directions["5m"] == directions["15m"] == directions["60m"] == "up":
        entry = round(float(latest["high"]) + 0.01, 2)
        return {
            "strategy": "MTF_TREND_BREAK",
            "side": "calls",
            "score": long_score,
            "base_score": long_score,
            "quality": "HIGH" if long_score >= 80 else "MEDIUM",
            "timeframes": directions,
            "setup": "5m + 15m aligned breakout with 1h uptrend",
            "gex_alignment": {
                "node": negative_node,
                "flip": flip,
                "heatmap_status": "fresh" if heatmap_fresh else "unavailable",
            },
            "a_plus": bool(
                negative_node
                and float(negative_node["distance_atr"]) <= 0.50
                and float(negative_node["magnitude_ratio"]) >= 0.50
                and negative_node.get("trend") != "fading"
                and migration_not_away
                and negative_gex
                and (_number(flip) and spot > float(flip))
            ),
            "risk_plan": _structure_plan(
                entry,
                "calls",
                float(atr_5m),
                float(latest["low"]) - float(atr_5m) * 0.15,
                structural_levels,
            ),
        }
    return None


def _frozen_reversal(previous_signal: dict[str, Any], now: float, spot: float) -> dict[str, Any] | None:
    setup = previous_signal.get("reversal_setup") or {}
    plan = setup.get("risk_plan") or {}
    active_position = (
        previous_signal.get("strategy") in FROZEN_SETUP_STRATEGIES
        and previous_signal.get("state") in CONTINUATION_OPEN_STATES
    )
    if setup.get("strategy") not in FROZEN_SETUP_STRATEGIES or (
        not active_position and float(setup.get("frozen_until", 0)) < now
    ):
        return None
    side = setup.get("side")
    stop = plan.get("stop")
    final_target = (plan.get("targets") or [None])[-1]
    invalidated = (side == "puts" and _number(stop) and spot >= stop) or (
        side == "calls" and _number(stop) and spot <= stop
    )
    completed = (side == "puts" and _number(final_target) and spot <= final_target) or (
        side == "calls" and _number(final_target) and spot >= final_target
    )
    return None if invalidated or completed else setup


def build_signal(
    market: dict[str, Any],
    indicators: dict[str, dict[str, Any]],
    options: dict[str, Any],
    gex: dict[str, Any] | None,
    stale_after: float = 5,
    previous_signal: dict[str, Any] | None = None,
    heatmap: dict[str, Any] | None = None,
    zerogex: dict[str, Any] | None = None,
    zerogex_role: str = "shadow",
    zerogex_features: dict[str, bool] | None = None,
    zerogex_minute_bucket_grace_seconds: float = (
        ZEROGEX_MINUTE_BUCKET_GRACE_SECONDS
    ),
    paper_exit_target: int = 2,
    same_side_reentry_cooldown_seconds: float = CONTINUATION_COOLDOWN_SECONDS,
    max_tracking_gap_seconds: float = MAX_ACTIVE_TRACKING_GAP_SECONDS,
    t1_move_invalidation_to_trigger: bool = True,
    t1_premium_lock_arm_pct: float = 20.0,
    t1_premium_lock_floor_pct: float = 10.0,
    option_max_total_debit_dollars: float = 0,
    option_preferred_contracts: int = 1,
    option_limit_price_offset: float = 0,
    option_max_otm_steps: int = 3,
    option_min_abs_delta: float = 0.15,
    option_max_spread_pct: float = MAX_OPTION_SPREAD_PCT,
    session_policy: dict[str, Any] | None = None,
    trendline_structure: dict[str, Any] | None = None,
) -> dict[str, Any]:
    trendline_config = validate_trendline_structure_config(
        trendline_structure
    )
    if (
        isinstance(paper_exit_target, bool)
        or not isinstance(paper_exit_target, int)
        or paper_exit_target not in {1, 2, 3}
    ):
        raise ValueError("paper_exit_target must be 1, 2, or 3")
    if (
        isinstance(same_side_reentry_cooldown_seconds, bool)
        or not _number(same_side_reentry_cooldown_seconds)
        or same_side_reentry_cooldown_seconds < 60
    ):
        raise ValueError("same_side_reentry_cooldown_seconds must be at least 60")
    if (
        isinstance(max_tracking_gap_seconds, bool)
        or not _number(max_tracking_gap_seconds)
        or max_tracking_gap_seconds < 5
    ):
        raise ValueError("max_tracking_gap_seconds must be at least 5")
    if not isinstance(t1_move_invalidation_to_trigger, bool):
        raise ValueError("t1_move_invalidation_to_trigger must be true or false")
    if (
        isinstance(zerogex_minute_bucket_grace_seconds, bool)
        or not _number(zerogex_minute_bucket_grace_seconds)
        or not 0 <= zerogex_minute_bucket_grace_seconds <= 60
    ):
        raise ValueError(
            "zerogex_minute_bucket_grace_seconds must be between 0 and 60"
        )
    if (
        not _number(t1_premium_lock_arm_pct)
        or not _number(t1_premium_lock_floor_pct)
        or t1_premium_lock_floor_pct < 0
        or t1_premium_lock_floor_pct >= t1_premium_lock_arm_pct
    ):
        raise ValueError(
            "t1 premium lock floor must be non-negative and below its arm level"
        )
    if (
        isinstance(option_max_total_debit_dollars, bool)
        or _number(option_max_total_debit_dollars) is None
        or option_max_total_debit_dollars < 0
    ):
        raise ValueError("option max total debit dollars must be non-negative")
    if (
        isinstance(option_preferred_contracts, bool)
        or not isinstance(option_preferred_contracts, int)
        or not 1 <= option_preferred_contracts <= 5
    ):
        raise ValueError("option preferred contracts must be between 1 and 5")
    if (
        isinstance(option_max_otm_steps, bool)
        or not isinstance(option_max_otm_steps, int)
        or not 1 <= option_max_otm_steps <= 10
    ):
        raise ValueError("option max OTM steps must be between 1 and 10")
    if (
        isinstance(option_min_abs_delta, bool)
        or not _number(option_min_abs_delta)
        or not 0.05 <= option_min_abs_delta <= 0.65
    ):
        raise ValueError("option minimum absolute delta must be between 0.05 and 0.65")
    if (
        isinstance(option_max_spread_pct, bool)
        or not _number(option_max_spread_pct)
        or not 0.1 <= option_max_spread_pct <= 20
    ):
        raise ValueError("option maximum spread percent must be between 0.1 and 20")
    if (
        isinstance(option_limit_price_offset, bool)
        or _number(option_limit_price_offset) is None
        or not 0 <= option_limit_price_offset <= 1
    ):
        raise ValueError("option limit price offset must be between 0 and 1")
    now = time.time()
    session = _session_policy(now, session_policy)
    previous_signal = previous_signal or {}
    spy_market = (market.get("symbols") or {}).get("SPY") or {}
    qqq_market = (market.get("symbols") or {}).get("QQQ") or {}
    use_qqq = "QQQ" in (market.get("symbols") or {})
    spy_bars = spy_market.get("bars") or []
    completed = _completed_bars(_session_bars(spy_bars, now=now))
    entry_structure_context = calculate_entry_structure_context(completed)
    if trendline_config["enabled"]:
        trendline_context = calculate_trendline_context(
            completed,
            length=trendline_config["length"],
            slope_multiplier=trendline_config["slope_multiplier"],
            slope_method=trendline_config["slope_method"],
            previous_context=previous_signal.get("trendline_context"),
            retest_window_bars=trendline_config["retest_window_bars"],
        )
        trendline_context.pop("_calculation_state", None)
    else:
        trendline_context = _empty_trendline_context(
            length=trendline_config["length"],
            slope_method=trendline_config["slope_method"],
            slope_multiplier=trendline_config["slope_multiplier"],
            retest_window_bars=trendline_config["retest_window_bars"],
            reason="disabled_by_runtime_config",
        )
    spy = indicators.get("SPY") or {}
    qqq = indicators.get("QQQ") or {}
    spot = spy_market.get("spot")
    market_age = now - float(market.get("generated_at", 0))
    quote_age = spy_market.get("quote_age_seconds")
    qqq_quote_age = qqq_market.get("quote_age_seconds")
    gex_ctx = _gex_context(gex, heatmap)
    entry_structure_context["gex_range"] = calculate_gex_range_context(
        spot,
        atr_5m=spy.get("atr_5m"),
        gex_context=gex_ctx,
    )
    zerogex_ctx = _zerogex_context(
        zerogex,
        gex_ctx,
        spot,
        now=now,
        role=zerogex_role,
        minute_bucket_grace_seconds=(
            zerogex_minute_bucket_grace_seconds
        ),
    )
    feature_policy = {
        "structure_context": True,
        "flow_context": True,
        "session_levels": True,
        "late_day_forced_flow": True,
        **(zerogex_features or {}),
    }
    feature_fields = {
        "structure_context": ("strike_context",),
        "flow_context": ("flow_context",),
        "session_levels": ("session_context",),
        "late_day_forced_flow": ("dealer_hedging", "forced_flow"),
    }
    for feature, fields in feature_fields.items():
        if feature_policy.get(feature) is not False:
            continue
        for field in fields:
            zerogex_ctx[field] = {}
            if isinstance(zerogex_ctx.get("data_freshness"), dict):
                zerogex_ctx["data_freshness"][field] = {
                    "fresh": False,
                    "reason": "disabled_by_runtime_config",
                }
    zerogex_ctx["feature_policy"] = feature_policy
    _apply_zerogex_primary_structure(gex_ctx, zerogex_ctx, now=now)
    zerogex_decision = _zerogex_decision_context(zerogex_ctx, now=now)

    result: dict[str, Any] = {
        "generated_at": now,
        "source": "deterministic-signal-engine",
        "engine_version": ENGINE_VERSION,
        "execution_enabled": False,
        "paper_policy": {
            "exit_after_target": paper_exit_target,
            "same_side_reentry_cooldown_seconds":
                same_side_reentry_cooldown_seconds,
            "max_tracking_gap_seconds": max_tracking_gap_seconds,
            "t1_move_invalidation_to_trigger":
                t1_move_invalidation_to_trigger,
            "t1_premium_lock_arm_pct": t1_premium_lock_arm_pct,
            "t1_premium_lock_floor_pct": t1_premium_lock_floor_pct,
        },
        "session_policy": session,
        "confirmation_mode": "SPY_QQQ" if use_qqq else "SPY_ONLY",
        "state": "WAIT",
        "signal_phase": "NO_TRADE",
        "favoring": "no-trade",
        "spot": spot,
        "blockers": [],
        "warnings": [],
        "confirmations": [],
        "entry_structure_context": entry_structure_context,
        "trendline_context": trendline_context,
        "gex": gex_ctx,
        "zerogex_shadow": zerogex_ctx,
        "zerogex_decision": zerogex_decision,
    }
    applied_zerogex_context: set[str] = set()

    def apply_zerogex_context(side: str) -> None:
        if side in applied_zerogex_context:
            return
        applied_zerogex_context.add(side)
        gate = (zerogex_decision.get("gates") or {}).get(side) or {}
        result["warnings"].extend(gate.get("warnings") or [])
        result["confirmations"].extend(gate.get("confirmations") or [])
    if (
        not _number(spot)
        or market_age > stale_after
        or (_number(quote_age) and quote_age > stale_after)
    ):
        blocker = "stale or missing IBKR market data"
        preserved = _preserve_open_tracking_during_data_block(
            previous_signal,
            result,
            now=now,
            blocker=blocker,
        )
        if preserved is not None:
            preserved["entry_structure_context"] = entry_structure_context
            preserved["trendline_context"] = trendline_context
            return _dedupe_messages(preserved)
        result["blockers"].append(blocker)
        return _dedupe_messages(result)
    if len(completed) < 22 or not _number(spy.get("vwap")):
        blocker = "insufficient completed intraday bars"
        preserved = _preserve_open_tracking_during_data_block(
            previous_signal,
            result,
            now=now,
            blocker=blocker,
        )
        if preserved is not None:
            preserved["entry_structure_context"] = entry_structure_context
            preserved["trendline_context"] = trendline_context
            return _dedupe_messages(preserved)
        result["blockers"].append(blocker)
        return _dedupe_messages(result)

    previous_lifecycle_for_latch = previous_signal.get("lifecycle") or {}
    previous_terminal_status = str(previous_lifecycle_for_latch.get("status") or "").upper()
    previous_closed_at = previous_lifecycle_for_latch.get("closed_at")
    if (
        previous_terminal_status in {"FAILED", "COMPLETED"}
        and _number(previous_closed_at)
        and now - float(previous_closed_at) <= TERMINAL_SIGNAL_LATCH_SECONDS
    ):
        latched_terminal = copy.deepcopy(previous_signal)
        latched_terminal.update(
            generated_at=now,
            spot=spot,
            gex=gex_ctx,
            zerogex_shadow=zerogex_ctx,
            entry_structure_context=entry_structure_context,
            trendline_context=trendline_context,
            execution_enabled=False,
            engine_version=ENGINE_VERSION,
        )
        return _dedupe_messages(latched_terminal)

    hard_data_block = False
    regular_session_open = _regular_session_open(now, session)
    if not regular_session_open:
        result["blockers"].append(
            session["reason"]
            or "US equities regular session is closed"
        )
        hard_data_block = True
    elif not _new_entry_window_open(now, session):
        result["blockers"].append(
            "end-of-day signal cutoff reached "
            f"({_format_et_minute(session['entry_cutoff_minute_et'])}); "
            "new activations are prohibited"
        )
        hard_data_block = True
    if use_qqq and (
        not _number(qqq_market.get("spot"))
        or not _number(qqq_quote_age)
        or qqq_quote_age > stale_after
    ):
        result["blockers"].append("QQQ live quote missing or stale")
        hard_data_block = True
    if regular_session_open and (
        not _number(spy.get("completed_bar_age_seconds"))
        or spy["completed_bar_age_seconds"] > 125
    ):
        result["blockers"].append("SPY one-minute bars stale")
        hard_data_block = True
    if regular_session_open and use_qqq and (
        not _number(qqq.get("completed_bar_age_seconds"))
        or qqq["completed_bar_age_seconds"] > 125
    ):
        result["blockers"].append("QQQ one-minute bars stale")
        hard_data_block = True

    base = completed[-7:-1]
    latest = completed[-1]
    raw_call_trigger = round(max(float(bar["high"]) for bar in base), 2)
    raw_put_trigger = round(min(float(bar["low"]) for bar in base), 2)
    latest_close = float(latest["close"])
    rvol = spy.get("rvol") or 0
    spy_up = spy.get("ema9_5m") and spy.get("ema21_5m") and spy["ema9_5m"] > spy["ema21_5m"]
    spy_down = spy.get("ema9_5m") and spy.get("ema21_5m") and spy["ema9_5m"] < spy["ema21_5m"]
    spy_up_15m = (
        spy.get("ema9_15m") and spy.get("ema21_15m")
        and spy["ema9_15m"] > spy["ema21_15m"]
    )
    spy_down_15m = (
        spy.get("ema9_15m") and spy.get("ema21_15m")
        and spy["ema9_15m"] < spy["ema21_15m"]
    )
    qqq_up = (not use_qqq) or (
        qqq.get("ema9_5m") and qqq.get("ema21_5m") and qqq["ema9_5m"] > qqq["ema21_5m"]
    )
    qqq_down = (not use_qqq) or (
        qqq.get("ema9_5m") and qqq.get("ema21_5m") and qqq["ema9_5m"] < qqq["ema21_5m"]
    )
    above_vwap = spot > spy["vwap"]
    below_vwap = spot < spy["vwap"]
    volume_ok = rvol >= 1.2
    call_break = latest_close > raw_call_trigger
    put_break = latest_close < raw_put_trigger
    failure_side = previous_signal.get("same_side_failure_side")
    failure_count = int(previous_signal.get("same_side_failure_count", 0) or 0)
    failure_last_at = float(previous_signal.get("same_side_failure_last_at", 0) or 0)
    failure_reset_required = bool(previous_signal.get("same_side_15m_reset_required"))
    failure_reset_after_bar = float(
        previous_signal.get("same_side_failure_reset_after_bar", 0)
        or failure_last_at
        or 0
    )
    if failure_last_at and now - failure_last_at > SAME_SIDE_FAILURE_WINDOW_SECONDS:
        failure_side, failure_count, failure_last_at, failure_reset_required = None, 0, 0.0, False
    previous_position_open_for_reset = (
        previous_signal.get("state") in CONTINUATION_OPEN_STATES
        and previous_signal.get("favoring") in {"calls", "puts"}
    )
    reset_aligned = (failure_side == "calls" and spy_up_15m) or (
        failure_side == "puts" and spy_down_15m
    )
    last_completed_15m_at = float(spy.get("last_completed_15m_at", 0) or 0)
    if (
        failure_reset_required
        and reset_aligned
        and not previous_position_open_for_reset
        and last_completed_15m_at > failure_reset_after_bar
    ):
        (
            failure_side,
            failure_count,
            failure_last_at,
            failure_reset_required,
            failure_reset_after_bar,
        ) = (None, 0, 0.0, False, 0.0)
    if failure_count:
        result.update(
            same_side_failure_side=failure_side,
            same_side_failure_count=failure_count,
            same_side_failure_last_at=failure_last_at,
            same_side_15m_reset_required=failure_reset_required,
            same_side_failure_reset_after_bar=failure_reset_after_bar,
        )
    failure_blocks_calls = failure_reset_required and failure_side == "calls"
    failure_blocks_puts = failure_reset_required and failure_side == "puts"
    call_confirmed = (
        call_break and spy_up and spy_up_15m and qqq_up and above_vwap and volume_ok
        and not hard_data_block and not failure_blocks_calls
    )
    put_confirmed = (
        put_break and spy_down and spy_down_15m and qqq_down and below_vwap and volume_ok
        and not hard_data_block and not failure_blocks_puts
    )

    result["market_context"] = {
        "vwap": spy.get("vwap"),
        "rvol_1m": spy.get("rvol"),
        "rvol_method": spy.get("rvol_method"),
        "rvol_reference_samples": spy.get("rvol_reference_samples"),
        "ema9_1m": spy.get("ema9"),
        "ema21_1m": spy.get("ema21"),
        "atr_5m": spy.get("atr_5m"),
        "ema9_5m": spy.get("ema9_5m"),
        "ema21_5m": spy.get("ema21_5m"),
        "last_completed_5m_at": spy.get("last_completed_5m_at"),
        "last_close_5m": spy.get("last_close_5m"),
        "ema9_15m": spy.get("ema9_15m"),
        "ema21_15m": spy.get("ema21_15m"),
        "last_completed_15m_at": spy.get("last_completed_15m_at"),
        "ema9_60m": spy.get("ema9_60m"),
        "ema21_60m": spy.get("ema21_60m"),
    }

    call_trigger = raw_call_trigger
    put_trigger = raw_put_trigger
    call_status = "ready"
    put_status = "ready"
    if call_break and not call_confirmed:
        call_trigger = round(max(float(bar["high"]) for bar in completed[-2:]) + 0.01, 2)
        call_status = "reset_after_unconfirmed_cross"
    if put_break and not put_confirmed:
        put_trigger = round(min(float(bar["low"]) for bar in completed[-2:]) - 0.01, 2)
        put_status = "reset_after_unconfirmed_cross"

    atr_5m = float(spy["atr_5m"]) if _number(spy.get("atr_5m")) else 0.20
    call_risk = _continuation_atr_plan(call_trigger, "calls", atr_5m)
    put_risk = _continuation_atr_plan(put_trigger, "puts", atr_5m)
    channel_width = max(0.0, raw_call_trigger - raw_put_trigger)
    call_continuation_quality = _continuation_confidence(
        breakout=bool(call_break),
        trend_5m=bool(spy_up),
        trend_15m=bool(spy_up_15m),
        cross_market=bool(qqq_up),
        use_cross_market=use_qqq,
        vwap_aligned=bool(above_vwap),
        rvol=float(rvol),
        spot=float(spot),
        trigger=float(call_trigger),
        channel_width=channel_width,
        atr_5m=atr_5m,
        gamma_regime=gex_ctx.get("gamma_regime"),
    )
    put_continuation_quality = _continuation_confidence(
        breakout=bool(put_break),
        trend_5m=bool(spy_down),
        trend_15m=bool(spy_down_15m),
        cross_market=bool(qqq_down),
        use_cross_market=use_qqq,
        vwap_aligned=bool(below_vwap),
        rvol=float(rvol),
        spot=float(spot),
        trigger=float(put_trigger),
        channel_width=channel_width,
        atr_5m=atr_5m,
        gamma_regime=gex_ctx.get("gamma_regime"),
    )
    result["continuation_quality"] = {
        "calls": call_continuation_quality,
        "puts": put_continuation_quality,
    }
    call_targets = list(call_risk["targets"])
    put_targets = list(put_risk["targets"])
    structural_levels = _gex_target_levels(gex_ctx)
    call_targets = _blend_structural_targets(
        call_targets,
        structural_levels,
        entry=call_trigger,
        side="calls",
        risk=float(call_risk["risk_dollars"]),
    )
    put_targets = _blend_structural_targets(
        put_targets,
        structural_levels,
        entry=put_trigger,
        side="puts",
        risk=float(put_risk["risk_dollars"]),
    )

    retain_pre_entry_options = previous_signal.get("state") in {"WAIT", "WATCH", "ARMED"}
    previous_call_option = (
        ((previous_signal.get("call_setup") or {}).get("option"))
        if retain_pre_entry_options
        else None
    )
    previous_put_option = (
        ((previous_signal.get("put_setup") or {}).get("option"))
        if retain_pre_entry_options
        else None
    )
    option_policy = {
        "max_total_debit_dollars":
            float(option_max_total_debit_dollars),
        "preferred_contracts": option_preferred_contracts,
        "limit_price_offset": float(option_limit_price_offset),
        "max_otm_steps": option_max_otm_steps,
        "min_abs_delta": float(option_min_abs_delta),
        "max_spread_pct": float(option_max_spread_pct),
    }

    def select_pre_entry_option(
        right: str,
        side: str,
        previous_option: dict[str, Any] | None,
    ) -> dict[str, Any] | None:
        if (
            previous_signal.get("state") == "ARMED"
            and previous_signal.get("favoring") == side
            and previous_option
        ):
            locked = dict(previous_option)
            locked["locked_at_armed"] = True
            locked.setdefault("locked_at", previous_signal.get("generated_at"))
            return _refresh_locked_option(
                options,
                locked,
                max_total_debit_dollars=option_policy[
                    "max_total_debit_dollars"
                ],
                preferred_contracts=option_policy["preferred_contracts"],
                limit_price_offset=option_policy["limit_price_offset"],
                min_abs_delta=option_policy["min_abs_delta"],
                max_spread_pct=option_policy["max_spread_pct"],
            )
        return _select_signal_option(
            options,
            right,
            float(spot),
            preferred=previous_option,
            **option_policy,
        )

    result["call_setup"] = {
        "status": call_status,
        "trigger": call_trigger,
        "invalidation": call_risk["stop"],
        "targets": sorted(set(call_targets))[:3],
        "risk_method": call_risk["method"],
        "risk_dollars": call_risk["risk_dollars"],
        "option": select_pre_entry_option(
            "C",
            "calls",
            previous_call_option,
        ),
    }
    result["put_setup"] = {
        "status": put_status,
        "trigger": put_trigger,
        "invalidation": put_risk["stop"],
        "targets": sorted(set(put_targets), reverse=True)[:3],
        "risk_method": put_risk["method"],
        "risk_dollars": put_risk["risk_dollars"],
        "option": select_pre_entry_option(
            "P",
            "puts",
            previous_put_option,
        ),
    }
    _enrich_setup_quality(result["call_setup"], "calls", paper_exit_target)
    _enrich_setup_quality(result["put_setup"], "puts", paper_exit_target)

    previous_reversal = previous_signal.get("reversal_setup") or {}
    previous_plan = previous_reversal.get("risk_plan") or {}
    previous_reversal_side = previous_reversal.get("side")
    previous_stop = previous_plan.get("stop")
    previous_final_target = (previous_plan.get("targets") or [None])[-1]
    prior_reversal_invalidated = (
        previous_reversal_side == "puts" and _number(previous_stop) and spot >= previous_stop
    ) or (
        previous_reversal_side == "calls" and _number(previous_stop) and spot <= previous_stop
    )
    prior_reversal_completed = (
        previous_reversal_side == "puts"
        and _number(previous_final_target)
        and spot <= previous_final_target
    ) or (
        previous_reversal_side == "calls"
        and _number(previous_final_target)
        and spot >= previous_final_target
    )
    cooldown_until = float(previous_signal.get("reversal_cooldown_until", 0) or 0)
    if previous_reversal and (prior_reversal_invalidated or prior_reversal_completed):
        cooldown_until = max(cooldown_until, now + 15 * 60)
    if cooldown_until > now:
        result["reversal_cooldown_until"] = cooldown_until

    reversal = None if cooldown_until > now else _frozen_reversal(previous_signal, now, float(spot))
    if reversal is None and cooldown_until <= now:
        reversal = _mtf_reversal_candidate(spy, latest, float(spot), gex_ctx)
        if reversal:
            reversal["armed_at"] = now
            reversal["frozen_until"] = now + 15 * 60
    if reversal:
        reversal["score"] = int(reversal.get("base_score", reversal["score"]))
        if gex_ctx.get("vix_gamma_regime") == "Whipsaw":
            reversal["score"] = max(0, int(reversal["score"]) - 10)
            result["warnings"].append("VIX gamma regime is Whipsaw; require stronger confirmation")
        if not volume_ok:
            reversal["score"] = max(0, int(reversal["score"]) - 5)
            result["warnings"].append(f"1m RVOL {rvol:.2f} below 1.20; wait for trigger-bar expansion")
        continuing_reversal = (
            previous_signal.get("strategy") in FROZEN_SETUP_STRATEGIES
            and previous_signal.get("state") in {*WATCH_STATES, *CONTINUATION_OPEN_STATES}
            and bool(previous_reversal)
        )
        if reversal["score"] < 70 and not continuing_reversal:
            result["warnings"].append(
                f"{reversal.get('strategy', 'frozen setup')} score "
                f"{reversal['score']}/100 is below 70 after risk penalties"
            )
            reversal = None
        else:
            reversal["quality"] = "HIGH" if reversal["score"] >= 80 else "MEDIUM"
            result["reversal_setup"] = reversal

    previous_side = previous_signal.get("favoring")
    previous_setup = previous_signal.get("call_setup") if previous_side == "calls" else previous_signal.get("put_setup")
    previous_lifecycle = previous_signal.get("lifecycle") or {}
    previous_strategy = previous_signal.get("strategy")
    previous_invalidation = (previous_setup or {}).get("invalidation")
    prior_position_open = (
        previous_signal.get("state") in CONTINUATION_OPEN_STATES
        and previous_side in {"calls", "puts"}
    )
    continuation_targets = list((previous_setup or {}).get("targets") or [])
    targets_hit = max(
        int(previous_lifecycle.get("targets_hit", 0) or 0),
        _target_count(str(previous_side), float(spot), continuation_targets)
        if prior_position_open
        else 0,
    )
    refreshed_position_option = (
        _refresh_locked_option(
            options,
            (previous_setup or {}).get("option"),
            max_total_debit_dollars=option_policy[
                "max_total_debit_dollars"
            ],
            preferred_contracts=option_policy["preferred_contracts"],
            limit_price_offset=option_policy["limit_price_offset"],
            min_abs_delta=option_policy["min_abs_delta"],
            max_spread_pct=option_policy["max_spread_pct"],
        )
        if prior_position_open
        else None
    )
    premium = _premium_lifecycle(
        previous_lifecycle.get("premium"), refreshed_position_option, now
    ) if prior_position_open else None
    last_trusted_tracking_at = (
        previous_lifecycle.get("last_trusted_tracking_at")
        or previous_signal.get("generated_at")
    )
    processing_gap_seconds = (
        now - float(last_trusted_tracking_at)
        if prior_position_open and _number(last_trusted_tracking_at)
        else 0.0
    )
    if prior_position_open and processing_gap_seconds > max_tracking_gap_seconds:
        gap_setup = (
            result["call_setup"]
            if previous_side == "calls"
            else result["put_setup"]
        )
        gap_setup.update(
            status="tracking_gap_abort",
            trigger=(previous_setup or {}).get("trigger"),
            invalidation=(previous_setup or {}).get("invalidation"),
            targets=continuation_targets,
            risk_method=(previous_setup or {}).get(
                "risk_method",
                "legacy_fixed",
            ),
            risk_dollars=(previous_setup or {}).get("risk_dollars"),
            option=refreshed_position_option,
        )
        result.update(
            state="FAILED",
            favoring="no-trade",
            strategy=previous_strategy,
            reversal_setup=(
                previous_reversal
                if previous_strategy in FROZEN_SETUP_STRATEGIES
                else None
            ),
            lifecycle={
                "status": "FAILED",
                "close_reason": "tracking_gap_abort",
                "activated_at": previous_lifecycle.get("activated_at"),
                "targets_hit": targets_hit,
                "entry_allowed": False,
                "paper_position_open": False,
                "closed_at": now,
                "tracking_gap_seconds": round(processing_gap_seconds, 1),
                "last_trusted_tracking_at": last_trusted_tracking_at,
                "premium": premium,
            },
        )
        _apply_same_side_reentry_reset(
            result,
            side=str(previous_side),
            now=now,
            indicators=spy,
            cooldown_seconds=float(same_side_reentry_cooldown_seconds),
        )
        if previous_strategy in FROZEN_SETUP_STRATEGIES:
            result["reversal_cooldown_until"] = max(
                cooldown_until,
                now + float(same_side_reentry_cooldown_seconds),
            )
        result["blockers"] = [
            f"paper tracking gap {processing_gap_seconds:.1f}s exceeded "
            f"{max_tracking_gap_seconds:g}s; stale lifecycle closed"
        ]
        return _dedupe_messages(result)
    if prior_position_open and _mandatory_flatten_due(now, session):
        timed_exit_setup = result["call_setup"] if previous_side == "calls" else result["put_setup"]
        timed_exit_setup.update(
            status="time_exit",
            trigger=(previous_setup or {}).get("trigger"),
            invalidation=(previous_setup or {}).get("invalidation"),
            targets=continuation_targets,
            risk_method=(previous_setup or {}).get("risk_method", "legacy_fixed"),
            risk_dollars=(previous_setup or {}).get("risk_dollars"),
            option=refreshed_position_option,
        )
        result.update(
            state="FAILED",
            favoring="no-trade",
            strategy=previous_strategy,
            reversal_setup=previous_reversal if previous_strategy in FROZEN_SETUP_STRATEGIES else None,
            lifecycle={
                "status": "FAILED",
                "close_reason": "end_of_day_flatten",
                "activated_at": previous_lifecycle.get("activated_at"),
                "targets_hit": targets_hit,
                "entry_allowed": False,
                "paper_position_open": False,
                "closed_at": now,
                "premium": premium,
            },
        )
        result["blockers"] = [
            "signal tracking ended at the mandatory "
            f"{_format_et_minute(session['flatten_minute_et'])} cutoff; "
            "no overnight signal"
        ]
        return _dedupe_messages(result)
    t1_protection_active = bool(prior_position_open and targets_hit >= 1)
    frozen_trigger = (previous_setup or {}).get("trigger")
    protected_invalidation = previous_invalidation
    if (
        t1_protection_active
        and t1_move_invalidation_to_trigger
        and _number(frozen_trigger)
    ):
        protected_invalidation = (
            max(float(previous_invalidation), float(frozen_trigger))
            if previous_side == "calls" and _number(previous_invalidation)
            else min(float(previous_invalidation), float(frozen_trigger))
            if previous_side == "puts" and _number(previous_invalidation)
            else float(frozen_trigger)
        )
    premium_lock_armed = False
    premium_floor_breached = False
    if t1_protection_active and isinstance(premium, dict):
        entry_reference = premium.get("entry_reference")
        max_bid = premium.get("max_bid")
        return_pct = premium.get("return_pct")
        if _number(entry_reference) and entry_reference > 0 and _number(max_bid):
            max_return_pct = (
                float(max_bid) / float(entry_reference) - 1
            ) * 100
            premium_lock_armed = max_return_pct >= t1_premium_lock_arm_pct
        if premium_lock_armed:
            premium.setdefault("profit_lock_armed_at", now)
            premium["profit_lock_arm_pct"] = t1_premium_lock_arm_pct
            premium["profit_lock_floor_pct"] = t1_premium_lock_floor_pct
            premium_floor_breached = (
                _number(return_pct)
                and float(return_pct) <= t1_premium_lock_floor_pct
            )
    protected_stop_hit = bool(
        t1_protection_active
        and _number(protected_invalidation)
        and (
            previous_side == "calls" and spot <= protected_invalidation
            or previous_side == "puts" and spot >= protected_invalidation
        )
    )
    if prior_position_open and (premium_floor_breached or protected_stop_hit):
        protected_setup = (
            result["call_setup"]
            if previous_side == "calls"
            else result["put_setup"]
        )
        close_reason = (
            "t1_premium_lock"
            if premium_floor_breached
            else "t1_protected_stop"
        )
        protected_setup.update(
            status="protected_exit",
            trigger=frozen_trigger,
            invalidation=protected_invalidation,
            targets=continuation_targets,
            risk_method=(previous_setup or {}).get(
                "risk_method",
                "legacy_fixed",
            ),
            risk_dollars=(previous_setup or {}).get("risk_dollars"),
            option=refreshed_position_option,
        )
        result.update(
            state="WAIT",
            favoring="no-trade",
            strategy=previous_strategy,
            lifecycle={
                "status": "COMPLETED",
                "close_reason": close_reason,
                "activated_at": previous_lifecycle.get("activated_at"),
                "targets_hit": targets_hit,
                "entry_allowed": False,
                "paper_position_open": False,
                "protected_invalidation": protected_invalidation,
                "premium_lock_arm_pct": t1_premium_lock_arm_pct,
                "premium_lock_floor_pct": t1_premium_lock_floor_pct,
                "closed_at": now,
                "premium": premium,
            },
        )
        _apply_same_side_reentry_reset(
            result,
            side=str(previous_side),
            now=now,
            indicators=spy,
            cooldown_seconds=float(same_side_reentry_cooldown_seconds),
        )
        if previous_strategy in FROZEN_SETUP_STRATEGIES:
            result["reversal_cooldown_until"] = max(
                cooldown_until,
                now + float(same_side_reentry_cooldown_seconds),
            )
        result["warnings"].append(
            "T1 premium profit lock closed the paper position"
            if premium_floor_breached
            else "T1 protected invalidation closed the paper position"
        )
        return _dedupe_messages(result)
    if prior_position_open and _number(protected_invalidation):
        failed = (
            previous_side == "calls" and spot <= protected_invalidation
        ) or (
            previous_side == "puts" and spot >= protected_invalidation
        )
        if failed:
            failed_setup = result["call_setup"] if previous_side == "calls" else result["put_setup"]
            failed_setup.update(
                status="invalidated",
                trigger=(previous_setup or {}).get("trigger"),
                invalidation=protected_invalidation,
                targets=continuation_targets,
                risk_method=(previous_setup or {}).get("risk_method", "legacy_fixed"),
                risk_dollars=(previous_setup or {}).get("risk_dollars"),
                option=refreshed_position_option,
            )
            result.update(
                state="FAILED",
                favoring="no-trade",
                strategy=previous_strategy,
                reversal_setup=previous_reversal or None,
                lifecycle={
                    "status": "FAILED",
                    "close_reason": "invalidation",
                    "activated_at": previous_lifecycle.get("activated_at"),
                    "targets_hit": targets_hit,
                    "entry_allowed": False,
                    "paper_position_open": False,
                    "closed_at": now,
                    "premium": premium,
                },
            )
            if previous_strategy in FROZEN_SETUP_STRATEGIES:
                result["reversal_cooldown_until"] = max(
                    cooldown_until,
                    now + float(same_side_reentry_cooldown_seconds),
                )
            else:
                prior_failure_count = (
                    failure_count
                    if failure_side == previous_side
                    and failure_last_at
                    and now - failure_last_at <= SAME_SIDE_FAILURE_WINDOW_SECONDS
                    else 0
                )
                failure_count = prior_failure_count + 1
                failure_side = previous_side
                failure_last_at = now
                failure_reset_required = failure_count >= SAME_SIDE_FAILURE_LIMIT
                failure_reset_after_bar = float(
                    spy.get("last_completed_15m_at", 0) or now
                )
                result.update(
                    same_side_failure_side=failure_side,
                    same_side_failure_count=failure_count,
                    same_side_failure_last_at=failure_last_at,
                    same_side_15m_reset_required=failure_reset_required,
                    same_side_failure_reset_after_bar=failure_reset_after_bar,
                )
            _apply_same_side_reentry_reset(
                result,
                side=str(previous_side),
                now=now,
                indicators=spy,
                cooldown_seconds=float(same_side_reentry_cooldown_seconds),
            )
            result["blockers"].append(f"prior {previous_side} signal invalidated")
            return _dedupe_messages(result)
    exit_target_index = (
        min(paper_exit_target, len(continuation_targets))
        if continuation_targets
        else 0
    )
    exit_target_level = (
        continuation_targets[exit_target_index - 1]
        if exit_target_index
        else None
    )
    continuation_completed = bool(
        prior_position_open
        and exit_target_index
        and targets_hit >= exit_target_index
    )
    if continuation_completed:
        completed_setup = result["call_setup"] if previous_side == "calls" else result["put_setup"]
        completed_setup.update(
            status="completed",
            trigger=(previous_setup or {}).get("trigger"),
            invalidation=(previous_setup or {}).get("invalidation"),
            targets=continuation_targets,
            risk_method=(previous_setup or {}).get("risk_method", "legacy_fixed"),
            risk_dollars=(previous_setup or {}).get("risk_dollars"),
            option=refreshed_position_option,
        )
        result.update(state="WAIT", favoring="no-trade", strategy=previous_strategy)
        result["lifecycle"] = {
            "status": "COMPLETED",
            "close_reason": "planned_target_exit",
            "activated_at": previous_lifecycle.get("activated_at"),
            "targets_hit": exit_target_index,
            "observed_targets_hit": targets_hit,
            "entry_allowed": False,
            "paper_position_open": False,
            "exit_target_index": exit_target_index,
            "exit_target_level": exit_target_level,
            "closed_at": now,
            "premium": premium,
        }
        if previous_strategy in FROZEN_SETUP_STRATEGIES:
            result["reversal_cooldown_until"] = max(
                cooldown_until,
                now + float(same_side_reentry_cooldown_seconds),
            )
        else:
            if failure_side == previous_side:
                for key in (
                    "same_side_failure_side", "same_side_failure_count",
                    "same_side_failure_last_at", "same_side_15m_reset_required",
                    "same_side_failure_reset_after_bar",
                ):
                    result.pop(key, None)
        result["confirmations"] = [
            f"prior {previous_side} planned T{exit_target_index} paper exit reached"
        ]
        result["warnings"].append(
            f"planned T{exit_target_index} paper exit reached; paper position closed"
        )
        return _dedupe_messages(result)

    continuation_cooldown_until = float(previous_signal.get("continuation_cooldown_until", 0) or 0)
    continuation_reset_after_bar = float(previous_signal.get("continuation_reset_after_bar", 0) or 0)
    continuation_reset_side = previous_signal.get("continuation_reset_side")
    continuation_reset_observed = bool(previous_signal.get("continuation_reset_observed"))
    last_completed_at = float(
        spy.get("last_completed_5m_at", 0)
        or spy.get("last_completed_at", 0)
        or 0
    )
    reset_close = spy.get("last_close_5m")
    if (
        continuation_reset_side in {"calls", "puts"}
        and not continuation_reset_observed
        and last_completed_at > continuation_reset_after_bar
        and _number(reset_close)
    ):
        continuation_reset_observed = (
            continuation_reset_side == "calls"
            and float(reset_close) <= raw_call_trigger
        ) or (
            continuation_reset_side == "puts"
            and float(reset_close) >= raw_put_trigger
        )
    continuation_reentry_blocked = (
        continuation_reset_side in {"calls", "puts"}
        and (
            now < continuation_cooldown_until
            or last_completed_at <= continuation_reset_after_bar
            or not continuation_reset_observed
        )
    )
    if continuation_reentry_blocked:
        result.update(
            continuation_cooldown_until=continuation_cooldown_until,
            continuation_reset_after_bar=continuation_reset_after_bar,
            continuation_reset_timeframe=(
                previous_signal.get("continuation_reset_timeframe") or "5m"
            ),
            continuation_reset_side=continuation_reset_side,
            continuation_reset_observed=continuation_reset_observed,
        )

    if not gex_ctx.get("available"):
        result["blockers"].append("GEX unavailable or incomplete; new entries blocked")
    elif gex_ctx["age_seconds"] > MAX_GEX_ENTRY_AGE_SECONDS:
        result["blockers"].append(
            f"GEX snapshot stale (>{MAX_GEX_ENTRY_AGE_SECONDS}s); new entries blocked"
        )
    if gex_ctx.get("source") == "ibkr-local-oi-model":
        result["warnings"].append(
            "IBKR local GEX uses inferred dealer signs and prior-clearing open interest; use as secondary confirmation"
        )
    if not reversal and gex_ctx.get("vix_gamma_regime") == "Whipsaw":
        result["warnings"].append("VIX gamma regime is Whipsaw; require stronger confirmation")
    if not reversal and not volume_ok:
        result["warnings"].append(f"1m RVOL {rvol:.2f} below 1.20")
    if call_break and spy_up and not spy_up_15m:
        result["blockers"].append("SPY 15m EMA structure is not bullish; call continuation blocked")
    if put_break and spy_down and not spy_down_15m:
        result["blockers"].append("SPY 15m EMA structure is not bearish; put continuation blocked")
    if call_break and failure_blocks_calls:
        result["blockers"].append(
            "two call invalidations; calls blocked until a new completed 15m bar realigns"
        )
    if put_break and failure_blocks_puts:
        result["blockers"].append(
            "two put invalidations; puts blocked until a new completed 15m bar realigns"
        )
    call_wall = (gex_ctx.get("call_wall") or {}).get("strike")
    put_wall = (gex_ctx.get("put_wall") or {}).get("strike")
    call_short_runway = (
        call_break and _number(call_wall)
        and 0 < call_wall - raw_call_trigger < 1.5 * float(call_risk["risk_dollars"])
    )
    put_short_runway = (
        put_break and _number(put_wall)
        and 0 < raw_put_trigger - put_wall < 1.5 * float(put_risk["risk_dollars"])
    )
    call_option = result["call_setup"]["option"]
    put_option = result["put_setup"]["option"]

    call_stage = (gex_ctx.get("call_wall") or {}).get("stage")
    put_stage = (gex_ctx.get("put_wall") or {}).get("stage")
    if call_short_runway and call_stage in {"Delivered", "Spent"}:
        result["blockers"].append(
            f"call wall is {call_stage} and leaves less than 1.5R runway; entry blocked"
        )
    elif call_short_runway:
        result["warnings"].append(
            "call breakout has less than 1.5R runway to the call wall"
        )
    if put_short_runway and put_stage in {"Delivered", "Spent"}:
        result["blockers"].append(
            f"put wall is {put_stage} and leaves less than 1.5R runway; entry blocked"
        )
    elif put_short_runway:
        result["warnings"].append(
            "put breakdown has less than 1.5R runway to the put wall"
        )
    if call_confirmed and call_stage in {"Delivered", "Spent"}:
        result["warnings"].append(f"call wall lifecycle is {call_stage}")
    if put_confirmed and put_stage in {"Delivered", "Spent"}:
        result["warnings"].append(f"put wall lifecycle is {put_stage}")
    previous_watch_side = previous_signal.get("favoring")
    previous_watch_setup = (
        previous_signal.get("call_setup")
        if previous_watch_side == "calls"
        else previous_signal.get("put_setup")
    ) or {}
    previous_watch_trigger = previous_watch_setup.get("trigger")
    previous_armed_until = float(previous_signal.get("armed_until", 0) or 0)
    prior_continuation_watch = (
        previous_signal.get("state") in WATCH_STATES
        and previous_signal.get("strategy") not in FROZEN_SETUP_STRATEGIES
        and previous_watch_side in {"calls", "puts"}
        and _number(previous_watch_trigger)
        and now <= previous_armed_until
    )
    if prior_continuation_watch:
        aligned = (
            previous_watch_side == "calls" and spy_up and spy_up_15m and qqq_up and above_vwap
        ) or (
            previous_watch_side == "puts" and spy_down and spy_down_15m and qqq_down and below_vwap
        )
        moved_too_far_away = (
            previous_watch_side == "calls" and spot < float(previous_watch_trigger) - ARM_EXIT_DISTANCE
        ) or (
            previous_watch_side == "puts" and spot > float(previous_watch_trigger) + ARM_EXIT_DISTANCE
        )
        prior_continuation_watch = bool(aligned and not moved_too_far_away)

    if call_confirmed and not prior_position_open and not prior_continuation_watch and not reversal and not _option_eligible(call_option):
        result["blockers"].append(_option_blocker(call_option, "call"))
    if put_confirmed and not prior_position_open and not prior_continuation_watch and not reversal and not _option_eligible(put_option):
        result["blockers"].append(_option_blocker(put_option, "put"))
    if reversal and not hard_data_block:
        reversal_option = put_option if reversal["side"] == "puts" else call_option
        reversal_label = "put" if reversal["side"] == "puts" else "call"
        if not _option_eligible(reversal_option):
            result["blockers"].append(_option_blocker(reversal_option, reversal_label))
    if prior_position_open:
        target_setup = result["call_setup"] if previous_side == "calls" else result["put_setup"]
        if targets_hit >= 2:
            lifecycle_state = "EXTENDED"
            setup_status = f"extended_t{targets_hit}"
            lifecycle_warning = f"{targets_hit} paper targets reached; signal remains in follow-through tracking"
        elif targets_hit == 1:
            lifecycle_state = "MANAGE"
            setup_status = "manage_t1"
            lifecycle_warning = "first paper target reached; signal remains in follow-through tracking"
        else:
            lifecycle_state = "ACTIVE"
            setup_status = "frozen_active_latched" if previous_strategy in FROZEN_SETUP_STRATEGIES else "active_latched"
            lifecycle_warning = None
        activated_at = float(previous_lifecycle.get("activated_at") or previous_signal.get("generated_at") or now)
        entry_window_until = float(previous_lifecycle.get("entry_window_until") or activated_at + 60)
        risk_dollars = (previous_setup or {}).get("risk_dollars")
        favorable_move = (
            float(spot) - float((previous_setup or {}).get("trigger"))
            if previous_side == "calls" and _number((previous_setup or {}).get("trigger"))
            else float((previous_setup or {}).get("trigger")) - float(spot)
            if previous_side == "puts" and _number((previous_setup or {}).get("trigger"))
            else 0
        )
        entry_allowed = (
            lifecycle_state == "ACTIVE"
            and now <= entry_window_until
            and (_number(risk_dollars) and favorable_move <= float(risk_dollars) * 0.75)
        )
        target_setup.update(
            status=setup_status,
            trigger=(previous_setup or {}).get("trigger"),
            invalidation=protected_invalidation,
            targets=continuation_targets,
            risk_method=(previous_setup or {}).get("risk_method", "legacy_fixed"),
            risk_dollars=(previous_setup or {}).get("risk_dollars"),
            option=refreshed_position_option,
        )
        result.update(
            state=lifecycle_state,
            favoring=previous_side,
            strategy=previous_strategy,
            confidence_score=(
                previous_signal.get("confidence_score")
                if _number(previous_signal.get("confidence_score"))
                else (
                    call_continuation_quality["score"]
                    if previous_side == "calls"
                    else put_continuation_quality["score"]
                )
                if previous_strategy == "CONTINUATION"
                else None
            ),
            reversal_setup=previous_reversal if previous_strategy in FROZEN_SETUP_STRATEGIES else None,
            lifecycle={
                "status": lifecycle_state,
                "activated_at": activated_at,
                "entry_window_until": entry_window_until,
                "targets_hit": targets_hit,
                "entry_allowed": entry_allowed,
                "paper_position_open": True,
                "protected_invalidation": (
                    protected_invalidation
                    if t1_protection_active
                    else None
                ),
                "premium_lock_armed": premium_lock_armed,
                "last_trusted_tracking_at": now,
                "premium": premium,
            },
        )
        result["confirmations"] = list(previous_signal.get("confirmations") or [])
        if "triggered signal remains inside its frozen risk plan" not in result["confirmations"]:
            result["confirmations"].append("triggered signal remains inside its frozen risk plan")
        if lifecycle_warning and lifecycle_warning not in result["warnings"]:
            result["warnings"].append(lifecycle_warning)
        if lifecycle_state == "ACTIVE" and not entry_allowed:
            result["warnings"].append("activation window expired or move extended; track signal only")
    elif reversal and not hard_data_block:
        side = reversal["side"]
        plan = reversal["risk_plan"]
        target_setup = result["put_setup"] if side == "puts" else result["call_setup"]
        reversal_option = put_option if side == "puts" else call_option
        triggered_raw = (side == "puts" and spot <= plan["entry"]) or (
            side == "calls" and spot >= plan["entry"]
        )
        apply_zerogex_context(side)
        ema9_1m, ema21_1m = spy.get("ema9"), spy.get("ema21")
        one_min_aligned = (
            side == "calls" and _number(ema9_1m) and _number(ema21_1m) and ema9_1m > ema21_1m
        ) or (
            side == "puts" and _number(ema9_1m) and _number(ema21_1m) and ema9_1m < ema21_1m
        )
        confirmation_ready = bool(one_min_aligned)
        same_side_cooldown = continuation_reentry_blocked and continuation_reset_side == side
        option_ready = _option_eligible(reversal_option)
        plan_risk = plan.get("risk_dollars")
        if not _number(plan_risk) and _number(plan.get("stop")):
            plan_risk = abs(float(plan["entry"]) - float(plan["stop"]))
        entry_not_extended = _entry_not_extended(side, float(spot), plan["entry"], plan_risk)
        reversal_plan_quality = _plan_quality(
            plan.get("entry"),
            plan.get("stop"),
            list(plan.get("targets") or []),
            side,
            paper_exit_target,
        )
        if triggered_raw and reversal_plan_quality.get("meets_minimum") is not True:
            result["blockers"].append(
                f"{side} plan reward/risk is below {MIN_PLAN_REWARD_RISK:.2f}:1"
            )
        if triggered_raw and not entry_not_extended:
            result["blockers"].append("trigger move is already extended beyond 0.75R; wait for a new setup")
        activation_ready = (
            triggered_raw
            and confirmation_ready
            and option_ready
            and entry_not_extended
            and not result["blockers"]
            and not same_side_cooldown
        )
        if triggered_raw and not confirmation_ready:
            result["warnings"].append(
                "frozen trigger touched without 1m EMA confirmation; activation held"
            )
        state = "ACTIVE" if activation_ready else (
            "ARMED" if option_ready and not result["blockers"]
            else "WATCH" if not option_ready
            else "WAIT"
        )
        result.update(
            state=state,
            favoring=side,
            strategy=reversal.get("strategy") or "MTF_TREND_BREAK",
            confidence_score=reversal["score"],
        )
        result["confirmations"] = [
            reversal["setup"],
            "price on trend side of VWAP",
            "trigger frozen for 15 minutes",
            *result["confirmations"],
        ]
        target_setup.update(
            status=(
                "mtf_active" if activation_ready
                else "mtf_frozen" if state == "ARMED"
                else "watch_liquidity" if state == "WATCH"
                else "blocked"
            ),
            trigger=plan["entry"],
            invalidation=plan["stop"],
            targets=plan["targets"],
            risk_method=plan["method"],
            risk_dollars=round(abs(float(plan["entry"]) - float(plan["stop"])), 2),
            plan_quality=reversal_plan_quality,
        )
        _enrich_setup_quality(target_setup, side, paper_exit_target)
        if activation_ready:
            target_setup["option"]["locked_at_activation"] = True
            target_setup["option"]["locked_at"] = now
            result["lifecycle"] = {
                "status": "ACTIVE",
                "activated_at": now,
                "entry_window_until": now + 60,
                "targets_hit": 0,
                "entry_allowed": True,
                "paper_position_open": True,
                "last_trusted_tracking_at": now,
                "premium": _premium_lifecycle(None, target_setup.get("option"), now, activate=True),
            }
    elif prior_continuation_watch:
        side = previous_watch_side
        target_setup = result["call_setup"] if side == "calls" else result["put_setup"]
        current_option = call_option if side == "calls" else put_option
        target_setup.update(
            status="armed_latched",
            trigger=previous_watch_setup.get("trigger"),
            invalidation=previous_watch_setup.get("invalidation"),
            targets=previous_watch_setup.get("targets"),
            risk_method=previous_watch_setup.get("risk_method"),
            risk_dollars=previous_watch_setup.get("risk_dollars"),
        )
        _enrich_setup_quality(target_setup, side, paper_exit_target)
        frozen_trigger = float(previous_watch_setup["trigger"])
        confirmed = (
            side == "calls" and latest_close > frozen_trigger and spy_up and spy_up_15m and qqq_up and above_vwap and volume_ok
        ) or (
            side == "puts" and latest_close < frozen_trigger and spy_down and spy_down_15m and qqq_down and below_vwap and volume_ok
        )
        apply_zerogex_context(side)
        same_side_cooldown = continuation_reentry_blocked and continuation_reset_side == side
        option_ready = _option_eligible(current_option)
        entry_not_extended = _entry_not_extended(
            side,
            float(spot),
            previous_watch_setup.get("trigger"),
            previous_watch_setup.get("risk_dollars"),
        )
        if not option_ready:
            result["blockers"].append(_option_blocker(current_option, "call" if side == "calls" else "put"))
        if confirmed and not entry_not_extended:
            result["blockers"].append("trigger move is already extended beyond 0.75R; wait for a new setup")
        plan_blocker = _plan_quality_blocker(target_setup, side)
        if plan_blocker:
            result["blockers"].append(plan_blocker)
        continuation_quality = call_continuation_quality if side == "calls" else put_continuation_quality
        if confirmed and int(continuation_quality["score"]) < MIN_CONTINUATION_CONFIDENCE:
            result["blockers"].append(
                f"continuation confidence {continuation_quality['score']} is below {MIN_CONTINUATION_CONFIDENCE}"
            )
        activation_ready = (
            confirmed and option_ready and entry_not_extended
            and not result["blockers"] and not same_side_cooldown
        )
        if activation_ready:
            current_option["locked_at_activation"] = True
            current_option["locked_at"] = now
            target_setup["option"] = current_option
            target_setup["status"] = "active_latched"
            result.update(
                state="ACTIVE",
                favoring=side,
                strategy="CONTINUATION",
                confidence_score=continuation_quality["score"],
            )
            result["lifecycle"] = {
                "status": "ACTIVE",
                "activated_at": now,
                "entry_window_until": now + 60,
                "targets_hit": 0,
                "entry_allowed": True,
                "paper_position_open": True,
                "last_trusted_tracking_at": now,
                "premium": _premium_lifecycle(None, current_option, now, activate=True),
            }
        else:
            result.update(
                state=("ARMED" if option_ready and not result["blockers"] else "WATCH" if not option_ready else "WAIT"),
                favoring=side,
                armed_until=previous_armed_until,
            )
            target_setup["status"] = (
                "armed_latched" if result["state"] == "ARMED"
                else "watch_liquidity" if result["state"] == "WATCH"
                else "blocked"
            )
    elif call_confirmed and not (continuation_reentry_blocked and continuation_reset_side == "calls"):
        apply_zerogex_context("calls")
        plan_blocker = _plan_quality_blocker(result["call_setup"], "calls")
        if plan_blocker:
            result["blockers"].append(plan_blocker)
        if int(call_continuation_quality["score"]) < MIN_CONTINUATION_CONFIDENCE:
            result["blockers"].append(
                f"continuation confidence {call_continuation_quality['score']} is below {MIN_CONTINUATION_CONFIDENCE}"
            )
        if not _entry_not_extended("calls", float(spot), call_trigger, call_risk["risk_dollars"]):
            result["blockers"].append("trigger move is already extended beyond 0.75R; wait for a new setup")
        if _option_eligible(call_option) and not result["blockers"]:
            call_option["locked_at_activation"] = True
            call_option["locked_at"] = now
            result.update(
                state="ACTIVE",
                favoring="calls",
                strategy="CONTINUATION",
                confidence_score=call_continuation_quality["score"],
            )
            result["lifecycle"] = {
                "status": "ACTIVE", "activated_at": now, "entry_window_until": now + 60,
                "targets_hit": 0, "entry_allowed": True, "paper_position_open": True,
                "last_trusted_tracking_at": now,
                "premium": _premium_lifecycle(None, call_option, now, activate=True),
            }
        else:
            state = "WATCH" if not _option_eligible(call_option) else "WAIT"
            result.update(state=state, favoring="calls", armed_until=now + ARM_LIFETIME_SECONDS)
            result["call_setup"]["status"] = "watch_liquidity" if state == "WATCH" else "blocked"
        result["confirmations"] = [
            "completed 1m breakout",
            "5m + 15m SPY up",
            "above VWAP",
            "volume expansion",
            *result["confirmations"],
        ]
        if use_qqq:
            result["confirmations"].insert(2, "QQQ up")
    elif put_confirmed and not (continuation_reentry_blocked and continuation_reset_side == "puts"):
        apply_zerogex_context("puts")
        plan_blocker = _plan_quality_blocker(result["put_setup"], "puts")
        if plan_blocker:
            result["blockers"].append(plan_blocker)
        if int(put_continuation_quality["score"]) < MIN_CONTINUATION_CONFIDENCE:
            result["blockers"].append(
                f"continuation confidence {put_continuation_quality['score']} is below {MIN_CONTINUATION_CONFIDENCE}"
            )
        if not _entry_not_extended("puts", float(spot), put_trigger, put_risk["risk_dollars"]):
            result["blockers"].append("trigger move is already extended beyond 0.75R; wait for a new setup")
        if _option_eligible(put_option) and not result["blockers"]:
            put_option["locked_at_activation"] = True
            put_option["locked_at"] = now
            result.update(
                state="ACTIVE",
                favoring="puts",
                strategy="CONTINUATION",
                confidence_score=put_continuation_quality["score"],
            )
            result["lifecycle"] = {
                "status": "ACTIVE", "activated_at": now, "entry_window_until": now + 60,
                "targets_hit": 0, "entry_allowed": True, "paper_position_open": True,
                "last_trusted_tracking_at": now,
                "premium": _premium_lifecycle(None, put_option, now, activate=True),
            }
        else:
            state = "WATCH" if not _option_eligible(put_option) else "WAIT"
            result.update(state=state, favoring="puts", armed_until=now + ARM_LIFETIME_SECONDS)
            result["put_setup"]["status"] = "watch_liquidity" if state == "WATCH" else "blocked"
        result["confirmations"] = [
            "completed 1m breakdown",
            "5m + 15m SPY down",
            "below VWAP",
            "volume expansion",
            *result["confirmations"],
        ]
        if use_qqq:
            result["confirmations"].insert(2, "QQQ down")
    elif (
        not hard_data_block
        and not (continuation_reentry_blocked and continuation_reset_side == "calls")
        and abs(spot - call_trigger) <= ARM_ENTER_DISTANCE
        and spy_up and spy_up_15m and qqq_up and above_vwap
    ):
        apply_zerogex_context("calls")
        plan_blocker = _plan_quality_blocker(result["call_setup"], "calls")
        if plan_blocker:
            result["blockers"].append(plan_blocker)
        option_ready = _option_eligible(call_option)
        if not option_ready:
            result["blockers"].append(_option_blocker(call_option, "call"))
        result.update(
            state=("ARMED" if option_ready and not result["blockers"] else "WATCH" if not option_ready else "WAIT"),
            favoring="calls",
            armed_until=now + ARM_LIFETIME_SECONDS,
        )
        result["call_setup"]["status"] = (
            "ready" if result["state"] == "ARMED" else "watch_liquidity" if result["state"] == "WATCH" else "blocked"
        )
        result["confirmations"] = ["near call trigger", "5m + 15m SPY up", "above VWAP"]
        if use_qqq:
            result["confirmations"].append("QQQ up")
    elif (
        not hard_data_block
        and not (continuation_reentry_blocked and continuation_reset_side == "puts")
        and abs(spot - put_trigger) <= ARM_ENTER_DISTANCE
        and spy_down and spy_down_15m and qqq_down and below_vwap
    ):
        apply_zerogex_context("puts")
        plan_blocker = _plan_quality_blocker(result["put_setup"], "puts")
        if plan_blocker:
            result["blockers"].append(plan_blocker)
        option_ready = _option_eligible(put_option)
        if not option_ready:
            result["blockers"].append(_option_blocker(put_option, "put"))
        result.update(
            state=("ARMED" if option_ready and not result["blockers"] else "WATCH" if not option_ready else "WAIT"),
            favoring="puts",
            armed_until=now + ARM_LIFETIME_SECONDS,
        )
        result["put_setup"]["status"] = (
            "ready" if result["state"] == "ARMED" else "watch_liquidity" if result["state"] == "WATCH" else "blocked"
        )
        result["confirmations"] = ["near put trigger", "5m + 15m SPY down", "below VWAP"]
        if use_qqq:
            result["confirmations"].append("QQQ down")
    elif hard_data_block:
        result["favoring"] = "no-trade"
    elif spy_up and qqq_up and above_vwap:
        result["favoring"] = "calls"
        apply_zerogex_context("calls")
    elif spy_down and qqq_down and below_vwap:
        result["favoring"] = "puts"
        apply_zerogex_context("puts")
    else:
        result["favoring"] = "mixed/range"
        result["blockers"].append("SPY 5m structure and VWAP are not aligned")
    if continuation_reentry_blocked and result.get("favoring") == continuation_reset_side:
        result["blockers"].append("continuation cooldown/reset active; same-side re-entry blocked")
    if failure_reset_required and result.get("favoring") == failure_side:
        result["blockers"].append(
            f"two same-side invalidations; {failure_side} blocked until a new completed 15m bar realigns"
        )
    return _dedupe_messages(result)


def _style(text: Any, color: bool, *codes: str) -> str:
    value = str(text)
    return f"\033[{';'.join(codes)}m{value}\033[0m" if color and codes else value


def _render_option_lines(
    label: str,
    option: dict[str, Any] | None,
    *,
    color: bool,
    active: bool,
    entry_allowed: bool,
) -> list[str]:
    if not option:
        return [f"  {_style(label + ' option', color, '2')}: unavailable"]
    right = "C" if label == "CALL" else "P"
    strike = option.get("target_strike")
    contract = f"SPY {option.get('expiry') or '-'} {strike if strike is not None else '-'}{right}"
    selection = option.get("selection") or "OTM"
    expiry_mode = str(option.get("expiry_mode") or "")
    expiry_label = {
        "0DTE": "0DTE",
        "0DTE_NO_FUTURE_EXPIRY": "0DTE",
        "1DTE_NEXT_LISTED": "1DTE",
    }.get(expiry_mode)
    if expiry_label:
        selection += f" {expiry_label}"
    if option.get("locked_at_activation"):
        selection += " @ activation"
    if option.get("eligible") is not True:
        reasons = ", ".join(option.get("rejection_reasons") or ["not eligible"])
        return [
            f"  {_style(label + ' option [' + selection + ']', color, '1')}: {_style(contract, color, '1')}",
            f"  {_style('NO ENTRY', color, '1', '91')} — {reasons}",
        ]
    contract_code = "92" if label == "CALL" else "91"
    if not active:
        contract_code = "36"
    lines = [
        f"  {_style(label + ' option [' + selection + ']', color, '1')}: {_style(contract, color, '1', contract_code)}",
        f"  Quote          bid {_style(option.get('bid'), color, '1')}  ask {_style(option.get('ask'), color, '1')}  "
        f"mid {_style(option.get('mid'), color, '1', '96')}  spread {option.get('spread_pct')}%",
    ]
    if option.get("planned_contracts") and option.get("planned_total_debit"):
        quantity = int(option["planned_contracts"])
        lines.append(
            f"  Budget plan    {quantity} contract"
            f"{'' if quantity == 1 else 's'} | limit "
            f"{option.get('planned_limit_price')} | total debit "
            f"${option.get('planned_total_debit')}"
        )
    if not entry_allowed:
        lines.append(
            f"  {_style('Signal guide', color, '1', '93')} locked paper contract; "
            f"{_style('PAPER TRACKING ONLY', color, '1', '91')}"
        )
        return lines
    lines.extend(
        [
            f"  Premium guide  indicative from mid +10% {_style(option.get('premium_target_10'), color, '1', '92')}  "
            f"+20% {_style(option.get('premium_target_20'), color, '1', '92')}",
            f"  {_style('Signal guide', color, '2')}   paper reference only; no broker order",
        ]
    )
    return lines


def _render_setup_lines(
    label: str,
    setup: dict[str, Any],
    *,
    active: bool,
    color: bool,
    entry_allowed: bool,
    targets_hit: int = 0,
) -> list[str]:
    side_code = "92" if label == "CALL" else "91"
    marker = "▶" if active else "•"
    direction = ">" if label == "CALL" else "<"
    targets = " → ".join(str(item) for item in (setup.get("targets") or [])) or "-"
    heading_codes = ("1", side_code) if active else ("1", "36")
    lines = [
        f"{_style(marker + ' ' + label, color, *heading_codes)}  "
        f"{_style('[' + str(setup.get('status', 'ready')).upper() + ']', color, '1' if active else '2')}",
        f"  Trigger        {direction} {_style(setup.get('trigger'), color, '1', '93')}",
        f"  {_style('INVALIDATION', color, '1', '91')}   {_style(setup.get('invalidation'), color, '1', '91')}",
        f"  Targets        {_style(targets, color, '1', '92')}",
    ]
    if setup.get("risk_method"):
        lines.append(
            f"  Risk           {_style(setup.get('risk_method'), color, '1')}"
            + (f"  (${setup.get('risk_dollars')} SPY risk)" if setup.get("risk_dollars") is not None else "")
        )
    if targets_hit:
        lines.append(
            f"  {_style('Progress', color, '1', '96')}       {targets_hit}/{len(setup.get('targets') or [])} targets reached"
        )
    lines.extend(
        _render_option_lines(
            label,
            setup.get("option"),
            color=color,
            active=active,
            entry_allowed=entry_allowed,
        )
    )
    return lines


def _quick_level(value: Any) -> str:
    if not _number(value):
        return "-"
    return f"{float(value):.4f}".rstrip("0").rstrip(".")


def format_option_contract(
    option: dict[str, Any] | None,
    *,
    side: str | None = None,
) -> str:
    """Render a selected option without exposing the raw IBKR local symbol."""
    option = option or {}
    expiry = str(option.get("expiry") or "").strip()
    if len(expiry) == 8 and expiry.isdigit():
        expiry = f"{expiry[:4]}-{expiry[4:6]}-{expiry[6:]}"
    strike = (
        option.get("target_strike")
        if _number(option.get("target_strike"))
        else option.get("strike")
    )
    right = str(option.get("right") or "").upper()
    normalized_side = str(side or "").lower()
    if right not in {"C", "P"}:
        right = "C" if normalized_side in {"call", "calls"} else "P" if normalized_side in {"put", "puts"} else ""
    if expiry and _number(strike) and right:
        return f"SPY {expiry} {_quick_level(strike)}{right}"
    return " ".join(str(option.get("local_symbol") or "").split())


def _quick_blocker(reason: Any) -> str:
    text = str(reason or "").strip()
    lower = text.lower()
    if "insufficient completed intraday bars" in lower:
        return "warming up; more completed bars are required"
    if "structure and vwap are not aligned" in lower:
        return "5m structure and VWAP disagree"
    if "stale or missing ibkr market data" in lower:
        return "market data is unavailable or stale"
    if "gex unavailable or incomplete" in lower:
        return "GEX is unavailable; new entries are blocked"
    if "gex snapshot stale" in lower:
        return "GEX is stale; new entries are blocked"
    if "regular session is closed" in lower:
        return "regular session is closed"
    if "zerogex has no confirming playbook setup" in lower:
        return "ZeroGEX has no confirming setup"
    return text


def _render_quick_read(signal: dict[str, Any], *, color: bool) -> list[str]:
    """Put the action, next levels, and main context ahead of the audit trail."""
    state = str(signal.get("state") or "WAIT").upper()
    phase = str(signal.get("signal_phase") or "").upper()
    favoring = str(signal.get("favoring") or "no-trade").lower()
    side = "CALL" if favoring == "calls" else "PUT" if favoring == "puts" else None
    if side is None and phase in {
        "COMPLETED",
        "INVALIDATED",
        "SESSION_CLOSED",
        "TRACKING_ABORTED",
    }:
        for candidate_side, setup_name in (("CALL", "call_setup"), ("PUT", "put_setup")):
            terminal_status = str(
                ((signal.get(setup_name) or {}).get("status") or "")
            ).lower()
            if terminal_status in {
                "completed",
                "protected_exit",
                "invalidated",
                "time_exit",
                "tracking_gap_abort",
            }:
                side = candidate_side
                break
    if side == "CALL":
        setup = signal.get("call_setup") or {}
    elif side == "PUT":
        setup = signal.get("put_setup") or {}
    else:
        setup = {}
    lifecycle = signal.get("lifecycle") or {}
    targets_hit = int(lifecycle.get("targets_hit", 0) or 0)
    premium = lifecycle.get("premium") or {}
    premium_return = premium.get("return_pct")
    targets = list(setup.get("targets") or [])
    spot = signal.get("spot")
    last_hit_target = (
        targets[targets_hit - 1]
        if targets_hit > 0 and targets_hit <= len(targets)
        else None
    )
    pulled_back_from_last_target = bool(
        side == "CALL"
        and _number(spot)
        and _number(last_hit_target)
        and float(spot) < float(last_hit_target) - 0.01
        or side == "PUT"
        and _number(spot)
        and _number(last_hit_target)
        and float(spot) > float(last_hit_target) + 0.01
    )

    if phase == "COMPLETED":
        close_reason = lifecycle.get("close_reason")
        exit_target_index = lifecycle.get("exit_target_index")
        exit_label = (
            f"T{int(exit_target_index)}"
            if _number(exit_target_index)
            else "T1 premium profit lock"
            if close_reason == "t1_premium_lock"
            else "T1 protected stop"
            if close_reason == "t1_protected_stop"
            else "planned target"
        )
        action = (
            f"PAPER {side} POSITION CLOSED — {exit_label} exit recorded; "
            "wait for a new setup"
            if side
            else f"PAPER POSITION CLOSED — {exit_label} exit recorded; "
            "wait for a new setup"
        )
    elif phase == "INVALIDATED":
        action = "PAPER PLAN INVALIDATED — stand aside and wait for a reset"
    elif phase == "SESSION_CLOSED":
        action = "SESSION CLOSED — paper tracking ended; no overnight signal"
    elif phase == "TRACKING_ABORTED":
        action = (
            "PAPER TRACKING ABORTED — the market-data gap was too long to "
            "trust the old setup; wait for a fresh signal"
        )
    elif phase == "TRACKING_PAUSED":
        action = (
            f"PAPER {side} TRACKING PAUSED — fresh market data is unavailable; "
            "the open paper lifecycle is preserved but no new decision is made"
            if side
            else "PAPER TRACKING PAUSED — fresh market data is unavailable"
        )
    elif state in CONTINUATION_OPEN_STATES and side:
        if targets_hit:
            action = (
                f"MANAGE PAPER {side} — T{targets_hit} previously reached; "
                f"price pulled back {'below' if side == 'CALL' else 'above'} T{targets_hit}"
                if pulled_back_from_last_target
                else f"MANAGE PAPER {side} — T{targets_hit} reached"
            )
        else:
            action = f"PAPER {side} TRIGGERED — paper tracking active"
        if _number(premium_return):
            action += f"; option mark {float(premium_return):+.1f}%"
        if state in {"MANAGE", "EXTENDED"} or lifecycle.get("entry_allowed") is False:
            action += f"; do not open a new {side.lower()}"
        else:
            action += "; no real position exists"
    elif state in WATCH_STATES and side:
        action = f"WAIT — {side} setup armed; trigger is not confirmed"
    elif state == "WAIT" and side:
        action = f"WAIT — {side} bias only; trigger is not confirmed"
    else:
        action = "NO TRADE — stand aside"

    invalidation = setup.get("invalidation")
    trigger = setup.get("trigger")
    if phase == "COMPLETED":
        next_line = (
            "paper_position_open=false | cooldown and fresh structure required "
            "before re-entry"
        )
    elif phase == "TRACKING_PAUSED":
        next_line = (
            "wait for fresh market data; do not create a new entry or "
            "reinterpret the frozen paper plan"
        )
    elif state in CONTINUATION_OPEN_STATES and side:
        remaining = [
            f"T{index + 1} {_quick_level(target)}"
            for index, target in enumerate(targets)
            if index >= targets_hit
        ]
        next_text = " → ".join(remaining) if remaining else "final target reached"
        if pulled_back_from_last_target:
            reclaim_direction = "above" if side == "CALL" else "below"
            reclaim = (
                f"back {reclaim_direction} T{targets_hit} "
                f"{_quick_level(last_hit_target)}"
            )
            next_text = (
                f"{reclaim}, then {next_text}"
                if remaining
                else reclaim
            )
        invalid_direction = "below" if side == "CALL" else "above"
        next_line = (
            f"{next_text} | setup invalid {invalid_direction} "
            f"{_quick_level(invalidation)}"
        )
    elif side and setup:
        direction = "above" if side == "CALL" else "below"
        invalid_direction = "below" if side == "CALL" else "above"
        trigger_mode = (
            "armed intrabar"
            if signal.get("strategy") in FROZEN_SETUP_STRATEGIES
            and state in WATCH_STATES
            else "completed 1m candle"
        )
        first_target = (
            f" | T1 {_quick_level(targets[0])}"
            if targets
            else ""
        )
        next_line = (
            f"{trigger_mode} {direction} {_quick_level(trigger)}"
            f"{first_target} | invalid {invalid_direction} "
            f"{_quick_level(invalidation)}"
        )
    else:
        blocker = (signal.get("blockers") or [None])[0]
        next_line = _quick_blocker(blocker) if blocker else "wait for a complete setup"

    context: list[str] = []
    risks: list[str] = []
    if signal.get("blockers") and phase not in {
        "COMPLETED",
        "INVALIDATED",
        "SESSION_CLOSED",
    }:
        first_blocker = _quick_blocker(signal["blockers"][0])
        if first_blocker:
            risks.append(first_blocker)
    gex = signal.get("gex") or {}
    regime = str(gex.get("regime") or "")
    gamma_regime = str(gex.get("gamma_regime") or "")
    if regime and gamma_regime:
        if gamma_regime == "Trend":
            context.append(f"{regime}/{gamma_regime} GEX can amplify confirmed moves")
        elif gamma_regime == "Range":
            context.append(f"{regime}/{gamma_regime} GEX favors pinning and fades")
        elif gamma_regime == "Whipsaw":
            risks.append("Whipsaw GEX raises reversal risk")

    zero = signal.get("zerogex_decision") or {}
    aligned_advanced = []
    conflicting_advanced = []
    advanced_labels = {
        "momentum_expansion": "momentum/expansion",
        "eod_pressure": "EOD pressure",
        "trap_detection": "trap signal",
        "zero_dte_position_imbalance": "0DTE imbalance",
        "gamma_vwap_confluence": "gamma/VWAP",
        "range_break_regime": "Breakout Mode",
        "dealer_pressure": "market pressure",
    }
    seen_advanced_families: set[tuple[str, str | None]] = set()
    for item in zero.get("active_advanced") or []:
        if not isinstance(item, dict) or not item.get("directional"):
            continue
        family = str(item.get("family") or item.get("name") or "signal")
        item_side = item.get("side")
        family_key = (family, item_side)
        if family_key in seen_advanced_families:
            continue
        seen_advanced_families.add(family_key)
        label = advanced_labels.get(family, family.replace("_", " "))
        direction = str(item.get("direction") or "").lower()
        phrase = f"{direction} {label}".strip()
        if side and item_side == favoring:
            aligned_advanced.append(phrase)
        elif side and item_side not in {None, favoring}:
            conflicting_advanced.append(phrase)
    if aligned_advanced:
        context.append(" + ".join(aligned_advanced) + " align")
    if conflicting_advanced:
        risks.append(" + ".join(conflicting_advanced) + " conflict")

    flow = zero.get("flow_context") or {}
    flow_side = _zerogex_side(flow.get("direction"))
    flow_strength = flow.get("strength")
    if (
        flow.get("fresh") is True
        and side
        and flow_side
        and _number(flow_strength)
        and float(flow_strength) >= 0.20
    ):
        flow_text = (
            f"ZeroGEX premium flow {'aligns' if flow_side == favoring else 'conflicts'}"
        )
        (
            context
            if flow_side == favoring
            else risks
        ).append(flow_text)

    late_day = zero.get("late_day_context") or {}
    dealer = late_day.get("dealer_hedging") or {}
    hedge_shares = dealer.get("expected_hedge_shares")
    if (
        late_day.get("active") is True
        and side
        and _number(hedge_shares)
        and abs(float(hedge_shares)) >= 1_000_000
    ):
        hedge_side = "calls" if float(hedge_shares) < 0 else "puts"
        hedge_text = (
            f"late-day dealer pressure {'aligns' if hedge_side == favoring else 'conflicts'}"
        )
        (
            context
            if hedge_side == favoring
            else risks
        ).append(hedge_text)

    trade_bias = zero.get("trade_bias") or {}
    bias_side = trade_bias.get("side")
    bias_score = trade_bias.get("score")
    bias_confidence = trade_bias.get("confidence")
    meaningful_bias = bool(
        trade_bias.get("fresh")
        and trade_bias.get("directional_confirmation")
        and bias_side in {"calls", "puts"}
        and _number(bias_score)
        and abs(float(bias_score)) >= 30
        and _number(bias_confidence)
        and float(bias_confidence) >= 30
    )
    if meaningful_bias and side:
        bias_direction = "LONG" if bias_side == "calls" else "SHORT"
        bias_text = (
            f"ZeroGEX {bias_direction} bias {float(bias_score):+.1f} "
            f"({float(bias_confidence):.1f} confidence)"
        )
        if bias_side == favoring:
            context.append(bias_text + " aligns")
        else:
            risks.append(bias_text + " conflicts")
    elif (
        trade_bias.get("fresh")
        and trade_bias.get("style") == "mean_reversion"
        and side
    ):
        label = trade_bias.get("label") or "range-fade"
        risks.append(f"ZeroGEX {label} is not continuation confirmation")

    playbook = zero.get("playbook") or {}
    if (
        zero.get("gex_primary")
        and str(playbook.get("state") or "").lower() == "stand_down"
    ):
        risks.append("ZeroGEX has no confirming setup")

    rvol = (signal.get("market_context") or {}).get("rvol_1m")
    if _number(rvol) and float(rvol) < 1.2:
        risks.append(f"low RVOL {float(rvol):.2f} can stall or reverse the move")

    if not context:
        context.append("local price structure remains the entry authority")
    context_line = "; ".join(context)
    if risks:
        context_line += " | RISK: " + "; ".join(dict.fromkeys(risks))

    return [
        _style("QUICK READ", color, "1", "96"),
        _style("ACTION NOW", color, "1", "93") + ": " + action,
        _style("NEXT", color, "1", "92") + ": " + next_line,
        _style("CONTEXT", color, "1", "95") + ": " + context_line,
        _style("DETAILS (audit trail)", color, "2"),
    ]


def _render_signal_details(signal: dict[str, Any], *, color: bool = False) -> str:
    """Render the full provider and lifecycle audit view."""
    call = signal.get("call_setup") or {}
    put = signal.get("put_setup") or {}
    state = str(signal.get("state") or "WAIT").upper()
    favoring = str(signal.get("favoring") or "no-trade")
    strategy = signal.get("strategy")
    score = signal.get("confidence_score")
    phase = str(signal.get("signal_phase") or "").upper()
    favored_setup = call if favoring == "calls" else (put if favoring == "puts" else {})
    favored_option = favored_setup.get("option") or {}
    blockers_text = " ".join(str(item).lower() for item in signal.get("blockers") or [])
    data_offline = (
        signal.get("spot") is None
        and "stale or missing ibkr market data" in blockers_text
    )
    side = "CALL" if favoring == "calls" else "PUT" if favoring == "puts" else None
    action = (
        side if state == "ACTIVE" and side
        else side if state in {"MANAGE", "EXTENDED"} and side
        else "NO TRADE" if state == "FAILED" or favoring == "no-trade"
        else "WAIT"
    )
    action_code = (
        "92" if action == "CALL"
        else "91" if action == "PUT" or action == "NO TRADE"
        else "96" if state in {"MANAGE", "EXTENDED"}
        else "93"
    )
    detail = []
    if phase and phase not in {"WAIT", "NO_TRADE"}:
        detail.append(phase.replace("_", " "))
    if state in {"ARMED", "WATCH", "WAIT"} and side:
        detail.append(f"{side} bias")
    elif state not in {"ACTIVE", "MANAGE", "EXTENDED", "FAILED", "WAIT"}:
        detail.append(state)
    if data_offline:
        detail.append("DATA OFFLINE")
    if strategy:
        detail.append(str(strategy))
        if score is not None:
            detail[-1] += f" {score}/100"
        if (signal.get("reversal_setup") or {}).get("a_plus"):
            detail[-1] += " A+"
    spot = signal.get("spot")
    header = (
        f"{_style(action, color, '1', action_code)}"
        f" | {_style('SPY ' + (str(spot) if spot is not None else 'unavailable'), color, '1', '96')}"
    )
    if detail:
        header += " | " + " | ".join(detail)
    lines = _render_quick_read(signal, color=color)
    lines.append(header)
    lifecycle = signal.get("lifecycle") or {}
    if str(lifecycle.get("status") or "").upper() == "COMPLETED":
        exit_index = lifecycle.get("exit_target_index")
        exit_level = lifecycle.get("exit_target_level")
        exit_text = (
            f"T{int(exit_index)} {_quick_level(exit_level)}"
            if _number(exit_index)
            else "planned target"
        )
        lines.append(
            _style("PAPER POSITION", color, "1", "92")
            + f": CLOSED | exit {exit_text} recorded | no broker order"
        )

    if side and favored_setup:
        direction = ">" if side == "CALL" else "<"
        targets = " → ".join(str(item) for item in favored_setup.get("targets") or []) or "-"
        risk = favored_setup.get("risk_dollars")
        risk_text = f" | risk ${risk}" if risk is not None else ""
        lines.append(
            f"{side}: trigger {direction} {favored_setup.get('trigger')} | "
            f"INVALIDATION {favored_setup.get('invalidation')} | targets {targets}{risk_text}"
        )
        if favored_option:
            right = "C" if side == "CALL" else "P"
            strike = favored_option.get("target_strike")
            selection = str(favored_option.get("selection") or "OTM")
            expiry_mode = str(favored_option.get("expiry_mode") or "")
            expiry_label = {
                "0DTE": "0DTE",
                "0DTE_NO_FUTURE_EXPIRY": "0DTE",
                "1DTE_NEXT_LISTED": "1DTE",
            }.get(expiry_mode)
            if expiry_label:
                selection += f" {expiry_label}"
            contract = (
                f"SPY {favored_option.get('expiry') or '-'} "
                f"{strike if strike is not None else '-'}{right}"
            )
            if favored_option.get("eligible") is True:
                option_line = (
                    f"{side} option [{selection}]: {contract} | bid/ask "
                    f"{favored_option.get('bid')}/{favored_option.get('ask')} | "
                    f"spread {favored_option.get('spread_pct')}%"
                )
                if (
                    favored_option.get("planned_contracts")
                    and favored_option.get("planned_total_debit")
                ):
                    option_line += (
                        f" | budget {favored_option['planned_contracts']}x "
                        f"${favored_option.get('planned_limit_price')} "
                        f"(${favored_option.get('planned_total_debit')} total)"
                    )
                entry_allowed = (signal.get("lifecycle") or {}).get("entry_allowed")
                if state in {"MANAGE", "EXTENDED"} or entry_allowed is False:
                    option_line += " | PAPER TRACKING ONLY"
                else:
                    option_line += (
                        f" | signal only | PT "
                        f"{favored_option.get('premium_target_10')}/"
                        f"{favored_option.get('premium_target_20')}"
                    )
                lines.append(option_line)
            else:
                reasons = ", ".join(
                    favored_option.get("rejection_reasons") or ["not eligible"]
                )
                lines.append(
                    f"{side} option [{selection}]: ENTRY BLOCKED — {contract}; {reasons}"
                )

    if side and (premium := (signal.get("lifecycle") or {}).get("premium")):
        milestones = []
        if premium.get("hit_10_at"):
            milestones.append("+10% hit")
        if premium.get("hit_20_at"):
            milestones.append("+20% hit")
        milestone_text = f" | {', '.join(milestones)}" if milestones else ""
        lines.append(
            f"Premium: {premium.get('return_pct')}% | bid {premium.get('last_bid')} "
            f"vs entry {premium.get('entry_reference')}{milestone_text}"
        )
    if signal.get("blockers"):
        lines.append(_style("BLOCKED", color, "1", "91") + ": " + "; ".join(signal["blockers"]))
    if signal.get("warnings"):
        lines.append(_style("CAUTION", color, "1", "93") + ": " + "; ".join(signal["warnings"]))
    gex = signal.get("gex") or {}
    if gex:
        call_wall = gex.get("call_wall") or {}
        put_wall = gex.get("put_wall") or {}
        regime = f"{gex.get('regime') or '-'}/{gex.get('gamma_regime') or '-'}"
        source = gex.get("source") or "unknown"
        source_label = (
            "IBKR local OI model"
            if source == "ibkr-local-oi-model"
            else "SSCGEX"
            if source == "sscgex"
            else "ZeroGEX"
            if source == "zerogex"
            else source
        )
        heatmap = gex.get("heatmap") or {}
        heatmap_text = (
            f" | flip {heatmap.get('flip')}"
            if heatmap.get("fresh") and _number(heatmap.get("flip"))
            else f" | flip {gex.get('flip')}"
            if _number(gex.get("flip"))
            else f" | heatmap {heatmap.get('status')}"
            if heatmap.get("status") not in {None, "unavailable"}
            else ""
        )
        lines.append(
            _style("GEX", color, "1", "95") + f" [{source_label}]: {regime}"
            f" | put {put_wall.get('strike') or '-'} {put_wall.get('stage') or '-'}"
            f" | call {call_wall.get('strike') or '-'} {call_wall.get('stage') or '-'}"
            f"{heatmap_text}"
        )
    for shadow_name, shadow_gex in (signal.get("gex_shadows") or {}).items():
        if not isinstance(shadow_gex, dict):
            continue
        shadow_label = {
            "sscgex": "SSCGEX",
            "ibkr_local_gex": "IBKR LOCAL GEX",
        }.get(str(shadow_name), str(shadow_name).upper())
        if not shadow_gex.get("available"):
            lines.append(
                _style(f"{shadow_label} SHADOW", color, "1", "90")
                + " (not a trigger): unavailable"
            )
            continue
        shadow_call = shadow_gex.get("call_wall") or {}
        shadow_put = shadow_gex.get("put_wall") or {}
        shadow_heatmap = shadow_gex.get("heatmap") or {}
        shadow_flip = (
            shadow_gex.get("flip")
            if _number(shadow_gex.get("flip"))
            else shadow_heatmap.get("api_flip")
            if _number(shadow_heatmap.get("api_flip"))
            else shadow_heatmap.get("nearest_zero_cross")
        )
        freshness = "fresh" if shadow_gex.get("fresh") else "stale"
        lines.append(
            _style(f"{shadow_label} SHADOW", color, "1", "90")
            + " (not a trigger): "
            + f"{shadow_gex.get('regime') or '-'}/"
            + f"{shadow_gex.get('gamma_regime') or '-'}"
            + f" | put {shadow_put.get('strike') or '-'}"
            + f" | call {shadow_call.get('strike') or '-'}"
            + f" | flip {shadow_flip or '-'}"
            + f" | {freshness}"
        )
    shadow = signal.get("zerogex_shadow") or {}
    if shadow:
        role = str(shadow.get("mode") or "shadow").lower()
        label = "ZEROGEX BIAS" if role == "primary" else "ZEROGEX SHADOW"
        role_text = (
            " (context; GEX summary is primary)"
            if role == "primary"
            else " (not a trigger)"
        )
        if shadow.get("available"):
            bias = shadow.get("trade_bias") or {}
            external_gex = shadow.get("gex_summary") or {}
            comparison = shadow.get("comparison") or {}
            direction = str(bias.get("direction") or "unavailable").upper()
            score = bias.get("bias_score")
            confidence = bias.get("confidence")
            score_text = f"{float(score):+.1f}" if _number(score) else "-"
            confidence_text = f"{float(confidence):.1f}" if _number(confidence) else "-"
            bias_fresh = bool(
                ((shadow.get("data_freshness") or {}).get("trade_bias") or {}).get(
                    "fresh"
                )
            )
            freshness = "fresh" if bias_fresh else "stale"
            outlier_text = (
                " | SSCGEX API flip outlier"
                if comparison.get("sscgex_api_flip_outlier")
                else ""
            )
            lines.append(
                _style(label, color, "1", "96")
                + f"{role_text}: {direction} {score_text}"
                f" | confidence {confidence_text}"
                f" | setup {bias.get('setup') or '-'}"
                f" | flip {external_gex.get('gamma_flip') or '-'}"
                f" | {freshness}{outlier_text}"
            )
        else:
            lines.append(
                _style(label, color, "1", "96")
                + f"{role_text}: unavailable"
            )
    zero_decision = signal.get("zerogex_decision") or {}
    if zero_decision and zero_decision.get("gex_primary"):
        composite = zero_decision.get("composite") or {}
        playbook = zero_decision.get("playbook") or {}
        playbook_state = str(playbook.get("state") or "unavailable").replace("_", " ").upper()
        posture = str(composite.get("posture") or "unavailable").replace("_", " ")
        score = composite.get("score")
        score_text = f"{float(score):.1f}" if _number(score) else "-"
        near_misses = playbook.get("near_misses") or []
        history = zero_decision.get("gex_history") or {}
        percentile = history.get("net_gex_30d_percentile")
        history_text = (
            f" | GEX 30d p{float(percentile):.0f}"
            if _number(percentile)
            else ""
        )
        lines.append(
            _style("ZEROGEX DECISION", color, "1", "94")
            + f": {playbook_state}"
            + f" | MSI {score_text} {posture}"
            + (
                f" | {len(near_misses)} near misses"
                if playbook_state == "STAND DOWN" and near_misses
                else f" | pattern {playbook.get('pattern') or '-'}"
            )
            + history_text
        )
        if playbook_state == "STAND DOWN" and near_misses:
            nearest = near_misses[0] if isinstance(near_misses[0], dict) else {}
            missing = nearest.get("missing") or []
            detail = str(missing[0]) if missing else "provider conditions not met"
            lines.append(
                _style("ZEROGEX NEAR MISS", color, "1", "90")
                + f": {nearest.get('pattern') or '-'} — {detail}"
            )
        active_advanced = zero_decision.get("active_advanced") or []
        if active_advanced:
            advanced_text = []
            labels = {
                "vol_expansion": "Vol expansion",
                "eod_pressure": "EOD pressure",
                "squeeze_setup": "Squeeze",
                "trap_detection": "Trap",
                "zero_dte_position_imbalance": "0DTE imbalance",
                "gamma_vwap_confluence": "Gamma/VWAP",
                "range_break_imminence": "Range break",
                "market_pressure": "Market pressure",
            }
            for item in active_advanced[:4]:
                name = str(item.get("name") or "")
                direction = str(item.get("direction") or "neutral").upper()
                score_value = item.get("score")
                detail = (
                    f" {float(item['imminence']):.0f}% imminent"
                    if _number(item.get("imminence"))
                    else f" expansion {float(item['expansion']):.0f}"
                    if _number(item.get("expansion"))
                    else f" {float(score_value):+.0f}"
                    if _number(score_value)
                    else ""
                )
                direction_text = (
                    direction
                    if item.get("directional")
                    else f"{direction} direction weak"
                )
                advanced_text.append(
                    f"{labels.get(name, name)} {direction_text}{detail}"
                )
            lines.append(
                _style("ZEROGEX ADVANCED", color, "1", "94")
                + ": "
                + " | ".join(advanced_text)
            )
    lines.append(_style("ADVISORY ONLY • execution disabled", color, "2"))
    return "\n".join(lines) + "\n"


def _compact_signal_side(
    signal: dict[str, Any],
) -> tuple[str | None, dict[str, Any]]:
    favoring = str(signal.get("favoring") or "").lower()
    if favoring == "calls":
        return "CALL", signal.get("call_setup") or {}
    if favoring == "puts":
        return "PUT", signal.get("put_setup") or {}
    phase = str(signal.get("signal_phase") or "").upper()
    if phase in {
        "COMPLETED",
        "INVALIDATED",
        "SESSION_CLOSED",
        "TRACKING_ABORTED",
    }:
        for side, setup_name in (("CALL", "call_setup"), ("PUT", "put_setup")):
            setup = signal.get(setup_name) or {}
            if str(setup.get("status") or "").lower() in {
                "completed",
                "protected_exit",
                "invalidated",
                "time_exit",
                "tracking_gap_abort",
            }:
                return side, setup
    return None, {}


def _compact_risks(signal: dict[str, Any]) -> list[str]:
    risks: list[str] = []
    state = str(signal.get("state") or "").upper()
    rvol = (signal.get("market_context") or {}).get("rvol_1m")
    if _number(rvol) and float(rvol) < 1.2:
        risks.append(f"weak volume (RVOL {float(rvol):.2f})")

    zero = signal.get("zerogex_decision") or {}
    favoring = str(signal.get("favoring") or "").lower()
    trade_bias = zero.get("trade_bias") or {}
    if (
        trade_bias.get("fresh")
        and trade_bias.get("style") == "mean_reversion"
    ):
        risks.append("ZeroGEX favors range fades, not continuation")
    elif (
        trade_bias.get("fresh")
        and trade_bias.get("directional_confirmation")
        and trade_bias.get("side") in {"calls", "puts"}
        and trade_bias.get("side") != favoring
        and _number(trade_bias.get("score"))
        and abs(float(trade_bias["score"])) >= 30
        and _number(trade_bias.get("confidence"))
        and float(trade_bias["confidence"]) >= 30
    ):
        risks.append("ZeroGEX directional context conflicts")
    if (zero.get("positioning_trap") or {}).get("strong"):
        risks.append("strong Positioning Trap favors mean reversion")
    if any(
        isinstance(item, dict)
        and item.get("name") == "range_break_imminence"
        and not item.get("directional")
        for item in zero.get("active_advanced") or []
    ):
        risks.append("ZeroGEX Break Watch still needs a clean break/retest")

    playbook = zero.get("playbook") or {}
    if (
        zero.get("gex_primary")
        and playbook.get("fresh", True)
        and str(playbook.get("state") or "").lower() == "stand_down"
    ):
        risks.append("ZeroGEX has no confirming setup")
    if any(
        isinstance(item, dict)
        and item.get("directional")
        and item.get("side") in {"calls", "puts"}
        and item.get("side") != favoring
        for item in zero.get("active_advanced") or []
    ):
        risks.append("ZeroGEX context conflicts")

    for warning in signal.get("warnings") or []:
        lower = str(warning).lower()
        if "rvol" in lower or "trigger-bar expansion" in lower:
            continue
        if "no confirming playbook setup" in lower:
            risks.append("ZeroGEX has no confirming setup")
        elif (
            "zerogex playbook strongly opposes" in lower
            or "multiple independent zerogex evidence families oppose" in lower
            or "zerogex trade bias conflicts" in lower
        ):
            risks.append("ZeroGEX context conflicts")
        elif "mean-reversion context" in lower:
            risks.append("ZeroGEX favors mean reversion, not continuation")
        elif "break watch" in lower:
            risks.append("ZeroGEX Break Watch still needs a clean break/retest")
        elif "whipsaw" in lower:
            risks.append("VIX/GEX whipsaw raises reversal risk")
        elif "less than 1.5r runway" in lower:
            risks.append("limited runway to the next GEX wall")
        elif (
            "activation window expired" in lower
            and state not in CONTINUATION_OPEN_STATES
        ):
            risks.append("paper-entry window expired")
        elif "msi posture favors chop/range" in lower:
            risks.append("ZeroGEX sees chop/range risk")
        elif "msi posture favors high-risk reversal" in lower:
            risks.append("ZeroGEX sees reversal risk")
    return list(dict.fromkeys(risks))[:2]


def _compact_context(signal: dict[str, Any]) -> str | None:
    gex = signal.get("gex") or {}
    regime = str(gex.get("regime") or "").strip()
    gamma_regime = str(gex.get("gamma_regime") or "").strip()
    context = (
        f"{regime}/{gamma_regime} GEX"
        if regime and gamma_regime
        else None
    )
    risks = _compact_risks(signal)
    if context and risks:
        return f"CONTEXT: {context} | CAUTION: {'; '.join(risks)}"
    if context:
        return f"CONTEXT: {context}"
    if risks:
        return f"CAUTION: {'; '.join(risks)}"
    return None


def _compact_option_line(
    setup: dict[str, Any],
    lifecycle: dict[str, Any],
    *,
    side: str,
) -> str | None:
    option = setup.get("option") or {}
    if not option:
        return None
    contract = format_option_contract(option, side=side)
    premium = lifecycle.get("premium") or {}
    return_pct = premium.get("return_pct")
    mark = (
        f" | mark {float(return_pct):+.1f}%"
        if _number(return_pct)
        else ""
    )
    return f"PAPER OPTION: {contract}{mark}"


def _render_compact_signal(
    signal: dict[str, Any],
    *,
    color: bool,
    entry_event: bool,
) -> str:
    state = str(signal.get("state") or "WAIT").upper()
    phase = str(signal.get("signal_phase") or "").upper()
    side, setup = _compact_signal_side(signal)
    lifecycle = signal.get("lifecycle") or {}
    spot = (
        _quick_level(signal.get("spot"))
        if _number(signal.get("spot"))
        else "unavailable"
    )
    blockers = list(signal.get("blockers") or [])
    targets = list(setup.get("targets") or [])
    invalidation = setup.get("invalidation")
    invalid_direction = "below" if side == "CALL" else "above"
    configured_exit = (signal.get("paper_policy") or {}).get("exit_after_target")
    exit_target_index = (
        min(int(configured_exit), len(targets))
        if _number(configured_exit) and int(configured_exit) > 0 and targets
        else len(targets)
    )
    lines: list[str] = []

    if phase == "COMPLETED":
        close_reason = lifecycle.get("close_reason")
        exit_index = lifecycle.get("exit_target_index")
        exit_label = (
            f"T{int(exit_index)}"
            if _number(exit_index)
            else "T1 premium profit lock"
            if close_reason == "t1_premium_lock"
            else "T1 protected stop"
            if close_reason == "t1_protected_stop"
            else "planned target"
        )
        label = f"PAPER {side} CLOSED" if side else "PAPER POSITION CLOSED"
        lines.append(
            f"{_style('CLOSED', color, '1', '92')} | SPY {spot} | "
            f"{label} at {exit_label}"
        )
        lines.append("NEXT: wait for cooldown and a fresh setup")
    elif phase == "TRACKING_ABORTED":
        lines.append(
            f"{_style('ABORTED', color, '1', '91')} | SPY {spot} | "
            "paper tracking gap was too long to trust the old setup"
        )
        lines.append("NEXT: wait for fresh data and a completely new setup")
    elif phase == "TRACKING_PAUSED":
        label = f"PAPER {side}" if side else "PAPER POSITION"
        lines.append(
            f"{_style('PAUSED', color, '1', '93')} | SPY {spot} | "
            f"{label} tracking is waiting for fresh market data"
        )
        lines.append(
            "NEXT: preserve the paper lifecycle; make no new signal decision"
        )
    elif phase in {"INVALIDATED", "SESSION_CLOSED"}:
        reason = (
            "session cutoff reached"
            if phase == "SESSION_CLOSED"
            else (
                f"{side} setup invalid {invalid_direction} "
                f"{_quick_level(invalidation)}"
                if side and _number(invalidation)
                else "paper setup invalidated"
            )
        )
        lines.append(
            f"{_style('CLOSED', color, '1', '91')} | SPY {spot} | {reason}"
        )
        lines.append("NEXT: wait for a fresh setup")
    elif state in {"MANAGE", "EXTENDED"} and side:
        targets_hit = int(lifecycle.get("targets_hit", 0) or 0)
        lines.append(
            f"{_style('MANAGE', color, '1', '96')} | SPY {spot} | "
            f"PAPER {side} | T{targets_hit} reached"
        )
        remaining = [
            (
                f"T{index + 1} {_quick_level(target)} — CLOSE PAPER POSITION"
                if index + 1 == exit_target_index
                else f"T{index + 1} {_quick_level(target)}"
            )
            for index, target in enumerate(targets)
            if targets_hit <= index < exit_target_index
        ]
        next_target = " → ".join(remaining) if remaining else "planned exit reached"
        lines.append(
            f"NEXT: {next_target} | invalid {invalid_direction} "
            f"{_quick_level(invalidation)}"
        )
        option_line = _compact_option_line(setup, lifecycle, side=side)
        if option_line:
            lines.append(option_line)
    elif state == "ACTIVE" and side:
        premium = lifecycle.get("premium") or {}
        milestone = 20 if premium.get("hit_20_at") else 10 if premium.get("hit_10_at") else None
        if entry_event:
            lines.append(
                f"{_style('PAPER ENTRY', color, '1', '92')} | SPY {spot} | "
                f"{side} trigger confirmed"
            )
        elif milestone:
            lines.append(
                f"{_style('MANAGE', color, '1', '96')} | SPY {spot} | "
                f"PAPER {side} | premium +{milestone}% reached"
            )
        elif lifecycle.get("entry_allowed") is False:
            lines.append(
                f"{_style('PAPER TRACKING ONLY', color, '1', '93')} | "
                f"SPY {spot} | {side} trigger occurred, but the new-entry "
                "gate is closed"
            )
        else:
            lines.append(
                f"{_style('PAPER ACTIVE', color, '1', '96')} | SPY {spot} | "
                f"{side} plan in progress"
            )
        planned_targets = " → ".join(
            (
                f"T{index + 1} {_quick_level(target)} — CLOSE PAPER POSITION"
                if index + 1 == exit_target_index
                else f"T{index + 1} {_quick_level(target)}"
            )
            for index, target in enumerate(targets[:exit_target_index])
        )
        lines.append(
            f"PLAN: {planned_targets or 'targets unavailable'} | "
            f"invalid {invalid_direction} {_quick_level(invalidation)}"
        )
        option_line = _compact_option_line(setup, lifecycle, side=side)
        if option_line:
            lines.append(option_line)
    elif blockers:
        primary = _quick_blocker(blockers[0])
        extra = (
            f"; +{len(blockers) - 1} other blocker"
            f"{'s' if len(blockers) - 1 != 1 else ''}"
            if len(blockers) > 1
            else ""
        )
        lines.append(
            f"{_style('NO TRADE', color, '1', '91')} | SPY {spot} | "
            f"{primary}{extra}"
        )
        lines.append("NEXT: wait for all mandatory gates to clear")
    elif side and setup:
        state_label = "setup armed" if state == "ARMED" else "setup not confirmed"
        lines.append(
            f"{_style('WAIT', color, '1', '93')} | SPY {spot} | "
            f"{side} {state_label}"
        )
        direction = "above" if side == "CALL" else "below"
        trigger_mode = (
            "armed intrabar move"
            if signal.get("strategy") in FROZEN_SETUP_STRATEGIES
            and state in WATCH_STATES
            else "completed 1m close"
        )
        first_target = (
            f" | T1 {_quick_level(targets[0])}"
            if targets
            else ""
        )
        lines.append(
            f"PAPER TRIGGER: {trigger_mode} {direction} "
            f"{_quick_level(setup.get('trigger'))} | "
            f"invalid {invalid_direction} {_quick_level(invalidation)}"
            f"{first_target}"
        )
    else:
        lines.append(
            f"{_style('NO TRADE', color, '1', '91')} | SPY {spot} | "
            "no complete setup"
        )
        lines.append("NEXT: wait for aligned price structure")

    context_line = _compact_context(signal)
    if context_line and phase not in {
        "COMPLETED",
        "INVALIDATED",
        "SESSION_CLOSED",
        "TRACKING_ABORTED",
        "TRACKING_PAUSED",
    }:
        lines.append(context_line)
    lines.append(_style("ADVISORY ONLY • execution disabled", color, "2"))
    return "\n".join(lines) + "\n"


def render_signal(
    signal: dict[str, Any],
    *,
    color: bool = False,
    details: bool = False,
    entry_event: bool = False,
) -> str:
    """Render the compact decision by default, with an optional audit view."""
    if details:
        return _render_signal_details(signal, color=color)
    return _render_compact_signal(
        signal,
        color=color,
        entry_event=entry_event,
    )
