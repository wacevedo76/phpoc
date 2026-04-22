import unittest
import json
import time
import os
import shutil
import tempfile
import hashlib
from pathlib import Path
from core.ledger import LedgerDomain
from security.crypto import CryptoManager
from security.recovery import RecoveryManager
from storage.file_store import LedgerStore

class TestCrypto(unittest.TestCase):
    def setUp(self):
        # Manually derive key as an Authenticator would
        master_key = hashlib.pbkdf2_hmac('sha256', b"test-password", b"session-salt", 100, 32)
        self.manager = CryptoManager(master_key)

    def test_encryption_decryption(self):
        original_text = "Hello, Reputation Ledger!"
        encrypted = self.manager.encrypt(original_text)
        self.assertNotEqual(encrypted, original_text)
        
        decrypted = self.manager.decrypt(encrypted)
        self.assertEqual(decrypted, original_text)

    def test_sealing(self):
        data = '{"day": 1, "entries": []}'
        seal = self.manager.seal(data)
        self.assertTrue(self.manager.verify_seal(data, seal))
        self.assertFalse(self.manager.verify_seal(data + "tamper", seal))

    def test_determinism(self):
        data = "stable-data"
        seal1 = self.manager.seal(data)
        seal2 = self.manager.seal(data)
        self.assertEqual(seal1, seal2)
        
        enc1 = self.manager.encrypt(data)
        enc2 = self.manager.encrypt(data)
        self.assertNotEqual(enc1, enc2)

class TestLedger(unittest.TestCase):
    def setUp(self):
        # Use RAM-backed storage (/dev/shm) for speed while remaining authentic
        base_dir = "/dev/shm" if os.path.exists("/dev/shm") else None
        self.test_dir = Path(tempfile.mkdtemp(dir=base_dir))
        self.staging_file = self.test_dir / "staging.json"
        self.ledger_file = self.test_dir / "ledger.json"
        self.identity_file = self.test_dir / "identity.json"
        
        # 1. PDK for initialization
        pdk = hashlib.pbkdf2_hmac('sha256', b"test-pass", b"session-salt", 100, 32)
        
        # 2. Setup Identity (Simulated)
        self.identity_secret = os.urandom(32)

        self.store = LedgerStore(self.staging_file, self.ledger_file)
        
        # 3. Initialize ledger using Factory
        from core.factory import LedgerFactory
        seed = LedgerFactory.initialize(self.ledger_file, pdk, "testuser", "test@example.com", identity_secret=self.identity_secret)
        
        # 4. Derive actual Master Key from seed for the Domain logic
        mk = RecoveryManager.seed_to_key(seed)
        self.crypto = CryptoManager(mk)
        self.ledger = LedgerDomain(self.crypto, self.store)

    def tearDown(self):
        shutil.rmtree(self.test_dir)

    def test_ledger_init(self):
        self.assertTrue(self.staging_file.exists())
        self.assertTrue(self.ledger_file.exists())
        self.assertTrue(self.identity_file.exists())
        
        data = json.loads(self.ledger_file.read_text())
        self.assertEqual(len(data), 1)
        self.assertEqual(data[0]["type"], "genesis")

    def test_capture_and_sync(self):
        # Capture
        start = int(time.time()*1000) - 3600000
        stop = int(time.time()*1000)
        metadata = {"note": "Test note"}
        self.ledger.capture_habit("Coding", start, stop, metadata=metadata)
        
        staging_data = json.loads(self.staging_file.read_text())
        self.assertEqual(len(staging_data), 1)
        self.assertEqual(staging_data[0]["data"]["title"], "Coding")
        self.assertTrue("startTime_enc" in staging_data[0]["data"])
        
        # Sync
        self.ledger.sync_day()
        self.assertEqual(json.loads(self.staging_file.read_text()), [])
        
        ledger_data = json.loads(self.ledger_file.read_text())
        # Find the day record
        day_record = next(r for r in reversed(ledger_data) if r.get("type") == "day")
        self.assertEqual(day_record["entries"][0]["data"]["title"], "Coding")
        
        # Verify decryption of metadata and timestamps
        data = day_record["entries"][0]["data"]
        decrypted_meta = json.loads(self.crypto.decrypt(data["metadata_enc"]))
        self.assertEqual(decrypted_meta, metadata)
        
        dec_start = int(self.crypto.decrypt(data["startTime_enc"]))
        self.assertEqual(dec_start, start)
        
        self.assertTrue(self.ledger.verify())

    def test_overlap_detection(self):
        now = int(time.time()*1000)
        self.ledger.capture_habit("Task 1", now, is_active=True)
        
        # Collision should raise ValueError
        with self.assertRaises(ValueError):
            self.ledger.capture_habit("Task 2", now, is_active=True)
        
        staging_data = self.store.read_staging()
        self.assertEqual(len(staging_data), 1)

    def test_immutable_history(self):
        # 1. Establish a history
        self.ledger.capture_habit("Past Habit", int(time.time())-86400000, int(time.time()))
        self.ledger.sync_day()
        self.assertTrue(self.ledger.verify())

        # 2. Attempt to tamper with past data
        ledger_data = json.loads(self.ledger_file.read_text())
        # Modifying historical entry data
        day_rec = next(r for r in ledger_data if r.get("type") == "day")
        day_rec["entries"][0]["data"]["title"] = "Evil Habit"
        self.ledger_file.write_text(json.dumps(ledger_data))
        
        # 3. Assert breach
        self.assertFalse(self.ledger.verify(), "Ledger failed to detect historical tampering")

if __name__ == "__main__":
    unittest.main()
