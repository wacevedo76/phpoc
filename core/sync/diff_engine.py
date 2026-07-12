"""Row-level sync diff engine — LWW resolution (Python port).

Compares local staging rows against a remote manifest and ledger hash index
to produce a sync plan (DiffResult: pull, push, delete_local, fast_path).

This is a direct port of phpoc-web/src/sync/row_sync.js:buildDiff().
The 8-scenario resolution table is documented in ADR-025 and
ROW_LEVEL_STAGING_SYNC_PLAN.md.

Resolution scenarios:
  S1: Same row, remote newer → pull
  S2: Same row, local newer → push
  S3: Same timestamp, status differs → tie-break (remote wins)
  S4: Remote-only → pull
  S5: Local-only, in ledger hash index (committed) → delete_local
  S6: Local-only, NOT in hash index (new) → push
  S7: All local committed, remote empty → fastPath + delete_local
"""

from collections import namedtuple
from typing import Any, Dict, List, Optional


# ── Helpers ──────────────────────────────────────────────────────────

def _safe_ts(row: Dict[str, Any]) -> int:
    """Extract updated_at as int, defaulting to 0 for missing/None."""
    return int(row.get("updated_at", 0) or 0)


# ── DiffResult namedtuple ────────────────────────────────────────────

DiffResult = namedtuple('DiffResult', ['pull', 'push', 'delete_local', 'fast_path'])
"""Sync plan produced by buildDiff().

Fields:
    pull         — List[str]: activity_ids to pull from remote.
    push         — List[str]: activity_ids to push to remote.
    delete_local — List[str]: activity_ids to delete from local staging.
    fast_path    — bool: True when no network calls needed (pull + push both empty).
"""


# ── buildDiff — 8-scenario LWW resolution ────────────────────────────

def buildDiff(
    local_rows: Optional[List[Dict[str, Any]]],
    remote_manifest: Optional[Dict[str, Any]],
    ledger_hash_index: Optional[Dict[str, Any]]
) -> DiffResult:
    """Compare local staging rows against a remote manifest and ledger hash index.

    Args:
        local_rows: Current local staging rows (list of dicts with
            activity_id, activity_status, activity, updated_at).
            None/null treated as [].
        remote_manifest: Remote manifest dict with 'rows' (list of dicts
            with activity_id, activity_status, updated_at) and 'version'.
            None or missing rows treated as empty.
        ledger_hash_index: Dict of activity_id → {committed_at: int} for
            entries already committed to the ledger. None treated as {}.

    Returns:
        DiffResult(pull, push, delete_local, fast_path).
    """
    # ── Defensive normalization ──
    local = local_rows if isinstance(local_rows, list) else []

    remote_rows = []
    if remote_manifest and isinstance(remote_manifest, dict):
        rows = remote_manifest.get("rows")
        if isinstance(rows, list):
            remote_rows = rows

    hash_idx = ledger_hash_index if isinstance(ledger_hash_index, dict) else {}

    # ── Build lookup maps ──
    local_map: Dict[str, dict] = {}
    for row in local:
        if row and row.get("activity_id"):
            local_map[row["activity_id"]] = row

    remote_map: Dict[str, dict] = {}
    for row in remote_rows:
        if row and row.get("activity_id"):
            # Last-wins dedup for duplicate activity_ids in remote manifest
            remote_map[row["activity_id"]] = row

    pull: List[str] = []
    push: List[str] = []
    delete_local: List[str] = []

    # ── Process remote rows: compare against local ──
    for activity_id, remote_row in remote_map.items():
        local_row = local_map.get(activity_id)

        if not local_row:
            # S4: Remote-only → pull
            pull.append(activity_id)
            continue

        # Both sides have the row — compare timestamps
        remote_time = _safe_ts(remote_row)
        local_time = _safe_ts(local_row)

        if remote_time > local_time:
            # S1: Remote newer → pull
            pull.append(activity_id)
        elif local_time > remote_time:
            # S2: Local newer → push
            push.append(activity_id)
        else:
            # S3: Same timestamp — tie-break by status, remote wins
            remote_status = remote_row.get("activity_status", "") or ""
            local_status = local_row.get("activity_status", "") or ""
            if remote_status != local_status:
                # Different status → pull remote version
                pull.append(activity_id)
            # If status also matches, row is identical → no-op

    # ── Process local rows not in remote ──
    for activity_id, local_row in local_map.items():
        if activity_id in remote_map:
            continue  # already handled above

        if activity_id in hash_idx:
            # S5: In ledger hash index → committed → delete_local
            delete_local.append(activity_id)
        else:
            # S6: New local entry, not committed → push
            push.append(activity_id)

    # ── Compute fastPath ──
    # fastPath: no network calls needed. delete_local is purely local
    # cleanup, so it does not disable fastPath.
    fast_path = len(pull) == 0 and len(push) == 0

    return DiffResult(pull, push, delete_local, fast_path)
