"""Tests for ph migrate-format command.

Covers:
  - Successful migration (single/multiple day blocks)
  - Provenance fields (original_hash, original_entry_hash)
  - Content hash recomputation with extensible 0.4.0 algorithm
  - --file and --output path modes
  - Edge cases: already-0.4.0, empty ledger, missing genesis, decrypt failures
  - Genesis-only chains
  - Mixed block types (month_summary pass-through)

Uses _MockCrypto and _MockLedgerStore patterns from test_content_hash_required.py.
"""

import unittest
import json
import hashlib
import hmac
import tempfile
import shutil
from pathlib import Path
from typing import Optional

from domain.ledger.chain import select_seal_fields


# ──────────────────────────────────────────────────────────────────────
# Mock Helpers
# ──────────────────────────────────────────────────────────────────────

class _MockCrypto:
    """Deterministic crypto mock matching test_content_hash_required.py."""

    def __init__(self, mk=b"\x01" * 32):
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

    def verify_seal(self, data_str: str, seal_hex: str) -> bool:
        return hmac.compare_digest(self.seal(data_str), seal_hex)

    def mac(self, data_str: str, identity_secret: bytes) -> str:
        return hmac.new(identity_secret, data_str.encode(), hashlib.sha256).hexdigest()

    def verify_mac(self, data_str: str, mac_tag: str, identity_secret: bytes) -> bool:
        return hmac.compare_digest(self.mac(data_str, identity_secret), mac_tag)


# ──────────────────────────────────────────────────────────────────────
# Chain Builder Helpers
# ──────────────────────────────────────────────────────────────────────

def _make_entry_data(crypto, title="Task", start="09:00", end="10:00",
                     duration=60, tags=None, comment=""):
    """Build an entry data dict with encrypted fields and a placeholder content_hash."""
    return {
        "title": title,
        "title_enc": crypto.encrypt(title),
        "startTime": start,
        "startTime_enc": crypto.encrypt(start),
        "endTime": end,
        "endTime_enc": crypto.encrypt(end),
        "duration": duration,
        "duration_enc": crypto.encrypt(str(duration)),
        "pauses": [],
        "pauses_enc": crypto.encrypt("[]"),
        "metadata": "{}",
        "metadata_enc": crypto.encrypt("{}"),
        "tags": tags or ["work"],
        "comment": comment,
        "comment_enc": crypto.encrypt(comment),
        "media": [],
        "content_hash": "0" * 64,  # placeholder — migration replaces this
    }


def _compute_entry_hash(data):
    """Canonical entry hash: SHA-256 of sort_keys=True, indent=2 JSON."""
    return hashlib.sha256(
        json.dumps(data, sort_keys=True, indent=2).encode()
    ).hexdigest()


def _seal_day_block(block, crypto):
    """Compute day_hash for a block."""
    seal_data = {k: v for k, v in block.items()
                 if k not in ("day_hash", "identity_seal", "signature",
                              "format_version", "key_version")}
    return crypto.seal(json.dumps(seal_data, sort_keys=True))


def _seal_genesis(genesis, crypto, identity_secret):
    """Compute block_hash and identity_seal for genesis."""
    check = {k: v for k, v in genesis.items()
             if k not in ("block_hash", "identity_seal", "signature",
                          "format_version", "key_version")}
    genesis["block_hash"] = crypto.seal(json.dumps(check, sort_keys=True))
    genesis["identity_seal"] = crypto.mac(genesis["block_hash"], identity_secret)
    return genesis


def build_chain(crypto, identity_secret, num_day_blocks=1):
    """Build a minimal valid chain: genesis + N day blocks.

    Returns a list of dicts ready for json.dump.
    """
    id_ct = crypto.encrypt("test-identity-secret")

    genesis = {
        "type": "genesis",
        "format_version": "0.2.0",
        "key_version": 1,
        "block_hash": "placeholder",
        "identity": {"identity_secret_enc_fallback": id_ct},
        "identity_seal": "placeholder",
    }
    genesis = _seal_genesis(genesis, crypto, identity_secret)

    chain = [genesis]
    prev_hash = genesis["block_hash"]

    for day_idx in range(1, num_day_blocks + 1):
        date = f"2026-07-{day_idx:02d}"
        data = _make_entry_data(crypto, title=f"Task {day_idx}")
        entry_hash = _compute_entry_hash(data)
        entry = {"hash": entry_hash, "data": data}

        block = {
            "type": "day",
            "day_index": day_idx,
            "date": date,
            "prev_hash": prev_hash,
            "entries": [entry],
        }
        block["day_hash"] = _seal_day_block(block, crypto)
        chain.append(block)
        prev_hash = block["day_hash"]

    return chain


# ──────────────────────────────────────────────────────────────────────
# Tests
# ──────────────────────────────────────────────────────────────────────

class TestMigrateFormatHappyPath(unittest.TestCase):
    """Successful migrations with various chain sizes."""

    @classmethod
    def setUpClass(cls):
        cls.crypto = _MockCrypto()
        cls.identity_secret = b"test-identity-16b"

    def test_single_day_block_migration_succeeds(self):
        """M1: 1 genesis + 1 day block → migration succeeds, format_version → 0.4.0."""
        from phpoc_cli.migrate_format import MigrateFormatCommand

        chain = build_chain(self.crypto, self.identity_secret, num_day_blocks=1)
        tmpdir = Path(tempfile.mkdtemp())
        ledger_path = tmpdir / "ledger.json"
        ledger_path.write_text(json.dumps(chain, indent=2))

        migrator = MigrateFormatCommand(
            data_dir=tmpdir,
            seed=bytes(32),  # not used with mock crypto in this path
            identity_secret=self.identity_secret,
            ledger_path=ledger_path,
        )

        # Patch the crypto derivation to use our mock
        migrator._derive_crypto = lambda genesis: self.crypto

        result = migrator.execute(skip_prompt=True)
        self.assertTrue(result, "Migration should succeed")

        migrated = json.loads(ledger_path.read_text())
        self.assertEqual(migrated[0]["format_version"], "0.4.0")
        self.assertEqual(len(migrated), 2)
        self.assertIn("original_hash", migrated[1])
        self.assertIn("original_entry_hash", migrated[1]["entries"][0]["data"])

    def test_multiple_day_blocks_migration_succeeds(self):
        """M2: 1 genesis + 3 day blocks → all migrated, prev_hash chain intact."""
        from phpoc_cli.migrate_format import MigrateFormatCommand

        chain = build_chain(self.crypto, self.identity_secret, num_day_blocks=3)
        tmpdir = Path(tempfile.mkdtemp())
        ledger_path = tmpdir / "ledger.json"
        ledger_path.write_text(json.dumps(chain, indent=2))

        migrator = MigrateFormatCommand(
            data_dir=tmpdir,
            identity_secret=self.identity_secret,
            ledger_path=ledger_path,
        )
        migrator._derive_crypto = lambda genesis: self.crypto

        result = migrator.execute(skip_prompt=True)
        self.assertTrue(result, "Migration should succeed")

        migrated = json.loads(ledger_path.read_text())
        self.assertEqual(len(migrated), 4)
        self.assertEqual(migrated[0]["format_version"], "0.4.0")

        # Verify prev_hash chain
        for i in range(1, len(migrated)):
            prev_hash = migrated[i - 1].get("block_hash") or migrated[i - 1].get("day_hash")
            self.assertEqual(migrated[i]["prev_hash"], prev_hash,
                             f"Block {i} prev_hash should match block {i-1} hash")

    def test_genesis_only_chain_migrates(self):
        """M3: Genesis-only chain → migration succeeds, no entries to process."""
        from phpoc_cli.migrate_format import MigrateFormatCommand

        chain = build_chain(self.crypto, self.identity_secret, num_day_blocks=0)
        tmpdir = Path(tempfile.mkdtemp())
        ledger_path = tmpdir / "ledger.json"
        ledger_path.write_text(json.dumps(chain, indent=2))

        migrator = MigrateFormatCommand(
            data_dir=tmpdir,
            identity_secret=self.identity_secret,
            ledger_path=ledger_path,
        )
        migrator._derive_crypto = lambda genesis: self.crypto

        result = migrator.execute(skip_prompt=True)
        self.assertTrue(result, "Genesis-only migration should succeed")
        migrated = json.loads(ledger_path.read_text())
        self.assertEqual(migrated[0]["format_version"], "0.4.0")


class TestMigrateFormatProvenance(unittest.TestCase):
    """Provenance fields are correctly preserved."""

    @classmethod
    def setUpClass(cls):
        cls.crypto = _MockCrypto()
        cls.identity_secret = b"test-identity-16b"

    def test_original_hash_preserves_old_seal(self):
        """P1: original_hash contains the pre-migration day_hash value."""
        from phpoc_cli.migrate_format import MigrateFormatCommand

        chain = build_chain(self.crypto, self.identity_secret, num_day_blocks=1)
        old_day_hash = chain[1]["day_hash"]

        tmpdir = Path(tempfile.mkdtemp())
        ledger_path = tmpdir / "ledger.json"
        ledger_path.write_text(json.dumps(chain, indent=2))

        migrator = MigrateFormatCommand(
            data_dir=tmpdir,
            identity_secret=self.identity_secret,
            ledger_path=ledger_path,
        )
        migrator._derive_crypto = lambda genesis: self.crypto
        migrator.execute(skip_prompt=True)

        migrated = json.loads(ledger_path.read_text())
        self.assertEqual(migrated[1]["original_hash"], old_day_hash,
                         "original_hash must preserve pre-migration seal")
        self.assertNotEqual(migrated[1]["day_hash"], old_day_hash,
                            "new day_hash must differ from original")

    def test_original_entry_hash_preserved(self):
        """P2: original_entry_hash contains the pre-migration entry hash."""
        from phpoc_cli.migrate_format import MigrateFormatCommand

        chain = build_chain(self.crypto, self.identity_secret, num_day_blocks=1)
        old_entry_hash = chain[1]["entries"][0]["hash"]

        tmpdir = Path(tempfile.mkdtemp())
        ledger_path = tmpdir / "ledger.json"
        ledger_path.write_text(json.dumps(chain, indent=2))

        migrator = MigrateFormatCommand(
            data_dir=tmpdir,
            identity_secret=self.identity_secret,
            ledger_path=ledger_path,
        )
        migrator._derive_crypto = lambda genesis: self.crypto
        migrator.execute(skip_prompt=True)

        migrated = json.loads(ledger_path.read_text())
        new_entry = migrated[1]["entries"][0]
        self.assertEqual(new_entry["data"]["original_entry_hash"], old_entry_hash,
                         "original_entry_hash must preserve pre-migration entry hash")
        self.assertNotEqual(new_entry["hash"], old_entry_hash,
                            "new entry hash must differ from original")

    def test_original_fields_covered_by_content_hash(self):
        """P3: original_entry_hash is included in content_hash computation."""
        from phpoc_cli.migrate_format import MigrateFormatCommand

        chain = build_chain(self.crypto, self.identity_secret, num_day_blocks=1)

        tmpdir = Path(tempfile.mkdtemp())
        ledger_path = tmpdir / "ledger.json"
        ledger_path.write_text(json.dumps(chain, indent=2))

        migrator = MigrateFormatCommand(
            data_dir=tmpdir,
            identity_secret=self.identity_secret,
            ledger_path=ledger_path,
        )
        migrator._derive_crypto = lambda genesis: self.crypto
        migrator.execute(skip_prompt=True)

        migrated = json.loads(ledger_path.read_text())
        data = migrated[1]["entries"][0]["data"]

        # Recompute content_hash ourselves — must include original_entry_hash
        content = {}
        for key, value in data.items():
            if key == "content_hash":
                continue
            if key.endswith("_enc") and value is not None and value != "":
                try:
                    content[key[:-4]] = self.crypto.decrypt(value)
                except Exception:
                    content[key] = value
            elif isinstance(value, list):
                content[key] = sorted(value)
            else:
                content[key] = value

        computed = hashlib.sha256(
            json.dumps(content, sort_keys=True).encode()
        ).hexdigest()
        self.assertEqual(computed, data["content_hash"],
                         "content_hash must cover original_entry_hash")


class TestMigrateFormatFilePaths(unittest.TestCase):
    """--file and --output path modes."""

    @classmethod
    def setUpClass(cls):
        cls.crypto = _MockCrypto()
        cls.identity_secret = b"test-identity-16b"

    def test_file_mode_overwrites_in_place(self):
        """F1: --file without --output overwrites the input file."""
        from phpoc_cli.migrate_format import MigrateFormatCommand

        chain = build_chain(self.crypto, self.identity_secret, num_day_blocks=1)
        tmpdir = Path(tempfile.mkdtemp())
        input_path = tmpdir / "my_backup.json"
        input_path.write_text(json.dumps(chain, indent=2))

        migrator = MigrateFormatCommand(
            data_dir=tmpdir,
            identity_secret=self.identity_secret,
            ledger_path=input_path,
        )
        migrator._derive_crypto = lambda genesis: self.crypto
        migrator.execute(skip_prompt=True)

        migrated = json.loads(input_path.read_text())
        self.assertEqual(migrated[0]["format_version"], "0.4.0")

    def test_file_with_output_preserves_original(self):
        """F2: --file + --output writes to output, preserves input unchanged."""
        from phpoc_cli.migrate_format import MigrateFormatCommand

        chain = build_chain(self.crypto, self.identity_secret, num_day_blocks=1)
        tmpdir = Path(tempfile.mkdtemp())
        input_path = tmpdir / "old.json"
        output_path = tmpdir / "new.json"
        input_path.write_text(json.dumps(chain, indent=2))
        original_content = input_path.read_text()

        migrator = MigrateFormatCommand(
            data_dir=tmpdir,
            identity_secret=self.identity_secret,
            ledger_path=input_path,
            output_path=output_path,
        )
        migrator._derive_crypto = lambda genesis: self.crypto
        migrator.execute(skip_prompt=True)

        # Output exists and is migrated
        self.assertTrue(output_path.exists())
        migrated = json.loads(output_path.read_text())
        self.assertEqual(migrated[0]["format_version"], "0.4.0")

        # Input unchanged
        self.assertEqual(input_path.read_text(), original_content,
                         "Input file must be preserved when --output is used")


class TestMigrateFormatEdgeCases(unittest.TestCase):
    """Error handling and edge cases."""

    @classmethod
    def setUpClass(cls):
        cls.crypto = _MockCrypto()
        cls.identity_secret = b"test-identity-16b"

    def test_already_at_040_is_noop(self):
        """E1: format_version already ≥ 0.4.0 → no-op, returns True."""
        from phpoc_cli.migrate_format import MigrateFormatCommand

        chain = build_chain(self.crypto, self.identity_secret, num_day_blocks=1)
        chain[0]["format_version"] = "0.4.0"

        tmpdir = Path(tempfile.mkdtemp())
        ledger_path = tmpdir / "ledger.json"
        ledger_path.write_text(json.dumps(chain, indent=2))

        migrator = MigrateFormatCommand(
            data_dir=tmpdir,
            identity_secret=self.identity_secret,
            ledger_path=ledger_path,
        )
        migrator._derive_crypto = lambda genesis: self.crypto

        result = migrator.execute(skip_prompt=True)
        self.assertTrue(result, "Already-0.4.0 should return True (no-op)")
        # Verify no changes
        reloaded = json.loads(ledger_path.read_text())
        self.assertEqual(reloaded[0]["format_version"], "0.4.0")
        self.assertNotIn("original_hash", reloaded[1])

    def test_already_at_050_is_noop(self):
        """E2: format_version 0.5.0 → no-op."""
        from phpoc_cli.migrate_format import MigrateFormatCommand

        chain = build_chain(self.crypto, self.identity_secret, num_day_blocks=1)
        chain[0]["format_version"] = "0.5.0"

        tmpdir = Path(tempfile.mkdtemp())
        ledger_path = tmpdir / "ledger.json"
        ledger_path.write_text(json.dumps(chain, indent=2))

        migrator = MigrateFormatCommand(
            data_dir=tmpdir,
            identity_secret=self.identity_secret,
            ledger_path=ledger_path,
        )
        migrator._derive_crypto = lambda genesis: self.crypto

        result = migrator.execute(skip_prompt=True)
        self.assertTrue(result, "0.5.0 should be treated as ≥ 0.4.0")

    def test_empty_ledger_returns_false(self):
        """E3: Empty ledger file → returns False."""
        from phpoc_cli.migrate_format import MigrateFormatCommand

        tmpdir = Path(tempfile.mkdtemp())
        ledger_path = tmpdir / "ledger.json"
        ledger_path.write_text("[]")

        migrator = MigrateFormatCommand(
            data_dir=tmpdir,
            identity_secret=self.identity_secret,
            ledger_path=ledger_path,
        )
        migrator._derive_crypto = lambda genesis: self.crypto

        result = migrator.execute(skip_prompt=True)
        self.assertFalse(result, "Empty ledger must return False")

    def test_no_genesis_block_returns_false(self):
        """E4: First block is not genesis → returns False."""
        from phpoc_cli.migrate_format import MigrateFormatCommand

        tmpdir = Path(tempfile.mkdtemp())
        ledger_path = tmpdir / "ledger.json"
        ledger_path.write_text(json.dumps([{"type": "day", "day_index": 1}]))

        migrator = MigrateFormatCommand(
            data_dir=tmpdir,
            identity_secret=self.identity_secret,
            ledger_path=ledger_path,
        )
        migrator._derive_crypto = lambda genesis: self.crypto

        result = migrator.execute(skip_prompt=True)
        self.assertFalse(result, "Non-genesis first block must fail")

    def test_missing_ledger_file_returns_false(self):
        """E5: No ledger.json at path → returns False."""
        from phpoc_cli.migrate_format import MigrateFormatCommand

        tmpdir = Path(tempfile.mkdtemp())
        nonexistent = tmpdir / "nonexistent.json"

        migrator = MigrateFormatCommand(
            data_dir=tmpdir,
            identity_secret=self.identity_secret,
            ledger_path=nonexistent,
        )
        migrator._derive_crypto = lambda genesis: self.crypto

        result = migrator.execute(skip_prompt=True)
        self.assertFalse(result, "Missing file must return False")

    def test_mixed_block_types_migrate_successfully(self):
        """E6: Non-day blocks (month_summary) after day blocks migrate successfully
        — Phase 2 re-seals all block types so prev_hash linkage stays consistent."""
        from phpoc_cli.migrate_format import MigrateFormatCommand

        chain = build_chain(self.crypto, self.identity_secret, num_day_blocks=1)

        # Add a month_summary block after the day block (real shape per ADR-029a:
        # {type, month, prev_hash, date} — no fixture-only month_index/day_count)
        month_block = {
            "type": "month_summary",
            "month": "2026-07",
            "prev_hash": chain[1]["day_hash"],
            "date": "2026-07-31",
        }
        month_block["month_hash"] = self.crypto.seal(
            json.dumps(select_seal_fields(month_block), sort_keys=True)
        )
        chain.append(month_block)

        tmpdir = Path(tempfile.mkdtemp())
        ledger_path = tmpdir / "ledger.json"
        ledger_path.write_text(json.dumps(chain, indent=2))

        migrator = MigrateFormatCommand(
            data_dir=tmpdir,
            identity_secret=self.identity_secret,
            ledger_path=ledger_path,
        )
        migrator._derive_crypto = lambda genesis: self.crypto
        result = migrator.execute(skip_prompt=True)

        self.assertTrue(result, "Mixed chains migrate successfully with re-sealing")
        migrated = json.loads(ledger_path.read_text())
        self.assertEqual(migrated[0]["format_version"], "0.4.0")
        self.assertEqual(migrated[2]["type"], "month_summary")
        # Verify prev_hash chain is consistent including the month_summary block
        for i in range(1, len(migrated)):
            hk = "block_hash" if migrated[i-1]["type"] == "genesis" else (
                 "day_hash" if migrated[i-1]["type"] == "day" else (
                 "month_hash" if migrated[i-1]["type"] == "month_summary" else "year_hash"))
            self.assertEqual(migrated[i]["prev_hash"], migrated[i-1][hk],
                             f"Block {i} prev_hash must match block {i-1} {hk}")

    def test_multiple_entries_per_block(self):
        """E7: Blocks with multiple entries → all entries get migrated."""
        from phpoc_cli.migrate_format import MigrateFormatCommand

        chain = build_chain(self.crypto, self.identity_secret, num_day_blocks=1)

        # Add second entry to the day block
        data2 = _make_entry_data(self.crypto, title="Task 2", start="10:00", end="11:00")
        entry2_hash = _compute_entry_hash(data2)
        chain[1]["entries"].append({"hash": entry2_hash, "data": data2})
        # Re-seal
        chain[1]["day_hash"] = _seal_day_block(chain[1], self.crypto)

        tmpdir = Path(tempfile.mkdtemp())
        ledger_path = tmpdir / "ledger.json"
        ledger_path.write_text(json.dumps(chain, indent=2))

        migrator = MigrateFormatCommand(
            data_dir=tmpdir,
            identity_secret=self.identity_secret,
            ledger_path=ledger_path,
        )
        migrator._derive_crypto = lambda genesis: self.crypto
        migrator.execute(skip_prompt=True)

        migrated = json.loads(ledger_path.read_text())
        entries = migrated[1]["entries"]
        self.assertEqual(len(entries), 2)
        for entry in entries:
            self.assertIn("original_entry_hash", entry["data"])
            self.assertIn("content_hash", entry["data"])
            self.assertNotEqual(entry["data"]["content_hash"], "0" * 64,
                                "content_hash must be recomputed")

    def test_backup_created_on_success(self):
        """E8: A timestamped backup directory is created during migration."""
        from phpoc_cli.migrate_format import MigrateFormatCommand

        chain = build_chain(self.crypto, self.identity_secret, num_day_blocks=1)
        tmpdir = Path(tempfile.mkdtemp())
        ledger_path = tmpdir / "ledger.json"
        ledger_path.write_text(json.dumps(chain, indent=2))

        migrator = MigrateFormatCommand(
            data_dir=tmpdir,
            identity_secret=self.identity_secret,
            ledger_path=ledger_path,
        )
        migrator._derive_crypto = lambda genesis: self.crypto
        migrator.execute(skip_prompt=True)

        # Find backup directory
        backups = list(tmpdir.glob("backup_*"))
        self.assertGreater(len(backups), 0, "Backup directory must be created")
        backup_ledger = backups[0] / "ledger.json"
        self.assertTrue(backup_ledger.exists(), "Backup must contain ledger.json")


class TestMigrateFormatDecryptFailures(unittest.TestCase):
    """Pre-validation: migration fails when _enc fields can't be decrypted."""

    @classmethod
    def setUpClass(cls):
        cls.crypto = _MockCrypto()
        cls.identity_secret = b"test-identity-16b"

    def test_undecryptable_field_causes_pre_validation_failure(self):
        """D1: An entry with an undecryptable _enc field → pre-validation fails."""
        from phpoc_cli.migrate_format import MigrateFormatCommand

        chain = build_chain(self.crypto, self.identity_secret, num_day_blocks=1)

        # Corrupt an _enc field with a long-enough value (>40 chars) that decrypt() rejects
        chain[1]["entries"][0]["data"]["title_enc"] = "bad:" + ("x" * 60)

        tmpdir = Path(tempfile.mkdtemp())
        ledger_path = tmpdir / "ledger.json"
        ledger_path.write_text(json.dumps(chain, indent=2))

        migrator = MigrateFormatCommand(
            data_dir=tmpdir,
            identity_secret=self.identity_secret,
            ledger_path=ledger_path,
        )
        migrator._derive_crypto = lambda genesis: self.crypto

        result = migrator.execute(skip_prompt=True)
        self.assertFalse(result, "Migration must fail when _enc field cannot be decrypted")


if __name__ == "__main__":
    unittest.main()
