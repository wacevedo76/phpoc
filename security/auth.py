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

    @abstractmethod
    def login(self) -> bool:
        """Force re-authentication regardless of cached session."""
        pass

from security.recovery import RecoveryManager

class PassphraseAuthenticator(AbstractAuthenticator):
    """Authenticator that uses a passphrase to unlock the Sovereign Seed from the ledger."""
    
    SESSION_FILE = Path("/dev/shm/phpoc_session") if Path("/dev/shm").exists() else Path("/tmp/phpoc_session")

    def __init__(self, ledger_path: Path):
        self.ledger_path = ledger_path
        self._key: Optional[bytes] = None

    def authenticate(self) -> bool:
        # 1. Check cached session — verify against genesis seal before trusting
        if self.SESSION_FILE.exists():
            try:
                cached_key = self.SESSION_FILE.read_bytes()
                if self._verify_cached_key(cached_key):
                    self._key = cached_key
                    return True
                # Stale/wrong key — clear and fall through to passphrase prompt
                self.SESSION_FILE.unlink()
            except Exception:
                pass

        # 2. Get PDK from user (or env var fallback)
        import os as _os
        passphrase = _os.environ.get("PHPOC_PASSPHRASE")
        if passphrase:
            print("Using PHPOC_PASSPHRASE from environment.")
        else:
            try:
                passphrase = getpass.getpass("Passphrase: ")
            except (KeyboardInterrupt, EOFError):
                print()
                return False
        if not passphrase:
            return False

        # Derive PDK with current iteration count (600K)
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

            # 4. Decrypt Sovereign Seed — try current (600K) first, then
            #    legacy (100K) for pre-R3 genesis blocks
            seed = None
            for candidate_pdk in [pdk, hashlib.pbkdf2_hmac('sha256', passphrase.encode(), b"session-salt", 100000, 32)]:
                try:
                    seed = RecoveryManager.decrypt_seed(enc_seed, candidate_pdk)
                    break
                except Exception:
                    continue

            if seed is None:
                print("Authentication Error: Wrong passphrase.")
                return False

            self._key = RecoveryManager.seed_to_key(seed)

            # 5. Cache in session
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

    def login(self) -> bool:
        """Force re-authentication regardless of cached session.

        Clears the session cache, then runs the standard authenticate()
        flow which prompts for a passphrase and re-creates the cache.
        """
        self.clear_session()
        return self.authenticate()

    def _verify_cached_key(self, key: bytes) -> bool:
        """Verify that a cached key matches the ledger by checking genesis seal.

        Returns True if the key correctly verifies the genesis block seal,
        False if the key is stale, wrong, or the ledger can't be read.
        """
        try:
            import json
            from security.crypto import CryptoManager
            ledger_data = json.loads(self.ledger_path.read_text())
            genesis = ledger_data[0]
            crypto = CryptoManager(key)
            check_data = {k: v for k, v in genesis.items()
                          if k not in ("day_hash", "signature")}
            return crypto.verify_seal(
                json.dumps(check_data, sort_keys=True),
                genesis["day_hash"]
            )
        except Exception:
            return False

    def clear_session(self):
        self._key = None
        if self.SESSION_FILE.exists():
            self.SESSION_FILE.unlink()

class RecoveryAuthenticator(AbstractAuthenticator):
    """Authenticator that uses the raw Recovery Seed to gain access."""
    
    def __init__(self):
        self._key: Optional[bytes] = None

    def authenticate(self) -> bool:
        try:
            seed = input("Enter Recovery Seed: ").strip()
        except (KeyboardInterrupt, EOFError):
            print()
            return False
        if not seed:
            return False
        try:
            self._key = RecoveryManager.seed_to_key(seed)
            return True
        except Exception:
            return False

    def get_key(self) -> Optional[bytes]:
        return self._key

    def login(self) -> bool:
        """Force re-authentication regardless of cached session."""
        self.clear_session()
        return self.authenticate()

    def clear_session(self):
        self._key = None
