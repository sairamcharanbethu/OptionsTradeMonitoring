#!/usr/bin/env python3
"""Conservative SPY GEX approximation from IBKR option gamma and open interest.

This model does not observe dealer inventory. Calls are signed positive and puts
negative, which is the common open-interest GEX convention. Consumers must keep
the source/method labels attached to the snapshot.
"""

from __future__ import annotations

import math
import time
from typing import Any


SOURCE = "ibkr-local-oi-model"
METHOD = "call_positive_put_negative_open_interest"


class GexSourceSelector:
    """Stateful primary/fallback selector with outage and recovery hysteresis."""

    def __init__(
        self,
        *,
        failover_delay: float = 7.0,
        recovery_delay: float = 3.0,
        primary_enabled: bool = True,
    ):
        self.failover_delay = max(0.0, float(failover_delay))
        self.recovery_delay = max(0.0, float(recovery_delay))
        self.primary_enabled = bool(primary_enabled)
        self.selected_source: str | None = None
        self.primary_unusable_since: float | None = None
        self.primary_healthy_since: float | None = None

    @staticmethod
    def _external(snapshot: dict[str, Any] | None) -> dict[str, Any] | None:
        if snapshot is None:
            return None
        chosen = dict(snapshot)
        raw_source = str(chosen.get("source") or "sscgex")
        chosen["selected_source"] = "sscgex" if raw_source == "prefetch-service" else raw_source
        return chosen

    def choose(
        self,
        external: dict[str, Any] | None,
        local: dict[str, Any] | None,
        *,
        local_enabled: bool,
        max_age: float = 20,
        now: float | None = None,
    ) -> dict[str, Any] | None:
        stamp = time.time() if now is None else now
        if not self.primary_enabled:
            self.primary_unusable_since = None
            self.primary_healthy_since = None
            local_ok = local_enabled and usable_gex(local, max_age=max_age, now=stamp)
            self.selected_source = SOURCE if local_ok else None
            return local

        external_ok = usable_gex(external, max_age=max_age, now=stamp)
        local_ok = local_enabled and usable_gex(local, max_age=max_age, now=stamp)
        external_snapshot = self._external(external)

        if external_ok:
            self.primary_unusable_since = None
            if self.selected_source == SOURCE and local_ok:
                if self.primary_healthy_since is None:
                    self.primary_healthy_since = stamp
                if stamp - self.primary_healthy_since < self.recovery_delay:
                    return local
            self.primary_healthy_since = stamp
            self.selected_source = "sscgex"
            return external_snapshot

        self.primary_healthy_since = None
        if self.primary_unusable_since is None:
            self.primary_unusable_since = stamp
        if self.selected_source != SOURCE:
            outage_age = stamp - self.primary_unusable_since
            if outage_age < self.failover_delay:
                self.selected_source = "sscgex"
                return external_snapshot or local
        if local_ok:
            self.selected_source = SOURCE
            return local

        # Neither source is currently usable. Retain the selected source label
        # when possible so health checks report unavailability, not a source flap.
        if self.selected_source == SOURCE and local is not None:
            return local
        self.selected_source = "sscgex" if external_snapshot is not None else None
        return external_snapshot or local

    def status(self, *, now: float | None = None) -> dict[str, Any]:
        stamp = time.time() if now is None else now
        return {
            "selected_source": self.selected_source,
            "primary_enabled": self.primary_enabled,
            "failover_delay_seconds": self.failover_delay,
            "recovery_delay_seconds": self.recovery_delay,
            "primary_unusable_seconds": (
                round(max(0.0, stamp - self.primary_unusable_since), 2)
                if self.primary_unusable_since is not None else None
            ),
            "primary_healthy_seconds": (
                round(max(0.0, stamp - self.primary_healthy_since), 2)
                if self.primary_healthy_since is not None else None
            ),
        }


def _number(value: Any) -> bool:
    return isinstance(value, (int, float)) and math.isfinite(value)


def _wall(strike_rows: list[dict[str, Any]], side: str) -> dict[str, Any] | None:
    field = "call_gex" if side == "call" else "put_gex"
    candidates = [row for row in strike_rows if _number(row.get(field)) and row[field] != 0]
    if not candidates:
        return None
    selected = max(candidates, key=lambda row: abs(float(row[field])))
    return {
        "strike": selected["strike"],
        "stage": "Modeled",
        "taps": 0,
        "gex": selected[field],
    }


def _rolling(current_call: dict[str, Any] | None, current_put: dict[str, Any] | None,
             previous: dict[str, Any] | None) -> str:
    prior_spy = ((previous or {}).get("data") or {}).get("SPY") or {}
    prior_call = (prior_spy.get("call_wall") or {}).get("strike")
    prior_put = (prior_spy.get("put_wall") or {}).get("strike")
    call = (current_call or {}).get("strike")
    put = (current_put or {}).get("strike")
    if not all(_number(value) for value in (prior_call, prior_put, call, put)):
        return "LOCAL_INITIAL"
    if call > prior_call and put > prior_put:
        return "LOCAL_SHIFT_UP"
    if call < prior_call and put < prior_put:
        return "LOCAL_SHIFT_DOWN"
    return "LOCAL_STABLE"


def build_local_gex(
    options: dict[str, Any],
    spot: float | None,
    *,
    previous: dict[str, Any] | None = None,
    min_contracts: int = 8,
    now: float | None = None,
) -> dict[str, Any]:
    """Return a normalized GEX snapshot compatible with ``signal_engine``."""
    stamp = time.time() if now is None else now
    expiry = options.get("expiry")
    contracts = options.get("contracts") or []
    by_strike: dict[float, dict[str, Any]] = {}
    usable = 0
    call_usable = 0
    put_usable = 0
    total_oi = 0.0

    if _number(spot) and spot > 0:
        multiplier = 100.0 * float(spot) ** 2 * 0.01
        for contract in contracts:
            strike = contract.get("strike")
            gamma = contract.get("gamma")
            open_interest = contract.get("open_interest")
            right = contract.get("right")
            if (
                right not in {"C", "P"}
                or not _number(strike)
                or not _number(gamma)
                or gamma < 0
                or not _number(open_interest)
                or open_interest < 0
            ):
                continue
            exposure = float(gamma) * float(open_interest) * multiplier
            signed = exposure if right == "C" else -exposure
            row = by_strike.setdefault(
                float(strike),
                {"strike": float(strike), "call_gex": 0.0, "put_gex": 0.0, "net_gex": 0.0},
            )
            field = "call_gex" if right == "C" else "put_gex"
            row[field] += signed
            row["net_gex"] += signed
            usable += 1
            call_usable += right == "C"
            put_usable += right == "P"
            total_oi += float(open_interest)

    rows = []
    for row in sorted(by_strike.values(), key=lambda item: item["strike"]):
        rows.append({key: round(value, 2) for key, value in row.items()})
    call_wall = _wall(rows, "call")
    put_wall = _wall(rows, "put")
    coverage = usable / len(contracts) if contracts else 0.0
    valid = bool(
        _number(spot)
        and usable >= max(2, min_contracts)
        and call_usable >= 2
        and put_usable >= 2
        and total_oi > 0
        and coverage >= 0.75
        and call_wall
        and put_wall
    )
    net_gex = round(sum(float(row["net_gex"]) for row in rows), 2)
    confidence = "MEDIUM" if valid and coverage >= 0.75 else "LOW"
    spy: dict[str, Any] = {
        "spot": float(spot) if _number(spot) else None,
        "served_expiry": expiry,
        "regime": "Positive" if net_gex >= 0 else "Negative",
        "gamma_regime": "Range" if net_gex >= 0 else "Trend",
        "pattern": "OI_GAMMA_MODEL",
        "rolling": _rolling(call_wall, put_wall, previous),
        "call_wall": call_wall,
        "put_wall": put_wall,
        "flip": None,
        "net_gex": net_gex,
        "contract_count": len(contracts),
        "usable_contracts": usable,
        "coverage_ratio": round(coverage, 3),
        "total_open_interest": round(total_oi, 0),
        "model_confidence": confidence,
        "strikes": rows,
    }
    if not valid:
        spy["error"] = (
            f"local GEX incomplete: usable={usable}/{len(contracts)}, "
            f"coverage={coverage:.1%}, calls={call_usable}, puts={put_usable}, total_oi={total_oi:.0f}"
        )
    return {
        "fetched_at": stamp,
        "source": SOURCE,
        "selected_source": SOURCE,
        "model": {
            "method": METHOD,
            "dealer_position_inferred": True,
            "open_interest_intraday": False,
        },
        "data": {"SPY": spy},
    }


def usable_gex(snapshot: dict[str, Any] | None, *, max_age: float, now: float | None = None) -> bool:
    stamp = time.time() if now is None else now
    snapshot = snapshot or {}
    spy = (snapshot.get("data") or {}).get("SPY") or {}
    try:
        age = stamp - float(snapshot.get("fetched_at", 0) or 0)
    except (TypeError, ValueError):
        return False
    return bool(
        0 <= age <= max_age
        and isinstance(spy, dict)
        and not spy.get("error")
        and spy.get("stale") is not True
        and _number(spy.get("spot"))
        and spy.get("regime") in {"Positive", "Negative"}
        and spy.get("gamma_regime") in {"Range", "Trend", "Whipsaw"}
    )


def select_gex(
    external: dict[str, Any] | None,
    local: dict[str, Any] | None,
    *,
    local_enabled: bool,
    max_age: float = 20,
    now: float | None = None,
) -> dict[str, Any] | None:
    """Prefer healthy SSCGEX; use the local model only when explicitly enabled."""
    stamp = time.time() if now is None else now
    if usable_gex(external, max_age=max_age, now=stamp):
        chosen = dict(external or {})
        raw_source = str(chosen.get("source") or "sscgex")
        chosen["selected_source"] = "sscgex" if raw_source == "prefetch-service" else raw_source
        return chosen
    if local_enabled and usable_gex(local, max_age=max_age, now=stamp):
        return local
    return external or local
