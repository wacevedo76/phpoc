#!/usr/bin/env python3
"""
Migrate a PHPOC ledger between format versions.

Supports:
  - v0.2.0 (implicit, no format_version) → v0.3.0  (add format_version field)
  - v0.3.0 → v0.4.0  (extensible content hash covering all data fields)

The v0.4.0 migration recomputes every entry's content_hash using the
extensible algorithm (iterates all data keys, decrypts *_enc fields,
sorts lists, excludes content_hash itself). Since content_hash sits
inside entry data and entry hash covers the entire data dict, changing
content_hash cascades: entry hash → day block content → block seal →
→ chain-wide prev_hash cascade.

Usage:
    python3 scripts/migrate_format_version.py --dry-run      # preview
    python3 scripts/migrate_format_version.py                 # write to .migrated
    python3 scripts/migrate_format_version.py --in-place      # overwrite + .bak

The script auto-detects the current format version and plans the
appropriate migration. Pass --target-version to override the target.

See §9.3 "Format Evolution & Versioning" in PHPSPEC.md for details.
"""

import sys
import os
import json
import getpass
import argparse
import shutil
import hashlib
import hmac
from pathlib import Path

# Add project root to path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from security.auth import PassphraseAuthenticator
from security.crypto import CryptoManager
from domain.ledger.chain import select_seal_fields


CONFIG_DIR = Path.home() / ".local" / "share" / "phpoc"
LEDGER_FILE = CONFIG_DIR / "ledger.json"


def _parse_version(v: str) -> tuple:
    """Parse a semver string like '0.3.0' into a comparable tuple."""
    return tuple(int(x) for x in v.split("."))


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
    """Recompute the HMAC-SHA256 seal for a block (see §5.2).

    Routes seal-input selection through the canonical ADR-029/029a per-type
    whitelist (`select_seal_fields`) so migrated seals match the closed set.
    """
    # Closed set: only the ADR-029a per-type whitelist fields are sealed
    check_data = select_seal_fields(block)
    data_str = json.dumps(check_data, sort_keys=True)

    # Derive sealing sub-key (fixed salt)
    seal_key = hmac.new(master_key, b"integrity-key-salt", hashlib.sha256).digest()
    return hmac.new(seal_key, data_str.encode("utf-8"), hashlib.sha256).hexdigest()


def compute_identity_mac(block_hash: str, identity_secret: bytes) -> str:
    """Recompute HMAC-SHA256 identity signature over a block's seal."""
    return hmac.new(identity_secret, block_hash.encode("utf-8"), hashlib.sha256).hexdigest()


def compute_content_hash(data: dict, decrypt_fn) -> str:
    """Compute extensible content hash from all entry data fields (v0.4.0+).

    Iterates all keys in the entry's data dict:
    - Fields ending in ``_enc`` are decrypted via *decrypt_fn*
    - List fields are sorted for deterministic output
    - The ``content_hash`` field itself is excluded
    - All other fields are included as-is

    ``sort_keys=True`` normalizes key ordering.
    """
    content = {}
    for key, value in data.items():
        if key == "content_hash":
            continue
        if key.endswith("_enc") and value is not None and value != "":
            content[key] = decrypt_fn(value)
        elif isinstance(value, list):
            content[key] = sorted(value)
        else:
            content[key] = value
    return hashlib.sha256(
        json.dumps(content, sort_keys=True).encode()
    ).hexdigest()


def load_identity_secret(master_key: bytes, ledger: list) -> bytes | None:
    """Try to load the identity secret from cache or genesis."""
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


def recompute_entry_content_hashes(ledger: list, master_key: bytes,
                                   dry_run: bool = False) -> list | None:
    """Recompute all entry content_hashes using the v0.4.0+ extensible algorithm.

    Updates each entry's content_hash, then recomputes entry.hash (which
    covers the entire data dict including content_hash).

    Returns a new ledger with updated entries, or None if dry_run.
    """
    crypto = CryptoManager(master_key)
    changes = 0
    new_ledger = []

    for i, block in enumerate(ledger):
        block = dict(block)
        if block.get("type", "day") == "day" and "entries" in block:
            new_entries = []
            for entry in block["entries"]:
                entry = dict(entry)
                data = dict(entry["data"])

                # Compute new content hash
                new_ch = compute_content_hash(data, crypto.decrypt)
                old_ch = data.get("content_hash", "")
                if new_ch != old_ch:
                    changes += 1

                data["content_hash"] = new_ch
                entry["hash"] = hashlib.sha256(
                    json.dumps(data, sort_keys=True).encode()
                ).hexdigest()
                entry["data"] = data
                new_entries.append(entry)
            block["entries"] = new_entries
        new_ledger.append(block)

    print(f"\n  Content hash changes: {changes} entry/entries")
    if dry_run:
        print("  [Dry run] Entry hashes not yet updated.")
        return None
    return new_ledger


def cascase_seals(ledger: list, master_key: bytes,
                  identity_secret: bytes | None = None,
                  dry_run: bool = False) -> list | None:
    """Recompute all block seals (and signatures) through the chain cascade.

    Handles prev_hash linkage, seal recomputation, and optional re-signing.
    Returns the updated ledger, or None if dry_run.
    """
    changes = []
    new_ledger = [dict(ledger[0])]

    # Genesis: recompute seal
    genesis = new_ledger[0]
    old_day_hash = genesis.get("day_hash", "")
    new_day_hash = compute_seal(genesis, master_key)
    genesis["day_hash"] = new_day_hash
    if new_day_hash != old_day_hash:
        changes.append("  [0] genesis: day_hash recomputed")

    if genesis.get("identity_seal") and identity_secret:
        genesis["identity_seal"] = compute_identity_mac(new_day_hash, identity_secret)
        changes.append("  [0] genesis: signature recomputed")

    # Cascade through remaining blocks
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

        new_seal = compute_seal(block, master_key)
        block[hash_key] = new_seal
        if new_seal != old_seal:
            changes.append(f"  [{i}] {block.get('type', 'day')}: {hash_key} recomputed")

        if block.get("identity_seal") and identity_secret:
            block["identity_seal"] = compute_identity_mac(new_seal, identity_secret)
            changes.append(f"  [{i}] {block.get('type', 'day')}: signature recomputed")

        new_ledger.append(block)

    for c in changes:
        print(c)

    if dry_run:
        print("  [Dry run] Seals not yet updated.")
        return None

    return new_ledger


def verify_chain(ledger: list, master_key: bytes,
                 identity_secret: bytes | None = None) -> list:
    """Verify a ledger chain's structural integrity. Returns list of error strings (empty = valid)."""
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
        check_data = {k: v for k, v in block.items() if k not in (hash_key, "identity_seal", "signature")}
        data_str = json.dumps(check_data, sort_keys=True)
        expected_seal = hmac.new(seal_key, data_str.encode("utf-8"), hashlib.sha256).hexdigest()
        actual_seal = block.get(hash_key, "")
        if expected_seal != actual_seal:
            errors.append(f"[{i}] seal mismatch")

        # Check signature (if available)
        if identity_secret and block.get("identity_seal"):
            expected_sig = hmac.new(identity_secret, actual_seal.encode("utf-8"), hashlib.sha256).hexdigest()
            if expected_sig != block["identity_seal"]:
                errors.append(f"[{i}] signature mismatch")

        # Check entry hashes and content hashes
        if block.get("type", "day") == "day":
            for j, entry in enumerate(block.get("entries", [])):
                data = entry.get("data", {})
                # Entry hash
                expected_hash = hashlib.sha256(
                    json.dumps(data, sort_keys=True).encode()
                ).hexdigest()
                if expected_hash != entry.get("hash", ""):
                    errors.append(f"[{i}].entries[{j}]: entry hash mismatch")

                # Content hash — try extensible first, fall back to legacy
                if "content_hash" in data:
                    try:
                        crypto = CryptoManager(master_key)
                        ch_new = compute_content_hash(data, crypto.decrypt)
                        if ch_new != data["content_hash"]:
                            # Fall back to legacy v0.3.0 algorithm
                            plain = dict(data)
                            for ef in ["startTime_enc", "endTime_enc", "metadata_enc", "pauses_enc"]:
                                if ef in plain and plain[ef]:
                                    plain[ef] = crypto.decrypt(plain[ef])
                            ch_legacy = hashlib.sha256(json.dumps({
                                "title": plain.get("title", ""),
                                "startTime": plain.get("startTime_enc", ""),
                                "endTime": plain.get("endTime_enc", ""),
                                "metadata": plain.get("metadata_enc", ""),
                                "pauses": plain.get("pauses_enc", ""),
                                "tags": sorted(plain.get("tags", [])),
                                "comment": plain.get("comment", ""),
                                "media": sorted(plain.get("media", [])),
                                "duration": plain.get("duration", 0),
                            }, sort_keys=True).encode()).hexdigest()
                            if ch_legacy != data["content_hash"]:
                                errors.append(f"[{i}].entries[{j}]: content_hash mismatch")
                    except Exception as e:
                        errors.append(f"[{i}].entries[{j}]: content_hash check threw: {e}")

    return errors


def migrate_ledger_v3_to_v4(
    ledger: list,
    master_key: bytes,
    identity_secret: bytes | None = None,
    dry_run: bool = False,
) -> list | None:
    """Migrate v0.3.0 → v0.4.0: extensible content hash.

    Steps:
    1. Bump format_version to "0.4.0" in genesis
    2. Recompute all entry content_hashes using the new extensible algorithm
    3. Recompute all entry hashes (they cover the data dict including content_hash)
    4. Cascade through all block seals (entries changed → day blocks changed)
    """
    genesis = dict(ledger[0])
    current_fv = genesis.get("format_version", "0.2.0")
    target_fv = "0.4.0"

    print(f"\n  Current format_version: {current_fv}")
    print(f"  Target format_version:  {target_fv}")
    print(f"  Upgrade path: recompute content hashes + full chain cascade")

    # Step 1: Update format_version in genesis
    genesis["format_version"] = target_fv
    new_ledger = [genesis] + [dict(b) for b in ledger[1:]]

    print(f"\n  Step 1/3: Udate format_version → {target_fv}")

    # Step 2: Recompute content hashes and entry hashes
    print(f"\n  Step 2/3: Recompute content hashes...")
    new_ledger = recompute_entry_content_hashes(new_ledger, master_key, dry_run=dry_run)
    if dry_run:
        return None

    # Step 3: Cascade seals through the chain
    print(f"\n  Step 3/3: Cascade seals through {len(new_ledger)} block(s)...")
    new_ledger = cascase_seals(new_ledger, master_key, identity_secret, dry_run=dry_run)
    if dry_run:
        return None

    # Verify
    print("\n  Verifying migrated chain...")
    errors = verify_chain(new_ledger, master_key, identity_secret)
    if errors:
        print(f"  ❌ {len(errors)} verification errors:")
        for e in errors:
            print(f"     {e}")
        return None
    print("  ✅ Chain verification passed")

    return new_ledger


def migrate_ledger_v2_to_v3(
    ledger: list,
    master_key: bytes,
    identity_secret: bytes | None = None,
    dry_run: bool = False,
    target_version: str = "0.3.0",
) -> list | None:
    """Migrate v0.2.0 (implicit, no format_version) → v0.3.0.

    Adds 'format_version' to genesis and recomputes all block seals
    (and optionally signatures) with a full chain cascade.

    If target_version >= "0.4.0", also upgrades content hashes.
    """
    genesis = dict(ledger[0])
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
    if genesis.get("identity_seal") and identity_secret:
        genesis["identity_seal"] = compute_identity_mac(new_day_hash, identity_secret)
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
        if block.get("identity_seal") and identity_secret:
            block["identity_seal"] = compute_identity_mac(new_seal, identity_secret)
            changes.append(f"  [{i}] {block.get('type', 'day')}: signature recomputed")

        new_ledger.append(block)

    # Report changes
    print(f"\nMigration plan ({len(ledger)} blocks):")
    for c in changes:
        print(c)

    # Step 5: If targeting v0.4.0+, also upgrade content hashes
    if _parse_version(target_version) >= (0, 4, 0):
        print(f"\n  Target version >= 0.4.0: also upgrading content hashes...")
        new_ledger = recompute_entry_content_hashes(new_ledger, master_key, dry_run=dry_run)
        if dry_run:
            return None

        # Content hash change cascaded into entries → need to re-cascade seals
        print(f"\n  Re-cascading seals after content hash upgrade...")
        new_ledger = cascase_seals(new_ledger, master_key, identity_secret, dry_run=dry_run)
        if dry_run:
            return None

    if dry_run:
        print("\n[Dry run] No files written.")
        return None

    # Verify
    print("\n  Verifying migrated chain...")
    errors = verify_chain(new_ledger, master_key, identity_secret)
    if errors:
        print(f"  ❌ {len(errors)} verification errors:")
        for e in errors:
            print(f"     {e}")
        return None
    print("  ✅ Chain verification passed")

    return new_ledger


def _auto_detect_migration(ledger: list) -> str | None:
    """Detect what migration is needed based on genesis format_version.

    Returns a descriptive label or None if no migration needed.
    """
    genesis = ledger[0]
    fv = genesis.get("format_version")

    if fv is None:
        return "v0.2.0 (implicit)"
    return None  # already has explicit format_version


def main():
    parser = argparse.ArgumentParser(
        description="Migrate a PHPOC ledger between format versions. "
                    "Auto-detects current version and plans appropriate upgrade.\n\n"
                    "v0.2.0 (implicit) → v0.3.0: adds format_version field to genesis\n"
                    "v0.3.0 → v0.4.0: extensible content hash covering all data fields\n"
                    "Any → v0.4.0+: both of the above in sequence",
        epilog="See §9.3 in PHPSPEC.md for migration rationale. "
               "The v0.4.0 content hash algorithm iterates all data keys with sort_keys=True, "
               "making it automatically extensible to future fields."
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
        default="0.4.0",
        help="Target format version (default: 0.4.0). "
             "Use 0.3.0 to only add format_version without content hash upgrade."
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
    current_fv = genesis.get("format_version")
    target_fv = args.target_version

    if current_fv is None:
        print(f"\nGenesis has no format_version field → implicit v0.2.0.")
        print(f"Target version: {target_fv}")
        migration_type = "v2_to_v3"
    elif _parse_version(current_fv) < _parse_version(target_fv):
        print(f"\nGenesis format_version: {current_fv} → target: {target_fv}")
        migration_type = "v3_to_v4"
    else:
        print(f"\nGenesis already at format_version='{current_fv}'.")
        print("No migration needed.")
        return

    # Authenticate to get Master Key
    print("\nAuthentication required (to recompute block seals and content hashes).")
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
        print("  Signatures will be left unchanged (safe; signatures are optional per §5.3).")

    # Run the appropriate migration
    if migration_type == "v2_to_v3":
        result = migrate_ledger_v2_to_v3(
            ledger, master_key,
            identity_secret=identity_secret,
            dry_run=args.dry_run,
            target_version=target_fv,
        )
    else:
        result = migrate_ledger_v3_to_v4(
            ledger, master_key,
            identity_secret=identity_secret,
            dry_run=args.dry_run,
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
