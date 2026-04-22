import secrets
import hashlib
import base64
from typing import Tuple

class RecoveryManager:
    """Generates and manages a recovery seed (24-word/base64 equivalent) for ledger access."""
    
    @staticmethod
    def generate_recovery_seed() -> str:
        """Generates a cryptographically strong 24-word-like seed (encoded as base64)."""
        # 256 bits of entropy
        random_bytes = secrets.token_bytes(32)
        return base64.b64encode(random_bytes).decode('utf-8')

    @staticmethod
    def seed_to_key(seed: str) -> bytes:
        """Converts the base64 seed back to the 32-byte master key."""
        return base64.b64decode(seed)

    @staticmethod
    def encrypt_seed(seed: str, pdk: bytes) -> str:
        """Encrypts the recovery seed with a Passphrase Derived Key (PDK)."""
        from security.crypto import CryptoManager
        temp_crypto = CryptoManager(pdk)
        return temp_crypto.encrypt(seed)

    @staticmethod
    def decrypt_seed(encrypted_seed: str, pdk: bytes) -> str:
        """Decrypts the recovery seed using a Passphrase Derived Key (PDK)."""
        from security.crypto import CryptoManager
        temp_crypto = CryptoManager(pdk)
        return temp_crypto.decrypt(encrypted_seed)
