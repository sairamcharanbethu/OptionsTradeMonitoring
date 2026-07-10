# MCP AI Tool Setup

This app exposes a Streamable HTTP MCP endpoint for guarded option trading:

```text
https://mcptrade.ssmedia.ca/mcp
```

Use this only with an app user that is allowed to trade. The MCP server uses the same app JWT authentication as the frontend.

## Prerequisites

1. Deploy the backend that includes the MCP route.
2. In the app, sign in as an admin and enable `Settings -> Connections -> MCP Trading Endpoint`.
3. For the trading user, configure:
   - Wealthsimple/SnapTrade connection.
   - Selected trading account.
   - Live trading acknowledgement.
4. Keep `MCP_TRADING_ENABLED=true` as an optional deployment default only. The Settings UI value overrides it once saved.

Expected public endpoint checks:

```bash
curl https://mcptrade.ssmedia.ca/mcp
```

If the kill switch is off, the response is:

```json
{"jsonrpc":"2.0","error":{"code":-32000,"message":"MCP trading is disabled."},"id":null}
```

If the kill switch is on but no JWT is supplied, the response is:

```json
{"jsonrpc":"2.0","error":{"code":-32000,"message":"Unauthorized MCP trading request."},"id":null}
```

## Get a JWT

Sign in through the app API and store the returned token outside prompts/chat history.

```bash
export OTM_MCP_JWT="$(
  curl -s -X POST https://tradestaging.ssmedia.ca/api/auth/signin \
    -H "Content-Type: application/json" \
    -d '{"username":"<username>","password":"<password>"}' \
  | jq -r '.token'
)"
```

Check that a token was returned:

```bash
test -n "$OTM_MCP_JWT" && test "$OTM_MCP_JWT" != "null" && echo "JWT ready"
```

If the MCP client later receives `Unauthorized MCP trading request`, sign in again and refresh `OTM_MCP_JWT`.

## Codex CLI

Register the remote MCP server with Codex:

```bash
codex mcp add options-trader \
  --url https://mcptrade.ssmedia.ca/mcp \
  --bearer-token-env-var OTM_MCP_JWT
```

Restart Codex after adding the server or after changing `OTM_MCP_JWT`.

## Generic MCP Client

Configure the client as a Streamable HTTP MCP server:

```json
{
  "mcpServers": {
    "options-trader": {
      "type": "streamable-http",
      "url": "https://mcptrade.ssmedia.ca/mcp",
      "headers": {
        "Authorization": "Bearer ${OTM_MCP_JWT}"
      }
    }
  }
}
```

Some clients use different field names, but the required pieces are the same:

- Transport: Streamable HTTP
- URL: `https://mcptrade.ssmedia.ca/mcp`
- Header: `Authorization: Bearer <app JWT>`

## Available Tools

### `get_trading_guardrails`

Read-only. Call this first. It returns whether MCP trading is enabled, the auth mode, allowed actions, quote validation limits, live trading acknowledgement status, and selected account status.

### `get_option_quote`

Read-only. Fetches a live IBKR option quote for inspection only. MCP order submission does not require this quote and does not block on IBKR market-data entitlements.

Input:

```json
{
  "symbol": "SPY",
  "optionType": "CALL",
  "strike": 640,
  "expiration": "2026-07-10"
}
```

### `place_option_trade`

Places one single-leg opening option order directly through SnapTrade/Wealthsimple after backend account, live-trading acknowledgement, duplicate-position, and idempotency checks.

Input:

```json
{
  "clientOrderId": "agent-unique-id-20260709-001",
  "symbol": "SPY",
  "optionType": "CALL",
  "action": "BUY_TO_OPEN",
  "strike": 640,
  "expiration": "2026-07-10",
  "quantity": 1,
  "orderType": "LIMIT",
  "premium": 1.25,
  "underlyingStopPrice": 635
}
```

Field notes:

- `quantity` is the number of option contracts.
- `orderType` can be `LIMIT` or `MARKET`.
- `premium` is required for `LIMIT` orders and is submitted as the exact per-contract limit price.
- `clientOrderId` must be stable for the same intended order. Reusing it makes retries idempotent.
- Allowed actions are `BUY_TO_OPEN` and `SELL_TO_OPEN`.
- `SELL_TO_OPEN` margin and eligibility checks are handled by SnapTrade/Wealthsimple.
- The MCP server does not require IBKR quote validation before submitting to SnapTrade/Wealthsimple.

### `get_order_status`

Read-only. Looks up a recent Wealthsimple/SnapTrade order by broker order id and refreshes local pending-order reconciliation.

Input:

```json
{
  "orderId": "broker-order-id"
}
```

Use the `orderId` returned by `place_option_trade` or `close_option_position`.

### `close_option_position`

Submits a closing order for an app-tracked open Wealthsimple option position.

Input:

```json
{
  "positionId": 123,
  "quantity": 1,
  "orderType": "MARKET",
  "reason": "USER_CONFIRMED_EXIT"
}
```

Limit close example:

```json
{
  "positionId": 123,
  "quantity": 1,
  "orderType": "LIMIT",
  "premium": 0.75,
  "reason": "USER_CONFIRMED_EXIT"
}
```

Close notes:

- Use `positionId`, not raw contract fields, so the server can verify ownership and open quantity.
- Omit `quantity` to close the full remaining position.
- The server derives the close action from the original entry:
  - `BUY_TO_OPEN` closes with `SELL_TO_CLOSE`.
  - `SELL_TO_OPEN` closes with `BUY_TO_CLOSE`.
- `premium` is required only for `LIMIT` close orders.
- The close order is reconciled later by SnapTrade order sync, same as entry orders.

## Recommended Agent Instruction

Paste this into the AI tool or agent that will use the MCP server:

```text
You have access to an Options Trade Monitoring MCP server named options-trader.

Before any trade:
1. Call get_trading_guardrails.
2. Stop if enabled is false, liveTradingAcknowledged is false, or hasSelectedSnapTradeAccount is false.
3. Ask the user for explicit confirmation of symbol, option type, action, strike, expiration, quantity, order type, and limit premium when applicable before calling place_option_trade.
4. Do not require get_option_quote before placing the order. The MCP server relays confirmed orders directly to SnapTrade/Wealthsimple.
5. Use LIMIT or MARKET only. For LIMIT orders, premium is the exact per-contract limit price.
6. Treat quantity as number of option contracts.
7. Generate a stable clientOrderId for each intended order and reuse it only for retries of the same order.
8. Never place multi-leg, rolling, or replacement orders through this MCP server.
9. For exits, call close_option_position with the app positionId. Do not manually choose SELL_TO_CLOSE or BUY_TO_CLOSE; the server derives the correct close action.
10. After place_option_trade or close_option_position, report orderId, tradeId, optionSymbol, positionId, positionStatus, executionStatus, action, orderType, and quantity when present.
11. Use get_order_status with the broker orderId when the user asks whether an entry or close has filled, rejected, canceled, or is still pending.
```
