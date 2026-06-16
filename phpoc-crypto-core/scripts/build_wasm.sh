#!/usr/bin/env bash
# Build phpoc-crypto-core for WASM target.
# Requires: wasm-pack (installed via: cargo install wasm-pack)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

# Ensure cargo bins are on PATH (user-level rustup install)
export PATH="$HOME/.cargo/bin:$PATH"

echo "==> Building phpoc-crypto-core for WASM..."
# Pass --features wasm via -- separator to avoid wasm-pack 0.15+ interpreting
# it as a cargo extra arg that conflicts with --out-dir.
wasm-pack build --target web --out-dir pkg -- --features wasm

echo "==> WASM build complete: pkg/"
echo "    - phpoc_crypto_core_bg.wasm"
echo "    - phpoc_crypto_core.js"
echo "    - phpoc_crypto_core.d.ts"
ls -lh pkg/
