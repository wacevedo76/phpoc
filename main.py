import argparse
import getpass
import time
import json
import hashlib
import base64
from pathlib import Path
from security.crypto import CryptoManager, NoAuthCryptoManager
from security.auth import PassphraseAuthenticator, RecoveryAuthenticator
from security.recovery import RecoveryManager
from storage.file_store import LedgerStore
from core.ledger import LedgerDomain
from core.factory import LedgerFactory
from cli.interface import CLIInterface

CONFIG_DIR = Path.home() / ".config" / "personal_history_poc"
LEDGER_PATH = CONFIG_DIR / "ledger.json"
INDEX_PATH = CONFIG_DIR / "index.json"

def main():
    parser = argparse.ArgumentParser(description="PHPOC Ledger")
    subparsers = parser.add_subparsers(dest="command")

    # Add command
    add_parser = subparsers.add_parser("add", help="Add a new habit")
    add_sub = add_parser.add_subparsers(dest="subcommand")
    oneoff_p = add_sub.add_parser("oneoff", help="Capture a completed task")
    oneoff_p.add_argument("title", nargs="?", help="Task title (optional, will prompt if omitted)")
    oneoff_p.add_argument("--tag", dest="tags", action="append", default=[], help="Add a tag (e.g. --tag music --tag learning)")
    start_p = add_sub.add_parser("start", help="Start a task")
    start_p.add_argument("title")
    start_p.add_argument("--tag", dest="tags", action="append", default=[], help="Add a tag (e.g. --tag music --tag learning)")
    end_p = add_sub.add_parser("end", help="End a task")
    end_p.add_argument("title")
    pause_p = add_sub.add_parser("pause", help="Pause a task")
    pause_p.add_argument("title")
    unpause_p = add_sub.add_parser("unpause", help="Resume a paused task")
    unpause_p.add_argument("title")

    # Init command
    subparsers.add_parser("init", help="Initialize a new ledger")

    # Recover command
    subparsers.add_parser("recover", help="Recover access using seed and set new passphrase")

    # View command
    view_parser = subparsers.add_parser("view", help="View active tasks")
    view_parser.add_argument("--tags", action="store_true", help="Show tags inline with tasks")

    # Tags command
    subparsers.add_parser("tags", help="List all unique tags ever used")

    # Sync command
    sync_parser = subparsers.add_parser("sync", help="Sync staged habits to the ledger")
    sync_parser.add_argument("--yes", action="store_true", help="Skip confirmation prompt")
    sync_parser.add_argument("--till", help="Only sync entries up to and including this date (MM-DD or YYYY-MM-DD)")
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

    # Helper to add common date filter args to a subparser
    def _add_date_args(p):
        p.add_argument("days", type=int, nargs="?", help="Limit to last N days")
        p.add_argument("--date", help="Specific date (YYYY-MM-DD)")
        p.add_argument("--week", help="ISO week (YYYY-Www) or date within week (YYYY-MM-DD)")
        p.add_argument("--month", help="Month (YYYY-MM or MM)")
        p.add_argument("--year", help="Year (YYYY)")
        p.add_argument("--from", dest="from_date", help="Start date (YYYY-MM-DD, YYYY-MM, YYYY, MM/YY, or MM)")
        p.add_argument("--to", dest="to_date", help="End date (YYYY-MM-DD, YYYY-MM, YYYY, MM/YY, or MM)")

    # List all activities (synced + staged)
    list_all_p = list_subparsers.add_parser("all", help="List all activities (synced and staged)")
    _add_date_args(list_all_p)

    # List only synced activities
    list_synced_p = list_subparsers.add_parser("synced", help="List only synced activities")
    _add_date_args(list_synced_p)

    # List only staged activities
    list_staged_p = list_subparsers.add_parser("staged", help="List only staged activities")
    _add_date_args(list_staged_p)

    # Revert command
    revert_p = subparsers.add_parser("revert", help="Undo the last N synced day blocks")
    revert_p.add_argument("count", type=int, nargs="?",
                          help="Number of day blocks to revert (not individual entries)")
    revert_p.add_argument("--list", action="store_true",
                          help="Show ledger summary with recent day blocks")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        exit(1)

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

        # 3. Re-seal the genesis (using MK)
        check_data = {k: v for k, v in ledger_data[0].items() if k != "day_hash"}
        ledger_data[0]["day_hash"] = crypto.seal(json.dumps(check_data, sort_keys=True))
        
        LEDGER_PATH.write_text(json.dumps(ledger_data, indent=2))
        print("Passphrase reset successful. You can now use your new passphrase.")
        return

    # --- Lazy Authentication Logic ---
    
    # List of commands that REQUIRE a valid passphrase
    # (Reading the ledger, verifying history, or performing a sync)
    require_auth = ["sync", "verify", "rep", "list", "view", "tags"]
    
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
    cli = CLIInterface(ledger)
    
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
            cli.add_oneoff(title, int(time.time()*1000)-1000, int(time.time()*1000), tags=tags)
        elif args.subcommand == "start":
            tags = CLIInterface._normalize_tag_args(args.tags) if hasattr(args, 'tags') and args.tags else None
            cli.add_start(args.title, tags=tags)
        elif args.subcommand == "end":
            cli.add_end(args.title)
        elif args.subcommand == "pause":
            cli.add_pause(args.title)
        elif args.subcommand == "unpause":
            cli.add_unpause(args.title)
    elif args.command == "view":
        show_tags = args.tags if hasattr(args, 'tags') else False
        cli.view_active(show_tags=show_tags)
    elif args.command == "tags":
        _list_tags(ledger, cli)
    elif args.command == "sync":
        from core.sync_confirmation import AutoSyncStrategy, InteractiveCLIStrategy
        strategy = AutoSyncStrategy() if getattr(args, 'yes', False) else InteractiveCLIStrategy()
        till_date = _resolve_till_date(args.till) if args.till else None
        ledger.sync_with_strategy(strategy, till_date=till_date)
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
        from_str, to_str = CLIInterface._resolve_date_filters(
            days=args.days,
            date=getattr(args, 'date', None),
            week=getattr(args, 'week', None),
            month=getattr(args, 'month', None),
            year=getattr(args, 'year', None),
            from_date=args.from_date,
            to_date=args.to_date,
        )
        cli.list_habits(args.source, args.days, from_date=from_str, to_date=to_str)
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
