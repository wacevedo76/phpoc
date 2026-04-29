#!/usr/bin/env python3
"""
Migrate a PHPOC ledger from implicit v0.2.0 to explicit v0.3.0 format.

Adds a 'format_version' field to the genesis block and recomputes every
block's seal (and signature, if the identity secret is available) to
account for the cascade: changing genesis → new day_hash → next block's
prev_hash changes → new seal for that block → ... through the entire chain.

Usage:
    # Preview what would change (dry run)
    python3 scripts/migrate_format_version.py --dry-run

    # Perform the migration, writing ledger.json.migrated
    python3 scripts/migrate_format_version.py

    # Overwrite ledger.json in-place (backup created automatically)
    python3 scripts/migrate_format_version.py --in-place

The script prompts for your passphrase (needed to derive the Master Key
for seal recomputation) and optionally the identity secret (needed to
re-sign blocks).

For more details, see §9.3 "Format Evolution & Versioning" in PHPSPEC.md.
"""

import sys
import os
import json
import getpass
import argparse
import shutil
from pathlib import Path

# Add project root to path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from security.auth import PassphraseAuthenticator
from security.crypto import CryptoManager


CONFIG_DIR = Path.home() / ".config" / "personal_history_poc"
LEDGER_FILE = CONFIG_DIR / "ledger.json"


def _get_block_hash(block: dict) -> str:
    """Return the seal (hash field) for this block, depending on its type."""
    type_map = {
        "genesis": "day_hash",
        "year_summary": "year_hash",
        "month_summary": "month_hash",
        "day": "day_hash",
    }
    key = type_map.get(block.get("type", "day"))
    return block.get(key, "")


def compute_seal(block: dict, master_key: bytes) -> str:
    """Recompute the HMAC-SHA256 seal for a block (see §5.2)."""
    import hmac
    import hashlib

    type_map = {
        "genesis": "day_hash",
        "year_summary": "year_hash",
        "month_summary": "month_hash",
        "day": "day_hash",
    }
    hash_key = type_map.get(block.get("type", "day"))

    # Exclude the seal field and the identity signature
    check_data = {k: v for k, v in block.items() if k not in (hash_key, "signature")}
    data_str = json.dumps(check_data, sort_keys=True)

    # Derive sealing sub-key (fixed salt)
    seal_key = hmac.new(master_key, b"integrity-key-salt", hashlib.sha256).digest()
    return hmac.new(seal_key, data_str.encode("utf-8"), hashlib.sha256).hexdigest()


def compute_signature(block_hash: str, identity_secret: bytes) -> str:
    """Recompute HMAC-SHA256 identity signature over a block's seal."""
    import hmac
    import hashlib
    return hmac.new(identity_secret, block_hash.encode("utf-8"), hashlib.sha256).hexdigest()


def load_identity_secret(master_key: bytes, ledger: list) -> bytes | None:
    """Try to load the identity secret from cache or genesis."""
    import base64

    # Try identity.json first (fast path)
    identity_path = CONFIG_DIR / "identity.json"
    if identity_path.exists():
        try:
            identity_data = json.loads(identity_path.read_text())
            enc = identity_data.get("identity_secret_enc")
            if enc:
                crypto = CryptoManager(master_key)
                secret_hex = crypto.decrypt(enc)
                return bytes.fromhex(secret_hex)
        except Exception:
            pass

    # Fall back to genesis block
    genesis = ledger[0]
    enc = genesis.get("identity", {}).get("identity_secret_enc_fallback")
    if enc:
        try:
            crypto = CryptoManager(master_key)
            secret_hex = crypto.decrypt(enc)
            return bytes.fromhex(secret_hex)
        except Exception as e:
            print(f"  Warning: could not decrypt identity_secret_enc_fallback: {e}")
            return None

    return None


def migrate_ledger(
    ledger: list,
    master_key: bytes,
    identity_secret: bytes | None = None,
    dry_run: bool = False,
    target_version: str = "0.2.0",
) -> list | None:
    """Migrate ledger from implicit v0.2.0 to explicit format_version.

    Args:
        ledger: The full ledger array.
        master_key: 32-byte Master Key for seal recomputation.
        identity_secret: 32-byte identity secret for re-signing (optional).
        dry_run: If True, only report what would change without modifying.
        target_version: The format_version to assign (default "0.2.0" for
                        pre-spec ledgers).

    Returns:
        The migrated ledger, or None if dry_run.
    """
    import hashlib
    import copy

    genesis = dict(ledger[0])

    # Check if already migrated
    if "format_version" in genesis:
        print(f"  Genesis already has format_version='{genesis['format_version']}' — nothing to do.")
        return None

    changes = []

    # Step 1: Add format_version to genesis
    genesis["format_version"] = target_version
    changes.append(f"  [0] genesis: added format_version=\"{target_version}\"")

    # Step 2: Recompute genesis seal
    old_day_hash = genesis.get("day_hash", "")
    new_day_hash = compute_seal(genesis, master_key)
    genesis["day_hash"] = new_day_hash
    if new_day_hash != old_day_hash:
        changes.append(f"  [0] genesis: day_hash changed")

    # Step 3: Recompute genesis signature
    if genesis.get("signature") and identity_secret:
        genesis["signature"] = compute_signature(new_day_hash, identity_secret)
        changes.append(f"  [0] genesis: signature recomputed")

    new_ledger = [genesis]

    # Step 4: Cascade through remaining blocks
    for i in range(1, len(ledger)):
        block = dict(ledger[i])
        prev_block = new_ledger[-1]
        prev_hash_field = _get_block_hash(prev_block)
        type_map = {
            "genesis": "day_hash",
            "year_summary": "year_hash",
            "month_summary": "month_hash",
            "day": "day_hash",
        }
        hash_key = type_map.get(block.get("type", "day"))
        old_prev = block.get("prev_hash", "")
        old_seal = block.get(hash_key, "")

        block["prev_hash"] = prev_hash_field
        if block["prev_hash"] != old_prev:
            changes.append(f"  [{i}] {block.get('type', 'day')}: prev_hash updated")

        # Recompute seal with new prev_hash
        new_seal = compute_seal(block, master_key)
        block[hash_key] = new_seal
        if new_seal != old_seal:
            changes.append(f"  [{i}] {block.get('type', 'day')}: {hash_key} recomputed")

        # Recompute signature
        if block.get("signature") and identity_secret:
            block["signature"] = compute_signature(new_seal, identity_secret)
            changes.append(f"  [{i}] {block.get('type', 'day')}: signature recomputed")

        new_ledger.append(block)

    # Report changes
    print(f"\nMigration plan ({len(ledger)} blocks):")
    for c in changes:
        print(c)

    # Verify the migrated chain
    print("\n  Verifying migrated chain...")
    errors = verify_chain(new_ledger, master_key, identity_secret)
    if errors:
        print(f"  ❌ {len(errors)} verification errors:")
        for e in errors:
            print(f"     {e}")
        return None
    else:
        print("  ✅ Chain verification passed")

    if dry_run:
        print("\n[Dry run] No files written.")
        return None

    return new_ledger


def verify_chain(ledger: list, master_key: bytes, identity_secret: bytes | None = None) -> list:
    """Verify a ledger chain's structural integrity. Returns list of error strings (empty = valid)."""
    import hmac
    import hashlib

    errors = []

    type_map = {
        "genesis": "day_hash",
        "year_summary": "year_hash",
        "month_summary": "month_hash",
        "day": "day_hash",
    }

    seal_key = hmac.new(master_key, b"integrity-key-salt", hashlib.sha256).digest()

    for i in range(len(ledger)):
        block = ledger[i]
        hash_key = type_map.get(block.get("type", "day"))

        # Check prev_hash linkage (skip genesis)
        if i > 0:
            prev = ledger[i - 1]
            prev_hash_key = type_map.get(prev.get("type", "day"))
            expected_prev = prev.get(prev_hash_key, "")
            if block.get("prev_hash", "") != expected_prev:
                errors.append(f"[{i}] prev_hash mismatch: got {block.get('prev_hash', '')[:12]}..., expected {expected_prev[:12]}...")

        # Check seal
        check_data = {k: v for k, v in block.items() if k not in (hash_key, "signature")}
        data_str = json.dumps(check_data, sort_keys=True)
        expected_seal = hmac.new(seal_key, data_str.encode("utf-8"), hashlib.sha256).hexdigest()
        actual_seal = block.get(hash_key, "")
        if expected_seal != actual_seal:
            errors.append(f"[{i}] seal mismatch")

        # Check signature (if available)
        if identity_secret and block.get("signature"):
            expected_sig = hmac.new(identity_secret, actual_seal.encode("utf-8"), hashlib.sha256).hexdigest()
            if expected_sig != block["signature"]:
                errors.append(f"[{i}] signature mismatch")

    return errors


def main():
    parser = argparse.ArgumentParser(
        description="Migrate a PHPOC ledger from implicit v0.2.0 to explicit v0.3.0 format. "
                    "Adds 'format_version' to genesis and recomputes all block seals "
                    "(and optionally signatures) with a full chain cascade.",
        epilog="See §9.3 in PHPSPEC.md for the migration rationale and algorithm."
    )
    parser.add_argument(
        "--dry-run", "-n",
        action="store_true",
        help="Preview what would change without writing any files."
    )
    parser.add_argument(
        "--in-place", "-i",
        action="store_true",
        help="Overwrite ledger.json directly (a .bak backup is created automatically). "
             "Default: write to ledger.json.migrated."
    )
    parser.add_argument(
        "--target-version",
        default="0.2.0",
        help="Format version label for pre-spec ledgers (default: 0.2.0). "
             "Use the version the data was actually created with, not the current spec version."
    )
    args = parser.parse_args()

    # Check ledger exists
    if not LEDGER_FILE.exists():
        print(f"Error: ledger not found at {LEDGER_FILE}")
        print("Run this script from the project root, or ensure the ledger exists.")
        sys.exit(1)

    # Read ledger
    ledger = json.loads(LEDGER_FILE.read_text())
    if not ledger:
        print("Error: ledger is empty.")
        sys.exit(1)

    print(f"Loaded ledger with {len(ledger)} block(s) from {LEDGER_FILE}")

    genesis = ledger[0]
    if "format_version" in genesis:
        print(f"\nGenesis already has format_version='{genesis['format_version']}'.")
        print("No migration needed.")
        return

    print(f"\nGenesis has no format_version field → implicit v0.2.0.")
    print(f"Target version: {args.target_version}")

    # Authenticate to get Master Key
    print("\nAuthentication required (to recompute block seals).")
    auth = PassphraseAuthenticator(LEDGER_FILE)
    if not auth.authenticate():
        print("Authentication failed.")
        sys.exit(1)
    master_key = auth.get_key()

    # Try to get identity secret for re-signing
    identity_secret = None
    try:
        print("\nAttempting to load identity secret for signature recomputation...")
        identity_secret = load_identity_secret(master_key, ledger)
        if identity_secret:
            print("  Identity secret loaded — blocks will be re-signed.")
        else:
            print("  Identity secret not available — signatures will be left unchanged.")
    except Exception as e:
        print(f"  Could not load identity secret: {e}")
        print("  Signatures will be left unchanged (this is safe; signatures are optional per §5.3).")

    # Run migration
    result = migrate_ledger(
        ledger,
        master_key,
        identity_secret=identity_secret,
        dry_run=args.dry_run,
        target_version=args.target_version,
    )

    if args.dry_run or result is None:
        return

    # Write result
    if args.in_place:
        backup_path = LEDGER_FILE.with_suffix(".json.bak")
        shutil.copy2(LEDGER_FILE, backup_path)
        LEDGER_FILE.write_text(json.dumps(result, indent=2))
        print(f"\n✅ Migration complete. Original backed up to {backup_path}")
        print(f"   Written to {LEDGER_FILE}")
    else:
        output_path = LEDGER_FILE.with_suffix(".json.migrated")
        output_path.write_text(json.dumps(result, indent=2))
        print(f"\n✅ Migration complete. Written to {output_path}")
        print(f"   Original ledger left untouched at {LEDGER_FILE}")
        print("   To apply: cp ledger.json.migrated ledger.json")


if __name__ == "__main__":
    main()
