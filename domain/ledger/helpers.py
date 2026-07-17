"""Ledger helpers — shared utility functions for block and entry hashing.

Provides:
  - ``get_block_hash`` — canonical hash-value extraction for any block type,
    with backward compatibility for pre-I-17 genesis blocks that still use
    ``day_hash`` instead of ``block_hash``.
    Priority order: block_hash > day_hash > month_hash > year_hash
  - ``compute_entry_hash`` — canonical entry hash (SHA-256 of
    sort_keys=True, indent=2 JSON). Single source of truth for the
    cross-client canonical serialization format.
  - ``verify_entry_hash_two_way`` — try canonical sort+indent2 then
    legacy sort+compact. Used by onboarding staging verification and
    as a building block for the 3-way flex verifier in chain.py.

These functions replace identical inlines and static methods spread
across the codebase (migrate, remote_sync, merge, chain, summary_policy,
onboarding, orchestrator, engine).
"""

import hashlib
import json
from typing import Dict, Any


def compute_entry_hash(data: Dict[str, Any]) -> str:
    """Compute the canonical SHA-256 entry hash.

    Canonical format: sha256(json.dumps(data, sort_keys=True, indent=2)).
    This is the cross-client standard — identical output on Python and JS.

    Args:
        data: Entry data dict (plaintext fields).

    Returns:
        64-character lowercase hex SHA-256 digest.
    """
    return hashlib.sha256(
        json.dumps(data, sort_keys=True, indent=2).encode()
    ).hexdigest()


def verify_entry_hash_two_way(hash_data: Dict[str, Any], stored_hash: str) -> bool:
    """Try canonical sort+indent2, then legacy sort+compact.

    Tries ``compute_entry_hash`` (sort_keys=True, indent=2) first — the
    cross-client canonical format. Falls back to sort+compact (sort_keys=True,
    no indent) which matches pre-v0.4 CLI output and pre-canonicalization
    staging entries.

    Args:
        hash_data: Entry data dict to hash.
        stored_hash: Expected 64-char hex digest to match against.

    Returns:
        True if stored_hash matches either serialization format.
    """
    # Canonical — single source of truth via compute_entry_hash
    if compute_entry_hash(hash_data) == stored_hash:
        return True
    # Legacy sort+compact
    expected_compact = hashlib.sha256(
        json.dumps(hash_data, sort_keys=True).encode()
    ).hexdigest()
    return expected_compact == stored_hash


def get_block_hash(block: Dict[str, Any]) -> str:
    """Return the canonical hash value for a block irrespective of type.

    Args:
        block: A ledger block dict.

    Returns:
        The first available hash value, or ``""`` if no hash key is present.
    """
    return (
        block.get("block_hash")
        or block.get("day_hash")
        or block.get("month_hash")
        or block.get("year_hash")
        or ""
    )
