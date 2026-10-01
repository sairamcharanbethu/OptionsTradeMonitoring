#!/usr/bin/env bash
# Tree sanity gate for pushes to staging (Coolify auto-deploys every push).
#
# Fails on:
#   1. any added/modified file larger than MAX_FILE_BYTES (default 1 MB)
#   2. a source file whose first three lines are each a long base64 run — the
#      exact shape of the 2026-09-30 incident where 11 source files were
#      committed as base64 blobs and 18k lines vanished
#   3. whitespace errors reported by `git diff --check`
#
# Usage: scripts/check-tree.sh [<range>]   (default: origin/staging..HEAD)
set -euo pipefail

RANGE="${1:-origin/staging..HEAD}"
MAX_FILE_BYTES="${MAX_FILE_BYTES:-1048576}"
fail=0

# Resolve the range to a list of added/modified paths. If origin/staging is
# unknown (fresh clone), fall back to the last commit.
if ! git rev-parse --verify --quiet "${RANGE%%..*}" >/dev/null 2>&1; then
  echo "check-tree: ${RANGE%%..*} not found; checking HEAD~1..HEAD" >&2
  RANGE="HEAD~1..HEAD"
fi

# Portable (macOS ships bash 3.2 without mapfile).
files=()
while IFS= read -r line; do
  [ -n "$line" ] && files+=("$line")
done < <(git diff --name-only --diff-filter=AM "$RANGE" -- . ':(exclude)**/package-lock.json' ':(exclude)**/*.lock' 2>/dev/null || true)

for f in "${files[@]+"${files[@]}"}"; do
  [ -f "$f" ] || continue
  size=$(wc -c < "$f" | tr -d ' ')
  if [ "$size" -gt "$MAX_FILE_BYTES" ]; then
    echo "check-tree: FAIL $f is ${size} bytes (> ${MAX_FILE_BYTES}); large blobs do not belong in this repo" >&2
    fail=1
  fi
  case "$f" in
    *.ts|*.tsx|*.js|*.py|*.sh|*.yml|*.yaml|*.json|*.md|*.sql|*.css|*.html)
      # Three leading lines that are each >=60 chars of pure base64 alphabet.
      if [ "$(head -n 3 "$f" | grep -cE '^[A-Za-z0-9+/=]{60,}$' || true)" -ge 3 ]; then
        echo "check-tree: FAIL $f looks like a base64 blob (first 3 lines are base64 runs)" >&2
        fail=1
      fi
      ;;
  esac
done

if ! git diff --check "$RANGE" -- . >/dev/null 2>&1; then
  echo "check-tree: FAIL whitespace errors in $RANGE (run: git diff --check $RANGE)" >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "check-tree: blocked. Fix the files above or set SKIP_PREPUSH=1 to bypass (logged)." >&2
  exit 1
fi
echo "check-tree: OK (${#files[@]} changed file(s) in $RANGE)"
