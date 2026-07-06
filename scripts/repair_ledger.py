#!/usr/bin/env python3
"""Repair a broken ledger chain from a local file — no network, no seed.

Reads a ledger JSON file (raw chain array or v2 export format), verifies
prev_hash linkage across all blocks, identifies break points, and exports
a clean file containing only the consistent prefix.

Outputs a raw JSON array (CLI ledger.json format) so phpoc-web can import
it via the _importRawChain path. Each block carries its own internal seal,
so no file-level seal or passphrase is needed.

Usage:
    python3 scripts/repair_ledger.py <ledger_file> [--output FILE]

Input formats accepted:
    - Raw chain: JSON array of block dicts
    - v2 export: {"format_version":"2.0", "ledger": [...], ...}

Examples:
    # Repair and auto-name output
    python3 scripts/repair_ledger.py broken_ledger.json

    # Specify output path
    python3 scripts/repair_ledger.py broken_ledger.json -o repaired.json

    # Also save orphaned blocks
    python3 scripts/repair_ledger.py broken_ledger.json --export-orphans
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone


def get_block_hash(block):
    """Return the canonical hash for a block of any type."""
    return (
        block.get("block_hash")
        or block.get("day_hash")
        or block.get("month_hash")
        or block.get("year_hash")
        or ""
    )


def load_chain(path):
    """Load a ledger chain from a file. Accepts raw array or v2 export format."""
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)

    # v2 export format: {"format_version": "2.0", "ledger": [...]}
    if isinstance(data, dict) and "ledger" in data:
        return data["ledger"]

    # Raw chain array
    if isinstance(data, list):
        return data

    raise ValueError(f"Unknown file format. Expected JSON array or v2 export dict, got {type(data).__name__}")


def diagnose_chain(blocks):
    """Verify prev_hash linkage and return break points.

    Returns:
        dict with:
          total_blocks: int
          consistent_prefix: int (number of blocks in valid chain prefix)
          break_points: list of {index, expected_hash, actual_prev_hash, block_type, block_date}
          genesis_info: dict with type/date/hash/identity summary
    """
    result = {
        "total_blocks": len(blocks),
        "consistent_prefix": len(blocks),  # optimistic
        "break_points": [],
        "genesis_info": None,
    }

    if len(blocks) == 0:
        result["consistent_prefix"] = 0
        return result

    # Genesis info
    g = blocks[0]
    result["genesis_info"] = {
        "type": g.get("type", "unknown"),
        "date": g.get("date", "unknown"),
        "hash": get_block_hash(g),
        "hash_key": "block_hash" if g.get("block_hash") else "day_hash",
        "username": (g.get("identity", {}) or {}).get("username", "unknown"),
        "email": (g.get("identity", {}) or {}).get("email", "unknown"),
    }

    # Check linkage
    for i in range(1, len(blocks)):
        prev = blocks[i - 1]
        curr = blocks[i]
        prev_hash = get_block_hash(prev)
        curr_prev = curr.get("prev_hash", "")

        if curr_prev != prev_hash:
            result["break_points"].append({
                "index": i,
                "expected_hash": prev_hash,
                "actual_prev_hash": curr_prev,
                "block_type": curr.get("type", "day"),
                "block_date": curr.get("date", "unknown"),
            })
            if i < result["consistent_prefix"]:
                result["consistent_prefix"] = i

    return result


def export_clean_chain(blocks, keep_count, output_path, total_original):
    """Export the first `keep_count` blocks as a raw JSON array.

    This is the native CLI ledger.json format. phpoc-web imports it via
    _importRawChain, which validates each block's own internal seal using
    the master key derived from passphrase+seed during onboarding. No
    file-level seal is needed.
    """
    clean_blocks = blocks[:keep_count]

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(clean_blocks, f, indent=2, ensure_ascii=False)

    return output_path


def export_orphaned_blocks(blocks, keep_count, output_path):
    """Export orphaned blocks for forensic review."""
    orphaned = blocks[keep_count:]
    if not orphaned:
        return None

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(orphaned, f, indent=2, ensure_ascii=False)

    return output_path


def main():
    parser = argparse.ArgumentParser(
        description="Repair a broken ledger chain from a local file (no network, no seed).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
After repair:
  1. Import the repaired file into phpoc-web (Onboarding → Import File)
  2. Enter your passphrase + recovery seed when prompted
  3. Clear the remote R2 storage
  4. Push the clean chain to R2
        """,
    )
    parser.add_argument(
        "ledger_file",
        help="Path to the broken ledger JSON file (raw chain array or v2 export format)",
    )
    parser.add_argument(
        "--output", "-o",
        default=None,
        help="Output path for repaired ledger (default: <input>_repaired.json)",
    )
    parser.add_argument(
        "--export-orphans",
        action="store_true",
        help="Also export orphaned blocks for forensic review",
    )

    args = parser.parse_args()

    input_path = os.path.abspath(args.ledger_file)
    if not os.path.exists(input_path):
        print(f"ERROR: File not found: {input_path}")
        sys.exit(1)

    # ── Load ─────────────────────────────────────────────────────
    print(f"Loading: {input_path}")
    try:
        blocks = load_chain(input_path)
    except (json.JSONDecodeError, ValueError) as e:
        print(f"ERROR: {e}")
        sys.exit(1)

    print(f"Loaded {len(blocks)} blocks")

    # ── Diagnose ─────────────────────────────────────────────────
    print("\n=== Diagnosing chain integrity ===")
    diag = diagnose_chain(blocks)

    print(f"Total blocks:   {diag['total_blocks']}")
    print(f"Genesis:        {diag['genesis_info']['type']} | "
          f"{diag['genesis_info']['date']} | "
          f"user={diag['genesis_info']['username']}")

    if diag["break_points"]:
        print(f"\n❌ CHAIN BROKEN — {len(diag['break_points'])} break(s) found:")
        for bp in diag["break_points"]:
            print(f"  Block {bp['index']} ({bp['block_type']}, {bp['block_date']}):")
            print(f"    Expected prev_hash:  {bp['expected_hash'][:16]}...")
            print(f"    Actual prev_hash:    {bp['actual_prev_hash'][:16]}...")
        print(f"\n  Consistent prefix: blocks 0–{diag['consistent_prefix'] - 1} "
              f"({diag['consistent_prefix']} block{'s' if diag['consistent_prefix'] > 1 else ''})")
        print(f"  Orphaned: blocks {diag['consistent_prefix']}–{diag['total_blocks'] - 1} "
              f"({diag['total_blocks'] - diag['consistent_prefix']} blocks)")
    else:
        print("\n✅ Chain is consistent — all prev_hash links valid.")

    # ── Determine keep count ─────────────────────────────────────
    keep_count = diag["consistent_prefix"]
    if keep_count == 0 and len(blocks) > 0:
        keep_count = 1
        print("\n⚠️  Genesis itself may be malformed — keeping it for recovery.")

    # ── Determine output path ────────────────────────────────────
    if args.output:
        output_path = args.output
    else:
        base, ext = os.path.splitext(input_path)
        output_path = f"{base}_repaired{ext}"

    # ── Export ───────────────────────────────────────────────────
    print(f"\n=== Exporting clean chain ({keep_count} blocks) ===")
    export_path = export_clean_chain(blocks, keep_count, output_path, len(blocks))
    file_size = os.path.getsize(export_path)
    print(f"Exported: {export_path} ({file_size:,} bytes)")

    # ── Export orphans ─────────────────────────────────────────
    if args.export_orphans and keep_count < len(blocks):
        orphans_path = output_path.replace(".json", "_orphaned.json")
        orphans_exported = export_orphaned_blocks(blocks, keep_count, orphans_path)
        if orphans_exported:
            print(f"Orphans:  {orphans_path} ({os.path.getsize(orphans_path):,} bytes)")

    # ── Summary ──────────────────────────────────────────────────
    print("\n" + "=" * 60)
    print("REPAIR COMPLETE")
    print("=" * 60)

    if keep_count < len(blocks):
        print(f"\n⚠️  {len(blocks) - keep_count} blocks were orphaned (different genesis).")
        print(f"  They have been excluded from the repaired file.")
    else:
        print(f"\n✅ No repair needed — all {len(blocks)} blocks are consistent.")

    print()
    print("Format: raw JSON array (CLI ledger.json — compatible with phpoc-web Import File)")
    print()
    print("Next steps:")
    print(f"  1. Import {os.path.basename(export_path)} into phpoc-web (Onboarding → Import File)")
    print(f"  2. Enter your passphrase + recovery seed when prompted")
    print(f"  3. Clear the remote R2 storage")
    print(f"  4. Push the clean chain to R2 (auto-sync on first commit)")


if __name__ == "__main__":
    main()
