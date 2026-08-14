# Self-hosted LEAN shadow operations

The `lean-shadow` service is a read-only, self-hosted LEAN sidecar. It runs the
three current SPY lanes (`mtf`, `orb_index`, and `vwap_trend`) against its own
IBKR Gateway client and the shared read-only ZeroGEX/policy files. It cannot
access Postgres, SnapTrade/Wealthsimple credentials, JWTs, the paper account,
or any execution endpoint.

The backend remains the sole authority for shared-account risk, paper/live
order submission, broker reconciliation, and exits. LEAN may only send a
signed `signal-only-v2` snapshot to the backend. Its Python algorithm blocks
all common order APIs, and the IBKR Gateway connection must also be configured
**read-only** before enabling it. QuantConnect's stock Interactive Brokers
plugin uses client ID `0`; it does not expose a configurable client ID.

## Enable shadow mode

Set these deployment-secret values, then deploy through the existing CI/CD
workflow:

```dotenv
LEAN_SHADOW_ENABLED=true
LEAN_SHADOW_INGEST_SECRET=<a random value of at least 32 characters>
LEAN_IB_ACCOUNT=<the IBKR account identifier used by the read-only Gateway>
LEAN_AUTO_PROMOTE=true
```

Do not place the ingest secret in source control. CI only starts/pulls the
sidecar when `LEAN_SHADOW_ENABLED=true`; otherwise the existing Python strategy
engine is unchanged.

Before enabling, configure the shared IBKR Gateway session to reject trading
for all API clients and verify that it permits the SPY/QQQ historical,
option-chain, and streaming market-data subscriptions. The sidecar uses the
same Gateway host and port; the stock LEAN plugin connects as client ID 0 while
the existing Node market-data clients remain 21–23.

## What to monitor

`GET /api/services/health` now includes `leanShadow`, and authenticated users
can query `GET /api/lean-shadow`. A healthy sidecar reports `connected: true`,
`orderGuard: ARMED`, and a freshness below 15 seconds. The backend rejects a
snapshot unless its HMAC timestamp, nonce, signature, lane set, engine version,
and `execution_enabled: false` contract are valid.

If a LEAN order guard violation, stale feed, publisher failure, or invalid
snapshot occurs after promotion, the backend blocks new entries immediately.
Existing position exits stay with the backend. While flat, during the next
pre-market window, the backend falls back to the already-warm Python source.

## Promotion rule

Promotion runs automatically only in the 08:45–09:30 ET pre-market window,
with no `OPEN` or `PENDING_ORDER` position. Every lane must have at least ten
completed shadow sessions, each with at least 300 snapshots, at least 99%
healthy samples, at least one qualified plan, and at least 95% match rate among
qualified plans. Each lane must also have ten distinct qualified plan episodes.

The strict trade-plan comparison requires the same direction and expiry, a
strike difference no greater than one SPY strike, trigger/invalidation within
$0.05, and the final target within $0.10. A failed or insufficient session
extends shadow mode; it cannot promote early.
