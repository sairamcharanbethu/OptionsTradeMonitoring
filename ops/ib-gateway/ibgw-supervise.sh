#!/usr/bin/env bash
# IB Gateway supervisor — runs on the Coolify HOST (the gateway is a host
# container outside the compose stack), from cron every 2 minutes or via the
# systemd timer next to this file.
#
# What it does each run:
#   1. TCP-probes the gateway API port and reads the container's Docker health.
#   2. Counts consecutive failures in a state file; after FAIL_THRESHOLD (3)
#      failures OUTSIDE the nightly restart window it `docker restart`s the
#      container (at most MAX_RESTARTS_PER_HOUR = 2) and resets the counter.
#   3. Pings the host heartbeat URL (second healthchecks.io check) so a dead
#      host or Docker daemon is noticed even when the backend cannot alert.
#
# Configure via environment or /etc/default/ibgw-supervise:
#   IBGW_CONTAINER      container name (default: ib-gateway)
#   IBGW_HOST           probe host (default: 127.0.0.1)
#   IBGW_PORT           probe port (default: 4001 live; 4002 paper)
#   IBGW_RESTART_WINDOW nightly auto-restart window, ET "HH:MM-HH:MM" (default 23:30-00:15)
#   HEARTBEAT_HOST_URL  healthchecks.io ping URL for the host check (optional)
#   FAIL_THRESHOLD      consecutive failures before restart (default 3)
#   MAX_RESTARTS_PER_HOUR (default 2)
#   STATE_DIR           (default /var/tmp/ibgw-supervise)
set -uo pipefail

[ -f /etc/default/ibgw-supervise ] && . /etc/default/ibgw-supervise

IBGW_CONTAINER="${IBGW_CONTAINER:-ib-gateway}"
IBGW_HOST="${IBGW_HOST:-127.0.0.1}"
IBGW_PORT="${IBGW_PORT:-4001}"
IBGW_RESTART_WINDOW="${IBGW_RESTART_WINDOW:-23:30-00:15}"
HEARTBEAT_HOST_URL="${HEARTBEAT_HOST_URL:-}"
FAIL_THRESHOLD="${FAIL_THRESHOLD:-3}"
MAX_RESTARTS_PER_HOUR="${MAX_RESTARTS_PER_HOUR:-2}"
STATE_DIR="${STATE_DIR:-/var/tmp/ibgw-supervise}"
mkdir -p "$STATE_DIR"
FAIL_FILE="$STATE_DIR/fail_count"
RESTART_LOG="$STATE_DIR/restarts.log"

log() { echo "$(date -u +%FT%TZ) ibgw-supervise: $*"; }

# --- 1. probe --------------------------------------------------------------
port_ok=0
if command -v nc >/dev/null 2>&1; then
  nc -z -w3 "$IBGW_HOST" "$IBGW_PORT" >/dev/null 2>&1 && port_ok=1
else
  python3 - "$IBGW_HOST" "$IBGW_PORT" <<'PY' >/dev/null 2>&1 && port_ok=1
import socket, sys
s = socket.socket(); s.settimeout(3)
try:
    s.connect((sys.argv[1], int(sys.argv[2])))
finally:
    s.close()
PY
fi

container_state="$(docker inspect -f '{{.State.Status}}' "$IBGW_CONTAINER" 2>/dev/null || echo missing)"
container_health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$IBGW_CONTAINER" 2>/dev/null || echo missing)"

healthy=0
if [ "$port_ok" -eq 1 ] && [ "$container_state" = "running" ] && { [ "$container_health" = "healthy" ] || [ "$container_health" = "none" ]; }; then
  healthy=1
fi

# --- 2. restart window (ET) ------------------------------------------------
in_window=0
et_now=$(TZ=America/New_York date +%H%M)
w_start="${IBGW_RESTART_WINDOW%-*}"; w_end="${IBGW_RESTART_WINDOW#*-}"
w_start="${w_start/:/}"; w_end="${w_end/:/}"
if [ "$w_start" -le "$w_end" ]; then
  [ "$et_now" -ge "$w_start" ] && [ "$et_now" -lt "$w_end" ] && in_window=1
else
  { [ "$et_now" -ge "$w_start" ] || [ "$et_now" -lt "$w_end" ]; } && in_window=1
fi

# --- 3. act ------------------------------------------------------------------
if [ "$healthy" -eq 1 ]; then
  if [ -s "$FAIL_FILE" ] && [ "$(cat "$FAIL_FILE")" != "0" ]; then
    log "recovered (port=$port_ok state=$container_state health=$container_health)"
  fi
  echo 0 > "$FAIL_FILE"
else
  fails=$(( $(cat "$FAIL_FILE" 2>/dev/null || echo 0) + 1 ))
  echo "$fails" > "$FAIL_FILE"
  log "unhealthy #$fails (port=$port_ok state=$container_state health=$container_health window=$in_window)"
  if [ "$in_window" -eq 1 ]; then
    log "inside restart window $IBGW_RESTART_WINDOW ET; not intervening"
  elif [ "$fails" -ge "$FAIL_THRESHOLD" ]; then
    recent=$(awk -v cutoff="$(( $(date +%s) - 3600 ))" '$1 > cutoff' "$RESTART_LOG" 2>/dev/null | wc -l | tr -d ' ')
    if [ "$recent" -ge "$MAX_RESTARTS_PER_HOUR" ]; then
      log "restart budget exhausted ($recent in the last hour); leaving it to the operator"
    elif [ "$container_state" = "missing" ]; then
      log "container $IBGW_CONTAINER not found; cannot restart"
    else
      log "restarting $IBGW_CONTAINER"
      if docker restart "$IBGW_CONTAINER" >/dev/null 2>&1; then
        echo "$(date +%s) restart" >> "$RESTART_LOG"
        echo 0 > "$FAIL_FILE"
      else
        log "docker restart failed"
      fi
    fi
  fi
fi

# --- 4. host heartbeat ---------------------------------------------------------
if [ -n "$HEARTBEAT_HOST_URL" ]; then
  if [ "$healthy" -eq 1 ] || [ "$in_window" -eq 1 ]; then
    curl -fsS -m 5 "$HEARTBEAT_HOST_URL" >/dev/null 2>&1 || log "heartbeat ping failed"
  else
    curl -fsS -m 5 --data "ibgw unhealthy: port=$port_ok state=$container_state health=$container_health" "${HEARTBEAT_HOST_URL%/}/fail" >/dev/null 2>&1 || log "heartbeat fail-ping failed"
  fi
fi
