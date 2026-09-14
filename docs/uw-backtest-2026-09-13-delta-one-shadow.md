# Delta-one shadow P&L on the corrected replay (2026-09-13)

**Question:** is the options wrapper (theta, IV, premium stop, spreads) the leak, or is it entry/stop quality? If the same 61 entries make money on the underlying, futures (MES) would be the better instrument.

**Method:** `strategy-engine/uw_shadow_delta_one.py` re-scores every trade in `uw_results/trades-fixed-0dte-baseline.jsonl` on cached SPY 1m bars with the same trigger/stop/targets and the same walk-forward rules as `simulate_exit` (stop-first intrabar, T1 moves stop to trigger, T2 exit, 15:20 flatten). No premium stop, no option pricing. Entry = open of the entry-minute bar (mirrors `symbol_market`). MES conversion: 1 SPY pt ≈ 10 ES pts = $50/MES; $4 friction per round trip.

**Answer: no.** The live set loses on the underlying too, and by more than the options did.

| Set | Instrument | n | Win % | Total | Mean ± SE | PF |
|---|---|---|---|---|---|---|
| Live set (excl. retired REJECTION) | MES net | 51 | 31% | −$392 | −$7.69 ± 8.93 | 0.74 |
| Live set | Options 0DTE (replay) | 51 | 29% | −$47 | −$0.92 ± 7.84 | 0.96 |
| Live set | Options 3DTE (replay) | 50 | 40% | +$337 | +$6.74 ± 9.62 | 1.31 |
| Live set | MES sized to $50 risk | 42 | 29% | −$578 | −$13.77 ± 8.27 | 0.57 |
| All 61 | MES net | 61 | 36% | −$79 | −$1.29 ± 9.58 | 0.96 |
| All 61 | Options 0DTE | 61 | 25% | −$511 | −$8.38 ± 6.94 | 0.66 |

Paired MES − 0DTE options on the live set: −$6.77 ± 5.99 (−1.1 SE). Paired on all 61: +$7.09 ± 8.88 (0.8 SE). Noise both ways; no evidence the wrapper is the leak.

**Where the loss is:** 26 of 51 live-set trades hit the full invalidation stop (0 wins, avg −$53). 16 hit T2 (avg +$68). Payoff ≈ 1.3:1 needs a ~44% win rate to break even; the set runs at 31%. Ratchet (live) beats no-ratchet and exit-at-T1 on the underlying too, consistent with the 2026-09-06 exit-policy result.

**By strategy (MES net, live policy):** CONTINUATION −$126 / 26 (PF 0.81); GEX_WALL_BREAK_FAIL +$7 / 10 (PF 1.02, SE $34); MTF_TREND_BREAK −$273 / 15 (PF 0.32).

**REJECTION artifact:** GEX_WALL_REJECTION shows +$313 on delta-one only because its 5–15 pt stops are never reached and trades drift to the 15:20 flatten (R multiples 0.0–0.5). Sized to a $50 budget every one of the 10 is denied. Not a reason to un-retire it.

**Conclusion:** futures don't fix this strategy; entry/stop quality does. 3 DTE options on the live set is the only positive line, still <1 SE. Do not build a futures feed or broker path on this evidence. Window is in-sample; forward OOS from 2026-09-06.

## Trailing-stop variants on the underlying (same day, operator request)

Live has no underlying trailing stop: the engine's stop is a strict invalidation that moves to the trigger after T1; only the option-premium side trails (`paper_trailing_stop_pct`). Tested trailing the underlying stop from the best excursion, tightening only, with and without the T2 exit. ATR = 14-period 5m ATR before entry (median 0.96 pt vs median stop risk 0.61 pt, so ATR trails are *wider* than the strict stop).

Live set (n=51), MES net per contract, paired vs the live policy:

| Policy | Win % | Total | PF | vs live (mean ± SE) |
|---|---|---|---|---|
| live (strict, T1→trigger, T2 exit) | 31% | −$392 | 0.74 | — |
| trail 1R from best, no target (run) | 39% | −$184 | 0.84 | +$4.07 ± 4.48 |
| trail 1R, T2 exit | 39% | −$221 | 0.81 | +$3.36 ± 4.14 |
| trail 0.5R, T2 exit | 37% | −$203 | 0.71 | +$3.70 ± 7.00 |
| strict to T1, then trail 1R, run | 41% | −$293 | 0.79 | +$1.94 ± 2.30 |
| strict to T1, then trail 0.5R | 45% | −$427 | 0.69 | −$0.69 ± 2.94 |
| trail 1.5R, run | 31% | −$401 | 0.72 | −$0.18 ± 4.43 |
| trail 1.0×ATR, T2 exit | 33% | −$409 | 0.65 | −$0.33 ± 6.19 |
| trail 1.5×ATR, run | 25% | −$620 | 0.57 | −$4.48 ± 6.28 |
| trail 2.0×ATR, run | 24% | −$859 | 0.48 | −$9.16 ± 6.72 |

Every trailing variant stays negative on the live set; the best is +$4/trade vs live at 0.9 SE. Wider (ATR) trails are worse because they give back the T2 winners. The all-61 positives (trail 1R run +$175, PF 1.12) come from the retired REJECTION trades drifting with 5–15 pt stops. By strategy under trail-1R-run: CONTINUATION −$2 (from −$126), BREAK_FAIL +$53, MTF_TREND_BREAK −$235 (from −$273).

**Conclusion unchanged:** stop *mechanics* (strict vs trailing vs ratchet) move a few dollars per trade within noise; the loss is that 31% of entries reach any target at ~1.3:1 payoff. Entry selection, not stop type, is the lever.
