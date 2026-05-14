"""LedgerEngine: high-level ledger operations (commit, verify, revert).

The unified public API that orchestrates LedgerChain, IndexManager,
and SummaryPolicy. This is the main entry point for syncing entries
to the ledger, verifying chain integrity, and reverting blocks.
"""

import json
import hashlib
import time
from typing import Optional, List, Dict, Any, Tuple

from security.crypto import AbstractCryptoManager
from storage.ledger_store import AbstractLedgerStore
from storage.index_store import AbstractIndexStore
from storage.staging_store import AbstractStagingStore
from domain.ledger.chain import LedgerChain
from domain.ledger.index_manager import IndexManager
from domain.ledger.summary_policy import (
    SummaryPolicy,
    YearMonthSummaryPolicy,
)


class LedgerEngine:
    """Orchestrates ledger operations: commit, verify, revert.

    Delegates block-level work to LedgerChain, index management to
    IndexManager, and summary insertion to SummaryPolicy.

    This matches the behavior of core/ledger.py sync_day(), verify(),
    and revert_entries() exactly.
    """

    def __init__(
        self,
        crypto: AbstractCryptoManager,
        store: AbstractLedgerStore,
        index_store: Optional[AbstractIndexStore] = None,
        staging_store: Optional[AbstractStagingStore] = None,
        identity_secret: Optional[bytes] = None,
        summary_policy: Optional[SummaryPolicy] = None,
    ):
        """
        Args:
            crypto: Crypto manager for encrypt/decrypt/seal/sign.
            store: Ledger block store.
            index_store: Optional index store (defaults to store if it
                implements AbstractIndexStore).
            staging_store: Optional staging store (for revert). If None,
                revert will not restore entries to staging.
            identity_secret: Optional identity secret for block signatures.
            summary_policy: Summary insertion policy. Defaults to
                YearMonthSummaryPolicy.
        """
        self.crypto = crypto
        self.store = store
        self.identity_secret = identity_secret

        # Resolve index store
        self.index_store: AbstractIndexStore
        if index_store is not None:
            self.index_store = index_store
        elif hasattr(store, "read_index"):
            # Duck-type: the store might be a _MockLedgerStore that
            # also has read_index/write_index
            self.index_store = store  # type: ignore
        else:
            self.index_store = store  # type: ignore

        # Resolve staging store
        self.staging_store: AbstractStagingStore
        if staging_store is not None:
            self.staging_store = staging_store
        elif hasattr(store, "read_staging"):
            self.staging_store = store  # type: ignore
        else:
            self.staging_store = store  # type: ignore

        self.chain = LedgerChain(crypto, store, identity_secret)
        self.index = IndexManager(self.index_store)
        self.summary_policy = summary_policy or YearMonthSummaryPolicy(
            crypto, identity_secret=identity_secret
        )

    # ── Commit (sync entries) ────────────────────────────

    def commit(self, entries: List[Dict[str, Any]]) -> Optional[str]:
        """Sync entries to the ledger.

        This is the main sync entry point, equivalent to
        core/ledger.py sync_day() but operating on explicitly-provided
        entries instead of reading from staging internally.

        Steps:
          1. Group entries by date
          2. Encrypt entry fields (startTime_enc, endTime_enc,
             metadata_enc, pauses_enc) using crypto
          3. Compute content_hash for each entry
          4. Insert year/month summary blocks as needed
          5. Build and append day blocks
          6. Update the blind index
          7. Return the last day_hash prefix (10 chars), or
             None if no entries were committed

        Args:
            entries: List of entry dicts with at minimum:
                - title (str)
                - start_epoch (int, ms since Unix epoch)
                - duration (int, ms)
                Optional: tags, comment, media, pauses, metadata,
                is_active, is_paused.

        Returns:
            10-character prefix of the last day_hash, or None if
            no entries were committed.
        """
        if not entries:
            return None

        # Group entries by date and encrypt/process
        days_to_sync = self._prepare_entries(entries)

        if not days_to_sync:
            return None

        # Append blocks for each day, inserting summaries as needed
        for date_str in sorted(days_to_sync.keys()):
            self._commit_day(date_str, days_to_sync[date_str])

        self.index._flush()  # type: ignore[attr-defined]

        # Return the hash prefix of the last block
        last = self.chain.get_last_block()
        if last is None:
            return None

        # Handle possibly absent hash keys (e.g., genesis)
        last_hash = (
            last.get("day_hash")
            or last.get("month_hash")
            or last.get("year_hash")
        )
        if last_hash:
            return last_hash[:10]
        return None

    def _prepare_entries(
        self, entries: List[Dict[str, Any]]
    ) -> Dict[str, List[Dict[str, Any]]]:
        """Group entries by date, encrypt fields, compute hashes.

        Returns a dict of {date_str: [entry_dicts]} where each entry
        dict has been augmented with encrypted fields and hashes.
        """
        days: Dict[str, List[Dict[str, Any]]] = {}

        for entry in entries:
            data = dict(entry)

            # Extract plaintext values
            start_epoch = data.get("start_epoch", 0)
            title = data.get("title", "")
            duration = data.get("duration", 0)
            metadata = data.get("metadata", {})
            pauses = data.get("pauses", [])
            tags = data.get("tags", [])
            end_epoch = data.get("end_epoch") or None
            # If no end_epoch provided, estimate from start + duration
            if end_epoch is None and duration > 0:
                end_epoch = start_epoch + duration

            # Encrypt fields for ledger storage
            data["startTime_enc"] = self.crypto.encrypt(str(start_epoch))
            data["endTime_enc"] = self.crypto.encrypt(str(end_epoch)) if end_epoch is not None else None
            data["metadata_enc"] = self.crypto.encrypt(json.dumps(metadata or {}))
            if pauses:
                data["pauses_enc"] = self.crypto.encrypt(json.dumps(pauses))
            elif "pauses_enc" not in data:
                data["pauses_enc"] = self.crypto.encrypt("[]")

            # Remove staging-only fields
            data.pop("start_epoch", None)
            data.pop("end_epoch", None)
            data.pop("pauses", None)
            data.pop("metadata", None)

            # Compute content hash (after removing staging fields)
            data["content_hash"] = self._compute_content_hash(data)

            # Compute entry hash
            entry_hash = hashlib.sha256(
                json.dumps(data, sort_keys=True).encode()
            ).hexdigest()

            date_str = time.strftime(
                "%Y-%m-%d", time.gmtime(start_epoch // 1000)
            )
            if date_str not in days:
                days[date_str] = []
            days[date_str].append(
                {"hash": entry_hash, "data": data, "start_epoch": start_epoch}
            )

        return days

    def _commit_day(self, date_str: str, day_entries: List[Dict[str, Any]]):
        """Process a single day: insert summaries, build/appends day block,
        update index."""
        ledger = self.chain.read_all()

        # Get the last block from the actual store for boundary checks
        prev_block = self.chain.get_last_block()
        if prev_block is None:
            return

        # Insert summary blocks if needed
        summary_blocks = self.summary_policy.get_summary_blocks(
            prev_block, date_str
        )
        for summary in summary_blocks:
            self.chain.append(summary)

        # Update index
        for entry in day_entries:
            title = entry["data"]["title"]
            duration = entry["data"].get("duration", 0)
            self.index.update(date_str, title, duration)

        # Build day block
        prev_block = self.chain.get_last_block()
        prev_hash = (
            prev_block.get("day_hash")
            or prev_block.get("month_hash")
            or prev_block.get("year_hash")
        )
        day_block = self.chain.build_day_block(
            day_entries, prev_hash, date_str
        )
        self.chain.append(day_block)

    # ── Verify ───────────────────────────────────────────

    def verify(self, full_check: bool = True) -> bool:
        """Verify the integrity of the entire ledger chain.

        Args:
            full_check: If True (default), performs full verification
                including content_hash checks. If False, only checks
                entry hashes (faster, for online verification).

        Returns:
            True if the chain is valid, False otherwise.
        """
        return self.chain.verify()

    # ── Revert ───────────────────────────────────────────

    def revert(self, count: int) -> int:
        """Revert the last N day blocks, restoring entries to staging.

        Counts day blocks (not summary blocks) and removes everything
        from the first reverted day block onward (including any summary
        blocks between reverted days). Restores entries to staging in
        plain: format.

        Args:
            count: Number of day blocks to revert from the end.

        Returns:
            Number of entries restored to staging, or -1 if count
            exceeds available day blocks.
        """
        ledger = self.chain.read_all()

        if not ledger:
            return 0

        # Identify day block indices
        day_indices = [
            i for i, b in enumerate(ledger) if b.get("type", "day") == "day"
        ]
        if count > len(day_indices):
            return -1
        if count <= 0:
            return 0

        revert_start = day_indices[-count]  # first day block to remove
        entries_restored = 0

        # Read staging using duck-type adaptation
        if hasattr(self.staging_store, 'read_entries'):
            staging = self.staging_store.read_entries()
        else:
            staging = self.staging_store.read_staging()
        staging = list(staging) if staging else []

        # Collect staging entries and update index
        for i in range(revert_start, len(ledger)):
            block = ledger[i]
            if block.get("type", "day") == "day":
                date_str = block["date"]
                for entry in block.get("entries", []):
                    data = dict(entry["data"])

                    # Convert encrypted fields back to plain: format
                    start_epoch = int(self.crypto.decrypt(data["startTime_enc"]))
                    data["startTime_enc"] = f"plain:{start_epoch}"
                    if data.get("endTime_enc"):
                        end_val = self.crypto.decrypt(data["endTime_enc"])
                        data["endTime_enc"] = f"plain:{end_val}"
                    if data.get("metadata_enc"):
                        data["metadata_enc"] = f"plain:{self.crypto.decrypt(data['metadata_enc'])}"
                    if data.get("pauses_enc"):
                        data["pauses_enc"] = f"plain:{self.crypto.decrypt(data['pauses_enc'])}"
                    else:
                        data["pauses_enc"] = "plain:[]"

                    # Build staging entry
                    staging_entry = {
                        "hash": entry["hash"],
                        "data": data,
                        "start_epoch": start_epoch,
                    }
                    staging.append(staging_entry)
                    entries_restored += 1

                    # Remove from index
                    title = data["title"]
                    duration = data.get("duration", 0)
                    self.index.update(date_str, title, -duration)

        # Write updated staging using duck-type adaptation
        if hasattr(self.staging_store, 'write_entries'):
            self.staging_store.write_entries(staging)
        else:
            self.staging_store.write_staging(staging)

        # Truncate ledger to keep all blocks before revert_start
        self.chain.truncate_keep(revert_start)
        return entries_restored

    # ── Query helpers ────────────────────────────────────

    def query_index(self, from_date: str, to_date: str) -> Dict[str, int]:
        """Query the blind index over a date range."""
        return self.index.query(from_date, to_date)

    def rebuild_index(self):
        """Rebuild the blind index from the full ledger chain.

        Scans all day blocks, sums durations per title per date,
        and writes the result to the index store.
        """
        self.index.clear()
        ledger = self.chain.read_all()

        for block in ledger:
            if block.get("type", "day") == "day":
                date_str = block["date"]
                for entry in block.get("entries", []):
                    data = entry["data"]
                    title = data.get("title", "")
                    duration = data.get("duration", 0)
                    self.index.update(date_str, title, duration)

    # ── Block access delegates ───────────────────────────

    def get_block_count(self) -> int:
        """Total number of blocks in the ledger chain."""
        return self.chain.get_block_count()

    def get_day_blocks(self) -> List[Dict[str, Any]]:
        """Return all day blocks from the chain (excludes summary blocks)."""
        ledger = self.chain.read_all()
        return [b for b in ledger if b.get("type", "day") == "day"]

    def get_last_block(self) -> Optional[Dict[str, Any]]:
        """Get the most recent block from the chain."""
        return self.chain.get_last_block()

    # ── Internal helpers ─────────────────────────────────

    def _compute_content_hash(self, data: dict) -> str:
        """Compute a content hash from all entry data fields.

        Decrypts _enc fields using the crypto manager, so the content
        hash is independent of encryption (survives re-keying).

        Matches the algorithm in core/ledger.py._compute_content_hash.
        """
        content = {}
        for key, value in data.items():
            if key == "content_hash":
                continue
            if key.endswith("_enc") and value is not None and value != "":
                try:
                    content[key] = self.crypto.decrypt(value)
                except Exception:
                    content[key] = value
            elif isinstance(value, list):
                content[key] = sorted(value)
            else:
                content[key] = value
        return hashlib.sha256(
            json.dumps(content, sort_keys=True).encode()
        ).hexdigest()
