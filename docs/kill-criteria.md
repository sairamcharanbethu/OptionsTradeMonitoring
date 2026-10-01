# Kill criteria for the swing system

Written 2026-10-01, when the app was paper-only. These are the numbers that
decide, in advance, when the strategy is treated as not working. They exist
so the decision is not made in the moment after a bad week.

The weekly parity report (`weekly-parity-report-service.ts`, Fridays 16:45 ET,
posted to Discord) evaluates every rule below per lane and marks breaches.
Breaches **flag** paper lanes and **pause** live entries when live trading is
on; nothing here closes an open position.

## Evidence thresholds (what counts as "we know")

| Milestone | Closed trades per lane | Meaning |
|---|---|---|
| Noise | < 30 | Report numbers but draw no conclusion. |
| Preliminary | 30 to 99 | Compare lanes to each other and to the backtest benchmark; act only on kill rules. |
| Decision | >= 100 | Promote / retire variants; consider lifting the one-contract clamp live. |

## Kill rules (evaluated on the most recent 30 closed trades of a lane)

| Rule | Threshold | Action (paper) | Action (live) |
|---|---|---|---|
| Rolling profit factor | PF < 0.90 with >= 30 closed trades | flag `PF_BELOW_FLOOR` | pause live entries until reviewed |
| Win rate vs benchmark | z-score <= -2.0 against the backtest win rate (binomial, benchmark p, lane n), n >= 30 | flag `WIN_RATE_BELOW_BENCHMARK` | pause live entries |
| Realized drawdown from peak | > $1,000 per lane (one-contract lanes; ~2 full premium-stop losers back to back on a $5 contract) | flag `DRAWDOWN_LIMIT` | pause live entries |
| Expectancy sign | average P&L per trade < 0 with >= 50 closed trades | flag `NEGATIVE_EXPECTANCY` | pause live entries |
| Exit-mix anomaly | > 60% of the last 30 exits are `*_PREMIUM_STOP` | flag `STOP_HEAVY` (entries are getting run over, not managed) | review, no automatic pause |

The daily loss kill switch (`daily_loss_limit_dollars`) stays as the
intraday circuit breaker; these rules are the slower, evidence-based layer.

## Promotion rule for a variant

A variant replaces the live rule set only when, over >= 100 closed trades in
both lanes, its profit factor exceeds the baseline lane's by at least 0.2 AND
its realized drawdown is not worse. One change at a time: a promoted variant
becomes the new baseline and the other lanes are re-derived from it.

## Benchmark

`shared/swing-expectations.json` holds the swing backtest summary over the
frozen Unusual Whales cache (modelled Black-Scholes premiums; read the
backtest docstring before trusting it). The report shows it next to each
lane; it is a reference, not a target, and is not updated by live data.

## Review log

| Date | Lane | Rule | Value | Decision |
|------|------|------|-------|----------|
|      |      |      |       |          |
