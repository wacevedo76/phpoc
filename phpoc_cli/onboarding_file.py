"""ph onboarding file — import a ledger from a local JSON file.

Supports three formats:
  - v1 export: { format_version: '1', entries, seal }
  - v2 export: { format_version: '2', ledger, staging, seal }
  - Raw chain: [block, ...] — CLI's ledger.json format

The user provides their recovery seed (base64-encoded master key).
For v2/raw chain: extracts identity, sets new passphrase, and verifies.
"""

import json
import hashlib
import base64
import getpass
import logging
from pathlib import Path

from security.crypto import CryptoManager
from security.recovery import RecoveryManager
from security.auth import PassphraseAuthenticator
from storage.file_store import LedgerStore
from core.ledger import LedgerDomain
from domain.ledger.helpers import get_block_hash, verify_entry_hash_two_way
from domain.ledger.chain import _verify_entry_hash_flex

logger = logging.getLogger(__name__)

# ── Per-block-type seal field names ────────────────────────────────────────
BLOCK_HASH_FIELD = {
    "genesis": "block_hash",
    "year_summary": "year_hash",
    "month_summary": "month_hash",
    "day": "day_hash",
}


def _prompt_seed() -> bytes:
    """Prompt for recovery seed and derive the 32-byte master key."""
    print("\nEnter your recovery seed to decrypt the import file.")
    seed = input("Recovery Seed: ").strip()
    if not seed:
        raise ValueError("No seed entered.")
    try:
        return RecoveryManager.seed_to_key(seed)
    except Exception:
        raise ValueError("Invalid recovery seed — must be valid base64.")


def _json_sort(obj):
    """Produce canonical JSON for seal/hash computation.

    Uses Python's default json.dumps formatting (spaces after : and ,)
    which matches the web app's _jsonDumps() format and all existing
    CLI seal computations.
    """
    return json.dumps(obj, sort_keys=True)


def _verify_seal(data_str: str, seal_hex: str, mk: bytes) -> bool:
    """Verify an HMAC-SHA256 seal against a canonical data string."""
    crypto = CryptoManager(mk)
    return crypto.seal(data_str) == seal_hex


def _verify_entry_hash(entry: dict) -> bool:
    """Verify a single entry's content hash.

    Matches the web app's ``LocalCache.append()`` hash computation:
    SHA-256 over jsonSort of the core staging DTO fields only
    (not metadata like committed, block_index, entry_index, comment).

    Delegates to ``verify_entry_hash_two_way`` which tries sort+indent2
    (canonical) then sort+compact (legacy CLI).
    """
    stored_hash = entry.get("hash")
    if not stored_hash:
        return False
    hash_data = {
        k: entry.get(k)
        for k in (
            "entry_id", "title", "duration", "is_active", "is_paused",
            "start_epoch", "end_epoch", "pauses", "tags", "media",
            "device_uuid", "metadata",
        )
    }
    return verify_entry_hash_two_way(hash_data, stored_hash)


def _verify_ledger_entry_hash(entry: dict) -> bool:
    """Verify a ledger-block entry's hash.

    Delegates to _verify_entry_hash_flex which tries all three serialization
    formats (sort+indent2, sort+compact, nosort+indent2). The hash in the
    block determines which format was used at commit time.
    """
    if "data" not in entry:
        return False
    stored_hash = entry.get("hash")
    if not stored_hash:
        return False
    return _verify_entry_hash_flex(entry["data"], stored_hash)


def _verify_entry_hash_updated(entry: dict) -> bool:
    """Verify an entry hash as computed by ``updateByEntryId()``
    (all fields minus ``hash`` and ``entry_index``).

    Delegates to ``verify_entry_hash_two_way`` which tries sort+indent2
    (canonical) then sort+compact (legacy CLI).
    """
    stored_hash = entry.get("hash")
    if not stored_hash:
        return False
    hash_data = {
        k: v for k, v in entry.items()
        if k not in ("hash", "entry_index")
    }
    return verify_entry_hash_two_way(hash_data, stored_hash)


# ── Format-specific import paths ────────────────────────────────────────────


def _import_v1(data: dict, mk: bytes) -> dict:
    """Import v1 format — staging entries only."""
    entries = data.get("entries", [])
    seal = data.get("seal", "")

    if not isinstance(entries, list):
        raise ValueError("v1 format: 'entries' must be an array")
    if not seal:
        raise ValueError("v1 format: missing 'seal'")

    entries_json = _json_sort(entries)
    if not _verify_seal(entries_json, seal, mk):
        raise ValueError(
            "Seal verification failed — wrong recovery seed or tampered file."
        )

    # Per-entry hash check is best-effort: entries created by append()
    # use core fields only, while entries modified by updateByEntryId()
    # use all fields minus hash+entry_index. The seal already covers
    # integrity, so mismatches are warnings not errors.
    mismatches = 0
    for i, entry in enumerate(entries):
        ok = _verify_entry_hash(entry) or _verify_entry_hash_updated(entry)
        if not ok:
            mismatches += 1
    if mismatches > 0:
        print(
            f"  Warning: {mismatches} entry hash(es) could not be verified "
            f"(top-level seal is valid — file integrity is intact)"
        )

    return {
        "format": "v1",
        "entries": entries,
        "ledger_blocks": None,
        "genesis_hash": None,
    }


def _import_v2(data: dict, mk: bytes) -> dict:
    """Import v2 format — full ledger export."""
    ledger_blocks = data.get("ledger", [])
    staging = data.get("staging", [])
    seal = data.get("seal", "")

    if not isinstance(ledger_blocks, list) or len(ledger_blocks) == 0:
        raise ValueError("v2 format: 'ledger' must be a non-empty array")
    if not isinstance(staging, list):
        raise ValueError("v2 format: 'staging' must be an array")
    if not seal:
        raise ValueError("v2 format: missing 'seal'")

    # Verify top-level seal over {ledger, staging}
    payload = _json_sort({"ledger": ledger_blocks, "staging": staging})
    if not _verify_seal(payload, seal, mk):
        raise ValueError(
            "Seal verification failed — wrong recovery seed or tampered file."
        )

    # Verify staging entry hashes (best-effort, same as v1)
    mismatches = 0
    for i, entry in enumerate(staging):
        ok = _verify_entry_hash(entry) or _verify_entry_hash_updated(entry)
        if not ok:
            mismatches += 1
    if mismatches > 0:
        print(
            f"  Warning: {mismatches} staging entry hash(es) could not be verified"
        )

    # Also validate the ledger block chain itself
    crypto = CryptoManager(mk)
    _validate_raw_chain(ledger_blocks, crypto, mk)

    genesis_hash = None
    if ledger_blocks[0].get("type") == "genesis":
        genesis_hash = get_block_hash(ledger_blocks[0])

    return {
        "format": "v2",
        "entries": staging,
        "ledger_blocks": ledger_blocks,
        "genesis_hash": genesis_hash,
    }


def _import_raw_chain(blocks: list, mk: bytes) -> dict:
    """Import raw chain format — CLI ledger.json."""
    if not isinstance(blocks, list) or len(blocks) == 0:
        raise ValueError("Raw chain: must be a non-empty JSON array")

    crypto = CryptoManager(mk)
    _validate_raw_chain(blocks, crypto, mk)

    genesis_hash = None
    if blocks[0].get("type") == "genesis":
        genesis_hash = get_block_hash(blocks[0])

    return {
        "format": "chain",
        "entries": [],
        "ledger_blocks": blocks,
        "genesis_hash": genesis_hash,
    }


# ── Shared chain validation ────────────────────────────────────────────────


def _validate_raw_chain(blocks: list, crypto: CryptoManager, mk: bytes):
    """Validate block seals, prev_hash linkage, and entry hashes."""
    if len(blocks) == 0:
        raise ValueError("Empty chain")

    if blocks[0].get("type") != "genesis":
        raise ValueError("Raw chain must start with a genesis block")

    for i, block in enumerate(blocks):
        block_type = block.get("type", "day")
        hash_field = BLOCK_HASH_FIELD.get(block_type)
        if not hash_field:
            raise ValueError(f"Unknown block type '{block_type}' at index {i}")

        block_hash = block.get(hash_field, "")
        if not isinstance(block_hash, str) or len(block_hash) != 64:
            raise ValueError(
                f"Missing or invalid {hash_field} at block index {i}"
            )

        # Verify per-block seal
        # I-07: format_version excluded from seal check data.
        check_data = {
            k: v
            for k, v in sorted(block.items())
            if k not in (hash_field, "identity_seal", "signature", "format_version")
        }
        check_json = _json_sort(check_data)
        if not _verify_seal(check_json, block_hash, mk):
            raise ValueError(
                f"Block seal verification failed at index {i} "
                f"({block_type}, date: {block.get('date', 'unknown')})"
            )

        # Verify chain linkage (skip genesis)
        if i > 0:
            prev = blocks[i - 1]
            prev_type = prev.get("type", "day")
            prev_hash_field = BLOCK_HASH_FIELD.get(prev_type)
            expected = prev.get(prev_hash_field, "")
            if block.get("prev_hash") != expected:
                raise ValueError(
                    f"Chain linkage broken at block index {i}"
                )

        # Verify entry hashes inside day blocks
        if block_type in ("genesis", "year_summary", "month_summary"):
            continue
        entries = block.get("entries", [])
        for j, entry in enumerate(entries):
            if not entry.get("hash") or not entry.get("data"):
                raise ValueError(
                    f"Malformed entry at block {i}, entry {j} — missing hash or data"
                )
            if not _verify_ledger_entry_hash(entry):
                raise ValueError(
                    f"Entry hash mismatch at block {i}, entry {j} "
                    f'("{entry.get("data", {}).get("title", "untitled")}")'
                )


# ── File writing helpers ───────────────────────────────────────────────────


def _write_data_files(data_dir: Path, result: dict) -> list | None:
    """Write staging, ledger, and index to the data directory.

    Returns ledger_blocks or None.
    """
    staging_path = data_dir / "staging.json"
    ledger_path = data_dir / "ledger.json"
    index_path = data_dir / "index.json"

    # Staging
    entries = result.get("entries", [])
    staging_path.write_text(json.dumps(entries, indent=2))
    print(f"  Wrote {len(entries)} staging entries to staging.json")

    # Ledger blocks (v2 + chain)
    blocks = result.get("ledger_blocks")
    if blocks and len(blocks) > 0:
        ledger_path.write_text(json.dumps(blocks, indent=2))
        print(f"  Wrote {len(blocks)} block(s) to ledger.json")

    # Empty index
    index_path.write_text(json.dumps({}, indent=2))
    print("  Wrote empty index.json")

    return blocks


def _extract_identity(
    ledger_blocks: list, mk: bytes, identity_path: Path
) -> bool:
    """Extract identity secret from genesis fallback and write identity.json."""
    if not ledger_blocks:
        return False

    genesis = ledger_blocks[0]
    if genesis.get("type") != "genesis":
        return False

    identity_data = genesis.get("identity", {})
    enc_fallback = identity_data.get("identity_secret_enc_fallback")
    if not enc_fallback:
        print("  No identity_secret_enc_fallback in genesis — skipping identity.")
        return False

    crypto = CryptoManager(mk)
    try:
        plain = crypto.decrypt(enc_fallback)
        if plain and plain.startswith("plain:"):
            plain = plain[6:]
        elif plain and plain.startswith("ENC:"):
            plain = plain[4:]

        secret_bytes = bytes.fromhex(plain)
        assert len(secret_bytes) == 32

        encrypted = crypto.encrypt(plain)
        identity_path.write_text(
            json.dumps({"identity_secret_enc": encrypted}, indent=2)
        )
        print("  Identity extracted from genesis block.")
        return True
    except Exception as exc:
        print(f"  Warning: Failed to extract identity from genesis: {exc}")
        return False


def _set_passphrase(ledger_path: Path, data_dir: Path, mk: bytes) -> bool:
    """Prompt for a new local passphrase, re-encrypt seed, re-seal chain.

    Uses per-user PBKDF2 salt derived from identity_pub_key when available.
    """
    print("\n=== Set New Passphrase ===")
    while True:
        p1 = getpass.getpass("New Passphrase: ")
        p2 = getpass.getpass("Confirm New Passphrase: ")
        if p1 == p2:
            break
        print("  Passphrases do not match. Try again.")

    from security.auth import get_pdk_salt_from_genesis
    salt = get_pdk_salt_from_genesis(ledger_path)
    pdk = hashlib.pbkdf2_hmac(
        "sha256", p1.encode(), salt, 600000, 32
    )

    ledger_data = json.loads(ledger_path.read_text())

    # Re-encrypt recovery seed with new PDK
    seed_str = base64.b64encode(mk).decode("utf-8")
    new_enc_seed = RecoveryManager.encrypt_seed(seed_str, pdk)
    ledger_data[0]["identity"]["recovery_seed_enc"] = new_enc_seed

    crypto = CryptoManager(mk)

    # Copy identity fallback from identity.json if it exists
    identity_path = data_dir / "identity.json"
    try:
        if identity_path.exists():
            enc_identity = json.loads(identity_path.read_text()).get(
                "identity_secret_enc"
            )
            if enc_identity:
                ledger_data[0]["identity"][
                    "identity_secret_enc_fallback"
                ] = enc_identity
    except (json.JSONDecodeError, OSError):
        pass

    # Get identity secret for re-signing
    store = LedgerStore(
        data_dir / "staging.json", ledger_path, data_dir / "index.json"
    )
    ledger_domain = LedgerDomain(crypto, store)
    identity_secret = ledger_domain._get_identity_secret()

    # Re-seal and re-sign genesis
    # I-17: genesis uses block_hash (not day_hash).
    # I-07: format_version excluded from seal check data.
    genesis_hash_key = "block_hash" if "block_hash" in ledger_data[0] else "day_hash"
    check_data = {
        k: v
        for k, v in ledger_data[0].items()
        if k not in (genesis_hash_key, "signature", "format_version")
    }
    ledger_data[0][genesis_hash_key] = crypto.seal(
        json.dumps(check_data, sort_keys=True)
    )
    if identity_secret:
        ledger_data[0]["identity_seal"] = crypto.mac(
            ledger_data[0][genesis_hash_key], identity_secret
        )

    # Re-chain all subsequent blocks
    for i in range(1, len(ledger_data)):
        block = ledger_data[i]
        prev = ledger_data[i - 1]

        block["prev_hash"] = get_block_hash(prev)

        hash_key = BLOCK_HASH_FIELD.get(block.get("type", "day"), "day_hash")
        # I-07: format_version excluded from seal. identity_seal also excluded.
        seal_data = {
            k: v
            for k, v in block.items()
            if k not in (hash_key, "identity_seal", "signature", "format_version")
        }
        block[hash_key] = crypto.seal(json.dumps(seal_data, sort_keys=True))

        if identity_secret and block.get("identity_seal") is not None:
            block["identity_seal"] = crypto.mac(block[hash_key], identity_secret)

    ledger_path.write_text(json.dumps(ledger_data, indent=2))
    print("  Passphrase set. Ledger re-sealed and re-signed.")
    return True


def _verify_ledger(
    ledger_path: Path, crypto: CryptoManager, identity_path: Path
) -> bool:
    """Verify ledger cryptographic integrity."""
    print("\n=== Verification ===")
    try:
        store = LedgerStore(
            ledger_path.parent / "staging.json",
            ledger_path,
            ledger_path.parent / "index.json",
        )
        ledger = LedgerDomain(crypto, store)
        ok = ledger.verify()
        if ok:
            print("  ✓ Ledger integrity verified")
        else:
            print("  ✗ Ledger verification FAILED")
        return ok
    except Exception as exc:
        print(f"  Verification error: {exc}")
        return False


# ── Public entry point ─────────────────────────────────────────────────────


def run_onboarding_file(data_dir: Path, config_manager, file_path: str) -> bool:
    """Import a ledger from a local JSON file.

    Args:
        data_dir: Path to the data directory (resolved via --dir, XDG, etc.)
        config_manager: ConfigManager instance.
        file_path: Path to the JSON file to import.

    Returns:
        True if import completed successfully.
    """
    print("=" * 60)
    print("  PH Ledger — Onboarding (File Import)")
    print("  Import ledger from local JSON file")
    print("=" * 60)

    # Check if ledger already exists
    ledger_path = data_dir / "ledger.json"
    if ledger_path.exists():
        override = (
            input("Ledger already exists on this device. Overwrite? (y/N): ")
            .strip()
            .lower()
        )
        if override != "y":
            print("Onboarding cancelled.")
            return False

    # ── Read file ──────────────────────────────────────────────────
    fpath = Path(file_path)
    if not fpath.exists():
        print(f"File not found: {fpath}")
        return False

    try:
        raw = fpath.read_text()
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        print(f"Invalid JSON file: {exc}")
        return False

    # ── Detect format ──────────────────────────────────────────────
    if isinstance(data, list):
        fmt = "chain"
        n = len(data)
        print(f"Detected raw chain format ({n} block{'s' if n != 1 else ''})")
    elif isinstance(data, dict):
        fmt = data.get("format_version", "unknown")
        if fmt == "1":
            n = len(data.get("entries", []))
            print(
                f"Detected v1 export ({n} staging {'entry' if n == 1 else 'entries'})"
            )
        elif fmt == "2":
            nb = len(data.get("ledger", []))
            ns = len(data.get("staging", []))
            print(
                f"Detected v2 export ({nb} ledger blocks, {ns} staging entries)"
            )
        else:
            print(f"Unknown format_version: '{fmt}'. Expected '1' or '2'.")
            return False
    else:
        print("Unrecognized file format — expected JSON object or array.")
        return False

    # ── Auth: prompt for recovery seed ─────────────────────────────
    try:
        mk = _prompt_seed()
    except ValueError as exc:
        print(f"Error: {exc}")
        return False

    # ── Import and validate ────────────────────────────────────────
    try:
        if fmt == "chain":
            result = _import_raw_chain(data, mk)
        elif fmt == "1":
            result = _import_v1(data, mk)
        elif fmt == "2":
            result = _import_v2(data, mk)
        else:
            print(f"Unsupported format: {fmt}")
            return False
    except ValueError as exc:
        print(f"\nImport failed: {exc}")
        return False

    print("  ✓ File validated successfully.")

    # ── Write data files ───────────────────────────────────────────
    blocks = _write_data_files(data_dir, result)

    # ── Extract identity ───────────────────────────────────────────
    identity_path = data_dir / "identity.json"
    if blocks:
        _extract_identity(blocks, mk, identity_path)

    # ── Set passphrase (v2/chain only) ─────────────────────────────
    if blocks and len(blocks) > 0:
        _set_passphrase(ledger_path, data_dir, mk)

        # Cache master key
        auth = PassphraseAuthenticator(ledger_path)
        auth._cache_key(mk)
        print("  Master key cached in session.")

        # Verify
        crypto = CryptoManager(mk)
        verify_ok = _verify_ledger(ledger_path, crypto, identity_path)
    else:
        print(
            "\n  Note: v1 import only contains staging entries."
        )
        print("  Run 'ph init' to create a new ledger with these entries.")
        verify_ok = True  # v1 has no ledger to verify

    # ── Summary ────────────────────────────────────────────────────
    print("\n" + "=" * 60)
    print("  File Import Complete!")
    print("=" * 60)
    print(f"  Format: {result['format']}")
    if blocks:
        print(f"  Ledger:  {ledger_path} ({len(blocks)} blocks)")
    staging_entries = result.get("entries", [])
    if staging_entries:
        print(f"  Staging: {len(staging_entries)} entries")
    print()

    return verify_ok
