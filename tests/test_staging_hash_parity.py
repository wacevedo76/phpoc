"""Staging-hash parity vectors V1/V2 — ADR-034 P0 gate (BLUEPRINT / RED).

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

Empirically-verified classification (as of this draft):

  🔴 genuinely RED today:
     * V1 (Python) — ``dtoToCanonicalRow`` does **not** yet normalize an
       empty-string ``comment`` to ``null`` (ADR-034 §4.1). Seed ``act-0002``
       has ``comment == ""``; Python emits ``""``, the golden emits ``null``.
     * V2 (Python) — ``compute_staging_hash`` is not yet implemented in
       ``domain/staging/row_merge.py`` (P0 deliverable); ImportError → red.
     * V2 (Web) / V2 (Flutter) — ``computeStagingHash`` / ``computeStagingHash``
       helpers not yet implemented (P0).

  🟢 green today:
     * V1 (Web) — JS ``dtoToCanonicalRow`` already emits ``e.comment || null``,
       so it already normalizes empty-string comment to ``null`` (matches golden).

  ⏸ not yet wired (P0 follow-on — placeholder tests below):
     * Cross-client legs require ``phpoc-web/test/staging_hash_parity.mjs`` and a
       Dart runner + ``phpoc-flutter/lib/data/sync/staging_hash.dart``.

The golden bytes are **committed constants**, never re-derived at test time, so
the gate is non-circular (the test re-derives from ``seed_dtos`` and compares).

Run::

    PYTHONPATH=. python3 -m pytest tests/test_staging_hash_parity.py -v
"""

import json
import unittest
from pathlib import Path

from domain.staging.row_merge import dtoToCanonicalRow  # existing (P0 will add the comment coercion)

_REPO_ROOT = Path(__file__).resolve().parent.parent
_FIXTURE = _REPO_ROOT / "testdata" / "staging_hash_seed.json"


def load_fixture() -> dict:
    with open(_FIXTURE, "r", encoding="utf-8") as f:
        return json.load(f)


def _serialize_canonical_array(rows: list) -> str:
    """The array-serialization step of the spec: filter committed, sort by
    activity_id ascending, then compact json with sorted keys."""
    rows = [r for r in rows if not r.get("committed")]
    rows = sorted(rows, key=lambda r: r["activity_id"])
    return json.dumps(rows, sort_keys=True, separators=(",", ":"))


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

    def test_canonical_rows_match_golden(self):
        """Full 5-field canonical row (activity_id/status/updated_at/committed)
        matches the golden row for every seed DTO."""
        golden_by_id = {r["activity_id"]: r for r in self.fx["golden"]["canonical_rows"]}
        for dto in self.fx["seed_dtos"]:
            row = dtoToCanonicalRow(dto, device_id=self.device, now=self.now)
            self.assertEqual(row, golden_by_id[row["activity_id"]])

    def test_activity_string_matches_golden(self):
        """The nested ``activity`` JSON string matches golden byte-for-byte
        (pinned key order + ``comment`` ''→null normalization)."""
        golden_by_id = {r["activity_id"]: r["activity"] for r in self.fx["golden"]["canonical_rows"]}
        for dto in self.fx["seed_dtos"]:
            row = dtoToCanonicalRow(dto, device_id=self.device, now=self.now)
            self.assertEqual(
                row["activity"],
                golden_by_id[row["activity_id"]],
                f"activity string mismatch for {row['activity_id']}",
            )

    def test_canonical_array_matches_golden(self):
        """The full serialized array (sorted + committed-excluded) matches the
        golden byte string."""
        rows = [dtoToCanonicalRow(d, device_id=self.device, now=self.now) for d in self.fx["seed_dtos"]]
        self.assertEqual(_serialize_canonical_array(rows), self.fx["golden"]["canonical_array"])


# ═══════════════════════════════════════════════════════════════════════════
# V2 — Digest (SHA-256 of the canonical array)
# ═══════════════════════════════════════════════════════════════════════════


class TestV2Digest(unittest.TestCase):
    """V2 — identical ``staging_hash`` across clients.

    RED today: ``compute_staging_hash`` is not yet implemented. The import is
    performed inside the test so the missing-helper state surfaces as a clean
    per-test failure rather than a module-level collection error.
    """

    def test_digest_matches_golden(self):
        from domain.staging.row_merge import compute_staging_hash  # P0 — to implement

        fx = load_fixture()
        rows = [dtoToCanonicalRow(d, device_id=fx["device_id"], now=fx["now"]) for d in fx["seed_dtos"]]
        self.assertEqual(compute_staging_hash(rows), fx["golden"]["staging_hash"])


# ═══════════════════════════════════════════════════════════════════════════
# Cross-client legs (P0 follow-on — placeholders)
# ═══════════════════════════════════════════════════════════════════════════


@unittest.skip("P0 follow-on: requires phpoc-web/test/staging_hash_parity.mjs + JS computeStagingHash")
class TestV1V2CrossClientWeb(unittest.TestCase):
    """Drive the JS engine via ``node`` on ``phpoc-web/test/staging_hash_parity.mjs``
    (mirrors ``tests/test_ccs4_cross_client.py`` / ``ccs4_cross_client.mjs``) and
    assert its serialized array + digest equal the golden bytes. JS V1 is expected
    GREEN today (``e.comment || null``); JS V2 is RED until ``computeStagingHash``
    lands in ``phpoc-web/src/sync/remote_sync.js``."""

    def test_array_and_digest_match_golden(self):
        pass  # RED placeholder — see docstring


@unittest.skip("P0 follow-on: requires phpoc-flutter/lib/data/sync/staging_hash.dart + a Dart runner")
class TestV1V2CrossClientFlutter(unittest.TestCase):
    """Drive the Dart engine and assert its serialized array + digest equal the
    golden bytes. Requires the new ``staging_hash.dart`` helper (compact
    ``json.encode`` + sorted keys + SHA-256) and a runner harness. Flutter's
    default ``json.encode`` spacing is a known divergence (see CCS-4 B2) — the
    Dart helper must emit compact separators to match."""

    def test_array_and_digest_match_golden(self):
        pass  # RED placeholder — see docstring
