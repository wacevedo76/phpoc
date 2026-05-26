#!/usr/bin/env python3
"""Force-push ALL ledger blocks from local to R2, overwriting any existing.

Run this on x13 when you want to replace the remote ledger with a clean
copy of x13's full chain. After this, debagent04 can re-run onboarding
to get a clean clone.

Usage:
    python3 scripts/force_push_ledger.py
"""

import json
import os
import sys

# ── Resolve paths ────────────────────────────────────────────────────
XDG_DATA = os.environ.get("XDG_DATA_HOME", os.path.expanduser("~/.local/share"))
DATA_DIR = Path(os.environ.get("PHPOC_DATA_DIR", XDG_DATA / "phpoc"))
CONFIG_DIR = Path(os.environ.get("PHPOC_CONFIG_DIR", os.path.expanduser("~/.config/phpoc")))

LEDGER_PATH = DATA_DIR / "ledger.json"
CONFIG_PATH = CONFIG_DIR / "config.json"


def main():
    # 1. Load config
    config = json.loads(CONFIG_PATH.read_text())
    http_cfg = config.get("http", {})
    base_url = http_cfg.get("base_url")
    api_key = http_cfg.get("api_key") or os.environ.get("PHPOC_CLOUDFLARE_API_KEY")
    
    if not base_url or not api_key:
        print("Error: HTTP transport not configured in config.json")
        print("  Set http.base_url and http.api_key")
        sys.exit(1)
    
    # 2. Authenticate and get master key
    sys.path.insert(0, str(Path(__file__).parent.parent))
    from security.auth import PassphraseAuthenticator
    from domain.ledger.remote_sync import RemoteLedgerSync
    from core.sync.http_transport import HttpStagingTransport
    
    auth = PassphraseAuthenticator(str(LEDGER_PATH))
    if not auth.authenticate():
        print("Authentication failed.")
        sys.exit(1)
    
    mk = auth.get_key()
    transport = HttpStagingTransport(base_url, api_key)
    ledger_sync = RemoteLedgerSync(transport=transport, master_key=mk)
    
    # 3. Load local ledger
    ledger_data = json.loads(LEDGER_PATH.read_text())
    print(f"Local ledger: {len(ledger_data)} blocks")
    
    # 4. Check what's on remote
    remote_count = ledger_sync.get_remote_block_count()
    print(f"Remote ledger: {remote_count} blocks")
    
    # 5. Force-push all blocks (overwrite existing)
    confirm = input(f"\nForce-push {len(ledger_data)} blocks to R2, overwriting {remote_count} existing? (y/N): ")
    if confirm.lower() != "y":
        print("Cancelled.")
        return
    
    # Overwrite by calling _transport.push directly
    pushed = 0
    for i, block in enumerate(ledger_data):
        filename = f"{i:06d}.json"
        path = f"ledger/blocks/{filename}"
        obfuscated = ledger_sync._obfuscate_block(block)
        transport.push(path, obfuscated)
        pushed += 1
        print(f"  Pushed block {i} ({block.get('date', '?')})")
    
    # 6. Push index too
    index_path = DATA_DIR / "index.json"
    if index_path.exists():
        index_data = json.loads(index_path.read_text())
        ledger_sync.push_index(index_data)
        print(f"✓ Pushed index ({len(index_data)} dates)")
    
    print(f"\n✓ Force-push complete: {pushed} blocks overwritten on R2")
    print("  debagent04 can now re-run: python3 main.py onboarding")


if __name__ == "__main__":
    from pathlib import Path
    main()
