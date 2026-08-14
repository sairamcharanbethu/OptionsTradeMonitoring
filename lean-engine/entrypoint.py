#!/usr/bin/env python3
"""Render the minimal LEAN config without exposing configuration in images."""
import json
import os
from pathlib import Path

if os.environ.get("LEAN_SHADOW_ENABLED") != "true":
    Path("/state").mkdir(parents=True, exist_ok=True)
    Path("/state/health.json").write_text(json.dumps({"status": "disabled", "connected": False, "order_guard": "ARMED"}))
    raise SystemExit(0)

if not os.environ.get("LEAN_IB_ACCOUNT", "").strip():
    raise SystemExit("LEAN_IB_ACCOUNT is required when LEAN shadow mode is enabled")

template = Path("/opt/lean-shadow/config.json").read_text()
config = (template
          .replace("__IBKR_HOST__", os.environ.get("IBKR_HOST", "ib_gateway"))
          .replace("__IBKR_PORT__", os.environ.get("IBKR_PORT", "4003"))
          .replace("__LEAN_IB_ACCOUNT__", os.environ.get("LEAN_IB_ACCOUNT", "")))
Path("config.json").write_text(config)
