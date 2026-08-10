"""StagingHashIndex — compact manifest for O(1) staging change detection.

Builds a compact ``[{activity_id, activity_status}, ...]`` index from
staging rows, computes SHA-256 hashes for integrity comparison, and
diffs local vs remote indexes to identify rows needing reconciliation.

Port of ``phpoc-flutter/lib/data/sync/staging_hash_index.dart`` and
``phpoc-web/src/sync/staging_hash_index.js``.
"""

import hashlib
import json
from dataclasses import dataclass
from typing import Optional


@dataclass
class StagingHashDiff:
    """Result of comparing two staging hash indexes.

    Attributes:
        identical: True when both indexes have the same entries.
        added: Activity IDs present in remote but not local.
        removed: Activity IDs present in local but not remote.
        changed: Activity IDs with different status in local vs remote.
    """
    identical: bool
    added: list[str]
    removed: list[str]
    changed: list[str]


class StagingHashIndex:
    """Tier-1 fast-path staging comparison via hash index."""

    # ------------------------------------------------------------------
    # build
    # ------------------------------------------------------------------

    @staticmethod
    def build(rows: Optional[list[dict]]) -> list[dict]:
        """Build a hash index array from staging rows.

        Extracts ``activity_id`` and ``activity_status`` from each row.
        Rows missing ``activity_id`` are skipped. Output is sorted by
        ``activity_id`` for deterministic hashing.

        Args:
            rows: List of staging row dicts, or None/empty.

        Returns:
            Sorted list of ``{activity_id, activity_status}`` dicts.
        """
        if not rows:
            return []
        result = []
        for row in rows:
            aid = row.get("activity_id") if isinstance(row, dict) else None
            if aid:
                result.append({
                    "activity_id": aid,
                    "activity_status": row.get("activity_status", "active"),
                })
        result.sort(key=lambda r: r["activity_id"])
        return result

    # ------------------------------------------------------------------
    # build_from_store
    # ------------------------------------------------------------------

    @staticmethod
    def build_from_store(store) -> list[dict]:
        """Build a hash index directly from a row-level staging store.

        Reads the store's canonical rows via ``store.get_all_rows()`` and
        delegates to :meth:`build`. Equivalent to
        ``build(store.get_all_rows())`` — a fast-path that avoids pulling + 
        decrypting the full blob for change detection.

        Args:
            store: A store exposing ``get_all_rows()`` (e.g. SqliteStagingStore).

        Returns:
            Sorted list of ``{activity_id, activity_status}`` dicts (fresh).
        """
        rows = store.get_all_rows() if store is not None else []
        return StagingHashIndex.build(rows)

    # ------------------------------------------------------------------
    # computeHash
    # ------------------------------------------------------------------

    @staticmethod
    def computeHash(index: list[dict]) -> str:
        """Compute a deterministic SHA-256 hex digest of *index*.

        The index is sorted by ``activity_id`` before hashing, so the
        same set of rows always produces the same hash regardless of
        input order.

        Args:
            index: List of ``{activity_id, activity_status}`` dicts.

        Returns:
            64-character lowercase hex string (SHA-256).
        """
        sorted_index = sorted(index, key=lambda r: r.get("activity_id", ""))
        json_str = json.dumps(sorted_index, separators=(",", ":"), sort_keys=True)
        return hashlib.sha256(json_str.encode("utf-8")).hexdigest()

    # ------------------------------------------------------------------
    # compare
    # ------------------------------------------------------------------

    @staticmethod
    def _build_lookup_map(index: list[dict]) -> dict[str, str]:
        """Build an ``activity_id → activity_status`` lookup from *index*.

        Entries missing ``activity_id`` are skipped.
        """
        result: dict[str, str] = {}
        for entry in index:
            aid = entry.get("activity_id")
            if aid:
                result[aid] = entry.get("activity_status", "active")
        return result

    @staticmethod
    def compare(
        local: Optional[list[dict]],
        remote: Optional[list[dict]],
    ) -> StagingHashDiff:
        """Compare local and remote hash indexes.

        Returns a StagingHashDiff with the sets of added, removed, and
        changed activity_ids. When both indexes have identical entries,
        ``identical`` is True.

        None is treated as an empty index.

        Args:
            local: Local hash index (or None).
            remote: Remote hash index (or None).

        Returns:
            StagingHashDiff with sorted added/removed/changed lists.
        """
        local = local or []
        remote = remote or []

        local_map = StagingHashIndex._build_lookup_map(local)
        remote_map = StagingHashIndex._build_lookup_map(remote)

        added: list[str] = []
        removed: list[str] = []
        changed: list[str] = []

        # Find added + changed (in remote, not local or different status)
        for rid, rstatus in remote_map.items():
            if rid not in local_map:
                added.append(rid)
            elif local_map[rid] != rstatus:
                changed.append(rid)

        # Find removed (in local, not remote)
        for lid in local_map:
            if lid not in remote_map:
                removed.append(lid)

        added.sort()
        removed.sort()
        changed.sort()

        identical = not added and not removed and not changed

        return StagingHashDiff(
            identical=identical,
            added=added,
            removed=removed,
            changed=changed,
        )
