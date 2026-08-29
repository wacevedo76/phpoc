#!/usr/bin/env python3
"""
Generate a test ledger for onboarding and integration testing.

Creates a fully valid PHPOC ledger with 1 month of entries using
the project's own crypto modules. Outputs ledger.json and a summary
of credentials (seed, passphrase, etc.).

Usage:
    python3 /tmp/generate_test_ledger.py
    python3 /tmp/generate_test_ledger.py --days 30 --output /path/to/output/
"""

import argparse
import base64
import hashlib
import hmac
import json
import os
import random
import sys
import time
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import List, Dict, Any, Optional

# Ensure we can import project modules
SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = Path("/home/wacevedo/code/Testing/phpoc")
sys.path.insert(0, str(PROJECT_ROOT))

from security.crypto import CryptoManager
from security.recovery import RecoveryManager
from domain.ledger.chain import compute_seal



# ═══════════════════════════════════════════════════════════════════════
# Configuration
# ═══════════════════════════════════════════════════════════════════════

USERNAME = "Test User01"
PASSPHRASE = "123456789"
EMAIL = "test@phpoc.test"

# Base epoch for entries (June 2026)
BASE_DATE = datetime(2026, 6, 1)

# Device UUID for the test device
DEVICE_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

# ─── Activity templates (similar to generate_mock_data.py) ───

DAILY_TEMPLATES = {
    "weekday": [
        ("Coffee & Morning Planning", 420, 480, ["morning"], 0.9),
        ("Morning Commute", 480, 510, ["travel", "morning"], 0.8),
        ("Working on Project Alpha", 510, 660, ["coding", "work"], 0.95),
        ("Team Standup Meeting", 570, 600, ["meetings", "work"], 0.85),
        ("Lunch Break", 690, 750, ["food", "break"], 0.9),
        ("Working on Project Alpha", 750, 900, ["coding", "work"], 0.9),
        ("Code Review", 780, 810, ["coding", "work", "meetings"], 0.6),
        ("Afternoon Walk", 900, 930, ["exercise", "health"], 0.6),
        ("Email & Admin", 930, 990, ["admin", "work"], 0.7),
        ("Learning - Rust Programming", 990, 1050, ["learning", "programming"], 0.7),
        ("Dinner", 1080, 1140, ["food"], 0.9),
        ("Reading - Technical Books", 1140, 1260, ["reading", "learning"], 0.6),
        ("Evening Exercise", 1200, 1260, ["exercise", "health"], 0.5),
        ("Video Games", 1260, 1380, ["entertainment", "gaming"], 0.6),
    ],
    "weekend": [
        ("Coffee & Morning Planning", 480, 540, ["morning"], 0.9),
        ("Morning Walk in the Park", 540, 660, ["exercise", "nature", "health"], 0.8),
        ("Working on Side Project", 660, 840, ["coding", "hobby"], 0.8),
        ("Reading", 660, 780, ["reading", "learning"], 0.7),
        ("Brunch with Friends", 600, 720, ["food", "social"], 0.5),
        ("Garden Work", 840, 960, ["garden", "housework"], 0.6),
        ("House Cleaning", 960, 1080, ["housework", "cleaning"], 0.7),
        ("Lunch", 780, 840, ["food", "break"], 0.9),
        ("Dinner", 1080, 1200, ["food"], 0.9),
        ("Video Games", 1200, 1380, ["entertainment", "gaming"], 0.8),
        ("Music Practice", 1200, 1290, ["music", "hobby"], 0.6),
        ("Movie Night", 1260, 1440, ["entertainment"], 0.5),
    ],
}


# ═══════════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════════

def get_day_template(day_of_week: int) -> str:
    return "weekday" if day_of_week < 5 else "weekend"


def compute_entry_hash(data: Dict[str, Any]) -> str:
    raw = json.dumps(data, sort_keys=True).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


# ═══════════════════════════════════════════════════════════════════════
# Entry generation
# ═══════════════════════════════════════════════════════════════════════

def generate_month_entries(
    start_date: datetime,
    num_days: int = 30,
    seed: int = 42,
    avg_entries_per_day: int = 6,
) -> List[Dict[str, Any]]:
    """Generate staging-style entries for the given period."""
    random.seed(seed)
    entries = []

    for day_offset in range(num_days):
        current_date = start_date + timedelta(days=day_offset)
        day_of_week = current_date.weekday()
        template_type = get_day_template(day_of_week)
        template = DAILY_TEMPLATES[template_type]

        # Midnight epoch ms for this day
        day_start_epoch = int(datetime(
            current_date.year, current_date.month, current_date.day
        ).timestamp() * 1000)

        # Pick entries using weighted random selection
        num_entries = min(
            random.randint(3, max(3, avg_entries_per_day + random.randint(-1, 2))),
            len(template),
        )
        selected_indices = set()
        candidates = list(range(len(template)))

        high_weight = [i for i in candidates if template[i][4] >= 0.8]
        if high_weight:
            selected_indices.add(random.choice(high_weight))

        while len(selected_indices) < num_entries and candidates:
            remaining = [i for i in candidates if i not in selected_indices]
            if not remaining:
                break
            weights = [template[i][4] for i in remaining]
            total = sum(weights)
            r = random.random() * total
            cumulative = 0
            chosen = remaining[0]
            for i, w in zip(remaining, weights):
                cumulative += w
                if r <= cumulative:
                    chosen = i
                    break
            selected_indices.add(chosen)

        selected = sorted(
            [template[i] for i in selected_indices], key=lambda x: x[1]
        )

        for title, start_min, end_min, tags, _weight in selected:
            jitter = random.randint(-5, 5)
            actual_start = max(0, start_min + jitter)
            base_duration_ms = (end_min - start_min) * 60 * 1000
            duration_jitter = random.randint(-300000, 300000)
            actual_duration_ms = max(600000, base_duration_ms + duration_jitter)

            start_epoch_ms = day_start_epoch + actual_start * 60 * 1000
            end_epoch_ms = start_epoch_ms + actual_duration_ms

            entry = {
                "title": title,
                "duration": actual_duration_ms,
                "is_active": False,
                "is_paused": False,
                "start_epoch": start_epoch_ms,
                "end_epoch": end_epoch_ms,
                "tags": sorted(tags),
                "media": [],
                "comment": "",
                "pauses": [],
                "metadata": {},
            }
            entries.append(entry)

    return entries


# ═══════════════════════════════════════════════════════════════════════
# Genesis block creation
# ═══════════════════════════════════════════════════════════════════════

def create_genesis_block(
    crypto: CryptoManager,
    seed: str,
    pdk: bytes,
    identity_secret: bytes,
    date_str: str,
) -> dict:
    """Create a genesis block matching LedgerFactory.initialize() output."""
    identity_pub_key = hashlib.sha256(identity_secret).hexdigest()
    encrypted_seed = RecoveryManager.encrypt_seed(seed, pdk)
    encrypted_identity = crypto.encrypt(identity_secret.hex())

    genesis = {
        "type": "genesis",
        "day_index": 0,
        "date": date_str,
        "identity": {
            "username": USERNAME,
            "email": EMAIL,
            "recovery_seed_enc": encrypted_seed,
            "identity_pub_key": identity_pub_key,
            "identity_secret_enc_fallback": encrypted_identity,
        },
        "prev_hash": "0" * 64,
        "entries": [],
        "signature": "",
    }

    # Seal over the ADR-029a per-type whitelist (excludes identity, signature)
    genesis["block_hash"] = compute_seal(crypto, genesis)
    genesis["identity_seal"] = crypto.mac(genesis["block_hash"], identity_secret)

    return genesis


# ═══════════════════════════════════════════════════════════════════════
# Day block creation (mimics LedgerEngine._commit_day / _prepare_entries)
# ═══════════════════════════════════════════════════════════════════════

def encrypt_entry_fields(entry: dict, crypto: CryptoManager) -> dict:
    """Encrypt entry fields exactly as LedgerEngine._prepare_entries does."""
    data = dict(entry)

    start_epoch = data.pop("start_epoch", 0)
    end_epoch = data.pop("end_epoch", None)
    metadata = data.pop("metadata", {})
    pauses = data.pop("pauses", [])
    duration = data.get("duration", 0)

    if end_epoch is None and duration > 0:
        end_epoch = start_epoch + duration

    data["startTime_enc"] = crypto.encrypt(str(start_epoch))
    data["endTime_enc"] = (
        crypto.encrypt(str(end_epoch)) if end_epoch is not None else None
    )
    data["metadata_enc"] = crypto.encrypt(json.dumps(metadata or {}))
    data["pauses_enc"] = crypto.encrypt(json.dumps(pauses))

    # Compute content hash (extensible algorithm from PHPSPEC §6.1)
    data["content_hash"] = compute_content_hash(data, crypto)

    # Compute entry hash
    entry_hash = hashlib.sha256(
        json.dumps(data, sort_keys=True).encode()
    ).hexdigest()

    return {"hash": entry_hash, "data": data}


def compute_content_hash(entry_data: dict, crypto: CryptoManager) -> str:
    """Compute extensible content hash (PHPSPEC §5.5/§6.1).

    Decrypts _enc fields, KEEPING the _enc suffix on the canonical key name
    and KEEPING the decrypted value as a string, so the hash is byte-identical
    across Python/Web/Flutter.
    """
    content = {}
    for key, value in entry_data.items():
        if key == "content_hash":
            continue
        if key.endswith("_enc") and value is not None and value != "":
            try:
                content[key] = crypto.decrypt(value)
            except Exception:
                content[key] = value
        elif isinstance(value, list):
            content[key] = sorted(value) if all(isinstance(x, str) for x in value) else value
        else:
            content[key] = value
    return hashlib.sha256(
        json.dumps(content, sort_keys=True).encode()
    ).hexdigest()


def build_day_block(
    crypto: CryptoManager,
    identity_secret: bytes,
    date_str: str,
    day_index: int,
    prev_hash: str,
    entries: list,
) -> dict:
    """Build a sealed day block."""
    block = {
        "type": "day",
        "day_index": day_index,
        "date": date_str,
        "prev_hash": prev_hash,
        "entries": entries,
    }

    block["block_hash"] = compute_seal(crypto, block)
    block["identity_seal"] = crypto.mac(block["block_hash"], identity_secret)

    return block


# ═══════════════════════════════════════════════════════════════════════
# Full ledger builder
# ═══════════════════════════════════════════════════════════════════════

def build_test_ledger(
    num_days: int = 30,
    seed_str: Optional[str] = None,
) -> tuple:
    """
    Build a complete test ledger.

    Returns:
        (ledger_blocks, seed_str, identity_secret)
    """
    # 1. Generate seed
    if seed_str is None:
        seed_str = RecoveryManager.generate_recovery_seed()
    mk = RecoveryManager.seed_to_key(seed_str)

    # 2. Generate identity first so we can derive per-user salt
    identity_secret = os.urandom(32)
    identity_pub_key = hashlib.sha256(identity_secret).hexdigest()

    # 3. Derive PDK with per-user salt (fresh ledger, no legacy needed)
    pdk = hashlib.pbkdf2_hmac(
        "sha256",
        PASSPHRASE.encode("utf-8"),
        hashlib.sha256(identity_pub_key.encode()).digest()[:16],
        600000,
        32,
    )

    # 4. Create crypto manager
    crypto = CryptoManager(mk)

    # 5. Create genesis
    genesis_date = BASE_DATE.strftime("%Y-%m-%d")
    genesis = create_genesis_block(crypto, seed_str, pdk, identity_secret, genesis_date)

    ledger = [genesis]
    prev_hash = genesis["block_hash"]

    # 6. Generate entries
    all_entries = generate_month_entries(BASE_DATE, num_days=num_days)

    # 7. Group by date
    from collections import defaultdict
    days = defaultdict(list)
    for entry in all_entries:
        start_ms = entry["start_epoch"]
        date_str = datetime.fromtimestamp(start_ms / 1000).strftime("%Y-%m-%d")
        days[date_str].append(entry)

    # 8. Build day blocks
    last_month = None
    day_index = 1
    for date_str in sorted(days.keys()):
        month = date_str[:7]

        # Insert month summary if crossing month boundary
        if last_month is not None and month != last_month:
            summary = {
                "type": "month_summary",
                "month": last_month,
                "prev_hash": prev_hash,
                "date": date_str,
            }
            summary_json = json.dumps(
                {k: v for k, v in summary.items() if k != "block_hash"},
                sort_keys=True,
            )
            summary["block_hash"] = crypto.seal(summary_json)
            summary["identity_seal"] = crypto.mac(
                summary["block_hash"], identity_secret
            )
            ledger.append(summary)
            prev_hash = summary["block_hash"]
            day_index = 1

        # Encrypt entries
        encrypted_entries = []
        for entry in days[date_str]:
            encrypted_entries.append(encrypt_entry_fields(entry, crypto))

        # Build day block
        day_block = build_day_block(
            crypto, identity_secret, date_str, day_index,
            prev_hash, encrypted_entries,
        )
        ledger.append(day_block)
        prev_hash = day_block["block_hash"]
        day_index += 1
        last_month = month

    return ledger, seed_str, identity_secret, pdk


# ═══════════════════════════════════════════════════════════════════════
# Verification
# ═══════════════════════════════════════════════════════════════════════

def verify_ledger(ledger: list, mk: bytes, identity_secret: bytes) -> bool:
    """Verify the ledger chain (subset of full verification)."""
    crypto = CryptoManager(mk)
    # Check genesis prev_hash
    assert ledger[0]["prev_hash"] == "0" * 64, "Genesis prev_hash must be all zeros"

    for i in range(1, len(ledger)):
        current = ledger[i]
        prev = ledger[i - 1]
        prev_hash = prev.get("block_hash") or prev.get("day_hash")
        if current["prev_hash"] != prev_hash:
            print(f"\n  ❌ Block {i}: prev_hash mismatch")
            print(f"     prev type: {prev.get('type')}, hash: {prev_hash[:16]}...")
            print(f"     curr type: {current.get('type')}, prev_hash: {current['prev_hash'][:16]}...")
            return False

        # Verify seal over ADR-029a per-type whitelist (excludes identity)
        hash_key = "block_hash"
        expected = compute_seal(crypto, current)
        if current[hash_key] != expected:
            print(f"\n  ❌ Block {i}: seal mismatch")
            return False

        # Verify entry hashes
        if current.get("type", "day") == "day":
            for j, entry in enumerate(current.get("entries", [])):
                expected_hash = hashlib.sha256(
                    json.dumps(entry["data"], sort_keys=True).encode()
                ).hexdigest()
                if entry["hash"] != expected_hash:
                    print(f"  ❌ Block {i} entry {j}: hash mismatch")
                    return False
    return True


# ═══════════════════════════════════════════════════════════════════════
# Per-user salt upgrade (what CLI does on first auth after init)
# ═══════════════════════════════════════════════════════════════════════

# ═══════════════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(
        description="Generate a test PHPOC ledger with 1 month of entries"
    )
    parser.add_argument(
        "--days", type=int, default=30,
        help="Number of days of entries (default: 30)"
    )
    parser.add_argument(
        "--output", type=str, default="/tmp/phpoc_test_ledger",
        help="Output directory (default: /tmp/phpoc_test_ledger)"
    )
    parser.add_argument(
        "--seed", type=str, default=None,
        help="Specific seed to use (base64, default: random)"
    )
    parser.add_argument(
        "--verify", action="store_true", default=True,
        help="Verify the ledger after creation (default: True)"
    )
    args = parser.parse_args()

    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"🔨 Building test ledger ({args.days} days)...")
    print(f"   Username:  {USERNAME}")
    print(f"   Passphrase: {PASSPHRASE}")

    ledger, seed_str, identity_secret, pdk = build_test_ledger(
        num_days=args.days,
        seed_str=args.seed,
    )

    mk = RecoveryManager.seed_to_key(seed_str)

    # Verify
    if args.verify:
        print("🔍 Verifying ledger chain...")
        try:
            verify_ledger(ledger, mk, identity_secret)
            print("   ✅ Ledger chain verified successfully")
        except AssertionError as e:
            print(f"   ❌ Verification failed: {e}")
            sys.exit(1)

    # Write files
    ledger_path = output_dir / "ledger.json"
    ledger_path.write_text(json.dumps(ledger, indent=2))

    identity_secret_enc = CryptoManager(mk).encrypt(identity_secret.hex())
    identity_path = output_dir / "identity.json"
    identity_path.write_text(
        json.dumps({"identity_secret_enc": identity_secret_enc}, indent=2)
    )

    # Stats
    day_blocks = [b for b in ledger if b.get("type", "day") == "day"]
    total_entries = sum(len(b.get("entries", [])) for b in day_blocks)
    total_hours = sum(
        e["data"]["duration"]
        for b in day_blocks
        for e in b.get("entries", [])
    ) / 3_600_000

    print(f"\n📊 Ledger Summary:")
    print(f"   Blocks:      {len(ledger)} ({len(day_blocks)} day blocks)")
    print(f"   Entries:     {total_entries}")
    print(f"   Total hours: {total_hours:.1f}h")
    print(f"   Date range:  {day_blocks[0]['date']} → {day_blocks[-1]['date']}")

    # Credentials summary
    identity_pub_key = ledger[0]["identity"]["identity_pub_key"]
    genesis_hash = ledger[0]["block_hash"]

    print(f"\n🔑 Credentials (SAVE THESE):")
    print(f"   Seed:        {seed_str}")
    print(f"   Passphrase:  {PASSPHRASE}")
    print(f"   Username:    {USERNAME}")
    print(f"   Identity:    {identity_pub_key}")
    print(f"   Genesis:     {genesis_hash}")
    print(f"\n💾 Files written to: {output_dir}/")
    print(f"   {ledger_path}")
    print(f"   {identity_path}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
