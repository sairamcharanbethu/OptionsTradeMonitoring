#!/usr/bin/env python3
"""Multi-day swing replay: the LIVE engine's entries, held under the live
9-10 DTE swing exit rules across sessions.

Entries come from the real ``signal_engine.build_signal`` replayed minute by
minute over the cached Unusual Whales sessions (same inputs as
``uw_backtest.py``: SPY/QQQ 1m bars with history, prior-session strike GEX
profile, 1m spot-gamma series). A single swing slot is enforced across days:
one open position at a time, one contract, one entry per setup.

Exits mirror the live swing stack (engine lifecycle + backend market poller):
  - underlying invalidation stop (gap-aware: a session that opens through the
    stop fills at the open), T1 ratchets the stop to the trigger, T2 exits;
  - engine T1 premium lock (+20% arms, back to +10% exits);
  - backend: 20% premium stop until the synthetic trail arms; the 15% trail
    arms at TP1 or once the premium peak prints +20% (profit-lock ladder:
    floor = entry, then +25% once the peak prints +50%);
  - exit-before-expiry at <= 2 DTE (first bar of that session);
  - max hold 7 days (10080 minutes from entry).

Honest limitations (read before trusting a number):
- NO REAL 9-10 DTE OPTION PRICES EXIST in uw_cache (harvest stopped at 6 DTE
  and the vendor subscription is gone). Option premiums are MODELED with
  Black-Scholes on the replayed spot, using one IV per session: the prior
  session's closing ATM IV from the longest cached expiry (3-6 DTE), else
  20-session realized vol. No skew, no intraday IV moves, no term premium.
  ``--calibrate`` measures this model's error against real cached 3-6 DTE
  candles. Treat option P&L as an estimate; the underlying (delta-one) P&L
  per trade is exact and is reported alongside it.
- Engine state is replayed per session (as in uw_backtest.py); multi-day
  management is done here by rule, not by carrying the engine lifecycle.
- Fills cross a modeled spread (buy ask, sell bid) unless --mid-fills.

Usage (from strategy-engine/; cache-only, no vendor token needed):
    python3 uw_swing_backtest.py --start 2026-04-14 --end 2026-08-21
    python3 uw_swing_backtest.py --calibrate --start 2026-04-14 --end 2026-08-21
"""
from __future__ import annotations

import argparse
import json
import math
import re
import statistics
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Callable

import signal_engine
import swing_exit_policy as _policy
import uw_backtest
from signal_engine import build_signal
from trade_prefetch_service import _preferred_option_expiry, _swing_window_max_dte
from uw_backtest import (
    ET, RISK_FREE_RATE, CacheMissError, UWClient, _num, _session_bounds,
    bs_delta, contract_symbols_for_expiry, derive_walls_and_flip, fetch_bars,
    fetch_bars_with_history, fetch_prior_strike_profile, fetch_spot_gamma_series,
    gex_snapshot, listed_expiries, modeled_spread, summarize, symbol_market,
)

# Exit rules come from the shared policy (shared/swing-exit-policy.json via
# swing_exit_policy.py) so the backtest cannot drift from live/paper code.
SWING_MIN_DTE = _policy.SWING_MIN_DTE
SWING_MAX_DTE = _policy.SWING_MAX_DTE
EXIT_BEFORE_EXPIRY_DTE = _policy.EXIT_BEFORE_EXPIRY_DTE
MAX_HOLD_MINUTES = _policy.MAX_HOLD_MINUTES
PREMIUM_STOP_PCT = _policy.PREMIUM_STOP_PCT
TRAIL_PCT = _policy.TRAIL_PCT
PROFIT_LOCK_TRIGGER_MULT = _policy.PROFIT_LOCK_TRIGGER_MULT
PROFIT_LOCK_RUNG2_MULT = _policy.PROFIT_LOCK_RUNG2_MULT
PROFIT_LOCK_RUNG2_FLOOR_MULT = _policy.PROFIT_LOCK_RUNG2_FLOOR_MULT
T1_LOCK_ARM_RETURN = _policy.T1_LOCK_ARM_PCT / 100
T1_LOCK_FLOOR_RETURN = _policy.T1_LOCK_FLOOR_PCT / 100
# Live default strategy_max_total_debit_dollars. A 9-10 DTE ATM SPY contract
# usually costs more than $5.00, so this cap can reject every entry.
LIVE_MAX_TOTAL_DEBIT = _policy.MAX_TOTAL_DEBIT_DOLLARS
MID_FILLS = False

_CONTRACT_FILE = re.compile(
    r"option-contract_SPY(\d{6})([CP])(\d{8})_intraday_date-(\d{4}-\d{2}-\d{2})\.json$"
)


# --- pricing ---------------------------------------------------------------

def _norm_cdf(x: float) -> float:
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def bs_price(spot: float, strike: float, minutes_to_expiry: float, iv: float, right: str) -> float:
    """Black-Scholes European premium (SPY options are American; for calls on
    a dividend-light index ETF and short tenors the difference is cents)."""
    if spot <= 0 or strike <= 0:
        return 0.0
    intrinsic = max(0.0, spot - strike) if right == "C" else max(0.0, strike - spot)
    if minutes_to_expiry <= 0 or not iv or iv <= 0:
        return intrinsic
    t = minutes_to_expiry / (365.0 * 24 * 60)
    vol_t = iv * math.sqrt(t)
    d1 = (math.log(spot / strike) + (RISK_FREE_RATE + iv * iv / 2) * t) / vol_t
    d2 = d1 - vol_t
    discount = math.exp(-RISK_FREE_RATE * t)
    if right == "C":
        return spot * _norm_cdf(d1) - strike * discount * _norm_cdf(d2)
    return strike * discount * _norm_cdf(-d2) - spot * _norm_cdf(-d1)


def expiry_close_epoch(expiry_iso: str) -> float:
    return datetime.strptime(expiry_iso, "%Y-%m-%d").replace(hour=16, minute=0, tzinfo=ET).timestamp()


def modeled_bid(strike: float, right: str, expiry_iso: str, spot: float, at: float, iv: float) -> float:
    mid = bs_price(spot, strike, (expiry_close_epoch(expiry_iso) - at) / 60, iv, right)
    if MID_FILLS:
        return max(0.01, mid)
    return max(0.01, mid - modeled_spread(mid) / 2)


def modeled_quote(entry: dict, sim_now: float, spot: float, iv: float) -> dict | None:
    """Engine-shaped option quote priced by the model (fresh, 1s old)."""
    minutes = (expiry_close_epoch(entry["expiry"]) - sim_now) / 60
    mid = bs_price(spot, entry["strike"], minutes, iv, entry["right"])
    if mid <= 0.01:
        return None
    half = modeled_spread(mid) / 2
    bid = max(0.01, round(mid - half, 2))
    ask = round(mid + half, 2)
    delta = bs_delta(spot, entry["strike"], max(1.0, minutes), iv, entry["right"])
    spread_pct = round((ask - bid) / mid * 100, 1)
    return {
        "local_symbol": entry["symbol"], "right": entry["right"], "strike": entry["strike"],
        "expiry": entry["expiry"], "bid": bid, "ask": ask, "mid": round(mid, 3),
        "spread_pct": spread_pct, "delta": round(delta, 3) if delta is not None else None,
        "gamma": None, "open_interest": None,
        # Modeled contracts have no prints; give the engine's volume gate a
        # nominal liquid value (near-ATM 9-10 DTE SPY trades thousands/day).
        "volume": 1000.0,
        "liquidity": "ok" if spread_pct <= 10 else "caution" if spread_pct <= 20 else "wide",
        "quote_time": sim_now - 1, "quote_age_seconds": 1.0,
    }


# --- implied vol per session --------------------------------------------------

class CacheIndex:
    """Which option-candle files exist per session date (cache-only world)."""

    def __init__(self, cache_dir: Path):
        self.by_date: dict[str, list[tuple[str, str, float, Path]]] = {}
        if not cache_dir.exists():
            return
        for path in cache_dir.iterdir():
            match = _CONTRACT_FILE.match(path.name)
            if not match:
                continue
            expiry = "20" + match.group(1)
            expiry_iso = f"{expiry[:4]}-{expiry[4:6]}-{expiry[6:]}"
            self.by_date.setdefault(match.group(4), []).append(
                (expiry_iso, match.group(2), int(match.group(3)) / 1000.0, path)
            )


def _candle_rows(path: Path) -> list[dict]:
    try:
        return json.loads(path.read_text()).get("data") or []
    except (OSError, ValueError):
        return []


def closing_atm_iv(index: CacheIndex, date: str, close_spot: float) -> float | None:
    """Median IV over the last 30 minutes of ``date`` for the two strikes
    nearest ``close_spot`` on the longest cached expiry with DTE >= 3."""
    files = index.by_date.get(date) or []
    session_day = datetime.strptime(date, "%Y-%m-%d").date()
    eligible = [
        row for row in files
        if (datetime.strptime(row[0], "%Y-%m-%d").date() - session_day).days >= 3
    ]
    if not eligible:
        return None
    longest = max(row[0] for row in eligible)
    chain = [row for row in eligible if row[0] == longest]
    strikes = sorted({row[2] for row in chain}, key=lambda strike: abs(strike - close_spot))[:2]
    _, close_at = _session_bounds(date)
    samples = []
    for _expiry, _right, strike, path in chain:
        if strike not in strikes:
            continue
        for row in _candle_rows(path):
            stamp = uw_backtest._iso_epoch(row["start_time"])
            if not (close_at - 30 * 60 <= stamp < close_at):
                continue
            high, low = _num(row.get("iv_high")), _num(row.get("iv_low"))
            if high and low and 0.03 < (high + low) / 2 < 3:
                samples.append((high + low) / 2)
    return statistics.median(samples) if len(samples) >= 3 else None


def realized_vol(client: UWClient, date: str, sessions: int = 20) -> float | None:
    """Annualized close-to-close vol of the ``sessions`` sessions before ``date``."""
    closes = []
    for prior in uw_backtest._prior_trading_dates(date, sessions + 1, span_days=(sessions + 1) * 3):
        try:
            bars = fetch_bars(client, "SPY", prior)
        except (CacheMissError, OSError):
            continue
        open_at, close_at = _session_bounds(prior)
        session = [bar for bar in bars if open_at <= bar["time"] < close_at]
        if session:
            closes.append(session[-1]["close"])
    if len(closes) < 10:
        return None
    returns = [math.log(closes[i] / closes[i + 1]) for i in range(len(closes) - 1)]
    return statistics.stdev(returns) * math.sqrt(252)


class SessionIV:
    """IV used to price day ``date``: the PRIOR session's closing ATM IV (known
    at the open, no look-ahead), else 20-session realized vol, else 15%."""

    def __init__(self, client: UWClient, index: CacheIndex):
        self.client = client
        self.index = index
        self.cache: dict[str, tuple[float, str]] = {}

    def __call__(self, date: str) -> float:
        return self.lookup(date)[0]

    def lookup(self, date: str) -> tuple[float, str]:
        if date in self.cache:
            return self.cache[date]
        result: tuple[float, str] | None = None
        for prior in uw_backtest._prior_trading_dates(date, 3):
            try:
                bars = fetch_bars(self.client, "SPY", prior)
            except (CacheMissError, OSError):
                continue
            open_at, close_at = _session_bounds(prior)
            session = [bar for bar in bars if open_at <= bar["time"] < close_at]
            if not session:
                continue
            iv = closing_atm_iv(self.index, prior, session[-1]["close"])
            if iv is not None:
                result = (iv, "prior_close_atm_iv")
            break
        if result is None:
            rv = realized_vol(self.client, date)
            result = (rv, "realized_vol_20d") if rv else (0.15, "default_15pct")
        self.cache[date] = result
        return result


# --- entries ------------------------------------------------------------------

def swing_expiry(expiries: list[str], open_at: float) -> tuple[str | None, str, int]:
    """Live strict 9-10 DTE selection (Thursday rolls to the Monday expiry)."""
    max_dte = _swing_window_max_dte(SWING_MIN_DTE, SWING_MAX_DTE, open_at) or SWING_MAX_DTE
    expiry, mode = _preferred_option_expiry(
        expiries, now=open_at, min_dte=SWING_MIN_DTE, max_dte=SWING_MAX_DTE, strict=True,
    )
    return expiry, mode, int(max_dte)


def collect_day_candidates(client: UWClient, date: str, iv_for: Callable[[str], float],
                           interval: int = 60, max_total_debit: float = LIVE_MAX_TOTAL_DEBIT) -> dict:
    """Replay one session through the live engine on a modeled 9-10 DTE chain
    and return every minute the engine would allow a swing entry."""
    open_at, close_at = _session_bounds(date)
    entry_cutoff = close_at - 60 * 60  # live autonomousEntryWindow
    spy_bars = fetch_bars_with_history(client, "SPY", date)
    qqq_bars = fetch_bars_with_history(client, "QQQ", date)
    session_spy = [bar for bar in spy_bars if open_at <= bar["time"] < close_at]
    if len(session_spy) < 30:
        return {"date": date, "skipped": f"only {len(session_spy)} session bars"}
    expiry, expiry_mode, max_dte = swing_expiry(listed_expiries(client, date), open_at)
    if expiry is None:
        return {"date": date, "skipped": "no listed expiry in the 9-10 DTE window"}
    gamma_series = fetch_spot_gamma_series(client, date)
    profile = fetch_prior_strike_profile(client, date)
    open_spot = session_spy[0]["open"]
    flip, call_wall, put_wall = derive_walls_and_flip(profile, open_spot)
    width = max(6.0, round(open_spot * 0.012, 2))
    chain_meta = contract_symbols_for_expiry(client, date, expiry, open_spot, width)
    iv = iv_for(date)

    candidates: list[dict] = []
    blockers: dict[str, int] = {}
    gamma_index = 0
    previous = None
    real_time = time.time
    try:
        for sim_minute in range(int(open_at) + 120, int(entry_cutoff), interval):
            sim_now = float(sim_minute) + 5.0
            time.time = lambda now=sim_now: now
            spy = symbol_market(spy_bars, sim_now)
            qqq = symbol_market(qqq_bars, sim_now)
            if spy["spot"] is None:
                continue
            while gamma_index + 1 < len(gamma_series) and gamma_series[gamma_index + 1][0] <= sim_now:
                gamma_index += 1
            net_gamma = gamma_series[gamma_index][1] if gamma_series and gamma_series[gamma_index][0] <= sim_now else None
            gex = gex_snapshot(sim_now, spy["spot"], net_gamma, flip, call_wall, put_wall)
            chain = [quote for entry in chain_meta
                     if (quote := modeled_quote(entry, sim_now, spy["spot"], iv))]
            options = {"generated_at": sim_now, "source": "UW_SWING_MODEL", "underlying": "SPY",
                       "expiry": chain_meta[0]["expiry"] if chain_meta else None,
                       "expiry_mode": expiry_mode, "min_dte": SWING_MIN_DTE, "max_dte": max_dte,
                       "contracts": chain}
            market = {"generated_at": sim_now, "source": "UW_BACKTEST", "data_type": "historical",
                      "transport": {"connected": True}, "symbols": {"SPY": spy, "QQQ": qqq}}
            indicators = {"SPY": signal_engine.calculate_indicators(spy["bars"]),
                          "QQQ": signal_engine.calculate_indicators(qqq["bars"])}
            market["market_data_readiness"] = signal_engine.market_data_readiness(
                market, indicators, now=sim_now, stale_after=120)
            signal = build_signal(
                market, indicators, options, gex, 120,
                previous_signal=previous, zerogex=None, zerogex_role="shadow",
                option_max_total_debit_dollars=max_total_debit, option_preferred_contracts=1,
                max_tracking_gap_seconds=max(180.0, interval * 3.0),
            )
            previous = signal
            for blocker in signal.get("blockers") or []:
                key = str(blocker)[:70]
                blockers[key] = blockers.get(key, 0) + 1
            lifecycle = signal.get("lifecycle") or {}
            if str(signal.get("state") or "").upper() != "ACTIVE" or lifecycle.get("entry_allowed") is not True:
                continue
            setup = signal.get("put_setup") if signal.get("favoring") == "puts" else signal.get("call_setup")
            option = (setup or {}).get("option") or {}
            if not option.get("local_symbol") or not _num(option.get("ask")):
                continue
            trigger = _num((setup or {}).get("trigger"))
            stop = _num((setup or {}).get("invalidation")) or _num((setup or {}).get("stop"))
            targets = [float(t) for t in ((setup or {}).get("targets") or []) if _num(t) is not None][:3]
            if trigger is None or stop is None or not targets:
                continue
            candidates.append({
                "date": date, "lane": "swing", "strategy": signal.get("strategy"),
                "confidence": _num(signal.get("confidence_score")),
                "side": "PUT" if signal.get("favoring") == "puts" else "CALL",
                "entry_time": sim_now,
                "entry_et": datetime.fromtimestamp(sim_now, ET).strftime("%H:%M"),
                "entry_spot": float(spy["spot"]),
                "contract": option["local_symbol"], "right": option.get("right"),
                "strike": float(option["strike"]), "expiry": option["expiry"],
                "entry_price": float(option["mid"] if MID_FILLS else option["ask"]),
                "entry_delta": _num(option.get("delta")),
                "entry_iv": iv, "contracts": 1,
                "trigger": trigger, "stop": stop, "targets": targets,
                "setup_key": f"{date}|{signal.get('strategy')}|{signal.get('favoring')}|{trigger}",
            })
    finally:
        time.time = real_time
    return {"date": date, "candidates": candidates, "blockers": blockers}


# --- multi-day exit -------------------------------------------------------------

def _profit_lock_floor(entry: float, peak: float) -> float:
    if entry <= 0 or peak <= 0:
        return 0.0
    if peak >= entry * PROFIT_LOCK_RUNG2_MULT:
        return entry * PROFIT_LOCK_RUNG2_FLOOR_MULT
    if peak >= entry * PROFIT_LOCK_TRIGGER_MULT:
        return entry
    return 0.0


def _dte(expiry_iso: str, date: str) -> int:
    return (datetime.strptime(expiry_iso, "%Y-%m-%d").date() - datetime.strptime(date, "%Y-%m-%d").date()).days


def simulate_swing_exit(trade: dict, session_bars: Callable[[str], list[dict] | None],
                        iv_for: Callable[[str], float], last_date: str) -> dict:
    """Hold ``trade`` across sessions under the live swing exit stack.

    ``session_bars(date)`` returns that session's regular-hours 1m bars (None
    when the session is not in the data); ``last_date`` bounds the walk — a
    position still open at the end of the data is UNRESOLVED (pnl None).
    """
    side_call = trade["side"] == "CALL"
    entry = float(trade["entry_price"])
    stop = float(trade["stop"])
    t1, t2 = trade["targets"][0], (trade["targets"][1] if len(trade["targets"]) > 1 else None)
    right, strike, expiry = ("C" if side_call else "P"), trade["strike"], trade["expiry"]
    entry_minute = int(trade["entry_time"] // 60) * 60
    t1_hit = trail_armed = False
    peak = entry
    max_bid_return = None
    exit_reason = exit_time = exit_spot = exit_date = None
    cursor = datetime.strptime(trade["date"], "%Y-%m-%d")
    end = datetime.strptime(last_date, "%Y-%m-%d")
    sessions_held = 0

    def adverse(bar: dict) -> bool:
        return bar["low"] <= stop if side_call else bar["high"] >= stop

    def touched(bar: dict, level: float | None) -> bool:
        if level is None:
            return False
        return bar["high"] >= level if side_call else bar["low"] <= level

    while cursor <= end and exit_reason is None:
        date = cursor.strftime("%Y-%m-%d")
        cursor += timedelta(days=1)
        if datetime.strptime(date, "%Y-%m-%d").weekday() >= 5:
            continue
        bars = session_bars(date)
        if not bars:
            continue
        sessions_held += 1
        iv = iv_for(date)
        first_bar = True
        for bar in bars:
            if bar["time"] <= entry_minute:
                continue
            at = bar["time"]
            session_first_bar = first_bar
            if first_bar and date != trade["date"] and _dte(expiry, date) <= EXIT_BEFORE_EXPIRY_DTE:
                exit_reason, exit_time, exit_spot, exit_date = "EXPIRY_EXIT", at + 60, bar["open"], date
                break
            first_bar = False
            if at - entry_minute >= MAX_HOLD_MINUTES * 60:
                exit_reason, exit_time, exit_spot, exit_date = "MAX_HOLD", at + 60, bar["open"], date
                break
            if adverse(bar):
                # A bar that opens through the stop fills at its open (worse
                # than the stop); only a session's first bar is an overnight gap.
                opened_through = (bar["open"] <= stop) if side_call else (bar["open"] >= stop)
                fill_spot = bar["open"] if opened_through else stop
                overnight_gap = opened_through and session_first_bar and date != trade["date"]
                if t1_hit:
                    reason = "T1_TRAIL_STOP"
                else:
                    reason = "GAP_STOP" if overnight_gap else "STOP"
                exit_reason, exit_time, exit_spot, exit_date = reason, at + 60, fill_spot, date
                break
            if touched(bar, t1) and not t1_hit:
                t1_hit = True
                trail_armed = True
                stop = float(trade["trigger"])  # engine: T1 moves protection to the trigger
            if touched(bar, t2):
                exit_reason, exit_time, exit_spot, exit_date = "TARGET_2", at + 60, t2, date
                break
            bid = modeled_bid(strike, right, expiry, bar["close"], at + 60, iv)
            peak = max(peak, bid)
            lock_floor = _profit_lock_floor(entry, peak)
            if lock_floor > 0:
                trail_armed = True
            if t1_hit:
                ret = bid / entry - 1
                max_bid_return = ret if max_bid_return is None else max(max_bid_return, ret)
                if max_bid_return >= T1_LOCK_ARM_RETURN and ret <= T1_LOCK_FLOOR_RETURN:
                    exit_reason, exit_time, exit_spot, exit_date = "T1_PREMIUM_LOCK", at + 60, bar["close"], date
                    break
            if trail_armed:
                floor = lock_floor if lock_floor > 0 else entry
                if bid <= max(peak * (1 - TRAIL_PCT / 100), floor):
                    exit_reason, exit_time, exit_spot, exit_date = "TRAIL_STOP", at + 60, bar["close"], date
                    break
            elif bid <= entry * (1 - PREMIUM_STOP_PCT / 100):
                exit_reason, exit_time, exit_spot, exit_date = "PREMIUM_STOP", at + 60, bar["close"], date
                break
    if exit_reason is None:
        return {**trade, "exit_reason": "UNRESOLVED", "pnl": None, "sessions_held": sessions_held}
    exit_bid = modeled_bid(strike, right, expiry, exit_spot, exit_time, iv_for(exit_date))
    direction = 1 if side_call else -1
    underlying_points = round((exit_spot - trade["entry_spot"]) * direction, 2)
    return {
        **trade,
        "exit_reason": exit_reason, "exit_time": exit_time, "exit_date": exit_date,
        "exit_spot": round(exit_spot, 2), "exit_price": round(exit_bid, 2),
        "pnl": round((exit_bid - entry) * 100 * trade["contracts"], 2),
        "underlying_points": underlying_points,
        "hold_hours": round((exit_time - trade["entry_time"]) / 3600, 1),
        "sessions_held": sessions_held, "t1_hit": t1_hit,
        "peak_bid": round(peak, 2),
    }


def execute_swing(candidates: list[dict], session_bars: Callable[[str], list[dict] | None],
                  iv_for: Callable[[str], float], last_date: str) -> list[dict]:
    """Single swing slot across days: take the first candidate after the slot
    frees, at most one entry per setup."""
    trades: list[dict] = []
    free_at = 0.0
    taken: set[str] = set()
    for candidate in sorted(candidates, key=lambda row: row["entry_time"]):
        if candidate["entry_time"] < free_at or candidate["setup_key"] in taken:
            continue
        taken.add(candidate["setup_key"])
        result = simulate_swing_exit(candidate, session_bars, iv_for, last_date)
        trades.append(result)
        if result.get("exit_time") is None:
            break  # open at the end of the data: the slot never frees
        free_at = float(result["exit_time"])
    return trades


# --- model calibration ----------------------------------------------------------

def calibrate(client: UWClient, index: CacheIndex, iv_lookup: SessionIV, dates: list[str]) -> dict:
    """Model error against REAL cached candles for the longest cached expiry
    (3-6 DTE) near the money, sampled every 30 minutes."""
    level_errors, return_errors = [], []
    for date in dates:
        files = [row for row in index.by_date.get(date) or []
                 if _dte(row[0], date) >= 3]
        if not files:
            continue
        try:
            bars = fetch_bars(client, "SPY", date)
        except CacheMissError:
            continue
        open_at, close_at = _session_bounds(date)
        spot_at = {bar["time"]: bar["close"] for bar in bars if open_at <= bar["time"] < close_at}
        if not spot_at:
            continue
        iv = iv_lookup(date)
        open_spot = spot_at[min(spot_at)]
        longest = max(row[0] for row in files)
        for expiry_iso, right, strike, path in files:
            if expiry_iso != longest or abs(strike - open_spot) > 2.5:
                continue
            candles = {uw_backtest._iso_epoch(row["start_time"]): float(row["close"])
                       for row in _candle_rows(path) if _num(row.get("close"))}
            samples = []
            for minute in range(int(open_at) + 30 * 60, int(close_at), 30 * 60):
                actual, spot = candles.get(float(minute)), spot_at.get(float(minute))
                if actual and spot and actual > 0.2:
                    model = bs_price(spot, strike, (expiry_close_epoch(expiry_iso) - minute - 60) / 60, iv, right)
                    samples.append((actual, model))
                    level_errors.append((model - actual) / actual)
            if len(samples) >= 2:
                (a0, m0), (a1, m1) = samples[0], samples[-1]
                return_errors.append((m1 / m0 - 1) - (a1 / a0 - 1))
    # Close-to-next-session-close returns on contracts cached on consecutive
    # sessions: the horizon a swing hold actually experiences (theta and the
    # overnight gap included), unlike the intraday window above.
    overnight_errors = []
    by_contract: dict[tuple[str, str, float], dict[str, Path]] = {}
    for date in dates:
        for expiry_iso, right, strike, path in index.by_date.get(date) or []:
            by_contract.setdefault((expiry_iso, right, strike), {})[date] = path
    for (expiry_iso, right, strike), paths in by_contract.items():
        ordered = sorted(paths)
        for day_a, day_b in zip(ordered, ordered[1:]):
            if (datetime.strptime(day_b, "%Y-%m-%d") - datetime.strptime(day_a, "%Y-%m-%d")).days > 4:
                continue
            if _dte(expiry_iso, day_b) < 2:
                continue
            marks = []
            for day in (day_a, day_b):
                _, close_at = _session_bounds(day)
                minute = close_at - 30 * 60
                candles = {uw_backtest._iso_epoch(row["start_time"]): float(row["close"])
                           for row in _candle_rows(paths[day]) if _num(row.get("close"))}
                try:
                    bars = {bar["time"]: bar["close"] for bar in fetch_bars(client, "SPY", day)}
                except CacheMissError:
                    bars = {}
                actual = next((candles[minute - k * 60] for k in range(10) if candles.get(minute - k * 60)), None)
                spot = bars.get(minute)
                if not actual or not spot or actual <= 0.2 or abs(strike - spot) > 2.5:
                    marks = []
                    break
                marks.append((actual, bs_price(spot, strike, (expiry_close_epoch(expiry_iso) - minute - 60) / 60,
                                                 iv_lookup(day), right)))
            if len(marks) == 2:
                (a0, m0), (a1, m1) = marks
                overnight_errors.append((m1 / m0 - 1) - (a1 / a0 - 1))

    def stats(values: list[float]) -> dict:
        if not values:
            return {"n": 0}
        return {"n": len(values), "median_pct": round(100 * statistics.median(values), 1),
                "median_abs_pct": round(100 * statistics.median(abs(v) for v in values), 1)}
    return {"premium_level_error": stats(level_errors), "intraday_return_error": stats(return_errors),
            "close_to_next_close_return_error": stats(overnight_errors)}


# --- reporting -----------------------------------------------------------------

def report_underlying(trades: list[dict]) -> None:
    resolved = [trade for trade in trades if trade.get("underlying_points") is not None]
    if not resolved:
        return
    points = [trade["underlying_points"] for trade in resolved]
    mean = statistics.mean(points)
    se = statistics.stdev(points) / math.sqrt(len(points)) if len(points) > 1 else 0.0
    wins = sum(1 for p in points if p > 0)
    gross_win = sum(p for p in points if p > 0)
    gross_loss = -sum(p for p in points if p < 0)
    print(f"underlying (exact, delta-one): {wins}/{len(points)} green, mean {mean:+.2f} pts/trade "
          f"± {se:.2f} SE, PF {gross_win / gross_loss if gross_loss else float('inf'):.2f}")
    holds = [trade["hold_hours"] for trade in resolved]
    print(f"hold: median {statistics.median(holds):.1f}h, max {max(holds):.1f}h; "
          f"sessions held median {statistics.median(t['sessions_held'] for t in resolved):.0f}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--date")
    parser.add_argument("--start")
    parser.add_argument("--end")
    parser.add_argument("--interval", type=int, default=60)
    parser.add_argument("--max-total-debit", type=float, default=LIVE_MAX_TOTAL_DEBIT,
                        help=f"engine total-debit cap per trade (live default ${LIVE_MAX_TOTAL_DEBIT:g})")
    parser.add_argument("--mid-fills", action="store_true")
    parser.add_argument("--calibrate", action="store_true",
                        help="measure the option model against real cached 3-6 DTE candles and exit")
    parser.add_argument("--trades-out", help="write every swing trade to this .jsonl path")
    args = parser.parse_args()
    if args.mid_fills:
        globals()["MID_FILLS"] = True
    uw_backtest.CACHE_ONLY = True  # the vendor subscription is gone; replay is cache-only

    if args.date:
        dates = [args.date]
    elif args.start and args.end:
        cursor, end = datetime.strptime(args.start, "%Y-%m-%d"), datetime.strptime(args.end, "%Y-%m-%d")
        dates = []
        while cursor <= end:
            if cursor.weekday() < 5:
                dates.append(cursor.strftime("%Y-%m-%d"))
            cursor += timedelta(days=1)
    else:
        raise SystemExit("pass --date or --start/--end")

    client = UWClient("cache-only")
    index = CacheIndex(uw_backtest.CACHE_DIR)
    iv_lookup = SessionIV(client, index)
    if args.calibrate:
        print(json.dumps(calibrate(client, index, iv_lookup, dates), indent=2))
        return

    bars_memo: dict[str, list[dict] | None] = {}

    def session_bars(date: str) -> list[dict] | None:
        if date not in bars_memo:
            try:
                bars = fetch_bars(client, "SPY", date)
            except CacheMissError:
                bars = []
            open_at, close_at = _session_bounds(date)
            bars_memo[date] = [bar for bar in bars if open_at <= bar["time"] < close_at] or None
        return bars_memo[date]

    candidates: list[dict] = []
    blockers: dict[str, int] = {}
    for date in dates:
        print(f"=== {date} ===", flush=True)
        try:
            result = collect_day_candidates(client, date, iv_lookup, args.interval, args.max_total_debit)
        except Exception as exc:  # one bad session must not end the run
            print(f"  FAILED: {exc}")
            continue
        if result.get("skipped"):
            print(f"  skipped: {result['skipped']}")
            continue
        candidates.extend(result["candidates"])
        for key, count in result["blockers"].items():
            blockers[key] = blockers.get(key, 0) + count
        print(f"  {len(result['candidates'])} entry-eligible minutes, IV {iv_lookup.lookup(date)[1]} "
              f"{iv_lookup(date):.3f}")

    trades = execute_swing(candidates, session_bars, iv_lookup, dates[-1])
    for trade in trades:
        print(f"  {trade['date']} {trade['entry_et']} {trade['strategy']} {trade['side']} {trade['contract']} "
              f"in ${trade['entry_price']:.2f} -> {trade['exit_reason']} {trade.get('exit_date')} "
              f"${trade.get('exit_price') or 0:.2f}  P&L ${trade.get('pnl')}  "
              f"underlying {trade.get('underlying_points')} pts  {trade.get('hold_hours')}h")
    summarize(trades, label="swing (modeled premium)")
    report_underlying(trades)
    sources: dict[str, int] = {}
    for date in dates:
        if date in iv_lookup.cache:
            sources[iv_lookup.cache[date][1]] = sources.get(iv_lookup.cache[date][1], 0) + 1
    print(f"IV sources by session: {sources}")
    debit_blocks = sum(count for key, count in blockers.items() if "total-debit budget" in key)
    print(f"engine minutes blocked by the ${args.max_total_debit:g} debit cap: {debit_blocks}")
    print("top blockers:")
    for key, count in sorted(blockers.items(), key=lambda item: -item[1])[:8]:
        print(f"  x{count}: {key}")
    if args.trades_out:
        out = Path(args.trades_out)
        out.parent.mkdir(parents=True, exist_ok=True)
        with out.open("w") as handle:
            for trade in trades:
                handle.write(json.dumps(trade) + "\n")
        print(f"wrote {len(trades)} trades to {out}")


if __name__ == "__main__":
    main()
