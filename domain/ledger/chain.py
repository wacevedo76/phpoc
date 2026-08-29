"""LedgerChain: block-level chain operations.

Handles construction, sealing, signing, appending, truncation, and
verification of individual blocks in the append-only ledger chain.

Every method is a thin wrapper over crypto + store operations, producing
output that is byte-identical to the original core/ledger.py.
"""

from domain.ledger.helpers import (
    get_block_hash, compute_entry_hash, verify_entry_hash_two_way
)

import json
import hashlib
from typing import Optional, List, Dict, Any, Tuple

from security.crypto import AbstractCryptoManager
from storage.ledger_store import AbstractLedgerStore

# Default format_version when genesis has none (pre-spec, implicit 0.2.0)
_DEFAULT_FORMAT_VERSION = (0, 2, 0)
# Content hash is required at this version and above
_CONTENT_HASH_REQUIRED_VERSION = (0, 4, 0)

# ADR-029 / ADR-029a: canonical closed, **type-aware** block-seal field table.
# A block's seal is an HMAC over exactly the fields in the row for that block
# type that are PRESENT, serialized with sort_keys=True. Fields OUTSIDE the row
# (format_version, key_version, identity, identity_seal, signature, the hash
# keys, and any stray/future/client-specific field) are NEVER sealed.
# `original_hash` is optional-presence on every type: sealed only when present
# (migrated blocks), absent on new/pre-0.4.0 blocks.
# Summaries seal their `month`/`year` (partition identity — D5 trust anchor)
# and carry no `day_index`/`entries`, so their rows differ from day/genesis.
SEAL_FIELDS = {
    "genesis":      {"type", "day_index", "date", "prev_hash", "entries",
                      "original_hash"},
    "day":          {"type", "day_index", "date", "prev_hash", "entries",
                      "original_hash"},
    "month_summary": {"type", "month", "date", "prev_hash", "original_hash"},
    "year_summary":  {"type", "year", "date", "prev_hash", "original_hash"},
}


def select_seal_fields(block: dict) -> dict:
    """Return the seal-input dict for a block: only the ADR-029a per-type
    whitelist fields present.

    Both sealers and verifiers/recompute across ALL implementations must use
    this single per-type selection so a block's seal never depends on
    non-whitelisted fields (closed-set) and summary identity (`month`/`year`)
    stays authenticated. Unknown block types are verification-invalid.
    """
    btype = block.get("type", "day")
    field_set = SEAL_FIELDS.get(btype)
    if field_set is None:
        raise ValueError(f"Unknown block type for seal: {btype!r}")
    return {k: v for k, v in block.items() if k in field_set}


def compute_seal(crypto, block: dict) -> str:
    """Compute a block's HMAC-SHA256 seal over its ADR-029a per-type fields.

    Centralizes `json.dumps(select_seal_fields(block), sort_keys=True)` + seal
    so every re-seal/verify site routes through the same per-type table.
    ``original_hash`` is sealed when present (in every row); the hash key and
    all non-whitelisted fields are excluded automatically.
    """
    return crypto.seal(json.dumps(select_seal_fields(block), sort_keys=True))


def _decrypt_or_plain(decrypt_fn, data: dict):
    """Return a callable that resolves plaintext or _enc field values.

    Returns a function ``resolver(field_name, enc_field_name, default='')``
    that prefers plaintext *field_name*, falling back to decrypting
    *enc_field_name* when available.
    """
    def resolve(field_name, enc_field_name, default=""):
        plain = data.get(field_name)
        if plain is not None and plain != "":
            return plain
        enc = data.get(enc_field_name)
        if enc and decrypt_fn is not None:
            try:
                return decrypt_fn(enc)
            except Exception:
                pass
        return default
    return resolve


def _resolve_json_list(field_name, enc_field_name, decrypt_fn, data: dict) -> list:
    """Resolve a list field, falling back from encrypted _enc variant."""
    plain = data.get(field_name)
    if plain is not None:
        return sorted(plain) if isinstance(plain, list) else []
    enc = data.get(enc_field_name)
    if enc and decrypt_fn is not None:
        try:
            import json as _json
            return sorted(_json.loads(decrypt_fn(enc)))
        except Exception:
            pass
    return []


def _verify_entry_hash_flex(data: dict, stored_hash: str) -> bool:
    """Verify an entry hash, trying all three serialization formats.

    Tries:
      1. sort+indent2 + sort+compact (via verify_entry_hash_two_way)
      2. nosort+indent2 (legacy: old CLI + current web before Phase 3)

    Returns True if stored_hash matches any format.
    """
    if verify_entry_hash_two_way(data, stored_hash):
        return True
    # Legacy: nosort+indent2
    expected_nosort_indent2 = hashlib.sha256(
        json.dumps(data, indent=2).encode()
    ).hexdigest()
    return expected_nosort_indent2 == stored_hash


class LedgerChain:
    """Block-level chain operations.

    Responsible for:
      - Sealing/MAC computation (matches CryptoManager seal/mac behavior)
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
            if ledger is None:
                ledger = []
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
            if ledger is None:
                ledger = []
            ledger.extend(blocks)
            self.store.write_ledger(ledger)
        return append_blocks

    def _make_truncate_fallback(self):  # pragma: no cover
        def truncate(keep_count):
            ledger = self.store.read_ledger()
            if ledger is None:
                ledger = []
            if keep_count >= len(ledger):
                return []
            kept = ledger[:keep_count]
            removed = ledger[keep_count:]
            self.store.write_ledger(kept)
            return removed
        return truncate

    def _make_get_block_count_fallback(self):  # pragma: no cover
        return lambda: len(self.store.read_ledger()) if self.store.read_ledger() is not None else 0

    def _make_get_last_block_fallback(self):  # pragma: no cover
        def get_last_block():
            ledger = self.store.read_ledger()
            if not ledger:
                return None
            return ledger[-1] if ledger else None
        return get_last_block

    # ── Seal / Sign helpers ──────────────────────────────

    def compute_seal(self, data: dict) -> str:
        """Compute an HMAC-SHA256 seal over a dict by serializing with sort_keys=True."""
        return self.crypto.seal(json.dumps(data, sort_keys=True))

    def verify_seal(self, data: dict, seal_hex: str) -> bool:
        """Verify an HMAC-SHA256 seal over a dict."""
        return self.crypto.verify_seal(json.dumps(data, sort_keys=True), seal_hex)

    def compute_identity_mac(self, data_str: str, identity_secret: Optional[bytes]) -> Optional[str]:
        """Compute an identity MAC, or None if no secret is configured."""
        if identity_secret is None:
            return None
        return self.crypto.mac(data_str, identity_secret)

    def verify_identity_mac(self, data_str: str, mac_tag: str, identity_secret: bytes) -> bool:
        """Verify an identity MAC against a given secret."""
        return self.crypto.verify_mac(data_str, mac_tag, identity_secret)

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
        key_version: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Build a day block with proper sealing and optional identity seal.

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
            day_hash, and optionally identity_seal.
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
            entry_hash = compute_entry_hash(data)
            normalized_entries.append({"hash": entry_hash, "data": data})

        day_content = {
            "type": "day",
            "day_index": day_index,
            "date": date_str,
            "prev_hash": prev_hash,
            "entries": normalized_entries,
        }
        if key_version is not None:
            day_content["key_version"] = key_version

        # Seal over the ADR-029a per-type whitelist (key_version excluded)
        # via the shared compute_seal entry point.
        day_content["day_hash"] = compute_seal(self.crypto, day_content)
        if self.identity_secret:
            day_content["identity_seal"] = self.crypto.mac(
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
            existing_hash = get_block_hash(last_existing)
            if blocks[0].get("prev_hash") != existing_hash:
                raise ValueError(
                    f"Block 0 prev_hash {blocks[0].get('prev_hash')} "
                    f"does not match last block hash {existing_hash}"
                )

        # Verify linkage among the new blocks
        for i in range(1, len(blocks)):
            prev_block = blocks[i - 1]
            prev_block_hash = get_block_hash(prev_block)
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

    def verify(self, get_mk_for_version=None) -> bool:
        """Full chain verification.

        Checks:
          1. prev_hash linkage between consecutive blocks
          2. Block seal integrity (day_hash/month_hash/year_hash)
          3. Identity seal (if identity_secret is available, via 'identity_seal' field)
          4. Entry hashes within day blocks (SHA256 of entry data)
          5. Content hash verification — required at format_version >= 0.4.0,
             optional (skip when absent) at lower versions

        Args:
            get_mk_for_version: Optional callable(version) -> CryptoManager for
                per-block MK selection. When None, self.crypto is used for all blocks.

        Returns True if the entire chain is valid.
        """
        ledger = self.read_all()
        if not ledger:
            return True

        verify_identity_seals = self.identity_secret is not None

        # Determine whether content_hash is required from genesis format_version
        genesis = ledger[0] if ledger else None
        require_content_hash = LedgerChain._is_format_version_at_least(
            genesis, _CONTENT_HASH_REQUIRED_VERSION
        )
        genesis_kv = genesis.get("key_version") if genesis else None

        for i in range(1, len(ledger)):
            current = ledger[i]
            prev = ledger[i - 1]

            # 1. prev_hash linkage — use per-version hash if available
            prev_hash = self._get_block_hash_for_version(
                prev, current.get("key_version"), get_mk_for_version
            )
            if current["prev_hash"] != prev_hash:
                return False

            # 2. Block seal (with per-version MK selection)
            if not self._verify_single_block(current, get_mk_for_version,
                                             require_content_hash=require_content_hash):
                return False

            # 3. Identity seal (if present — supports both 'identity_seal' and legacy 'signature')
            hash_key = LedgerChain._hash_key_for_block(current)
            identity_seal = current.get("identity_seal") or current.get("signature")
            if verify_identity_seals and identity_seal:
                if not self.crypto.verify_mac(
                    current[hash_key], identity_seal, self.identity_secret
                ):
                    return False

            # Check key_version invariant: day block key_version must not exceed genesis
            block_kv = current.get("key_version")
            if genesis_kv is not None and block_kv is not None and block_kv > genesis_kv:
                return False

        return True

    def _verify_single_block(self, block: dict, get_mk_for_version=None,
                             require_content_hash: bool = False) -> bool:
        """Verify a single block's seal and internal data integrity.

        Checks:
          1. Block seal (HMAC) — with optional per-version MK lookup
          2. Entry hashes within day blocks (via _verify_entry_hash_flex)
          3. Content hash — required at format_version >= 0.4.0,
             optional when absent at lower versions

        Does NOT check identity_seal/signature — that is handled by the
        caller (verify() or verify_block()).

        Args:
            block: The block to verify.
            get_mk_for_version: Optional callable returning a crypto-like object
                for the given version.
            require_content_hash: Whether content_hash is mandatory.

        Returns:
            True if valid.
        """
        # Determine which crypto to use for this block's seal
        crypto = self.crypto
        block_kv = block.get("key_version")
        if block_kv is not None and get_mk_for_version is not None:
            version_crypto = get_mk_for_version(block_kv)
            if version_crypto is None:
                return False
            crypto = version_crypto

        hash_key = LedgerChain._hash_key_for_block(block)
        # Verify against the ADR-029a canonical per-type whitelist (closed-set). A stray
        # non-whitelisted field in the block is excluded from recompute.
        check_data = select_seal_fields(block)
        if not crypto.verify_seal(
            json.dumps(check_data, sort_keys=True), block[hash_key]
        ):
            return False

        # Entry hashes in day blocks
        if block.get("type", "day") == "day":
            for entry in block.get("entries", []):
                data = entry["data"]
                if not _verify_entry_hash_flex(data, entry["hash"]):
                    return False

                has_content_hash = "content_hash" in data
                if require_content_hash and not has_content_hash:
                    return False

                if require_content_hash:
                    try:
                        if not self._verify_content_hash(data, decrypt_fn=crypto.decrypt):
                            return False
                    except Exception:
                        return False

        return True

    def verify_block(self, index: int, get_mk_for_version=None) -> bool:
        """Verify a single block by index.

        For block 0 (genesis), checks type + seal. For subsequent blocks,
        checks prev_hash linkage against the preceding block, plus seal +
        identity seal + entry hashes.

        Args:
            index: Block index.
            get_mk_for_version: Optional callable for per-block MK selection.
        """
        block = self.get_block(index)
        if block is None:
            return False

        if index == 0:
            if block.get("type") not in ("genesis", "day", "month_summary", "year_summary"):
                return False
            return self._verify_single_block(block, get_mk_for_version)

        prev = self.get_block(index - 1)
        if prev is None:
            return False

        current = block
        prev_hash = self._get_block_hash_for_version(
            prev, current.get("key_version"), get_mk_for_version
        )
        if current["prev_hash"] != prev_hash:
            return False

        if not self._verify_single_block(current, get_mk_for_version):
            return False

        # Identity seal (supports both 'identity_seal' and legacy 'signature')
        hash_key = LedgerChain._hash_key_for_block(current)
        identity_seal = current.get("identity_seal") or current.get("signature")
        if self.identity_secret and identity_seal:
            if not self.crypto.verify_mac(
                current[hash_key], identity_seal, self.identity_secret
            ):
                return False

        return True

    # ── Internal helpers ─────────────────────────────────

    @staticmethod
    def _get_block_hash_for_version(block: dict, key_version=None,
                                    get_mk_for_version=None) -> str:
        """Get a block's hash for prev_hash linkage checking.

        When the block is a genesis that may have been re-sealed with a
        different key version, recomputes the hash using the current block's
        key version. This allows day blocks created before rotation to still
        link to the genesis hash as it was at their version.

        After soft rotation, the genesis identity fields are re-encrypted
        with the new MK, so the seal data has changed. The old hash is
        stored as ``prev_block_hash_v{N}`` where N is the old key_version.
        When present and matching the queried key_version, that stored
        hash is returned directly.
        """
        stored = get_block_hash(block)
        if (key_version is not None and get_mk_for_version is not None
                and block.get("type") == "genesis"):
            # Check for stored previous hash from soft rotation
            prev_hash_key = f"prev_block_hash_v{key_version}"
            prev_stored = block.get(prev_hash_key)
            if prev_stored is not None:
                return prev_stored

            version_crypto = get_mk_for_version(key_version)
            if version_crypto is not None:
                hash_key = LedgerChain._hash_key_for_block(block)
                # Recompute over the ADR-029a canonical per-type whitelist (closed-set).
                check_data = select_seal_fields(block)
                recomputed = version_crypto.seal(
                    json.dumps(check_data, sort_keys=True)
                )
                if recomputed != stored:
                    return recomputed
        return stored

    @staticmethod
    def _hash_key_for_block(block: dict) -> str:
        """Return the hash field name for a block based on its type.

        Genesis blocks use ``block_hash`` (I-17). Old-format genesis
        blocks with only ``day_hash`` are still supported for backward
        compatibility. Non-genesis blocks use type-specific keys.
        """
        btype = block.get("type", "day")
        if btype == "genesis" and "block_hash" in block:
            return "block_hash"
        if btype == "genesis" and "day_hash" in block:
            return "day_hash"  # I-17 backward compat
        return {
            "day": "day_hash",
            "month_summary": "month_hash",
            "year_summary": "year_hash",
        }.get(btype, "day_hash")

    @staticmethod
    def _parse_format_version(genesis: Optional[dict]) -> Tuple[int, ...]:
        """Parse format_version from a genesis block into a tuple of ints.

        Returns (0, 2, 0) if genesis is None or has no format_version.
        """
        if genesis is None:
            return _DEFAULT_FORMAT_VERSION
        fv = genesis.get("format_version")
        if fv is None or not isinstance(fv, str):
            return _DEFAULT_FORMAT_VERSION
        try:
            return tuple(int(s) for s in fv.split("."))
        except (ValueError, AttributeError):
            return _DEFAULT_FORMAT_VERSION

    @staticmethod
    def _verify_content_hash_v030(data: dict, decrypt_fn=None) -> bool:
        """Verify content_hash using legacy v0.3.0 fixed-field algorithm.

        The v0.3.0 format used 9 hardcoded fields, each individually
        decrypted. This is the final fallback after canonical and
        extensible formats fail.
        """
        stored = data.get("content_hash")
        _resolve = _decrypt_or_plain(decrypt_fn, data)
        legacy = {
            "title": _resolve("title", "title_enc"),
            "startTime": decrypt_fn(data.get("startTime_enc", ""))
                if (decrypt_fn is not None and data.get("startTime_enc"))
                else data.get("startTime_enc", ""),
            "endTime": decrypt_fn(data.get("endTime_enc", ""))
                if (decrypt_fn is not None and data.get("endTime_enc"))
                else data.get("endTime_enc", ""),
            "metadata": decrypt_fn(data.get("metadata_enc", ""))
                if (decrypt_fn is not None and data.get("metadata_enc"))
                else data.get("metadata_enc", "{}"),
            "pauses": decrypt_fn(data.get("pauses_enc", ""))
                if (decrypt_fn is not None and data.get("pauses_enc"))
                else data.get("pauses_enc", "[]"),
            "tags": _resolve_json_list("tags", "tags_enc", decrypt_fn, data),
            "comment": _resolve("comment", "comment_enc"),
            "media": sorted(data.get("media", [])),
            "duration": int(_resolve("duration", "duration_enc", default="0")),
        }
        return (
            hashlib.sha256(json.dumps(legacy, sort_keys=True).encode()).hexdigest()
            == stored
        )

    @staticmethod
    def _is_format_version_at_least(genesis: Optional[dict], minimum: Tuple[int, ...]) -> bool:
        """Return True if genesis format_version >= minimum (segment-wise int comparison)."""
        actual = LedgerChain._parse_format_version(genesis)
        # Pad shorter tuple for comparison
        max_len = max(len(actual), len(minimum))
        a = actual + (0,) * (max_len - len(actual))
        m = minimum + (0,) * (max_len - len(minimum))
        return a >= m

    @staticmethod
    def _verify_content_hash(data: dict, decrypt_fn=None) -> bool:
        """Verify the content_hash of an entry's data dict.

        Uses the extensible algorithm from core/ledger.py:
        - Fields ending in ``_enc`` are decrypted via *decrypt_fn*
        - List fields are sorted for deterministic output
        - ``content_hash`` itself is excluded
        - sort_keys=True normalizes key ordering

        Args:
            data: The entry's data dict (raw from ledger, with encrypted fields).
            decrypt_fn: Callable that decrypts a single encrypted field value.
                       Required for proper verification. If None, uses
                       encrypted values directly (less accurate, but matches
                       old pre-v0.4 behavior).
        """
        content_canonical = {}  # keeps _enc suffix (v0.4.0+ per PHPSPEC §5.5/§6.1)
        content_legacy = {}  # strips _enc suffix (pre-spec Python format)
        for key, value in data.items():
            if key == "content_hash":
                continue
            if key.endswith("_enc") and value is not None and value != "":
                if decrypt_fn is not None:
                    try:
                        decrypted = decrypt_fn(value)
                        content_canonical[key] = decrypted
                        content_legacy[key[:-4]] = decrypted
                    except Exception:
                        content_canonical[key] = value
                        content_legacy[key] = value
                    continue
                else:
                    content_canonical[key] = value
                    content_legacy[key] = value
                    continue
            elif isinstance(value, list):
                content_canonical[key] = sorted(value)
                content_legacy[key] = sorted(value)
            else:
                content_canonical[key] = value
                content_legacy[key] = value

        computed = hashlib.sha256(
            json.dumps(content_canonical, sort_keys=True).encode()
        ).hexdigest()
        if computed == data["content_hash"]:
            return True

        # Try legacy Python format (strips _enc suffix on decrypted fields)
        computed_legacy = hashlib.sha256(
            json.dumps(content_legacy, sort_keys=True).encode()
        ).hexdigest()
        if computed_legacy == data["content_hash"]:
            return True

        # Fallback to legacy v0.3.0 algorithm (hardcoded 9-field format)
        return LedgerChain._verify_content_hash_v030(data, decrypt_fn)
