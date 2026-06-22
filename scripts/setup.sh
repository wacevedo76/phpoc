#!/usr/bin/env bash
# setup.sh — Bootstrap a fresh clone of the PH Ledger monorepo.
#
# Usage:
#   bash scripts/setup.sh            # everything (skip what's already done)
#   bash scripts/setup.sh --check    # dry-run: show what's missing
#
# Does:
#   1. Rust toolchain + wasm-pack (if missing)
#   2. WASM build (phpoc-crypto-core/pkg/)
#   3. npm install (phpoc-web + worker)
#   4. Python test deps (pytest)
#
# Safe to re-run — each step is idempotent.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
skip() { echo -e "  ${YELLOW}○${NC} $1 (already done)"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }
info() { echo -e "${BOLD}${1}${NC}"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

DRY_RUN=false
if [ "${1:-}" = "--check" ]; then
    DRY_RUN=true
fi

cd "$ROOT_DIR"

# ──────────────────────────────────────────────
# 1. Rust toolchain + wasm-pack
# ──────────────────────────────────────────────
info "── 1. Rust toolchain ──"

NEEDS_RUST=false
if ! command -v rustc &>/dev/null; then
    echo "  rustc:        MISSING"
    NEEDS_RUST=true
else
    skip "rustc $(rustc --version 2>/dev/null)"
fi

if ! rustup target list --installed 2>/dev/null | grep -q wasm32-unknown-unknown; then
    echo "  wasm32 target: MISSING"
    NEEDS_RUST=true
else
    skip "wasm32-unknown-unknown target"
fi

if ! command -v wasm-pack &>/dev/null; then
    echo "  wasm-pack:    MISSING"
    NEEDS_RUST=true
else
    skip "wasm-pack $(wasm-pack --version 2>/dev/null)"
fi

if $NEEDS_RUST && ! $DRY_RUN; then
    echo ""
    echo "  Installing Rust toolchain..."
    if ! command -v rustc &>/dev/null; then
        curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
        source "$HOME/.cargo/env"
    fi
    rustup target add wasm32-unknown-unknown
    cargo install wasm-pack
    ok "Rust toolchain ready"
elif $NEEDS_RUST; then
    echo "  (run without --check to install)"
fi

# ──────────────────────────────────────────────
# 2. WASM build
# ──────────────────────────────────────────────
info ""
info "── 2. WASM build (phpoc-crypto-core) ──"

WASM_DIR="$ROOT_DIR/phpoc-crypto-core/pkg"
WASM_FILE="$WASM_DIR/phpoc_crypto_core_bg.wasm"

if [ -f "$WASM_FILE" ]; then
    skip "phpoc_crypto_core_bg.wasm exists"
else
    echo "  WASM package: MISSING"
    if ! $DRY_RUN; then
        echo "  Building..."
        bash "$ROOT_DIR/phpoc-crypto-core/scripts/build_wasm.sh"
        ok "WASM built"
    else
        echo "  (run without --check to build)"
    fi
fi

# ──────────────────────────────────────────────
# 3. npm install — phpoc-web
# ──────────────────────────────────────────────
info ""
info "── 3. npm install (phpoc-web) ──"

if [ -d "$ROOT_DIR/phpoc-web/node_modules" ]; then
    skip "node_modules exists"
else
    echo "  node_modules: MISSING"
    if ! $DRY_RUN; then
        cd "$ROOT_DIR/phpoc-web"
        npm install
        ok "phpoc-web deps installed"
    else
        echo "  (run without --check to install)"
    fi
fi

# ──────────────────────────────────────────────
# 4. npm install — worker
# ──────────────────────────────────────────────
info ""
info "── 4. npm install (worker) ──"

if [ -d "$ROOT_DIR/worker/node_modules" ]; then
    skip "node_modules exists"
else
    echo "  node_modules: MISSING"
    if ! $DRY_RUN; then
        cd "$ROOT_DIR/worker"
        npm install
        ok "worker deps installed"
    else
        echo "  (run without --check to install)"
    fi
fi

# ──────────────────────────────────────────────
# 5. Python test deps
# ──────────────────────────────────────────────
info ""
info "── 5. Python test deps ──"

MISSING_PY=false
if ! python3 -c "import pytest" 2>/dev/null; then
    echo "  pytest:       MISSING"
    MISSING_PY=true
else
    skip "pytest $(python3 -c 'import pytest; print(pytest.__version__)' 2>/dev/null)"
fi

if ! python3 -c "import pytest_timeout" 2>/dev/null; then
    echo "  pytest-timeout: MISSING"
    MISSING_PY=true
else
    skip "pytest-timeout"
fi

if $MISSING_PY && ! $DRY_RUN; then
    pip install pytest pytest-timeout
    ok "Python test deps installed"
elif $MISSING_PY; then
    echo "  (run: pip install pytest pytest-timeout)"
fi

# ──────────────────────────────────────────────
# Summary
# ──────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if $DRY_RUN; then
    echo "Dry run complete. Run without --check to install missing dependencies."
else
    echo "Setup complete."
fi
echo ""
echo "  Next steps:"
echo "    cd phpoc-web && npm run dev     # launch web app"
echo "    cd worker && npm test           # run worker tests"
echo "    python3 -m pytest tests/ -q     # run CLI tests"
echo "    node phpoc-web/test/genesis_gate_test.mjs  # run web tests"
echo ""
echo "  Configuration needed:"
echo "    CLI:    ~/.config/phpoc/config.json (worker_url + api_key)"
echo "    Web:    Set Worker URL + API key in SyncSettings UI"
echo ""
