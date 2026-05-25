"""ph onboarding — import an existing ledger to a new device via git transport.

Orchestrates pulling all data from a remote git repo, extracting identity,
verifying recovery seed, and setting a new passphrase — all in one flow.

Steps:
  1. Prompt for git remote URL → validate → store in config
  2. Prompt for recovery seed → derive master key
  3. Pull ledger blocks from remote → write ledger.json
  4. Extract identity secret from genesis → write identity.json
  5. Pull staging blob from remote → write staging.json
  6. Pull blind index from remote → write index.json
  7. Set new passphrase → re-encrypt → re-seal → re-sign (same as ph recover)
  8. Cache master key → run verify → show summary
"""

import json
import hashlib
import base64
import getpass
import logging
from pathlib import Path
from typing import Optional

from security.crypto import CryptoManager
from security.auth import RecoveryAuthenticator
from security.recovery import RecoveryManager
from domain.ledger.remote_sync import RemoteLedgerSync
from core.sync.git_transport import GitStagingTransport
from storage.file_store import LedgerStore
from core.ledger import LedgerDomain

logger = logging.getLogger(__name__)


def _prompt_git_remote_url() -> Optional[str]:
    """Prompt for and validate a git remote URL.

    Returns the URL string, or None if cancelled.
    """
    print("\n=== Step 1: Git Remote Repository ===")
    print("Enter the git remote URL where your ledger data is stored.")
    print("Example: git@github.com:username/phpoc-staging.git")
    url = input("Remote URL: ").strip()
    if not url:
        print("No URL entered. Onboarding cancelled.")
        return None
    
    # Validate: do a quick ls-remote to check connectivity
    print(f"  Validating connection to {url}...", end=" ", flush=True)
    import subprocess
    import os as _os
    try:
        env = _os.environ.copy()
        env["GIT_TERMINAL_PROMPT"] = "0"  # Fail fast, no prompts
        result = subprocess.run(
            ["git", "ls-remote", url],
            capture_output=True, text=True, timeout=30, env=env,
        )
        if result.returncode == 0:
            print("ok")
        else:
            stderr = result.stderr.strip()
            # Accept empty repos (no refs yet) — user may be importing from a fresh repo
            if "couldn't find remote ref" in stderr.lower() or "does not appear to be a git repository" in stderr.lower():
                if "does not appear" in stderr:
                    print("FAILED")
                    print(f"  Error: {stderr}")
                    retry = input("Retry with a different URL? (y/N): ").strip().lower()
                    if retry == "y":
                        return _prompt_git_remote_url()
                    return None
                print("ok (empty repo)")
            else:
                print("FAILED")
                print(f"  Error: {stderr}")
                retry = input("Retry with a different URL? (y/N): ").strip().lower()
                if retry == "y":
                    return _prompt_git_remote_url()
                return None
    except subprocess.TimeoutExpired:
        print("TIMEOUT")
        print("  Connection timed out. Check the URL and your network/SSH setup.")
        retry = input("Retry? (y/N): ").strip().lower()
        if retry == "y":
            return _prompt_git_remote_url()
        return None
    except FileNotFoundError:
        print("FAILED")
        print("  git is not installed or not in PATH.")
        return None
    
    return url


def _pull_ledger_blocks(transport, master_key, data_dir: Path) -> Optional[list]:
    """Pull all ledger blocks from remote, write ledger.json.

    Returns the list of ledger blocks, or None on failure.
    """
    print("\n=== Step 2: Pulling Ledger Data ===")
    ledger_sync = RemoteLedgerSync(
        transport=transport,
        master_key=master_key,
    )
    
    # Check what's on remote
    remote_count = ledger_sync.get_remote_block_count()
    if remote_count == 0:
        print("  No ledger blocks found on remote.")
        return None
    
    print(f"  Remote has {remote_count} block(s). Pulling...")
    
    # Pull all blocks (no local blocks yet)
    new_blocks, total = ledger_sync.pull_blocks(local_blocks=None)
    if new_blocks is None and total > 0:
        # All blocks already present (shouldn't happen on fresh device)
        print("  No new blocks to pull (already in sync).")
        return None
    if new_blocks is None:
        print("  No ledger blocks on remote.")
        return None
    
    print(f"  Pulled {len(new_blocks)} block(s).")
    return new_blocks


def _pull_staging(transport, master_key, data_dir: Path, crypto) -> Optional[dict]:
    """Pull the staging blob from remote, write staging.json.

    Returns the staging entries dict, or None on failure/absence.
    """
    print("\n=== Step 3: Pulling Staging Data ===")
    from domain.staging.remote_sync import RemoteStagingSync
    
    # Use the crypto's master_key for blob deobfuscation
    remote_sync = RemoteStagingSync(
        crypto=crypto,
        device_id_provider=None,
        transport=transport,
        master_key=master_key,
    )
    
    blob_data = remote_sync.pull(master_key=master_key)
    if blob_data is None:
        print("  No staging blob found on remote.")
        return None
    
    entries = blob_data.get("entries", [])
    print(f"  Pulled staging blob with {len(entries)} entry/entries.")
    return blob_data


def _pull_index(transport, master_key) -> Optional[dict]:
    """Pull the blind index from remote.

    Returns the index dict, or None.
    """
    print("\n=== Step 4: Pulling Index Data ===")
    ledger_sync = RemoteLedgerSync(
        transport=transport,
        master_key=master_key,
    )
    index_data = ledger_sync.pull_index()
    if index_data is None:
        print("  No index file found on remote.")
        return None
    print(f"  Pulled index with {len(index_data)} date(s).")
    return index_data


def _extract_identity_from_genesis(ledger_blocks: list, mk: bytes, identity_path: Path) -> bool:
    """Extract identity from genesis block's fallback and write identity.json.

    Returns True if identity was extracted and written.
    """
    if not ledger_blocks:
        print("  No ledger blocks available — cannot extract identity.")
        return False
    
    genesis = ledger_blocks[0]
    if genesis.get("type") != "genesis":
        print(f"  First block is type '{genesis.get('type')}', expected 'genesis'.")
        return False
    
    identity_data = genesis.get("identity", {})
    enc_fallback = identity_data.get("identity_secret_enc_fallback")
    if not enc_fallback:
        print("  No identity_secret_enc_fallback found in genesis block.")
        return False
    
    # Decrypt with master key
    crypto = CryptoManager(mk)
    try:
        identity_secret_hex = crypto.decrypt(enc_fallback)
        if identity_secret_hex is None or not identity_secret_hex.startswith("plain:"):
            # Normal decryption — strip any prefix
            if identity_secret_hex.startswith("ENC:"):
                identity_secret_hex = identity_secret_hex[4:]
        else:
            identity_secret_hex = identity_secret_hex[6:]  # strip "plain:"
        
        # Verify it's valid hex of 32 bytes
        secret_bytes = bytes.fromhex(identity_secret_hex)
        assert len(secret_bytes) == 32
        
        # Re-encrypt with same master key (consistent format)
        encrypted = crypto.encrypt(identity_secret_hex)
        
        identity_path.write_text(
            json.dumps({"identity_secret_enc": encrypted}, indent=2)
        )
        print("  Identity extracted from genesis block.")
        return True
    except Exception as exc:
        print(f"  Failed to decrypt identity from genesis: {exc}")
        return False


def _recover_ledger(ledger_path: Path, data_dir: Path, mk: bytes) -> bool:
    """Set a new passphrase and re-seal/re-sign the ledger (same as ph recover).

    Returns True on success.
    """
    print("\n=== Step 6: Setting New Passphrase ===")
    while True:
        p1 = getpass.getpass("New Passphrase: ")
        p2 = getpass.getpass("Confirm New Passphrase: ")
        if p1 == p2:
            break
        print("  Passphrases do not match. Try again.")
    
    pdk = hashlib.pbkdf2_hmac("sha256", p1.encode(), b"session-salt", 600000, 32)
    
    try:
        ledger_data = json.loads(ledger_path.read_text())
    except (FileNotFoundError, json.JSONDecodeError) as exc:
        print(f"  Failed to read ledger: {exc}")
        return False
    
    seed_str = base64.b64encode(mk).decode("utf-8")
    new_enc_seed = RecoveryManager.encrypt_seed(seed_str, pdk)
    
    ledger_data[0]["identity"]["recovery_seed_enc"] = new_enc_seed
    
    crypto = CryptoManager(mk)
    
    # Copy identity fallback from identity.json if it exists
    identity_path = data_dir / "identity.json"
    try:
        if identity_path.exists():
            enc_identity = json.loads(identity_path.read_text()).get("identity_secret_enc")
            if enc_identity:
                ledger_data[0]["identity"]["identity_secret_enc_fallback"] = enc_identity
    except (json.JSONDecodeError, OSError):
        pass
    
    # Get identity secret (from identity.json or genesis fallback)
    store = LedgerStore(data_dir / "staging.json", ledger_path, data_dir / "index.json")
    ledger_domain = LedgerDomain(crypto, store)
    identity_secret = ledger_domain._get_identity_secret()
    
    # Re-seal and re-sign genesis
    check_data = {
        k: v for k, v in ledger_data[0].items()
        if k not in ["day_hash", "signature"]
    }
    ledger_data[0]["day_hash"] = crypto.seal(json.dumps(check_data, sort_keys=True))
    
    if identity_secret:
        ledger_data[0]["signature"] = crypto.sign(
            ledger_data[0]["day_hash"], identity_secret
        )
    
    # Re-chain all subsequent blocks
    for i in range(1, len(ledger_data)):
        block = ledger_data[i]
        prev = ledger_data[i - 1]
        
        block["prev_hash"] = (
            prev.get("day_hash")
            or prev.get("month_hash")
            or prev.get("year_hash")
        )
        
        hash_key = (
            "day_hash" if block.get("type", "day") == "day" else
            "month_hash" if block.get("type") == "month_summary" else
            "year_hash"
        )
        
        seal_data = {
            k: v for k, v in block.items()
            if k not in [hash_key, "signature"]
        }
        block[hash_key] = crypto.seal(json.dumps(seal_data, sort_keys=True))
        
        if identity_secret and block.get("signature") is not None:
            block["signature"] = crypto.sign(block[hash_key], identity_secret)
    
    ledger_path.write_text(json.dumps(ledger_data, indent=2))
    print("  Passphrase set. Ledger re-sealed and re-signed.")
    return True


def _verify_ledger(ledger_path: Path, crypto: CryptoManager, identity_path: Path) -> bool:
    """Verify the ledger's cryptographic integrity."""
    print("\n=== Step 8: Verification ===")
    try:
        store = LedgerStore(
            ledger_path.parent / "staging.json",
            ledger_path,
            ledger_path.parent / "index.json",
        )
        ledger = LedgerDomain(crypto, store)
        
        result = ledger.verify()
        if result:
            print("  ✓ Ledger integrity verified")
        else:
            print("  ✗ Ledger verification FAILED")
        return result
    except Exception as exc:
        import traceback
        print(f"  Verification error: {exc}")
        print(traceback.format_exc())
        return False


def _setup_staging_remote(remote_url: str, data_dir: Path, config_manager) -> None:
    """Configure the remote staging URL in the config."""
    config_manager.set("remote.git_remote_url", remote_url)
    print(f"  Remote URL saved to config.")


def _write_staging_json(blob_data: dict, staging_path: Path) -> bool:
    """Write staging entries from blob data to the staging.json file."""
    if blob_data is None:
        staging_path.write_text(json.dumps([]))
        return True
    
    entries = blob_data.get("entries", [])
    staging_path.write_text(json.dumps(entries, indent=2))
    print(f"  Wrote {len(entries)} staging entries.")
    return True


def run_onboarding(data_dir: Path, config_manager) -> bool:
    """Run the full onboarding flow.

    Args:
        data_dir: Path to the data directory (resolved via --dir, XDG, etc.)
        config_manager: ConfigManager instance for reading/writing config.

    Returns:
        True if onboarding completed successfully.
    """
    print("=" * 60)
    print("  PH Ledger — Onboarding")
    print("  Import existing ledger to this device")
    print("=" * 60)
    
    # Check if ledger already exists
    ledger_path = data_dir / "ledger.json"
    if ledger_path.exists():
        override = input("Ledger already exists on this device. Overwrite? (y/N): ").strip().lower()
        if override != "y":
            print("Onboarding cancelled.")
            return False
    
    # ── Step 1: Git Remote URL ──────────────────────────────────────
    url = _prompt_git_remote_url()
    if url is None:
        return False
    
    clone_path = str(data_dir / "remote")
    transport = GitStagingTransport(url, clone_path)
    
    # ── Step 2: Recovery Seed ────────────────────────────────────────
    print("\n=== Step 5: Recovery Seed ===")
    print("Enter your recovery seed to decrypt the ledger.")
    print("(This was shown when you ran 'ph init' on your original device.)")
    rec_auth = RecoveryAuthenticator()
    if not rec_auth.authenticate():
        print("  No seed entered. Onboarding cancelled.")
        return False
    
    mk = rec_auth.get_key()
    assert mk is not None
    
    # Now we have the master key — pull and decrypt all data
    # ── Step 2 (now): Pull ledger blocks ─────────────────────────────
    ledger_blocks = _pull_ledger_blocks(transport, mk, data_dir)
    if ledger_blocks is None:
        print("  No ledger blocks found on remote. Cannot proceed.")
        return False
    
    # Write ledger.json immediately so verify can use it
    ledger_path.write_text(json.dumps(ledger_blocks, indent=2))
    print(f"  Wrote {len(ledger_blocks)} block(s) to ledger.json.")
    
    # ── Step 4: Extract identity from genesis ────────────────────────
    identity_path = data_dir / "identity.json"
    identity_ok = _extract_identity_from_genesis(ledger_blocks, mk, identity_path)
    if not identity_ok:
        print("  Could not extract identity from ledger. Proceeding without signing key.")
    
    # ── Step 5: Pull staging ────────────────────────────────────────
    crypto = CryptoManager(mk)
    staging_data = _pull_staging(transport, mk, data_dir, crypto)
    staging_path = data_dir / "staging.json"
    _write_staging_json(staging_data, staging_path)
    
    # ── Step 6: Pull index ──────────────────────────────────────────
    index_data = _pull_index(transport, mk)
    index_path = data_dir / "index.json"
    if index_data is not None:
        index_path.write_text(json.dumps(index_data, indent=2))
        print(f"  Wrote index with {len(index_data)} date(s) to index.json.")
    else:
        # Write empty index
        index_path.write_text(json.dumps({}, indent=2))
        print("  Wrote empty index.json.")
    
    # ── Save remote URL to config ────────────────────────────────────
    _setup_staging_remote(url, data_dir, config_manager)
    
    # ── Step 6: Set new passphrase ───────────────────────────────────
    recover_ok = _recover_ledger(ledger_path, data_dir, mk)
    if not recover_ok:
        print("  Failed to set new passphrase. Data files are intact but unsealed.")
        return False
    
    # ── Cache master key ─────────────────────────────────────────────
    from security.auth import PassphraseAuthenticator
    auth = PassphraseAuthenticator(ledger_path)
    auth._cache_key(mk)
    print("  Master key cached in session.")
    
    # ── Step 8: Verify ───────────────────────────────────────────────
    verify_ok = _verify_ledger(ledger_path, crypto, identity_path)
    
    # ── Summary ──────────────────────────────────────────────────────
    print("\n" + "=" * 60)
    print("  Onboarding Complete!")
    print("=" * 60)
    print(f"  Ledger:   {ledger_path} ({len(ledger_blocks)} blocks)")
    
    if staging_data:
        n_active = sum(1 for e in staging_data.get("entries", []) if e.get("data", {}).get("is_active"))
        n_staged = len(staging_data.get("entries", []))
        print(f"  Staging:  {staging_path} ({n_staged} entries, {n_active} active)")
    else:
        print(f"  Staging:  (no remote staging data)")
    
    print(f"  Identity: {identity_path} {'✓' if identity_ok else '✗ not extracted'}")
    
    from security.device_identity import RandomUUIDDeviceIdentityProvider
    provider = RandomUUIDDeviceIdentityProvider(config_manager)
    device_id = provider.get_device_identity(mk)
    print(f"  Device:   {device_id.device_label or device_id.device_id}")
    
    print(f"  Verify:   {'✓ Passed' if verify_ok else '✗ Failed'}")
    print()
    print("  You can now use all ph commands:")
    print("    ph view        — view active tasks")
    print("    ph add start   — start a new task")
    print("    ph add end     — end a task")
    print("    ph list all 7  — view recent entries")
    print("    ph rep         — reputation summary")
    print()
    
    return verify_ok
