"""Group A: HTTP Transport Default Timeout — Phase 2 RED tests.

Tests that the transport default timeout changes from 60s → 5s and that
explicit timeouts override correctly.

Assertions covered (from docs/planning/P5_CLI_UNLOCK_LATENCY_PHASE1.md):
  A1 — _DEFAULT_TIMEOUT_S equals 5.0
  A2 — pull() uses 5s socket timeout when timeout_ms is None
  A3 — push() uses 5s socket timeout when timeout_ms is None
  A4 — list_files() uses 5s socket timeout when timeout_ms is None
  A5 — delete() uses 5s socket timeout when timeout_ms is None
  A6 — Explicit timeout_ms=2000 overrides default to 2s
"""

import json
import unittest
from unittest.mock import MagicMock, patch

from core.sync.http_transport import HttpStagingTransport


# =============================================================================
# Helpers
# =============================================================================

def _make_response(status=200, body=b"", headers=None):
    """Create a mock HTTP response."""
    reasons = {
        200: "OK", 201: "Created", 304: "Not Modified",
        400: "Bad Request", 401: "Unauthorized", 403: "Forbidden",
        404: "Not Found", 500: "Internal Server Error",
    }
    mock = MagicMock()
    mock.status = status
    mock.reason = reasons.get(status, "")
    mock.read.return_value = body
    all_headers = headers or {}
    mock.getheader.side_effect = lambda name, default=None: all_headers.get(name, default)
    return mock


def _make_connection(response):
    """Create a mock HTTP connection."""
    conn = MagicMock()
    conn.getresponse.return_value = response
    return conn


class TestTransportDefaultTimeout(unittest.TestCase):
    """Group A: Transport default timeout assertions."""

    def test_A1_default_timeout_is_5_seconds(self):
        """A1: _DEFAULT_TIMEOUT_S equals 5.0.

        The core fix — changing the default from 60s to 5s prevents
        60-second hangs on unreachable remotes.
        """
        from core.sync.http_transport import _DEFAULT_TIMEOUT_S
        self.assertEqual(_DEFAULT_TIMEOUT_S, 5.0,
                         "Default transport timeout must be 5.0 seconds (was 60.0)")

    def test_A2_pull_uses_5s_socket_timeout_when_timeout_ms_is_None(self):
        """A2: pull() uses 5s socket timeout when timeout_ms is None.

        Confirms the new default is actually applied at connection time.
        """
        resp = _make_response(200, b'{"entries":[]}')
        conn = _make_connection(resp)

        with patch.object(HttpStagingTransport, '_connect', return_value=conn) as mock_connect:
            t = HttpStagingTransport("https://example.com")
            t.pull("staging/blobs/current.json")
            mock_connect.assert_called_once_with(5.0)

    def test_A3_push_uses_5s_socket_timeout_when_timeout_ms_is_None(self):
        """A3: push() uses 5s socket timeout when timeout_ms is None."""
        resp = _make_response(200)
        conn = _make_connection(resp)

        with patch.object(HttpStagingTransport, '_connect', return_value=conn) as mock_connect:
            t = HttpStagingTransport("https://example.com")
            t.push("staging/blobs/current.json", b"data")
            mock_connect.assert_called_once_with(5.0)

    def test_A4_list_files_uses_5s_socket_timeout_when_timeout_ms_is_None(self):
        """A4: list_files() uses 5s socket timeout when timeout_ms is None."""
        resp = _make_response(200, b'["block1.json","block2.json"]')
        conn = _make_connection(resp)

        with patch.object(HttpStagingTransport, '_connect', return_value=conn) as mock_connect:
            t = HttpStagingTransport("https://example.com")
            t.list_files("ledger/blocks/")
            mock_connect.assert_called_once_with(5.0)

    def test_A5_delete_uses_5s_socket_timeout_when_timeout_ms_is_None(self):
        """A5: delete() uses 5s socket timeout when timeout_ms is None."""
        resp = _make_response(200)
        conn = _make_connection(resp)

        with patch.object(HttpStagingTransport, '_connect', return_value=conn) as mock_connect:
            t = HttpStagingTransport("https://example.com")
            t.delete("staging/blobs/old.json")
            mock_connect.assert_called_once_with(5.0)

    def test_A6_explicit_timeout_ms_overrides_default(self):
        """A6: Explicit timeout_ms=2000 overrides default to 2s.

        Must not regress — explicit timeouts must still be respected.
        """
        resp = _make_response(200, b'{"entries":[]}')
        conn = _make_connection(resp)

        with patch.object(HttpStagingTransport, '_connect', return_value=conn) as mock_connect:
            t = HttpStagingTransport("https://example.com")
            t.pull("staging/blobs/current.json", timeout_ms=2000)
            mock_connect.assert_called_once_with(2.0)


if __name__ == "__main__":
    unittest.main()
