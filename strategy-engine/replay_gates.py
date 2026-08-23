#!/usr/bin/env python3
"""Replay stored signal snapshots through the LIVE entry-gate code.

Used by the backend's SignalReplayBacktester so that replay verdicts come from
the exact gate implementation that trades live (signal_engine._enforce_entry_gates)
instead of a hand-synced TypeScript mirror. No threshold or strategy-set constant
is duplicated on the caller's side: change a gate parameter in signal_engine.py
and every subsequent replay reflects it automatically.

Protocol (line-oriented, one JSON object per line):

  stdin:  {"id": <opaque>, "snapshot": {...}, "spot": <num|null>, "atr_5m": <num|null>}
  stdout: {"id": <opaque>, "entry_allowed": <bool>, "gates": ["<blocker>", ...]}
          or {"id": <opaque>, "error": "<message>"} for a line that failed.

`snapshot` is either a full engine signal snapshot (signals.strategy_snapshot /
strategy_signal_events.signal_snapshot) or a minimal synthesized one for legacy
rows. The snapshot is re-armed (state=ACTIVE, lifecycle.entry_allowed=True)
before gating so the question answered is always: "would the CURRENT gate code
allow this entry?", independent of what the gate decided when it was recorded.
`spot`/`atr_5m` fall back to snapshot["spot"] / snapshot["market_context"]["atr_5m"].
"""
from __future__ import annotations

import copy
import json
import math
import sys
from typing import Any

import signal_engine


def _number(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def evaluate(record: dict[str, Any]) -> dict[str, Any]:
    snapshot = record.get("snapshot")
    result: dict[str, Any] = copy.deepcopy(snapshot) if isinstance(snapshot, dict) else {}

    result["state"] = "ACTIVE"
    lifecycle = result.get("lifecycle")
    if not isinstance(lifecycle, dict):
        lifecycle = {}
        result["lifecycle"] = lifecycle
    lifecycle["entry_allowed"] = True

    blockers_before = list(result.get("blockers") or [])

    spot = _number(record.get("spot"))
    if spot is None:
        spot = _number(result.get("spot"))
    atr_5m = _number(record.get("atr_5m"))
    if atr_5m is None:
        market_context = result.get("market_context")
        if isinstance(market_context, dict):
            atr_5m = _number(market_context.get("atr_5m"))

    gated = signal_engine._enforce_entry_gates(result, spot=spot, atr_5m=atr_5m)

    blockers_after = list(gated.get("blockers") or [])
    if blockers_after[: len(blockers_before)] == blockers_before:
        gates = blockers_after[len(blockers_before):]
    else:
        gates = [blocker for blocker in blockers_after if blocker not in blockers_before]

    gated_lifecycle = gated.get("lifecycle") or {}
    return {
        "id": record.get("id"),
        "entry_allowed": gated_lifecycle.get("entry_allowed") is True,
        "gates": gates,
    }


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        record: dict[str, Any] = {}
        try:
            record = json.loads(line)
            output = evaluate(record)
        except Exception as exc:  # a bad line must not kill the batch
            output = {
                "id": record.get("id") if isinstance(record, dict) else None,
                "error": str(exc),
            }
        sys.stdout.write(json.dumps(output) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
