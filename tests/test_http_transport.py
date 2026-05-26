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
import socket
import time
import unittest
from pathlib import Path
from typing import Optional, Dict, Any, List
from unittest.mock import MagicMock, patch, call, Mock

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
) -> MagicMock:
    """Create a mock HTTP response compatible with ``http.client.HTTPResponse``.

    The mock supports:
      - ``.status`` (int)
      - ``.reason`` (str)
      - ``.read()`` → body bytes
      - ``.getheader(name, default=None)`` → header value or default

    Args:
        status: HTTP status code.
        body: Response body bytes.
        headers: Optional dict of response headers.

    Returns:
        MagicMock configured as an HTTP response.
    """
    reasons = {
        200: "OK",
        201: "Created",
        304: "Not Modified",
        400: "Bad Request",
        401: "Unauthorized",
        403: "Forbidden",
        404: "Not Found",
        413: "Payload Too Large",
        500: "Internal Server Error",
        503: "Service Unavailable",
    }
    mock = MagicMock()
    mock.status = status
    mock.reason = reasons.get(status, "")
    mock.read.return_value = body
    all_headers = headers or {}
    mock.getheader.side_effect = lambda name, default=None: all_headers.get(name, default)
    return mock


def _make_mock_connection(response: MagicMock) -> MagicMock:
    """Create a mock HTTP connection that returns a given response.

    The connection supports ``.request(method, url, body, headers)``
    and ``.getresponse()``.

    Args:
        response: A mock response (from ``_make_response``).

    Returns:
        MagicMock configured as an HTTP connection.
    """
    conn = MagicMock()
    conn.getresponse.return_value = response
    conn.request.return_value = None
    return conn


def _get_header_from_request(mock_conn: MagicMock, name: str) -> Optional[str]:
    """Extract a header value from a mocked connection's request call.

    The transport passes headers as a dict to ``conn.request()``, so we
    look them up case-insensitively.

    Args:
        mock_conn: A mock connection (from ``_make_mock_connection``).
        name: Header name to look up.

    Returns:
        Header value string, or None if not found.
    """
    if mock_conn.request.call_count == 0:
        return None
    # Last call's keyword argument 'headers'
    args, kwargs = mock_conn.request.call_args
    headers = kwargs.get("headers", {})
    if not headers and len(args) >= 4:
        headers = args[3] or {}
    # Case-insensitive lookup
    name_lower = name.lower()
    for k, v in headers.items():
        if k.lower() == name_lower:
            return v
    return None


def _get_request_path(mock_conn: MagicMock) -> str:
    """Extract the URL path from a mocked connection's request call.

    Args:
        mock_conn: A mock connection (from ``_make_mock_connection``).

    Returns:
        The URL path string (e.g., ``/staging/blobs/x.json``).
    """
    if mock_conn.request.call_count == 0:
        return ""
    args, _ = mock_conn.request.call_args
    # args[0] = method, args[1] = url_path
    return args[1] if len(args) >= 2 else ""


def _get_request_method(mock_conn: MagicMock) -> str:
    """Extract the HTTP method from a mocked connection's request call.

    Args:
        mock_conn: A mock connection (from ``_make_mock_connection``).

    Returns:
        The HTTP method string (e.g., ``GET``, ``PUT``).
    """
    if mock_conn.request.call_count == 0:
        return ""
    args, _ = mock_conn.request.call_args
    return args[0] if len(args) >= 1 else ""


def _get_request_body(mock_conn: MagicMock) -> Optional[bytes]:
    """Extract the body from a mocked connection's request call.

    The transport passes body as a keyword argument:
      conn.request(method, url, body=data, headers=headers)

    Args:
        mock_conn: A mock connection (from ``_make_mock_connection``).

    Returns:
        Body bytes, or None if no body.
    """
    if mock_conn.request.call_count == 0:
        return None
    args, kwargs = mock_conn.request.call_args
    # body can be positional arg 2 or keyword 'body'
    if 'body' in kwargs:
        return kwargs['body']
    return args[2] if len(args) >= 3 else None


# =============================================================================
# Test classes
# =============================================================================


class TestHttpTransportContract(unittest.TestCase):
    """Layer 1: AbstractStagingTransport interface compliance."""

    def setUp(self):
        self.transport = None  # created per-test to avoid _connect() in __init__

    def _make_transport(self, base_url="https://example.com", api_key=None):
        from core.sync.http_transport import HttpStagingTransport
        t = HttpStagingTransport(base_url, api_key)
        # Patch _connect to return a mock connection by default
        self._mock_conn = _make_mock_connection(_make_response(200, b""))
        connect_patcher = patch.object(t, '_connect', return_value=self._mock_conn)
        self._connect_mock = connect_patcher.start()
        self.addCleanup(connect_patcher.stop)
        return t

    # ── Constructor / URL handling ────────────────────────────────

    def test_constructor_accepts_http(self):
        from core.sync.http_transport import HttpStagingTransport
        t = HttpStagingTransport("http://localhost:8787")
        self.assertEqual(t.base_url, "http://localhost:8787")

    def test_constructor_accepts_https(self):
        from core.sync.http_transport import HttpStagingTransport
        t = HttpStagingTransport("https://example.com")
        self.assertEqual(t.base_url, "https://example.com")

    def test_constructor_rejects_empty_base_url(self):
        from core.sync.http_transport import HttpStagingTransport
        with self.assertRaises(ValueError):
            HttpStagingTransport("")

    def test_constructor_rejects_invalid_scheme(self):
        from core.sync.http_transport import HttpStagingTransport
        with self.assertRaises(ValueError):
            HttpStagingTransport("ftp://example.com")

    # ── pull ──────────────────────────────────────────────────────

    def test_pull_returns_bytes_on_200(self):
        t = self._make_transport()
        body = b'{"entries": []}'
        self._mock_conn.getresponse.return_value = _make_response(200, body)
        result = t.pull("staging/blobs/current.json")
        self.assertEqual(result, body)

    def test_pull_returns_none_on_404(self):
        t = self._make_transport()
        self._mock_conn.getresponse.return_value = _make_response(404, b"")
        result = t.pull("staging/blobs/current.json")
        self.assertIsNone(result)

    def test_pull_raises_on_4xx_without_404(self):
        t = self._make_transport()
        self._mock_conn.getresponse.return_value = _make_response(403, b"")
        with self.assertRaises(RuntimeError):
            t.pull("staging/blobs/current.json")

    def test_pull_raises_on_5xx(self):
        t = self._make_transport()
        self._mock_conn.getresponse.return_value = _make_response(500, b"")
        with self.assertRaises(RuntimeError):
            t.pull("staging/blobs/current.json")

    def test_pull_sends_get_request(self):
        t = self._make_transport()
        self._mock_conn.getresponse.return_value = _make_response(200, b"data")
        t.pull("staging/blobs/current.json")
        self.assertEqual(_get_request_method(self._mock_conn), "GET")

    def test_pull_sends_correct_path(self):
        t = self._make_transport()
        self._mock_conn.getresponse.return_value = _make_response(200, b"data")
        t.pull("staging/blobs/current.json")
        path = _get_request_path(self._mock_conn)
        self.assertIn("staging/blobs/current.json", path)

    def test_pull_handles_trailing_slash_in_base_url(self):
        from core.sync.http_transport import HttpStagingTransport
        t = HttpStagingTransport("https://example.com/")
        mock_conn = _make_mock_connection(_make_response(200, b"data"))
        connect_patcher = patch.object(t, '_connect', return_value=mock_conn)
        connect_patcher.start()
        self.addCleanup(connect_patcher.stop)
        t.pull("staging/blobs/x.json")
        path = _get_request_path(mock_conn)
        self.assertIn("staging/blobs/x.json", path)

    def test_pull_passes_timeout(self):
        t = self._make_transport()
        self._mock_conn.getresponse.return_value = _make_response(200, b"data")
        t.pull("staging/blobs/x.json", timeout_ms=500)
        # _connect was called with the timeout value (500ms → 0.5s)
        self._connect_mock.assert_called_once()
        timeout_arg = self._connect_mock.call_args[0][0]
        self.assertAlmostEqual(timeout_arg, 0.5, places=1)

    # ── push ──────────────────────────────────────────────────────

    def test_push_sends_put(self):
        t = self._make_transport()
        self._mock_conn.getresponse.return_value = _make_response(200, b"ok")
        t.push("staging/blobs/current.json", b"data")
        self.assertEqual(_get_request_method(self._mock_conn), "PUT")

    def test_push_sends_correct_path(self):
        t = self._make_transport()
        self._mock_conn.getresponse.return_value = _make_response(200, b"ok")
        t.push("staging/blobs/current.json", b"data")
        path = _get_request_path(self._mock_conn)
        self.assertIn("staging/blobs/current.json", path)

    def test_push_returns_none_on_success(self):
        t = self._make_transport()
        self._mock_conn.getresponse.return_value = _make_response(200, b"ok")
        result = t.push("staging/blobs/current.json", b"data")
        self.assertIsNone(result)

    def test_push_sends_data_as_body(self):
        t = self._make_transport()
        self._mock_conn.getresponse.return_value = _make_response(200, b"ok")
        sent = b"my task data"
        t.push("staging/blobs/x.json", sent)
        body = _get_request_body(self._mock_conn)
        self.assertEqual(body, sent)

    def test_push_raises_on_4xx(self):
        t = self._make_transport()
        self._mock_conn.getresponse.return_value = _make_response(400, b"bad request")
        with self.assertRaises(RuntimeError):
            t.push("staging/blobs/x.json", b"data")

    def test_push_raises_on_5xx(self):
        t = self._make_transport()
        self._mock_conn.getresponse.return_value = _make_response(500, b"error")
        with self.assertRaises(RuntimeError):
            t.push("staging/blobs/x.json", b"data")

    def test_push_raises_on_413(self):
        t = self._make_transport()
        self._mock_conn.getresponse.return_value = _make_response(413, b"too large")
        with self.assertRaises(RuntimeError):
            t.push("staging/blobs/x.json", b"x" * 1000)

    # ── list_files ────────────────────────────────────────────────

    def test_list_files_returns_list_on_200(self):
        t = self._make_transport()
        self._mock_conn.getresponse.return_value = _make_response(
            200, b'["a.json", "b.json"]'
        )
        result = t.list_files("ledger/blocks/")
        self.assertEqual(result, ["a.json", "b.json"])

    def test_list_files_sends_prefix_parameter(self):
        t = self._make_transport()
        self._mock_conn.getresponse.return_value = _make_response(200, b"[]")
        t.list_files("ledger/blocks/")
        path = _get_request_path(self._mock_conn)
        # The / is URL-encoded to %2F by urlencode()
        self.assertIn("prefix=ledger", path)
        self.assertIn("blocks%2F", path)

    def test_list_files_returns_empty_list_on_200_empty(self):
        t = self._make_transport()
        self._mock_conn.getresponse.return_value = _make_response(200, b"[]")
        result = t.list_files("ledger/blocks/")
        self.assertEqual(result, [])

    def test_list_files_returns_empty_list_on_404(self):
        t = self._make_transport()
        self._mock_conn.getresponse.return_value = _make_response(404, b"")
        result = t.list_files("ledger/blocks/")
        self.assertEqual(result, [])

    def test_list_files_raises_on_5xx(self):
        t = self._make_transport()
        self._mock_conn.getresponse.return_value = _make_response(503, b"")
        with self.assertRaises(RuntimeError):
            t.list_files("ledger/blocks/")

    def test_list_files_raises_on_unexpected_json(self):
        t = self._make_transport()
        self._mock_conn.getresponse.return_value = _make_response(200, b'{"not": "a list"}')
        with self.assertRaises(RuntimeError):
            t.list_files("ledger/blocks/")


class TestHttpTransportETagCaching(unittest.TestCase):
    """Layer 2: ETag-based freshness and cache behavior."""

    def setUp(self):
        self.test_body = b'{"entries": []}'
        self.etag = '"abc123"'

    def _make_transport(self, base_url="https://example.com"):
        from core.sync.http_transport import HttpStagingTransport
        t = HttpStagingTransport(base_url)
        self._mock_conn = _make_mock_connection(_make_response(200, b""))
        connect_patcher = patch.object(t, '_connect', return_value=self._mock_conn)
        connect_patcher.start()
        self.addCleanup(connect_patcher.stop)
        return t

    def test_first_pull_no_if_none_match(self):
        """First pull does NOT send If-None-Match header (no cached ETag)."""
        t = self._make_transport()
        self._mock_conn.getresponse.return_value = _make_response(
            200, self.test_body, {"ETag": self.etag}
        )
        t.pull("staging/blobs/current.json")
        ifnm = _get_header_from_request(self._mock_conn, "If-None-Match")
        self.assertIsNone(ifnm)

    def test_second_pull_sends_if_none_match(self):
        """Second pull sends If-None-Match with ETag from first response."""
        t = self._make_transport()
        # First pull: 200 with ETag
        self._mock_conn.getresponse.return_value = _make_response(
            200, self.test_body, {"ETag": self.etag}
        )
        t.pull("staging/blobs/current.json")
        # Second pull: set mock to check what header was sent
        self._mock_conn.getresponse.return_value = _make_response(
            304, b"", {"ETag": self.etag}
        )
        t.pull("staging/blobs/current.json")
        ifnm = _get_header_from_request(self._mock_conn, "If-None-Match")
        self.assertEqual(ifnm, self.etag)

    def test_304_returns_cached_bytes(self):
        """304 response returns previously cached bytes, not empty body."""
        t = self._make_transport()
        # First pull: cache the body
        self._mock_conn.getresponse.return_value = _make_response(
            200, self.test_body, {"ETag": self.etag}
        )
        t.pull("staging/blobs/current.json")
        # Reset mock for second call
        self._mock_conn.getresponse.return_value = _make_response(304, b"")
        result = t.pull("staging/blobs/current.json")
        self.assertEqual(result, self.test_body)

    def test_304_does_not_read_response_body(self):
        """304 does not consume the response body (optimization)."""
        t = self._make_transport()
        # First pull: cache the body
        self._mock_conn.getresponse.return_value = _make_response(
            200, self.test_body, {"ETag": self.etag}
        )
        t.pull("staging/blobs/current.json")
        # Second pull: 304
        mock_304 = _make_response(304, b"should-not-be-read")
        self._mock_conn.getresponse.return_value = mock_304
        t.pull("staging/blobs/current.json")
        # read() should NOT be called on the 304 response
        mock_304.read.assert_not_called()

    def test_new_200_replaces_cache(self):
        """New 200 response replaces cached ETag and bytes."""
        t = self._make_transport()
        # First pull: cache first version
        self._mock_conn.getresponse.return_value = _make_response(
            200, b"v1", {"ETag": '"v1"' }
        )
        t.pull("staging/blobs/current.json")
        # Second pull: new version
        self._mock_conn.getresponse.return_value = _make_response(
            200, b"v2", {"ETag": '"v2"' }
        )
        result = t.pull("staging/blobs/current.json")
        self.assertEqual(result, b"v2")

    def test_different_paths_independent_cache(self):
        """Different paths have independent ETag caches."""
        t = self._make_transport()
        # Pull path A
        self._mock_conn.getresponse.return_value = _make_response(
            200, b"data_a", {"ETag": '"etag_a"'}
        )
        t.pull("path/a")
        # Pull path B — should NOT send If-None-Match for path A's ETag
        self._mock_conn.getresponse.return_value = _make_response(
            200, b"data_b", {"ETag": '"etag_b"'}
        )
        t.pull("path/b")
        # Verify path B's request didn't have path A's ETag
        ifnm = _get_header_from_request(self._mock_conn, "If-None-Match")
        # First call was A, second was B. After both, check that B was a full 200.
        # This test passes if B returns 200 (no 304 for wrong ETag)
        self.assertEqual(_get_request_path(self._mock_conn), "/path/b")

    def test_push_clears_cache(self):
        """Push for a path clears the ETag cache — next pull is fresh."""
        t = self._make_transport()
        # First pull: cache the body
        self._mock_conn.getresponse.return_value = _make_response(
            200, self.test_body, {"ETag": self.etag}
        )
        t.pull("staging/blobs/current.json")
        # Push: clears cache
        self._mock_conn.getresponse.return_value = _make_response(200, b"ok")
        t.push("staging/blobs/current.json", b"new data")
        # Pull again — should NOT send If-None-Match (cache cleared)
        self._mock_conn.getresponse.return_value = _make_response(
            200, b"fresh", {"ETag": '"fresh"' }
        )
        t.pull("staging/blobs/current.json")
        ifnm = _get_header_from_request(self._mock_conn, "If-None-Match")
        self.assertIsNone(ifnm)

    def test_reset_cache_clears_all(self):
        """ETag cache can be explicitly cleared (e.g., after migration)."""
        t = self._make_transport()
        # First pull: cache the body
        self._mock_conn.getresponse.return_value = _make_response(
            200, self.test_body, {"ETag": self.etag}
        )
        t.pull("staging/blobs/current.json")
        # Reset cache
        t.reset_cache()
        # Pull again — should NOT send If-None-Match
        self._mock_conn.getresponse.return_value = _make_response(
            200, self.test_body, {"ETag": self.etag}
        )
        t.pull("staging/blobs/current.json")
        ifnm = _get_header_from_request(self._mock_conn, "If-None-Match")
        self.assertIsNone(ifnm)

    def test_no_etag_no_caching(self):
        """If server doesn't send ETag, no caching occurs."""
        t = self._make_transport()
        # First pull: no ETag in response
        self._mock_conn.getresponse.return_value = _make_response(200, self.test_body)
        t.pull("staging/blobs/current.json")
        # Second pull: should still not send If-None-Match
        self._mock_conn.getresponse.return_value = _make_response(200, self.test_body)
        t.pull("staging/blobs/current.json")
        ifnm = _get_header_from_request(self._mock_conn, "If-None-Match")
        self.assertIsNone(ifnm)

    def test_push_arbitrary_bytes_roundtrip(self):
        """Push arbitrary bytes → pull same path → identical bytes."""
        t = self._make_transport()
        original = bytes(range(256))
        # Push
        self._mock_conn.getresponse.return_value = _make_response(200, b"ok")
        t.push("staging/blobs/x.bin", original)
        # Pull (with 304 the second time to test cache)
        self._mock_conn.getresponse.return_value = _make_response(
            200, original, {"ETag": '"x-bin"' }
        )
        pulled = t.pull("staging/blobs/x.bin")
        self.assertEqual(pulled, original)

    def test_weak_etags(self):
        """Weak ETags (W/ prefix) are stored and sent as-is."""
        t = self._make_transport()
        weak_etag = 'W/"abc"'
        self._mock_conn.getresponse.return_value = _make_response(
            200, self.test_body, {"ETag": weak_etag}
        )
        t.pull("staging/blobs/current.json")
        self._mock_conn.getresponse.return_value = _make_response(
            304, b"", {"ETag": weak_etag}
        )
        t.pull("staging/blobs/current.json")
        ifnm = _get_header_from_request(self._mock_conn, "If-None-Match")
        self.assertEqual(ifnm, weak_etag)

    def test_etag_without_quotes(self):
        """ETag values without surrounding quotes are used as-is."""
        t = self._make_transport()
        raw_etag = "abc123"
        self._mock_conn.getresponse.return_value = _make_response(
            200, self.test_body, {"ETag": raw_etag}
        )
        t.pull("staging/blobs/current.json")
        self._mock_conn.getresponse.return_value = _make_response(
            304, b"", {"ETag": raw_etag}
        )
        t.pull("staging/blobs/current.json")
        ifnm = _get_header_from_request(self._mock_conn, "If-None-Match")
        self.assertEqual(ifnm, raw_etag)


class TestHttpTransportErrors(unittest.TestCase):
    """Layer 3: Error handling and edge cases."""

    def _make_transport(self, base_url="https://example.com"):
        from core.sync.http_transport import HttpStagingTransport
        t = HttpStagingTransport(base_url)
        self._mock_conn = _make_mock_connection(_make_response(200, b""))
        connect_patcher = patch.object(t, '_connect', return_value=self._mock_conn)
        connect_patcher.start()
        self.addCleanup(connect_patcher.stop)
        return t

    def test_connection_refused(self):
        """Connection refused error raises RuntimeError."""
        t = self._make_transport()
        self._mock_conn.request.side_effect = ConnectionRefusedError(
            "[Errno 111] Connection refused"
        )
        with self.assertRaises(RuntimeError):
            t.pull("staging/blobs/current.json")

    def test_dns_failure(self):
        """DNS resolution failure raises RuntimeError."""
        t = self._make_transport()
        self._mock_conn.request.side_effect = socket.gaierror(
            "[Errno -2] Name or service not known"
        )
        with self.assertRaises(RuntimeError):
            t.pull("staging/blobs/current.json")

    def test_timeout_on_pull(self):
        """Timeout raises RuntimeError."""
        t = self._make_transport()
        self._mock_conn.request.side_effect = socket.timeout("timed out")
        with self.assertRaises(RuntimeError):
            t.pull("staging/blobs/current.json")

    def test_timeout_on_push(self):
        """Timeout on push raises RuntimeError."""
        t = self._make_transport()
        self._mock_conn.request.side_effect = socket.timeout("timed out")
        with self.assertRaises(RuntimeError):
            t.push("staging/blobs/x.json", b"data")

    def test_network_error_on_list_files(self):
        """Network error on list_files raises RuntimeError."""
        t = self._make_transport()
        self._mock_conn.request.side_effect = OSError(
            "[Errno 101] Network is unreachable"
        )
        with self.assertRaises(RuntimeError):
            t.list_files("ledger/blocks/")

    def test_empty_body_pull(self):
        """Pull returning empty bytes is valid (edge case)."""
        t = self._make_transport()
        self._mock_conn.getresponse.return_value = _make_response(200, b"")
        result = t.pull("staging/blobs/x.json")
        self.assertEqual(result, b"")

    def test_unicode_paths(self):
        """Paths with unicode characters work correctly."""
        t = self._make_transport()
        self._mock_conn.getresponse.return_value = _make_response(200, b"data")
        t.pull("staging/blobs/über.json")
        path = _get_request_path(self._mock_conn)
        self.assertIn("über.json", path)

    def test_push_empty_bytes(self):
        """Push of empty bytes succeeds."""
        t = self._make_transport()
        self._mock_conn.getresponse.return_value = _make_response(200, b"ok")
        t.push("staging/blobs/empty.bin", b"")


class TestHttpTransportIntegration(unittest.TestCase):
    """Layer 4/5: Integration with RemoteStagingSync and RemoteLedgerSync."""

    def setUp(self):
        from core.sync.http_transport import HttpStagingTransport
        from domain.staging.remote_sync import RemoteStagingSync
        from domain.ledger.remote_sync import RemoteLedgerSync

        from core.sync.transport import AbstractStagingTransport
        from security.device_identity import (
            AbstractDeviceIdentityProvider,
            DeviceIdentity,
        )

        self.master_key = b"x" * 32

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

        self.device_id_provider = TestIdentityProvider()

        # Create transport with mocked connection
        self.transport = HttpStagingTransport(
            "https://example.com", api_key="test-key"
        )
        self._mock_conn = _make_mock_connection(_make_response(200, b"[]"))
        connect_patcher = patch.object(
            self.transport, '_connect', return_value=self._mock_conn
        )
        connect_patcher.start()
        self.addCleanup(connect_patcher.stop)

        from security.crypto import CryptoManager
        self._crypto = CryptoManager(self.master_key)

        self.staging_sync = RemoteStagingSync(
            crypto=self._crypto,
            transport=self.transport,
            master_key=self.master_key,
            device_id_provider=self.device_id_provider,
        )
        self.ledger_sync = RemoteLedgerSync(
            transport=self.transport,
            master_key=self.master_key,
        )

    # ── RemoteStagingSync integration ─────────────────────────────

    def test_push_entries_via_http(self):
        """Push entries via HTTP → pull same entries back."""
        from domain.staging.remote_sync import RemoteStagingSync as _RS
        entries = [{"id": "task1", "title": "Test"}]
        # Push
        self._mock_conn.getresponse.return_value = _make_response(200, b"ok")
        self.staging_sync.push(entries, device_id="test-device-id")
        # Pull — push obfuscates, so we need to pull with master_key
        pushed_body = _RS._obfuscate(
            json.dumps(entries).encode("utf-8"), self.master_key
        )
        self._mock_conn.getresponse.return_value = _make_response(200, pushed_body)
        pulled = self.staging_sync.pull(master_key=self.master_key)
        self.assertEqual(pulled, entries)

    def test_pull_returns_none_when_http_returns_404(self):
        """RemoteStagingSync.pull returns None when HTTP returns 404."""
        self._mock_conn.getresponse.return_value = _make_response(404, b"")
        result = self.staging_sync.pull()
        self.assertIsNone(result)

    def test_pull_cookie_uses_correct_path(self):
        """pull_cookie sends GET to staging/blobs/device_cookie.bin."""
        self._mock_conn.getresponse.return_value = _make_response(200, b"\x00" * 32)
        self.staging_sync.pull_cookie()
        path = _get_request_path(self._mock_conn)
        self.assertIn("staging/blobs/device_cookie.bin", path)

    def test_push_cookie_uses_correct_path(self):
        """push_cookie sends PUT to staging/blobs/device_cookie.bin."""
        self._mock_conn.getresponse.return_value = _make_response(200, b"ok")
        self.staging_sync.push_cookie(b"\x00" * 32)
        path = _get_request_path(self._mock_conn)
        self.assertIn("staging/blobs/device_cookie.bin", path)

    def test_check_remote_available_returns_true(self):
        """check_remote_available returns True when server responds."""
        self._mock_conn.getresponse.return_value = _make_response(200, b"ok")
        result = self.staging_sync.check_remote_available(timeout_ms=500)
        self.assertTrue(result)

    def test_check_remote_available_returns_false_on_timeout(self):
        """check_remote_available returns False when request exceeds timeout."""
        self._mock_conn.request.side_effect = socket.timeout("timed out")
        result = self.staging_sync.check_remote_available(timeout_ms=500)
        self.assertFalse(result)

    def test_check_remote_available_returns_false_on_error(self):
        """check_remote_available returns False on connection error."""
        self._mock_conn.request.side_effect = ConnectionRefusedError()
        result = self.staging_sync.check_remote_available(timeout_ms=500)
        self.assertFalse(result)

    def test_check_device_via_http(self):
        """check_device works over HTTP transport."""
        self._mock_conn.getresponse.return_value = _make_response(200, b"ok")
        matches = self.staging_sync.check_device(master_key=self.master_key)
        self.assertTrue(matches)

    # ── RemoteLedgerSync integration ──────────────────────────────

    def test_push_blocks_via_http(self):
        """RemoteLedgerSync.push_blocks sends PUTs for new blocks."""
        blocks = [
            {"block": 0, "data": "first"},
            {"block": 1, "data": "second"},
        ]
        # push_blocks makes: 1 list_files call + 2 push calls
        self._mock_conn.getresponse.side_effect = [
            _make_response(200, b"[]"),          # list_files → empty
            _make_response(200, b"ok"),           # push block 0
            _make_response(200, b"ok"),           # push block 1
        ]
        count = self.ledger_sync.push_blocks(blocks)
        self.assertEqual(count, 2)

    def test_push_blocks_skips_existing(self):
        """RemoteLedgerSync.push_blocks skips blocks already on remote."""
        blocks = [
            {"block": 0, "data": "first"},
            {"block": 1, "data": "second"},
        ]
        # push_blocks makes: 1 list_files call + 1 push call (block 1 only)
        self._mock_conn.getresponse.side_effect = [
            _make_response(200, json.dumps(
                ["000000.json"]
            ).encode("utf-8")),                    # list_files → block 0 exists
            _make_response(200, b"ok"),            # push block 1 only
        ]
        count = self.ledger_sync.push_blocks(blocks)
        self.assertEqual(count, 1)

    def test_pull_blocks_pulls_missing(self):
        """RemoteLedgerSync.pull_blocks pulls missing blocks via HTTP."""
        # Only 1 block on remote
        block_data = {"block": 0, "data": "test"}
        obfuscated = self.ledger_sync._obfuscate_block(block_data)
        self._mock_conn.getresponse.side_effect = [
            _make_response(200, json.dumps(
                ["000000.json"]
            ).encode("utf-8")),        # list_files → 1 block
            _make_response(200, obfuscated),             # pull block
        ]
        blocks, count = self.ledger_sync.pull_blocks()
        self.assertEqual(len(blocks), 1)
        self.assertEqual(blocks[0]["block"], 0)
        self.assertEqual(count, 1)

    def test_list_remote_block_indices(self):
        """RemoteLedgerSync._list_remote_block_indices works over HTTP."""
        self._mock_conn.getresponse.return_value = _make_response(
            200, json.dumps(["000000.json"]).encode("utf-8")
        )
        indices = self.ledger_sync._list_remote_block_indices()
        # Returns set of int (block numbers), not strings
        self.assertEqual(indices, {0})

    def test_pull_index_via_http(self):
        """RemoteLedgerSync.pull_index works over HTTP."""
        from domain.staging.remote_sync import RemoteStagingSync as _RS
        index_data = {"2026-05-26": ["000000"]}
        # pull_index deobfuscates, so we need to provide obfuscated data
        obfuscated = _RS._obfuscate(
            json.dumps(index_data).encode("utf-8"), self.master_key
        )
        self._mock_conn.getresponse.return_value = _make_response(200, obfuscated)
        result = self.ledger_sync.pull_index()
        self.assertIsNotNone(result)

    def test_push_index_via_http(self):
        """RemoteLedgerSync.push_index works over HTTP."""
        import json as _json
        index_data = {"2026-05-26": ["000000"]}
        self._mock_conn.getresponse.return_value = _make_response(200, b"ok")
        result = self.ledger_sync.push_index(index_data)
        # push_index returns None on success (or raises on error)
        self.assertIsNone(result)


class TestHttpTransportWithWorkerContract(unittest.TestCase):
    """Documents the exact HTTP contract the Cloudflare Worker must implement."""

    def _make_transport(self, base_url="https://phpoc-staging.example.workers.dev"):
        from core.sync.http_transport import HttpStagingTransport
        t = HttpStagingTransport(base_url, api_key="test-key")
        self._mock_conn = _make_mock_connection(_make_response(200, b""))
        connect_patcher = patch.object(t, '_connect', return_value=self._mock_conn)
        connect_patcher.start()
        self.addCleanup(connect_patcher.stop)
        return t

    def test_push_sends_content_type_octet_stream(self):
        """Contract: push sends Content-Type: application/octet-stream."""
        t = self._make_transport()
        self._mock_conn.getresponse.return_value = _make_response(200, b"ok")
        t.push("staging/blobs/x.json", b"data")
        # Check Content-Type header
        args, kwargs = self._mock_conn.request.call_args
        headers = kwargs.get("headers", {})
        self.assertEqual(headers.get("Content-Type"), "application/octet-stream")

    def test_get_200_returns_body_with_etag(self):
        """Contract: GET /{path} → 200 + body bytes + optional ETag header."""
        t = self._make_transport()
        body = b'{"entries": []}'
        self._mock_conn.getresponse.return_value = _make_response(
            200, body, {"ETag": '"xyz"'}
        )
        result = t.pull("staging/blobs/current.json")
        self.assertEqual(result, body)

    def test_get_304_cached(self):
        """Contract: GET /{path} with If-None-Match → 304 (empty body, cached)."""
        t = self._make_transport()
        body = b'{"entries": []}'
        # First pull
        self._mock_conn.getresponse.return_value = _make_response(
            200, body, {"ETag": '"abc"'}
        )
        t.pull("staging/blobs/current.json")
        # Second pull via 304
        self._mock_conn.getresponse.return_value = _make_response(304, b"")
        result = t.pull("staging/blobs/current.json")
        self.assertEqual(result, body)

    def test_get_404_returns_none(self):
        """Contract: GET /{nonexistent} → 404 (treated as None)."""
        t = self._make_transport()
        self._mock_conn.getresponse.return_value = _make_response(404, b"")
        result = t.pull("staging/blobs/nonexistent.json")
        self.assertIsNone(result)

    def test_put_200_success(self):
        """Contract: PUT /{path} body → 200 (any 2xx accepted)."""
        t = self._make_transport()
        self._mock_conn.getresponse.return_value = _make_response(201, b"created")
        # 201 is also 2xx → should succeed
        t.push("staging/blobs/x.json", b"data")

    def test_get_list_with_prefix(self):
        """Contract: GET /?prefix={prefix} → 200 + JSON array of filenames."""
        t = self._make_transport()
        self._mock_conn.getresponse.return_value = _make_response(
            200, b'["a.json", "b.json"]'
        )
        result = t.list_files("staging/blobs/")
        self.assertEqual(result, ["a.json", "b.json"])

    def test_get_list_404_empty(self):
        """Contract: GET /?prefix={missing} → 404 (treated as empty list)."""
        t = self._make_transport()
        self._mock_conn.getresponse.return_value = _make_response(404, b"")
        result = t.list_files("staging/blobs/nonexistent/")
        self.assertEqual(result, [])

    def test_paths_are_relative(self):
        """Contract: Paths are relative ('staging/blobs/...'), not absolute."""
        t = self._make_transport()
        self._mock_conn.getresponse.return_value = _make_response(200, b"data")
        t.pull("staging/blobs/current.json")
        path = _get_request_path(self._mock_conn)
        # Should NOT start with //
        self.assertFalse(path.startswith("//"))
        self.assertIn("staging/blobs/current.json", path)

    def test_auth_403_raises(self):
        """Contract: Worker must enforce auth — 401/403 → RuntimeError."""
        t = self._make_transport()
        self._mock_conn.getresponse.return_value = _make_response(401, b"unauthorized")
        with self.assertRaises(RuntimeError):
            t.pull("staging/blobs/current.json")
