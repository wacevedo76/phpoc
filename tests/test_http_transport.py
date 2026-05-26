"""Tests for HttpStagingTransport — generic HTTP transport for remote sync.

Test coverage:

Layer 1 — Transport contract (AbstractStagingTransport interface):
  - pull returns bytes on 200, None on 404, raises on 5xx
  - push sends PUT, raises on non-2xx
  - list_files returns list on 200, empty on 404
  - URL construction from base_url + path
  - Custom headers (Content-Type, User-Agent)

Layer 2 — ETag-based freshness (latency optimization):
  - If-None-Match sent on second pull
  - 304 → returns cached bytes, zero network transfer
  - New 200 → updates cache
  - Push clears cache for that path
  - Independent per-path ETag cache

Layer 3 — Error handling & timeouts:
  - Connection errors, DNS failures → RuntimeError
  - Timeout → RuntimeError
  - Auth errors (401/403) → RuntimeError (not silently swallowed)
  - Large payloads

Layer 4 — Integration with RemoteStagingSync:
  - pull/push round-trip through HTTP
  - pull_cookie correct path
  - check_remote_available with healthy/slow/unreachable server

Layer 5 — Integration with RemoteLedgerSync:
  - push_blocks via HTTP
  - pull_blocks via HTTP
  - list_files via HTTP
"""

import json
import time
import unittest
from io import BytesIO
from pathlib import Path
from typing import Optional, Dict, Any, List
from unittest.mock import MagicMock, patch, call, Mock
from urllib.error import URLError, HTTPError

import sys
import os

# Ensure project root is on path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


# =============================================================================
# Helpers for mocking HTTP responses
# =============================================================================

def _make_response(
    status: int = 200,
    body: bytes = b"",
    headers: Optional[Dict[str, str]] = None,
    url: str = "http://example.com/test",
) -> MagicMock:
    """Create a mock HTTP response object with working context manager.

    MagicMock.__enter__ does not return self by default (it spawns a new
    mock), so we explicitly configure ``__enter__`` to return *self* so that
    ``with urlopen(...) as response:`` works correctly.

    Args:
        status: HTTP status code.
        body: Response body bytes.
        headers: Response headers dict.
        url: Response URL (for redirects, but we don't handle those).

    Returns:
        Mock with .status, .read(), .getheader(), .headers, .url attributes.
    """
    mock_resp = MagicMock()
    mock_resp.status = status
    mock_resp.read.return_value = body
    mock_resp.url = url

    # Configure context manager: ``with response as r:`` → r = mock_resp
    mock_resp.__enter__.return_value = mock_resp

    # .getheader() for individual headers
    all_headers = headers or {}
    mock_resp.getheader.side_effect = lambda name, default=None: all_headers.get(name, default)

    # .headers for dict-style access
    mock_headers = MagicMock()
    mock_headers.get.side_effect = lambda name, default=None: all_headers.get(name, default)
    mock_resp.headers = mock_headers

    return mock_resp


def _make_http_error(
    status: int,
    body: bytes = b"error",
    url: str = "http://example.com/test",
) -> HTTPError:
    """Create an HTTPError for testing non-2xx responses.

    HTTPError is a subclass of URLError, so urlopen raises it on 4xx/5xx.

    Args:
        status: HTTP status code.
        body: Response body.
        url: Request URL.

    Returns:
        An HTTPError instance.
    """
    return HTTPError(
        url=url,
        code=status,
        msg="",
        hdrs={},
        fp=BytesIO(body),
    )


def _get_header(request, name: str) -> Optional[str]:
    """Extract a header from a urllib Request object (case-insensitive).

    Python's ``urllib.request.Request.add_header()`` normalizes header
    names to title case (e.g. ``If-None-Match`` → ``If-none-match``),
    and ``get_header()`` is case-sensitive. We try the original name,
    the title-cased version, and fall back to a case-insensitive search
    of the headers dict.

    Args:
        request: A ``urllib.request.Request`` instance (or mock).
        name: Header name to look up.

    Returns:
        Header value string, or None if not found.
    """
    # Try get_header with original name
    if hasattr(request, 'get_header'):
        value = request.get_header(name)
        if value is not None:
            return value
        # Try title-cased version (what Python stores internally)
        if "-" in name:
            title_cased = name.title()
            value = request.get_header(title_cased)
            if value is not None:
                return value

    # Fall back to case-insensitive dict search
    if hasattr(request, 'headers'):
        name_lower = name.lower()
        for k, v in request.headers.items():
            if k.lower() == name_lower:
                return v

    return None


def _request_url(request) -> str:
    """Extract the full URL string from a Request object."""
    if hasattr(request, 'get_full_url'):
        return request.get_full_url()
    if hasattr(request, 'full_url'):
        return request.full_url
    return str(request)


# =============================================================================
# Test classes
# =============================================================================


class TestHttpTransportContract(unittest.TestCase):
    """Layer 1 — Basic AbstractStagingTransport contract over HTTP."""

    def setUp(self):
        self.mock_urlopen = patch(
            "urllib.request.urlopen"
        ).start()
        self.addCleanup(patch.stopall)

        # Import after patching so the module uses the mock
        from core.sync.http_transport import HttpStagingTransport
        self.transport = HttpStagingTransport(base_url="https://worker.example.com")

    # ── pull() ────────────────────────────────────────────────────────────

    def test_pull_returns_bytes_on_200(self):
        """pull(path) returns bytes when server returns 200."""
        body = b'{"device_id": "abc", "entries": []}'
        self.mock_urlopen.return_value = _make_response(200, body)

        result = self.transport.pull("staging/blobs/current.json")

        self.assertEqual(result, body)

    def test_pull_returns_none_on_404(self):
        """pull(path) returns None when server returns 404."""
        self.mock_urlopen.side_effect = _make_http_error(404)

        result = self.transport.pull("staging/blobs/nonexistent.json")

        self.assertIsNone(result)

    def test_pull_raises_on_5xx(self):
        """pull(path) raises RuntimeError on 5xx server error."""
        self.mock_urlopen.side_effect = _make_http_error(500)

        with self.assertRaises(RuntimeError):
            self.transport.pull("staging/blobs/current.json")

    def test_pull_raises_on_4xx_without_404(self):
        """pull(path) raises RuntimeError on 403/401 (not auth-swallowed)."""
        self.mock_urlopen.side_effect = _make_http_error(403)

        with self.assertRaises(RuntimeError):
            self.transport.pull("staging/blobs/current.json")

    def test_pull_uses_correct_url(self):
        """pull(path) sends GET to base_url + / + path."""
        self.mock_urlopen.return_value = _make_response(200, b"data")

        self.transport.pull("staging/blobs/current.json")

        # Verify the URL passed to urlopen
        request = self.mock_urlopen.call_args[0][0]
        call_url = _request_url(request)
        self.assertIn("https://worker.example.com", call_url)
        self.assertIn("staging/blobs/current.json", call_url)

    def test_pull_handles_trailing_slash_in_base_url(self):
        """pull works whether base_url ends with / or not."""
        from core.sync.http_transport import HttpStagingTransport
        transport = HttpStagingTransport(base_url="https://worker.example.com/")

        self.mock_urlopen.return_value = _make_response(200, b"data")
        transport.pull("staging/blobs/current.json")

        request = self.mock_urlopen.call_args[0][0]
        call_url = _request_url(request)
        # Should not have double slashes
        self.assertNotIn("//staging", call_url)

    def test_pull_sends_get_method(self):
        """pull sends a GET request (not POST, not PUT)."""
        self.mock_urlopen.return_value = _make_response(200, b"data")

        self.transport.pull("staging/blobs/current.json")

        # urlopen with a URL uses GET by default — verify no data sent
        call_args = self.mock_urlopen.call_args
        request = call_args[0][0]
        if hasattr(request, 'get_method'):
            self.assertEqual(request.get_method(), "GET")
        elif hasattr(request, 'method'):
            self.assertEqual(request.method, "GET")

    # ── push() ────────────────────────────────────────────────────────────

    def test_push_sends_put_with_body(self):
        """push(path, data) sends PUT with data as body."""
        data = b'{"device_id": "abc", "entries": []}'
        self.mock_urlopen.return_value = _make_response(200, b"ok")

        self.transport.push("staging/blobs/current.json", data)

        call_args = self.mock_urlopen.call_args
        request = call_args[0][0]

        # Verify method is PUT
        if hasattr(request, 'get_method'):
            self.assertEqual(request.get_method(), "PUT")
        elif hasattr(request, 'method'):
            self.assertEqual(request.method, "PUT")

        # Verify body
        if hasattr(request, 'data'):
            self.assertEqual(request.data, data)

    def test_push_uses_correct_url(self):
        """push sends PUT to base_url + / + path."""
        self.mock_urlopen.return_value = _make_response(200, b"ok")

        self.transport.push("staging/blobs/current.json", b"data")

        request = self.mock_urlopen.call_args[0][0]
        call_url = _request_url(request)
        self.assertIn("staging/blobs/current.json", call_url)

    def test_push_raises_on_4xx(self):
        """push raises RuntimeError on 4xx rejection."""
        self.mock_urlopen.side_effect = _make_http_error(400, b"bad request")

        with self.assertRaises(RuntimeError):
            self.transport.push("staging/blobs/current.json", b"data")

    def test_push_raises_on_5xx(self):
        """push raises RuntimeError on 5xx server error."""
        self.mock_urlopen.side_effect = _make_http_error(503, b"service unavailable")

        with self.assertRaises(RuntimeError):
            self.transport.push("staging/blobs/current.json", b"data")

    def test_push_raises_on_413_payload_too_large(self):
        """push raises RuntimeError with clear message on 413."""
        self.mock_urlopen.side_effect = _make_http_error(413, b"payload too large")

        with self.assertRaises(RuntimeError) as ctx:
            self.transport.push("staging/blobs/current.json", b"x" * 1024 * 1024)

        self.assertIn("413", str(ctx.exception))

    def test_push_returns_none_on_success(self):
        """push returns None (void method) on success."""
        self.mock_urlopen.return_value = _make_response(200, b"ok")

        result = self.transport.push("staging/blobs/current.json", b"data")

        self.assertIsNone(result)

    # ── list_files() ──────────────────────────────────────────────────────

    def test_list_files_returns_list_on_200(self):
        """list_files returns list of filenames from JSON response."""
        file_list = ["000000.json", "000001.json", "000042.json"]
        self.mock_urlopen.return_value = _make_response(
            200, json.dumps(file_list).encode("utf-8")
        )

        result = self.transport.list_files("ledger/blocks/")

        self.assertEqual(result, file_list)

    def test_list_files_returns_empty_list_on_404(self):
        """list_files returns empty list when prefix doesn't exist (404)."""
        self.mock_urlopen.side_effect = _make_http_error(404)

        result = self.transport.list_files("nonexistent/")

        self.assertEqual(result, [])

    def test_list_files_returns_empty_list_on_200_empty(self):
        """list_files returns empty list when JSON response is empty."""
        self.mock_urlopen.return_value = _make_response(
            200, b"[]"
        )

        result = self.transport.list_files("ledger/blocks/")

        self.assertEqual(result, [])

    def test_list_files_sends_prefix_parameter(self):
        """list_files sends ?prefix= parameter in URL."""
        self.mock_urlopen.return_value = _make_response(200, b'["a.json"]')

        self.transport.list_files("ledger/blocks/")

        request = self.mock_urlopen.call_args[0][0]
        call_url = _request_url(request)
        self.assertIn("prefix=", call_url)
        self.assertIn("ledger", call_url)
        self.assertIn("blocks", call_url)

    def test_list_files_raises_on_5xx(self):
        """list_files raises RuntimeError on 5xx."""
        self.mock_urlopen.side_effect = _make_http_error(500)

        with self.assertRaises(RuntimeError):
            self.transport.list_files("ledger/blocks/")

    def test_list_files_raises_on_unexpected_json(self):
        """list_files raises RuntimeError when response is not JSON list."""
        self.mock_urlopen.return_value = _make_response(
            200, b'{"not": "a list"}'
        )

        with self.assertRaises(RuntimeError):
            self.transport.list_files("ledger/blocks/")

    # ── Constructor ───────────────────────────────────────────────────────

    def test_constructor_rejects_empty_base_url(self):
        """HttpStagingTransport rejects empty base URL."""
        from core.sync.http_transport import HttpStagingTransport

        with self.assertRaises(ValueError):
            HttpStagingTransport(base_url="")

    def test_constructor_rejects_invalid_scheme(self):
        """HttpStagingTransport rejects non-http/https schemes."""
        from core.sync.http_transport import HttpStagingTransport

        with self.assertRaises(ValueError):
            HttpStagingTransport(base_url="ftp://example.com")

    def test_constructor_accepts_http(self):
        """HttpStagingTransport accepts http:// URLs (for testing)."""
        from core.sync.http_transport import HttpStagingTransport

        transport = HttpStagingTransport(base_url="http://localhost:8080")
        self.assertIsNotNone(transport)

    def test_constructor_accepts_https(self):
        """HttpStagingTransport accepts https:// URLs."""
        from core.sync.http_transport import HttpStagingTransport

        transport = HttpStagingTransport(base_url="https://worker.example.com")
        self.assertIsNotNone(transport)

    # ── timeout ───────────────────────────────────────────────────────────

    def test_pull_sets_timeout(self):
        """pull passes a timeout to urlopen (used in check_remote_available)."""
        self.mock_urlopen.return_value = _make_response(200, b"data")

        self.transport.pull("staging/blobs/current.json", timeout_ms=500)

        # urlopen is called with URL as first arg, timeout as keyword
        call_kwargs = self.mock_urlopen.call_args[1]
        self.assertIn("timeout", call_kwargs)
        self.assertEqual(call_kwargs["timeout"], 0.5)


class TestHttpTransportETagCaching(unittest.TestCase):
    """Layer 2 — ETag-based freshness (304 Not Modified)."""

    def setUp(self):
        self.mock_urlopen = patch(
            "urllib.request.urlopen"
        ).start()
        self.addCleanup(patch.stopall)

        from core.sync.http_transport import HttpStagingTransport
        self.transport = HttpStagingTransport(base_url="https://worker.example.com")
        self.test_path = "staging/blobs/current.json"
        self.test_body = b'{"device_id": "abc", "entries": []}'

    def test_first_pull_no_if_none_match(self):
        """First pull does NOT send If-None-Match header (no cached ETag)."""
        self.mock_urlopen.return_value = _make_response(200, self.test_body)

        self.transport.pull(self.test_path)

        request = self.mock_urlopen.call_args[0][0]
        # Verify no If-None-Match in headers
        header_val = _get_header(request, "If-None-Match")
        self.assertIsNone(header_val)

    def test_second_pull_sends_if_none_match(self):
        """Second pull sends If-None-Match with ETag from first response."""
        # First pull: server returns 200 with ETag
        self.mock_urlopen.return_value = _make_response(
            200, self.test_body, {"ETag": '"abc123"'}
        )
        self.transport.pull(self.test_path)

        # Second pull: should send If-None-Match
        second_resp = _make_response(304, b"")
        self.mock_urlopen.return_value = second_resp

        result = self.transport.pull(self.test_path)

        request = self.mock_urlopen.call_args[0][0]
        sent_etag = _get_header(request, "If-None-Match")
        self.assertEqual(sent_etag, '"abc123"')

    def test_304_returns_cached_bytes(self):
        """304 response returns previously cached bytes, not empty body."""
        # First pull: 200 with data
        self.mock_urlopen.return_value = _make_response(
            200, self.test_body, {"ETag": '"abc123"'}
        )
        first_result = self.transport.pull(self.test_path)
        self.assertEqual(first_result, self.test_body)

        # Second pull: 304 Not Modified
        self.mock_urlopen.return_value = _make_response(304, b"not used")

        result = self.transport.pull(self.test_path)

        # Should return cached bytes from first pull, not the 304 body
        self.assertEqual(result, self.test_body)

    def test_304_does_not_call_read(self):
        """304 does not read response body (optimization check)."""
        self.mock_urlopen.return_value = _make_response(
            200, self.test_body, {"ETag": '"abc123"'}
        )
        self.transport.pull(self.test_path)

        # Second pull: 304 — verify read is not called on the empty body
        mock_304 = _make_response(304, b"should not be read")
        self.mock_urlopen.return_value = mock_304

        self.transport.pull(self.test_path)

        # read should not be called on 304 responses
        mock_304.read.assert_not_called()

    def test_new_200_updates_cache(self):
        """New 200 response replaces cached ETag and bytes."""
        # First pull
        self.mock_urlopen.return_value = _make_response(
            200, b"old_data", {"ETag": '"old"'}
        )
        self.transport.pull(self.test_path)

        # Second pull: new data, new ETag
        new_body = b"new_data"
        self.mock_urlopen.return_value = _make_response(
            200, new_body, {"ETag": '"new"'}
        )
        result = self.transport.pull(self.test_path)

        self.assertEqual(result, new_body)

        # Third pull should send new ETag
        self.mock_urlopen.return_value = _make_response(304, b"")
        self.transport.pull(self.test_path)

        request = self.mock_urlopen.call_args[0][0]
        sent_etag = _get_header(request, "If-None-Match")
        self.assertEqual(sent_etag, '"new"')

    def test_push_clears_etag_cache_for_that_path(self):
        """Push for a path clears the ETag cache — next pull is fresh."""
        # Pull to cache ETag
        self.mock_urlopen.return_value = _make_response(
            200, self.test_body, {"ETag": '"stale"'}
        )
        self.transport.pull(self.test_path)

        # Push (same path)
        self.mock_urlopen.return_value = _make_response(200, b"ok")
        self.transport.push(self.test_path, b"new data")

        # Next pull should NOT send If-None-Match (cache cleared)
        self.mock_urlopen.return_value = _make_response(200, b"fresh", {"ETag": '"fresh"'})
        self.transport.pull(self.test_path)

        request = self.mock_urlopen.call_args[0][0]
        sent_etag = _get_header(request, "If-None-Match")
        self.assertIsNone(sent_etag)

    def test_independent_etag_per_path(self):
        """Different paths have independent ETag caches."""
        path_a = "staging/blobs/current.json"
        path_b = "ledger/index.json"

        # Pull path A → ETag "A"
        self.mock_urlopen.return_value = _make_response(
            200, b"a", {"ETag": '"A"'}
        )
        self.transport.pull(path_a)

        # Pull path B → ETag "B"
        self.mock_urlopen.return_value = _make_response(
            200, b"b", {"ETag": '"B"'}
        )
        self.transport.pull(path_b)

        # Pull path A again — should send "A", not "B"
        self.mock_urlopen.return_value = _make_response(304, b"")
        self.transport.pull(path_a)

        request = self.mock_urlopen.call_args[0][0]
        sent_etag = _get_header(request, "If-None-Match")
        self.assertEqual(sent_etag, '"A"')

    def test_etag_without_quotes_preserved(self):
        """ETag values without surrounding quotes are used as-is."""
        self.mock_urlopen.return_value = _make_response(
            200, self.test_body, {"ETag": "abc123"}
        )
        self.transport.pull(self.test_path)

        self.mock_urlopen.return_value = _make_response(304, b"")
        self.transport.pull(self.test_path)

        request = self.mock_urlopen.call_args[0][0]
        sent_etag = _get_header(request, "If-None-Match")
        self.assertEqual(sent_etag, "abc123")

    def test_weak_etag_handled(self):
        """Weak ETags (W/ prefix) are stored and sent as-is."""
        self.mock_urlopen.return_value = _make_response(
            200, self.test_body, {"ETag": 'W/"abc"'}
        )
        self.transport.pull(self.test_path)

        self.mock_urlopen.return_value = _make_response(304, b"")
        self.transport.pull(self.test_path)

        request = self.mock_urlopen.call_args[0][0]
        sent_etag = _get_header(request, "If-None-Match")
        self.assertEqual(sent_etag, 'W/"abc"')

    def test_no_etag_in_response_no_caching(self):
        """If server doesn't send ETag, no caching occurs."""
        # First pull: no ETag header
        self.mock_urlopen.return_value = _make_response(200, self.test_body)
        self.transport.pull(self.test_path)

        # Second pull should have no If-None-Match
        self.mock_urlopen.return_value = _make_response(200, self.test_body)
        self.transport.pull(self.test_path)

        request = self.mock_urlopen.call_args[0][0]
        sent_etag = _get_header(request, "If-None-Match")
        self.assertIsNone(sent_etag)

    def test_cache_purged_on_transport_reset(self):
        """ETag cache can be explicitly cleared (e.g., after migration)."""
        self.mock_urlopen.return_value = _make_response(
            200, self.test_body, {"ETag": '"stale"'}
        )
        self.transport.pull(self.test_path)

        # Clear the cache
        self.transport.reset_cache()

        # Next pull should be fresh (no If-None-Match)
        self.mock_urlopen.return_value = _make_response(200, self.test_body, {"ETag": '"fresh"'})
        self.transport.pull(self.test_path)

        request = self.mock_urlopen.call_args[0][0]
        sent_etag = _get_header(request, "If-None-Match")
        self.assertIsNone(sent_etag)


class TestHttpTransportErrors(unittest.TestCase):
    """Layer 3 — Error handling, timeouts, network failures."""

    def setUp(self):
        self.mock_urlopen = patch(
            "urllib.request.urlopen"
        ).start()
        self.addCleanup(patch.stopall)

        from core.sync.http_transport import HttpStagingTransport
        self.transport = HttpStagingTransport(base_url="https://worker.example.com")

    def test_connection_refused(self):
        """Connection refused error raises RuntimeError."""
        self.mock_urlopen.side_effect = URLError("[Errno 111] Connection refused")

        with self.assertRaises(RuntimeError):
            self.transport.pull("staging/blobs/current.json")

    def test_dns_failure(self):
        """DNS resolution failure raises RuntimeError."""
        self.mock_urlopen.side_effect = URLError("[Errno -2] Name or service not known")

        with self.assertRaises(RuntimeError):
            self.transport.pull("staging/blobs/current.json")

    def test_timeout(self):
        """Timeout raises RuntimeError."""
        self.mock_urlopen.side_effect = TimeoutError("timed out")

        with self.assertRaises(RuntimeError):
            self.transport.pull("staging/blobs/current.json")

    def test_timeout_on_push(self):
        """Timeout on push raises RuntimeError."""
        self.mock_urlopen.side_effect = TimeoutError("timed out")

        with self.assertRaises(RuntimeError):
            self.transport.push("staging/blobs/current.json", b"data")

    def test_network_unreachable_on_list_files(self):
        """Network error on list_files raises RuntimeError."""
        self.mock_urlopen.side_effect = URLError("[Errno 101] Network is unreachable")

        with self.assertRaises(RuntimeError):
            self.transport.list_files("ledger/blocks/")

    def test_binary_data_round_trip(self):
        """Push arbitrary bytes → pull same path → identical bytes."""
        push_body = bytes(range(256))  # All byte values 0-255
        self.mock_urlopen.return_value = _make_response(200, b"ok")

        self.transport.push("staging/blobs/current.json", push_body)

        # Capture what was sent, make pull return it
        call_args = self.mock_urlopen.call_args
        request = call_args[0][0]
        sent_data = request.data if hasattr(request, 'data') else push_body

        self.mock_urlopen.return_value = _make_response(200, sent_data)
        pulled = self.transport.pull("staging/blobs/current.json")

        self.assertEqual(pulled, push_body)

    def test_empty_body_pull(self):
        """Pull returning empty bytes is valid (edge case)."""
        self.mock_urlopen.return_value = _make_response(200, b"")

        result = self.transport.pull("staging/blobs/empty.json")

        self.assertEqual(result, b"")

    def test_unicode_paths(self):
        """Paths with unicode characters work correctly.

        urllib.request.Request stores the URL as-is; urlopen handles
        encoding when making the actual request. The transport should
        pass the path through faithfully.
        """
        self.mock_urlopen.return_value = _make_response(200, b"data")

        self.transport.pull("staging/blobs/café.json")

        request = self.mock_urlopen.call_args[0][0]
        call_url = _request_url(request)
        # The path is passed through as-is; urlopen encodes when
        # making the actual request. Just verify the path appears.
        self.assertIn("café.json", call_url)


class TestHttpTransportIntegration(unittest.TestCase):
    """Layer 4+5 — Integration with RemoteStagingSync and RemoteLedgerSync.

    These tests verify that the existing domain sync modules work correctly
    when backed by HttpStagingTransport instead of InMemoryStagingTransport.
    """

    def setUp(self):
        # Patch urlopen for all tests in this class
        self.urlopen_patcher = patch("urllib.request.urlopen")
        self.mock_urlopen = self.urlopen_patcher.start()
        self.addCleanup(patch.stopall)

        from core.sync.http_transport import HttpStagingTransport
        from domain.staging.remote_sync import RemoteStagingSync
        from security.crypto import NoAuthCryptoManager
        from security.device_identity import (
            AbstractDeviceIdentityProvider,
            DeviceIdentity,
        )

        # Simple identity provider
        class TestIdentityProvider(AbstractDeviceIdentityProvider):
            def get_device_identity(self, master_key: bytes) -> DeviceIdentity:
                return DeviceIdentity(
                    device_id="test-device-id",
                    device_label="test",
                    device_proof="mock-proof",
                )

            def verify_device_proof(self, device_id: str, proof: bytes) -> bool:
                return True

            def check_remote_identity(
                self, master_key: bytes, remote_device_id: str
            ) -> bool:
                return remote_device_id == "test-device-id"

        self.transport = HttpStagingTransport(base_url="https://worker.example.com")
        self.crypto = NoAuthCryptoManager()
        self.master_key = bytes(32)
        self.identity_provider = TestIdentityProvider()

        self.remote_sync = RemoteStagingSync(
            crypto=self.crypto,
            transport=self.transport,
            device_id_provider=self.identity_provider,
            master_key=self.master_key,
        )

    # ── RemoteStagingSync with HTTP ──────────────────────────────────────

    def test_remote_sync_push_pull_round_trip(self):
        """Push entries via HTTP → pull same entries back."""
        entries = [
            {"entry_id": "e1", "title": "Task 1", "state": "active"},
            {"entry_id": "e2", "title": "Task 2", "state": "paused"},
        ]
        device_id = "test-device-id"

        # Push — mock the PUT response
        self.mock_urlopen.return_value = _make_response(200, b"ok")
        self.remote_sync.push(entries, device_id)

        # Pull — mock the GET response with the obfuscated blob
        # We need to capture what was sent and return it on pull
        push_call = self.mock_urlopen.call_args_list[0]
        push_request = push_call[0][0]
        pushed_bytes = push_request.data

        self.mock_urlopen.return_value = _make_response(200, pushed_bytes)
        pulled = self.remote_sync.pull(master_key=self.master_key)

        self.assertIsNotNone(pulled)
        self.assertEqual(pulled["device_id"], device_id)
        self.assertEqual(len(pulled["entries"]), 2)
        self.assertEqual(pulled["entries"][0]["entry_id"], "e1")

    def test_remote_sync_pull_returns_none_when_no_blob(self):
        """RemoteStagingSync.pull returns None when HTTP returns 404."""
        self.mock_urlopen.side_effect = _make_http_error(404)

        result = self.remote_sync.pull(master_key=self.master_key)

        self.assertIsNone(result)

    def test_pull_cookie_uses_correct_path(self):
        """pull_cookie sends GET to staging/blobs/device_cookie.bin."""
        self.mock_urlopen.return_value = _make_response(200, b"\x00" * 32)

        self.remote_sync.pull_cookie()

        request = self.mock_urlopen.call_args[0][0]
        call_url = _request_url(request)
        self.assertIn("device_cookie.bin", call_url)

    def test_push_cookie_uses_correct_path(self):
        """push_cookie sends PUT to staging/blobs/device_cookie.bin."""
        self.mock_urlopen.return_value = _make_response(200, b"ok")

        self.remote_sync.push_cookie(b"\x00" * 32)

        request = self.mock_urlopen.call_args[0][0]
        call_url = _request_url(request)
        self.assertIn("device_cookie.bin", call_url)

    def test_check_remote_available_healthy(self):
        """check_remote_available returns True when server responds."""
        self.mock_urlopen.return_value = _make_response(200, b"{}")

        result = self.remote_sync.check_remote_available(timeout_ms=500)

        self.assertTrue(result)

    def test_check_remote_available_unreachable(self):
        """check_remote_available returns False on connection error."""
        self.mock_urlopen.side_effect = URLError("Connection refused")

        result = self.remote_sync.check_remote_available(timeout_ms=500)

        self.assertFalse(result)

    def test_check_remote_available_timeout(self):
        """check_remote_available returns False when request exceeds timeout.

        Note: This test verifies the timeout logic in check_remote_available,
        which measures elapsed wall time. We simulate a slow response.
        """
        def _slow_response(*args, **kwargs):
            time.sleep(0.05)  # 50ms delay
            return _make_response(200, b"{}")

        self.mock_urlopen.side_effect = _slow_response

        # With a very short timeout (10ms), the 50ms response should exceed it
        result = self.remote_sync.check_remote_available(timeout_ms=10)

        self.assertFalse(result)

    def test_check_device_via_http(self):
        """check_device works over HTTP transport."""
        # Push a blob for this device
        self.mock_urlopen.return_value = _make_response(200, b"ok")
        self.remote_sync.push(
            [{"entry_id": "e1", "title": "Test", "state": "active"}],
            "test-device-id",
        )

        # Pull — return the pushed blob
        push_call = self.mock_urlopen.call_args_list[0]
        push_request = push_call[0][0]
        pushed_bytes = push_request.data

        self.mock_urlopen.return_value = _make_response(200, pushed_bytes)
        matches = self.remote_sync.check_device(master_key=self.master_key)

        self.assertTrue(matches)

    # ── RemoteLedgerSync with HTTP ───────────────────────────────────────

    def test_ledger_push_blocks_via_http(self):
        """RemoteLedgerSync.push_blocks sends PUTs for new blocks."""
        from domain.ledger.remote_sync import RemoteLedgerSync

        ledger_sync = RemoteLedgerSync(
            transport=self.transport,
            master_key=self.master_key,
        )

        blocks = [
            {"day_hash": "hash0", "prev_hash": None, "entries": []},
            {"day_hash": "hash1", "prev_hash": "hash0", "entries": []},
        ]

        # push_blocks makes: 1 list_files call + 2 push calls
        self.mock_urlopen.side_effect = [
            _make_response(200, b"[]"),          # list_files → empty
            _make_response(200, b"ok"),           # push block 0
            _make_response(200, b"ok"),           # push block 1
        ]

        count = ledger_sync.push_blocks(blocks)

        self.assertEqual(count, 2)
        # Verify list_files was called first, then two pushes
        self.assertEqual(len(self.mock_urlopen.call_args_list), 3)

    def test_ledger_push_blocks_skips_existing(self):
        """RemoteLedgerSync.push_blocks skips blocks already on remote."""
        from domain.ledger.remote_sync import RemoteLedgerSync

        ledger_sync = RemoteLedgerSync(
            transport=self.transport,
            master_key=self.master_key,
        )

        blocks = [
            {"day_hash": "hash0", "prev_hash": None, "entries": []},
            {"day_hash": "hash1", "prev_hash": "hash0", "entries": []},
        ]

        # push_blocks makes: 1 list_files call + 1 push call (block 1 only)
        self.mock_urlopen.side_effect = [
            _make_response(200, json.dumps(
                ["000000.json"]
            ).encode("utf-8")),                    # list_files → block 0 exists
            _make_response(200, b"ok"),            # push block 1 only
        ]

        count = ledger_sync.push_blocks(blocks)

        self.assertEqual(count, 1)
        # Verify only 2 calls: list_files + 1 push
        self.assertEqual(len(self.mock_urlopen.call_args_list), 2)

    def test_ledger_pull_blocks_via_http(self):
        """RemoteLedgerSync.pull_blocks pulls missing blocks via HTTP."""
        from domain.ledger.remote_sync import RemoteLedgerSync
        from domain.staging.remote_sync import RemoteStagingSync

        ledger_sync = RemoteLedgerSync(
            transport=self.transport,
            master_key=self.master_key,
        )

        block0 = {"day_hash": "hash0", "prev_hash": None, "entries": []}
        block1 = {"day_hash": "hash1", "prev_hash": "hash0", "entries": []}

        # list_files returns 2 blocks
        self.mock_urlopen.return_value = _make_response(
            200, json.dumps(["000000.json", "000001.json"]).encode("utf-8")
        )

        # pull_blocks for each missing index
        obfuscated0 = RemoteStagingSync._obfuscate(
            json.dumps(block0).encode("utf-8"), self.master_key
        )
        obfuscated1 = RemoteStagingSync._obfuscate(
            json.dumps(block1).encode("utf-8"), self.master_key
        )

        # Mock responses: list, then block0, then block1
        self.mock_urlopen.side_effect = [
            _make_response(200, json.dumps(
                ["000000.json", "000001.json"]
            ).encode("utf-8")),
            _make_response(200, obfuscated0),
            _make_response(200, obfuscated1),
        ]

        new_blocks, total = ledger_sync.pull_blocks(local_blocks=None)

        self.assertIsNotNone(new_blocks)
        self.assertEqual(total, 2)
        self.assertEqual(len(new_blocks), 2)
        self.assertEqual(new_blocks[0]["day_hash"], "hash0")
        self.assertEqual(new_blocks[1]["day_hash"], "hash1")

    def test_ledger_pull_index_via_http(self):
        """RemoteLedgerSync.pull_index works over HTTP."""
        from domain.ledger.remote_sync import RemoteLedgerSync
        from domain.staging.remote_sync import RemoteStagingSync

        ledger_sync = RemoteLedgerSync(
            transport=self.transport,
            master_key=self.master_key,
        )

        index_data = {"2026-05-25": {"tasks": 3}}
        obfuscated = RemoteStagingSync._obfuscate(
            json.dumps(index_data).encode("utf-8"), self.master_key
        )

        self.mock_urlopen.return_value = _make_response(200, obfuscated)

        result = ledger_sync.pull_index()

        self.assertEqual(result, index_data)

    def test_ledger_push_index_via_http(self):
        """RemoteLedgerSync.push_index works over HTTP."""
        from domain.ledger.remote_sync import RemoteLedgerSync

        ledger_sync = RemoteLedgerSync(
            transport=self.transport,
            master_key=self.master_key,
        )

        index_data = {"2026-05-25": {"tasks": 3}}
        self.mock_urlopen.return_value = _make_response(200, b"ok")

        ledger_sync.push_index(index_data)

        # Verify PUT to index path
        request = self.mock_urlopen.call_args[0][0]
        call_url = _request_url(request)
        self.assertIn("ledger/index.json", call_url)

    def test_ledger_list_files_via_http(self):
        """RemoteLedgerSync._list_remote_block_indices works over HTTP."""
        from domain.ledger.remote_sync import RemoteLedgerSync

        ledger_sync = RemoteLedgerSync(
            transport=self.transport,
            master_key=self.master_key,
        )

        self.mock_urlopen.return_value = _make_response(
            200, json.dumps(
                ["000000.json", "000001.json", "000042.json"]
            ).encode("utf-8")
        )

        # _list_remote_block_indices is the internal method; we can access it
        # via get_remote_block_count which calls it
        count = ledger_sync.get_remote_block_count()

        self.assertEqual(count, 43)  # max index + 1


class TestHttpTransportWithWorkerContract(unittest.TestCase):
    """Layer 5 — Tests that define the HTTP contract the Worker must implement.

    These tests document the exact request/response format the Python CLI
    expects from the server (Worker or any other HTTP backend).
    """

    def setUp(self):
        self.mock_urlopen = patch(
            "urllib.request.urlopen"
        ).start()
        self.addCleanup(patch.stopall)

        from core.sync.http_transport import HttpStagingTransport
        self.transport = HttpStagingTransport(base_url="https://worker.example.com")

    def test_pull_expects_200_with_body(self):
        """Contract: GET /{path} → 200 + body bytes + optional ETag header."""
        body = b'{"entries": []}'
        self.mock_urlopen.return_value = _make_response(200, body, {
            "ETag": '"v1"',
            "Content-Type": "application/octet-stream",
        })

        result = self.transport.pull("staging/blobs/current.json")

        self.assertEqual(result, body)
        # Should pass through the ETag for later 304 usage
        request = self.mock_urlopen.call_args[0][0]
        # First call has no If-None-Match (verified in other tests)

    def test_pull_expects_404_on_missing(self):
        """Contract: GET /{nonexistent} → 404 (body unused, treated as None)."""
        self.mock_urlopen.side_effect = _make_http_error(404)

        result = self.transport.pull("nonexistent/path")

        self.assertIsNone(result)

    def test_pull_expects_304_without_body(self):
        """Contract: GET /{path} with If-None-Match → 304 (empty body, cached)."""
        self.mock_urlopen.return_value = _make_response(200, b"data", {"ETag": '"x"'})
        self.transport.pull("staging/blobs/current.json")

        self.mock_urlopen.return_value = _make_response(304, b"", {"ETag": '"x"'})
        result = self.transport.pull("staging/blobs/current.json")

        self.assertEqual(result, b"data")

    def test_put_expects_200_on_success(self):
        """Contract: PUT /{path} body → 200 (any 2xx accepted)."""
        self.mock_urlopen.return_value = _make_response(201, b"created")

        # Should not raise
        self.transport.push("staging/blobs/current.json", b"data")

    def test_list_expects_200_with_json_array(self):
        """Contract: GET /?prefix={prefix} → 200 + JSON array of filenames."""
        self.mock_urlopen.return_value = _make_response(
            200, b'["000000.json", "000001.json"]'
        )

        files = self.transport.list_files("ledger/blocks/")

        self.assertEqual(files, ["000000.json", "000001.json"])

    def test_list_expects_404_as_empty(self):
        """Contract: GET /?prefix={missing} → 404 (treated as empty list)."""
        self.mock_urlopen.side_effect = _make_http_error(404)

        files = self.transport.list_files("nonexistent/")

        self.assertEqual(files, [])

    def test_auth_required(self):
        """Contract: Worker must enforce auth — 401/403 → RuntimeError.

        The transport itself does not handle auth; the Worker is responsible
        for rejecting unauthenticated requests. The Python side treats any
        non-404 4xx as a RuntimeError.
        """
        self.mock_urlopen.side_effect = _make_http_error(401, b"unauthorized")

        with self.assertRaises(RuntimeError) as ctx:
            self.transport.pull("staging/blobs/current.json")

        self.assertIn("401", str(ctx.exception))

    def test_content_type_octet_stream(self):
        """Contract: push sends Content-Type: application/octet-stream."""
        self.mock_urlopen.return_value = _make_response(200, b"ok")

        self.transport.push("staging/blobs/current.json", b"data")

        request = self.mock_urlopen.call_args[0][0]
        ct = _get_header(request, "Content-Type")
        self.assertEqual(ct, "application/octet-stream")

    def test_paths_are_relative(self):
        """Contract: Paths are relative ('staging/blobs/...'), not absolute.

        The transport prepends the base URL. Paths should never start with /.
        """
        self.mock_urlopen.return_value = _make_response(200, b"data")

        # Path starting with / could cause double-slash in URL
        self.transport.pull("/staging/blobs/current.json")

        request = self.mock_urlopen.call_args[0][0]
        call_url = _request_url(request)
        # Should not have double slashes in the middle
        self.assertNotIn("//staging", call_url)


if __name__ == "__main__":
    unittest.main()
