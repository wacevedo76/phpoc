#!/usr/bin/env python3
"""
One-time staging repair script for phpoc.

Converts any hex-encrypted staging fields (from old revert_entries)
back to plain: format so the sync pipeline can re-encrypt them cleanly.

Usage:
    python3 scripts/repair_staging.py

This reads staging.json from ~/.config/personal_history_poc/ and writes
a repaired copy to staging.json.repaired in the same directory.

It will prompt for your passphrase to decrypt the encrypted fields.
"""
import sys
import os
import json
import getpass
import hashlib
from pathlib import Path

# Add project root to path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from security.crypto import CryptoManager
from security.recovery import RecoveryManager
from security.auth import PassphraseAuthenticator
from storage.file_store import LedgerStore


def main():
    config_dir = Path.home() / ".config" / "personal_history_poc"
    staging_path = config_dir / "staging.json"
    ledger_path = config_dir / "ledger.json"
    index_path = config_dir / "index.json"
    backup_path = staging_path.with_suffix(".json.repaired")

    if not staging_path.exists():
        print(f"No staging file found at {staging_path}")
        return

    # Read staging
    staging = json.loads(staging_path.read_text())
    if not staging:
        print("Staging is empty — nothing to repair.")
        return

    # Count how many entries need repair
    needs_repair = 0
    for e in staging:
        d = e["data"]
        for field in ["startTime_enc", "endTime_enc", "metadata_enc", "pauses_enc"]:
            val = d.get(field)
            if val and not val.startswith("plain:"):
                needs_repair += 1
                break

    if needs_repair == 0:
        print("All staging entries already use plain: format — no repair needed.")
        return

    print(f"Found {needs_repair} entries with encrypted (hex) staging fields.")
    print("Need your passphrase to decrypt them.")

    # Authenticate to get crypto key
    auth = PassphraseAuthenticator(ledger_path)
    if not auth.authenticate():
        print("Authentication failed.")
        return

    mk = auth.get_key()
    crypto = CryptoManager(mk)

    # Repair each entry
    repaired = 0
    failed = 0
    for i, e in enumerate(staging):
        d = e["data"]
        entry_needed_repair = False
        entry_failed = False

        for field in ["startTime_enc", "endTime_enc", "metadata_enc", "pauses_enc"]:
            val = d.get(field)
            if val and not val.startswith("plain:"):
                try:
                    plaintext = crypto.decrypt(val)
                    d[field] = f"plain:{plaintext}"
                    entry_needed_repair = True
                except Exception as ex:
                    print(f"  [{i}] {d.get('title','?')}:{field} — DECRYPT FAILED: {ex}")
                    entry_failed = True

        if entry_needed_repair:
            # Recompute entry hash since data changed
            entry_hash = hashlib.sha256(
                json.dumps(d, sort_keys=True).encode()
            ).hexdigest()
            e["hash"] = entry_hash
            repaired += 1
        if entry_failed:
            failed += 1

    # Write repaired staging
    staging_path.write_text(json.dumps(staging, indent=2))
    print(f"\nRepaired {repaired} entries ({failed} had decryption failures).")
    print(f"Staging written to {staging_path}")
    print()
    print("Run 'phpoc sync' now to sync the repaired entries.")


if __name__ == "__main__":
    main()
