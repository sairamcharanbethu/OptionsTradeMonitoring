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

---

# Addendum: the replay was flattering itself — corrected results (same day)

A critic pass over `uw_backtest.py` (look-ahead, repainting, fills, fitting, sample, alignment)
found three fidelity defects. All numbers above this line were produced with them present.

| Defect | Where | Fix |
|---|---|---|
| Entry filled at the **current minute's option close**, which is not known at decision time | `build_option_contract`: `candle = candles.get(minute - lookback*60)` with lookback 0 | quote from the **last closed minute** |
| Tradeable strike universe chosen from the **day's realised high/low** | `width = max(6.0, (day_high - day_low) * 1.2)` | open ± 1.2%, fixed |
| Strike GEX profile is a per-date snapshot (payload fields: date/strike/call_gex/put_gex, no time) used from the open | `fetch_strike_profile(client, date)` | **prior session's** profile |
| Engine fed today-only bars (live gets ~6 sessions) so the wall evaluator's 15m macro filter defaulted UP all morning | `fetch_bars(client, "SPY", date)` | 5 sessions of history |

The Unusual Whales subscription has lapsed (API 401), so corrected runs use `--cache-only`:
contracts absent from the on-disk cache are skipped and counted (about 23% of the widened
universe, mostly far strikes). The engine is also the post-pruning single-lane engine
(ORB_INDEX / VWAP_TREND removed), so trade counts are not comparable with the tables above.

## Corrected baseline (94 sessions, 61 entries per chain)

| | 0DTE primary | ≥3 DTE primary |
|---|---|---|
| Win rate | 25% | 36% |
| Total / contract, PF | −$511.35, **0.66** | −$173.75, **0.90** |
| Expectancy / trade | −$8.38 ± 6.94 | −$2.85 ± 9.38 |
| Paired 3 DTE − 0DTE (n=60) | — | +$6.38 ± 6.86 (+0.9 SE); return on premium +2.0% ± 3.4 |

Post-T1 exit alternatives, paired against the live rule: all **negative** and within noise
(0DTE: −$1.42 ± 1.50, −$0.67 ± 1.69, −$1.14 ± 1.64; 3 DTE: −$0.96 ± 1.76 ×2, −$2.68 ± 1.85).
The conclusion "keep the live exit rule" stands and is now slightly stronger.

## Per family, corrected (0DTE; 3 DTE in parentheses)

| Family | n | Mean/trade | SE from zero | Wins |
|---|---|---|---|---|
| **GEX_WALL_REJECTION** | 10 | **−$46.47 ± 5.05** (−$42.81 ± 27.67) | **−9.2** (−1.6) | **0/10** (2/10) |
| MTF_TREND_BREAK | 15 | −$23.60 ± 10.59 (−$16.46 ± 10.73) | −2.2 (−1.5) | 4/15 |
| CONTINUATION | 26 | +$5.81 ± 9.43 (+$10.80 ± 11.71) | +0.6 (+0.9) | 9/26 (13/26) |
| GEX_WALL_BREAK_FAIL | 10 | +$15.63 ± 26.62 (+$22.05 ± 35.02) | +0.6 (+0.6) | 2/10 (3/10) |

The important reversal: **GEX_WALL_REJECTION**, which the flattering replay showed as the
best family (+$12/trade), loses on every one of its ten 0DTE entries once the walls come
from the prior session and the macro filter is defined. Two caveats cut both ways: the
replay's walls are a daily proxy while live uses ZeroGEX's intraday walls, and n=10. It is
nevertheless the family with the worst evidence now, and the one that was previously
described as "validated".

Time of day: before 11:00 ET −$13.27 ± 6.77 (n=53), after +$24.01 ± 26.90 (n=8) — the
same sign as the earlier corrected cut and again noise; still no support for the 11:00 cutoff
as an edge.

## How much was each defect worth?

Ablation with only the fill look-ahead restored (`--legacy-fill-lookahead`, everything else
corrected): PF 0.70, −$6.58/trade, paired against the fully corrected run on 59 shared entries
**+$1.72 ± 5.14/trade (+0.3 SE)**, entries 2.4¢ cheaper on average. The fill bias was real
but small and direction-neutral. The reversal in the wall-rejection family and the drop in
the baseline come from the other fixes — prior-session wall levels, a defined 15m macro
filter from the open, and an open-anchored strike universe — together with the engine pruning.

## What this means

1. The honest baseline for the current engine on this window is **PF 0.66–0.90, negative
   expectancy**, not the near-breakeven picture reported this morning.
2. Every design conclusion drawn from this window since April is suspect to the degree it
   depended on the option-fill timing, the strike universe, or the wall levels. The
   wall-bounce removal and ORB removal were based on stop-outs in the underlying and survive;
   anything about wall REJECTION does not.
3. With the vendor gone, this cache is the last vendor replay. Forward evidence has to come
   from live capture (option_market_history, bars) through the backend replay-backtester,
   with the engine frozen. Treat 2026-09-06 as the start of the out-of-sample period.
