"""File-backed implementation of AbstractStagingStore.

Reads/writes a JSON file at the configured path.
Initializes with an empty list if the file does not exist.
"""

import json
from pathlib import Path
from typing import List, Dict, Any

from storage.staging_store import AbstractStagingStore


class FileStagingStore(AbstractStagingStore):
    """Staging store backed by a single JSON file on disk."""

    def __init__(self, path: Path):
        self.path = path
        self._ensure_path()
        if not self.path.exists():
            self.write_entries([])

    def _ensure_path(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def read_entries(self) -> List[Dict[str, Any]]:
        if not self.path.exists():
            return []
        return json.loads(self.path.read_text())

    def write_entries(self, data: List[Dict[str, Any]]):
        self.path.write_text(json.dumps(data, indent=2))

    def append_entry(self, entry: Dict[str, Any]):
        entries = self.read_entries()
        entries.append(entry)
        self.write_entries(entries)

    def remove_entries(self, indices: List[int]):
        entries = self.read_entries()
        for idx in sorted(indices, reverse=True):
            if 0 <= idx < len(entries):
                entries.pop(idx)
        self.write_entries(entries)

    def update_entry(self, index: int, fields: Dict[str, Any]):
        entries = self.read_entries()
        if 0 <= index < len(entries):
            entries[index].update(fields)
            self.write_entries(entries)
