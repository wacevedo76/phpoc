"""TransportProvider registry — extensible transport sources for onboarding.

Provides a registry of TransportProvider instances so that ``ph onboarding``
can discover and instantiate transports without hard-coded branches.

Each provider declares:
  - An ``id`` (unique string, e.g. ``"git"``, ``"http-cloudflare"``)
  - A ``name`` for display
  - A ``description`` for interactive pickers
  - A ``prompt_config()`` callable that returns ``(config_dict, transport)``
    or ``(None, None)`` if the user cancels
  - A ``transport_factory()`` callable that creates an ``AbstractStagingTransport``
    from persisted config

Built-in providers:
  - ``git`` — Generic git remote (SSH or HTTPS)
  - ``http-cloudflare`` — Cloudflare R2 via Worker (guided setup)
  - ``http-generic`` — Generic HTTP server (URL + optional API key)
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Optional, Dict, Any, Callable, Tuple, List

from core.sync.transport import AbstractStagingTransport

logger = logging.getLogger(__name__)


# ── Public type aliases ─────────────────────────────────────────────────────

# prompt_config() returns (config_update_dict, transport_instance) or (None, None)
PromptResult = Tuple[Optional[Dict[str, Any]], Optional[AbstractStagingTransport]]

# prompt_config callable signature
PromptConfigFn = Callable[[], PromptResult]

# transport_factory callable signature — creates transport from saved config
TransportFactoryFn = Callable[[Dict[str, Any], Optional[str]], Optional[AbstractStagingTransport]]


# ═════════════════════════════════════════════════════════════════════════════
# TransportProvider dataclass
# ═════════════════════════════════════════════════════════════════════════════

@dataclass(frozen=True)
class TransportProvider:
    """A transport source that onboarding can use to pull ledger data.

    Attributes:
        id_: Unique provider identifier (e.g. ``"git"``, ``"http-cloudflare"``).
        name: Human-readable name for display in pickers.
        description: One-line description of the provider.
        prompt_config: Callable that interactively prompts the user for
                       provider-specific settings. Returns a ``(config_update, transport)``
                       tuple, or ``(None, None)`` if the user cancels.
        transport_factory: Callable that creates a transport instance from
                           previously persisted config (used for non-interactive
                           commands like ``ph sync``).
        requires_api_key: Whether this provider typically needs an API key.
    """

    id_: str
    name: str
    description: str
    prompt_config: PromptConfigFn
    transport_factory: TransportFactoryFn
    requires_api_key: bool = False

    def __post_init__(self):
        if not self.id_ or not self.id_.strip():
            raise ValueError("TransportProvider.id_ must be a non-empty string")
        if not self.name or not self.name.strip():
            raise ValueError("TransportProvider.name must be a non-empty string")

    def __hash__(self):
        return hash(self.id_)

    def __eq__(self, other):
        if not isinstance(other, TransportProvider):
            return NotImplemented
        return self.id_ == other.id_


# ═════════════════════════════════════════════════════════════════════════════
# TransportRegistry
# ═════════════════════════════════════════════════════════════════════════════

class TransportRegistry:
    """Registry of ``TransportProvider`` instances.

    Thread-safe: uses a lock for mutation. Lookups are lock-free (reads
    from a dict that is replaced atomically on mutation).

    Usage::

        registry = TransportRegistry()
        registry.register(git_provider)
        registry.register(http_cloudflare_provider)

        provider = registry.get("git")
        if provider:
            config, transport = provider.prompt_config()
    """

    def __init__(self):
        self._providers: Dict[str, TransportProvider] = {}
        # Mutable lock — python dict assignment is atomic per the GIL,
        # but we use a simple lock for multi-step mutations.
        import threading
        self._lock = threading.Lock()

    # ── Public API ──────────────────────────────────────────────────────

    def register(self, provider: TransportProvider) -> None:
        """Register a transport provider.

        If a provider with the same ``id_`` already exists, it is replaced.

        Args:
            provider: The ``TransportProvider`` to register.

        Raises:
            TypeError: If *provider* is not a ``TransportProvider``.
        """
        if not isinstance(provider, TransportProvider):
            raise TypeError(
                f"Expected TransportProvider, got {type(provider).__name__}"
            )
        with self._lock:
            self._providers[provider.id_] = provider
        logger.debug("Registered transport provider: %s", provider.id_)

    def get(self, id_: str) -> Optional[TransportProvider]:
        """Look up a provider by its ``id_``.

        Args:
            id_: Provider identifier (case-sensitive).

        Returns:
            The ``TransportProvider``, or ``None`` if not registered.
        """
        return self._providers.get(id_)

    def list_providers(self) -> List[TransportProvider]:
        """Return all registered providers as a sorted list.

        Providers are sorted alphabetically by ``name``.

        Returns:
            A new list of ``TransportProvider`` instances (safe to mutate).
        """
        return sorted(self._providers.values(), key=lambda p: p.name)

    def __len__(self) -> int:
        """Return the number of registered providers."""
        return len(self._providers)

    def __contains__(self, id_: str) -> bool:
        """Check if a provider id is registered."""
        return id_ in self._providers

    def unregister(self, id_: str) -> Optional[TransportProvider]:
        """Remove a provider from the registry.

        Args:
            id_: Provider identifier to remove.

        Returns:
            The removed ``TransportProvider``, or ``None`` if not found.
        """
        with self._lock:
            return self._providers.pop(id_, None)


# ═════════════════════════════════════════════════════════════════════════════
# Built-in transport factory helpers
# ═════════════════════════════════════════════════════════════════════════════

def _factory_git(config: Dict[str, Any], config_dir: Optional[str]) -> Optional[AbstractStagingTransport]:
    """Create a ``GitStagingTransport`` from config."""
    remote_url = config.get("remote", {}).get("git_remote_url")
    if not remote_url:
        return None

    from pathlib import Path
    if config_dir is None:
        clone_path = Path.home() / ".local" / "share" / "phpoc" / "remote"
    else:
        clone_path = Path(config_dir) / "remote"

    from core.sync.git_transport import GitStagingTransport
    logger.info("Using GitStagingTransport -> %s", remote_url)
    return GitStagingTransport(remote_url, str(clone_path))


def _factory_http(config: Dict[str, Any], config_dir: Optional[str]) -> Optional[AbstractStagingTransport]:
    """Create an ``HttpStagingTransport`` from config.

    Used by both cloudflare and generic HTTP providers.
    """
    base_url = config.get("http", {}).get("base_url")
    if not base_url:
        logger.warning("http.base_url is not set — cannot create HTTP transport")
        return None
    api_key = config.get("http", {}).get("api_key")
    from core.sync.http_transport import HttpStagingTransport
    logger.info("Using HttpStagingTransport -> %s (provider=%s)",
                base_url, config.get("http", {}).get("provider", "unknown"))
    return HttpStagingTransport(base_url=base_url, api_key=api_key)


# ═════════════════════════════════════════════════════════════════════════════
# Built-in prompt_config implementations
# ═════════════════════════════════════════════════════════════════════════════

def _prompt_git() -> PromptResult:
    """Interactive git remote URL prompt.

    Returns (config_update, transport) or (None, None) on cancel.

    The config_update includes ``remote.git_remote_url`` and
    ``remote.transport = "git"``.
    """
    from phpoc_cli.onboarding import _prompt_git_remote_url
    url = _prompt_git_remote_url()
    if url is None:
        return None, None

    config_update = {
        "remote": {
            "transport": "git",
            "git_remote_url": url,
        },
    }

    from pathlib import Path
    clone_path = str(Path.home() / ".local" / "share" / "phpoc" / "remote")
    from core.sync.git_transport import GitStagingTransport
    transport = GitStagingTransport(url, clone_path)

    return config_update, transport


def _prompt_http_cloudflare() -> PromptResult:
    """Interactive Cloudflare R2 Worker prompt.

    Reuses the existing ``cli.onboarding._prompt_http_transport()`` logic.
    """
    from phpoc_cli.onboarding import _prompt_http_transport
    return _prompt_http_transport()


def _prompt_http_generic() -> PromptResult:
    """Interactive generic HTTP server prompt.

    Prompts for a base URL and optional API key.
    """
    print("\n=== Generic HTTP Transport Setup ===")
    print()
    print("Enter the base URL of the HTTP server hosting your phpoc data.")
    print("Example: https://phpoc.example.com/staging")
    print()

    url = input("Base URL: ").strip()
    if not url:
        print("No URL entered. Onboarding cancelled.")
        return None, None
    url = url.rstrip("/")

    api_key = input("API key (optional, press Enter to skip): ").strip()
    if not api_key:
        api_key = None

    from core.sync.http_transport import HttpStagingTransport
    transport = HttpStagingTransport(base_url=url, api_key=api_key)

    # Quick connectivity test
    print("  Testing connection...", end=" ", flush=True)
    try:
        result = transport.pull("onboarding-health-check")
        if result is None:
            print("ok (reachable, no existing data)")
        else:
            print("ok")
    except RuntimeError as exc:
        err_str = str(exc)
        if "403" in err_str or "401" in err_str:
            print("AUTH ERROR")
            print(f"  Server returned auth failure. Check your API key.")
        elif "Timeout" in err_str:
            print("TIMEOUT")
        else:
            print("FAILED")
            print(f"  Error: {exc}")
        retry = input("Retry with a different URL? (y/N): ").strip().lower()
        if retry == "y":
            return _prompt_http_generic()
        return None, None
    except Exception as exc:
        print("FAILED")
        print(f"  Unexpected error: {exc}")
        return None, None

    config_update = {
        "remote": {"transport": "http"},
        "http": {
            "provider": "generic",
            "base_url": url,
            "api_key": api_key,
        },
    }

    return config_update, transport


# ═════════════════════════════════════════════════════════════════════════════
# Module-level singleton registry (populated at import time)
# ═════════════════════════════════════════════════════════════════════════════

_registry: Optional[TransportRegistry] = None


def get_registry() -> TransportRegistry:
    """Return the module-level ``TransportRegistry`` singleton.

    On first call, the registry is populated with built-in providers.
    Subsequent calls return the same instance.
    """
    global _registry
    if _registry is None:
        _registry = TransportRegistry()
        _register_builtins(_registry)
    return _registry


def reset_registry() -> None:
    """Reset the module-level registry to ``None``.

    The next call to ``get_registry()`` will create a fresh instance.
    Useful for tests that need a clean registry.
    """
    global _registry
    _registry = None


def _register_builtins(registry: TransportRegistry) -> None:
    """Register all built-in transport providers."""
    registry.register(TransportProvider(
        id_="git",
        name="Git Remote",
        description="Import from a git repository (SSH or HTTPS)",
        prompt_config=_prompt_git,
        transport_factory=_factory_git,
        requires_api_key=False,
    ))
    registry.register(TransportProvider(
        id_="http-cloudflare",
        name="Cloudflare R2",
        description="Import from Cloudflare R2 via a deployed Worker",
        prompt_config=_prompt_http_cloudflare,
        transport_factory=_factory_http,
        requires_api_key=True,
    ))
    registry.register(TransportProvider(
        id_="http-generic",
        name="Generic HTTP Server",
        description="Import from any HTTP server with phpoc staging",
        prompt_config=_prompt_http_generic,
        transport_factory=_factory_http,
        requires_api_key=False,
    ))


# ═════════════════════════════════════════════════════════════════════════════
# Integration: create transport from config (delegates to registry)
# ═════════════════════════════════════════════════════════════════════════════

def create_transport_from_config(config: Dict[str, Any]) -> Optional[AbstractStagingTransport]:
    """Create a transport based on config settings, delegating to the registry.

    Priority:
      1. ``remote.transport == "http"`` → look up provider from ``http.provider``
         in the registry, fall back to direct ``HttpStagingTransport``.
      2. ``remote.git_remote_url`` is set → use git transport via registry.
      3. Neither set → ``None`` (no remote transport).

    Args:
        config: Application config dict (from ``ConfigManager``).

    Returns:
        An ``AbstractStagingTransport`` instance, or ``None`` if no remote
        transport is configured.
    """
    transport_type = config.get("remote", {}).get("transport", "git")
    config_dir = config.get("_config_dir", None)

    # HTTP transport — try registry first, fall back to direct factory
    if transport_type == "http":
        http_config = config.get("http", {})
        provider_id = http_config.get("provider", "cloudflare")
        base_url = http_config.get("base_url")

        if not base_url:
            logger.warning("transport=http but http.base_url is not set")
            return None

        # Try the registry for this specific provider
        registry = get_registry()
        provider = registry.get(f"http-{provider_id}")
        if provider is not None:
            transport = provider.transport_factory(config, config_dir)
            if transport is not None:
                return transport

        # Fallback: create directly (backward compat with unknown providers)
        api_key = http_config.get("api_key")
        from core.sync.http_transport import HttpStagingTransport
        logger.info("Using HttpStagingTransport -> %s (direct, provider=%s)",
                    base_url, provider_id)
        return HttpStagingTransport(base_url=base_url, api_key=api_key)

    # Git transport
    remote_url = config.get("remote", {}).get("git_remote_url")
    if not remote_url:
        return None

    # Try the registry first
    registry = get_registry()
    provider = registry.get("git")
    if provider is not None:
        transport = provider.transport_factory(config, config_dir)
        if transport is not None:
            return transport

    # Fallback — direct creation
    from pathlib import Path
    clone_path = config_dir
    if clone_path is None:
        clone_path = Path.home() / ".local" / "share" / "phpoc" / "remote"
    else:
        clone_path = Path(config_dir) / "remote"

    from core.sync.git_transport import GitStagingTransport
    logger.info("Using GitStagingTransport -> %s (direct)", remote_url)
    return GitStagingTransport(remote_url, str(clone_path))
