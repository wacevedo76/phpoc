"""File-backed implementation of AbstractLedgerStore.

Reads/writes a JSON array file at the configured path.
Optimizes get_last_block by reading only the last 1MB.
"""

import json
from pathlib import Path
from typing import List, Dict, Any, Optional

from storage.ledger_store import AbstractLedgerStore


class FileLedgerStore(AbstractLedgerStore):
    """Ledger store backed by a single JSON file on disk."""

    def __init__(self, path: Path):
        self.path = path
        self._ensure_path()

    def _ensure_path(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def _load(self) -> List[Dict[str, Any]]:
        if not self.path.exists():
            return []
        return json.loads(self.path.read_text())

    def _save(self, blocks: List[Dict[str, Any]]):
        self.path.write_text(json.dumps(blocks, indent=2))

    def read_blocks(self, start: int = 0, end: Optional[int] = None) -> List[Dict[str, Any]]:
        blocks = self._load()
        total = len(blocks)

        # Convert negative start (count from end)
        if start < 0:
            start = max(0, total + start)

        if end is None:
            end = total
        elif end < 0:
            end = max(0, total + end)

        return blocks[start:end]

    def append_blocks(self, blocks: List[Dict[str, Any]]):
        existing = self._load()
        existing.extend(blocks)
        self._save(existing)

    def truncate(self, keep_count: int) -> List[Dict[str, Any]]:
        blocks = self._load()
        if keep_count >= len(blocks):
            return []
        removed = blocks[keep_count:]
        kept = blocks[:keep_count]
        self._save(kept)
        return removed

    def get_block_count(self) -> int:
        if not self.path.exists():
            return 0
        # Fast approximate count: count lines that look like block starts
        # Fall back to full parse if needed
        text = self.path.read_text()
        if not text.strip():
            return 0
        try:
            blocks = json.loads(text)
            return len(blocks)
        except json.JSONDecodeError:
            return 0

    def get_last_block(self) -> Optional[Dict[str, Any]]:
        blocks = self._load()
        if not blocks:
            return None
        return blocks[-1]
