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

import hashlib
import hmac
import json
import logging
import os
import struct
import time
from typing import Optional, List, Dict, Any, Tuple
from enum import Enum

from security.crypto import AbstractCryptoManager, PureAESCTR
from security.device_identity import AbstractDeviceIdentityProvider
from cli.trace import trace

_logger = logging.getLogger(__name__)


# Obfuscation tier sizes in bytes
TIER_64K = 64 * 1024       # 65536
TIER_128K = 128 * 1024     # 131072
TIER_256K = 256 * 1024     # 262144
TIER_512K = 512 * 1024     # 524288

BLOB_TIERS = [TIER_64K, TIER_128K, TIER_256K, TIER_512K]
# Prefix used to derive the blob obfuscation sub-key from the master key
BLOB_SUBKEY_PREFIX = b"blob-obfuscation"

# Remote path for the device cookie (32-byte HMAC, no decryption needed)
REMOTE_COOKIE_PATH = "staging/blobs/device_cookie.bin"


class SyncCheckResult(Enum):
    """Result of event-driven remote check before a staging command."""
    READY = "ready"           # Remote synced, proceed with local operation
    OFFLINE = "offline"       # Remote unreachable, local operation only
    REAUTH_NEEDED = "reauth"  # Device mismatch, passphrase required


# Sentinel returned by pull() when a remote blob exists but cannot be decrypted
# (wrong master key). This is distinct from None (no blob on remote).
BLOB_KEY_MISMATCH = object()


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
        return hmac.new(master_key, BLOB_SUBKEY_PREFIX, hashlib.sha256).digest()[:16]

    # -- Shared encryption helpers (used by both obfuscation paths) ---------

    @staticmethod
    def _derive_blob_encryption_keys(blob_key: bytes, salt: bytes) -> Tuple[bytes, bytes]:
        """Derive encryption and integrity keys from blob key + salt.

        Per PHPSPEC §3.3:
          - ``enc_key = HMAC-SHA256(blob_key, salt)[:16]``
          - ``integrity_key = HMAC-SHA256(blob_key, salt || "-integrity")[:16]``
        """
        enc_key = hmac.new(blob_key, salt, hashlib.sha256).digest()[:16]
        integrity_key = hmac.new(
            blob_key, salt + b"-integrity", hashlib.sha256
        ).digest()[:16]
        return enc_key, integrity_key

    @staticmethod
    def _encrypt_and_tag(
        payload: bytes, enc_key: bytes, integrity_key: bytes, nonce: bytes
    ) -> bytes:
        """AES-CTR encrypt *payload* and append an HMAC-SHA256 auth tag.

        Returns ``ciphertext + tag(32)`` — caller prepends salt + nonce.
        """
        aes = PureAESCTR(enc_key)
        ciphertext = aes.process(payload, nonce)
        tag = hmac.new(integrity_key, nonce + ciphertext, hashlib.sha256).digest()
        return ciphertext + tag

    @staticmethod
    def _obfuscate_core(
        plaintext: bytes,
        master_key: bytes,
        salt: bytes,
        nonce: bytes,
        padding_fill: Optional[int] = None,
    ) -> bytes:
        """Core obfuscation: pad to tier, encrypt with explicit salt/nonce.

        This is the shared engine behind ``_obfuscate()`` (random salt/nonce)
        and ``_obfuscate_deterministic()`` (explicit salt/nonce + zero-fill).

        Args:
            plaintext: Serialized blob bytes.
            master_key: 32-byte master key.
            salt: 16-byte salt.
            nonce: 8-byte nonce.
            padding_fill: Byte value for padding (None = random, 0 = zero-fill).
        """
        if len(salt) != 16:
            raise ValueError(f"salt must be 16 bytes, got {len(salt)}")
        if len(nonce) != 8:
            raise ValueError(f"nonce must be 8 bytes, got {len(nonce)}")

        tier = RemoteStagingSync._select_tier(len(plaintext))
        padded_size = tier - 4  # Reserve 4 bytes for the original length

        # Prepend original length and pad
        padding_needed = padded_size - len(plaintext)
        if padding_needed > 0:
            fill = os.urandom(padding_needed) if padding_fill is None else bytes([padding_fill]) * padding_needed
            padded = plaintext + fill
        else:
            padded = plaintext
        payload = struct.pack(">I", len(plaintext)) + padded

        blob_key = RemoteStagingSync._derive_blob_key(master_key)
        enc_key, integrity_key = \
            RemoteStagingSync._derive_blob_encryption_keys(blob_key, salt)
        ciphertext_tag = RemoteStagingSync._encrypt_and_tag(
            payload, enc_key, integrity_key, nonce
        )
        return salt + nonce + ciphertext_tag

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
        return RemoteStagingSync._obfuscate_core(
            plaintext, master_key,
            salt=os.urandom(16),
            nonce=os.urandom(8),
        )

    @staticmethod
    def _obfuscate_deterministic(
        plaintext: bytes, master_key: bytes, salt: bytes, nonce: bytes
    ) -> bytes:
        """Obfuscate with explicit salt, nonce, and deterministic padding.

        Produces byte-identical output across implementations when called
        with the same (plaintext, master_key, salt, nonce). Delegates to
        ``_obfuscate_core()`` with zero-fill padding for reproducibility.

        Used for cross-platform test vector validation. Production code
        should use ``_obfuscate()`` which uses random salt/nonce/padding.

        Args:
            plaintext: Serialized blob bytes.
            master_key: 32-byte master key.
            salt: 16-byte explicit salt.
            nonce: 8-byte explicit nonce.

        Returns:
            Obfuscated bytes (salt + nonce + ciphertext + tag).

        Raises:
            ValueError: If salt is not 16 bytes or nonce is not 8 bytes.
        """
        return RemoteStagingSync._obfuscate_core(
            plaintext, master_key, salt, nonce, padding_fill=0,
        )

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

            enc_key, integrity_key = \
                RemoteStagingSync._derive_blob_encryption_keys(blob_key, salt)
            expected_tag = hmac.new(
                integrity_key, nonce + ciphertext, hashlib.sha256
            ).digest()

            if not hmac.compare_digest(expected_tag, stored_tag):
                _logger.warning("Blob integrity check failed (tag mismatch)")
                return None

            aes = PureAESCTR(enc_key)
            decrypted = aes.process(ciphertext, nonce)

            # Read original length (first 4 bytes)
            original_len = struct.unpack(">I", decrypted[:4])[0]
            return decrypted[4:4 + original_len]
        except Exception as exc:
            _logger.warning("Blob deobfuscation failed: %s", exc)
            return None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    @trace
    def pull(self, master_key: Optional[bytes] = None, timeout_ms: Optional[int] = None) -> Optional[Dict[str, Any]]:
        """Pull remote blob, deobfuscate, return parsed dict.

        If the blob is obfuscated (non-JSON), requires *master_key* to
        decrypt. Unobfuscated (plain JSON) blobs are accepted for
        backward compatibility.

        Args:
            master_key: 32-byte master key for blob decryption.
                        If None, falls back to ``self._crypto.master_key``
                        if available (authenticated session).
            timeout_ms: Optional timeout in milliseconds forwarded to
                        the transport layer.

        Returns:
            Parsed blob dict with ``entries``, ``device_id``, etc.,
            None if no blob exists on remote,
            or ``BLOB_KEY_MISMATCH`` if a blob exists but cannot be
            decrypted (wrong master key or corrupted data).
        """
        raw_bytes = self._transport.pull(self._blob_path, timeout_ms=timeout_ms) if timeout_ms is not None else self._transport.pull(self._blob_path)
        if raw_bytes is None:
            return None

        # Try plaintext JSON first (backward compat / unobfuscated)
        try:
            return json.loads(raw_bytes.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            pass

        # Resolve effective key: explicit arg > crypto.master_key > stored key
        effective_key = (
            master_key
            or getattr(self._crypto, "master_key", None)
            or self._master_key
        )

        # Try deobfuscation if we have a key
        if isinstance(effective_key, bytes) and len(effective_key) == 32:
            plaintext = self._deobfuscate(raw_bytes, effective_key)
            if plaintext is not None:
                try:
                    return json.loads(plaintext.decode("utf-8"))
                except (json.JSONDecodeError, UnicodeDecodeError):
                    pass

        # Raw bytes exist but we can't decrypt — key mismatch or corruption
        return BLOB_KEY_MISMATCH

    @trace
    def push(self, entries: List[Dict[str, Any]], device_id: str, master_key: Optional[bytes] = None, timeout_ms: Optional[int] = None):
        """Encrypt entries into blob format, obfuscate, and push via transport.

        Obfuscation happens when a *master_key* is available (either passed
        directly or stored via ``_master_key``). Falls back to plaintext JSON
        when no key is available (e.g., unauthenticated sessions).

        Args:
            entries: List of staging entry dicts (encrypted, raw format).
            device_id: This device's UUID for the blob header.
            master_key: 32-byte master key for blob obfuscation.
                        Falls back to ``self._master_key`` if not provided.
            timeout_ms: Optional timeout in milliseconds forwarded to
                        the transport layer.
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

        self._transport.push(self._blob_path, blob_bytes, timeout_ms=timeout_ms) if timeout_ms is not None else self._transport.push(self._blob_path, blob_bytes)

    @trace
    def check_device(self, master_key: Optional[bytes] = None) -> bool:
        """Compare local device_id with remote blob's device_id.

        Args:
            master_key: Optional 32-byte key for deobfuscating the blob.

        Returns:
            True if remote blob matches this device (or no remote blob),
            False if device mismatch (re-auth may be needed).
        """
        blob = self.pull(master_key=master_key)
        if blob is None or blob is BLOB_KEY_MISMATCH:
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
        if blob is None or blob is BLOB_KEY_MISMATCH:
            return None
        return blob.get("device_id")

    @trace
    def pull_cookie(self, timeout_ms: Optional[int] = None) -> Optional[bytes]:
        """Pull only the device cookie file from remote.

        The cookie is a small JSON blob (device_specifier + device_uuid).
        This is orders of magnitude faster than pulling + decrypting the
        full staging blob (~64KB+).

        Args:
            timeout_ms: Optional timeout in milliseconds forwarded to
                        the transport layer.

        Returns:
            Raw cookie bytes (JSON), or None if no cookie exists on remote.
        """
        return self._transport.pull(REMOTE_COOKIE_PATH, timeout_ms=timeout_ms) if timeout_ms is not None else self._transport.pull(REMOTE_COOKIE_PATH)

    @trace
    def push_cookie(self, cookie_bytes: bytes, timeout_ms: Optional[int] = None):
        """Push the device cookie to remote.

        Args:
            cookie_bytes: JSON bytes of {"device_uuid": ..., "device_specifier": ...}.
            timeout_ms: Optional timeout in milliseconds forwarded to
                        the transport layer.
        """
        self._transport.push(REMOTE_COOKIE_PATH, cookie_bytes, timeout_ms=timeout_ms) if timeout_ms is not None else self._transport.push(REMOTE_COOKIE_PATH, cookie_bytes)

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
            result = self._transport.pull(self._blob_path, timeout_ms=timeout_ms) if timeout_ms is not None else self._transport.pull(self._blob_path)
            elapsed_ms = (_time.monotonic() - start) * 1000
            if elapsed_ms > timeout_ms:
                return False
            # Transport responded — treat as available even if blob is empty
            return True
        except Exception:
            return False
