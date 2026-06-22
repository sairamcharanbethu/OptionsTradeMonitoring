# AGENTS.md

## Repository Expectations

- Read this file before making changes in this repository.
- Check `git status --short` before editing and do not revert unrelated user changes.
- Prefer `rg`/`rg --files` for repo inspection.
- Keep changes scoped to the requested behavior; avoid unrelated refactors.
- After editing generated build output during verification, do not commit regenerated artifacts unless they are intentional.

## Behavioral Guidelines

These guidelines bias toward caution over speed. For trivial tasks, use judgment.

### Think Before Coding

Do not assume, hide confusion, or silently pick among unclear interpretations.

- State assumptions explicitly before implementing.
- If multiple interpretations exist, present them instead of choosing silently.
- If a simpler approach exists, say so and push back when warranted.
- If something is unclear, stop, name what is confusing, and ask.

### Simplicity First

Use the minimum code that solves the problem. Do not add speculative flexibility.

- Do not build features beyond what was asked.
- Do not create abstractions for single-use code.
- Do not add configurability that was not requested.
- Do not add error handling for impossible scenarios.
- If a solution is much larger than necessary, rewrite it smaller.

Ask: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### Surgical Changes

Touch only what is necessary and clean up only changes introduced by the current work.

- Do not improve adjacent code, comments, or formatting.
- Do not refactor unrelated code.
- Match existing style, even when another style seems preferable.
- If unrelated dead code is noticed, mention it instead of deleting it.
- Remove imports, variables, or functions made unused by the current change.
- Do not remove pre-existing dead code unless asked.

Every changed line should trace directly to the user's request.

### Goal-Driven Execution

Turn tasks into verifiable goals and loop until verified.

- For validation work, write or identify invalid-input checks, then make them pass.
- For bug fixes, reproduce the bug with a focused check when practical, then make it pass.
- For refactors, preserve behavior and run relevant checks before and after when practical.
- For multi-step tasks, state a brief plan with the verification step for each item.

Strong success criteria reduce unnecessary changes, overcomplication, and late clarification.

## Runtime And Topology

- Backend runtime is Node.js 22 or newer. Keep `backend/package.json` and `backend/Dockerfile` aligned with that floor.
- Keep ThetaData inside the backend container. The backend should start Theta Terminal v3 in the same container and communicate with it over `127.0.0.1` ports.
- Do not split Theta Terminal into a separate sidecar/container service unless the user explicitly asks for that architecture change.
- Treat `THETADATA_BASE_URL=http://127.0.0.1:25503` and `THETADATA_STREAM_URL=ws://127.0.0.1:25520/v1/events` as the intended container-local defaults.

## Verification Commands

- Backend build: `cd backend && npm run build`
- Backend tests: `cd backend && npm test`
- Frontend build: `cd frontend && npm run build`
- Full Docker runtime: `docker-compose up -d --build`

Run the narrowest relevant verification for the files changed. If a command cannot be run, report why.

## Debugging Notes

- For stale latest-signal/order state, distinguish stale clients from duplicate socket bugs with backend `legacy` and `activeForClient` logging before changing websocket behavior.
- For training/history parsing issues, remember that `stock_history_cache.data` is JSON-shaped and should be parsed defensively.
- For broker order status mismatches, check SnapTrade pending-order sync and fill evidence before changing UI status rendering.
