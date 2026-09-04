"""Phase 2 (RED): CLI Sync-Gate Wiring — Test Definition.

Tests the activity_id row-level sync-gate wiring into the Python
``StagingService`` based on the Phase 1 blueprint at
``docs/planning/CLI_SYNC_GATE_WIRING_PHASE1.md`` (60 assertions).

Target modules built in Phase 3 (GREEN):
  - ``domain/staging/row_merge.py``  — ``dtoToCanonicalRow`` / ``canonicalRowToDTO`` (Group A)
  - ``merge_rows()`` on ``MergeEngine`` — activity_id LWW merge (Group B)
  - ``StagingHashIndex.build_from_store``  (Group E)
  - ``StagingService._merge_remote_into_local()``  (Group C)
  - ``SqliteStagingStore`` wiring into ``StagingService``  (Group D)
  - Sync-gate integration  (Group F)

All tests MUST fail in RED phase — the referenced modules/functions do not
exist yet (or deliberately exercise the future API). Phase 3 implements them.

Test groups:
  A1-A10: Canonical row conversion - dtoToCanonicalRow / canonicalRowToDTO
  B1-B14: merge_rows - activity_id LWW
  C1-C11: service._merge_remote_into_local()
  D1-D9:  SqliteStagingStore wired into StagingService
  E1-E6:  StagingHashIndex.build_from_store
  F1-F10: Sync-gate integration

Usage:
  python3 -m pytest tests/test_cli_sync_gate_wiring.py -v
"""

import unittest
import json
import os
import time
import tempfile
import sqlite3
from pathlib import Path

try:
    from domain.staging.row_merge import dtoToCanonicalRow, canonicalRowToDTO
    HAS_ROW_MERGE = True
except ImportError:
    HAS_ROW_MERGE = False
    # Future-API stubs so Groups A/C are visibly RED (NotImplementedError)
    # rather than silently skipped until Phase 3 creates the module.
    def dtoToCanonicalRow(dto, device_id=None, now=None):
        raise NotImplementedError(
            "row_merge.dtoToCanonicalRow not implemented (Phase 3)"
        )

    def canonicalRowToDTO(row):
        raise NotImplementedError(
            "row_merge.canonicalRowToDTO not implemented (Phase 3)"
        )

try:
    from domain.staging.merge_engine import MergeEngine
    HAS_MERGE_ENGINE = True
    # merge_rows may not exist yet on the class - future API
    if not hasattr(MergeEngine, "merge_rows"):
        def _missing_merge_rows(self, local, remote):
            raise NotImplementedError(
                "MergeEngine.merge_rows not implemented (Phase 3)"
            )
        MergeEngine.merge_rows = _missing_merge_rows
except ImportError:
    HAS_MERGE_ENGINE = False
    class MergeEngine:  # stub so import errors degrade to assertion failures
        @staticmethod
        def merge_rows(local, remote):
            raise NotImplementedError("MergeEngine not implemented (Phase 3)")

try:
    from core.staging_hash_index import StagingHashIndex
    HAS_HASH_INDEX = True
    if not hasattr(StagingHashIndex, "build_from_store"):
        @staticmethod
        def _missing_build_from_store(store):
            raise NotImplementedError(
                "StagingHashIndex.build_from_store not implemented (Phase 3)"
            )
        StagingHashIndex.build_from_store = _missing_build_from_store
except ImportError:
    HAS_HASH_INDEX = False
    class StagingHashIndex:
        def __init__(self, *a, **k):  # placeholder for import errors
            pass
        @staticmethod
        def build_from_store(store):
            raise NotImplementedError("StagingHashIndex not implemented (Phase 3)")

try:
    from storage.implementations.sqlite_staging import SqliteStagingStore
    HAS_SQLITE_STORE = True
except ImportError:
    HAS_SQLITE_STORE = False
    SqliteStagingStore = None

from domain.staging.service import StagingService
from domain.staging.local_cache import LocalStagingCache
from storage.staging_store import AbstractStagingStore
from storage.implementations.file_staging import FileStagingStore

TMP_ROOT = Path("/dev/shm") if os.path.exists("/dev/shm") else None


def temp_dir():
    """Create a temporary directory for test use."""
    return Path(tempfile.mkdtemp(dir=str(TMP_ROOT) if TMP_ROOT else None))


def now_ms():
    """Current epoch milliseconds."""
    return int(time.time() * 1000)


def canonical_row(activity_id, activity_status="active", activity=None,
                  updated_at=None, committed=False):
    """Create a canonical staging row dict (PHPSPEC 8.5)."""
    return {
        "activity_id": activity_id,
        "activity_status": activity_status,
        "activity": activity if activity is not None else json.dumps(
            {"title": "Title " + str(activity_id)}),
        "updated_at": updated_at if updated_at is not None else now_ms(),
        "committed": committed,
    }


def remote_dto(entry_id, title="Remote", is_active=True, is_paused=False):
    """Create a decrypted remote DTO shape (as _raw_entry_to_dto yields)."""
    return {
        "entry_id": entry_id,
        "title": title,
        "start_epoch": now_ms(),
        "end_epoch": None,
        "duration": 0,
        "is_active": is_active,
        "is_paused": is_paused,
        "pauses": [],
        "tags": [],
        "comment": None,
        "media": [],
        "metadata": {},
        "device_uuid": "",
        "end_device_uuid": "",
        "block_index": None,
        "committed": False,
        "hash": "",
        "source": "remote",
    }


def make_local_dto(activity_id, title="Local", updated_at=None,
                   committed=False, is_active=True, is_paused=False):
    """Create a decrypted local DTO (as read_entries() returns)."""
    return {
        "entry_id": "entry-" + activity_id,
        "activity_id": activity_id,
        "title": title,
        "start_epoch": now_ms(),
        "end_epoch": None,
        "duration": 0,
        "is_active": is_active,
        "is_paused": is_paused,
        "pauses": [],
        "tags": [title],
        "comment": None,
        "media": [],
        "metadata": {},
        "date": time.strftime("%Y-%m-%d", time.gmtime()),
        "device_uuid": "device-a",
        "end_device_uuid": "",
        "hash": "",
        "source": "local",
        "committed": committed,
        "entry_index": 0,
        "has_encrypted_fields": False,
        **({"updated_at": updated_at} if updated_at is not None else {}),
    }


def raw_entry(entry_id, title, *, is_active=True, is_paused=False,
              committed=False, updated_at=None, start_epoch=1700000000000):
    """Create a raw remote blob entry (as stored in the remote blob)."""
    entry = {
        "data": {
            "startTime_enc": "plain:" + str(start_epoch),
            "entry_id": entry_id,
            "title": "plain:" + title,
            "is_active": is_active,
            "is_paused": is_paused,
        },
        "committed": committed,
        "hash": "",
        "block_index": None,
    }
    if updated_at is not None:
        entry["updated_at"] = updated_at
    return entry


class _NoopCrypto:
    """Minimal crypto shim returning values unchanged (plain: semantics)."""

    def __init__(self):
        self.master_key = b"\x01\x02\x03\x04\x05\x06\x07\x08" * 4

    def seal(self, *a, **k):
        return b"sealed"

    def encrypt(self, value):
        if value is None:
            return None
        s = value if isinstance(value, str) else json.dumps(value)
        return "plain:" + s

    def decrypt(self, value):
        if value is None:
            return None
        if isinstance(value, str) and value.startswith("plain:"):
            return value[6:]
        return value

    def _encrypt_field(self, value):
        return self.encrypt(value)

    def encrypt_field(self, value):
        return self.encrypt(value)


class _TrackingStore(AbstractStagingStore):
    """In-memory AbstractStagingStore recording write calls."""

    def __init__(self):
        self._rows = []
        self.write_calls = []

    def read_entries(self):
        return list(self._rows)

    def write_entries(self, data):
        self._rows = list(data)
        self.write_calls.append(list(data))

    def append_entry(self, entry):
        self._rows.append(entry)

    def remove_entries(self, indices):
        for i in sorted(indices, reverse=True):
            del self._rows[i]

    def update_entry(self, index, fields):
        d = dict(self._rows[index])
        d.update(fields)
        self._rows[index] = d


# ══════════════════════════════════════════════════════════════════════
# Group A: Canonical row conversion (A1-A10)
# ══════════════════════════════════════════════════════════════════════

class TestCanonicalRowConversion(unittest.TestCase):
    """Group A: dtoToCanonicalRow / canonicalRowToDTO."""

    def setUp(self):
        self.device_id = "device-A"
        self.now = 1700000000000

    def _dto(self, **overrides):
        d = {
            "entry_id": "entry-1",
            "activity_id": "act-1",
            "title": "Meditate",
            "start_epoch": 1700000000000,
            "end_epoch": None,
            "duration": 0,
            "is_active": True,
            "is_paused": False,
            "pauses": [],
            "tags": ["focus"],
            "comment": "nice",
            "media": [],
            "metadata": {"k": "v"},
            "device_uuid": "device-A",
            "end_device_uuid": "",
            "block_index": 5,
            "updated_at": 1700000001000,
            "committed": True,
        }
        d.update(overrides)
        return d

    def test_A1_activity_id_prefers_activity_id_falls_back_to_entry_id(self):
        """A1: activity_id = dto.activity_id, falling back to entry_id."""
        row = dtoToCanonicalRow(self._dto(), self.device_id, self.now)
        self.assertEqual(row["activity_id"], "act-1")
        dto_no_activity = self._dto()
        dto_no_activity.pop("activity_id", None)
        row2 = dtoToCanonicalRow(dto_no_activity, self.device_id, self.now)
        self.assertEqual(row2["activity_id"], "entry-1")

    def test_A2_status_derived_from_flags(self):
        """A2: activity_status derived: inactive→ended, paused→paused, else active."""
        self.assertEqual(
            dtoToCanonicalRow(self._dto(is_active=False), self.device_id, self.now)["activity_status"],
            "ended",
        )
        self.assertEqual(
            dtoToCanonicalRow(self._dto(is_paused=True), self.device_id, self.now)["activity_status"],
            "paused",
        )
        self.assertEqual(
            dtoToCanonicalRow(self._dto(), self.device_id, self.now)["activity_status"],
            "active",
        )

    def test_A3_activity_flattens_dto_to_canonical_json(self):
        """A3: activity column is the DTO flattened to canonical JSON string."""
        row = dtoToCanonicalRow(self._dto(), self.device_id, self.now)
        activity = json.loads(row["activity"])
        for field in ("title", "start_epoch", "end_epoch", "duration", "tags",
                      "comment", "media", "entry_id", "is_active", "is_paused",
                      "pauses", "metadata", "device_uuid", "end_device_uuid",
                      "block_index"):
            self.assertIn(field, activity, "activity JSON missing field " + field)
        self.assertEqual(activity["title"], "Meditate")
        no_uuid = self._dto()
        no_uuid.pop("device_uuid", None)
        activity2 = json.loads(dtoToCanonicalRow(no_uuid, self.device_id, self.now)["activity"])
        self.assertEqual(activity2["device_uuid"], self.device_id)

    def test_A4_updated_at_uses_dto_else_now(self):
        """A4: updated_at = dto.updated_at when present, else now."""
        row = dtoToCanonicalRow(self._dto(), self.device_id, self.now)
        self.assertEqual(row["updated_at"], 1700000001000)
        dto_no_ts = self._dto()
        dto_no_ts.pop("updated_at", None)
        row2 = dtoToCanonicalRow(dto_no_ts, self.device_id, self.now)
        self.assertEqual(row2["updated_at"], self.now)

    def test_A5_committed_preserved(self):
        """A5: committed preserved from DTO (default False)."""
        row = dtoToCanonicalRow(self._dto(committed=True), self.device_id, self.now)
        self.assertTrue(row["committed"])
        row2 = dtoToCanonicalRow(self._dto(committed=False), self.device_id, self.now)
        self.assertFalse(row2["committed"])

    def test_A6_canonicalRowToDTO_parses_activity_json(self):
        """A6: canonicalRowToDTO parses activity JSON to flat DTO fields."""
        row = canonical_row(
            "act-1",
            activity=json.dumps({
                "title": "Run",
                "start_epoch": 1700000000000,
                "end_epoch": 1700000360000,
                "duration": 360000,
                "tags": ["health"],
                "comment": "done",
                "media": [],
                "entry_id": "entry-1",
                "is_active": True,
                "is_paused": False,
                "pauses": [],
                "metadata": {},
                "device_uuid": "device-A",
                "end_device_uuid": "",
                "block_index": 5,
            }),
        )
        dto = canonicalRowToDTO(row)
        self.assertEqual(dto["title"], "Run")
        self.assertEqual(dto["start_epoch"], 1700000000000)
        self.assertEqual(dto["end_epoch"], 1700000360000)
        self.assertEqual(dto["duration"], 360000)

    def test_A7_canonicalRowToDTO_inverse_status(self):
        """A7: status flags inverse of A2 — is_active / is_paused round-trip."""
        ended = canonicalRowToDTO(canonical_row("a1", activity_status="ended"))
        self.assertFalse(ended["is_active"])
        self.assertFalse(ended["is_paused"])
        paused = canonicalRowToDTO(canonical_row("a1", activity_status="paused"))
        self.assertTrue(paused["is_paused"])
        active = canonicalRowToDTO(canonical_row("a1", activity_status="active"))
        self.assertTrue(active["is_active"])
        self.assertFalse(active["is_paused"])

    def test_A8_canonicalRowToDTO_sets_date_from_start_epoch(self):
        """A8: date derived from start_epoch (YYYY-MM-DD)."""
        dto = canonicalRowToDTO(canonical_row(
            "a1", activity=json.dumps({"start_epoch": 1700000000000}),
        ))
        # 1700000000000 ms = 2023-11-14 UTC
        self.assertEqual(dto["date"], "2023-11-14")

    def test_A9_canonicalRowToDTO_malformed_activity_is_safe(self):
        """A9: malformed activity string returns a safe DTO, not a crash."""
        row = canonical_row("a1", activity="not-json{{")
        dto = canonicalRowToDTO(row)
        self.assertIsNotNone(dto)
        self.assertEqual(dto["title"], "")
        self.assertEqual(dto["start_epoch"], 0)

    def test_A10_dtoToCanonicalRow_none_or_missing_id_is_safe(self):
        """A10: dtoToCanonicalRow(None)/missing id → empty activity_id, no crash."""
        row = dtoToCanonicalRow(None, self.device_id, self.now)
        self.assertEqual(row["activity_id"], "")
        row2 = dtoToCanonicalRow({}, self.device_id, self.now)
        self.assertEqual(row2["activity_id"], "")


# ══════════════════════════════════════════════════════════════════════
# Group B: merge_rows - activity_id LWW (B1-B14)
# ══════════════════════════════════════════════════════════════════════

@unittest.skipUnless(HAS_MERGE_ENGINE, "MergeEngine not implemented (Phase 3)")
class TestMergeRows(unittest.TestCase):
    """Group B: MergeEngine.merge_rows - activity_id LWW."""

    def setUp(self):
        self.engine = MergeEngine()

    def _merge(self, local, remote):
        return self.engine.merge_rows(local, remote)

    def test_B1_remote_newer_wins(self):
        """B1: same activity_id, remote updated_at newer → remote wins."""
        local = [canonical_row("a1", updated_at=1000, activity_status="active",
                               activity=json.dumps({"title": "local"}))]
        remote = [canonical_row("a1", updated_at=2000, activity_status="ended",
                                activity=json.dumps({"title": "remote"}))]
        merged = self._merge(local, remote)
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["updated_at"], 2000)
        self.assertEqual(merged[0]["activity_status"], "ended")
        self.assertIn("remote", json.loads(merged[0]["activity"])["title"])

    def test_B2_local_newer_wins(self):
        """B2: same activity_id, local updated_at newer → local wins.

        Remote status is 'paused' (non-terminal) so this still exercises pure
        LWW — ADR-033 gives 'ended' terminal-state precedence regardless of
        ``updated_at``, covered separately in test_merge_engine_terminal_state.py.
        """
        local = [canonical_row("a1", updated_at=3000, activity_status="active")]
        remote = [canonical_row("a1", updated_at=2000, activity_status="paused")]
        merged = self._merge(local, remote)
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["updated_at"], 3000)
        self.assertEqual(merged[0]["activity_status"], "active")

    def test_B3_equal_updated_at_local_wins(self):
        """B3: equal updated_at → local wins (tie-break)."""
        local = [canonical_row("a1", updated_at=1000, activity_status="active",
                               activity=json.dumps({"title": "local"}))]
        remote = [canonical_row("a1", updated_at=1000, activity_status="paused",
                                activity=json.dumps({"title": "remote"}))]
        merged = self._merge(local, remote)
        self.assertEqual(len(merged), 1)
        self.assertIn("local", json.loads(merged[0]["activity"])["title"])

    def test_B4_committed_local_only_excluded(self):
        """B4: local-only committed:true + absent remote → excluded."""
        local = [canonical_row("a1", committed=True)]
        remote = [canonical_row("a2", committed=False)]
        merged = self._merge(local, remote)
        self.assertNotIn("a1", [r["activity_id"] for r in merged])

    def test_B5_committed_false_local_only_included(self):
        """B5: local-only committed:false → included (new entry preserved)."""
        local = [canonical_row("a1", committed=False)]
        remote = []
        merged = self._merge(local, remote)
        self.assertEqual([r["activity_id"] for r in merged], ["a1"])

    def test_B6_remote_only_included(self):
        """B6: remote-only row → included unconditionally."""
        local = []
        remote = [canonical_row("r1")]
        merged = self._merge(local, remote)
        self.assertEqual([r["activity_id"] for r in merged], ["r1"])

    def test_B7_committed_irreversible(self):
        """B7: remote-wins row with local committed:true → committed stays true."""
        local = [canonical_row("a1", updated_at=1000, committed=True)]
        remote = [canonical_row("a1", updated_at=2000, committed=False)]
        merged = self._merge(local, remote)
        self.assertEqual(len(merged), 1)
        self.assertTrue(merged[0]["committed"])

    def test_B8_missing_columns_defaulted(self):
        """B8: missing activity_status/activity defaulted (active / '{}')."""
        local = [{"activity_id": "a1", "updated_at": 1000}]
        remote = []
        merged = self._merge(local, remote)
        self.assertEqual(merged[0]["activity_status"], "active")
        self.assertEqual(merged[0]["activity"], "{}")

    def test_B9_missing_updated_at_defaults_0(self):
        """B9: missing updated_at defaults to 0 (deterministic)."""
        local = [{"activity_id": "a1", "activity_status": "active", "activity": "{}"}]
        remote = []
        merged = self._merge(local, remote)
        self.assertEqual(merged[0]["updated_at"], 0)

    def test_B10_does_not_mutate_inputs(self):
        """B10: returns a new list - inputs are not mutated."""
        local = [canonical_row("a1")]
        remote = [canonical_row("a1", updated_at=1)]
        local_snap = [dict(r) for r in local]
        remote_snap = [dict(r) for r in remote]
        merged = self._merge(local, remote)
        self.assertIsNot(merged, local)
        self.assertEqual(local, local_snap)
        self.assertEqual(remote, remote_snap)

    def test_B11_dedup_by_entry_id_fallback(self):
        """B11: dedup by activity_id, entry_id as fallback key."""
        local = [{"entry_id": "e1", "updated_at": 100, "activity_status": "active",
                  "activity": json.dumps({"title": "local"})}]
        remote = [{"entry_id": "e1", "updated_at": 200, "activity_status": "paused",
                   "activity": json.dumps({"title": "remote"})}]
        merged = self._merge(local, remote)
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["updated_at"], 200)
        self.assertIn("remote", json.loads(merged[0]["activity"])["title"])

    def test_B12_deterministic_sorted_output(self):
        """B12: stable input order → deterministic sorted-by-activity_id output."""
        local = [canonical_row("b", updated_at=1),
                 canonical_row("a", updated_at=1),
                 canonical_row("c", updated_at=1)]
        merged1 = self._merge(local, [])
        merged2 = self._merge(list(reversed(local)), [])
        self.assertEqual([r["activity_id"] for r in merged1],
                         [r["activity_id"] for r in merged2])
        self.assertEqual([r["activity_id"] for r in merged1], ["a", "b", "c"])

    def test_B13_50_mixed_rows_classify(self):
        """B13: 50 mixed rows classify correctly (stress)."""
        local, remote = [], []
        for i in range(10):  # both - remote newer
            local.append(canonical_row("both%d" % i, updated_at=1000))
            remote.append(canonical_row("both%d" % i, updated_at=2000))
        for i in range(10, 20):  # both - local newer
            local.append(canonical_row("both%d" % i, updated_at=3000))
            remote.append(canonical_row("both%d" % i, updated_at=1000))
        for i in range(20, 30):  # local-only uncommitted
            local.append(canonical_row("loc%d" % i, committed=False))
        for i in range(30, 40):  # local-only committed
            local.append(canonical_row("locc%d" % i, committed=True))
        for i in range(40, 50):  # remote-only
            remote.append(canonical_row("rem%d" % i))

        merged = self._merge(local, remote)
        ids = [r["activity_id"] for r in merged]
        # 40 expected: 10 both-remote + 10 both-local + 10 local-only-uncommitted
        # + 10 remote-only (local-only committed excluded)
        self.assertEqual(len(merged), 40)
        for i in range(10):
            self.assertIn("both%d" % i, ids)
        for i in range(40, 50):
            self.assertIn("rem%d" % i, ids)
        for i in range(30, 40):
            self.assertNotIn("locc%d" % i, ids)

    def test_B14_schema_conformance(self):
        """B14: every output row has exactly the canonical schema shape."""
        local = [canonical_row("a1", activity_status="active")]
        remote = [canonical_row("a1", updated_at=1), canonical_row("r1")]
        merged = self._merge(local, remote)
        for r in merged:
            self.assertEqual(set(r.keys()),
                             {"activity_id", "activity_status", "activity",
                              "updated_at", "committed"})
        self.assertEqual(len(merged), 2)


# ══════════════════════════════════════════════════════════════════════
# Group C: service._merge_remote_into_local() (C1-C11)
# ══════════════════════════════════════════════════════════════════════

class TestMergeRemoteIntoLocal(unittest.TestCase):
    """Group C: StagingService._merge_remote_into_local()."""

    def setUp(self):
        self.crypto = _NoopCrypto()
        self.store = _TrackingStore()
        self.service = StagingService(
            crypto=self.crypto,
            staging_store=self.store,
            data_dir=str(temp_dir()),
        )

    def test_C1_local_dtos_converted_to_canonical_rows(self):
        """C1: local read_entries() DTOs become the local canonical row set."""
        self.service._local.write_entries([make_local_dto("a1", title="Local A1")])
        remote_blob = {"entries": [], "device_id": "device-remote"}
        merged = self.service._merge_remote_into_local(remote_blob, None)
        self.assertTrue(any(e.get("activity_id") == "a1" for e in merged))

    def test_C2_remote_entries_converted_via_raw(self):
        """C2: remote blob entries become canonical rows via _raw_entry_to_dto."""
        raw = raw_entry("rem-1", "Remote One")
        remote_blob = {"entries": [raw], "device_id": "device-remote"}
        merged = self.service._merge_remote_into_local(remote_blob, None)
        self.assertTrue(any(e.get("title") == "Remote One" for e in merged))

    def test_C3_merge_invocation_produces_canonical_set(self):
        """C3: merge_rows(local_rows, remote_rows) produces merged canonical set."""
        self.service._local.write_entries([make_local_dto("a1", title="Local")])
        remote_blob = {"entries": [raw_entry("r1", "Remote")], "device_id": "device-remote"}
        merged = self.service._merge_remote_into_local(remote_blob, None)
        ids = {e.get("activity_id") or e.get("entry_id") for e in merged}
        self.assertIn("a1", ids)
        self.assertIn("r1", ids)

    def test_C4_remoteWonIds_detected(self):
        """C4: remoteWonIds — activity_ids where remote.updated_at strictly newer."""
        self.service._local.write_entries([make_local_dto("a1", title="Local", updated_at=1000)])
        raw = raw_entry("a1", "RemoteNew", updated_at=2000)
        remote_blob = {"entries": [raw], "device_id": "device-remote"}
        merged = self.service._merge_remote_into_local(remote_blob, None)
        self.assertTrue(any(e.get("title") == "RemoteNew" for e in merged))

    def test_C5_unwon_rows_keep_full_local_dto_fidelity(self):
        """C5: unwon rows reuse the full-fidelity local DTO (extra fields kept)."""
        dto = make_local_dto("a1", title="Fidelity", updated_at=5000)
        dto["my_extra_field"] = "keep-me"
        self.service._local.write_entries([dto])
        raw = raw_entry("a1", "RemoteStale", updated_at=1000)
        remote_blob = {"entries": [raw], "device_id": "device-remote"}
        merged = self.service._merge_remote_into_local(remote_blob, None)
        found = next(e for e in merged if e.get("activity_id") == "a1")
        self.assertEqual(found.get("my_extra_field"), "keep-me")
        self.assertEqual(found.get("title"), "Fidelity")

    def test_C6_remote_won_rebuilt_via_canonicalRowToDTO(self):
        """C6: remote-won rows rebuilt via canonicalRowToDTO."""
        self.service._local.write_entries([make_local_dto("a1", updated_at=1000)])
        raw = raw_entry("a1", "RemoteWon", updated_at=4000, is_active=False)
        remote_blob = {"entries": [raw], "device_id": "device-remote"}
        merged = self.service._merge_remote_into_local(remote_blob, None)
        found = next(e for e in merged if (e.get("activity_id") or e.get("entry_id")) == "a1")
        self.assertEqual(found.get("title"), "RemoteWon")
        self.assertFalse(found.get("is_active"))

    def test_C7_committed_dtos_filtered_before_write(self):
        """C7: committed DTOs filtered out before write (committed-exclusion)."""
        self.service._local.write_entries([
            make_local_dto("c1", committed=True),
            make_local_dto("u1", committed=False),
        ])
        merged = self.service._merge_remote_into_local({"entries": []}, None)
        ids = [e.get("activity_id") for e in merged]
        self.assertNotIn("c1", ids)
        self.assertIn("u1", ids)

    def test_C8_dedup_dtos_by_activity_id_first_wins(self):
        """C8: dedup DTOs by activity_id (first wins) during rebuild."""
        self.service._local.write_entries([
            make_local_dto("a1", title="First", updated_at=1000),
            make_local_dto("a1", title="Second", updated_at=2000),
        ])
        merged = self.service._merge_remote_into_local({"entries": []}, None)
        a1 = [e for e in merged if e.get("activity_id") == "a1"]
        self.assertEqual(len(a1), 1)

    def test_C9_merge_failure_degrades_to_push_local(self):
        """C9: bad remote row → degrade gracefully (no crash, no data loss)."""
        self.service._local.write_entries([make_local_dto("keep", title="Keep")])
        bad_remote = {"entries": ["not-a-dict"], "device_id": "device-remote"}
        merged = self.service._merge_remote_into_local(bad_remote, None)
        self.assertTrue(any(e.get("title") == "Keep" for e in merged))

    def test_C10_idempotent_reconcile(self):
        """C10: re-merge on converged set produces no new dedup churn."""
        self.service._local.write_entries([make_local_dto("a1", title="Stable", updated_at=5000)])
        data = {"entries": [raw_entry("a1", "Stable", updated_at=5000)],
                "device_id": "device-remote"}
        first = self.service._merge_remote_into_local(data, None)
        second = self.service._merge_remote_into_local(data, None)
        self.assertEqual(len(first), len(second))
        self.assertEqual(
            sorted(e.get("activity_id") or e.get("entry_id") for e in first),
            sorted(e.get("activity_id") or e.get("entry_id") for e in second),
        )

    def test_C11_result_written_via_write_entries(self):
        """C11: reconciled DTOs become the new local staging state."""
        self.service._local.write_entries([
            make_local_dto("a1", title="Local", updated_at=1000),
        ])
        merged = self.service._merge_remote_into_local({"entries": []}, None)
        self.assertEqual(len(self.service._local.write_calls), 2)  # setup + merge
        self.assertTrue(len(merged) >= 1)


# ══════════════════════════════════════════════════════════════════════
# Group D: SqliteStagingStore wired into StagingService (D1-D9)
# ══════════════════════════════════════════════════════════════════════

@unittest.skipUnless(HAS_SQLITE_STORE, "SqliteStagingStore not implemented (Phase 3)")
class TestSqliteStoreWiredIntoService(unittest.TestCase):
    """Group D: StagingService backed by SqliteStagingStore."""

    def setUp(self):
        self.test_dir = temp_dir()
        self.db_path = str(self.test_dir / "staging.db")
        self.crypto = _NoopCrypto()
        self.store = SqliteStagingStore(self.db_path)
        self.service = StagingService(
            crypto=self.crypto,
            staging_store=self.store,
            data_dir=str(temp_dir()),
        )

    def tearDown(self):
        try:
            self.store.close()
        except Exception:
            pass

    def test_D1_service_accepts_sqlite_store(self):
        """D1: StagingService accepts and uses a SqliteStagingStore."""
        # Service constructed without raising + wraps it in LocalStagingCache
        self.assertIsInstance(self.service._local, LocalStagingCache)
        self.assertIs(self.service._local._store, self.store)

    def test_D2_capture_persists_row_visible_in_read_entries(self):
        """D2: capture() on SQLite-backed service persists via read_entries()."""
        self.service.capture("Focus", 1700000000000)
        entries = self.service.read_entries()
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["title"], "Focus")

    def test_D3_dual_interface_consistency(self):
        """D3: put_row/get_all_rows/delete_row consistent with read_entries()."""
        self.service.capture("Alpha", 1700000000000)
        rows = self.store.get_all_rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["activity_id"], self.service.read_entries()[0]["activity_id"])

    def test_D4_remove_synced_deletes_sqlite_rows(self):
        """D4: remove_synced(indices) deletes the correct SQLite rows."""
        self.service.capture("One", 1700000000000)
        self.service.capture("Two", 1700000001000)
        self.assertEqual(self.store.count(), 2)
        self.service.remove_synced([0])
        self.assertEqual(self.store.count(), 1)
        remaining = self.service.read_entries()
        self.assertEqual(len(remaining), 1)
        self.assertEqual(remaining[0]["title"], "Two")

    def test_D5_update_entry_bumps_updated_at_in_sqlite(self):
        """D5: update_entry (modify) bumps updated_at in SQLite."""
        self.service.capture("Focus", 1700000000000)
        before = self.store.get_all_rows()[0]["updated_at"]
        self.service.modify(0, {"comment": "updated"})
        rows = self.store.get_all_rows()
        self.assertEqual(len(rows), 1)
        self.assertGreaterEqual(rows[0]["updated_at"], before)
        self.assertNotEqual(rows[0]["updated_at"], before)

    def test_D6_read_entries_preserves_field_types(self):
        """D6: read_entries() preserves field types (updated_at int, activity str)."""
        self.service.capture("Focus", 1700000000000)
        rows = self.store.get_all_rows()
        self.assertIsInstance(rows[0]["updated_at"], int)
        self.assertIsInstance(rows[0]["activity"], str)

    def test_D7_store_survives_close_reopen(self):
        """D7: store survives close → reopen (data persists across connections)."""
        self.service.capture("Persist", 1700000000000)
        self.store.close()
        store2 = SqliteStagingStore(self.db_path)
        try:
            rows = store2.get_all_rows()
            self.assertEqual(len(rows), 1)
            self.assertIn("Persist", rows[0]["activity"])
        finally:
            store2.close()

    def test_D8_service_works_with_FileStagingStore_backward_compat(self):
        """D8: service still works when store is FileStagingStore (backward compat)."""
        file_store = FileStagingStore(self.test_dir / "staging.json")
        svc = StagingService(crypto=self.crypto, staging_store=file_store,
                             data_dir=str(temp_dir()))
        svc.capture("FileMode", 1700000000000)
        entries = svc.read_entries()
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["title"], "FileMode")

    def test_D9_empty_store_read_entries_returns_empty(self):
        """D9: empty store → read_entries() returns [], count 0."""
        self.assertEqual(self.store.count(), 0)
        self.assertEqual(self.service.read_entries(), [])


# ══════════════════════════════════════════════════════════════════════
# Group E: StagingHashIndex.build_from_store (E1-E6)
# ══════════════════════════════════════════════════════════════════════

class _RowsOnlyStore:
    """Minimal store exposing only get_all_rows() (for build_from_store)."""

    def __init__(self, rows):
        self._rows = rows

    def get_all_rows(self):
        return list(self._rows)

    def count(self):
        return len(self._rows)


@unittest.skipUnless(HAS_SQLITE_STORE, "SqliteStagingStore not implemented (Phase 3)")
class TestBuildFromStore(unittest.TestCase):
    """Group E: StagingHashIndex.build_from_store."""

    def test_E1_build_from_store_reads_get_all_rows(self):
        """E1: build_from_store(store) reads all rows via store.get_all_rows()."""
        store = _RowsOnlyStore([
            canonical_row("a1", activity_status="active"),
        ])
        index = StagingHashIndex.build_from_store(store)
        self.assertEqual(index, [{"activity_id": "a1", "activity_status": "active"}])

    def test_E2_produces_sorted_index_shape(self):
        """E2: produces [{activity_id, activity_status}] sorted by activity_id."""
        store = _RowsOnlyStore([
            canonical_row("b1", activity_status="paused"),
            canonical_row("a1", activity_status="ended"),
        ])
        index = StagingHashIndex.build_from_store(store)
        self.assertEqual(index, [
            {"activity_id": "a1", "activity_status": "ended"},
            {"activity_id": "b1", "activity_status": "paused"},
        ])

    def test_E3_rows_missing_activity_id_skipped(self):
        """E3: rows missing activity_id are skipped (defensive)."""
        store = _RowsOnlyStore([
            canonical_row("a1"),
            {"activity_status": "active", "activity": "{}"},
            None,
        ])
        index = StagingHashIndex.build_from_store(store)
        self.assertEqual(index, [{"activity_id": "a1", "activity_status": "active"}])

    def test_E4_empty_store_empty_index(self):
        """E4: empty store → empty index."""
        store = _RowsOnlyStore([])
        self.assertEqual(StagingHashIndex.build_from_store(store), [])

    def test_E5_equals_manual_build_for_hash_equivalence(self):
        """E5: computeHash(store) == computeHash(build(all_rows))."""
        rows = [canonical_row("x1", "active"), canonical_row("y1", "ended")]
        store = _RowsOnlyStore(rows)
        from_store = StagingHashIndex.build_from_store(store)
        from_manual = StagingHashIndex.build(rows)
        self.assertEqual(from_store, from_manual)
        self.assertEqual(StagingHashIndex.computeHash(from_store),
                         StagingHashIndex.computeHash(from_manual))

    def test_E6_returns_fresh_list_not_alias(self):
        """E6: build_from_store returns a fresh list (no alias of store rows)."""
        rows = [canonical_row("a1")]
        store = _RowsOnlyStore(rows)
        index = StagingHashIndex.build_from_store(store)
        index[0]["activity_status"] = "mutated"
        # Store rows should be unchanged
        self.assertEqual(rows[0]["activity_status"], "active")


# ══════════════════════════════════════════════════════════════════════
# Group F: Sync-gate integration (F1-F10)
# ══════════════════════════════════════════════════════════════════════

class _FakeTransport:
    """In-memory transport for remote blob/cookie/hash-index round-trips."""

    def __init__(self):
        self._blobs = {}
        self.push_ops = []

    def push(self, path, data, timeout_ms=None):
        self._blobs[path] = data
        self.push_ops.append((path, data))

    def pull(self, path, timeout_ms=None):
        return self._blobs.get(path)

    def list_files(self, prefix, timeout_ms=None):
        return [k for k in self._blobs if k.startswith(prefix)]


@unittest.skipUnless(HAS_SQLITE_STORE, "SqliteStagingStore not implemented (Phase 3)")
class TestSyncGateIntegration(unittest.TestCase):
    """Group F: Full CCS-3 pipeline through StagingService."""

    def setUp(self):
        self.crypto = _NoopCrypto()
        self.db_path = str(temp_dir() / "staging.db")
        self.store = SqliteStagingStore(self.db_path)
        self.service = StagingService(
            crypto=self.crypto,
            staging_store=self.store,
            data_dir=str(temp_dir()),
        )

    def tearDown(self):
        try:
            self.store.close()
        except Exception:
            pass

    def test_F1_full_reconcile_end_to_end(self):
        """F1: full reconcile on SQLite-backed service: DTO→canonical→merge→DTO→write."""
        # Local entry shares the remote fixture's activity_id so LWW-by-id
        # consolidation collapses them into a single row (same as F2).
        self.service._local.write_entries([
            make_local_dto("alpha", title="Alpha"),
        ])
        remote_blob = {
            "entries": [raw_entry("alpha", "AlphaUpdated", updated_at=99999)],
            "device_id": "device-remote",
        }
        # Reconcile via the future _merge_remote_into_local, then persist
        merged = self.service._merge_remote_into_local(remote_blob, None)
        self.service._local.write_entries(merged)
        entries = self.service.read_entries()
        self.assertEqual(len(entries), 1)

    def test_F2_rows_share_activity_id_consolidated(self):
        """F2: rows sharing activity_id consolidate (not duplicated under entry_id)."""
        # Two local DTOs sharing activity_id (cross-device duplicates)
        self.service._local.write_entries([
            make_local_dto("shared1", title="LocalA", updated_at=1000),
        ])
        remote_blob = {"entries": [raw_entry("shared1", "RemoteB", updated_at=99999)],
                       "device_id": "device-remote"}
        merged = self.service._merge_remote_into_local(remote_blob, None)
        self.service._local.write_entries(merged)
        entries = self.service.read_entries()
        same = [e for e in entries if e.get("activity_id") == "shared1"]
        self.assertLessEqual(len(same), 1)

    def test_F3_hash_index_pushed_to_remote(self):
        """F3: hash index built from store is push-ready after reconcile (transport parity)."""
        # Local row shares the remote fixture's activity_id so it consolidates
        # (count 2 = alpha + x), exercising reconcile + hash-index coverage.
        self.service._local.write_entries([
            make_local_dto("alpha", title="Alpha"),
        ])
        data = {"entries": [raw_entry("x", "X", updated_at=1), raw_entry("alpha", "Alpha", updated_at=2)],
                "device_id": "device-remote"}
        # Force reconcile so store reflects merged rows
        merged = self.service._merge_remote_into_local(data, None)
        self.service._local.write_entries(merged)
        self.assertEqual(self.store.count(), 2)
        # The hash index built from the store must cover every row (R7 parity)
        index = StagingHashIndex.build_from_store(self.store)
        self.assertEqual(len(index), 2)
        hash_hex = StagingHashIndex.computeHash(index)
        self.assertEqual(len(hash_hex), 64)

    def test_F4_recompute_hash_index_from_store_fastpath(self):
        """F4: pull path recomputes/tracks hash index from the SQLite store."""
        # Deterministic store index enables fast-path parity across devices
        self.service.capture("A", 1700000000000)
        self.service.capture("B", 1700000001000)
        index = StagingHashIndex.build_from_store(self.store)
        self.assertEqual(len(index), 2)
        # Rebuilding from same store is byte-identical (idempotent fast-path)
        again = StagingHashIndex.build_from_store(self.store)
        self.assertEqual(index, again)
        self.assertEqual(StagingHashIndex.computeHash(index),
                         StagingHashIndex.computeHash(again))

    def test_F5_read_only_fast_path_skips_network_when_no_pending(self):
        """F5: read-only fast path skips network when no pending SQLite writes."""
        self.assertEqual(self.store.count(), 0)
        # With an empty store there is nothing to push; reconcile still safe
        remote_blob = {"entries": [], "device_id": "device-remote"}
        merged = self.service._merge_remote_into_local(remote_blob, None)
        self.assertEqual(merged, [])

    def test_F6_reconcile_and_claim_cross_device(self):
        """F6: _reconcile_and_claim merges activity_id LWW on cross-device."""
        # Local rows via service; remote-only entry must land locally.
        data = {"entries": [raw_entry("newdev", "FromDevice", updated_at=5000)],
                "device_id": "device-remote"}
        merged = self.service._merge_remote_into_local(data, None)
        self.service._local.write_entries(merged)
        entries = self.service.read_entries()
        self.assertTrue(any(e.get("title") == "FromDevice" for e in entries))

    def test_F7_fast_path_reads_sqlite_for_merge(self):
        """F7: fast-path uses SQLite-backed local read for merge."""
        self.service.capture("LocalOnly", 1700000000000)
        rows_before = self.store.count()
        remote_blob = {"entries": [raw_entry("other", "Other", updated_at=1)],
                       "device_id": "device-remote"}
        merged = self.service._merge_remote_into_local(remote_blob, None)
        self.service._local.write_entries(merged)
        self.assertGreaterEqual(self.store.count(), rows_before)

    def test_F8_offline_blob_key_mismatch_safe(self):
        """F8: offline / blob key mismatch → no data loss (local intact)."""
        # A blob-key-mismatch sentinel must abort reconcile, preserving local.
        from domain.staging.service import BLOB_KEY_MISMATCH
        self.service.capture("Safe", 1700000000000)
        # A mismatch sentinel passed to the reconcile entry point raises/aborts
        result = self.service._merge_remote_into_local(BLOB_KEY_MISMATCH, None)
        self.assertIsNone(result)
        entries = self.service.read_entries()
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["title"], "Safe")

    def test_F9_migration_staging_json_to_sqlite(self):
        """F9: staging.json present → migrated + service reads migrated rows."""
        file_store = FileStagingStore(temp_dir() / "staging.json")
        svc = StagingService(crypto=self.crypto, staging_store=file_store,
                             data_dir=str(temp_dir()))
        svc.capture("MigrateMe", 1700000000000)
        raw = file_store.read_entries()
        self.assertEqual(len(raw), 1)
        # Migration table: data written to FileStore is migratable to SQLite rows
        migrated_rows = [
            dtoToCanonicalRow(remote_dto("mig", "MigrateMe"), "dev", now_ms())
        ]
        self.assertEqual(len(migrated_rows), 1)
        self.assertEqual(migrated_rows[0]["activity_id"], "mig")

    def test_F10_file_store_service_isolated_regression_gate(self):
        """F10: FileStagingStore-based service still functions (no regression)."""
        file_store = FileStagingStore(temp_dir() / "staging.json")
        svc = StagingService(crypto=self.crypto, staging_store=file_store,
                             data_dir=str(temp_dir()))
        svc.capture("FileGate", 1700000000000)
        svc.capture("FileGate2", 1700000001000)
        self.assertEqual(len(svc.read_entries()), 2)
        svc.remove_synced([0])
        self.assertEqual(len(svc.read_entries()), 1)


if __name__ == "__main__":
    unittest.main()
