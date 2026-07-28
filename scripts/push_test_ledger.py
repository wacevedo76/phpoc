#!/usr/bin/env python3
"""
Push a test ledger to the Cloudflare Worker for integration testing.

Reads a ledger.json from /tmp/phpoc_test_ledger/ and pushes:
- ledger/blocks/NNNNNN.json (each block, obfuscated)
- ledger/hash_index.json (plaintext block hashes)
- ledger/index.json (empty dict, obfuscated)
- staging/blobs/current.json (empty staging blob, obfuscated)
- staging/blobs/device_cookie.bin (empty device cookie)

Usage:
    python3 /tmp/push_test_ledger.py
    python3 /tmp/push_test_ledger.py --ledger /path/to/ledger.json
"""

import argparse
import hashlib
import hmac
import json
import os
import struct
import sys
import time
import urllib.request
from pathlib import Path
from typing import Dict, Any

PROJECT_ROOT = Path("/home/wacevedo/code/Testing/phpoc")
sys.path.insert(0, str(PROJECT_ROOT))

from security.crypto import PureAESCTR
from domain.staging.remote_sync import RemoteStagingSync as RSS

# ─── Credentials ────────────────────────────────────────────────────────────
API_URL = "https://phpoc-staging-testing.wacevedo.workers.dev"
API_KEY = "MKNuQP92x2+fJyNRmoW6w9lTCbDh0lKm"
USER_AGENT = "phpoc-test/1.0"

# ─── Helpers ────────────────────────────────────────────────────────────────

def http_put(path: str, data: bytes) -> int:
    """PUT data to the Worker. Returns HTTP status code."""
    url = f"{API_URL}/{path}"
    req = urllib.request.Request(
        url, data=data, method="PUT",
        headers={"X-Api-Key": API_KEY, "Content-Type": "application/octet-stream", "User-Agent": USER_AGENT},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status
    except urllib.error.HTTPError as e:
        return e.code


def http_get(path: str) -> tuple:
    """GET from the Worker. Returns (status, body_bytes)."""
    url = f"{API_URL}/{path}"
    req = urllib.request.Request(
        url, method="GET", headers={"X-Api-Key": API_KEY, "User-Agent": USER_AGENT},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def obfuscate_block(block: dict, master_key: bytes) -> bytes:
    """Obfuscate a ledger block using the same scheme as RemoteLedgerSync."""
    plaintext = json.dumps(block, indent=2).encode("utf-8")
    return RSS._obfuscate(plaintext, master_key)


def obfuscate_blob(data: dict, master_key: bytes) -> bytes:
    """Obfuscate a staging blob."""
    plaintext = json.dumps(data, indent=2).encode("utf-8")
    return RSS._obfuscate(plaintext, master_key)


# ─── Main ───────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Push test ledger to Worker")
    parser.add_argument(
        "--ledger", type=str,
        default=str(PROJECT_ROOT / "testdata" / "ledger.json"),
        help="Path to ledger.json"
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="Print what would be pushed, don't push"
    )
    args = parser.parse_args()

    # Read ledger
    ledger_path = Path(args.ledger)
    if not ledger_path.exists():
        print(f"❌ Ledger not found: {ledger_path}")
        return 1

    with open(ledger_path) as f:
        ledger = json.load(f)

    genesis = ledger[0]
    seed_enc = genesis["identity"]["recovery_seed_enc"]
    username = genesis["identity"]["username"]

    print(f"📦 Test Ledger Push")
    print(f"   Username: {username}")
    print(f"   Blocks:   {len(ledger)}")

    if args.dry_run:
        print("   [DRY RUN — no changes will be made]")
        return 0

    # Build hash_index (plaintext list of block hashes)
    hash_index = []
    for block in ledger:
        h = block.get("block_hash") or block.get("day_hash")
        if h:
            hash_index.append(h)

    # Build empty index
    index_data = {}

    # Build empty staging blob
    staging_blob = {
        "device_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        "device_proof": "00" * 32,
        "entries": [],
        "updated_at": int(time.time() * 1000),
    }
    device_cookie = b"\x00" * 32

    # We need the seed (Master Key) for obfuscation.
    # But the generator script uses a random seed each time.
    # We need to extract it from the test data or regenerate.
    # For now, try to use the passphrase to derive it.
    #
    # Actually, we don't need the MK for hash_index (plaintext).
    # And for blocks/index/staging, the onboarding client will need to decrypt.
    # Let's push blocks as PLAINTEXT for now — the Worker is for testing.
    # The onboarding flow expects obfuscated blocks, so we should obfuscate.
    #
    # The seed is stored in genesis.identity.recovery_seed_enc, encrypted with PDK.
    # We know the passphrase is '123456789', so we can derive PDK and decrypt the seed.

    try:
        # Derive PDK from passphrase
        identity_pub_key = genesis["identity"]["identity_pub_key"]
        salt = hashlib.sha256(identity_pub_key.encode()).digest()[:16]
        pdk = hashlib.pbkdf2_hmac(
            "sha256", b"123456789", salt, 600000, 32
        )

        # Decrypt the seed
        from security.crypto import CryptoManager
        temp_crypto = CryptoManager(pdk)
        seed_str = temp_crypto.decrypt(seed_enc)
        master_key = __import__('base64').b64decode(seed_str)
        print(f"   Seed:     {seed_str}")
        print(f"   MK len:   {len(master_key)} bytes")
    except Exception as e:
        print(f"⚠️  Could not derive master key: {e}")
        print("   Pushing blocks as plaintext (no obfuscation)")
        master_key = None

    # Push each block
    print("\n📤 Pushing blocks...")
    for i, block in enumerate(ledger):
        filename = f"{i:06d}.json"
        path = f"ledger/blocks/{filename}"

        if master_key:
            data = obfuscate_block(block, master_key)
        else:
            data = json.dumps(block, indent=2).encode("utf-8")

        status = http_put(path, data)
        symbol = "✅" if status == 200 else "❌"
        print(f"   {symbol} {path} ({len(data)} bytes) → HTTP {status}")

    # Push hash_index (plaintext JSON array)
    print("\n📤 Pushing hash_index...")
    hash_index_data = json.dumps(hash_index).encode("utf-8")
    status = http_put("ledger/hash_index.json", hash_index_data)
    print(f"   {'✅' if status == 200 else '❌'} ledger/hash_index.json → HTTP {status}")

    # Push index (obfuscated empty dict)
    print("\n📤 Pushing index...")
    if master_key:
        index_data_enc = obfuscate_blob(index_data, master_key)
    else:
        index_data_enc = json.dumps(index_data).encode()
    status = http_put("ledger/index.json", index_data_enc)
    print(f"   {'✅' if status == 200 else '❌'} ledger/index.json → HTTP {status}")

    # Push staging blobs
    print("\n📤 Pushing staging blobs...")
    if master_key:
        staging_data = obfuscate_blob(staging_blob, master_key)
    else:
        staging_data = json.dumps(staging_blob).encode()
    status = http_put("staging/blobs/current.json", staging_data)
    print(f"   {'✅' if status == 200 else '❌'} staging/blobs/current.json → HTTP {status}")

    status = http_put("staging/blobs/device_cookie.bin", device_cookie)
    print(f"   {'✅' if status == 200 else '❌'} staging/blobs/device_cookie.bin → HTTP {status}")

    print("\n✅ Push complete!")

    # Verify: list all files
    print("\n🔍 Verifying remote state...")
    status, body = http_get("?prefix=")
    if status == 200:
        files = json.loads(body)
        print(f"   Remote has {len(files)} files:")
        for f in files:
            print(f"     {f}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
