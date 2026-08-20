#!/usr/bin/env python3
"""Persistent read-only IBKR prefetcher for AI-readable trade context files."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from ib_insync import IB, Stock, Ticker, util

try:
    import redis as redis_client
except ImportError:  # Local tests can run without the optional event transport.
    redis_client = None

from ibkr_0dte_options import (
    DATA_TYPES,
    DEFAULT_CURRENCY,
    DEFAULT_EXCHANGE,
    _contract,
    _select_chain,
    _ticker_price,
)
from local_gex import build_local_gex, usable_gex
from signal_engine import (
    CONTINUATION_OPEN_STATES,
    _regular_session_open,
    build_signal,
    calculate_indicators,
    compact_signal_for_journal,
    market_data_readiness,
    provider_timestamp_freshness,
    reconcile_open_positions,
    render_signal,
)

ET = ZoneInfo("America/New_York")
NEXT_EXPIRY_ROLLOVER_MINUTE_ET = 13 * 60
STRATEGY_LANES = ("mtf", "orb_index", "vwap_trend")
LANE_STRATEGIES = {
    "mtf": {"CONTINUATION", "MTF_REVERSAL", "MTF_TREND_BREAK", "GEX_REJECTION"},
    "orb_index": {"ORB_INDEX"},
    "vwap_trend": {"VWAP_TREND"},
}


def _valid(value: Any) -> bool:
    return isinstance(value, (int, float)) and math.isfinite(value)


def _value(value: Any) -> float | None:
    return float(value) if _valid(value) and value >= 0 else None


def _boolean(value: str | bool) -> bool:
    if isinstance(value, bool):
        return value
    lowered = value.strip().lower()
    if lowered in {"1", "true", "yes", "on"}:
        return True
    if lowered in {"0", "false", "no", "off"}:
        return False
    raise argparse.ArgumentTypeError("expected true or false")


def _atomic_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, separators=(",", ":")))
    temporary.replace(path)


def _strategy_lane(signal: dict[str, Any] | None) -> str:
    strategy = str((signal or {}).get("strategy") or "").upper()
    if strategy == "ORB_INDEX":
        return "orb_index"
    if strategy == "VWAP_TREND":
        return "vwap_trend"
    return "mtf"


def _previous_strategy_lanes(
    payload: dict[str, Any] | None,
    fallback: dict[str, Any] | None = None,
) -> dict[str, dict[str, Any]]:
    raw = (payload or {}).get("signals") or {}
    lanes = {
        lane: dict(raw.get(lane) or {})
        for lane in STRATEGY_LANES
        if isinstance(raw.get(lane), dict)
    }
    if fallback and not lanes:
        lanes[_strategy_lane(fallback)] = fallback
    return lanes


def _strategy_family_policy_for_lane(
    configured: dict[str, Any] | None,
    lane: str,
) -> dict[str, Any]:
    source = copy.deepcopy(configured or {})
    if lane == "mtf":
        return {"enabled": False, "mode": "shadow"}
    families_enabled = source.get("enabled", True) is True
    orb_enabled = (source.get("orb_index") or {}).get("enabled", True) is True
    vwap_enabled = (source.get("vwap_trend") or {}).get("enabled", True) is True
    return {
        **source,
        "enabled": families_enabled,
        "mode": "primary",
        "orb_index": {
            **dict(source.get("orb_index") or {}),
            "enabled": lane == "orb_index" and orb_enabled,
        },
        "vwap_trend": {
            **dict(source.get("vwap_trend") or {}),
            "enabled": lane == "vwap_trend" and vwap_enabled,
        },
    }


def _normalize_strategy_lane(signal: dict[str, Any], lane: str) -> dict[str, Any]:
    signal["strategy_lane"] = lane
    strategy = str(signal.get("strategy") or "").upper()
    favored_setup = (
        signal.get("call_setup")
        if signal.get("favoring") == "calls"
        else signal.get("put_setup")
        if signal.get("favoring") == "puts"
        else {}
    ) or {}
    reversal_setup = signal.get("reversal_setup") or {}
    has_family_event = bool(
        favored_setup.get("source_event_id")
        or reversal_setup.get("event_id")
    )
    if strategy in LANE_STRATEGIES[lane] and (
        lane == "mtf" or has_family_event
    ):
        return signal
    if lane == "mtf":
        return signal

    idle = copy.deepcopy(signal)
    idle.update(
        state="WAIT",
        signal_phase="NO_TRADE",
        favoring="no-trade",
        strategy="ORB_INDEX" if lane == "orb_index" else "VWAP_TREND",
        confidence_score=None,
        call_setup={},
        put_setup={},
        reversal_setup=None,
        blockers=[],
        confirmations=[],
        lifecycle={
            "status": "WAIT",
            "entry_allowed": False,
            "paper_position_open": False,
        },
        strategy_lane=lane,
    )
    return idle


def _atomic_text(path: Path, payload: str) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(payload)
    temporary.replace(path)


def _bar_dict(bar: Any) -> dict[str, Any]:
    stamp = _bar_timestamp(bar)
    return {
        "time": stamp,
        "open": float(bar.open),
        "high": float(bar.high),
        "low": float(bar.low),
        "close": float(bar.close),
        "volume": float(bar.volume),
    }


def _bar_timestamp(bar: Any) -> float:
    value = bar.date
    return float(value.timestamp()) if hasattr(value, "timestamp") else float(value)


def _latest_completed_bar_time(bars: Any, now: float | None = None) -> float | None:
    current = time.time() if now is None else now
    minute_start = int(current // 60) * 60
    completed = [stamp for bar in bars if (stamp := _bar_timestamp(bar)) < minute_start]
    return max(completed) if completed else None


def _bars_are_stale(bars: Any, stale_after: float, now: float | None = None) -> bool:
    current = time.time() if now is None else now
    latest = _latest_completed_bar_time(bars, current)
    return latest is None or current - latest > stale_after


def _option_dict(ticker: Ticker, *, now: float | None = None) -> dict[str, Any]:
    contract = ticker.contract
    bid, ask = _value(ticker.bid), _value(ticker.ask)
    mid = (bid + ask) / 2 if bid is not None and ask is not None and ask > 0 else None
    spread = (ask - bid) / mid * 100 if mid else None
    greeks = ticker.modelGreeks or ticker.bidGreeks or ticker.askGreeks or ticker.lastGreeks
    quote_time = _ticker_time(ticker)
    quote_age = (now if now is not None else time.time()) - quote_time if quote_time else None
    open_interest = (
        getattr(ticker, "callOpenInterest", None)
        if contract.right == "C"
        else getattr(ticker, "putOpenInterest", None)
    )
    if mid is None:
        liquidity = "noquote"
    elif spread is not None and spread <= 10:
        liquidity = "ok"
    elif spread is not None and spread <= 20:
        liquidity = "caution"
    else:
        liquidity = "wide"
    return {
        "local_symbol": contract.localSymbol,
        "right": contract.right,
        "strike": float(contract.strike),
        "expiry": contract.lastTradeDateOrContractMonth,
        "bid": bid,
        "ask": ask,
        "mid": round(mid, 3) if mid else None,
        "spread_pct": round(spread, 1) if spread is not None else None,
        "delta": round(float(greeks.delta), 3) if greeks and _valid(greeks.delta) else None,
        "gamma": round(float(greeks.gamma), 8) if greeks and _valid(greeks.gamma) else None,
        "open_interest": float(open_interest) if _valid(open_interest) and open_interest >= 0 else None,
        "volume": float(ticker.volume) if _valid(ticker.volume) else None,
        "liquidity": liquidity,
        "quote_time": quote_time,
        "quote_age_seconds": round(max(0.0, quote_age), 2) if quote_age is not None else None,
    }


def _read_gex(path: Path) -> dict[str, Any] | None:
    try:
        payload = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    # Coerce to dict-or-None: a valid-but-non-dict JSON (array/scalar) from an
    # external writer would otherwise crash downstream `.get(...)` calls.
    return payload if isinstance(payload, dict) else None


def _read_policy(path: Path | None) -> dict[str, Any]:
    if path is None:
        return {}
    payload = _read_gex(path)
    return payload if isinstance(payload, dict) else {}


def _policy_fingerprint(policy: dict[str, Any]) -> str:
    encoded = json.dumps(policy, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def _provider_timestamp(value: Any) -> float | None:
    if _valid(value):
        return float(value)
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return datetime.fromisoformat(
            value.strip().replace("Z", "+00:00")
        ).timestamp()
    except (TypeError, ValueError, OSError):
        return None


def _zerogex_primary_snapshot(
    snapshot: dict[str, Any] | None,
    *,
    now: float | None = None,
    max_provider_age: float = 120,
    minute_bucket_grace_seconds: float = 60,
) -> dict[str, Any] | None:
    """Map the documented ZeroGEX summary into the engine's GEX contract."""
    if not isinstance(snapshot, dict):
        return None
    stamp = time.time() if now is None else now
    fetched_at = snapshot.get("fetched_at")
    summary = snapshot.get("gex_summary") or {}
    provider_freshness = provider_timestamp_freshness(
        summary.get("timestamp"),
        now=stamp,
        max_age=max_provider_age,
        minute_bucket_grace_seconds=minute_bucket_grace_seconds,
    )
    provider_at = provider_freshness["timestamp"]
    provider_age = provider_freshness["age_seconds"]
    provider_raw_age = provider_freshness["raw_age_seconds"]
    provider_precision_grace = provider_freshness[
        "precision_grace_seconds"
    ]
    spot = summary.get("spot_price")
    net_gex = summary.get("net_gex_at_spot")
    if not _valid(net_gex):
        net_gex = summary.get("net_gex")
    flip = summary.get("gamma_flip")
    call_wall = summary.get("call_wall")
    put_wall = summary.get("put_wall")
    missing = [
        name
        for name, value in (
            ("spot_price", spot),
            ("net_gex", net_gex),
            ("gamma_flip", flip),
            ("call_wall", call_wall),
            ("put_wall", put_wall),
        )
        if not _valid(value)
    ]
    error = None
    if snapshot.get("source") != "zerogex" or str(snapshot.get("symbol") or "").upper() != "SPY":
        error = "ZeroGEX snapshot source or symbol is invalid"
    elif not _valid(fetched_at):
        error = "ZeroGEX snapshot has no fetched_at timestamp"
    elif provider_age is None:
        error = "ZeroGEX snapshot has no provider timestamp"
    elif provider_age > max_provider_age:
        error = (
            f"ZeroGEX provider data is {provider_age:.1f}s old after "
            f"{provider_precision_grace:g}s timestamp-precision allowance "
            f"(raw {provider_raw_age:.1f}s; limit {max_provider_age:g}s)"
        )
    elif missing:
        error = f"ZeroGEX GEX summary missing: {', '.join(missing)}"

    positive = _valid(net_gex) and float(net_gex) >= 0
    spy = {
        "spot": float(spot) if _valid(spot) else None,
        "served_expiry": None,
        "regime": "Positive" if positive else "Negative",
        "gamma_regime": "Range" if positive else "Trend",
        "pattern": "ZEROGEX_SUMMARY",
        "rolling": "ZEROGEX_PRIMARY",
        "flip": float(flip) if _valid(flip) else None,
        "call_wall": {
            "strike": float(call_wall),
            "stage": "External",
            "taps": 0,
        } if _valid(call_wall) else None,
        "put_wall": {
            "strike": float(put_wall),
            "stage": "External",
            "taps": 0,
        } if _valid(put_wall) else None,
        "net_gex": float(net_gex) if _valid(net_gex) else None,
        "put_call_ratio": summary.get("put_call_ratio"),
        "max_pain": summary.get("max_pain"),
        "flip_distance": summary.get("flip_distance"),
        "local_gex": summary.get("local_gex"),
        "convexity_risk": summary.get("convexity_risk"),
        "provider_timestamp": provider_at,
        "provider_age_seconds": round(provider_age, 1)
        if provider_age is not None
        else None,
        "provider_raw_age_seconds": round(provider_raw_age, 1)
        if provider_raw_age is not None
        else None,
        "provider_timestamp_precision_grace_seconds":
            provider_precision_grace,
    }
    if error:
        spy["error"] = error
    return {
        "fetched_at": float(fetched_at) if _valid(fetched_at) else 0,
        "source": "zerogex",
        "selected_source": "zerogex",
        "model": {
            "method": "zerogex_documented_gex_summary",
            "dealer_position_inferred": True,
        },
        "data": {"SPY": spy},
    }


def _unavailable_primary(source: str, detail: str) -> dict[str, Any]:
    return {
        "fetched_at": 0,
        "source": source,
        "selected_source": source,
        "data": {"SPY": {"error": detail}},
    }


def _configured_primary_gex(
    primary_source: str,
    *,
    sscgex: dict[str, Any] | None,
    local: dict[str, Any] | None,
    zerogex: dict[str, Any] | None,
    zerogex_max_provider_age: float,
    zerogex_minute_bucket_grace_seconds: float = 60,
    now: float,
) -> dict[str, Any]:
    if primary_source == "sscgex":
        candidate = sscgex
    elif primary_source == "ibkr-local-oi-model":
        candidate = local
    elif primary_source == "zerogex":
        candidate = _zerogex_primary_snapshot(
            zerogex,
            now=now,
            max_provider_age=zerogex_max_provider_age,
            minute_bucket_grace_seconds=(
                zerogex_minute_bucket_grace_seconds
            ),
        )
    else:
        return _unavailable_primary(
            "unavailable",
            f"unrecognized configured primary GEX source: {primary_source}",
        )
    if candidate is None:
        return _unavailable_primary(
            primary_source,
            f"configured primary GEX source {primary_source} has no snapshot",
        )
    return candidate


def _compact_shadow_gex(
    snapshot: dict[str, Any] | None,
    *,
    source: str,
    now: float,
    max_age: float,
    heatmap: dict[str, Any] | None = None,
) -> dict[str, Any]:
    spy = ((snapshot or {}).get("data") or {}).get("SPY") or {}
    fetched_at = (snapshot or {}).get("fetched_at")
    age = max(0.0, now - float(fetched_at)) if _valid(fetched_at) else None
    interpretation = (heatmap or {}).get("interpretation") or {}
    return {
        "source": source,
        "mode": "shadow",
        "entry_authority": False,
        "available": bool(snapshot),
        "fresh": bool(
            snapshot
            and age is not None
            and age <= max_age
            and not spy.get("error")
        ),
        "age_seconds": round(age, 1) if age is not None else None,
        "regime": spy.get("regime"),
        "gamma_regime": spy.get("gamma_regime"),
        "flip": spy.get("flip"),
        "call_wall": spy.get("call_wall"),
        "put_wall": spy.get("put_wall"),
        "net_gex": spy.get("net_gex"),
        "heatmap": {
            "api_flip": interpretation.get("api_flip"),
            "nearest_zero_cross": interpretation.get("nearest_zero_cross"),
            "status": interpretation.get("status"),
        } if heatmap else None,
        "error": spy.get("error"),
    }


def _ticker_time(ticker: Ticker) -> float | None:
    value = getattr(ticker, "time", None)
    if value is None:
        return None
    try:
        return value.timestamp()
    except (AttributeError, TypeError, ValueError, OSError):
        return None


def _symmetric_strikes(strikes: list[float], spot: float, per_side: int) -> list[float]:
    """Return a buffered strike window used for both calls and puts."""
    valid = [float(strike) for strike in strikes if strike > 0]
    count = max(3, per_side * 2 + 1)
    return sorted(sorted(valid, key=lambda strike: abs(strike - spot))[:count])


def _locked_option_spec(signal: dict[str, Any] | None, expiry: str) -> tuple[float, str] | None:
    """Return the open continuation's activation contract for subscription retention."""
    signal = signal or {}
    if signal.get("state") not in CONTINUATION_OPEN_STATES or signal.get("strategy") not in {
        "CONTINUATION", "MTF_REVERSAL", "MTF_TREND_BREAK", "GEX_REJECTION",
        "ORB_INDEX", "VWAP_TREND",
    }:
        return None
    side = signal.get("favoring")
    setup = signal.get("call_setup") if side == "calls" else signal.get("put_setup")
    option = (setup or {}).get("option") or {}
    strike = option.get("target_strike", option.get("strike"))
    right = option.get("right")
    if (
        not _valid(strike)
        or right not in {"C", "P"}
        or str(option.get("expiry") or "") != str(expiry)
    ):
        return None
    return float(strike), str(right)


def _locked_option_expiry(signal: dict[str, Any] | None) -> str | None:
    """Keep an active position on its activation expiry across the 1 PM rollover."""
    signal = signal or {}
    if signal.get("state") not in CONTINUATION_OPEN_STATES:
        return None
    side = signal.get("favoring")
    setup = signal.get("call_setup") if side == "calls" else signal.get("put_setup")
    option = (setup or {}).get("option") or {}
    expiry = str(option.get("expiry") or "")
    return expiry or None


def _preferred_option_expiry(
    expirations: list[str], now: float | None = None
) -> tuple[str, str]:
    """Use today's expiry before 1 PM ET, then the next valid listed expiry."""
    stamp = datetime.fromtimestamp(time.time() if now is None else now, ET)
    today = stamp.strftime("%Y%m%d")
    listed = sorted({str(expiry) for expiry in expirations})
    if not listed:
        raise RuntimeError("SPY option chain returned no expirations")
    minutes = stamp.hour * 60 + stamp.minute
    if minutes < NEXT_EXPIRY_ROLLOVER_MINUTE_ET and today in listed:
        return today, "0DTE"
    future = [expiry for expiry in listed if expiry > today]
    if future:
        return future[0], "1DTE_NEXT_LISTED"
    if today in listed:
        return today, "0DTE_NO_FUTURE_EXPIRY"
    raise RuntimeError("SPY option chain has no current or future expiry")


def _wall_option_expiry(
    expirations: list[str], now: float | None = None, min_dte: int = 3
) -> str | None:
    """Nearest listed expiry at least ``min_dte`` calendar days out.

    Wall-reaction setups trade near-the-money multi-day contracts (lower theta)
    rather than 0DTE. Returns None when disabled (min_dte <= 0) or when no listed
    expiry reaches ``min_dte`` days — callers then fall back to the primary chain.
    """
    if min_dte <= 0:
        return None
    stamp = datetime.fromtimestamp(time.time() if now is None else now, ET)
    today = stamp.date()
    for expiry in sorted({str(value) for value in expirations}):
        try:
            expiry_date = datetime.strptime(expiry, "%Y%m%d").date()
        except ValueError:
            continue
        if (expiry_date - today).days >= min_dte:
            return expiry
    return None


class TradePrefetcher:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.ib = IB()
        self.stocks: dict[str, Any] = {}
        self.tickers: dict[str, Ticker] = {}
        self.bars: dict[str, Any] = {}
        self.option_tickers: list[Ticker] = []
        self.option_chain: Any = None
        self.option_expiry: str | None = None
        self.option_expiries: set[str] = set()
        self.option_expiry_mode: str | None = None
        # Nearest ~3DTE expiry for near-the-money wall-reaction contracts (or None).
        self.wall_option_expiry: str | None = None
        self.option_anchor_spot: float | None = None
        self.last_option_refresh = 0.0
        self.last_bar_refresh = 0.0
        self.bar_refresh_required = False
        self.last_bar_recovery_reason: str | None = None
        self.last_errors: list[dict[str, Any]] = []
        self.last_log_fingerprint: tuple[Any, ...] | None = None
        self.last_log_at = 0.0
        self.last_journal_fingerprint: tuple[Any, ...] | None = None
        self.last_journal_fingerprints: dict[str, tuple[Any, ...]] = {}
        self.last_journal_ats: dict[str, float] = {}
        self.local_gex: dict[str, Any] | None = None
        self.last_local_gex_at = 0.0
        self.last_journal_at = 0.0
        self.runtime_ibkr_config: dict[str, Any] = {}
        self.redis_publisher: Any = None
        self.redis_retry_at = 0.0
        self.redis_last_error_at = 0.0
        self.ib.errorEvent += self._on_error

    def _publish_signal_update(self, signal: dict[str, Any]) -> None:
        if not self.args.redis_url or redis_client is None:
            return
        now = time.time()
        if now < self.redis_retry_at:
            return
        try:
            if self.redis_publisher is None:
                self.redis_publisher = redis_client.Redis.from_url(
                    self.args.redis_url,
                    socket_connect_timeout=0.2,
                    socket_timeout=0.2,
                    decode_responses=True,
                )
            self.redis_publisher.publish(
                self.args.redis_channel,
                json.dumps(
                    {
                        "generated_at": signal.get("generated_at"),
                        "state": signal.get("state"),
                        "phase": signal.get("signal_phase"),
                    },
                    separators=(",", ":"),
                ),
            )
        except Exception as exc:
            self.redis_publisher = None
            self.redis_retry_at = now + 5
            if now - self.redis_last_error_at >= 60:
                print(
                    f"trade-prefetch Redis notification unavailable: {type(exc).__name__}: {exc}",
                    flush=True,
                )
                self.redis_last_error_at = now

    def _reset_option_state(self) -> None:
        """Discard ticker objects that cannot survive an IBKR reconnect."""
        self.option_tickers = []
        self.option_chain = None
        self.option_expiry = None
        self.option_expiries = set()
        self.option_expiry_mode = None
        self.option_anchor_spot = None
        self.last_option_refresh = 0.0

    def _on_error(
        self,
        req_id: int,
        error_code: int,
        error_string: str,
        contract: Any = None,
    ) -> None:
        if error_code == 162 and "query cancelled" in error_string.lower():
            return
        if error_code == 366 and "no historical data query found" in error_string.lower():
            return
        self.last_errors.append(
            {
                "time": time.time(),
                "request_id": req_id,
                "code": error_code,
                "message": error_string,
                "symbol": getattr(contract, "symbol", None),
            }
        )
        self.last_errors = self.last_errors[-25:]
        if error_code == 2105:
            self.bar_refresh_required = True
            self.last_bar_recovery_reason = "HMDS data farm disconnected"
        elif error_code in {1101, 1102, 2106}:
            self.bar_refresh_required = True
            self.last_bar_recovery_reason = f"IBKR recovery event {error_code}"

    def _subscribe_bars(self, symbol: str) -> None:
        previous = self.bars.get(symbol)
        if previous is not None:
            try:
                self.ib.cancelHistoricalData(previous)
            except Exception:
                pass
        self.bars[symbol] = self.ib.reqHistoricalData(
            self.stocks[symbol],
            endDateTime="",
            durationStr="6 D",
            barSizeSetting="1 min",
            whatToShow="TRADES",
            useRTH=True,
            formatDate=2,
            keepUpToDate=True,
        )
        self.last_bar_refresh = time.time()

    def _recover_stale_bars(self) -> None:
        now = time.time()
        if not _regular_session_open(now):
            self.bar_refresh_required = False
            self.last_bar_recovery_reason = None
            return
        stale_symbols = [
            symbol
            for symbol in self.args.symbols
            if _bars_are_stale(self.bars.get(symbol) or [], self.args.bar_stale_after, now)
        ]
        if not stale_symbols:
            self.bar_refresh_required = False
            self.last_bar_recovery_reason = None
            return
        if now - self.last_bar_refresh < self.args.bar_recovery_cooldown:
            return
        reason = self.last_bar_recovery_reason or "completed one-minute bars stale"
        print(
            f"trade-prefetch recovering bars ({reason}): {','.join(stale_symbols)}",
            flush=True,
        )
        for symbol in stale_symbols:
            self._subscribe_bars(symbol)
        self.bar_refresh_required = False
        self.last_bar_recovery_reason = None

    def connect(self) -> None:
        # ib_insync ticker objects belong to the connection that created them.
        # Reusing them after a reconnect leaves option quotes silently frozen.
        self._reset_option_state()
        self.ib.connect(
            self.args.host,
            self.args.port,
            clientId=self.args.client_id,
            timeout=8,
            readonly=True,
        )
        self.ib.reqMarketDataType(DATA_TYPES[self.args.data_type])
        for symbol in self.args.symbols:
            stock = Stock(symbol, DEFAULT_EXCHANGE, DEFAULT_CURRENCY)
            self.ib.qualifyContracts(stock)
            self.stocks[symbol] = stock
            self.tickers[symbol] = self.ib.reqMktData(stock, "233", False, False)
            self._subscribe_bars(symbol)
        self.ib.sleep(2)
        self.bar_refresh_required = False
        self.last_bar_recovery_reason = None
        self._refresh_options(force_chain=True)

    def _apply_runtime_ibkr_policy(self) -> None:
        policy = _read_policy(getattr(self.args, "policy_file", None))
        configured_host = str(policy.get("ibkr_host") or "").strip()
        configured_port = policy.get("ibkr_port")
        host = configured_host or self.args.host
        try:
            port = int(configured_port) if configured_port is not None else self.args.port
        except (TypeError, ValueError):
            raise ValueError("Invalid runtime IBKR port in strategy policy")
        if not host or port <= 0:
            raise ValueError("Invalid runtime IBKR host or port in strategy policy")
        data_type = str(policy.get("ibkr_data_type") or self.args.data_type).strip()
        if data_type not in DATA_TYPES:
            raise ValueError(f"Unsupported runtime IBKR data type: {data_type}")
        changed = not (
            host == self.args.host
            and port == self.args.port
            and data_type == self.args.data_type
        )
        self.runtime_ibkr_config = {
            "source": "backend-policy" if configured_host or configured_port is not None else "container",
            "configured": {
                "host": configured_host or self.args.host,
                "port": configured_port if configured_port is not None else self.args.port,
                "data_type": policy.get("ibkr_data_type") or self.args.data_type,
            },
            "applied": {"host": host, "port": port, "data_type": data_type},
            "changed_at": time.time() if changed else None,
        }
        if not changed:
            return
        if self.ib.isConnected():
            self.ib.disconnect()
        self._reset_option_state()
        self.args.host = host
        self.args.port = port
        self.args.data_type = data_type
        print(
            f"trade-prefetch applying runtime IBKR config {host}:{port} ({data_type})",
            flush=True,
        )

    def _option_anchor_price(self) -> float:
        """Resolve a safe chain-selection anchor without requiring the first quote tick."""
        try:
            return float(_ticker_price(self.tickers["SPY"]))
        except RuntimeError:
            pass
        spy_bars = self.bars.get("SPY") or []
        if spy_bars:
            close = getattr(spy_bars[-1], "close", None)
            if _valid(close) and close > 0:
                return float(close)
        external = (
            _read_gex(self.args.gex_file) or {}
            if getattr(self.args, "sscgex_enabled", True)
            else {}
        )
        external_spot = (((external.get("data") or {}).get("SPY") or {}).get("spot"))
        if _valid(external_spot) and external_spot > 0:
            return float(external_spot)
        if (
            getattr(self.args, "primary_gex_source", "sscgex") == "zerogex"
            and getattr(self.args, "zerogex_enabled", False)
        ):
            zerogex = _read_gex(self.args.zerogex_file) or {}
            zerogex_spot = (zerogex.get("gex_summary") or {}).get("spot_price")
            if _valid(zerogex_spot) and zerogex_spot > 0:
                return float(zerogex_spot)
        raise RuntimeError("No usable underlying price from IBKR bars, quotes, or enabled GEX sources")

    def _refresh_options(self, force_chain: bool = False) -> None:
        stock = self.stocks["SPY"]
        spot = self._option_anchor_price()
        if self.option_chain is None or force_chain:
            chains = self.ib.reqSecDefOptParams("SPY", "", stock.secType, stock.conId)
            self.option_chain = _select_chain(chains, "SPY")
        chain = self.option_chain
        previous_signal = _read_gex(self.args.output_dir / "signal.json")
        previous_lanes = _previous_strategy_lanes(
            _read_gex(self.args.output_dir / "strategy-signals.json"),
            previous_signal,
        )
        preferred_expiry, preferred_mode = _preferred_option_expiry(
            list(chain.expirations)
        )
        locked_expiries = {
            expiry
            for signal in previous_lanes.values()
            if (expiry := _locked_option_expiry(signal))
            and expiry in chain.expirations
        }
        wall_expiry = _wall_option_expiry(
            list(chain.expirations),
            min_dte=int(getattr(self.args, "wall_option_expiry_dte", 0) or 0),
        )
        self.wall_option_expiry = wall_expiry
        desired_expiries = {preferred_expiry, *locked_expiries}
        if wall_expiry:
            desired_expiries = {*desired_expiries, wall_expiry}
        strike_count = (
            max(self.args.strikes_per_side, self.args.local_gex_strikes_per_side)
            if self.args.local_gex_fallback
            else self.args.strikes_per_side
        )
        strikes = _symmetric_strikes(list(chain.strikes), spot, strike_count)
        contract_specs = {
            (expiry, float(strike), right)
            for expiry in desired_expiries
            for strike in strikes
            for right in ("C", "P")
        }
        for signal in previous_lanes.values():
            locked_expiry = _locked_option_expiry(signal)
            if not locked_expiry or locked_expiry not in desired_expiries:
                continue
            locked_spec = _locked_option_spec(signal, locked_expiry)
            if locked_spec is not None:
                contract_specs.add((locked_expiry, *locked_spec))
        contracts = [
            _contract("SPY", expiry, strike, right, chain.tradingClass)
            for expiry, strike, right in sorted(contract_specs)
        ]
        qualified = self.ib.qualifyContracts(*contracts)
        old_by_con_id = {ticker.contract.conId: ticker for ticker in self.option_tickers}
        new_tickers = []
        for contract in qualified:
            ticker = old_by_con_id.get(contract.conId)
            if ticker is None:
                ticker = self.ib.reqMktData(contract, "100,101,106", False, False)
            new_tickers.append(ticker)
        new_con_ids = {ticker.contract.conId for ticker in new_tickers}
        for ticker in self.option_tickers:
            if ticker.contract.conId not in new_con_ids:
                self.ib.cancelMktData(ticker.contract)
        self.option_tickers = new_tickers
        self.option_expiry = preferred_expiry
        self.option_expiries = desired_expiries
        self.option_expiry_mode = preferred_mode
        self.option_anchor_spot = spot
        self.last_option_refresh = time.time()

    def _options_need_recenter(self) -> bool:
        if not self.option_tickers or self.option_anchor_spot is None or self.option_expiry is None:
            return True
        signal = _read_gex(self.args.output_dir / "signal.json")
        previous_lanes = _previous_strategy_lanes(
            _read_gex(self.args.output_dir / "strategy-signals.json"),
            signal,
        )
        if self.option_chain is None:
            return True
        preferred_expiry, _ = _preferred_option_expiry(
            list(self.option_chain.expirations)
        )
        desired_expiries = {
            preferred_expiry,
            *(
                expiry
                for lane_signal in previous_lanes.values()
                if (expiry := _locked_option_expiry(lane_signal))
                and expiry in self.option_chain.expirations
            ),
        }
        wall_expiry = _wall_option_expiry(
            list(self.option_chain.expirations),
            min_dte=int(getattr(self.args, "wall_option_expiry_dte", 0) or 0),
        )
        if wall_expiry:
            desired_expiries = {*desired_expiries, wall_expiry}
        if self.option_expiries != desired_expiries:
            return True
        try:
            spot = self._option_anchor_price()
        except RuntimeError:
            return False
        return abs(spot - self.option_anchor_spot) >= self.args.option_recenter

    def write(self) -> dict[str, Any]:
        generated_at = time.time()
        policy = _read_policy(getattr(self.args, "policy_file", None))
        max_total_debit = float(
            policy.get(
                "strategy_max_total_debit_dollars",
                self.args.option_max_total_debit_dollars,
            )
        )
        max_contracts = int(
            policy.get(
                "strategy_max_contracts",
                self.args.option_preferred_contracts,
            )
        )
        preferred_contracts = min(
            max_contracts,
            int(
                policy.get(
                    "strategy_preferred_contracts",
                    self.args.option_preferred_contracts,
                )
            ),
        )
        symbols = {}
        indicators = {}
        for symbol in self.args.symbols:
            ticker = self.tickers[symbol]
            normalized_bars = [_bar_dict(bar) for bar in self.bars[symbol]]
            try:
                spot = _ticker_price(ticker)
            except RuntimeError:
                spot = None
            quote_time = _ticker_time(ticker)
            symbols[symbol] = {
                "spot": spot,
                "bid": _value(ticker.bid),
                "ask": _value(ticker.ask),
                "last": _value(ticker.last),
                "quote_time": quote_time,
                "quote_age_seconds": round(generated_at - quote_time, 2) if quote_time else None,
                "bars": normalized_bars,
            }
            indicators[symbol] = calculate_indicators(normalized_bars)
        market = {
            "generated_at": generated_at,
            "source": "IBKR",
            "data_type": self.args.data_type,
            "transport": {
                "connected": self.ib.isConnected(),
                "host": self.args.host,
                "port": self.args.port,
                "client_id": self.args.client_id,
                "data_type": self.args.data_type,
                "runtime_config": self.runtime_ibkr_config,
                "last_error": self.last_errors[-1] if self.last_errors else None,
            },
            "symbols": symbols,
        }
        market["market_data_readiness"] = market_data_readiness(
            market,
            indicators,
            now=generated_at,
            stale_after=self.args.stale_after,
        )
        option_contracts = [
            _option_dict(ticker, now=generated_at)
            for ticker in self.option_tickers
        ]
        # Dedicated ~3DTE near-the-money chain for wall-reaction setups (lower
        # theta than 0DTE). None when disabled or the expiry has no subscribed
        # contracts — build_signal then falls back to the primary chain.
        wall_options: dict[str, Any] | None = None
        if self.wall_option_expiry:
            wall_contracts = [
                contract
                for contract in option_contracts
                if contract.get("expiry") == self.wall_option_expiry
            ]
            if wall_contracts:
                wall_options = {
                    "generated_at": generated_at,
                    "source": "IBKR",
                    "underlying": "SPY",
                    "expiry": self.wall_option_expiry,
                    "expiry_mode": "MULTI_DAY_WALL",
                    "contracts": wall_contracts,
                }
        options = {
            "generated_at": generated_at,
            "source": "IBKR",
            "underlying": "SPY",
            "expiry": self.option_expiry,
            "expiry_mode": self.option_expiry_mode,
            "contracts": [
                contract
                for contract in option_contracts
                if contract.get("expiry") == self.option_expiry
            ],
        }
        spy_spot = (symbols.get("SPY") or {}).get("spot")
        external_gex = (
            _read_gex(self.args.gex_file)
            if getattr(self.args, "sscgex_enabled", True)
            else None
        )
        zerogex = (
            _read_gex(self.args.zerogex_file)
            if getattr(self.args, "zerogex_enabled", False)
            else None
        )
        if (
            self.args.local_gex_fallback
            and (self.local_gex is None or generated_at - self.last_local_gex_at >= self.args.local_gex_interval)
        ):
            self.local_gex = build_local_gex(
                options,
                spy_spot,
                previous=self.local_gex,
                min_contracts=self.args.local_gex_min_contracts,
                now=generated_at,
            )
            self.last_local_gex_at = generated_at
            _atomic_json(self.args.output_dir / "local_gex.json", self.local_gex)
        primary_source = getattr(self.args, "primary_gex_source", "sscgex")
        gex = _configured_primary_gex(
            primary_source,
            sscgex=external_gex,
            local=self.local_gex,
            zerogex=zerogex,
            zerogex_max_provider_age=self.args.zerogex_max_provider_age,
            zerogex_minute_bucket_grace_seconds=(
                getattr(
                    self.args,
                    "zerogex_minute_bucket_grace_seconds",
                    60,
                )
            ),
            now=generated_at,
        )
        _atomic_json(self.args.output_dir / "effective_gex.json", gex)
        previous_signal = _read_gex(self.args.output_dir / "signal.json")
        previous_lanes = _previous_strategy_lanes(
            _read_gex(self.args.output_dir / "strategy-signals.json"),
            previous_signal,
        )
        # Reconcile the engine's self-assumed open-position latch against the
        # backend ledger (positions.json). A lane the backend is confident holds
        # no position is demoted out of the open lifecycle so the engine re-arms
        # instead of managing a phantom position it never actually entered.
        previous_lanes = reconcile_open_positions(
            previous_lanes,
            _read_gex(self.args.output_dir / "positions.json"),
            now=generated_at,
        )
        sscgex_heatmap = (
            _read_gex(self.args.heatmap_file)
            if getattr(self.args, "sscgex_enabled", True)
            else None
        )
        primary_heatmap = sscgex_heatmap if primary_source == "sscgex" else None
        zerogex_role = "primary" if primary_source == "zerogex" else "shadow"
        provider_roles = {
            "primary": primary_source,
            "sscgex": (
                "primary"
                if primary_source == "sscgex"
                else "shadow"
                if getattr(self.args, "sscgex_enabled", True)
                else "disabled"
            ),
            "ibkr_local_gex": (
                "primary"
                if primary_source == "ibkr-local-oi-model"
                else "shadow"
                if self.args.local_gex_fallback
                else "disabled"
            ),
            "zerogex": (
                "primary"
                if primary_source == "zerogex"
                else "shadow"
                if getattr(self.args, "zerogex_enabled", False)
                else "disabled"
            ),
        }
        gex_shadows: dict[str, Any] = {}
        if provider_roles["sscgex"] == "shadow":
            gex_shadows["sscgex"] = _compact_shadow_gex(
                external_gex,
                source="sscgex",
                now=generated_at,
                max_age=self.args.local_gex_max_age,
                heatmap=sscgex_heatmap,
            )
        if provider_roles["ibkr_local_gex"] == "shadow":
            gex_shadows["ibkr_local_gex"] = _compact_shadow_gex(
                self.local_gex,
                source="ibkr-local-oi-model",
                now=generated_at,
                max_age=self.args.local_gex_max_age,
            )
        configured_families = (
            policy.get("strategy_families")
            if isinstance(policy.get("strategy_families"), dict)
            else None
        )

        def options_for_lane(lane: str) -> dict[str, Any]:
            locked_expiry = _locked_option_expiry(previous_lanes.get(lane))
            expiry = (
                locked_expiry
                if locked_expiry and locked_expiry in self.option_expiries
                else self.option_expiry
            )
            return {
                "generated_at": generated_at,
                "source": "IBKR",
                "underlying": "SPY",
                "expiry": expiry,
                "expiry_mode": (
                    "LOCKED_POSITION" if locked_expiry == expiry
                    else self.option_expiry_mode
                ),
                "contracts": [
                    contract
                    for contract in option_contracts
                    if contract.get("expiry") == expiry
                ],
            }

        signals: dict[str, dict[str, Any]] = {}
        for lane in STRATEGY_LANES:
            lane_family_policy = _strategy_family_policy_for_lane(
                configured_families,
                lane,
            )
            lane_signal = build_signal(
                market,
                indicators,
                options_for_lane(lane),
                gex,
                self.args.stale_after,
                previous_signal=previous_lanes.get(lane),
                heatmap=primary_heatmap,
                zerogex=zerogex,
                zerogex_role=zerogex_role,
                zerogex_features={
                    "structure_context": self.args.zerogex_structure_context,
                    "flow_context": self.args.zerogex_flow_context,
                    "session_levels": self.args.zerogex_session_levels,
                    "late_day_forced_flow": self.args.zerogex_late_day_forced_flow,
                },
                zerogex_minute_bucket_grace_seconds=getattr(
                    self.args,
                    "zerogex_minute_bucket_grace_seconds",
                    60,
                ),
                paper_exit_target=self.args.paper_exit_target,
                same_side_reentry_cooldown_seconds=(
                    self.args.same_side_reentry_cooldown_seconds
                ),
                max_tracking_gap_seconds=self.args.max_tracking_gap_seconds,
                t1_move_invalidation_to_trigger=(
                    self.args.t1_move_invalidation_to_trigger
                ),
                t1_premium_lock_arm_pct=self.args.t1_premium_lock_arm_pct,
                t1_premium_lock_floor_pct=self.args.t1_premium_lock_floor_pct,
                option_max_total_debit_dollars=max_total_debit,
                option_preferred_contracts=preferred_contracts,
                option_limit_price_offset=self.args.option_limit_price_offset,
                option_max_otm_steps=self.args.option_max_otm_steps,
                option_min_abs_delta=self.args.option_min_abs_delta,
                option_max_spread_pct=self.args.option_max_spread_pct,
                session_policy=(
                    policy.get("session")
                    if isinstance(policy.get("session"), dict)
                    else None
                ),
                trendline_structure=(
                    policy.get("trendline_structure")
                    if isinstance(policy.get("trendline_structure"), dict)
                    else None
                ),
                strategy_families=lane_family_policy,
                cross_market_confirmation=getattr(
                    self.args,
                    "cross_market_confirmation",
                    "required",
                ),
                wall_options=wall_options,
            )
            lane_signal = _normalize_strategy_lane(lane_signal, lane)
            lane_signal["provider_roles"] = provider_roles
            lane_signal["gex_shadows"] = gex_shadows
            lane_signal["strategy_policy"] = {
                "strategy_max_total_debit_dollars": max_total_debit,
                "strategy_preferred_contracts": preferred_contracts,
                "strategy_max_contracts": max_contracts,
                "strategy_lane": lane,
                "concurrent_strategy_lanes": list(STRATEGY_LANES),
                "session": lane_signal.get("session_policy"),
                "strategy_families": lane_family_policy,
            }
            lane_signal["policy_fingerprint"] = _policy_fingerprint(
                lane_signal["strategy_policy"]
            )
            signals[lane] = lane_signal

        state_rank = {
            "ACTIVE": 5,
            "MANAGE": 4,
            "EXTENDED": 4,
            "ARMED": 3,
            "WATCH": 2,
            "WAIT": 1,
        }
        signal = max(
            signals.values(),
            key=lambda item: state_rank.get(str(item.get("state") or "WAIT"), 0),
        )
        _atomic_json(self.args.output_dir / "market.json", market)
        _atomic_json(self.args.output_dir / "options.json", options)
        _atomic_json(self.args.output_dir / "indicators.json", {"generated_at": generated_at, "symbols": indicators})
        _atomic_json(
            self.args.output_dir / "strategy-signals.json",
            {
                "generated_at": generated_at,
                "market_data_readiness": signal.get("market_data_readiness"),
                "signals": signals,
            },
        )
        _atomic_json(self.args.output_dir / "signal.json", signal)
        _atomic_text(self.args.output_dir / "signal.txt", render_signal(signal))
        for lane_signal in signals.values():
            self._journal_signal(lane_signal)
        regular_session_open = _regular_session_open(
            generated_at,
            signal.get("session_policy"),
        )
        _atomic_json(
            self.args.output_dir / "health.json",
            {
                "updated_at": generated_at,
                "status": (
                    "closed"
                    if not regular_session_open
                    else (
                        "guarded"
                        if any(item.get("blockers") for item in signals.values())
                        else "ok"
                    )
                ),
                "market_session": "open" if regular_session_open else "closed",
                "connected": self.ib.isConnected(),
                "readonly": True,
                "execution_enabled": False,
                "market_data_readiness": signal.get("market_data_readiness"),
                "paper_exit_target": self.args.paper_exit_target,
                "session_policy": signal.get("session_policy"),
                "paper_lifecycle_status": (
                    signal.get("lifecycle") or {}
                ).get("status") or "FLAT",
                "paper_position_open": (
                    any(
                        (item.get("lifecycle") or {}).get("paper_position_open") is True
                        for item in signals.values()
                    )
                ),
                "strategy_lanes": {
                    lane: {
                        "state": item.get("state"),
                        "strategy": item.get("strategy"),
                        "favoring": item.get("favoring"),
                        "entry_allowed": (
                            item.get("lifecycle") or {}
                        ).get("entry_allowed") is True,
                        "paper_position_open": (
                            item.get("lifecycle") or {}
                        ).get("paper_position_open") is True,
                    }
                    for lane, item in signals.items()
                },
                "paper_close_reason": (
                    signal.get("lifecycle") or {}
                ).get("close_reason"),
                "paper_closed_at": (
                    signal.get("lifecycle") or {}
                ).get("closed_at"),
                "host": self.args.host,
                "port": self.args.port,
                "client_id": self.args.client_id,
                "data_type": self.args.data_type,
                "option_contracts": len(self.option_tickers),
                "option_expiry": self.option_expiry,
                "option_expiries": sorted(self.option_expiries),
                "option_expiry_mode": self.option_expiry_mode,
                "option_anchor_spot": self.option_anchor_spot,
                "option_refresh_age_seconds": round(generated_at - self.last_option_refresh, 1),
                "option_recenter_dollars": self.args.option_recenter,
                "last_bar_refresh_at": self.last_bar_refresh,
                "bar_recovery_required": self.bar_refresh_required,
                "bar_recovery_reason": self.last_bar_recovery_reason,
                "completed_bar_age_seconds": {
                    symbol: (
                        round(generated_at - latest, 1)
                        if (latest := _latest_completed_bar_time(self.bars[symbol], generated_at))
                        else None
                    )
                    for symbol in self.args.symbols
                },
                "signal_state": signal["state"],
                "gex_source": gex.get("selected_source") or gex.get("source"),
                "gex_selection": {
                    "configured_primary": primary_source,
                    "selected_source": gex.get("selected_source") or gex.get("source"),
                    "primary_usable": usable_gex(
                        gex,
                        max_age=self.args.local_gex_max_age,
                        now=generated_at,
                    ),
                    "fallback_allowed": False,
                },
                "provider_roles": provider_roles,
                "sscgex_enabled": getattr(self.args, "sscgex_enabled", True),
                "zerogex": {
                    "available": (signal.get("zerogex_shadow") or {}).get("available"),
                    "fresh": (signal.get("zerogex_shadow") or {}).get("fresh"),
                    "fetched_age_seconds": (
                        signal.get("zerogex_shadow") or {}
                    ).get("fetched_age_seconds"),
                    "provider_age_seconds": (
                        signal.get("zerogex_shadow") or {}
                    ).get("provider_age_seconds"),
                    "entry_authority": (
                        signal.get("zerogex_shadow") or {}
                    ).get("entry_authority", False),
                    "mode": (signal.get("zerogex_shadow") or {}).get("mode"),
                    "composite_posture": (
                        (signal.get("zerogex_decision") or {}).get("composite") or {}
                    ).get("posture"),
                    "playbook_state": (
                        (signal.get("zerogex_decision") or {}).get("playbook") or {}
                    ).get("state"),
                    "active_advanced": [
                        item.get("name")
                        for item in (
                            (signal.get("zerogex_decision") or {}).get(
                                "active_advanced"
                            )
                            or []
                        )
                    ],
                    "endpoint_errors": (
                        signal.get("zerogex_shadow") or {}
                    ).get("endpoint_errors", {}),
                },
                "local_gex_enabled": self.args.local_gex_fallback,
                "local_gex_usable": usable_gex(
                    self.local_gex,
                    max_age=self.args.local_gex_max_age,
                    now=generated_at,
                ),
                "last_ibkr_errors": self.last_errors,
            },
        )
        return signal

    @staticmethod
    def _signal_fingerprint(signal: dict[str, Any]) -> tuple[Any, ...]:
        call = signal.get("call_setup") or {}
        put = signal.get("put_setup") or {}
        reversal = signal.get("reversal_setup") or {}
        lifecycle = signal.get("lifecycle") or {}
        premium = lifecycle.get("premium") or {}
        zero = signal.get("zerogex_decision") or {}
        zero_playbook = zero.get("playbook") or {}
        zero_composite = zero.get("composite") or {}
        trendline = signal.get("trendline_context") or {}
        trendline_break = trendline.get("break") or {}
        trendline_retest = trendline.get("retest") or {}
        families = signal.get("strategy_family_context") or {}
        orb = families.get("orb_index") or {}
        vwap = families.get("vwap_trend") or {}
        orb_candidate = orb.get("candidate") or {}
        vwap_candidate = (
            vwap.get("candidate")
            or vwap.get("suppressed_candidate")
            or {}
        )
        return (
            signal.get("state"),
            signal.get("favoring"),
            signal.get("strategy"),
            signal.get("confidence_score"),
            (signal.get("gex") or {}).get("source"),
            call.get("status"),
            call.get("trigger"),
            put.get("status"),
            put.get("trigger"),
            reversal.get("frozen_until"),
            lifecycle.get("status"),
            lifecycle.get("targets_hit"),
            lifecycle.get("entry_allowed"),
            lifecycle.get("paper_position_open"),
            lifecycle.get("close_reason"),
            lifecycle.get("exit_target_index"),
            bool(premium.get("hit_10_at")),
            bool(premium.get("hit_20_at")),
            tuple(signal.get("blockers") or []),
            tuple(signal.get("warnings") or []),
            zero_playbook.get("state"),
            zero_playbook.get("pattern"),
            zero_playbook.get("side"),
            zero_composite.get("posture"),
            trendline_break.get("event_id"),
            trendline_retest.get("status"),
            orb.get("status"),
            orb_candidate.get("event_id"),
            vwap.get("status"),
            vwap_candidate.get("event_id"),
            (vwap.get("kill_switch") or {}).get("active"),
            tuple(
                (
                    item.get("name"),
                    item.get("side"),
                    item.get("directional"),
                )
                for item in (zero.get("active_advanced") or [])
            ),
        )

    def _journal_signal(self, signal: dict[str, Any]) -> None:
        """Append replayable context when a signal changes or once per interval."""
        now = time.time()
        fingerprint = self._signal_fingerprint(signal)
        lane = str(signal.get("strategy_lane") or "legacy")
        fingerprints = getattr(self, "last_journal_fingerprints", {})
        journal_ats = getattr(self, "last_journal_ats", {})
        if (
            fingerprint == fingerprints.get(lane)
            and now - journal_ats.get(lane, 0) < self.args.journal_interval
        ):
            return
        journal_dir = self.args.output_dir / "history"
        journal_dir.mkdir(parents=True, exist_ok=True)
        day = datetime.fromtimestamp(now, ET).strftime("%Y-%m-%d")
        record = {
            **compact_signal_for_journal(signal),
            "journaled_at": now,
        }
        with (journal_dir / f"signals-{day}.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(record, separators=(",", ":")) + "\n")
        fingerprints[lane] = fingerprint
        journal_ats[lane] = now
        self.last_journal_fingerprints = fingerprints
        self.last_journal_ats = journal_ats
        self.last_journal_fingerprint = fingerprint
        self.last_journal_at = now

    def _log_if_changed(self, signal: dict[str, Any]) -> None:
        fingerprint = self._signal_fingerprint(signal)
        now = time.time()
        if fingerprint != self.last_log_fingerprint or now - self.last_log_at >= 60:
            print(render_signal(signal).strip(), flush=True)
            self.last_log_fingerprint = fingerprint
            self.last_log_at = now

    def _start_watchdog(self) -> None:
        """Self-restart on a silent hang.

        In-process IBKR reconnect handles dropped sockets, but a blocking
        ib_insync call on a half-open socket can hang without raising — no
        exception (so no reconnect) and no exit (so the container's restart
        policy, which only fires on exit, never triggers). This watchdog turns
        that stall into an exit: if the main loop makes no progress for
        ``timeout`` seconds it os._exit(1)s so the container restarts. Progress
        is stamped at the top of every iteration, so the normal error/reconnect
        path (which keeps looping during an IBKR outage) never trips it.
        """
        timeout = float(os.getenv("STRATEGY_WATCHDOG_TIMEOUT_SECONDS", "90") or 0)
        if timeout <= 0:
            return

        def _watch() -> None:
            while True:
                time.sleep(min(5.0, timeout / 2))
                if time.time() - self._last_progress_at > timeout:
                    print(
                        f"trade-prefetch watchdog: no loop progress for {timeout:.0f}s; "
                        "exiting for restart.",
                        flush=True,
                    )
                    os._exit(1)

        threading.Thread(target=_watch, name="prefetch-watchdog", daemon=True).start()

    def run(self) -> None:
        self.args.output_dir.mkdir(parents=True, exist_ok=True)
        self._last_progress_at = time.time()
        if not self.args.once:
            self._start_watchdog()
        try:
            while True:
                self._last_progress_at = time.time()
                try:
                    self._apply_runtime_ibkr_policy()
                    if not self.ib.isConnected():
                        self.connect()
                    self._recover_stale_bars()
                    if self._options_need_recenter():
                        self._refresh_options(force_chain=self.option_chain is None)
                    signal = self.write()
                    self._publish_signal_update(signal)
                    self._log_if_changed(signal)
                    if self.args.once:
                        return
                    self.ib.sleep(self.args.interval)
                except KeyboardInterrupt:
                    return
                except Exception as exc:
                    _atomic_json(
                        self.args.output_dir / "health.json",
                        {
                            "updated_at": time.time(),
                            "status": "error",
                            "connected": self.ib.isConnected(),
                            "readonly": True,
                            "execution_enabled": False,
                            "error": f"{type(exc).__name__}: {exc}",
                        },
                    )
                    print(f"trade-prefetch error: {type(exc).__name__}: {exc}", flush=True)
                    if self.args.once:
                        raise
                    if self.ib.isConnected():
                        self.ib.disconnect()
                    self._reset_option_state()
                    time.sleep(self.args.reconnect_interval)
        finally:
            if self.redis_publisher is not None:
                try:
                    self.redis_publisher.close()
                except Exception:
                    pass
            if self.ib.isConnected():
                self.ib.disconnect()
            self._reset_option_state()


def main() -> None:
    parser = argparse.ArgumentParser(description="Persistent read-only IBKR trade prefetch")
    parser.add_argument("--host", default="host.docker.internal")
    parser.add_argument("--port", type=int, default=4001)
    parser.add_argument("--client-id", type=int, default=89)
    parser.add_argument("--symbols", nargs="+", default=["SPY"])
    parser.add_argument(
        "--cross-market-confirmation",
        choices=("required", "shadow", "disabled"),
        default="required",
        help=(
            "Treat subscribed QQQ structure as a required gate, shadow-only "
            "breadth, or disabled context."
        ),
    )
    parser.add_argument("--strikes-per-side", type=int, default=6)
    parser.add_argument(
        "--wall-option-expiry-dte",
        type=int,
        default=3,
        help=(
            "Minimum calendar days-to-expiry for wall-reaction (near-the-money) "
            "contracts; the nearest listed expiry at least this many days out is "
            "subscribed and used for GEX wall setups. 0 disables (wall setups then "
            "use the primary 0DTE/next chain)."
        ),
    )
    parser.add_argument(
        "--option-max-total-debit-dollars",
        type=float,
        default=0,
        help=(
            "Maximum combined entry debit used to select an affordable "
            "signal contract; zero disables budget filtering."
        ),
    )
    parser.add_argument(
        "--option-preferred-contracts",
        type=int,
        default=1,
        help="Preferred quantity before an affordability fallback.",
    )
    parser.add_argument(
        "--option-limit-price-offset",
        type=float,
        default=0,
        help="Amount added to the ask for conservative affordability checks.",
    )
    parser.add_argument(
        "--option-max-otm-steps",
        type=int,
        default=6,
        help="Maximum number of OTM strikes considered by the selector.",
    )
    parser.add_argument(
        "--option-min-abs-delta",
        type=float,
        default=0.15,
        help="Reject cheap contracts whose absolute delta is below this floor.",
    )
    parser.add_argument(
        "--option-max-spread-pct",
        type=float,
        default=5,
        help="Reject contracts with wider bid/ask spreads.",
    )
    parser.add_argument(
        "--primary-gex-source",
        choices=("sscgex", "ibkr-local-oi-model", "zerogex"),
        default="sscgex",
        help="The one configured GEX source allowed to affect signal gates.",
    )
    parser.add_argument(
        "--sscgex-enabled",
        type=_boolean,
        default=True,
        help="Read SSCGEX as either the configured primary or a shadow source.",
    )
    parser.add_argument(
        "--zerogex-enabled",
        type=_boolean,
        default=False,
        help="Read ZeroGEX as either the configured primary or a shadow source.",
    )
    parser.add_argument(
        "--zerogex-structure-context",
        type=_boolean,
        default=False,
        help="Use fresh ZeroGEX strike profiles to enrich GEX nodes and walls.",
    )
    parser.add_argument(
        "--zerogex-flow-context",
        type=_boolean,
        default=False,
        help="Use ZeroGEX premium and smart-money flow as correlated context.",
    )
    parser.add_argument(
        "--zerogex-session-levels",
        type=_boolean,
        default=False,
        help="Include ZeroGEX premarket, prior-session, and opening-range levels.",
    )
    parser.add_argument(
        "--zerogex-late-day-forced-flow",
        type=_boolean,
        default=False,
        help="Use ZeroGEX dealer/forced-flow context only after 2:30 PM ET.",
    )
    parser.add_argument(
        "--paper-exit-target",
        type=int,
        choices=(1, 2, 3),
        default=2,
        help="Mark the paper lifecycle complete after this underlying target.",
    )
    parser.add_argument(
        "--same-side-reentry-cooldown-seconds",
        type=float,
        default=15 * 60,
        help="Minimum same-side cooldown after a protective or failed paper lifecycle closes.",
    )
    parser.add_argument(
        "--max-tracking-gap-seconds",
        type=float,
        default=30,
        help="Abort an open paper lifecycle after a longer processing gap.",
    )
    parser.add_argument(
        "--t1-move-invalidation-to-trigger",
        type=_boolean,
        default=True,
        help="After T1, protect the setup at its frozen entry trigger.",
    )
    parser.add_argument(
        "--t1-premium-lock-arm-pct",
        type=float,
        default=20,
        help="After T1, arm the premium profit lock at this return.",
    )
    parser.add_argument(
        "--t1-premium-lock-floor-pct",
        type=float,
        default=10,
        help="After the lock arms, close paper tracking at this return floor.",
    )
    parser.add_argument(
        "--local-gex-fallback",
        type=_boolean,
        default=True,
        help="Read the IBKR open-interest GEX model as primary or shadow.",
    )
    parser.add_argument("--local-gex-strikes-per-side", type=int, default=10)
    parser.add_argument("--local-gex-min-contracts", type=int, default=8)
    parser.add_argument("--local-gex-interval", type=float, default=5.0)
    parser.add_argument("--local-gex-max-age", type=float, default=20.0)
    parser.add_argument(
        "--zerogex-max-provider-age",
        type=float,
        default=120.0,
        help="Reject ZeroGEX when its adjusted provider age exceeds this.",
    )
    parser.add_argument(
        "--zerogex-minute-bucket-grace-seconds",
        type=float,
        default=60.0,
        help=(
            "Precision allowance for ZeroGEX timestamps rounded to a minute "
            "(default: 60)."
        ),
    )
    parser.add_argument(
        "--gex-failover-delay",
        type=float,
        default=7.0,
        help="Seconds SSCGEX must remain unusable before selecting local GEX.",
    )
    parser.add_argument(
        "--gex-recovery-delay",
        type=float,
        default=3.0,
        help="Seconds SSCGEX must remain healthy before leaving local GEX.",
    )
    parser.add_argument("--data-type", choices=sorted(DATA_TYPES), default="live")
    parser.add_argument("--interval", type=float, default=0.25)
    parser.add_argument(
        "--option-recenter",
        type=float,
        default=2,
        help="Rebuild the buffered option window only after SPY moves this many dollars.",
    )
    parser.add_argument("--reconnect-interval", type=float, default=5)
    parser.add_argument(
        "--bar-stale-after",
        type=float,
        default=125,
        help="Resubscribe historical bars when the latest completed one-minute bar is older than this.",
    )
    parser.add_argument(
        "--bar-recovery-cooldown",
        type=float,
        default=30,
        help="Minimum seconds between historical-bar resubscription attempts.",
    )
    parser.add_argument("--stale-after", type=float, default=5)
    parser.add_argument(
        "--redis-url",
        default=os.getenv("STRATEGY_REDIS_URL") or os.getenv("REDIS_URL") or "",
        help="Optional Redis URL used only to publish snapshot-change notifications.",
    )
    parser.add_argument(
        "--redis-channel",
        default=os.getenv("STRATEGY_REDIS_CHANNEL", "strategy:state-changed"),
        help="Redis Pub/Sub channel for strategy snapshot notifications.",
    )
    parser.add_argument(
        "--journal-interval",
        type=float,
        default=60,
        help="Persist a replayable signal snapshot at least this often, and immediately on changes.",
    )
    parser.add_argument("--output-dir", type=Path, default=Path("gex-data/trade"))
    parser.add_argument(
        "--policy-file",
        type=Path,
        default=None,
        help="Optional atomic JSON policy published by the Node backend.",
    )
    parser.add_argument("--gex-file", type=Path, default=Path("gex-data/latest.json"))
    parser.add_argument(
        "--heatmap-file",
        type=Path,
        default=Path("gex-data/heatmap/latest.json"),
    )
    parser.add_argument(
        "--zerogex-file",
        type=Path,
        default=Path("gex-data/trade/zerogex.json"),
        help="Cached ZeroGEX snapshot used according to its configured provider role.",
    )
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    if args.zerogex_max_provider_age <= 0:
        parser.error("--zerogex-max-provider-age must be greater than zero")
    if not 0 <= args.zerogex_minute_bucket_grace_seconds <= 60:
        parser.error(
            "--zerogex-minute-bucket-grace-seconds must be between 0 and 60"
        )
    args.symbols = [symbol.upper() for symbol in args.symbols]
    util.patchAsyncio()
    TradePrefetcher(args).run()


if __name__ == "__main__":
    main()
