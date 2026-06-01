#!/usr/bin/env bash
# Build phpoc-crypto-core for WASM target.
# Requires: wasm-pack (installed via: cargo install wasm-pack)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo "==> Building phpoc-crypto-core for WASM..."
wasm-pack build --target web --features wasm --out-dir pkg

echo "==> WASM build complete: pkg/"
echo "    - phpoc_crypto_core_bg.wasm"
echo "    - phpoc_crypto_core.js"
echo "    - phpoc_crypto_core.d.ts"
ls -lh pkg/
