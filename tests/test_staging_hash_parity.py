"""Staging-hash parity vectors V1/V2 — ADR-034 P0 gate (Phase 2 RED).

Verifies the canonical ``staging_hash`` spec
(``docs/design/STAGING_CHANGE_DETECTION_DESIGN.md`` §4.1) is byte-identical
across clients, using a committed seed fixture + golden bytes in
``testdata/staging_hash_seed.json``. This is the **P0 go/no-go gate** before
any cookie-schema work (plan §10): V1 (canonical serialization) and V2
(digest) must both pass before P1 begins.

Spec under test::

    staging_hash = SHA-256( json.dumps( canonical_rows,
                                        sort_keys=True, separators=(",", ":") ) )
      where canonical_rows = [ canonical_row(r) for r in non-committed rows ]
                             sorted ascending by activity_id
            canonical_row(r) = { activity_id, activity_status, activity,
                                 updated_at, committed }
            activity = compact JSON string in the pinned Python-literal key order
                       (title, start_epoch, end_epoch, duration, tags, comment,
                        media, entry_id, is_active, is_paused, pauses, metadata,
                        device_uuid, end_device_uuid, block_index)

Phase 2 (RED) classification:

  🔴 genuinely RED today:
     * V1 (Python, Group A) — ``dtoToCanonicalRow`` does **not** yet normalize an
       empty-string ``comment`` to ``null`` (ADR-034 §4.1). Seed ``act-0002``
       has ``comment == ""``; Python emits ``""``, the golden emits ``null``.
     * V2 (Python, Group B) — ``compute_staging_hash`` is not yet implemented in
       ``domain/staging/row_merge.py`` (P0 deliverable); ImportError → red.
     * V2 (Web, Group D / G1) — ``computeStagingHash`` is not yet implemented in
       ``phpoc-web/src/sync/remote_sync.js``.
     * V1/V2 (Flutter, Groups E/F — asserted in
       ``phpoc-flutter/test/data/sync/staging_hash_test.dart``) — the
       ``lib/data/sync/staging_hash.dart`` module does not exist yet.

  🟢 guard (green today):
     * V1 (Web, Group C / G1) — JS ``dtoToCanonicalRow`` already emits
       ``e.comment || null``, so it already normalizes empty-string comment to
       ``null`` (matches golden).

The golden bytes are **committed constants**, never re-derived at test time, so
the gate is non-circular (the test re-derives from ``seed_dtos`` and compares).

Group G (cross-client):
  * G1 (Python ↔ Web): driven here via `node` on
    ``phpoc-web/test/staging_hash_parity.mjs``.
  * G2 (Flutter ↔ golden): asserted in
    ``phpoc-flutter/test/data/sync/staging_hash_test.dart`` (not Python-driven).
  * G3 (all three equal golden): satisfied transitively when Group A/B (Python),
    G1 + C/D (Web) and E/F (Flutter) all pass the same committed golden digest.

Run::

    PYTHONPATH=. python3 -m pytest tests/test_staging_hash_parity.py -v

Requires `node` on PATH (Group G1). No network.
"""

import json
import subprocess
import unittest
from pathlib import Path
from typing import Any

from domain.staging.row_merge import dtoToCanonicalRow  # existing (P0 will add the comment coercion)

_REPO_ROOT = Path(__file__).resolve().parent.parent
_FIXTURE = _REPO_ROOT / "testdata" / "staging_hash_seed.json"
_NODE_HELPER = _REPO_ROOT / "phpoc-web" / "test" / "staging_hash_parity.mjs"


def load_fixture() -> dict:
    with open(_FIXTURE, "r", encoding="utf-8") as f:
        return json.load(f)


def _serialize_canonical_array(rows: list) -> str:
    """The array-serialization step of the spec: filter committed, sort by
    activity_id ascending, then compact json with sorted keys."""
    rows = [r for r in rows if not r.get("committed")]
    rows = sorted(rows, key=lambda r: r["activity_id"])
    return json.dumps(rows, sort_keys=True, separators=(",", ":"))


def _node(op: str, **kwargs) -> Any:
    """Run a parity operation on the JS engine via node subprocess.

    Sends one JSON-line request on stdin, reads one JSON-line result.
    Returns the decoded `result` field. Raises on node failure.
    """
    req = json.dumps({"op": op, **kwargs})
    proc = subprocess.run(
        ["node", str(_NODE_HELPER)],
        input=req,
        capture_output=True,
        text=True,
        timeout=60,
    )
    if proc.returncode != 0:
        raise AssertionError(
            f"node helper failed (op={op}, rc={proc.returncode}): {proc.stderr.strip()}"
        )
    resp = json.loads(proc.stdout)
    if not resp.get("ok"):
        raise AssertionError(f"node op {op} error: {resp.get('error')}")
    return resp["result"]


# ═══════════════════════════════════════════════════════════════════════════
# V1 — Canonical serialization (byte parity of the activity string + array)
# ═══════════════════════════════════════════════════════════════════════════


class TestV1CanonicalSerialization(unittest.TestCase):
    """V1 — identical compact JSON across CLI / Web / Flutter.

    RED today on the ``comment`` empty-string normalization (see module
    docstring). Also verifies the pinned ``activity`` key order (the golden
    bytes encode the Python-literal order) and the committed-row exclusion
    (``act-0004`` is absent from the golden array).
    """

    @classmethod
    def setUpClass(cls):
        cls.fx = load_fixture()
        cls.device = cls.fx["device_id"]
        cls.now = cls.fx["now"]

    def _rows(self):
        return [
            dtoToCanonicalRow(d, device_id=self.device, now=self.now)
            for d in self.fx["seed_dtos"]
        ]

    def test_canonical_rows_match_golden(self):
        """A1: full 5-field canonical row (activity_id/status/activity/
        updated_at/committed) matches the golden row for every seed DTO."""
        golden_by_id = {r["activity_id"]: r for r in self.fx["golden"]["canonical_rows"]}
        for row in self._rows():
            self.assertEqual(row, golden_by_id[row["activity_id"]])

    def test_activity_string_matches_golden(self):
        """A2: the nested ``activity`` JSON string matches golden byte-for-byte
        (pinned key order + ``comment`` ''→null normalization)."""
        golden_by_id = {r["activity_id"]: r["activity"] for r in self.fx["golden"]["canonical_rows"]}
        for row in self._rows():
            self.assertEqual(
                row["activity"],
                golden_by_id[row["activity_id"]],
                f"activity string mismatch for {row['activity_id']}",
            )

    def test_comment_empty_string_normalizes_to_null(self):
        """A3: ``comment == ""`` normalizes to ``null`` (seed ``act-0002``)."""
        dto = next(d for d in self.fx["seed_dtos"] if d["entry_id"] == "act-0002")
        row = dtoToCanonicalRow(dto, device_id=self.device, now=self.now)
        activity = json.loads(row["activity"])
        self.assertIsNone(activity["comment"])

    def test_canonical_array_matches_golden(self):
        """A4: the full serialized array (sorted + committed-excluded) matches
        the golden byte string."""
        self.assertEqual(
            _serialize_canonical_array(self._rows()),
            self.fx["golden"]["canonical_array"],
        )

    def test_committed_rows_excluded_from_array(self):
        """A5: committed rows (``act-0004``) are absent from the array (D11)."""
        arr = json.loads(_serialize_canonical_array(self._rows()))
        ids = [r["activity_id"] for r in arr]
        self.assertNotIn("act-0004", ids)
        self.assertEqual(len(ids), 3)


# ═══════════════════════════════════════════════════════════════════════════
# V2 — Digest (SHA-256 of the canonical array)
# ═══════════════════════════════════════════════════════════════════════════


def _compute_staging_hash(rows: list) -> str:
    """P0 deliverable — RED until ``compute_staging_hash`` lands in
    ``domain/staging/row_merge.py``. Imported lazily so the missing-helper
    state surfaces as a clean per-test failure, not a collection error."""
    from domain.staging.row_merge import compute_staging_hash  # P0 — to implement

    return compute_staging_hash(rows)


class TestV2Digest(unittest.TestCase):
    """V2 — identical ``staging_hash`` across clients.

    RED today: ``compute_staging_hash`` is not yet implemented.
    """

    def _rows(self):
        fx = load_fixture()
        return [
            dtoToCanonicalRow(d, device_id=fx["device_id"], now=fx["now"])
            for d in fx["seed_dtos"]
        ]

    def test_digest_matches_golden(self):
        """B1: compute_staging_hash(rows) returns the golden hex digest."""
        self.assertEqual(_compute_staging_hash(self._rows()), load_fixture()["golden"]["staging_hash"])

    def test_digest_is_lowercase_hex(self):
        """B2: the digest is 64-char lowercase hex (cross-client compare)."""
        digest = _compute_staging_hash(self._rows())
        self.assertEqual(len(digest), 64)
        self.assertRegex(digest, r"^[0-9a-f]{64}$")

    def test_digest_deterministic_and_order_independent(self):
        """B3: deterministic; independent of input row order (after sort)."""
        rows = self._rows()
        shuffled = list(rows)
        shuffled.reverse()  # committed row moves too — must not matter
        self.assertEqual(_compute_staging_hash(rows), _compute_staging_hash(rows))
        self.assertEqual(_compute_staging_hash(rows), _compute_staging_hash(shuffled))


# ═══════════════════════════════════════════════════════════════════════════
# Cross-client legs
# ═══════════════════════════════════════════════════════════════════════════


class TestV1V2CrossClientWeb(unittest.TestCase):
    """G1 — Python ↔ Web byte-parity. Drive the JS engine via `node` on
    ``phpoc-web/test/staging_hash_parity.mjs`` and assert its serialized rows +
    array + digest equal the committed golden bytes.

    JS V1 is GREEN today (``e.comment || null``); JS V2 is RED until
    ``computeStagingHash`` lands in ``phpoc-web/src/sync/remote_sync.js``."""

    @classmethod
    def setUpClass(cls):
        cls.fx = load_fixture()

    def test_js_canonical_rows_match_golden(self):
        """G1a: JS dtoToCanonicalRow activity strings match golden (Web V1)."""
        rows = _node("canonicalRows")
        golden_by_id = {r["activity_id"]: r["activity"] for r in self.fx["golden"]["canonical_rows"]}
        self.assertEqual(len(rows), len(self.fx["seed_dtos"]))
        for row in rows:
            self.assertEqual(row["activity"], golden_by_id[row["activity_id"]])

    def test_js_canonical_array_matches_golden(self):
        """G1b: JS canonical array (committed-filtered + sorted) == golden."""
        self.assertEqual(_node("canonicalArray"), self.fx["golden"]["canonical_array"])

    def test_js_digest_matches_golden(self):
        """G1c: JS computeStagingHash == golden (RED until helper lands)."""
        self.assertEqual(_node("stagingHash"), self.fx["golden"]["staging_hash"])


@unittest.skip(
    "P0 follow-on: Flutter leg is a Dart test "
    "(phpoc-flutter/test/data/sync/staging_hash_test.dart — Groups E/F + G2), "
    "not driven from Python. G3 (all three equal golden) is satisfied "
    "transitively when Group A/B (Python) + G1/C/D (Web) + E/F (Flutter) pass."
)
class TestV1V2CrossClientFlutter(unittest.TestCase):
    """G2/G3 — Flutter ↔ golden byte-parity + three-client adoption gate.

    Asserted in ``phpoc-flutter/test/data/sync/staging_hash_test.dart`` against
    the same committed golden bytes. Requires the new
    ``phpoc-flutter/lib/data/sync/staging_hash.dart`` helper (canonical
    ``dtoToCanonicalRow`` builder + ``computeStagingHash`` using
    ``encodeValueNoSpaces`` — NOT the spaced ``jsonSort``)."""

    def test_array_and_digest_match_golden(self):
        pass  # see phpoc-flutter/test/data/sync/staging_hash_test.dart
