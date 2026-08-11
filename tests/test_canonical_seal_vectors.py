"""Cross-client CANONICAL seal-vector tests (ADR-029/029a, Phase 6).

Consumes `testdata/canonical_seal_vectors.json` — the CLOSED-whitelist fixture
that supersedes the stale pre-ADR-029a open-set `canonical_test_vectors.json`.

Blueprint: `docs/planning/CANONICAL_SEALFIELD_PHASE6_VECTORS_PHASE1.md`
  Group A — vector fixture correctness & shape (A1–A7)
  Group B — exact cross-client seal parity (B5/B7/B8 in Python)
  Group D — divergence detection / closed-set proof (D1, D3, D4)
  Group E — supersede & regression guard (E1)

NOTES on RED/GREEN in this file:
  * The Python harness (chain.py select_seal_fields) ALREADY implements the
    ADR-029a per-type whitelist with month/year, so B-series exact-asserts are
    convergence GUARDS (GREEN now, protect against future drift).
  * The genuinely-RED summary-seal tests live in
    phpoc-flutter/test/.../chain_seal_whitelist_test.dart (Group C + D2),
    because Flutter `_sealFields` still uses a single day-style list and does
    NOT seal month/year (Finding 2). That divergence is the real Phase 3 fix.
"""

import hashlib
import hmac
import json
import unittest
from pathlib import Path

from domain.ledger.chain import select_seal_fields

from test_migration import MASTER_KEY, IDENTITY_SECRET_BYTES, _MockCrypto

PROJECT_ROOT = Path(__file__).parent.parent
VECTORS_PATH = PROJECT_ROOT / "testdata" / "canonical_seal_vectors.json"
STALE_PATH = PROJECT_ROOT / "testdata" / "canonical_test_vectors.json"


def load_vectors(path=VECTORS_PATH):
    if not path.exists():
        return {}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _vector_map(data: dict) -> dict:
    """Return the fixture's ``vectors`` mapping (empty dict if missing).

    Shared by every test class so loading stays DRY and each class only
    accesses the exactly-shaped field it needs."""
    return data.get("vectors", {})


class _RefSealer(_MockCrypto):
    """Test-local HMAC sealer using the canonical cross-client derivation."""

    @staticmethod
    def _seal_hex(data_str: str, mk: bytes = MASTER_KEY) -> str:
        key = hmac.new(mk, b"integrity-key-salt", hashlib.sha256).digest()
        return hmac.new(key, data_str.encode(), hashlib.sha256).hexdigest()


def ref_seal(block: dict) -> str:
    """Compute expected_seal over select_seal_fields(block) with sort_keys."""
    return _RefSealer._seal_hex(json.dumps(select_seal_fields(block),
                                           sort_keys=True))


_SERIALIZERS = {
    "sort_keys": lambda b: json.dumps(select_seal_fields(b), sort_keys=True),
    "indent2": lambda b: json.dumps(select_seal_fields(b), sort_keys=True,
                                    indent=2),
    "no_space": lambda b: json.dumps(select_seal_fields(b), sort_keys=True,
                                     separators=(",", ":")),
}


class TestGroupAVectorFixture(unittest.TestCase):
    """Group A — vector fixture correctness & shape (A1–A7)."""

    @classmethod
    def setUpClass(cls):
        cls.data = load_vectors()
        cls.vectors = _vector_map(cls.data)

    def test_a1_fixture_complete_8_vectors(self):
        """A1: fixture holds all four types × original_hash absent/present."""
        expected = {
            "V-genesis", "V-genesis-orig",
            "V-day", "V-day-orig",
            "V-month", "V-month-orig",
            "V-year", "V-year-orig",
        }
        self.assertEqual(set(self.vectors.keys()), expected,
                         "fixture must contain exactly the 8 canonical vectors")

    def test_a2_expected_seal_is_generated_not_hand_typed(self):
        """A2: each expected_seal == HMAC(HMAC(MK,salt), jsonSort(selected))."""
        for name, v in self.vectors.items():
            recomputed = ref_seal(v["block_data"])
            self.assertEqual(recomputed, v["expected_seal"],
                             f"{name} expected_seal must equal the derived "
                             "closed-set formula (self-consistent, not hand-typed)")

    def test_a3_month_summary_uses_real_month_not_month_index(self):
        """A3: month_summary rows carry `month` (YYYY-MM), NOT month_index."""
        for name in ("V-month", "V-month-orig"):
            row = self.vectors[name]["block_data"]
            self.assertEqual(row["type"], "month_summary")
            self.assertEqual(row["month"], "2026-07",
                             f"{name} must carry real `month` field")
            self.assertNotIn("month_index", select_seal_fields(row),
                             f"{name} must not reintroduce month_index in seal")
        # A5 tie-in: the excluded month_index is allowed on the WIDE block only.
        self.assertIn("month_index", self.vectors["V-month"]["block_data"],
                      "wide row may carry excluded telemetry to prove exclusion")

    def test_a4_year_summary_uses_real_year_not_year_index(self):
        """A4: year_summary rows carry `year` (int), NOT year_index."""
        for name in ("V-year", "V-year-orig"):
            row = self.vectors[name]["block_data"]
            self.assertEqual(row["type"], "year_summary")
            self.assertIsInstance(row["year"], int,
                                  f"{name} must carry int `year`")
            self.assertEqual(row["year"], 2026)
            self.assertNotIn("year_index", select_seal_fields(row),
                             f"{name} must not reintroduce year_index in seal")

    def test_a5_excluded_fields_do_not_enter_expected_seal(self):
        """A5: excluded fields present in wide block are absent from seal row."""
        excluded = {"identity", "format_version", "key_version",
                    "identity_seal", "signature", "month_index", "year_index",
                    "total_entries", "total_duration_ms"}
        for name, v in self.vectors.items():
            block = v["block_data"]
            sel = select_seal_fields(block)
            for field in excluded:
                self.assertNotIn(field, sel,
                                 f"{name}: excluded field {field!r} must not "
                                 "be in expected_seal input")

    def test_a6_seal_stable_across_serializers(self):
        """A6: canonical seal is stable; cross-client fallbacks encode the SAME
        selected-fields dict, so a 3-way-fallback verifier (Flutter verifySeal)
        accepts the single expected_seal from any of the three encodings."""
        for name, v in self.vectors.items():
            block = v["block_data"]
            selected = select_seal_fields(block)
            # The canonical compact serializer (jsonSort) reproduces expected_seal.
            self.assertEqual(ref_seal(block), v["expected_seal"],
                             f"{name}: canonical jsonSort must reproduce expected_seal")
            # indent2 and no-space encode the SAME logical selected-fields object;
            # their bytes differ only in whitespace and therefore resolve to the
            # same seal under a whitespace-normalizing 3-way fallback verifier.
            for sname, ser_fn in _SERIALIZERS.items():
                decoded = json.loads(ser_fn(block))
                self.assertEqual(decoded, selected,
                                 f"{name}: serializer {sname!r} encodes the same "
                                 "selected-fields dict (cross-client parity)")

    def test_a7_new_fixture_is_the_only_live_vector_source(self):
        """A7: no live consumer may depend on the stale open-set fixture."""
        # The new closed fixture exists and is non-empty.
        self.assertTrue(VECTORS_PATH.exists(), "canonical_seal_vectors.json must exist")
        self.assertTrue(self.vectors, "new fixture must have vectors")
        # The stale fixture's V-genesis/V-month/V-year open-set seals are
        # superseded: their values differ from the closed-set recompute.
        stale = load_vectors(STALE_PATH).get("vectors", {})
        self.assertTrue(stale, "stale fixture expected present for the A7 check")
        for name, new_v in self.vectors.items():
            # Only compare the shared (non -orig) names present in the stale set.
            if name in stale:
                self.assertNotEqual(
                    stale[name]["expected_seal"], ref_seal(new_v["block_data"]),
                    f"{name}: stale open-set seal must NOT equal the closed-set "
                    "seal (supersedes stale contract)")


class TestGroupBPythonParity(unittest.TestCase):
    """Group B (Python) — exact closed-set parity + integrated verify (B5, B7, B8)."""

    @classmethod
    def setUpClass(cls):
        cls.data = load_vectors()
        cls.vectors = _vector_map(cls.data)

    def test_b5_original_hash_absent_and_present_both_exact(self):
        """B5: orig-absent AND orig-present variants reproduce expected_seal."""
        for name in ("V-genesis", "V-day", "V-month", "V-year"):
            self._assert_exact(name)
        for name in ("V-genesis-orig", "V-day-orig", "V-month-orig", "V-year-orig"):
            self._assert_exact(name)

    def _assert_exact(self, name):
        v = self.vectors[name]
        computed = _MockCrypto().seal(json.dumps(select_seal_fields(v["block_data"]),
                                                 sort_keys=True))
        self.assertEqual(computed, v["expected_seal"],
                         f"{name} exact closed-set seal (Python)")

    @unittest.skipUnless(PROJECT_ROOT.joinpath("domain").exists(), "domain import")
    def test_b7_chain_of_all_four_types_verifies(self):
        """B7: integrated chains of the four vector types verify end-to-end.

        Both the original_hash-ABSENT chain (V-genesis→V-year→V-month→V-day)
        and the original_hash-PRESENT chain (…-orig) are chained in the D4
        hierarchy (Genesis→Year→Month→Day), each downstream prev_hash already
        pointing at the upstream expected_seal. The day rows have empty entries
        so the orthogonal entry/content-hash layer does not interfere with the
        seal-convergence claim."""
        from domain.ledger.chain import LedgerChain
        from security.crypto import CryptoManager
        from test_migration import _MockLedgerStore
        crypto = _MockCrypto()
        crypto_mgr = CryptoManager(MASTER_KEY)
        hash_key = {"genesis": "block_hash", "year_summary": "year_hash",
                    "month_summary": "month_hash", "day": "day_hash"}

        for suffix in ("", "-orig"):
            order = ["V-genesis" + suffix, "V-year" + suffix,
                     "V-month" + suffix, "V-day" + suffix]
            blocks = []
            for name in order:
                btype = self.vectors[name]["block_data"]["type"]
                seal = self.vectors[name]["expected_seal"]
                block = dict(self.vectors[name]["block_data"])
                block[hash_key[btype]] = seal
                block["identity_seal"] = crypto.mac(seal, IDENTITY_SECRET_BYTES)
                blocks.append(block)
            chain = LedgerChain(crypto_mgr, _MockLedgerStore(blocks),
                                IDENTITY_SECRET_BYTES)
            self.assertTrue(
                chain.verify(),
                f"B7: integrated {suffix or 'absent'}-original_hash chain of "
                "genesis/year/month/day vector seals must verify end-to-end "
                "(ADR-029a closed whitelist)")

    def test_b8_seal_input_string_byte_identical_cross_client(self):
        """B8: canonical (jsonSort) seal-input string reproduces the EXACT
        expected_seal — the byte-identical contract the Web/Flutter canonical
        serializers must also reproduce (asserted per-client in their suites)."""
        for name, v in self.vectors.items():
            block = v["block_data"]
            # Canonical compact serialization := Python json.dumps(sort_keys=True),
            # byte-for-byte equal to what Web `jsonSort` and Flutter `jsonSort`
            # produce for the SAME selected fields.
            self.assertEqual(ref_seal(block), v["expected_seal"],
                             f"{name}: canonical seal-input string must reproduce "
                             "the exact expected_seal (cross-client byte-identity)")


class TestGroupDDivergenceDetection(unittest.TestCase):
    """Group D — closed-set proof & tamper detection (D1, D3, D4)."""

    @classmethod
    def setUpClass(cls):
        cls.data = load_vectors()
        cls.vectors = _vector_map(cls.data)

    def test_d1_open_set_seal_differs_from_closed_set(self):
        """D1: open-set (full block_data) seal != closed-set expected_seal."""
        for name in ("V-genesis", "V-month", "V-year"):
            v = self.vectors[name]
            open_seal = _MockCrypto().seal(
                json.dumps(v["block_data"], sort_keys=True))
            self.assertNotEqual(open_seal, v["expected_seal"],
                                f"{name}: open-set (incl excluded fields) seal "
                                "must differ from the closed-set expected_seal")

    def test_d3_excluded_field_add_does_not_change_seal(self):
        """D3: adding any excluded field does NOT change the closed seal."""
        excluded = ["identity", "month_index", "year_index", "total_entries",
                    "total_duration_ms", "format_version", "key_version"]
        for name in ("V-genesis", "V-month", "V-year"):
            v = self.vectors[name]
            for field in excluded:
                block = dict(v["block_data"])
                block.pop(field, None)
                self.assertEqual(ref_seal(block), v["expected_seal"],
                                 f"{name}: seal must be invariant to "
                                 f"presence/absence of excluded {field!r}")

    def test_d4_tamper_sealed_field_invalidates_seal(self):
        """D4: tampering a whitelisted field yields a different seal."""
        tamper_map = {
            "V-genesis": {"date": "2026-07-04"},
            "V-month": {"month": "2026-08"},
            "V-year": {"year": 2027},
        }
        for name, tamper in tamper_map.items():
            v = self.vectors[name]
            block = dict(v["block_data"])
            block.update(tamper)
            self.assertNotEqual(ref_seal(block), v["expected_seal"],
                                f"{name}: tampering {tamper} must invalidate "
                                "the closed-set seal")


class TestGroupESupersedeAndRegressionGuard(unittest.TestCase):
    """Group E (Python) — E1: full ecosystem stays GREEN after the swap."""

    def test_e1_new_fixture_loadable_and_has_expected_master_key(self):
        """E1 guard: new fixture is loadable, well-formed, uses canonical MK."""
        data = load_vectors()
        self.assertEqual(data.get("_master_key_hex"),
                         "deadbeef" * 8,
                         "fixture must use the fixed deadbeef MASTER_KEY")
        self.assertEqual(len(data.get("vectors", {})), 8,
                         "fixture must have exactly 8 vectors")
        # Every expected_seal is 64 lowercase hex chars.
        for name, v in data["vectors"].items():
            s = v["expected_seal"]
            self.assertEqual(len(s), 64, f"{name} seal must be 64 hex")
            self.assertTrue(all(c in "0123456789abcdef" for c in s),
                            f"{name} seal must be lowercase hex")


if __name__ == "__main__":
    unittest.main()
