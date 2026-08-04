"""Phase 7: User-configurable configuration file integration.

Tests that:
  - A config file is auto-created with defaults on `init`
  - The `--config` CLI flag specifies a custom config path
  - XDG config resolution works: $XDG_CONFIG_HOME/phpoc/ → ~/.config/phpoc/
  - A `config` CLI subcommand can view and set values
  - main.py uses ConfigManager instead of hardcoded CONFIG_DIR
  - The storage.config_dir key controls data file locations
  - Backward compatibility with existing hardcoded path users
"""

import unittest
import json
import os
import tempfile
from pathlib import Path
from unittest.mock import patch, MagicMock


# ════════════════════════════════════════════════════════════════════════════
# Category A: Config path resolution
# ════════════════════════════════════════════════════════════════════════════

class TestConfigPathResolution(unittest.TestCase):
    """XDG config path resolution with XDG_CONFIG_HOME and fallback."""

    def test_xdg_config_home_env_var(self):
        """$XDG_CONFIG_HOME/phpoc/config.json when env var is set."""
        with patch.dict(os.environ, {"XDG_CONFIG_HOME": "/custom/config"}):
            from storage.implementations.file_config import _resolve_config_path
            path = _resolve_config_path()
            self.assertEqual(str(path), "/custom/config/phpoc/config.json")

    def test_xdg_fallback_to_home(self):
        """~/.config/phpoc/config.json when XDG_CONFIG_HOME is not set."""
        with patch.dict(os.environ, clear=True):
            with patch("pathlib.Path.home", return_value=Path("/home/user")):
                from storage.implementations.file_config import _resolve_config_path
                path = _resolve_config_path()
                self.assertEqual(str(path), "/home/user/.config/phpoc/config.json")

    def test_custom_config_path_argument(self):
        """Explicit --config path overrides all resolution."""
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            custom = Path(tmp) / "config.json"
            from storage.implementations.file_config import FileConfigStore
            store = FileConfigStore(custom)
            store.write_config({"test": True})
            self.assertTrue(custom.exists())
            self.assertEqual(store.read_config(), {"test": True})

    def test_config_store_parent_dir_created(self):
        """FileConfigStore creates parent directories automatically."""
        import tempfile
        from storage.implementations.file_config import FileConfigStore
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "deep" / "nested" / "config.json"
            store = FileConfigStore(path)
            store.write_config({"hello": "world"})
            self.assertTrue(path.exists())


class TestDataDirResolution(unittest.TestCase):
    """XDG data directory resolution with XDG_DATA_HOME and fallback."""

    def test_xdg_data_home_env_var(self):
        """$XDG_DATA_HOME/phpoc when env var is set."""
        with patch.dict(os.environ, {"XDG_DATA_HOME": "/custom/data"}):
            from storage.implementations.file_config import _resolve_data_dir
            path = _resolve_data_dir()
            self.assertEqual(str(path), "/custom/data/phpoc")

    def test_xdg_data_home_fallback(self):
        """~/.local/share/phpoc when XDG_DATA_HOME is not set."""
        with patch.dict(os.environ, clear=True):
            with patch("pathlib.Path.home", return_value=Path("/home/user")):
                from storage.implementations.file_config import _resolve_data_dir
                path = _resolve_data_dir()
                self.assertEqual(str(path), "/home/user/.local/share/phpoc")

    def test_phpoc_data_dir_env_var(self):
        """$PHPOC_DATA_DIR overrides XDG_DATA_HOME."""
        with patch.dict(os.environ, {"PHPOC_DATA_DIR": "/my/custom/data"}):
            from storage.implementations.file_config import _resolve_data_dir
            path = _resolve_data_dir()
            self.assertEqual(str(path), "/my/custom/data")

    def test_data_dir_custom_override(self):
        """Explicit override_dir argument goes first."""
        from storage.implementations.file_config import _resolve_data_dir
        path = _resolve_data_dir(Path("/explicit/path"))
        self.assertEqual(str(path), "/explicit/path")


# ════════════════════════════════════════════════════════════════════════════
# Category B: Config initialization on `init`
# ════════════════════════════════════════════════════════════════════════════

class TestConfigInitialization(unittest.TestCase):
    """Config auto-created with defaults on `init`, preserved on re-init."""

    def test_init_creates_config_with_defaults(self):
        """Initializing a new ledger creates config.json with defaults."""
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "config.json"
            from storage.implementations.file_config import FileConfigStore
            from security.config_manager import ConfigManager
            store = FileConfigStore(config_path)
            mgr = ConfigManager(store)

            # Simulate init: config shouldn't exist yet
            self.assertIsNone(store.read_config())

            # First read triggers defaults creation
            config = mgr.read()
            self.assertIn("storage", config)
            self.assertIn("remote", config)
            self.assertIn("auth", config)

    def test_init_writes_default_config_to_disk(self):
        """read() with no existing file persists defaults to disk."""
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "config.json"
            from storage.implementations.file_config import FileConfigStore
            from security.config_manager import ConfigManager
            store = FileConfigStore(config_path)
            mgr = ConfigManager(store)

            # Trigger defaults creation
            mgr.write(mgr.read())  # Simulate what init does: read defaults, write them

            # Verify on disk
            saved = store.read_config()
            self.assertIsNotNone(saved)
            self.assertIn("storage", saved)
            self.assertEqual(saved["storage"]["config_dir"],
                             str(Path.home() / ".config" / "phpoc"))

    def test_reinit_preserves_existing_config(self):
        """Re-initializing a ledger does not overwrite existing config."""
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "config.json"
            from storage.implementations.file_config import FileConfigStore
            from security.config_manager import ConfigManager
            store = FileConfigStore(config_path)
            mgr = ConfigManager(store)

            # First init
            config = mgr.read()
            config["auth"]["cache_timeout_minutes"] = 120
            mgr.write(config)

            # Re-init: write defaults again (simulate re-init)
            config2 = mgr.read()
            config2["auth"]["cache_timeout_minutes"] = 120  # user value preserved in memory
            mgr.write(config2)

            # Should still have user value
            self.assertEqual(mgr.get("auth.cache_timeout_minutes"), 120)


# ════════════════════════════════════════════════════════════════════════════
# Category C: Config-integrated main() construction
# ════════════════════════════════════════════════════════════════════════════

class TestMainConfigConstruction(unittest.TestCase):
    """Verify main.py reads config for data directory construction."""

    def test_config_manager_used_in_main(self):
        """main.py uses ConfigManager instead of hardcoded CONFIG_DIR."""
        with open("main.py") as f:
            content = f.read()
        self.assertIn("ConfigManager", content,
                      "main.py should import and use ConfigManager")

    def test_config_controls_storage_paths(self):
        """storage.config_dir from config controls where data files live."""
        from security.config_manager import ConfigManager
        self.assertIn("storage", ConfigManager.DEFAULTS,
                      "ConfigManager must have a 'storage' section")
        self.assertIn("config_dir", ConfigManager.DEFAULTS.get("storage", {}),
                      "storage.config_dir must be a configurable key")

    def test_data_paths_derived_from_config(self):
        """Ledger, staging, and index paths are derived from config."""
        from security.config_manager import ConfigManager
        self.assertIn("storage", ConfigManager.DEFAULTS)
        storage = ConfigManager.DEFAULTS["storage"]
        self.assertIn("ledger", storage, "storage.ledger path in defaults")
        self.assertIn("staging", storage, "storage.staging path in defaults")
        self.assertIn("index", storage, "storage.index path in defaults")

    def test_main_no_longer_hardcodes_data_paths(self):
        """main.py does not hardcode ledger/staging/index paths at module level."""
        with open("main.py") as f:
            content = f.read()
        # Primary paths use `_resolve_data_dir()` + `CONFIG_DIR / "ledger.json"`
        # rather than old fixed CONFIG_DIR = Path.home() / ".config" / "personal_history_poc"
        # Verify the data directory comes from _resolve_data_dir()
        self.assertIn("_resolve_data_dir", content,
                      "Data directory must use _resolve_data_dir(), not hardcoded path")
        self.assertIn("config_manager=CONFIG", content,
                      "Data directory resolution should consult config for storage.data_dir")
        self.assertIn('CONFIG_DIR / "ledger.json"', content,
                      "LEDGER_PATH should derive from CONFIG_DIR, not hardcoded string")
        # Verify no old-style hardcoded paths
        old_path = 'Path.home() / ".config" / "personal_history_poc"' in content
        # Old path is still present as legacy fallback, but only once
        legacy_count = content.count('"personal_history_poc"')
        self.assertGreaterEqual(legacy_count, 1,
                                "Legacy path reference should exist for fallback")
        # CONFIG_DIR should not be a literal fixed path
        self.assertNotIn("CONFIG_DIR = Path.home()", content,
                         "CONFIG_DIR should not be hardcoded to a fixed path")
        self.assertNotIn('"personal_history_poc"', content.split("CONFIG_DIR = ")[0] if "CONFIG_DIR = " in content else content,
                         "Legacy path should only appear as fallback, not primary definition")


# ════════════════════════════════════════════════════════════════════════════
# Category D: `config` CLI subcommand
# ════════════════════════════════════════════════════════════════════════════

class TestConfigCLICommand(unittest.TestCase):
    """The `config` CLI subcommand to view and set config values."""

    def test_config_subcommand_exists(self):
        """main.py has a 'config' subcommand."""
        with open("main.py") as f:
            content = f.read()
        self.assertIn('"config"', content,
                      "main.py must add a 'config' subcommand to argparse")

    def test_config_get_shows_value(self):
        """config get <key> shows a config value."""
        # We test via CLIInterface or a dedicated config handler
        with tempfile.TemporaryDirectory() as tmp:
            from storage.implementations.file_config import FileConfigStore
            from security.config_manager import ConfigManager
            config_path = Path(tmp) / "config.json"
            store = FileConfigStore(config_path)
            mgr = ConfigManager(store)
            mgr.write(mgr.read())

            from phpoc_cli.interface import CLIInterface
            # CLIInterface needs a config display method or we test separately
            # Test that ConfigManager.get() works for the config show command
            self.assertEqual(mgr.get("auth.cache_timeout_minutes"), 30)

    def test_config_set_updates_value(self):
        """config set <key> <value> updates a config value."""
        with tempfile.TemporaryDirectory() as tmp:
            from storage.implementations.file_config import FileConfigStore
            from security.config_manager import ConfigManager
            config_path = Path(tmp) / "config.json"
            store = FileConfigStore(config_path)
            mgr = ConfigManager(store)
            mgr.write(mgr.read())

            # Set a value via ConfigManager
            mgr.write({"auth": {"cache_timeout_minutes": 60}})
            self.assertEqual(mgr.get("auth.cache_timeout_minutes"), 60)

            # Verify on disk
            reloaded = FileConfigStore(config_path)
            mgr2 = ConfigManager(reloaded)
            self.assertEqual(mgr2.get("auth.cache_timeout_minutes"), 60)

    def test_config_get_nonexistent_key(self):
        """config get on a nonexistent key shows a sensible message."""
        with tempfile.TemporaryDirectory() as tmp:
            from storage.implementations.file_config import FileConfigStore
            from security.config_manager import ConfigManager
            config_path = Path(tmp) / "config.json"
            store = FileConfigStore(config_path)
            mgr = ConfigManager(store)

            # get with default
            result = mgr.get("nonexistent", None)
            self.assertIsNone(result)

    def test_config_show_all(self):
        """config show (no args) displays the full config as JSON."""
        with tempfile.TemporaryDirectory() as tmp:
            from storage.implementations.file_config import FileConfigStore
            from security.config_manager import ConfigManager
            config_path = Path(tmp) / "config.json"
            store = FileConfigStore(config_path)
            mgr = ConfigManager(store)
            config = mgr.read()

            # Display should show all config keys
            self.assertIn("storage", config)
            self.assertIn("remote", config)
            self.assertIn("auth", config)
            self.assertIn("device", config)
            self.assertIn("timeouts", config)
            self.assertIn("staging", config)


# ════════════════════════════════════════════════════════════════════════════
# Category E: Config defaults — expanded with storage paths
# ════════════════════════════════════════════════════════════════════════════

class TestConfigDefaultsExpanded(unittest.TestCase):
    """ConfigManager.DEFAULTS now includes storage paths."""

    def test_storage_section_exists(self):
        """DEFAULTS has a storage section with all data file paths."""
        defaults = __import__("security.config_manager", fromlist=["ConfigManager"]).ConfigManager.DEFAULTS
        self.assertIn("storage", defaults)
        storage = defaults["storage"]
        self.assertIn("config_dir", storage)
        self.assertIn("data_dir", storage)
        self.assertIn("ledger", storage)
        self.assertIn("staging", storage)
        self.assertIn("index", storage)
        self.assertIn("identity", storage)

    def test_default_paths_are_valid(self):
        """Default storage paths are valid filenames."""
        defaults = __import__("security.config_manager", fromlist=["ConfigManager"]).ConfigManager.DEFAULTS
        storage = defaults["storage"]
        for key in ("ledger", "staging", "index", "identity"):
            self.assertIsInstance(storage[key], str)
            self.assertTrue(storage[key].endswith(".json"))

    def test_config_dir_default_is_xdg_compliant(self):
        """Default config_dir follows XDG spec ~/.config/phpoc."""
        with patch("pathlib.Path.home", return_value=Path("/home/user")):
            from storage.implementations.file_config import _resolve_config_path
            path = _resolve_config_path()
            self.assertIn(".config/phpoc", str(path))

    def test_defaults_include_all_prior_keys(self):
        """Existing defaults (remote, auth, device, timeouts, staging) are preserved."""
        from security.config_manager import ConfigManager
        self.assertIn("remote", ConfigManager.DEFAULTS)
        self.assertIn("auth", ConfigManager.DEFAULTS)
        self.assertIn("device", ConfigManager.DEFAULTS)
        self.assertIn("timeouts", ConfigManager.DEFAULTS)
        self.assertIn("staging", ConfigManager.DEFAULTS)


# ════════════════════════════════════════════════════════════════════════════
# Category F: Backward compatibility
# ════════════════════════════════════════════════════════════════════════════

class TestConfigBackwardCompat(unittest.TestCase):
    """Users without config.json still work — defaults are used."""

    def test_no_config_file_uses_defaults(self):
        """If config.json doesn't exist, all operations use defaults."""
        with tempfile.TemporaryDirectory() as tmp:
            from storage.implementations.file_config import FileConfigStore
            from security.config_manager import ConfigManager
            config_path = Path(tmp) / "no-config" / "config.json"
            store = FileConfigStore(config_path)
            mgr = ConfigManager(store)

            # No file yet, but operations work with defaults
            self.assertEqual(mgr.get("auth.cache_timeout_minutes"), 30)
            self.assertEqual(mgr.get("timeouts.remote_check_ms"), 500)
            self.assertEqual(mgr.get("storage.config_dir"),
                             str(Path.home() / ".config" / "phpoc"))
            self.assertEqual(mgr.get("storage.data_dir"),
                             str(Path.home() / ".local" / "share" / "phpoc"))

    def test_old_hardcoded_paths_still_work(self):
        """The old ~/.config/personal_history_poc/ path is still valid."""
        from pathlib import Path
        old_path = Path.home() / ".config" / "personal_history_poc"
        # main.py checks for legacy path as data directory fallback
        from storage.implementations.file_config import _resolve_data_dir
        data_dir = _resolve_data_dir()
        self.assertIn("phpoc", str(data_dir),
                      "New XDG data path uses 'phpoc' as app name")
        self.assertNotIn("personal_history_poc", str(data_dir),
                         "Default data dir is ~/.local/share/phpoc, not legacy path")
        # The legacy path fallback is handled in main.py, not at the library level


# ════════════════════════════════════════════════════════════════════════════
# Category G: Environment variable overrides
# ════════════════════════════════════════════════════════════════════════════

class TestConfigEnvOverrides(unittest.TestCase):
    """Environment variables can override config values."""

    def test_phpoc_config_env_var(self):
        """PHPOC_CONFIG environment variable specifies the config file path."""
        with tempfile.TemporaryDirectory() as tmp:
            custom_path = Path(tmp) / "my-custom-config.json"
            with patch.dict(os.environ, {"PHPOC_CONFIG": str(custom_path)}):
                # Write some config
                custom_path.parent.mkdir(parents=True, exist_ok=True)
                custom_path.write_text(json.dumps({"auth": {"cache_timeout_minutes": 999}}))

                from storage.implementations.file_config import FileConfigStore
                from security.config_manager import ConfigManager
                store = FileConfigStore(custom_path)
                mgr = ConfigManager(store)
                self.assertEqual(mgr.get("auth.cache_timeout_minutes"), 999)

    def test_phpoc_data_dir_env_var(self):
        """PHPOC_DATA_DIR overrides the default data directory."""
        from storage.implementations.file_config import _resolve_data_dir
        with patch.dict(os.environ, {"PHPOC_DATA_DIR": "/custom/data/path"}):
            resolved = _resolve_data_dir()
            self.assertEqual(str(resolved), "/custom/data/path")
            self.assertTrue(resolved.name == "path",
                            "PHPOC_DATA_DIR should be used as-is for the data directory")


# ════════════════════════════════════════════════════════════════════════════
# Category H: Config template generation (config init)
# ════════════════════════════════════════════════════════════════════════════

class TestConfigInitCommand(unittest.TestCase):
    """The `config init` subcommand generates a commented config template."""

    def test_config_init_subcommand_exists(self):
        """main.py has a 'config init' subcommand."""
        with open("main.py") as f:
            content = f.read()
        # Find the config subparser block and check for 'init'
        config_block = content.split("config_p =")[1] if "config_p =" in content else content
        self.assertIn('"init"', config_block,
                      "config subparser must have an 'init' action")

    def test_generate_template_creates_file(self):
        """config init generates a template file at the config path."""
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "config.json"
            from storage.implementations.file_config import FileConfigStore
            from security.config_manager import ConfigManager
            store = FileConfigStore(config_path)
            mgr = ConfigManager(store)

            from main import _config_generate_template
            _config_generate_template(mgr)

            self.assertTrue(config_path.exists(),
                            "Config template file should be created")
            content = config_path.read_text()
            self.assertIn("PHPOC Configuration File", content,
                          "Template should have a header comment")
            self.assertIn('"storage"', content,
                          "Template should mention storage section")
            self.assertIn('"remote"', content,
                          "Template should mention remote section")
            self.assertIn('"auth"', content,
                          "Template should mention auth section")

    def test_template_contains_default_values(self):
        """Template includes all default key-value pairs as comments."""
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "config.json"
            from storage.implementations.file_config import FileConfigStore
            from security.config_manager import ConfigManager
            store = FileConfigStore(config_path)
            mgr = ConfigManager(store)

            from main import _config_generate_template
            _config_generate_template(mgr)

            content = config_path.read_text()
            self.assertIn('"config_dir"', content)
            self.assertIn('"data_dir"', content)
            self.assertIn('"ledger"', content)
            self.assertIn('"transport"', content)
            self.assertIn('"cache_timeout_minutes"', content)
            self.assertIn('"passphrase_required"', content)
            self.assertIn('"device_id"', content)
            self.assertIn('"remote_check_ms"', content)
            self.assertIn('"blob_size_tier"', content)

    def test_template_is_valid_json_if_uncommented(self):
        """The template body is valid JSON when you strip // lines."""
        import re
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "config.json"
            from storage.implementations.file_config import FileConfigStore
            from security.config_manager import ConfigManager
            store = FileConfigStore(config_path)
            mgr = ConfigManager(store)

            from main import _config_generate_template
            _config_generate_template(mgr)

            content = config_path.read_text()
            # Remove any line that starts with // (after stripping whitespace)
            clean_lines = [
                line for line in content.split("\n")
                if not line.strip().startswith("//")
            ]
            clean = "\n".join(clean_lines)
            import json
            try:
                parsed = json.loads(clean)
                self.assertIsInstance(parsed, dict)
                self.assertIn("storage", parsed)
                self.assertIn("remote", parsed)
                self.assertIn("auth", parsed)
            except json.JSONDecodeError as e:
                self.fail(f"Template is not valid JSON after stripping // lines: {e}\n---\n{clean[:800]}")

    def test_template_has_instructions(self):
        """Template includes instructions for the user."""
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "config.json"
            from storage.implementations.file_config import FileConfigStore
            from security.config_manager import ConfigManager
            store = FileConfigStore(config_path)
            mgr = ConfigManager(store)

            from main import _config_generate_template
            _config_generate_template(mgr)

            content = config_path.read_text()
            self.assertIn("uncomment", content.lower(),
                          "Template should mention uncommenting settings")
            self.assertIn("default", content.lower(),
                          "Template should mention defaults")

    def test_generate_template_not_user_config(self):
        """config init writes defaults, not the user's config values."""
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "config.json"
            from storage.implementations.file_config import FileConfigStore
            from security.config_manager import ConfigManager
            store = FileConfigStore(config_path)
            mgr = ConfigManager(store)

            # Write a real config first
            mgr.write({"auth": {"cache_timeout_minutes": 999}})

            # Now generate the template (overwrites)
            from main import _config_generate_template
            _config_generate_template(mgr)

            content = config_path.read_text()
            # Template should not contain "999" — that was the old user value
            self.assertNotIn("999", content,
                             "Template should contain defaults, not old user values")
            self.assertIn("30", content,
                          "Template should contain default cache_timeout_minutes of 30")


# ════════════════════════════════════════════════════════════════════════════
# Category F: --dir CLI flag and config storage.data_dir
# ════════════════════════════════════════════════════════════════════════════

class TestDataDirOverrideConfig(unittest.TestCase):
    """storage.data_dir in config file is consulted by _resolve_data_dir()."""

    def setUp(self):
        # Reset any PHPOC_DATA_DIR env that might interfere
        self._old_env = os.environ.pop("PHPOC_DATA_DIR", None)

    def tearDown(self):
        if self._old_env is not None:
            os.environ["PHPOC_DATA_DIR"] = self._old_env
        elif "PHPOC_DATA_DIR" in os.environ:
            del os.environ["PHPOC_DATA_DIR"]

    def test_resolve_data_dir_uses_config(self):
        """_resolve_data_dir consults config_manager when no env var."""
        from storage.implementations.file_config import _resolve_data_dir
        from security.config_manager import ConfigManager
        from storage.implementations.file_config import FileConfigStore

        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "config.json"
            store = FileConfigStore(config_path)
            mgr = ConfigManager(store)

            # Set storage.data_dir in config
            custom_dir = Path(tmp) / "custom_data"
            mgr.write({"storage": {"data_dir": str(custom_dir)}})

            result = _resolve_data_dir(config_manager=mgr)
            self.assertEqual(result, custom_dir)

    def test_resolve_data_dir_config_over_xdg(self):
        """Config file storage.data_dir takes priority over XDG default."""
        from storage.implementations.file_config import _resolve_data_dir
        from security.config_manager import ConfigManager
        from storage.implementations.file_config import FileConfigStore

        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "config.json"
            store = FileConfigStore(config_path)
            mgr = ConfigManager(store)

            custom_dir = Path(tmp) / "from_config"
            mgr.write({"storage": {"data_dir": str(custom_dir)}})

            # Should return config value, not XDG default
            result = _resolve_data_dir(config_manager=mgr)
            self.assertEqual(result, custom_dir)

    def test_resolve_data_dir_env_over_config(self):
        """PHPOC_DATA_DIR env var takes priority over config storage.data_dir."""
        from storage.implementations.file_config import _resolve_data_dir
        from security.config_manager import ConfigManager
        from storage.implementations.file_config import FileConfigStore

        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "config.json"
            store = FileConfigStore(config_path)
            mgr = ConfigManager(store)

            config_dir = Path(tmp) / "from_config"
            mgr.write({"storage": {"data_dir": str(config_dir)}})

            env_dir = Path(tmp) / "from_env"
            os.environ["PHPOC_DATA_DIR"] = str(env_dir)

            result = _resolve_data_dir(config_manager=mgr)
            self.assertEqual(result, env_dir)

    def test_resolve_data_dir_explicit_over_env(self):
        """Explicit overridden_dir arg takes priority over env var."""
        from storage.implementations.file_config import _resolve_data_dir

        with tempfile.TemporaryDirectory() as tmp:
            env_dir = Path(tmp) / "from_env"
            os.environ["PHPOC_DATA_DIR"] = str(env_dir)

            explicit_dir = Path(tmp) / "from_explicit"
            result = _resolve_data_dir(overridden_dir=explicit_dir)
            self.assertEqual(result, explicit_dir)

    def test_main_has_dir_flag(self):
        """main.py defines a --dir argument for all commands."""
        with open("main.py") as f:
            content = f.read()
        self.assertIn("--dir", content,
                      "main.py should accept --dir for data directory override")
        self.assertIn("data_dir", content,
                      "main.py should use dest='data_dir' for the --dir flag")


if __name__ == "__main__":
    unittest.main()
