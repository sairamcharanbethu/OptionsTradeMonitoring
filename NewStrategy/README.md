# ZeroGEX Scanner v5

This is an accuracy-first rewrite of `premarket_bias_scanner_v4.py`. It keeps
regime, direction, structure, and execution confirmation as separate inputs.

## API Map

| Endpoint | Role | Failure behavior |
| --- | --- | --- |
| `/api/v1/levels/{symbol}` | Spot, age, Net GEX at spot, flip, walls, max pain | Required; stale or missing data stands down |
| `/api/signals/score` | Nondirectional MSI regime | Required; never converted into bullish/bearish direction |
| `/api/signals/advanced/trap-detection` | Failed breakout and wall-migration confirmation | Required for wall reactions |
| `/api/signals/advanced/range-break-imminence` | Range vs. break regime and break direction | Required; `>=65` requires confirmed/retest logic |
| `/api/signals/advanced/market-pressure` | Loaded hedging/flow direction | Optional, but missing data lowers confidence |
| `/api/signals/trade-bias` | Intraday directional bias | Optional, but missing data lowers confidence |
| `/api/signals/basic` | Six continuous directional reads in one request | Optional; dealer-delta chase risk can veto a fade |
| `/api/signals/action` | ZeroGEX Playbook Engine cross-check | Optional; confident opposing Cards veto a fade |
| `/api/signals/advanced/0dte-position-imbalance` | Same-day flow direction | Optional; opposing triggers reduce size |
| `/api/signals/advanced/gamma-vwap-confluence` | Magnet/continuation direction | Optional; opposing triggers reduce size |
| `/api/market/historical` | Actual 09:30 ET opening bar | Optional; missing gap data reduces size |
| `/api/market/session-closes` | Previous completed cash close | Optional; used with the opening bar for the true gap |
| `/api/market/session-levels` | Premarket and prior-session high/low | Optional context and logging |
| `/api/market/volatility` | VIX/VXN level and momentum | Optional; Elevated reduces size, Extreme stands down |

## Decision Rules

- Positive GEX supports wall absorption. Negative GEX suppresses wall reactions.
- MSI describes market character only. Direction comes from directional APIs.
- A wall reaction requires the corresponding triggered trap signal.
- Wall migration immediately invalidates the reaction.
- Migration never creates an at-market flip. Two independent breakout signals
  produce a watch that still requires acceptance and a retest.
- An opening gap greater than 0.50% against the reaction reduces size; it is not
  a universal suppression gate.
- Stops are never widened and positions are never averaged down.
- All size multipliers are relative to an independently configured maximum
  per-trade risk. They are not percentages of account equity.

## Run

```bash
export ZEROGEX_API_TOKEN="..."
python3 premarket_bias_scanner_v5.py --symbols SPY,QQQ
```

For machine-readable output and an audit log:

```bash
python3 premarket_bias_scanner_v5.py \
  --json \
  --log-jsonl ./output/zerogex_decisions.jsonl
```

Override macro risk when the embedded calendar is incomplete:

```bash
python3 premarket_bias_scanner_v5.py \
  --event-risk high \
  --event-name "ISM Manufacturing PMI" \
  --event-time 10:00
```

## Verify

```bash
python3 -m unittest -v test_premarket_bias_scanner_v5.py
```

## Remaining Limits

- The embedded macro calendar is intentionally limited. Connect a maintained
  economic-calendar feed before using the scanner unattended.
- v5 does not select an option contract. Accurate selection needs live bid/ask,
  delta, IV, open interest, spread, and liquidity filters. A price-derived strike
  is not an acceptable substitute.
- ZeroGEX GEX and dealer positioning are modeled estimates, not observed dealer
  inventory.
- The ZeroGEX Action Card documentation notes that open-position awareness and
  persistence/hysteresis are not yet active. v5 uses it as a cross-check only.
- This tool needs replay/backtest validation before any sizing multiplier is
  promoted above the conservative defaults.
