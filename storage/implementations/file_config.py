"""File-backed implementation of AbstractConfigStore.

Reads/writes a JSON dict file at the configured path.
Does NOT auto-initialize with defaults — the ConfigManager handles that.
"""

import json
from pathlib import Path
from typing import Dict, Any, Optional

from storage.config_store import AbstractConfigStore


class FileConfigStore(AbstractConfigStore):
    """Config store backed by a single JSON file on disk."""

    def __init__(self, path: Path):
        self.path = path
        self._ensure_path()

    def _ensure_path(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def read_config(self) -> Optional[Dict[str, Any]]:
        if not self.path.exists():
            return None
        text = self.path.read_text().strip()
        if not text:
            return None
        return json.loads(text)

    def write_config(self, data: Dict[str, Any]):
        self.path.write_text(json.dumps(data, indent=2))
