#!/usr/bin/env python3
"""Pull ALL ledger blocks from the remote (HTTP transport), overwriting local.

Use this if `ph onboarding` fails or you need a clean re-pull from the
Cloudflare Worker. Requires an active session (run `ph login` first).

Usage:
    python3 scripts/pull_remote_ledger.py
"""

import json
import shutil
import sys
from pathlib import Path

# Resolve paths
XDG_DATA = Path.home() / ".local" / "share" / "phpoc"
XDG_CONFIG = Path.home() / ".config" / "phpoc"

DATA_DIR = Path(sys.argv[1]) if len(sys.argv) > 1 else XDG_DATA
CONFIG_PATH = XDG_CONFIG / "config.json"


def main():
    # 1. Load config for transport
    from storage.implementations.file_config import FileConfigStore, _resolve_data_dir
    from security.config_manager import ConfigManager
    from core.sync.transport import create_transport_from_config

    config_store = FileConfigStore(CONFIG_PATH)
    config = ConfigManager(config_store)
    data_dir = _resolve_data_dir(config_manager=config)
    config_with_dir = dict(config.read())
    config_with_dir["_config_dir"] = str(data_dir)
    transport = create_transport_from_config(config_with_dir)

    if transport is None:
        print("Error: No remote transport configured.")
        sys.exit(1)
    print(f"Transport: {type(transport).__name__}")

    # 2. Get master key from session
    session = Path("/dev/shm/phpoc_session")
    if not session.exists():
        print("Error: No active session. Run 'ph login' first.")
        sys.exit(1)
    mk = session.read_bytes()
    print(f"Session key: {len(mk)} bytes")

    # 3. Pull blocks from remote
    from domain.ledger.remote_sync import RemoteLedgerSync
    ls = RemoteLedgerSync(transport, mk)

    print("\nListing remote blocks...")
    files = transport.list_files("ledger/blocks/")
    if not files:
        print("No blocks found on remote.")
        sys.exit(1)

    indices = sorted(int(f.strip()[:-5]) for f in files if f.strip().endswith(".json"))
    print(f"Remote has {len(indices)} blocks: {indices[0]} to {indices[-1]}")

    print("Pulling blocks...")
    all_blocks = []
    for idx in indices:
        raw = transport.pull(f"ledger/blocks/{idx:06d}.json")
        if raw is None:
            print(f"  ERROR: block {idx} missing!")
            continue
        block = ls._deobfuscate_block(raw)
        all_blocks.append(block)
        if idx % 10 == 0:
            e = len(block.get("entries", []))
            print(f"  block {idx:3d} — {block.get('date','?')} ({e} entries)")

    print(f"\nPulled {len(all_blocks)} blocks total")
    print(f"Range: {all_blocks[0].get('date','?')} to {all_blocks[-1].get('date','?')}")

    # 4. Backup and write ledger
    ledger_path = data_dir / "ledger.json"
    bak = ledger_path.with_suffix(".json.bak.pull-script")
    shutil.copy2(ledger_path, bak)
    print(f"Backed up old ledger to {bak.name}")

    ledger_path.write_text(json.dumps(all_blocks, indent=2))
    print(f"Written {len(all_blocks)} blocks to ledger.json")

    # 5. Pull index
    print("\nPulling index...")
    from domain.staging.remote_sync import RemoteStagingSync
    index_raw = transport.pull("ledger/index.json")
    if index_raw:
        plaintext = RemoteStagingSync._deobfuscate(index_raw, mk)
        if plaintext:
            index_data = json.loads(plaintext.decode("utf-8"))
            index_path = data_dir / "index.json"
            shutil.copy2(index_path, index_path.with_suffix(".json.bak.pull-script"))
            index_path.write_text(json.dumps(index_data, indent=2))
            print(f"Written index with {len(index_data)} dates")

    # 6. Pull staging blob if it has entries
    print("\nPulling staging...")
    staging_raw = transport.pull("staging/blobs/current.json")
    if staging_raw:
        plaintext = RemoteStagingSync._deobfuscate(staging_raw, mk)
        if plaintext:
            blob = json.loads(plaintext.decode("utf-8"))
            entries = blob.get("entries", [])
            staging_path = data_dir / "staging.json"
            staging_path.write_text(json.dumps(entries, indent=2))
            print(f"Written staging with {len(entries)} entries")
        else:
            print("  Could not deobfuscate staging blob")
    else:
        print("  No staging blob on remote")

    print("\nDone! Run 'ph verify' to check integrity.")


if __name__ == "__main__":
    main()
