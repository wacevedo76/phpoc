"""Device Identity Provider — UUID-based device identity with HMAC proof.

Each device gets a random UUID4 on first init (stored in config). The device
identity includes a cryptographic proof — HMAC-SHA256 over the device ID
using the master key — allowing other devices to independently verify that
the proof holder knows the same master key.

This prevents impersonation: an attacker needs *both* the UUID and the
master key to forge a device identity.
"""

import uuid
import hmac
import hashlib
import socket
from abc import ABC, abstractmethod
from typing import Optional, Tuple

# ── I-09: device ID derivation constants ─────────────────────────

DEVICE_ID_PREFIX = "phpoc:device:"


def derive_device_id(master_key: bytes, device_local_secret: str) -> str:
    """Derive a device ID from MK + per-device secret (I-09).

    ``device_id = HMAC-SHA256(MK, "phpoc:device:" + device_local_secret)``

    Binds the device ID to both the MK and a per-device random secret,
    ensuring different devices with the same passphrase get different IDs.

    Args:
        master_key: 32-byte master key.
        device_local_secret: Per-device UUID4 secret string.

    Returns:
        64-char hex string device identifier.

    Raises:
        ValueError: If master_key is empty/None/short, or secret is empty/None.
    """
    if not master_key or len(master_key) < 32:
        raise ValueError("master_key must be at least 32 bytes")
    if not device_local_secret:
        raise ValueError("device_local_secret must not be empty")
    return hmac.new(
        master_key,
        f"{DEVICE_ID_PREFIX}{device_local_secret}".encode(),
        hashlib.sha256,
    ).hexdigest()


class DeviceIdentity:
    """An opaque device identity with a verifiable proof.

    Attributes:
        device_id: Stable UUID4 string, unique per device, never changes.
        device_proof: HMAC-SHA256(mk, "phpoc:device:" + device_id).
        device_label: Human-readable name (e.g., "MacBook Air").
    """

    def __init__(
        self,
        device_id: str = "",
        device_proof: str = "",
        device_label: str = "",
    ):
        self.device_id = device_id
        self.device_proof = device_proof
        self.device_label = device_label


class AbstractDeviceIdentityProvider(ABC):
    """Pluggable strategy for generating and resolving device identities.

    Implementations control HOW a device gets its identity:
    - Random UUID (recommended for simple use)
    - Hardware-bound (TPM, secure enclave)
    - OS-provided (/etc/machine-id)
    - User-chosen label + salt
    - Hybrid (UUID + HMAC proof)
    """

    @abstractmethod
    def get_device_identity(self, master_key: bytes) -> DeviceIdentity:
        """Return this device's stable identity.

        Called once per session (or once per cached auth window).
        The implementation decides whether to generate, read from config,
        or derive from hardware.
        """
        pass

    @abstractmethod
    def verify_device_proof(
        self, device_id: str, device_proof: str, master_key: bytes
    ) -> bool:
        """Verify that a device_proof matches a given device_id and master_key.

        This is the cross-device check: when device B encounters a blob
        last touched by device A, it verifies A's proof independently.
        """
        pass

    @abstractmethod
    def check_remote_identity(
        self,
        remote_device_id: str,
        remote_device_proof: str,
        local_identity: DeviceIdentity,
        master_key: bytes,
    ) -> bool:
        """Check if the remote blob's last device matches this device.

        Returns True if remote was last touched by THIS device
        (no re-auth needed). Returns False if different device
        (pull + merge required before modifying).
        """
        pass


class RandomUUIDDeviceIdentityProvider(AbstractDeviceIdentityProvider):
    """Device identity via random UUID, stored in config.

    Translates to any stack:
    - Python: uuid4()
    - JavaScript: crypto.randomUUID()
    - Rust: Uuid::new_v4()
    - Go: uuid.New()
    - Swift: UUID()
    - Kotlin: UUID.randomUUID()
    """

    PROOF_PREFIX = DEVICE_ID_PREFIX
    CLIENT_TYPE = "cli"  # Bug 3a fix: client suffix for cross-client identity

    def __init__(self, config_manager):
        """Initialize with a ConfigManager for persisting the device_id.

        Args:
            config_manager: An object with ``read() -> dict`` and
                           ``write(config: dict) -> None`` methods
                           (duck-typed ConfigManager interface).
        """
        self._config = config_manager
        self._cached_identity: Optional[DeviceIdentity] = None

    def _resolve_device_id(
        self, master_key: bytes, config: dict
    ) -> str:
        """Resolve the device_id from config, preferring I-09 derivation.

        I-09 main path: derive from MK + device_local_secret via HMAC.
        Legacy fallback: reuse or generate a bare UUID4 from config.
        """
        device_local_secret = config.get("device_local_secret", "")

        if device_local_secret:
            core_id = derive_device_id(master_key, device_local_secret)
            return f"{core_id}-{self.CLIENT_TYPE}"

        # Legacy fallback: old config without device_local_secret
        current_id = config.get("device_id", "")
        if not current_id:
            return f"{uuid.uuid4()}-{self.CLIENT_TYPE}"
        if not current_id.endswith(f"-{self.CLIENT_TYPE}"):
            return f"{current_id}-{self.CLIENT_TYPE}"
        return current_id

    def get_device_identity(self, master_key: bytes) -> DeviceIdentity:
        if self._cached_identity is not None:
            return self._cached_identity

        config = self._config.read()
        device_id = self._resolve_device_id(master_key, config)

        if device_id != config.get("device_id"):
            config["device_id"] = device_id
            config["device_label"] = config.get(
                "device_label", socket.gethostname()
            )
            self._config.write(config)

        device_label = config.get("device_label", device_id[:8])

        # Proof = HMAC(mk, "phpoc:device:" + device_id)
        proof = hmac.new(
            master_key,
            f"{self.PROOF_PREFIX}{device_id}".encode(),
            hashlib.sha256,
        ).hexdigest()

        identity = DeviceIdentity(
            device_id=device_id,
            device_proof=proof,
            device_label=device_label,
        )
        self._cached_identity = identity
        return identity

    def verify_device_proof(
        self, device_id: str, device_proof: str, master_key: bytes
    ) -> bool:
        expected = hmac.new(
            master_key,
            f"{self.PROOF_PREFIX}{device_id}".encode(),
            hashlib.sha256,
        ).hexdigest()
        return hmac.compare_digest(expected, device_proof)

    def check_remote_identity(
        self,
        remote_device_id: str,
        remote_device_proof: str,
        local_identity: DeviceIdentity,
        master_key: bytes,
    ) -> bool:
        # First verify the remote's proof is valid (proves they know MK)
        if not self.verify_device_proof(
            remote_device_id, remote_device_proof, master_key
        ):
            return False
        # Then check if it's the same physical device
        return remote_device_id == local_identity.device_id
