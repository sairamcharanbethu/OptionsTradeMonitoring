#!/usr/bin/env python3
"""Deterministic, execution-free GEX wall-reaction signal evaluator.

This is a *second, independent* strategy that runs alongside the primary
``signal_engine`` in shadow mode. Where ``signal_engine`` chases 0DTE OTM
breakouts via additive confluence scoring, this engine trades *reactions at
dealer gamma walls* on closed 5m/15m bars with explicit candle microstructure
(wick / sweep / retest), a logarithmic-regression macro filter, and a
gamma-regime gate.

It is a faithful port of the ``gex_signal_evaluator`` strategy logic with all
config, filesystem I/O, notifications, IBKR/yfinance fetching, and contract
execution removed. The engine is a pure function over normalized inputs and
never connects to a broker or places an order.

Inputs (matching the existing engine's shapes):
  * ``gex``  — a GEX context dict exposing ``call_wall``, ``put_wall``,
    ``flip`` (gamma flip), ``regime`` ("Positive"/"Negative"), and optionally
    ``net_gex`` and ``spot``. This is the same structure ``signal_engine``
    consumes from the ZeroGEX / local-GEX prefetch.
  * ``bars`` — a list of 1-minute bar dicts ``{time, open, high, low, close,
    volume}`` (epoch-second ``time``). Aggregated internally to closed 5m/15m.

Output: a graded shadow signal dict (setup_type / verdict / direction /
confidence / reason / invalidation) — never an order.
"""

from __future__ import annotations

import math
import statistics
import time
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
ENGINE_VERSION = "gex-wall-reaction-v1"

# --- Strategy thresholds (ported verbatim from the source strategy) ---------
LOG_REGRESSION_LENGTH = 100
CHANNEL_WIDTH = 1.5
BAND_EXTRA_WIDTH = 0.3            # up/lw = end +/- stdev * (channel_width + 0.3)
EMA_SPAN = 9
MIN_CLOSED_5M_BARS = 15
WALL_PROXIMITY_PCT = 0.35        # within 0.35% of a wall counts as a touch
BAND_TOUCH_LOWER = 1.002         # low <= lower_band * 1.002 counts as a band touch
BAND_TOUCH_UPPER = 0.998         # high >= upper_band * 0.998 counts as a band touch
WICK_DOMINANCE = 0.40            # wick must be > 40% of the candle range
RETEST_PROXIMITY = 0.998         # retest bar within 0.2% of the wall
RECLAIM_PROXIMITY = 1.002
# Strong-negative-gamma gate, in priority order:
#   1. net_gex 30d percentile <= NEGATIVE_GAMMA_PERCENTILE (scale-robust, preferred)
#   2. raw net_gex < NEGATIVE_GAMMA_NET_THRESHOLD (source strategy's absolute gate)
#   3. regime == "Negative" (sign only, last resort — demote-only: it still
#      cautions long setups but never upgrades a short to A+/PARTICIPATE)
NEGATIVE_GAMMA_PERCENTILE = 10.0
NEGATIVE_GAMMA_NET_THRESHOLD = -1.5e9
# Volume-exhaustion guard for wall *fades* (bounce/rejection): a fade into an
# expanding-volume touch is usually a break, not a hold — downgrade it.
FADE_SETUPS = {"PUT_WALL_BOUNCE_CALL", "CALL_WALL_REJECTION_PUT"}
VOLUME_EXPANSION_MULT = 1.5      # touch-bar volume >= 1.5x recent avg = expansion
VOLUME_LOOKBACK_BARS = 10


def _number(value: Any) -> bool:
    return (
        not isinstance(value, bool)
        and isinstance(value, (int, float))
        and math.isfinite(value)
    )


def _aggregate(bars: list[dict[str, Any]], minutes: int, *, now: float) -> list[dict[str, Any]]:
    """Bucket 1-minute bars into completed ``minutes``-minute candles.

    Mirrors ``signal_engine._aggregate_bars``: only closed buckets are returned
    (the in-progress bucket is dropped), so evaluation is strictly on closed
    bars.
    """
    seconds = minutes * 60
    groups: dict[int, list[dict[str, Any]]] = {}
    for bar in bars:
        stamp = bar.get("time")
        if not _number(stamp):
            continue
        bucket = int(float(stamp) // seconds) * seconds
        groups.setdefault(bucket, []).append(bar)
    output: list[dict[str, Any]] = []
    for stamp, items in sorted(groups.items()):
        try:
            output.append(
                {
                    "time": stamp,
                    "open": float(items[0]["open"]),
                    "high": max(float(item["high"]) for item in items),
                    "low": min(float(item["low"]) for item in items),
                    "close": float(items[-1]["close"]),
                    "volume": sum(float(item.get("volume", 0) or 0) for item in items),
                }
            )
        except (KeyError, TypeError, ValueError):
            continue
    current_bucket = int(now // seconds) * seconds
    return [bar for bar in output if bar["time"] < current_bucket]


def _ema_last(closes: list[float], span: int = EMA_SPAN) -> float | None:
    """Final EMA value over ``closes`` (ewm, adjust=False), pure Python."""
    if not closes:
        return None
    alpha = 2 / (span + 1)
    result = closes[0]
    for value in closes[1:]:
        result = value * alpha + result * (1 - alpha)
    return result


def _log_regression(
    closes: list[float],
    length: int = LOG_REGRESSION_LENGTH,
    channel_width: float = CHANNEL_WIDTH,
) -> tuple[float, float, float, float, bool]:
    """Logarithmic-regression channel (BigBeluga), pure Python.

    Returns ``(slope, end_baseline, upper_band, lower_band, is_slope_up)``.
    OLS on ln(price) vs bar index; bands are the population stdev of price
    scaled by ``channel_width + BAND_EXTRA_WIDTH``.
    """
    positive = [c for c in closes if _number(c) and c > 0]
    if len(positive) < MIN_CLOSED_5M_BARS:
        return 0.0, 0.0, 0.0, 0.0, False
    cur_len = min(len(positive), length)
    src = positive[-cur_len:]
    log_src = [math.log(v) for v in src]
    xs = list(range(1, cur_len + 1))
    sum_x = sum(xs)
    sum_y = sum(log_src)
    sum_x_sq = sum(x * x for x in xs)
    sum_xy = sum(x * y for x, y in zip(xs, log_src))
    denom = cur_len * sum_x_sq - sum_x * sum_x
    if denom == 0:
        return 0.0, 0.0, 0.0, 0.0, False
    slope = (cur_len * sum_xy - sum_x * sum_y) / denom
    intercept = (sum_y / cur_len) - slope * (sum_x / cur_len) + slope
    end = math.exp(intercept)
    stdev = statistics.pstdev(src) if len(src) > 1 else 0.0
    band = stdev * (channel_width + BAND_EXTRA_WIDTH)
    return slope, end, end + band, end - band, slope > 0


def _negative_gamma_state(gex: dict[str, Any]) -> tuple[bool, bool]:
    """Return ``(is_negative, confident)`` for the strong-negative-gamma gate.

    ``confident`` is True only when the verdict comes from measured evidence
    (30d percentile or absolute net GEX). The regime-sign fallback still says
    "negative" so long setups keep their caution demotion, but it must never
    count as the *strong* negative gamma that upgrades a short to A+/
    PARTICIPATE — demote-never-promote on degraded data.
    """
    percentile = gex.get("net_gex_percentile")
    if _number(percentile):
        return float(percentile) <= NEGATIVE_GAMMA_PERCENTILE, True
    net_gex = gex.get("net_gex")
    if _number(net_gex):
        return float(net_gex) < NEGATIVE_GAMMA_NET_THRESHOLD, True
    return str(gex.get("regime")) == "Negative", False


def _is_negative_gamma(gex: dict[str, Any]) -> bool:
    return _negative_gamma_state(gex)[0]


def _empty_result(
    *,
    now: float,
    symbol: str,
    spot: Any,
    reason: str,
    warnings: list[str],
) -> dict[str, Any]:
    return {
        "generated_at": now,
        "source": "gex-wall-evaluator",
        "engine_version": ENGINE_VERSION,
        "strategy": "GEX_WALL_REACTION",
        "execution_enabled": False,
        "mode": "shadow",
        "symbol": symbol,
        "spot": spot if _number(spot) else None,
        "setup_type": "NONE",
        "verdict": "AVOID",
        "direction": "NEUTRAL",
        "side": None,
        "confidence": "C",
        "reason": reason,
        "invalidation": "N/A",
        "levels": {},
        "macro": {},
        "regime": {},
        "warnings": warnings,
    }


def evaluate_gex_wall(
    gex: dict[str, Any] | None,
    bars: list[dict[str, Any]] | None,
    *,
    now: float | None = None,
    symbol: str = "SPY",
    previous_walls: dict[str, Any] | None = None,
    log_regression_length: int = LOG_REGRESSION_LENGTH,
    channel_width: float = CHANNEL_WIDTH,
) -> dict[str, Any]:
    """Evaluate the GEX wall-reaction setups against closed 5m/15m structure.

    Returns a graded, execution-free shadow signal. ``previous_walls`` (dict
    with ``call_wall``/``put_wall`` from the prior evaluation) enables the
    call-wall-migration guard; when absent the guard is treated as inactive.
    """
    current = time.time() if now is None else now
    gex = gex or {}
    bars = bars or []

    cw = gex.get("call_wall")
    pw = gex.get("put_wall")
    flip = gex.get("flip")
    if flip is None:
        flip = gex.get("gamma_flip")
    spot = gex.get("spot")

    if not (_number(cw) and _number(pw) and float(cw) > 0 and float(pw) > 0):
        return _empty_result(
            now=current, symbol=symbol, spot=spot,
            reason="GEX call/put walls unavailable.",
            warnings=["missing_walls"],
        )
    cw = float(cw)
    pw = float(pw)

    closed_5m = _aggregate(bars, 5, now=current)
    if len(closed_5m) < MIN_CLOSED_5M_BARS:
        return _empty_result(
            now=current, symbol=symbol, spot=spot,
            reason=f"Insufficient closed 5m structure ({len(closed_5m)} bars).",
            warnings=["insufficient_bars"],
        )

    closes_5m = [bar["close"] for bar in closed_5m]
    slope_5m, end_5m, up_5m, lw_5m, is_5m_up = _log_regression(
        closes_5m, length=log_regression_length, channel_width=channel_width
    )
    ema9 = _ema_last(closes_5m, EMA_SPAN)
    if not _number(ema9):
        return _empty_result(
            now=current, symbol=symbol, spot=spot,
            reason="Could not compute EMA9 baseline.",
            warnings=["ema_unavailable"],
        )

    # 15m macro trend filter.
    closed_15m = _aggregate(bars, 15, now=current)
    is_15m_up = True
    slope_15m = 0.0
    if len(closed_15m) >= MIN_CLOSED_5M_BARS:
        slope_15m, _e15, _u15, _l15, is_15m_up = _log_regression(
            [bar["close"] for bar in closed_15m],
            length=log_regression_length,
            channel_width=channel_width,
        )

    is_negative_gamma, negative_gamma_confident = _negative_gamma_state(gex)
    # Only evidence-backed negative gamma may upgrade a short setup.
    strong_negative_gamma = is_negative_gamma and negative_gamma_confident

    prev = previous_walls or {}
    prev_cw = float(prev["call_wall"]) if _number(prev.get("call_wall")) else cw
    wall_migrated_higher = cw > prev_cw

    last = closed_5m[-1]
    prior = closed_5m[-2]
    close_p = last["close"]
    open_p = last["open"]
    high_p = last["high"]
    low_p = last["low"]

    range_p = high_p - low_p
    lower_shadow = min(open_p, close_p) - low_p
    upper_shadow = high_p - max(open_p, close_p)

    prior_range = prior["high"] - prior["low"]
    prior_lower_shadow = min(prior["open"], prior["close"]) - prior["low"]
    prior_upper_shadow = prior["high"] - max(prior["open"], prior["close"])

    lows_2 = min(last["low"], prior["low"])
    highs_2 = max(last["high"], prior["high"])
    recent_highs = max(bar["high"] for bar in closed_5m[-4:])
    recent_lows = min(bar["low"] for bar in closed_5m[-4:])

    setup_type = "NONE"
    verdict = "AVOID"
    direction = "NEUTRAL"
    confidence = "C"
    reason = "No high-probability wall microstructure setup triggered."
    invalidation = "N/A"

    has_lower_wick = (
        (prior_lower_shadow / (prior_range + 0.001)) > WICK_DOMINANCE
        or (lower_shadow / (range_p + 0.001)) > WICK_DOMINANCE
    )
    has_upper_wick = (
        (prior_upper_shadow / (prior_range + 0.001)) > WICK_DOMINANCE
        or (upper_shadow / (range_p + 0.001)) > WICK_DOMINANCE
    )

    # --- Check 1: PUT_WALL / LOWER_BAND bounce -> CALL (mean-reversion) ------
    near_put_wall = (
        abs(lows_2 - pw) / pw * 100 <= WALL_PROXIMITY_PCT
        or lows_2 <= lw_5m * BAND_TOUCH_LOWER
    )
    if near_put_wall and has_lower_wick and close_p > ema9:
        setup_type = "PUT_WALL_BOUNCE_CALL"
        direction = "CALL"
        if not is_15m_up and is_negative_gamma:
            verdict, confidence = "AVOID", "C"
            reason = (
                f"Spot touched Put Wall ${pw:.2f} / Lower Band ${lw_5m:.2f}, but 15m "
                "trend is DOWN and index is in Negative Gamma. High flush risk."
            )
        elif not is_15m_up:
            verdict, confidence = "CAUTION", "B"
            reason = (
                f"Lower Band bounce confirmed at ${pw:.2f}, but 15m macro trend is "
                "DOWN. Micro-scalp size only."
            )
        else:
            verdict, confidence = "PARTICIPATE", "A"
            reason = (
                f"Confirmed Lower Band bounce at ${pw:.2f} above EMA9 with 15m UP "
                "macro alignment and Positive Gamma."
            )
        invalidation = f"5m closed bar below today's low ${low_p:.2f}"

    # --- Check 2: CALL_WALL / UPPER_BAND rejection -> PUT (mean-reversion) ---
    near_call_wall = (
        abs(highs_2 - cw) / cw * 100 <= WALL_PROXIMITY_PCT
        or highs_2 >= up_5m * BAND_TOUCH_UPPER
    )
    if near_call_wall and has_upper_wick and close_p < ema9:
        setup_type = "CALL_WALL_REJECTION_PUT"
        direction = "PUT"
        if wall_migrated_higher:
            verdict, confidence = "AVOID", "C"
            reason = "AVOID: call wall migrated higher; do not fade a rising ceiling."
        elif not is_15m_up or strong_negative_gamma:
            verdict = "PARTICIPATE"
            confidence = "A+" if (not is_15m_up and strong_negative_gamma) else "A"
            reason = (
                f"Confirmed Upper Band / Call Wall rejection at ${cw:.2f} below EMA9 "
                "with 15m DOWN alignment and Negative Gamma tailwinds."
            )
        else:
            verdict, confidence = "CAUTION", "B"
            reason = (
                f"Call Wall rejection at ${cw:.2f}, but 15m macro trend is UP. "
                "Micro-scalp only."
            )
        invalidation = f"5m closed bar above swing high ${high_p:.2f}"

    # --- Check 3: CALL_WALL failed breakout + retest -> PUT (momentum) ------
    has_breached_wall = recent_highs > cw or recent_highs >= up_5m
    lost_wall_on_close = close_p < cw or close_p < up_5m
    if has_breached_wall and lost_wall_on_close and close_p < ema9:
        retest_confirmed = False
        retest_high = cw
        for bar in closed_5m[-3:]:
            if bar["high"] >= cw * RETEST_PROXIMITY and bar["close"] < cw:
                retest_confirmed = True
                retest_high = max(retest_high, bar["high"])
        if retest_confirmed:
            setup_type = "CALL_WALL_FAILED_BREAKOUT_PUT"
            direction = "PUT"
            if not is_15m_up or strong_negative_gamma:
                verdict, confidence = "PARTICIPATE", "A+"
                reason = (
                    f"Spot swept Upper Band / Wall ${cw:.2f} to ${retest_high:.2f} and "
                    "failed. 15m DOWN alignment and Negative Gamma active."
                )
            else:
                verdict, confidence = "CAUTION", "B"
                reason = (
                    f"Spot failed ${cw:.2f} breakout, but 15m macro is UP. "
                    "Caution sizing."
                )
            invalidation = f"5m closed bar above retest high ${retest_high:.2f}"

    # --- Check 4: PUT_WALL failed breakdown + retest -> CALL (momentum) -----
    has_breached_put_wall = recent_lows < pw or recent_lows <= lw_5m
    reclaimed_wall_on_close = close_p > pw
    if has_breached_put_wall and reclaimed_wall_on_close and close_p > ema9:
        retest_confirmed = False
        retest_low = pw
        for bar in closed_5m[-3:]:
            if bar["low"] <= pw * RECLAIM_PROXIMITY and bar["close"] > pw:
                retest_confirmed = True
                retest_low = min(retest_low, bar["low"])
        if retest_confirmed:
            setup_type = "PUT_WALL_FAILED_BREAKDOWN_CALL"
            direction = "CALL"
            if is_negative_gamma or not is_15m_up:
                verdict, confidence = "CAUTION", "B"
                reason = (
                    f"Spot swept below Put Wall ${pw:.2f}, reclaimed with retest holding "
                    f"at ${retest_low:.2f}. Negative Gamma / 15m macro cautions calls."
                )
            else:
                verdict, confidence = "PARTICIPATE", "A"
                reason = (
                    f"Confirmed Lower Band / Put Wall reclaim at ${pw:.2f} with 15m UP "
                    "macro alignment and Positive Gamma."
                )
            invalidation = f"5m closed bar below retest low ${retest_low:.2f}"

    # --- Volume-exhaustion guard for FADES -----------------------------------
    # A wall bounce/rejection is a bet the wall holds. If the touch prints on
    # expanding volume, that is the signature of a break, not a hold — so a
    # PARTICIPATE fade is downgraded to CAUTION (never upgraded).
    lookback = closed_5m[-(VOLUME_LOOKBACK_BARS + 1):-1]
    avg_volume = (
        sum(float(b.get("volume", 0) or 0) for b in lookback) / len(lookback)
        if lookback else 0.0
    )
    touch_volume = float(last.get("volume", 0) or 0)
    volume_expanding = bool(
        avg_volume > 0 and touch_volume >= avg_volume * VOLUME_EXPANSION_MULT
    )
    if setup_type in FADE_SETUPS and verdict == "PARTICIPATE" and volume_expanding:
        verdict, confidence = "CAUTION", "B"
        reason = (
            f"{reason} Volume is expanding into the wall "
            f"({touch_volume:.0f} vs {avg_volume:.0f} avg) — break risk; size down."
        )

    # --- Tier-A price-structure confluence -----------------------------------
    # Boosts follow the wrapper's VWAP idiom (upgrade confidence only, capped at
    # A+); the acceptance guard mirrors the volume-expansion guard above
    # (downgrade a fade that is actually breaking, never below the base floor).
    _CONF_ORDER = ["C", "B", "A", "A+"]

    def _bump(conf: str) -> str:
        try:
            idx = _CONF_ORDER.index(conf)
        except ValueError:
            return conf
        return _CONF_ORDER[min(idx + 1, len(_CONF_ORDER) - 1)]

    # Defaults for the informational structure block. The price-structure
    # computation only affects a PARTICIPATE verdict, so it (and its import) is
    # skipped entirely for the common AVOID/CAUTION outputs.
    session: dict[str, Any] = {}
    disp: dict[str, Any] = {}
    fvgs: list[dict[str, Any]] = []
    structure_notes: list[str] = []
    swept: dict[str, Any] | None = None
    accept: dict[str, Any] | None = None
    fvg_aligned = False

    if verdict == "PARTICIPATE":
        # Lazy import (also breaks a module-load cycle: price_structure imports
        # helpers from this module).
        from price_structure import (
            acceptance,
            detect_sweep,
            displacement,
            find_fvgs,
            reference_levels,
            session_levels,
        )

        session = session_levels(bars, now=current)
        refs = reference_levels(session)
        disp = displacement(closed_5m)
        fvgs = find_fvgs(closed_5m)
        trade_up = direction == "CALL"
        disp_aligned = bool(
            disp.get("is_displacement")
            and disp.get("direction") == ("up" if trade_up else "down")
        )
        fvg_aligned = any(
            (g["type"] == "bullish") == trade_up and not g["inverted"] for g in fvgs
        )

        # A sweep of a liquidity pool on the trade's origin side (sell-side for a
        # long, buy-side for a short) that reclaims = a stop-run reversal. In
        # practice a sweep-and-reclaim of the *wall* is what Check 3/4 already
        # classify as a failed break — so this boosts the break-fail setups; the
        # pure wick bounce/rejection (Check 1/2) rarely breaches and stays fade.
        if trade_up:
            sweep_levels = [pw] + [r["price"] for r in refs if r["kind"] == "sell_side"]
            for lvl in sweep_levels:
                swept = detect_sweep(closed_5m, lvl, side="sell_side")
                if swept:
                    break
            accept = acceptance(closed_5m, pw, side="below")
        else:
            sweep_levels = [cw] + [r["price"] for r in refs if r["kind"] == "buy_side"]
            for lvl in sweep_levels:
                swept = detect_sweep(closed_5m, lvl, side="buy_side")
                if swept:
                    break
            accept = acceptance(closed_5m, cw, side="above")

        boosted = False
        if setup_type in FADE_SETUPS:
            if disp_aligned:
                structure_notes.append("displacement confirms reversal")
                boosted = True
            # Guard: acceptance *through* the defended wall means it is breaking,
            # not holding — downgrade the fade (mirrors the volume guard).
            if accept and accept.get("accepted"):
                verdict, confidence = "CAUTION", "B"
                reason = (
                    f"{reason} Price is ACCEPTING through the wall "
                    f"({accept['dwell_bars']} closes beyond) — break risk; size down."
                )
                structure_notes.append("acceptance beyond wall — fade downgraded")
                boosted = False
        else:
            # Break-fail momentum: reward a genuine sweep+reclaim, a wall that is
            # also an HTF liquidity level, an aligned FVG, or a displacement.
            traded_wall = cw if direction == "PUT" else pw
            ref_kind = "buy_side" if direction == "PUT" else "sell_side"
            htf_confluent = any(
                r["kind"] == ref_kind
                and abs(r["price"] - traded_wall) / traded_wall * 100 <= WALL_PROXIMITY_PCT
                for r in refs
            )
            if swept:
                structure_notes.append(f"liquidity sweep of {swept['level']} reclaimed")
                boosted = True
            if htf_confluent:
                structure_notes.append("wall coincides with HTF liquidity level")
                boosted = True
            if fvg_aligned:
                structure_notes.append("aligned FVG near entry")
                boosted = True
            if disp_aligned:
                structure_notes.append("displacement confirms failure")
                boosted = True

        if boosted and verdict == "PARTICIPATE" and confidence != "A+":
            confidence = _bump(confidence)
            reason = f"{reason} Structure confluence: {'; '.join(structure_notes)}."

    side = "calls" if direction == "CALL" else "puts" if direction == "PUT" else None

    return {
        "generated_at": current,
        "source": "gex-wall-evaluator",
        "engine_version": ENGINE_VERSION,
        "strategy": "GEX_WALL_REACTION",
        "execution_enabled": False,
        "mode": "shadow",
        "symbol": symbol,
        "spot": float(spot) if _number(spot) else round(close_p, 2),
        "setup_type": setup_type,
        "verdict": verdict,
        "direction": direction,
        "side": side,
        "confidence": confidence,
        "reason": reason,
        "invalidation": invalidation,
        "levels": {
            "call_wall": round(cw, 2),
            "put_wall": round(pw, 2),
            "gamma_flip": round(float(flip), 2) if _number(flip) else None,
            "upper_band_5m": round(up_5m, 2),
            "lower_band_5m": round(lw_5m, 2),
            "ema9_5m": round(ema9, 2),
        },
        "macro": {
            "trend_15m": "up" if is_15m_up else "down",
            "slope_15m": slope_15m,
            "slope_5m": slope_5m,
        },
        "regime": {
            "negative_gamma": is_negative_gamma,
            "negative_gamma_confident": negative_gamma_confident,
            "net_gex": gex.get("net_gex") if _number(gex.get("net_gex")) else None,
            "net_gex_percentile": (
                gex.get("net_gex_percentile")
                if _number(gex.get("net_gex_percentile")) else None
            ),
            "label": gex.get("regime"),
            "wall_migrated_higher": wall_migrated_higher,
        },
        "volume": {
            "touch": round(touch_volume, 0),
            "avg": round(avg_volume, 0),
            "expanding": volume_expanding,
        },
        "structure": {
            "engine_version": "price-structure-v1",
            "session": {
                "prior_day": session.get("prior_day") if session.get("available") else None,
                "today": session.get("today") if session.get("available") else None,
                "overnight": session.get("overnight") if session.get("available") else None,
            },
            "sweep": swept,
            "acceptance": accept,
            "displacement": disp,
            "fvg_count": len(fvgs),
            "fvg_aligned": fvg_aligned,
            "notes": structure_notes,
        },
        # The source strategy trades ~3DTE near-the-money contracts (higher
        # delta, tighter spreads, less theta) — surfaced here as a hint for the
        # execution layer; this engine never selects or places a contract.
        "contract_hint": {"dte_preference": ">=3", "moneyness": "near_ATM"},
        "bars_used": len(closed_5m),
        "warnings": [],
    }


if __name__ == "__main__":  # pragma: no cover - manual smoke check
    import json

    demo_now = 1_700_000_000.0
    demo_bars = [
        {"time": demo_now - (30 - i) * 60, "open": 500 + i * 0.1, "high": 500 + i * 0.1,
         "low": 500 + i * 0.1, "close": 500 + i * 0.1, "volume": 1000}
        for i in range(30)
    ]
    print(json.dumps(evaluate_gex_wall({"call_wall": 505, "put_wall": 500, "regime": "Positive"},
                                       demo_bars, now=demo_now), indent=2))
