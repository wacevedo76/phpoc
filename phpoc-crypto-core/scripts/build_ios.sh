#!/usr/bin/env bash
# Build phpoc-crypto-core for iOS (aarch64).
# Requires: Xcode with iOS SDK, rustup target add aarch64-apple-ios
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo "==> Building phpoc-crypto-core for iOS (aarch64)..."
cargo build --release --target aarch64-apple-ios

echo "==> iOS build complete"
ls -lh target/aarch64-apple-ios/release/libphpoc_crypto_core.a
