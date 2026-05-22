#!/usr/bin/env bash
#
# remove_trace_logging.sh
#
# Removes all trace-logging code that was added during the cross-device
# sync debugging phase. This script:
#   1. Removes "from cli.trace import trace" import lines from 5 files
#   2. Removes all "@trace" decorator lines from those same files
#   3. Deletes cli/trace.py (the trace module)
#   4. Deletes staging_log/ directory
#
# Safe to run multiple times — each operation is idempotent.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

echo "=== Removing trace-logging code from $REPO_ROOT ==="

# ------------------------------------------------------------------
# 1. Remove "from cli.trace import trace" import lines
# ------------------------------------------------------------------
FILES_WITH_IMPORT=(
  "cli/interface.py"
  "domain/staging/service.py"
  "domain/staging/remote_sync.py"
  "main.py"
  "compat/v0_3_0.py"
)

echo ""
echo "--- Removing import lines ---"
for f in "${FILES_WITH_IMPORT[@]}"; do
  if [ -f "$f" ]; then
    # Remove lines that are exactly "from cli.trace import trace" (possibly with leading whitespace)
    sed -i '/^[[:space:]]*from cli\.trace import trace/d' "$f"
    echo "  ✓ $f"
  else
    echo "  - $f (not found, skipping)"
  fi
done

# ------------------------------------------------------------------
# 2. Remove "@trace" decorator lines
# ------------------------------------------------------------------
echo ""
echo "--- Removing @trace decorator lines ---"
for f in "${FILES_WITH_IMPORT[@]}"; do
  if [ -f "$f" ]; then
    # Remove lines that are just "  @trace" or "@trace" (possible whitespace before)
    sed -i '/^[[:space:]]*@trace$/d' "$f"
    echo "  ✓ $f"
  else
    echo "  - $f (not found, skipping)"
  fi
done

# ------------------------------------------------------------------
# 3. Delete cli/trace.py
# ------------------------------------------------------------------
echo ""
echo "--- Deleting cli/trace.py ---"
if [ -f "cli/trace.py" ]; then
  rm -v "cli/trace.py"
else
  echo "  (already removed)"
fi

# ------------------------------------------------------------------
# 4. Delete staging_log/ directory
# ------------------------------------------------------------------
echo ""
echo "--- Deleting staging_log/ ---"
if [ -d "staging_log" ]; then
  rm -rv "staging_log"
else
  echo "  (already removed)"
fi

# ------------------------------------------------------------------
# Summary
# ------------------------------------------------------------------
echo ""
echo "=== Done ==="
echo ""
echo "Verify no trace references remain:"
REMAINING=$(grep -rn 'from cli.trace\|@trace' --include='*.py' "$REPO_ROOT" 2>/dev/null | grep -v __pycache__ || true)
if [ -z "$REMAINING" ]; then
  echo "  ✓ No trace references found — all clean."
else
  echo "  ⚠  Still found:"
  echo "$REMAINING"
fi
