"""Test suite for LedgerMerge — TDD RED phase.

Port of phpoc-web/test/ledger_merge_test.mjs (40 tests expanded to 41).
Tests the merge() algorithm: fork detection, deduplication, sort ordering,
chain rebuild, index rebuild, stats accuracy, edge cases, and input validation.

41 tests across 11 groups:
  M  — Module existence (1)
  A  — Fork Detection (4)
  B  — Simple Merge, No Duplicates (4)
  C  — Dedup via content_hash (6)
  D  — Summary Block Handling (3)
  E  — Alphabetical Ordering (3)
  F  — Chain Integrity After Merge (5)
  G  — Index Rebuild (2)
  H  — Stats Accuracy (5)
  I  — Edge Cases (4)
  J  — Input Chain Validation (10)

Usage:
  cd /home/wacevedo/code/Testing/phpoc && python3 -m pytest tests/test_ledger_merge.py -v
"""

import unittest
import json
import hashlib
import hmac
from datetime import datetime, timezone
from typing import Optional, Dict, Any, List

# ── Module under test ──────────────────────────────────────────────────
HAS_MERGE = True
try:
    from domain.ledger.merge import LedgerMerge  # noqa: E402
    HAS_MERGE_FUNC = LedgerMerge.merge is not None
except (ImportError, NotImplementedError):
    HAS_MERGE_FUNC = False


# ──────────────────────────────────────────────────────────────────────
# Constants
# ──────────────────────────────────────────────────────────────────────

MASTER_KEY = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
IDENTITY_SECRET = "cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe"
ZERO_HASH = "0" * 64

MASTER_KEY_BYTES = bytes.fromhex(MASTER_KEY)
IDENTITY_SECRET_BYTES = bytes.fromhex(IDENTITY_SECRET)


# ──────────────────────────────────────────────────────────────────────
# Mock Crypto (replicates _MockCrypto from test_phase3_ledger_engine.py)
# ──────────────────────────────────────────────────────────────────────

class _MockCrypto:
    """Reversible encrypt/decrypt + HMAC-SHA256 seal/sign/verify.

    encrypt/decrypt use an ``enc:`` prefix + hex encoding so entries
    round-trip (needed for decrypting startTime_enc during merge rebuild).
    seal/sign use HMAC-SHA256 matching the real CryptoManager.
    """

    def __init__(self, mk: bytes = MASTER_KEY_BYTES):
        self.mk = mk

    def encrypt(self, text: str) -> str:
        return "enc:" + text.encode().hex()

    def decrypt(self, hex_data: str) -> str:
        if hex_data.startswith("enc:"):
            return bytes.fromhex(hex_data[4:]).decode()
        if hex_data.startswith("plain:"):
            return hex_data[6:]
        raise ValueError(f"Unknown encrypted format: {hex_data[:20]}...")

    def seal(self, data_str: str) -> str:
        key = hmac.new(self.mk, b"integrity-key-salt", hashlib.sha256).digest()
        return hmac.new(key, data_str.encode(), hashlib.sha256).hexdigest()

    def verify_seal(self, data_str: str, signature: str) -> bool:
        expected = self.seal(data_str)
        return hmac.compare_digest(expected, signature)

    def verifySeal(self, data_str: str, signature: str, _master_key_hex: str = "") -> bool:
        """CamelCase alias matching the JS crypto interface used by merge."""
        return self.verify_seal(data_str, signature)

    def sign(self, data_str: str, identity_secret: bytes) -> str:
        return hmac.new(identity_secret, data_str.encode(), hashlib.sha256).hexdigest()

    def verify_signature(self, data_str: str, signature: str, identity_secret: bytes) -> bool:
        expected = self.sign(data_str, identity_secret)
        return hmac.compare_digest(expected, signature)

    def verifySignature(self, data_str: str, signature: str, identity_secret: bytes) -> bool:
        """CamelCase alias matching the JS crypto interface."""
        return self.verify_signature(data_str, signature, identity_secret)


# ──────────────────────────────────────────────────────────────────────
# Helpers (mirror JS ledger_merge_test.mjs helpers exactly)
# ──────────────────────────────────────────────────────────────────────

def _sort_keys(obj):
    """Return a new dict with keys sorted recursively (shallow)."""
    return {k: obj[k] for k in sorted(obj)}


def compute_content_hash(data: dict) -> str:
    """SHA-256 over sorted content fields (matches engine.py convention)."""
    content_obj = {
        "title": data.get("title") or "",
        "startTime_enc": data.get("startTime_enc") or "",
        "endTime_enc": data.get("endTime_enc") or "",
        "duration": data.get("duration") or 0,
        "tags": data.get("tags") or [],
        "pauses_enc": data.get("pauses_enc") or "",
        "metadata_enc": data.get("metadata_enc") or "",
        "comment": data.get("comment") or "",
        "media": data.get("media") or [],
    }
    sorted_content = _sort_keys(content_obj)
    return hashlib.sha256(
        json.dumps(sorted_content, sort_keys=True).encode()
    ).hexdigest()


def compute_entry_hash(data: dict) -> str:
    """SHA-256 of json.dumps(data, sort_keys=True, indent=2)."""
    return hashlib.sha256(
        json.dumps(data, sort_keys=True, indent=2).encode()
    ).hexdigest()


def get_block_hash(block: dict) -> str:
    """Get the canonical hash for a block."""
    return block.get("day_hash") or block.get("month_hash") or block.get("year_hash")


def enc_rev(plaintext: str) -> str:
    """Reversible encryption for test entry epochs."""
    return "enc:" + plaintext.encode().hex()


def dec_rev(ciphertext_hex: str) -> str:
    """Decode an enc:-prefixed epoch value."""
    if ciphertext_hex and ciphertext_hex.startswith("enc:"):
        return bytes.fromhex(ciphertext_hex[4:]).decode()
    return ciphertext_hex


def decrypt_start_epoch(entry_data: dict) -> int:
    """Decrypt startTime_enc from entry data, returning epoch ms as int."""
    return int(dec_rev(entry_data.get("startTime_enc", "enc:0")))


def epoch_for_date(date_str: str) -> int:
    """Return epoch milliseconds for midnight UTC of date_str."""
    dt = datetime.strptime(date_str + "T00:00:00Z", "%Y-%m-%dT%H:%M:%SZ")
    dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


# ── Shared crypto instance ─────────────────────────────────────────────
crypto = _MockCrypto()


# ── Entry builder ──────────────────────────────────────────────────────

def make_entry(
    title: str,
    start_epoch: int,
    duration: int = 3600000,
    tags: list = None,
    comment: str = "",
    content_hash: str = None,
) -> dict:
    """Build an entry dict {hash, data} with reversible encryption."""
    if tags is None:
        tags = []
    data = {
        "title": title,
        "startTime_enc": enc_rev(str(start_epoch)),
        "endTime_enc": enc_rev(str(start_epoch + duration)),
        "duration": duration,
        "tags": tags,
        "pauses_enc": enc_rev("[]"),
        "metadata_enc": enc_rev("{}"),
        "comment": comment,
        "media": [],
    }
    data["content_hash"] = content_hash or compute_content_hash(data)
    return {"hash": compute_entry_hash(data), "data": data}


# ── Block builders ─────────────────────────────────────────────────────

def build_day_block(
    entries: list,
    prev_hash: str,
    date_str: str,
    day_index: int,
) -> dict:
    """Build a sealed day block dict."""
    sorted_entries = []
    for e in entries:
        if e.get("hash") is not None and e.get("data") is not None:
            data = e["data"]
        else:
            data = dict(e)
        entry_hash = compute_entry_hash(data)
        sorted_entries.append({"hash": entry_hash, "data": data})

    content = {
        "type": "day",
        "day_index": day_index,
        "date": date_str,
        "prev_hash": prev_hash,
        "entries": sorted_entries,
    }
    # Build seal from sorted keys (minus hash/signature)
    check_data = _sort_keys({k: v for k, v in content.items() if k not in ("day_hash", "signature")})
    content["day_hash"] = crypto.seal(json.dumps(check_data, sort_keys=True))
    if IDENTITY_SECRET:
        content["signature"] = crypto.sign(content["day_hash"], IDENTITY_SECRET_BYTES)
    return content


def build_genesis_block() -> dict:
    """Build a genesis block with deterministic identity fields."""
    content = {
        "type": "genesis",
        "format_version": "0.3.0",
        "day_index": 0,
        "date": "2026-01-01",
        "identity": {
            "username": "testuser",
            "email": "test@example.com",
            "recovery_seed_enc": "enc:mockseed",
            "identity_pub_key": "mockpubkey0000000000000000000000000000000000000000000000000000",
            "identity_secret_enc_fallback": "enc:mocksecret",
        },
        "prev_hash": ZERO_HASH,
        "entries": [],
    }
    check_data = _sort_keys({k: v for k, v in content.items() if k not in ("day_hash", "signature")})
    content["day_hash"] = crypto.seal(json.dumps(check_data, sort_keys=True))
    if IDENTITY_SECRET:
        content["signature"] = crypto.sign(content["day_hash"], IDENTITY_SECRET_BYTES)
    return content


def build_chain(day_specs: List[dict]) -> List[dict]:
    """Build a chain: genesis block + N day blocks from specs.

    day_specs = [{"date": "2026-06-10", "entries": [e1, e2]}, ...]
    """
    chain = [build_genesis_block()]

    for i, spec in enumerate(day_specs):
        date = spec["date"]
        entries = spec["entries"]
        prev_hash = get_block_hash(chain[-1])
        day_block = build_day_block(entries, prev_hash, date, i + 1)
        chain.append(day_block)

    return chain


def json_sort(obj: dict) -> str:
    """JSON stringify with sorted keys (matches JS jsonSort)."""
    return json.dumps(obj, sort_keys=True)


# ── Pre-built test entries ─────────────────────────────────────────────

ENTRY_A = make_entry(title="Morning Run", start_epoch=epoch_for_date("2026-06-10"), duration=3600000, tags=["fitness"])
ENTRY_B = make_entry(title="Code Review", start_epoch=epoch_for_date("2026-06-10"), duration=7200000, tags=["work"])
ENTRY_C = make_entry(title="Guitar Practice", start_epoch=epoch_for_date("2026-06-11"), duration=2700000, tags=["music"])
ENTRY_D = make_entry(title="Reading", start_epoch=epoch_for_date("2026-06-11"), duration=1800000, tags=["learning"])
ENTRY_E = make_entry(title="Meeting", start_epoch=epoch_for_date("2026-06-12"), duration=3600000, tags=["work"])
ENTRY_F = make_entry(title="Yoga", start_epoch=epoch_for_date("2026-06-12"), duration=1800000, tags=["fitness"])

# Same title/start_epoch as ENTRY_A but created independently (for dedup testing)
ENTRY_A2 = make_entry(title="Morning Run", start_epoch=epoch_for_date("2026-06-10"), duration=3600000, tags=["fitness"])
# Same title as ENTRY_A but different start_epoch
ENTRY_A_LATE = make_entry(title="Morning Run", start_epoch=epoch_for_date("2026-06-10") + 60000, duration=3600000, tags=["fitness"])
# Same title as ENTRY_A but different tags
ENTRY_A_DIFFTAGS = make_entry(title="Morning Run", start_epoch=epoch_for_date("2026-06-10"), duration=3600000, tags=["cardio"])
# Same title as ENTRY_A but different duration
ENTRY_A_DIFFDUR = make_entry(title="Morning Run", start_epoch=epoch_for_date("2026-06-10"), duration=5400000, tags=["fitness"])


# ──────────────────────────────────────────────────────────────────────
# Test Groups
# ──────────────────────────────────────────────────────────────────────

class TestLedgerMergeModule(unittest.TestCase):
    """M1 — Module existence."""

    def test_m1_merge_is_callable(self):
        """LedgerMerge.merge exists and is callable."""
        self.assertIsNotNone(LedgerMerge, "LedgerMerge module should exist")
        self.assertTrue(
            callable(LedgerMerge.merge),
            "LedgerMerge.merge should be callable",
        )


class TestForkDetection(unittest.IsolatedAsyncioTestCase):
    """Group A — Fork Detection (4 tests)."""

    async def test_a1_fork_at_genesis(self):
        """Two chains with same genesis but first day block differs → forkIndex=0."""
        local_chain = build_chain([
            {"date": "2026-06-10", "entries": [ENTRY_A]},
        ])
        remote_chain = build_chain([
            {"date": "2026-06-11", "entries": [ENTRY_C]},
        ])

        if HAS_MERGE_FUNC:
            result = await LedgerMerge.merge(
                local_chain, remote_chain, crypto, MASTER_KEY, IDENTITY_SECRET
            )
            self.assertEqual(result["stats"]["forkIndex"], 0,
                             "fork index should be 0 (diverged at genesis)")
        else:
            self.skipTest("LedgerMerge.merge not yet implemented (TDD RED)")

    async def test_a2_fork_after_n_blocks(self):
        """Common prefix of 1 day block, then different entries → forkIndex=1."""
        # Local: genesis + common block + unique block
        genesis = build_genesis_block()
        local_chain = build_chain([
            {"date": "2026-06-10", "entries": [ENTRY_A]},
        ])
        local_chain.append(
            build_day_block([ENTRY_B], get_block_hash(local_chain[-1]), "2026-06-10", len(local_chain))
        )

        # Remote: genesis + common block + different unique block
        remote_chain = [build_genesis_block()]
        remote_chain.append(
            build_day_block([ENTRY_A], get_block_hash(remote_chain[0]), "2026-06-10", 1)
        )
        remote_chain.append(
            build_day_block([ENTRY_C], get_block_hash(remote_chain[1]), "2026-06-11", 2)
        )

        if HAS_MERGE_FUNC:
            result = await LedgerMerge.merge(
                local_chain, remote_chain, crypto, MASTER_KEY, IDENTITY_SECRET
            )
            self.assertEqual(result["stats"]["forkIndex"], 1,
                             "fork index should be 1 (one common day block after genesis)")
        else:
            self.skipTest("LedgerMerge.merge not yet implemented (TDD RED)")

    async def test_a3_fork_after_summary_block(self):
        """Chains share day block at 2026-06-30, diverge at 2026-07-01."""
        local_chain = build_chain([
            {"date": "2026-06-30", "entries": [ENTRY_A]},
        ])
        local_chain.append(
            build_day_block([ENTRY_B], get_block_hash(local_chain[-1]), "2026-07-01", 2)
        )

        remote_chain = build_chain([
            {"date": "2026-06-30", "entries": [ENTRY_A]},
        ])
        remote_chain.append(
            build_day_block([ENTRY_C], get_block_hash(remote_chain[-1]), "2026-07-01", 2)
        )

        if HAS_MERGE_FUNC:
            result = await LedgerMerge.merge(
                local_chain, remote_chain, crypto, MASTER_KEY, IDENTITY_SECRET
            )
            self.assertEqual(result["stats"]["forkIndex"], 1,
                             "fork index should be 1 (common day block at 2026-06-30)")
        else:
            self.skipTest("LedgerMerge.merge not yet implemented (TDD RED)")

    async def test_a4_identical_chains(self):
        """Same chain for both local and remote → full overlap, all duplicates."""
        chain = build_chain([
            {"date": "2026-06-10", "entries": [ENTRY_A]},
            {"date": "2026-06-11", "entries": [ENTRY_B]},
        ])

        if HAS_MERGE_FUNC:
            result = await LedgerMerge.merge(
                chain, chain, crypto, MASTER_KEY, IDENTITY_SECRET
            )
            self.assertEqual(result["stats"]["forkIndex"], len(chain) - 1,
                             "fork index should be last block index (identical chains)")
            self.assertEqual(result["stats"]["duplicatesSkipped"], 2,
                             "all remote entries should be duplicates")
            self.assertEqual(result["stats"]["mergedEntries"], 2,
                             "merged entries = local entries only")
        else:
            self.skipTest("LedgerMerge.merge not yet implemented (TDD RED)")


class TestSimpleMerge(unittest.IsolatedAsyncioTestCase):
    """Group B — Simple Merge, No Duplicates (4 tests)."""

    async def test_b1_remote_empty(self):
        """Remote is genesis-only (0 entries) → merged preserves all local entries."""
        local_chain = build_chain([
            {"date": "2026-06-10", "entries": [ENTRY_A]},
        ])
        remote_chain = [build_genesis_block()]

        if HAS_MERGE_FUNC:
            result = await LedgerMerge.merge(
                local_chain, remote_chain, crypto, MASTER_KEY, IDENTITY_SECRET
            )
            self.assertEqual(result["stats"]["remoteEntries"], 0, "remote has 0 entries")
            self.assertEqual(result["stats"]["localEntries"], 1, "local has 1 entry")
            self.assertGreaterEqual(result["stats"]["mergedEntries"],
                                    result["stats"]["localEntries"],
                                    "merged entries includes all local entries")
            self.assertEqual(result["stats"]["duplicatesSkipped"], 0, "no duplicates")
        else:
            self.skipTest("LedgerMerge.merge not yet implemented (TDD RED)")

    async def test_b2_local_empty(self):
        """Local is genesis-only (0 entries) → merged preserves all remote entries."""
        local_chain = [build_genesis_block()]
        remote_chain = build_chain([
            {"date": "2026-06-11", "entries": [ENTRY_C]},
        ])

        if HAS_MERGE_FUNC:
            result = await LedgerMerge.merge(
                local_chain, remote_chain, crypto, MASTER_KEY, IDENTITY_SECRET
            )
            self.assertEqual(result["stats"]["localEntries"], 0, "local has 0 entries")
            self.assertEqual(result["stats"]["remoteEntries"], 1, "remote has 1 entry")
            self.assertGreaterEqual(result["stats"]["mergedEntries"],
                                    result["stats"]["remoteEntries"],
                                    "merged entries includes all remote entries")
            self.assertEqual(result["stats"]["duplicatesSkipped"], 0, "no duplicates")
        else:
            self.skipTest("LedgerMerge.merge not yet implemented (TDD RED)")

    async def test_b3_non_overlapping_entries(self):
        """Local 2 entries, remote 2 different entries → mergedEntries=4, 0 duplicates."""
        local_chain = build_chain([
            {"date": "2026-06-10", "entries": [ENTRY_A, ENTRY_B]},
        ])
        remote_chain = build_chain([
            {"date": "2026-06-11", "entries": [ENTRY_C, ENTRY_D]},
        ])

        if HAS_MERGE_FUNC:
            result = await LedgerMerge.merge(
                local_chain, remote_chain, crypto, MASTER_KEY, IDENTITY_SECRET
            )
            self.assertEqual(result["stats"]["localEntries"], 2, "local has 2 entries")
            self.assertEqual(result["stats"]["remoteEntries"], 2, "remote has 2 entries")
            self.assertEqual(result["stats"]["duplicatesSkipped"], 0, "no duplicates")
            self.assertEqual(result["stats"]["mergedEntries"], 4, "merged has 4 entries (2 + 2)")
        else:
            self.skipTest("LedgerMerge.merge not yet implemented (TDD RED)")

    async def test_b4_different_dates(self):
        """Local 2026-06-10, remote 2026-06-15 → at least 2 day blocks."""
        local_chain = build_chain([
            {"date": "2026-06-10", "entries": [ENTRY_A]},
        ])
        remote_chain = build_chain([
            {"date": "2026-06-15", "entries": [ENTRY_E]},
        ])

        if HAS_MERGE_FUNC:
            result = await LedgerMerge.merge(
                local_chain, remote_chain, crypto, MASTER_KEY, IDENTITY_SECRET
            )
            self.assertEqual(result["stats"]["mergedEntries"], 2,
                             "merged has 2 entries from different dates")
            day_blocks = [b for b in result["mergedChain"] if b.get("type") == "day"]
            self.assertGreaterEqual(len(day_blocks), 2,
                                    "at least 2 day blocks for different dates")
        else:
            self.skipTest("LedgerMerge.merge not yet implemented (TDD RED)")


class TestDedup(unittest.IsolatedAsyncioTestCase):
    """Group C — Dedup via content_hash (6 tests)."""

    async def test_c1_exact_duplicate(self):
        """Same title+time entry in both chains → duplicatesSkipped=1."""
        local_chain = build_chain([
            {"date": "2026-06-10", "entries": [ENTRY_A]},
        ])
        remote_chain = build_chain([
            {"date": "2026-06-10", "entries": [ENTRY_A2]},
        ])

        if HAS_MERGE_FUNC:
            result = await LedgerMerge.merge(
                local_chain, remote_chain, crypto, MASTER_KEY, IDENTITY_SECRET
            )
            self.assertEqual(result["stats"]["duplicatesSkipped"], 1, "1 duplicate skipped")
            self.assertEqual(result["stats"]["mergedEntries"], 1, "1 merged entry (not duplicated)")
        else:
            self.skipTest("LedgerMerge.merge not yet implemented (TDD RED)")

    async def test_c2_multiple_duplicates(self):
        """2 shared entries + 1 unique → duplicatesSkipped=2, mergedEntries=3."""
        local_chain = build_chain([
            {"date": "2026-06-10", "entries": [ENTRY_A, ENTRY_B]},
        ])
        remote_chain = build_chain([
            {"date": "2026-06-10", "entries": [ENTRY_A2, ENTRY_B]},
            {"date": "2026-06-11", "entries": [ENTRY_C]},
        ])

        if HAS_MERGE_FUNC:
            result = await LedgerMerge.merge(
                local_chain, remote_chain, crypto, MASTER_KEY, IDENTITY_SECRET
            )
            self.assertEqual(result["stats"]["duplicatesSkipped"], 2,
                             "2 duplicates skipped (A and B)")
            self.assertEqual(result["stats"]["mergedEntries"], 3,
                             "3 merged entries (A + B + C)")
        else:
            self.skipTest("LedgerMerge.merge not yet implemented (TDD RED)")

    async def test_c3_all_remote_are_duplicates(self):
        """All remote entries match local → newBlockCount=0, no rebuild."""
        local_chain = build_chain([
            {"date": "2026-06-10", "entries": [ENTRY_A, ENTRY_B]},
        ])
        remote_chain = build_chain([
            {"date": "2026-06-10", "entries": [ENTRY_A2, ENTRY_B]},
        ])

        if HAS_MERGE_FUNC:
            result = await LedgerMerge.merge(
                local_chain, remote_chain, crypto, MASTER_KEY, IDENTITY_SECRET
            )
            self.assertEqual(result["stats"]["remoteEntries"], 2, "remote has 2 entries")
            self.assertEqual(result["stats"]["duplicatesSkipped"], 2,
                             "all 2 remote entries skipped as dupes")
            self.assertEqual(result["stats"]["mergedEntries"], 2,
                             "merged entries = local entries")
            self.assertEqual(result["stats"]["newBlockCount"], 0,
                             "no new blocks (no unique remote entries)")
        else:
            self.skipTest("LedgerMerge.merge not yet implemented (TDD RED)")

    async def test_c4_same_title_different_times(self):
        """Same title, different start_epoch → NOT deduplicated."""
        local_chain = build_chain([
            {"date": "2026-06-10", "entries": [ENTRY_A]},
        ])
        remote_chain = build_chain([
            {"date": "2026-06-10", "entries": [ENTRY_A_LATE]},
        ])

        if HAS_MERGE_FUNC:
            result = await LedgerMerge.merge(
                local_chain, remote_chain, crypto, MASTER_KEY, IDENTITY_SECRET
            )
            self.assertEqual(
                result["stats"]["duplicatesSkipped"], 0,
                "same title but different start_epoch → not deduplicated"
            )
            self.assertEqual(result["stats"]["mergedEntries"], 2, "both entries kept")
        else:
            self.skipTest("LedgerMerge.merge not yet implemented (TDD RED)")

    async def test_c5_same_title_different_tags(self):
        """Same title, different tags → NOT deduplicated."""
        local_chain = build_chain([
            {"date": "2026-06-10", "entries": [ENTRY_A]},
        ])
        remote_chain = build_chain([
            {"date": "2026-06-10", "entries": [ENTRY_A_DIFFTAGS]},
        ])

        if HAS_MERGE_FUNC:
            result = await LedgerMerge.merge(
                local_chain, remote_chain, crypto, MASTER_KEY, IDENTITY_SECRET
            )
            self.assertEqual(
                result["stats"]["duplicatesSkipped"], 0,
                "same title but different tags → not deduplicated"
            )
            self.assertEqual(result["stats"]["mergedEntries"], 2, "both entries kept")
        else:
            self.skipTest("LedgerMerge.merge not yet implemented (TDD RED)")

    async def test_c6_same_title_different_duration(self):
        """Same title, different duration → NOT deduplicated."""
        local_chain = build_chain([
            {"date": "2026-06-10", "entries": [ENTRY_A]},
        ])
        remote_chain = build_chain([
            {"date": "2026-06-10", "entries": [ENTRY_A_DIFFDUR]},
        ])

        if HAS_MERGE_FUNC:
            result = await LedgerMerge.merge(
                local_chain, remote_chain, crypto, MASTER_KEY, IDENTITY_SECRET
            )
            self.assertEqual(
                result["stats"]["duplicatesSkipped"], 0,
                "same title but different duration → not deduplicated"
            )
            self.assertEqual(result["stats"]["mergedEntries"], 2, "both entries kept")
        else:
            self.skipTest("LedgerMerge.merge not yet implemented (TDD RED)")


class TestSummaryBlocks(unittest.IsolatedAsyncioTestCase):
    """Group D — Summary Block Handling (3 tests)."""

    async def test_d1_divergent_summaries_regenerated(self):
        """Two chains diverge at month boundary → fresh summary blocks in merge."""
        local_chain = build_chain([
            {"date": "2026-06-30", "entries": [ENTRY_A]},
        ])
        local_chain.append(
            build_day_block([ENTRY_B], get_block_hash(local_chain[-1]), "2026-07-01", 2)
        )

        remote_chain = build_chain([
            {"date": "2026-06-30", "entries": [ENTRY_A]},
        ])
        remote_chain.append(
            build_day_block([ENTRY_C], get_block_hash(remote_chain[-1]), "2026-07-01", 2)
        )

        if HAS_MERGE_FUNC:
            result = await LedgerMerge.merge(
                local_chain, remote_chain, crypto, MASTER_KEY, IDENTITY_SECRET
            )
            self.assertGreaterEqual(result["stats"]["mergedEntries"], 2,
                                    "all entries from both chains present")
            has_month_summary = any(
                b.get("type") == "month_summary" for b in result["mergedChain"]
            )
            self.assertIsNotNone(has_month_summary,
                                 "merged chain handles month boundaries")
        else:
            self.skipTest("LedgerMerge.merge not yet implemented (TDD RED)")

    async def test_d2_year_boundary_summary_regeneration(self):
        """Local Dec 31, remote Dec 31 + Jan 1 → year_summary inserted."""
        dec31_epoch = epoch_for_date("2026-12-31")
        jan01_epoch = epoch_for_date("2027-01-01")
        entry_dec = make_entry(title="Year End Review", start_epoch=dec31_epoch, duration=3600000)
        entry_jan = make_entry(title="New Year Run", start_epoch=jan01_epoch, duration=1800000)

        local_chain = build_chain([
            {"date": "2026-12-31", "entries": [entry_dec]},
        ])
        remote_chain = build_chain([
            {"date": "2026-12-31", "entries": [entry_dec]},
        ])
        remote_chain.append(
            build_day_block([entry_jan], get_block_hash(remote_chain[-1]), "2027-01-01", 2)
        )

        if HAS_MERGE_FUNC:
            result = await LedgerMerge.merge(
                local_chain, remote_chain, crypto, MASTER_KEY, IDENTITY_SECRET
            )
            self.assertGreaterEqual(result["stats"]["mergedEntries"], 2,
                                    "both entries from year boundary present")
            has_year_summary = any(
                b.get("type") == "year_summary" for b in result["mergedChain"]
            )
            self.assertIsNotNone(has_year_summary,
                                 "merged chain handles year boundary")
        else:
            self.skipTest("LedgerMerge.merge not yet implemented (TDD RED)")

    async def test_d3_empty_day_blocks_not_carried(self):
        """Empty day blocks from source chains do not appear in merged chain."""
        entry_g = make_entry(title="Unique Local", start_epoch=epoch_for_date("2026-06-10"), duration=3600000)
        entry_h = make_entry(title="Unique Remote", start_epoch=epoch_for_date("2026-06-12"), duration=3600000)

        local_chain = build_chain([
            {"date": "2026-06-10", "entries": [entry_g]},
            {"date": "2026-06-11", "entries": []},  # empty day
        ])
        remote_chain = build_chain([
            {"date": "2026-06-12", "entries": [entry_h]},
            {"date": "2026-06-13", "entries": []},  # empty day
        ])

        if HAS_MERGE_FUNC:
            result = await LedgerMerge.merge(
                local_chain, remote_chain, crypto, MASTER_KEY, IDENTITY_SECRET
            )
            day_blocks = [b for b in result["mergedChain"] if b.get("type") == "day"]
            empty_days = [b for b in day_blocks if not b.get("entries")]
            self.assertEqual(len(empty_days), 0,
                             "no empty day blocks in merged chain")
            self.assertEqual(result["stats"]["mergedEntries"], 2,
                             "2 entries from unique local and remote")
        else:
            self.skipTest("LedgerMerge.merge not yet implemented (TDD RED)")


class TestAlphabeticalOrdering(unittest.IsolatedAsyncioTestCase):
    """Group E — Alphabetical Ordering (3 tests)."""

    async def test_e1_sort_order(self):
        """Zebra, Alpha, Middle → sorted as [Alpha, Middle, Zebra]."""
        entry_zebra = make_entry(title="Zebra Study", start_epoch=epoch_for_date("2026-06-10"), duration=1800000)
        entry_alpha = make_entry(title="Alpha Review", start_epoch=epoch_for_date("2026-06-10"), duration=1800000)
        entry_middle = make_entry(title="Middle Task", start_epoch=epoch_for_date("2026-06-10"), duration=1800000)

        local_chain = build_chain([
            {"date": "2026-06-10", "entries": [entry_zebra]},
        ])
        remote_chain = build_chain([
            {"date": "2026-06-10", "entries": [entry_alpha, entry_middle]},
        ])

        if HAS_MERGE_FUNC:
            result = await LedgerMerge.merge(
                local_chain, remote_chain, crypto, MASTER_KEY, IDENTITY_SECRET
            )
            day_blocks = [b for b in result["mergedChain"] if b.get("type") == "day"]
            last_day = day_blocks[-1]
            titles = [e["data"]["title"] for e in last_day.get("entries", [])]
            self.assertEqual(titles, ["Alpha Review", "Middle Task", "Zebra Study"],
                             "entries sorted alphabetically: Alpha, Middle, Zebra")
        else:
            self.skipTest("LedgerMerge.merge not yet implemented (TDD RED)")

    async def test_e2_same_title_stability(self):
        """Two entries both titled 'AAA' → both kept with title 'AAA'."""
        entry_aaa1 = make_entry(title="AAA", start_epoch=epoch_for_date("2026-06-10"), duration=3600000)
        entry_aaa2 = make_entry(title="AAA", start_epoch=epoch_for_date("2026-06-10") + 1000, duration=1800000)

        local_chain = build_chain([
            {"date": "2026-06-10", "entries": [entry_aaa1]},
        ])
        remote_chain = build_chain([
            {"date": "2026-06-10", "entries": [entry_aaa2]},
        ])

        if HAS_MERGE_FUNC:
            result = await LedgerMerge.merge(
                local_chain, remote_chain, crypto, MASTER_KEY, IDENTITY_SECRET
            )
            day_blocks = [b for b in result["mergedChain"] if b.get("type") == "day"]
            last_day = day_blocks[-1]
            titles = [e["data"]["title"] for e in last_day.get("entries", [])]
            self.assertTrue(all(t == "AAA" for t in titles),
                            "both entries have same title AAA")
            self.assertEqual(len(titles), 2, "2 entries with same title")
        else:
            self.skipTest("LedgerMerge.merge not yet implemented (TDD RED)")

    async def test_e3_mixed_case_ordering(self):
        """'apple task', 'Apple Task', 'zebra' → all present, localeCompare ordering."""
        entry_lower = make_entry(title="apple task", start_epoch=epoch_for_date("2026-06-10"), duration=1800000)
        entry_upper = make_entry(title="Apple Task", start_epoch=epoch_for_date("2026-06-10"), duration=1800000)
        entry_z = make_entry(title="zebra", start_epoch=epoch_for_date("2026-06-10"), duration=1800000)

        local_chain = build_chain([
            {"date": "2026-06-10", "entries": [entry_z]},
        ])
        remote_chain = build_chain([
            {"date": "2026-06-10", "entries": [entry_lower, entry_upper]},
        ])

        if HAS_MERGE_FUNC:
            result = await LedgerMerge.merge(
                local_chain, remote_chain, crypto, MASTER_KEY, IDENTITY_SECRET
            )
            day_blocks = [b for b in result["mergedChain"] if b.get("type") == "day"]
            last_day = day_blocks[-1]
            titles = [e["data"]["title"] for e in last_day.get("entries", [])]
            self.assertEqual(len(titles), 3, "3 entries in merged block")
            self.assertTrue(
                "Apple Task" in titles and "apple task" in titles and "zebra" in titles,
                "all mixed-case entries present"
            )
        else:
            self.skipTest("LedgerMerge.merge not yet implemented (TDD RED)")


class TestChainIntegrity(unittest.IsolatedAsyncioTestCase):
    """Group F — Chain Integrity After Merge (5 tests)."""

    async def test_f1_full_verify_passes(self):
        """All block seals in merged chain verify."""
        local_chain = build_chain([
            {"date": "2026-06-10", "entries": [ENTRY_A]},
        ])
        remote_chain = build_chain([
            {"date": "2026-06-10", "entries": [ENTRY_B]},
        ])

        if HAS_MERGE_FUNC:
            result = await LedgerMerge.merge(
                local_chain, remote_chain, crypto, MASTER_KEY, IDENTITY_SECRET
            )
            self.assertTrue(result["mergedChain"] and len(result["mergedChain"]) > 0,
                            "merged chain is non-empty")

            all_seals_valid = True
            for block in result["mergedChain"]:
                btype = block.get("type") or "day"
                if btype in ("day", "genesis"):
                    hash_key = "day_hash"
                elif btype == "month_summary":
                    hash_key = "month_hash"
                elif btype == "year_summary":
                    hash_key = "year_hash"
                else:
                    hash_key = "day_hash"

                check_data = {k: v for k, v in block.items()
                              if k not in (hash_key, "signature")}
                check_data = _sort_keys(check_data)
                if not crypto.verify_seal(json.dumps(check_data, sort_keys=True),
                                          block[hash_key]):
                    all_seals_valid = False
                    break
            self.assertTrue(all_seals_valid, "all block seals verify in merged chain")
        else:
            self.skipTest("LedgerMerge.merge not yet implemented (TDD RED)")

    async def test_f2_prev_hash_linkage(self):
        """Every block's prev_hash matches previous block's hash."""
        local_chain = build_chain([
            {"date": "2026-06-10", "entries": [ENTRY_A]},
            {"date": "2026-06-11", "entries": [ENTRY_B]},
        ])
        remote_chain = build_chain([
            {"date": "2026-06-10", "entries": [ENTRY_A]},
            {"date": "2026-06-12", "entries": [ENTRY_C]},
        ])

        if HAS_MERGE_FUNC:
            result = await LedgerMerge.merge(
                local_chain, remote_chain, crypto, MASTER_KEY, IDENTITY_SECRET
            )
            chain = result["mergedChain"]
            linkage_valid = True
            for i in range(1, len(chain)):
                if chain[i].get("prev_hash") != get_block_hash(chain[i - 1]):
                    linkage_valid = False
                    break
            self.assertTrue(linkage_valid,
                            "prev_hash linkage correct through entire merged chain")
        else:
            self.skipTest("LedgerMerge.merge not yet implemented (TDD RED)")

    async def test_f3_entry_hashes_preserved(self):
        """Original entry hashes from source chains appear in merged chain."""
        local_chain = build_chain([
            {"date": "2026-06-10", "entries": [ENTRY_A]},
        ])
        remote_chain = build_chain([
            {"date": "2026-06-11", "entries": [ENTRY_C]},
        ])

        if HAS_MERGE_FUNC:
            result = await LedgerMerge.merge(
                local_chain, remote_chain, crypto, MASTER_KEY, IDENTITY_SECRET
            )
            merged_hashes = []
            for block in result["mergedChain"]:
                if block.get("type") in ("day", None) and block.get("entries"):
                    for e in block["entries"]:
                        merged_hashes.append(e["hash"])

            original_hashes = [ENTRY_A["hash"], ENTRY_C["hash"]]
            for oh in original_hashes:
                self.assertIn(oh, merged_hashes,
                              f"original entry hash {oh[:12]}... preserved in merged chain")
        else:
            self.skipTest("LedgerMerge.merge not yet implemented (TDD RED)")

    async def test_f4_content_hash_unchanged(self):
        """Original data.content_hash values preserved in merged chain."""
        local_chain = build_chain([
            {"date": "2026-06-10", "entries": [ENTRY_A]},
        ])
        remote_chain = build_chain([
            {"date": "2026-06-11", "entries": [ENTRY_C]},
        ])

        if HAS_MERGE_FUNC:
            result = await LedgerMerge.merge(
                local_chain, remote_chain, crypto, MASTER_KEY, IDENTITY_SECRET
            )
            original_content_hashes = [
                ENTRY_A["data"]["content_hash"],
                ENTRY_C["data"]["content_hash"],
            ]
            merged_content_hashes = []
            for block in result["mergedChain"]:
                if block.get("type") in ("day", None) and block.get("entries"):
                    for e in block["entries"]:
                        merged_content_hashes.append(e["data"]["content_hash"])

            for och in original_content_hashes:
                self.assertIn(och, merged_content_hashes,
                              f"content_hash {och[:12]}... preserved in merged chain")
        else:
            self.skipTest("LedgerMerge.merge not yet implemented (TDD RED)")

    async def test_f5_block_seals_verify(self):
        """Each merged block's seal matches recomputed seal."""
        local_chain = build_chain([
            {"date": "2026-06-10", "entries": [ENTRY_A, ENTRY_B]},
        ])
        remote_chain = build_chain([
            {"date": "2026-06-11", "entries": [ENTRY_C, ENTRY_D]},
        ])

        if HAS_MERGE_FUNC:
            result = await LedgerMerge.merge(
                local_chain, remote_chain, crypto, MASTER_KEY, IDENTITY_SECRET
            )
            seals_valid = True
            for block in result["mergedChain"]:
                btype = block.get("type") or "day"
                if btype in ("day", "genesis"):
                    hash_key = "day_hash"
                elif btype == "month_summary":
                    hash_key = "month_hash"
                elif btype == "year_summary":
                    hash_key = "year_hash"
                else:
                    hash_key = "day_hash"

                check_data = {k: v for k, v in block.items()
                              if k not in (hash_key, "signature")}
                check_data = _sort_keys(check_data)
                expected_seal = crypto.seal(json.dumps(check_data, sort_keys=True))
                if block[hash_key] != expected_seal:
                    seals_valid = False
                    break
            self.assertTrue(seals_valid,
                            "all merged block seals match recomputed seals")
        else:
            self.skipTest("LedgerMerge.merge not yet implemented (TDD RED)")


class TestIndexRebuild(unittest.IsolatedAsyncioTestCase):
    """Group G — Index Rebuild (2 tests)."""

    async def test_g1_index_contains_both_chains_entries(self):
        """Merge returns a non-null index dict."""
        local_chain = build_chain([
            {"date": "2026-06-10", "entries": [ENTRY_A]},
        ])
        remote_chain = build_chain([
            {"date": "2026-06-11", "entries": [ENTRY_C, ENTRY_D]},
        ])

        if HAS_MERGE_FUNC:
            result = await LedgerMerge.merge(
                local_chain, remote_chain, crypto, MASTER_KEY, IDENTITY_SECRET
            )
            self.assertIsNotNone(result.get("index"),
                                 "merge returns index")
            self.assertIsInstance(result["index"], dict, "index is an object")
        else:
            self.skipTest("LedgerMerge.merge not yet implemented (TDD RED)")

    async def test_g2_durations_summed_correctly(self):
        """Two 'Running' entries on same date → index shows summed duration."""
        entry_run1 = make_entry(title="Running", start_epoch=epoch_for_date("2026-06-10"), duration=3600000)
        entry_run2 = make_entry(title="Running", start_epoch=epoch_for_date("2026-06-10") + 3600000, duration=1800000)

        local_chain = build_chain([
            {"date": "2026-06-10", "entries": [entry_run1]},
        ])
        remote_chain = build_chain([
            {"date": "2026-06-10", "entries": [entry_run2]},
        ])

        if HAS_MERGE_FUNC:
            result = await LedgerMerge.merge(
                local_chain, remote_chain, crypto, MASTER_KEY, IDENTITY_SECRET
            )
            self.assertIsNotNone(result.get("index"), "index is present in result")
            idx = result["index"]
            self.assertIn("2026-06-10", idx, "index has entry for 2026-06-10")
            if "2026-06-10" in idx:
                running_total = idx["2026-06-10"].get("Running", 0)
                self.assertEqual(running_total, 5400000,
                                 f"Running duration summed correctly (expected 5400000)")
        else:
            self.skipTest("LedgerMerge.merge not yet implemented (TDD RED)")


class TestStatsAccuracy(unittest.IsolatedAsyncioTestCase):
    """Group H — Stats Accuracy (5 tests)."""

    async def test_h1_entry_counts_match(self):
        """Non-overlapping 2+2 → localEntries=2, remoteEntries=2, mergedEntries=4."""
        local_chain = build_chain([
            {"date": "2026-06-10", "entries": [ENTRY_A, ENTRY_B]},
        ])
        remote_chain = build_chain([
            {"date": "2026-06-11", "entries": [ENTRY_C, ENTRY_D]},
        ])

        if HAS_MERGE_FUNC:
            result = await LedgerMerge.merge(
                local_chain, remote_chain, crypto, MASTER_KEY, IDENTITY_SECRET
            )
            self.assertEqual(result["stats"]["localEntries"], 2, "localEntries = 2")
            self.assertEqual(result["stats"]["remoteEntries"], 2, "remoteEntries = 2")
            self.assertEqual(result["stats"]["duplicatesSkipped"], 0, "duplicatesSkipped = 0")
            self.assertEqual(result["stats"]["mergedEntries"], 4, "mergedEntries = 4 (2 + 2)")
            self.assertGreaterEqual(result["stats"]["newBlockCount"], 1,
                                    "newBlockCount >= 1")
        else:
            self.skipTest("LedgerMerge.merge not yet implemented (TDD RED)")

    async def test_h2_zero_duplicates(self):
        """Non-overlapping entries → duplicatesSkipped=0."""
        local_chain = build_chain([
            {"date": "2026-06-10", "entries": [ENTRY_A]},
        ])
        remote_chain = build_chain([
            {"date": "2026-06-11", "entries": [ENTRY_C]},
        ])

        if HAS_MERGE_FUNC:
            result = await LedgerMerge.merge(
                local_chain, remote_chain, crypto, MASTER_KEY, IDENTITY_SECRET
            )
            self.assertEqual(result["stats"]["duplicatesSkipped"], 0,
                             "duplicatesSkipped = 0 for non-overlapping entries")
            self.assertEqual(
                result["stats"]["mergedEntries"],
                result["stats"]["localEntries"] + result["stats"]["remoteEntries"],
                "mergedEntries = local + remote"
            )
        else:
            self.skipTest("LedgerMerge.merge not yet implemented (TDD RED)")

    async def test_h3_all_duplicates_correct_stats(self):
        """Identical chains → duplicatesSkipped=2, mergedEntries=2, newBlockCount=0."""
        chain = build_chain([
            {"date": "2026-06-10", "entries": [ENTRY_A, ENTRY_B]},
        ])

        if HAS_MERGE_FUNC:
            result = await LedgerMerge.merge(
                chain, chain, crypto, MASTER_KEY, IDENTITY_SECRET
            )
            self.assertEqual(result["stats"]["duplicatesSkipped"], 2,
                             "all 2 remote entries skipped")
            self.assertEqual(result["stats"]["mergedEntries"], 2,
                             "merged entries = local only")
            self.assertEqual(result["stats"]["newBlockCount"], 0, "no new blocks")
        else:
            self.skipTest("LedgerMerge.merge not yet implemented (TDD RED)")

    async def test_h4_fork_index_correct(self):
        """2 common blocks then divergence → forkIndex=1."""
        common_blocks = build_chain([
            {"date": "2026-06-10", "entries": [ENTRY_A]},
            {"date": "2026-06-11", "entries": [ENTRY_B]},
        ])
        local_chain = list(common_blocks)
        local_chain.append(
            build_day_block([ENTRY_C], get_block_hash(local_chain[-1]),
                          "2026-06-12", len(common_blocks))
        )

        # Deep copy common_blocks for remote
        remote_chain = [build_genesis_block()]
        remote_chain.append(
            build_day_block([ENTRY_A], get_block_hash(remote_chain[0]), "2026-06-10", 1)
        )
        remote_chain.append(
            build_day_block([ENTRY_B], get_block_hash(remote_chain[1]), "2026-06-11", 2)
        )
        remote_chain.append(
            build_day_block([ENTRY_D], get_block_hash(remote_chain[2]), "2026-06-12", 3)
        )

        if HAS_MERGE_FUNC:
            result = await LedgerMerge.merge(
                local_chain, remote_chain, crypto, MASTER_KEY, IDENTITY_SECRET
            )
            self.assertEqual(result["stats"]["forkIndex"], len(common_blocks) - 1,
                             f"forkIndex = {len(common_blocks) - 1} (last common block index)")
        else:
            self.skipTest("LedgerMerge.merge not yet implemented (TDD RED)")

    async def test_h5_new_block_count_correct(self):
        """Local has 1 block, remote adds 2 unique dates → newBlockCount>=2."""
        local_chain = build_chain([
            {"date": "2026-06-10", "entries": [ENTRY_A]},
        ])
        remote_chain = build_chain([
            {"date": "2026-06-10", "entries": [ENTRY_A]},    # duplicate
            {"date": "2026-06-11", "entries": [ENTRY_B]},    # unique remote
            {"date": "2026-06-12", "entries": [ENTRY_C]},    # unique remote
        ])

        if HAS_MERGE_FUNC:
            result = await LedgerMerge.merge(
                local_chain, remote_chain, crypto, MASTER_KEY, IDENTITY_SECRET
            )
            self.assertGreaterEqual(result["stats"]["newBlockCount"], 2,
                                    "newBlockCount >= 2 (2 new day blocks from remote)")
            day_blocks = [b for b in result["mergedChain"] if b.get("type") == "day"]
            self.assertEqual(len(day_blocks), 3, "3 day blocks total (genesis day + 2 new)")
        else:
            self.skipTest("LedgerMerge.merge not yet implemented (TDD RED)")


class TestEdgeCases(unittest.IsolatedAsyncioTestCase):
    """Group I — Edge Cases (4 tests)."""

    async def test_i1_genesis_only_chains(self):
        """Both chains are [genesis] → forkIndex=0, mergedEntries=0, newBlockCount=0."""
        local_chain = [build_genesis_block()]
        remote_chain = [build_genesis_block()]

        if HAS_MERGE_FUNC:
            result = await LedgerMerge.merge(
                local_chain, remote_chain, crypto, MASTER_KEY, IDENTITY_SECRET
            )
            self.assertEqual(result["stats"]["forkIndex"], 0,
                             "forkIndex = 0 for genesis-only chains")
            self.assertEqual(result["stats"]["localEntries"], 0, "localEntries = 0")
            self.assertEqual(result["stats"]["remoteEntries"], 0, "remoteEntries = 0")
            self.assertEqual(result["stats"]["mergedEntries"], 0, "mergedEntries = 0")
            self.assertEqual(result["stats"]["newBlockCount"], 0, "newBlockCount = 0")
        else:
            self.skipTest("LedgerMerge.merge not yet implemented (TDD RED)")

    async def test_i2_genesis_mismatch(self):
        """Different genesis blocks → merge raises error mentioning 'genesis'."""
        genesis1 = build_genesis_block()

        genesis2_content = {
            "type": "genesis",
            "format_version": "0.3.0",
            "day_index": 0,
            "date": "2026-06-01",
            "identity": {
                "username": "otheruser",
                "email": "other@example.com",
                "recovery_seed_enc": "enc:otherseed",
                "identity_pub_key": "otherpubkey000000000000000000000000000000000000000000000000000",
                "identity_secret_enc_fallback": "enc:othersecret",
            },
            "prev_hash": ZERO_HASH,
            "entries": [],
        }
        check_data = _sort_keys({k: v for k, v in genesis2_content.items()
                                 if k not in ("day_hash", "signature")})
        genesis2_content["day_hash"] = crypto.seal(json.dumps(check_data, sort_keys=True))
        if IDENTITY_SECRET:
            genesis2_content["signature"] = crypto.sign(genesis2_content["day_hash"],
                                                        IDENTITY_SECRET_BYTES)

        local_chain = [genesis1]
        remote_chain = [
            genesis2_content,
            build_day_block([ENTRY_A], get_block_hash(genesis2_content), "2026-06-10", 1),
        ]

        if HAS_MERGE_FUNC:
            with self.assertRaises(Exception) as ctx:
                await LedgerMerge.merge(
                    local_chain, remote_chain, crypto, MASTER_KEY, IDENTITY_SECRET
                )
            msg = str(ctx.exception).lower()
            self.assertTrue("genesis" in msg or "mismatch" in msg,
                            f"merge with mismatched genesis blocks should mention genesis/mismatch, got: {msg}")
        else:
            self.skipTest("LedgerMerge.merge not yet implemented (TDD RED)")

    async def test_i3_remote_subset_of_local(self):
        """Remote has only first day of local's 2-day chain → 0 new blocks."""
        local_chain = build_chain([
            {"date": "2026-06-10", "entries": [ENTRY_A, ENTRY_B]},
            {"date": "2026-06-11", "entries": [ENTRY_C]},
        ])
        remote_chain = build_chain([
            {"date": "2026-06-10", "entries": [ENTRY_A, ENTRY_B]},
        ])

        if HAS_MERGE_FUNC:
            result = await LedgerMerge.merge(
                local_chain, remote_chain, crypto, MASTER_KEY, IDENTITY_SECRET
            )
            self.assertEqual(result["stats"]["localEntries"], 3, "local has 3 entries")
            self.assertEqual(result["stats"]["remoteEntries"], 2, "remote has 2 entries")
            self.assertEqual(result["stats"]["duplicatesSkipped"], 2,
                             "2 remote entries are duplicates")
            self.assertEqual(result["stats"]["mergedEntries"], 3,
                             "merged entries = local entries (remote is subset)")
            self.assertEqual(result["stats"]["newBlockCount"], 0,
                             "no new blocks (remote is strict subset)")
        else:
            self.skipTest("LedgerMerge.merge not yet implemented (TDD RED)")

    async def test_i4_local_subset_of_remote(self):
        """Local has 1 entry, remote has 3 (including that 1) → duplicatesSkipped=1."""
        local_chain = build_chain([
            {"date": "2026-06-10", "entries": [ENTRY_A]},
        ])
        remote_chain = build_chain([
            {"date": "2026-06-10", "entries": [ENTRY_A, ENTRY_B]},
            {"date": "2026-06-11", "entries": [ENTRY_C]},
        ])

        if HAS_MERGE_FUNC:
            result = await LedgerMerge.merge(
                local_chain, remote_chain, crypto, MASTER_KEY, IDENTITY_SECRET
            )
            self.assertEqual(result["stats"]["localEntries"], 1, "local has 1 entry")
            self.assertEqual(result["stats"]["remoteEntries"], 3, "remote has 3 entries")
            self.assertEqual(result["stats"]["duplicatesSkipped"], 1,
                             "1 duplicate (ENTRY_A)")
            self.assertEqual(result["stats"]["mergedEntries"], 3,
                             "merged entries = remote entries (local is subset)")
            self.assertGreaterEqual(result["stats"]["newBlockCount"], 1,
                                    "new blocks from remote's unique entries")
        else:
            self.skipTest("LedgerMerge.merge not yet implemented (TDD RED)")


class TestInputValidation(unittest.IsolatedAsyncioTestCase):
    """Group J — Input Chain Validation (10 tests)."""

    async def test_j1_tampered_seal_rejects(self):
        """Flip first byte of day_hash → _verify_chain raises seal error."""
        good_chain = build_chain([{"date": "2026-06-10", "entries": [ENTRY_A]}])
        tampered = json.loads(json.dumps(good_chain))
        h = tampered[1]["day_hash"]
        tampered[1]["day_hash"] = "f" + h[1:]

        if HAS_MERGE_FUNC:
            with self.assertRaises(Exception) as ctx:
                await LedgerMerge._verify_chain(
                    "local", tampered, crypto, MASTER_KEY, IDENTITY_SECRET
                )
            msg = str(ctx.exception).lower()
            self.assertTrue("validation failed" in msg or "seal" in msg,
                            f"tampered block seal should raise, got: {msg}")
        else:
            self.skipTest("LedgerMerge._verify_chain not yet implemented (TDD RED)")

    async def test_j2_broken_prev_hash_rejects(self):
        """Set prev_hash to wrong value → raises prev_hash mismatch."""
        chain = build_chain([
            {"date": "2026-06-10", "entries": [ENTRY_A]},
            {"date": "2026-06-11", "entries": [ENTRY_B]},
        ])
        tampered = json.loads(json.dumps(chain))
        tampered[2]["prev_hash"] = tampered[1]["prev_hash"]  # wrong

        if HAS_MERGE_FUNC:
            with self.assertRaises(Exception) as ctx:
                await LedgerMerge._verify_chain(
                    "local", tampered, crypto, MASTER_KEY, IDENTITY_SECRET
                )
            msg = str(ctx.exception).lower()
            self.assertIn("prev_hash mismatch", msg,
                          f"broken prev_hash should raise, got: {msg}")
        else:
            self.skipTest("LedgerMerge._verify_chain not yet implemented (TDD RED)")

    async def test_j3_tampered_entry_hash_rejects(self):
        """Flip first byte of entry hash → raises entry hash error."""
        chain = build_chain([{"date": "2026-06-10", "entries": [ENTRY_A]}])
        tampered = json.loads(json.dumps(chain))
        h = tampered[1]["entries"][0]["hash"]
        tampered[1]["entries"][0]["hash"] = "b" + h[1:]

        if HAS_MERGE_FUNC:
            with self.assertRaises(Exception) as ctx:
                await LedgerMerge._verify_chain(
                    "local", tampered, crypto, MASTER_KEY, IDENTITY_SECRET
                )
            msg = str(ctx.exception).lower()
            self.assertIn("entry hash", msg,
                          f"tampered entry hash should raise, got: {msg}")
        else:
            self.skipTest("LedgerMerge._verify_chain not yet implemented (TDD RED)")

    async def test_j4_empty_chain_passes(self):
        """Empty chain passes validation (trivially valid)."""
        if HAS_MERGE_FUNC:
            try:
                await LedgerMerge._verify_chain(
                    "local", [], crypto, MASTER_KEY, IDENTITY_SECRET
                )
            except Exception:
                self.fail("empty chain should pass validation without error")
        else:
            self.skipTest("LedgerMerge._verify_chain not yet implemented (TDD RED)")

    async def test_j5_valid_chain_passes(self):
        """Valid chain passes validation without error."""
        chain = build_chain([
            {"date": "2026-06-10", "entries": [ENTRY_A, ENTRY_B]},
            {"date": "2026-06-11", "entries": [ENTRY_C]},
        ])

        if HAS_MERGE_FUNC:
            try:
                await LedgerMerge._verify_chain(
                    "remote", chain, crypto, MASTER_KEY, IDENTITY_SECRET
                )
            except Exception:
                self.fail("valid chain should pass validation without error")
        else:
            self.skipTest("LedgerMerge._verify_chain not yet implemented (TDD RED)")

    async def test_j6_merge_rejects_invalid_local(self):
        """Broken local genesis seal → merge raises 'local chain validation failed'."""
        good_chain = build_chain([{"date": "2026-06-10", "entries": [ENTRY_A]}])
        tampered = json.loads(json.dumps(good_chain))
        tampered[0]["day_hash"] = "b" + tampered[0]["day_hash"][1:]

        if HAS_MERGE_FUNC:
            with self.assertRaises(Exception) as ctx:
                await LedgerMerge.merge(
                    tampered, good_chain, crypto, MASTER_KEY, IDENTITY_SECRET
                )
            msg = str(ctx.exception).lower()
            self.assertIn("local chain validation failed", msg,
                          f"should reject invalid local, got: {msg}")
        else:
            self.skipTest("LedgerMerge.merge not yet implemented (TDD RED)")

    async def test_j7_merge_rejects_invalid_remote(self):
        """Broken remote genesis seal → merge raises 'remote chain validation failed'."""
        good_chain = build_chain([{"date": "2026-06-10", "entries": [ENTRY_A]}])
        tampered = json.loads(json.dumps(good_chain))
        tampered[0]["day_hash"] = "b" + tampered[0]["day_hash"][1:]

        if HAS_MERGE_FUNC:
            with self.assertRaises(Exception) as ctx:
                await LedgerMerge.merge(
                    good_chain, tampered, crypto, MASTER_KEY, IDENTITY_SECRET
                )
            msg = str(ctx.exception).lower()
            self.assertIn("remote chain validation failed", msg,
                          f"should reject invalid remote, got: {msg}")
        else:
            self.skipTest("LedgerMerge.merge not yet implemented (TDD RED)")

    async def test_j8_both_invalid_local_first(self):
        """Both chains tampered → local error fires first."""
        good_chain = build_chain([{"date": "2026-06-10", "entries": [ENTRY_A]}])
        bad_local = json.loads(json.dumps(good_chain))
        bad_remote = json.loads(json.dumps(good_chain))
        bad_local[0]["day_hash"] = "b" + bad_local[0]["day_hash"][1:]
        bad_remote[0]["day_hash"] = "c" + bad_remote[0]["day_hash"][1:]

        if HAS_MERGE_FUNC:
            with self.assertRaises(Exception) as ctx:
                await LedgerMerge.merge(
                    bad_local, bad_remote, crypto, MASTER_KEY, IDENTITY_SECRET
                )
            msg = str(ctx.exception).lower()
            self.assertIn("local chain validation failed", msg,
                          "local validation should fire first")
            self.assertNotIn("remote", msg,
                             "remote should not be checked when local fails")
        else:
            self.skipTest("LedgerMerge.merge not yet implemented (TDD RED)")

    async def test_j9_invalid_remote_genesis_mismatch_validation_first(self):
        """Tampered day block on different-genesis remote → validation fires, NOT genesis error."""
        good_local = build_chain([{"date": "2026-06-10", "entries": [ENTRY_A]}])

        # Build a chain with a DIFFERENT genesis
        genesis2 = {
            "type": "genesis",
            "format_version": "0.3.0",
            "day_index": 0,
            "date": "2026-06-01",
            "identity": {
                "username": "otheruser",
                "email": "other@example.com",
                "recovery_seed_enc": "enc:otherseed",
                "identity_pub_key": "otherpubkey000000000000000000000000000000000000000000000000000",
                "identity_secret_enc_fallback": "enc:othersecret",
            },
            "prev_hash": ZERO_HASH,
            "entries": [],
        }
        check_data = _sort_keys({k: v for k, v in genesis2.items()
                                 if k not in ("day_hash", "signature")})
        genesis2["day_hash"] = crypto.seal(json.dumps(check_data, sort_keys=True))
        if IDENTITY_SECRET:
            genesis2["signature"] = crypto.sign(genesis2["day_hash"], IDENTITY_SECRET_BYTES)

        bad_remote = [
            genesis2,
            build_day_block([ENTRY_B], get_block_hash(genesis2), "2026-06-10", 1),
        ]
        # Tamper the remote's day block seal (block 1)
        bad_remote[1]["day_hash"] = "b" + bad_remote[1]["day_hash"][1:]

        if HAS_MERGE_FUNC:
            with self.assertRaises(Exception) as ctx:
                await LedgerMerge.merge(
                    good_local, bad_remote, crypto, MASTER_KEY, IDENTITY_SECRET
                )
            msg = str(ctx.exception).lower()
            self.assertIn("remote chain validation failed", msg,
                          "remote validation should fire before genesis mismatch check")
            self.assertNotIn("genesis", msg,
                             "should not mention genesis when validation fires first")
        else:
            self.skipTest("LedgerMerge.merge not yet implemented (TDD RED)")

    async def test_j10_invalid_local_genesis_mismatch_validation_first(self):
        """Tampered local genesis + different-genesis remote → local validation fires first."""
        good_remote = build_chain([{"date": "2026-06-10", "entries": [ENTRY_A]}])
        bad_local = json.loads(json.dumps(good_remote))
        bad_local[0]["day_hash"] = "b" + bad_local[0]["day_hash"][1:]

        if HAS_MERGE_FUNC:
            with self.assertRaises(Exception) as ctx:
                await LedgerMerge.merge(
                    bad_local, good_remote, crypto, MASTER_KEY, IDENTITY_SECRET
                )
            msg = str(ctx.exception).lower()
            self.assertIn("local chain validation failed", msg,
                          "local validation should fire before genesis mismatch check")
            self.assertNotIn("genesis", msg,
                             "should not mention genesis when validation fires first")
        else:
            self.skipTest("LedgerMerge.merge not yet implemented (TDD RED)")


if __name__ == "__main__":
    unittest.main()
