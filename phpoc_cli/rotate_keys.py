"""RotateKeysCommand — Key rotation CLI command (I-01).

Supports soft rotation (default) and hard rotation (--full) of the
Master Key used to protect the ledger chain.

Soft rotation:
  - Increments genesis key_version
  - Re-encrypts mutable state (identity_secret, staging, index, cookie)
  - Re-seals genesis with new MK
  - Existing day blocks are NOT modified

Hard rotation (--full):
  - Full chain rewrite: re-encrypts every entry, updates all key_version
    fields, recomputes all seals, MACs, and prev_hash links
  - Creates a backup of the old chain before overwriting
"""

import base64
import hashlib
import json
import logging
import secrets
import shutil
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

from security.crypto import CryptoManager, derive_mk
from security.recovery import RecoveryManager
from domain.ledger.chain import LedgerChain, compute_seal, select_seal_fields
from domain.ledger.index_manager import IndexManager
from domain.ledger.remote_sync import RemoteLedgerSync
from domain.staging.local_cache import LocalStagingCache
from domain.staging.remote_sync import RemoteStagingSync, REMOTE_COOKIE_PATH
from domain.cookie.device_cookie import DeviceCookie
from storage.implementations.file_ledger import FileLedgerStore
from storage.implementations.file_staging import FileStagingStore
from storage.implementations.file_index import FileIndexStore

logger = logging.getLogger(__name__)


class RotateKeysCommand:
    """CLI command for key rotation operations.

    Usage:
        ph rotate-keys              # Soft rotation (requires re-auth)
        ph rotate-keys --full       # Hard rotation (full chain rewrite)
    """

    requires_auth = True
    full = False

    def __init__(self, data_dir: Optional[Path] = None, *,
                 seed: Optional[bytes] = None,
                 identity_secret: Optional[bytes] = None,
                 current_key_version: Optional[int] = None,
                 old_seed: Optional[bytes] = None,
                 authenticator=None,
                 transport=None,
                 pdk: Optional[bytes] = None):
        self.data_dir = data_dir or Path.home() / ".local" / "share" / "phpoc"
        self.seed = seed
        self.identity_secret = identity_secret
        self.current_key_version = current_key_version
        self.old_seed = old_seed
        self.authenticator = authenticator
        self.transport = transport
        self.pdk = pdk

    # ── Internal helpers ────────────────────────────────────────────

    def _get_current_key_version(self, genesis: dict) -> int:
        """Read the key_version from genesis (default 0 for raw-seed / pre-ADR ledgers)."""
        return genesis.get("key_version", 0)

    def _verify_seed(self, genesis: dict) -> bool:
        """Check that the appropriate seed can decrypt the genesis identity secret.

        If old_seed is set, verifies that old_seed can decrypt current data
        (we are changing passphrases). Otherwise verifies self.seed.

        Derives the MK for the current key_version and attempts to
        decrypt identity_secret_enc_fallback. Returns False on any
        failure (wrong passphrase/seed, missing identity block).
        """
        try:
            current_version = self._get_current_key_version(genesis)
            effective_seed = self.old_seed if self.old_seed else self.seed
            mk = derive_mk(effective_seed, current_version)
            crypto = CryptoManager(mk, key_version=current_version)
            fallback = genesis["identity"]["identity_secret_enc_fallback"]
            crypto.decrypt(fallback)
            return True
        except Exception:
            return False

    def _read_device_uuid(self) -> str:
        """Get device_uuid from existing cookie, or generate a new one."""
        cookie_path = self.data_dir / "device_cookie.bin"
        try:
            if cookie_path.exists():
                cookie = json.loads(cookie_path.read_text())
                du = cookie.get("device_uuid")
                if du:
                    return du
        except (json.JSONDecodeError, OSError):
            pass
        return str(uuid.uuid4())

    # ── Rotation operations ────────────────────────────────────────

    def authenticate(self) -> bool:
        """Re-authenticate before rotation (required for safety).

        Returns True if authentication succeeds.
        """
        if self.seed is None:
            return False
        try:
            ledger_path = self.data_dir / "ledger.json"
            if not ledger_path.exists():
                return False
            genesis = json.loads(ledger_path.read_text())[0]
            return self._verify_seed(genesis)
        except Exception:
            return False

    @staticmethod
    def _make_multi_version_mk_lookup(current_version: int, seed: bytes):
        """Build a get_mk_for_version callable covering v0..current_version.

        Derives MKs for every version from 0 through current_version,
        enabling multi-version chain verification. v0 is the raw seed
        (pre-ADR / raw-seed ledgers).

        Args:
            current_version: The highest key version to derive.
            seed: Seed for MK derivation (required, not optional).
        """
        mks = {}
        for v in range(0, current_version + 1):
            mks[v] = CryptoManager(derive_mk(seed, v), key_version=v)
        return lambda version: mks.get(version)

    def verify_before_rotate(self) -> bool:
        """Verify chain integrity before rotation.

        Handles mixed-version chains by deriving all MKs from v1
        to current_version and providing a multi-version lookup.

        Returns True if the chain passes verification.
        """
        try:
            ledger_path = self.data_dir / "ledger.json"
            if not ledger_path.exists():
                return False
            genesis = json.loads(ledger_path.read_text())[0]
            current_version = self._get_current_key_version(genesis)
            mk = derive_mk(self.seed, current_version)
            crypto = CryptoManager(mk, key_version=current_version)
            store = FileLedgerStore(ledger_path)
            chain = LedgerChain(crypto, store, identity_secret=self.identity_secret)
            get_mk = self._make_multi_version_mk_lookup(current_version, self.seed)
            return chain.verify(get_mk_for_version=get_mk)
        except Exception:
            return False

    # ── Rotation pipeline helpers ──────────────────────────────────

    def _prepare_rotation(self):
        """Validate guards and derive old + new CryptoManagers.

        Returns a dict with keys: chain_blocks, genesis, ledger_path,
        current_version, new_version, crypto_v1, crypto_v2, get_mk.
        Returns None if any guard fails.
        """
        if not self.data_dir.exists():
            return None

        ledger_path = self.data_dir / "ledger.json"
        if not ledger_path.exists():
            return None

        try:
            chain_blocks = json.loads(ledger_path.read_text())
        except (json.JSONDecodeError, OSError):
            return None

        if not chain_blocks:
            return None

        genesis = chain_blocks[0]

        if not self._verify_seed(genesis):
            return None

        current_version = self._get_current_key_version(genesis)

        # Idempotency: if caller specified a current_key_version and
        # genesis is already at a higher version, this rotation is a no-op.
        if (self.current_key_version is not None
                and current_version > self.current_key_version):
            return None  # caller treats None as no-op / already-rotated

        decrypt_seed = self.old_seed if self.old_seed else self.seed
        encrypt_seed = self.seed

        mk_v1 = derive_mk(decrypt_seed, current_version)
        crypto_v1 = CryptoManager(mk_v1, key_version=current_version)

        store = FileLedgerStore(ledger_path)
        chain = LedgerChain(crypto_v1, store, identity_secret=self.identity_secret)
        get_mk = self._make_multi_version_mk_lookup(current_version, decrypt_seed)
        if not chain.verify(get_mk_for_version=get_mk):
            return None

        new_version = current_version + 1
        mk_v2 = derive_mk(encrypt_seed, new_version)
        crypto_v2 = CryptoManager(mk_v2, key_version=new_version)

        return {
            "chain_blocks": chain_blocks,
            "genesis": genesis,
            "ledger_path": ledger_path,
            "current_version": current_version,
            "new_version": new_version,
            "crypto_v1": crypto_v1,
            "crypto_v2": crypto_v2,
            "get_mk": get_mk,
        }

    def _rotate_mutable_state(self, genesis, crypto_v1, crypto_v2):
        """Re-encrypt identity fields, staging, index, and device cookie.

        Returns staging_path (Path or None).
        """
        # Identity fields
        decrypted_secret = crypto_v1.decrypt(
            genesis["identity"]["identity_secret_enc_fallback"]
        )
        genesis["identity"]["identity_secret_enc_fallback"] = \
            crypto_v2.encrypt(decrypted_secret)

        if "recovery_seed_enc" in genesis["identity"]:
            decrypted_recovery = crypto_v1.decrypt(
                genesis["identity"]["recovery_seed_enc"]
            )
            genesis["identity"]["recovery_seed_enc"] = \
                crypto_v2.encrypt(decrypted_recovery)

        # Staging
        staging_path = self.data_dir / "staging.json"
        if staging_path.exists():
            staging_store = FileStagingStore(staging_path)
            staging_cache_v1 = LocalStagingCache(crypto_v1, staging_store)
            entries = staging_cache_v1.read_entries()
            staging_cache_v2 = LocalStagingCache(crypto_v2, staging_store)
            staging_cache_v2.write_entries(entries)

        # Index
        index_path = self.data_dir / "index.json"
        if index_path.exists():
            index_store = FileIndexStore(index_path)
            index_mgr_v1 = IndexManager(index_store, crypto_v1)
            index_data = index_mgr_v1.get_all()
            index_mgr_v2 = IndexManager(index_store, crypto_v2)
            for date, titles in index_data.items():
                for title, duration in titles.items():
                    index_mgr_v2.update(date, title, duration)

        # Device cookie
        device_uuid = self._read_device_uuid()
        DeviceCookie.create(device_uuid, self.data_dir)

        return staging_path

    def _push_transport_updates(self, crypto_v1, crypto_v2, current_version,
                                 new_version, staging_path):
        """Update authenticator session cache and push to remote transport.

        Pushes through the real ``AbstractStagingTransport`` contract
        (``push(path, data)``): the rotated device cookie (plaintext JSON at
        ``staging/blobs/device_cookie.bin``) and the re-encrypted staging blob
        (obfuscated under the new MK via ``RemoteStagingSync.push``). Remote
        failures are logged, never fatal to the local rotation.
        """
        if self.authenticator is not None:
            self.authenticator._keys[new_version] = crypto_v2
            if current_version not in self.authenticator._keys:
                self.authenticator._keys[current_version] = crypto_v1

        if self.transport is None:
            return

        try:
            cookie_bytes = (self.data_dir / "device_cookie.bin").read_bytes()
            self.transport.push(REMOTE_COOKIE_PATH, cookie_bytes)
        except Exception as exc:
            logger.warning("rotation: device cookie push failed: %s", exc)

        try:
            if staging_path is not None and staging_path.exists():
                entries = FileStagingStore(staging_path).read_entries()
                rsync = RemoteStagingSync(
                    crypto_v2, self.transport, device_id_provider=None,
                    master_key=crypto_v2.master_key,
                )
                rsync.push(entries, self._read_device_uuid(),
                           master_key=crypto_v2.master_key)
        except Exception as exc:
            logger.warning("rotation: staging blob push failed: %s", exc)

    # ── Shared per-`_enc` re-key helpers (hard_rotate + renew_seed) ──────

    @staticmethod
    def _enc_fields(data: dict):
        """Yield ``(key, value)`` for ciphertext fields needing re-encryption.

        A field is ciphertext when its name ends in ``_enc`` and its value is a
        non-trivial string (``len > 40`` skips empty/placeholder values that
        are not real ciphertext).
        """
        for key, value in data.items():
            if key.endswith("_enc") and isinstance(value, str) and len(value) > 40:
                yield key, value

    @staticmethod
    def _decrypt_crypto_for_version(key_version, get_mk, fallback_crypto):
        """Resolve the decryption CryptoManager for a block ``key_version``.

        ``get_mk(version)`` covers the multi-version chain; ``fallback_crypto``
        is used when no versioned key is available for that version. Takes the
        key_version *explicitly* so callers pass the pre-rewrite version even
        when the block dict has already had ``key_version`` bumped.
        """
        return get_mk(key_version) if get_mk(key_version) else fallback_crypto

    def _prevalidate_entries_decryptable(self, chain_blocks, get_mk,
                                         fallback_crypto, default_kv):
        """Return True iff every day-block entry ciphertext field decrypts.

        Pre-validation runs before any write so a corrupt entry aborts the
        rewrite without leaving a half-rewritten chain (B2 atomicity).
        """
        for block in chain_blocks:
            if block.get("type") != "day":
                continue
            dec_crypto = self._decrypt_crypto_for_version(
                block.get("key_version", default_kv), get_mk, fallback_crypto)
            if dec_crypto is None:
                return False
            for entry in block.get("entries", []):
                for _key, value in self._enc_fields(entry["data"]):
                    try:
                        dec_crypto.decrypt(value)
                    except Exception:
                        return False
        return True

    def _reencrypt_entry_data(self, entry, dec_crypto, encrypt_crypto):
        """Re-encrypt one day-block entry's ciphertext fields under a new MK.

        Returns a new ``{"hash", "data"}`` entry with every ``_enc`` field
        re-encrypted and the ciphertext-bound entry hash recomputed. Plaintext
        ``content_hash`` is left invariant (R9).
        """
        data = dict(entry["data"])
        for key, value in list(self._enc_fields(data)):
            data[key] = encrypt_crypto.encrypt(dec_crypto.decrypt(value))
        new_hash = hashlib.sha256(
            json.dumps(data, sort_keys=True, indent=2).encode()
        ).hexdigest()
        return {"hash": new_hash, "data": data}

    def soft_rotate(self) -> bool:
        """Execute a soft rotation.

        Increments genesis key_version, re-encrypts mutable state,
        re-seals genesis. Existing day blocks are NOT modified.

        Returns True on success.
        """
        ctx = self._prepare_rotation()
        if ctx is None:
            # Idempotency: stale current_key_version → already rotated
            return (self.current_key_version is not None)

        chain_blocks = ctx["chain_blocks"]
        genesis = ctx["genesis"]
        ledger_path = ctx["ledger_path"]
        current_version = ctx["current_version"]
        new_version = ctx["new_version"]
        crypto_v1 = ctx["crypto_v1"]
        crypto_v2 = ctx["crypto_v2"]

        staging_path = self._rotate_mutable_state(genesis, crypto_v1, crypto_v2)

        # Bump key_version and format_version on genesis
        genesis["key_version"] = new_version
        fv = genesis.get("format_version", "0.0.0")
        if fv < "0.5.0":
            genesis["format_version"] = "0.5.0"

        # Save old genesis hash for prev_hash linkage after soft rotation
        old_genesis_hash = genesis.get("block_hash")
        if old_genesis_hash:
            genesis[f"prev_block_hash_v{current_version}"] = old_genesis_hash

        # Re-seal genesis — ADR-029a per-type whitelist
        check_data = select_seal_fields(genesis)
        genesis["block_hash"] = crypto_v2.seal(
            json.dumps(check_data, sort_keys=True)
        )

        # Recompute identity MAC
        genesis["identity_seal"] = crypto_v2.mac(
            genesis["block_hash"], self.identity_secret
        )

        # Write back — only genesis changes, day blocks untouched
        chain_blocks[0] = genesis
        ledger_path.write_text(json.dumps(chain_blocks, indent=2))

        self._push_transport_updates(crypto_v1, crypto_v2, current_version,
                                      new_version, staging_path)
        return True

    def hard_rotate(self) -> bool:
        """Execute a hard rotation (full chain rewrite).

        Creates a backup, then re-encrypts every entry in every day
        block with the new MK, updating all key_version fields, seals,
        MACs, and prev_hash links.

        Returns True on success, False if any step fails (no partial writes).
        """
        ctx = self._prepare_rotation()
        if ctx is None:
            return False

        chain_blocks = ctx["chain_blocks"]
        genesis = ctx["genesis"]
        ledger_path = ctx["ledger_path"]
        current_version = ctx["current_version"]
        new_version = ctx["new_version"]
        crypto_v1 = ctx["crypto_v1"]
        crypto_v2 = ctx["crypto_v2"]
        get_mk = ctx["get_mk"]

        # Create backup BEFORE any modifications
        if self.create_backup() is None:
            return False

        # Pre-validate: every entry must be decryptable before we rewrite.
        # (B2 atomicity — a corrupt entry aborts before any write.)
        if not self._prevalidate_entries_decryptable(
                chain_blocks, get_mk, crypto_v1, 1):
            return False

        staging_path = self._rotate_mutable_state(genesis, crypto_v1, crypto_v2)

        # Rewrite every block: bump key_version, re-encrypt entries,
        # recompute hashes, seals, and MACs with cascading prev_hash links
        old_to_new_hash = {}
        new_blocks = []

        for block in chain_blocks:
            block = dict(block)  # shallow copy — we rebuild entries
            original_kv = block.get("key_version", current_version)
            block["key_version"] = new_version

            if block.get("type") == "genesis":
                fv = block.get("format_version", "0.0.0")
                if fv < "0.5.0":
                    block["format_version"] = "0.5.0"

                old_hash = genesis.get("block_hash")
                if old_hash:
                    block[f"prev_block_hash_v{current_version}"] = old_hash

                hash_key = "block_hash"
                check_data = select_seal_fields(block)
                block[hash_key] = crypto_v2.seal(
                    json.dumps(check_data, sort_keys=True)
                )
                block["identity_seal"] = crypto_v2.mac(
                    block[hash_key], self.identity_secret
                )
                old_to_new_hash[old_hash] = block[hash_key]
                # Map stored prev_block_hash_v{N} → new genesis hash
                for key, val in genesis.items():
                    if key.startswith("prev_block_hash_v"):
                        old_to_new_hash[val] = block[hash_key]

            elif block.get("type") == "day":
                dec_crypto = self._decrypt_crypto_for_version(
                    original_kv, get_mk, crypto_v1)
                if dec_crypto is None:
                    return False
                block["entries"] = [
                    self._reencrypt_entry_data(entry, dec_crypto, crypto_v2)
                    for entry in block.get("entries", [])
                ]

                old_prev = block.get("prev_hash")
                if old_prev and old_prev in old_to_new_hash:
                    block["prev_hash"] = old_to_new_hash[old_prev]

                old_day_hash = block.get("day_hash")
                hash_key = "day_hash"
                block[hash_key] = compute_seal(crypto_v2, block)
                if self.identity_secret:
                    block["identity_seal"] = crypto_v2.mac(
                        block[hash_key], self.identity_secret
                    )
                if old_day_hash:
                    old_to_new_hash[old_day_hash] = block[hash_key]

            new_blocks.append(block)

        ledger_path.write_text(json.dumps(new_blocks, indent=2))

        self._push_transport_updates(crypto_v1, crypto_v2, current_version,
                                      new_version, staging_path)
        return True

    def create_backup(self) -> Optional[Path]:
        """Create a timestamped backup of the current chain and mutable state.

        Copies ledger.json, staging.json, index.json, device_cookie.meta,
        device_cookie.bin, and identity.json (if they exist) into a
        timestamped subdirectory under data_dir.

        Returns path to the backup directory, or None on failure.
        """
        try:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            backup_dir = self.data_dir / f"backup_{timestamp}"
            backup_dir.mkdir(parents=True, exist_ok=False)

            for fname in ["ledger.json", "staging.json", "index.json",
                          "device_cookie.meta", "device_cookie.bin",
                          "identity.json"]:
                src = self.data_dir / fname
                if src.exists():
                    shutil.copy2(src, backup_dir / fname)

            return backup_dir
        except OSError:
            return None

    def execute(self, full: bool = False) -> bool:
        """Execute the rotation command.

        Args:
            full: If True, perform hard rotation. Default: soft rotation.

        If old_seed is provided (passphrase change), hard rotation is
        forced regardless of the full flag — re-encrypting mutable state
        alone would leave day-block seals bound to the old MK, breaking
        chain verification under the new passphrase.

        Returns True on success.
        """
        if self.old_seed is not None:
            full = True
        if full:
            return self.hard_rotate()
        return self.soft_rotate()

    # ── C-2 Seed Re-Key (Phase 3) ────────────────────────────────────

    @staticmethod
    def seed_fingerprint(seed_b64: str) -> str:
        """Deterministic SHA-256 fingerprint of a seed (64 hex chars) for
        drift detection and the no-double-run marker (B4).

        Contract: SHA-256 over the domain-prefixed string
        ``f"phpoc:seed-fingerprint:v1:{seed_b64}"`` (Flutter parity).
        """
        return hashlib.sha256(
            f"phpoc:seed-fingerprint:v1:{seed_b64}".encode()
        ).hexdigest()

    def mint_new_seed(self) -> str:
        """Mint a fresh 32-byte CSPRNG seed, base64-encoded (R3/R4)."""
        return base64.b64encode(secrets.token_bytes(32)).decode()

    def _rekey_mutable_state(self, crypto_v1, crypto_v2):
        """Re-encrypt staging, index, and device cookie under the new MK.

        Unlike ``_rotate_mutable_state`` this deliberately does NOT touch
        ``recovery_seed_enc`` (it is PDK-encrypted, rewritten separately in
        ``renew_seed``) nor genesis identity fields (handled by the block
        rebuild).

        Returns the staging path (Path or None).
        """
        staging_path = self.data_dir / "staging.json"
        if staging_path.exists():
            staging_store = FileStagingStore(staging_path)
            staging_cache_v1 = LocalStagingCache(crypto_v1, staging_store)
            entries = staging_cache_v1.read_entries()
            staging_cache_v2 = LocalStagingCache(crypto_v2, staging_store)
            staging_cache_v2.write_entries(entries)

        index_path = self.data_dir / "index.json"
        if index_path.exists():
            index_store = FileIndexStore(index_path)
            index_mgr_v1 = IndexManager(index_store, crypto_v1)
            index_data = index_mgr_v1.get_all()
            index_mgr_v2 = IndexManager(index_store, crypto_v2)
            for date, titles in index_data.items():
                for title, duration in titles.items():
                    index_mgr_v2.update(date, title, duration)

        # Rotate the device cookie specifier so stale-MK sessions re-auth.
        device_uuid = self._read_device_uuid()
        DeviceCookie.create(device_uuid, self.data_dir)

        return staging_path

    def renew_seed(self):
        """C-2 seed replacement: full-chain re-key under a freshly-minted seed.

        Orchestrates the re-key in four phases (mirroring Flutter/Web Phase 4):

          1. ``_prepare_rekey``          — guards, verify, backup, mint, derive,
                                           pre-validate (atomicity)
          2. ``_rebuild_rekeyed_blocks`` — in-memory re-encrypt + re-seal + re-hash
          3. ``_persist_rekeyed_state``  — identity.json + chain + mutable state
                                           + marker
          4. ``_push_rekeyed_state``     — session cache + remote push

        Returns the new seed (base64 str) on success, or None on failure
        (wrong/absent old seed, corrupt chain, existing marker, partial write).
        """
        ctx = self._prepare_rekey()
        if ctx is None:
            return None

        new_seed_b64 = ctx["new_seed_b64"]

        new_blocks = self._rebuild_rekeyed_blocks(ctx)
        if new_blocks is None:
            return None

        staging_path = self._persist_rekeyed_state(ctx, new_blocks)
        if staging_path is None:
            return None

        self._push_rekeyed_state(
            ctx["crypto_v1"], ctx["crypto_v2"], ctx["current_version"],
            ctx["new_version"], staging_path, new_blocks)

        return new_seed_b64

    def _prepare_rekey(self):
        """Guards, verify, backup, mint, and derive — the re-key preflight.

        Returns a context dict (chain_blocks, genesis, ledger_path,
        current_version, new_version, crypto_v1, crypto_v2, get_mk,
        new_seed_b64) or None if any guard fails.
        """
        marker_path = self.data_dir / "rekey_seed.json"
        if marker_path.exists():
            return None

        ledger_path = self.data_dir / "ledger.json"
        if not ledger_path.exists():
            return None
        try:
            chain_blocks = json.loads(ledger_path.read_text())
        except (json.JSONDecodeError, OSError):
            return None
        if not chain_blocks:
            return None

        genesis = chain_blocks[0]

        # Gate: the old seed must decrypt the genesis identity fallback (R1).
        if not self._verify_seed(genesis):
            return None

        current_version = self._get_current_key_version(genesis)

        mk_v1 = derive_mk(self.seed, current_version)
        crypto_v1 = CryptoManager(mk_v1, key_version=current_version)
        get_mk = self._make_multi_version_mk_lookup(current_version, self.seed)

        store = FileLedgerStore(ledger_path)
        chain = LedgerChain(crypto_v1, store, identity_secret=self.identity_secret)
        if not chain.verify(get_mk_for_version=get_mk):
            return None

        # Backup BEFORE any write (R2/B1).
        if self.create_backup() is None:
            return None

        # Mint the replacement seed (R3/R4).
        new_seed_b64 = self.mint_new_seed()
        new_seed = base64.b64decode(new_seed_b64)

        # Option (a) raw-seed re-key: the fresh seed IS the MK (key_version=0).
        # A seed replacement does not bump key_version (ADR-026 rotation does).
        new_version = 0
        mk_v2 = derive_mk(new_seed, new_version)
        crypto_v2 = CryptoManager(mk_v2, key_version=new_version)

        # Pre-validate every entry decrypts before rewriting (B2 — atomicity).
        if not self._prevalidate_entries_decryptable(
                chain_blocks, get_mk, crypto_v1, current_version):
            return None

        return {
            "chain_blocks": chain_blocks,
            "genesis": genesis,
            "ledger_path": ledger_path,
            "current_version": current_version,
            "new_version": new_version,
            "crypto_v1": crypto_v1,
            "crypto_v2": crypto_v2,
            "get_mk": get_mk,
            "new_seed_b64": new_seed_b64,
        }

    def _rebuild_rekeyed_blocks(self, ctx):
        """In-memory rebuild of the chain under the new key set.

        Re-encrypts each block's ciphertext, re-seals, recomputes identity
        MACs and the prev_hash cascade. Nothing is written — the caller
        persists atomically (M4). Returns the rebuilt blocks, or None if a
        day-block decryption key cannot be resolved.
        """
        chain_blocks = ctx["chain_blocks"]
        genesis = ctx["genesis"]
        current_version = ctx["current_version"]
        crypto_v1 = ctx["crypto_v1"]
        crypto_v2 = ctx["crypto_v2"]
        get_mk = ctx["get_mk"]
        new_seed_b64 = ctx["new_seed_b64"]

        old_to_new_hash = {}
        new_blocks = []

        for block in chain_blocks:
            block = dict(block)

            if block.get("type") == "genesis":
                identity = dict(block["identity"])
                block["identity"] = identity

                # Re-encrypt the identity fallback under the new MK (R6).
                identity_hex = crypto_v1.decrypt(
                    identity["identity_secret_enc_fallback"]
                )
                identity["identity_secret_enc_fallback"] = crypto_v2.encrypt(identity_hex)

                # Rewrite the seed vault under the PDK (R5) — the new seed
                # becomes the single recovery root.
                if self.pdk is not None:
                    identity["recovery_seed_enc"] = RecoveryManager.encrypt_seed(
                        new_seed_b64, self.pdk
                    )

                old_hash = genesis.get("block_hash")
                # key_version carried through unchanged (option (a) raw-seed re-key).
                block["block_hash"] = crypto_v2.seal(
                    json.dumps(select_seal_fields(block), sort_keys=True)
                )
                block["identity_seal"] = crypto_v2.mac(
                    block["block_hash"], self.identity_secret
                )
                if old_hash:
                    old_to_new_hash[old_hash] = block["block_hash"]

            elif block.get("type") == "day":
                dec_crypto = self._decrypt_crypto_for_version(
                    block.get("key_version", current_version), get_mk, crypto_v1)
                if dec_crypto is None:
                    return None

                # Ciphertext-bound entry hash recomputed; content_hash
                # (plaintext) is intentionally left invariant (R9).
                block["entries"] = [
                    self._reencrypt_entry_data(entry, dec_crypto, crypto_v2)
                    for entry in block.get("entries", [])
                ]

                old_prev = block.get("prev_hash")
                if old_prev and old_prev in old_to_new_hash:
                    block["prev_hash"] = old_to_new_hash[old_prev]

                # Re-seal under the block's canonical hash key (mirrors
                # get_block_hash): legacy test ledgers seal day blocks under
                # ``block_hash``; canonical ledgers use ``day_hash``.
                hash_key = LedgerChain._hash_key_for_block(block)
                old_day_hash = block.get(hash_key)
                block[hash_key] = compute_seal(crypto_v2, block)
                if self.identity_secret:
                    block["identity_seal"] = crypto_v2.mac(
                        block[hash_key], self.identity_secret
                    )
                if old_day_hash:
                    old_to_new_hash[old_day_hash] = block[hash_key]

            else:
                # Summary blocks (month/year) — re-seal only (key_version unchanged).
                block[LedgerChain._hash_key_for_block(block)] = compute_seal(crypto_v2, block)

            new_blocks.append(block)

        return new_blocks

    def _persist_rekeyed_state(self, ctx, new_blocks):
        """Persist the re-keyed chain, identity.json, mutable state + marker.

        Writes in fail-safe order: identity.json first (returns None on
        failure, before any chain write), then the re-keyed chain (single
        atomic swap — M4), then mutable state + the no-double-run marker.

        Returns the staging path on success, or None on identity.json failure.
        """
        crypto_v1 = ctx["crypto_v1"]
        crypto_v2 = ctx["crypto_v2"]
        ledger_path = ctx["ledger_path"]
        new_version = ctx["new_version"]
        new_seed_b64 = ctx["new_seed_b64"]

        # Re-encrypt identity.json under the new MK (R6) — the existing
        # rotate path never touched this file (gap called out in §4.2).
        id_path = self.data_dir / "identity.json"
        if id_path.exists():
            try:
                id_data = json.loads(id_path.read_text())
                if "identity_secret_enc" in id_data:
                    id_data["identity_secret_enc"] = crypto_v2.encrypt(
                        crypto_v1.decrypt(id_data["identity_secret_enc"])
                    )
                    id_path.write_text(json.dumps(id_data, indent=2))
            except (json.JSONDecodeError, OSError, KeyError, ValueError):
                return None

        # Write the re-keyed chain atomically (single swap, no orphan — M4).
        ledger_path.write_text(json.dumps(new_blocks, indent=2))

        # Re-encrypt mutable state + rotate the device cookie.
        staging_path = self._rekey_mutable_state(crypto_v1, crypto_v2)

        # Record the re-key marker (B4).
        marker_path = self.data_dir / "rekey_seed.json"
        marker_path.write_text(json.dumps({
            "seed_fingerprint": self.seed_fingerprint(new_seed_b64),
            "key_version": new_version,
            "rekeyed_at": int(time.time() * 1000),
        }, indent=2))

        return staging_path

    def _push_rekeyed_state(self, crypto_v1, crypto_v2, current_version,
                            new_version, staging_path, new_blocks):
        """Update the authenticator session cache and push the re-keyed state.

        Pushes through the real ``AbstractStagingTransport`` contract
        (``push(path, data)`` / ``pull(path)``):

          - device cookie (plaintext JSON) — rotated specifier forces re-auth
          - staging blob — obfuscated under the NEW MK via ``RemoteStagingSync``
          - ledger chain — per-block obfuscated files via ``RemoteLedgerSync``
            (``force=True`` overwrites the old-MK chain, as after ``ph recover``)
          - hash index + index — via ``RemoteLedgerSync``

        Each push is isolated so a remote failure never breaks the already
        completed local re-key.
        """
        if self.authenticator is not None:
            self.authenticator._keys[new_version] = crypto_v2
            if current_version not in self.authenticator._keys:
                self.authenticator._keys[current_version] = crypto_v1

        if self.transport is None:
            return

        mk_v2 = crypto_v2.master_key

        try:
            cookie_bytes = (self.data_dir / "device_cookie.bin").read_bytes()
            self.transport.push(REMOTE_COOKIE_PATH, cookie_bytes)
        except Exception as exc:
            logger.warning("re-key: device cookie push failed: %s", exc)

        try:
            if staging_path is not None and staging_path.exists():
                entries = FileStagingStore(staging_path).read_entries()
                rsync = RemoteStagingSync(
                    crypto_v2, self.transport, device_id_provider=None,
                    master_key=mk_v2,
                )
                rsync.push(entries, self._read_device_uuid(), master_key=mk_v2)
        except Exception as exc:
            logger.warning("re-key: staging blob push failed: %s", exc)

        try:
            ledger_sync = RemoteLedgerSync(self.transport, mk_v2)
            ledger_sync.push_blocks(new_blocks, force=True)
            ledger_sync.push_hash_index(new_blocks)
            index_path = self.data_dir / "index.json"
            if index_path.exists():
                index_data = IndexManager(
                    FileIndexStore(index_path), crypto_v2).get_all()
                if index_data:
                    ledger_sync.push_index(index_data)
        except Exception as exc:
            logger.warning("re-key: ledger push failed: %s", exc)
