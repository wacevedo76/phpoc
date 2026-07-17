"""Group C: Timeout Propagation — RemoteLedgerSync — Phase 2 RED tests.

Tests that timeout_ms is propagated from RemoteLedgerSync methods through
to the underlying transport.

Assertions covered (from docs/planning/P5_CLI_UNLOCK_LATENCY_PHASE1.md):
  C1 — push_blocks(timeout_ms=500) passes timeout to transport.list_files()
  C2 — push_blocks(timeout_ms=500) passes timeout to transport.push()
  C3 — pull_blocks(timeout_ms=500) passes timeout to transport.pull()
  C4 — pull_index(timeout_ms=500) passes timeout to transport.pull()
  C5 — push_hash_index(timeout_ms=500) passes timeout to transport.push()
"""

import json
import unittest
from unittest.mock import MagicMock, patch

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from domain.ledger.remote_sync import RemoteLedgerSync
from domain.staging.remote_sync import RemoteStagingSync


# =============================================================================
# Helpers
# =============================================================================

TEST_MASTER_KEY = b"\x01\x02\x03\x04\x05\x06\x07\x08" * 4  # 32 bytes


class TimeoutTrackingTransport:
    """Transport spy that records timeout_ms passed to each method."""

    def __init__(self):
        self.pull_calls: list = []
        self.push_calls: list = []
        self.list_files_calls: list = []
        self._blobs: dict = {}

    def pull(self, path, timeout_ms=None):
        self.pull_calls.append((path, timeout_ms))
        return self._blobs.get(path)

    def push(self, path, data, timeout_ms=None):
        self.push_calls.append((path, data, timeout_ms))
        self._blobs[path] = data

    def list_files(self, prefix, timeout_ms=None):
        self.list_files_calls.append((prefix, timeout_ms))
        return sorted(
            [k.split("/")[-1] for k in self._blobs if k.startswith(prefix)]
        )


def _make_genesis_block():
    """Return a minimal valid genesis block."""
    block_hash = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2"
    return {
        "block_hash": block_hash,
        "prev_hash": None,
        "content_hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "start_epoch": 0,
        "end_epoch": 0,
        "entries": [],
        "day_hash": block_hash,
    }


def _make_day_block(index, prev_hash):
    """Return a minimal valid day block."""
    block_hash = f"day{index:06d}" + "x" * (64 - 7)
    return {
        "block_hash": block_hash,
        "prev_hash": prev_hash,
        "content_hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "start_epoch": index * 86400000,
        "end_epoch": index * 86400000 + 86400000 - 1,
        "entries": [],
        "day_hash": block_hash,
        "summary_day": index,
    }


def _preload_ledger_blocks(transport, blocks, prefix="ledger/blocks/"):
    """Pre-populate remote ledger blocks in the transport spy."""
    for i, block in enumerate(blocks):
        plaintext = json.dumps(block, sort_keys=True).encode("utf-8")
        obfuscated = RemoteStagingSync._obfuscate(plaintext, TEST_MASTER_KEY)
        transport._blobs[f"{prefix}{i:06d}.json"] = obfuscated


# =============================================================================
# Test cases
# =============================================================================

class TestRemoteLedgerSyncTimeoutPropagation(unittest.TestCase):
    """Group C: RemoteLedgerSync timeout propagation."""

    def setUp(self):
        self.transport = TimeoutTrackingTransport()
        self.sync = RemoteLedgerSync(
            transport=self.transport,
            master_key=TEST_MASTER_KEY,
        )

    # C1 & C2: push_blocks ---------------------------------------------

    def test_C1_push_blocks_passes_timeout_to_list_files(self):
        """C1: push_blocks(timeout_ms=500) passes timeout to transport.list_files().

        push_blocks lists remote blocks to find what's missing. The timeout
        must reach list_files.
        """
        blocks = [_make_genesis_block()]
        self.sync.push_blocks(blocks, timeout_ms=500)
        # push_blocks calls list_files when existing_indices is None
        self.assertGreaterEqual(len(self.transport.list_files_calls), 1)
        _prefix, timeout_ms = self.transport.list_files_calls[0]
        self.assertEqual(timeout_ms, 500)

    def test_C2_push_blocks_passes_timeout_to_push(self):
        """C2: push_blocks(timeout_ms=500) passes timeout to transport.push().

        Each block pushed must use the timeout for the transport push call.
        """
        blocks = [_make_genesis_block()]
        self.sync.push_blocks(blocks, timeout_ms=500)
        self.assertGreaterEqual(len(self.transport.push_calls), 1)
        _path, _data, timeout_ms = self.transport.push_calls[0]
        self.assertEqual(timeout_ms, 500)

    def test_C1_push_blocks_skips_list_files_when_existing_indices_provided(self):
        """When existing_indices is provided, list_files is not called.

        This is an existing optimization — must not regress.
        """
        blocks = [_make_genesis_block()]
        self.sync.push_blocks(blocks, existing_indices=set(), timeout_ms=500)
        self.assertEqual(len(self.transport.list_files_calls), 0)
        # Still pushed
        self.assertGreaterEqual(len(self.transport.push_calls), 1)

    # C3: pull_blocks -------------------------------------------------

    def test_C3_pull_blocks_passes_timeout_to_list_files(self):
        """C3: pull_blocks(timeout_ms=500) passes timeout to transport.list_files()."""
        _preload_ledger_blocks(self.transport, [_make_genesis_block()])
        self.sync.pull_blocks(local_blocks=[], timeout_ms=500)
        self.assertGreaterEqual(len(self.transport.list_files_calls), 1)
        _prefix, timeout_ms = self.transport.list_files_calls[0]
        self.assertEqual(timeout_ms, 500)

    def test_C3_pull_blocks_passes_timeout_to_pull(self):
        """C3: pull_blocks(timeout_ms=500) passes timeout to transport.pull() for each block."""
        genesis = _make_genesis_block()
        _preload_ledger_blocks(self.transport, [genesis])
        self.sync.pull_blocks(local_blocks=[], timeout_ms=500)
        # Should have pulled at least genesis block
        block_pulls = [c for c in self.transport.pull_calls if "ledger/blocks/" in c[0]]
        self.assertGreaterEqual(len(block_pulls), 1)
        _path, timeout_ms = block_pulls[0]
        self.assertEqual(timeout_ms, 500)

    # C4: pull_index --------------------------------------------------

    def test_C4_pull_index_passes_timeout_to_transport_pull(self):
        """C4: pull_index(timeout_ms=500) passes timeout to transport.pull().

        The index file is pulled from 'ledger/index.json'. The timeout must
        reach the transport.
        """
        # Pre-load an obfuscated index
        index_data = {"2024-01-01": {}}
        plaintext = json.dumps(index_data, indent=2).encode("utf-8")
        obfuscated = RemoteStagingSync._obfuscate(plaintext, TEST_MASTER_KEY)
        self.transport._blobs["ledger/index.json"] = obfuscated

        self.sync.pull_index(timeout_ms=500)
        index_pulls = [c for c in self.transport.pull_calls if c[0] == "ledger/index.json"]
        self.assertGreaterEqual(len(index_pulls), 1)
        _path, timeout_ms = index_pulls[0]
        self.assertEqual(timeout_ms, 500)

    # C5: push_hash_index ---------------------------------------------

    def test_C5_push_hash_index_passes_timeout_to_transport_push(self):
        """C5: push_hash_index(timeout_ms=500) passes timeout to transport.push().

        Both the hash index JSON and the SHA-256 checksum must use the timeout.
        """
        genesis = _make_genesis_block()
        day1 = _make_day_block(1, genesis["day_hash"])
        self.sync.push_hash_index([genesis, day1], timeout_ms=500)

        # Two push calls: hash_index.json + hash_index.sha256
        self.assertGreaterEqual(len(self.transport.push_calls), 2)
        for _path, _data, timeout_ms in self.transport.push_calls:
            self.assertEqual(timeout_ms, 500,
                             f"push_hash_index push to {_path} should use timeout_ms=500")


if __name__ == "__main__":
    unittest.main()
