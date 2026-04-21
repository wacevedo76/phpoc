import unittest
import json
import time
import os
import shutil
import tempfile
from pathlib import Path
from core.ledger import LedgerDomain
from security.crypto import CryptoManager
from storage.file_store import LedgerStore

class TestCrypto(unittest.TestCase):
    def setUp(self):
        self.manager = CryptoManager("test-password")

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
        self.crypto = CryptoManager("test-pass")
        self.store = LedgerStore(self.staging_file, self.ledger_file)
        self.ledger = LedgerDomain(self.crypto, self.store)

    def tearDown(self):
        shutil.rmtree(self.test_dir)

    def test_ledger_init(self):
        self.assertTrue(self.staging_file.exists())
        self.assertTrue(self.ledger_file.exists())
        
        data = json.loads(self.ledger_file.read_text())
        self.assertEqual(len(data), 1)
        self.assertEqual(data[0]["day_index"], 0)

    def test_capture_and_sync(self):
        # Capture
        start = int(time.time()) - 3600
        stop = int(time.time())
        metadata = {"note": "Test note"}
        self.ledger.capture_habit("Coding", start, stop, metadata=metadata)
        
        staging_data = json.loads(self.staging_file.read_text())
        self.assertEqual(len(staging_data), 1)
        self.assertEqual(staging_data[0]["data"]["title"], "Coding")
        self.assertTrue("metadata_enc" in staging_data[0]["data"])
        
        # Sync
        self.ledger.sync_day()
        self.assertEqual(json.loads(self.staging_file.read_text()), [])
        
        ledger_data = json.loads(self.ledger_file.read_text())
        self.assertEqual(len(ledger_data), 2)
        self.assertEqual(ledger_data[1]["entries"][0]["data"]["title"], "Coding")
        
        # Verify decryption of metadata
        data = ledger_data[1]["entries"][0]["data"]
        decrypted_meta = json.loads(self.crypto.decrypt(data["metadata_enc"]))
        self.assertEqual(decrypted_meta, metadata)
        
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
        self.ledger.capture_habit("Past Habit", int(time.time())-86400, int(time.time()))
        self.ledger.sync_day()
        self.assertTrue(self.ledger.verify())

        # 2. Attempt to tamper with past data
        ledger_data = json.loads(self.ledger_file.read_text())
        # Modifying historical entry data
        ledger_data[1]["entries"][0]["data"]["title"] = "Evil Habit"
        self.ledger_file.write_text(json.dumps(ledger_data))
        
        # 3. Assert breach
        self.assertFalse(self.ledger.verify(), "Ledger failed to detect historical tampering")

def test_utils():
    # External non-class test
    t1 = parse_time("10:00")
    t2 = parse_time("11:00")
    assert isinstance(t1, int)
    assert t2 > t1
    assert t2 - t1 == 3600

if __name__ == "__main__":
    unittest.main()
