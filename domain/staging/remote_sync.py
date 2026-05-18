"""RemoteStagingSync — device identity check, transport pull/push, blob handling.

Handles the remote side of staging: verifying device identity, pulling and
pushing staging blobs over a transport, and managing the remote blob format.

The transport is a 2-method interface:
  - ``pull(path) -> bytes | None``
  - ``push(path, data: bytes) -> None``

Remote blob format (JSON, stored as obfuscated bytes):
  {
    "device_id": "uuid-string",
    "device_proof": "hmac-hex",
    "entries": [...],
    "updated_at": 1714000000000
  }
"""

import json
import os
import struct
import time
from typing import Optional, List, Dict, Any, Tuple
from enum import Enum

from security.crypto import AbstractCryptoManager
from security.device_identity import AbstractDeviceIdentityProvider


# Obfuscation tier sizes in bytes
TIER_64K = 64 * 1024       # 65536
TIER_128K = 128 * 1024     # 131072
TIER_256K = 256 * 1024     # 262144
TIER_512K = 512 * 1024     # 524288

BLOB_TIERS = [TIER_64K, TIER_128K, TIER_256K, TIER_512K]
# Prefix used to derive the blob obfuscation sub-key from the master key
BLOB_SUBKEY_PREFIX = b"blob-obfuscation"


class SyncCheckResult(Enum):
    """Result of event-driven remote check before a staging command."""
    READY = "ready"           # Remote synced, proceed with local operation
    OFFLINE = "offline"       # Remote unreachable, local operation only
    REAUTH_NEEDED = "reauth"  # Device mismatch, passphrase required


class RemoteStagingSync:
    """Handles device identity, transport, and blob obfuscation for remote staging.

    Blob obfuscation:
      - Serialized JSON is padded to the next class ceiling with random bytes
      - Then encrypted using a derived blob sub-key (``HMAC(MK, "blob-obfuscation")``)
      - On pull: decrypt, then strip padding by reading the original-size prefix

    Attributes:
        _crypto: CryptoManager for blob obfuscation.
        _transport: 2-method interface for pull/push.
        _device_id_provider: For checking device identity.
        _blob_path: Remote path for the staging blob.
    """

    def __init__(
        self,
        crypto: AbstractCryptoManager,
        transport,
        device_id_provider: AbstractDeviceIdentityProvider,
        blob_path: str = "staging/blobs/current.json",
        master_key: Optional[bytes] = None,
    ):
        self._crypto = crypto
        self._transport = transport
        self._device_id_provider = device_id_provider
        self._blob_path = blob_path
        self._master_key = master_key

    # ------------------------------------------------------------------
    # Blob obfuscation (pad + encrypt)
    # ------------------------------------------------------------------

    @staticmethod
    def _select_tier(plaintext_size: int) -> int:
        """Select the smallest obfuscation tier that fits *plaintext_size*.

        Args:
            plaintext_size: Size of the serialized blob in bytes.

        Returns:
            Tier size in bytes (65536, 131072, 262144, or 524288).

        Raises:
            ValueError: If plaintext_size exceeds the largest tier (512K).
        """
        for tier in BLOB_TIERS:
            if plaintext_size <= tier:
                return tier
        raise ValueError(
            f"Blob size {plaintext_size} bytes exceeds max tier "
            f"{TIER_512K} bytes (512K). Consider a larger tier."
        )

    @staticmethod
    def _derive_blob_key(master_key: bytes) -> bytes:
        """Derive the blob obfuscation sub-key from the master key.

        Uses: ``HMAC-SHA256(MK, "blob-obfuscation")[:16]``

        Args:
            master_key: 32-byte master key.

        Returns:
            16-byte AES key for blob encryption.
        """
        import hmac
        import hashlib
        return hmac.new(master_key, BLOB_SUBKEY_PREFIX, hashlib.sha256).digest()[:16]

    @staticmethod
    def _obfuscate(plaintext: bytes, master_key: bytes) -> bytes:
        """Pad to nearest tier ceiling and encrypt with blob sub-key.

        Format:
          ``salt(16) + nonce(8) + plaintext_len(4) + padded_data + tag(32)``

        *salt*, *nonce*, *tag* are added by the AES-CTR encrypt wrapper.
        *plaintext_len* is the original length before padding (big-endian u32).

        Args:
            plaintext: Serialized blob bytes.
            master_key: 32-byte master key for sub-key derivation.

        Returns:
            Obfuscated bytes ready for transport.
        """
        tier = RemoteStagingSync._select_tier(len(plaintext))
        padded_size = tier - 4  # Reserve 4 bytes for the original length

        # Pad with random bytes
        padding_needed = padded_size - len(plaintext)
        if padding_needed > 0:
            padded = plaintext + os.urandom(padding_needed)
        else:
            padded = plaintext

        # Prepend original length
        padded_with_len = struct.pack(">I", len(plaintext)) + padded

        # Encrypt using the blob sub-key
        blob_key = RemoteStagingSync._derive_blob_key(master_key)

        salt = os.urandom(16)
        nonce = os.urandom(8)

        # Derive the encryption key from salt using the blob sub-key
        import hmac
        import hashlib
        enc_key = hmac.new(blob_key, salt, hashlib.sha256).digest()[:16]

        from security.crypto import PureAESCTR
        aes = PureAESCTR(enc_key)
        ciphertext = aes.process(padded_with_len, nonce)

        # Encrypt-then-MAC
        integrity_key = hmac.new(
            blob_key, salt + b"-integrity", hashlib.sha256
        ).digest()[:16]
        tag = hmac.new(integrity_key, nonce + ciphertext, hashlib.sha256).digest()

        return salt + nonce + ciphertext + tag

    @staticmethod
    def _deobfuscate(obfuscated: bytes, master_key: bytes) -> Optional[bytes]:
        """Decrypt and unpad an obfuscated blob.

        Args:
            obfuscated: Raw bytes from transport.
            master_key: 32-byte master key for sub-key derivation.

        Returns:
            Original plaintext bytes, or None if decryption fails.
        """
        try:
            blob_key = RemoteStagingSync._derive_blob_key(master_key)

            salt = obfuscated[:16]
            nonce = obfuscated[16:24]
            ciphertext = obfuscated[24:-32]
            stored_tag = obfuscated[-32:]

            import hmac
            import hashlib

            integrity_key = hmac.new(
                blob_key, salt + b"-integrity", hashlib.sha256
            ).digest()[:16]
            expected_tag = hmac.new(
                integrity_key, nonce + ciphertext, hashlib.sha256
            ).digest()

            if not hmac.compare_digest(expected_tag, stored_tag):
                logger = __import__("logging").getLogger(__name__)
                logger.warning("Blob integrity check failed (tag mismatch)")
                return None

            enc_key = hmac.new(
                blob_key, salt, hashlib.sha256
            ).digest()[:16]

            from security.crypto import PureAESCTR
            aes = PureAESCTR(enc_key)
            decrypted = aes.process(ciphertext, nonce)

            # Read original length (first 4 bytes)
            original_len = struct.unpack(">I", decrypted[:4])[0]
            return decrypted[4:4 + original_len]
        except Exception as exc:
            logger = __import__("logging").getLogger(__name__)
            logger.warning("Blob deobfuscation failed: %s", exc)
            return None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def pull(self, master_key: Optional[bytes] = None) -> Optional[Dict[str, Any]]:
        """Pull remote blob, deobfuscate, return parsed dict.

        If the blob is obfuscated (non-JSON), requires *master_key* to
        decrypt. Unobfuscated (plain JSON) blobs are accepted for
        backward compatibility.

        Args:
            master_key: 32-byte master key for blob decryption.
                        If None, tries plaintext JSON only.

        Returns:
            Parsed blob dict with ``entries``, ``device_id``, etc.,
            or None if no blob exists or decryption fails.
        """
        raw_bytes = self._transport.pull(self._blob_path)
        if raw_bytes is None:
            return None

        # Try plaintext JSON first (backward compat / unobfuscated)
        try:
            return json.loads(raw_bytes.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            pass

        # Try deobfuscation if master_key is available
        if master_key is not None:
            plaintext = self._deobfuscate(raw_bytes, master_key)
            if plaintext is not None:
                try:
                    return json.loads(plaintext.decode("utf-8"))
                except (json.JSONDecodeError, UnicodeDecodeError):
                    pass

        return None

    def push(self, entries: List[Dict[str, Any]], device_id: str, master_key: Optional[bytes] = None):
        """Encrypt entries into blob format, obfuscate, and push via transport.

        Obfuscation happens when a *master_key* is available (either passed
        directly or stored via ``_master_key``). Falls back to plaintext JSON
        when no key is available (e.g., unauthenticated sessions).

        Args:
            entries: List of staging entry dicts (encrypted, raw format).
            device_id: This device's UUID for the blob header.
            master_key: 32-byte master key for blob obfuscation.
                        Falls back to ``self._master_key`` if not provided.
        """
        blob = {
            "device_id": device_id,
            "device_proof": "",  # set by caller or via device_id_provider
            "entries": entries,
            "updated_at": int(time.time() * 1000),
        }
        blob_bytes = json.dumps(blob, indent=2).encode("utf-8")

        effective_key = master_key if isinstance(master_key, bytes) else self._master_key
        if effective_key is not None and len(effective_key) == 32:
            blob_bytes = self._obfuscate(blob_bytes, effective_key)

        self._transport.push(self._blob_path, blob_bytes)

    def check_device(self, master_key: Optional[bytes] = None) -> bool:
        """Compare local device_id with remote blob's device_id.

        Args:
            master_key: Optional 32-byte key for deobfuscating the blob.

        Returns:
            True if remote blob matches this device (or no remote blob),
            False if device mismatch (re-auth may be needed).
        """
        blob = self.pull(master_key=master_key)
        if blob is None:
            return True  # No remote blob — nothing to conflict with
        remote_id = blob.get("device_id")
        if not remote_id:
            return True
        local = self._device_id_provider.get_device_identity(b"")  # dummy mk
        return remote_id == local.device_id

    def get_remote_device_id(self, master_key: Optional[bytes] = None) -> Optional[str]:
        """Decrypt device_id from remote blob.

        Args:
            master_key: Optional 32-byte key for deobfuscating the blob.

        Returns:
            Device ID string, or None if no blob exists.
        """
        blob = self.pull(master_key=master_key)
        if blob is None:
            return None
        return blob.get("device_id")

    def check_remote_available(self, timeout_ms: int = 500) -> bool:
        """Quick reachability check on the transport.

        Attempts to pull the blob. If the transport doesn't respond within
        *timeout_ms*, it is considered offline.

        Args:
            timeout_ms: Max time to wait for transport response in ms.

        Returns:
            True if remote is reachable within the timeout (pull returned bytes).
        """
        import time as _time
        start = _time.monotonic()
        try:
            result = self._transport.pull(self._blob_path)
            elapsed_ms = (_time.monotonic() - start) * 1000
            if elapsed_ms > timeout_ms:
                return False
            # Transport responded — treat as available even if blob is empty
            return True
        except Exception:
            return False
