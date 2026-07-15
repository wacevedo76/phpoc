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
from core.factory import LedgerFactory

class TestHierarchyAndIndex(unittest.TestCase):
    def setUp(self):
        base_dir = "/dev/shm" if os.path.exists("/dev/shm") else None
        self.test_dir = Path(tempfile.mkdtemp(dir=base_dir))
        self.ledger_file = self.test_dir / "ledger.json"
        self.staging_file = self.test_dir / "staging.json"
        self.index_file = self.test_dir / "index.json"
        self.identity_file = self.test_dir / "identity.json"
        
        # 1. PDK for initialization
        pdk = b"dummy-pdk-32-bytes-long-12345678"
        
        # 2. Setup Identity Secret
        self.identity_secret = os.urandom(32)

        # 3. Init Ledger using real Factory
        # This creates the genesis block with the encrypted seed and identity_pub_key
        seed = LedgerFactory.initialize(
            self.ledger_file, 
            pdk, 
            "user", 
            "email", 
            identity_secret=self.identity_secret
        )
        
        # 4. Derive actual Master Key from seed for the Domain logic
        mk = RecoveryManager.seed_to_key(seed)
        self.crypto = CryptoManager(mk)
        
        # 5. The Factory doesn't write identity.json directly (it does now in recent changes, but let's be sure)
        # Actually core/factory.py saves it. Let's verify and then re-save if needed with the correct mk.
        # Wait, core/factory.py uses the Sovereign MK to encrypt identity_secret.
        
        self.store = LedgerStore(self.staging_file, self.ledger_file, self.index_file)
        self.ledger = LedgerDomain(self.crypto, self.store)

    def tearDown(self):
        shutil.rmtree(self.test_dir)

    def test_blind_indexing(self):
        # 1. Capture habit
        now = int(time.time() * 1000)
        self.ledger.capture_habit("Work", now - 3600000, now) # 1 hour
        self.ledger.sync_day()
        
        # 2. Check index.json
        self.assertTrue(self.index_file.exists())
        index_data = json.loads(self.index_file.read_text())
        
        date_str = time.strftime("%Y-%m-%d", time.gmtime(now // 1000))
        self.assertIn(date_str, index_data)
        self.assertEqual(index_data[date_str]["Work"], 3600000)

    def test_month_transition_summary_and_signatures(self):
        # Task in Jan
        jan_time = calendar_to_epoch(2025, 1, 15, 10, 0)
        self.ledger.capture_habit("Jan Task", jan_time, jan_time + 3600000)
        self.ledger.sync_day()
        
        # Task in Feb
        feb_time = calendar_to_epoch(2025, 2, 10, 10, 0)
        self.ledger.capture_habit("Feb Task", feb_time, feb_time + 3600000)
        self.ledger.sync_day()
        
        ledger_data = json.loads(self.ledger_file.read_text())
        
        # 1. Check for hierarchical markers
        has_month_summary = any(rec.get("type") == "month_summary" for rec in ledger_data)
        self.assertTrue(has_month_summary)
        
        # 2. Check all blocks have signatures
        for record in ledger_data:
            # Genesis is signed in Factory, others in sync_day
            seal_val = record.get("identity_seal") or record.get("signature"); self.assertIsNotNone(seal_val, f"Missing identity seal in {record}")
            self.assertNotEqual(record["identity_seal"], "")
            
        # 3. Full verification (HMAC seals + Signatures)
        self.assertTrue(self.ledger.verify())

def calendar_to_epoch(year, month, day, hour, minute):
    import datetime
    dt = datetime.datetime(year, month, day, hour, minute, tzinfo=datetime.timezone.utc)
    return int(dt.timestamp() * 1000)

if __name__ == "__main__":
    unittest.main()
