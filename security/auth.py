import os
import getpass
import hashlib
from abc import ABC, abstractmethod
from typing import Optional
from pathlib import Path

class AbstractAuthenticator(ABC):
    """Abstract Base Class for authentication mechanisms."""

    @abstractmethod
    def authenticate(self) -> bool:
        """
        Triggers the authentication flow.
        Returns True if successful, False otherwise.
        """
        pass

    @abstractmethod
    def get_key(self) -> Optional[bytes]:
        """
        Returns the derived cryptographic key after successful authentication.
        Should return None if not authenticated.
        """
        pass

    @abstractmethod
    def clear_session(self):
        """Clears any cached authentication state."""
        pass

from security.recovery import RecoveryManager

class PassphraseAuthenticator(AbstractAuthenticator):
    """Authenticator that uses a passphrase to unlock the Sovereign Seed from the ledger."""
    
    SESSION_FILE = Path("/dev/shm/phpoc_session") if Path("/dev/shm").exists() else Path("/tmp/phpoc_session")

    def __init__(self, ledger_path: Path):
        self.ledger_path = ledger_path
        self._key: Optional[bytes] = None

    def authenticate(self) -> bool:
        # 1. Check RAM cache
        if self.SESSION_FILE.exists():
            try:
                self._key = self.SESSION_FILE.read_bytes()
                return True
            except Exception:
                pass

        # 2. Get PDK from user
        passphrase = getpass.getpass("Passphrase: ")
        if not passphrase:
            return False
        
        pdk = hashlib.pbkdf2_hmac('sha256', passphrase.encode(), b"session-salt", 600000, 32)
        
        # 3. Read Ledger to find encrypted seed
        if not self.ledger_path.exists():
            # If no ledger exists, we use the PDK as a temporary key (for init)
            self._key = pdk
            return True

        try:
            import json
            ledger_data = json.loads(self.ledger_path.read_text())
            genesis = ledger_data[0]
            enc_seed = genesis["identity"]["recovery_seed_enc"]
            
            # 4. Decrypt Sovereign Seed
            seed = RecoveryManager.decrypt_seed(enc_seed, pdk)
            self._key = RecoveryManager.seed_to_key(seed)
            
            # 5. Cache in RAM
            self._cache_key(self._key)
            return True
        except Exception as e:
            print(f"Authentication Error: {e}")
            return False

    def _cache_key(self, key: bytes):
        try:
            self.SESSION_FILE.write_bytes(key)
            self.SESSION_FILE.chmod(0o600)
        except Exception:
            pass

    def get_key(self) -> Optional[bytes]:
        if not self._key and self.SESSION_FILE.exists():
            self._key = self.SESSION_FILE.read_bytes()
        return self._key

    def clear_session(self):
        self._key = None
        if self.SESSION_FILE.exists():
            self.SESSION_FILE.unlink()

class RecoveryAuthenticator(AbstractAuthenticator):
    """Authenticator that uses the raw Recovery Seed to gain access."""
    
    def __init__(self):
        self._key: Optional[bytes] = None

    def authenticate(self) -> bool:
        seed = input("Enter Recovery Seed: ").strip()
        if not seed:
            return False
        try:
            self._key = RecoveryManager.seed_to_key(seed)
            return True
        except Exception:
            return False

    def get_key(self) -> Optional[bytes]:
        return self._key

    def clear_session(self):
        self._key = None
