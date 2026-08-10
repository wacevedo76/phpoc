"""MigrateFormatCommand — Format migration command.

Migrates the ledger chain to format version 0.4.0 by recomputing
all content_hash values with the extensible algorithm, plus all
dependent entry hashes, block seals, and prev_hash linkage.

Preserves provenance by saving original_* fields on every entry
and block before recomputing.

Usage:
    ph migrate-format          # Interactive — prompts for passphrase
    ph migrate-format --yes    # Skip confirmation prompt
"""

import hashlib
import json
import shutil
from datetime import datetime
from pathlib import Path
from typing import Optional

from security.crypto import CryptoManager, derive_mk
from domain.ledger.chain import LedgerChain, compute_seal
from domain.ledger.helpers import compute_entry_hash
from storage.implementations.file_ledger import FileLedgerStore


class MigrateFormatCommand:
    """CLI command for migrating ledger format_version to 0.4.0.

    Recomputes all content_hash values using the extensible (v0.4.0)
    algorithm, then cascades to update entry hashes, block seals,
    and prev_hash links.

    Preserves original_hash and original_entry_hash for provenance.

    Usage:
        ph migrate-format                                    # Default data dir
        ph migrate-format --file backup.json                 # Specific input
        ph migrate-format --file old.json --output new.json  # Input + output
    """

    requires_auth = True

    def __init__(self, data_dir: Optional[Path] = None, *,
                 seed: Optional[bytes] = None,
                 identity_secret: Optional[bytes] = None,
                 ledger_path: Optional[Path] = None,
                 output_path: Optional[Path] = None):
        self.data_dir = data_dir or Path.home() / ".local" / "share" / "phpoc"
        self.seed = seed
        self.identity_secret = identity_secret
        self._ledger_path = ledger_path
        self._output_path = output_path

    @property
    def ledger_path(self) -> Path:
        """Resolved ledger path: --file, or data dir default."""
        return self._ledger_path or self.data_dir / "ledger.json"

    @property
    def output_path(self) -> Path:
        """Resolved output path: --output, or same as input."""
        return self._output_path or self.ledger_path

    # ── Helpers ───────────────────────────────────────────────────

    def _derive_crypto(self, genesis: dict) -> CryptoManager:
        """Derive a CryptoManager from genesis key_version and seed.

        Defaults to key_version 0 (raw seed / pre-ADR legacy) when the genesis
        carries no key_version field — matching how such ledgers were encrypted.
        Newer ledgers with an explicit key_version use domain-separated HMAC.
        """
        key_version = genesis.get("key_version", 0)
        if key_version < 0:
            key_version = 0
        mk = derive_mk(self.seed, key_version)
        return CryptoManager(mk, key_version=key_version)

    def _compute_content_hash(self, data: dict, crypto: CryptoManager) -> str:
        """Compute content_hash using the extensible v0.4.0 algorithm.

        Decrypts _enc fields, strips _enc suffix, sorts lists,
        excludes content_hash itself, then SHA-256 of compact
        sort_keys=True JSON.
        """
        content = {}
        for key, value in data.items():
            if key == "content_hash":
                continue
            if key.endswith("_enc") and value is not None and value != "":
                try:
                    # Strip _enc suffix for canonical key name
                    content[key[:-4]] = crypto.decrypt(value)
                except Exception:
                    content[key] = value
            elif isinstance(value, list):
                content[key] = sorted(value)
            else:
                content[key] = value
        return hashlib.sha256(
            json.dumps(content, sort_keys=True).encode()
        ).hexdigest()

    def _seal_block(self, block: dict, crypto: CryptoManager, hash_key: str = None) -> str:
        """Compute a block seal: HMAC-SHA256 over the ADR-029a per-type fields.

        Routes through `chain.select_seal_fields` so all sealers share the
        canonical per-type whitelist (genesis/day = 6 fields, summaries =
        {type, month|year, date, prev_hash, original_hash}). The hash_key is
        derived from block type unless provided explicitly, so genesis
        (block_hash), day (day_hash), month (month_hash) and year (year_hash)
        blocks are all sealed consistently. `original_hash` is sealed when
        present; format_version/key_version/identity/signature stay out.
        """
        if hash_key is None:
            hash_key = self._block_hash_key(block)
        if hash_key is None:
            raise ValueError(f"Cannot seal block of unknown type: {block.get('type')}")
        return compute_seal(crypto, block)

    @staticmethod
    def _block_hash_key(block: dict) -> str:
        """Return the canonical hash-key field name for a block type."""
        t = block.get("type")
        if t == "genesis":
            return "block_hash"
        if t == "day":
            return "day_hash"
        if t == "month_summary":
            return "month_hash"
        if t == "year_summary":
            return "year_hash"
        return None

    def authenticate(self) -> bool:
        """Authenticate by verifying seed can decrypt genesis identity."""
        if self.seed is None:
            return False
        try:
            if not self.ledger_path.exists():
                return False
            chain_blocks = json.loads(self.ledger_path.read_text())
            if not chain_blocks:
                return False
            genesis = chain_blocks[0]
            crypto = self._derive_crypto(genesis)
            fallback = genesis["identity"]["identity_secret_enc_fallback"]
            crypto.decrypt(fallback)
            return True
        except Exception:
            return False

    def create_backup(self) -> Optional[Path]:
        """Create a timestamped backup of the input ledger and related state.

        When using --file (non-default input), only backs up the specified
        input file. For the default data-dir mode, backs up the full data dir.
        """
        try:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

            if self._ledger_path is not None:
                # --file mode: backup only the input file
                backup_dir = self.ledger_path.parent / f"backup_{timestamp}"
                backup_dir.mkdir(parents=True, exist_ok=False)
                shutil.copy2(self.ledger_path, backup_dir / self.ledger_path.name)
            else:
                # Default mode: backup everything in data dir
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

    # ── Migration ─────────────────────────────────────────────────

    def execute(self, skip_prompt: bool = False, force: bool = False) -> bool:
        """Run the format migration.

        Args:
            skip_prompt: If True, skip the confirmation prompt.
            force: If True, re-hash even chains already at format_version >= 0.4.0.
                Since the whole ledger is decryptable given the MK, an already-
                0.4.0 chain whose content_hashes were built by a divergent client
                can still be fully re-hashed into canonical jsonSort() form.

        Returns True on success.
        """
        if not self.ledger_path.exists():
            print("Error: No ledger.json found at", self.ledger_path)
            return False

        try:
            chain_blocks = json.loads(self.ledger_path.read_text())
        except (json.JSONDecodeError, OSError) as e:
            print("Error reading ledger.json:", e)
            return False

        if not chain_blocks:
            print("Error: ledger.json is empty")
            return False

        genesis = chain_blocks[0]
        if genesis.get("type") != "genesis":
            print("Error: First block is not a genesis block")
            return False

        current_fv = genesis.get("format_version", "0.0.0")
        if current_fv >= "0.4.0" and not force:
            print(f"Ledger is already at format_version {current_fv}. Nothing to do.")
            print(f"Run with --force to fully re-hash to canonical jsonSort() form (proceeds even at {current_fv}).")
            return True  # no-op is success

        crypto = self._derive_crypto(genesis)

        # ── Pre-validation: every _enc field must be decryptable ──
        print("Pre-validating: decrypting all _enc fields...")
        for i, block in enumerate(chain_blocks):
            if block.get("type") != "day":
                continue
            for j, entry in enumerate(block.get("entries", [])):
                data = entry.get("data", {})
                for key, val in data.items():
                    if key.endswith("_enc") and isinstance(val, str) and len(val) > 40:
                        try:
                            crypto.decrypt(val)
                        except Exception as e:
                            print(f"  FAIL: block {i}, entry {j}, field {key}: {e}")
                            return False
        print("  OK — all fields decryptable")

        # ── Confirmation ──
        if not skip_prompt:
            print()
            print("This will:")
            print(f"  - Migrate {len(chain_blocks)} blocks to format_version 0.4.0")
            print(f"  - Recompute content_hash for all entries")
            print(f"  - Recompute entry hashes, block seals, and prev_hash chain")
            print(f"  - Preserve original_hash and original_entry_hash for provenance")
            print(f"  - Create a timestamped backup before modifying")
            print()
            resp = input("Continue? [y/N] ").strip().lower()
            if resp not in ("y", "yes"):
                print("Aborted.")
                return False

        # ── Backup ──
        print("Creating backup...")
        backup_path = self.create_backup()
        if backup_path is None:
            print("Error: Could not create backup")
            return False
        print(f"  Backup at {backup_path}")

        # ── Phase 1: Rewrite entries (content_hash + entry hashes) ──
        # Seals and prev_hash rebuilt in Phase 2.
        print("Phase 1: Rewriting entries...")
        new_blocks = []

        for i, block in enumerate(chain_blocks):
            block = dict(block)  # shallow copy

            if block.get("type") == "genesis":
                block["format_version"] = "0.4.0"
                # Save original seal, clear it — recomputed in Phase 2 since
                # format_version changed (affects the genesis seal fields).
                if "block_hash" in block:
                    block["original_hash"] = block["block_hash"]
                block.pop("block_hash", None)
                block.pop("identity_seal", None)
                new_blocks.append(block)
                print(f"  Block {i}: genesis — format_version → 0.4.0")

            elif block.get("type") == "day":
                old_day_hash = block.get("day_hash", "")
                new_entries = []

                for entry in block.get("entries", []):
                    data = dict(entry["data"])

                    # Save original entry hash and add BEFORE content_hash so it's covered
                    original_entry_hash = entry.get("hash", "")
                    if original_entry_hash:
                        data["original_entry_hash"] = original_entry_hash

                    # Compute new content_hash (covers all data fields incl. original_entry_hash)
                    new_content_hash = self._compute_content_hash(data, crypto)

                    # Update data dict
                    data["content_hash"] = new_content_hash

                    # Compute new entry hash
                    new_entry_hash = compute_entry_hash(data)

                    new_entries.append({
                        "hash": new_entry_hash,
                        "data": data,
                    })

                block["entries"] = new_entries

                # Save original block seal
                if old_day_hash:
                    block["original_hash"] = old_day_hash

                # Clear ALL stale hash keys + seal — recomputed in Phase 2.
                # Some multi-client ledgers carry a stray block_hash on day
                # blocks (block_hash == day_hash); strip every hash field so
                # get_block_hash() sees exactly one canonical value.
                for hk in ("day_hash", "block_hash", "month_hash", "year_hash"):
                    block.pop(hk, None)
                block.pop("identity_seal", None)

                new_blocks.append(block)
                print(f"  Block {i}: day — {len(new_entries)} entries migrated")

            else:
                # month_summary, year_summary — re-seal in Phase 2 (must be
                # rebuilt since preceding day hashes change their prev_hash).
                hk = self._block_hash_key(block)
                if hk and hk in block:
                    block["original_hash"] = block[hk]
                for h in ("day_hash", "block_hash", "month_hash", "year_hash"):
                    block.pop(h, None)
                block.pop("identity_seal", None)
                new_blocks.append(block)

        # ── Phase 2: Rebuild prev_hash chain and re-seal ──
        # Each block's prev_hash must point to the previous block's new hash,
        # and the seal must be computed WITH that prev_hash included.  All
        # block types (genesis, day, month_summary, year_summary) are re-sealed
        # so the whole chain is self-consistent under the canonical jsonSort()
        # serialization.
        print("Phase 2: Rebuilding seals and prev_hash chain...")

        for i in range(len(new_blocks)):
            curr_block = new_blocks[i]

            # Update prev_hash for all blocks except genesis
            if i > 0:
                prev_block = new_blocks[i - 1]
                prev_key = self._block_hash_key(prev_block)
                if prev_key and prev_key in prev_block:
                    curr_block["prev_hash"] = prev_block[prev_key]

            # Re-seal the block with the (possibly updated) prev_hash
            hk = self._block_hash_key(curr_block)
            if hk:
                curr_block[hk] = self._seal_block(curr_block, crypto, hash_key=hk)

            # Identity seal (if present) — recompute with new hash
            if self.identity_secret and hk:
                seal_value = curr_block.get(hk)
                if seal_value:
                    curr_block["identity_seal"] = crypto.mac(
                        seal_value, self.identity_secret
                    )

        # ── Write and verify the migrated chain ──
        print("Writing and verifying migrated chain...")

        # Write migrated chain to output path
        self.output_path.write_text(json.dumps(new_blocks, indent=2))
        print(f"  Written to {self.output_path}")

        # ── Verify ──
        ledger_store = FileLedgerStore(self.output_path)
        chain = LedgerChain(crypto, ledger_store, identity_secret=self.identity_secret)
        result = chain.verify()

        if result:
            print("  ✅ Chain verification passed")
            print()
            print("Migration complete. Original data preserved in backup:")
            print(f"  {backup_path}")
            print()
            print("Next steps:")
            print("  1. Back up the migrated ledger file")
            print("  2. Wipe R2 (Flutter device)")
            print("  3. Onboard from the migrated ledger in phpoc-flutter")
            return True
        else:
            print("  ❌ Chain verification FAILED")
            print(f"  Restoring from backup: {backup_path}")
            # Restore from backup — copy back to input path
            backup_ledger = backup_path / "ledger.json"
            if backup_ledger.exists():
                shutil.copy2(backup_ledger, self.ledger_path)
                print("  Original ledger restored.")
            return False
