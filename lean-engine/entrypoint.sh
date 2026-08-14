#!/bin/sh
set -eu
if [ "${LEAN_SHADOW_ENABLED:-false}" != "true" ]; then
  mkdir -p /state
  printf '%s' '{"status":"disabled","connected":false,"order_guard":"ARMED"}' > /state/health.json
  exec tail -f /dev/null
fi
launcher="$(find /Lean/Launcher -type f -name QuantConnect.Lean.Launcher.dll | head -n 1)"
if [ -z "$launcher" ]; then
  echo "LEAN launcher DLL was not found in the base image" >&2
  exit 1
fi
cd "$(dirname "$launcher")"
python3 /opt/lean-shadow/entrypoint.py
exec dotnet "$(basename "$launcher")"
