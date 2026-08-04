# Wall Reaction V1

Wall Reaction is a paper-only SPY/QQQ feature. It translates the `NewStrategy` wall-fade decision policy into the existing Node/React application without changing the Day Trading scanner, signal lifecycle, or `strategy-system` paper account.

## Runtime boundary

- ZeroGEX prefetch: SPY keeps using `/strategy-data/trade/zerogex.json`. A separate QQQ prefetch container writes `/strategy-data/wall-reaction/QQQ-zerogex.json`.
- Market data: the backend uses IBKR Gateway for underlying snapshots, one-minute bars, expirations, option chains, and exact-contract quotes.
- Macro data: a keyless Wall Reaction calendar combines a bundled schedule verified from BLS, BEA, Census, Federal Reserve, and ISM sources with the official BLS iCalendar and BEA release feeds. Blocking events stop new entries from 30 minutes before through 15 minutes after; informational events remain visible without closing the gate. Last-known-good live schedules are persisted in the Wall Reaction data directory, and entries fail closed when verified calendar coverage expires.
- Account: all decisions, orders, positions, and journal events use `wall-reaction-system`. Day Trading continues to use `strategy-system`.
- Execution: there is no broker-order call in the Wall Reaction routes or services. Every fill is recorded as `wall_reaction_paper`.

## Entry contract

Only `CALL_WALL_FADE` and `PUT_WALL_BOUNCE` can become candidates. Breakout codes are watch states and cannot enter.

An entry candidate requires all of the following:

1. Fresh provider timestamps for GEX, MSI, trap detection, and range-break data.
2. Positive GEX with spot above the gamma flip.
3. A provider-confirmed failed-breakout trap at a wall; a wick alone is insufficient.
4. No opposing loaded pressure, dealer-delta chase veto, confident opposing playbook, wall migration, or breakout mode.
5. A clear macro calendar and an open cash session at least 40 minutes before the close.
6. A provider breakout buffer, an invalidation beyond the frozen wall, T1 at 1R or better, and optional T2 at 2R or better.
7. The adaptive expiration: same-day before 13:00 ET when listed, otherwise the next listed expiration.
8. A fresh IBKR option quote with spread at most 5%, nonzero volume/open interest/IV, and absolute delta from 0.15 through 0.65.
9. The configured debit budget after the 0.25x or 0.50x policy multiplier.

The engine caps size at two contracts. Two contracts trim one at T1 and close the remainder at T2. A one-contract entry exits at T1.

## Manual approval and lifecycle

An administrator must arm the exact candidate from the Wall Reaction dashboard. An arm expires after five minutes. Before creating or filling the protected paper order, the backend rechecks candidate identity, provider age, macro status, the return through the frozen wall, contract identity, available cash, and the protected limit. The pending paper order expires after 60 seconds.

Open positions are repriced from the exact IBKR OSI contract. They close on invalidation, wall migration, their assigned structural target, a manual paper close, or ten minutes before the cash close. Quote failures leave the position open, mark feature health degraded, and retry; they do not fabricate a fill.

## Configuration

- `wall_reaction_enabled`: enables the independent evaluator. Default behavior is enabled unless explicitly set to `false`.
- `wall_reaction_max_risk_dollars`: base risk from $50 through $10,000; default $500.
- `STRIKEPILOT_CALENDAR_CONTACT`: monitored operator email included in the BLS calendar request User-Agent. Recommended for identifiable, policy-compliant automated retrieval.
- Existing `IBKR_HOST`, `IBKR_PORT`, `IBKR_CLIENT_ID_MARKET_DATA`, and `IBKR_MARKET_DATA_TYPE` settings remain the market-data path.

The bundled calendar is reviewed through the `coverageThrough` date reported on the Wall Reaction dashboard. Extend `wall-reaction-economic-calendar.ts` from official schedules before that date. A temporary BLS or BEA outage degrades calendar health but continues using cached and bundled schedules; it does not turn a covered empty day into an unavailable calendar.

Settings are available under **Settings > Wall Reaction**. The dashboard workspace is a separate top-level **Wall Reaction** tab and is labeled **Paper only**.

## Verification

Use the feature suite first:

```bash
cd backend && npm run test:wall-reaction
```

Then run the unchanged backend and frontend gates:

```bash
cd backend && npm test && npm run build
cd frontend && npm run build
python3 -m unittest discover -s strategy-engine -p 'test_*.py'
python3 -m unittest discover -s NewStrategy -p 'test_*.py'
docker-compose config --quiet
```

Database lifecycle tests must only run against an explicitly supplied disposable `PAPER_TEST_DATABASE_URL`.
