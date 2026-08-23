#!/bin/bash
# Rescue today's session data into the permanent local cache (uw_cache/).
# The UW plan's GEX history is a rolling ~130-day window — days not fetched
# eventually become unreachable forever. Run after the close on trading days;
# weekends/holidays no-op harmlessly. ~60 throttled API calls, ~1 minute.
#
# Cron (weekdays 17:30 local, after the close):
#   30 17 * * 1-5 /Users/saibethu/Documents/OptionsTradeMonitoring/strategy-engine/fetch_uw_daily.sh
set -euo pipefail
cd "$(dirname "$0")"
DATE="${1:-$(date +%Y-%m-%d)}"
mkdir -p uw_results
echo "[$(date '+%F %T')] fetch $DATE" >> uw_results/daily-fetch.log
python3 uw_backtest.py --date "$DATE" --fetch-only --summary-only >> uw_results/daily-fetch.log 2>&1 || \
  echo "[$(date '+%F %T')] fetch $DATE FAILED" >> uw_results/daily-fetch.log
