import argparse
import getpass
from pathlib import Path
from security.crypto import CryptoManager
from storage.file_store import LedgerStore
from core.ledger import LedgerDomain
from cli.interface import CLIInterface

CONFIG_DIR = Path.home() / ".config" / "personal_history_poc"

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

    # Rep command
    rep_parser = subparsers.add_parser("rep", help="Show reputation summary")
    rep_parser.add_argument("days", type=int, nargs="?", help="Limit to last N days")
    rep_parser.add_argument("--from", dest="from_date", help="Start date (YYYY-MM-DD)")
    rep_parser.add_argument("--to", dest="to_date", help="End date (YYYY-MM-DD)")

    # List command
    list_parser = subparsers.add_parser("list", help="List detailed habits (requires decryption)")
    list_parser.add_argument("days", type=int, nargs="?", help="Limit to last N days")
    list_parser.add_argument("--from", dest="from_date", help="Start date (YYYY-MM-DD)")
    list_parser.add_argument("--to", dest="to_date", help="End date (YYYY-MM-DD)")

    args = parser.parse_args()

    # ... (init code)

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
