# Sweep-and-reclaim reversal, shadow only (2026-09-14)

**Built:** `strategy-engine/sweep_reversal.py` (pure; `SWEEP_RECLAIM_REVERSAL`). A closed 5m bar pierces a session reference level (PDH/PDL, ONH/ONL, IBH/IBL after 10:30) by ≤0.15% and the latest completed 5m bar closes back through it. Sell-side sweep reclaimed → calls; buy-side → puts. Entry = reclaim bar extreme ±0.01, stop = sweep extreme ±0.15×ATR (risk floored at 0.5×ATR, skipped above 1.5×ATR), targets 1.0/1.75/2.75 R, 15-minute frozen trigger. `signal_engine.build_signal` attaches the candidate under `signal["shadow_setups"]` inside a try/except and never reads it back; it cannot arm, block, or alter a live entry. `uw_backtest.py` runs an independent `shadow_sweep` executor (own caps: 2/session, one open) and reports it as its own variant.

**Replay:** cached sessions 2026-04-21..08-21 (89), 3 DTE primary chain, live exit policy, OTM-2 contract at the ask.

| Set | n | Win % | Total / contract | Mean ± SE | PF |
|---|---|---|---|---|---|
| **All shadow sweep trades** | 128 | 41% | **+$406.50** | +$3.18 ± 4.78 (0.7 SE) | **1.17** |
| Live baseline same window (CONTINUATION + BREAK_FAIL) | 60 | 37% | −$109.80 | −$1.83 | 0.93 |

Post-hoc slices (in-sample, chosen after looking — treat as hypotheses, not results):

| Slice | n | Win % | Total | Mean ± SE | PF |
|---|---|---|---|---|---|
| PUT (buy-side sweep of a high, reclaimed down) | 72 | 51% | +$988 | +$13.72 ± 7.01 (2.0 SE) | 1.94 |
| CALL (sell-side sweep of a low, reclaimed up) | 56 | 27% | −$581 | −$10.38 ± 5.78 | 0.56 |
| Level PDH | 16 | 88% | +$783 | +$48.91 ± 13.87 | 18.0 |
| Level ONH | 32 | 56% | +$641 | +$20.03 ± 11.68 | 2.52 |
| Level PDL | 10 | 0% | −$281 | −$28.08 ± 6.42 | 0.00 |
| Level IBH | 24 | 21% | −$436 | −$18.16 ± 6.57 | 0.26 |
| GEX regime Negative | 73 | 42% | +$588 | +$8.06 ± 7.62 | 1.39 |
| GEX regime Positive | 55 | 38% | −$182 | −$3.30 ± 4.59 | 0.79 |

Exit mix: 45 TARGET_2 (avg +$59), 48 STOP (avg −$36), 28 T1 trail stops (avg −$15), 4 premium stops, 3 premium locks. Entries cluster 10:00–11:59 (94 of 128).

**Reading.** Overall the setup is a coin flip with a slightly favourable payoff: +$3/trade at 0.7 SE is not evidence. The interesting structure is that fading swept *highs* (puts after a PDH/ONH sweep) carried all the profit while fading swept *lows* lost — the reverse of the "buy the stop-run under the lows" story the pattern is sold on. The scoring bonus for positive gamma was wrong on this window (negative gamma did better); it is informational only and was not changed, because tuning on the same in-sample window that produced the slice is how BOUNCE and REJECTION got "validated" and then failed.

**Decision rule for promotion:** stays shadow. Promote a *pre-registered* variant (puts only, PDH/ONH only) only if the forward shadow journal from 2026-09-14 onward reproduces PF > 1.3 on ≥ 40 trades. The live engine now journals every candidate, so this accrues without trading.

Per-trade records (git-ignored): `strategy-engine/uw_results/trades-shadow-sweep-3dte-shadow_sweep.jsonl`. Repro: `python3 uw_backtest.py --start 2026-04-21 --end 2026-08-21 --cache-only --summary-only` (the `shadow_sweep` block prints after the live variants).
