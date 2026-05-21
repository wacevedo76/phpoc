"""MergeEngine — entry_id-based deduplication merge of staging entries.

Uses ``entry_id`` as the primary dedup key (stable UUID per entry).
Falls back to ``(title, start_epoch)`` for backward compatibility
with entries created before the entry_id change.

When the same ``entry_id`` exists in both local and remote, remote wins —
it represents the more recent state.

The MergeEngine is a pure function: no I/O, no side effects, no dependencies
beyond Python builtins.
"""

from typing import List, Dict, Any, Tuple


class MergeEngine:
    """Merge entries from multiple sources by entry_id dedup.

    Remote wins on ties (more recent source).
    Result sorted ascending by start_epoch.
    """

    @staticmethod
    def _dedup_key(entry: Dict[str, Any]) -> Tuple:
        """Return the dedup key for an entry.

        Primary: entry_id (stable UUID).
        Fallback: (title, start_epoch) for backward compatibility.
        """
        entry_id = entry.get("entry_id", "")
        if entry_id:
            return ("id", entry_id)
        return ("fallback", entry.get("title", ""), entry.get("start_epoch", 0))

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
            Merged list deduplicated by entry_id (or title+start_epoch for
            backward compat), remote winning on ties, sorted by start_epoch
            ascending.
        """
        seen: Dict[Tuple, Dict[str, Any]] = {}

        # Process local entries first
        for entry in local_entries:
            key = self._dedup_key(entry)
            entry_copy = dict(entry)
            entry_copy["source"] = "local"
            seen[key] = entry_copy

        # Process remote entries — overwrite on tie (remote is more recent)
        for entry in remote_entries:
            key = self._dedup_key(entry)
            entry_copy = dict(entry)
            entry_copy["source"] = "remote"
            seen[key] = entry_copy

        # Sort by start_epoch ascending
        return sorted(seen.values(), key=lambda e: e.get("start_epoch", 0))
