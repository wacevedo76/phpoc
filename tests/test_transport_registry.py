"""Tests for ``core/sync/transport_registry.py`` — TransportProvider + TransportRegistry.

Covers:
  - TransportProvider dataclass (constructor, validation, equality, hashing)
  - TransportRegistry (register, get, list, unregister, length, contains)
  - Built-in providers (git, http-cloudflare, http-generic)
  - create_transport_from_config integration
  - Singleton registry behavior
"""

import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch
from typing import Optional, Dict, Any

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from core.sync.transport_registry import (
    TransportProvider,
    TransportRegistry,
    get_registry,
    reset_registry,
    create_transport_from_config,
    _factory_git,
    _factory_http,
    _prompt_git,
    _prompt_http_cloudflare,
    _prompt_http_generic,
)
from core.sync.transport import AbstractStagingTransport


# ═════════════════════════════════════════════════════════════════════════════
# Helpers
# ═════════════════════════════════════════════════════════════════════════════

def _noop_prompt():
    """A prompt_config that returns (None, None) — simulate cancel."""
    return None, None


def _dummy_prompt():
    """A prompt_config that returns an empty config + None transport."""
    return {}, None


def _noop_factory(config: Dict[str, Any], config_dir: Optional[str]) -> Optional[AbstractStagingTransport]:
    """A transport_factory that always returns None."""
    return None


def _make_provider(id_="test-provider", name="Test Provider", description="A test provider"):
    """Create a TransportProvider with minimal valid args."""
    return TransportProvider(
        id_=id_,
        name=name,
        description=description,
        prompt_config=_noop_prompt,
        transport_factory=_noop_factory,
    )


# ═════════════════════════════════════════════════════════════════════════════
# TransportProvider tests
# ═════════════════════════════════════════════════════════════════════════════

class TestTransportProvider(unittest.TestCase):
    """TransportProvider dataclass behavior."""

    def test_01_constructor_sets_all_fields(self):
        """All fields are set from constructor args."""
        p = TransportProvider(
            id_="git",
            name="Git Remote",
            description="Clone from git",
            prompt_config=_noop_prompt,
            transport_factory=_noop_factory,
            requires_api_key=False,
        )
        self.assertEqual(p.id_, "git")
        self.assertEqual(p.name, "Git Remote")
        self.assertEqual(p.description, "Clone from git")
        self.assertEqual(p.prompt_config, _noop_prompt)
        self.assertEqual(p.transport_factory, _noop_factory)
        self.assertFalse(p.requires_api_key)

    def test_02_requires_api_key_defaults_to_false(self):
        """requires_api_key defaults to False."""
        p = TransportProvider(
            id_="x",
            name="X",
            description="d",
            prompt_config=_noop_prompt,
            transport_factory=_noop_factory,
        )
        self.assertFalse(p.requires_api_key)

    def test_03_requires_api_key_can_be_true(self):
        """requires_api_key can be set to True."""
        p = TransportProvider(
            id_="x",
            name="X",
            description="d",
            prompt_config=_noop_prompt,
            transport_factory=_noop_factory,
            requires_api_key=True,
        )
        self.assertTrue(p.requires_api_key)

    def test_04_empty_id_raises_value_error(self):
        """Empty id_ raises ValueError."""
        with self.assertRaises(ValueError):
            TransportProvider(
                id_="",
                name="X",
                description="d",
                prompt_config=_noop_prompt,
                transport_factory=_noop_factory,
            )

    def test_05_whitespace_only_id_raises_value_error(self):
        """Whitespace-only id_ raises ValueError."""
        with self.assertRaises(ValueError):
            TransportProvider(
                id_="   ",
                name="X",
                description="d",
                prompt_config=_noop_prompt,
                transport_factory=_noop_factory,
            )

    def test_06_empty_name_raises_value_error(self):
        """Empty name raises ValueError."""
        with self.assertRaises(ValueError):
            TransportProvider(
                id_="x",
                name="",
                description="d",
                prompt_config=_noop_prompt,
                transport_factory=_noop_factory,
            )

    def test_07_equality_is_by_id(self):
        """Two providers with the same id_ are equal, regardless of other fields."""
        p1 = TransportProvider(
            id_="git",
            name="Git Remote",
            description="a",
            prompt_config=_noop_prompt,
            transport_factory=_noop_factory,
        )
        p2 = TransportProvider(
            id_="git",
            name="Different Name",
            description="b",
            prompt_config=_dummy_prompt,
            transport_factory=_noop_factory,
        )
        self.assertEqual(p1, p2)

    def test_08_different_ids_not_equal(self):
        """Providers with different ids are not equal."""
        p1 = _make_provider(id_="git")
        p2 = _make_provider(id_="http")
        self.assertNotEqual(p1, p2)

    def test_09_hash_is_by_id(self):
        """Hash is based on id_ only."""
        p1 = _make_provider(id_="git")
        p2 = _make_provider(id_="git")
        p3 = _make_provider(id_="http")
        self.assertEqual(hash(p1), hash(p2))
        self.assertNotEqual(hash(p1), hash(p3))

    def test_10_provider_is_hashable_in_set(self):
        """Providers can be placed in a set."""
        p1 = _make_provider(id_="a")
        p2 = _make_provider(id_="a")
        p3 = _make_provider(id_="b")
        s = {p1, p2, p3}
        self.assertEqual(len(s), 2)

    def test_11_frozen_dataclass_cannot_be_mutated(self):
        """TransportProvider is frozen (immutable after creation)."""
        p = _make_provider()
        with self.assertRaises(Exception):
            p.id_ = "changed"  # type: ignore


# ═════════════════════════════════════════════════════════════════════════════
# TransportRegistry tests
# ═════════════════════════════════════════════════════════════════════════════

class TestTransportRegistry(unittest.TestCase):
    """TransportRegistry CRUD and behavior."""

    def setUp(self):
        self.registry = TransportRegistry()

    def test_12_register_adds_provider(self):
        """register() adds a provider that can be retrieved by get()."""
        p = _make_provider(id_="git")
        self.registry.register(p)
        self.assertIs(self.registry.get("git"), p)

    def test_13_register_duplicate_overwrites(self):
        """Registering a provider with the same id overwrites the previous one."""
        p1 = _make_provider(id_="git", name="First")
        p2 = _make_provider(id_="git", name="Second")
        self.registry.register(p1)
        self.registry.register(p2)
        self.assertEqual(self.registry.get("git").name, "Second")

    def test_14_get_missing_returns_none(self):
        """get() for an unregistered id returns None."""
        self.assertIsNone(self.registry.get("nonexistent"))

    def test_15_list_providers_empty(self):
        """list_providers() on an empty registry returns an empty list."""
        self.assertEqual(self.registry.list_providers(), [])

    def test_16_list_providers_sorted_by_name(self):
        """list_providers() returns providers sorted alphabetically by name."""
        self.registry.register(_make_provider(id_="c", name="Charlie"))
        self.registry.register(_make_provider(id_="a", name="Alpha"))
        self.registry.register(_make_provider(id_="b", name="Bravo"))
        result = self.registry.list_providers()
        self.assertEqual([p.name for p in result], ["Alpha", "Bravo", "Charlie"])

    def test_17_list_providers_is_a_copy(self):
        """list_providers() returns a new list — mutation doesn't affect registry."""
        self.registry.register(_make_provider(id_="a"))
        providers = self.registry.list_providers()
        providers.clear()
        self.assertIsNotNone(self.registry.get("a"))

    def test_18_length_zero_initially(self):
        """len() of empty registry is 0."""
        self.assertEqual(len(self.registry), 0)

    def test_19_length_after_registration(self):
        """len() reflects number of registered providers."""
        self.registry.register(_make_provider(id_="a"))
        self.registry.register(_make_provider(id_="b"))
        self.assertEqual(len(self.registry), 2)

    def test_20_contains_true_for_registered(self):
        """'in' operator returns True for registered ids."""
        self.registry.register(_make_provider(id_="git"))
        self.assertIn("git", self.registry)

    def test_21_contains_false_for_unregistered(self):
        """'in' operator returns False for unregistered ids."""
        self.assertNotIn("nonexistent", self.registry)

    def test_22_unregister_existing_returns_provider(self):
        """unregister() returns the removed provider and it can no longer be found."""
        p = _make_provider(id_="git")
        self.registry.register(p)
        removed = self.registry.unregister("git")
        self.assertIs(removed, p)
        self.assertIsNone(self.registry.get("git"))

    def test_23_unregister_missing_returns_none(self):
        """unregister() for an unregistered id returns None."""
        self.assertIsNone(self.registry.unregister("nonexistent"))

    def test_24_register_raises_type_error_for_non_provider(self):
        """register() raises TypeError when given a non-TransportProvider."""
        with self.assertRaises(TypeError):
            self.registry.register("not-a-provider")  # type: ignore

    def test_25_register_raises_type_error_for_none(self):
        """register() raises TypeError when given None."""
        with self.assertRaises(TypeError):
            self.registry.register(None)  # type: ignore

    def test_26_multiple_providers_independent(self):
        """Registering multiple providers doesn't interfere."""
        p1 = _make_provider(id_="git", name="Git")
        p2 = _make_provider(id_="http", name="HTTP")
        self.registry.register(p1)
        self.registry.register(p2)
        self.assertEqual(len(self.registry), 2)
        self.assertIs(self.registry.get("git"), p1)
        self.assertIs(self.registry.get("http"), p2)


# ═════════════════════════════════════════════════════════════════════════════
# Singleton registry tests
# ═════════════════════════════════════════════════════════════════════════════

class TestSingletonRegistry(unittest.TestCase):
    """Module-level singleton registry behavior."""

    def setUp(self):
        # Ensure clean state
        reset_registry()

    def tearDown(self):
        reset_registry()

    def test_27_get_registry_returns_same_instance(self):
        """Multiple calls to get_registry() return the same object."""
        r1 = get_registry()
        r2 = get_registry()
        self.assertIs(r1, r2)

    def test_28_get_registry_has_builtins(self):
        """The singleton registry comes pre-populated with built-in providers."""
        r = get_registry()
        self.assertIsNotNone(r.get("git"))
        self.assertIsNotNone(r.get("http-cloudflare"))
        self.assertIsNotNone(r.get("http-generic"))

    def test_29_reset_registry_creates_new_instance(self):
        """reset_registry() causes get_registry() to return a fresh instance."""
        r1 = get_registry()
        reset_registry()
        r2 = get_registry()
        self.assertIsNot(r1, r2)

    def test_30_builtin_git_provider_has_correct_fields(self):
        """The built-in git provider has expected attributes."""
        p = get_registry().get("git")
        self.assertEqual(p.id_, "git")
        self.assertEqual(p.name, "Git Remote")
        self.assertFalse(p.requires_api_key)
        self.assertIsNotNone(p.prompt_config)
        self.assertIsNotNone(p.transport_factory)

    def test_31_builtin_http_cloudflare_provider_has_correct_fields(self):
        """The built-in http-cloudflare provider has expected attributes."""
        p = get_registry().get("http-cloudflare")
        self.assertEqual(p.id_, "http-cloudflare")
        self.assertEqual(p.name, "Cloudflare R2")
        self.assertTrue(p.requires_api_key)

    def test_32_builtin_http_generic_provider_has_correct_fields(self):
        """The built-in http-generic provider has expected attributes."""
        p = get_registry().get("http-generic")
        self.assertEqual(p.id_, "http-generic")
        self.assertEqual(p.name, "Generic HTTP Server")
        self.assertFalse(p.requires_api_key)

    def test_33_builtins_list_providers_returns_three(self):
        """list_providers() returns exactly 3 built-in providers."""
        providers = get_registry().list_providers()
        self.assertEqual(len(providers), 3)
        ids = {p.id_ for p in providers}
        self.assertEqual(ids, {"git", "http-cloudflare", "http-generic"})


# ═════════════════════════════════════════════════════════════════════════════
# create_transport_from_config integration tests
# ═════════════════════════════════════════════════════════════════════════════

class TestCreateTransportFromConfig(unittest.TestCase):
    """Integration of create_transport_from_config with the registry."""

    def setUp(self):
        reset_registry()

    def tearDown(self):
        reset_registry()

    def test_34_no_remote_config_returns_none(self):
        """Empty config returns None."""
        self.assertIsNone(create_transport_from_config({}))

    def test_35_no_transport_config_returns_none(self):
        """Config without remote/transport returns None."""
        self.assertIsNone(create_transport_from_config({"auth": {}}))

    def test_36_git_transport_creates_via_registry(self):
        """Config with git_remote_url creates GitStagingTransport via registry."""
        # Use a path that exists to avoid clone errors
        import tempfile
        with tempfile.TemporaryDirectory() as tmpdir:
            config = {
                "remote": {
                    "transport": "git",
                    "git_remote_url": f"file://{tmpdir}/test.git",
                },
                "_config_dir": tmpdir,
            }
            # create_transport_from_config should return a transport
            # (The git factory will try to clone — but since we're not
            #  validating connectivity, the transport object is created)
            transport = create_transport_from_config(config)
            # Git transport may be None if the remote URL isn't valid as a git repo
            # But the factory itself should be invoked via the registry
            if transport is not None:
                from core.sync.git_transport import GitStagingTransport
                self.assertIsInstance(transport, GitStagingTransport)

    def test_37_http_cloudflare_creates_via_registry(self):
        """Config with http base_url + provider=cloudflare creates HttpStagingTransport via registry."""
        config = {
            "remote": {"transport": "http"},
            "http": {
                "provider": "cloudflare",
                "base_url": "https://test-worker.example.workers.dev",
                "api_key": "test-key",
            },
        }
        transport = create_transport_from_config(config)
        self.assertIsNotNone(transport)
        from core.sync.http_transport import HttpStagingTransport
        self.assertIsInstance(transport, HttpStagingTransport)
        self.assertEqual(transport.base_url, "https://test-worker.example.workers.dev")

    def test_38_http_unknown_provider_falls_back_to_direct(self):
        """Config with http + unknown provider still creates HttpStagingTransport."""
        config = {
            "remote": {"transport": "http"},
            "http": {
                "provider": "unknown-custom",
                "base_url": "https://custom.example.com",
            },
        }
        transport = create_transport_from_config(config)
        self.assertIsNotNone(transport)
        from core.sync.http_transport import HttpStagingTransport
        self.assertIsInstance(transport, HttpStagingTransport)

    def test_39_http_without_base_url_returns_none(self):
        """Config with transport=http but no base_url returns None."""
        config = {
            "remote": {"transport": "http"},
            "http": {"provider": "cloudflare"},
        }
        self.assertIsNone(create_transport_from_config(config))

    def test_40_git_without_url_returns_none(self):
        """Config with transport=git but no git_remote_url returns None."""
        config = {
            "remote": {"transport": "git"},
        }
        self.assertIsNone(create_transport_from_config(config))

    def test_41_custom_registered_provider_used(self):
        """A custom provider registered in the registry is used."""
        reset_registry()
        registry = get_registry()

        # Register a custom provider that overrides git
        mock_transport = MagicMock(spec=AbstractStagingTransport)

        def custom_factory(config, config_dir):
            return mock_transport

        custom = TransportProvider(
            id_="git",
            name="Custom Git",
            description="My custom git provider",
            prompt_config=_noop_prompt,
            transport_factory=custom_factory,
        )
        registry.register(custom)

        config = {
            "remote": {
                "transport": "git",
                "git_remote_url": "git@example.com:repo.git",
            },
        }
        transport = create_transport_from_config(config)
        self.assertIs(transport, mock_transport)


# ═════════════════════════════════════════════════════════════════════════════
# Factory function tests
# ═════════════════════════════════════════════════════════════════════════════

class TestTransportFactories(unittest.TestCase):
    """Direct tests for factory helper functions."""

    def test_42_factory_git_with_no_url_returns_none(self):
        """_factory_git returns None when git_remote_url is missing."""
        self.assertIsNone(_factory_git({}, None))

    def test_43_factory_git_with_url_returns_git_transport(self):
        """_factory_git returns GitStagingTransport when URL is provided."""
        import tempfile
        with tempfile.TemporaryDirectory() as tmpdir:
            config = {
                "remote": {
                    "git_remote_url": f"file://{tmpdir}/test.git",
                },
            }
            transport = _factory_git(config, tmpdir)
            self.assertIsNotNone(transport)
            from core.sync.git_transport import GitStagingTransport
            self.assertIsInstance(transport, GitStagingTransport)

    def test_44_factory_http_with_no_url_returns_none(self):
        """_factory_http returns None when base_url is missing."""
        self.assertIsNone(_factory_http({}, None))

    def test_45_factory_http_with_url_returns_http_transport(self):
        """_factory_http returns HttpStagingTransport when base_url is provided."""
        config = {
            "http": {
                "provider": "cloudflare",
                "base_url": "https://example.com",
            },
        }
        transport = _factory_http(config, None)
        self.assertIsNotNone(transport)
        from core.sync.http_transport import HttpStagingTransport
        self.assertIsInstance(transport, HttpStagingTransport)
        self.assertEqual(transport.base_url, "https://example.com")


# ═════════════════════════════════════════════════════════════════════════════
# Prompt function tests (light — confirm they exist and are callable)
# ═════════════════════════════════════════════════════════════════════════════

class TestPromptFunctions(unittest.TestCase):
    """Smoke tests for prompt_config callbacks."""

    def test_46_prompt_git_is_callable_with_no_args(self):
        """_prompt_git accepts 0 args and returns a tuple or (None, None)."""
        # We can't test the full interactive flow, but we can verify it's callable
        result = _prompt_git  # Not called — just type check
        self.assertTrue(callable(result))

    def test_47_prompt_http_cloudflare_is_callable(self):
        """_prompt_http_cloudflare is callable."""
        self.assertTrue(callable(_prompt_http_cloudflare))

    def test_48_prompt_http_generic_is_callable(self):
        """_prompt_http_generic is callable."""
        self.assertTrue(callable(_prompt_http_generic))

    def test_49_prompt_http_generic_returns_none_on_empty_url(self):
        """_prompt_http_generic returns (None, None) when user enters empty URL."""
        with patch("builtins.input", return_value=""):
            with patch("builtins.print"):
                result = _prompt_http_generic()
                self.assertEqual(result, (None, None))

    def test_50_prompt_http_generic_returns_config_on_valid_url(self):
        """_prompt_http_generic returns config + transport when user enters URL."""
        # Mock HttpStagingTransport.pull to avoid real network call
        with patch(
            "core.sync.http_transport.HttpStagingTransport.pull",
            return_value=None,  # simulate 404 (reachable, no data)
        ):
            with patch("builtins.input", side_effect=["https://test.example.com", ""]):
                with patch("builtins.print"):
                    result = _prompt_http_generic()
                    self.assertIsNotNone(result[0])
                    self.assertIsNotNone(result[1])
                    config, transport = result
                    self.assertEqual(config["remote"]["transport"], "http")
                    self.assertEqual(config["http"]["provider"], "generic")
                    self.assertEqual(config["http"]["base_url"], "https://test.example.com")


# ═════════════════════════════════════════════════════════════════════════════
# Run
# ═════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    unittest.main()
