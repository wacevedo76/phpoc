#!/usr/bin/env python3
"""Migrate the live ledger at ~/.local/share/phpoc/ledger.json to canonical format.

Prompts for the passphrase (not stored), derives the master key from the
encrypted seed in the genesis block, and runs migrate_chain.

Usage:
  python3 scripts/migrate_live_ledger.py
"""

import sys
import json
import hashlib
import base64
from getpass import getpass
from pathlib import Path

# ── Add project root to sys.path ────────────────────────────────────────────
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from security.crypto import CryptoManager
from phpoc_cli.migrate import migrate_chain


LEDGER_PATH = Path.home() / ".local/share/phpoc/ledger.json"


def main():
    # 1. Read the ledger
    if not LEDGER_PATH.exists():
        print(f"ERROR: Ledger not found at {LEDGER_PATH}", file=sys.stderr)
        sys.exit(1)

    with open(LEDGER_PATH) as f:
        chain = json.load(f)

    genesis = chain[0]
    if genesis.get("type") != "genesis":
        print("ERROR: First block is not a genesis block", file=sys.stderr)
        sys.exit(1)

    recovery_seed_enc = genesis["identity"]["recovery_seed_enc"]
    username = genesis["identity"].get("username", "unknown")

    # 2. Prompt for passphrase
    print(f"\n  Ledger: {username}  ({len(chain)} blocks)")
    print(f"  Path:   {LEDGER_PATH}")
    print()
    passphrase = getpass("  Passphrase: ")

    if not passphrase:
        print("ERROR: Passphrase cannot be empty", file=sys.stderr)
        sys.exit(1)

    # 3. Derive PDK and decrypt the seed
    pdk = hashlib.pbkdf2_hmac(
        "sha256",
        passphrase.encode("utf-8"),
        b"session-salt",
        600_000,
        32,
    )

    pdk_crypto = CryptoManager(pdk)
    try:
        seed_b64 = pdk_crypto.decrypt(recovery_seed_enc)
    except Exception as e:
        print(f"ERROR: Could not decrypt seed (wrong passphrase?): {e}", file=sys.stderr)
        sys.exit(1)

    # 4. Derive master key from seed
    master_key = base64.b64decode(seed_b64)
    master_key_hex = master_key.hex()

    # 5. Quick sanity check — decrypt the identity secret
    mk_crypto = CryptoManager(master_key)
    id_secret_enc = genesis["identity"]["identity_secret_enc_fallback"]
    try:
        mk_crypto.decrypt(id_secret_enc)
    except Exception as e:
        print(f"ERROR: Seed decrypted but identity check failed: {e}", file=sys.stderr)
        sys.exit(1)

    print(f"\n  ✓ Passphrase verified")
    print(f"  ✓ Master key derived (seed: {seed_b64[:12]}...)")

    # 6. Run migration
    print(f"\n  Running migration (I-07 + I-17)...")
    try:
        migrated = migrate_chain(chain, master_key_hex, ledger_path=str(LEDGER_PATH))
    except Exception as e:
        print(f"\n  ✗ Migration FAILED: {e}", file=sys.stderr)
        print(f"  Your original ledger is backed up at {LEDGER_PATH}.bak", file=sys.stderr)
        sys.exit(1)

    # 7. Report
    genesis_new = migrated[0]
    print(f"\n  ✓ Migration complete — {len(migrated)} blocks migrated")
    print(f"  ✓ Backup saved to {LEDGER_PATH}.bak")
    print(f"  ✓ Genesis hash field: {list(genesis_new.keys())}")
    print(f"  ✓ format_version removed")
    print(f"  ✓ All seals recomputed + chain linkage verified")
    print()


if __name__ == "__main__":
    main()
