"""Pure helpers for the LEAN shadow sidecar.

This module deliberately contains no broker, database, or order API.  It is
kept independently testable so the only outbound capability is the signed
snapshot publisher in ``LeanShadow.py``.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
import uuid
from pathlib import Path
from typing import Any


LANES = ("mtf", "orb_index", "vwap_trend")


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def signed_headers(secret: str, body: dict[str, Any], timestamp: int | None = None, nonce: str | None = None) -> dict[str, str]:
    issued_at = int(time.time()) if timestamp is None else timestamp
    request_nonce = nonce or uuid.uuid4().hex
    digest = hashlib.sha256(canonical_json(body).encode()).hexdigest()
    signature = hmac.new(
        secret.encode(), f"{issued_at}\n{request_nonce}\n{digest}".encode(), hashlib.sha256
    ).hexdigest()
    return {
        "Content-Type": "application/json",
        "X-Lean-Timestamp": str(issued_at),
        "X-Lean-Nonce": request_nonce,
        "X-Lean-Signature": signature,
    }


def read_json(path: str | Path) -> dict[str, Any]:
    try:
        payload = json.loads(Path(path).read_text())
        return payload if isinstance(payload, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def lane_strategy_families(configured: dict[str, Any] | None, lane: str) -> dict[str, Any]:
    source = dict(configured or {})
    if lane == "mtf":
        return {"enabled": False, "mode": "shadow"}
    orb = dict(source.get("orb_index") or {})
    vwap = dict(source.get("vwap_trend") or {})
    return {
        **source,
        "enabled": source.get("enabled", True) is True,
        "mode": "primary",
        "orb_index": {**orb, "enabled": lane == "orb_index" and orb.get("enabled", True) is True},
        "vwap_trend": {**vwap, "enabled": lane == "vwap_trend" and vwap.get("enabled", True) is True},
    }


def normalize_lane(signal: dict[str, Any], lane: str) -> dict[str, Any]:
    signal["strategy_lane"] = lane
    strategy = str(signal.get("strategy") or "").upper()
    setup = signal.get("call_setup") if signal.get("favoring") == "calls" else signal.get("put_setup")
    has_family_event = bool((setup or {}).get("source_event_id") or (signal.get("reversal_setup") or {}).get("event_id"))
    expected = {"mtf": {"MTF_REVERSAL", "MTF_TREND_BREAK", "GEX_REJECTION", "CONTINUATION"}, "orb_index": {"ORB_INDEX"}, "vwap_trend": {"VWAP_TREND"}}
    if strategy in expected[lane] and (lane == "mtf" or has_family_event):
        return signal
    if lane == "mtf":
        return signal
    idle = dict(signal)
    idle.update({
        "state": "WAIT", "signal_phase": "NO_TRADE", "favoring": "no-trade",
        "strategy": "ORB_INDEX" if lane == "orb_index" else "VWAP_TREND",
        "confidence_score": None, "call_setup": {}, "put_setup": {}, "reversal_setup": None,
        "blockers": [], "confirmations": [],
        "lifecycle": {"status": "WAIT", "entry_allowed": False, "paper_position_open": False},
        "strategy_lane": lane,
    })
    return idle


def selected_expiry(contracts: list[dict[str, Any]], generated_at: float) -> tuple[str | None, str | None]:
    expiries = sorted({str(contract.get("expiry") or "") for contract in contracts if contract.get("expiry")})
    if not expiries:
        return None, None
    # This avoids the historical before-1PM next-expiry bug: keep 0DTE before
    # 13:00 ET and choose the next listed expiry afterwards.
    from datetime import datetime
    from zoneinfo import ZoneInfo
    stamp = datetime.fromtimestamp(generated_at, ZoneInfo("America/New_York"))
    today = stamp.strftime("%Y%m%d")
    if stamp.hour * 60 + stamp.minute < 13 * 60 and today in expiries:
        return today, "0DTE"
    future = [expiry for expiry in expiries if expiry > today]
    if future:
        return future[0], "1DTE_NEXT_LISTED"
    if today in expiries:
        return today, "0DTE_NO_FUTURE_EXPIRY"
    return None, None


def zerogex_primary(snapshot: dict[str, Any], now: float) -> dict[str, Any]:
    summary = snapshot.get("gex_summary") or {}
    value = lambda key: summary.get(key)
    return {
        "fetched_at": float(snapshot.get("fetched_at") or 0),
        "source": "zerogex", "selected_source": "zerogex",
        "data": {"SPY": {
            "spot": value("spot_price"), "net_gex": value("net_gex_at_spot") or value("net_gex"),
            "flip": value("gamma_flip"), "call_wall": {"strike": value("call_wall"), "stage": "External", "taps": 0} if value("call_wall") is not None else None,
            "put_wall": {"strike": value("put_wall"), "stage": "External", "taps": 0} if value("put_wall") is not None else None,
            "regime": "Positive" if float(value("net_gex_at_spot") or value("net_gex") or 0) >= 0 else "Negative",
            "gamma_regime": "Range" if float(value("net_gex_at_spot") or value("net_gex") or 0) >= 0 else "Trend",
            "provider_timestamp": value("timestamp"), "provider_age_seconds": max(0, now - float(snapshot.get("fetched_at") or now)),
        }},
    }
