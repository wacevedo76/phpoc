"""LocalStagingCache — the ONLY class that knows about the plain: prefix convention.

LocalStagingCache handles encrypt/decrypt of staging entry fields and provides
CRUD methods that higher layers use without ever seeing ``plain:``.

This is a critical boundary in the architecture:
- ``plain:`` prefix is an internal detail, visible ONLY here
- All callers (StagingService, SyncOrchestrator, views) receive decrypted DTOs
- When ``plain:`` is eventually replaced with real no-op encryption, only this
  file changes
"""

import json
import hashlib
import hmac
import time
import uuid
from typing import Optional, List, Dict, Any, Tuple

from security.crypto import (
    AbstractCryptoManager,
    derive_field_key,
    build_field_token_map,
    STAGING_ENCRYPTABLE_FIELDS,
)
from storage.staging_store import AbstractStagingStore


# ── Field-name encryption constants ────────────────────────────────

# Re-exported from crypto.py for backward compatibility.
_ENCRYPTABLE_FIELDS = STAGING_ENCRYPTABLE_FIELDS


class LocalStagingCache:
    """Manages local staging entries with the plain: prefix convention.

    This is the ONLY class that knows about ``plain:``. No other component
    should see ``startswith("plain:")`` checks.

    Attributes:
        _crypto: CryptoManager for encrypting/decrypting entry fields.
        _store: AbstractStagingStore for persistence (staging.json).
    """

    def __init__(self, crypto: AbstractCryptoManager, staging_store: AbstractStagingStore):
        self._crypto = crypto
        self._store = staging_store
        self._field_token_map_cache: Optional[Dict[str, str]] = None

    # ------------------------------------------------------------------
    # Internal: plain: encoding/decoding
    # ------------------------------------------------------------------

    @property
    def _field_key(self) -> Optional[bytes]:
        """Lazily derive the field-name encryption key from the master key.

        Returns None when using NoAuthCryptoManager (no master key).
        """
        mk = getattr(self._crypto, "master_key", None)
        if not isinstance(mk, bytes) or len(mk) != 32:
            return None
        return derive_field_key(mk)

    def _field_name_token(self, field_name: str) -> str:
        """Compute a deterministic HMAC token for a field name.

        Same field name always produces the same token for the same
        master key. Uses HMAC-SHA256 with the derived field key.

        Returns the plaintext field name unchanged when no field key
        is available (no-auth mode).
        """
        fk = self._field_key
        if fk is None:
            return field_name
        return hmac.new(fk, field_name.encode(), hashlib.sha256).hexdigest()[:24]

    def _build_field_token_map(self) -> Dict[str, str]:
        """Build a reverse map from encrypted tokens → plaintext field names.

        Used by read_entries to decode which encrypted token maps to
        which field (e.g., token 'a1b2c3...' → 'startTime_enc').

        The result is cached on the instance — the token map is fixed
        for the lifetime of a given master key.
        """
        if self._field_token_map_cache is not None:
            return self._field_token_map_cache
        mk = getattr(self._crypto, "master_key", None)
        if not isinstance(mk, bytes) or len(mk) != 32:
            self._field_token_map_cache = {}
            return {}
        self._field_token_map_cache = build_field_token_map(
            mk, _ENCRYPTABLE_FIELDS
        )
        return self._field_token_map_cache

    @staticmethod
    def _is_legacy_entry_data(data: dict) -> bool:
        """Check if raw entry data uses legacy plaintext ``_enc`` keys.

        Only checks for the known structural ``_enc`` keys
        (startTime_enc, endTime_enc, etc.), NOT per-field encryption
        keys like title_enc, tags_enc, etc.
        """
        return any(k in _ENCRYPTABLE_FIELDS for k in data)

    def _decode_data_keys(self, data: dict, token_map: Dict[str, str]) -> Dict[str, Any]:
        """Decode raw entry data keys from encrypted tokens or legacy _enc.

        Returns a dict with standard plaintext keys (startTime_enc,
        endTime_enc, etc.) that downstream code can process.

        Legacy _enc keys are passed through as-is.
        """
        if not data:
            return {}
        # If any key ends with _enc, it's legacy format
        if self._is_legacy_entry_data(data):
            return dict(data)
        # New format: reverse-map tokens to field names
        decoded: Dict[str, Any] = {}
        for key, value in data.items():
            if key in token_map:
                decoded[token_map[key]] = value
            else:
                # Non-encryptable field: pass through as-is
                decoded[key] = value
        return decoded

    def _encode_data_keys(self, dto: dict) -> dict:
        """Encode standard field names to encrypted tokens for storage.

        Non-encryptable fields (title, duration, etc.) pass through as-is.
        Falls back to plaintext _enc keys when no master key is available.
        """
        encoded: Dict[str, Any] = {}
        for key, value in dto.items():
            if key in _ENCRYPTABLE_FIELDS:
                token = self._field_name_token(key)
                encoded[token] = value
            else:
                encoded[key] = value
        return encoded

    def _to_plain(self, field_value: str) -> str:
        """Internal: encrypt a field value for storage.

        Delegates to CryptoManager.encrypt() which produces:
        - AES-CTR hex ciphertext when a master key is available
        - ``plain:{value}`` fallback when using NoAuthCryptoManager (no MK)
        """
        return self._crypto.encrypt(field_value)

    def _from_plain(self, field_value: Optional[str]) -> Optional[str]:
        """Internal: decrypt a field value from storage.

        Handles both legacy ``plain:`` prefixed values (backward compat)
        and AES-CTR hex ciphertext. Returns None if input is None or
        decryption fails (corrupt entry).
        """
        if field_value is None:
            return None
        if field_value.startswith("plain:"):
            return field_value[6:]
        try:
            return self._crypto.decrypt(field_value)
        except Exception:
            return None

    def _from_plain_int(self, field_value: Optional[str]) -> Optional[int]:
        """Decrypt a field and convert to int. Returns None on failure."""
        decrypted = self._from_plain(field_value)
        if decrypted is None:
            return None
        try:
            return int(decrypted)
        except (ValueError, TypeError):
            return None

    def _encrypt_field(self, value: Any) -> str:
        """Encrypt a field value for storage (uses plain: prefix internally)."""
        return self._to_plain(str(value))

    # ------------------------------------------------------------------
    # Per-field encryption helpers (title, tags, comment, duration)
    # ------------------------------------------------------------------

    def _generate_entry_id(self) -> str:
        """Generate a stable entry UUID.

        Uses crypto.generateUuid() when available (mock compatibility),
        falling back to uuid.uuid4().
        """
        if hasattr(self._crypto, 'generateUuid') and callable(self._crypto.generateUuid):
            uid = self._crypto.generateUuid()
            if isinstance(uid, str) and uid:
                return uid
        return str(uuid.uuid4())

    def _has_master_key(self) -> bool:
        """Check if a master key is available for field encryption.

        Handles both CryptoManager (master_key attribute) and mock
        crypto (hasMasterKey/getMasterKey methods).
        """
        # Mock compatibility: check hasMasterKey() method first
        if hasattr(self._crypto, 'hasMasterKey') and callable(self._crypto.hasMasterKey):
            if not self._crypto.hasMasterKey():
                return False
            mk = self._crypto.getMasterKey() if hasattr(self._crypto, 'getMasterKey') else None
        else:
            mk = getattr(self._crypto, "master_key", None)
        return isinstance(mk, bytes) and len(mk) == 32

    def _encrypt_value(self, value: str) -> str:
        """Encrypt a single field value using the master key.

        Falls back to ``plain:`` prefix when no master key is available.
        """
        if not self._has_master_key():
            return "plain:" + str(value)
        return self._crypto.encrypt(value)

    def _decrypt_value(self, value: Optional[str]) -> Optional[str]:
        """Decrypt a single field value, handling plain: and hex ciphertext."""
        if value is None:
            return None
        if value.startswith("plain:"):
            return value[6:]
        try:
            return self._crypto.decrypt(value)
        except Exception:
            return None

    def _apply_entry_encryption(self, data: dict, *,
                                 title: str = "",
                                 tags: list = None,
                                 comment: str = None,
                                 duration: int = 0,
                                 encrypt_title: bool = False,
                                 encrypt_tags: bool = False,
                                 encrypt_comment: bool = False,
                                 encrypt_duration: bool = False):
        """Apply per-field encryption to the raw data dict in-place.

        Moves plaintext fields to ``_enc`` variants when encryption flags
        are set. Called *after* hash computation so the hash uses canonical
        plaintext values.

        Does NOT encrypt structural fields (is_active, is_paused).
        """
        tags = tags or []
        if encrypt_title:
            data["title_enc"] = self._encrypt_value(title)
            data.pop("title", None)
        if encrypt_tags:
            data["tags_enc"] = self._encrypt_value(json.dumps(tags))
            data.pop("tags", None)
        if encrypt_comment and comment is not None:
            data["comment_enc"] = self._encrypt_value(comment)
            data.pop("comment", None)
        if encrypt_duration:
            data["duration_enc"] = self._encrypt_value(str(duration))
            data.pop("duration", None)

    def _read_encrypted_field(self, data: dict, field_name: str, *, as_int: bool = False):
        """Dual-read a field: try ``{field}_enc`` first, fall back to plaintext.

        Returns the decrypted value and a boolean indicating whether the
        _enc variant was present (for ``has_encrypted_fields`` marking).
        """
        enc_key = f"{field_name}_enc"
        has_enc = enc_key in data
        has_mk = self._has_master_key()

        if has_enc:
            if has_mk:
                decrypted = self._decrypt_value(data.get(enc_key))
                if as_int:
                    if decrypted is not None:
                        try:
                            return int(decrypted), True
                        except (ValueError, TypeError):
                            return 0, True
                    return 0, True
                return decrypted, True
            else:
                # No MK — can't decrypt; return safe default
                if as_int:
                    return 0, True
                return "" if field_name == "title" else None, True

        # Plaintext fallback
        plain_val = data.get(field_name)
        if as_int:
            if plain_val is not None:
                try:
                    return int(plain_val), False
                except (ValueError, TypeError):
                    return 0, False
            return 0, False
        return plain_val, False

    def _read_encrypted_json_field(self, data: dict, field_name: str):
        """Dual-read a JSON-serialized field (tags).

        Returns (parsed_value, has_encrypted_fields_bool).
        """
        enc_key = f"{field_name}_enc"
        has_enc = enc_key in data
        has_mk = self._has_master_key()

        if has_enc:
            if has_mk:
                decrypted = self._decrypt_value(data.get(enc_key))
                if decrypted is not None:
                    try:
                        return json.loads(decrypted), True
                    except (json.JSONDecodeError, TypeError):
                        return [], True
                return [], True
            else:
                return [], True

        # Plaintext fallback
        return data.get(field_name, []), False

    def _toggle_encryption(self, decoded: dict, field_name: str, encrypt: bool, *,
                            serialize=None, deserialize=None,
                            default_plain="", default_enc_absent=None):
        """Toggle a field between plaintext and encrypted storage.

        When *encrypt* is True, encrypts the plaintext value and stores it
        as ``{field}_enc``, removing the plaintext key.
        When *encrypt* is False, decrypts the ``{field}_enc`` value back to
        plaintext and removes the encrypted key.

        *serialize* converts the native value to a string for encryption
        (default: identity). *deserialize* converts the decrypted string
        back (default: identity).
        """
        enc_key = f"{field_name}_enc"
        plain = decoded.get(field_name)

        if encrypt and plain is not None:
            raw = plain if serialize is None else serialize(plain)
            decoded[enc_key] = self._encrypt_value(raw)
            decoded.pop(field_name, None)
        elif not encrypt and enc_key in decoded:
            dec_raw = self._decrypt_value(decoded.get(enc_key))
            if deserialize is not None:
                try:
                    plain_val = deserialize(dec_raw) if dec_raw is not None else default_enc_absent
                except (ValueError, TypeError, json.JSONDecodeError):
                    plain_val = default_enc_absent
            else:
                plain_val = dec_raw if dec_raw is not None else default_plain
            decoded[field_name] = plain_val
            decoded.pop(enc_key, None)

    @staticmethod
    def _compute_entry_hash(entry_dto: dict) -> str:
        """Compute deterministic entry hash from plaintext DTO fields.

        Uses canonical plaintext fields (not encrypted storage fields) so the
        hash is independent of encryption nonces — same DTO always produces
        the same hash across clients.
        """
        fields = {
            "title": entry_dto.get("title", ""),
            "start_epoch": entry_dto.get("start_epoch", 0),
            "end_epoch": entry_dto.get("end_epoch"),
            "duration": entry_dto.get("duration", 0),
            "is_active": entry_dto.get("is_active", False),
            "is_paused": entry_dto.get("is_paused", False),
            "pauses": entry_dto.get("pauses", []),
            "tags": entry_dto.get("tags", []),
            "media": entry_dto.get("media", []),
            "entry_id": entry_dto.get("entry_id", ""),
            "metadata": entry_dto.get("metadata", {}),
            "device_uuid": entry_dto.get("device_uuid", ""),
            "end_device_uuid": entry_dto.get("end_device_uuid", ""),
        }
        comment = entry_dto.get("comment")
        if comment is not None:
            fields["comment"] = comment
        return hashlib.sha256(json.dumps(fields, sort_keys=True).encode()).hexdigest()

    # ------------------------------------------------------------------
    # Reading / Writing (full list)
    # ------------------------------------------------------------------

    def read_entries(self) -> List[Dict[str, Any]]:
        """Read all staged entries, decrypt fields, return DTOs.

        Returns decrypted entries suitable for external consumption —
        no ``plain:`` prefix visible, timestamps are integers, pauses are parsed.

        Returns:
            List of dicts with decrypted fields (start_epoch, end_epoch, pauses, etc.)
            plus metadata (entry_index, hash, source).
        """
        raw = self._store.read_entries()
        result = []
        token_map = self._build_field_token_map()
        for idx, entry in enumerate(raw):
            try:
                data = entry.get("data", {})
                # Decode encrypted key names → standard _enc keys
                decoded = self._decode_data_keys(data, token_map)

                # Decrypt structural fields
                start_epoch = self._from_plain_int(decoded.get("startTime_enc"))
                if start_epoch is None:
                    # Corrupt entry — skip
                    continue

                end_epoch = self._from_plain_int(decoded.get("endTime_enc"))

                pauses_raw = self._from_plain(decoded.get("pauses_enc"))
                pauses = json.loads(pauses_raw) if pauses_raw else []

                metadata_raw = self._from_plain(decoded.get("metadata_enc"))
                metadata = json.loads(metadata_raw) if metadata_raw else {}

                date_str = time.strftime(
                    "%Y-%m-%d", time.gmtime(start_epoch // 1000)
                )

                device_uuid = self._from_plain(decoded.get("device_uuid_enc"))
                end_device_uuid = self._from_plain(decoded.get("end_device_uuid_enc"))

                # Dual-read encryptable fields (title_enc, tags_enc, comment_enc, duration_enc)
                title, title_has_enc = self._read_encrypted_field(decoded, "title")
                if title is None:
                    title = ""
                tags, tags_has_enc = self._read_encrypted_json_field(decoded, "tags")
                comment, comment_has_enc = self._read_encrypted_field(decoded, "comment")
                duration, duration_has_enc = self._read_encrypted_field(decoded, "duration", as_int=True)
                if duration is None:
                    duration = 0

                has_encrypted_fields = (title_has_enc or tags_has_enc or
                                        comment_has_enc or duration_has_enc)

                dto = {
                    "entry_index": idx,
                    "title": title,
                    "start_epoch": start_epoch,
                    "end_epoch": end_epoch,
                    "duration": duration,
                    "is_active": decoded.get("is_active", False),
                    "is_paused": decoded.get("is_paused", False),
                    "pauses": pauses,
                    "tags": tags,
                    "comment": comment,
                    "media": decoded.get("media", []),
                    "entry_id": decoded.get("entry_id", ""),
                    "metadata": metadata,
                    "date": date_str,
                    "source": "local",
                    "hash": entry.get("hash", ""),
                    "device_uuid": device_uuid or "",
                    "end_device_uuid": end_device_uuid or "",
                    "has_encrypted_fields": has_encrypted_fields,
                }
                result.append(dto)
            except Exception:
                # Skip corrupt entries
                continue
        return result

    def write_entries(self, entries: List[Dict[str, Any]]):
        """Write a list of DTOs back to storage (encrypting fields and key names).

        Args:
            entries: List of DTOs (as returned by ``read_entries``).

        If an entry has ``has_encrypted_fields`` set, per-field encryptable
        fields (title, tags, comment, duration) are re-encrypted and stored
        as ``_enc`` variants.
        """
        raw = []
        for entry in entries:
            has_enc = entry.get("has_encrypted_fields", False)

            # Compute entry hash from canonical (plaintext) fields
            hash_data = {
                "title": entry.get("title", ""),
                "duration": entry.get("duration", 0),
                "start_epoch": entry.get("start_epoch", 0),
                "end_epoch": entry.get("end_epoch"),
                "tags": sorted(entry.get("tags", [])),
                "comment": entry.get("comment") or "",
                "media": sorted(entry.get("media", [])),
                "pauses": sorted(entry.get("pauses", []),
                                 key=lambda p: (p.get("pause_start", 0), p.get("pause_stop", 0))),
                "metadata": entry.get("metadata", {}),
                "device_uuid": entry.get("device_uuid", ""),
                "end_device_uuid": entry.get("end_device_uuid", ""),
                "entry_id": entry.get("entry_id", ""),
                "is_active": entry.get("is_active", False),
                "is_paused": entry.get("is_paused", False),
            }
            entry_hash = entry.get("hash") or self._compute_entry_hash(hash_data)

            data = {
                "is_active": entry.get("is_active", False),
                "is_paused": entry.get("is_paused", False),
                "startTime_enc": self._encrypt_field(entry.get("start_epoch", 0)),
                "endTime_enc": self._encrypt_field(entry["end_epoch"])
                if entry.get("end_epoch") is not None else None,
                "pauses_enc": self._encrypt_field(json.dumps(entry.get("pauses", []))),
                "metadata_enc": self._encrypt_field(json.dumps(entry.get("metadata", {}))),
                "media": entry.get("media", []),
                "entry_id": entry.get("entry_id", ""),
                "device_uuid_enc": self._encrypt_field(entry.get("device_uuid", "")),
                "end_device_uuid_enc": self._encrypt_field(entry.get("end_device_uuid", "")),
            }

            if has_enc:
                # Re-encrypt per-field fields, store as _enc variants
                data["title_enc"] = self._encrypt_value(entry.get("title", ""))
                data["tags_enc"] = self._encrypt_value(json.dumps(entry.get("tags", [])))
                comment = entry.get("comment")
                if comment:
                    data["comment_enc"] = self._encrypt_value(comment)
                data["duration_enc"] = self._encrypt_value(str(entry.get("duration", 0)))
            else:
                data["title"] = entry.get("title", "")
                data["duration"] = entry.get("duration", 0)
                data["tags"] = entry.get("tags", [])
                if entry.get("comment") is not None:
                    data["comment"] = entry["comment"]

            # Encrypt field key names
            data = self._encode_data_keys(data)

            raw.append({
                "hash": entry_hash,
                "data": data,
                "start_epoch": entry.get("start_epoch", 0),
            })

        self._store.write_entries(raw)

    # ------------------------------------------------------------------
    # CRUD operations
    # ------------------------------------------------------------------

    def append(self, title: str, start_epoch: int, *,
               end_epoch: Optional[int] = None,
               metadata: Optional[Dict[str, Any]] = None,
               is_active: bool = False,
               tags: Optional[List[str]] = None,
               comment: Optional[str] = None,
               media: Optional[List[Dict[str, Any]]] = None,
               device_uuid: Optional[str] = None,
               encrypt_title: bool = False,
               encrypt_tags: bool = False,
               encrypt_comment: bool = False,
               encrypt_duration: bool = False,
               encrypt_all: bool = False) -> str:
        """Append a new staging entry. Returns the entry hash prefix (10 chars).

        Raises:
            ValueError: If a collision is detected (same start_epoch).
        """
        raw = self._store.read_entries()

        # Collision check
        for entry in raw:
            if entry.get("start_epoch") == start_epoch:
                raise ValueError(
                    "Collision detected: A task has already started "
                    "at this millisecond."
                )

        # Normalize tags
        normalized_tags = self._normalize_tags(tags)

        computed_duration = (end_epoch - start_epoch) if end_epoch else 0

        data = {
            "title": title,
            "duration": computed_duration,
            "is_active": is_active,
            "is_paused": False,
            "startTime_enc": self._encrypt_field(start_epoch),
            "endTime_enc": self._encrypt_field(end_epoch) if end_epoch else None,
            "pauses_enc": self._encrypt_field(json.dumps([])),
            "metadata_enc": self._encrypt_field(json.dumps(metadata or {})),
            "tags": normalized_tags,
            "media": media if media is not None else [],
            "entry_id": self._generate_entry_id(),
            "device_uuid_enc": self._encrypt_field(device_uuid or ""),
            "end_device_uuid_enc": self._encrypt_field(""),
        }
        if comment is not None:
            data["comment"] = comment

        # Encrypt field key names (before hash and field encryption)
        data = self._encode_data_keys(data)

        # Compute hash from canonical plaintext DTO (before field encryption)
        entry_hash = self._compute_entry_hash({
            "title": title,
            "start_epoch": start_epoch,
            "end_epoch": end_epoch,
            "duration": computed_duration,
            "is_active": is_active,
            "is_paused": False,
            "pauses": [],
            "tags": normalized_tags,
            "media": media if media is not None else [],
            "entry_id": data.get("entry_id", ""),
            "metadata": metadata or {},
            "device_uuid": device_uuid or "",
            "end_device_uuid": "",
            "comment": comment,
        })

        # Decode key names back for field encryption (needs plaintext keys)
        decoded_from_tokens = self._decode_data_keys(data, self._build_field_token_map())

        # Determine effective encryption flags (encrypt_all overrides)
        eff_enc_title = encrypt_all or encrypt_title
        eff_enc_tags = encrypt_all or encrypt_tags
        eff_enc_comment = encrypt_all or encrypt_comment
        eff_enc_duration = encrypt_all or encrypt_duration

        # Apply field encryption after hash computation (hash uses plaintext)
        self._apply_entry_encryption(decoded_from_tokens,
            title=title,
            tags=normalized_tags,
            comment=comment,
            duration=computed_duration,
            encrypt_title=eff_enc_title,
            encrypt_tags=eff_enc_tags,
            encrypt_comment=eff_enc_comment,
            encrypt_duration=eff_enc_duration,
        )

        # Re-encode key names after encryption (title_enc keys are new plaintext)
        data = self._encode_data_keys(decoded_from_tokens)

        raw.append({
            "hash": entry_hash,
            "data": data,
            "start_epoch": start_epoch,
        })
        self._store.write_entries(raw)
        return entry_hash[:10]

    def update(self, index: int, fields: Dict[str, Any]):
        """Update specific fields on an entry at *index*.

        Fields that end with ``_epoch`` are encrypted before storage.
        The entry hash is recomputed after modifications.

        Args:
            index: Entry index in the staging array.
            fields: Dict of field names to new values.

        Raises:
            IndexError: If *index* is out of range.
        """
        raw = self._store.read_entries()
        if index < 0 or index >= len(raw):
            raise IndexError(f"No staged entry at index {index}.")

        data = raw[index]["data"]
        token_map = self._build_field_token_map()

        # Decode encrypted key names for reading (handles both legacy _enc and new tokens)
        decoded = self._decode_data_keys(data, token_map)

        # Map epoch fields to encrypted storage fields
        field_mapping = {
            "start_epoch": "startTime_enc",
            "end_epoch": "endTime_enc",
            "end_device_uuid": "end_device_uuid_enc",
        }

        for field_key, field_value in fields.items():
            if field_key in field_mapping:
                storage_key = field_mapping[field_key]
                if field_value is not None:
                    decoded[storage_key] = self._encrypt_field(field_value)
                else:
                    decoded[storage_key] = None
            elif field_key == "pauses":
                decoded["pauses_enc"] = self._encrypt_field(json.dumps(field_value))
            elif field_key == "metadata":
                decoded["metadata_enc"] = self._encrypt_field(json.dumps(field_value))
            elif field_key == "tags":
                decoded["tags"] = self._normalize_tags(field_value)
            elif field_key == "encrypt_title":
                self._toggle_encryption(decoded, "title", field_value)
            elif field_key == "encrypt_tags":
                self._toggle_encryption(decoded, "tags", field_value,
                                        serialize=json.dumps, deserialize=json.loads,
                                        default_plain=[], default_enc_absent=[])
            elif field_key == "encrypt_comment":
                self._toggle_encryption(decoded, "comment", field_value,
                                        default_plain=None)
            elif field_key == "encrypt_duration":
                self._toggle_encryption(decoded, "duration", field_value,
                                        serialize=str, deserialize=int,
                                        default_plain=0)
            elif field_key == "title_enc" and field_value is None:
                # Explicitly clear title_enc (A14: modify to decrypt)
                decoded.pop("title_enc", None)
            else:
                # Direct update for simple fields (adds new keys if needed)
                decoded[field_key] = field_value

        # Re-encode key names (upgrades legacy _enc keys to encrypted tokens)
        data.clear()
        data.update(self._encode_data_keys(decoded))

        # Recompute hash from current plaintext values
        raw[index]["hash"] = self._compute_entry_hash(self._raw_entry_to_dto_inline(decoded))

        self._store.write_entries(raw)

    def _raw_entry_to_dto_inline(self, data: dict) -> dict:
        """Build a partial DTO from a decoded data dict for hash computation.

        *data* is expected to be already decoded to standard field names
        (startTime_enc, endTime_enc, etc.), either because it came from
        _decode_data_keys or because it was legacy format.

        Handles both plaintext and _enc variants of encryptable fields
        (title/title_enc, tags/tags_enc, comment/comment_enc, duration/duration_enc).
        """
        start_epoch = self._from_plain_int(data.get("startTime_enc")) or 0
        end_epoch = self._from_plain_int(data.get("endTime_enc"))
        pauses_raw = self._from_plain(data.get("pauses_enc"))
        pauses = json.loads(pauses_raw) if pauses_raw else []
        metadata_raw = self._from_plain(data.get("metadata_enc"))
        metadata = json.loads(metadata_raw) if metadata_raw else {}
        device_uuid = self._from_plain(data.get("device_uuid_enc")) or ""
        end_device_uuid = self._from_plain(data.get("end_device_uuid_enc")) or ""

        # Dual-read encryptable fields for hash computation
        title, _ = self._read_encrypted_field(data, "title")
        if title is None:
            title = ""
        tags, _ = self._read_encrypted_json_field(data, "tags")
        comment, _ = self._read_encrypted_field(data, "comment")
        duration, _ = self._read_encrypted_field(data, "duration", as_int=True)
        if duration is None:
            duration = 0

        return {
            "title": title,
            "start_epoch": start_epoch,
            "end_epoch": end_epoch,
            "duration": duration,
            "is_active": data.get("is_active", False),
            "is_paused": data.get("is_paused", False),
            "pauses": pauses,
            "tags": tags,
            "media": data.get("media", []),
            "entry_id": data.get("entry_id", ""),
            "metadata": metadata,
            "device_uuid": device_uuid,
            "end_device_uuid": end_device_uuid,
            "comment": comment,
        }

    def delete(self, index: int):
        """Remove entry at *index*.

        Raises:
            IndexError: If *index* is out of range.
        """
        raw = self._store.read_entries()
        if index < 0 or index >= len(raw):
            raise IndexError(f"No staged entry at index {index}.")
        raw.pop(index)
        self._store.write_entries(raw)

    def remove_multiple(self, indices: List[int]):
        """Remove entries at the specified indices (staging-level).

        Args:
            indices: List of staging-level indices to remove.
        """
        self._store.remove_entries(indices)

    # ------------------------------------------------------------------
    # Pause management
    # ------------------------------------------------------------------

    def add_pause(self, index: int, pause_epoch: int, comment: Optional[str] = None):
        """Add a new pause record to the entry at *index*.

        The pause is opened (``pause_stop`` is None).

        Raises:
            IndexError: If *index* is out of range.
        """
        raw = self._store.read_entries()
        if index < 0 or index >= len(raw):
            raise IndexError(f"No staged entry at index {index}.")

        data = raw[index]["data"]
        token_map = self._build_field_token_map()
        decoded = self._decode_data_keys(data, token_map)

        pauses_enc = decoded.get("pauses_enc", self._encrypt_field(json.dumps([])))
        pauses = json.loads(self._from_plain(pauses_enc) or "[]")

        next_index = len(pauses) + 1
        pause_record = {
            "pause_index": next_index,
            "pause_start": pause_epoch,
            "pause_stop": None,
        }
        if comment is not None:
            pause_record["comment"] = comment
        pauses.append(pause_record)

        decoded["pauses_enc"] = self._encrypt_field(json.dumps(pauses))
        decoded["is_paused"] = True

        # Re-encode key names
        data.clear()
        data.update(self._encode_data_keys(decoded))

        # Recompute hash from plaintext values
        raw[index]["hash"] = self._compute_entry_hash(self._raw_entry_to_dto_inline(decoded))
        self._store.write_entries(raw)

    def close_pause(self, index: int, stop_epoch: int, comment: Optional[str] = None):
        """Close the last open pause record on the entry at *index*.

        Raises:
            IndexError: If *index* is out of range.
        """
        raw = self._store.read_entries()
        if index < 0 or index >= len(raw):
            raise IndexError(f"No staged entry at index {index}.")

        data = raw[index]["data"]
        token_map = self._build_field_token_map()
        decoded = self._decode_data_keys(data, token_map)

        pauses_enc = decoded.get("pauses_enc", self._encrypt_field(json.dumps([])))
        pauses = json.loads(self._from_plain(pauses_enc) or "[]")

        if pauses and pauses[-1].get("pause_stop") is None:
            pauses[-1]["pause_stop"] = stop_epoch
            if comment is not None:
                pauses[-1]["comment"] = comment

        decoded["pauses_enc"] = self._encrypt_field(json.dumps(pauses))
        decoded["is_paused"] = False

        # Re-encode key names
        data.clear()
        data.update(self._encode_data_keys(decoded))

        # Recompute hash from plaintext values
        raw[index]["hash"] = self._compute_entry_hash(self._raw_entry_to_dto_inline(decoded))
        self._store.write_entries(raw)

    # ------------------------------------------------------------------
    # Entry ID-based operations (stable identifier, no index race)
    # ------------------------------------------------------------------

    def _find_index_by_entry_id(self, entry_id: str) -> int:
        """Find the positional index for a given entry_id.

        Reads the current staging array and searches by entry_id (UUID).
        This is a fresh read each time — no stale-index risk.

        Raises:
            ValueError: If entry_id is not found.
        """
        raw = self._store.read_entries()
        for i, entry in enumerate(raw):
            if entry.get("data", {}).get("entry_id") == entry_id:
                return i
        raise ValueError(f"No staged entry found for entry_id: {entry_id}")

    def update_by_entry_id(self, entry_id: str, fields: Dict[str, Any]):
        """Update an entry by its stable entry_id (UUID). Resistant to index shifts."""
        index = self._find_index_by_entry_id(entry_id)
        self.update(index, fields)

    def add_pause_by_entry_id(self, entry_id: str, pause_epoch: int,
                               comment: Optional[str] = None):
        """Add a pause to an entry by its stable entry_id (UUID)."""
        index = self._find_index_by_entry_id(entry_id)
        self.add_pause(index, pause_epoch, comment)

    def close_pause_by_entry_id(self, entry_id: str, stop_epoch: int,
                                 comment: Optional[str] = None):
        """Close the last open pause on an entry by its stable entry_id (UUID)."""
        index = self._find_index_by_entry_id(entry_id)
        self.close_pause(index, stop_epoch, comment)

    # ------------------------------------------------------------------
    # Duration computation
    # ------------------------------------------------------------------

    @staticmethod
    def _compute_duration(
        start_epoch: int,
        end_epoch: Optional[int],
        pauses: List[Dict[str, Any]],
    ) -> int:
        """Compute active duration as wall time minus all completed pause intervals.

        ``pauses`` is a list of ``{"pause_start": ..., "pause_stop": ...}`` dicts.
        Intervals with ``pause_stop=None`` (ongoing pause) are skipped.

        Returns:
            Duration in milliseconds (0 if end_epoch is None).
        """
        if end_epoch is None:
            return 0
        total_pause_ms = 0
        for p in pauses:
            if p.get("pause_stop") is not None:
                total_pause_ms += p["pause_stop"] - p["pause_start"]
        return max(0, (end_epoch - start_epoch) - total_pause_ms)

    # ------------------------------------------------------------------
    # Tag normalization
    # ------------------------------------------------------------------

    @staticmethod
    def _normalize_tags(tags: Optional[List[str]]) -> List[str]:
        """Normalize tags: lowercase, strip, dedup, remove empties, sort."""
        if not tags:
            return []
        seen = set()
        result = []
        for t in tags:
            clean = t.strip().lower()
            if clean and clean not in seen:
                seen.add(clean)
                result.append(clean)
        result.sort()
        return result
