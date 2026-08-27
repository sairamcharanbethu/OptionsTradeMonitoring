#!/usr/bin/env python3
"""Cache ZeroGEX data independently from the latency-sensitive trade loop."""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import time
from pathlib import Path
from typing import Any

from zerogex_client import (
    ZeroGEXAuthError,
    fetch_component_snapshot,
    fetch_snapshot,
    get_api_key,
    render_text,
)

LANE_FIELDS = {
    "core": (
        "trade_bias",
        "basic_signals",
        "composite",
        "playbook",
        "market_quote",
        "market_bars",
    ),
    "deep": (
        "advanced_signals",
        "gex_history",
        "market_volatility",
        "strike_context",
        "flow_context",
        "session_context",
        "dealer_hedging",
        "forced_flow",
    ),
}

# Raw request-spec names whose v2 freshness envelopes belong to each lane
# (freshness is keyed by raw component name, not the normalized field name).
LANE_FRESHNESS_KEYS = {
    "core": (
        "trade_bias",
        "basic_signals",
        "composite",
        "playbook",
        "market_quote",
        "market_bars",
    ),
    "deep": (
        "gex_history",
        "market_volatility",
        "strike_profile",
        "flow_series",
        "smart_money",
        "session_levels",
        "technicals",
        "dealer_hedging",
        "forced_flow_levels",
    ),
}


def _lane_freshness(lane: str, freshness: dict[str, Any]) -> dict[str, Any]:
    keys = LANE_FRESHNESS_KEYS.get(lane, ())
    return {
        name: entry
        for name, entry in (freshness or {}).items()
        if name in keys or (lane == "deep" and name.startswith("advanced:"))
    }


def _atomic_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, separators=(",", ":")))
    temporary.replace(path)


def _health_payload(
    status: str,
    *,
    symbol: str,
    mode: str,
    snapshot: dict[str, Any] | None = None,
    error: str | None = None,
    polling: dict[str, Any] | None = None,
) -> dict[str, Any]:
    bias = (snapshot or {}).get("trade_bias") or {}
    gex = (snapshot or {}).get("gex_summary") or {}
    composite = (snapshot or {}).get("composite") or {}
    playbook = (snapshot or {}).get("playbook") or {}
    market_quote = (snapshot or {}).get("market_quote") or {}
    strike_context = (snapshot or {}).get("strike_context") or {}
    flow_context = (snapshot or {}).get("flow_context") or {}
    session_context = (snapshot or {}).get("session_context") or {}
    dealer_hedging = (snapshot or {}).get("dealer_hedging") or {}
    forced_flow = (snapshot or {}).get("forced_flow") or {}
    return {
        "updated_at": time.time(),
        "status": status,
        "source": "zerogex",
        "mode": mode,
        "symbol": symbol,
        "last_good_at": (snapshot or {}).get("fetched_at"),
        "provider_timestamps": {
            "gex_summary": gex.get("timestamp"),
            "trade_bias": bias.get("timestamp"),
            "composite": composite.get("timestamp"),
            "playbook": playbook.get("timestamp"),
            "market_quote": market_quote.get("timestamp"),
            "strike_context": strike_context.get("timestamp"),
            "flow_context": flow_context.get("timestamp"),
            "session_context": session_context.get("timestamp"),
            "dealer_hedging": dealer_hedging.get("timestamp"),
            "forced_flow": forced_flow.get("timestamp"),
        },
        "endpoint_errors": (snapshot or {}).get("endpoint_errors") or {},
        "freshness_status": {
            name: entry.get("freshness_status")
            for name, entry in ((snapshot or {}).get("freshness") or {}).items()
            if isinstance(entry, dict)
        },
        "polling": dict(polling or {}),
        "error": error,
    }


def _merge_cached_context(
    snapshot: dict[str, Any],
    previous_snapshot: dict[str, Any] | None,
) -> None:
    if not previous_snapshot:
        return
    for fields in LANE_FIELDS.values():
        for field in fields:
            snapshot[field] = previous_snapshot.get(field)
    merged_freshness = dict(snapshot.get("freshness") or {})
    for lane in LANE_FRESHNESS_KEYS:
        merged_freshness.update(
            _lane_freshness(lane, previous_snapshot.get("freshness") or {})
        )
    snapshot["freshness"] = merged_freshness


def _apply_lane_result(
    snapshot: dict[str, Any],
    lane: str,
    lane_snapshot: dict[str, Any],
) -> dict[str, str]:
    for field in LANE_FIELDS[lane]:
        snapshot[field] = lane_snapshot.get(field)
    snapshot.setdefault("freshness", {}).update(
        _lane_freshness(lane, lane_snapshot.get("freshness") or {})
    )
    return dict(lane_snapshot.get("endpoint_errors") or {})


def _polling_status(
    lane_state: dict[str, dict[str, Any]],
    *,
    gex_interval: float,
    core_interval: float,
    deep_interval: float,
) -> dict[str, Any]:
    return {
        "gex_summary_interval_seconds": gex_interval,
        "core_context_interval_seconds": core_interval,
        "deep_context_interval_seconds": deep_interval,
        "core_in_flight": lane_state["core"].get("future") is not None,
        "deep_in_flight": lane_state["deep"].get("future") is not None,
        "last_core_started_at": lane_state["core"].get("last_started_at"),
        "last_core_completed_at": lane_state["core"].get("last_completed_at"),
        "last_deep_started_at": lane_state["deep"].get("last_started_at"),
        "last_deep_completed_at": lane_state["deep"].get("last_completed_at"),
    }


def _run_once(
    args: argparse.Namespace,
    *,
    symbol: str,
) -> None:
    key = get_api_key(args.env_file)
    snapshot = fetch_snapshot(
        symbol,
        api_key=key,
        timeout=args.timeout,
        include_extended=True,
    )
    snapshot["mode"] = args.mode
    _atomic_json(args.output_file, snapshot)
    _atomic_json(
        args.health_file,
        _health_payload(
            "ok",
            symbol=symbol,
            mode=args.mode,
            snapshot=snapshot,
            polling={
                "gex_summary_interval_seconds": args.interval,
                "core_context_interval_seconds": args.context_interval,
                "deep_context_interval_seconds": args.deep_interval,
                "one_shot": True,
            },
        ),
    )
    print(
        render_text(snapshot).replace(
            "ZEROGEX ANALYTICS",
            f"ZEROGEX {args.mode.upper()}",
            1,
        ),
        flush=True,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Prefetch read-only ZeroGEX analytics")
    parser.add_argument("--symbol", default="SPY")
    parser.add_argument("--mode", choices=("primary", "shadow"), default="shadow")
    parser.add_argument(
        "--interval",
        type=float,
        default=5,
        help="Seconds between independent GEX-summary reads.",
    )
    parser.add_argument(
        "--context-interval",
        type=float,
        default=15,
        help="Seconds between core signal, quote, and bar context reads.",
    )
    parser.add_argument(
        "--deep-interval",
        type=float,
        default=30,
        help="Seconds between advanced-signal, volatility, and historical-context reads.",
    )
    parser.add_argument("--timeout", type=float, default=10)
    parser.add_argument("--error-interval", type=float, default=30)
    parser.add_argument("--auth-error-interval", type=float, default=300)
    parser.add_argument("--env-file", type=Path, default=Path(".env"))
    parser.add_argument(
        "--output-file", type=Path, default=Path("gex-data/trade/zerogex.json")
    )
    parser.add_argument(
        "--health-file",
        type=Path,
        default=Path("gex-data/trade/zerogex-health.json"),
    )
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    if min(args.interval, args.context_interval, args.deep_interval) <= 0:
        parser.error("polling intervals must be greater than zero")
    symbol = args.symbol.upper()
    if args.once:
        try:
            _run_once(args, symbol=symbol)
        except ZeroGEXAuthError as exc:
            print(f"ZEROGEX {args.mode.upper()} AUTH ERROR: {exc}", flush=True)
            raise SystemExit(2) from exc
        return

    last_good: dict[str, Any] | None = None
    lane_errors: dict[str, dict[str, str]] = {"core": {}, "deep": {}}
    lane_state: dict[str, dict[str, Any]] = {
        "core": {
            "future": None,
            "last_started_mono": None,
            "last_started_at": None,
            "last_completed_at": None,
        },
        "deep": {
            "future": None,
            "last_started_mono": None,
            "last_started_at": None,
            "last_completed_at": None,
        },
    }
    lane_intervals = {
        "core": args.context_interval,
        "deep": args.deep_interval,
    }

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        while True:
            started = time.time()
            started_mono = time.monotonic()
            next_interval = args.interval

            for lane, state in lane_state.items():
                future = state.get("future")
                if future is None or not future.done():
                    continue
                try:
                    lane_snapshot = future.result()
                    if last_good is not None:
                        lane_errors[lane] = _apply_lane_result(
                            last_good,
                            lane,
                            lane_snapshot,
                        )
                    state["last_completed_at"] = time.time()
                except Exception as exc:
                    lane_errors[lane] = {
                        f"{lane}_lane": f"{type(exc).__name__}: {exc}"
                    }
                finally:
                    state["future"] = None

            try:
                key = get_api_key(args.env_file)
                snapshot = fetch_component_snapshot(
                    symbol,
                    lane="gex",
                    api_key=key,
                    timeout=args.timeout,
                    previous_snapshot=last_good,
                )
                snapshot.pop("_fetched_components", None)
                _merge_cached_context(snapshot, last_good)
                snapshot["endpoint_errors"] = {
                    **lane_errors["core"],
                    **lane_errors["deep"],
                    **(snapshot.get("endpoint_errors") or {}),
                }
                snapshot["mode"] = args.mode
                last_good = snapshot

                for lane, state in lane_state.items():
                    last_started_mono = state.get("last_started_mono")
                    due = (
                        last_started_mono is None
                        or started_mono - last_started_mono
                        >= lane_intervals[lane]
                    )
                    if state.get("future") is not None or not due:
                        continue
                    state["future"] = executor.submit(
                        fetch_component_snapshot,
                        symbol,
                        lane=lane,
                        api_key=key,
                        timeout=args.timeout,
                        previous_snapshot=last_good,
                    )
                    state["last_started_mono"] = started_mono
                    state["last_started_at"] = started

                polling = _polling_status(
                    lane_state,
                    gex_interval=args.interval,
                    core_interval=args.context_interval,
                    deep_interval=args.deep_interval,
                )
                _atomic_json(args.output_file, snapshot)
                _atomic_json(
                    args.health_file,
                    _health_payload(
                        "ok",
                        symbol=symbol,
                        mode=args.mode,
                        snapshot=snapshot,
                        polling=polling,
                    ),
                )
                print(
                    render_text(snapshot).replace(
                        "ZEROGEX ANALYTICS",
                        f"ZEROGEX {args.mode.upper()}",
                        1,
                    ),
                    flush=True,
                )
            except ZeroGEXAuthError as exc:
                next_interval = args.auth_error_interval
                _atomic_json(
                    args.health_file,
                    _health_payload(
                        "auth_error",
                        symbol=symbol,
                        mode=args.mode,
                        snapshot=last_good,
                        error=str(exc),
                        polling=_polling_status(
                            lane_state,
                            gex_interval=args.interval,
                            core_interval=args.context_interval,
                            deep_interval=args.deep_interval,
                        ),
                    ),
                )
                print(f"ZEROGEX {args.mode.upper()} AUTH ERROR: {exc}", flush=True)
            except Exception as exc:
                next_interval = args.error_interval
                safe_error = f"{type(exc).__name__}: {exc}"
                _atomic_json(
                    args.health_file,
                    _health_payload(
                        "error",
                        symbol=symbol,
                        mode=args.mode,
                        snapshot=last_good,
                        error=safe_error,
                        polling=_polling_status(
                            lane_state,
                            gex_interval=args.interval,
                            core_interval=args.context_interval,
                            deep_interval=args.deep_interval,
                        ),
                    ),
                )
                print(f"ZEROGEX {args.mode.upper()} ERROR: {safe_error}", flush=True)

            elapsed = time.time() - started
            time.sleep(max(0.1, next_interval - elapsed))


if __name__ == "__main__":
    main()
