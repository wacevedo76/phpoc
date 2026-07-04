"""Tests for the recovery → verify sequence.

Verifies that after a password recovery (genesis re-seal + re-chaining),
the full ledger chain verifies correctly.
"""
import unittest
import json
import time
import os
import shutil
import tempfile
import hashlib
import base64
from pathlib import Path
from core.ledger import LedgerDomain
from security.crypto import CryptoManager
from security.recovery import RecoveryManager
from storage.file_store import LedgerStore
from core.factory import LedgerFactory


def calendar_to_epoch(year, month, day, hour, minute):
    import datetime
    dt = datetime.datetime(year, month, day, hour, minute, tzinfo=datetime.timezone.utc)
    return int(dt.timestamp() * 1000)


class TestRecoveryVerifySequence(unittest.TestCase):
    """Full integration test: init → add entries → sync → recover → verify."""

    def setUp(self):
        base_dir = "/dev/shm" if os.path.exists("/dev/shm") else None
        self.test_dir = Path(tempfile.mkdtemp(dir=base_dir))
        self.ledger_file = self.test_dir / "ledger.json"
        self.staging_file = self.test_dir / "staging.json"
        self.index_file = self.test_dir / "index.json"
        self.identity_file = self.test_dir / "identity.json"

        # PDK for initialization
        self.initial_pass = "initial-pass"
        self.initial_pdk = hashlib.pbkdf2_hmac(
            'sha256', self.initial_pass.encode(), b"session-salt", 100, 32
        )

        # Identity secret
        self.identity_secret = os.urandom(32)

        # Init ledger
        self.seed = LedgerFactory.initialize(
            self.ledger_file,
            self.initial_pdk,
            "testuser",
            "test@example.com",
            identity_secret=self.identity_secret,
        )
        self.assertIsNotNone(self.seed)

        # Derive MK
        mk = RecoveryManager.seed_to_key(self.seed)
        self.crypto = CryptoManager(mk)

        self.store = LedgerStore(
            self.staging_file, self.ledger_file, self.index_file
        )
        self.ledger = LedgerDomain(self.crypto, self.store)

    def tearDown(self):
        shutil.rmtree(self.test_dir)

    def _sync_entry(self, title, year, month, day, hour, minute, duration_ms):
        """Helper: add a completed entry on a specific date and sync it."""
        start = calendar_to_epoch(year, month, day, hour, minute)
        stop = start + duration_ms
        self.ledger.capture_habit(title, start, stop)
        self.ledger.sync_day()

    # ------------------------------------------------------------------
    # Test 1: Recovery with re-chaining on a single-block ledger
    # ------------------------------------------------------------------
    def test_recovery_rechains_single_block_chain(self):
        """Recovery must re-chain block 1's prev_hash to genesis's new day_hash."""
        # Add one day of entries
        self._sync_entry("Test Activity", 2026, 4, 23, 10, 0, 3600000)

        # Verify before recovery
        self.assertTrue(self.ledger.verify(),
                        "Chain must verify before recovery")

        # --- Simulate recovery flow (matching main.py recover) ---
        new_pass = "new-passphrase"
        new_pdk = hashlib.pbkdf2_hmac(
            'sha256', new_pass.encode(), b"session-salt", 100, 32
        )

        ledger_data = json.loads(self.ledger_file.read_text())
        seed_str = base64.b64encode(RecoveryManager.seed_to_key(self.seed)).decode('utf-8')
        new_enc_seed = RecoveryManager.encrypt_seed(seed_str, new_pdk)

        # Update genesis identity
        ledger_data[0]["identity"]["recovery_seed_enc"] = new_enc_seed

        # Embed identity secret fallback
        identity_data = json.loads(self.identity_file.read_text())
        ledger_data[0]["identity"]["identity_secret_enc_fallback"] = \
            identity_data["identity_secret_enc"]

        # Re-seal genesis (excluding signature, matching verify())
        check_data = {
            k: v for k, v in ledger_data[0].items()
            if k not in ("day_hash", "signature", "format_version")
        }
        genesis_hk = "block_hash" if "block_hash" in ledger_data[0] else "day_hash"
        ledger_data[0][genesis_hk] = self.crypto.seal(
            json.dumps(check_data, sort_keys=True)
        )

        # Re-sign genesis
        ledger_data[0]["signature"] = self.crypto.sign(
            ledger_data[0][genesis_hk], self.identity_secret
        )

        # --- RE-CHAIN all subsequent blocks ---
        for i in range(1, len(ledger_data)):
            block = ledger_data[i]
            prev = ledger_data[i - 1]
            block["prev_hash"] = (
                prev.get("block_hash") or prev.get("day_hash")
                or prev.get("month_hash")
                or prev.get("year_hash")
            )
            hash_key = (
                "day_hash"
                if block.get("type", "day") == "day"
                else "month_hash"
                if block.get("type") == "month_summary"
                else "year_hash"
            )
            seal_data = {
                k: v for k, v in block.items()
                if k not in (hash_key, "signature", "format_version")
            }
            block[hash_key] = self.crypto.seal(
                json.dumps(seal_data, sort_keys=True)
            )
            if block.get("signature") is not None:
                block["signature"] = self.crypto.sign(
                    block[hash_key], self.identity_secret
                )

        # Write updated ledger
        self.ledger_file.write_text(json.dumps(ledger_data, indent=2))

        # Verify after recovery — should pass now
        self.assertTrue(self.ledger.verify(),
                        "Chain must verify after recovery with re-chaining")

    # ------------------------------------------------------------------
    # Test 2: Recovery with re-chaining on a multi-block ledger
    # (multiple days, month transition)
    # ------------------------------------------------------------------
    def test_recovery_rechains_multi_block_chain(self):
        """Recovery must re-chain many blocks across multiple days."""
        # Add entries across multiple days
        self._sync_entry("Coding", 2026, 4, 23, 10, 0, 3600000)
        self._sync_entry("Music", 2026, 4, 24, 14, 30, 1800000)
        self._sync_entry("Reading", 2026, 4, 25, 9, 0, 2700000)

        # Verify before recovery
        self.assertTrue(self.ledger.verify(),
                        "Chain must verify before recovery")

        # --- Simulate recovery flow ---
        new_pass = "new-passphrase-v2"
        new_pdk = hashlib.pbkdf2_hmac(
            'sha256', new_pass.encode(), b"session-salt", 100, 32
        )

        ledger_data = json.loads(self.ledger_file.read_text())
        seed_str = base64.b64encode(RecoveryManager.seed_to_key(self.seed)).decode('utf-8')
        new_enc_seed = RecoveryManager.encrypt_seed(seed_str, new_pdk)

        ledger_data[0]["identity"]["recovery_seed_enc"] = new_enc_seed
        identity_data = json.loads(self.identity_file.read_text())
        ledger_data[0]["identity"]["identity_secret_enc_fallback"] = \
            identity_data["identity_secret_enc"]

        # Re-seal genesis
        check_data = {
            k: v for k, v in ledger_data[0].items()
            if k not in ("day_hash", "signature", "format_version")
        }
        genesis_hk = "block_hash" if "block_hash" in ledger_data[0] else "day_hash"
        ledger_data[0][genesis_hk] = self.crypto.seal(
            json.dumps(check_data, sort_keys=True)
        )
        ledger_data[0]["signature"] = self.crypto.sign(
            ledger_data[0][genesis_hk], self.identity_secret
        )

        # Re-chain ALL subsequent blocks
        for i in range(1, len(ledger_data)):
            block = ledger_data[i]
            prev = ledger_data[i - 1]
            block["prev_hash"] = (
                prev.get("block_hash") or prev.get("day_hash")
                or prev.get("month_hash")
                or prev.get("year_hash")
            )
            hash_key = (
                "day_hash"
                if block.get("type", "day") == "day"
                else "month_hash"
                if block.get("type") == "month_summary"
                else "year_hash"
            )
            seal_data = {
                k: v for k, v in block.items()
                if k not in (hash_key, "signature", "format_version")
            }
            block[hash_key] = self.crypto.seal(
                json.dumps(seal_data, sort_keys=True)
            )
            if block.get("signature") is not None:
                block["signature"] = self.crypto.sign(
                    block[hash_key], self.identity_secret
                )

        self.ledger_file.write_text(json.dumps(ledger_data, indent=2))

        # Verify after recovery
        self.assertTrue(self.ledger.verify(),
                        "Multi-block chain must verify after recovery with re-chaining")

    # ------------------------------------------------------------------
    # Test 3: Recovery WITHOUT re-chaining (verifies it fails)
    # ------------------------------------------------------------------
    def test_recovery_without_rechain_fails(self):
        """Recovery without re-chaining must fail verification."""
        self._sync_entry("Coding", 2026, 4, 23, 10, 0, 3600000)

        self.assertTrue(self.ledger.verify(),
                        "Chain must verify before recovery")

        # Simulate OLD recovery flow (no re-chaining)
        new_pass = "new-pass-old-bug"
        new_pdk = hashlib.pbkdf2_hmac(
            'sha256', new_pass.encode(), b"session-salt", 100, 32
        )

        ledger_data = json.loads(self.ledger_file.read_text())
        seed_str = base64.b64encode(RecoveryManager.seed_to_key(self.seed)).decode('utf-8')
        new_enc_seed = RecoveryManager.encrypt_seed(seed_str, new_pdk)
        ledger_data[0]["identity"]["recovery_seed_enc"] = new_enc_seed
        identity_data = json.loads(self.identity_file.read_text())
        ledger_data[0]["identity"]["identity_secret_enc_fallback"] = \
            identity_data["identity_secret_enc"]

        # Old buggy seal: includes 'signature' in check_data
        check_data = {k: v for k, v in ledger_data[0].items() if k not in ("day_hash", "block_hash")}
        genesis_hk = "block_hash" if "block_hash" in ledger_data[0] else "day_hash"
        ledger_data[0][genesis_hk] = self.crypto.seal(
            json.dumps(check_data, sort_keys=True)
        )
        # Note: NO re-chaining of subsequent blocks

        self.ledger_file.write_text(json.dumps(ledger_data, indent=2))

        # Must fail — block 1's prev_hash still points to old genesis day_hash
        self.assertFalse(self.ledger.verify(),
                         "Chain must fail verify after recovery without re-chaining")

    # ------------------------------------------------------------------
    # Test 4: Recovery with month_summary blocks
    # ------------------------------------------------------------------
    def test_recovery_across_month_boundary(self):
        """Recovery re-chaining must handle month_summary blocks."""
        # Entry in Jan
        jan_time = calendar_to_epoch(2025, 1, 15, 10, 0)
        self.ledger.capture_habit("Jan Task", jan_time, jan_time + 3600000)
        self.ledger.sync_day()

        # Entry in Feb → triggers month_summary
        feb_time = calendar_to_epoch(2025, 2, 10, 10, 0)
        self.ledger.capture_habit("Feb Task", feb_time, feb_time + 1800000)
        self.ledger.sync_day()

        # Verify before
        self.assertTrue(self.ledger.verify(),
                        "Chain must verify before recovery")

        # --- Recovery with re-chaining ---
        new_pass = "new-pass-month-boundary"
        new_pdk = hashlib.pbkdf2_hmac(
            'sha256', new_pass.encode(), b"session-salt", 100, 32
        )

        ledger_data = json.loads(self.ledger_file.read_text())
        seed_str = base64.b64encode(RecoveryManager.seed_to_key(self.seed)).decode('utf-8')
        new_enc_seed = RecoveryManager.encrypt_seed(seed_str, new_pdk)
        ledger_data[0]["identity"]["recovery_seed_enc"] = new_enc_seed
        identity_data = json.loads(self.identity_file.read_text())
        ledger_data[0]["identity"]["identity_secret_enc_fallback"] = \
            identity_data["identity_secret_enc"]

        check_data = {
            k: v for k, v in ledger_data[0].items()
            if k not in ("day_hash", "signature", "format_version")
        }
        genesis_hk = "block_hash" if "block_hash" in ledger_data[0] else "day_hash"
        ledger_data[0][genesis_hk] = self.crypto.seal(
            json.dumps(check_data, sort_keys=True)
        )
        ledger_data[0]["signature"] = self.crypto.sign(
            ledger_data[0][genesis_hk], self.identity_secret
        )

        # Re-chain all blocks (including month_summary)
        for i in range(1, len(ledger_data)):
            block = ledger_data[i]
            prev = ledger_data[i - 1]
            block["prev_hash"] = (
                prev.get("block_hash") or prev.get("day_hash")
                or prev.get("month_hash")
                or prev.get("year_hash")
            )
            hash_key = (
                "day_hash"
                if block.get("type", "day") == "day"
                else "month_hash"
                if block.get("type") == "month_summary"
                else "year_hash"
            )
            seal_data = {
                k: v for k, v in block.items()
                if k not in (hash_key, "signature", "format_version")
            }
            block[hash_key] = self.crypto.seal(
                json.dumps(seal_data, sort_keys=True)
            )
            if block.get("signature") is not None:
                block["signature"] = self.crypto.sign(
                    block[hash_key], self.identity_secret
                )

        self.ledger_file.write_text(json.dumps(ledger_data, indent=2))

        # Verify after recovery
        self.assertTrue(self.ledger.verify(),
                        "Chain with month_summary must verify after recovery")

    # ------------------------------------------------------------------
    # Test 5: New passphrase can decrypt the recovery seed after recovery
    # ------------------------------------------------------------------
    def test_new_passphrase_works_after_recovery(self):
        """After recovery with re-chaining, the new passphrase must unlock the seed."""
        self._sync_entry("Test", 2026, 4, 23, 10, 0, 3600000)

        new_pass = "new-pass-final"
        new_pdk = hashlib.pbkdf2_hmac(
            'sha256', new_pass.encode(), b"session-salt", 100, 32
        )

        ledger_data = json.loads(self.ledger_file.read_text())
        seed_str = base64.b64encode(RecoveryManager.seed_to_key(self.seed)).decode('utf-8')
        new_enc_seed = RecoveryManager.encrypt_seed(seed_str, new_pdk)
        ledger_data[0]["identity"]["recovery_seed_enc"] = new_enc_seed
        identity_data = json.loads(self.identity_file.read_text())
        ledger_data[0]["identity"]["identity_secret_enc_fallback"] = \
            identity_data["identity_secret_enc"]

        # I-17: genesis uses block_hash (not day_hash).
        # I-07: format_version excluded from seal data.
        genesis_hash_key = "block_hash" if "block_hash" in ledger_data[0] else "day_hash"
        check_data = {
            k: v for k, v in ledger_data[0].items()
            if k not in (genesis_hash_key, "signature", "format_version")
        }
        ledger_data[0][genesis_hash_key] = self.crypto.seal(
            json.dumps(check_data, sort_keys=True)
        )
        ledger_data[0]["signature"] = self.crypto.sign(
            ledger_data[0][genesis_hash_key], self.identity_secret
        )

        for i in range(1, len(ledger_data)):
            block = ledger_data[i]
            prev = ledger_data[i - 1]
            block["prev_hash"] = (
                prev.get("block_hash") or prev.get("day_hash")
                or prev.get("month_hash")
                or prev.get("year_hash")
            )
            hash_key = (
                "block_hash"
                if block.get("type") == "genesis" and "block_hash" in block
                else "day_hash"
                if block.get("type", "day") == "day"
                else "month_hash"
                if block.get("type") == "month_summary"
                else "year_hash"
            )
            seal_data = {
                k: v for k, v in block.items()
                if k not in (hash_key, "signature", "format_version")
            }
            block[hash_key] = self.crypto.seal(
                json.dumps(seal_data, sort_keys=True)
            )
            if block.get("signature") is not None:
                block["signature"] = self.crypto.sign(
                    block[hash_key], self.identity_secret
                )

        self.ledger_file.write_text(json.dumps(ledger_data, indent=2))

        # Verify chain
        self.assertTrue(self.ledger.verify(),
                        "Chain must verify after full recovery")

        # Verify old passphrase can NO longer decrypt the seed
        old_pdk = self.initial_pdk
        with self.assertRaises(Exception):
            RecoveryManager.decrypt_seed(
                ledger_data[0]["identity"]["recovery_seed_enc"], old_pdk
            )

        # Verify NEW passphrase CAN decrypt the seed
        decrypted = RecoveryManager.decrypt_seed(
            ledger_data[0]["identity"]["recovery_seed_enc"], new_pdk
        )
        self.assertEqual(decrypted, self.seed,
                         "New passphrase must decrypt the recovery seed")


if __name__ == "__main__":
    unittest.main()
