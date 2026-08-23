#!/bin/bash
# Weekly evidence report — replays the full available window through the
# CURRENT engine and appends the summary to uw_results/weekly-reports.log.
# Runs from cache except the newest days (the daily fetch keeps those warm),
# so it completes in ~10-15 minutes. Intended for cron, e.g. Friday evening:
#   0 18 * * 5  /Users/saibethu/Documents/OptionsTradeMonitoring/strategy-engine/weekly_report.sh
#
# Review ritual: compare the family table week-over-week, check whether
# watch-list items (docs/uw-backtest-*.md) moved toward or away from the
# ~2-SE bar on the freshly added sessions, and compare against the live
# by-strategy panel on the Trade Intelligence page.
set -euo pipefail
cd "$(dirname "$0")"
START="${1:-2026-04-14}"
END="${2:-$(date +%Y-%m-%d)}"
STAMP="$(date +%Y%m%d)"
mkdir -p uw_results
LOG="uw_results/weekly-$STAMP.log"
python3 uw_backtest.py --start "$START" --end "$END" --summary-only \
  --trades-out "uw_results/trades-weekly-$STAMP" > "$LOG" 2>&1
{
  echo ""
  echo "================ WEEKLY REPORT $(date '+%F %T') ($START..$END) ================"
  grep -E "TRADES:|win rate|trades .* wins" "$LOG" | head -20
} >> uw_results/weekly-reports.log
