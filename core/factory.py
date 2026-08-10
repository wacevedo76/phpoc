import json
import time
import hashlib
from pathlib import Path
from typing import Optional
from security.crypto import CryptoManager
from security.recovery import RecoveryManager
from domain.ledger.chain import compute_seal

class LedgerFactory:
    """Handles the creation and initial setup of the ledger environment."""

    @staticmethod
    def initialize(ledger_path: Path, pdk: bytes, username: str, email: str, identity_secret: Optional[bytes] = None) -> str:
        if ledger_path.exists():
            return None # Ledger already exists

        # 1. Generate the Sovereign Master Key (Seed)
        seed = RecoveryManager.generate_recovery_seed()
        mk = RecoveryManager.seed_to_key(seed)
        
        # 2. Initialize Crypto with the Sovereign MK
        crypto = CryptoManager(mk)
        
        # 3. Generate Identity (Proxy for Ed25519)
        import os
        if identity_secret is None:
            identity_secret = os.urandom(32)
        
        # Public key is just a hash of the secret for this proxy
        identity_pub_key = hashlib.sha256(identity_secret).hexdigest()
        
        # 4. Encrypt the Seed and Identity Secret with the Passphrase Derived Key (PDK)
        encrypted_seed = RecoveryManager.encrypt_seed(seed, pdk)
        encrypted_identity = crypto.encrypt(identity_secret.hex())

        date_str = time.strftime("%Y-%m-%d")
        identity_metadata = {
            "username": username,
            "email": email,
            "recovery_seed_enc": encrypted_seed,
            "identity_pub_key": identity_pub_key,
            "identity_secret_enc_fallback": encrypted_identity
        }

        genesis = {
            "type": "genesis",
            "day_index": 0,
            "date": date_str,
            "identity": identity_metadata,
            "prev_hash": "0" * 64,
            "entries": [],
            "signature": ""
        }
        
        # 5. Seal and Sign the Genesis
        # Route through compute_seal for the ADR-029a canonical per-type whitelist
        # (identity/signature/identity metadata stay OUT of the seal).
        genesis["block_hash"] = compute_seal(crypto, genesis)
        genesis["identity_seal"] = crypto.mac(genesis["block_hash"], identity_secret)
        
        # Create directory first
        ledger_path.parent.mkdir(parents=True, exist_ok=True)
        
        # Save Identity File
        id_path = ledger_path.parent / "identity.json"
        id_path.write_text(json.dumps({"identity_secret_enc": encrypted_identity}, indent=2))

        ledger_path.write_text(json.dumps([genesis], indent=2))
        return seed

