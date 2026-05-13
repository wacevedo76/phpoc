"""File-backed implementation of AbstractIdentityStore.

Reads/writes a JSON dict file at the configured path.
Returns None if the file does not exist.
"""

import json
from pathlib import Path
from typing import Dict, Any, Optional

from storage.identity_store import AbstractIdentityStore


class FileIdentityStore(AbstractIdentityStore):
    """Identity cache backed by a single JSON file on disk."""

    def __init__(self, path: Path):
        self.path = path
        self._ensure_path()

    def _ensure_path(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def read_identity(self) -> Optional[Dict[str, Any]]:
        if not self.path.exists():
            return None
        return json.loads(self.path.read_text())

    def write_identity(self, data: Dict[str, Any]):
        self.path.write_text(json.dumps(data, indent=2))
