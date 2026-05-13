"""LedgerChain: block-level chain operations.

Handles construction, sealing, signing, appending, truncation, and
verification of individual blocks in the append-only ledger chain.

Every method is a thin wrapper over crypto + store operations, producing
output that is byte-identical to the original core/ledger.py.
"""

import json
import hashlib
from typing import Optional, List, Dict, Any

from security.crypto import AbstractCryptoManager
from storage.ledger_store import AbstractLedgerStore


class LedgerChain:
    """Block-level chain operations.

    Responsible for:
      - Sealing/signing blocks (matches CryptoManager seal/sign behavior)
      - Building day blocks with correct structure
      - Appending blocks with linkage verification
      - Truncation with removed-block return
      - Full and single-block verification
    """

    def __init__(
        self,
        crypto: AbstractCryptoManager,
        store: AbstractLedgerStore,
        identity_secret: Optional[bytes] = None,
    ):
        self.crypto = crypto
        self.store = store
        self.identity_secret = identity_secret

        # Duck-type resolution: the store may implement the new
        # AbstractLedgerStore interface or the old read_ledger/write_ledger API.
        # We normalize to the new API here.
        if not hasattr(store, "read_blocks"):
            # Wrap old-style store in adapter closures
            self._read_blocks = self._make_read_blocks_fallback()
            self._append_blocks = self._make_append_blocks_fallback()
            self._truncate = self._make_truncate_fallback()
            self._get_block_count = self._make_get_block_count_fallback()
            self._get_last_block = self._make_get_last_block_fallback()
        else:
            self._read_blocks = store.read_blocks
            self._append_blocks = store.append_blocks
            self._truncate = store.truncate
            self._get_block_count = store.get_block_count
            self._get_last_block = store.get_last_block

    def _make_read_blocks_fallback(self):  # pragma: no cover
        def read_blocks(start=0, end=None):
            ledger = self.store.read_ledger()
            total = len(ledger)
            if start < 0:
                start = max(0, total + start)
            if end is None:
                end = total
            elif end < 0:
                end = max(0, total + end)
            return ledger[start:end]
        return read_blocks

    def _make_append_blocks_fallback(self):  # pragma: no cover
        def append_blocks(blocks):
            ledger = self.store.read_ledger()
            ledger.extend(blocks)
            self.store.write_ledger(ledger)
        return append_blocks

    def _make_truncate_fallback(self):  # pragma: no cover
        def truncate(keep_count):
            ledger = self.store.read_ledger()
            if keep_count >= len(ledger):
                return []
            kept = ledger[:keep_count]
            removed = ledger[keep_count:]
            self.store.write_ledger(kept)
            return removed
        return truncate

    def _make_get_block_count_fallback(self):  # pragma: no cover
        return lambda: len(self.store.read_ledger())

    def _make_get_last_block_fallback(self):  # pragma: no cover
        def get_last_block():
            ledger = self.store.read_ledger()
            return ledger[-1] if ledger else None
        return get_last_block

    # ── Seal / Sign helpers ──────────────────────────────

    def compute_seal(self, data: dict) -> str:
        """Compute an HMAC-SHA256 seal over a dict by serializing with sort_keys=True."""
        return self.crypto.seal(json.dumps(data, sort_keys=True))

    def verify_seal(self, data: dict, signature: str) -> bool:
        """Verify an HMAC-SHA256 seal over a dict."""
        return self.crypto.verify_seal(json.dumps(data, sort_keys=True), signature)

    def compute_signature(self, data_str: str, identity_secret: Optional[bytes]) -> Optional[str]:
        """Compute an identity signature, or None if no secret is configured."""
        if identity_secret is None:
            return None
        return self.crypto.sign(data_str, identity_secret)

    def verify_signature(self, data_str: str, signature: str, identity_secret: bytes) -> bool:
        """Verify an identity signature against a given secret."""
        return self.crypto.verify_signature(data_str, signature, identity_secret)

    # ── Block access ─────────────────────────────────────

    def get_block_count(self) -> int:
        """Total number of blocks in the chain."""
        return self._get_block_count()

    def get_block(self, index: int) -> Optional[Dict[str, Any]]:
        """Get a single block by index (supports negative indexing)."""
        count = self._get_block_count()
        if count == 0:
            return None
        if index < 0:
            index = count + index
        if index < 0 or index >= count:
            return None
        blocks = self._read_blocks(start=index, end=index + 1)
        return blocks[0] if blocks else None

    def get_last_block(self) -> Optional[Dict[str, Any]]:
        """Get the most recent block."""
        return self._get_last_block()

    def read_all(self) -> List[Dict[str, Any]]:
        """Read the full chain as a list (returns a copy)."""
        return self._read_blocks(start=0)

    # ── Block building ───────────────────────────────────

    def build_day_block(
        self,
        entries: List[Dict[str, Any]],
        prev_hash: str,
        date_str: str,
    ) -> Dict[str, Any]:
        """Build a day block with proper sealing and optional identity signature.

        Matches the exact structure produced by core/ledger.py sync_day().
        callers must provide prev_hash (resolved from the last chain block).
        date_str is the ISO date string for this day.

        Args:
            entries: List of entry dicts. Each may be either:
                {"hash": str, "data": dict} (pre-hashed), or
                raw dict (hash computed automatically).
            prev_hash: The resolved hash from the previous block.
            date_str: ISO date string (YYYY-MM-DD).

        Returns:
            A day block dict with type, day_index, date, prev_hash, entries,
            day_hash, and optionally signature.
        """
        last = self.get_last_block()
        day_index = 1
        if last and last.get("type") == "day":
            day_index = last.get("day_index", 0) + 1

        # Normalize entries: accept both {"hash", "data"} and raw dicts,
        # always recomputing hash from the actual data dict.
        normalized_entries = []
        for e in entries:
            if "hash" in e and "data" in e:
                data = e["data"]
            else:
                data = dict(e)
            entry_hash = hashlib.sha256(
                json.dumps(data, sort_keys=True).encode()
            ).hexdigest()
            normalized_entries.append({"hash": entry_hash, "data": data})

        day_content = {
            "type": "day",
            "day_index": day_index,
            "date": date_str,
            "prev_hash": prev_hash,
            "entries": normalized_entries,
        }

        day_json = json.dumps(day_content, sort_keys=True)
        day_content["day_hash"] = self.crypto.seal(day_json)
        if self.identity_secret:
            day_content["signature"] = self.crypto.sign(
                day_content["day_hash"], self.identity_secret
            )
        return day_content

    # ── Append / truncate ────────────────────────────────

    def append(self, block: Dict[str, Any]):
        """Append a single block to the chain."""
        self._append_blocks([block])

    def append_blocks(self, blocks: List[Dict[str, Any]]):
        """Append multiple blocks with linkage verification.

        Raises ValueError if any block's prev_hash does not match the
        hash of the block just before it in the combined chain.
        """
        if not blocks:
            return

        # Verify linkage across the bridge (last existing → first new)
        last_existing = self.get_last_block()
        if last_existing is not None:
            existing_hash = (
                last_existing.get("day_hash")
                or last_existing.get("month_hash")
                or last_existing.get("year_hash")
            )
            if blocks[0].get("prev_hash") != existing_hash:
                raise ValueError(
                    f"Block 0 prev_hash {blocks[0].get('prev_hash')} "
                    f"does not match last block hash {existing_hash}"
                )

        # Verify linkage among the new blocks
        for i in range(1, len(blocks)):
            prev_block = blocks[i - 1]
            prev_block_hash = (
                prev_block.get("day_hash")
                or prev_block.get("month_hash")
                or prev_block.get("year_hash")
            )
            if blocks[i].get("prev_hash") != prev_block_hash:
                raise ValueError(
                    f"Block {i} prev_hash {blocks[i].get('prev_hash')} "
                    f"does not match block {i - 1} hash {prev_block_hash}"
                )

        self._append_blocks(blocks)

    def truncate(self, remove_count: int) -> List[Dict[str, Any]]:
        """Remove `remove_count` blocks from the end of the chain.

        Preserves at minimum the genesis block (block 0). Returns the
        removed blocks for inspection.

        Args:
            remove_count: Number of blocks to remove from the end.

        Returns:
            List of removed block dicts.
        """
        total = self._get_block_count()
        if remove_count <= 0 or total == 0:
            return []
        # Keep at minimum block 0 (genesis)
        keep_count = max(1, total - remove_count)
        if keep_count >= total:
            return []
        return self._truncate(keep_count)

    def truncate_keep(self, keep_count: int) -> List[Dict[str, Any]]:
        """Truncate the chain to keep `keep_count` blocks from the start.

        This is the inverse of truncate() — it specifies the number of
        blocks to KEEP rather than the number to REMOVE.

        Returns the removed blocks. If keep_count >= total, returns [].

        Args:
            keep_count: Number of blocks to keep (from start).

        Returns:
            List of removed block dicts.
        """
        total = self._get_block_count()
        if keep_count <= 0 or keep_count >= total:
            return []
        return self._truncate(keep_count)

    # ── Verification ─────────────────────────────────────

    def verify(self) -> bool:
        """Full chain verification.

        Checks:
          1. prev_hash linkage between consecutive blocks
          2. Block seal integrity (day_hash/month_hash/year_hash)
          3. Identity signature (if identity_secret is available)
          4. Entry hashes within day blocks (SHA256 of entry data)
          5. Content hash verification for entries that carry one

        Returns True if the entire chain is valid.
        """
        ledger = self.read_all()
        verify_signatures = self.identity_secret is not None

        for i in range(1, len(ledger)):
            current = ledger[i]
            prev = ledger[i - 1]

            # 1. prev_hash linkage
            prev_hash = (
                prev.get("day_hash")
                or prev.get("month_hash")
                or prev.get("year_hash")
            )
            if current["prev_hash"] != prev_hash:
                return False

            # 2. Block seal
            hash_key = (
                "day_hash"
                if current.get("type", "day") == "day"
                else "month_hash"
                if current.get("type") == "month_summary"
                else "year_hash"
            )
            check_data = {k: v for k, v in current.items() if k not in (hash_key, "signature")}
            if not self.crypto.verify_seal(
                json.dumps(check_data, sort_keys=True), current[hash_key]
            ):
                return False

            # 3. Identity signature (if present)
            if verify_signatures and current.get("signature"):
                if not self.crypto.verify_signature(
                    current[hash_key], current["signature"], self.identity_secret
                ):
                    return False

            # 4. Entry hashes in day blocks
            if current.get("type", "day") == "day":
                for entry in current["entries"]:
                    data = entry["data"]
                    if (
                        hashlib.sha256(
                            json.dumps(data, sort_keys=True).encode()
                        ).hexdigest()
                        != entry["hash"]
                    ):
                        return False

                    # 5. Content hash verification
                    if "content_hash" in data:
                        try:
                            if not self._verify_content_hash(data):
                                return False
                        except Exception:
                            return False

        return True

    def verify_block(self, index: int) -> bool:
        """Verify a single block by index.

        For block 0 (genesis), checks only that its type is valid.
        For subsequent blocks, checks prev_hash linkage against the
        preceding block, plus seal + signature + entry hashes.
        """
        block = self.get_block(index)
        if block is None:
            return False

        if index == 0:
            return block.get("type") in ("genesis", "day", "month_summary", "year_summary")

        prev = self.get_block(index - 1)
        if prev is None:
            return False

        current = block
        prev_hash = (
            prev.get("day_hash") or prev.get("month_hash") or prev.get("year_hash")
        )
        if current["prev_hash"] != prev_hash:
            return False

        hash_key = (
            "day_hash"
            if current.get("type", "day") == "day"
            else "month_hash"
            if current.get("type") == "month_summary"
            else "year_hash"
        )
        check_data = {k: v for k, v in current.items() if k not in (hash_key, "signature")}
        if not self.crypto.verify_seal(json.dumps(check_data, sort_keys=True), current[hash_key]):
            return False

        if self.identity_secret and current.get("signature"):
            if not self.crypto.verify_signature(
                current[hash_key], current["signature"], self.identity_secret
            ):
                return False

        if current.get("type", "day") == "day":
            for entry in current["entries"]:
                data = entry["data"]
                if (
                    hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()
                    != entry["hash"]
                ):
                    return False

        return True

    # ── Internal helpers ─────────────────────────────────

    @staticmethod
    def _verify_content_hash(data: dict) -> bool:
        """Verify the content_hash of an entry's data dict.

        Uses the extensible algorithm from core/ledger.py:
        - Fields ending in ``_enc`` are left as-is (caller is expected
          to have decrypted them before computing; in verify context
          the encrypted values are compared)
        - List fields are sorted for deterministic output
        - ``content_hash`` itself is excluded
        - sort_keys=True normalizes key ordering

        For verify(), the data still contains encrypted _enc values,
        so the content_hash check is a comparison between two
        invocations of the same algorithm — not a plaintext check.
        """
        content = {}
        for key, value in data.items():
            if key == "content_hash":
                continue
            if key.endswith("_enc") and value is not None and value != "":
                content[key] = value
            elif isinstance(value, list):
                content[key] = sorted(value)
            else:
                content[key] = value
        computed = hashlib.sha256(
            json.dumps(content, sort_keys=True).encode()
        ).hexdigest()
        # Fallback to legacy v0.3.0 algorithm if extensible doesn't match
        if computed != data["content_hash"]:
            # Legacy algorithm: hardcoded 9 fields
            plain = dict(data)
            legacy = {
                "title": plain.get("title", ""),
                "startTime": plain.get("startTime_enc", ""),
                "endTime": plain.get("endTime_enc", ""),
                "metadata": plain.get("metadata_enc", ""),
                "pauses": plain.get("pauses_enc", ""),
                "tags": sorted(plain.get("tags", [])),
                "comment": plain.get("comment", ""),
                "media": sorted(plain.get("media", [])),
                "duration": plain.get("duration", 0),
            }
            return (
                hashlib.sha256(json.dumps(legacy, sort_keys=True).encode()).hexdigest()
                == data["content_hash"]
            )
        return True
