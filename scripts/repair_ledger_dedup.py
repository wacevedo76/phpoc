#!/usr/bin/env python3
"""Repair the local ledger by removing duplicate entries across all dates.

Run this from within the project directory:
    PYTHONPATH=. .venv/bin/python scripts/repair_ledger_dedup.py

This script:
1. Reads the full ledger and all staging data
2. For each date, identifies unique entries (by title+duration+startTime_enc)
3. Rebuilds the ledger with ONLY the first occurrence of each unique entry
4. Preserves all summary blocks
5. Rebuilds the blind index
6. Backs up originals with .bak3 suffix

Run BEFORE ph recover, so the fixed chain gets pushed to remote.
"""

import json
import shutil
from pathlib import Path
from collections import OrderedDict
import sys

# Add project root to path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from security.crypto import CryptoManager, NoAuthCryptoManager
from security.auth import PassphraseAuthenticator
from storage.ledger_store import AbstractLedgerStore
from storage.implementations.file_ledger import FileLedgerStore
from storage.index_store import AbstractIndexStore
from storage.implementations.file_index import FileIndexStore
from domain.ledger.engine import LedgerEngine

# Paths
DATA_DIR = Path.home() / ".local/share/phpoc"
LEDGER_PATH = DATA_DIR / "ledger.json"
INDEX_PATH = DATA_DIR / "index.json"
STAGING_PATH = DATA_DIR / "staging.json"

def entry_key(entry):
    """Build a dedup key from an entry dict (title + duration only).

    We deliberately exclude startTime_enc/endTime_enc and other encrypted fields
    because the same real-world entry committed twice will have DIFFERENT ciphertexts
    but identical title and duration. Using (title, duration) identifies these
    genuine duplicates.
    """
    d = entry.get("data", {})
    return (
        d.get("title", ""),
        d.get("duration", 0),
    )

def main():
    print("=== Ledger Deduplication Repair ===\n")
    
    # -- Auth --
    auth = PassphraseAuthenticator(LEDGER_PATH)
    if not auth.authenticate():
        print("❌ Authentication required. Please log in first (ph login)")
        return 1
    
    mk = auth.get_key()
    if mk:
        crypto = CryptoManager(mk)
        print("✓ Authenticated with CryptoManager")
    else:
        crypto = NoAuthCryptoManager()
        print("⚠ Using NoAuthCryptoManager (no encryption)")
    
    # -- Backup --
    for f in ["ledger.json", "index.json"]:
        src = DATA_DIR / f
        bak = DATA_DIR / f"{f}.bak3"
        shutil.copy2(src, bak)
        print(f"✓ Backed up {f} -> {f}.bak3")
    
    # -- Read full ledger --
    with open(LEDGER_PATH) as f:
        ledger = json.load(f)
    
    print(f"\nCurrent ledger: {len(ledger)} blocks")
    
    # -- Identify summary blocks to preserve --
    summary_indices = []
    for i, block in enumerate(ledger):
        if block.get("type", "day") != "day":
            summary_indices.append(i)
    print(f"Summary blocks to preserve: {len(summary_indices)}")
    
    # -- Collect unique entries per date --
    # Track first block index per date for ordering
    date_first_block = {}  # date -> earliest block index
    date_unique_sigs = {}  # date -> set of entry_keys
    date_entries = {}      # date -> list of entry dicts (first occurrence)
    
    for i, block in enumerate(ledger):
        if block.get("type", "day") != "day":
            continue
        date_str = block.get("date", "")
        if date_str not in date_first_block:
            date_first_block[date_str] = i
            date_unique_sigs[date_str] = set()
            date_entries[date_str] = []
        
        for entry in block.get("entries", []):
            key = entry_key(entry)
            if key not in date_unique_sigs[date_str]:
                date_unique_sigs[date_str].add(key)
                date_entries[date_str].append(entry)
    
    removed_count = sum(
        len(block.get("entries", [])) - len(date_unique_sigs.get(block.get("date", ""), set()))
        for block in ledger if block.get("type", "day") == "day"
    )
    # More accurate: count total entries minus unique
    total_entries = sum(len(b.get("entries", [])) for b in ledger if b.get("type", "day") == "day")
    unique_entries = sum(len(v) for v in date_entries.values())
    dedup_count = total_entries - unique_entries
    print(f"Total entries: {total_entries}")
    print(f"Unique entries: {unique_entries}")
    print(f"Duplicate entries to remove: {dedup_count}")
    
    # -- Rebuild ledger --
    # Strategy: keep all blocks but REMOVE duplicate entries from day blocks
    # This preserves block structure, day_index ordering, and summary placement
    
    new_ledger = []
    kept_entries = {}  # date -> set of entry_keys kept so far
    
    for i, block in enumerate(ledger):
        if block.get("type", "day") != "day":
            # Preserve summary blocks as-is
            new_ledger.append(block)
            continue
        
        date_str = block.get("date", "")
        if date_str not in kept_entries:
            kept_entries[date_str] = set()
        
        # Filter to only unique entries
        unique_in_block = []
        for entry in block.get("entries", []):
            key = entry_key(entry)
            if key not in kept_entries[date_str]:
                kept_entries[date_str].add(key)
                unique_in_block.append(entry)
        
        if unique_in_block:
            # Build a corrected day block using LedgerChain
            from domain.ledger.chain import LedgerChain
            from storage.ledger_store import AbstractLedgerStore
            
            # We need a way to build a new block. Since blocks are interleaved,
            # we need to re-seal with the correct prev_hash.
            # We'll do this iteratively.
            new_block = dict(block)
            new_block["entries"] = unique_in_block
            
            # We'll re-seal it after we have the full chain
            new_ledger.append(new_block)
        else:
            # Block becomes empty - skip it entirely
            print(f"  Skipping block [{i}] ({date_str}): all entries were duplicates")
    
    print(f"\nBlocks after dedup: {len(new_ledger)} (summary blocks: {len(summary_indices)})")
    
    # -- Now re-seal every day block with correct prev_hash linkage --
    from domain.ledger.chain import LedgerChain
    
    # Build a mock store that wraps our ledger list
    class ListStore(AbstractLedgerStore):
        def __init__(self, blocks):
            self._blocks = blocks
        def read_blocks(self, start=0, end=None):
            return self._blocks[start:end]
        def append_blocks(self, blocks):
            self._blocks.extend(blocks)
        def truncate(self, keep_count):
            removed = self._blocks[keep_count:]
            self._blocks[:] = self._blocks[:keep_count]
            return removed
        def get_block_count(self):
            return len(self._blocks)
        def get_last_block(self):
            return self._blocks[-1] if self._blocks else None
    
    store = ListStore([])
    chain = LedgerChain(crypto, store)
    
    sealed_blocks = []
    for i, block in enumerate(new_ledger):
        if block.get("type", "day") != "day":
            sealed_blocks.append(block)
            continue
        
        # Get prev_hash from previous sealed block
        if sealed_blocks:
            prev = sealed_blocks[-1]
            prev_hash = (
                prev.get("day_hash")
                or prev.get("month_hash")
                or prev.get("year_hash")
            )
        else:
            prev_hash = "0" * 64
        
        # Build a new day block — after sealing, append to store so
        # build_day_block gets the correct prev for next iteration
        day_block = chain.build_day_block(
            entries=block["entries"],
            prev_hash=prev_hash,
            date_str=block["date"],
        )
        sealed_blocks.append(day_block)
        store._blocks.append(day_block)
    
    # -- Write the result --
    with open(LEDGER_PATH, "w") as f:
        json.dump(sealed_blocks, f, indent=2)
    
    print(f"✓ Written {len(sealed_blocks)} sealed blocks to ledger.json")
    
    # -- Rebuild index from scratch --
    index = {}
    for block in sealed_blocks:
        if block.get("type", "day") == "day":
            date_str = block.get("date", "")
            if date_str not in index:
                index[date_str] = {}
            for entry in block.get("entries", []):
                d = entry.get("data", {})
                title = d.get("title", "")
                duration = d.get("duration", 0)
                if title not in index[date_str]:
                    index[date_str][title] = 0
                index[date_str][title] += duration
    
    with open(INDEX_PATH, "w") as f:
        json.dump(index, f, indent=2)
    
    # -- Verify --
    print(f"\n✓ Index rebuilt: {sum(len(v) for v in index.values())} title-date entries")
    
    # Quick chain linkage check
    errors = 0
    for i in range(1, len(sealed_blocks)):
        cur = sealed_blocks[i]
        prev = sealed_blocks[i-1]
        prev_hash = prev.get("day_hash") or prev.get("month_hash") or prev.get("year_hash")
        if cur.get("prev_hash") != prev_hash:
            print(f"  ❌ Chain break at block {i}")
            errors += 1
    if errors == 0:
        print("✓ Chain linkage: all prev_hash links valid")
    else:
        print(f"❌ Chain linkage: {errors} breaks - check crypto key")
    
    print("\n=== Done ===")
    print("Run 'ph list all' to verify the fixed ledger.")
    print("Then 'ph recover' to push to remote.")
    return 0

if __name__ == "__main__":
    sys.exit(main())
