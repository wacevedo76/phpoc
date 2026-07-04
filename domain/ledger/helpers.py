"""Ledger helpers — shared utility functions for block hash extraction.

Provides canonical hash-value extraction for any block type, with
backward compatibility for pre-I-17 genesis blocks that still use
``day_hash`` instead of ``block_hash``.

Priority order: block_hash > day_hash > month_hash > year_hash

This function replaces identical inlines and static methods spread
across the codebase (migrate, remote_sync, merge, chain, summary_policy,
onboarding, orchestrator, engine).
"""

from typing import Dict, Any


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
