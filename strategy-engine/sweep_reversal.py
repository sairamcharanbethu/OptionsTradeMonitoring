#!/usr/bin/env python3
"""Sweep-and-reclaim reversal — SHADOW ONLY (never arms a live entry).

A liquidity-sweep reversal at a session reference level (PDH/PDL, ONH/ONL,
IBH/IBL): a closed 5m bar pierces the level shallowly (a stop run, not a trend
break-through) and price closes back through it on the latest completed 5m
bar. The candidate reverses *with* the reclaim: a sell-side sweep (below a low)
reclaimed → calls; a buy-side sweep (above a high) reclaimed → puts.

Why shadow: every pure fade this engine has traded (wall bounce, wall
rejection, heatmap rejection) failed in replay. This setup differs in that it
fires only after the level has already broken and price has come back, which
is structurally closer to the surviving GEX_WALL_BREAK_FAIL than to a bounce.
It earns a live slot only if the replay says so (uw_backtest ``shadow_sweep``
executor). ``signal_engine`` attaches the candidate under
``signal["shadow_setups"]`` for journaling and never reads it back.

Pure and execution-free, built on ``price_structure`` (same closed-bar basis as
the wall evaluator). Independent research on the public "liquidity sweep"
pattern finds at best a small, insignificant edge on SPY, so the default
thresholds here are deliberately strict and the bar for promotion is the
replay, not the pattern's popularity.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from gex_wall_evaluator import ET, _aggregate, _number
from price_structure import (
    detect_sweep,
    displacement,
    reference_levels,
    session_levels,
)

STRATEGY = "SWEEP_RECLAIM_REVERSAL"
ENGINE_VERSION = "sweep-reversal-shadow-v1"

# --- Thresholds (tune via replay; module-level like the evaluator) ----------
BAR_MINUTES = 5                 # closed-bar basis for the sweep/reclaim
MIN_SCORE = 70                  # below this the candidate is not emitted
STOP_BUFFER_ATR = 0.15          # stop sits this far beyond the sweep extreme
MIN_RISK_ATR = 0.50             # never tighter than half an ATR (noise floor)
MAX_RISK_ATR = 1.50             # sweep too deep for the reclaim entry -> skip
TARGET_R = (1.0, 1.75, 2.75)    # mirrors _structure_plan's ATR fallback ladder
FREEZE_SECONDS = 15 * 60        # trigger stays valid this long (live idiom)
IB_LEVELS_FROM_MIN = 10 * 60 + 30   # IBH/IBL only mean something after 10:30 ET
HTF_LEVELS = {"PDH", "PDL", "ONH", "ONL"}


def _et_minutes(epoch: float) -> int:
    stamp = datetime.fromtimestamp(float(epoch), ET)
    return stamp.hour * 60 + stamp.minute


def _plan(entry: float, side: str, atr: float, stop_anchor: float) -> dict[str, Any] | None:
    minimum_risk = max(0.10, atr * MIN_RISK_ATR)
    if side == "calls":
        stop = min(stop_anchor, entry - minimum_risk)
    else:
        stop = max(stop_anchor, entry + minimum_risk)
    stop = round(stop, 2)
    risk = round(abs(entry - stop), 2)
    if risk <= 0 or risk > atr * MAX_RISK_ATR + 1e-9:
        return None
    targets = [
        round(entry + m * risk if side == "calls" else entry - m * risk, 2)
        for m in TARGET_R
    ]
    return {
        "entry": round(entry, 2),
        "stop": stop,
        "risk_dollars": risk,
        "targets": targets,
        "method": f"sweep_extreme+{STOP_BUFFER_ATR:g}x_5m_atr_buffer",
    }


def sweep_reclaim_candidate(
    history_bars: list[dict[str, Any]] | None,
    *,
    spot: float,
    atr_5m: float,
    now: float,
    gex_ctx: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Fresh sweep-and-reclaim reversal candidate, or ``None``.

    ``history_bars``: completed 1m bars spanning today and prior sessions (the
    same multi-day window the wall candidate receives). Emits only when the
    reclaim closed on the *latest* completed 5m bar, so a given reclaim
    produces exactly one candidate.
    """
    if not _number(spot) or not _number(atr_5m) or float(atr_5m) <= 0:
        return None
    bars = [b for b in (history_bars or []) if _number(b.get("time"))]
    if len(bars) < 30:
        return None
    five = _aggregate(bars, BAR_MINUTES, now=now)
    if len(five) < 3:
        return None
    session = session_levels(bars, now=now)
    levels = reference_levels(session)
    if not levels:
        return None
    minute = _et_minutes(now)
    if minute < IB_LEVELS_FROM_MIN:
        levels = [lvl for lvl in levels if lvl["name"] not in {"IBH", "IBL"}]

    spot = float(spot)
    atr = float(atr_5m)
    reclaim_bar = five[-1]
    disp = displacement(five)
    regime = str((gex_ctx or {}).get("regime") or "")

    best: dict[str, Any] | None = None
    for level in levels:
        sweep = detect_sweep(five, level["price"], side=level["kind"])
        if not sweep or sweep.get("bars_since") != 0:
            continue
        side = "calls" if level["kind"] == "sell_side" else "puts"
        # Spot must still be on the reclaim side of the level.
        if (side == "calls" and spot <= level["price"]) or (side == "puts" and spot >= level["price"]):
            continue
        if side == "calls":
            entry = round(float(reclaim_bar["high"]) + 0.01, 2)
            stop_anchor = float(sweep["pierce_extreme"]) - atr * STOP_BUFFER_ATR
        else:
            entry = round(float(reclaim_bar["low"]) - 0.01, 2)
            stop_anchor = float(sweep["pierce_extreme"]) + atr * STOP_BUFFER_ATR
        plan = _plan(entry, side, atr, round(stop_anchor, 2))
        if plan is None:
            continue
        aligned_disp = disp.get("is_displacement") and disp.get("direction") == (
            "up" if side == "calls" else "down"
        )
        score = MIN_SCORE
        score += 10 if aligned_disp else 0
        # Fades are the positive-gamma trade: dealer hedging dampens moves and
        # pulls price back toward the level that was just swept.
        score += 10 if regime == "Positive" else 0
        score += 5 if level["name"] in HTF_LEVELS else 0
        if score < MIN_SCORE:
            continue
        candidate = {
            "strategy": STRATEGY,
            "shadow": True,
            "side": side,
            "score": score,
            "base_score": score,
            "quality": "HIGH" if score >= 80 else "MEDIUM",
            "setup": (
                f"{level['name']} {level['price']:.2f} swept to {sweep['pierce_extreme']:.2f} "
                f"and reclaimed on the latest 5m close"
            ),
            "level": {"name": level["name"], "price": round(float(level["price"]), 2), "kind": level["kind"]},
            "sweep": sweep,
            "displacement": {
                "aligned": bool(aligned_disp),
                "body_atr_ratio": disp.get("body_atr_ratio"),
            },
            "gex_alignment": {"regime": regime or None, "heatmap_status": "n/a"},
            "a_plus": bool(aligned_disp and regime == "Positive"),
            "risk_plan": plan,
            "detected_at": float(now),
            "frozen_until": float(now) + FREEZE_SECONDS,
            "engine_version": ENGINE_VERSION,
        }
        if best is None or (
            candidate["score"], -candidate["risk_plan"]["risk_dollars"]
        ) > (best["score"], -best["risk_plan"]["risk_dollars"]):
            best = candidate
    return best
