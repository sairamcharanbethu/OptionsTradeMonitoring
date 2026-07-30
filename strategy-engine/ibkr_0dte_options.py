#!/usr/bin/env python3
"""Read-only IBKR 0DTE option snapshot for candidate contract selection.

Default use:
    python3 ibkr_0dte_options.py
    python3 ibkr_0dte_options.py --data-type delayed-frozen
    python3 ibkr_0dte_options.py --expiry 20260709 --underlying SPY
"""

from __future__ import annotations

import argparse
import math
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from ib_insync import IB, Option, Stock, util

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 4001
DEFAULT_CLIENT_ID = 88
DEFAULT_UNDERLYING = "SPY"
DEFAULT_EXCHANGE = "SMART"
DEFAULT_CURRENCY = "USD"
DEFAULT_STRIKES_PER_SIDE = 4
DATA_TYPES = {
    "live": 1,
    "frozen": 2,
    "delayed": 3,
    "delayed-frozen": 4,
}


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not math.isnan(value)


def _fmt(value: Any, digits: int = 2) -> str:
    if not _is_number(value):
        return "-"
    return f"{value:.{digits}f}".rstrip("0").rstrip(".")


def _mid(bid: Any, ask: Any) -> float | None:
    if _is_number(bid) and _is_number(ask) and ask > 0:
        return (bid + ask) / 2
    return None


def _quote(value: Any) -> float | None:
    if _is_number(value) and value >= 0:
        return float(value)
    return None


def _spread_pct(bid: Any, ask: Any) -> float | None:
    mid = _mid(bid, ask)
    if mid and mid > 0:
        return (ask - bid) / mid * 100
    return None


def _ticker_price(ticker: Any) -> float:
    price = ticker.marketPrice()
    if _is_number(price) and price > 0:
        return float(price)
    for attr in ("last", "close", "bid", "ask"):
        value = getattr(ticker, attr, None)
        if _is_number(value) and value > 0:
            return float(value)
    raise RuntimeError("No usable underlying price from IBKR market data")


def _select_chain(chains: list[Any], symbol: str) -> Any:
    smart = [chain for chain in chains if chain.exchange == "SMART"]
    exact = [chain for chain in smart if chain.tradingClass == symbol]
    if exact:
        return exact[0]
    if smart:
        return smart[0]
    if chains:
        return chains[0]
    raise RuntimeError(f"No option chain returned for {symbol}")


def _select_expiry(expirations: list[str], requested: str | None) -> tuple[str, bool]:
    today = datetime.now(ZoneInfo("America/New_York")).strftime("%Y%m%d")
    sorted_expirations = sorted(expirations)
    if requested:
        if requested not in expirations:
            raise RuntimeError(f"Requested expiry {requested} not found")
        return requested, requested == today
    if today in expirations:
        return today, True
    future = [expiry for expiry in sorted_expirations if expiry > today]
    if future:
        return future[0], False
    return sorted_expirations[-1], False


def _select_strikes(strikes: list[float], spot: float, count: int) -> tuple[list[float], list[float]]:
    valid = sorted(float(strike) for strike in strikes if strike > 0)
    calls = [strike for strike in valid if strike >= spot][: count + 1]
    puts = [strike for strike in reversed(valid) if strike <= spot][: count + 1]
    if not calls or not puts:
        nearest = sorted(valid, key=lambda strike: abs(strike - spot))[: count * 2]
        calls = sorted(nearest)
        puts = sorted(nearest, reverse=True)
    return calls[:count], puts[:count]


def _contract(symbol: str, expiry: str, strike: float, right: str, trading_class: str) -> Option:
    return Option(
        symbol=symbol,
        lastTradeDateOrContractMonth=expiry,
        strike=strike,
        right=right,
        exchange=DEFAULT_EXCHANGE,
        currency=DEFAULT_CURRENCY,
        tradingClass=trading_class,
    )


def _summarize_ticker(label: str, ticker: Any) -> str:
    contract = ticker.contract
    bid = _quote(ticker.bid)
    ask = _quote(ticker.ask)
    mid = _mid(bid, ask)
    spread = _spread_pct(bid, ask)
    greeks = ticker.modelGreeks or ticker.bidGreeks or ticker.askGreeks or ticker.lastGreeks
    delta = getattr(greeks, "delta", None) if greeks else None
    volume = ticker.volume if _is_number(ticker.volume) else None

    flags = []
    if spread is not None and spread > 20:
        flags.append("wide")
    if not _is_number(bid) or not _is_number(ask) or ask <= 0:
        flags.append("noquote")

    return " | ".join(
        [
            label,
            f"{contract.localSymbol or contract.symbol} {contract.right}{_fmt(contract.strike)}",
            f"bid {_fmt(bid)}",
            f"ask {_fmt(ask)}",
            f"mid {_fmt(mid)}",
            f"spr {_fmt(spread, 1)}%",
            f"delta {_fmt(delta, 2)}",
            f"vol {_fmt(volume, 0)}",
            ",".join(flags) if flags else "ok",
        ]
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Fetch compact IBKR 0DTE option candidates")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--client-id", type=int, default=DEFAULT_CLIENT_ID)
    parser.add_argument("--underlying", default=DEFAULT_UNDERLYING)
    parser.add_argument("--expiry", help="YYYYMMDD. Defaults to today's expiry if listed.")
    parser.add_argument("--strikes-per-side", type=int, default=DEFAULT_STRIKES_PER_SIDE)
    parser.add_argument(
        "--data-type",
        choices=sorted(DATA_TYPES),
        default="live",
        help="IBKR market data type. Use delayed-frozen outside regular hours if needed.",
    )
    args = parser.parse_args()

    symbol = args.underlying.upper()
    ib = IB()
    try:
        ib.connect(args.host, args.port, clientId=args.client_id, timeout=5, readonly=True)
        ib.reqMarketDataType(DATA_TYPES[args.data_type])

        stock = Stock(symbol, DEFAULT_EXCHANGE, DEFAULT_CURRENCY)
        ib.qualifyContracts(stock)
        underlying_ticker = ib.reqTickers(stock)[0]
        spot = _ticker_price(underlying_ticker)

        chains = ib.reqSecDefOptParams(symbol, "", stock.secType, stock.conId)
        chain = _select_chain(chains, symbol)
        expiry, is_0dte = _select_expiry(list(chain.expirations), args.expiry)
        calls, puts = _select_strikes(list(chain.strikes), spot, args.strikes_per_side)

        contracts = [
            _contract(symbol, expiry, strike, "C", chain.tradingClass) for strike in calls
        ] + [_contract(symbol, expiry, strike, "P", chain.tradingClass) for strike in puts]
        qualified = ib.qualifyContracts(*contracts)
        tickers = ib.reqTickers(*qualified)

        print(
            f"IBKR {symbol} spot {_fmt(spot)} expiry {expiry} "
            f"{'0DTE' if is_0dte else 'NOT_0DTE'} chain {chain.tradingClass}/{chain.exchange} "
            f"data {args.data_type}"
        )
        for ticker in sorted(
            tickers,
            key=lambda item: (item.contract.right, abs(item.contract.strike - spot)),
        ):
            label = "CALL" if ticker.contract.right == "C" else "PUT "
            print(_summarize_ticker(label, ticker))
    finally:
        if ib.isConnected():
            ib.disconnect()


if __name__ == "__main__":
    util.patchAsyncio()
    main()
