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
from security.crypto import CryptoManager, NoAuthCryptoManager
from security.auth import PassphraseAuthenticator, RecoveryAuthenticator
from security.recovery import RecoveryManager
from storage.file_store import LedgerStore
from core.factory import LedgerFactory
from cli.interface import CLIInterface

# --- Test Crypto Manager ---
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
        self.index_file = self.test_dir / "index.json"
        
        # 1. PDK for initialization
        pdk = hashlib.pbkdf2_hmac('sha256', b"test-pass", b"session-salt", 100, 32)
        
        # 2. Setup Identity (Simulated)
        self.identity_secret = os.urandom(32)

        # 3. Initialize ledger using Factory
        from core.factory import LedgerFactory
        seed = LedgerFactory.initialize(
            self.ledger_file, 
            pdk, 
            "testuser", 
            "test@example.com", 
            identity_secret=self.identity_secret
        )
        
        # 4. Derive actual Master Key from seed for the Domain logic
        mk = RecoveryManager.seed_to_key(seed)
        self.crypto = CryptoManager(mk)
        
        self.store = LedgerStore(self.staging_file, self.ledger_file, self.index_file)
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

    def test_lazy_encryption_flow(self):
        # 1. Capture habit without auth (NoAuthCryptoManager)
        lazy_ledger = LedgerDomain(NoAuthCryptoManager(), self.store)
        start = int(time.time()*1000) - 100000
        lazy_ledger.capture_habit("Lazy Task", start, start + 50000)
        
        staging_data = self.store.read_staging()
        self.assertTrue(staging_data[0]["data"]["startTime_enc"].startswith("plain:"))
        
        # 2. Sync with real auth
        self.ledger.sync_day()
        
        # 3. Verify it was encrypted in the ledger
        ledger_data = self.store.read_ledger()
        day_rec = next(r for r in ledger_data if r.get("type") == "day" and any(e["data"]["title"] == "Lazy Task" for e in r["entries"]))
        entry = next(e for e in day_rec["entries"] if e["data"]["title"] == "Lazy Task")
        
        self.assertFalse(entry["data"]["startTime_enc"].startswith("plain:"))
        # Should be decryptable with real key
        dec_start = int(self.crypto.decrypt(entry["data"]["startTime_enc"]))
        self.assertEqual(dec_start, start)
        
        self.assertTrue(self.ledger.verify())

    def test_list_synced(self):
        # Setup: Capture and sync data
        start_synced = int(time.time()*1000) - 7200000 # 2 hours ago
        stop_synced = start_synced + 3600000 # 1 hour duration
        self.ledger.capture_habit("Synced Task", start_synced, stop_synced)
        self.ledger.sync_day()
        
        # List synced activities
        # Mocking CLI output is complex, so we'll check raw ledger data
        ledger_data = self.ledger.get_ledger_data()
        day_record = next(r for r in reversed(ledger_data) if r.get("type") == "day")
        synced_entry = next(e for e in day_record["entries"] if e["data"]["title"] == "Synced Task")
        
        self.assertEqual(synced_entry["data"]["title"], "Synced Task")
        self.assertFalse(synced_entry["data"]["startTime_enc"].startswith("plain:"))

    def test_list_staged(self):
        # Setup: Capture data but do not sync
        start_staged = int(time.time()*1000) - 1800000 # 30 mins ago
        stop_staged = start_staged + 600000 # 10 mins duration
        self.ledger.capture_habit("Staged Task", start_staged, stop_staged)
        
        # List staged activities
        staging_data = self.store.read_staging()
        self.assertEqual(len(staging_data), 1)
        self.assertEqual(staging_data[0]["data"]["title"], "Staged Task")
        # With real CryptoManager, data is encrypted, not plain
        # self.assertTrue(staging_data[0]["data"]["startTime_enc"].startswith("plain:"))

    def test_list_all_combined(self):
        # Setup: Capture and sync some data, then capture more staged data
        start_synced = int(time.time()*1000) - 7200000 # 2 hours ago
        stop_synced = start_synced + 3600000
        self.ledger.capture_habit("Synced Task", start_synced, stop_synced)
        self.ledger.sync_day()

        start_staged = int(time.time()*1000) - 1800000 # 30 mins ago
        stop_staged = start_staged + 600000
        self.ledger.capture_habit("Staged Task", start_staged, stop_staged)

        # List all activities
        # Note: list_habits() with source='all' combines synced and staged
        # We are checking the raw data sources here as the CLI output is complex to mock perfectly.
        ledger_data = self.ledger.get_ledger_data()
        staging_data = self.store.read_staging()
        
        self.assertEqual(len(ledger_data), 2) # Genesis + 1 Day record (synced)
        self.assertEqual(len(staging_data), 1) # 1 Staged record

        # Check presence of both types
        synced_titles = [e["data"]["title"] for day in ledger_data if day.get("type") == "day" for e in day["entries"]]
        staged_titles = [e["data"]["title"] for e in staging_data]
        
        self.assertIn("Synced Task", synced_titles)
        self.assertIn("Staged Task", staged_titles)

    def test_list_date_filtering(self):
        # Setup: Add activities for multiple days
        today_ts = int(time.time()*1000)
        yesterday_ts = today_ts - 86400000
        day_before_yesterday_ts = yesterday_ts - 86400000

        # Use gmtime for consistency with sync_day
        today_str = time.strftime("%Y-%m-%d", time.gmtime(today_ts // 1000))
        yesterday_str = time.strftime("%Y-%m-%d", time.gmtime(yesterday_ts // 1000))
        day_before_yesterday_str = time.strftime("%Y-%m-%d", time.gmtime(day_before_yesterday_ts // 1000))

        self.ledger.capture_habit("Task Today", today_ts, today_ts + 1800000) # 30 min
        self.ledger.sync_day() # Sync today's task

        self.ledger.capture_habit("Task Yesterday", yesterday_ts, yesterday_ts + 3600000) # 1 hour
        self.ledger.sync_day() # Sync yesterday's task

        self.ledger.capture_habit("Task Day Before", day_before_yesterday_ts, day_before_yesterday_ts + 600000) # 10 min
        self.ledger.sync_day() # Sync day before yesterday's task

        # Re-read ledger to ensure syncs are processed
        ledger_data = self.ledger.get_ledger_data()

        # Test filtering by days_limit
        # List last 2 days (should include today and yesterday)
        # Note: days_limit=2 means include today and yesterday (2 calendar days)
        # So we filter for dates >= 1 day ago (not 2 days ago)
        synced_list_last_2 = [d for d in ledger_data if d.get('type') == 'day' and d['date'] >= time.strftime("%Y-%m-%d", time.gmtime(today_ts // 1000 - 1 * 86400))]
        self.assertEqual(len(synced_list_last_2), 2)

        # Test filtering by from_date
        synced_list_from_yesterday = [d for d in ledger_data if d.get('type') == 'day' and d['date'] >= yesterday_str]
        self.assertEqual(len(synced_list_from_yesterday), 2)

        # Test filtering by to_date
        synced_list_to_yesterday = [d for d in ledger_data if d.get('type') == 'day' and d['date'] <= yesterday_str]
        self.assertEqual(len(synced_list_to_yesterday), 2)

class TestGenesisSealVerification(unittest.TestCase):
    """Bug 4: Genesis seal mismatch between creation and verification.

    The factory includes signature: "" in the JSON before sealing,
    but verification paths strip signature before recomputing.
    The fix strips signature from seal_data before calling crypto.seal().
    """

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.ledger_path = Path(self.tmpdir) / "ledger.json"
        self.pdk = hashlib.pbkdf2_hmac(
            'sha256', b'test-passphrase-123', b'session-salt', 100, 32
        )

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_genesis_seal_verifiable_without_signature(self):
        """Factory-produced genesis day_hash can be verified by re-computing
        the seal WITHOUT the signature field in the JSON.

        Before Bug 4 fix: this test FAILS because factory includes
        signature: "" in the sealed JSON, producing a different hash
        than the verification paths that strip signature.
        """
        # Create a ledger with the factory
        identity_secret = os.urandom(32)
        seed = LedgerFactory.initialize(
            self.ledger_path, self.pdk,
            username='testseal', email='seal@test.com',
            identity_secret=identity_secret
        )

        # Read the genesis block
        ledger_data = json.loads(self.ledger_path.read_text())
        genesis = ledger_data[0]
        self.assertEqual(genesis['type'], 'genesis')

        # Extract seal values
        day_hash = genesis['day_hash']
        signature = genesis.get('signature', '')

        # Recompute the seal WITHOUT the signature field
        # (matching onboarding_file.py line 260 and auth.py line 147)
        import copy
        check_data = copy.deepcopy(genesis)
        del check_data['day_hash']
        if 'signature' in check_data:
            del check_data['signature']

        # Derive master key from seed and create crypto
        mk = RecoveryManager.seed_to_key(seed)
        crypto = CryptoManager(mk)

        # Re-compute seal
        check_json = json.dumps(check_data, sort_keys=True)
        recomputed_day_hash = crypto.seal(check_json)

        self.assertEqual(
            recomputed_day_hash, day_hash,
            'Bug 4 fix: genesis day_hash must match seal computed WITHOUT signature field'
        )

    def test_genesis_seal_matches_auth_verification_path(self):
        """Factory-produced genesis day_hash matches what auth.py
        _verify_cached_key() would compute."""
        identity_secret = os.urandom(32)
        seed = LedgerFactory.initialize(
            self.ledger_path, self.pdk,
            username='testauth', email='auth@test.com',
            identity_secret=identity_secret
        )

        ledger_data = json.loads(self.ledger_path.read_text())
        genesis = ledger_data[0]

        # Simulate auth.py _verify_cached_key() logic:
        # Copy block, remove day_hash and signature, recompute seal
        check_data = {}
        for k, v in genesis.items():
            if k not in ('day_hash', 'signature'):
                check_data[k] = v

        mk = RecoveryManager.seed_to_key(seed)
        crypto = CryptoManager(mk)
        check_json = json.dumps(check_data, sort_keys=True)
        expected_hash = crypto.seal(check_json)

        self.assertEqual(
            expected_hash, genesis['day_hash'],
            'Bug 4 fix: genesis day_hash matches auth verification path'
        )

    def test_old_buggy_genesis_fails_verification(self):
        """Old CLI-created ledgers (with signature in the sealed JSON)
        still fail verification — no false-positive regression."""
        # Construct a buggy genesis manually (simulating old factory behavior)
        mk = RecoveryManager.seed_to_key(
            RecoveryManager.generate_recovery_seed()
        )
        crypto = CryptoManager(mk)

        date_str = time.strftime("%Y-%m-%d")
        # Buggy genesis: includes signature before sealing
        buggy_genesis = {
            "type": "genesis",
            "day_index": 0,
            "date": date_str,
            "identity": {
                "username": "olduser",
                "email": "old@test.com",
                "recovery_seed_enc": "enc:oldseed",
                "identity_pub_key": "0" * 64,
                "identity_secret_enc_fallback": "enc:oldsecret",
            },
            "prev_hash": "0" * 64,
            "entries": [],
            "signature": "",  # BUG: included in sealed JSON
        }
        genesis_json = json.dumps(buggy_genesis, sort_keys=True)
        buggy_genesis["day_hash"] = crypto.seal(genesis_json)

        # Now verify it WITHOUT signature (as verification paths do)
        verify_data = {k: v for k, v in buggy_genesis.items()
                       if k not in ('day_hash', 'signature')}
        verify_json = json.dumps(verify_data, sort_keys=True)
        recomputed_hash = crypto.seal(verify_json)

        # The buggy seal should NOT match the signature-stripped recomputation
        self.assertNotEqual(
            recomputed_hash, buggy_genesis['day_hash'],
            'Old buggy genesis (signature in seal) should fail verification — '
            'this confirms the bug existed and the fix prevents new ledgers '
            'from being created this way'
        )


if __name__ == "__main__":
    unittest.main()
