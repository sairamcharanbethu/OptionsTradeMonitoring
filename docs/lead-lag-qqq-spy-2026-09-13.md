# Does NQ lead SPY by 1–3 minutes? (2026-09-13)

**Claim tested:** "NQ futures are 1 to 3 minutes early relative to SPY."

**Proxy:** QQQ 1-minute bars stand in for NQ. QQQ and NQ are arbitraged within seconds, so at 1-minute resolution any multi-minute lead of NQ over SPY would appear identically in QQQ. Data: 160 cached RTH sessions (2026), 62,240 aligned 1-minute log returns. Script: `strategy-engine/uw_leadlag_qqq_spy.py`; raw output alongside this file.

| Lag k (QQQ at t−k vs SPY at t) | Correlation | 1 SE |
|---|---|---|
| −3 (SPY leads) | −0.012 | 0.004 |
| −1 | −0.001 | 0.004 |
| **0 (same minute)** | **+0.922** | 0.004 |
| +1 (QQQ leads by 1 min) | +0.002 | 0.004 |
| +2 | +0.002 | 0.004 |
| +3 | −0.010 | 0.004 |

Predictive regression SPY[t] on SPY[t−1] and QQQ[t−1]: the QQQ coefficient is +0.029 (t = 4.0). Statistically detectable, economically nil: a 10 bp QQQ move in the prior minute predicts about 0.3 bp of SPY in the next minute, a quarter of one SPY tick.

Sign-following trade (buy SPY when QQQ's prior 1- or 3-minute move was up, hold 1 or 5 minutes), gross of costs: mean −0.002 to −0.10 bp per trade, hit rate 48.9–49.8%. Negative before spread.

**Conclusion:** false at the minute scale. QQQ/NQ and SPY move in the same minute (r = 0.92) and the next-minute information is ~1/40 of a tick. The real futures-over-ETF lead is sub-second to a few seconds, which the 1-minute engine cannot use and which no retail routing can capture. Do not build an NQ-leads-SPY signal.
