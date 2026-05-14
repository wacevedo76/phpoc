"""File-backed implementation of AbstractConfigStore.

Reads/writes a JSON dict file at the configured path.
Does NOT auto-initialize with defaults — the ConfigManager handles that.

Supports XDG config path resolution:
  1. $PHPOC_CONFIG env var (explicit path)
  2. $XDG_CONFIG_HOME/phpoc/config.json
  3. ~/.config/phpoc/config.json (XDG default)
"""

import json
import os
from pathlib import Path
from typing import Dict, Any, Optional, TYPE_CHECKING

from storage.config_store import AbstractConfigStore

if TYPE_CHECKING:
    from security.config_manager import ConfigManager


def _resolve_config_path(overridden_path: Optional[Path] = None) -> Path:
    """Resolve the config file path, with priority:
    1. Explicit overridden_path argument
    2. $PHPOC_CONFIG environment variable
    3. $XDG_CONFIG_HOME/phpoc/config.json
    4. ~/.config/phpoc/config.json (XDG default)
    """
    if overridden_path is not None:
        return overridden_path

    env_path = os.environ.get("PHPOC_CONFIG")
    if env_path:
        return Path(env_path)

    xdg_config_home = os.environ.get("XDG_CONFIG_HOME")
    if xdg_config_home:
        return Path(xdg_config_home) / "phpoc" / "config.json"

    return Path.home() / ".config" / "phpoc" / "config.json"


def _resolve_data_dir(overridden_dir: Optional[Path] = None,
                       config_manager: Optional['ConfigManager'] = None) -> Path:
    """Resolve the data directory path, with priority:
    1. Explicit overridden_dir argument (--dir CLI flag at runtime)
    2. $PHPOC_DATA_DIR environment variable (per-session override)
    3. Config file storage.data_dir value (persistent per-ledger setting)
    4. XDG base directory: $XDG_DATA_HOME/phpoc
    5. ~/.local/share/phpoc (XDG default)

    The data directory holds ledger.json, index.json, staging.json, etc.
    This is intentionally separate from the config file location.

    Args:
        overridden_dir: Explicit path from CLI --dir flag, highest priority.
        config_manager: Optional ConfigManager to read storage.data_dir
                        as a persistent override below env var but above XDG.
    """
    if overridden_dir is not None:
        return overridden_dir

    env_dir = os.environ.get("PHPOC_DATA_DIR")
    if env_dir:
        return Path(env_dir)

    # Check config file for persistent data_dir override
    if config_manager is not None:
        try:
            cfg_dir = config_manager.get("storage.data_dir")
            if cfg_dir:
                return Path(cfg_dir)
        except Exception:
            pass

    xdg_data_home = os.environ.get("XDG_DATA_HOME")
    if xdg_data_home:
        return Path(xdg_data_home) / "phpoc"

    return Path.home() / ".local" / "share" / "phpoc"


class FileConfigStore(AbstractConfigStore):
    """Config store backed by a single JSON file on disk."""

    def __init__(self, path: Optional[Path] = None):
        if path is None:
            path = _resolve_config_path()
        self.path = path

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
        self._ensure_path()
        self.path.write_text(json.dumps(data, indent=2))
