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
from typing import Optional


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

    PROOF_PREFIX = "phpoc:device:"
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

    def get_device_identity(self, master_key: bytes) -> DeviceIdentity:
        if self._cached_identity is not None:
            return self._cached_identity

        config = self._config.read()

        current_id = config.get("device_id", "")

        # Bug 3a fix: Ensure device_id has -cli suffix for cross-client identity.
        # Migration: bare UUIDs get -cli appended. Already-suffixed UUIDs
        # stay as-is. New installations get fresh uuid4-cli.
        if not current_id:
            current_id = f"{uuid.uuid4()}-{self.CLIENT_TYPE}"
        elif not current_id.endswith(f"-{self.CLIENT_TYPE}"):
            # Append suffix to existing bare UUID (migration)
            current_id = f"{current_id}-{self.CLIENT_TYPE}"

        if current_id != config.get("device_id"):
            config["device_id"] = current_id
            config["device_label"] = config.get(
                "device_label", socket.gethostname()
            )
            self._config.write(config)

        device_id = config["device_id"]
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
