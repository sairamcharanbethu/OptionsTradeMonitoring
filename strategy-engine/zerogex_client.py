#!/usr/bin/env python3
"""Read-only ZeroGEX API client for GEX, confluence, and signal research."""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable

BASE_URL = "https://api.zerogex.io"
USER_AGENT = "ClaudeCodeAgent-signal-only-v2/1.0"
DEFAULT_TIMEOUT = 10.0

BIAS_FIELDS = (
    "bias_score",
    "direction",
    "state",
    "confidence",
    "confidence_raw",
    "regime_label",
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
    "regime_desc",
    "conviction_driven",
    "breadth",
    "override",
    "aggregate",
    "max_confidence_raw",
)
GEX_FIELDS = (
    "symbol",
    "timestamp",
    "spot_price",
    "gamma_flip",
    "gamma_flip_raw",
    "gamma_flip_span_used",
    "flip_distance",
    "call_wall",
    "put_wall",
    "max_pain",
    "net_gex",
    "net_gex_at_spot",
    "local_gex",
    "put_call_ratio",
    "convexity_risk",
)
MARKET_QUOTE_FIELDS = (
    "timestamp",
    "symbol",
    "open",
    "high",
    "low",
    "close",
    "volume",
    "session",
    "display_source",
    "data_symbol",
)
MARKET_BAR_FIELDS = (
    "timestamp",
    "symbol",
    "open",
    "high",
    "low",
    "close",
    "volume",
    "session",
)
SESSION_LEVEL_FIELDS = (
    "symbol",
    "trading_date",
    "premarket_high",
    "premarket_low",
    "prev_session_date",
    "prev_session_high",
    "prev_session_low",
    "source",
    "updated_at",
)
FORCED_FLOW_FIELDS = (
    "symbol",
    "timestamp",
    "spot",
    "gamma_flip",
    "charm_flip",
    "vanna_flip",
    "zero_flow_level",
)
DEALER_HEDGING_FIELDS = (
    "timestamp",
    "time_et",
    "symbol",
    "current_price",
    "price_change",
    "expected_hedge_shares",
    "hedge_pressure",
)
BASIC_SIGNAL_FIELDS = (
    "score",
    "clamped_score",
    "direction",
    "timestamp",
    "source",
    "context_values",
)
COMPOSITE_CONTEXT_FIELDS = (
    "flip_distance_subscore",
    "local_gamma_subscore",
    "price_vs_max_gamma_subscore",
    "net_gex",
    "put_call_ratio",
    "vix_level",
    "imbalance_ratio",
    "dealer_net_delta_estimated",
)
ADVANCED_ENDPOINTS = {
    "vol_expansion": "/api/signals/advanced/vol-expansion",
    "eod_pressure": "/api/signals/advanced/eod-pressure",
    "squeeze_setup": "/api/signals/advanced/squeeze-setup",
    "trap_detection": "/api/signals/advanced/trap-detection",
    "zero_dte_position_imbalance": "/api/signals/advanced/0dte-position-imbalance",
    "gamma_vwap_confluence": "/api/signals/advanced/gamma-vwap-confluence",
    "range_break_imminence": "/api/signals/advanced/range-break-imminence",
    "market_pressure": "/api/signals/advanced/market-pressure",
}
ADVANCED_COMMON_FIELDS = (
    "timestamp",
    "score",
    "clamped_score",
    "weighted_score",
    "weight",
    "direction",
    "triggered",
    "signal",
    "label",
    "playbook",
)
ADVANCED_DETAIL_FIELDS = {
    "vol_expansion": (
        "expansion",
        "direction_score",
        "magnitude",
        "expected_5min_move_bps",
        "vix_regime",
    ),
    "eod_pressure": (
        "time_ramp",
        "charm_at_spot",
        "pin_target",
        "pin_distance_pct",
        "gamma_regime",
        "calendar_flags",
    ),
    "squeeze_setup": (
        "call_flow_delta",
        "put_flow_delta",
        "call_flow_z",
        "put_flow_z",
        "momentum_z",
        "momentum_5bar",
        "momentum_10bar",
        "accel_dn",
        "accel_up",
        "flow_norm_used",
        "vix_regime",
    ),
    "trap_detection": (
        "breakout_up",
        "breakout_down",
        "breakout_buffer_pct",
        "broken_resistance_level",
        "broken_support_level",
        "call_wall",
        "put_wall",
        "call_wall_migrated_up",
        "put_wall_migrated_down",
        "net_gex_delta",
        "net_gex_delta_pct",
    ),
    "zero_dte_position_imbalance": (
        "flow_imbalance",
        "smart_imbalance",
        "flow_source",
        "tod_multiplier",
        "pcr_tilt",
    ),
    "gamma_vwap_confluence": (
        "confluence_level",
        "expected_target",
        "cluster_gap_pct",
        "vwap",
        "gamma_flip",
        "call_wall",
        "max_gamma",
        "max_pain",
    ),
    "range_break_imminence": (
        "imminence",
        "bias",
    ),
    "market_pressure": (
        "loading",
        "direction_value",
        "direction_sign",
        "confidence_mult",
    ),
}

ADVANCED_CONTEXT_FIELDS = {
    "vol_expansion": (
        "expansion",
        "direction_score",
        "magnitude",
        "expected_5min_move_bps",
        "vix_regime",
    ),
    "eod_pressure": (
        "time_ramp",
        "charm_at_spot",
        "pin_target",
        "pin_distance_pct",
        "gamma_regime",
        "calendar_flags",
    ),
    "squeeze_setup": (
        "accel_dn",
        "accel_up",
        "momentum_5bar",
        "momentum_10bar",
        "momentum_z",
        "call_flow_z",
        "put_flow_z",
        "call_flow_delta",
        "put_flow_delta",
        "flow_norm_used",
        "vix_regime",
        "gamma_flip",
    ),
    "trap_detection": (
        "breakout_up",
        "breakout_down",
        "broken_resistance_level",
        "broken_support_level",
        "call_wall_migrated_up",
        "put_wall_migrated_down",
        "net_gex_delta",
        "net_gex_delta_pct",
    ),
    "zero_dte_position_imbalance": (
        "flow_imbalance",
        "smart_imbalance",
        "flow_source",
        "tod_multiplier",
        "pcr_tilt",
        "put_call_ratio",
    ),
    "gamma_vwap_confluence": (
        "confluence_level",
        "expected_target",
        "cluster_gap_pct",
        "vwap",
        "gamma_flip",
        "call_wall",
        "max_gamma",
        "max_pain",
    ),
    "range_break_imminence": (
        "imminence",
        "bias",
        "compression",
        "trap",
    ),
    "market_pressure": (
        "loading",
        "direction_sign",
        "confidence_mult",
        "compression",
        "tension",
    ),
}


class ZeroGEXError(RuntimeError):
    """Safe client error that never includes an API key."""


class ZeroGEXAuthError(ZeroGEXError):
    """Authentication or entitlement failure."""


def _env_file_value(path: Path, name: str) -> str | None:
    try:
        lines = path.read_text().splitlines()
    except OSError:
        return None
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key.strip() == name:
            return value.strip().strip('"').strip("'") or None
    return None


def get_api_key(env_file: Path | None = Path(".env")) -> str:
    key = os.environ.get("ZEROGEX_API_KEY")
    if not key and env_file is not None:
        key = _env_file_value(env_file, "ZEROGEX_API_KEY")
    if not key:
        raise ZeroGEXAuthError(
            "ZEROGEX_API_KEY is not configured; generate a Pro API key and add it to .env"
        )
    return key.strip()


def _request_json(
    path: str,
    params: dict[str, Any],
    *,
    api_key: str,
    timeout: float = DEFAULT_TIMEOUT,
    opener: Callable[..., Any] = urllib.request.urlopen,
) -> Any:
    url = f"{BASE_URL}{path}?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        },
    )
    try:
        with opener(request, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        if exc.code in {401, 403}:
            raise ZeroGEXAuthError(
                f"ZeroGEX authentication or Pro entitlement failed (HTTP {exc.code})"
            ) from exc
        raise ZeroGEXError(f"ZeroGEX request failed (HTTP {exc.code})") from exc
    except urllib.error.URLError as exc:
        reason = getattr(exc, "reason", None)
        reason_name = type(reason).__name__ if reason is not None else "network error"
        raise ZeroGEXError(f"ZeroGEX request failed ({reason_name})") from exc
    except (json.JSONDecodeError, TimeoutError, OSError) as exc:
        raise ZeroGEXError(
            f"ZeroGEX response failed ({type(exc).__name__})"
        ) from exc


def _select_fields(payload: Any, fields: tuple[str, ...]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    return {field: payload.get(field) for field in fields if field in payload}


def _number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if result == result and abs(result) != float("inf") else None


def _node_trend(current: Any, previous: Any) -> str:
    current_number = _number(current)
    previous_number = _number(previous)
    if current_number is None or previous_number is None:
        return "stable"
    current_magnitude = abs(current_number)
    previous_magnitude = abs(previous_number)
    if previous_magnitude <= 0:
        return "building" if current_magnitude > 0 else "stable"
    ratio = current_magnitude / previous_magnitude
    if ratio >= 1.10:
        return "building"
    if ratio <= 0.90:
        return "fading"
    return "stable"


def _normalize_strike_context(payload: Any) -> dict[str, Any]:
    """Compress the strike rewind feed into node strength and migration context."""
    if not isinstance(payload, list):
        return {}
    buckets = sorted(
        (item for item in payload if isinstance(item, dict)),
        key=lambda item: str(item.get("timestamp") or ""),
    )
    if not buckets:
        return {}
    latest = buckets[-1]
    baseline = buckets[0]
    spot = _number(latest.get("close"))
    current_rows = {
        float(strike): row
        for row in (latest.get("strikes") or [])
        if isinstance(row, dict)
        and (strike := _number(row.get("strike"))) is not None
    }
    previous_rows = {
        float(strike): row
        for row in (baseline.get("strikes") or [])
        if isinstance(row, dict)
        and (strike := _number(row.get("strike"))) is not None
    }
    if not current_rows:
        return {
            "status": "unavailable",
            "timestamp": latest.get("timestamp"),
            "message": "ZeroGEX strike profile contains no recognized strikes",
        }
    band = max(10.0, (spot or 0.0) * 0.03)
    nearby = {
        strike: row
        for strike, row in current_rows.items()
        if spot is None or abs(strike - spot) <= band
    } or current_rows
    max_magnitude = max(
        abs(_number(row.get("net_gamma")) or 0.0)
        for row in nearby.values()
    ) or 1.0
    nodes = []
    for strike, row in nearby.items():
        gex = _number(row.get("net_gamma"))
        if gex is None:
            continue
        prior = previous_rows.get(strike) or {}
        prior_gex = _number(prior.get("net_gamma"))
        change = gex - prior_gex if prior_gex is not None else None
        nodes.append(
            {
                "strike": strike,
                "gex": gex,
                "change": change,
                "trend": _node_trend(gex, prior_gex),
                "magnitude_ratio": round(abs(gex) / max_magnitude, 4),
                "call_gex": _number(row.get("call_gamma")),
                "put_gex": _number(row.get("put_gamma")),
                "call_oi": _number(row.get("call_oi")),
                "put_oi": _number(row.get("put_oi")),
            }
        )
    nodes.sort(key=lambda item: abs(float(item["gex"])), reverse=True)
    positive = [item for item in nodes if float(item["gex"]) > 0][:8]
    negative = [item for item in nodes if float(item["gex"]) < 0][:8]

    def wall_strength(kind: str) -> dict[str, Any]:
        field = "call_gamma" if kind == "call" else "put_gamma"
        wall = _number(latest.get(f"{kind}_wall"))
        if wall is None:
            return {}
        row = current_rows.get(float(wall)) or {}
        previous = previous_rows.get(float(wall)) or {}
        value = _number(row.get(field))
        prior = _number(previous.get(field))
        values = [
            abs(number)
            for item in nearby.values()
            if (number := _number(item.get(field))) is not None
        ]
        maximum = max(values) if values else 0.0
        return {
            "strike": wall,
            "gex": value,
            "strength_ratio": (
                round(abs(value) / maximum, 4)
                if value is not None and maximum > 0
                else None
            ),
            "trend": _node_trend(value, prior),
            "migrated": wall != _number(baseline.get(f"{kind}_wall")),
            "previous_strike": _number(baseline.get(f"{kind}_wall")),
        }

    migrations = []
    for kind in ("call", "put"):
        previous_wall = _number(baseline.get(f"{kind}_wall"))
        current_wall = _number(latest.get(f"{kind}_wall"))
        if (
            previous_wall is not None
            and current_wall is not None
            and previous_wall != current_wall
        ):
            migrations.append(
                {
                    "kind": f"{kind}_wall",
                    "from": previous_wall,
                    "to": current_wall,
                    "direction": "up" if current_wall > previous_wall else "down",
                    "toward_spot": (
                        abs(current_wall - spot) < abs(previous_wall - spot)
                        if spot is not None
                        else None
                    ),
                }
            )
    dominant_migration = (
        min(
            migrations,
            key=lambda item: abs(float(item["to"]) - float(spot)),
        )
        if migrations and spot is not None
        else migrations[0]
        if migrations
        else None
    )
    return {
        "status": "ok",
        "source": "zerogex_strike_profile",
        "timestamp": latest.get("timestamp"),
        "lookback_start": baseline.get("timestamp"),
        "spot": spot,
        "flip": _number(latest.get("gamma_flip")),
        "api_flip": _number(latest.get("gamma_flip")),
        "nearest_zero_cross": _number(latest.get("gamma_flip")),
        "net_gex": sum(float(item["gex"]) for item in nodes),
        "positive_nodes": positive,
        "negative_nodes": negative,
        "strongest_nodes": nodes[:10],
        "building_positive": [
            {"strike": item["strike"], "change": item["change"]}
            for item in positive
            if item.get("trend") == "building"
        ],
        "building_negative": [
            {"strike": item["strike"], "change": item["change"]}
            for item in negative
            if item.get("trend") == "building"
        ],
        "dominant_migration": dominant_migration,
        "wall_strength": {
            "call": wall_strength("call"),
            "put": wall_strength("put"),
        },
        "sample_count": len(buckets),
    }


def _normalize_flow_context(
    flow_series: Any,
    smart_money: Any,
) -> dict[str, Any]:
    series = sorted(
        (item for item in flow_series if isinstance(item, dict)),
        key=lambda item: str(item.get("timestamp") or ""),
        reverse=True,
    ) if isinstance(flow_series, list) else []
    smart_rows = sorted(
        (item for item in smart_money if isinstance(item, dict)),
        key=lambda item: str(item.get("timestamp") or ""),
        reverse=True,
    ) if isinstance(smart_money, list) else []
    latest = series[0] if series else {}
    net_premium = _number(latest.get("net_premium_cum"))
    gross_premium = sum(
        abs(value)
        for value in (
            _number(latest.get("call_premium_cum")),
            _number(latest.get("put_premium_cum")),
        )
        if value is not None
    )
    flow_direction = (
        "calls"
        if net_premium is not None and net_premium > 0
        else "puts"
        if net_premium is not None and net_premium < 0
        else "mixed"
    )
    smart_score = 0.0
    smart_gross = 0.0
    compact_smart = []
    for row in smart_rows[:20]:
        notional = _number(row.get("notional"))
        right = str(row.get("option_type") or "").upper()
        trade_side = str(row.get("trade_side") or "").upper()
        if notional is not None:
            sign = (
                1
                if (right == "C" and trade_side == "BUY")
                or (right == "P" and trade_side == "SELL")
                else -1
                if (right == "P" and trade_side == "BUY")
                or (right == "C" and trade_side == "SELL")
                else 0
            )
            smart_score += sign * abs(notional)
            smart_gross += abs(notional)
        compact_smart.append(
            _select_fields(
                row,
                (
                    "timestamp",
                    "contract",
                    "strike",
                    "expiration",
                    "dte",
                    "option_type",
                    "flow",
                    "notional",
                    "trade_side",
                    "delta",
                    "score",
                    "underlying_price",
                ),
            )
        )
    smart_direction = (
        "calls" if smart_score > 0 else "puts" if smart_score < 0 else "mixed"
    )
    return {
        "timestamp": latest.get("timestamp") or (
            smart_rows[0].get("timestamp") if smart_rows else None
        ),
        "direction": flow_direction,
        "strength": (
            round(abs(net_premium) / gross_premium, 4)
            if net_premium is not None and gross_premium > 0
            else None
        ),
        "net_premium": net_premium,
        "put_call_ratio": _number(latest.get("put_call_ratio")),
        "underlying_price": _number(latest.get("underlying_price")),
        "smart_money": {
            "direction": smart_direction,
            "strength": (
                round(abs(smart_score) / smart_gross, 4)
                if smart_gross > 0
                else None
            ),
            "net_notional": smart_score,
            "heuristic": True,
            "rows": compact_smart,
        },
        "aligned": (
            flow_direction == smart_direction
            and flow_direction in {"calls", "puts"}
        ),
        "bars": [
            _select_fields(
                row,
                (
                    "timestamp",
                    "call_premium_cum",
                    "put_premium_cum",
                    "net_premium_cum",
                    "call_volume_cum",
                    "put_volume_cum",
                    "net_volume_cum",
                    "put_call_ratio",
                    "underlying_price",
                    "contract_count",
                    "is_synthetic",
                ),
            )
            for row in series[:12]
        ],
    }


def _normalize_session_context(
    session_levels: Any,
    technicals: Any,
) -> dict[str, Any]:
    levels = _select_fields(session_levels, SESSION_LEVEL_FIELDS)
    bars = (
        [item for item in technicals.get("bars") or [] if isinstance(item, dict)]
        if isinstance(technicals, dict)
        else []
    )
    latest = max(bars, key=lambda item: str(item.get("timestamp") or "")) if bars else {}
    divergence = latest.get("momentum_divergence") or {}
    divergence_text = str(divergence.get("divergence_signal") or "").lower()
    divergence_direction = (
        "calls"
        if "bullish" in divergence_text
        else "puts"
        if "bearish" in divergence_text
        else "mixed"
    )
    return {
        "timestamp": latest.get("timestamp") or levels.get("updated_at"),
        "levels": levels,
        "opening_range": _select_fields(
            latest.get("opening_range"),
            (
                "orb_high",
                "orb_low",
                "orb_range",
                "distance_above_orb_high",
                "distance_below_orb_low",
                "orb_pct",
                "orb_status",
            ),
        ),
        "vwap": _select_fields(
            latest.get("vwap_deviation"),
            ("vwap", "vwap_deviation_pct", "vwap_position"),
        ),
        "volume": _select_fields(
            latest.get("volume_spike"),
            (
                "current_volume",
                "avg_volume",
                "volume_sigma",
                "volume_ratio",
                "buying_pressure_pct",
                "volume_class",
            ),
        ),
        "momentum_divergence": {
            **_select_fields(
                divergence,
                ("chg_5m", "opt_flow", "divergence_signal"),
            ),
            "direction": divergence_direction,
        },
    }


def _normalize_dealer_hedging(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, list):
        return {}
    rows = [item for item in payload if isinstance(item, dict)]
    if not rows:
        return {}
    latest = max(rows, key=lambda item: str(item.get("timestamp") or ""))
    return _select_fields(latest, DEALER_HEDGING_FIELDS)


def _normalize_composite(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    components: dict[str, Any] = {}
    for name, value in (payload.get("components") or {}).items():
        if not isinstance(value, dict):
            continue
        context = value.get("context") or {}
        compact_context = {
            field: context.get(field)
            for field in COMPOSITE_CONTEXT_FIELDS
            if field in context
        }
        components[str(name)] = {
            field: value.get(field)
            for field in ("max_points", "contribution", "score")
            if field in value
        }
        if compact_context:
            components[str(name)]["context"] = compact_context
    return {
        "timestamp": payload.get("timestamp"),
        "score": payload.get("composite_score"),
        "components": components,
    }


def _normalize_playbook(payload: Any) -> dict[str, Any]:
    """Keep decision reasoning while discarding option legs and order-like fields."""
    if not isinstance(payload, dict):
        return {}
    raw_action = str(payload.get("action") or "").upper()
    state = (
        "stand_down"
        if raw_action == "STAND_DOWN"
        else "candidate"
        if raw_action
        else "unavailable"
    )
    near_misses = []
    for item in (payload.get("near_misses") or [])[:12]:
        if not isinstance(item, dict):
            continue
        near_misses.append(
            {
                "pattern": item.get("pattern"),
                "missing": [
                    str(reason)[:400]
                    for reason in (item.get("missing") or [])[:8]
                ],
            }
        )
    context = payload.get("context") or {}
    return {
        "timestamp": payload.get("timestamp"),
        "state": state,
        "pattern": payload.get("pattern"),
        "direction": payload.get("direction"),
        "confidence": payload.get("confidence"),
        "rationale": str(payload.get("rationale") or "")[:1200] or None,
        "near_misses": near_misses,
        "context": {
            field: context.get(field)
            for field in ("msi", "regime")
            if field in context
        },
    }


def _normalize_advanced(payloads: Any) -> dict[str, Any]:
    if not isinstance(payloads, dict):
        return {}
    normalized: dict[str, Any] = {}
    for name, payload in payloads.items():
        if name not in ADVANCED_ENDPOINTS or not isinstance(payload, dict):
            continue
        fields = ADVANCED_COMMON_FIELDS + ADVANCED_DETAIL_FIELDS.get(name, ())
        item = _select_fields(payload, fields)
        context = payload.get("context_values")
        compact_context = _select_fields(
            context,
            (
                "triggered",
                "signal",
                "label",
                "playbook",
                "direction",
            )
            + ADVANCED_CONTEXT_FIELDS.get(name, ()),
        )
        if compact_context:
            item["context_values"] = compact_context
            # Some endpoint versions expose these fields only inside
            # context_values. Promote the stable decision fields so the
            # downstream engine does not depend on the provider's layout.
            for field in (
                "triggered",
                "signal",
                "label",
                "playbook",
                "direction",
            ) + ADVANCED_DETAIL_FIELDS.get(name, ()):
                if field not in item and field in compact_context:
                    item[field] = compact_context[field]
        normalized[name] = item
    return normalized


def _normalize_gex_history(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    metrics = {}
    for metric_name, metric in (payload.get("metrics") or {}).items():
        if not isinstance(metric, dict):
            continue
        windows = {}
        for window_name, window in (metric.get("windows") or {}).items():
            if not isinstance(window, dict):
                continue
            windows[str(window_name)] = {
                field: window.get(field)
                for field in (
                    "percentile",
                    "z_score",
                    "regime",
                    "sample_size",
                    "is_record_high",
                    "is_record_low",
                )
                if field in window
            }
        metrics[str(metric_name)] = {
            "current": metric.get("current"),
            "windows": windows,
        }
    return {
        "timestamp": payload.get("timestamp"),
        "in_rth": payload.get("in_rth"),
        "tod_bucket": payload.get("tod_bucket"),
        "metrics": metrics,
    }


def _normalize_market_volatility(payload: Any) -> dict[str, Any]:
    return _select_fields(
        payload,
        (
            "timestamp",
            "index",
            "level",
            "level_label",
            "momentum",
            "momentum_label",
        ),
    )


def _normalize_market_bars(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, list):
        return []
    bars = [
        _select_fields(item, MARKET_BAR_FIELDS)
        for item in payload[:576]
        if isinstance(item, dict)
    ]
    return sorted(bars, key=lambda item: str(item.get("timestamp") or ""))


def normalize_snapshot(
    symbol: str,
    trade_bias: Any,
    gex_summary: Any,
    basic_signals: Any,
    *,
    fetched_at: float | None = None,
    composite: Any = None,
    playbook: Any = None,
    advanced_signals: Any = None,
    gex_history: Any = None,
    market_volatility: Any = None,
    market_quote: Any = None,
    market_bars: Any = None,
    strike_profile: Any = None,
    flow_series: Any = None,
    smart_money: Any = None,
    session_levels: Any = None,
    technicals: Any = None,
    dealer_hedging: Any = None,
    forced_flow_levels: Any = None,
    endpoint_errors: dict[str, str] | None = None,
) -> dict[str, Any]:
    normalized_signals = {}
    if isinstance(basic_signals, dict):
        for name, value in (basic_signals.get("signals") or {}).items():
            if value is None:
                normalized_signals[str(name)] = None
            else:
                normalized_signals[str(name)] = _select_fields(
                    value, BASIC_SIGNAL_FIELDS
                )
    return {
        "fetched_at": time.time() if fetched_at is None else float(fetched_at),
        "source": "zerogex",
        "mode": "shadow",
        "symbol": symbol.upper(),
        "trade_bias": _select_fields(trade_bias, BIAS_FIELDS),
        "gex_summary": _select_fields(gex_summary, GEX_FIELDS),
        "basic_signals": normalized_signals,
        "composite": _normalize_composite(composite),
        "playbook": _normalize_playbook(playbook),
        "advanced_signals": _normalize_advanced(advanced_signals),
        "gex_history": _normalize_gex_history(gex_history),
        "market_volatility": _normalize_market_volatility(market_volatility),
        "market_quote": _select_fields(market_quote, MARKET_QUOTE_FIELDS),
        "market_bars": _normalize_market_bars(market_bars),
        "strike_context": _normalize_strike_context(strike_profile),
        "flow_context": _normalize_flow_context(flow_series, smart_money),
        "session_context": _normalize_session_context(session_levels, technicals),
        "dealer_hedging": _normalize_dealer_hedging(dealer_hedging),
        "forced_flow": _select_fields(forced_flow_levels, FORCED_FLOW_FIELDS),
        "endpoint_errors": dict(endpoint_errors or {}),
    }


def _gex_summary_request_specs(
    symbol: str,
) -> dict[str, tuple[str, dict[str, Any]]]:
    return {
        "gex_summary": ("/api/gex/summary", {"symbol": symbol}),
    }


def _core_context_request_specs(
    symbol: str,
) -> dict[str, tuple[str, dict[str, Any]]]:
    return {
        "trade_bias": (
            "/api/signals/trade-bias",
            {"underlying": symbol, "tenor": "intraday"},
        ),
        "basic_signals": ("/api/signals/basic", {"symbol": symbol}),
        "composite": ("/api/signals/score", {"underlying": symbol}),
        "playbook": ("/api/signals/action", {"underlying": symbol}),
        "market_quote": ("/api/market/quote", {"symbol": symbol}),
        "market_bars": (
            "/api/market/historical",
            {
                "symbol": symbol,
                "timeframe": "1min",
                "window_units": 576,
            },
        ),
    }


def _deep_context_request_specs(
    symbol: str,
) -> dict[str, tuple[str, dict[str, Any]]]:
    specs: dict[str, tuple[str, dict[str, Any]]] = {
        f"advanced:{name}": (path, {"symbol": symbol})
        for name, path in ADVANCED_ENDPOINTS.items()
    }
    specs.update(
        {
            "gex_history": (
                "/api/gex/historical-context",
                {"symbol": symbol},
            ),
            "market_volatility": (
                "/api/market/volatility",
                {"ticker": "VXN" if symbol.upper() == "QQQ" else "VIX"},
            ),
            "strike_profile": (
                "/api/gex/strike-profile-timeseries",
                {
                    "symbol": symbol,
                    "timeframe": "1min",
                    "window_units": 20,
                    "expirations": "all",
                },
            ),
            "flow_series": (
                "/api/flow/series",
                {"symbol": symbol, "session": "current", "intervals": 12},
            ),
            "smart_money": (
                "/api/flow/smart-money",
                {"symbol": symbol, "session": "current", "limit": 20},
            ),
            "session_levels": (
                "/api/market/session-levels",
                {"symbol": symbol},
            ),
            "technicals": (
                "/api/technicals",
                {"symbol": symbol, "intervals": 12},
            ),
            "dealer_hedging": (
                "/api/technicals/dealer-hedging",
                {"symbol": symbol},
            ),
            "forced_flow_levels": (
                "/api/forced-flow/levels",
                {"symbol": symbol},
            ),
        }
    )
    return specs


def _request_specs(
    symbol: str,
    include_extended: bool,
) -> dict[str, tuple[str, dict[str, Any]]]:
    specs = {
        **_core_context_request_specs(symbol),
        **_gex_summary_request_specs(symbol),
    }
    if include_extended:
        specs.update(_deep_context_request_specs(symbol))
    return specs


def _fetch_payloads(
    specs: dict[str, tuple[str, dict[str, Any]]],
    *,
    api_key: str,
    timeout: float,
    request_json: Callable[..., Any],
) -> tuple[dict[str, Any], dict[str, str], dict[str, Exception]]:
    payloads: dict[str, Any] = {}
    errors: dict[str, str] = {}
    exceptions: dict[str, Exception] = {}

    def fetch(item: tuple[str, tuple[str, dict[str, Any]]]) -> tuple[str, Any]:
        name, (path, params) = item
        return name, request_json(
            path,
            params,
            api_key=api_key,
            timeout=timeout,
        )

    with concurrent.futures.ThreadPoolExecutor(
        max_workers=min(8, max(1, len(specs)))
    ) as executor:
        future_names = {
            executor.submit(fetch, item): item[0]
            for item in specs.items()
        }
        for future in concurrent.futures.as_completed(future_names):
            name = future_names[future]
            try:
                result_name, payload = future.result()
                payloads[result_name] = payload
            except Exception as exc:
                errors[name] = f"{type(exc).__name__}: {exc}"
                exceptions[name] = exc
    return payloads, errors, exceptions


def _snapshot_from_payloads(
    symbol: str,
    payloads: dict[str, Any],
    endpoint_errors: dict[str, str],
) -> dict[str, Any]:
    market_volatility = payloads.get("market_volatility")
    if isinstance(market_volatility, dict) and market_volatility:
        expected_index = "VXN" if symbol.upper() == "QQQ" else "VIX"
        returned_index = str(market_volatility.get("index") or "").upper()
        if returned_index != expected_index:
            endpoint_errors["market_volatility"] = (
                "ZeroGEX returned volatility index "
                f"{returned_index or 'missing'} for {symbol.upper()}; "
                f"expected {expected_index}"
            )
            payloads.pop("market_volatility", None)
    advanced_payloads = {
        name.removeprefix("advanced:"): payload
        for name, payload in payloads.items()
        if name.startswith("advanced:")
    }
    return normalize_snapshot(
        symbol,
        payloads.get("trade_bias"),
        payloads.get("gex_summary"),
        payloads.get("basic_signals"),
        composite=payloads.get("composite"),
        playbook=payloads.get("playbook"),
        advanced_signals=advanced_payloads,
        gex_history=payloads.get("gex_history"),
        market_volatility=payloads.get("market_volatility"),
        market_quote=payloads.get("market_quote"),
        market_bars=payloads.get("market_bars"),
        strike_profile=payloads.get("strike_profile"),
        flow_series=payloads.get("flow_series"),
        smart_money=payloads.get("smart_money"),
        session_levels=payloads.get("session_levels"),
        technicals=payloads.get("technicals"),
        dealer_hedging=payloads.get("dealer_hedging"),
        forced_flow_levels=payloads.get("forced_flow_levels"),
        endpoint_errors=endpoint_errors,
    )


def _carry_forward_failed_components(
    snapshot: dict[str, Any],
    payloads: dict[str, Any],
    previous_snapshot: dict[str, Any] | None,
) -> None:
    previous = previous_snapshot or {}
    raw_to_normalized = {
        "trade_bias": "trade_bias",
        "basic_signals": "basic_signals",
        "composite": "composite",
        "playbook": "playbook",
        "gex_history": "gex_history",
        "market_volatility": "market_volatility",
        "market_quote": "market_quote",
        "market_bars": "market_bars",
        "strike_profile": "strike_context",
        "flow_series": "flow_context",
        "session_levels": "session_context",
        "dealer_hedging": "dealer_hedging",
        "forced_flow_levels": "forced_flow",
    }
    for raw_name, normalized_name in raw_to_normalized.items():
        if raw_name not in payloads and previous.get(normalized_name):
            snapshot[normalized_name] = previous[normalized_name]
    previous_advanced = previous.get("advanced_signals") or {}
    advanced_payloads = {
        name.removeprefix("advanced:"): payload
        for name, payload in payloads.items()
        if name.startswith("advanced:")
    }
    for name in ADVANCED_ENDPOINTS:
        if name not in advanced_payloads and name in previous_advanced:
            snapshot["advanced_signals"][name] = previous_advanced[name]


def fetch_component_snapshot(
    symbol: str = "SPY",
    *,
    lane: str,
    api_key: str,
    timeout: float = DEFAULT_TIMEOUT,
    request_json: Callable[..., Any] = _request_json,
    previous_snapshot: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Fetch one independent polling lane without waiting on other API families."""

    symbol = symbol.upper()
    lane_specs = {
        "gex": _gex_summary_request_specs,
        "core": _core_context_request_specs,
        "deep": _deep_context_request_specs,
    }
    try:
        specs = lane_specs[lane](symbol)
    except KeyError as exc:
        raise ValueError(f"unknown ZeroGEX polling lane: {lane}") from exc
    payloads, endpoint_errors, exceptions = _fetch_payloads(
        specs,
        api_key=api_key,
        timeout=timeout,
        request_json=request_json,
    )
    if lane == "gex" and "gex_summary" not in payloads:
        raise exceptions.get(
            "gex_summary",
            ZeroGEXError("ZeroGEX GEX summary is unavailable"),
        )
    snapshot = _snapshot_from_payloads(symbol, payloads, endpoint_errors)
    _carry_forward_failed_components(snapshot, payloads, previous_snapshot)
    snapshot["_fetched_components"] = sorted(payloads)
    return snapshot


def fetch_snapshot(
    symbol: str = "SPY",
    *,
    api_key: str,
    timeout: float = DEFAULT_TIMEOUT,
    request_json: Callable[..., Any] = _request_json,
    include_extended: bool = True,
    previous_snapshot: dict[str, Any] | None = None,
) -> dict[str, Any]:
    symbol = symbol.upper()
    payloads, endpoint_errors, exceptions = _fetch_payloads(
        _request_specs(symbol, include_extended),
        api_key=api_key,
        timeout=timeout,
        request_json=request_json,
    )
    if "gex_summary" not in payloads:
        raise exceptions.get(
            "gex_summary",
            ZeroGEXError("ZeroGEX GEX summary is unavailable"),
        )
    snapshot = _snapshot_from_payloads(symbol, payloads, endpoint_errors)
    _carry_forward_failed_components(snapshot, payloads, previous_snapshot)
    return snapshot


def render_text(snapshot: dict[str, Any]) -> str:
    bias = snapshot.get("trade_bias") or {}
    gex = snapshot.get("gex_summary") or {}
    direction = str(bias.get("direction") or "unavailable").upper()
    score = bias.get("bias_score")
    confidence = bias.get("confidence")
    composite = snapshot.get("composite") or {}
    playbook = snapshot.get("playbook") or {}
    active = []
    for name, signal in (snapshot.get("advanced_signals") or {}).items():
        if not isinstance(signal, dict):
            continue
        triggered = signal.get("triggered") is True
        if name == "vol_expansion" and not triggered:
            expansion = signal.get("expansion")
            direction_score = signal.get("direction_score")
            triggered = bool(
                isinstance(expansion, (int, float))
                and not isinstance(expansion, bool)
                and expansion >= 60
                and isinstance(direction_score, (int, float))
                and not isinstance(direction_score, bool)
                and abs(direction_score) >= 50
            )
        if triggered:
            active.append(name)
    return (
        f"ZEROGEX ANALYTICS {snapshot.get('symbol', 'SPY')} "
        f"{direction} score={score if score is not None else '-'} "
        f"confidence={confidence if confidence is not None else '-'} "
        f"flip={gex.get('gamma_flip') if gex.get('gamma_flip') is not None else '-'} "
        f"walls={gex.get('put_wall') if gex.get('put_wall') is not None else '-'}/"
        f"{gex.get('call_wall') if gex.get('call_wall') is not None else '-'} "
        f"msi={composite.get('score') if composite.get('score') is not None else '-'} "
        f"playbook={str(playbook.get('state') or 'unavailable').upper()} "
        f"advanced={','.join(active) if active else '-'}"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Fetch read-only ZeroGEX analytics")
    parser.add_argument("symbol", nargs="?", default="SPY")
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    parser.add_argument("--env-file", type=Path, default=Path(".env"))
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    snapshot = fetch_snapshot(
        args.symbol,
        api_key=get_api_key(args.env_file),
        timeout=args.timeout,
    )
    print(json.dumps(snapshot, indent=2) if args.json else render_text(snapshot))


if __name__ == "__main__":
    main()
