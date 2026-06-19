#!/bin/sh
set -eu

JAR_PATH="/opt/thetadata/ThetaTerminal.jar"

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
  exec java ${THETADATA_JAVA_OPTS:-} -jar "$JAR_PATH" --creds-file "$CREDS_FILE"
fi

echo "ThetaData Terminal requires THETADATA_USERNAME and THETADATA_PASSWORD, or explicit THETADATA_TERMINAL_ARGS." >&2
echo "THETADATA_API_KEY is used by the backend API client, not as a ThetaTerminal launch argument." >&2
exit 64
