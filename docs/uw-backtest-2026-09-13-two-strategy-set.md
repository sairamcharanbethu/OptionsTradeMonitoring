# Two-strategy live set: CONTINUATION + GEX_WALL_BREAK_FAIL (2026-09-13)

Operator decision: retire MTF_TREND_BREAK and the heatmap GEX_REJECTION; keep CONTINUATION (negative gamma only) and GEX_WALL_BREAK_FAIL. Implemented by deleting the `_mtf_reversal_candidate` builder (the only source of both retired setups) so the wall-reaction engine is the sole frozen-trigger candidate; `FROZEN_SETUP_STRATEGIES` is now the wall set and any stored frozen setup with a retired name never re-arms.

Like-for-like replay, cached sessions 2026-04-21..08-21, 3 DTE primary chain, live exit policy, same engine build otherwise:

| Code | Trades | Win % | Total / contract | PF | CONTINUATION | BREAK_FAIL | MTF_TREND_BREAK |
|---|---|---|---|---|---|---|---|
| Before (3 live setups) | 60 | 37% | −$0.65 | 1.00 | 32 tr, +$155 | 10 tr, +$220 | 18 tr, −$376 |
| After (2 live setups) | 60 | 37% | −$109.80 | 0.93 | 49 tr, −$237 | 11 tr, +$127 | — |

**The retired strategies were not simply subtracted.** MTF_TREND_BREAK candidates used to out-score or cooldown-block CONTINUATION on many sessions; with them gone, CONTINUATION fires 17 more times and those extra entries net about −$390. The change is −$109 total on this window, which is inside noise for 60 trades (roughly ±$350 at 1 SE), but the operator should know the "keep the positive subset" intuition did not hold: CONTINUATION's +$281 (earlier run) / +$155 (this baseline) was partly a selection effect of the strategy that lost money standing in front of it.

Per-trade records: `strategy-engine/uw_results/trades-two-strategy-3dte-baseline.jsonl`. Window is in-sample; forward OOS from 2026-09-06 is the judge.
