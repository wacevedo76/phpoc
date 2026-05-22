"""Configuration manager — reads/writes user-editable config with defaults.

The config file lives at:
  1. $PHPOC_CONFIG (env var)
  2. $XDG_CONFIG_HOME/phpoc/config.json
  3. ~/.config/phpoc/config.json (XDG default)

All fields have defaults. Missing fields are filled from DEFAULTS.
The file is user-editable — no validation beyond JSON parsing.
"""

from pathlib import Path
from typing import Dict, Any, Optional


class ConfigManager:
    """Read/write config.json with defaults.

    Use dot-notation get() for nested access:
      config.get("remote.staging_path")
      config.get("auth.cache_timeout_minutes", 30)

    The config is cached in memory after first read.
    """

    DEFAULTS: Dict[str, Any] = {
        "storage": {
            "config_dir": str(Path.home() / ".config" / "phpoc"),
            "data_dir": str(Path.home() / ".local" / "share" / "phpoc"),
            "ledger": "ledger.json",
            "staging": "staging.json",
            "index": "index.json",
            "identity": "identity.json",
            "config": "config.json",
        },
        "remote": {
            "staging_path": None,
            "ledger_path": None,
            "transport": "git",
            "git_remote_url": None,
        },
        "auth": {
            "cache_timeout_minutes": 30,
            "passphrase_required": True,
        },
        "device": {
            "device_id": None,
            "device_label": None,
        },
        "timeouts": {
            "remote_check_ms": 500,
            "push_timeout_ms": 5000,
        },
        "debug": {
            "trace_enabled": False,
        },
        "staging": {
            "blob_size_tier": "64K",
        },
    }

    def __init__(self, config_store):
        """Initialize with a config store (typically FileConfigStore).

        Args:
            config_store: An instance implementing AbstractConfigStore.
        """
        self._store = config_store
        self._config: Optional[Dict[str, Any]] = None

    def read(self) -> Dict[str, Any]:
        """Read config from store, merging with defaults.

        Returns:
            Full config dict with all fields populated via defaults.
        """
        if self._config is not None:
            return self._config
        raw = self._store.read_config() or {}
        self._config = self._deep_merge(self.DEFAULTS, raw)
        return self._config

    def write(self, config: Dict[str, Any]):
        """Persist config to store and update in-memory cache.

        Args:
            config: Full or partial config dict to persist.
        """
        # Merge with current to preserve fields not in the write
        current = self.read()
        merged = self._deep_merge(current, config)
        self._config = merged
        self._store.write_config(config)

    def get(self, key_path: str, default=None):
        """Access nested config using dot notation.

        Examples:
          config.get("remote.staging_path")
          config.get("auth.cache_timeout_minutes", 30)
          config.get("nonexistent.key", "fallback")

        Args:
            key_path: Dot-separated path to the config value.
            default: Value to return if the key is missing or None.

        Returns:
            The config value at key_path, or default if not found.
        """
        keys = key_path.split(".")
        value = self.read()
        for key in keys:
            if not isinstance(value, dict):
                return default
            if key not in value:
                return default
            value = value[key]
        return value if value is not None else default

    @staticmethod
    def _deep_merge(defaults: dict, overrides: dict) -> dict:
        """Recursively merge overrides into defaults.

        Args:
            defaults: Base dict (all expected keys).
            overrides: User-supplied dict (may be partial).

        Returns:
            New dict with all keys from defaults, overridden by overrides.
        """
        result = {}
        for key, default_val in defaults.items():
            if key in overrides:
                override_val = overrides[key]
                if isinstance(default_val, dict) and isinstance(override_val, dict):
                    result[key] = ConfigManager._deep_merge(default_val, override_val)
                else:
                    result[key] = override_val
            else:
                result[key] = default_val
        # Include any extra keys from overrides not in defaults
        for key in overrides:
            if key not in result:
                result[key] = overrides[key]
        return result
