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

import http.client
import json
import logging
import socket
import time
from typing import Optional, Dict, List, Tuple
from urllib.parse import urlencode, urlparse

from core.sync.transport import AbstractStagingTransport

logger = logging.getLogger(__name__)

# Seconds to wait before giving up on a single HTTP request.
# Used as the default when no explicit timeout is provided.
_DEFAULT_TIMEOUT_S = 60.0

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

    def __init__(
        self,
        base_url: str,
        api_key: Optional[str] = None,
        cache_ttl_s: float = 0.0,
    ):
        """Initialize with base URL and optional API key.

        Args:
            base_url: Base URL of the HTTP server (e.g.,
                      ``https://worker.example.com``). Must start with
                      ``http://`` or ``https://``.
            api_key: Optional pre-shared API key. If provided, sent as
                     ``X-Api-Key`` header on every request.
                     If not provided, falls back to the environment
                     variable ``PHPOC_CLOUDFLARE_API_KEY``.
            cache_ttl_s: ETag cache TTL in seconds. 0 = no expiry (default).
                         Set to e.g. 300 for 5-minute expiry in long-running
                         processes (daemon mode) to prevent stale bodies.

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

        # ETag cache: {path: (etag, body_bytes, cached_at_timestamp)}
        self._etag_cache: Dict[str, Tuple[str, bytes, float]] = {}

        # Cache TTL in seconds. 0 = no expiry.
        self._cache_ttl_s = max(0.0, cache_ttl_s)

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
        url_path = self._build_path(path)
        timeout_s = _DEFAULT_TIMEOUT_S if timeout_ms is None else (timeout_ms / 1000.0)

        # Build headers
        headers = {}
        self._add_api_key(headers)

        # Send If-None-Match if we have a non-expired cached ETag for this path
        cached = self._get_cached_entry(path)
        if cached is not None:
            cached_etag, cached_body, _cached_at = cached
            headers["If-None-Match"] = cached_etag

        try:
            conn = self._connect(timeout_s)
            conn.request("GET", url_path, headers=headers)
            resp = conn.getresponse()

            if resp.status == 304:
                conn.close()
                # Not Modified — return cached body
                logger.debug(
                    "304 for %s — returning cached %d bytes",
                    path, len(cached_body),
                )
                return cached_body

            body = resp.read()

            if resp.status == 200:
                # Cache ETag if present
                etag = resp.getheader("ETag")
                if etag:
                    self._etag_cache[path] = (etag, body, time.time())
                conn.close()
                return body

            if resp.status == 404:
                conn.close()
                return None

            # Non-404 error
            reason = resp.reason or ""
            conn.close()
            raise RuntimeError(f"HTTP {resp.status} pulling {path}: {reason}")

        except (socket.timeout, TimeoutError) as e:
            raise RuntimeError(f"Timeout pulling {path}: {e}") from e
        except (socket.gaierror, ConnectionRefusedError, ConnectionError) as e:
            raise RuntimeError(f"Network error pulling {path}: {e}") from e
        except RuntimeError:
            raise
        except Exception as e:
            raise RuntimeError(f"Error pulling {path}: {e}") from e

    def push(self, path: str, data: bytes, timeout_ms: Optional[int] = None) -> None:
        """Write blob to remote via HTTP PUT.

        Args:
            path: Remote path (e.g., ``staging/blobs/current.json``).
            data: Blob bytes to write.
            timeout_ms: Optional timeout in milliseconds.

        Raises:
            RuntimeError: On network errors, timeouts, or non-2xx responses.
        """
        url_path = self._build_path(path)
        timeout_s = _DEFAULT_TIMEOUT_S if timeout_ms is None else (timeout_ms / 1000.0)

        headers = {
            "Content-Type": _CONTENT_TYPE,
        }
        self._add_api_key(headers)

        try:
            conn = self._connect(timeout_s)
            conn.request("PUT", url_path, body=data, headers=headers)
            resp = conn.getresponse()

            if 200 <= resp.status < 300:
                # Success; clear cache for this path (server has newer data)
                self._etag_cache.pop(path, None)
                resp.read()  # drain
                conn.close()
                return

            reason = resp.reason or ""
            body = resp.read()
            conn.close()
            raise RuntimeError(f"HTTP {resp.status} pushing {path}: {reason}")

        except (socket.timeout, TimeoutError) as e:
            raise RuntimeError(f"Timeout pushing {path}: {e}") from e
        except (socket.gaierror, ConnectionRefusedError, ConnectionError) as e:
            raise RuntimeError(f"Network error pushing {path}: {e}") from e
        except RuntimeError:
            raise
        except Exception as e:
            raise RuntimeError(f"Error pushing {path}: {e}") from e

    def delete(self, path: str, timeout_ms: Optional[int] = None) -> None:
        """Delete blob at *path* from remote via HTTP DELETE.

        Args:
            path: Remote path (e.g., ``staging/blobs/current.json``).
            timeout_ms: Optional timeout in milliseconds.

        Raises:
            RuntimeError: On network errors, timeouts, or non-2xx/404 responses.
        """
        url_path = self._build_path(path)
        timeout_s = _DEFAULT_TIMEOUT_S if timeout_ms is None else (timeout_ms / 1000.0)

        headers = {}
        self._add_api_key(headers)

        try:
            conn = self._connect(timeout_s)
            conn.request("DELETE", url_path, headers=headers)
            resp = conn.getresponse()

            if resp.status in (200, 202, 204, 404):
                # Success (or already gone — idempotent)
                self._etag_cache.pop(path, None)
                resp.read()  # drain
                conn.close()
                return

            reason = resp.reason or ""
            body = resp.read()
            conn.close()
            raise RuntimeError(f"HTTP {resp.status} deleting {path}: {reason}")

        except (socket.timeout, TimeoutError) as e:
            raise RuntimeError(f"Timeout deleting {path}: {e}") from e
        except (socket.gaierror, ConnectionRefusedError, ConnectionError) as e:
            raise RuntimeError(f"Network error deleting {path}: {e}") from e
        except RuntimeError:
            raise
        except Exception as e:
            raise RuntimeError(f"Error deleting {path}: {e}") from e

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
        url_path = f"/?{params}"
        timeout_s = _DEFAULT_TIMEOUT_S if timeout_ms is None else (timeout_ms / 1000.0)

        headers = {}
        self._add_api_key(headers)

        try:
            conn = self._connect(timeout_s)
            conn.request("GET", url_path, headers=headers)
            resp = conn.getresponse()
            body = resp.read()

            if resp.status == 200:
                conn.close()
                parsed = json.loads(body.decode("utf-8"))
                if not isinstance(parsed, list):
                    raise RuntimeError(
                        f"Expected JSON array from list_files({prefix}), "
                        f"got {type(parsed).__name__}"
                    )
                return parsed

            if resp.status == 404:
                conn.close()
                return []

            reason = resp.reason or ""
            conn.close()
            raise RuntimeError(f"HTTP {resp.status} listing {prefix}: {reason}")

        except (socket.timeout, TimeoutError) as e:
            raise RuntimeError(f"Timeout listing {prefix}: {e}") from e
        except (socket.gaierror, ConnectionRefusedError, ConnectionError) as e:
            raise RuntimeError(f"Network error listing {prefix}: {e}") from e
        except RuntimeError:
            raise
        except json.JSONDecodeError as e:
            raise RuntimeError(
                f"Invalid JSON response from list_files({prefix}): {e}"
            ) from e
        except Exception as e:
            raise RuntimeError(f"Error listing {prefix}: {e}") from e

    # ------------------------------------------------------------------
    # ETag cache management
    # ------------------------------------------------------------------

    def reset_cache(self) -> None:
        """Clear all cached ETags and bodies.

        Used after transport swap (e.g., migration from git to HTTP) to
        ensure the next pull is a clean request.
        """
        self._etag_cache.clear()

    def evict_stale(self) -> int:
        """Evict all expired entries from the ETag cache.

        Returns the number of entries evicted. Safe to call periodically
        from daemon loops to purge stale entries without clearing the
        entire cache.

        Returns:
            Number of cache entries evicted.
        """
        if self._cache_ttl_s <= 0:
            return 0
        now = time.time()
        stale_keys = [
            path
            for path, (_etag, _body, cached_at) in self._etag_cache.items()
            if now - cached_at > self._cache_ttl_s
        ]
        for path in stale_keys:
            del self._etag_cache[path]
        return len(stale_keys)

    def _get_cached_entry(
        self, path: str
    ) -> Optional[Tuple[str, bytes, float]]:
        """Return a cached ETag entry if it exists and has not expired.

        If the cache TTL has been set and the entry is older than the TTL,
        the entry is evicted and None is returned.

        Args:
            path: Remote path to look up.

        Returns:
            ``(etag, body, cached_at)`` tuple, or None if not cached or expired.
        """
        entry = self._etag_cache.get(path)
        if entry is None:
            return None

        _etag, _body, cached_at = entry
        if self._cache_ttl_s > 0 and time.time() - cached_at > self._cache_ttl_s:
            del self._etag_cache[path]
            return None

        return entry

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _connect(self, timeout: float) -> http.client.HTTPSConnection:
        """Create an HTTPS (or HTTP) connection to the remote server.

        Args:
            timeout: Socket timeout in seconds.

        Returns:
            An ``HTTPSConnection`` or ``HTTPConnection`` instance.

        Raises:
            ValueError: If the base URL cannot be parsed.
        """
        parsed = urlparse(self.base_url)
        host = parsed.hostname
        port = parsed.port
        secure = parsed.scheme == "https"

        if secure:
            conn = http.client.HTTPSConnection(
                host, port=port, timeout=timeout,
            )
        else:
            conn = http.client.HTTPConnection(
                host, port=port, timeout=timeout,
            )
        return conn

    def _build_path(self, path: str) -> str:
        """Build the URL path from base URL and remote path.

        Extracts the path component from the base URL (if any) and appends
        the remote path.

        Args:
            path: Remote path, possibly starting with /.

        Returns:
            Full URL path string (e.g., ``/staging/blobs/x.json``).
        """
        parsed = urlparse(self.base_url)
        base_path = parsed.path.rstrip("/")
        clean_path = path.lstrip("/")
        if base_path:
            return f"{base_path}/{clean_path}"
        return f"/{clean_path}"

    def _add_api_key(self, headers: dict) -> None:
        """Add API key header to request headers dict if configured.

        Uses ``http.client`` which preserves header case in the actual
        HTTP request (unlike ``urllib.request`` which lowercases keys).

        Args:
            headers: Dict of headers to add the key to.
        """
        if self.api_key is not None:
            headers[_API_KEY_HEADER] = self.api_key

    # ------------------------------------------------------------------
    # Convenience property (used by is checks / isinstance in callers)
    # ------------------------------------------------------------------

    @property
    def is_http(self) -> bool:
        """Flag indicating this is an HTTP transport (vs git or in-memory)."""
        return True
