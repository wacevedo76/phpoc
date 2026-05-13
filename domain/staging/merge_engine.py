"""MergeEngine — timestamp-based deduplication merge of staging entries.

Since real-world tasks don't start at the same millisecond on two devices,
entries are normally additive and non-conflicting. When they do collide
(same ``title`` at the same ``start_epoch``), the remote version wins —
it represents the more recent state.

The MergeEngine is a pure function: no I/O, no side effects, no dependencies
beyond Python builtins.
"""

from typing import List, Dict, Any


class MergeEngine:
    """Merge entries from multiple sources by (title, start_epoch) dedup.

    Remote wins on ties (more recent source).
    Result sorted ascending by start_epoch.
    """

    def merge(
        self,
        local_entries: List[Dict[str, Any]],
        remote_entries: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        """Merge remote entries into local cache.

        Args:
            local_entries: Entries from the local staging cache (decrypted DTOs).
            remote_entries: Entries pulled from remote (decrypted DTOs).

        Returns:
            Merged list deduplicated by (title, start_epoch),
            remote winning on ties, sorted by start_epoch ascending.
        """
        seen: Dict[tuple, Dict[str, Any]] = {}

        # Process local entries first
        for entry in local_entries:
            key = (entry.get("title", ""), entry.get("start_epoch"))
            # Make a copy and mark source
            entry_copy = dict(entry)
            entry_copy["source"] = "local"
            seen[key] = entry_copy

        # Process remote entries — overwrite on tie (remote is more recent)
        for entry in remote_entries:
            key = (entry.get("title", ""), entry.get("start_epoch"))
            entry_copy = dict(entry)
            entry_copy["source"] = "remote"
            seen[key] = entry_copy

        # Sort by start_epoch ascending
        return sorted(seen.values(), key=lambda e: e.get("start_epoch", 0))
