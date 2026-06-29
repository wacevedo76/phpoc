#!/usr/bin/env python3
"""
compare_ledgers.py — Compare ledger:blocks blob vs ledger/blocks/ files on R2.

Fetches both remote formats from the Cloudflare Worker, deobfuscates
the blocks-format files, and compares genesis hashes, usernames,
passphrases, and block counts to detect divergence.

Usage:
    python3 scripts/compare_ledgers.py <worker_url> <api_key> <seed_base64>

Example:
    python3 scripts/compare_ledgers.py https://phpoc-staging.example.workers.dev sk-mykey "dGhpcyBpcyBhIHNlZWQ..."

Note: The seed is the base64-encoded 32-byte master key shown during
'ph init'.  It is NOT a passphrase or BIP39 mnemonic.
"""

import sys
import json
import hashlib
import base64
import os
from urllib.request import Request, urlopen
from urllib.parse import urlencode

# Resolve the phpoc project root relative to this script
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)
sys.path.insert(0, PROJECT_ROOT)

from domain.staging.remote_sync import RemoteStagingSync


# ── Helpers ─────────────────────────────────────────────────────────

def fetch(worker_url, api_key, path):
    """GET a path from the Worker. Returns bytes or None on 404."""
    url = worker_url.rstrip('/') + '/' + path.lstrip('/')
    req = Request(url, headers={'X-Api-Key': api_key})
    try:
        with urlopen(req, timeout=15) as resp:
            if resp.status == 404:
                return None
            return resp.read()
    except Exception as e:
        print(f"  !! HTTP {path}: {e}")
        return None


def list_files(worker_url, api_key, prefix):
    """List keys under a prefix via ?prefix= query."""
    url = worker_url.rstrip('/') + '/?' + urlencode({'prefix': prefix})
    req = Request(url, headers={'X-Api-Key': api_key})
    try:
        with urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode())
            return data if isinstance(data, list) else []
    except Exception as e:
        print(f"  !! LIST {prefix}: {e}")
        return []


def derive_master_key(seed):
    """Decode the base64-encoded seed into the 32-byte master key.

    The 'recovery seed' in phpoc IS the base64-encoded master key.
    """
    return base64.b64decode(seed)


def get_genesis_hash(block):
    """Compute genesis hash matching GenesisGate.compare() JS logic."""
    sealable = {k: v for k, v in block.items()
                if k not in ('day_hash', 'month_hash', 'year_hash', 'signature')}
    return hashlib.sha256(
        json.dumps(sealable, sort_keys=True).encode()
    ).hexdigest()


def deobfuscate_block(raw, master_key):
    """Deobfuscate a blocks-format file into a ledger block dict."""
    try:
        plaintext = RemoteStagingSync._deobfuscate(raw, master_key)
        if plaintext is None:
            return None
        return json.loads(plaintext.decode('utf-8'))
    except Exception as e:
        print(f"  !! Deobfuscation failed: {e}")
        return None


def _short(s, n=20):
    """Truncate string for display."""
    return s if len(s) <= n else s[:n] + '...'


# ── Main ────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 4:
        print(__doc__)
        sys.exit(1)

    worker_url = sys.argv[1]
    api_key = sys.argv[2]
    seed = ''.join(sys.argv[3:]).replace(' ', '')

    master_key = derive_master_key(seed)
    print(f"Master key: {master_key.hex()[:16]}...")

    # ── 1. Fetch ledger:blocks (old single-blob format) ─────────────
    print("\n=== ledger:blocks (single blob) ===")
    blob_raw = fetch(worker_url, api_key, 'ledger:blocks')
    blob_chain = None
    if blob_raw is not None:
        try:
            blob_chain = json.loads(blob_raw.decode('utf-8'))
        except json.JSONDecodeError as e:
            print(f"  X Invalid JSON: {e}")
            return
        blob_genesis = blob_chain[0]
        print(f"  FOUND — {len(blob_chain)} blocks")
        print(f"     Genesis type: {blob_genesis.get('type', '??')}")
        print(f"     Username:     {blob_genesis.get('data', {}).get('username', '??')}")
        pp = blob_genesis.get('data', {}).get('passphrase', '??')
        print(f"     Passphrase:   \"{_short(pp)}\"")
        print(f"     Genesis hash: {get_genesis_hash(blob_genesis)[:16]}...")
    else:
        print("  NOT FOUND (404) — no single-blob ledger exists.")

    # ── 2. Fetch ledger/blocks/ (canonical format) ──────────────────
    print("\n=== ledger/blocks/ (block files) ===")
    files = list_files(worker_url, api_key, 'ledger/blocks/')
    chain = []
    if not files:
        print("  No block files found — empty or non-existent.")
    else:
        print(f"  FOUND {len(files)} files: {sorted(files)}")
        for fname in sorted(files):
            path = 'ledger/blocks/' + fname
            raw = fetch(worker_url, api_key, path)
            if raw is None:
                print(f"  !! {fname}: fetch failed — skipping")
                continue
            block = deobfuscate_block(raw, master_key)
            if block is None:
                print(f"  X {fname}: deobfuscation failed — wrong seed?")
                print(f"     Raw size: {len(raw)} bytes")
                print(f"     First 24 bytes (hex): {raw[:24].hex()}")
                continue
            chain.append(block)
            entries = len(block.get('entries', []))
            print(f"     {fname}: type={block.get('type', '??')}, entries={entries}")
        if chain:
            genesis = chain[0]
            print(f"\n  === Genesis block ===")
            print(f"     Type:         {genesis.get('type', '??')}")
            print(f"     Username:     {genesis.get('data', {}).get('username', '??')}")
            pp = genesis.get('data', {}).get('passphrase', '??')
            print(f"     Passphrase:   \"{_short(pp)}\"")
            print(f"     Genesis hash: {get_genesis_hash(genesis)[:16]}...")
            print(f"     Total blocks: {len(chain)}")

    # ── 3. Compare ──────────────────────────────────────────────────
    print("\n=== Comparison ===")
    if blob_chain and chain:
        blob_gen = blob_chain[0]
        blk_gen = chain[0]
        blob_hash = get_genesis_hash(blob_gen)
        blk_hash = get_genesis_hash(blk_gen)

        blob_user = blob_gen.get('data', {}).get('username', '')
        blk_user = blk_gen.get('data', {}).get('username', '')
        blob_pp = blob_gen.get('data', {}).get('passphrase', '')
        blk_pp = blk_gen.get('data', {}).get('passphrase', '')

        if blob_hash == blk_hash:
            print("  SAME LEDGER — genesis hashes match.")
            bc = len(blob_chain)
            fc = len(chain)
            if bc != fc:
                print(f"  Block counts differ: blob={bc}, files={fc}")
            else:
                print(f"  Both formats have {bc} blocks — identical.")
        else:
            print("  DIVERGENT — genesis hashes differ!")
            print(f"     blob   genesis: {blob_hash[:16]}... (user: {blob_user})")
            print(f"     blocks genesis: {blk_hash[:16]}... (user: {blk_user})")
            if blob_user != blk_user or blob_pp != blk_pp:
                print("     DIFFERENT credentials — these are separate ledgers!")
            if len(blob_chain) != len(chain):
                print(f"     DIFFERENT block counts: {len(blob_chain)} vs {len(chain)}")
    elif blob_chain and not chain:
        print("  Only single-blob format exists. No blocks-format found.")
        g = blob_chain[0]
        print(f"  {len(blob_chain)} blocks, user: {g.get('data', {}).get('username', '??')}")
    elif chain and not blob_chain:
        print("  Only blocks format exists. No single-blob found.")
        g = chain[0]
        print(f"  {len(chain)} blocks, user: {g.get('data', {}).get('username', '??')}")
    else:
        print("  Neither format exists on R2 — empty bucket.")


if __name__ == '__main__':
    main()
