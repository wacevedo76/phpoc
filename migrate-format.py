#!/usr/bin/env python3
"""Standalone format migration script for PHPOC ledgers.

Migrates a ledger chain to format_version 0.4.0 (extensible content_hash
algorithm).  Supports passphrase auth or direct master-key input.

Usage:
    python migrate-format.py                          # Default data dir
    python migrate-format.py --file backup.json       # Specific input
    python migrate-format.py --file old.json --output new.json
    python migrate-format.py --dir /custom/data        # Custom data directory
    python migrate-format.py --yes                     # Skip confirmation
    python migrate-format.py --key <hex-or-b64>        # Direct master key
"""

import argparse
import base64
import getpass
import json
import os
import sys
from pathlib import Path
from typing import Optional

# — ensure the project root is on sys.path —
_PROJECT_ROOT = Path(__file__).resolve().parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from security.auth import PassphraseAuthenticator
from security.config_manager import ConfigManager
from security.crypto import CryptoManager, derive_mk
from storage.implementations.file_config import FileConfigStore, _resolve_config_path, _resolve_data_dir
from phpoc_cli.migrate_format import MigrateFormatCommand


def read_identity_secret(data_dir: Path, seed_bytes: bytes) -> Optional[bytes]:
    """Read and decrypt identity_secret from identity.json if present."""
    id_path = data_dir / "identity.json"
    if not id_path.exists():
        return None
    try:
        id_data = json.loads(id_path.read_text())
        enc_hex = id_data.get("identity_secret_enc")
        if not enc_hex:
            return None
    except Exception:
        return None

    mk = derive_mk(seed_bytes, 0)
    crypto = CryptoManager(mk, key_version=0)
    try:
        return bytes.fromhex(crypto.decrypt(enc_hex))
    except Exception:
        return None


def parse_key(raw: str) -> bytes:
    """Parse a --key value: hex string or base64 string → 32 bytes."""
    raw = raw.strip()
    # Try hex first
    if all(c in "0123456789abcdefABCDEF" for c in raw) and len(raw) == 64:
        return bytes.fromhex(raw)
    # Try base64
    try:
        decoded = base64.b64decode(raw)
        if len(decoded) == 32:
            return decoded
    except Exception:
        pass
    print("Error: --key must be 64 hex chars or 32-byte base64 string.")
    sys.exit(1)


def authenticate_via_passphrase(ledger_path: Path) -> Optional[bytes]:
    """Authenticate with passphrase → seed via PassphraseAuthenticator.

    Returns raw 32-byte seed, or None on failure.
    """
    auth = PassphraseAuthenticator(ledger_path)

    # Try cached session first
    seed_bytes = auth.get_key()
    if seed_bytes is not None:
        return seed_bytes

    # Check env var
    env_pass = os.environ.get("PHPOC_PASSPHRASE")
    if env_pass:
        print("Using PHPOC_PASSPHRASE from environment.")

    if not auth.authenticate():
        return None

    return auth.get_key()


def main():
    parser = argparse.ArgumentParser(
        description="Migrate PHPOC ledger to format_version 0.4.0",
    )
    parser.add_argument("--file", type=str, default=None,
                        help="Input ledger file (default: <data-dir>/ledger.json)")
    parser.add_argument("--output", type=str, default=None,
                        help="Output path (default: overwrite input)")
    parser.add_argument("--dir", type=str, default=None,
                        help="Custom data directory (default: ~/.local/share/phpoc/)")
    parser.add_argument("--yes", "-y", action="store_true",
                        help="Skip confirmation prompt")
    parser.add_argument("--key", type=str, default=None,
                        help="Master key as hex (64 chars) or base64 string (bypasses passphrase)")
    parser.add_argument("--force", action="store_true",
                        help="Force full re-hash even if ledger is already at format_version 0.4.0")
    args = parser.parse_args()

    # ── resolve paths ──────────────────────────────────────────
    config_path = _resolve_config_path()
    config = ConfigManager(FileConfigStore(config_path))
    data_dir = _resolve_data_dir(overridden_dir=args.dir, config_manager=config)
    legacy = Path.home() / ".phpoc"
    if legacy.exists() and not data_dir.exists():
        data_dir = legacy
    input_path = Path(args.file) if args.file else (data_dir / "ledger.json")
    output_path = Path(args.output) if args.output else None

    if not input_path.exists():
        print(f"Error: file not found: {input_path}")
        sys.exit(1)

    # ── check if migration is even needed ───────────────────────
    try:
        chain = json.loads(input_path.read_text())
        if not chain:
            print("Error: ledger is empty")
            sys.exit(1)
        current_fv = chain[0].get("format_version", "0.0.0")
        if current_fv >= "0.4.0" and not args.force:
            print(f"Ledger is already at format_version {current_fv}. Nothing to do.")
            print("Pass --force to fully re-hash to canonical jsonSort() form.")
            sys.exit(0)
    except (json.JSONDecodeError, KeyError) as e:
        print(f"Error reading ledger: {e}")
        sys.exit(1)

    print(f"Input:    {input_path}")
    print(f"Output:   {output_path or input_path}  (overwrite)")
    if args.dir:
        print(f"Data dir: {data_dir}")
    print(f"Current format: {current_fv} → migrating to 0.4.0")
    print()

    # ── get master key ─────────────────────────────────────────
    if args.key:
        seed_bytes = parse_key(args.key)
        print("✓ Using provided master key")
    else:
        print("Authenticating…")
        seed_bytes = authenticate_via_passphrase(input_path)
        if seed_bytes is None:
            print("Authentication failed.")
            sys.exit(1)
        print("✓ Authenticated")
    print()

    # ── identity secret (optional) ─────────────────────────────
    identity_secret = read_identity_secret(data_dir, seed_bytes)
    if identity_secret:
        print("✓ Identity secret loaded")
        print()

    # ── migrate ────────────────────────────────────────────────
    migrator = MigrateFormatCommand(
        data_dir=data_dir,
        seed=seed_bytes,
        identity_secret=identity_secret,
        ledger_path=input_path,
        output_path=output_path,
    )

    success = migrator.execute(skip_prompt=args.yes, force=args.force)
    if success:
        if output_path:
            print(f"\nMigrated ledger → {output_path}")
        else:
            print("\nMigration successful.")
    else:
        print("\nMigration failed — original ledger preserved.")
        sys.exit(1)


if __name__ == "__main__":
    main()
