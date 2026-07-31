"""B-05c CLI Staging Format Alignment — Phase 2 (RED) Test Definition.

Tests for ActivityIdGenerator, StagingHashIndex, and RemoteStagingSync
format alignment changes based on the canonical PHPSPEC §8 format.

All tests MUST fail in RED phase — the modules/behaviors under test
do not exist yet or differ from the canonical format. Phase 3 (GREEN)
will implement the modules and changes to make these tests pass.

Test groups:
  A1–A8:   ActivityIdGenerator (port from Flutter)
  B1–B6:   StagingHashIndex — build()
  C1–C5:   StagingHashIndex — computeHash()
  D1–D11:  StagingHashIndex — compare()
  E1–E6:   RemoteStagingSync — Blob & Hash Index Paths
  F1–F9:   RemoteStagingSync — Canonical Envelope & Compact JSON
  G1–G7:   RemoteStagingSync — Obfuscation Alignment

Usage:
  python3 -m pytest tests/test_b05c_cli_staging_alignment.py -v
"""

import json
import os
import unittest
from unittest.mock import MagicMock, patch

# ══════════════════════════════════════════════════════════════════════
# Future imports — these modules/behaviors do NOT exist yet (Phase 2: RED)
# ══════════════════════════════════════════════════════════════════════

try:
    from core.activity_id import ActivityIdGenerator
    HAS_ACTIVITY_ID = True
except ImportError:
    HAS_ACTIVITY_ID = False
    ActivityIdGenerator = None

try:
    from core.staging_hash_index import StagingHashIndex
    HAS_HASH_INDEX = True
except ImportError:
    HAS_HASH_INDEX = False
    StagingHashIndex = None

# RemoteStagingSync exists but has wrong defaults/behavior for canonical format
from domain.staging.remote_sync import RemoteStagingSync, REMOTE_COOKIE_PATH


# ══════════════════════════════════════════════════════════════════════
# Helpers
# ══════════════════════════════════════════════════════════════════════

TEST_MASTER_KEY = b"\x01\x02\x03\x04\x05\x06\x07\x08" * 4  # 32 bytes
TEST_DEVICE_ID = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"

# Canonical paths from PHPSPEC §8.4
CANONICAL_BLOB_PATH = "staging/blob"
CANONICAL_HASH_INDEX_PATH = "staging/hash_index.json"
CANONICAL_COOKIE_PATH = "staging/blobs/device_cookie.bin"


def _make_transport():
    """Return a simple in-memory transport spy."""
    class Spy:
        def __init__(self):
            self._blobs = {}
            self.pull_calls = []
            self.push_calls = []

        def pull(self, path, timeout_ms=None):
            self.pull_calls.append((path, timeout_ms))
            return self._blobs.get(path)

        def push(self, path, data, timeout_ms=None):
            self.push_calls.append((path, data, timeout_ms))
            self._blobs[path] = data

    return Spy()


def _make_crypto(master_key=TEST_MASTER_KEY):
    crypto = MagicMock()
    crypto.master_key = master_key
    return crypto


def _make_device_provider(device_id=TEST_DEVICE_ID):
    from security.device_identity import DeviceIdentity
    provider = MagicMock()
    provider.get_device_identity.return_value = DeviceIdentity(
        device_id=device_id, device_proof="test-proof", device_label="test"
    )
    return provider


def _make_canonical_row(activity_id, status="active", activity='{"test":true}',
                        updated_at=1714000000000, committed=False):
    """Build a canonical staging row per PHPSPEC §8.1."""
    return {
        "activity_id": activity_id,
        "activity_status": status,
        "activity": activity,
        "updated_at": updated_at,
        "committed": committed,
    }


# ══════════════════════════════════════════════════════════════════════
# Group A: ActivityIdGenerator (port from Flutter)
# ══════════════════════════════════════════════════════════════════════

@unittest.skipUnless(HAS_ACTIVITY_ID, "ActivityIdGenerator module not yet implemented")
class TestActivityIdGenerator(unittest.TestCase):
    """Group A: ActivityIdGenerator — port from Flutter."""

    def test_A1_generate_returns_10_char_string(self):
        """A1: generateActivityId() returns a 10-character string."""
        aid = ActivityIdGenerator.generateActivityId()
        self.assertIsInstance(aid, str)
        self.assertEqual(len(aid), 10,
                         "Activity ID must be exactly 10 characters")

    def test_A2_characters_are_alphanumeric(self):
        """A2: All characters are alphanumeric (A-Z, a-z, 0-9)."""
        for _ in range(100):
            aid = ActivityIdGenerator.generateActivityId()
            self.assertTrue(aid.isalnum(),
                            f"Activity ID '{aid}' contains non-alphanumeric chars")
            # Verify each char is in the canonical set
            for ch in aid:
                self.assertIn(ch, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
                              f"Character '{ch}' in '{aid}' outside canonical set")

    def test_A3_consecutive_calls_produce_different_ids(self):
        """A3: Two consecutive calls produce different IDs."""
        a = ActivityIdGenerator.generateActivityId()
        b = ActivityIdGenerator.generateActivityId()
        self.assertNotEqual(a, b, "Consecutive IDs must be different")

    def test_A4_1000_ids_all_unique(self):
        """A4: 1000 generated IDs are all unique (no collisions)."""
        ids = set()
        for _ in range(1000):
            aid = ActivityIdGenerator.generateActivityId()
            self.assertNotIn(aid, ids,
                             f"Collision detected: '{aid}' generated twice in 1000 calls")
            ids.add(aid)
        self.assertEqual(len(ids), 1000)

    def test_A5_isValid_returns_true_for_valid_ids(self):
        """A5: isValidActivityId() returns True for valid 10-char alphanumeric."""
        valid_ids = ["a1b2c3d4e5", "ABCDEFGHIJ", "0123456789", "Zx9Yw8Vv7U"]
        for aid in valid_ids:
            self.assertTrue(ActivityIdGenerator.isValidActivityId(aid),
                            f"'{aid}' should be valid but was rejected")

    def test_A6_isValid_rejects_wrong_length(self):
        """A6: isValidActivityId() returns False for strings of wrong length."""
        self.assertFalse(ActivityIdGenerator.isValidActivityId("abc"))
        self.assertFalse(ActivityIdGenerator.isValidActivityId("a1b2c3d4e5f6"))
        self.assertFalse(ActivityIdGenerator.isValidActivityId(""))

    def test_A7_isValid_rejects_special_characters(self):
        """A7: isValidActivityId() returns False for strings with special chars."""
        invalid_ids = ["a1b2c3d4e-", "a1b2c3d4e_", "a1b2c3d4e!", "@bcd3fghij",
                       "a1b2c3d4e ", "a1b2c3d4e\n"]
        for aid in invalid_ids:
            self.assertFalse(ActivityIdGenerator.isValidActivityId(aid),
                             f"'{aid}' should be invalid but was accepted")

    def test_A8_isValid_rejects_none(self):
        """A8: isValidActivityId(None) returns False."""
        self.assertFalse(ActivityIdGenerator.isValidActivityId(None))


# ══════════════════════════════════════════════════════════════════════
# Group B: StagingHashIndex — build()
# ══════════════════════════════════════════════════════════════════════

@unittest.skipUnless(HAS_HASH_INDEX, "StagingHashIndex module not yet implemented")
class TestStagingHashIndexBuild(unittest.TestCase):
    """Group B: StagingHashIndex.build() — port from Flutter/Web."""

    def test_B1_build_returns_list_of_id_status_pairs(self):
        """B1: build() returns [{activity_id, activity_status}, ...] from rows."""
        rows = [
            _make_canonical_row("a1b2c3d4e5", "active"),
            _make_canonical_row("f6g7h8i9j0", "paused"),
        ]
        result = StagingHashIndex.build(rows)
        self.assertIsInstance(result, list)
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0], {"activity_id": "a1b2c3d4e5", "activity_status": "active"})
        self.assertEqual(result[1], {"activity_id": "f6g7h8i9j0", "activity_status": "paused"})

    def test_B2_build_empty_rows_returns_empty_list(self):
        """B2: build() returns [] for empty rows list."""
        result = StagingHashIndex.build([])
        self.assertEqual(result, [])

    def test_B3_build_none_returns_empty_list(self):
        """B3: build(None) returns [] — defensive null handling."""
        result = StagingHashIndex.build(None)
        self.assertEqual(result, [])

    def test_B4_build_skips_rows_without_activity_id(self):
        """B4: build() skips rows missing activity_id."""
        rows = [
            {"activity_status": "active", "updated_at": 1},  # no activity_id
            _make_canonical_row("a1b2c3d4e5", "active"),
        ]
        result = StagingHashIndex.build(rows)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["activity_id"], "a1b2c3d4e5")

    def test_B5_build_preserves_all_status_values(self):
        """B5: build() preserves all activity_status values."""
        rows = [
            _make_canonical_row("a1b2c3d4e5", "active"),
            _make_canonical_row("f6g7h8i9j0", "paused"),
            _make_canonical_row("k1l2m3n4o5", "ended"),
        ]
        result = StagingHashIndex.build(rows)
        statuses = {r["activity_status"] for r in result}
        self.assertEqual(statuses, {"active", "paused", "ended"})

    def test_B6_build_output_is_sorted_by_activity_id(self):
        """B6: build() output is sorted by activity_id for determinism."""
        rows = [
            _make_canonical_row("zzzzzzzzzz", "active"),
            _make_canonical_row("aaaaaaaaaa", "active"),
            _make_canonical_row("mmmmmmmmmm", "active"),
        ]
        result = StagingHashIndex.build(rows)
        ids = [r["activity_id"] for r in result]
        self.assertEqual(ids, sorted(ids),
                         "Hash index must be sorted by activity_id")


# ══════════════════════════════════════════════════════════════════════
# Group C: StagingHashIndex — computeHash()
# ══════════════════════════════════════════════════════════════════════

@unittest.skipUnless(HAS_HASH_INDEX, "StagingHashIndex module not yet implemented")
class TestStagingHashIndexComputeHash(unittest.TestCase):
    """Group C: StagingHashIndex.computeHash() — SHA-256 of sorted index."""

    def test_C1_computeHash_returns_64_char_hex(self):
        """C1: computeHash() returns a 64-character hex string."""
        index = [{"activity_id": "a1b2c3d4e5", "activity_status": "active"}]
        result = StagingHashIndex.computeHash(index)
        self.assertIsInstance(result, str)
        self.assertEqual(len(result), 64, "SHA-256 hex digest must be 64 chars")
        # All hex chars
        self.assertTrue(all(c in "0123456789abcdef" for c in result),
                        f"Hash '{result}' is not valid hex")

    def test_C2_same_input_produces_same_hash(self):
        """C2: Same input always produces identical hash (deterministic)."""
        index = [
            {"activity_id": "a1b2c3d4e5", "activity_status": "active"},
            {"activity_id": "f6g7h8i9j0", "activity_status": "paused"},
        ]
        h1 = StagingHashIndex.computeHash(index)
        h2 = StagingHashIndex.computeHash(index)
        self.assertEqual(h1, h2, "computeHash must be deterministic")

    def test_C3_different_input_produces_different_hash(self):
        """C3: Different index content produces different hash."""
        idx1 = [{"activity_id": "a1b2c3d4e5", "activity_status": "active"}]
        idx2 = [{"activity_id": "a1b2c3d4e5", "activity_status": "paused"}]
        self.assertNotEqual(
            StagingHashIndex.computeHash(idx1),
            StagingHashIndex.computeHash(idx2),
            "Status change must produce different hash"
        )

    def test_C4_empty_index_returns_valid_hash(self):
        """C4: Empty index [] produces a valid hash (not error/None)."""
        result = StagingHashIndex.computeHash([])
        self.assertIsInstance(result, str)
        self.assertEqual(len(result), 64)

    def test_C5_hash_depends_on_sort_order(self):
        """C5: computeHash() is order-independent for same set.

        Because build() sorts by activity_id, computeHash produces the
        same digest regardless of input row order.
        """
        idx1 = [
            {"activity_id": "bbbbbbbbbb", "activity_status": "active"},
            {"activity_id": "aaaaaaaaaa", "activity_status": "active"},
        ]
        idx2 = [
            {"activity_id": "aaaaaaaaaa", "activity_status": "active"},
            {"activity_id": "bbbbbbbbbb", "activity_status": "active"},
        ]
        # computeHash should sort internally before hashing
        h1 = StagingHashIndex.computeHash(idx1)
        h2 = StagingHashIndex.computeHash(idx2)
        self.assertEqual(h1, h2,
                         "Hash must be order-independent (sorted by activity_id internally)")


# ══════════════════════════════════════════════════════════════════════
# Group D: StagingHashIndex — compare()
# ══════════════════════════════════════════════════════════════════════

@unittest.skipUnless(HAS_HASH_INDEX, "StagingHashIndex module not yet implemented")
class TestStagingHashIndexCompare(unittest.TestCase):
    """Group D: StagingHashIndex.compare() — diff two hash indexes."""

    def test_D1_identical_indexes(self):
        """D1: Identical indexes → identical=True, no actions."""
        local = [{"activity_id": "a1b2c3d4e5", "activity_status": "active"}]
        remote = [{"activity_id": "a1b2c3d4e5", "activity_status": "active"}]
        diff = StagingHashIndex.compare(local, remote)
        self.assertTrue(diff.identical)
        self.assertEqual(diff.added, [])
        self.assertEqual(diff.removed, [])
        self.assertEqual(diff.changed, [])

    def test_D2_remote_has_new_entry(self):
        """D2: Remote has entry not in local → added list populated."""
        local = []
        remote = [{"activity_id": "a1b2c3d4e5", "activity_status": "active"}]
        diff = StagingHashIndex.compare(local, remote)
        self.assertFalse(diff.identical)
        self.assertEqual(diff.added, ["a1b2c3d4e5"])
        self.assertEqual(diff.removed, [])
        self.assertEqual(diff.changed, [])

    def test_D3_local_entry_not_on_remote(self):
        """D3: Local has entry not on remote → removed list populated."""
        local = [{"activity_id": "a1b2c3d4e5", "activity_status": "active"}]
        remote = []
        diff = StagingHashIndex.compare(local, remote)
        self.assertFalse(diff.identical)
        self.assertEqual(diff.added, [])
        self.assertEqual(diff.removed, ["a1b2c3d4e5"])
        self.assertEqual(diff.changed, [])

    def test_D4_same_id_different_status(self):
        """D4: Same activity_id, different status → changed list populated."""
        local = [{"activity_id": "a1b2c3d4e5", "activity_status": "active"}]
        remote = [{"activity_id": "a1b2c3d4e5", "activity_status": "paused"}]
        diff = StagingHashIndex.compare(local, remote)
        self.assertFalse(diff.identical)
        self.assertEqual(diff.added, [])
        self.assertEqual(diff.removed, [])
        self.assertEqual(diff.changed, ["a1b2c3d4e5"])

    def test_D5_multiple_changes_detected_simultaneously(self):
        """D5: Added + removed + changed all detected in one compare()."""
        local = [
            {"activity_id": "removed_id", "activity_status": "active"},
            {"activity_id": "changed_id", "activity_status": "active"},
            {"activity_id": "shared_id", "activity_status": "active"},
        ]
        remote = [
            {"activity_id": "shared_id", "activity_status": "active"},
            {"activity_id": "changed_id", "activity_status": "paused"},
            {"activity_id": "added_id", "activity_status": "active"},
        ]
        diff = StagingHashIndex.compare(local, remote)
        self.assertFalse(diff.identical)
        self.assertEqual(set(diff.added), {"added_id"})
        self.assertEqual(set(diff.removed), {"removed_id"})
        self.assertEqual(set(diff.changed), {"changed_id"})

    def test_D6_remote_empty_local_has_entries(self):
        """D6: Remote empty, local has entries → all local in removed.

        Per canonical behavior: local-only entries with empty remote
        means they were deleted on remote side.
        """
        local = [
            {"activity_id": "a1b2c3d4e5", "activity_status": "active"},
            {"activity_id": "f6g7h8i9j0", "activity_status": "paused"},
        ]
        remote = []
        diff = StagingHashIndex.compare(local, remote)
        self.assertFalse(diff.identical)
        self.assertEqual(set(diff.removed), {"a1b2c3d4e5", "f6g7h8i9j0"})
        self.assertEqual(diff.added, [])
        self.assertEqual(diff.changed, [])

    def test_D7_both_empty(self):
        """D7: Both local and remote empty → identical=True."""
        diff = StagingHashIndex.compare([], [])
        self.assertTrue(diff.identical)
        self.assertEqual(diff.added, [])
        self.assertEqual(diff.removed, [])
        self.assertEqual(diff.changed, [])

    def test_D8_remote_none_treated_as_empty(self):
        """D8: Remote=None is treated as empty."""
        local = [{"activity_id": "a1b2c3d4e5", "activity_status": "active"}]
        diff = StagingHashIndex.compare(local, None)
        self.assertFalse(diff.identical)
        self.assertEqual(diff.removed, ["a1b2c3d4e5"])

    def test_D9_local_none_treated_as_empty(self):
        """D9: Local=None is treated as empty."""
        remote = [{"activity_id": "a1b2c3d4e5", "activity_status": "active"}]
        diff = StagingHashIndex.compare(None, remote)
        self.assertFalse(diff.identical)
        self.assertEqual(diff.added, ["a1b2c3d4e5"])

    def test_D10_both_none_identical(self):
        """D10: Both None → identical=True."""
        diff = StagingHashIndex.compare(None, None)
        self.assertTrue(diff.identical)

    def test_D11_output_lists_are_sorted(self):
        """D11: Added/removed/changed lists are sorted for determinism."""
        local = [
            {"activity_id": "z_id", "activity_status": "active"},
            {"activity_id": "a_id", "activity_status": "active"},
        ]
        remote = [
            {"activity_id": "m_id", "activity_status": "active"},
            {"activity_id": "a_id", "activity_status": "paused"},
        ]
        diff = StagingHashIndex.compare(local, remote)
        self.assertEqual(diff.added, sorted(diff.added))
        self.assertEqual(diff.removed, sorted(diff.removed))
        self.assertEqual(diff.changed, sorted(diff.changed))


# ══════════════════════════════════════════════════════════════════════
# Group E: RemoteStagingSync — Blob & Hash Index Paths
# ══════════════════════════════════════════════════════════════════════

class TestRemoteStagingSyncPaths(unittest.TestCase):
    """Group E: RemoteStagingSync uses canonical paths per PHPSPEC §8.4."""

    def test_E1_default_blob_path_is_canonical(self):
        """E1: Default blob_path is 'staging/blob' per PHPSPEC §8.4."""
        sync = RemoteStagingSync(
            crypto=_make_crypto(),
            transport=_make_transport(),
            device_id_provider=_make_device_provider(),
        )
        self.assertEqual(sync._blob_path, CANONICAL_BLOB_PATH,
                         f"Default blob_path must be '{CANONICAL_BLOB_PATH}'")

    def test_E2_pull_uses_canonical_blob_path(self):
        """E2: pull() uses _blob_path which is 'staging/blob'."""
        transport = _make_transport()
        sync = RemoteStagingSync(
            crypto=_make_crypto(),
            transport=transport,
            device_id_provider=_make_device_provider(),
        )
        # Place a plaintext blob at the canonical path
        blob = json.dumps({"device_id": TEST_DEVICE_ID, "entries": [], "device_proof": "x"})
        transport._blobs[CANONICAL_BLOB_PATH] = blob.encode()
        sync.pull()
        self.assertEqual(len(transport.pull_calls), 1)
        self.assertEqual(transport.pull_calls[0][0], CANONICAL_BLOB_PATH)

    def test_E3_push_uses_canonical_blob_path(self):
        """E3: push() uses _blob_path which is 'staging/blob'."""
        transport = _make_transport()
        sync = RemoteStagingSync(
            crypto=_make_crypto(),
            transport=transport,
            device_id_provider=_make_device_provider(),
        )
        sync.push(entries=[], device_id=TEST_DEVICE_ID)
        self.assertEqual(len(transport.push_calls), 1)
        self.assertEqual(transport.push_calls[0][0], CANONICAL_BLOB_PATH)

    def test_E4_cookie_path_unchanged(self):
        """E4: REMOTE_COOKIE_PATH remains 'staging/blobs/device_cookie.bin'."""
        self.assertEqual(REMOTE_COOKIE_PATH, CANONICAL_COOKIE_PATH)

    def test_E5_pull_hash_index_method_exists_and_uses_correct_path(self):
        """E5: pull_hash_index() pulls from 'staging/hash_index.json'."""
        transport = _make_transport()
        sync = RemoteStagingSync(
            crypto=_make_crypto(),
            transport=transport,
            device_id_provider=_make_device_provider(),
        )
        # Place hash index at canonical path
        hash_index = json.dumps([{"activity_id": "a1b2c3d4e5", "activity_status": "active"}])
        transport._blobs[CANONICAL_HASH_INDEX_PATH] = hash_index.encode()

        self.assertTrue(hasattr(sync, 'pull_hash_index'),
                        "RemoteStagingSync must have pull_hash_index() method")
        result = sync.pull_hash_index()
        self.assertEqual(transport.pull_calls[0][0], CANONICAL_HASH_INDEX_PATH)
        self.assertEqual(result, [{"activity_id": "a1b2c3d4e5", "activity_status": "active"}])

    def test_E6_push_hash_index_method_exists_and_uses_correct_path(self):
        """E6: push_hash_index() pushes to 'staging/hash_index.json'."""
        transport = _make_transport()
        sync = RemoteStagingSync(
            crypto=_make_crypto(),
            transport=transport,
            device_id_provider=_make_device_provider(),
        )
        self.assertTrue(hasattr(sync, 'push_hash_index'),
                        "RemoteStagingSync must have push_hash_index() method")
        index = [{"activity_id": "a1b2c3d4e5", "activity_status": "active"}]
        sync.push_hash_index(index)
        self.assertEqual(len(transport.push_calls), 1)
        self.assertEqual(transport.push_calls[0][0], CANONICAL_HASH_INDEX_PATH)


# ══════════════════════════════════════════════════════════════════════
# Group F: RemoteStagingSync — Canonical Envelope & Compact JSON
# ══════════════════════════════════════════════════════════════════════

class TestRemoteStagingSyncCanonicalEnvelope(unittest.TestCase):
    """Group F: RemoteStagingSync emits canonical envelope per PHPSPEC §8.2."""

    def setUp(self):
        self.transport = _make_transport()
        self.sync = RemoteStagingSync(
            crypto=_make_crypto(),
            transport=self.transport,
            device_id_provider=_make_device_provider(),
        )

    def _get_pushed_blob(self):
        """Return the deserialized blob from the most recent push."""
        self.assertTrue(len(self.transport.push_calls) > 0, "No push calls recorded")
        _path, data, _timeout = self.transport.push_calls[-1]
        return json.loads(data.decode("utf-8"))

    def test_F1_push_uses_compact_json_no_indent(self):
        """F1: push() serializes JSON without indent (compact, single-line).

        Per PHPSPEC §8.7: serialized blob JSON must be compact (no whitespace
        padding) to ensure deterministic hash index computation and consistent
        obfuscation output. The current CLI uses ``json.dumps(indent=2)`` which
        inserts newlines and spaces — this must change to compact serialization.
        """
        self.sync.push(
            entries=[_make_canonical_row("a1b2c3d4e5", "active")],
            device_id=TEST_DEVICE_ID,
        )
        _path, data, _timeout = self.transport.push_calls[0]
        # Since no master_key is set, push emits plaintext JSON
        json_str = data.decode("utf-8")

        # Verify it parses correctly
        parsed = json.loads(json_str)
        self.assertIn("entries", parsed)
        self.assertIn("device_id", parsed)

        # Compact JSON: must not contain newlines
        self.assertNotIn("\n", json_str,
                         f"Blob JSON must be compact (no indent), but has newlines. "
                         f"Current format uses indent=2 which must change to compact. "
                         f"First 120 chars: {json_str[:120]}")

    def test_F2_envelope_has_no_updated_at(self):
        """F2: Envelope does NOT include 'updated_at' per PHPSPEC §8.2 note."""
        self.sync.push(entries=[], device_id=TEST_DEVICE_ID)
        blob = self._get_pushed_blob()
        self.assertIn("device_id", blob)
        self.assertIn("device_proof", blob)
        self.assertIn("entries", blob)
        self.assertNotIn("updated_at", blob,
                         "Envelope must not have 'updated_at' — hash index supersedes it")

    def test_F3_push_includes_device_proof(self):
        """F3: push() includes device_proof in envelope."""
        self.sync.push(entries=[], device_id=TEST_DEVICE_ID)
        blob = self._get_pushed_blob()
        self.assertEqual(blob["device_id"], TEST_DEVICE_ID)
        # device_proof should be set to something meaningful
        self.assertIn("device_proof", blob)

    def test_F4_push_accepts_canonical_rows(self):
        """F4: push() accepts and preserves canonical row format.

        Rows must have: activity_id, activity_status, activity, updated_at, committed.
        """
        row = _make_canonical_row("a1b2c3d4e5", "active", '{"t":1}', 1714000000000, False)
        self.sync.push(entries=[row], device_id=TEST_DEVICE_ID)
        blob = self._get_pushed_blob()
        self.assertEqual(len(blob["entries"]), 1)
        pushed_row = blob["entries"][0]
        self.assertEqual(pushed_row["activity_id"], "a1b2c3d4e5")
        self.assertEqual(pushed_row["activity_status"], "active")
        self.assertEqual(pushed_row["activity"], '{"t":1}')
        self.assertEqual(pushed_row["updated_at"], 1714000000000)
        self.assertEqual(pushed_row.get("committed"), False)

    def test_F5_pull_can_parse_pushed_blob_roundtrip(self):
        """F5: Blob pushed by push() can be parsed by pull() (round-trip)."""
        row = _make_canonical_row("a1b2c3d4e5", "active")
        self.sync.push(entries=[row], device_id=TEST_DEVICE_ID)
        result = self.sync.pull()
        self.assertIsNotNone(result)
        self.assertEqual(len(result["entries"]), 1)
        self.assertEqual(result["entries"][0]["activity_id"], "a1b2c3d4e5")

    def test_F6_push_empty_entries_produces_valid_envelope(self):
        """F6: push() with empty entries produces valid envelope."""
        self.sync.push(entries=[], device_id=TEST_DEVICE_ID)
        blob = self._get_pushed_blob()
        self.assertEqual(blob["entries"], [])
        self.assertEqual(blob["device_id"], TEST_DEVICE_ID)

    def test_F7_push_preserves_committed_flag(self):
        """F7: push() preserves committed flag in rows."""
        row = _make_canonical_row("a1b2c3d4e5", "ended", '{"t":1}', committed=True)
        self.sync.push(entries=[row], device_id=TEST_DEVICE_ID)
        blob = self._get_pushed_blob()
        self.assertTrue(blob["entries"][0]["committed"])

    def test_F8_pull_returns_none_for_missing_blob(self):
        """F8: pull() returns None when no remote blob exists (unchanged)."""
        result = self.sync.pull()
        self.assertIsNone(result)

    def test_F9_push_serialization_is_valid_json(self):
        """F9: Push output is always valid JSON (no trailing commas etc.)."""
        self.sync.push(entries=[
            _make_canonical_row("a1b2c3d4e5", "active", '{"key":"value with \\"quotes\\""}'),
        ], device_id=TEST_DEVICE_ID)
        _path, data, _timeout = self.transport.push_calls[0]
        # Must parse without error
        try:
            json.loads(data.decode("utf-8"))
        except json.JSONDecodeError as e:
            self.fail(f"Push produced invalid JSON: {e}")


# ══════════════════════════════════════════════════════════════════════
# Group G: RemoteStagingSync — Obfuscation Alignment
# ══════════════════════════════════════════════════════════════════════

class TestRemoteStagingSyncObfuscationAlignment(unittest.TestCase):
    """Group G: Obfuscation aligns with Flutter/Web scheme (PHPSPEC §8.7)."""

    def setUp(self):
        self.transport = _make_transport()
        # Create sync with master_key so push obfuscates
        self.sync = RemoteStagingSync(
            crypto=_make_crypto(),
            transport=self.transport,
            device_id_provider=_make_device_provider(),
            master_key=TEST_MASTER_KEY,
        )

    def test_G1_obfuscated_blob_is_not_plain_json(self):
        """G1: Obfuscated blob is not parseable as plain JSON."""
        self.sync.push(
            entries=[_make_canonical_row("a1b2c3d4e5", "active")],
            device_id=TEST_DEVICE_ID,
        )
        _path, data, _timeout = self.transport.push_calls[0]
        # Should not parse as JSON (obfuscation is active)
        try:
            json.loads(data.decode("utf-8"))
            self.fail("Obfuscated blob should not be plain JSON")
        except (json.JSONDecodeError, UnicodeDecodeError):
            pass  # Expected

    def test_G2_obfuscate_deobfuscate_roundtrip(self):
        """G2: deobfuscate(obfuscate(plaintext)) returns original plaintext."""
        plaintext = json.dumps({
            "device_id": TEST_DEVICE_ID,
            "device_proof": "test-proof",
            "entries": [_make_canonical_row("a1b2c3d4e5", "active")],
        }).encode("utf-8")

        obfuscated = self.sync._obfuscate(plaintext, TEST_MASTER_KEY)
        deobfuscated = self.sync._deobfuscate(obfuscated, TEST_MASTER_KEY)

        self.assertIsNotNone(deobfuscated)
        self.assertEqual(deobfuscated, plaintext)

    def test_G3_blob_subkey_prefix_unchanged(self):
        """G3: Blob sub-key derivation uses same 'blob-obfuscation' prefix."""
        from domain.staging.remote_sync import BLOB_SUBKEY_PREFIX
        self.assertEqual(BLOB_SUBKEY_PREFIX, b"blob-obfuscation",
                         "Blob sub-key prefix must remain 'blob-obfuscation'")

    def test_G4_no_tiered_padding_constants_exposed(self):
        """G4: Tiered padding constants (TIER_*) are removed/deprecated.

        The CLI currently uses 4-tier padding (64K-512K). After alignment
        with Flutter/Web, this is replaced by simpler obfuscation without
        size-tier padding. The tier constants should not be part of the
        public API.
        """
        # The module-level tier constants should not exist after alignment
        import domain.staging.remote_sync as mod
        tier_attrs = ['TIER_64K', 'TIER_128K', 'TIER_256K', 'TIER_512K', 'BLOB_TIERS']
        for attr in tier_attrs:
            self.assertFalse(
                hasattr(mod, attr),
                f"{attr} should be removed — tiered padding is deprecated"
            )

    def test_G5_obfuscation_uses_salt_and_nonce(self):
        """G5: Obfuscation includes random salt + nonce (not deterministic in production)."""
        plaintext = b"test blob data for salt/nonce check"
        obf1 = self.sync._obfuscate(plaintext, TEST_MASTER_KEY)
        obf2 = self.sync._obfuscate(plaintext, TEST_MASTER_KEY)

        # Two obfuscations of the same data should differ (random salt/nonce)
        self.assertNotEqual(obf1, obf2,
                            "Production obfuscation must use random salt/nonce")
        # Both should deobfuscate correctly
        self.assertEqual(self.sync._deobfuscate(obf1, TEST_MASTER_KEY), plaintext)
        self.assertEqual(self.sync._deobfuscate(obf2, TEST_MASTER_KEY), plaintext)

    def test_G6_deobfuscate_wrong_key_returns_none(self):
        """G6: deobfuscate with wrong key returns None (not exception)."""
        plaintext = b"test blob data"
        wrong_key = b"\xff" * 32
        obfuscated = self.sync._obfuscate(plaintext, TEST_MASTER_KEY)
        result = self.sync._deobfuscate(obfuscated, wrong_key)
        self.assertIsNone(result, "Wrong key must return None, not raise or return garbage")

    def test_G7_deobfuscate_corrupt_data_returns_none(self):
        """G7: deobfuscate with corrupt data returns None."""
        result = self.sync._deobfuscate(b"not valid obfuscated data!!", TEST_MASTER_KEY)
        self.assertIsNone(result)


# ══════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    unittest.main()
