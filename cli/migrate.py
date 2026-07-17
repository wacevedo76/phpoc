"""ph migrate — migrate ledger chain to canonical format.

Rewrites the entire chain with new seals:
  - I-07: format_version excluded from block seal computation and removed from blocks
  - I-17: genesis day_hash → block_hash rename

The migration:
  1. Reads the ledger chain from ledger_path (or an in-memory chain)
  2. Strips format_version from every block
  3. Renames genesis day_hash → block_hash
  4. Recomputes all seals with format_version excluded
  5. Fixes prev_hash chain linkage
  6. Preserves all entry data and identity fields
  7. Creates a backup (ledger.json.bak) if a file path is provided

Usage:
  from cli.migrate import migrate_chain
  migrated = migrate_chain(chain, master_key_hex, ledger_path="/path/to/ledger.json")
"""

import json
import hashlib
import hmac
import shutil
from pathlib import Path
from typing import Optional, Dict, Any, List


def _compute_integrity_key(master_key: bytes) -> bytes:
    """Derive the integrity sub-key from the master key."""
    return hmac.new(master_key, b"integrity-key-salt", hashlib.sha256).digest()


def _seal(data_str: str, integrity_key: bytes) -> str:
    """Compute HMAC-SHA256 seal over a data string."""
    return hmac.new(integrity_key, data_str.encode(), hashlib.sha256).hexdigest()


def _hash_key_for_block_type(block: dict) -> str:
    """Get the canonical hash key for a block type."""
    btype = block.get("type", "day")
    if btype == "genesis":
        return "block_hash"  # I-17: genesis uses block_hash
    elif btype == "day":
        return "day_hash"
    elif btype == "month_summary":
        return "month_hash"
    elif btype == "year_summary":
        return "year_hash"
    else:
        return "day_hash"


from domain.ledger.helpers import get_block_hash, compute_entry_hash


def _verify_migrated_chain(migrated: List[dict], integrity_key: bytes) -> None:
    """Verify the migrated chain's structural integrity.

    Checks (a)-(d) from the Phase 4 refactor recommendations:
      (a) No format_version key exists in any block
      (b) Genesis block has block_hash (not day_hash)
      (c) Every block's seal verifies against its check data
      (d) prev_hash chain linkage is correct across all blocks

    Raises ValueError on the first verification failure.
    """
    if not migrated:
        raise ValueError("Verification failed: chain is empty")

    genesis = migrated[0]

    # (a) No format_version in any block
    for i, block in enumerate(migrated):
        if "format_version" in block:
            raise ValueError(
                f"Verification failed: block {i} still has format_version"
            )

    # (b) Genesis has block_hash, not day_hash
    if "day_hash" in genesis:
        raise ValueError(
            "Verification failed: genesis block still has day_hash "
            "(expected block_hash per I-17)"
        )
    if "block_hash" not in genesis:
        raise ValueError(
            "Verification failed: genesis block missing block_hash"
        )

    # (c) Every block's seal verifies
    for i, block in enumerate(migrated):
        btype = block.get("type", "day")
        hash_key = _hash_key_for_block_type(block)
        stored_hash = block.get(hash_key)
        if not stored_hash:
            raise ValueError(
                f"Verification failed: block {i} missing {hash_key}"
            )
        check_data = {k: v for k, v in block.items()
                      if k not in (hash_key, "identity_seal",
                                   "signature", "format_version", "key_version")}
        expected = _seal(json.dumps(check_data, sort_keys=True), integrity_key)
        if expected != stored_hash:
            raise ValueError(
                f"Verification failed: block {i} seal mismatch "
                f"(type={btype}, expected={expected[:16]}..., "
                f"got={stored_hash[:16]}...)"
            )

    # (d) prev_hash chain linkage
    for i in range(1, len(migrated)):
        prev_hash = get_block_hash(migrated[i - 1])
        current_prev = migrated[i].get("prev_hash")
        if current_prev != prev_hash:
            raise ValueError(
                f"Verification failed: block {i} prev_hash mismatch: "
                f"expected {prev_hash[:16]}..., got {current_prev[:16]}..."
            )


def migrate_chain(
    chain: List[dict],
    master_key_hex: str,
    ledger_path: Optional[str] = None,
) -> List[dict]:
    """Migrate a ledger chain to the canonical format.

    Args:
        chain: List of block dicts in the old format (format_version present,
               day_hash on genesis).
        master_key_hex: 64-char hex master key for seal computation.
        ledger_path: Optional path to the ledger.json file. If provided, a
                     backup (ledger.json.bak) is created and the migrated
                     chain is written back.

    Returns:
        The migrated chain (new list of block dicts).

    Raises:
        ValueError: If the chain is empty or has no genesis block.
    """
    if not chain or not isinstance(chain, list) or len(chain) == 0:
        raise ValueError("Cannot migrate empty chain")
    if chain[0].get("type") != "genesis":
        raise ValueError("Chain must start with a genesis block")

    # ── 0. Create backup ──────────────────────────────────────────────
    if ledger_path:
        ledger_file = Path(ledger_path)
        if ledger_file.exists():
            backup_path = ledger_file.with_suffix(".json.bak")
            shutil.copy2(ledger_file, backup_path)

    # ── 1. Integrity key ─────────────────────────────────────────────
    mk = bytes.fromhex(master_key_hex)
    integrity_key = _compute_integrity_key(mk)

    # ── 2. Deep copy to avoid mutating input ─────────────────────────
    migrated = json.loads(json.dumps(chain))

    # ── 3. Strip format_version from all blocks ──────────────────────
    for block in migrated:
        block.pop("format_version", None)

    # ── 3a. Recompute entry hashes to canonical sort+indent2 ─────────
    # Cross-client canonical serialization: all entry hashes must use
    # sha256(json.dumps(data, sort_keys=True, indent=2)).
    for block in migrated:
        if block.get("type") == "day":
            for entry in block.get("entries", []):
                data = entry.get("data", {})
                entry["hash"] = compute_entry_hash(data)

    # ── 4. Rename genesis hash field (I-17) ──────────────────────────
    genesis = migrated[0]
    if "day_hash" in genesis:
        genesis["block_hash"] = genesis.pop("day_hash")

    # ── 5. Recompute genesis seal (no prev_hash dependency) ──────────
    genesis_hash_key = _hash_key_for_block_type(genesis)
    genesis_check_data = {k: v for k, v in genesis.items()
                          if k not in (genesis_hash_key, "identity_seal",
                                       "signature", "format_version", "key_version")}
    genesis[genesis_hash_key] = _seal(json.dumps(genesis_check_data, sort_keys=True), integrity_key)

    # ── 6. Process remaining blocks: fix prev_hash → recompute seal ───
    for i in range(1, len(migrated)):
        block = migrated[i]
        # Fix prev_hash to point to previous block's CURRENT hash
        block["prev_hash"] = get_block_hash(migrated[i - 1])
        # Recompute seal with correct prev_hash
        hash_key = _hash_key_for_block_type(block)
        check_data = {k: v for k, v in block.items()
                      if k not in (hash_key, "identity_seal",
                                   "signature", "format_version", "key_version")}
        block[hash_key] = _seal(json.dumps(check_data, sort_keys=True), integrity_key)

    # ── 7. Self-verification ────────────────────────────────────────
    _verify_migrated_chain(migrated, integrity_key)

    # ── 8. Write migrated chain back if path provided ────────────────
    if ledger_path:
        Path(ledger_path).write_text(json.dumps(migrated, indent=2))

    return migrated
