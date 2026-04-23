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
    add_sub.add_parser("oneoff", help="Capture a completed task")
    start_p = add_sub.add_parser("start", help="Start a task")
    start_p.add_argument("title")
    end_p = add_sub.add_parser("end", help="End a task")
    end_p.add_argument("title")

    # Init command
    subparsers.add_parser("init", help="Initialize a new ledger")

    # Recover command
    subparsers.add_parser("recover", help="Recover access using seed and set new passphrase")

    # View command
    subparsers.add_parser("view", help="View active tasks")
    # Sync command
    subparsers.add_parser("sync", help="Sync staged habits to the ledger")
    # Verify command
    subparsers.add_parser("verify", help="Verify ledger integrity")

    # Rep/List commands...
    rep_parser = subparsers.add_parser("rep", help="Show reputation summary")
    rep_parser.add_argument("days", type=int, nargs="?", help="Limit to last N days")
    rep_parser.add_argument("--from", dest="from_date", help="Start date (YYYY-MM-DD)")
    rep_parser.add_argument("--to", dest="to_date", help="End date (YYYY-MM-DD)")

    list_parser = subparsers.add_parser("list", help="List detailed habits (requires decryption)")
    list_parser.add_argument("days", type=int, nargs="?", help="Limit to last N days")
    list_parser.add_argument("--from", dest="from_date", help="Start date (YYYY-MM-DD)")
    list_parser.add_argument("--to", dest="to_date", help="End date (YYYY-MM-DD)")

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
        pdk = hashlib.pbkdf2_hmac('sha256', p1.encode(), b"session-salt", 100000, 32)
        
        seed = LedgerFactory.initialize(LEDGER_PATH, pdk, username, email)
        if seed:
            print(f"\nLedger initialized.")
            print(f"!!! IMPORTANT: Save this recovery seed in a secure place !!!")
            print(f"RECOVERY SEED: {seed}")
            print(f"!!! You will NOT be able to recover your data without this seed if you lose your password !!!\n")
            
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
        print("\nSeed Verified. Set your new passphrase.")
        while True:
            p1 = getpass.getpass("New Passphrase: ")
            p2 = getpass.getpass("Confirm New Passphrase: ")
            if p1 == p2:
                break
            print("Passphrases do not match.")
        
        # 1. Update Identity block in Ledger
        pdk = hashlib.pbkdf2_hmac('sha256', p1.encode(), b"session-salt", 100000, 32)
        
        ledger_data = json.loads(LEDGER_PATH.read_text())
        seed_str = base64.b64encode(mk).decode('utf-8')
        new_enc_seed = RecoveryManager.encrypt_seed(seed_str, pdk)
        
        ledger_data[0]["identity"]["recovery_seed_enc"] = new_enc_seed
        
        # 2. Re-seal the genesis (using MK)
        crypto = CryptoManager(mk)
        check_data = {k: v for k, v in ledger_data[0].items() if k != "day_hash"}
        ledger_data[0]["day_hash"] = crypto.seal(json.dumps(check_data, sort_keys=True))
        
        LEDGER_PATH.write_text(json.dumps(ledger_data, indent=2))
        print("Passphrase reset successful. You can now use your new passphrase.")
        return

    # --- Lazy Authentication Logic ---
    
    # List of commands that REQUIRE a valid passphrase
    # (Reading the ledger, verifying history, or performing a sync)
    require_auth = ["sync", "verify", "rep", "list", "view"]
    
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
            cli.add_oneoff(input("Title: "), int(time.time()*1000)-120000, int(time.time()*1000))
        elif args.subcommand == "start":
            cli.add_start(args.title)
        elif args.subcommand == "end":
            cli.add_end(args.title)
    elif args.command == "view":
        cli.view_active()
    elif args.command == "sync":
        ledger.sync_day()
    elif args.command == "verify":
        ledger.verify()
    elif args.command == "rep":
        cli.show_rep(args.days, from_date=args.from_date, to_date=args.to_date)
    elif args.command == "list":
        cli.list_habits(args.days, from_date=args.from_date, to_date=args.to_date)

if __name__ == "__main__":
    main()
