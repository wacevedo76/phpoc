#!/usr/bin/env python3
"""
Generate one month of realistic mock staging entries for PH Ledger.

This script creates staging entries spanning June 4, 2026 → July 3, 2026
using the plain: prefix convention so all data is readable without auth.

Usage:
    python3 scripts/generate_mock_data.py              # Default: 1 month
    python3 scripts/generate_mock_data.py --days 14    # 2 weeks
    python3 scripts/generate_mock_data.py --output staging.json  # Custom output
"""

import argparse
import json
import os
import random
import hashlib
import uuid
from datetime import datetime, timedelta
from typing import List, Dict, Any

# ─── Configuration ───────────────────────────────────────────────────────────

# Base epoch for June 4, 2026 (midnight UTC)
# Python: datetime(2026, 6, 4, 0, 0, 0).timestamp() * 1000
BASE_EPOCH_MS = int(datetime(2026, 6, 4, 0, 0, 0).timestamp() * 1000)

# Device UUID — match the existing device from staging
DEVICE_UUID = "bc315840-6975-4fb5-af5d-e907a8600557"

# Daily schedule template — hours are minutes-from-midnight
# Each day template generates entries based on the day of week
DAILY_TEMPLATES = {
    "weekday": [
        # (title, start_min, end_min, tags, comment, weight)
        ("Coffee & Morning Planning", 420, 480, ["morning"], "Morning coffee, reviewing schedule for the day", 0.9),
        ("Getting Gabriel Ready for School", 480, 540, ["parenting", "morning"], "Breakfast, packing lunch, getting dressed", 0.7),
        ("Morning Walk", 540, 600, ["exercise", "morning"], "Morning walk around the neighborhood", 0.6),
        ("Working on phpoc - mobile-poc", 600, 780, ["coding", "software development", "training"], "", 0.95),
        ("Working on phpoc", 600, 780, ["coding", "software development"], "", 0.8),
        ("IT Research - Dart Programming Language", 600, 720, ["research", "learning", "programming"], "Researching Flutter/Dart for mobile port", 0.6),
        ("IT Research - Speech to Text", 600, 690, ["research", "learning"], "Researching speech-to-text integration options", 0.5),
        ("Learning - Linux Compositors - Niri", 600, 690, ["learning", "linux"], "Learning about the Niri compositor", 0.4),
        ("Working on phpoc-web-analysis", 780, 900, ["coding", "software development", "web"], "Working on the web analysis module", 0.5),
        ("Lunch", 780, 840, ["food", "break"], "", 0.9),
        ("TEFL lesson planning - Krystian", 840, 930, ["tefl", "teaching", "work"], "Planning TEFL lessons for Krystian", 0.5),
        ("TEFL lesson - Krystian", 930, 1020, ["tefl", "teaching", "work"], "TEFL lesson with Krystian", 0.5),
        ("General Housework", 1020, 1110, ["housework"], "Tidying, laundry, vacuuming", 0.8),
        ("Tidying - Kitchen and Living Room", 1020, 1080, ["housework", "tidying"], "Washing dishes, wiping counters, tidying up", 0.7),
        ("Vacuuming Livingroom and Kitchen", 1080, 1110, ["housework", "cleaning"], "", 0.5),
        ("Laundry - Hanging Laundry", 1020, 1050, ["housework", "laundry"], "", 0.5),
        ("Cooking - Dinner", 1110, 1200, ["cooking", "housework"], "Preparing dinner for the family", 0.7),
        ("Making Lunch for Gabriel", 1110, 1170, ["cooking", "parenting"], "Preparing Gabriel's lunch", 0.5),
        ("Reading - Human Problem Solving", 1200, 1320, ["reading", "learning", "self-improvement"], "Reading Newell and Simon", 0.6),
        ("Music Practice - Flute", 1200, 1290, ["music", "practice", "hobby"], "", 0.5),
        ("Pushups - 50 reps", 1290, 1320, ["exercise", "fitness"], "Daily pushups", 0.7),
        ("Pilates", 1320, 1410, ["exercise", "fitness"], "", 0.5),
        ("Video game - Hollow Knight", 1320, 1440, ["entertainment", "gaming"], "", 0.8),
        ("YT Learning Workflow with AI", 1320, 1410, ["learning", "ai", "productivity"], "Learning about AI-powered workflows", 0.5),
    ],
    "weekend": [
        ("Coffee & Morning Planning", 480, 540, ["morning"], "Leisurely morning coffee, weekend planning", 0.9),
        ("Morning Walk in the Woods", 540, 660, ["exercise", "morning", "nature"], "Extended morning walk in the woods", 0.7),
        ("Working on phpoc", 660, 840, ["coding", "software development"], "", 0.8),
        ("Learning Scheme", 660, 780, ["learning", "programming"], "Learning the Scheme programming language", 0.5),
        ("Learning Pi", 660, 780, ["learning", "technology"], "Learning about Raspberry Pi", 0.5),
        ("Lunch", 780, 840, ["food", "break"], "", 0.9),
        ("Garden Work - Trim Front Yard Bushes", 840, 960, ["garden", "housework"], "Trimming bushes, weeding", 0.6),
        ("Garden Tidying", 840, 960, ["garden", "housework"], "General garden maintenance", 0.6),
        ("General Housework - Deep Clean", 960, 1080, ["housework", "cleaning"], "Deep cleaning the house", 0.6),
        ("Cooking - Dinner", 1080, 1200, ["cooking", "housework"], "Cooking a nice weekend dinner", 0.7),
        ("Video game - Hollow Knight", 1200, 1380, ["entertainment", "gaming"], "Extended gaming session", 0.8),
        ("Music Practice - Flute", 1200, 1320, ["music", "practice", "hobby"], "", 0.6),
        ("Reading", 1380, 1440, ["reading", "learning"], "Weekend reading", 0.7),
    ],
}

# ─── Helpers ─────────────────────────────────────────────────────────────────

def get_day_template(day_of_week: int) -> str:
    """Return 'weekday' (Mon-Fri) or 'weekend' (Sat-Sun)."""
    return "weekday" if day_of_week < 5 else "weekend"


def compute_hash(data: Dict[str, Any]) -> str:
    """Compute SHA-256 hash of entry data (matches CLI's hash convention)."""
    raw = json.dumps(data, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def make_entry(
    title: str,
    start_epoch_ms: int,
    duration_ms: int,
    tags: List[str],
    comment: str,
) -> Dict[str, Any]:
    """Create a single staging entry in the exact format used by the ledger."""
    end_epoch_ms = start_epoch_ms + duration_ms
    entry_id = str(uuid.uuid4())

    data = {
        "title": title,
        "duration": duration_ms,
        "is_active": False,
        "is_paused": False,
        "startTime_enc": f"plain:{start_epoch_ms}",
        "endTime_enc": f"plain:{end_epoch_ms}",
        "pauses_enc": "plain:[]",
        "metadata_enc": "plain:{}",
        "tags": tags,
        "media": [],
        "entry_id": entry_id,
        "device_uuid_enc": f"plain:{DEVICE_UUID}",
        "end_device_uuid_enc": f"plain:{DEVICE_UUID}",
    }

    if comment:
        data["comment"] = comment

    hash_val = compute_hash(data)

    return {
        "hash": hash_val,
        "data": data,
        "start_epoch": start_epoch_ms,
    }


def add_minutes_to_epoch(base_ms: int, minutes: int) -> int:
    """Add minutes to a base epoch ms timestamp."""
    return base_ms + minutes * 60 * 1000


# ─── Generator ───────────────────────────────────────────────────────────────

def generate_month(
    start_date: datetime,
    num_days: int = 30,
    seed: int = 42,
    avg_entries_per_day: int = 5,
) -> List[Dict[str, Any]]:
    """Generate mock staging entries for the given period."""
    random.seed(seed)
    entries = []

    for day_offset in range(num_days):
        current_date = start_date + timedelta(days=day_offset)
        day_of_week = current_date.weekday()
        template_type = get_day_template(day_of_week)
        template = DAILY_TEMPLATES[template_type]

        # Base epoch ms for this day's midnight
        day_start_epoch = int(datetime(
            current_date.year, current_date.month, current_date.day
        ).timestamp() * 1000)

        # Determine how many entries from template to use
        num_entries = min(
            random.randint(3, max(3, avg_entries_per_day + random.randint(-1, 2))),
            len(template)
        )

        # Pick entries from the template using weighted random selection
        selected_indices = set()
        candidates = list(range(len(template)))
        
        # Always include at least 1 of the high-weight items
        high_weight_indices = [i for i in candidates if template[i][5] >= 0.8]
        if high_weight_indices:
            selected_indices.add(random.choice(high_weight_indices))
        
        # Fill rest with weighted random choices
        while len(selected_indices) < num_entries and candidates:
            remaining = [i for i in candidates if i not in selected_indices]
            if not remaining:
                break
            # Weighted choice
            weights = [template[i][5] for i in remaining]
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

        selected = [template[i] for i in sorted(selected_indices)]

        # Assign times: sort by start_min to avoid overlaps, then add jitter
        selected.sort(key=lambda x: x[1])

        for i, (title, start_min, end_min, tags, comment, _weight) in enumerate(selected):
            # Add small jitter to start times (+/- 5 min)
            jitter = random.randint(-5, 5)
            actual_start = max(0, start_min + jitter)
            
            # Duration in ms (convert minutes to ms, add jitter)
            base_duration_ms = (end_min - start_min) * 60 * 1000
            duration_jitter = random.randint(-300000, 300000)  # +/- 5 min
            actual_duration_ms = max(600000, base_duration_ms + duration_jitter)  # Min 10 min

            start_epoch_ms = add_minutes_to_epoch(day_start_epoch, actual_start)

            # Pick a personalized comment 30% of the time
            final_comment = comment
            if not final_comment and random.random() < 0.3:
                day_comments = {
                    "Working on phpoc - mobile-poc": "Working on the mobile proof-of-concept port",
                    "Working on phpoc": "Debugging and testing the sync algorithm",
                    "Coffee & Morning Planning": "Reviewing today's tasks and priorities",
                    "Pilates": "Daily Pilates routine",
                    "Pushups - 50 reps": "Daily pushup routine",
                    "Music Practice - Flute": "Practicing scales and a new piece",
                    "Video game - Hollow Knight": "Exploring the City of Tears",
                }
                final_comment = day_comments.get(title, "")

            entry = make_entry(title, start_epoch_ms, actual_duration_ms, tags, final_comment)
            entries.append(entry)

    return entries


# ─── Statistics ──────────────────────────────────────────────────────────────

def print_stats(entries: List[Dict[str, Any]], num_days: int):
    """Print statistics about the generated data."""
    total_entries = len(entries)
    total_duration_h = sum(e["data"]["duration"] for e in entries) / 3600000
    
    # Count by title
    from collections import Counter
    title_counts = Counter(e["data"]["title"] for e in entries)
    tag_counts = Counter()
    for e in entries:
        for tag in e["data"]["tags"]:
            tag_counts[tag] += 1

    per_day = total_entries / num_days
    per_day_h = total_duration_h / num_days

    print(f"\n{'='*60}")
    print(f"📊 Mock Data Summary")
    print(f"{'='*60}")
    print(f"  Period:          {num_days} days")
    print(f"  Total entries:   {total_entries}")
    print(f"  Avg entries/day: {per_day:.1f}")
    print(f"  Total hours:     {total_duration_h:.1f}h")
    print(f"  Avg hours/day:   {per_day_h:.1f}h")
    print(f"\n📋 Activities by frequency:")
    for title, count in title_counts.most_common(10):
        hours = sum(
            e["data"]["duration"] for e in entries if e["data"]["title"] == title
        ) / 3600000
        print(f"  {count:3d}x  {title:45s}  {hours:5.1f}h")
    print(f"\n🏷️  Tags by frequency:")
    for tag, count in tag_counts.most_common(10):
        print(f"  {count:3d}x  {tag}")


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Generate one month of realistic mock staging entries for PH Ledger"
    )
    parser.add_argument(
        "--days", type=int, default=30,
        help="Number of days to generate (default: 30)"
    )
    parser.add_argument(
        "--start-date", type=str, default="2026-06-04",
        help="Start date in YYYY-MM-DD format (default: 2026-06-04)"
    )
    parser.add_argument(
        "--output", type=str, default=None,
        help="Output file path (default: prints to stdout, use --apply to write to staging)"
    )
    parser.add_argument(
        "--apply", action="store_true",
        help="Write to the user's staging.json (makes data visible to ph CLI)"
    )
    parser.add_argument(
        "--seed", type=int, default=42,
        help="Random seed for reproducibility (default: 42)"
    )
    parser.add_argument(
        "--avg-entries", type=int, default=5,
        help="Average entries per day (default: 5)"
    )
    parser.add_argument(
        "--stats", action="store_true", default=True,
        help="Print statistics (default: True)"
    )
    args = parser.parse_args()

    # Parse start date
    try:
        start_date = datetime.strptime(args.start_date, "%Y-%m-%d")
    except ValueError:
        print(f"❌ Invalid date format: {args.start_date}. Use YYYY-MM-DD.")
        return

    # Generate entries
    print(f"🔄 Generating {args.days} days of mock data starting {args.start_date}...")
    entries = generate_month(
        start_date=start_date,
        num_days=args.days,
        seed=args.seed,
        avg_entries_per_day=args.avg_entries,
    )

    if args.stats:
        print_stats(entries, args.days)

    # Output
    if args.apply:
        # Find the staging.json path
        staging_paths = [
            os.path.expanduser("~/.local/share/phpoc/staging.json"),
            os.path.expanduser("~/.config/personal_history_poc/staging.json"),
        ]
        staging_path = None
        for p in staging_paths:
            if os.path.exists(os.path.dirname(p)):
                staging_path = p
                break
            if os.path.exists(p):
                staging_path = p
                break
        
        if not staging_path:
            staging_path = staging_paths[0]
            os.makedirs(os.path.dirname(staging_path), exist_ok=True)

        # Read existing staging entries (keep them, append new ones)
        existing = []
        if os.path.exists(staging_path):
            try:
                with open(staging_path) as f:
                    existing = json.load(f)
                print(f"📂 Found existing staging with {len(existing)} entries. Appending...")
            except (json.JSONDecodeError, Exception):
                print(f"⚠️  Could not read existing staging, starting fresh.")

        # Merge: keep existing entries + new mock entries
        all_entries = existing + entries
        with open(staging_path, "w") as f:
            json.dump(all_entries, f, indent=2)

        print(f"\n✅ Wrote {len(entries)} new entries to {staging_path}")
        print(f"   Total staging entries: {len(all_entries)}")
        print(f"   Run 'ph list' or 'ph view' to see the data.")
        print(f"   Run 'ph sync' to commit entries to the ledger chain.")
    elif args.output:
        with open(args.output, "w") as f:
            json.dump(entries, f, indent=2)
        print(f"\n✅ Wrote {len(entries)} entries to {args.output}")
    else:
        print(json.dumps(entries, indent=2))


if __name__ == "__main__":
    main()
