"""Does QQQ (proxy for NQ at 1-minute resolution) lead SPY by 1-3 minutes?
Cross-correlation of 1m log returns, predictive regression, and a sign-following test."""
import json, math, os, re
from datetime import datetime
from zoneinfo import ZoneInfo
ET = ZoneInfo("America/New_York")
CACHE = "uw_cache"
def load(sym, date):
    rows = json.load(open(f"{CACHE}/stock_{sym}_ohlc_1m_date-{date}_limit-1500.json"))["data"]
    out = {}
    for r in rows:
        t = datetime.fromisoformat(r["start_time"].replace("Z", "+00:00")).astimezone(ET)
        m = t.hour * 60 + t.minute
        if 570 <= m < 960:  # RTH only
            out[int(t.timestamp())] = float(r["close"])
    return out
dates = sorted({re.search(r"date-(2026-\d\d-\d\d)", f).group(1) for f in os.listdir(CACHE)
                if f.startswith("stock_SPY_ohlc_1m_date-2026")})
dates = [d for d in dates if os.path.exists(f"{CACHE}/stock_QQQ_ohlc_1m_date-{d}_limit-1500.json")]
spy_r, qqq_r = [], []   # aligned 1m log returns, session boundaries respected
sessions = 0
for d in dates:
    s, q = load("SPY", d), load("QQQ", d)
    ts = sorted(set(s) & set(q))
    if len(ts) < 300: continue
    sessions += 1
    # require consecutive minutes
    for a, b in zip(ts, ts[1:]):
        if b - a != 60: spy_r.append(None); qqq_r.append(None); continue
        spy_r.append(math.log(s[b] / s[a])); qqq_r.append(math.log(q[b] / q[a]))
    spy_r.append(None); qqq_r.append(None)
def corr(x, y):
    n = len(x); mx = sum(x)/n; my = sum(y)/n
    sxy = sum((a-mx)*(b-my) for a, b in zip(x, y)); sxx = sum((a-mx)**2 for a in x); syy = sum((b-my)**2 for b in y)
    return sxy / math.sqrt(sxx*syy)
def pairs(lag):
    """(qqq_r[t-lag], spy_r[t]); lag>0 = QQQ leads. Skips session boundaries."""
    X, Y = [], []
    for t in range(len(spy_r)):
        i = t - lag
        if i < 0 or i >= len(qqq_r) or spy_r[t] is None or qqq_r[i] is None: continue
        if any(v is None for v in spy_r[min(i,t):max(i,t)+1]): continue
        X.append(qqq_r[i]); Y.append(spy_r[t])
    return X, Y
print(f"{sessions} sessions, {sum(1 for v in spy_r if v is not None)} aligned 1m returns\n")
print("Cross-correlation corr(QQQ_ret[t-k], SPY_ret[t]); k>0 means QQQ/NQ leads SPY, k<0 means SPY leads")
for k in (-3, -2, -1, 0, 1, 2, 3):
    X, Y = pairs(k); c = corr(X, Y); se = 1/math.sqrt(len(X))
    print(f"  k={k:>+2}  corr {c:>+7.4f}   (n={len(X)}, 1 SE ≈ {se:.4f})")
# Predictive regression: SPY_ret[t] = a + b1*SPY_ret[t-1] + b2*QQQ_ret[t-1]
import itertools
rows = []
for t in range(1, len(spy_r)):
    if None in (spy_r[t], spy_r[t-1], qqq_r[t-1]): continue
    rows.append((spy_r[t], spy_r[t-1], qqq_r[t-1]))
# OLS via normal equations (3x3)
def ols(rows):
    n = len(rows); X = [(1.0, r[1], r[2]) for r in rows]; y = [r[0] for r in rows]
    XtX = [[sum(a[i]*a[j] for a in X) for j in range(3)] for i in range(3)]
    Xty = [sum(a[i]*b for a, b in zip(X, y)) for i in range(3)]
    # solve
    import copy
    A = [row[:] + [Xty[i]] for i, row in enumerate(XtX)]
    for i in range(3):
        p = A[i][i]
        for j in range(i, 4): A[i][j] /= p
        for r in range(3):
            if r != i:
                f = A[r][i]
                for j in range(i, 4): A[r][j] -= f * A[i][j]
    beta = [A[i][3] for i in range(3)]
    resid = [yy - sum(b*x for b, x in zip(beta, xx)) for xx, yy in zip(X, y)]
    s2 = sum(e*e for e in resid) / (n - 3)
    # inverse of XtX for SEs
    M = [row[:] + [1.0 if i == j else 0.0 for j in range(3)] for i, row in enumerate(XtX)]
    for i in range(3):
        p = M[i][i]
        for j in range(6): M[i][j] /= p
        for r in range(3):
            if r != i:
                f = M[r][i]
                for j in range(6): M[r][j] -= f * M[i][j]
    se = [math.sqrt(s2 * M[i][3+i]) for i in range(3)]
    return beta, se
beta, se = ols(rows)
print(f"\nPredictive OLS  SPY_ret[t] = a + b1*SPY_ret[t-1] + b2*QQQ_ret[t-1]   (n={len(rows)})")
print(f"  b1 (own lag)   {beta[1]:>+7.4f} ± {se[1]:.4f}   t={beta[1]/se[1]:>+5.1f}")
print(f"  b2 (QQQ lag)   {beta[2]:>+7.4f} ± {se[2]:.4f}   t={beta[2]/se[2]:>+5.1f}")
# Sign-following test: go with the sign of QQQ's prior 1m / 3m return; SPY next-1m and next-5m return in bps
def horizon_ret(arr, t, h):
    if t + h > len(arr): return None
    seg = arr[t:t+h]
    return None if any(v is None for v in seg) else sum(seg)
print("\nSign-following: trade SPY in the direction of QQQ's prior move (gross, no costs); returns in bps of SPY")
for look, hold in ((1, 1), (1, 5), (3, 1), (3, 5)):
    rets = []
    for t in range(look, len(spy_r)):
        sig = horizon_ret(qqq_r, t-look, look); fwd = horizon_ret(spy_r, t, hold)
        if sig is None or fwd is None or sig == 0: continue
        rets.append(math.copysign(1, sig) * fwd * 1e4)
    n = len(rets); m = sum(rets)/n; sd = math.sqrt(sum((r-m)**2 for r in rets)/(n-1)); hit = sum(1 for r in rets if r > 0)/n
    print(f"  look {look}m -> hold {hold}m: mean {m:>+6.3f} bps ± {sd/math.sqrt(n):.3f}  hit {hit*100:.1f}%  n={n}   (1 SPY tick ≈ {1e4*0.01/745:.2f} bps; typical spread cost ≈ 0.13 bps)")
# Residual (QQQ-specific) information: QQQ_ret - beta*SPY_ret at t-1 -> SPY_ret[t]
X0, Y0 = pairs(0); b = sum(a*b for a, b in zip(X0, Y0)) / sum(a*a for a in X0)
res_rows = []
for t in range(1, len(spy_r)):
    if None in (spy_r[t], spy_r[t-1], qqq_r[t-1]): continue
    res_rows.append((spy_r[t], spy_r[t-1], qqq_r[t-1] - b*spy_r[t-1]))
beta_r, se_r = ols(res_rows)
print(f"\nQQQ-specific (residual) lag: SPY_ret[t] on SPY_ret[t-1] and (QQQ_ret - {b:.2f}*SPY_ret)[t-1]")
print(f"  b2 residual    {beta_r[2]:>+7.4f} ± {se_r[2]:.4f}   t={beta_r[2]/se_r[2]:>+5.1f}")
