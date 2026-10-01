"""Swing (9-10 DTE SPY) exit policy — Python mirror of ``shared/swing-exit-policy.json``.

The JSON is the contract shared with the backend (``backend/src/config/
swing-exit-policy.ts``). The defaults below are embedded because the engine
image does not ship ``shared/``; when the JSON is present (repo checkout) it is
loaded and ``test_swing_exit_policy.py`` asserts the two agree, so the
backtest, the engine and the backend cannot drift apart silently.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

_DEFAULTS: dict[str, Any] = {
    "version": 1,
    "minDte": 9,
    "maxDte": 10,
    "exitBeforeExpiryDte": 2,
    "maxHoldMinutes": 10080,
    "premiumStopPct": 20,
    "trailPct": 15,
    "profitLock": {"triggerMult": 1.2, "rung2Mult": 1.5, "rung2FloorMult": 1.25},
    "t1PremiumLock": {"armPct": 20, "floorPct": 10},
    "maxTotalDebitDollars": 500,
}

SHARED_POLICY_PATH = Path(__file__).resolve().parent.parent / "shared" / "swing-exit-policy.json"


def load_shared_policy(path: Path = SHARED_POLICY_PATH) -> dict[str, Any] | None:
    """The JSON contract when present, else None (runtime image)."""
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    data.pop("$comment", None)
    return data


def embedded_defaults() -> dict[str, Any]:
    return json.loads(json.dumps(_DEFAULTS))


# Effective policy: the shared JSON when available, else the embedded mirror.
POLICY: dict[str, Any] = load_shared_policy() or embedded_defaults()

SWING_MIN_DTE: int = int(POLICY["minDte"])
SWING_MAX_DTE: int = int(POLICY["maxDte"])
EXIT_BEFORE_EXPIRY_DTE: int = int(POLICY["exitBeforeExpiryDte"])
MAX_HOLD_MINUTES: int = int(POLICY["maxHoldMinutes"])
PREMIUM_STOP_PCT: float = float(POLICY["premiumStopPct"])
TRAIL_PCT: float = float(POLICY["trailPct"])
PROFIT_LOCK_TRIGGER_MULT: float = float(POLICY["profitLock"]["triggerMult"])
PROFIT_LOCK_RUNG2_MULT: float = float(POLICY["profitLock"]["rung2Mult"])
PROFIT_LOCK_RUNG2_FLOOR_MULT: float = float(POLICY["profitLock"]["rung2FloorMult"])
T1_LOCK_ARM_PCT: float = float(POLICY["t1PremiumLock"]["armPct"])
T1_LOCK_FLOOR_PCT: float = float(POLICY["t1PremiumLock"]["floorPct"])
MAX_TOTAL_DEBIT_DOLLARS: float = float(POLICY["maxTotalDebitDollars"])
