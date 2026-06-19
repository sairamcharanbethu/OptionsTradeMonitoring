#!/bin/sh
set -eu

JAR_PATH="/opt/thetadata/ThetaTerminal.jar"
CONFIG_FILE="${THETADATA_CONFIG_FILE:-/var/lib/thetadata/config_0.properties}"
LOG_DIRECTORY="${THETADATA_LOG_DIRECTORY:-/var/lib/thetadata/logs}"

mkdir -p "$(dirname "$CONFIG_FILE")" "$LOG_DIRECTORY"

cat > "$CONFIG_FILE" <<EOF
host=${THETADATA_HOST:-0.0.0.0}
port=${THETADATA_PORT:-25503}
log_directory=${LOG_DIRECTORY}
request_queue_length=${THETADATA_REQUEST_QUEUE_LENGTH:-200}
EOF

if [ -n "${THETADATA_TERMINAL_ARGS:-}" ]; then
  exec java ${THETADATA_JAVA_OPTS:-} -jar "$JAR_PATH" ${THETADATA_TERMINAL_ARGS}
fi

if [ -n "${THETADATA_USERNAME:-}" ] && [ -n "${THETADATA_PASSWORD:-}" ]; then
  CREDS_FILE="/tmp/thetadata-creds.txt"
  {
    printf '%s\n' "$THETADATA_USERNAME"
    printf '%s\n' "$THETADATA_PASSWORD"
  } > "$CREDS_FILE"
  chmod 600 "$CREDS_FILE"
  exec java ${THETADATA_JAVA_OPTS:-} -jar "$JAR_PATH" --creds-file "$CREDS_FILE" --config "$CONFIG_FILE" --log-directory "$LOG_DIRECTORY"
fi

echo "ThetaData Terminal requires THETADATA_USERNAME and THETADATA_PASSWORD, or explicit THETADATA_TERMINAL_ARGS." >&2
echo "THETADATA_API_KEY is used by the backend API client, not as a ThetaTerminal launch argument." >&2
exit 64
