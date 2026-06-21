#!/bin/sh
set -eu

THETA_HOME="${THETA_HOME:-/opt/thetadata}"
THETA_JAR="${THETA_JAR:-${THETA_HOME}/ThetaTerminalv3.jar}"
THETA_HTTP_URL="${THETA_HTTP_URL:-http://127.0.0.1:25503/v3/terminal/mdds/status}"
THETA_MIN_TERMINAL_HEAP="${THETA_MIN_TERMINAL_HEAP:-2G}"
THETA_MAX_TERMINAL_HEAP="${THETA_MAX_TERMINAL_HEAP:-6G}"

mkdir -p "$THETA_HOME" /root/ThetaData/ThetaTerminal /root/.ThetaData/ThetaTerminal

if [ ! -f "$THETA_JAR" ]; then
  echo "[ThetaData] Missing terminal jar at $THETA_JAR" >&2
  exit 1
fi

THETA_USER="${THETA_USERNAME:-${THETADATA_USERNAME:-}}"
THETA_PASS="${THETA_PASSWORD:-${THETADATA_PASSWORD:-}}"
CREDS_FILE=""

if [ -n "$THETA_USER" ] && [ -n "$THETA_PASS" ]; then
  CREDS_FILE="$(mktemp /tmp/thetadata-creds.XXXXXX)"
  printf '%s\n%s\n' "$THETA_USER" "$THETA_PASS" > "$CREDS_FILE"
  chmod 600 "$CREDS_FILE"
else
  echo "[ThetaData] THETADATA_USERNAME/THETADATA_PASSWORD are not set. Starting backend without Theta Terminal." >&2
fi

cleanup() {
  if [ -n "${THETA_PID:-}" ] && kill -0 "$THETA_PID" 2>/dev/null; then
    kill "$THETA_PID" 2>/dev/null || true
  fi
  if [ -n "$CREDS_FILE" ]; then
    rm -f "$CREDS_FILE"
  fi
}
trap cleanup INT TERM EXIT

if [ -n "$CREDS_FILE" ]; then
  echo "[ThetaData] Starting Theta Terminal v3 on 127.0.0.1..."
  java -jar "$THETA_JAR" \
    --creds-file "$CREDS_FILE" \
    --min-terminal-heap "$THETA_MIN_TERMINAL_HEAP" \
    --max-terminal-heap "$THETA_MAX_TERMINAL_HEAP" &
  THETA_PID="$!"

  echo "[ThetaData] Waiting for terminal status at $THETA_HTTP_URL"
  THETA_READY=0
  for _ in $(seq 1 90); do
    if curl -fsS "$THETA_HTTP_URL" >/dev/null 2>&1; then
      echo "[ThetaData] Terminal is reachable."
      THETA_READY=1
      break
    fi
    if ! kill -0 "$THETA_PID" 2>/dev/null; then
      echo "[ThetaData] Terminal exited before becoming ready." >&2
      exit 1
    fi
    sleep 2
  done
  if [ "$THETA_READY" != "1" ]; then
    echo "[ThetaData] Terminal did not become ready in time." >&2
    exit 1
  fi
fi

echo "[Backend] Starting Node API..."
npm start &
NODE_PID="$!"

while :; do
  if ! kill -0 "$NODE_PID" 2>/dev/null; then
    wait "$NODE_PID"
    exit $?
  fi
  if [ -n "${THETA_PID:-}" ] && ! kill -0 "$THETA_PID" 2>/dev/null; then
    echo "[ThetaData] Terminal exited. Stopping backend container." >&2
    kill "$NODE_PID" 2>/dev/null || true
    wait "$NODE_PID" 2>/dev/null || true
    exit 1
  fi
  sleep 5
done
