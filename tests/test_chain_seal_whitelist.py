"""Phase 2/3 tests — ADR-029/029a Canonical Block-Seal Field Whitelist (Python).

Blueprint: docs/planning/CANONICAL_SEALFIELD_PYTHON_PHASE1.md (26 assertions,
groups A-E).
Docs: docs/design/ARCHITECTURAL_DECISIONS.md §ADR-029, §ADR-029a; SEAL_FIELDS_TYPE_AWARE_AMENDMENT.md.

Contract (ADR-029a — type-aware, amends ADR-029):
    SEAL_FIELDS = {
        "genesis":       {type, day_index, date, prev_hash, entries, original_hash},
        "day":           {type, day_index, date, prev_hash, entries, original_hash},
        "month_summary": {type, month, date, prev_hash, original_hash},
        "year_summary":  {type, year,  date, prev_hash, original_hash},
    }

Semantics:
    - Closed whitelist: a block's seal is an HMAC over exactly the per-type
      fields that are PRESENT, serialized with sort_keys=True.
    - Fields NOT in the block's row (format_version, key_version, identity,
      identity_seal, signature, hash keys, and any stray/future field) are
      never sealed.
    - original_hash is optional-presence on every type: sealed only when present.
    - Summaries seal their partition identity `month`/`year` (ADR-029a/D5) and
      carry no day_index/entries.
    - An unknown block type is verification-invalid (reject).
"""

import unittest
import json
import hashlib
import hmac
import os

# ──────────────────────────────────────────────────────────────────────
# Expected contract (test-side oracle for what Phase 3 defines)
# ──────────────────────────────────────────────────────────────────────

EXPECTED_SEAL_FIELDS = {
    "genesis":       {"type", "day_index", "date", "prev_hash", "entries",
                      "original_hash"},
    "day":           {"type", "day_index", "date", "prev_hash", "entries",
                      "original_hash"},
    "month_summary": {"type", "month", "date", "prev_hash", "original_hash"},
    "year_summary":  {"type", "year", "date", "prev_hash", "original_hash"},
}

# Fields that must NEVER appear in any per-type seal set.
_EXCLUDED_FIELDS = {"format_version", "key_version", "identity", "identity_seal",
                    "signature", "day_hash", "block_hash", "month_hash",
                    "year_hash", "hash"}

# Hash field name per block type (mirrors LedgerChain._hash_key_for_block)
_TYPE_HASH_KEY = {
    "genesis": "block_hash",
    "day": "day_hash",
    "month_summary": "month_hash",
    "year_summary": "year_hash",
}


def _hash_key_for_block(block):
    btype = block.get("type", "day")
    if btype == "genesis":
        if "block_hash" in block:
            return "block_hash"
        if "day_hash" in block:
            return "day_hash"  # legacy genesis
        return "block_hash"  # unsigned genesis defaults to block_hash
    return _TYPE_HASH_KEY.get(btype, "day_hash")


# ──────────────────────────────────────────────────────────────────────
# Production import
# ──────────────────────────────────────────────────────────────────────

SEAL_FIELDS = None
try:
    from domain.ledger.chain import SEAL_FIELDS
except (ImportError, ModuleNotFoundError, AttributeError):
    pass


# ──────────────────────────────────────────────────────────────────────
# Mock Crypto + Store (mirror test_content_hash_required.py)
# ──────────────────────────────────────────────────────────────────────

class _MockCrypto:
    """Deterministic crypto mock for seal/sign/encrypt/decrypt."""

    def __init__(self, mk=b"\x01" * 32):
        self.mk = mk

    def seal(self, data_str: str) -> str:
        key = hmac.new(self.mk, b"integrity-key-salt", hashlib.sha256).digest()
        return hmac.new(key, data_str.encode(), hashlib.sha256).hexdigest()

    def verify_seal(self, data_str: str, seal_hex: str) -> bool:
        return hmac.compare_digest(self.seal(data_str), seal_hex)

    def encrypt(self, text: str) -> str:
        return "enc:" + text.encode().hex()

    def decrypt(self, hex_data: str) -> str:
        if hex_data.startswith("enc:"):
            return bytes.fromhex(hex_data[4:]).decode()
        if hex_data.startswith("plain:"):
            return hex_data[6:]
        raise ValueError(f"Unknown encrypted format: {hex_data[:20]}...")

    def mac(self, data_str: str, identity_secret: bytes) -> str:
        return hmac.new(identity_secret, data_str.encode(), hashlib.sha256).hexdigest()

    def verify_mac(self, data_str: str, mac_tag: str, identity_secret: bytes) -> bool:
        return hmac.compare_digest(self.mac(data_str, identity_secret), mac_tag)


class _MockLedgerStore:
    """In-memory mock implementing AbstractLedgerStore (new API)."""

    def __init__(self, initial_ledger=None):
        self._ledger = initial_ledger if initial_ledger is not None else []

    def read_blocks(self, start=0, end=None):
        total = len(self._ledger)
        if start < 0:
            start = max(0, total + start)
        if end is None:
            end = total
        elif end < 0:
            end = max(0, total + end)
        return list(self._ledger[start:end])

    def append_blocks(self, blocks):
        self._ledger.extend(blocks)

    def truncate(self, keep_count):
        if keep_count >= len(self._ledger):
            return []
        kept = self._ledger[:keep_count]
        removed = self._ledger[keep_count:]
        self._ledger = kept
        return removed

    def get_block_count(self):
        return len(self._ledger)

    def get_last_block(self):
        return self._ledger[-1] if self._ledger else None

    # Old API fallbacks (harmless)
    def read_ledger(self):
        return list(self._ledger)

    def write_ledger(self, data):
        self._ledger = list(data)


# ──────────────────────────────────────────────────────────────────────
# Seal helpers
# ──────────────────────────────────────────────────────────────────────

def _per_type_fields(block):
    """Return the per-type seal-input field set for a block (test oracle)."""
    btype = block.get("type")
    if btype not in EXPECTED_SEAL_FIELDS:
        raise ValueError(f"Unknown block type for seal: {btype!r}")
    return EXPECTED_SEAL_FIELDS[btype]


def _seal_over_fields(crypto, block, fields, omit=()):
    """HMAC seal over the given field set (sorted, skips absent fields/omits)."""
    data = {k: v for k, v in block.items()
            if k in fields and k not in omit}
    return crypto.seal(json.dumps(data, sort_keys=True))


def _compute_entry_hash(data):
    return hashlib.sha256(json.dumps(data, sort_keys=True, indent=2).encode()).hexdigest()


def _make_entry(data=None):
    data = data if data is not None else {"title": "task", "duration": 0}
    return {"hash": _compute_entry_hash(data), "data": data}


def _build_block(btype, index, date, prev_hash, entries=None, extra_fields=None,
                 include_original_hash=False, original=None):
    """Build an unsigned block with the REAL per-type shape (ADR-029a).

    genesis/day carry day_index+entries; month_summary carries `month`;
    year_summary carries `year`. No fixture-only variants (month_index,
    day_count, total_duration) are emitted.
    """
    block = {"type": btype, "date": date, "prev_hash": prev_hash}
    if btype in ("genesis", "day"):
        block["day_index"] = index
        block["entries"] = entries if entries is not None else []
    elif btype == "month_summary":
        block["month"] = date[:7]  # 'YYYY-MM'
    elif btype == "year_summary":
        block["year"] = int(date[:4])
    if include_original_hash:
        block["original_hash"] = original if original is not None else "0" * 64
    if extra_fields:
        block.update(extra_fields)
    return block


def _seal_block_whitelist(crypto, block, seal_fields_map):
    """Seal a block over its per-type whitelist, storing under the type hash key."""
    out = dict(block)
    hk = _hash_key_for_block(out)
    out[hk] = _seal_over_fields(crypto, out, seal_fields_map[out["type"]],
                                omit={hk})
    return out


def _seal_block_open(crypto, block):
    """Seal a block the legacy way (open-set minus exclusions) for divergence tests."""
    out = dict(block)
    hk = _hash_key_for_block(out)
    check = {k: v for k, v in out.items()
             if k not in (hk, "identity_seal", "signature", "format_version",
                          "key_version")}
    out[hk] = crypto.seal(json.dumps(check, sort_keys=True))
    return out


# ──────────────────────────────────────────────────────────────────────
# Verification harness
# ──────────────────────────────────────────────────────────────────────

def _verify(chain, crypto):
    from domain.ledger.chain import LedgerChain
    store = _MockLedgerStore(initial_ledger=chain)
    lc = LedgerChain(crypto, store)
    return lc.verify()


def _chain(types, original=False):
    """Build a whitelist-sealed linked chain of the given block types (shared helper)."""
    crypto = _MockCrypto()
    chain = []
    prev = "0" * 64
    for i, t in enumerate(types):
        b = _build_block(t, i, "2026-01-0%d" % (i + 1), prev,
                         entries=[_make_entry()] if t in ("genesis", "day") else [],
                         include_original_hash=original,
                         original="%d" % (i + 1))
        hk = _hash_key_for_block(b)
        chain.append(_seal_block_whitelist(crypto, b, EXPECTED_SEAL_FIELDS))
        prev = chain[-1][hk]
    return chain, crypto


# ══════════════════════════════════════════════════════════════════════
# Group A — Whitelist selection (A7: per-type map)
# ══════════════════════════════════════════════════════════════════════

class TestSealWhitelistSelection(unittest.TestCase):
    """A7: SEAL_FIELDS is the canonical per-type map (ADR-029a)."""

    def test_a7_seal_fields_constant_defined(self):
        if SEAL_FIELDS is None:
            self.fail("SEAL_FIELDS must be defined in domain.ledger.chain (RED until"
                      " Phase 3 defines the ADR-029a per-type map).")
        self.assertTrue(isinstance(SEAL_FIELDS, dict),
                        "SEAL_FIELDS must be the per-type map (ADR-029a)")

    def test_a7_genesis_day_six_fields(self):
        if SEAL_FIELDS is None:
            self.fail("SEAL_FIELDS must be defined (RED until Phase 3).")
        for btype in ("genesis", "day"):
            self.assertEqual(set(SEAL_FIELDS[btype]),
                             EXPECTED_SEAL_FIELDS[btype],
                             f"{btype} must seal {{type, day_index, date, prev_hash,"
                             " entries, original_hash}}")

    def test_a7_month_summary_fields(self):
        if SEAL_FIELDS is None:
            self.fail("SEAL_FIELDS must be defined (RED until Phase 3).")
        self.assertEqual(set(SEAL_FIELDS["month_summary"]),
                         EXPECTED_SEAL_FIELDS["month_summary"],
                         "month_summary must seal {type, month, date, prev_hash,"
                         " original_hash} (partition identity sealed)")

    def test_a7_year_summary_fields(self):
        if SEAL_FIELDS is None:
            self.fail("SEAL_FIELDS must be defined (RED until Phase 3).")
        self.assertEqual(set(SEAL_FIELDS["year_summary"]),
                         EXPECTED_SEAL_FIELDS["year_summary"],
                         "year_summary must seal {type, year, date, prev_hash,"
                         " original_hash}")

    def test_a7_excluded_fields_never_sealed(self):
        if SEAL_FIELDS is None:
            self.fail("SEAL_FIELDS must be defined (RED until Phase 3).")
        for btype, fields in SEAL_FIELDS.items():
            self.assertTrue(_EXCLUDED_FIELDS.isdisjoint(set(fields)),
                            f"{btype} seal set must not include metadata/hash-key"
                            " fields")

    def test_a7_no_day_index_or_entries_in_summaries(self):
        if SEAL_FIELDS is None:
            self.fail("SEAL_FIELDS must be defined (RED until Phase 3).")
        for btype in ("month_summary", "year_summary"):
            fields = set(SEAL_FIELDS[btype])
            self.assertNotIn("day_index", fields,
                             "summaries carry no day_index")
            self.assertNotIn("entries", fields,
                             "summaries carry no entries")

    def test_a1_stray_field_excluded_by_whitelist_verifies(self):
        """Closed-set: block with stray `foo` (present but NOT in stored seal)
        still verifies, because the whitelist verifier excludes foo."""
        crypto = _MockCrypto()
        genesis = _seal_block_whitelist(crypto, _build_block(
            "genesis", 0, "2026-01-01", "0" * 64), EXPECTED_SEAL_FIELDS)
        day = _seal_block_whitelist(crypto, _build_block(
            "day", 1, "2026-01-02", genesis[_hash_key_for_block(genesis)],
            entries=[_make_entry()]), EXPECTED_SEAL_FIELDS)
        day["foo"] = "unexpected-client-field"
        self.assertTrue(_verify([genesis, day], crypto),
                        "Stray non-whitelisted field must NOT break the seal")

    def test_a2_stray_field_in_seal_is_rejected(self):
        """A seal computed INCLUDING a stray field must FAIL verification."""
        crypto = _MockCrypto()
        genesis = _seal_block_whitelist(crypto, _build_block(
            "genesis", 0, "2026-01-01", "0" * 64), EXPECTED_SEAL_FIELDS)
        day_body = _build_block(
            "day", 1, "2026-01-02", genesis[_hash_key_for_block(genesis)],
            entries=[_make_entry()])
        day_body["foo"] = "sealed-by-divergent-client"
        day = _seal_block_open(crypto, day_body)  # divergent: seals over foo
        self.assertFalse(_verify([genesis, day], crypto),
                         "Seal computed over a non-whitelisted field must be rejected")

    def test_a3_original_hash_required_in_seal(self):
        """Migrated-style block that SEALS over original_hash must verify."""
        crypto = _MockCrypto()
        genesis = _seal_block_whitelist(crypto, _build_block(
            "genesis", 0, "2026-01-01", "0" * 64,
            include_original_hash=True, original="a" * 64), EXPECTED_SEAL_FIELDS)
        day = _seal_block_whitelist(crypto, _build_block(
            "day", 1, "2026-01-02", genesis[_hash_key_for_block(genesis)],
            entries=[_make_entry()], include_original_hash=True,
            original="b" * 64), EXPECTED_SEAL_FIELDS)
        self.assertTrue(_verify([genesis, day], crypto),
                        "original_hash must be included in seal when present")

    def test_a4_block_without_original_hash_verifies(self):
        """original_hash absent (new/pre-migration block) must still verify."""
        crypto = _MockCrypto()
        genesis = _seal_block_whitelist(crypto, _build_block(
            "genesis", 0, "2026-01-01", "0" * 64), EXPECTED_SEAL_FIELDS)
        day = _seal_block_whitelist(crypto, _build_block(
            "day", 1, "2026-01-02", genesis[_hash_key_for_block(genesis)],
            entries=[_make_entry()]), EXPECTED_SEAL_FIELDS)
        self.assertTrue(_verify([genesis, day], crypto),
                        "Block without original_hash must still verify")

    def test_a5_format_and_key_version_excluded(self):
        """format_version/key_version NOT sealed — rotation/format-safe."""
        crypto = _MockCrypto()
        g1 = _seal_block_whitelist(crypto, _build_block(
            "genesis", 0, "2026-01-01", "0" * 64,
            extra_fields={"format_version": "0.3.0"}), EXPECTED_SEAL_FIELDS)
        g2 = _seal_block_whitelist(crypto, _build_block(
            "genesis", 0, "2026-01-01", "0" * 64,
            extra_fields={"format_version": "0.4.0", "key_version": 2}),
            EXPECTED_SEAL_FIELDS)
        self.assertEqual(g1[_hash_key_for_block(g1)], g2[_hash_key_for_block(g2)],
                         "format_version/key_version must NOT change the seal")

    def test_a6_identity_seal_signature_excluded(self):
        """Adding identity_seal/signature (after sealing) must not change seal."""
        crypto = _MockCrypto()
        d1 = _seal_block_whitelist(crypto, _build_block(
            "day", 1, "2026-01-02", "0" * 64, entries=[_make_entry()]),
            EXPECTED_SEAL_FIELDS)
        body = _build_block("day", 1, "2026-01-02", "0" * 64,
                            entries=[_make_entry()])
        d2 = _seal_block_whitelist(crypto, body, EXPECTED_SEAL_FIELDS)
        d2["identity_seal"] = "x"
        d2["signature"] = "y"
        self.assertEqual(d1[_hash_key_for_block(d1)], d2[_hash_key_for_block(d2)],
                         "identity_seal/signature must not be sealed inputs")

    def test_a8_sort_keys_canonical_shape(self):
        """Whitelist selection json-serializes with sort_keys=True, byte-stable."""
        crypto = _MockCrypto()
        block = _build_block("day", 7, "2026-03-04", "0" * 64,
                             entries=[_make_entry()], include_original_hash=True)
        data1 = {k: v for k, v in block.items() if k in EXPECTED_SEAL_FIELDS["day"]}
        data2 = {k: data1[k] for k in reversed(list(data1))}
        self.assertEqual(json.dumps(data1, sort_keys=True),
                         json.dumps(data2, sort_keys=True),
                         "Seal serialization must be order-independent")


# ══════════════════════════════════════════════════════════════════════
# Group B — Sealer build_day_block (B1-B5)
# ══════════════════════════════════════════════════════════════════════

class TestSealerBuildDayBlock(unittest.TestCase):
    """Guard B2/B3: build_day_block + verify still integrate with a whitelist chain."""

    def _genesis(self, crypto, **kw):
        return _seal_block_whitelist(crypto, _build_block(
            "genesis", 0, "2026-01-01", "0" * 64), EXPECTED_SEAL_FIELDS)

    def test_b3_whitelist_chain_verifies_end_to_end(self):
        from domain.ledger.chain import LedgerChain
        crypto = _MockCrypto()
        genesis = self._genesis(crypto)
        store = _MockLedgerStore(initial_ledger=[genesis])
        lc = LedgerChain(crypto, store)
        day = lc.build_day_block([_make_entry()],
                                 genesis[_hash_key_for_block(genesis)],
                                 "2026-01-02")
        lc.append(day)
        self.assertTrue(lc.verify(),
                        "build_day_block-sealed chain must verify end-to-end")

    def test_b5_day_index_increments_and_links(self):
        from domain.ledger.chain import LedgerChain
        crypto = _MockCrypto()
        genesis = self._genesis(crypto)
        store = _MockLedgerStore(initial_ledger=[genesis])
        lc = LedgerChain(crypto, store)
        d1 = lc.build_day_block([_make_entry()],
                                genesis[_hash_key_for_block(genesis)], "2026-01-02")
        lc.append(d1)
        d2 = lc.build_day_block([_make_entry()], d1["day_hash"], "2026-01-03")
        lc.append(d2)
        self.assertEqual(d1["day_index"], 1)
        self.assertEqual(d2["day_index"], 2)
        self.assertEqual(d2["prev_hash"], d1["day_hash"])
        self.assertTrue(lc.verify())

    def test_b1_b4_stray_metadata_does_not_change_seal(self):
        """Closed-set sealer: different stray metadata yields the SAME day_hash."""
        from domain.ledger.chain import LedgerChain
        crypto = _MockCrypto()
        entries = [_make_entry()]
        gh = "0" * 64
        d1 = LedgerChain(crypto, _MockLedgerStore(initial_ledger=[])).build_day_block(
            entries, gh, "2026-01-02")
        base = {"type": "day",
                "day_index": d1["day_index"],
                "date": d1["date"],
                "prev_hash": d1["prev_hash"],
                "entries": d1["entries"]}
        whitelist_seal = _seal_over_fields(crypto, {**base, "debug_note": "zzz"},
                                           EXPECTED_SEAL_FIELDS["day"])
        self.assertEqual(whitelist_seal, d1["day_hash"],
                         "Stray metadata must not change the seal")


# ══════════════════════════════════════════════════════════════════════
# Group C — Verifier across block types (C1-C7)
# ══════════════════════════════════════════════════════════════════════

class TestVerifierBlockTypes(unittest.TestCase):
    """C1-C7: whitelist-sealed blocks of each type verify; divergent/tampered fail."""

    def test_c1_genesis_verifies(self):
        chain, crypto = _chain(["genesis"])
        self.assertTrue(_verify(chain, crypto))

    def test_c2_day_verifies(self):
        chain, crypto = _chain(["genesis", "day"])
        self.assertTrue(_verify(chain, crypto))

    def test_c3_month_summary_verifies(self):
        """Month summary sealed over {type, month, date, prev_hash, original_hash}
        verifies (real shape, month is sealed as partition identity)."""
        chain, crypto = _chain(["genesis", "day", "month_summary"])
        self.assertTrue(_verify(chain, crypto))

    def test_c4_year_summary_verifies(self):
        """Year summary sealed over {type, year, date, prev_hash, original_hash}
        verifies (real shape, year is sealed as partition identity)."""
        chain, crypto = _chain(["genesis", "day", "month_summary", "year_summary"])
        self.assertTrue(_verify(chain, crypto))

    def test_c2_migrated_style_with_original_hash_verifies(self):
        chain, crypto = _chain(["genesis", "day", "month_summary"], original=True)
        self.assertTrue(_verify(chain, crypto),
                        "Migrated-style chain (original_hash present) must verify")

    def test_c5_divergent_seal_rejected(self):
        """Day block sealed INCLUDING a stray field must be rejected."""
        crypto = _MockCrypto()
        genesis = _seal_block_whitelist(crypto, _build_block(
            "genesis", 0, "2026-01-01", "0" * 64), EXPECTED_SEAL_FIELDS)
        body = _build_block("day", 1, "2026-01-02",
                            genesis[_hash_key_for_block(genesis)],
                            entries=[_make_entry()])
        body["foo"] = "y"
        day = _seal_block_open(crypto, body)
        self.assertFalse(_verify([genesis, day], crypto),
                         "Divergent seal (foo included) must be rejected")

    def test_c6_summary_month_identity_sealed(self):
        """Tampering a summary's `month` (partition identity) breaks the seal —
        proving month is inside the seal (ADR-029a)."""
        crypto = _MockCrypto()
        genesis = _seal_block_whitelist(crypto, _build_block(
            "genesis", 0, "2026-01-01", "0" * 64), EXPECTED_SEAL_FIELDS)
        day = _seal_block_whitelist(crypto, _build_block(
            "day", 1, "2026-01-02", genesis["block_hash"],
            entries=[_make_entry()]), EXPECTED_SEAL_FIELDS)
        ms = _seal_block_whitelist(crypto, _build_block(
            "month_summary", 2, "2026-01-03", day["day_hash"]),
            EXPECTED_SEAL_FIELDS)
        # Re-label the partition boundary — must break the seal
        ms["month"] = "1999-01"
        self.assertFalse(_verify([genesis, day, ms], crypto),
                         "Tampered summary month must break the seal")

    def test_c7_tampered_whitelist_field_rejected(self):
        """Tampering any sealed whitelist field breaks the seal."""
        crypto = _MockCrypto()
        good_head = _seal_block_whitelist(crypto, _build_block(
            "genesis", 0, "2026-01-01", "0" * 64), EXPECTED_SEAL_FIELDS)
        day_block = _seal_block_whitelist(crypto, _build_block(
            "day", 1, "2026-01-02", good_head["block_hash"],
            entries=[_make_entry()]), EXPECTED_SEAL_FIELDS)
        day_block["entries"] = [_make_entry({"title": "HACKED", "duration": 99999})]
        self.assertFalse(_verify([good_head, day_block], crypto),
                         "Tampered entries must break the seal")


# ══════════════════════════════════════════════════════════════════════
# Group D — SEAL_FIELDS per-type map integration (D1-D3)
# ══════════════════════════════════════════════════════════════════════

class TestSealFieldsIntegration(unittest.TestCase):
    """D1-D3: the production per-type map drives verification, incl. summaries."""

    def test_d1_d2_production_map_matches_oracle(self):
        """The production SEAL_FIELDS per-type map equals the oracle exactly
        (single source of truth — D1/D2)."""
        if SEAL_FIELDS is None:
            self.skipTest("SEAL_FIELDS not yet defined (Phase 3)")
        self.assertEqual(
            {k: set(v) for k, v in SEAL_FIELDS.items()},
            EXPECTED_SEAL_FIELDS)
        # Verify all four block types are present
        self.assertEqual(set(SEAL_FIELDS.keys()),
                         {"genesis", "day", "month_summary", "year_summary"})

    def test_d2_summary_sealer_uses_per_type_map(self):
        """Summary sealers (summary_policy.py) seal over the summary per-type set
        so a tampered `month` breaks the summary seal (real production shape)."""
        if SEAL_FIELDS is None:
            self.skipTest("SEAL_FIELDS not yet defined (Phase 3)")
        from domain.ledger.summary_policy import YearMonthSummaryPolicy
        crypto = _MockCrypto()
        policy = YearMonthSummaryPolicy(crypto)
        month = policy._make_month_summary("2026-01", "0" * 64, "2026-01-31")
        # Recompute by hand over the summary per-type set
        expect_fields = EXPECTED_SEAL_FIELDS["month_summary"]
        hand = crypto.seal(json.dumps(
            {k: v for k, v in month.items() if k in expect_fields},
            sort_keys=True))
        self.assertEqual(hand, month["month_hash"],
                         "summary sealer must seal {type, month, date, prev_hash}")

    def test_d3_unknown_type_rejected(self):
        """A block type with no entry in the map is verification-invalid (reject)."""
        crypto = _MockCrypto()
        genesis = _seal_block_whitelist(crypto, _build_block(
            "genesis", 0, "2026-01-01", "0" * 64), EXPECTED_SEAL_FIELDS)
        bogus = _build_block("quarter_summary", 1, "2026-01-02",
                             genesis["block_hash"])
        # Sealing an unknown type must be rejected by the production selector
        from domain.ledger.chain import select_seal_fields
        with self.assertRaises(ValueError):
            select_seal_fields(bogus)


# ══════════════════════════════════════════════════════════════════════
# Group E — Regression guard (E1-E3)
# ══════════════════════════════════════════════════════════════════════

class TestRegressionGuard(unittest.TestCase):
    """E1-E3: existing well-formed behavior preserved; content-hash untouched."""

    def _open_chain(self, crypto, n_entries=1):
        """Build a chain the pre-refactor open-set way (current fixtures)."""
        genesis = _seal_block_open(crypto, _build_block(
            "genesis", 0, "2026-01-01", "0" * 64))
        prev = genesis["block_hash"]
        day_entries = [_make_entry() for _ in range(n_entries)]
        day = _seal_block_open(crypto, _build_block(
            "day", 1, "2026-01-02", prev, entries=day_entries))
        return [genesis, day]

    def test_e1_open_set_fixture_still_verifies(self):
        """Well-formed open-set-style block (no stray fields) must continue to
        verify after the per-type whitelist change."""
        crypto = _MockCrypto()
        chain = self._open_chain(crypto)
        self.assertTrue(_verify(chain, crypto))

    def test_e2_migrated_style_verifies(self):
        """Migrated-style chain (original_hash present on every type) must verify."""
        chain, crypto = _chain(["genesis", "day", "month_summary", "year_summary"],
                               original=True)
        self.assertTrue(_verify(chain, crypto),
                        "Migrated-style chain must verify (provenance sealed)")

    def test_e3_entry_content_hash_path_untouched(self):
        """Entry content_hash verification (ADR-005, all-keys) is a separate layer;
        a day block with a valid entry content_hash still verifies after the seal
        change (the verifier handles content hashes independently)."""
        crypto = _MockCrypto()
        # Build an entry whose content_hash matches its data via the canonical
        # extendable algorithm — here we only assert the chain verifies when the
        # entry hash is valid (content-hash path remains independent).
        genesis = _seal_block_whitelist(crypto, _build_block(
            "genesis", 0, "2026-01-01", "0" * 64), EXPECTED_SEAL_FIELDS)
        entry_data = {"title": "x", "duration": 0}
        entry_hash = _compute_entry_hash(entry_data)
        day = _seal_block_whitelist(crypto, _build_block(
            "day", 1, "2026-01-02", genesis["block_hash"],
            entries=[{"hash": entry_hash, "data": entry_data}]),
            EXPECTED_SEAL_FIELDS)
        self.assertTrue(_verify([genesis, day], crypto))


if __name__ == "__main__":
    unittest.main()
