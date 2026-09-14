#!/bin/bash
# Differential check of the se_kernel Rust extension against the pure-Python
# reference, on cached Unusual Whales sessions. Never calls the vendor API.
#
#   ./kernel_parity_check.sh OUT_DIR python|rust|both [DATE ...]
#
# For each kernel it writes, under OUT_DIR/<kernel>/:
#   <date>.stdout          full uw_backtest output (states, blockers, trades)
#   <date>-baseline.jsonl  priced trades (via --trades-out)
#   <date>.indicators.jsonl per-minute calculate_indicators dump
#   timing.txt             wall seconds per date
# When both kernel directories exist it diffs them file by file and exits
# non-zero on any difference.
set -uo pipefail
cd "$(dirname "$0")"

OUT="${1:?OUT_DIR required}"
MODE="${2:-both}"
shift 2 || true
DATES=("$@")
if [ ${#DATES[@]} -eq 0 ]; then
  DATES=(2026-04-01 2026-04-17 2026-05-05 2026-05-21 2026-06-08 2026-06-24 2026-07-10 2026-07-28 2026-08-13 2026-08-20)
fi
export UW_TOKEN="${UW_TOKEN:-cache-only-no-network}"

run_kernel() {
  local kernel="$1" dir="$OUT/$1"
  mkdir -p "$dir"
  : > "$dir/timing.txt"
  for date in "${DATES[@]}"; do
    local start end
    start=$(python3 -c 'import time; print(time.time())')
    SE_KERNEL="$kernel" python3 uw_backtest.py --date "$date" --cache-only \
      --trades-out "$dir/$date" > "$dir/$date.stdout" 2> "$dir/$date.stderr" \
      || echo "  uw_backtest FAILED for $date ($kernel), see $dir/$date.stderr"
    end=$(python3 -c 'import time; print(time.time())')
    printf "%s %.2f\n" "$date" "$(echo "$end - $start" | bc)" >> "$dir/timing.txt"
    SE_KERNEL="$kernel" python3 kernel_indicator_dump.py --date "$date" \
      --out "$dir/$date.indicators.jsonl" >> "$dir/$date.stdout" 2>> "$dir/$date.stderr" \
      || echo "  indicator dump FAILED for $date ($kernel)"
  done
  echo "[$kernel] wall seconds per session:"; cat "$dir/timing.txt"
}

case "$MODE" in
  python) run_kernel python ;;
  rust)   run_kernel rust ;;
  both)   run_kernel python; run_kernel rust ;;
  *) echo "mode must be python|rust|both"; exit 2 ;;
esac

if [ -d "$OUT/python" ] && [ -d "$OUT/rust" ]; then
  status=0
  for f in "$OUT/python"/*.stdout "$OUT/python"/*.jsonl; do
    name=$(basename "$f")
    if [ ! -f "$OUT/rust/$name" ]; then echo "MISSING rust/$name"; status=1; continue; fi
    # the "wrote N trades to <path>" line embeds the kernel's output dir; strip it
    if ! diff <(sed "s#$OUT/python/##" "$f") <(sed "s#$OUT/rust/##" "$OUT/rust/$name") > "$OUT/$name.diff"; then
      echo "DIFF $name"; head -6 "$OUT/$name.diff"; status=1
    else
      rm -f "$OUT/$name.diff"
    fi
  done
  if [ $status -eq 0 ]; then echo "PARITY OK: python and rust outputs identical for ${#DATES[@]} sessions"; fi
  exit $status
fi
