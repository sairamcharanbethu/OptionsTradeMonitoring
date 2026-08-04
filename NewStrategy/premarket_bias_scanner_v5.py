#!/usr/bin/env python3
"""Accuracy-first SPY/QQQ scanner built around documented ZeroGEX contracts."""

from __future__ import annotations

import argparse
import json
import os
import re
import time as time_module
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, time, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional
from urllib.parse import quote
from zoneinfo import ZoneInfo

import requests


API_BASE = "https://api.zerogex.io"
ET = ZoneInfo("America/New_York")
SYMBOL_RE = re.compile(r"^[A-Za-z0-9.^-]{1,16}$")

MAX_LEVEL_AGE_SECONDS = 60.0
WALL_DISTANCE_PCT = 0.25
STRONG_GAP_PCT = 0.50


@dataclass(frozen=True)
class MacroEvent:
    name: str
    risk: str
    event_time: Optional[time] = None
    block_minutes_before: int = 30
    block_minutes_after: int = 15


# This is intentionally narrow. Use CLI overrides or connect a maintained
# economic-calendar source instead of assuming an absent entry means no event.
KNOWN_EVENTS = {
    date(2026, 8, 3): MacroEvent("ISM Manufacturing PMI", "high", time(10, 0)),
}


@dataclass(frozen=True)
class GapInfo:
    basis: str
    percent: Optional[float]
    prior_close: Optional[float]
    reference_price: Optional[float]
    warning: Optional[str] = None


@dataclass
class SymbolContext:
    symbol: str
    now_et: datetime
    spot: float
    levels_age_seconds: float
    net_gex: float
    gamma_flip: float
    call_wall: float
    put_wall: float
    max_pain: Optional[float]
    msi: float
    gap: GapInfo
    trap: Mapping[str, Any]
    range_break: Mapping[str, Any]
    market_pressure: Mapping[str, Any] = field(default_factory=dict)
    trade_bias: Mapping[str, Any] = field(default_factory=dict)
    basic_signals: Mapping[str, Any] = field(default_factory=dict)
    action_card: Mapping[str, Any] = field(default_factory=dict)
    zero_dte: Mapping[str, Any] = field(default_factory=dict)
    gamma_vwap: Mapping[str, Any] = field(default_factory=dict)
    volatility: Mapping[str, Any] = field(default_factory=dict)
    session_levels: Mapping[str, Any] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class Decision:
    code: str
    setup: str
    direction: str
    confidence: int
    risk_multiplier: float
    action: str
    reasons: tuple[str, ...]
    warnings: tuple[str, ...] = ()


class ZeroGEXError(RuntimeError):
    pass


class ZeroGEXClient:
    def __init__(
        self,
        token: str,
        base_url: str = API_BASE,
        timeout: float = 8.0,
        retries: int = 3,
    ) -> None:
        if not token:
            raise ValueError("ZEROGEX_API_TOKEN is required")
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.retries = retries
        self.session = requests.Session()
        self.session.headers.update(
            {
                "Accept": "application/json",
                "Authorization": f"Bearer {token}",
                "User-Agent": "ZeroGEX-Scanner-v5/1.0",
            }
        )

    def get(self, path: str, params: Optional[Mapping[str, Any]] = None) -> Any:
        url = f"{self.base_url}{path}"
        last_error: Optional[Exception] = None

        for attempt in range(self.retries):
            try:
                response = self.session.get(url, params=params, timeout=self.timeout)
                if response.status_code == 429:
                    retry_after = float(response.headers.get("Retry-After", 1.0))
                    time_module.sleep(min(retry_after, 10.0))
                    continue
                response.raise_for_status()
                return response.json()
            except (requests.RequestException, ValueError) as exc:
                last_error = exc
                if attempt + 1 < self.retries:
                    time_module.sleep(0.5 * (2**attempt))

        raise ZeroGEXError(f"GET {path} failed after {self.retries} attempts: {last_error}")

    def optional(
        self,
        path: str,
        params: Optional[Mapping[str, Any]],
        warnings: list[str],
    ) -> Any:
        try:
            return self.get(path, params)
        except ZeroGEXError as exc:
            warnings.append(str(exc))
            return {}

    def levels(self, symbol: str) -> Mapping[str, Any]:
        validate_symbol(symbol)
        return self.get(f"/api/v1/levels/{quote(symbol)}")


def validate_symbol(symbol: str) -> None:
    if not SYMBOL_RE.fullmatch(symbol):
        raise ValueError(f"Invalid symbol: {symbol!r}")


def as_float(value: Any, default: Optional[float] = None) -> Optional[float]:
    if value is None or isinstance(value, bool):
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def as_bool(value: Any) -> bool:
    return value is True


def parse_timestamp(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def payload_age_seconds(payload: Mapping[str, Any], now: datetime) -> Optional[float]:
    candidates: list[datetime] = []
    for key in ("timestamp", "as_of", "updated_at"):
        parsed = parse_timestamp(payload.get(key))
        if parsed:
            candidates.append(parsed)
    history = payload.get("score_history")
    if isinstance(history, list):
        for row in history:
            if isinstance(row, Mapping):
                parsed = parse_timestamp(row.get("timestamp"))
                if parsed:
                    candidates.append(parsed)
    signals = payload.get("signals")
    if isinstance(signals, Mapping):
        for signal in signals.values():
            if isinstance(signal, Mapping):
                parsed = parse_timestamp(signal.get("timestamp"))
                if parsed:
                    candidates.append(parsed)
    if not candidates:
        return None
    latest = max(candidates)
    if latest.tzinfo is None:
        latest = latest.replace(tzinfo=timezone.utc)
    return max(0.0, (now.astimezone(timezone.utc) - latest.astimezone(timezone.utc)).total_seconds())


def msi_regime(msi: float) -> str:
    if msi >= 70:
        return "Trend/Expansion"
    if msi >= 40:
        return "Controlled Trend"
    if msi >= 20:
        return "Chop/Range"
    return "High-Risk Reversal"


def imminence_regime(imminence: float) -> str:
    if imminence >= 80:
        return "Breakout Mode"
    if imminence >= 65:
        return "Break Watch"
    if imminence >= 40:
        return "Weak Range"
    return "Range Fade"


def wall_distance_pct(spot: float, wall: float) -> float:
    if spot <= 0 or wall <= 0:
        return float("inf")
    return abs(spot - wall) / spot * 100.0


def _session_prior_close(
    session_closes: Mapping[str, Any],
    trading_date: date,
) -> Optional[float]:
    current_close = as_float(session_closes.get("current_session_close"))
    prior_close = as_float(session_closes.get("prior_session_close"))
    current_ts = parse_timestamp(session_closes.get("current_session_close_ts"))

    if current_ts is None:
        return current_close
    current_date = current_ts.astimezone(ET).date()
    return current_close if current_date < trading_date else prior_close


def compute_gap(
    historical: Iterable[Mapping[str, Any]],
    session_closes: Mapping[str, Any],
    now_et: datetime,
) -> GapInfo:
    prior_close = _session_prior_close(session_closes, now_et.date())
    if not prior_close or prior_close <= 0:
        return GapInfo("unavailable", None, prior_close, None, "Prior cash close unavailable")

    bars: list[tuple[datetime, Mapping[str, Any]]] = []
    for bar in historical:
        if not isinstance(bar, Mapping):
            continue
        timestamp = parse_timestamp(bar.get("timestamp"))
        if timestamp is None:
            continue
        bars.append((timestamp.astimezone(ET), bar))
    bars.sort(key=lambda item: item[0])

    rth_bars = [
        item
        for item in bars
        if item[0].date() == now_et.date() and time(9, 30) <= item[0].time() < time(16, 0)
    ]
    if rth_bars:
        first_ts, first_bar = rth_bars[0]
        rth_open = as_float(first_bar.get("open"))
        if first_ts.time() > time(9, 35):
            return GapInfo(
                "unavailable",
                None,
                prior_close,
                rth_open,
                f"First regular-session bar is late ({first_ts.strftime('%H:%M:%S')} ET)",
            )
        if rth_open and rth_open > 0:
            gap_pct = (rth_open - prior_close) / prior_close * 100.0
            return GapInfo("opening_gap", gap_pct, prior_close, rth_open)

    same_day = [item for item in bars if item[0].date() == now_et.date()]
    if now_et.time() < time(9, 30) and same_day:
        last_price = as_float(same_day[-1][1].get("close"))
        if last_price and last_price > 0:
            change_pct = (last_price - prior_close) / prior_close * 100.0
            return GapInfo("premarket_change", change_pct, prior_close, last_price)

    return GapInfo(
        "unavailable",
        None,
        prior_close,
        None,
        "No valid 09:30 ET opening bar",
    )


def macro_is_blocking(event: Optional[MacroEvent], now_et: datetime) -> tuple[bool, str]:
    if event is None or event.risk == "none":
        return False, ""
    if event.risk == "extreme" and event.event_time is None:
        return True, f"Extreme macro event: {event.name}"
    if event.event_time is None:
        return False, f"Macro event declared without time: {event.name}"

    event_dt = datetime.combine(now_et.date(), event.event_time, ET)
    minutes = (now_et - event_dt).total_seconds() / 60.0
    blocked = -event.block_minutes_before <= minutes <= event.block_minutes_after
    return blocked, f"{event.name} at {event.event_time.strftime('%H:%M')} ET"


def _direction(payload: Mapping[str, Any]) -> str:
    value = str(payload.get("direction", "neutral")).lower()
    return value if value in {"bullish", "bearish", "neutral"} else "neutral"


def _basic_signal(context: SymbolContext, name: str) -> Mapping[str, Any]:
    signals = context.basic_signals.get("signals", {})
    if not isinstance(signals, Mapping):
        return {}
    signal = signals.get(name)
    return signal if isinstance(signal, Mapping) else {}


def _opposite(direction: str) -> str:
    return "bearish" if direction == "bullish" else "bullish"


def _confirmed_break(context: SymbolContext, direction: str) -> bool:
    imminence = as_float(context.range_break.get("imminence"), 0.0) or 0.0
    range_confirmed = (
        imminence >= 65
        and as_bool(context.range_break.get("triggered"))
        and _direction(context.range_break) == direction
    )
    pressure_confirmed = (
        as_bool(context.market_pressure.get("triggered"))
        and _direction(context.market_pressure) == direction
        and (as_float(context.market_pressure.get("loading"), 0.0) or 0.0) >= 50
    )
    return range_confirmed and pressure_confirmed


def _migration_decision(context: SymbolContext) -> Optional[Decision]:
    call_migrated = as_bool(context.trap.get("call_wall_migrated_up"))
    put_migrated = as_bool(context.trap.get("put_wall_migrated_down"))
    if not call_migrated and not put_migrated:
        return None

    if call_migrated:
        confirmed = _confirmed_break(context, "bullish")
        return Decision(
            code="CALL_BREAKOUT_WATCH" if confirmed else "EXIT_PUTS",
            setup="call_wall_migration",
            direction="bullish" if confirmed else "neutral",
            confidence=7 if confirmed else 0,
            risk_multiplier=0.0,
            action=(
                "Exit put exposure. Bullish pressure and break risk agree; wait for acceptance "
                "above the old wall and a successful retest before considering calls."
                if confirmed
                else "Exit put exposure. Do not auto-flip; breakout confirmation is incomplete."
            ),
            reasons=("Call wall migrated upward",),
            warnings=tuple(context.warnings),
        )

    confirmed = _confirmed_break(context, "bearish")
    return Decision(
        code="PUT_BREAKOUT_WATCH" if confirmed else "EXIT_CALLS",
        setup="put_wall_migration",
        direction="bearish" if confirmed else "neutral",
        confidence=7 if confirmed else 0,
        risk_multiplier=0.0,
        action=(
            "Exit call exposure. Bearish pressure and break risk agree; wait for acceptance "
            "below the old wall and a successful retest before considering puts."
            if confirmed
            else "Exit call exposure. Do not auto-flip; breakdown confirmation is incomplete."
        ),
        reasons=("Put wall migrated downward",),
        warnings=tuple(context.warnings),
    )


def _evaluate_wall_reaction(context: SymbolContext, wall_type: str) -> Decision:
    is_call_wall = wall_type == "call"
    setup = "call_wall_fade" if is_call_wall else "put_wall_bounce"
    direction = "bearish" if is_call_wall else "bullish"
    wall = context.call_wall if is_call_wall else context.put_wall
    distance = wall_distance_pct(context.spot, wall)
    expected_signal = "bearish_fade" if is_call_wall else "bullish_fade"
    breakout_field = "breakout_up" if is_call_wall else "breakout_down"
    migration_field = "call_wall_migrated_up" if is_call_wall else "put_wall_migrated_down"
    adverse_gap = (
        context.gap.percent is not None
        and ((is_call_wall and context.gap.percent > STRONG_GAP_PCT)
             or (not is_call_wall and context.gap.percent < -STRONG_GAP_PCT))
    )
    reasons: list[str] = []
    warnings = list(context.warnings)

    if distance > WALL_DISTANCE_PCT:
        return Decision(
            "WAIT", setup, "neutral", 0, 0.0,
            f"Spot is {distance:.2f}% from the wall; wait for a structural test.",
            (f"Wall proximity requires <= {WALL_DISTANCE_PCT:.2f}%",),
            tuple(warnings),
        )

    volatility_level = as_float(context.volatility.get("level"))
    if volatility_level is not None and volatility_level >= 8:
        return Decision(
            "STAND_DOWN", setup, direction, 0, 0.0,
            "The volatility index is in ZeroGEX's Extreme band; do not initiate a 1DTE wall reaction.",
            (f"Volatility level score {volatility_level:.1f}/10",),
            tuple(warnings),
        )

    if context.net_gex <= 0 or context.spot <= context.gamma_flip:
        return Decision(
            "STAND_DOWN", setup, direction, 0, 0.0,
            "Do not fade the wall in short-gamma or below-flip conditions.",
            ("Wall reactions require positive GEX at spot and spot above the gamma flip",),
            tuple(warnings),
        )
    reasons.append("Positive GEX supports wall absorption")

    if as_bool(context.trap.get(migration_field)):
        return Decision(
            "STAND_DOWN", setup, direction, 0, 0.0,
            "The wall migrated with price, invalidating the reaction setup.",
            ("Wall migration invalidated the fade",),
            tuple(warnings),
        )

    trap_confirmed = (
        as_bool(context.trap.get("triggered"))
        and context.trap.get("signal") == expected_signal
        and as_bool(context.trap.get(breakout_field))
    )
    if not trap_confirmed:
        return Decision(
            "WAIT_FOR_TRAP", setup, direction, 0, 0.0,
            "Do not enter from a wick alone. Wait for the ZeroGEX failed-breakout trap signal.",
            (f"Required trap signal: {expected_signal}",),
            tuple(warnings),
        )
    reasons.append("ZeroGEX trap detector confirmed the failed breakout")

    pressure_direction = _direction(context.market_pressure)
    pressure_triggered = as_bool(context.market_pressure.get("triggered"))
    if pressure_triggered and pressure_direction == _opposite(direction):
        return Decision(
            "STAND_DOWN", setup, direction, 0, 0.0,
            "Loaded market pressure opposes the wall reaction; do not fade it.",
            (f"Market pressure is triggered {_opposite(direction)}",),
            tuple(warnings),
        )

    dealer_delta = _basic_signal(context, "dealer_delta_pressure")
    dealer_score = as_float(dealer_delta.get("score"), 0.0) or 0.0
    if (direction == "bearish" and dealer_score > 60) or (
        direction == "bullish" and dealer_score < -60
    ):
        return Decision(
            "STAND_DOWN", setup, direction, 0, 0.0,
            "Dealer delta pressure indicates chase risk against the wall reaction.",
            (f"Dealer delta pressure score {dealer_score:+.1f}",),
            tuple(warnings),
        )

    action_direction = _direction(context.action_card)
    action_confidence = as_float(context.action_card.get("confidence"), 0.0) or 0.0
    if (
        context.action_card.get("action") not in {None, "", "STAND_DOWN"}
        and action_direction == _opposite(direction)
        and action_confidence >= 0.50
    ):
        return Decision(
            "STAND_DOWN", setup, direction, 0, 0.0,
            "The ZeroGEX Action Card has a confident opposing setup.",
            (f"Action Card: {context.action_card.get('action')} ({action_confidence:.0%})",),
            tuple(warnings),
        )

    score = 5  # trap (3) plus positive gamma (2)
    trap_context = context.trap.get("context_values", {})
    if isinstance(trap_context, Mapping) and as_bool(trap_context.get("gamma_strengthening")):
        score += 1
        reasons.append("Dealer gamma is strengthening")

    imminence = as_float(context.range_break.get("imminence"), 0.0) or 0.0
    if imminence < 65:
        score += 1
        reasons.append(f"Range state is {imminence_regime(imminence)}")
    if context.market_pressure and (
        not pressure_triggered or pressure_direction in {direction, "neutral"}
    ):
        score += 1
        reasons.append("Market pressure does not oppose the setup")
    elif not context.market_pressure:
        warnings.append("Market-pressure signal unavailable")

    bias_direction = _direction(context.trade_bias)
    bias_confidence = as_float(context.trade_bias.get("confidence"), 0.0) or 0.0
    if context.trade_bias and bias_direction in {direction, "neutral"}:
        score += 1
        reasons.append("Intraday bias is aligned or neutral")
    elif bias_confidence >= 0.60:
        warnings.append(f"Intraday bias opposes setup at {bias_confidence:.0%} confidence")
    elif not context.trade_bias:
        warnings.append("Intraday trade-bias signal unavailable")

    if action_direction == direction:
        score += 1
        reasons.append("Action Card direction agrees")
    elif context.action_card.get("action") == "STAND_DOWN":
        warnings.append("ZeroGEX Action Card currently says STAND_DOWN")

    score = min(score, 10)
    risk_multiplier = 0.50
    if context.gap.percent is None:
        risk_multiplier = min(risk_multiplier, 0.25)
        warnings.append("Opening-gap state is unavailable")
    if adverse_gap:
        risk_multiplier = min(risk_multiplier, 0.25)
        warnings.append(
            f"Adverse {context.gap.basis.replace('_', ' ')} {context.gap.percent:+.2f}%"
        )
    if imminence >= 40:
        risk_multiplier = min(risk_multiplier, 0.25)
    if context.msi < 20 or context.msi >= 70:
        risk_multiplier = min(risk_multiplier, 0.25)
    if volatility_level is not None and volatility_level >= 6:
        risk_multiplier = min(risk_multiplier, 0.25)
        warnings.append(f"Volatility level is {context.volatility.get('level_label', 'Elevated')}")

    zero_dte_direction = _direction(context.zero_dte)
    if (
        as_bool(context.zero_dte.get("triggered"))
        and zero_dte_direction == _opposite(direction)
    ):
        risk_multiplier = min(risk_multiplier, 0.25)
        warnings.append("Triggered 0DTE imbalance opposes the wall reaction")

    gamma_vwap_direction = _direction(context.gamma_vwap)
    if (
        as_bool(context.gamma_vwap.get("triggered"))
        and gamma_vwap_direction == _opposite(direction)
    ):
        risk_multiplier = min(risk_multiplier, 0.25)
        warnings.append("Gamma/VWAP confluence opposes the wall reaction")
    if imminence >= 80:
        return Decision(
            "STAND_DOWN", setup, direction, score, 0.0,
            "Breakout Mode is active; do not initiate a wall reaction trade.",
            tuple(reasons), tuple(warnings),
        )

    return Decision(
        code="CALL_WALL_FADE" if is_call_wall else "PUT_WALL_BOUNCE",
        setup=setup,
        direction=direction,
        confidence=score,
        risk_multiplier=risk_multiplier,
        action=(
            "Enter only after price returns through the breached wall/buffer and holds. "
            "Use the original wall invalidation; never widen the stop or average down."
        ),
        reasons=tuple(reasons),
        warnings=tuple(warnings),
    )


def evaluate_context(
    context: SymbolContext,
    macro_event: Optional[MacroEvent] = None,
    max_level_age_seconds: float = MAX_LEVEL_AGE_SECONDS,
) -> Decision:
    if context.levels_age_seconds > max_level_age_seconds:
        return Decision(
            "STAND_DOWN", "stale_data", "neutral", 0, 0.0,
            "Levels are stale; do not manufacture replacement walls.",
            (f"Level age {context.levels_age_seconds:.1f}s exceeds {max_level_age_seconds:.1f}s",),
            tuple(context.warnings),
        )

    macro_blocked, macro_reason = macro_is_blocking(macro_event, context.now_et)
    if macro_blocked:
        return Decision(
            "STAND_DOWN", "macro_window", "neutral", 0, 0.0,
            "No new short-duration option entries inside the macro-event block window.",
            (macro_reason,), tuple(context.warnings),
        )

    migration = _migration_decision(context)
    if migration:
        return migration

    call_distance = wall_distance_pct(context.spot, context.call_wall)
    put_distance = wall_distance_pct(context.spot, context.put_wall)
    if call_distance <= WALL_DISTANCE_PCT and call_distance <= put_distance:
        return _evaluate_wall_reaction(context, "call")
    if put_distance <= WALL_DISTANCE_PCT:
        return _evaluate_wall_reaction(context, "put")

    if _confirmed_break(context, "bullish"):
        return Decision(
            "CALL_BREAKOUT_WATCH", "confirmed_break_watch", "bullish", 7, 0.0,
            "Wait for a broken level to hold on retest before considering calls; this is not an at-market entry.",
            ("Range-break and market-pressure signals agree bullish",),
            tuple(context.warnings),
        )
    if _confirmed_break(context, "bearish"):
        return Decision(
            "PUT_BREAKOUT_WATCH", "confirmed_break_watch", "bearish", 7, 0.0,
            "Wait for a broken level to hold on retest before considering puts; this is not an at-market entry.",
            ("Range-break and market-pressure signals agree bearish",),
            tuple(context.warnings),
        )

    return Decision(
        "WAIT", "no_structural_entry", "neutral", 0, 0.0,
        "No confirmed wall reaction or two-signal breakout setup is present.",
        (f"MSI {context.msi:.1f} is {msi_regime(context.msi)} and is not directional",),
        tuple(context.warnings),
    )


def _required_number(payload: Mapping[str, Any], key: str, source: str) -> float:
    value = as_float(payload.get(key))
    if value is None:
        raise ZeroGEXError(f"{source} missing numeric field {key!r}")
    return value


def fetch_symbol_context(
    client: ZeroGEXClient,
    symbol: str,
    now_et: Optional[datetime] = None,
) -> SymbolContext:
    validate_symbol(symbol)
    now_et = now_et or datetime.now(ET)
    warnings: list[str] = []

    levels = client.levels(symbol)
    score = client.get("/api/signals/score", {"underlying": symbol})
    trap = client.get("/api/signals/advanced/trap-detection", {"symbol": symbol})
    range_break = client.get(
        "/api/signals/advanced/range-break-imminence", {"symbol": symbol}
    )

    market_pressure = client.optional(
        "/api/signals/advanced/market-pressure", {"symbol": symbol}, warnings
    )
    trade_bias = client.optional(
        "/api/signals/trade-bias", {"underlying": symbol, "tenor": "intraday"}, warnings
    )
    basic_signals = client.optional("/api/signals/basic", {"symbol": symbol}, warnings)
    action_card = client.optional("/api/signals/action", {"underlying": symbol}, warnings)
    zero_dte = client.optional(
        "/api/signals/advanced/0dte-position-imbalance", {"symbol": symbol}, warnings
    )
    gamma_vwap = client.optional(
        "/api/signals/advanced/gamma-vwap-confluence", {"symbol": symbol}, warnings
    )
    session_levels = client.optional(
        "/api/market/session-levels", {"symbol": symbol}, warnings
    )
    session_closes = client.optional(
        "/api/market/session-closes", {"symbol": symbol}, warnings
    )
    historical = client.optional(
        "/api/market/historical",
        {
            "symbol": symbol,
            "window_units": 576,
            "timeframe": "1min",
            "allow_futures": False,
        },
        warnings,
    )
    volatility = client.optional(
        "/api/market/volatility",
        {"ticker": "VIX" if symbol == "SPY" else "VXN"},
        warnings,
    )

    levels_data = levels.get("levels", {})
    if not isinstance(levels_data, Mapping):
        raise ZeroGEXError("/api/v1/levels response missing levels object")

    gap = compute_gap(
        historical if isinstance(historical, list) else [],
        session_closes if isinstance(session_closes, Mapping) else {},
        now_et,
    )
    if gap.warning:
        warnings.append(gap.warning)

    for name, payload in (("trap", trap), ("range-break", range_break)):
        age = payload_age_seconds(payload, now_et)
        if age is not None and age > 180:
            raise ZeroGEXError(f"{name} signal is stale ({age:.0f}s)")

    optional_payloads = {
        "market-pressure": market_pressure,
        "trade-bias": trade_bias,
        "basic-signals": basic_signals,
        "action-card": action_card,
        "0DTE-imbalance": zero_dte,
        "gamma-vwap": gamma_vwap,
    }
    for name, payload in optional_payloads.items():
        if not isinstance(payload, Mapping) or not payload:
            continue
        age = payload_age_seconds(payload, now_et)
        if age is not None and age > 180:
            warnings.append(f"Ignoring stale {name} data ({age:.0f}s)")
            optional_payloads[name] = {}

    market_pressure = optional_payloads["market-pressure"]
    trade_bias = optional_payloads["trade-bias"]
    basic_signals = optional_payloads["basic-signals"]
    action_card = optional_payloads["action-card"]
    zero_dte = optional_payloads["0DTE-imbalance"]
    gamma_vwap = optional_payloads["gamma-vwap"]

    return SymbolContext(
        symbol=symbol,
        now_et=now_et,
        spot=_required_number(levels, "spot", "/api/v1/levels"),
        levels_age_seconds=_required_number(levels, "age_seconds", "/api/v1/levels"),
        net_gex=_required_number(levels, "net_gex_at_spot", "/api/v1/levels"),
        gamma_flip=_required_number(levels_data, "gamma_flip", "/api/v1/levels"),
        call_wall=_required_number(levels_data, "call_wall", "/api/v1/levels"),
        put_wall=_required_number(levels_data, "put_wall", "/api/v1/levels"),
        max_pain=as_float(levels_data.get("max_pain")),
        msi=_required_number(score, "composite_score", "/api/signals/score"),
        gap=gap,
        trap=trap,
        range_break=range_break,
        market_pressure=market_pressure if isinstance(market_pressure, Mapping) else {},
        trade_bias=trade_bias if isinstance(trade_bias, Mapping) else {},
        basic_signals=basic_signals if isinstance(basic_signals, Mapping) else {},
        action_card=action_card if isinstance(action_card, Mapping) else {},
        zero_dte=zero_dte if isinstance(zero_dte, Mapping) else {},
        gamma_vwap=gamma_vwap if isinstance(gamma_vwap, Mapping) else {},
        volatility=volatility if isinstance(volatility, Mapping) else {},
        session_levels=session_levels if isinstance(session_levels, Mapping) else {},
        warnings=warnings,
    )


def format_report(context: SymbolContext, decision: Decision) -> str:
    gap_text = "N/A"
    if context.gap.percent is not None:
        gap_text = f"{context.gap.percent:+.3f}% ({context.gap.basis.replace('_', ' ')})"
    imminence = as_float(context.range_break.get("imminence"), 0.0) or 0.0
    pressure_loading = as_float(context.market_pressure.get("loading"), 0.0) or 0.0
    volatility_index = as_float(context.volatility.get("index"))
    volatility_text = "N/A" if volatility_index is None else f"{volatility_index:.2f}"

    lines = [
        "=" * 72,
        f"{context.symbol}  {context.now_et.strftime('%Y-%m-%d %H:%M:%S ET')}",
        "=" * 72,
        f"Spot:             ${context.spot:.2f}",
        f"Level age:        {context.levels_age_seconds:.1f}s",
        f"Net GEX at spot:  ${context.net_gex / 1e9:+.2f}B (regime, not direction)",
        f"Gamma flip:       ${context.gamma_flip:.2f}",
        f"Call / Put wall:  ${context.call_wall:.2f} / ${context.put_wall:.2f}",
        f"MSI:              {context.msi:.1f} ({msi_regime(context.msi)}, nondirectional)",
        f"Trade bias:       {_direction(context.trade_bias)}",
        (
            f"Range imminence:  {imminence:.1f} ({imminence_regime(imminence)}, "
            f"{_direction(context.range_break)})"
        ),
        f"Market pressure:  {pressure_loading:.1f} ({_direction(context.market_pressure)})",
        f"Trap signal:      {context.trap.get('signal', 'none')}",
        f"Gap:              {gap_text}",
        f"Vol index:        {volatility_text}",
        "",
        f"Decision:         {decision.code}",
        f"Setup:            {decision.setup}",
        f"Direction:        {decision.direction}",
        f"Confidence:       {decision.confidence}/10",
        f"Risk multiplier:  {decision.risk_multiplier:.2f}x normal per-trade risk",
        f"Action:            {decision.action}",
    ]
    if decision.reasons:
        lines.append("Reasons:")
        lines.extend(f"  - {reason}" for reason in decision.reasons)
    if decision.warnings:
        lines.append("Warnings:")
        lines.extend(f"  - {warning}" for warning in decision.warnings)
    return "\n".join(lines)


def append_jsonl(path: Path, context: SymbolContext, decision: Decision) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "timestamp": context.now_et.isoformat(),
        "symbol": context.symbol,
        "spot": context.spot,
        "level_age_seconds": context.levels_age_seconds,
        "net_gex_at_spot": context.net_gex,
        "gamma_flip": context.gamma_flip,
        "call_wall": context.call_wall,
        "put_wall": context.put_wall,
        "msi": context.msi,
        "msi_regime": msi_regime(context.msi),
        "gap": asdict(context.gap),
        "trap": dict(context.trap),
        "range_break": dict(context.range_break),
        "market_pressure": dict(context.market_pressure),
        "trade_bias": dict(context.trade_bias),
        "action_card": dict(context.action_card),
        "decision": asdict(decision),
    }
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, default=str, sort_keys=True) + "\n")


def parse_event(args: argparse.Namespace, now_et: datetime) -> Optional[MacroEvent]:
    if args.event_risk is None:
        return KNOWN_EVENTS.get(now_et.date())
    event_time = None
    if args.event_time:
        event_time = datetime.strptime(args.event_time, "%H:%M").time()
    return MacroEvent(args.event_name or "Operator-declared event", args.event_risk, event_time)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--symbols", default="SPY,QQQ", help="Comma-separated symbols")
    parser.add_argument("--json", action="store_true", help="Print machine-readable output")
    parser.add_argument("--log-jsonl", type=Path, help="Append complete decisions to this JSONL file")
    parser.add_argument("--event-risk", choices=("none", "high", "extreme"))
    parser.add_argument("--event-name")
    parser.add_argument("--event-time", help="Event time in ET, HH:MM")
    parser.add_argument("--max-level-age", type=float, default=MAX_LEVEL_AGE_SECONDS)
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    token = os.environ.get("ZEROGEX_API_TOKEN", "")
    if not token:
        raise SystemExit("Set ZEROGEX_API_TOKEN before running the scanner")

    symbols = [item.strip().upper() for item in args.symbols.split(",") if item.strip()]
    for symbol in symbols:
        validate_symbol(symbol)

    client = ZeroGEXClient(token)
    now_et = datetime.now(ET)
    macro_event = parse_event(args, now_et)
    output: list[dict[str, Any]] = []
    exit_code = 0

    for symbol in symbols:
        try:
            context = fetch_symbol_context(client, symbol, now_et)
            decision = evaluate_context(context, macro_event, args.max_level_age)
        except (ZeroGEXError, ValueError) as exc:
            exit_code = 1
            if args.json:
                output.append({"symbol": symbol, "error": str(exc)})
            else:
                print(f"{symbol}: DATA ERROR - {exc}")
            continue

        if args.log_jsonl:
            append_jsonl(args.log_jsonl, context, decision)
        if args.json:
            output.append(
                {
                    "symbol": symbol,
                    "context": {
                        "spot": context.spot,
                        "levels_age_seconds": context.levels_age_seconds,
                        "net_gex_at_spot": context.net_gex,
                        "gamma_flip": context.gamma_flip,
                        "call_wall": context.call_wall,
                        "put_wall": context.put_wall,
                        "msi": context.msi,
                        "msi_regime": msi_regime(context.msi),
                        "gap": asdict(context.gap),
                    },
                    "decision": asdict(decision),
                }
            )
        else:
            print(format_report(context, decision))

    if args.json:
        print(json.dumps(output, indent=2, default=str))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
