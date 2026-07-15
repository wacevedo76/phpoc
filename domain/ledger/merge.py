"""LedgerMerge — merge divergent ledger chains that share the same genesis.

Standalone module (not embedded in LedgerEngine or LedgerChain) because:
  1. Merge is infrequent — triggered by the genesis compatibility gate
     during remote connection setup, not on every sync.
  2. Cross-platform portable — minimal dependencies, can be ported.
  3. Bulk-merge ready — the same function can merge 2+ ledgers.
  4. Testable in isolation — no Engine/Chain instantiation needed.

Usage:
  from domain.ledger.merge import LedgerMerge
  result = await LedgerMerge.merge(local_chain, remote_chain, crypto,
                                   master_key, identity_secret)
  # result: {"mergedChain": list[dict], "stats": dict, "index": dict}

Algorithm (7 steps from merge.js):
  1. FIND FORK POINT — walk both chains, stop where block hashes diverge
  2. EXTRACT DIVERGENT ENTRIES — collect all entries from post-fork blocks
  3. DE-DUPLICATE — strict content_hash match; keep local, skip remote dupes
  4. SORT — alphabetically by data.title (privacy-first ordering)
  5. REBUILD CHAIN — common prefix + rebuilt day blocks with summary inserts
  6. REBUILD INDEX — aggregate durations by date and title
  7. RETURN — merged chain, stats, and index

TDD: GREEN phase — implementation complete.
"""

import hashlib
import inspect
from domain.ledger.helpers import get_block_hash

import json
from datetime import datetime, timezone
from typing import Optional, Dict, Any, List

from domain.ledger.summary_policy import YearMonthSummaryPolicy


class LedgerMerge:
    """Merge two divergent ledger chains that share the same genesis block."""

    @staticmethod
    async def merge(
        local_chain: List[dict],
        remote_chain: List[dict],
        crypto,
        master_key: str,
        identity_secret: Optional[str] = None,
        summary_policy=None,
    ) -> Dict[str, Any]:
        """Merge two divergent ledger chains.

        Returns: {"mergedChain": list[dict], "stats": dict, "index": dict}

        stats keys: forkIndex, localEntries, remoteEntries,
                    duplicatesSkipped, mergedEntries, newBlockCount
        """
        # ── 0. VALIDATE EACH CHAIN INDEPENDENTLY ──────────────────────
        await LedgerMerge._verify_chain("local", local_chain, crypto,
                                        master_key, identity_secret)
        await LedgerMerge._verify_chain("remote", remote_chain, crypto,
                                        master_key, identity_secret)

        # ── 1. FIND FORK POINT ────────────────────────────────────────
        fork_index = -1
        min_len = min(len(local_chain), len(remote_chain))
        for i in range(min_len):
            local_block_hash = get_block_hash(local_chain[i])
            remote_block_hash = get_block_hash(remote_chain[i])
            if local_block_hash == remote_block_hash:
                fork_index = i
            else:
                break

        # Genesis mismatch (fork_index === -1 means even genesis differs)
        if fork_index < 0:
            raise ValueError(
                "Genesis block mismatch: chains have different genesis "
                "blocks and cannot be merged"
            )

        # ── 2. EXTRACT ENTRIES & COUNT ────────────────────────────────
        local_entry_count = 0
        remote_entry_count = 0
        duplicates_skipped = 0
        all_local_content_hashes: set = set()
        post_fork_local_entries: list = []

        for i, block in enumerate(local_chain):
            if block.get("type") in ("day", None):
                for entry in (block.get("entries") or []):
                    local_entry_count += 1
                    ch = entry["data"].get("content_hash")
                    if ch:
                        all_local_content_hashes.add(ch)
                    if i > fork_index:
                        post_fork_local_entries.append({
                            "hash": entry["hash"],
                            "data": dict(entry["data"]),
                        })

        post_fork_remote_entries: list = []

        for i, block in enumerate(remote_chain):
            if block.get("type") in ("day", None):
                for entry in (block.get("entries") or []):
                    remote_entry_count += 1
                    ch = entry["data"].get("content_hash")
                    if ch and ch in all_local_content_hashes:
                        duplicates_skipped += 1
                    if i > fork_index:
                        post_fork_remote_entries.append({
                            "hash": entry["hash"],
                            "data": dict(entry["data"]),
                        })

        # ── 3. DE-DUPLICATE post-fork entries (strict content_hash) ────
        merged_entries = list(post_fork_local_entries)

        for entry in post_fork_remote_entries:
            ch = entry["data"].get("content_hash")
            if not ch or ch not in all_local_content_hashes:
                merged_entries.append(entry)

        # ── 4. SORT — alphabetical by title ───────────────────────────
        merged_entries.sort(
            key=lambda e: (e["data"].get("title") or "").casefold()
        )

        # ── 5. REBUILD CHAIN FROM FORK POINT ──────────────────────────
        common_prefix = local_chain[: fork_index + 1]

        # If no unique remote entries were added, the local chain is
        # already complete — use it as-is.
        has_unique_remote = len(merged_entries) > len(post_fork_local_entries)

        if not has_unique_remote:
            # Remote is a subset (or equal): keep local chain unchanged
            merged_chain = list(local_chain)
            new_block_count = 0
        else:
            # Rebuild: common prefix + new day blocks for merged entries
            merged_chain = list(common_prefix)

            # Determine starting day_index from the fork block
            fork_block = common_prefix[-1]
            if fork_block.get("type") in ("month_summary", "year_summary"):
                # PHPSPEC §4.4: reset to 1 if fork point is a summary block
                day_index = 1
            else:
                day_index = (fork_block.get("day_index") or 0) + 1

            # Group merged entries by date
            entries_by_date: dict = {}
            for entry in merged_entries:
                # Handle both sync and async decrypt
                if inspect.iscoroutinefunction(crypto.decrypt):
                    start_epoch_str = await crypto.decrypt(
                        entry["data"]["startTime_enc"]
                    )
                else:
                    start_epoch_str = crypto.decrypt(
                        entry["data"]["startTime_enc"]
                    )
                start_epoch = int(start_epoch_str)
                date_str = datetime.fromtimestamp(
                    start_epoch / 1000, tz=timezone.utc
                ).strftime("%Y-%m-%d")
                if date_str not in entries_by_date:
                    entries_by_date[date_str] = []
                entries_by_date[date_str].append(entry)

            # Use summary policy for inserting summary blocks during rebuild
            if summary_policy is None:
                identity_bytes = (
                    bytes.fromhex(identity_secret) if identity_secret else None
                )
                # YearMonthSummaryPolicy takes (crypto, identity_secret)
                summary_policy = YearMonthSummaryPolicy(crypto, identity_bytes)

            sorted_dates = sorted(entries_by_date.keys())
            new_block_count = 0

            for date_str in sorted_dates:
                date_entries = entries_by_date[date_str]

                # Sort entries alphabetically by title within the day
                date_entries.sort(
                    key=lambda e: (e["data"].get("title") or "").casefold()
                )

                # Insert summary blocks between the last block and this date
                prev_block = merged_chain[-1]
                summary_blocks = summary_policy.get_summary_blocks(
                    prev_block, date_str
                )
                for summary in summary_blocks:
                    merged_chain.append(summary)

                # Build day block
                prev_hash = get_block_hash(
                    merged_chain[-1]
                )

                day_content = {
                    "type": "day",
                    "day_index": day_index,
                    "date": date_str,
                    "prev_hash": prev_hash,
                    "entries": date_entries,
                }

                # Compute block seal
                day_json = json.dumps(day_content, sort_keys=True)

                if inspect.iscoroutinefunction(crypto.seal):
                    day_content["day_hash"] = await crypto.seal(day_json)
                else:
                    day_content["day_hash"] = crypto.seal(day_json)

                # Sign with identity secret if available
                if identity_secret:
                    identity_bytes = (
                        bytes.fromhex(identity_secret)
                        if isinstance(identity_secret, str)
                        else identity_secret
                    )
                    if inspect.iscoroutinefunction(crypto.sign):
                        day_content["identity_seal"] = await crypto.mac(
                            day_content["day_hash"], identity_bytes
                        )
                    else:
                        day_content["identity_seal"] = crypto.mac(
                            day_content["day_hash"], identity_bytes
                        )

                merged_chain.append(day_content)
                new_block_count += 1
                day_index += 1

        # ── 6. REBUILD INDEX ──────────────────────────────────────────
        index: dict = {}
        for block in merged_chain:
            if block.get("type") in ("day", None):
                for entry in (block.get("entries") or []):
                    data = entry["data"]
                    title = data.get("title") or ""
                    duration = data.get("duration") or 0
                    date_str = block["date"]
                    if date_str not in index:
                        index[date_str] = {}
                    index[date_str][title] = (
                        index[date_str].get(title, 0) + duration
                    )

        # ── 7. RETURN ─────────────────────────────────────────────────
        # Count merged entries from the full chain
        merged_entry_count = 0
        for block in merged_chain:
            if block.get("type") in ("day", None):
                merged_entry_count += len(block.get("entries") or [])

        stats = {
            "forkIndex": fork_index,
            "localEntries": local_entry_count,
            "remoteEntries": remote_entry_count,
            "duplicatesSkipped": duplicates_skipped,
            "mergedEntries": merged_entry_count,
            "newBlockCount": new_block_count,
        }

        return {"mergedChain": merged_chain, "stats": stats, "index": index}

    @staticmethod
    async def _verify_chain(
        label: str,
        chain: List[dict],
        crypto,
        master_key: str,
        identity_secret: Optional[str] = None,
    ) -> None:
        """Verify seal integrity, prev_hash linkage, entry hashes,
        and optional identity signatures for every block.

        Raises ValueError on validation failure.
        """
        if not isinstance(chain, list) or len(chain) == 0:
            return  # Empty chain is valid (trivially)

        # Block 0: seal + entry hashes
        if not LedgerMerge._verify_block_data(
            chain[0], crypto, master_key, identity_secret
        ):
            raise ValueError(
                f"{label} chain validation failed: block 0 seal or "
                f"entry hash is invalid"
            )

        # Blocks 1+: prev_hash linkage + seal + entry hashes
        for i in range(1, len(chain)):
            current = chain[i]
            prev = chain[i - 1]

            # Check prev_hash linkage
            if current.get("prev_hash") != get_block_hash(prev):
                raise ValueError(
                    f"{label} chain validation failed: prev_hash mismatch "
                    f"at block {i}"
                )

            if not LedgerMerge._verify_block_data(
                current, crypto, master_key, identity_secret
            ):
                raise ValueError(
                    f"{label} chain validation failed: block {i} seal, "
                    f"signature, or entry hash is invalid"
                )

    @staticmethod
    def _verify_block_data(
        block: dict,
        crypto,
        master_key: str,
        identity_secret: Optional[str] = None,
    ) -> bool:
        """Verify a single block: seal, optional signature, and entry hashes.

        Matches LedgerChain._verifyBlockData() from JS but operates on raw
        dicts (no store dependency).
        """
        btype = block.get("type") or "day"
        if btype == "genesis":
            hash_key = "block_hash" if "block_hash" in block else "day_hash"
        elif btype == "day":
            hash_key = "day_hash"
        elif btype == "month_summary":
            hash_key = "month_hash"
        elif btype == "year_summary":
            hash_key = "year_hash"
        else:
            hash_key = "day_hash"

        # Build check data: everything except the hash key, identity_seal, and signature
        check_data = {
            k: v for k, v in block.items()
            if k != hash_key and k != "signature" and k != "identity_seal"
        }

        # 1. Block seal
        if not crypto.verify_seal(
            json.dumps(check_data, sort_keys=True),
            block[hash_key],
        ):
            return False

        # 2. Identity seal (only if identity secret is set)
        if identity_secret:
            if "identity_seal" not in block and "signature" not in block:
                return False
            identity_bytes = (
                bytes.fromhex(identity_secret)
                if isinstance(identity_secret, str)
                else identity_secret
            )
            seal_value = block.get("identity_seal") or block.get("signature")
            if not crypto.verify_mac(
                block[hash_key], seal_value, identity_bytes
            ):
                return False

        # 3. Entry hashes for day blocks
        if btype == "day" and block.get("entries"):
            for entry in block["entries"]:
                expected_hash = hashlib.sha256(
                    json.dumps(
                        entry["data"], sort_keys=True, indent=2
                    ).encode()
                ).hexdigest()
                if expected_hash != entry["hash"]:
                    return False

        return True
