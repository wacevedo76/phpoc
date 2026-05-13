"""File-backed implementation of AbstractIndexStore.

Reads/writes a JSON dict file at the configured path.
Initializes with an empty dict if the file does not exist.
"""

import json
from pathlib import Path
from typing import Dict, Any

from storage.index_store import AbstractIndexStore


class FileIndexStore(AbstractIndexStore):
    """Blind index backed by a single JSON file on disk."""

    def __init__(self, path: Path):
        self.path = path
        self._ensure_path()

    def _ensure_path(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def read_index(self) -> Dict[str, Any]:
        if not self.path.exists():
            return {}
        return json.loads(self.path.read_text())

    def write_index(self, data: Dict[str, Any]):
        self.path.write_text(json.dumps(data, indent=2))
