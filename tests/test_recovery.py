import unittest
import json
import os
import shutil
import tempfile
import hashlib
import base64
from pathlib import Path
from security.crypto import CryptoManager
from security.auth import PassphraseAuthenticator, RecoveryAuthenticator
from security.recovery import RecoveryManager
from core.factory import LedgerFactory
from storage.file_store import LedgerStore

class TestSovereignRecovery(unittest.TestCase):
    def setUp(self):
        base_dir = "/dev/shm" if os.path.exists("/dev/shm") else None
        self.test_dir = Path(tempfile.mkdtemp(dir=base_dir))
        self.ledger_file = self.test_dir / "ledger.json"
        self.staging_file = self.test_dir / "staging.json"
        self.index_file = self.test_dir / "index.json"
        
        self.username = "testuser"
        self.email = "test@example.com"
        self.passphrase = "initial-pass"
        self.pdk = hashlib.pbkdf2_hmac('sha256', self.passphrase.encode(), b"session-salt", 100, 32)

    def tearDown(self):
        shutil.rmtree(self.test_dir)
        # Clear session files if they exist in temp
        for p in [Path("/dev/shm/phpoc_session"), Path("/tmp/phpoc_session")]:
            if p.exists(): p.unlink()

    def test_sovereign_init_and_auth(self):
        # 1. Initialize
        seed = LedgerFactory.initialize(self.ledger_file, self.pdk, self.username, self.email)
        self.assertIsNotNone(seed)
        
        # 2. Verify Identity Storage
        id_path = self.test_dir / "identity.json"
        self.assertTrue(id_path.exists())
        id_data = json.loads(id_path.read_text())
        self.assertIn("identity_secret_enc", id_data)
        
        # 3. Verify Genesis Block has Public Key and Signature
        ledger_data = json.loads(self.ledger_file.read_text())
        genesis = ledger_data[0]
        self.assertIn("identity_pub_key", genesis["identity"])
        seal_val = genesis.get("identity_seal") or genesis.get("signature"); self.assertIsNotNone(seal_val, f"Missing identity seal in {genesis}")
        self.assertNotEqual(genesis["identity_seal"], "")
        
        # 4. Verify we can unlock Seed and Identity
        enc_seed = genesis["identity"]["recovery_seed_enc"]
        decrypted_seed = RecoveryManager.decrypt_seed(enc_seed, self.pdk)
        self.assertEqual(decrypted_seed, seed)
        
        mk = RecoveryManager.seed_to_key(decrypted_seed)
        crypto = CryptoManager(mk)
        
        # Unlock Identity Secret
        decrypted_identity_hex = crypto.decrypt(id_data["identity_secret_enc"])
        identity_secret = bytes.fromhex(decrypted_identity_hex)
        
        # Verify signature on genesis seal
        self.assertTrue(crypto.verify_mac(genesis.get("block_hash") or genesis.get("day_hash"), genesis["identity_seal"], identity_secret))

    def test_recovery_and_passphrase_reset(self):
        seed = LedgerFactory.initialize(self.ledger_file, self.pdk, self.username, self.email)
        mk = RecoveryManager.seed_to_key(seed)
        
        # Scenario: User forgets passphrase, uses seed to set a NEW one
        new_passphrase = "new-secure-pass"
        new_pdk = hashlib.pbkdf2_hmac('sha256', new_passphrase.encode(), b"session-salt", 100, 32)
        
        # Recovery Flow (similar to main.py recover command)
        ledger_data = json.loads(self.ledger_file.read_text())
        new_enc_seed = RecoveryManager.encrypt_seed(seed, new_pdk)
        ledger_data[0]["identity"]["recovery_seed_enc"] = new_enc_seed
        
        # Re-seal genesis
        crypto = CryptoManager(mk)
        check_data = {k: v for k, v in ledger_data[0].items() if k != "day_hash"}
        ledger_data[0]["day_hash"] = crypto.seal(json.dumps(check_data, sort_keys=True))
        self.ledger_file.write_text(json.dumps(ledger_data))
        
        # Now verify old passphrase fails and new one works
        old_pdk = self.pdk
        with self.assertRaises(Exception): # CryptoManager or Decrypt will fail
             RecoveryManager.decrypt_seed(new_enc_seed, old_pdk)
             
        # New one works
        decrypted = RecoveryManager.decrypt_seed(new_enc_seed, new_pdk)
        self.assertEqual(decrypted, seed)

if __name__ == "__main__":
    unittest.main()
