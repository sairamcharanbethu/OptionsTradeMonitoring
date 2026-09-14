"""Delta-one shadow P&L for the corrected replay trades.

Re-scores each replay entry on the underlying (SPY 1m bars) using the same
trigger/stop/targets and the same walk-forward rules as simulate_exit, but
with no option premium in the loop. Expressed in SPY points, R multiples, and
MES dollars (1 SPY point ~= 10 ES points = $50 per MES contract).
"""
import json, math, sys
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from collections import defaultdict

ET = ZoneInfo("America/New_York")
ROOT = __import__("os").path.dirname(__import__("os").path.abspath(__file__))
TRADES = f"{ROOT}/uw_results/trades-fixed-0dte-baseline.jsonl"
TRADES_3 = f"{ROOT}/uw_results/trades-fixed-3dte-baseline.jsonl"
MES_PER_SPY_PT = 50.0      # $5/ES pt * 10 ES pts per SPY pt
FRICTION_PER_MES = 4.0     # 1 tick slippage each side ($2.50) + ~$0.75/side commission
RISK_BUDGET = 50.0
RETIRED = {"GEX_WALL_REJECTION"}

def bars_for(date):
    rows = json.load(open(f"{ROOT}/uw_cache/stock_SPY_ohlc_1m_date-{date}_limit-1500.json"))["data"]
    out = []
    for r in rows:
        t = datetime.fromisoformat(r["start_time"].replace("Z", "+00:00")).timestamp()
        out.append({"time": t, "open": float(r["open"]), "high": float(r["high"]),
                    "low": float(r["low"]), "close": float(r["close"])})
    out.sort(key=lambda b: b["time"])
    return out

def session_bounds(date):
    d = datetime.strptime(date, "%Y-%m-%d").replace(tzinfo=ET)
    return d.replace(hour=9, minute=30).timestamp(), d.replace(hour=16).timestamp()

POLICIES = {
    # name: (initial-stop mode, trail spec, trail-after-T1-only, exit at T2?)
    "live":               ("strict", None,          False, True),
    "no_ratchet":         ("hold",   None,          False, True),
    "exit_at_t1":         ("t1",     None,          False, True),
    "trail_0.5R_T2":      ("hold",   ("R", 0.5),    False, True),
    "trail_1R_T2":        ("hold",   ("R", 1.0),    False, True),
    "trail_1R_run":       ("hold",   ("R", 1.0),    False, False),
    "trail_1.5R_run":     ("hold",   ("R", 1.5),    False, False),
    "trail_atr1_T2":      ("hold",   ("ATR", 1.0),  False, True),
    "trail_atr1.5_T2":    ("hold",   ("ATR", 1.5),  False, True),
    "trail_atr1.5_run":   ("hold",   ("ATR", 1.5),  False, False),
    "trail_atr2_run":     ("hold",   ("ATR", 2.0),  False, False),
    "t1_then_trail_0.5R": ("strict", ("R", 0.5),    True,  True),
    "t1_then_trail_1R_run": ("strict", ("R", 1.0),  True,  False),
}

def atr_5m_at(bars, entry_minute, period=14):
    """ATR(14) of 5m bars completed before entry, RTH bars only, same as _atr_py."""
    rth = [b for b in bars if b["time"] < entry_minute and datetime.fromtimestamp(b["time"], ET).hour * 60 + datetime.fromtimestamp(b["time"], ET).minute >= 570 and datetime.fromtimestamp(b["time"], ET).hour < 16]
    fives = {}
    for b in rth:
        k = int(b["time"] // 300) * 300
        f = fives.setdefault(k, {"high": b["high"], "low": b["low"], "close": b["close"]})
        f["high"] = max(f["high"], b["high"]); f["low"] = min(f["low"], b["low"]); f["close"] = b["close"]
    seq = [fives[k] for k in sorted(fives)]
    if len(seq) < 2: return None
    tr = [max(c["high"] - c["low"], abs(c["high"] - p["close"]), abs(c["low"] - p["close"])) for p, c in zip(seq, seq[1:])]
    w = tr[-period:]
    return sum(w) / len(w)

def shadow(trade, bars, policy):
    init_mode, trail, after_t1_only, exit_t2 = POLICIES[policy]
    side = trade["side"]; sgn = 1 if side == "CALL" else -1
    stop = trade["stop"]; t1, t2 = trade["targets"][0], trade["targets"][1]
    risk = abs(trade["trigger"] - trade["stop"])
    _, close_at = session_bounds(trade["date"])
    flatten_at = close_at - 40 * 60
    entry_minute = int(trade["entry_time"] // 60) * 60
    by_time = {b["time"]: b for b in bars}
    cur = by_time.get(entry_minute)
    entry_px = cur["open"] if cur else trade["trigger"]
    atr = trade.get("_atr")
    if trail and trail[0] == "ATR" and not atr:
        atr = risk  # fallback: no ATR available -> trail at 1R-equivalent
    trail_dist = None
    if trail:
        trail_dist = trail[1] * (risk if trail[0] == "R" else atr)
    best = entry_px
    t1_hit = False
    reason, exit_px, exit_time = "SESSION_FLATTEN", None, flatten_at
    last_close = entry_px
    for b in bars:
        if b["time"] <= entry_minute or b["time"] >= flatten_at:
            continue
        last_close = b["close"]
        stop_hit = b["low"] <= stop if side == "CALL" else b["high"] >= stop
        t1_touch = b["high"] >= t1 if side == "CALL" else b["low"] <= t1
        t2_touch = b["high"] >= t2 if side == "CALL" else b["low"] <= t2
        if stop_hit:
            if t1_hit:
                reason = "TRAIL_STOP" if trail else ("T1_TRAIL_STOP" if init_mode == "strict" else "STOP_AFTER_T1")
            else:
                reason = "TRAIL_STOP" if (trail and not after_t1_only and sgn * (stop - trade["stop"]) > 1e-9) else "STOP"
            exit_px, exit_time = stop, b["time"] + 60
            break
        if t1_touch and not t1_hit:
            if init_mode == "t1":
                reason, exit_px, exit_time = "TARGET_1", t1, b["time"] + 60
                break
            t1_hit = True
            if init_mode == "strict":
                stop = trade["trigger"] if sgn * (trade["trigger"] - stop) > 0 else stop
        if exit_t2 and t2_touch:
            reason, exit_px, exit_time = "TARGET_2", t2, b["time"] + 60
            break
        # update trailing stop from this bar's extreme (applies from next bar)
        if trail and (t1_hit or not after_t1_only):
            best = max(best, b["high"]) if side == "CALL" else min(best, b["low"])
            candidate = best - sgn * trail_dist
            if sgn * (candidate - stop) > 0:
                stop = candidate
    if exit_px is None:
        exit_px = last_close
    pts = sgn * (exit_px - entry_px)
    return {"entry_px": entry_px, "exit_px": exit_px, "reason": reason, "t1_hit": t1_hit,
            "pts": pts, "risk_pts": risk, "r": pts / risk if risk > 0 else None,
            "mes_gross": pts * MES_PER_SPY_PT, "mes_net": pts * MES_PER_SPY_PT - FRICTION_PER_MES,
            "exit_et": datetime.fromtimestamp(exit_time, ET).strftime("%H:%M")}

def stats(xs):
    n = len(xs)
    if n == 0: return (0, 0.0, 0.0, 0.0, 0.0)
    m = sum(xs) / n
    sd = math.sqrt(sum((x - m) ** 2 for x in xs) / (n - 1)) if n > 1 else 0.0
    se = sd / math.sqrt(n)
    g = sum(x for x in xs if x > 0); l = -sum(x for x in xs if x < 0)
    pf = g / l if l > 0 else float("inf")
    return n, sum(xs), m, se, pf

def fmt(label, xs, unit="$"):
    n, tot, m, se, pf = stats(xs)
    wins = sum(1 for x in xs if x > 0)
    return f"{label:<34} n={n:>3}  wins {wins:>2} ({wins/n*100 if n else 0:>3.0f}%)  total {unit}{tot:>9.2f}  mean {unit}{m:>7.2f} ± {se:>5.2f}  PF {pf:>5.2f}"

trades = [json.loads(l) for l in open(TRADES)]
opt3 = {(t["date"], t["entry_time"]): t["pnl"] for t in (json.loads(l) for l in open(TRADES_3))}
bars_cache = {}
rows = []
for t in trades:
    bars = bars_cache.setdefault(t["date"], bars_for(t["date"]))
    hist = list(bars)
    from datetime import timedelta
    d = datetime.strptime(t["date"], "%Y-%m-%d")
    for back in range(1, 5):
        pd = (d - timedelta(days=back)).strftime("%Y-%m-%d")
        try: hist = bars_for(pd) + hist; break
        except FileNotFoundError: continue
    t["_atr"] = atr_5m_at(hist, int(t["entry_time"] // 60) * 60)
    r = {p: shadow(t, bars, p) for p in POLICIES}
    rows.append((t, r))

print("=" * 100)
print("DELTA-ONE SHADOW P&L  (SPY 1m bars, same trigger/stop/targets, no premium stop)")
print(f"MES $/SPY pt = {MES_PER_SPY_PT}, friction/round trip = ${FRICTION_PER_MES}, risk budget ${RISK_BUDGET}")
print("=" * 100)
hdr = f"{'date':<10} {'et':<5} {'strategy':<19} {'side':<4} {'entry':>7} {'exit':>7} {'reason':<15} {'pts':>6} {'R':>6} {'MES$':>8} {'opt0$':>8} {'opt3$':>8}"
print(hdr)
for t, r in rows:
    s = r["live"]
    print(f"{t['date']:<10} {t['entry_et']:<5} {t['strategy'][:19]:<19} {t['side']:<4} {s['entry_px']:>7.2f} {s['exit_px']:>7.2f} {s['reason']:<15} {s['pts']:>6.2f} {s['r']:>6.2f} {s['mes_net']:>8.2f} {t['pnl']:>8.2f} {opt3.get((t['date'], t['entry_time']), float('nan')):>8.2f}")

def block(title, subset):
    print("\n" + "-" * 100); print(title); print("-" * 100)
    base = [r["live"]["mes_net"] for _, r in subset]
    for p in POLICIES:
        xs = [r[p]["mes_net"] for _, r in subset]
        d = [x - b for x, b in zip(xs, base)]
        n, tot, m, se, _ = stats(d)
        paired = f"   vs live {m:>+7.2f} ± {se:>5.2f}" if p != "live" else ""
        print(fmt(f"MES net  [{p}]", xs) + paired)
    print(fmt("MES gross [live]", [r["live"]["mes_gross"] for _, r in subset]))
    print(fmt("R multiple [live]", [r["live"]["r"] for _, r in subset], unit=""))
    print(fmt("Options 0DTE (replay)", [t["pnl"] for t, _ in subset]))
    print(fmt("Options 3DTE (replay)", [opt3[(t["date"], t["entry_time"])] for t, _ in subset if (t["date"], t["entry_time"]) in opt3]))
    d = [r["live"]["mes_net"] - t["pnl"] for t, r in subset]
    n, tot, m, se, _ = stats(d)
    print(f"{'Paired MES - 0DTE options':<34} n={n:>3}  mean ${m:>7.2f} ± {se:>5.2f}  ({m/se:>4.1f} SE)" if se else "")
    # budget-sized MES
    sized = []; denied = 0
    for t, r in subset:
        k = math.floor(RISK_BUDGET / (r["live"]["risk_pts"] * MES_PER_SPY_PT)) if r["live"]["risk_pts"] > 0 else 0
        if k == 0: denied += 1; continue
        sized.append(k * r["live"]["mes_net"])
    print(fmt(f"MES sized to ${RISK_BUDGET:.0f} risk [live]", sized) + f"   denied {denied}")
    by = defaultdict(list); byr = defaultdict(list)
    for t, r in subset:
        by[t["strategy"]].append(r["live"]["mes_net"]); byr[r["live"]["reason"]].append(r["live"]["mes_net"])
    print("  by strategy:")
    for k in sorted(by): print("   " + fmt(k, by[k]))
    print("  by exit reason:")
    for k in sorted(byr): print("   " + fmt(k, byr[k]))

block("ALL 61 REPLAY TRADES", rows)
block("LIVE SET (excluding retired GEX_WALL_REJECTION)", [(t, r) for t, r in rows if t["strategy"] not in RETIRED])
