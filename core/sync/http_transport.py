"""HttpStagingTransport — push/pull staging blobs via HTTP(S).

Concrete implementation of ``AbstractStagingTransport`` that speaks plain HTTP.
Replaces ``GitStagingTransport`` to eliminate ~5s SSH handshake latency.

Design principles:
  - **Transport knows nothing about providers** — just HTTP verbs, base URL,
    and ETag headers. No Cloudflare/R2/S3 knowledge.
  - **ETag-based freshness** — ``304 Not Modified`` = zero bytes transferred = instant.
  - **Stateless** — each request is independent; auth is a pre-shared API key
    set in the ``X-Api-Key`` header.

Contract:
  - ``pull(path) -> bytes | None``: GET blob at path. Returns ``None`` on 404.
    Raises ``RuntimeError`` on 4xx (non-404) or 5xx or network error.
  - ``push(path, data: bytes) -> None``: PUT blob at path. Raises on non-2xx.
  - ``list_files(prefix) -> List[str]``: GET ``?prefix=...``, parse JSON array.
    Returns empty list on 404.

ETag caching:
  - On a successful 200 response with an ``ETag`` header, the transport caches
    both the ETag and the response body for that path.
  - Subsequent ``pull()`` for the same path sends ``If-None-Match`` with the
    cached ETag.
  - If server responds 304, the cached body is returned — zero bytes transferred.
  - If server responds 200 with a new body + ETag, both cache entries are updated.
  - ``push()`` for a path clears that path's cache (the server now has newer data).
  - ``reset_cache()`` clears all cached ETags.
"""

import json
import logging
import urllib.request
import urllib.error
from typing import Optional, Dict, List, Tuple
from urllib.parse import urlencode, urljoin

from core.sync.transport import AbstractStagingTransport

logger = logging.getLogger(__name__)

# Seconds to wait before giving up on a single HTTP request.
# Used as the default when no explicit timeout is provided.
_DEFAULT_TIMEOUT_S = 10.0

# Custom header names
_API_KEY_HEADER = "X-Api-Key"
_CONTENT_TYPE = "application/octet-stream"
_USER_AGENT = "phpoc-http-transport/1.0"

# Environment variable that can supply the API key instead of putting it
# directly in the config file. Set this in your shell profile (e.g. .zshrc):
#   export PHPOC_CLOUDFLARE_API_KEY="your-key-here"
_API_KEY_ENV_VAR = "PHPOC_CLOUDFLARE_API_KEY"


class HttpStagingTransport(AbstractStagingTransport):
    """Push/pull staging blobs via HTTP(S) with ETag-based caching.

    Attributes:
        base_url: Base URL of the remote storage server
                  (e.g., ``https://phpoc-worker.example.workers.dev``).
        api_key: Optional pre-shared API key sent as ``X-Api-Key`` header.
        _etag_cache: ``{path: (etag, body_bytes)}`` — cached ETags and bodies.
    """

    def __init__(self, base_url: str, api_key: Optional[str] = None):
        """Initialize with base URL and optional API key.

        Args:
            base_url: Base URL of the HTTP server (e.g.,
                      ``https://worker.example.com``). Must start with
                      ``http://`` or ``https://``.
            api_key: Optional pre-shared API key. If provided, sent as
                     ``X-Api-Key`` header on every request.
                     If not provided, falls back to the environment
                     variable ``PHPOC_CLOUDFLARE_API_KEY``.

        Raises:
            ValueError: If *base_url* is empty or has an unsupported scheme.
        """
        if not base_url:
            raise ValueError("base_url must not be empty")
        if not (base_url.startswith("http://") or base_url.startswith("https://")):
            raise ValueError(
                f"base_url must start with http:// or https://, got: {base_url}"
            )

        # Normalize: strip trailing slash for consistent URL joining
        self.base_url = base_url.rstrip("/")

        # Resolve API key: constructor arg → env var → None
        import os
        self.api_key = api_key or os.environ.get(_API_KEY_ENV_VAR)
        self._api_key_source = "arg" if api_key else ("env" if self.api_key else "none")

        self._etag_cache: Dict[str, Tuple[str, bytes]] = {}

    # ------------------------------------------------------------------
    # Public interface (AbstractStagingTransport)
    # ------------------------------------------------------------------

    def pull(self, path: str, timeout_ms: Optional[int] = None) -> Optional[bytes]:
        """Fetch blob from remote via HTTP GET.

        Args:
            path: Remote path (e.g., ``staging/blobs/current.json``).
                   Leading slash is normalized away.
            timeout_ms: Optional timeout in milliseconds. If not provided,
                        a default 10s timeout is used.

        Returns:
            Blob bytes, or None if server returns 404.

        Raises:
            RuntimeError: On network errors, timeouts, non-404 4xx, or 5xx.
        """
        url = self._build_url(path)
        timeout_s = _DEFAULT_TIMEOUT_S if timeout_ms is None else (timeout_ms / 1000.0)

        request = urllib.request.Request(url, method="GET")

        # Add API key if configured
        self._add_api_key(request)

        # Send If-None-Match if we have a cached ETag for this path
        cached = self._etag_cache.get(path)
        if cached is not None:
            cached_etag, _cached_body = cached
            request.add_header("If-None-Match", cached_etag)

        try:
            with urllib.request.urlopen(request, timeout=timeout_s) as response:
                if response.status == 304:
                    # Not Modified — return cached body
                    logger.debug("304 for %s — returning cached %d bytes", path, len(_cached_body))
                    # Do NOT call response.read() — the body is empty on 304
                    return _cached_body

                body = response.read()

                # Cache ETag if present
                etag = response.headers.get("ETag")
                if etag:
                    self._etag_cache[path] = (etag, body)

                return body

        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            raise RuntimeError(
                f"HTTP {e.code} pulling {path}: {e.reason}"
            ) from e

        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise RuntimeError(
                f"Network error pulling {path}: {e}"
            ) from e

    def push(self, path: str, data: bytes, timeout_ms: Optional[int] = None) -> None:
        """Write blob to remote via HTTP PUT.

        Args:
            path: Remote path (e.g., ``staging/blobs/current.json``).
            data: Blob bytes to write.
            timeout_ms: Optional timeout in milliseconds.

        Raises:
            RuntimeError: On network errors, timeouts, or non-2xx responses.
        """
        url = self._build_url(path)
        timeout_s = _DEFAULT_TIMEOUT_S if timeout_ms is None else (timeout_ms / 1000.0)

        request = urllib.request.Request(
            url,
            data=data,
            method="PUT",
        )
        request.add_header("Content-Type", _CONTENT_TYPE)

        self._add_api_key(request)

        try:
            with urllib.request.urlopen(request, timeout=timeout_s) as response:
                # 2xx = success; clear cache for this path (server has newer data)
                if 200 <= response.status < 300:
                    self._etag_cache.pop(path, None)
                    return

                raise RuntimeError(
                    f"HTTP {response.status} pushing {path}"
                )

        except urllib.error.HTTPError as e:
            raise RuntimeError(
                f"HTTP {e.code} pushing {path}: {e.reason}"
            ) from e

        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise RuntimeError(
                f"Network error pushing {path}: {e}"
            ) from e

    def list_files(self, prefix: str, timeout_ms: Optional[int] = None) -> List[str]:
        """List filenames under *prefix* via HTTP GET with ?prefix= query.

        Args:
            prefix: Remote directory prefix (e.g., ``ledger/blocks/``).
            timeout_ms: Optional timeout in milliseconds.

        Returns:
            List of filenames (basenames only). Empty if no files match.

        Raises:
            RuntimeError: On network errors, timeouts, or 5xx.
        """
        params = urlencode({"prefix": prefix})
        url = f"{self.base_url}/?{params}"
        timeout_s = _DEFAULT_TIMEOUT_S if timeout_ms is None else (timeout_ms / 1000.0)

        request = urllib.request.Request(url, method="GET")
        self._add_api_key(request)

        try:
            with urllib.request.urlopen(request, timeout=timeout_s) as response:
                body = response.read()
                if not body:
                    return []
                parsed = json.loads(body.decode("utf-8"))
                if not isinstance(parsed, list):
                    raise RuntimeError(
                        f"Expected JSON array from list_files({prefix}), "
                        f"got {type(parsed).__name__}"
                    )
                return parsed

        except urllib.error.HTTPError as e:
            if e.code == 404:
                return []
            raise RuntimeError(
                f"HTTP {e.code} listing {prefix}: {e.reason}"
            ) from e

        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise RuntimeError(
                f"Network error listing {prefix}: {e}"
            ) from e

    # ------------------------------------------------------------------
    # ETag cache management
    # ------------------------------------------------------------------

    def reset_cache(self) -> None:
        """Clear all cached ETags and bodies.

        Used after transport swap (e.g., migration from git to HTTP) to
        ensure the next pull is a clean request.
        """
        self._etag_cache.clear()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _build_url(self, path: str) -> str:
        """Build the full URL from base URL and path.

        Normalizes the path: strips leading slash to avoid double slashes
        in the final URL.

        Args:
            path: Remote path, possibly starting with /.

        Returns:
            Full URL string (e.g., ``https://worker.example.com/staging/blobs/x.json``).
        """
        clean_path = path.lstrip("/")
        return f"{self.base_url}/{clean_path}"

    def _add_api_key(self, request: urllib.request.Request) -> None:
        """Add API key header to request if configured.

        Args:
            request: The urllib Request to add the header to.
        """
        if self.api_key is not None:
            request.add_header(_API_KEY_HEADER, self.api_key)

    # ------------------------------------------------------------------
    # Convenience property (used by is checks / isinstance in callers)
    # ------------------------------------------------------------------

    @property
    def is_http(self) -> bool:
        """Flag indicating this is an HTTP transport (vs git or in-memory)."""
        return True
