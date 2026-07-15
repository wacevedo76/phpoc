import json
import getpass
import hashlib
from abc import ABC, abstractmethod
from typing import Optional
from pathlib import Path

from security.crypto import CryptoManager


def derive_pdk_salt(identity_pub_key: Optional[str]) -> bytes:
    """Derive a per-user PBKDF2 salt from the identity pub key.

    Per PHPSPEC §2.4:
        salt = SHA-256(identity_pub_key_hex.encode())[:16]

    Args:
        identity_pub_key: 64-char hex identity pub key string.

    Returns:
        16-byte per-user salt.

    Raises:
        ValueError: if identity_pub_key is empty or None.
    """
    if not identity_pub_key:
        raise ValueError("identity_pub_key is required for per-user salt derivation")
    return hashlib.sha256(identity_pub_key.encode()).digest()[:16]


def get_pdk_salt_from_genesis(ledger_path: Path) -> bytes:
    """Read genesis from ledger and derive the per-user PBKDF2 salt.

    Extracts identity_pub_key from the genesis block and derives a
    per-user salt via ``derive_pdk_salt()``. Falls back to the legacy
    fixed salt ``b"session-salt"`` when no pub_key is available (init
    case or corrupted genesis).

    Args:
        ledger_path: Path to ledger.json.

    Returns:
        16-byte salt for PBKDF2 derivation.
    """
    try:
        ledger_data = json.loads(ledger_path.read_text())
        pub_key = ledger_data[0].get("identity", {}).get("identity_pub_key")
        if pub_key:
            return derive_pdk_salt(pub_key)
    except Exception:
        pass
    return b"session-salt"


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
    PBKDF2_ITERATIONS = 600000
    PBKDF2_ITERATIONS_LEGACY = 100000
    OLD_SALT = b"session-salt"

    def __init__(self, ledger_path: Path):
        self.ledger_path = ledger_path
        self._key: Optional[bytes] = None

    def _derive_pbkdf2(self, passphrase: str, salt: bytes, iterations: int) -> bytes:
        """Derive a PDK via PBKDF2-HMAC-SHA256."""
        return hashlib.pbkdf2_hmac('sha256', passphrase.encode(), salt, iterations, 32)

    def _get_per_user_salt(self, genesis: dict) -> Optional[bytes]:
        """Derive per-user salt from genesis identity_pub_key.

        Returns None if no identity_pub_key is available (init case).
        """
        pub_key = genesis.get("identity", {}).get("identity_pub_key")
        if not pub_key:
            return None
        return derive_pdk_salt(pub_key)

    def _upgrade_seed_to_new_salt(self, ledger_data: list, passphrase: str,
                                   seed: str, new_salt: bytes, mk: bytes):
        """Transparently upgrade the seed encryption from old salt to per-user salt.

        Re-encrypts the recovery seed with a per-user-salt PDK (600K iterations),
        re-seals the genesis, and writes the ledger back to disk.
        """
        new_pdk = self._derive_pbkdf2(passphrase, new_salt, self.PBKDF2_ITERATIONS)
        new_enc_seed = RecoveryManager.encrypt_seed(seed, new_pdk)
        ledger_data[0]["identity"]["recovery_seed_enc"] = new_enc_seed

        # Re-seal genesis since recovery_seed_enc changed
        crypto = CryptoManager(mk)
        hash_key = "block_hash" if "block_hash" in ledger_data[0] else "day_hash"
        check_data = {
            k: v for k, v in ledger_data[0].items()
            if k not in (hash_key, "identity_seal", "signature", "format_version")
        }
        ledger_data[0][hash_key] = crypto.seal(json.dumps(check_data, sort_keys=True))
        self.ledger_path.write_text(json.dumps(ledger_data, indent=2))

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
        import os
        passphrase = os.environ.get("PHPOC_PASSPHRASE")
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

        # 3. Read Ledger to find encrypted seed
        if not self.ledger_path.exists():
            # If no ledger exists, we use the PDK as a temporary key (for init)
            # Use old salt (no identity_pub_key to derive from)
            pdk = self._derive_pbkdf2(passphrase, self.OLD_SALT, self.PBKDF2_ITERATIONS)
            self._key = pdk
            return True

        try:
            ledger_data = json.loads(self.ledger_path.read_text())
            genesis = ledger_data[0]
            enc_seed = genesis["identity"]["recovery_seed_enc"]
            new_salt = self._get_per_user_salt(genesis)

            # 4. Try all salt/iteration combos in priority order:
            #    a. new salt + 600K (per-user, current iterations)
            #    b. new salt + 100K (per-user, legacy iterations)
            #    c. old salt + 600K (fixed salt, current iterations)
            #    d. old salt + 100K (fixed salt, legacy iterations)
            seed = None
            used_new_salt = False

            # Build candidate list
            candidates = []
            if new_salt is not None:
                candidates.append((new_salt, self.PBKDF2_ITERATIONS, True))
                candidates.append((new_salt, self.PBKDF2_ITERATIONS_LEGACY, True))
            candidates.append((self.OLD_SALT, self.PBKDF2_ITERATIONS, False))
            candidates.append((self.OLD_SALT, self.PBKDF2_ITERATIONS_LEGACY, False))

            for salt, iterations, is_new_salt in candidates:
                try:
                    candidate_pdk = self._derive_pbkdf2(passphrase, salt, iterations)
                    seed = RecoveryManager.decrypt_seed(enc_seed, candidate_pdk)
                    used_new_salt = is_new_salt
                    break
                except Exception:
                    continue

            if seed is None:
                print("Authentication Error: Wrong passphrase.")
                return False

            self._key = RecoveryManager.seed_to_key(seed)

            # 5. Transparent upgrade: if old-salt combo succeeded, re-encrypt with new salt
            if not used_new_salt and new_salt is not None:
                self._upgrade_seed_to_new_salt(ledger_data, passphrase, seed, new_salt, self._key)

            # 6. Cache in session
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
            ledger_data = json.loads(self.ledger_path.read_text())
            genesis = ledger_data[0]
            crypto = CryptoManager(key)
            # I-17: genesis uses block_hash (not day_hash).
            # I-07: format_version excluded from seal check data.
            hash_key = "block_hash" if "block_hash" in genesis else "day_hash"
            check_data = {k: v for k, v in genesis.items()
                          if k not in (hash_key, "identity_seal", "signature", "format_version")}
            return crypto.verify_seal(
                json.dumps(check_data, sort_keys=True),
                genesis[hash_key]
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
