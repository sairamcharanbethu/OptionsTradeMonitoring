# Replay: post-T1 exit policy and 3 DTE primary chain (2026-04-14 → 2026-08-21)

Run 2026-09-06 with `strategy-engine/uw_backtest.py` over the 94 cached Unusual Whales
sessions (127 executor entries per configuration, live caps of 2 trades/day, stop-first
intrabar sequencing, fills crossing a modeled spread, wall chain disabled to mirror
live). Logs and per-trade files: `strategy-engine/uw_results/run-exitpolicy-{0dte,3dte}.log`,
`trades-exitpolicy-{0dte,3dte}-<variant>.jsonl`. Contracts are commission-free, so
gross = net; the only modeled cost is the spread.

## Question 1 — is the post-T1 stop ratchet the leak?

Hypothesis (from the June–August cut): trades that reached T1 and were then stopped on the
ratcheted stop closed red 77% of the time while T2 exits carried the system, so leaving the
stop at the invalidation (or trimming at T1 and holding) should add expectancy.

Four exit policies were simulated on the **same entries**, so the paired per-trade delta is
the test statistic:

| Policy (0DTE primary, n=127) | Win % | Total/contract | PF | Δ vs live (paired) |
|---|---|---|---|---|
| live: T1 → stop to trigger, premium lock | 38% | −$166.75 | 0.94 | — |
| t1_no_ratchet: stop stays at invalidation, lock kept | 40% | −$157.80 | 0.94 | **+$0.07 ± 0.92** |
| t1_hold: stop stays, no lock, run to T2 | 36% | −$265.45 | 0.91 | **−$0.78 ± 1.74** |
| t1_trim_half_hold: bank 50% at T1, rest holds invalidation stop | 40% | −$136.73 | 0.94 | **+$0.24 ± 1.68** |

On the 3 DTE chain the same four policies land at −$1.15 ± 1.28, −$0.51 ± 1.55 and
+$0.36 ± 1.53 against live.

**Result: the hypothesis is not supported.** Every alternative is within half a standard
error of the live rule. The mechanism is visible in the exit breakdown: of the 16 trades
the live rule closed as `T1_TRAIL_STOP` (avg −$24), holding them produced 3–4 extra T2 hits
(+$60 each) but the rest ran to the original invalidation (`STOP_AFTER_T1`, avg −$39) or
the premium stop. The ratchet gives back less than it saves. Trimming half at T1 is the
best of the alternatives and is still indistinguishable from noise. **No change to exit
management is warranted by this data.**

## Question 2 — 3 DTE primary vs 0DTE primary

The live default moved to a ≥3-calendar-day primary chain on 2026-09-06. Paired on the
115 entries shared by both runs:

| | 0DTE / 1PM-roll primary | ≥3 DTE primary |
|---|---|---|
| Avg entry premium | $1.62 | $3.97 |
| Total/contract, PF | −$166.75, 0.94 | −$484.00, 0.85 |
| Mean return on premium | +1.3% | −0.3% |
| Paired Δ per contract | — | **−$1.03 ± 3.15** |
| Paired Δ return on premium | — | **−1.6% ± 2.75** |

A statistical tie for the third time (see the April–August doc), leaning 0DTE. With
risk-based sizing the per-contract dollar gap is normalized away; what remains is that the
3 DTE contract costs ~2.4× the premium for the same underlying plan and its stops
(`STOP` avg −$32 vs −$19) are proportionally larger. There is no evidence for 3 DTE here,
and mild evidence against it. Left as an operator preference; revisit with a longer window.

## Question 3 — what actually leaks?

Per-family mean ± SE, 0DTE baseline (3 DTE in parentheses):

| Family | n | Mean/trade | SE from zero |
|---|---|---|---|
| **ORB_INDEX** | 11 | **−$34.86 ± 22.20** (−$60.17 ± 27.15) | **−1.6 (−2.2)** |
| MTF_TREND_BREAK | 35 | −$3.20 ± 7.31 | −0.4 |
| VWAP_TREND | 26 | −$1.10 ± 9.60 | −0.1 |
| GEX_WALL_BREAK_FAIL | 15 | −$1.68 ± 10.14 | −0.2 |
| GEX_WALL_REJECTION | 8 | +$12.10 ± 41.95 | +0.3 |
| CONTINUATION | 32 | +$8.93 ± 8.94 | +1.0 |

- **ORB_INDEX is the only family consistently negative**: 3 wins in 11 here, −$248 on 4
  trades in the June–August cut, and the worst family under both chains. Excluding it moves
  the 0DTE baseline to **+$1.87 ± 4.95/trade, PF 1.11** (3 DTE: +$1.53 ± 5.55, PF 1.07).
  Still under 1 SE from zero, but it is the same shape of evidence that retired
  GEX_WALL_BOUNCE, and the family is structurally thin (5-minute range, two eligible trigger
  bars, no range-width or volume filter).
- 70 of 127 trades end at `STOP` or `PREMIUM_STOP` for −$1,858 combined. Entry quality and
  stop placement, not post-target management, decide this system.

## Question 4 — does the 11:00 ET cutoff hold up?

| Entry time (0DTE baseline) | n | Mean/trade |
|---|---|---|
| before 11:00 | 101 | −$3.23 ± 5.07 |
| 11:00 and later | 26 | +$6.12 ± 14.30 |

This **contradicts the June–August cut** ("every hour after 11:00 negative") and is itself
noise (26 trades, SE $14). Time-of-day is not a robust edge in either direction on this
sample. The 11:00 default last-entry time shipped on 2026-09-06 reduces exposure, which is
defensible, but it should be understood as a judgment call, not a measured edge.
Before 11:00 and excluding ORB: +$0.64 ± 4.91, PF 1.04 (0DTE).

## Conclusions

1. Keep the live post-T1 rule. Do not ship the trim-at-T1 change.
2. The one evidence-backed candidate is **disabling ORB_INDEX** (adapter policy
   `strategy_families.orb_index.enabled`). Expected effect on this sample: about +$3/trade,
   PF 0.94 → 1.11; still not statistically proven, so treat as the next paper-first test.
3. 3 DTE vs 0DTE is a tie leaning 0DTE; no data supports the switch yet.
4. The 11:00 cutoff is not confirmed by this window; leave it configurable and revisit with
   a longer sample.

## Fidelity caveats

Same as prior runs: no ZeroGEX decision blockers (more permissive than live); modeled
spreads on candle mids, stop-first intrabar sequencing (less favorable than live); GEX from
UW's dealer model. The 3 DTE chain uses the narrower (0.8×) strike width that was cached
for wall setups. Trim P&L is a 50/50 blend per contract, which assumes a 2-contract
position; with the $500 risk budget most live entries size to 2+ contracts on 0DTE and to
1 on 3 DTE, where a trim is impossible.
