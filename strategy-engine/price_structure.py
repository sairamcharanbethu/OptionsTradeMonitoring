#!/usr/bin/env python3
"""Deterministic, execution-free price-structure feature module.

This is the *Tier-A foundation* for the order-flow / auction-theory work: a set
of pure functions over the same normalized bar shape ``gex_wall_evaluator``
consumes, computing price-only structure that can be built from stored 5m OHLCV
(no ticks, no aggressor side, no Level 2 required). Nothing here connects to a
broker, reads the filesystem, or places an order.

The features are designed as *confluence context* for the GEX wall-reaction
setups, not standalone entry triggers — mirroring how ``_gex_wall_candidate``
already boosts a wall setup on VWAP confluence. Each is backtestable today
against the bars the system already persists.

Features:
  * ``session_levels``   — HTF / session liquidity: prior-day H/L/close (PDH/
    PDL/PDC), today's RTH open, initial-balance H/L, overnight H/L, and a
    multi-day (weekly-proxy) range.
  * ``detect_sweep``     — liquidity grab: a wick pierces a reference level then
    price closes back through it (stop-run reversal).
  * ``acceptance``       — acceptance vs. rejection: dwell of closed bars beyond
    a level (break) vs. a wick that closed back (fade).
  * ``displacement``     — outsized directional body vs. ATR (institutional
    intent after a sweep).
  * ``find_fvgs``        — fair-value gaps (3-bar imbalance) and their inversion
    (IFVG) once price closes through them.
  * ``reference_levels`` — flattens ``session_levels`` into the ordered level
    list the sweep/acceptance checks scan.

Bar shape: ``{time, open, high, low, close, volume}`` with epoch-second ``time``
(same as ``gex_wall_evaluator``). Level/pattern features operate on *closed*
bars aggregated via the shared ``_aggregate`` so their basis is identical to
the wall evaluator's.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

# Reuse the wall evaluator's numeric guard, ET zone, and closed-bar aggregation
# verbatim so this module's basis is byte-for-byte identical to the evaluator's
# (sessions, sweeps, and setups must agree on what "a closed bar" is).
from gex_wall_evaluator import ET, _aggregate, _number

ENGINE_VERSION = "price-structure-v1"

# --- Session windows (ET, minutes-of-day) -----------------------------------
RTH_OPEN_MIN = 9 * 60 + 30       # 09:30 ET
RTH_CLOSE_MIN = 16 * 60          # 16:00 ET
IB_MINUTES = 60                  # initial balance = first 60 min of RTH

# --- Feature thresholds (tune via backtest; module-level like the evaluator) -
ATR_LEN = 14
SWEEP_LOOKBACK = 4               # bars in which a pierce + reclaim must occur
SWEEP_PROXIMITY_PCT = 0.15       # pierce must clear the level by <= this % to
                                 # count as a *grab* (a clean run, not a trend)
ACCEPT_LOOKBACK = 3              # bars examined for acceptance beyond a level
ACCEPT_MIN_BARS = 2              # >= this many closes beyond = accepted (break)
DISPLACEMENT_ATR_MULT = 1.5      # body >= this * ATR = displacement
DISPLACEMENT_BODY_RATIO = 0.55   # body must be >= this fraction of the range
FVG_LOOKBACK = 20                # bars scanned for fair-value gaps
FVG_MIN_GAP_ATR = 0.15           # gap must be >= this * ATR to matter


def _et_minute_of_day(epoch: float) -> int:
    dt = datetime.fromtimestamp(float(epoch), ET)
    return dt.hour * 60 + dt.minute


def _et_date(epoch: float) -> str:
    return datetime.fromtimestamp(float(epoch), ET).strftime("%Y-%m-%d")


def _is_rth(epoch: float) -> bool:
    minute = _et_minute_of_day(epoch)
    return RTH_OPEN_MIN <= minute < RTH_CLOSE_MIN


def _clean(bars: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """Sorted bars with finite time/OHLC; volume defaulted to 0."""
    out: list[dict[str, Any]] = []
    for bar in bars or []:
        t = bar.get("time")
        o, h, low, c = bar.get("open"), bar.get("high"), bar.get("low"), bar.get("close")
        if not all(_number(v) for v in (t, o, h, low, c)):
            continue
        vol = bar.get("volume", 0)
        out.append(
            {
                "time": float(t),
                "open": float(o),
                "high": float(h),
                "low": float(low),
                "close": float(c),
                "volume": float(vol) if _number(vol) else 0.0,
            }
        )
    out.sort(key=lambda b: b["time"])
    return out


def _atr(bars: list[dict[str, Any]], length: int = ATR_LEN) -> float | None:
    """Simple-average True Range over the last ``length`` bars (pure Python)."""
    if len(bars) < 2:
        return None
    trs: list[float] = []
    for prev, cur in zip(bars[:-1], bars[1:]):
        tr = max(
            cur["high"] - cur["low"],
            abs(cur["high"] - prev["close"]),
            abs(cur["low"] - prev["close"]),
        )
        trs.append(tr)
    if not trs:
        return None
    window = trs[-length:]
    return sum(window) / len(window)


def session_levels(
    bars: list[dict[str, Any]] | None,
    *,
    now: float | None = None,
) -> dict[str, Any]:
    """HTF / session liquidity levels from ET-classified bars.

    Works off the finest bars supplied (do NOT pre-aggregate — truer wick
    extremes). Requires ``useRTH=false`` bars for overnight fields; when only
    RTH bars are present the overnight block is ``None`` and the rest still
    populate. Prior-*week* H/L is only as deep as the supplied window (a 5-day
    window is a weekly proxy, surfaced as ``multi_day``).
    """
    clean = _clean(bars)
    if not clean:
        return {"available": False, "reason": "no_bars"}

    # Group RTH bars by ET calendar date.
    rth_by_date: dict[str, list[dict[str, Any]]] = {}
    for bar in clean:
        if _is_rth(bar["time"]):
            rth_by_date.setdefault(_et_date(bar["time"]), []).append(bar)

    today_date = _et_date(clean[-1]["time"])
    rth_dates = sorted(rth_by_date)

    def _hl(items: list[dict[str, Any]]) -> tuple[float, float]:
        return max(b["high"] for b in items), min(b["low"] for b in items)

    today: dict[str, Any] = {"date": today_date}
    today_rth = rth_by_date.get(today_date)
    if today_rth:
        r_high, r_low = _hl(today_rth)
        ib = [b for b in today_rth if _et_minute_of_day(b["time"]) < RTH_OPEN_MIN + IB_MINUTES]
        ib_high, ib_low = _hl(ib) if ib else (None, None)
        today.update(
            {
                "rth_open": today_rth[0]["open"],
                "rth_high": r_high,
                "rth_low": r_low,
                "ib_high": ib_high,
                "ib_low": ib_low,
            }
        )
    # Full-session (incl. overnight) extremes for today's ET date.
    today_all = [b for b in clean if _et_date(b["time"]) == today_date]
    if today_all:
        s_high, s_low = _hl(today_all)
        today["session_high"] = s_high
        today["session_low"] = s_low

    # Prior RTH day (PDH/PDL/PDC): latest RTH date strictly before today.
    prior_day: dict[str, Any] | None = None
    prior_rth_dates = [d for d in rth_dates if d < today_date]
    if prior_rth_dates:
        pd_date = prior_rth_dates[-1]
        pd_bars = rth_by_date[pd_date]
        pd_high, pd_low = _hl(pd_bars)
        prior_day = {
            "date": pd_date,
            "high": pd_high,
            "low": pd_low,
            "close": pd_bars[-1]["close"],
        }

    # Overnight: bars strictly between the prior RTH session's last bar and
    # today's first RTH bar (or ``now`` if today's RTH has not started).
    overnight: dict[str, Any] | None = None
    if prior_rth_dates:
        pd_last_t = rth_by_date[prior_rth_dates[-1]][-1]["time"]
        on_end_t = today_rth[0]["time"] if today_rth else (
            float(now) if _number(now) else clean[-1]["time"] + 1
        )
        on_bars = [b for b in clean if pd_last_t < b["time"] < on_end_t]
        if on_bars:
            on_high, on_low = _hl(on_bars)
            overnight = {"high": on_high, "low": on_low}

    # Multi-day (weekly proxy) range over the whole supplied window.
    md_high, md_low = _hl(clean)
    multi_day = {"high": md_high, "low": md_low, "days": len(rth_dates)}

    return {
        "available": True,
        "today": today,
        "prior_day": prior_day,
        "overnight": overnight,
        "multi_day": multi_day,
    }


def reference_levels(session: dict[str, Any]) -> list[dict[str, Any]]:
    """Flatten ``session_levels`` output into named, sweepable price levels.

    ``kind`` is the liquidity side that rests at the level: ``sell_side`` (below
    price — resting stops under prior lows, swept by a downside pierce +
    reclaim) or ``buy_side`` (above price — stops over prior highs).
    """
    if not session.get("available"):
        return []
    out: list[dict[str, Any]] = []

    def add(name: str, price: Any, kind: str) -> None:
        if _number(price):
            out.append({"name": name, "price": float(price), "kind": kind})

    today = session.get("today") or {}
    prior = session.get("prior_day") or {}
    overnight = session.get("overnight") or {}
    add("PDH", prior.get("high"), "buy_side")
    add("PDL", prior.get("low"), "sell_side")
    add("ONH", overnight.get("high"), "buy_side")
    add("ONL", overnight.get("low"), "sell_side")
    add("IBH", today.get("ib_high"), "buy_side")
    add("IBL", today.get("ib_low"), "sell_side")
    return out


def detect_sweep(
    bars: list[dict[str, Any]] | None,
    level: float,
    *,
    side: str,
    lookback: int = SWEEP_LOOKBACK,
    proximity_pct: float = SWEEP_PROXIMITY_PCT,
) -> dict[str, Any] | None:
    """Liquidity sweep of ``level`` within the last ``lookback`` closed bars.

    ``side='sell_side'``: a bar pierces *below* ``level`` (grabs resting sell
    stops) and a later/same bar closes back *above* it → bullish reversal.
    ``side='buy_side'``: a bar pierces *above* ``level`` and closes back below →
    bearish. The pierce must be shallow (<= ``proximity_pct`` beyond the level)
    to read as a grab rather than a trend break-through.
    """
    clean = _clean(bars)
    if len(clean) < 2 or not _number(level) or level <= 0:
        return None
    window = clean[-lookback:]
    max_beyond = level * (proximity_pct / 100.0)

    if side == "sell_side":
        for i, bar in enumerate(window):
            if bar["low"] < level and (level - bar["low"]) <= max_beyond:
                # reclaim: this bar or a subsequent one closes back above level
                for j in range(i, len(window)):
                    if window[j]["close"] > level:
                        return {
                            "swept": True,
                            "side": side,
                            "level": round(level, 2),
                            "pierce_extreme": round(bar["low"], 2),
                            "bars_since": len(window) - 1 - j,
                        }
    elif side == "buy_side":
        for i, bar in enumerate(window):
            if bar["high"] > level and (bar["high"] - level) <= max_beyond:
                for j in range(i, len(window)):
                    if window[j]["close"] < level:
                        return {
                            "swept": True,
                            "side": side,
                            "level": round(level, 2),
                            "pierce_extreme": round(bar["high"], 2),
                            "bars_since": len(window) - 1 - j,
                        }
    return None


def acceptance(
    bars: list[dict[str, Any]] | None,
    level: float,
    *,
    side: str,
    lookback: int = ACCEPT_LOOKBACK,
    min_bars: int = ACCEPT_MIN_BARS,
) -> dict[str, Any]:
    """Acceptance vs. rejection of ``level`` over the last ``lookback`` bars.

    ``side='above'``: counts closed bars closing *above* ``level``. Acceptance
    (>= ``min_bars`` closes beyond) reads as a genuine break; a final bar that
    wicked beyond but closed back reads as rejection (fade). ``side='below'``
    is the mirror.
    """
    clean = _clean(bars)
    result = {"dwell_bars": 0, "accepted": False, "rejected": False, "side": side}
    if not clean or not _number(level):
        return result
    window = clean[-lookback:]
    last = clean[-1]
    if side == "above":
        dwell = sum(1 for b in window if b["close"] > level)
        rejected = last["high"] > level and last["close"] <= level
    elif side == "below":
        dwell = sum(1 for b in window if b["close"] < level)
        rejected = last["low"] < level and last["close"] >= level
    else:
        return result
    result["dwell_bars"] = dwell
    result["accepted"] = dwell >= min_bars
    result["rejected"] = bool(rejected)
    return result


def displacement(
    bars: list[dict[str, Any]] | None,
    *,
    atr_len: int = ATR_LEN,
    atr_mult: float = DISPLACEMENT_ATR_MULT,
    body_ratio: float = DISPLACEMENT_BODY_RATIO,
) -> dict[str, Any]:
    """Outsized directional body on the last closed bar vs. ATR."""
    clean = _clean(bars)
    empty = {
        "is_displacement": False, "direction": "none",
        "body": 0.0, "range": 0.0, "atr": None, "body_atr_ratio": None,
    }
    if len(clean) < 2:
        return empty
    atr = _atr(clean, atr_len)
    last = clean[-1]
    body = abs(last["close"] - last["open"])
    rng = last["high"] - last["low"]
    if not _number(atr) or atr <= 0 or rng <= 0:
        return {**empty, "body": round(body, 4), "range": round(rng, 4), "atr": atr}
    ratio = body / atr
    is_disp = ratio >= atr_mult and (body / rng) >= body_ratio
    direction = "up" if last["close"] > last["open"] else "down" if last["close"] < last["open"] else "none"
    return {
        "is_displacement": bool(is_disp),
        "direction": direction if is_disp else "none",
        "body": round(body, 4),
        "range": round(rng, 4),
        "atr": round(atr, 4),
        "body_atr_ratio": round(ratio, 3),
    }


def find_fvgs(
    bars: list[dict[str, Any]] | None,
    *,
    lookback: int = FVG_LOOKBACK,
    atr_len: int = ATR_LEN,
    min_gap_atr: float = FVG_MIN_GAP_ATR,
) -> list[dict[str, Any]]:
    """Fair-value gaps (3-bar imbalance) and inversions (IFVG).

    Bullish FVG: ``bar[i-2].high < bar[i].low`` (gap the middle bar displaced
    through). Bearish FVG: ``bar[i-2].low > bar[i].high``. ``filled`` marks that
    a later bar traded back into the gap; ``inverted`` (IFVG) marks that a later
    bar *closed fully through* the gap, flipping its polarity — a filled-and-
    inverted bullish FVG becomes bearish resistance and vice versa.
    """
    clean = _clean(bars)
    if len(clean) < 3:
        return []
    atr = _atr(clean, atr_len) or 0.0
    min_gap = atr * min_gap_atr
    scan = clean[-(lookback + 2):]
    out: list[dict[str, Any]] = []
    for i in range(2, len(scan)):
        a, _mid, c = scan[i - 2], scan[i - 1], scan[i]
        bullish = a["high"] < c["low"] and (c["low"] - a["high"]) >= min_gap
        bearish = a["low"] > c["high"] and (a["low"] - c["high"]) >= min_gap
        if not (bullish or bearish):
            continue
        top = c["low"] if bullish else a["low"]
        bottom = a["high"] if bullish else c["high"]
        gap = {
            "type": "bullish" if bullish else "bearish",
            "top": round(top, 4),
            "bottom": round(bottom, 4),
            "mid": round((top + bottom) / 2, 4),
            "created_time": c["time"],
            "filled": False,
            "inverted": False,
        }
        # Fill / inversion by any bar after the gap's third leg.
        for later in scan[i + 1:]:
            if later["low"] <= top and later["high"] >= bottom:
                gap["filled"] = True
            if gap["type"] == "bullish" and later["close"] < bottom:
                gap["inverted"] = True
            elif gap["type"] == "bearish" and later["close"] > top:
                gap["inverted"] = True
        out.append(gap)
    return out


if __name__ == "__main__":  # pragma: no cover - manual smoke check
    import json

    demo_now = 1_700_000_000.0
    demo_bars = [
        {"time": demo_now - (60 - i) * 300, "open": 500 + i * 0.1,
         "high": 500 + i * 0.1 + 0.2, "low": 500 + i * 0.1 - 0.2,
         "close": 500 + i * 0.1, "volume": 1000}
        for i in range(60)
    ]
    session = session_levels(demo_bars, now=demo_now)
    closed_5m = _aggregate(_clean(demo_bars), 5, now=demo_now)
    print(json.dumps({
        "session": session,
        "reference_levels": reference_levels(session),
        "displacement": displacement(closed_5m),
        "fvgs": find_fvgs(closed_5m),
    }, indent=2))
