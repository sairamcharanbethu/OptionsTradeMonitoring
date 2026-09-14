#!/usr/bin/env python3
"""Dump per-minute indicator output for one cached UW session.

Replays a cached day the same way ``uw_backtest.run_day`` does (same clock
monkeypatch, same forming-bar feed) but records the raw outputs of the
functions the ``se_kernel`` Rust extension replaces:

  * ``signal_engine.calculate_indicators`` for SPY and QQQ
  * ``signal_engine.calculate_entry_structure_context`` for SPY

One JSON line per simulated minute. Run it once with ``SE_KERNEL=python`` and
once with ``SE_KERNEL=rust`` and ``diff`` the files: they must be identical.
Never calls the vendor API (cache-only).

    python3 kernel_indicator_dump.py --date 2026-08-20 --out /tmp/py.jsonl
"""
from __future__ import annotations

import argparse
import json
import sys
import time

import signal_engine
import uw_backtest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--interval", type=int, default=60)
    args = parser.parse_args()

    uw_backtest.CACHE_ONLY = True
    client = uw_backtest.UWClient("cache-only")
    spy_bars = uw_backtest.fetch_bars_with_history(client, "SPY", args.date)
    qqq_bars = uw_backtest.fetch_bars_with_history(client, "QQQ", args.date)
    open_at, close_at = uw_backtest._session_bounds(args.date)

    real_time = time.time
    rows = 0
    try:
        with open(args.out, "w") as handle:
            for sim_minute in range(int(open_at) + 120, int(close_at), args.interval):
                sim_now = float(sim_minute) + 5.0
                time.time = lambda now=sim_now: now
                spy = uw_backtest.symbol_market(spy_bars, sim_now)
                qqq = uw_backtest.symbol_market(qqq_bars, sim_now)
                if spy["spot"] is None:
                    continue
                spy_ind = signal_engine.calculate_indicators(spy["bars"])
                qqq_ind = signal_engine.calculate_indicators(qqq["bars"])
                completed = signal_engine._completed_bars(spy["bars"])
                structure = signal_engine.calculate_entry_structure_context(completed)
                record = {
                    "t": sim_now,
                    "SPY": spy_ind,
                    "QQQ": qqq_ind,
                    "structure": structure,
                }
                # sort_keys so dict ordering can never mask a numeric diff
                handle.write(json.dumps(record, sort_keys=True) + "\n")
                rows += 1
    finally:
        time.time = real_time
    backend = signal_engine.kernel_backend() if hasattr(signal_engine, "kernel_backend") else "python"
    print(f"{args.date}: wrote {rows} minutes to {args.out} (kernel={backend})", file=sys.stderr)


if __name__ == "__main__":
    main()
