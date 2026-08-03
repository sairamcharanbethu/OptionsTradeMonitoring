# Strategy engine provenance

The deterministic SPY strategy and GEX modules.

Included behavior is the broker-free `signal-only-v2` engine, its read-only
IBKR prefetch loop, ZeroGEX normalization/prefetch, and dormant SSCGEX/local
GEX compatibility. Robinhood execution, TradingView handoff, and AI escalation
are intentionally excluded.

Local integration changes must preserve `execution_enabled: false` in the
strategy output. Broker execution remains owned by the Node backend and its
explicit per-order confirmation path.
