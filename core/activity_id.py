"""ActivityIdGenerator — CSPRNG activity ID generation for row-level staging.

Produces 10-character alphanumeric IDs (62^10 ≈ 8.4×10^17 space).
Uses ``secrets.choice`` for cryptographic randomness.

Port of ``phpoc-flutter/lib/data/sync/activity_id.dart``.
"""

import re
import secrets

_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
_LENGTH = 10
_VALID_PATTERN = re.compile(r"^[A-Za-z0-9]{10}$")


class ActivityIdGenerator:
    """CSPRNG activity ID generator for row-level staging."""

    @staticmethod
    def generateActivityId() -> str:
        """Generate a 10-character alphanumeric activity ID.

        Returns:
            A 10-character string from [A-Za-z0-9].
        """
        return "".join(secrets.choice(_ALPHABET) for _ in range(_LENGTH))

    @staticmethod
    def isValidActivityId(value: str | None) -> bool:
        """Validate that *value* is a well-formed activity ID.

        Args:
            value: String to validate, or None.

        Returns:
            True if *value* is a 10-char alphanumeric string, False otherwise.
        """
        if value is None:
            return False
        return bool(_VALID_PATTERN.match(value))
