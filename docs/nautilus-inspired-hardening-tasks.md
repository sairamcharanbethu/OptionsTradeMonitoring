# Nautilus-Inspired Hardening Tasks

These tasks adapt useful NautilusTrader patterns into this app without importing the engine wholesale.

Execution rule: finish one task at a time. Each task must include a bug check, the narrowest relevant tests/builds, `git diff --check`, generated artifact cleanup, and a commit before starting the next task.

Status: all hardening tasks in this queue are completed.

## Completed Task 1: Durable Event Journal And Replay Audit

Goal: make scanner and execution lifecycle decisions queryable in order, including events before a position exists.

Implementation:
- Extend `trade_events` so events can be linked to `signal_id` as well as `position_id`.
- Record signal creation and execution skip/failure events with enough metadata to reconstruct the decision chain.
- Include signal-linked events in command-center replay output.

Bug check:
- Unit tests prove signal-linked events are persisted and command replay includes both signal and position events in order.
- Run `cd backend && npm test`.
- Run `cd backend && npm run build`.
- Run `git diff --check`.
- Restore generated `backend/dist` before commit.

Status: completed in prior work.

## Completed Task 2: Explicit Broker Order State Machine

Goal: remove ambiguous local order states by centralizing allowed transitions.

Implementation:
- Define a small order lifecycle helper for entry states: `LOCAL_BLOCKED`, `SUBMITTED`, `PENDING_RECONCILE`, `ACCEPTED`, `FILLED`, `REJECTED`, `STALE`, `REVIEW_REQUIRED`.
- Use it in pending reconciliation, watchdog, and execution failure paths.
- Record state transitions to the event journal.

Bug check:
- Unit tests cover allowed and rejected transitions, stale protected-limit handling, and broker reconciliation updates.
- Run `cd backend && npm test`.
- Run `cd backend && npm run build`.
- Run `git diff --check`.
- Restore generated `backend/dist` before commit.

Status: completed in prior work.

## Completed Task 3: Fill Realism Model For Replay

Goal: make replay less optimistic for 0DTE options that look good on direction but are hard to fill.

Implementation:
- Apply execution realism to replay trades.
- Penalize or skip fills with theoretical pricing, extreme spreads, weak liquidity, or stale quote metadata.
- Add replay output comparing raw PnL versus fill-realistic PnL.

Bug check:
- Unit tests prove wide-spread/low-liquidity replay trades are penalized or skipped while clean trades remain unchanged.
- Run `cd backend && npm test`.
- Run `cd backend && npm run build`.
- Run `git diff --check`.
- Restore generated `backend/dist` before commit.

Status: completed in prior work.

## Completed Task 4: Configuration Snapshots Per Signal

Goal: make historical replay use the settings that existed when the signal was created.

Implementation:
- Store scanner/risk/execution thresholds in `option_details` when a signal is created.
- Use the stored snapshot in replay and attribution when present.
- Keep current defaults as fallback for older signals.

Bug check:
- Unit tests prove replay prefers signal-local settings and falls back for legacy records.
- Run `cd backend && npm test`.
- Run `cd backend && npm run build`.
- Run `git diff --check`.
- Restore generated `backend/dist` before commit.

Status: completed in prior work.

## Completed Task 5: Decision Snapshot V1

Goal: persist one immutable scanner decision packet for every generated or blocked setup so each decision can be audited without refetching live APIs.

Implementation:
- Add a `decision_snapshot` JSON payload under `option_details` or a dedicated JSONB field if the existing shape becomes too large.
- Include symbol, market date, candle timestamp, scanner settings, macro snapshot, GEX snapshot, mega-cap internals, scoring weights, call/put score parts, selected side, threshold adjustments, option chain selection summary, and final blockers.
- Keep the snapshot read-only after creation.
- Surface a compact snapshot summary in the command center or signal details only if it helps debugging.

Bug check:
- Unit test signal creation with a generated setup and a blocked setup.
- Assert the snapshot contains macro/GEX/score inputs and does not mutate when current settings change.
- Run `cd backend && npm test`.
- Run `cd backend && npm run build`.
- Run `git diff --check`.
- Restore generated `backend/dist` before commit.
- Commit message: `Add signal decision snapshots`.

Status: completed in prior work.

## Completed Task 6: Snapshot-Based Replay And Drift Report

Goal: rerun historical scoring from saved decision snapshots and compare the original decision with current scoring code.

Implementation:
- Add replay logic that accepts a saved decision snapshot instead of live market/API fetches.
- Produce `originalDecision`, `replayedDecision`, `scoreDelta`, `gradeDelta`, `blockerDelta`, and `contractSelectionDelta`.
- Add a report endpoint or extend existing replay output with drift fields.
- Keep legacy replay fallback for signals without snapshots.

Bug check:
- Unit tests prove replay uses stored macro/GEX/settings instead of fresh APIs.
- Unit tests prove a changed threshold reports drift instead of silently rewriting history.
- Run `cd backend && npm test`.
- Run `cd backend && npm run build`.
- Run `git diff --check`.
- Restore generated `backend/dist` before commit.
- Commit message: `Add snapshot replay drift report`.

Status: completed in current work.

## Completed Task 7: Central Pre-Submit Risk Engine

Goal: put every live-order denial rule through one hard pre-submit risk layer before SnapTrade or any broker adapter is called.

Implementation:
- Create a small risk engine helper that returns `{ approved, denials, warnings, evidence }`.
- Move or wrap checks for daily limit, stale quote, missing bid/ask, max spread, max premium, theoretical pricing, duplicate exposure, macro contradiction, account selection, and live acknowledgement.
- Record risk decisions into the event journal.
- Keep UI blockers aligned with risk engine reason codes.

Bug check:
- Unit tests cover each denial reason and one clean approval.
- Unit tests prove broker execution is not called when risk denies.
- Run `cd backend && npm test`.
- Run `cd backend && npm run build`.
- Run `cd frontend && npm run build` if UI reason mapping changes.
- Run `git diff --check`.
- Restore generated `backend/dist` before commit.
- Commit message: `Add pre-submit risk engine`.

Status: completed in current work.

## Completed Task 8: Adapter Health Contracts And Freshness

Goal: normalize health and freshness for Yahoo, IBKR, SnapTrade, GEX, OpenRouter, Discord, Redis, and Postgres.

Implementation:
- Define one adapter health shape: `status`, `latencyMs`, `lastGoodAt`, `lastError`, `freshnessMs`, `degradedReason`, and `source`.
- Wrap existing health responses into the common shape without breaking current consumers.
- Update the terminal adapter matrix and system health page to use freshness and degraded reasons.

Bug check:
- Unit or route tests prove degraded adapters expose a reason and healthy adapters expose `lastGoodAt`.
- Frontend build proves the UI handles missing/legacy fields.
- Run `cd backend && npm test`.
- Run `cd backend && npm run build`.
- Run `cd frontend && npm run build`.
- Run `git diff --check`.
- Restore generated `backend/dist` before commit.
- Commit message: `Normalize adapter health contracts`.

Status: completed in current work.

## Completed Task 9: Option Instrument Cache And Selection Stability

Goal: reduce transient IBKR/API noise by caching option chain snapshots and selection evidence per symbol/expiry/time window.

Implementation:
- Cache normalized option chain snapshots for a short TTL keyed by symbol, expiry, and scan window.
- Persist selected and rejected candidate evidence in the decision snapshot.
- Reuse a cached chain within the same scanner cycle instead of refetching for every downstream step.
- Add cache bypass for manual force scan if needed.

Bug check:
- Unit tests prove repeated selection in the same window uses the same normalized chain.
- Unit tests prove stale cache is ignored after TTL.
- Run `cd backend && npm test`.
- Run `cd backend && npm run build`.
- Run `git diff --check`.
- Restore generated `backend/dist` before commit.
- Commit message: `Cache option chain selection inputs`.

Status: completed in current work.

## Completed Task 10: Deterministic Scanner Clock And Phase Split

Goal: make scanner behavior reproducible by passing one clock/context object through fetch, normalize, score, persist, and execute phases.

Implementation:
- Create a scanner cycle context containing `startedAt`, NY market date/time, market phase, user id, selected symbols, and cycle id.
- Split the scanner path into small functions: fetch inputs, normalize snapshot, score snapshot, persist decision, emit events, execute eligible signal.
- Replace scattered `new Date()` calls in scoring with the context clock.
- Keep public behavior unchanged.

Bug check:
- Unit tests pass a fixed clock and assert expiry selection, afternoon threshold inflation, and macro assessment are deterministic.
- Run `cd backend && npm test`.
- Run `cd backend && npm run build`.
- Run `git diff --check`.
- Restore generated `backend/dist` before commit.
- Commit message: `Add deterministic scanner cycle context`.

Status: completed in current work.

## Completed Task 11: Performance Pass For Scanner I/O

Goal: reduce scanner latency and duplicate network calls without changing strategy behavior.

Implementation:
- Measure current scan phase timings with structured logs or existing event journal metadata.
- Parallelize independent fetches where safe: macro, mega-cap internals, GEX, and option chain inputs.
- Add per-cycle timing evidence to the decision snapshot.
- Keep ordering deterministic for scoring and persistence.

Bug check:
- Unit tests prove scoring output is unchanged for the same normalized inputs.
- Build/test run confirms no async race introduced.
- Run `cd backend && npm test`.
- Run `cd backend && npm run build`.
- Run `git diff --check`.
- Restore generated `backend/dist` before commit.
- Commit message: `Add scanner phase timing and IO cleanup`.

Status: completed in current work.

## Completed Working Order

1. Task 5: Decision Snapshot V1.
2. Task 6: Snapshot-Based Replay And Drift Report.
3. Task 7: Central Pre-Submit Risk Engine.
4. Task 8: Adapter Health Contracts And Freshness.
5. Task 9: Option Instrument Cache And Selection Stability.
6. Task 10: Deterministic Scanner Clock And Phase Split.
7. Task 11: Performance Pass For Scanner I/O.

Do not start the next task until the previous task is committed and `git status --short` is clean.
