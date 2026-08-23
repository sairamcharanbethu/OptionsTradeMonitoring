#!/usr/bin/env python3
"""One-time UW harvest before token expiry — bank everything reachable.

The API token is temporary; the disk cache (uw_cache/) is forever. Priority:
  A. Daily Greek-exposure aggregates (SPY, QQQ) — full year, 2 calls.
  B. SPY + QQQ 1m OHLC — as far back as the plan serves (probed by year).
  C. Window-day depth (2026-04-14..today): per-expiry GEX, per-strike intraday
     spot exposures, QQQ GEX — optionality for future research, cheap now.

Resumable: every response caches on disk; re-running skips banked data.
403s are recorded and skipped (plan limits), not fatal.
"""
from __future__ import annotations

import sys
import urllib.error
from datetime import date, timedelta

from uw_backtest import UWClient, _load_token

START_WINDOW = date(2026, 4, 14)


def trading_days(start: date, end: date):
    day = start
    while day <= end:
        if day.weekday() < 5:
            yield day.isoformat()
        day += timedelta(days=1)


def safe_get(client, path, params=None):
    try:
        return client.get(path, params)
    except urllib.error.HTTPError as err:
        return {"_error": err.code}
    except Exception as exc:
        return {"_error": str(exc)}


def main() -> None:
    client = UWClient(_load_token())
    today = date.today()

    print("A. daily greek-exposure aggregates", flush=True)
    for symbol in ("SPY", "QQQ"):
        payload = safe_get(client, f"stock/{symbol}/greek-exposure")
        rows = len(payload.get("data") or []) if isinstance(payload, dict) else 0
        print(f"  {symbol}: {rows} daily rows ({payload.get('_error', 'ok')})", flush=True)

    print("B. 1m OHLC depth probe + bank", flush=True)
    earliest = None
    for probe_year in (2022, 2023, 2024, 2025):
        payload = safe_get(client, "stock/SPY/ohlc/1m", {"date": f"{probe_year}-03-01", "limit": 2})
        if isinstance(payload, dict) and payload.get("data"):
            earliest = date(probe_year, 1, 1)
            break
    if earliest is None:
        earliest = date(2025, 9, 1)
    print(f"  banking SPY+QQQ 1m bars from {earliest} to {today}", flush=True)
    count = 0
    for day in trading_days(earliest, today):
        for symbol in ("SPY", "QQQ"):
            payload = safe_get(client, f"stock/{symbol}/ohlc/1m", {"date": day, "limit": 1500})
            if isinstance(payload, dict) and payload.get("_error"):
                print(f"  {day} {symbol}: {payload['_error']}", flush=True)
        count += 1
        if count % 50 == 0:
            print(f"  ...{count} days banked (through {day})", flush=True)

    print("C. window-day depth", flush=True)
    for day in trading_days(START_WINDOW, today):
        safe_get(client, "stock/SPY/greek-exposure/expiry", {"date": day})
        safe_get(client, "stock/SPY/spot-exposures/strike", {"date": day})
        safe_get(client, "stock/QQQ/spot-exposures", {"date": day})
        safe_get(client, "stock/QQQ/greek-exposure/strike", {"date": day})
    print("harvest complete", flush=True)


if __name__ == "__main__":
    main()
