"""Group M: MergeEngine.merge_rows terminal-state rule (ADR-033).

Phase 2 (RED) — these tests are written before the implementation and are
expected to FAIL on the current pure-LWW ``merge_rows``.

Mirrors the Web Group K assertions against the Python CLI merge engine.
"""

import json

from domain.staging.merge_engine import MergeEngine


def _row(aid, status, updated_at, activity="{}", committed=False):
    return {
        "activity_id": aid,
        "activity_status": status,
        "activity": activity,
        "updated_at": updated_at,
        "committed": committed,
    }


def _by_id(rows):
    return {r["activity_id"]: r for r in rows}


def test_m1_remote_ended_beats_newer_local_active():
    merged = MergeEngine().merge_rows(
        [_row("a", "active", 200)],
        [_row("a", "ended", 100)],
    )
    assert merged[0]["activity_status"] == "ended"


def test_m2_remote_ended_beats_older_local_active():
    merged = MergeEngine().merge_rows(
        [_row("a", "active", 100)],
        [_row("a", "ended", 200)],
    )
    assert merged[0]["activity_status"] == "ended"


def test_m3_remote_ended_beats_newer_local_paused():
    merged = MergeEngine().merge_rows(
        [_row("a", "paused", 200)],
        [_row("a", "ended", 100)],
    )
    assert merged[0]["activity_status"] == "ended"


def test_m4_local_ended_survives_newer_remote_active():
    merged = MergeEngine().merge_rows(
        [_row("a", "ended", 100)],
        [_row("a", "active", 200)],
    )
    assert merged[0]["activity_status"] == "ended"


def test_m5_both_ended_lww_newest_wins():
    merged = MergeEngine().merge_rows(
        [_row("a", "ended", 100, '{"v": "local"}')],
        [_row("a", "ended", 200, '{"v": "remote"}')],
    )
    assert merged[0]["activity_status"] == "ended"
    assert merged[0]["updated_at"] == 200
    assert merged[0]["activity"] == '{"v": "remote"}'


def test_m6_both_active_lww_newest_wins():
    merged = MergeEngine().merge_rows(
        [_row("a", "active", 100)],
        [_row("a", "active", 200)],
    )
    assert merged[0]["activity_status"] == "active"
    assert merged[0]["updated_at"] == 200


def test_m7_ended_winner_carries_end_epoch():
    local_activity = json.dumps({"title": "T", "start_epoch": 1000, "end_epoch": None, "is_active": True})
    remote_activity = json.dumps({"title": "T", "start_epoch": 1000, "end_epoch": 5000, "is_active": False})
    merged = MergeEngine().merge_rows(
        [_row("a", "active", 200, local_activity)],
        [_row("a", "ended", 100, remote_activity)],
    )
    assert merged[0]["activity_status"] == "ended"
    assert json.loads(merged[0]["activity"])["end_epoch"] == 5000


def test_m8_status_fallback_via_is_active():
    # M8a: empty status + no is_active:false → not ended → remote ended wins
    merged = MergeEngine().merge_rows(
        [_row("a", "", 200)],
        [_row("a", "ended", 100)],
    )
    assert merged[0]["activity_status"] == "ended"

    # M8b: empty status + is_active:false → ended (fallback) → local wins
    merged = MergeEngine().merge_rows(
        [_row("b", "", 200, json.dumps({"is_active": False}))],
        [_row("b", "active", 100)],
    )
    assert merged[0]["activity_status"] == "ended"


def test_m_int1_mixed_set_independent_and_committed_irreversible():
    local = [
        _row("a1", "active", 200),
        _row("a2", "ended", 100),
        _row("a3", "active", 300, "{}", committed=True),
    ]
    remote = [
        _row("a1", "ended", 100),
        _row("a2", "active", 200),
        _row("a3", "active", 100),
        _row("a4", "ended", 50),
    ]
    by_id = _by_id(MergeEngine().merge_rows(local, remote))
    assert by_id["a1"]["activity_status"] == "ended"
    assert by_id["a2"]["activity_status"] == "ended"
    assert by_id["a3"]["activity_status"] == "active"
    assert by_id["a3"]["committed"] is True
    assert by_id["a4"]["activity_status"] == "ended"
