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


class TestMigrateFormatSealWhitelist(unittest.TestCase):
    """Canonical ADR-029/029a 6-field block-seal whitelist (bp CANONICAL_SEALFIELD_MIGRATOR_PHASE1.md).

    Groups A–F: the migration re-stamps every block seal over the closed per-type
    whitelist via `compute_seal`/`select_seal_fields`, and fails cleanly (no partial
    write) on an unknown/unsealable block type.
    """

    @classmethod
    def setUpClass(cls):
        cls.crypto = _MockCrypto()
        cls.identity_secret = b"test-identity-16b"

    # ── helpers ───────────────────────────────────────────────────

    def _migrate_to(self, chain, name="ledger.json"):
        """Write `chain`, run a full migration in a temp dir, return (MigrateFormatCommand, ledger path, migrated list)."""
        from phpoc_cli.migrate_format import MigrateFormatCommand
        tmpdir = Path(tempfile.mkdtemp())
        lp = tmpdir / name
        lp.write_text(json.dumps(chain, indent=2))
        migrator = MigrateFormatCommand(
            data_dir=tmpdir, identity_secret=self.identity_secret, ledger_path=lp)
        migrator._derive_crypto = lambda genesis: self.crypto
        result = migrator.execute(skip_prompt=True)
        return migrator, lp, json.loads(lp.read_text())

    def _verify(self, migrated_blocks, path):
        from domain.ledger.chain import LedgerChain
        from storage.implementations.file_ledger import FileLedgerStore
        path.write_text(json.dumps(migrated_blocks, indent=2))
        ch = LedgerChain(self.crypto, FileLedgerStore(path),
                         identity_secret=self.identity_secret)
        return ch.verify()

    def _run(self, chain, name="ledger.json"):
        from phpoc_cli.migrate_format import MigrateFormatCommand
        tmpdir = Path(tempfile.mkdtemp())
        lp = tmpdir / name
        lp.write_text(json.dumps(chain, indent=2))
        migrator = MigrateFormatCommand(
            data_dir=tmpdir, identity_secret=self.identity_secret, ledger_path=lp)
        migrator._derive_crypto = lambda genesis: self.crypto
        return migrator, lp

    # ── Group A: day-block seal-input whitelist ──────────────────

    def test_A1_day_hash_equals_compute_seal_whitelist(self):
        """A1: migrated day day_hash == HMAC over select_seal_fields sorted-JSON."""
        from domain.ledger.chain import compute_seal
        chain = build_chain(self.crypto, self.identity_secret, num_day_blocks=1)
        _, _, migrated = self._migrate_to(chain)
        block = migrated[1]
        self.assertEqual(block["day_hash"], compute_seal(self.crypto, block),
                         "day_hash must be the canonical whitelist seal")

    def test_A2_day_seal_unchanged_by_excluded_fields(self):
        """A2: adding/mutating format_version/key_version/signature does not change day_hash."""
        from domain.ledger.chain import compute_seal
        chain = build_chain(self.crypto, self.identity_secret, num_day_blocks=1)
        _, _, migrated = self._migrate_to(chain)
        block = dict(migrated[1])
        base = compute_seal(self.crypto, block)
        for excluded in ("format_version", "key_version", "signature"):
            b = dict(block)
            b[excluded] = "tampered" if excluded != "key_version" else 99
            self.assertEqual(compute_seal(self.crypto, b), base,
                             f"excluded field {excluded!r} must not alter the day seal")

    def test_A3_day_seal_input_exact_six_fields(self):
        """A3: select_seal_fields on a migrated day == {type,day_index,date,prev_hash,entries,original_hash}."""
        from domain.ledger.chain import select_seal_fields
        chain = build_chain(self.crypto, self.identity_secret, num_day_blocks=1)
        _, _, migrated = self._migrate_to(chain)
        keys = set(select_seal_fields(migrated[1]).keys())
        self.assertEqual(keys, {"type", "day_index", "date", "prev_hash", "entries", "original_hash"})

    def test_A4_original_hash_present_and_sealed(self):
        """A4: migrated day original_hash is present AND covered by the seal input."""
        from domain.ledger.chain import select_seal_fields
        chain = build_chain(self.crypto, self.identity_secret, num_day_blocks=1)
        old_hash = chain[1]["day_hash"]
        _, _, migrated = self._migrate_to(chain)
        block = migrated[1]
        self.assertEqual(block["original_hash"], old_hash)
        self.assertIn("original_hash", select_seal_fields(block))

    def test_A5_day_without_original_hash_still_seals(self):
        """A5: a day block with no original_hash (legacy/new) still seals via the whitelist."""
        from domain.ledger.chain import compute_seal, select_seal_fields
        block = {
            "type": "day", "day_index": 3, "date": "2026-07-03",
            "prev_hash": "p" * 64, "entries": [{"hash": "h" * 64, "data": {}}],
        }
        # no original_hash present
        self.assertNotIn("original_hash", select_seal_fields(block))
        self.assertEqual(compute_seal(self.crypto, block),
                         self.crypto.seal(json.dumps(select_seal_fields(block), sort_keys=True)))

    def test_A6_original_entry_hash_not_sealed(self):
        """A6: original_entry_hash (entry provenance) does NOT enter the block seal."""
        from domain.ledger.chain import select_seal_fields
        chain = build_chain(self.crypto, self.identity_secret, num_day_blocks=1)
        _, _, migrated = self._migrate_to(chain)
        self.assertIn("original_entry_hash", migrated[1]["entries"][0]["data"])
        self.assertNotIn("original_entry_hash", select_seal_fields(migrated[1]))

    def test_A7_all_day_blocks_re_seal_under_whitelist(self):
        """A7: every migrated day block in a multi-day chain matches compute_seal."""
        from domain.ledger.chain import compute_seal
        chain = build_chain(self.crypto, self.identity_secret, num_day_blocks=3)
        _, _, migrated = self._migrate_to(chain)
        day_idxs = [i for i, b in enumerate(migrated) if b["type"] == "day"]
        self.assertEqual(len(day_idxs), 3)
        for i in day_idxs:
            self.assertEqual(migrated[i]["day_hash"], compute_seal(self.crypto, migrated[i]),
                             f"day block {i} must be whitelist-sealed")

    # ── Group B: genesis seal-input whitelist ────────────────────

    def test_B1_genesis_hash_equals_compute_seal_whitelist(self):
        """B1: migrated genesis block_hash == HMAC over select_seal_fields."""
        from domain.ledger.chain import compute_seal, select_seal_fields
        chain = build_chain(self.crypto, self.identity_secret, num_day_blocks=1)
        _, _, migrated = self._migrate_to(chain)
        genesis = migrated[0]
        self.assertEqual(genesis["type"], "genesis")
        self.assertEqual(genesis["block_hash"], compute_seal(self.crypto, genesis))
        # identity / format_version / key_version excluded from the seal input
        sel = select_seal_fields(genesis)
        self.assertNotIn("identity", sel)
        self.assertNotIn("format_version", sel)
        self.assertNotIn("key_version", sel)
        self.assertNotIn("identity_seal", sel)

    def test_B2_genesis_seal_excludes_identity(self):
        """B2: genesis identity object stays out of the seal (cross-client parity)."""
        from domain.ledger.chain import compute_seal, select_seal_fields
        chain = build_chain(self.crypto, self.identity_secret, num_day_blocks=1)
        _, _, migrated = self._migrate_to(chain)
        genesis = migrated[0]
        self.assertIn("identity", genesis)
        self.assertNotIn("identity", select_seal_fields(genesis))
        mutated = dict(genesis); mutated["identity"] = {"identity_secret_enc_fallback": "changed"}
        self.assertEqual(compute_seal(self.crypto, genesis), compute_seal(self.crypto, mutated),
                         "mutating identity must not change genesis block_hash")

    def test_B3_genesis_seal_excludes_format_and_key_version(self):
        """B3: format_version/key_version never affect the genesis seal."""
        from domain.ledger.chain import compute_seal
        chain = build_chain(self.crypto, self.identity_secret, num_day_blocks=1)
        _, _, migrated = self._migrate_to(chain)
        genesis = migrated[0]
        base = compute_seal(self.crypto, genesis)
        for fv in ("4.0.0", "0.3.5"):
            g = dict(genesis); g["format_version"] = fv
            self.assertEqual(compute_seal(self.crypto, g), base, f"format_version {fv} must not change genesis seal")
        g = dict(genesis); g["key_version"] = 42
        self.assertEqual(compute_seal(self.crypto, g), base, "key_version must not change genesis seal")

    def test_B4_genesis_original_hash_preserved_and_sealed(self):
        """B4: genesis original_hash == pre-migration block_hash and is in the seal input."""
        from domain.ledger.chain import select_seal_fields
        chain = build_chain(self.crypto, self.identity_secret, num_day_blocks=1)
        old_block_hash = chain[0]["block_hash"]
        _, _, migrated = self._migrate_to(chain)
        genesis = migrated[0]
        self.assertEqual(genesis["original_hash"], old_block_hash)
        self.assertIn("original_hash", select_seal_fields(genesis))
        self.assertNotEqual(genesis["block_hash"], old_block_hash,
                            "new block_hash must differ (format_version change is not sealed, but seed/identity fields present differ)")

    def test_B5_genesis_identity_seal_does_not_affect_block_hash(self):
        """B5: identity_seal is a separate MAC layer — not part of block_hash."""
        from domain.ledger.chain import compute_seal
        chain = build_chain(self.crypto, self.identity_secret, num_day_blocks=1)
        _, _, migrated = self._migrate_to(chain)
        genesis = migrated[0]
        base = compute_seal(self.crypto, genesis)
        if computed := genesis.get("identity_seal"):
            g = dict(genesis); g["identity_seal"] = "f" * 64
            self.assertEqual(compute_seal(self.crypto, g), base,
                             "identity_seal must not be part of the genesis block seal")

    # ── Group C: summary-block seal-input whitelist ───────────────

    def _with_month_and_year(self, base_chain):
        """Append a month_summary and year_summary to a base chain before migration."""
        last = base_chain[-1]
        last_key = "block_hash" if last["type"] == "genesis" else \
            ("day_hash" if last["type"] == "day" else "month_hash")
        month = {"type": "month_summary", "month": "2026-07",
                 "prev_hash": last.get(last_key), "date": "2026-07-31",
                 # stray legacy fixture field that must NOT be sealed (regression guard)
                 "day_count": 31}
        month["month_hash"] = self.crypto.seal(
            json.dumps(select_seal_fields(month), sort_keys=True))
        year = {"type": "year_summary", "year": 2026,
                "prev_hash": month["month_hash"], "date": "2026-12-31"}
        year["year_hash"] = self.crypto.seal(
            json.dumps(select_seal_fields(year), sort_keys=True))
        base_chain.append(month)
        base_chain.append(year)
        return base_chain

    def test_C1_month_summary_hash_equals_compute_seal(self):
        """C1: migrated month_hash == compute_seal over {type,month,date,prev_hash,original_hash}."""
        from domain.ledger.chain import compute_seal, select_seal_fields
        chain = self._with_month_and_year(build_chain(self.crypto, self.identity_secret, num_day_blocks=1))
        _, _, migrated = self._migrate_to(chain)
        month = next(b for b in migrated if b["type"] == "month_summary")
        self.assertEqual(month["month_hash"], compute_seal(self.crypto, month))
        self.assertEqual(set(select_seal_fields(month).keys()),
                         {"type", "month", "date", "prev_hash", "original_hash"})

    def test_C2_year_summary_hash_equals_compute_seal(self):
        """C2: migrated year_hash == compute_seal over {type,year,date,prev_hash,original_hash}."""
        from domain.ledger.chain import compute_seal, select_seal_fields
        chain = self._with_month_and_year(build_chain(self.crypto, self.identity_secret, num_day_blocks=1))
        _, _, migrated = self._migrate_to(chain)
        year = next(b for b in migrated if b["type"] == "year_summary")
        self.assertEqual(year["year_hash"], compute_seal(self.crypto, year))
        self.assertEqual(set(select_seal_fields(year).keys()),
                         {"type", "year", "date", "prev_hash", "original_hash"})

    def test_C3_summary_seal_unchanged_by_stray_fixture_field(self):
        """C3: adding a stray fixture field (day_count / stray_metadata) does not change the summary seal."""
        from domain.ledger.chain import compute_seal
        chain = self._with_month_and_year(build_chain(self.crypto, self.identity_secret, num_day_blocks=1))
        _, _, migrated = self._migrate_to(chain)
        month = next(b for b in migrated if b["type"] == "month_summary")
        base = compute_seal(self.crypto, month)
        m = dict(month); m["day_count"] = 31; m["stray_metadata"] = "x"
        self.assertEqual(compute_seal(self.crypto, m), base,
                         "stray/non-whitelisted fields must not alter the summary seal")

    def test_C4_summary_prev_hash_sealed_and_updated(self):
        """C4: summary prev_hash is sealed and points to the previous block's new hash."""
        from domain.ledger.chain import select_seal_fields
        chain = self._with_month_and_year(build_chain(self.crypto, self.identity_secret, num_day_blocks=1))
        _, _, migrated = self._migrate_to(chain)
        month = next(b for b in migrated if b["type"] == "month_summary")
        day = next((b for b in migrated if b["type"] == "day"), None)
        self.assertIn("prev_hash", select_seal_fields(month))
        self.assertEqual(month["prev_hash"], day["day_hash"],
                         "month prev_hash must point to the new day_hash")

    # ── Group D: end-to-end acceptance + closed-set guard ────────

    def test_D1_verify_passes_on_migrated_multi_type(self):
        """D1: chain.verify() returns True on a migrated multi-type ledger."""
        chain = self._with_month_and_year(build_chain(self.crypto, self.identity_secret, num_day_blocks=2))
        _, lp, migrated = self._migrate_to(chain)
        self.assertTrue(self._verify(migrated, lp),
                        "migrated multi-type ledger must verify (the 0/129 fix)")

    def test_D2_tampered_seal_fails_verify(self):
        """D2: tampering a migrated block seal makes chain.verify() return False."""
        chain = build_chain(self.crypto, self.identity_secret, num_day_blocks=1)
        _, lp, migrated = self._migrate_to(chain)
        migrated[1]["day_hash"] = "f" * 64
        self.assertFalse(self._verify(migrated, lp),
                         "tampered day seal must fail verification")

    def test_D3_seal_unchanged_under_excluded_field_mutation(self):
        """D3: compute_seal is unchanged when excluded fields are added/mutated (seal-level)."""
        from domain.ledger.chain import compute_seal
        chain = build_chain(self.crypto, self.identity_secret, num_day_blocks=1)
        _, _, migrated = self._migrate_to(chain)
        day_base = compute_seal(self.crypto, migrated[1])
        d = dict(migrated[1]); d["format_version"] = "9.9.9"; d["key_version"] = 99
        self.assertEqual(compute_seal(self.crypto, d), day_base)
        g_base = compute_seal(self.crypto, migrated[0])
        g = dict(migrated[0]); g["format_version"] = "9.9.9"
        self.assertEqual(compute_seal(self.crypto, g), g_base)

    def test_D4_excluded_field_only_change_still_verifies(self):
        """D4: changing only a present excluded field (genesis format_version/key_version) still verifies True."""
        chain = build_chain(self.crypto, self.identity_secret, num_day_blocks=1)
        _, lp, migrated = self._migrate_to(chain)
        migrated[0]["format_version"] = "9.9.9"
        migrated[0]["key_version"] = 99
        self.assertTrue(self._verify(migrated, lp),
                        "mutating a non-sealed excluded field must not invalidate the chain")

    # ── Group E: _seal_block / _block_hash_key helper contract ───

    def test_E1_seal_block_routes_through_compute_seal(self):
        """E1: _seal_block == manual compute_seal over the whitelist."""
        from phpoc_cli.migrate_format import MigrateFormatCommand
        from domain.ledger.chain import compute_seal
        chain = build_chain(self.crypto, self.identity_secret, num_day_blocks=1)
        migrator, _ = self._run(chain)
        block = {"type": "day", "day_index": 9, "date": "2026-07-09",
                 "prev_hash": "p" * 64, "entries": [], "original_hash": "o" * 64}
        self.assertEqual(migrator._seal_block(block, self.crypto),
                         compute_seal(self.crypto, block))

    def test_E2_seal_block_unknown_type_raises(self):
        """E2: _seal_block(unknown_type) raises ValueError."""
        chain = build_chain(self.crypto, self.identity_secret, num_day_blocks=1)
        migrator, _ = self._run(chain)
        with self.assertRaises(ValueError):
            migrator._seal_block({"type": "oddball"}, self.crypto)

    def test_E3_block_hash_key_mapping(self):
        """E3: _block_hash_key maps genesis/day/month/year → canonical hash-key field."""
        chain = build_chain(self.crypto, self.identity_secret, num_day_blocks=1)
        migrator, _ = self._run(chain)
        cases = [("genesis", "block_hash"), ("day", "day_hash"),
                 ("month_summary", "month_hash"), ("year_summary", "year_hash")]
        for t, hk in cases:
            self.assertEqual(migrator._block_hash_key({"type": t}), hk)

    def test_E4_block_hash_key_unknown_returns_none(self):
        """E4: _block_hash_key(unknown_type) returns None."""
        chain = build_chain(self.crypto, self.identity_secret, num_day_blocks=1)
        migrator, _ = self._run(chain)
        self.assertIsNone(migrator._block_hash_key({"type": "oddball"}))

    # ── Group F: unknown/unsealable block-type safety ────────────

    def test_F1_unknown_block_type_does_not_corrupt_input(self):
        """F1: a ledger with an unknown block type must not leave a partially-migrated input file."""
        chain = build_chain(self.crypto, self.identity_secret, num_day_blocks=1)
        chain.append({"type": "oddball", "some_field": "x", "prev_hash": chain[1]["day_hash"]})
        migrator, lp = self._run(chain)
        original_bytes = lp.read_bytes()
        with self.assertRaises(ValueError):
            migrator.execute(skip_prompt=True)
        self.assertEqual(lp.read_bytes(), original_bytes,
                         "the input ledger must NOT be overwritten by a failed migration")

    def test_F2_failed_migration_is_noop_on_ledger(self):
        """F2: failed migration leaves the ledger file byte-identical (atomic, D5/D9)."""
        chain = build_chain(self.crypto, self.identity_secret, num_day_blocks=1)
        chain.append({"type": "oddball", "some_field": "x", "prev_hash": chain[1]["day_hash"]})
        migrator, lp = self._run(chain)
        original_bytes = lp.read_bytes()
        with self.assertRaises(ValueError):
            migrator.execute(skip_prompt=True)
        reloaded = json.loads(lp.read_bytes())
        # not bumped, not partially migrated
        self.assertEqual(lp.read_bytes(), original_bytes)
        self.assertEqual(reloaded[0].get("format_version"), "0.2.0")
        self.assertIn("oddball", [b["type"] for b in reloaded])


if __name__ == "__main__":
    unittest.main()
