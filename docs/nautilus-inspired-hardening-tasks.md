# Nautilus-Inspired Hardening Tasks

These tasks adapt the useful NautilusTrader patterns into this app without importing the engine wholesale.

## Task 1: Durable Event Journal And Replay Audit

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

## Task 2: Explicit Broker Order State Machine

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

## Task 3: Fill Realism Model For Replay

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

## Task 4: Configuration Snapshots Per Signal

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
