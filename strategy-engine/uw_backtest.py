#!/usr/bin/env python3
"""Out-of-sample backtest driver: Unusual Whales history -> the LIVE engine.

Reconstructs the engine's input contract (SPY/QQQ 1m bars, GEX snapshot,
0DTE option chain quotes) for a historical session from the Unusual Whales
API, then replays the day minute-by-minute through the real
signal_engine.build_signal with a simulated clock. No gate, threshold, or
setup logic is re-implemented — the engine that trades live makes every call.

Usage (from strategy-engine/, UW_TOKEN in env or ../.env):
    python3 uw_backtest.py --date 2026-08-20
    python3 uw_backtest.py --start 2026-06-01 --end 2026-08-20 --summary-only

Honest limitations (documented, not hidden):
- GEX comes from UW's dealer model (daily strike profile for walls/flip +
  1m spot net-gamma series), not ZeroGEX/local-IBKR — regimes can differ.
- ZeroGEX decision context is absent, so its two live blockers cannot fire:
  results are slightly MORE permissive than live.
- Option quotes are trade-candle mids with a modeled spread (UW has no
  historical NBBO); fills cross that modeled spread (buy ask, sell bid).
- Spot at each step is the current minute's OPEN (no intraminute lookahead);
  intrabar stop/target sequencing is resolved conservatively (stop first).
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import signal_engine
from signal_engine import build_signal
# The exact per-lane family policy and wall-expiry selection the live loop
# uses — never approximate them.
from trade_prefetch_service import _strategy_family_policy_for_lane, _wall_option_expiry

ET = ZoneInfo("America/New_York")
API_BASE = "https://api.unusualwhales.com/api"
CACHE_DIR = Path(os.environ.get("UW_CACHE_DIR", "uw_cache"))
THROTTLE_SECONDS = 0.45
STRATEGY_LANES = ("mtf", "orb_index", "vwap_trend")
RISK_FREE_RATE = 0.04

_REAL_MONOTONIC = time.monotonic
_last_request_at = [0.0]


def _load_token() -> str:
    token = os.environ.get("UW_TOKEN") or os.environ.get("UW_API_TOKEN")
    if not token:
        for env_path in (Path("../.env"), Path(".env")):
            if env_path.exists():
                for line in env_path.read_text().splitlines():
                    if line.startswith("UW_TOKEN=") or line.startswith("UW_API_TOKEN="):
                        token = line.split("=", 1)[1].strip()
                        break
            if token:
                break
    if not token:
        raise SystemExit("UW_TOKEN not found in environment or .env")
    return token


class UWClient:
    def __init__(self, token: str):
        self.token = token

    def get(self, path: str, params: dict | None = None) -> dict:
        query = urllib.parse.urlencode(params or {})
        slug = (path + ("_" + query if query else "")).replace("/", "_").replace("?", "_").replace("&", "_").replace("=", "-")
        cache_file = CACHE_DIR / f"{slug}.json"
        if cache_file.exists():
            return json.loads(cache_file.read_text())
        wait = THROTTLE_SECONDS - (_REAL_MONOTONIC() - _last_request_at[0])
        if wait > 0:
            time.sleep(wait)
        url = f"{API_BASE}/{path}" + (f"?{query}" if query else "")
        request = urllib.request.Request(url, headers={
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/json",
        })
        _last_request_at[0] = _REAL_MONOTONIC()
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.loads(response.read().decode())
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        cache_file.write_text(json.dumps(payload))
        return payload


def _num(value) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _iso_epoch(value: str) -> float:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def _session_bounds(date: str) -> tuple[float, float]:
    day = datetime.strptime(date, "%Y-%m-%d").replace(tzinfo=ET)
    open_at = day.replace(hour=9, minute=30).timestamp()
    close_at = day.replace(hour=16, minute=0).timestamp()
    return open_at, close_at


def fetch_bars(client: UWClient, symbol: str, date: str) -> list[dict]:
    payload = client.get(f"stock/{symbol}/ohlc/1m", {"date": date, "limit": 1500})
    bars = []
    for row in payload.get("data") or []:
        stamp = _iso_epoch(row["start_time"])
        bars.append({
            "time": stamp,
            "open": float(row["open"]),
            "high": float(row["high"]),
            "low": float(row["low"]),
            "close": float(row["close"]),
            "volume": float(row.get("volume") or 0),
        })
    bars.sort(key=lambda bar: bar["time"])
    return bars


def fetch_spot_gamma_series(client: UWClient, date: str) -> list[tuple[float, float, float]]:
    """[(minute_epoch, net_gamma_oi, price)] ascending."""
    payload = client.get("stock/SPY/spot-exposures", {"date": date})
    series = []
    for row in payload.get("data") or []:
        stamp = _iso_epoch(row.get("start_time") or row["time"])
        gamma = _num(row.get("gamma_per_one_percent_move_oi"))
        price = _num(row.get("price"))
        if gamma is None:
            continue
        series.append((stamp, gamma, price if price is not None else 0.0))
    series.sort(key=lambda item: item[0])
    return series


def fetch_strike_profile(client: UWClient, date: str) -> list[dict]:
    payload = client.get("stock/SPY/greek-exposure/strike", {"date": date})
    profile = []
    for row in payload.get("data") or []:
        strike = _num(row.get("strike"))
        call_gex = _num(row.get("call_gex")) or 0.0
        put_gex = _num(row.get("put_gex")) or 0.0
        if strike is None:
            continue
        profile.append({"strike": strike, "call_gex": call_gex, "put_gex": put_gex,
                        "net_gex": call_gex + put_gex})
    profile.sort(key=lambda row: row["strike"])
    return profile


def derive_walls_and_flip(profile: list[dict], spot: float) -> tuple[float | None, float | None, float | None]:
    """(flip, call_wall, put_wall) from the daily strike GEX profile."""
    near = [row for row in profile if spot * 0.9 <= row["strike"] <= spot * 1.1] or profile
    call_wall = max(near, key=lambda row: row["call_gex"], default=None)
    put_wall = min(near, key=lambda row: row["put_gex"], default=None)
    flip = None
    cumulative = 0.0
    previous_strike = None
    running = []
    for row in near:
        cumulative += row["net_gex"]
        running.append((row["strike"], cumulative))
    for index in range(1, len(running)):
        prior_strike, prior_sum = running[index - 1]
        strike, total = running[index]
        if prior_sum <= 0 <= total or prior_sum >= 0 >= total:
            candidate = (prior_strike + strike) / 2
            if flip is None or abs(candidate - spot) < abs(flip - spot):
                flip = candidate
        previous_strike = strike
    return (
        flip,
        call_wall["strike"] if call_wall and call_wall["call_gex"] > 0 else None,
        put_wall["strike"] if put_wall and put_wall["put_gex"] < 0 else None,
    )


def fetch_option_candles(client: UWClient, contract: str, date: str) -> dict[float, dict]:
    """minute_epoch -> candle for one option contract."""
    payload = client.get(f"option-contract/{contract}/intraday", {"date": date})
    candles = {}
    for row in payload.get("data") or []:
        stamp = _iso_epoch(row["start_time"])
        volume = sum(
            _num(row.get(field)) or 0
            for field in ("volume_ask_side", "volume_bid_side", "volume_mid_side", "volume_no_side")
        )
        iv = _num(row.get("iv_high"))
        iv_low = _num(row.get("iv_low"))
        if iv is not None and iv_low is not None:
            iv = (iv + iv_low) / 2
        candles[stamp] = {"close": float(row["close"]), "volume": volume, "iv": iv}
    return candles


def bs_delta(spot: float, strike: float, minutes_to_expiry: float, iv: float | None, right: str) -> float | None:
    if not iv or iv <= 0 or minutes_to_expiry <= 0 or spot <= 0 or strike <= 0:
        return None
    t = minutes_to_expiry / (365.0 * 24 * 60)
    d1 = (math.log(spot / strike) + (RISK_FREE_RATE + iv * iv / 2) * t) / (iv * math.sqrt(t))
    cdf = 0.5 * (1 + math.erf(d1 / math.sqrt(2)))
    return cdf if right == "C" else cdf - 1


def modeled_spread(mid: float) -> float:
    # SPY 0DTE near-ATM spreads are tight ($0.01-0.03); scale gently with
    # premium and floor at a cent. Deliberately a touch pessimistic.
    return max(0.01, round(0.006 * mid + 0.01, 3))


def listed_expiries(client: UWClient, date: str) -> list[str]:
    """All expiries (YYYYMMDD) tradable on `date`, ascending."""
    payload = client.get("stock/SPY/option-chains", {"date": date})
    tags = set()
    for symbol in payload.get("data") or []:
        if symbol.startswith("SPY") and len(symbol) >= 15:
            tags.add("20" + symbol[3:9])
    return sorted(tags)


def contract_symbols_for_expiry(client: UWClient, date: str, expiry_yyyymmdd: str,
                                spot: float, width: float) -> list[dict]:
    payload = client.get("stock/SPY/option-chains", {"date": date})
    expiry_tag = expiry_yyyymmdd[2:]
    expiry_iso = f"{expiry_yyyymmdd[:4]}-{expiry_yyyymmdd[4:6]}-{expiry_yyyymmdd[6:]}"
    picked = []
    for symbol in payload.get("data") or []:
        if not symbol.startswith(f"SPY{expiry_tag}"):
            continue
        right = symbol[9]
        strike = int(symbol[10:]) / 1000.0
        if abs(strike - spot) <= width:
            picked.append({"symbol": symbol, "right": right, "strike": strike,
                           "expiry": expiry_iso, "expiry_yyyymmdd": expiry_yyyymmdd})
    picked.sort(key=lambda row: (row["strike"], row["right"]))
    return picked


def build_option_contract(entry: dict, candles: dict[float, dict], sim_now: float,
                          spot: float) -> dict | None:
    minute = int(sim_now // 60) * 60
    candle = None
    for lookback in range(0, 4):
        candle = candles.get(minute - lookback * 60)
        if candle:
            break
    if not candle or candle["close"] <= 0:
        return None
    mid = candle["close"]
    half = modeled_spread(mid) / 2
    bid = max(0.01, round(mid - half, 2))
    ask = round(mid + half, 2)
    spread_pct = round((ask - bid) / mid * 100, 1)
    expiry_close = datetime.strptime(entry["expiry"], "%Y-%m-%d").replace(
        hour=16, minute=0, tzinfo=ET).timestamp()
    delta = bs_delta(spot, entry["strike"], max(1.0, (expiry_close - sim_now) / 60), candle["iv"], entry["right"])
    if delta is None:
        # Moneyness fallback keeps the contract judgeable when a candle has no IV.
        moneyness = (spot - entry["strike"]) / max(spot * 0.01, 0.01)
        approx = 0.5 + 0.15 * moneyness
        delta = max(0.02, min(0.98, approx))
        if entry["right"] == "P":
            delta = delta - 1
    return {
        "local_symbol": entry["symbol"],
        "right": entry["right"],
        "strike": entry["strike"],
        "expiry": entry["expiry"],
        "bid": bid,
        "ask": ask,
        "mid": round(mid, 3),
        "spread_pct": spread_pct,
        "delta": round(delta, 3),
        "gamma": None,
        "open_interest": None,
        "volume": candle["volume"],
        "liquidity": "ok" if spread_pct <= 10 else "caution" if spread_pct <= 20 else "wide",
        "quote_time": sim_now - 1,
        "quote_age_seconds": 1.0,
    }


def gex_snapshot(sim_now: float, spot: float, net_gamma: float | None,
                 flip: float | None, call_wall: float | None, put_wall: float | None) -> dict:
    positive = net_gamma is not None and net_gamma >= 0
    spy = {
        "spot": spot,
        "served_expiry": None,
        "regime": "Positive" if positive else "Negative",
        "gamma_regime": "Range" if positive else "Trend",
        "pattern": "UW_BACKTEST",
        "rolling": "UW_BACKTEST",
        "flip": flip,
        "call_wall": {"strike": call_wall, "stage": "External", "taps": 0} if call_wall else None,
        "put_wall": {"strike": put_wall, "stage": "External", "taps": 0} if put_wall else None,
        "net_gex": net_gamma,
        "put_call_ratio": None,
        "max_pain": None,
        "flip_distance": round(spot - flip, 2) if flip is not None else None,
        "local_gex": None,
        "convexity_risk": None,
        "provider_timestamp": sim_now,
        "provider_age_seconds": 0.0,
    }
    if net_gamma is None:
        spy["error"] = "UW spot gamma series has no value at this minute"
    return {
        "fetched_at": sim_now,
        "source": "uw_backtest",
        "selected_source": "uw_backtest",
        "model": {"method": "uw_daily_strike_profile_plus_spot_series",
                  "dealer_position_inferred": True},
        "data": {"SPY": spy},
    }


def symbol_market(bars: list[dict], sim_now: float) -> dict:
    minute = int(sim_now // 60) * 60
    completed = [bar for bar in bars if bar["time"] < minute]
    current = next((bar for bar in bars if bar["time"] == minute), None)
    spot = current["open"] if current else (completed[-1]["close"] if completed else None)
    # Mimic keepUpToDate: a forming bar for the current minute, seeded from its
    # open only (no intraminute lookahead).
    feed = list(completed)
    if current and spot is not None:
        feed.append({"time": minute, "open": current["open"], "high": current["open"],
                     "low": current["open"], "close": current["open"], "volume": 0.0})
    return {
        "spot": spot,
        "bid": spot,
        "ask": spot,
        "last": spot,
        "quote_time": sim_now - 1,
        "quote_age_seconds": 1.0,
        "bars": feed,
    }


def simulate_exit(trade: dict, spy_bars: list[dict], option_candles: dict[float, dict],
                  close_at: float, flatten_at: float) -> dict:
    """Walk forward on 1m bars: stop / premium stop / T1 (stop-to-trigger) /
    T2 / flatten.

    Conservative intrabar rule: if a bar spans both stop and target, the stop
    fills first. The premium stop mirrors the live exit stack (35% for the
    ORB/VWAP families, 20% otherwise) and is checked on each minute's option
    candle close — without it, a 0DTE option can "ride to zero" in ways the
    live StopLossEngine never allows.
    """
    side = trade["side"]
    stop = trade["stop"]
    targets = trade["targets"]
    premium_stop_pct = 35.0 if trade["strategy"] in ("ORB_INDEX", "VWAP_TREND") else 20.0
    premium_floor = trade["entry_price"] * (1 - premium_stop_pct / 100)
    entry_minute = int(trade["entry_time"] // 60) * 60
    t1_hit = False
    last_premium = None
    exit_reason, exit_time = "SESSION_FLATTEN", flatten_at
    for bar in spy_bars:
        if bar["time"] <= entry_minute or bar["time"] >= flatten_at:
            continue
        stop_hit = bar["low"] <= stop if side == "CALL" else bar["high"] >= stop
        t1 = targets[0] if targets else None
        t2 = targets[1] if len(targets) > 1 else None
        t1_touch = t1 is not None and (bar["high"] >= t1 if side == "CALL" else bar["low"] <= t1)
        t2_touch = t2 is not None and (bar["high"] >= t2 if side == "CALL" else bar["low"] <= t2)
        if stop_hit:
            exit_reason = "T1_TRAIL_STOP" if t1_hit else "STOP"
            exit_time = bar["time"] + 60
            break
        if t1_touch and not t1_hit:
            t1_hit = True
            stop = trade["trigger"]  # live policy: T1 moves the stop to the trigger
        if t2_touch:
            exit_reason = "TARGET_2"
            exit_time = bar["time"] + 60
            break
        candle = option_candles.get(bar["time"])
        if candle and candle["close"] > 0:
            last_premium = candle["close"]
        if not t1_hit and last_premium is not None and last_premium <= premium_floor:
            exit_reason = "PREMIUM_STOP"
            exit_time = bar["time"] + 60
            break
    minute = int(exit_time // 60) * 60
    candle = None
    for lookback in range(0, 15):
        candle = option_candles.get(minute - lookback * 60)
        if candle and candle["close"] > 0:
            break
    if not candle or candle["close"] <= 0:
        return {**trade, "exit_reason": "NO_EXIT_QUOTE", "pnl": None}
    exit_mid = candle["close"]
    exit_bid = max(0.01, exit_mid - modeled_spread(exit_mid) / 2)
    pnl = round((exit_bid - trade["entry_price"]) * 100 * trade["contracts"], 2)
    return {**trade, "exit_time": exit_time, "exit_price": round(exit_bid, 2),
            "exit_reason": exit_reason, "t1_hit": t1_hit, "pnl": pnl}


def run_day(client: UWClient, date: str, interval: int, verbose: bool) -> dict:
    open_at, close_at = _session_bounds(date)
    flatten_at = close_at - 40 * 60
    entry_cutoff = close_at - 60 * 60

    spy_bars = fetch_bars(client, "SPY", date)
    qqq_bars = fetch_bars(client, "QQQ", date)
    session_spy = [bar for bar in spy_bars if open_at <= bar["time"] < close_at]
    if len(session_spy) < 30:
        return {"date": date, "skipped": f"only {len(session_spy)} session bars"}
    gamma_series = fetch_spot_gamma_series(client, date)
    profile = fetch_strike_profile(client, date)
    open_spot = session_spy[0]["open"]
    flip, call_wall, put_wall = derive_walls_and_flip(profile, open_spot)

    day_low = min(bar["low"] for bar in session_spy)
    day_high = max(bar["high"] for bar in session_spy)
    width = max(6.0, (day_high - day_low) * 1.2)
    mid_price = (day_high + day_low) / 2
    session_yyyymmdd = date.replace("-", "")
    expiries = listed_expiries(client, date)

    # Primary chain: 0DTE before 1 PM ET, next listed expiry after (live
    # adaptive mode). Wall chain: nearest expiry >= 3 calendar days out —
    # exactly the live _wall_option_expiry selection.
    next_expiry = next((expiry for expiry in expiries if expiry > session_yyyymmdd), None)
    wall_expiry = _wall_option_expiry(expiries, now=open_at, min_dte=3)

    zero_dte_meta = contract_symbols_for_expiry(client, date, session_yyyymmdd, mid_price, width)
    next_meta = contract_symbols_for_expiry(client, date, next_expiry, mid_price, width) if next_expiry else []
    wall_meta = (
        contract_symbols_for_expiry(client, date, wall_expiry, mid_price, max(6.0, width * 0.8))
        if wall_expiry and wall_expiry not in (session_yyyymmdd,) else []
    )
    option_data = {
        entry["symbol"]: fetch_option_candles(client, entry["symbol"], date)
        for entry in (*zero_dte_meta, *next_meta, *wall_meta)
    }
    one_pm = datetime.strptime(date, "%Y-%m-%d").replace(hour=13, minute=0, tzinfo=ET).timestamp()

    gamma_index = 0
    previous = {lane: None for lane in STRATEGY_LANES}
    trades: list[dict] = []
    open_by_lane: dict[str, dict] = {}
    blocker_counts: dict[str, int] = {}
    state_minutes: dict[str, int] = {}

    real_time = time.time
    try:
        for sim_minute in range(int(open_at) + 120, int(entry_cutoff), interval):
            sim_now = float(sim_minute) + 5.0
            time.time = lambda now=sim_now: now  # the engine's whole clock

            spy = symbol_market(spy_bars, sim_now)
            qqq = symbol_market(qqq_bars, sim_now)
            if spy["spot"] is None:
                continue
            while gamma_index + 1 < len(gamma_series) and gamma_series[gamma_index + 1][0] <= sim_now:
                gamma_index += 1
            net_gamma = gamma_series[gamma_index][1] if gamma_series and gamma_series[gamma_index][0] <= sim_now else None
            gex = gex_snapshot(sim_now, spy["spot"], net_gamma, flip, call_wall, put_wall)

            if sim_now < one_pm or not next_meta:
                primary_meta, primary_expiry, expiry_mode = zero_dte_meta, date, "0DTE"
            else:
                primary_meta = next_meta
                primary_expiry = next_meta[0]["expiry"]
                expiry_mode = "1DTE_NEXT_LISTED"
            chain = []
            for entry in primary_meta:
                quote = build_option_contract(entry, option_data[entry["symbol"]], sim_now, spy["spot"])
                if quote:
                    chain.append(quote)
            options = {"generated_at": sim_now, "source": "UW", "underlying": "SPY",
                       "expiry": primary_expiry, "expiry_mode": expiry_mode, "contracts": chain}
            wall_options = None
            if wall_meta:
                wall_chain = []
                for entry in wall_meta:
                    quote = build_option_contract(entry, option_data[entry["symbol"]], sim_now, spy["spot"])
                    if quote:
                        wall_chain.append(quote)
                if wall_chain:
                    wall_options = {"generated_at": sim_now, "source": "UW", "underlying": "SPY",
                                    "expiry": wall_meta[0]["expiry"], "expiry_mode": "WALL_3DTE",
                                    "contracts": wall_chain}
            market = {
                "generated_at": sim_now,
                "source": "UW_BACKTEST",
                "data_type": "historical",
                "transport": {"connected": True},
                "symbols": {"SPY": spy, "QQQ": qqq},
            }
            indicators = {
                "SPY": signal_engine.calculate_indicators(spy["bars"]),
                "QQQ": signal_engine.calculate_indicators(qqq["bars"]),
            }
            market["market_data_readiness"] = signal_engine.market_data_readiness(
                market, indicators, now=sim_now, stale_after=120,
            )

            for lane in STRATEGY_LANES:
                signal = build_signal(
                    market, indicators, options, gex, 120,
                    previous_signal=previous[lane],
                    zerogex=None, zerogex_role="shadow",
                    option_max_total_debit_dollars=1000,
                    option_preferred_contracts=1,
                    max_tracking_gap_seconds=max(180.0, interval * 3.0),
                    strategy_families=_strategy_family_policy_for_lane(None, lane),
                    wall_options=wall_options,
                )
                previous[lane] = signal
                state = str(signal.get("state") or "WAIT").upper()
                state_minutes[state] = state_minutes.get(state, 0) + 1
                for blocker in signal.get("blockers") or []:
                    key = str(blocker)[:70]
                    blocker_counts[key] = blocker_counts.get(key, 0) + 1

                lifecycle = signal.get("lifecycle") or {}
                if lane in open_by_lane:
                    continue
                # Mirror the live executor's portfolio caps: max 2 entries/day,
                # and never stack the identical contract+side from another lane.
                if len(open_by_lane) + len(trades) >= 2:
                    continue
                if state == "ACTIVE" and lifecycle.get("entry_allowed") is True:
                    setup = signal.get("put_setup") if signal.get("favoring") == "puts" else signal.get("call_setup")
                    option = (setup or {}).get("option") or {}
                    if not option.get("local_symbol") or not _num(option.get("ask")):
                        continue
                    trade = {
                        "date": date, "lane": lane,
                        "strategy": signal.get("strategy"),
                        "side": "PUT" if signal.get("favoring") == "puts" else "CALL",
                        "entry_time": sim_now,
                        "entry_et": datetime.fromtimestamp(sim_now, ET).strftime("%H:%M"),
                        "contract": option["local_symbol"],
                        "entry_price": float(option["ask"]),
                        "contracts": 1,
                        "trigger": _num((setup or {}).get("trigger")),
                        "stop": _num((setup or {}).get("invalidation")) or _num((setup or {}).get("stop")),
                        "targets": [t for t in ((setup or {}).get("targets") or []) if _num(t) is not None][:3],
                    }
                    if trade["stop"] is None or not trade["targets"] or trade["trigger"] is None:
                        continue
                    duplicate = any(
                        existing["contract"] == trade["contract"] and existing["side"] == trade["side"]
                        for existing in open_by_lane.values()
                    )
                    if duplicate:
                        continue
                    open_by_lane[lane] = trade
                    if verbose:
                        print(f"  ENTRY {trade['entry_et']} {lane} {trade['strategy']} {trade['side']} "
                              f"{trade['contract']} @ ${trade['entry_price']:.2f} stop {trade['stop']} targets {trade['targets']}")
    finally:
        time.time = real_time

    for lane, trade in open_by_lane.items():
        candles = option_data.get(trade["contract"], {})
        trades.append(simulate_exit(trade, spy_bars, candles, close_at, flatten_at))

    return {"date": date, "trades": trades, "blockers": blocker_counts, "states": state_minutes}


def summarize(all_trades: list[dict]) -> None:
    priced = [trade for trade in all_trades if trade.get("pnl") is not None]
    print(f"\n{'=' * 64}\nTRADES: {len(all_trades)} ({len(priced)} priced)")
    if not priced:
        return
    wins = [trade for trade in priced if trade["pnl"] > 0]
    gross_win = sum(trade["pnl"] for trade in wins)
    gross_loss = -sum(trade["pnl"] for trade in priced if trade["pnl"] < 0)
    total = sum(trade["pnl"] for trade in priced)
    print(f"win rate {len(wins)}/{len(priced)} ({100 * len(wins) / len(priced):.0f}%)   "
          f"total P&L ${total:.2f}/contract   PF {gross_win / gross_loss if gross_loss else float('inf'):.2f}   "
          f"expectancy ${total / len(priced):.2f}/trade (gross of commission)")
    by_strategy: dict[str, list[dict]] = {}
    for trade in priced:
        by_strategy.setdefault(str(trade["strategy"]), []).append(trade)
    for strategy, rows in sorted(by_strategy.items()):
        subtotal = sum(row["pnl"] for row in rows)
        sub_wins = sum(1 for row in rows if row["pnl"] > 0)
        print(f"  {strategy:<22} {len(rows):>3} trades  {sub_wins:>2} wins  ${subtotal:>9.2f}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--date")
    parser.add_argument("--start")
    parser.add_argument("--end")
    parser.add_argument("--interval", type=int, default=60)
    parser.add_argument("--summary-only", action="store_true")
    args = parser.parse_args()

    client = UWClient(_load_token())
    if args.date:
        dates = [args.date]
    elif args.start and args.end:
        cursor = datetime.strptime(args.start, "%Y-%m-%d")
        end = datetime.strptime(args.end, "%Y-%m-%d")
        dates = []
        while cursor <= end:
            if cursor.weekday() < 5:
                dates.append(cursor.strftime("%Y-%m-%d"))
            cursor += timedelta(days=1)
    else:
        raise SystemExit("pass --date or --start/--end")

    all_trades: list[dict] = []
    for date in dates:
        print(f"\n=== {date} ===")
        try:
            result = run_day(client, date, args.interval, verbose=not args.summary_only)
        except Exception as exc:
            print(f"  FAILED: {exc}")
            continue
        if result.get("skipped"):
            print(f"  skipped: {result['skipped']}")
            continue
        day_trades = result["trades"]
        all_trades.extend(day_trades)
        for trade in day_trades:
            print(f"  {trade['entry_et']} {trade['lane']:<10} {str(trade['strategy']):<20} {trade['side']} "
                  f"{trade['contract']} in ${trade['entry_price']:.2f} -> "
                  f"{trade.get('exit_reason')} ${trade.get('exit_price', 0) or 0:.2f}  P&L ${trade.get('pnl')}")
        if not args.summary_only:
            top = sorted(result["blockers"].items(), key=lambda item: -item[1])[:6]
            print(f"  states: {result['states']}")
            for blocker, count in top:
                print(f"    blocker x{count}: {blocker}")
    summarize(all_trades)


if __name__ == "__main__":
    main()
