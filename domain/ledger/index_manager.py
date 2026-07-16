"""IndexManager: blind index of durations by date and title.

A lightweight key-value cache mapping dates to title-to-duration maps.
Derived from the ledger chain and can be fully rebuilt if lost.
"""

import json
from typing import Dict, Any, Optional

from storage.index_store import AbstractIndexStore


class IndexManager:
    """Manages a blind index of {date: {title: total_duration_ms}}.

    Thread-safe via assumption of single-writer pattern (all mutations
    go through the store).

    The index is purely derived data — it can be fully rebuilt from
    the ledger chain using rebuild_from_chain().

    When *crypto* is provided, the index is encrypted at rest using
    AES-128-CTR. Legacy plaintext indices are auto-detected and
    upgraded on next write.
    """

    def __init__(self, store: AbstractIndexStore, crypto=None):
        self.store = store
        self._crypto = crypto
        self._cache: Dict[str, Any] = {}
        self._load()

    def _load(self):
        """Load index from store into memory cache.

        Detects encrypted vs legacy plaintext format automatically:
        - Dict with ``_enc`` key → decrypt
        - Plain dict → legacy, use as-is
        - Empty/falsy → start with empty cache
        """
        stored = self.store.read_index()
        if not stored:
            self._cache = {}
            return
        if isinstance(stored, dict) and "_enc" in stored:
            # Encrypted format
            if self._crypto is not None:
                try:
                    plain = self._crypto.decrypt(stored["_enc"])
                    self._cache = json.loads(plain)
                except Exception:
                    self._cache = {}
            else:
                self._cache = {}
        elif isinstance(stored, dict):
            # Legacy plaintext format
            self._cache = dict(stored)
        else:
            self._cache = {}

    def _flush(self):
        """Write in-memory cache back to store.

        Encrypts the full index dict as JSON when crypto is available.
        Uses ``{"_enc": "<hex_ciphertext>"}`` wrapper format so
        legacy plaintext readers can skip encrypted blobs cleanly.
        """
        if self._crypto is not None:
            plain = json.dumps(self._cache, sort_keys=True)
            encrypted = self._crypto.encrypt(plain)
            self.store.write_index({"_enc": encrypted})
        else:
            self.store.write_index(dict(self._cache))

    def reload(self):
        """Reload cache from the underlying store.

        Call this when an external component may have written to the
        store directly (e.g., legacy code paths).
        """
        self._cache = {}
        self._load()

    def get_all(self) -> Dict[str, Any]:
        """Return a copy of the full index."""
        return dict(self._cache)

    def update(self, date: str, title: str, duration_delta: int):
        """Add or subtract duration for a title on a given date.

        If duration_delta is negative and causes the total to go to
        zero or below, the title entry is removed from that date's
        dict. If the date dict becomes empty, the date is removed.

        Args:
            date: ISO date string (YYYY-MM-DD).
            title: Activity title.
            duration_delta: Duration in ms to add (positive) or
                subtract (negative).
        """
        if date not in self._cache:
            if duration_delta <= 0:
                return
            self._cache[date] = {}

        old = self._cache[date].get(title, 0)
        new = old + duration_delta

        if new <= 0:
            # Remove the title entry; if date is now empty, remove the date too
            if title in self._cache[date]:
                del self._cache[date][title]
            if not self._cache[date]:
                del self._cache[date]
        else:
            self._cache[date][title] = new

        self._flush()

    def query(self, from_date: str, to_date: str) -> Dict[str, int]:
        """Aggregate durations by title over a date range.

        Args:
            from_date: Start date (inclusive), ISO format.
            to_date: End date (inclusive), ISO format.

        Returns:
            Dict of {title: total_ms} over the range. Empty dict if
            no data or from_date > to_date.
        """
        if from_date > to_date or not self._cache:
            return {}

        result: Dict[str, int] = {}
        for date_str, titles in self._cache.items():
            if from_date <= date_str <= to_date:
                for title, duration in titles.items():
                    result[title] = result.get(title, 0) + duration
        return result

    def clear(self):
        """Clear all index data."""
        self._cache = {}
        self._flush()
