"""MergeEngine — entry_id-based deduplication merge of staging entries.

Uses ``entry_id`` as the primary dedup key (stable UUID per entry).
Falls back to ``(title, start_epoch)`` for backward compatibility
with entries created before the entry_id change.

When the same ``entry_id`` exists in both local and remote, remote wins —
it represents the more recent state.

The MergeEngine is a pure function: no I/O, no side effects, no dependencies
beyond Python builtins.
"""

import json

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

    # ------------------------------------------------------------------
    # row-level merge (activity_id LWW) — CCS-3 canonical-row sync gate
    # ------------------------------------------------------------------

    @staticmethod
    def _is_ended(row):
        """Whether a canonical staging row reflects an ended activity.

        Checks row-level ``activity_status`` first (canonical), then falls
        back to the ``is_active`` flag inside the ``activity`` JSON blob for
        rows that predate row-level status or carry an empty/missing status.
        Unknown status without ``is_active:false`` is treated as not-ended
        (fail-safe — never force a row to end on bad data).
        """
        if not row:
            return False
        status = row.get("activity_status")
        if status == "ended":
            return True
        if status is not None and status != "":
            return False  # active/paused

        # Fallback: activity blob `is_active: false` ⇒ ended
        try:
            activity_str = row.get("activity")
            if activity_str:
                activity = (
                    json.loads(activity_str)
                    if isinstance(activity_str, str)
                    else activity_str
                )
                if isinstance(activity, dict) and activity.get("is_active") is False:
                    return True
        except (ValueError, TypeError):
            pass

        return False

    @staticmethod
    def _effective_status(row):
        """Resolve empty-status fallback so an ended row normalizes to 'ended'."""
        if MergeEngine._is_ended(row):
            return "ended"
        v = row.get("activity_status") if row else None
        return v if v else "active"

    @staticmethod
    def _terminal_end_winner(local, remote):
        """ADR-033 terminal-state winner, if any.

        When exactly one side is ``ended`` and the other is not, the ``ended``
        side wins regardless of ``updated_at``. Returns ``"remote"``,
        ``"local"``, or ``None`` when both sides share the same terminal state
        (or neither ended).
        """
        local_ended = MergeEngine._is_ended(local)
        remote_ended = MergeEngine._is_ended(remote)
        if remote_ended and not local_ended:
            return "remote"
        if local_ended and not remote_ended:
            return "local"
        return None

    @staticmethod
    def _remote_wins(local, remote):
        """Terminal-state rule + LWW: does the remote row win the merge?"""
        terminal_winner = MergeEngine._terminal_end_winner(local, remote)
        if terminal_winner is not None:
            return terminal_winner == "remote"
        local_ts = (local or {}).get("updated_at") or 0
        remote_ts = (remote or {}).get("updated_at") or 0
        return remote_ts > local_ts

    def merge_rows(self, local_rows, remote_rows):
        """Merge two arrays of canonical staging rows by activity_id.

        Ported from the Web ``mergeRows`` (row_sync.js) per PHPSPEC §8.5:

          1. ``activity_id`` is the primary merge key; ``entry_id`` falls back.
          2. Terminal-state rule (ADR-033): if exactly one side is ``ended``
             and the other is ``active``/``paused``/unset, the ``ended`` side
             wins regardless of ``updated_at``. An activity cannot un-end.
          3. Otherwise, newer ``updated_at`` wins.
          4. On equal ``updated_at``, the local row wins (matches Flutter).
          5. Local-only rows with ``committed:true`` are excluded.
          6. Remote-only rows are included unconditionally.
          7. ``committed:true`` is irreversible (never downgraded to false).

        Output rows are sorted deterministically by ``activity_id`` so repeated
        merges of the same input produce byte-identical ordering.

        Pure function — does not mutate inputs; returns fresh dicts.

        Args:
            local_rows: Local canonical rows.
            remote_rows: Remote canonical rows.

        Returns:
            List of merged canonical rows, each with exactly the keys
            ``{activity_id, activity_status, activity, updated_at, committed}``.
        """
        loc = list(local_rows) if local_rows else []
        rem = list(remote_rows) if remote_rows else []

        merged: Dict[str, Any] = {}
        remote_keys = set()

        def _build(row, updated_at, committed):
            return {
                "activity_id": row.get("activity_id") or row.get("entry_id") or "",
                "activity_status": MergeEngine._effective_status(row),
                "activity": row.get("activity") if row.get("activity") is not None else "{}",
                "updated_at": updated_at,
                "committed": committed,
            }

        # Process local rows first
        for row in loc:
            if not row:
                continue
            key = row.get("activity_id") or row.get("entry_id")
            if not key:
                continue
            merged[key] = _build(
                row, row.get("updated_at") or 0, row.get("committed") or False
            )

        # Set of remote keys for committed-exclusion lookup
        for row in rem:
            if row:
                key = row.get("activity_id") or row.get("entry_id")
                if key:
                    remote_keys.add(key)

        # Merge remote rows
        for row in rem:
            if not row:
                continue
            key = row.get("activity_id") or row.get("entry_id")
            if not key:
                continue
            remote_time = row.get("updated_at") or 0
            remote_committed = row.get("committed") or False
            existing = merged.get(key)

            if existing is None:
                # Remote-only row → include unconditionally
                merged[key] = _build(row, remote_time, remote_committed)
            elif MergeEngine._remote_wins(existing, row):
                # Remote wins (LWW newer, or terminal-state: remote ended vs
                # local non-ended). committed is irreversible.
                merged[key] = _build(
                    row, remote_time, bool(existing.get("committed")) or remote_committed
                )
            elif remote_committed:
                # Local wins — but committed is irreversible
                existing["committed"] = True

        # Exclude local-only rows with committed:true (rule 4). Local-only
        # means the row's activity_id is NOT in the remote set.
        result = []
        for row in merged.values():
            if row.get("committed") and row.get("activity_id") not in remote_keys:
                continue
            result.append(row)

        # Deterministic output ordering
        result.sort(key=lambda r: r.get("activity_id", ""))
        return result
