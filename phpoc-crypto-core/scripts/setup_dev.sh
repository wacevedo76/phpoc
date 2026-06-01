#!/usr/bin/env bash
# setup_dev.sh — Install system dependencies for phpoc-crypto-core development.
#
# Run this script as root:
#   sudo bash scripts/setup_dev.sh
#
# Alternatively, run individual sections manually:
#   sudo bash scripts/setup_dev.sh --system     # apt packages only
#   bash scripts/setup_dev.sh --rust           # rustup + cargo (user level)
#   bash scripts/setup_dev.sh --all            # everything
#
# Cross-compilation targets (iOS/Android) are optional and only needed
# when building for those platforms.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; }

# ──────────────────────────────────────────────
# System packages (requires root)
# ──────────────────────────────────────────────
install_system_deps() {
    info "Installing system dependencies via apt..."

    apt-get update -qq

    # Required: ring's BoringSSL build needs pkg-config, gcc, and system headers.
    # gcc, g++, make are already present via build-essential (verify).
    apt-get install -y --no-install-recommends \
        pkg-config \
        build-essential \
        libc6-dev \
        linux-headers-$(uname -r) 2>/dev/null || true

    # Optional: clang (alternative C compiler, sometimes preferred by ring)
    # apt-get install -y clang

    # Optional: curl/wget for downloading Rust toolchain if not using rustup
    # apt-get install -y curl wget

    info "System dependencies installed successfully."
}

# ──────────────────────────────────────────────
# Rust toolchain (user level — do NOT run as root)
# ──────────────────────────────────────────────
install_rust() {
    if command -v rustc &>/dev/null; then
        info "Rust is already installed: $(rustc --version)"
        info "Updating rustup..."
        rustup update
    else
        info "Installing Rust via rustup (user-level install)..."
        curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
        source "$HOME/.cargo/env"
        info "Rust installed: $(rustc --version)"
    fi

    # Add WASM target
    info "Adding WASM compilation target..."
    rustup target add wasm32-unknown-unknown

    # Add iOS target (optional, macOS only)
    if [[ "$(uname)" == "Darwin" ]]; then
        info "Adding iOS compilation target..."
        rustup target add aarch64-apple-ios
    else
        warn "Skipping iOS target (not on macOS)"
    fi

    # Add Android target (optional, needs NDK)
    info "Adding Android compilation target..."
    rustup target add aarch64-linux-android || warn "Android target not available (arm64 host required)"

    # Install wasm-pack for WASM builds
    if command -v wasm-pack &>/dev/null; then
        info "wasm-pack already installed: $(wasm-pack --version)"
    else
        info "Installing wasm-pack..."
        cargo install wasm-pack
    fi
}

# ──────────────────────────────────────────────
# Verify everything works
# ──────────────────────────────────────────────
verify_installation() {
    info "Verifying installation..."
    local errors=0

    echo ""
    echo "  rustc:        $(rustc --version 2>/dev/null || echo 'MISSING ✗')"
    echo "  cargo:        $(cargo --version 2>/dev/null || echo 'MISSING ✗')"
    echo "  rustup:       $(rustup --version 2>/dev/null || echo 'MISSING ✗')"
    echo "  wasm-pack:    $(wasm-pack --version 2>/dev/null || echo 'MISSING ✗')"
    echo "  gcc:          $(gcc --version 2>/dev/null | head -1 || echo 'MISSING ✗')"
    echo "  pkg-config:   $(pkg-config --version 2>/dev/null || echo 'MISSING ✗')"

    # Check rustup targets
    for target in wasm32-unknown-unknown aarch64-apple-ios aarch64-linux-android; do
        if rustup target list --installed 2>/dev/null | grep -q "$target"; then
            echo "  target $target: INSTALLED ✅"
        else
            echo "  target $target: not installed (optional)"
        fi
    done

    echo ""

    # Try a cargo check
    info "Running 'cargo check' on phpoc-crypto-core..."
    cd "$PROJECT_DIR"
    if cargo check 2>/dev/null; then
        info "cargo check PASSED ✅"
    else
        error "cargo check FAILED. Check the error messages above."
        errors=$((errors + 1))
    fi

    if [ "$errors" -eq 0 ]; then
        info "All checks passed! ✅"
        echo ""
        echo "  Next steps:"
        echo "    1. Extract test vectors from CLI:"
        echo "       python3 scripts/extract_test_vectors.py"
        echo "    2. Run tests:"
        echo "       cargo test"
        echo "    3. Build for WASM:"
        echo "       ./scripts/build_wasm.sh"
    else
        error "$errors check(s) failed."
        return 1
    fi
}

# ──────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────
main() {
    case "${1:---all}" in
        --system)
            install_system_deps
            ;;
        --rust)
            install_rust
            ;;
        --all)
            if [ "$(id -u)" -ne 0 ]; then
                error "The --system and --all options require root."
                echo ""
                echo "  Run: sudo bash scripts/setup_dev.sh --all"
                echo "  Or install system and rust separately:"
                echo "    sudo bash scripts/setup_dev.sh --system"
                echo "    bash scripts/setup_dev.sh --rust"
                exit 1
            fi
            install_system_deps
            # Rust should be installed as the regular user
            warn "Now switch to your regular user and run:"
            warn "  bash scripts/setup_dev.sh --rust"
            warn "  bash scripts/setup_dev.sh --verify"
            ;;
        --verify)
            verify_installation
            ;;
        --help)
            echo "Usage: sudo bash $0 [OPTION]"
            echo ""
            echo "Options:"
            echo "  --system    Install system packages (requires root)"
            echo "  --rust      Install Rust toolchain (user level)"
            echo "  --all       Install everything (requires root for system packages)"
            echo "  --verify    Verify installation and run cargo check"
            echo "  --help      Show this help"
            ;;
        *)
            echo "Unknown option: $1"
            echo "Usage: sudo bash $0 [--system | --rust | --all | --verify | --help]"
            exit 1
            ;;
    esac
}

main "$@"
