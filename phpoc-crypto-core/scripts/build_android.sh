#!/usr/bin/env bash
# Build phpoc-crypto-core for Android (aarch64).
# Requires: Android NDK, ANDROID_NDK_HOME env var, rustup target add aarch64-linux-android
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

# Verify NDK is available
if [ -z "${ANDROID_NDK_HOME:-}" ]; then
    echo "ERROR: ANDROID_NDK_HOME is not set."
    echo "Install the Android NDK and set:"
    echo "  export ANDROID_NDK_HOME=\$HOME/Android/Sdk/ndk/<version>"
    exit 1
fi

echo "==> Building phpoc-crypto-core for Android (aarch64)..."
cargo build --release --target aarch64-linux-android

echo "==> Android build complete"
ls -lh target/aarch64-linux-android/release/libphpoc_crypto_core.so
