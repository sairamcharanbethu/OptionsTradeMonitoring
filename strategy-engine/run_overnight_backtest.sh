#!/bin/bash
# Overnight out-of-sample backtest through the LIVE engine on Unusual Whales
# history. One pass simulates three executor variants simultaneously:
#   baseline        — live caps as-is
#   no_wall_bounce  — executor vetoes GEX_WALL_BOUNCE entries
#   morning_only    — no entries after 11:00 ET
#
# Usage:
#   ./run_overnight_backtest.sh                 # 2025-09-02 .. 2026-08-20
#   ./run_overnight_backtest.sh 2026-01-02 2026-08-20
#
# Needs UW_TOKEN in the environment or in ../.env. Rough cost: ~60 API calls
# per uncached session (throttled to ~2/s), ~1-2 min of engine simulation per
# session. A full year is roughly 6-9 hours; already-cached days re-run in
# simulation time only. Safe to re-run after an interruption — every API
# response is cached on disk under uw_cache/ and picked up where it left off.
set -euo pipefail
cd "$(dirname "$0")"

START="${1:-2025-09-02}"
END="${2:-2026-08-20}"
STAMP="$(date +%Y%m%d-%H%M)"
OUT_DIR="uw_results"
mkdir -p "$OUT_DIR"
LOG="$OUT_DIR/run-$STAMP-$START-to-$END.log"

echo "Backtest $START .. $END -> $LOG"
echo "Variants: baseline, no_wall_bounce, morning_only"
echo "Started $(date). This will take hours; caffeinate keeps the Mac awake."

# caffeinate: prevent sleep for the duration (macOS). nohup + tee so closing
# the terminal doesn't kill it and progress is watchable with: tail -f "$LOG"
nohup caffeinate -is python3 uw_backtest.py \
  --start "$START" --end "$END" \
  --summary-only --variants \
  --trades-out "$OUT_DIR/trades-$STAMP" \
  >> "$LOG" 2>&1 &

PID=$!
echo "Running as PID $PID."
echo "Watch progress:   tail -f \"$LOG\""
echo "Stop it:          kill $PID"
