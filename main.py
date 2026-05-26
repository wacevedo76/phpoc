import argparse
import getpass
import time
import json
import hashlib
import base64
import os
from pathlib import Path
from security.crypto import CryptoManager, NoAuthCryptoManager
from security.auth import PassphraseAuthenticator, RecoveryAuthenticator
from security.recovery import RecoveryManager
from security.config_manager import ConfigManager
from storage.implementations.file_config import FileConfigStore, _resolve_config_path, _resolve_data_dir
from storage.file_store import LedgerStore
from core.ledger import LedgerDomain
from core.factory import LedgerFactory
from cli.interface import CLIInterface
from cli.trace import trace
from domain.staging.service import StagingService
from domain.ledger.engine import LedgerEngine
from core.sync import SyncOrchestrator
from core.sync.transport import create_transport_from_config
from storage.implementations.file_staging import FileStagingStore
from security.device_identity import RandomUUIDDeviceIdentityProvider

# Config file resolution
CONFIG_PATH = _resolve_config_path()
CONFIG_STORE = FileConfigStore(CONFIG_PATH)
CONFIG = ConfigManager(CONFIG_STORE)

# Data directory resolution (separate from config directory per XDG spec)
# Priority: --dir CLI flag > PHPOC_DATA_DIR env > config storage.data_dir > XDG default > legacy
CONFIG_DIR = _resolve_data_dir(config_manager=CONFIG)

# Migrate from old directory if it exists and new one doesn't
_LEGACY_DIR = Path.home() / ".config" / "personal_history_poc"
if _LEGACY_DIR.exists() and not CONFIG_DIR.exists():
    # Use legacy directory as-is (user might move later)
    CONFIG_DIR = _LEGACY_DIR

LEDGER_PATH = CONFIG_DIR / "ledger.json"
INDEX_PATH = CONFIG_DIR / "index.json"
STAGING_PATH = CONFIG_DIR / "staging.json"
IDENTITY_PATH = CONFIG_DIR / "identity.json"

def _resolve_data_paths(data_dir: Path):
    """Resolve all data file paths from a data directory.

    Returns (ledger_path, index_path, staging_path, identity_path).
    This helper is used when --dir overrides the module-level CONFIG_DIR.
    """
    return (
        data_dir / "ledger.json",
        data_dir / "index.json",
        data_dir / "staging.json",
        data_dir / "identity.json",
    )


def main():
    parser = argparse.ArgumentParser(description="PHPOC Ledger")
    parser.add_argument("--config", type=str, help="Path to config file (default: XDG ~/.config/phpoc/config.json)")
    parser.add_argument("--dir", type=str, dest="data_dir",
                        help="Data directory for ledger.json, identity.json, etc. "
                             "(default: XDG ~/.local/share/phpoc/)")
    subparsers = parser.add_subparsers(dest="command")

    # Config command
    config_p = subparsers.add_parser("config", help="View or modify configuration")
    config_sub = config_p.add_subparsers(dest="config_action")
    config_show = config_sub.add_parser("show", help="Show all config values")
    config_get = config_sub.add_parser("get", help="Get a config value by dot path")
    config_get.add_argument("key", help="Config key path (e.g. auth.cache_timeout_minutes)")
    config_set = config_sub.add_parser("set", help="Set a config value")
    config_set.add_argument("key", help="Config key path (e.g. auth.cache_timeout_minutes)")
    config_set.add_argument("value", help="New value (JSON-parseable, or plain string)")
    config_init = config_sub.add_parser("init", help="Generate a commented config template at the config path")

    # Add command
    add_parser = subparsers.add_parser("add", help="Add a new habit")
    add_sub = add_parser.add_subparsers(dest="subcommand")
    oneoff_p = add_sub.add_parser("oneoff", help="Capture a completed task")
    oneoff_p.add_argument("title", nargs="?", help="Task title (optional, will prompt if omitted)")
    oneoff_p.add_argument("--tag", dest="tags", action="append", default=[], help="Add a tag (e.g. --tag music --tag learning)")
    oneoff_p.add_argument("--comment", "-m", dest="comment", help="Add a comment / note")
    start_p = add_sub.add_parser("start", help="Start a task")
    start_p.add_argument("title")
    start_p.add_argument("--tag", dest="tags", action="append", default=[], help="Add a tag (e.g. --tag music --tag learning)")
    start_p.add_argument("--comment", "-m", dest="comment", help="Add a comment / note")
    end_p = add_sub.add_parser("end", help="End a task")
    end_p.add_argument("title")
    end_p.add_argument("--comment", "-m", dest="comment", help="Add a comment / note")
    pause_p = add_sub.add_parser("pause", help="Pause a task")
    pause_p.add_argument("title")
    unpause_p = add_sub.add_parser("unpause", help="Resume a paused task")
    unpause_p.add_argument("title")

    # Init command
    subparsers.add_parser("init", help="Initialize a new ledger")

    # Recover command
    subparsers.add_parser("recover", help="Recover access using seed and set new passphrase")

    # Onboarding command (import existing ledger to a new device)
    subparsers.add_parser("onboarding", help="Import existing ledger to this device via git remote")

    # Login / Logout commands
    subparsers.add_parser("login", help="Authenticate and cache session (re-prompts for passphrase)")
    subparsers.add_parser("logout", help="Clear cached session (forces re-auth on next command)")

    # View command
    view_parser = subparsers.add_parser("view", help="View active tasks (alias: ph list active)")
    view_parser.add_argument("--show-tags", action="store_true", help="Show tags inline with tasks")
    view_parser.add_argument("--show-comments", "-c", action="store_true", help="Show comments inline with tasks")

    # Tags command
    subparsers.add_parser("tags", help="List all unique tags ever used")

    # Sync command
    sync_parser = subparsers.add_parser("sync", help="Sync staged habits to the ledger, or sync staging with remote")
    sync_subparsers = sync_parser.add_subparsers(dest="sync_action")
    sync_parser.add_argument("--yes", action="store_true", help="Skip confirmation prompt")
    sync_parser.add_argument("--till", help="Only sync entries up to and including this date (MM-DD or YYYY-MM-DD)")
    sync_remote_p = sync_subparsers.add_parser("remote_staging", help="Sync local staging with remote blob (pull, merge, push) — no ledger commit")
    sync_ledger_p = sync_subparsers.add_parser("remote_ledger", help="Sync ledger blocks with remote (push/pull append-only chain)")
    # Verify command
    subparsers.add_parser("verify", help="Verify ledger integrity")

    # Rep/List commands...
    rep_parser = subparsers.add_parser("rep", help="Show reputation summary")
    rep_parser.add_argument("days", type=int, nargs="?", help="Limit to last N days")
    rep_parser.add_argument("--date", help="Specific date (YYYY-MM-DD)")
    rep_parser.add_argument("--week", help="ISO week (YYYY-Www) or date within week (YYYY-MM-DD)")
    rep_parser.add_argument("--month", help="Month (YYYY-MM or MM)")
    rep_parser.add_argument("--year", help="Year (YYYY)")
    rep_parser.add_argument("--from", dest="from_date", help="Start date (YYYY-MM-DD, YYYY-MM, YYYY, MM/YY, or MM)")
    rep_parser.add_argument("--to", dest="to_date", help="End date (YYYY-MM-DD, YYYY-MM, YYYY, MM/YY, or MM)")

    # List command with subcommands for source
    list_parser = subparsers.add_parser("list", help="List detailed habits")
    list_subparsers = list_parser.add_subparsers(dest="source", required=True)

    # Helper to add common date filter args and --show-comments to a subparser
    def _add_date_args(p, add_show_comments=False, add_show_tags=False):
        p.add_argument("days", type=int, nargs="?", help="Limit to last N days")
        if add_show_comments:
            p.add_argument("--show-comments", "-c", action="store_true", help="Show comments inline with entries")
        if add_show_tags:
            p.add_argument("--show-tags", action="store_true", help="Show tags inline with entries")
        p.add_argument("--date", help="Specific date (YYYY-MM-DD)")
        p.add_argument("--week", help="ISO week (YYYY-Www) or date within week (YYYY-MM-DD)")
        p.add_argument("--month", help="Month (YYYY-MM or MM)")
        p.add_argument("--year", help="Year (YYYY)")
        p.add_argument("--from", dest="from_date", help="Start date (YYYY-MM-DD, YYYY-MM, YYYY, MM/YY, or MM)")
        p.add_argument("--to", dest="to_date", help="End date (YYYY-MM-DD, YYYY-MM, YYYY, MM/YY, or MM)")

    # List all activities (synced + staged)
    list_all_p = list_subparsers.add_parser("all", help="List all activities (synced and staged)")
    _add_date_args(list_all_p, add_show_comments=True, add_show_tags=True)

    # List only synced activities
    list_synced_p = list_subparsers.add_parser("synced", help="List only synced activities")
    _add_date_args(list_synced_p, add_show_comments=True, add_show_tags=True)

    # List only staged activities
    list_staged_p = list_subparsers.add_parser("staged", help="List only staged activities")
    _add_date_args(list_staged_p, add_show_comments=True, add_show_tags=True)

    # List only active (running) tasks — same as ph view
    list_active_p = list_subparsers.add_parser("active", help="List active (running) tasks")
    list_active_p.add_argument("--show-tags", action="store_true", help="Show tags inline with tasks")
    list_active_p.add_argument("--show-comments", "-c", action="store_true", help="Show comments inline with tasks")

    # Modify command
    modify_p = subparsers.add_parser("modify", help="Modify a staged entry's end time and pauses")
    modify_p.add_argument("index", type=int, nargs="?", help="Staging index to modify (optional, will list if omitted)")

    # Remove command
    remove_p = subparsers.add_parser("remove", help="Remove a staged entry from staging")
    remove_p.add_argument("index", type=int, nargs="?", help="Staging index to remove (optional, will list if omitted)")
    remove_p.add_argument("--yes", action="store_true", help="Skip confirmation prompt")

    # Review command
    review_p = subparsers.add_parser("review", help="Preview staged entries as they'd appear after sync")

    # Revert command
    revert_p = subparsers.add_parser("revert", help="Undo the last N synced day blocks")
    revert_p.add_argument("count", type=int, nargs="?",
                          help="Number of day blocks to revert (not individual entries)")
    revert_p.add_argument("--list", action="store_true",
                          help="Show ledger summary with recent day blocks")

    # Hidden internal subcommand (no help text — spawned by Phase A background process)
    bg_p = subparsers.add_parser("_background_sync_check", add_help=False)
    bg_p.add_argument("--dir", type=str, dest="data_dir",
                       help=argparse.SUPPRESS)

    # Hidden internal subcommand (no help text — spawned by Phase B background push)
    bg_push_p = subparsers.add_parser("_background_push", add_help=False)
    bg_push_p.add_argument("--dir", type=str, dest="data_dir",
                            help=argparse.SUPPRESS)

    # Daemon subcommand (Phase C — persistent background sync)
    daemon_p = subparsers.add_parser("daemon", help="Start/stop/status of the background sync daemon")
    daemon_sub = daemon_p.add_subparsers(dest="daemon_action")
    daemon_sub.add_parser("start", help="Start the daemon in the background")
    daemon_sub.add_parser("stop", help="Stop the daemon gracefully")
    daemon_sub.add_parser("status", help="Show daemon running state and last sync info")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        exit(1)

    # Handle --config flag override (before data dir resolution)
    if args.config:
        from storage.implementations.file_config import FileConfigStore
        global CONFIG, CONFIG_STORE, CONFIG_PATH
        CONFIG_PATH = Path(args.config)
        CONFIG_STORE = FileConfigStore(CONFIG_PATH)
        CONFIG = ConfigManager(CONFIG_STORE)

    # Handle --dir flag override (update paths before any command uses them)
    overridden_data_dir = Path(args.data_dir) if args.data_dir else None
    if overridden_data_dir is not None:
        global CONFIG_DIR, LEDGER_PATH, INDEX_PATH, STAGING_PATH, IDENTITY_PATH
        CONFIG_DIR = _resolve_data_dir(overridden_dir=overridden_data_dir,
                                        config_manager=CONFIG)
        LEDGER_PATH, INDEX_PATH, STAGING_PATH, IDENTITY_PATH = _resolve_data_paths(CONFIG_DIR)

    # Activate trace logging if config debug.trace_enabled is true
    if CONFIG.get("debug.trace_enabled"):
        from cli.trace import enable_tracing
        enable_tracing()

    # Handle 'config' subcommand before auth (no auth needed)
    if args.command == "config":
        _handle_config_command(args, CONFIG)
        return

    auth = PassphraseAuthenticator(LEDGER_PATH)
    
    if args.command == "init":
        username = input("Username: ")
        email = input("Email: ")
        
        while True:
            p1 = getpass.getpass("Set Passphrase: ")
            p2 = getpass.getpass("Confirm Passphrase: ")
            if p1 == p2:
                break
            print("Passphrases do not match. Try again.")
        
        # PDK for initialization
        pdk = hashlib.pbkdf2_hmac('sha256', p1.encode(), b"session-salt", 600000, 32)
        
        # Initialize config file with defaults if not yet created
        CONFIG.write(CONFIG.read())

        seed = LedgerFactory.initialize(LEDGER_PATH, pdk, username, email)
        if seed:
            print(f"Ledger initialized.")
            print(f"!!! IMPORTANT: Save this recovery seed in a secure place !!!")
            print(f"RECOVERY SEED: {seed}")
            print(f"!!! You will NOT be able to recover your data without this seed if you lose your password !!!")
            
            # Cache the newly created sovereign key for this session
            mk = RecoveryManager.seed_to_key(seed)
            auth._cache_key(mk)
        else:
            print("Ledger already exists.")
        return

    if args.command == "onboarding":
        from cli.onboarding import run_onboarding
        from core.sync.transport import create_transport_from_config
        config_with_dir = dict(CONFIG)
        config_with_dir["_config_dir"] = str(CONFIG_DIR)
        onboarding_transport = create_transport_from_config(config_with_dir)
        ok = run_onboarding(
            data_dir=CONFIG_DIR,
            config_manager=CONFIG,
            transport=onboarding_transport,
        )
        return

    if args.command == "recover":
        rec_auth = RecoveryAuthenticator()
        if not rec_auth.authenticate():
            print("Recovery failed.")
            return
            
        mk = rec_auth.get_key()
        # Seed is valid, now set new passphrase
        print("Seed Verified. Set your new passphrase.")
        while True:
            p1 = getpass.getpass("New Passphrase: ")
            p2 = getpass.getpass("Confirm New Passphrase: ")
            if p1 == p2:
                break
            print("Passphrases do not match.")
        
        # 1. Update Identity block in Ledger
        pdk = hashlib.pbkdf2_hmac('sha256', p1.encode(), b"session-salt", 600000, 32)
        
        ledger_data = json.loads(LEDGER_PATH.read_text())
        seed_str = base64.b64encode(mk).decode('utf-8')
        new_enc_seed = RecoveryManager.encrypt_seed(seed_str, pdk)
        
        ledger_data[0]["identity"]["recovery_seed_enc"] = new_enc_seed
        
        # 2. Re-encrypt identity secret with same MK and embed as fallback
        crypto = CryptoManager(mk)
        if "identity_secret_enc" in json.loads(LEDGER_PATH.parent.joinpath("identity.json").read_text()):
            enc_identity = json.loads(LEDGER_PATH.parent.joinpath("identity.json").read_text())["identity_secret_enc"]
            ledger_data[0]["identity"]["identity_secret_enc_fallback"] = enc_identity

        # 3. Re-seal and re-sign the genesis (using MK)
        # NOTE: verify() excludes "signature" from check_data when verifying the seal,
        # so we must do the same here to be consistent.
        check_data = {k: v for k, v in ledger_data[0].items() if k not in ["day_hash", "signature"]}
        ledger_data[0]["day_hash"] = crypto.seal(json.dumps(check_data, sort_keys=True))

        # Get identity secret for re-signing
        store = LedgerStore(LEDGER_PATH.parent / "staging.json", LEDGER_PATH, INDEX_PATH)
        ledger_domain = LedgerDomain(crypto, store)
        identity_secret = ledger_domain._get_identity_secret()
        if identity_secret:
            ledger_data[0]["signature"] = crypto.sign(ledger_data[0]["day_hash"], identity_secret)

        # 4. Re-chain all subsequent blocks: update prev_hash, re-seal, re-sign
        for i in range(1, len(ledger_data)):
            block = ledger_data[i]
            prev = ledger_data[i-1]

            # Update prev_hash to point to the preceding block's current hash
            block["prev_hash"] = prev.get("day_hash") or prev.get("month_hash") or prev.get("year_hash")

            # Determine which hash key this block uses
            hash_key = (
                "day_hash" if block.get("type", "day") == "day" else
                "month_hash" if block.get("type") == "month_summary" else
                "year_hash"
            )

            # Re-seal (exclude hash_key and signature, matching verify())
            seal_data = {k: v for k, v in block.items() if k not in [hash_key, "signature"]}
            block[hash_key] = crypto.seal(json.dumps(seal_data, sort_keys=True))

            # Re-sign if identity is available
            if identity_secret and block.get("signature") is not None:
                block["signature"] = crypto.sign(block[hash_key], identity_secret)

        LEDGER_PATH.write_text(json.dumps(ledger_data, indent=2))
        # Cache the recovered master key so subsequent commands can decrypt entries
        auth._cache_key(mk)
        print("Passphrase reset successful. You can now use your new passphrase.")
        return

    if args.command == "logout":
        auth.clear_session()
        print("\u2713 Session cleared. You will be prompted for your passphrase on the next command.")
        return

    if args.command == "login":
        if auth.login():
            print("\u2713 Authentication successful. Session cached.")
        else:
            print("Authentication failed.")
            exit(1)
        return

    # --- Hidden internal command (background sync check, spawned by Phase A) ---
    if args.command == "_background_sync_check":
        from cli.background import handle_background_sync_check
        data_dir_str = str(CONFIG_DIR)
        if args.data_dir:
            data_dir_str = args.data_dir
        handle_background_sync_check(data_dir_str)
        return

    # --- Hidden internal command (background push, spawned by Phase B) ---
    if args.command == "_background_push":
        from cli.wal import _background_push
        data_dir_str = str(CONFIG_DIR)
        if args.data_dir:
            data_dir_str = args.data_dir
        _background_push(data_dir_str)
        return

    # --- Daemon subcommand (Phase C) ---
    if args.command == "daemon":
        from cli.daemon import PhDaemon
        daemon = PhDaemon(CONFIG_DIR)
        if args.daemon_action == "start":
            daemon.start()
        elif args.daemon_action == "stop":
            daemon.stop()
        elif args.daemon_action == "status":
            daemon.status()
        else:
            print("Usage: ph daemon <start|stop|status>")
        return

    # --- Lazy Authentication Logic ---
    
    # List of commands that REQUIRE a valid passphrase
    # (Reading the ledger, verifying history, or performing a sync)
    require_auth = ["sync", "verify", "rep", "list", "view", "tags", "modify", "review", "add"]
    
    crypto = None
    if args.command in require_auth:
        if not auth.authenticate():
            print("Passphrase required for this operation.")
            exit(1)
        crypto = CryptoManager(auth.get_key())
    else:
        # Check if we happen to have a session already
        cached_key = auth.get_key()
        if cached_key:
            crypto = CryptoManager(cached_key)
        else:
            # Add/Start/End commands can use NoAuth mode (Stage in plain-text)
            crypto = NoAuthCryptoManager()

    store = LedgerStore(CONFIG_DIR / "staging.json", LEDGER_PATH, INDEX_PATH)
    ledger = LedgerDomain(crypto, store)

    # Remote transport setup (from config)
    config_with_dir = dict(CONFIG)
    config_with_dir["_config_dir"] = str(CONFIG_DIR)
    transport = create_transport_from_config(config_with_dir)
    device_id_provider = None
    if transport is not None:
        device_id_provider = RandomUUIDDeviceIdentityProvider(CONFIG)

    # New layered components
    staging_store = FileStagingStore(CONFIG_DIR / "staging.json")
    staging_service = StagingService(
        crypto=crypto,
        staging_store=staging_store,
        transport=transport,
        device_id_provider=device_id_provider,
        cookie_ttl_minutes=CONFIG.get("cookie.ttl_minutes", 30),
        data_dir=str(CONFIG_DIR),
    )
    ledger_engine = LedgerEngine(
        crypto=crypto,
        store=store,
        index_store=store,
        staging_store=staging_store,
        identity_secret=None,
    )
    cli = CLIInterface(staging_service, ledger_engine, crypto)

    # Phase B: Replay any pending WAL (crash-safe deferred push) before commands
    if remote_url and CONFIG_DIR:
        from cli.wal import _replay_wal
        _replay_wal(CONFIG_DIR, staging_service)
    sync_orchestrator = SyncOrchestrator(
        staging_service=staging_service,
        ledger_engine=ledger_engine,
        view_interface=cli._view if hasattr(cli, '_view') else None,
        master_key=auth.get_key() if hasattr(auth, 'get_key') else None,
    )
    
    if args.command == "add":
        if args.subcommand == "oneoff":
            title = args.title
            if not title:
                title = input("Title: ")
            tags = CLIInterface._normalize_tag_args(args.tags) if hasattr(args, 'tags') and args.tags else None
            if tags is None and not args.tags:
                # Prompt for tags if --tag not provided
                tag_input = input("Tags (comma-separated, or leave blank): ").strip()
                if tag_input:
                    raw_tags = [t.strip() for t in tag_input.split(",")]
                    tags = CLIInterface._normalize_tag_args(raw_tags)
            comment = args.comment if hasattr(args, 'comment') and args.comment else None
            cli.add_oneoff(title, int(time.time()*1000)-1000, int(time.time()*1000), tags=tags, comment=comment)
        elif args.subcommand == "start":
            tags = CLIInterface._normalize_tag_args(args.tags) if hasattr(args, 'tags') and args.tags else None
            comment = args.comment if hasattr(args, 'comment') and args.comment else None
            cli.add_start(args.title, tags=tags, comment=comment)
        elif args.subcommand == "end":
            comment = args.comment if hasattr(args, 'comment') and args.comment else None
            cli.add_end(args.title, comment=comment)
        elif args.subcommand == "pause":
            cli.add_pause(args.title)
        elif args.subcommand == "unpause":
            cli.add_unpause(args.title)
    elif args.command == "view":
        show_tags = args.show_tags if hasattr(args, 'show_tags') else False
        show_comments = args.show_comments if hasattr(args, 'show_comments') else False
        cli.view_active(show_tags=show_tags, show_comments=show_comments)
    elif args.command == "tags":
        _list_tags(ledger, cli)
    elif args.command == "sync":
        if getattr(args, 'sync_action', None) == "remote_staging":
            staging_service.check_and_sync(timeout_ms=500)
            staging_service.push_to_remote(master_key=auth.get_key())
            print("\u2713 Remote staging synced")
        elif getattr(args, 'sync_action', None) == "remote_ledger":
            from domain.ledger.remote_sync import RemoteLedgerSync

            if transport is None or device_id_provider is None:
                print("Remote not configured. Set remote.git_remote_url in config.")
                exit(1)

            # 1. Force re-auth before any remote operation
            print("Authenticating for remote ledger sync...")
            auth.clear_session()
            if not auth.authenticate():
                print("Authentication required for remote ledger sync.")
                exit(1)
            crypto = CryptoManager(auth.get_key())

            # Refresh ledger components with new crypto
            store = LedgerStore(CONFIG_DIR / "staging.json", LEDGER_PATH, INDEX_PATH)
            ledger = LedgerDomain(crypto, store)
            staging_store = FileStagingStore(CONFIG_DIR / "staging.json")
            staging_service = StagingService(
                crypto=crypto,
                staging_store=staging_store,
                transport=transport,
                device_id_provider=device_id_provider,
                cookie_ttl_minutes=CONFIG.get("cookie.ttl_minutes", 30),
                data_dir=str(CONFIG_DIR),
            )
            ledger_engine = LedgerEngine(
                crypto=crypto,
                store=store,
                index_store=store,
                staging_store=staging_store,
                identity_secret=None,
            )

            ledger_sync = RemoteLedgerSync(
                transport=transport,
                master_key=auth.get_key(),
            )

            # 2. Show sync summary
            ledger_data = ledger.get_ledger_data()
            local_count = len(ledger_data)
            remote_count = ledger_sync.get_remote_block_count()

            day_blocks_local = sum(1 for b in ledger_data if b.get("type", "day") == "day")
            print(f"\nLocal ledger:  {local_count} blocks ({day_blocks_local} day blocks)")
            print(f"Remote ledger: {remote_count} blocks")

            if remote_count > local_count:
                pull_count = remote_count - local_count
                print(f"  -> Will pull {pull_count} block(s) from remote")
            elif local_count > remote_count:
                push_count = local_count - remote_count
                # Show dates of blocks that will be pushed
                push_blocks = ledger_data[remote_count:]
                for b in push_blocks:
                    date_str = b.get("date", "?")
                    btype = b.get("type", "day")
                    n_entries = len(b.get("entries", []))
                    print(f"  -> Will push block #{remote_count + push_blocks.index(b) + 1}: "
                          f"{date_str} ({btype}, {n_entries} entr{'y' if n_entries == 1 else 'ies'})")
            else:
                print("  -> Already in sync (no changes)")
                return

            # 3. Confirm
            confirm = input("\nProceed with remote ledger sync? (y/N): ").strip().lower()
            if confirm != "y":
                print("Cancelled.")
                return

            # 4. Execute pull/push
            new_blocks, _ = ledger_sync.pull_blocks(ledger_data)
            if new_blocks:
                ledger_engine.chain.append_blocks(new_blocks)
                print(f"\u2713 Pulled {len(new_blocks)} block(s) from remote")

            ledger_data = ledger.get_ledger_data()
            pushed = ledger_sync.push_blocks(ledger_data)
            if pushed:
                print(f"\u2713 Pushed {pushed} block(s) to remote")

            # Sync the index
            try:
                index_data = json.loads(INDEX_PATH.read_text())
                ledger_sync.push_index(index_data)
                print("\u2713 Index synced to remote")
            except (FileNotFoundError, json.JSONDecodeError) as exc:
                print(f"\u26A0 Index not synced: {exc}")

            print("\u2713 Remote ledger sync complete")
        else:
            till_date = _resolve_till_date(args.till) if args.till else None
            sync_orchestrator.sync(till_date=till_date)
    elif args.command == "verify":
        result = ledger.verify()
        print(result)
    elif args.command == "rep":
        from_str, to_str = CLIInterface._resolve_date_filters(
            days=args.days,
            date=getattr(args, 'date', None),
            week=getattr(args, 'week', None),
            month=getattr(args, 'month', None),
            year=getattr(args, 'year', None),
            from_date=args.from_date,
            to_date=args.to_date,
        )
        cli.show_rep(args.days, from_date=from_str, to_date=to_str)
    elif args.command == "list":
        if args.source == "active":
            show_tags = args.show_tags if hasattr(args, 'show_tags') else False
            show_comments = args.show_comments if hasattr(args, 'show_comments') else False
            cli.view_active(show_tags=show_tags, show_comments=show_comments)
        else:
            show_comments = args.show_comments if hasattr(args, 'show_comments') else False
            from_str, to_str = CLIInterface._resolve_date_filters(
                days=args.days,
                date=getattr(args, 'date', None),
                week=getattr(args, 'week', None),
                month=getattr(args, 'month', None),
                year=getattr(args, 'year', None),
                from_date=args.from_date,
                to_date=args.to_date,
            )
            show_tags = args.show_tags if hasattr(args, 'show_tags') else False
            cli.list_habits(args.source, args.days, from_date=from_str, to_date=to_str,
                            show_comments=show_comments, show_tags=show_tags)
    elif args.command == "modify":
        _handle_modify(ledger, args.index)
    elif args.command == "remove":
        _handle_remove(ledger, args.index, args.yes)
    elif args.command == "review":
        _handle_review(ledger, cli)
    elif args.command == "revert":
        if args.list:
            print("\n=== Ledger Summary ===")
            ledger_data = ledger.get_ledger_data()
            day_blocks = [(i, b) for i, b in enumerate(ledger_data)
                          if b.get("type", "day") == "day"]
            print(f"Total blocks: {len(ledger_data)} ({len(day_blocks)} day blocks)")
            print()
            if day_blocks:
                # Show last 5 day blocks
                print("Most recent day blocks (revertable):")
                for idx, (block_idx, block) in enumerate(day_blocks[-5:],
                                                         start=max(1, len(day_blocks)-4)):
                    date_str = block["date"]
                    titles = [e["data"]["title"] for e in block.get("entries", [])]
                    print(f"  #{idx}: {date_str} — {', '.join(titles)}")
            return
        if args.count is None:
            print("Usage: phpoc revert COUNT")
            print("       phpoc revert --list  (show ledger summary)")
            return
        count = ledger.revert_entries(args.count)
        if count == -1:
            print(f"Cannot revert {args.count} day blocks — not enough day blocks in the ledger.")
        elif count == 0:
            print("Nothing to revert.")
        else:
            print(f"Reverted {args.count} day block(s), restored {count} entr{'y' if count == 1 else 'ies'} to staging.")
            result = ledger.verify()
            if result:
                print("Chain intact and verified.")
            else:
                print("WARN: Chain verification failed.")


def _handle_config_command(args, config):
    """Handle the 'config' subcommand (show, get, set)."""
    if args.config_action == "show":
        import json as _json
        print(_json.dumps(config.read(), indent=2))
    elif args.config_action == "get":
        val = config.get(args.key)
        if val is None:
            print(f"Config key '{args.key}' not found.")
        else:
            import json as _json
            if isinstance(val, (dict, list)):
                print(_json.dumps(val, indent=2))
            else:
                print(val)
    elif args.config_action == "set":
        try:
            parsed = json.loads(args.value)
        except (json.JSONDecodeError, ValueError):
            parsed = args.value
        keys = args.key.split(".")
        if len(keys) == 1:
            config.write({keys[0]: parsed})
        else:
            nested = {}
            current = nested
            for k in keys[:-1]:
                current[k] = {}
                current = current[k]
            current[keys[-1]] = parsed
            config.write(nested)
        print(f"Set config.{args.key} = {args.value}")
    elif args.config_action == "init":
        _config_generate_template(config)
    else:
        print("Usage: phpoc config <show|get|set|init>")
        print("  phpoc config show              — show all config values")
        print("  phpoc config get <key>          — get a config value (dot path)")
        print("  phpoc config set <key> <value>  — set a config value (JSON or string)")
        print("  phpoc config init               — generate a commented config template")


def _config_generate_template(config):
    """Generate a fully-commented config template at the config file path.

    The format puts each key-value pair on a commented line:
      // "key": "value"

    To activate a setting, the user removes the leading "// ".
    Lines without "// " are live JSON that the parser reads.
    The template body produces valid JSON after removing // lines.
    """
    import json as _json
    from security.config_manager import ConfigManager

    defaults = ConfigManager.DEFAULTS

    lines = [
        "//",
        "// PHPOC Configuration File",
        "// ========================",
        "//",
        "// This file was auto-generated. All settings shown below are the defaults.",
        "// To change a setting, uncomment the line (remove the leading '//') and edit the value.",
        "// Lines starting with // are ignored by the parser.",
        "// Values use standard JSON syntax.",
        "//",
        "// To reset your config: delete this file and run `phpoc config init` again.",
        "//",
        "{",
    ]

    sections = [
        ("storage", "File paths for ledger data and metadata"),
        ("remote", "Remote sync settings (git transport)"),
        ("auth", "Authentication / passphrase settings"),
        ("device", "Device identity for multi-device use"),
        ("debug", "Debug and diagnostics (trace logging)"),
        ("timeouts", "Timeout values for sync operations"),
        ("staging", "Staging blob size limits"),
    ]

    first_section = True
    for section_key, section_desc in sections:
        if section_key not in defaults:
            continue
        section = defaults[section_key]

        if first_section:
            first_section = False
        else:
            lines.append(",")
        lines.append("")
        lines.append(f'  // {section_desc}')

        keys = list(section.keys())
        lines.append(f'  "{section_key}": {{')

        for i, key in enumerate(keys):
            value = section[key]
            full_key = f"{section_key}.{key}"
            json_val = _json.dumps(value) if value is not None else "null"
            comment = _get_config_comment(full_key)

            if comment:
                lines.append(f'    // {comment}')

            is_last = (i == len(keys) - 1)
            comma = "" if is_last else ","
            lines.append(f'    // "{key}": {json_val}{comma}')

        lines.append(f'  }}')

    lines.append("}")
    template = "\n".join(lines)

    config_path = config._store.path
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(template)
    print(f"Config template written to {config_path}")
    print("Edit the file, uncomment the settings you want to change, and save.")


def _get_config_comment(full_key: str) -> str:
    """Return a human-readable comment for a config key."""
    comments = {
        "storage.config_dir": "Config file directory (not usually needed to change)",
        "storage.data_dir": "Where ledger.json, staging.json, index.json etc. live",
        "storage.ledger": "Filename for the ledger chain",
        "storage.staging": "Filename for staging entries",
        "storage.index": "Filename for the blind index cache",
        "storage.identity": "Filename for device identity key",
        "storage.config": "Filename for this config file (self-reference)",
        "remote.staging_path": "Remote path for staging (e.g. SSH-style path)",
        "remote.ledger_path": "Remote path for the ledger",
        "remote.transport": "Transport: 'git' (default), 'rsync', etc.",
        "remote.git_remote_url": "Git remote URL for push/pull (e.g. git@example.com:user/phpoc.git)",
        "auth.cache_timeout_minutes": "How long to cache the passphrase before re-prompting",
        "auth.passphrase_required": "Set false to allow no-auth mode for add/start/end",
        "device.device_id": "Unique device identifier (auto-generated on init)",
        "device.device_label": "Human-readable device label (e.g. 'my laptop')",
        "debug.trace_enabled": "Set true to log method-level traces to staging_log/ (no PHPOC_TRACE env var needed)",
        "timeouts.remote_check_ms": "How often to check for remote changes (milliseconds)",
        "timeouts.push_timeout_ms": "Timeout for push operations (milliseconds)",
        "staging.blob_size_tier": "Staging blob size limit: '64K', '256K', '1M', etc.",
    }
    return comments.get(full_key, "")


def _parse_time_input(value_str, date_str, start_epoch, end_epoch):
    """Parse a time input to epoch ms.

    Supported formats:
      HH:MM or HH:MM:SS  -> clock time on date_str
      +N[m|h|s]           -> offset from start_epoch
      -N[m|h|s]           -> offset from end_epoch (clamped at start_epoch)
      N[h][m][s]          -> absolute duration from start_epoch
      <epoch ms>          -> raw epoch ms

    Returns (epoch_ms, display_str) or (None, error_msg).
    """
    from datetime import timezone, datetime
    import re

    value_str = value_str.strip()

    # Offset from start: +N[m|h|s]
    if value_str.startswith("+"):
        try:
            offset_str = value_str.lstrip("+").strip()
            if offset_str.endswith("m"):
                offset_ms = int(offset_str[:-1]) * 60000
            elif offset_str.endswith("h"):
                offset_ms = int(offset_str[:-1]) * 3600000
            elif offset_str.endswith("s"):
                offset_ms = int(offset_str[:-1]) * 1000
            else:
                offset_ms = int(offset_str) * 60000
            result = start_epoch + offset_ms
            return result, time.strftime("%H:%M:%S", time.localtime(result/1000))
        except ValueError:
            return None, "Invalid offset format."

    # Offset from end: -N[m|h|s]
    if value_str.startswith("-"):
        if end_epoch is None:
            return None, "No end time to offset from."
        try:
            offset_str = value_str.lstrip("-").strip()
            if offset_str.endswith("m"):
                offset_ms = int(offset_str[:-1]) * 60000
            elif offset_str.endswith("h"):
                offset_ms = int(offset_str[:-1]) * 3600000
            elif offset_str.endswith("s"):
                offset_ms = int(offset_str[:-1]) * 1000
            else:
                offset_ms = int(offset_str) * 60000
            result = end_epoch - offset_ms
            if result < start_epoch:
                result = start_epoch
            return result, time.strftime("%H:%M:%S", time.localtime(result/1000))
        except ValueError:
            return None, "Invalid offset format."

    # Duration from start: N[h][m][s]
    if re.search(r"\d+(?:h|m|s)", value_str):
        try:
            h = m = s = 0
            h_match = re.search(r"(\d+)h", value_str)
            m_match = re.search(r"(\d+)m", value_str)
            s_match = re.search(r"(\d+)s", value_str)
            if h_match: h = int(h_match.group(1))
            if m_match: m = int(m_match.group(1))
            if s_match: s = int(s_match.group(1))
            duration_ms = (h * 3600 + m * 60 + s) * 1000
            result = start_epoch + duration_ms
            return result, time.strftime("%H:%M:%S", time.localtime(result/1000))
        except ValueError:
            return None, "Invalid duration format."

    # Clock time: HH:MM or HH:MM:SS
    parts = value_str.split(":")
    if len(parts) in (2, 3):
        try:
            date_parts = date_str.split("-")
            h, m = int(parts[0]), int(parts[1])
            s = int(parts[2]) if len(parts) == 3 else 0
            # Use naive datetime (local time) to match time.localtime() display
            dt = datetime(int(date_parts[0]), int(date_parts[1]), int(date_parts[2]),
                          h, m, s)
            result = int(dt.timestamp() * 1000)
            return result, time.strftime("%H:%M:%S", time.localtime(result/1000))
        except (ValueError, IndexError):
            pass

    # Raw epoch ms
    try:
        result = int(value_str)
        return result, time.strftime("%H:%M:%S", time.localtime(result/1000))
    except ValueError:
        return None, "Unrecognized time format. Use HH:MM, +N[m|h|s], -N[m|h|s], N[h][m][s], or epoch ms."


@trace
def _handle_modify(ledger, index):
    """Modify a staged entry's end time, pauses, comment, tags, and media."""
    staging = ledger.store.read_staging()
    completed = [(i, e) for i, e in enumerate(staging)
                  if not e["data"].get("is_active", False)
                  and not e["data"].get("is_paused", False)]

    if not completed:
        print("No completed staged entries to modify.")
        return

    # Show entries
    print("\n=== Staged Entries ===")
    for idx, entry in completed:
        data = entry["data"]
        start_val = data["startTime_enc"]
        if start_val.startswith("plain:"):
            start_epoch = int(start_val[6:])
        else:
            start_epoch = int(ledger.crypto.decrypt(start_val))
        end_val = data["endTime_enc"]
        if end_val:
            if end_val.startswith("plain:"):
                end_epoch = int(end_val[6:])
            else:
                end_epoch = int(ledger.crypto.decrypt(end_val))
        else:
            end_epoch = None

        start_str = time.strftime("%H:%M", time.localtime(start_epoch/1000))
        end_str = time.strftime("%H:%M", time.localtime(end_epoch/1000)) if end_epoch else "??"
        print(f"  #{idx}: [{start_str}-{end_str}] {data['title']} ({data.get('duration', 0)//60000}m)")

    # Prompt for selection
    if index is None:
        try:
            index = int(input("\nEnter entry index to modify: "))
        except ValueError:
            print("Invalid index.")
            return

    if index < 0 or index >= len(staging):
        print(f"No staged entry at index {index}.")
        return
    entry = staging[index]
    data = entry["data"]
    if data.get("is_active", False):
        print(f"Cannot modify active task '{data['title']}'. End it first.")
        return

    print(f"\nModifying: {data['title']}")

    # Decrypt current values
    start_val = data["startTime_enc"]
    if start_val.startswith("plain:"):
        start_epoch = int(start_val[6:])
    else:
        start_epoch = int(ledger.crypto.decrypt(start_val))
    end_val = data["endTime_enc"]
    if end_val:
        if end_val.startswith("plain:"):
            current_end = int(end_val[6:])
        else:
            current_end = int(ledger.crypto.decrypt(end_val))
    else:
        current_end = None

    pauses_enc = data.get("pauses_enc")
    if pauses_enc:
        if pauses_enc.startswith("plain:"):
            current_pauses = json.loads(pauses_enc[6:])
        else:
            current_pauses = json.loads(ledger.crypto.decrypt(pauses_enc))
    else:
        current_pauses = []

    date_str = time.strftime("%Y-%m-%d", time.localtime(start_epoch/1000))

    # Show current state
    start_str = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(start_epoch/1000))
    print(f"  Date:  {date_str}")
    print(f"  Start: {start_str}")
    if current_end:
        end_str = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(current_end/1000))
        print(f"  End:   {end_str}")
    print(f"  Duration: {data.get('duration', 0)//60000}m")
    if current_pauses:
        print(f"  Pauses:")
        for p in current_pauses:
            ps = time.strftime("%H:%M:%S", time.localtime(p["pause_start"]/1000))
            if p.get("pause_stop"):
                pst = time.strftime("%H:%M:%S", time.localtime(p["pause_stop"]/1000))
                pdur = (p["pause_stop"] - p["pause_start"]) // 60000
                print(f"    #{p['pause_index']}: {ps} -> {pst} ({pdur}m)")
            else:
                print(f"    #{p['pause_index']}: {ps} -> ongoing")

    changes_made = {"end_epoch": None, "pauses": None}
    pause_modified = False

    # ======== EDIT END TIME ========
    end_input = input("\nNew end time (blank=keep, HH:MM, HH:MM:SS, +N[m|h|s], N[h][m][s], or epoch ms): ").strip()
    if end_input:
        new_end, _ = _parse_time_input(end_input, date_str, start_epoch, current_end) or (None, None)
        if new_end is not None:
            current_end = new_end
            changes_made["end_epoch"] = new_end
            end_str = time.strftime("%H:%M:%S", time.localtime(current_end/1000))
            print(f"  End set to {end_str}")
        else:
            print("  Invalid format, keeping original.")

    # ======== EDIT COMMENT ========
    current_comment = data.get("comment")
    if current_comment:
        comment_input = input(f'  Comment ("{current_comment}", edit, or blank to clear): ').strip()
    else:
        comment_input = input("  Comment (optional, or blank to keep): ").strip()

    if comment_input:
        data["comment"] = comment_input
        print(f"  Comment set to: {comment_input}")
    elif current_comment and comment_input == "":
        data["comment"] = None
        print("  Comment cleared.")

    # ======== EDIT TAGS ========
    current_tags = list(data.get("tags", []))
    print(f"\n--- Tags (current: {', '.join(current_tags) if current_tags else 'none'}) ---")
    tags_modified = False
    while True:
        tag_action = input("  [A]dd tag, [R]emove tag, [D]one: ").strip().upper()
        if tag_action == "A":
            t = input("  Tag to add: ").strip().lower()
            if t:
                if t not in current_tags:
                    current_tags.append(t)
                    current_tags.sort()
                    print(f"  Added @{t}")
                    tags_modified = True
                else:
                    print(f"  @{t} already present.")
        elif tag_action == "R":
            if not current_tags:
                print("  No tags to remove.")
            else:
                print(f"  Tags: {', '.join(f'@{t}' for t in current_tags)}")
                t = input("  Tag to remove: ").strip().lower()
                if t in current_tags:
                    current_tags.remove(t)
                    print(f"  Removed @{t}")
                    tags_modified = True
                else:
                    print(f"  @{t} not found.")
        elif tag_action == "D":
            break
        else:
            print("  Invalid choice.")
    if tags_modified:
        data["tags"] = current_tags

    # ======== MEDIA STUB ========
    current_media = list(data.get("media", []))
    if current_media:
        print(f"\n  Current media: {json.dumps(current_media)}")
    add_media = input("  Add media? (filename,hash or blank to skip): ").strip()
    if add_media:
        parts = add_media.split(",")
        if len(parts) == 2:
            fname, fhash = parts[0].strip(), parts[1].strip()
            current_media.append({"filename": fname, "hash": fhash})
            data["media"] = current_media
            print(f"  Added media: {fname}")
        else:
            print("  Expected format: filename,hash")

    # ======== EDIT PAUSES ========
    print("\n--- Pause Editor ---")
    print("  Options:")
    print("    [A]dd pause      [E]dit pause")
    print("    [R]emove pause   [C]lear all pauses")
    print("    [K]eep current")

    new_pauses = [dict(p) for p in current_pauses]

    while True:
        pause_action = input("  Choice (A/E/R/C/K): ").strip().upper()
        if pause_action == "A":
            try:
                p_start_input = input("  Pause start (HH:MM, +N[m|h|s], N[h][m][s]): ").strip()
                if not p_start_input:
                    print("  Cancelled.")
                    continue
                pause_start, _ = _parse_time_input(p_start_input, date_str, start_epoch, current_end) or (None, None)
                if pause_start is None:
                    print("  Invalid format.")
                    continue

                p_stop_input = input("  Pause stop (HH:MM, +N[m|h|s], N[h][m][s], or blank for ongoing): ").strip()
                pause_stop = None
                if p_stop_input:
                    pause_stop, _ = _parse_time_input(p_stop_input, date_str, start_epoch, current_end) or (None, None)
                    if pause_stop is None:
                        print("  Invalid format.")
                        continue
                    # Clamp stop at activity end time
                    if current_end is not None and pause_stop > current_end:
                        pause_stop = current_end
                        print(f"  Pause stop clamped to activity end ({time.strftime('%H:%M:%S', time.localtime(current_end/1000))})")

                next_idx = max([p.get("pause_index", 0) for p in new_pauses], default=0) + 1
                new_pauses.append({
                    "pause_index": next_idx,
                    "pause_start": pause_start,
                    "pause_stop": pause_stop,
                })
                print(f"  Added pause #{next_idx}.")
                pause_modified = True
            except (ValueError, IndexError, TypeError):
                print("  Invalid time format, no pause added.")

        elif pause_action == "E":
            if not new_pauses:
                print("  No pauses to edit.")
                continue
            try:
                e_idx = int(input(f"  Pause index to edit (1-{len(new_pauses)}): "))
                found = [p for p in new_pauses if p["pause_index"] == e_idx]
                if not found:
                    print(f"  No pause with index {e_idx}.")
                    continue
                p = found[0]
                ps_str = time.strftime("%H:%M:%S", time.localtime(p["pause_start"]/1000))
                print(f"  Editing pause #{e_idx}: currently start={ps_str}")

                new_start_input = input("  New start (blank to keep, HH:MM, +N[m|h|s]): ").strip()
                if new_start_input:
                    new_start, _ = _parse_time_input(new_start_input, date_str, start_epoch, current_end) or (None, None)
                    if new_start is not None:
                        p["pause_start"] = new_start
                        print(f"  Start set to {time.strftime('%H:%M:%S', time.localtime(new_start/1000))}")
                        pause_modified = True
                    else:
                        print("  Invalid format, keeping original.")

                pst_str = time.strftime("%H:%M:%S", time.localtime(p["pause_stop"]/1000)) if p.get("pause_stop") else "ongoing"
                print(f"  Currently stop={pst_str}")
                new_stop_input = input("  New stop (blank to keep, HH:MM, +N[m|h|s], -N[m|h|s], or 'none' for ongoing): ").strip()
                if new_stop_input:
                    if new_stop_input.lower() == "none":
                        p["pause_stop"] = None
                        print("  Stop cleared (ongoing).")
                        pause_modified = True
                    else:
                        new_stop, _ = _parse_time_input(new_stop_input, date_str, start_epoch, current_end) or (None, None)
                        if new_stop is not None:
                            # Clamp at activity end
                            if current_end is not None and new_stop > current_end:
                                new_stop = current_end
                                print(f"  Pause stop clamped to activity end ({time.strftime('%H:%M:%S', time.localtime(current_end/1000))})")
                            p["pause_stop"] = new_stop
                            print(f"  Stop set to {time.strftime('%H:%M:%S', time.localtime(new_stop/1000))}")
                            pause_modified = True
                        else:
                            print("  Invalid format, keeping original.")
            except ValueError:
                print("  Invalid index.")

        elif pause_action == "R":
            if not new_pauses:
                print("  No pauses to remove.")
                continue
            try:
                r_idx = int(input(f"  Pause index to remove (1-{len(new_pauses)}): "))
                removed = [p for p in new_pauses if p["pause_index"] == r_idx]
                if removed:
                    new_pauses = [p for p in new_pauses if p["pause_index"] != r_idx]
                    for i, p in enumerate(new_pauses):
                        p["pause_index"] = i + 1
                    print(f"  Removed pause #{r_idx}.")
                    pause_modified = True
                else:
                    print(f"  No pause with index {r_idx}.")
            except ValueError:
                print("  Invalid index.")

        elif pause_action == "C":
            new_pauses = []
            pause_modified = True
            print("  All pauses cleared.")

        elif pause_action == "K":
            break

        else:
            print("  Invalid choice.")
            continue
        break

    # Recompute hash if any data changed
    if any([changes_made["end_epoch"], pause_modified, comment_input or (current_comment and comment_input == ""),
            tags_modified, add_media]):
        entry["hash"] = hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()

    # Apply end_epoch and pauses via domain method (handles duration recompute)
    if changes_made["end_epoch"] or pause_modified:
        try:
            result = ledger.modify_staged_entry(
                index,
                end_epoch=changes_made["end_epoch"],
                pauses=new_pauses if pause_modified else None,
            )
            print(f"\nDone: {result['title']} (duration: {result['duration']//60000}m)")
        except ValueError as e:
            print(f"Error: {e}")
    else:
        # Only non-timing fields changed, just write staging
        if any([comment_input or (current_comment and comment_input == ""), tags_modified, add_media]):
            ledger.store.write_staging(staging)
            print(f"\nDone: {data.get('title', '?')}")
@trace
def _handle_remove(ledger, index, auto_yes):
    """Remove a staged entry."""
    staging = ledger.store.read_staging()

    if not staging:
        print("No entries in staging.")
        return

    # Show entries
    print("\n=== Staged Entries ===")
    for idx, entry in enumerate(staging):
        data = entry["data"]
        _print_staging_line(entry, idx)

    # Prompt for selection
    if index is None:
        try:
            index = int(input("\nEnter entry index to remove: "))
        except ValueError:
            print("Invalid index.")
            return

    if index < 0 or index >= len(staging):
        print(f"No staged entry at index {index}.")
        return

    title = staging[index]["data"]["title"]
    if not auto_yes:
        confirm = input(f"Remove '{title}' from staging? (y/N): ").strip().lower()
        if confirm != "y":
            print("Cancelled.")
            return

    try:
        removed = ledger.remove_staged_entry(index)
        print(f"✓ Removed: {removed}")
    except ValueError as e:
        print(f"Error: {e}")


def _handle_review(ledger, cli):
    """Preview staged entries as they'd appear after sync."""
    preview = ledger.get_staged_entries_preview()

    if not preview:
        print("No completed staged entries to review.")
        return

    # Group by date
    by_date = {}
    for p in preview:
        by_date.setdefault(p["date"], []).append(p)

    print("\n=== Staging Preview (as would appear after sync) ===")
    total_duration = 0
    total_entries = len(preview)

    for date_str in sorted(by_date):
        entries = by_date[date_str]
        day_duration = sum(e["duration"] for e in entries)
        total_duration += day_duration

        print(f"\n── {date_str} ── ({len(entries)} entries, {day_duration//60000}m total)")

        for e in entries:
            start_str = time.strftime("%H:%M", time.localtime(e["start_epoch"]/1000))
            end_str = time.strftime("%H:%M", time.localtime(e["end_epoch"]/1000)) if e["end_epoch"] else "??"
            dur_str = f"{e['duration']//60000}m" if e['duration'] >= 0 else f"({e['duration']//60000}m)"
            tag_str = f" [{', '.join(e['tags'])}]" if e["tags"] else ""
            comment_str = f" — {e['comment']}" if e.get("comment") else ""

            # Show pause info if any
            pause_str = ""
            if e["pauses"]:
                total_pause_ms = sum(
                    (p.get("pause_stop", 0) or 0) - p["pause_start"]
                    for p in e["pauses"] if p.get("pause_stop")
                )
                if total_pause_ms > 0:
                    pause_str = f" (paused {total_pause_ms//60000}m)"

            print(f"  [{start_str}-{end_str}] {e['title']}{tag_str} ({dur_str}){pause_str}{comment_str}")

    print(f"\n── Summary: {total_entries} entries, {total_duration//60000}m total over {len(by_date)} day(s) ──")


def _print_staging_line(entry, idx):
    """Print one line for a staged entry in a list (handle plain: prefix)."""
    data = entry["data"]
    start_val = data["startTime_enc"]
    if start_val.startswith("plain:"):
        start_epoch = int(start_val[6:])
    else:
        import sys
        print(f"  #{idx}: {data['title']} (encrypted — use auth to view)")
        return

    end_val = data.get("endTime_enc")
    if end_val and end_val.startswith("plain:"):
        end_epoch = int(end_val[6:])
    else:
        end_epoch = None

    start_str = time.strftime("%H:%M", time.localtime(start_epoch/1000))
    end_str = time.strftime("%H:%M", time.localtime(end_epoch/1000)) if end_epoch else "??"
    active_str = " [active]" if data.get("is_active") else ""
    paused_str = " [paused]" if data.get("is_paused") else ""

    print(f"  #{idx}: [{start_str}-{end_str}] {data['title']} ({data.get('duration', 0)//60000}m){active_str}{paused_str}")


def _list_tags(ledger, cli):
    """Collect and print all unique tags from staging and synced entries."""
    all_tags = set()

    # From staging
    staging = ledger.store.read_staging()
    for entry in staging:
        all_tags.update(entry["data"].get("tags", []))

    # From synced ledger
    ledger_data = ledger.get_ledger_data()
    for day in ledger_data:
        if day.get("type") != "day":
            continue
        for entry in day.get("entries", []):
            all_tags.update(entry["data"].get("tags", []))

    sorted_tags = sorted(all_tags)
    if sorted_tags:
        print("\n--- Tags ---")
        for t in sorted_tags:
            print(f"  @{t}")
    else:
        print("No tags found.")


def _resolve_till_date(date_str: str) -> str:
    """Parse --till value to YYYY-MM-DD. Supports MM-DD or YYYY-MM-DD."""
    import re, datetime
    if re.match(r'^\d{4}-\d{2}-\d{2}$', date_str):
        return date_str
    if re.match(r'^\d{2}-\d{2}$', date_str):
        return f"{datetime.date.today().year}-{date_str}"
    print(f"WARN: Invalid --till format '{date_str}'. Use MM-DD or YYYY-MM-DD. Ignoring.")
    return None


if __name__ == "__main__":
    main()
