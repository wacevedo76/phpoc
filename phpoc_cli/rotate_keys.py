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

import hashlib
import json
import shutil
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

from security.crypto import CryptoManager, derive_mk
from domain.ledger.chain import LedgerChain, compute_seal, select_seal_fields
from domain.ledger.index_manager import IndexManager
from domain.staging.local_cache import LocalStagingCache
from domain.cookie.device_cookie import DeviceCookie
from storage.implementations.file_ledger import FileLedgerStore
from storage.implementations.file_staging import FileStagingStore
from storage.implementations.file_index import FileIndexStore


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
                 transport=None):
        self.data_dir = data_dir or Path.home() / ".local" / "share" / "phpoc"
        self.seed = seed
        self.identity_secret = identity_secret
        self.current_key_version = current_key_version
        self.old_seed = old_seed
        self.authenticator = authenticator
        self.transport = transport

    # ── Internal helpers ────────────────────────────────────────────

    def _get_current_key_version(self, genesis: dict) -> int:
        """Read the key_version from genesis (default 1 for pre-ADR ledgers)."""
        return genesis.get("key_version", 1)

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
        """Build a get_mk_for_version callable covering v1..current_version.

        Derives MKs for every version from 1 through current_version,
        enabling multi-version chain verification.

        Args:
            current_version: The highest key version to derive.
            seed: Seed for MK derivation (required, not optional).
        """
        mks = {}
        for v in range(1, current_version + 1):
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
        """Update authenticator session cache and push to remote transport."""
        if self.authenticator is not None:
            self.authenticator._keys[new_version] = crypto_v2
            if current_version not in self.authenticator._keys:
                self.authenticator._keys[current_version] = crypto_v1

        if self.transport is not None:
            try:
                cookie_bytes = (self.data_dir / "device_cookie.bin").read_bytes()
                self.transport.push_cookie(cookie_bytes)
            except Exception:
                pass
            try:
                if staging_path is not None and staging_path.exists():
                    staging_bytes = staging_path.read_bytes()
                    self.transport.push_blob("staging/blobs/staging.json", staging_bytes)
            except Exception:
                pass

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

        # Pre-validate: every entry must be decryptable before we rewrite
        for block in chain_blocks:
            if block.get("type") == "day":
                entry_kv = block.get("key_version", 1)
                dec_crypto = get_mk(entry_kv) if get_mk(entry_kv) else crypto_v1
                for entry in block.get("entries", []):
                    for key, val in entry["data"].items():
                        if key.endswith("_enc") and isinstance(val, str) and len(val) > 40:
                            try:
                                dec_crypto.decrypt(val)
                            except Exception:
                                return False

        staging_path = self._rotate_mutable_state(genesis, crypto_v1, crypto_v2)

        # Rewrite every block: bump key_version, re-encrypt entries,
        # recompute hashes, seals, and MACs with cascading prev_hash links
        old_to_new_hash = {}
        new_blocks = []

        for i, block in enumerate(chain_blocks):
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
                new_entries = []
                entry_kv = original_kv
                dec_crypto = get_mk(entry_kv) if get_mk(entry_kv) else crypto_v1
                if dec_crypto is None:
                    return False
                for entry in block.get("entries", []):
                    data = dict(entry["data"])
                    for key, val in list(data.items()):
                        if key.endswith("_enc") and isinstance(val, str) and len(val) > 40:
                            plaintext = dec_crypto.decrypt(val)
                            data[key] = crypto_v2.encrypt(plaintext)
                    new_hash = hashlib.sha256(
                        json.dumps(data, sort_keys=True, indent=2).encode()
                    ).hexdigest()
                    new_entries.append({"hash": new_hash, "data": data})

                block["entries"] = new_entries

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
