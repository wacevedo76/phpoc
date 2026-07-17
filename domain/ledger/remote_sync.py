"""RemoteLedgerSync — push/pull ledger blocks to/from remote git repo.

Blocks are stored as individual obfuscated files on the remote:

  ledger/blocks/000000.json   (genesis — pushed once)
  ledger/blocks/000001.json   (subsequent blocks, sequence-numbered)
  ...

Index is stored as an obfuscated file:

  ledger/index.json            (lightweight summary)

Uses the same obfuscation scheme (tiered padding + AES-CTR) as
RemoteStagingSync, sharing the same master-key sub-key derivation.
"""

import json
import hashlib
import logging
from typing import Optional, List, Dict, Any, Tuple

from domain.staging.remote_sync import RemoteStagingSync
from core.sync.transport import AbstractStagingTransport
from domain.ledger.helpers import get_block_hash

logger = logging.getLogger(__name__)


class RemoteLedgerSync:
    """Sync immutable ledger blocks to/from remote git repo.

    Push: only new blocks since last sync. Genesis pushed once.
    Pull: list remote files → find missing → deobfuscate → verify chain → return.
    Hash Index: lightweight plaintext index of block seals for fast sync detection.
    """

    # Remote paths for hash index files (plaintext — no obfuscation needed)
    REMOTE_HASH_INDEX = "ledger/hash_index.json"
    REMOTE_HASH_INDEX_SHA256 = "ledger/hash_index.sha256"

    def __init__(
        self,
        transport: AbstractStagingTransport,
        master_key: bytes,
        blocks_prefix: str = "ledger/blocks/",
        index_path: str = "ledger/index.json",
    ):
        """Initialize with transport and master key.

        Args:
            transport: Git transport (or mock) for remote operations.
            master_key: 32-byte master key for blob obfuscation.
            blocks_prefix: Remote path prefix for block files.
            index_path: Remote path for the index file.
        """
        self._transport = transport
        self._master_key = master_key
        self._blocks_prefix = blocks_prefix
        self._index_path = index_path

    # ═══════════════════════════════════════════════════════════
    # Public API
    # ═══════════════════════════════════════════════════════════

    def push_blocks(
        self,
        local_blocks: List[Dict[str, Any]],
        force: bool = False,
        existing_indices: Optional[set] = None,
        overwrite_indices: Optional[set] = None,
        timeout_ms: Optional[int] = None,
    ) -> int:
        """Push blocks that don't exist on remote yet (or overwrite if force=True).

        After ``ph recover``, all local block hashes change (cascading prev_hash).
        Normal push skips by index, leaving the old chain on remote. With force=True,
        existing remote blocks are overwritten so the remote matches the local chain.

        ``overwrite_indices`` is a targeted alternative to ``force``: specific indices
        are always pushed even if they already exist on remote. This is useful when
        the remote has stale blocks at certain indices from an incompatible chain
        (e.g. after recovery on a different device). `pull_blocks()` detects these
        by divergence reporting — the caller then passes those indices here.

        Args:
            local_blocks: Full local ledger chain (list of block dicts).
            force: If True, overwrite ALL remote blocks. Used after recovery.
            existing_indices: Pre-fetched set of remote block indices. When provided,
                              avoids a redundant ``list_files()`` call. If omitted,
                              fetches fresh.
            overwrite_indices: Set of specific indices to overwrite even if they
                               exist on remote. Independent of ``force`` — only the
                               given indices are overwritten. Must be provided with
                               ``existing_indices`` to know which are stale.
            timeout_ms: Optional timeout in milliseconds forwarded to
                        transport calls.

        Returns:
            Number of blocks pushed.
        """
        existing = existing_indices if existing_indices is not None else (
            self._list_remote_block_indices(timeout_ms=timeout_ms) if not force else set()
        )
        pushed = 0

        for i, block in enumerate(local_blocks):
            filename = f"{i:06d}.json"
            path = self._blocks_prefix + filename

            if i in existing:
                # Skip unless this index is explicitly marked for overwrite
                if overwrite_indices is None or i not in overwrite_indices:
                    continue

            obfuscated = self._obfuscate_block(block)
            if timeout_ms is not None:
                self._transport.push(path, obfuscated, timeout_ms=timeout_ms)
            else:
                self._transport.push(path, obfuscated)
            pushed += 1
            logger.info("Pushed block %s to remote", filename)

        return pushed

    def push_index(self, index_data: Dict[str, Any]) -> None:
        """Push the index file (lightweight summary) to remote.

        Args:
            index_data: Dict of {date_str: {title: {ms, tags, entries}}}.
        """
        plaintext = json.dumps(index_data, indent=2).encode("utf-8")
        obfuscated = RemoteStagingSync._obfuscate(plaintext, self._master_key)
        self._transport.push(self._index_path, obfuscated)
        logger.info("Pushed index to remote")

    def pull_blocks(
        self,
        local_blocks: Optional[List[Dict[str, Any]]] = None,
        existing_indices: Optional[set] = None,
        timeout_ms: Optional[int] = None,
    ) -> Tuple[Optional[List[Dict[str, Any]]], int]:
        """Pull missing blocks from remote.

        Verifies chain integrity (prev_hash linkage, block seals)
        before returning blocks.

        Args:
            local_blocks: Existing local ledger blocks. If None or empty,
                         pulls all remote blocks (fresh clone scenario).
            existing_indices: Pre-fetched set of remote block indices. When provided,
                              avoids a redundant ``list_files()`` call. If omitted,
                              fetches fresh. Used by ``SyncOrchestrator._sync_ledger_blocks()``
                              to share one ``list_files()`` between pull and push.
            timeout_ms: Optional timeout in milliseconds forwarded to
                        transport calls.

        Returns:
            Tuple of (new_blocks_list, total_remote_block_count).
            new_blocks_list is None if nothing to pull.
            total_remote_block_count is the number of blocks on remote.
        """
        existing = existing_indices if existing_indices is not None else (
            self._list_remote_block_indices(timeout_ms=timeout_ms)
        )
        if not existing:
            return None, 0

        max_remote = max(existing)
        local_count = len(local_blocks) if local_blocks else 0

        if local_count > 0 and max_remote < local_count:
            return None, max_remote + 1  # Local is ahead — nothing to pull

        if local_count > 0 and max_remote == local_count - 1:
            return None, max_remote + 1  # Already have all remote blocks

        # Indices we need to pull: from local_count to max_remote
        indices_needed = list(range(local_count, max_remote + 1))
        if not indices_needed:
            return None, max_remote + 1

        # Pull and deobfuscate each block
        new_blocks: List[Dict[str, Any]] = []
        for idx in indices_needed:
            filename = f"{idx:06d}.json"
            path = self._blocks_prefix + filename
            raw = self._transport.pull(path, timeout_ms=timeout_ms) if timeout_ms is not None else self._transport.pull(path)
            if raw is None:
                raise FileNotFoundError(
                    f"Remote block {filename} expected but not found"
                )
            block = self._deobfuscate_block(raw)
            new_blocks.append(block)

        # Verify chain integrity: check prev_hash linkage
        combined = (local_blocks or []) + new_blocks

        divergence_idx = self._verify_chain(combined, strict=False)
        if divergence_idx is not None:
            # Chains diverged — the remote chain is incompatible with local.
            # This happens when two devices have different data at the same
            # block index (different staging → different ledger hashes).
            # We can only pull blocks that chain correctly from the last
            # matching local block.
            remote_div_idx = divergence_idx - local_count
            if remote_div_idx <= 0:
                # The very first remote block doesn't link — nothing to pull
                logger.warning(
                    "Ledger chain divergence at block %d: remote prev_hash "
                    "does not match local block hash. Remote blocks are from "
                    "an incompatible chain. Nothing pulled.",
                    divergence_idx,
                )
                return None, max_remote + 1
            # Some remote blocks link correctly; return only those
            divergent_blocks = new_blocks[remote_div_idx:]
            new_blocks = new_blocks[:remote_div_idx]
            logger.warning(
                "Ledger chain divergence at block %d: %d remote block(s) "
                "from an incompatible chain will be skipped.",
                divergence_idx,
                len(divergent_blocks),
            )

        return new_blocks, max_remote + 1

    def pull_index(self, timeout_ms: Optional[int] = None) -> Optional[Dict[str, Any]]:
        """Pull the remote index file.

        Args:
            timeout_ms: Optional timeout in milliseconds forwarded to
                        the transport layer.

        Returns:
            Parsed index dict, or None if no index exists on remote.
        """
        raw = self._transport.pull(self._index_path, timeout_ms=timeout_ms) if timeout_ms is not None else self._transport.pull(self._index_path)
        if raw is None:
            return None
        plaintext = RemoteStagingSync._deobfuscate(raw, self._master_key)
        if plaintext is None:
            logger.warning("Failed to deobfuscate remote index")
            return None
        try:
            return json.loads(plaintext.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            logger.warning("Failed to parse remote index: %s", exc)
            return None

    def pull_full_chain(self) -> List[Dict[str, Any]]:
        """Pull all remote ledger blocks without chain verification.

        Used for same-genesis divergence merge — LedgerMerge.merge()
        performs its own independent chain validation.

        Returns:
            List of all block dicts from remote, in index order.
            Empty list if no blocks exist on remote.

        Raises:
            FileNotFoundError: If a block file is expected but missing.
            ValueError: If a block fails deobfuscation or JSON parse.
        """
        indices = self._list_remote_block_indices()
        if not indices:
            return []
        blocks: List[Dict[str, Any]] = []
        for idx in sorted(indices):
            filename = f"{idx:06d}.json"
            path = self._blocks_prefix + filename
            raw = self._transport.pull(path)
            if raw is None:
                raise FileNotFoundError(
                    f"Remote block {filename} expected but not found"
                )
            block = self._deobfuscate_block(raw)
            blocks.append(block)
        return blocks

    def pull_block_by_index(self, index: int) -> Optional[Dict[str, Any]]:
        """Pull a single remote ledger block by index.

        Args:
            index: Block sequence number (0 = genesis).

        Returns:
            Block dict, or None if the block doesn't exist on remote.

        Raises:
            ValueError: If deobfuscation or JSON parse fails.
        """
        filename = f"{index:06d}.json"
        path = self._blocks_prefix + filename
        raw = self._transport.pull(path)
        if raw is None:
            return None
        return self._deobfuscate_block(raw)

    def get_remote_block_count(self) -> int:
        """Count blocks on remote by listing block files.

        Returns:
            Number of blocks on remote (0 if none).
        """
        existing = self._list_remote_block_indices()
        return max(existing) + 1 if existing else 0

    # ═══════════════════════════════════════════════════════════
    # Hash Index (fast sync detection)
    # ═══════════════════════════════════════════════════════════

    def push_hash_index(self, chain: List[Dict[str, Any]], timeout_ms: Optional[int] = None) -> None:
        """Build and push hash index files to remote.

        The hash index is a plaintext array of block seals (day_hash,
        month_hash, or year_hash) in chain order. A SHA-256 checksum
        of the JSON is also pushed for Tier-1 fast-path detection.

        These files are NOT obfuscated — they contain only block seals
        which are already public information (stored as plaintext in the
        obfuscated block files themselves). No master key needed to read.

        Args:
            chain: Full ledger chain (list of block dicts).
            timeout_ms: Optional timeout in milliseconds forwarded to
                        transport calls.
        """
        hashes = [get_block_hash(b) for b in chain]
        hi_json = json.dumps(hashes).encode("utf-8")
        hi_sha256 = hashlib.sha256(hi_json).hexdigest()
        if timeout_ms is not None:
            self._transport.push(self.REMOTE_HASH_INDEX, hi_json, timeout_ms=timeout_ms)
            self._transport.push(
                self.REMOTE_HASH_INDEX_SHA256, hi_sha256.encode("utf-8"), timeout_ms=timeout_ms
            )
        else:
            self._transport.push(self.REMOTE_HASH_INDEX, hi_json)
            self._transport.push(
                self.REMOTE_HASH_INDEX_SHA256, hi_sha256.encode("utf-8")
            )
        logger.info("Pushed hash index to remote (%d blocks)", len(hashes))

    def pull_hash_index(self) -> Optional[Dict[str, Any]]:
        """Pull hash index from remote.

        Returns:
            Dict with ``hashes`` (list of seal strings) and ``sha256`` (hex
            digest), or None if either file is missing or the SHA-256 does
            not match (tampered or corrupted).
        """
        hi_raw = self._transport.pull(self.REMOTE_HASH_INDEX)
        hi_sha_raw = self._transport.pull(self.REMOTE_HASH_INDEX_SHA256)
        if hi_raw is None or hi_sha_raw is None:
            return None

        # Verify SHA-256 integrity
        expected = hashlib.sha256(hi_raw).hexdigest()
        actual = hi_sha_raw.decode("utf-8").strip()
        if expected != actual:
            logger.warning(
                "Remote hash index SHA-256 mismatch — discarding"
            )
            return None

        try:
            hashes = json.loads(hi_raw.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            logger.warning(
                "Failed to parse remote hash index: %s", exc
            )
            return None

        return {"hashes": hashes, "sha256": actual}

    @staticmethod
    def compare_hash_indexes(
        local: Optional[List[str]],
        remote: Optional[List[str]],
    ) -> Dict[str, Any]:
        """Compare local and remote hash indexes to detect fork type.

        Walks both arrays element-by-element until a mismatch is found.
        Handles None inputs defensively (treated as empty arrays).

        Fork types::

            'none'             — identical (or both empty)
            'linear_remote'    — remote extends local
            'linear_local'     — local extends remote
            'divergent'        — mismatch at a shared index after genesis
            'genesis_mismatch' — mismatch at index 0 (different genesis)

        Args:
            local: Local hash index (list of seal strings), or None.
            remote: Remote hash index (list of seal strings), or None.

        Returns:
            Dict with ``fork_type`` (str) and ``fork_index`` (int or None).
        """
        l = local or []
        r = remote or []

        if len(l) == 0 and len(r) == 0:
            return {"fork_type": "none"}
        if len(l) == 0:
            return {"fork_type": "linear_remote", "fork_index": 0}
        if len(r) == 0:
            return {"fork_type": "linear_local", "fork_index": 0}
        if l[0] != r[0]:
            return {"fork_type": "genesis_mismatch", "fork_index": 0}

        min_len = min(len(l), len(r))
        for i in range(1, min_len):
            if l[i] != r[i]:
                return {"fork_type": "divergent", "fork_index": i}

        if len(r) > len(l):
            return {"fork_type": "linear_remote", "fork_index": len(l)}
        if len(l) > len(r):
            return {"fork_type": "linear_local", "fork_index": len(r)}

        return {"fork_type": "none"}

    # ═══════════════════════════════════════════════════════════
    # Internal helpers
    # ═══════════════════════════════════════════════════════════

    def _obfuscate_block(self, block: Dict[str, Any]) -> bytes:
        """Serialize a single block dict and obfuscate it.

        Args:
            block: Single ledger block dict.

        Returns:
            Obfuscated bytes ready for transport.
        """
        plaintext = json.dumps(block, sort_keys=True).encode("utf-8")
        return RemoteStagingSync._obfuscate(plaintext, self._master_key)

    def _deobfuscate_block(self, raw: bytes) -> Dict[str, Any]:
        """Deobfuscate raw bytes back into a block dict.

        Args:
            raw: Obfuscated bytes from transport.

        Returns:
            Parsed block dict.

        Raises:
            ValueError: If deobfuscation fails.
        """
        plaintext = RemoteStagingSync._deobfuscate(raw, self._master_key)
        if plaintext is None:
            raise ValueError("Failed to deobfuscate ledger block")
        try:
            return json.loads(plaintext.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise ValueError(f"Failed to parse deobfuscated block: {exc}") from exc

    def _list_remote_block_indices(self, timeout_ms: Optional[int] = None) -> set:
        """List all block file indices currently on remote.

        Args:
            timeout_ms: Optional timeout in milliseconds forwarded to
                        the transport layer.

        Returns:
            Set of integers (block sequence numbers).
        """
        files = self._transport.list_files(self._blocks_prefix, timeout_ms=timeout_ms) if timeout_ms is not None else self._transport.list_files(self._blocks_prefix)
        indices: set = set()
        for fname in files:
            # Filenames are like "000000.json"
            name = fname.strip()
            if name.endswith(".json"):
                try:
                    idx = int(name[:-5])  # Strip ".json"
                    indices.add(idx)
                except (ValueError, IndexError):
                    continue
        return indices

    @staticmethod
    def _verify_chain(
        blocks: List[Dict[str, Any]], strict: bool = True
    ) -> Optional[int]:
        """Verify chain integrity across a list of blocks.

        Checks:
          1. prev_hash linkage between consecutive blocks
          2. Each block has a valid hash key (day_hash/month_hash/year_hash)

        Does NOT verify seal integrity (HMAC) because that requires the
        crypto manager. Seal verification is done locally after appending.

        Args:
            blocks: Full list of ledger blocks (genesis onward).
            strict: If True, raises ValueError on mismatch (original behavior).
                    If False, returns the index of the first mismatched block,
                    or None if the chain is valid.

        Returns:
            None if chain is valid.
            int (block index) of first mismatch if strict=False.

        Raises:
            ValueError: If strict=True and chain integrity check fails.
        """
        if not blocks:
            return None

        for i in range(1, len(blocks)):
            current = blocks[i]
            prev = blocks[i - 1]

            # Get the previous block's hash
            prev_hash = (
                prev.get("block_hash")
                or prev.get("day_hash")
                or prev.get("month_hash")
                or prev.get("year_hash")
            )
            if not prev_hash:
                if strict:
                    raise ValueError(
                        f"Block {i - 1} has no hash key "
                        f"(day_hash/month_hash/year_hash)"
                    )
                return i

            # Check prev_hash linkage
            if current.get("prev_hash") != prev_hash:
                if strict:
                    raise ValueError(
                        f"Block {i} prev_hash ({current.get('prev_hash')}) "
                        f"does not match block {i - 1} hash ({prev_hash})"
                    )
                return i

            # Verify the current block has a hash
            current_hash = (
                current.get("block_hash")
                or current.get("day_hash")
                or current.get("month_hash")
                or current.get("year_hash")
            )
            if not current_hash:
                if strict:
                    raise ValueError(
                        f"Block {i} has no hash key "
                        f"(day_hash/month_hash/year_hash)"
                    )
                return i

        return None
