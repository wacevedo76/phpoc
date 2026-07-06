#!/usr/bin/env python3
"""Fix broken genesis→day1 linkage in the remote ledger chain.

The chain on R2 has a self-consistent blocks[1..104] but the genesis
block at index 0 has a different day_hash than day1's prev_hash. This
script patches day1.prev_hash to match genesis, then force-pushes the
fixed chain. Seal verification is skipped — only prev_hash linkage is
corrected.

Usage:
    python3 scripts/fix_chain_genesis_link.py <worker_url> <recovery_seed>
"""

import json
import sys

# Add project root to path
sys.path.insert(0, ".")

from domain.ledger.remote_sync import RemoteLedgerSync
from domain.staging.remote_sync import RemoteStagingSync
from core.sync.http_transport import HttpStagingTransport
from security.recovery import RecoverySeedManager


def _obfuscate(data: bytes, master_key: bytes) -> bytes:
    """Re-obfuscate a block."""
    return RemoteStagingSync._obfuscate(data, master_key)


def _deobfuscate(data: bytes, master_key: bytes) -> bytes:
    """De-obfuscate a block."""
    return RemoteStagingSync._deobfuscate(data, master_key)


def main():
    if len(sys.argv) < 3:
        print(f"Usage: {sys.argv[0]} <worker_url> <recovery_seed>")
        print("Example: python3 scripts/fix_chain_genesis_link.py \\")
        print("    https://phpoc-staging.wacevedo.workers.dev \\")
        print("    Qy2OER5EbUcsL7PWp+e24hSTE/CAN/OOEF7fgDIGEsw=")
        sys.exit(1)

    worker_url = sys.argv[1]
    recovery_seed = sys.argv[2]

    print(f"Worker: {worker_url}")
    print(f"Seed:   {recovery_seed[:16]}...")

    # Derive master key from seed
    try:
        master_key = RecoverySeedManager.seed_to_key(recovery_seed)
    except Exception as e:
        print(f"ERROR: Invalid recovery seed: {e}")
        sys.exit(1)
    print(f"Master key derived ({len(master_key)} bytes)")

    # Create transport and sync
    transport = HttpStagingTransport(base_url=worker_url)
    print("Transport created")

    syncer = RemoteLedgerSync(transport=transport, master_key=master_key)

    # Step 1: Pull all blocks
    print("\n=== Step 1: Pulling all blocks ===")
    blocks, count = syncer.pull_blocks()
    if blocks is None:
        print("No blocks pulled. Checking raw...")
        # _pull_block directly
        all_blocks = []
        existing = syncer._list_remote_block_indices()
        print(f"Remote has {len(existing)} block files")
        for idx in sorted(existing):
            filename = f"{idx:06d}.json"
            path = syncer._blocks_prefix + filename
            raw = transport.pull(path)
            if raw:
                block = syncer._deobfuscate_block(raw)
                if block:
                    all_blocks.append(block)
                    print(f"  [{idx}] type={block.get('type')} ok")
        blocks = all_blocks

    if not blocks:
        print("ERROR: Could not pull any blocks")
        sys.exit(1)

    print(f"\nPulled {len(blocks)} blocks")

    # Step 2: Diagnose and fix genesis→day1 link
    print("\n=== Step 2: Fixing genesis→day1 linkage ===")
    genesis = blocks[0]
    day1 = blocks[1]

    genesis_hash = (
        genesis.get("block_hash")
        or genesis.get("day_hash")
        or genesis.get("month_hash")
        or genesis.get("year_hash")
    )

    print(f"Genesis hash: {genesis_hash[:16]}...")
    print(f"Day1 prev_hash: {day1.get('prev_hash', 'NONE')[:16]}...")
    print(f"Day1 prev_hash correct: {day1.get('prev_hash') == genesis_hash}")

    if day1.get("prev_hash") != genesis_hash:
        old_prev = day1["prev_hash"]
        day1["prev_hash"] = genesis_hash
        print(f"PATCHED: day1.prev_hash {old_prev[:16]}... → {genesis_hash[:16]}...")

        # Step 3: Force-push all blocks
        print(f"\n=== Step 3: Force-pushing {len(blocks)} blocks ===")
        for i, block in enumerate(blocks):
            path = f"ledger/blocks/{i:06d}.json"
            json_str = json.dumps(block, ensure_ascii=False)
            obfuscated = _obfuscate(json_str.encode("utf-8"), master_key)
            transport.push(path, obfuscated)
            if i < 5 or i >= len(blocks) - 2:
                print(f"  [{i}] {block.get('type')} pushed ({len(obfuscated)} bytes)")
            elif i == 5:
                print(f"  ... (blocks 5-{len(blocks)-3} pushed) ...")
        print("\nDone! All blocks force-pushed with fixed chain linkage.")
        print("Now re-run: ph onboarding http cloudflare")
    else:
        print("No fix needed — chain is already consistent.")


if __name__ == "__main__":
    main()
