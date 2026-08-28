#!/usr/bin/env python3
"""Apply the Aug-7 doubling remediation (deduped chain) to remote R2.

Force-push the *already-repaired* chain to R2 (overwriting re-sealed blocks and
adding any new tail blocks), then regenerate and push the two remote indexes
(``ledger/hash_index.json`` + ``.sha256`` and ``ledger/index.json``) so remote
fork-detection and the blind summary stay consistent with the new chain.

The repaired chain is read from ``--input`` (default the repair script's output
``/tmp/2026-08-27-ledger-repaired.json``). It must be the OUTPUT of
``scripts/repair_ledger_same_start_dedup.py``. This script re-verifies it
(VALID chain + 0 same-start-ms duplicates) before touching anything.

Credentials come from ``TEST_CREDENTIALS.md`` (same source as the repair
script), or via ``--worker-url`` / ``--api-key`` / ``--seed`` overrides.

SAFETY
------
* Dry-run by default — lists the exact PUT plan against the remote and exits
  WITHOUT writing. Only ``--apply`` performs writes, and only after an explicit
  interactive confirmation (bypass with ``--yes``).
* Blocks are compared by seal (``get_block_hash``) against the ACTUAL remote
  blocks (full read-only pull), so identical blocks are skipped and only
  genuinely changed / new blocks are written.
* Remote blocks BEYOND the repaired chain are reported but never deleted —
  this repair removes entries, not blocks.

Usage:
    python3 scripts/apply_ledger_repair_r2.py                       # dry-run
    python3 scripts/apply_ledger_repair_r2.py --input /path/repaired.json
    python3 scripts/apply_ledger_repair_r2.py --apply               # write to R2
    python3 scripts/apply_ledger_repair_r2.py --apply --yes         # non-interactive
"""
import argparse
import base64
import hashlib
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PROJECT_ROOT)

from domain.ledger.helpers import get_block_hash
from domain.ledger.remote_sync import RemoteLedgerSync
from security.crypto import CryptoManager
from scripts.repair_ledger_same_start_dedup import (
    build_global_dedup,
    read_personal_creds,
)
from scripts.verify_ledger import Verifier

USER_AGENT = "phpoc-repair/1.0"


class UrllibTransport:
    """Minimal urllib transport speaking the Worker's HTTP API.

    Mirrors the repair script's read path (custom User-Agent to avoid
    Cloudflare 403, X-Api-Key auth) and adds PUT/DELETE for writes.
    Implements the 3 methods ``RemoteLedgerSync`` uses: pull/push/list_files.
    """

    def __init__(self, base_url: str, api_key: str):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key

    def _open(self, method: str, path: str, body: bytes = None):
        u = self.base_url + "/" + path.lstrip("/")
        headers = {"X-Api-Key": self.api_key, "User-Agent": USER_AGENT}
        req = urllib.request.Request(u, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def pull(self, path: str, timeout_ms: int = None):
        status, body = self._open("GET", path)
        if status == 404:
            return None
        if status == 200:
            return body
        raise RuntimeError(f"HTTP {status} pulling {path}: {body[:200]!r}")

    def push(self, path: str, data: bytes, timeout_ms: int = None):
        status, body = self._open("PUT", path, body=data)
        if 200 <= status < 300:
            return
        raise RuntimeError(f"HTTP {status} pushing {path}: {body[:200]!r}")

    def list_files(self, prefix: str, timeout_ms: int = None):
        u = self.base_url + "/?" + urllib.parse.urlencode({"prefix": prefix})
        headers = {"X-Api-Key": self.api_key, "User-Agent": USER_AGENT}
        req = urllib.request.Request(u, headers=headers)
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode())


def build_blind_index(blocks):
    """Rebuild the blind index ``{date: {title: total_duration_ms}}``.

    Matches ``LedgerEngine.rebuild_index()`` + ``IndexManager.update()``: sums
    each day entry's ``duration`` per (date, title), skipping entries with no
    plaintext title and dropping non-positive totals.
    """
    index = {}
    for b in blocks:
        if b.get("type") != "day":
            continue
        date = b.get("date")
        if not date:
            continue
        for e in b.get("entries", []) or []:
            data = e.get("data") if isinstance(e, dict) else {}
            if not isinstance(data, dict):
                continue
            title = data.get("title", "")
            if not title:
                continue
            try:
                dur = int(data.get("duration", 0) or 0)
            except (TypeError, ValueError):
                dur = 0
            if dur <= 0:
                continue
            d = index.setdefault(date, {})
            d[title] = d.get(title, 0) + dur
    return index


def fmt_ranges(indices):
    """Collapse a sorted list of ints into a compact range string."""
    if not indices:
        return "[]"
    out = []
    start = prev = indices[0]
    for i in indices[1:]:
        if i == prev + 1:
            prev = i
        else:
            out.append(str(start) if start == prev else f"{start}..{prev}")
            start = prev = i
    out.append(str(start) if start == prev else f"{start}..{prev}")
    return "[" + ", ".join(out) + "]"


def load_chain(path):
    if not os.path.exists(path):
        raise SystemExit(f"Input not found: {path}")
    raw = json.load(open(path))
    blocks = raw["ledger"] if isinstance(raw, dict) and "ledger" in raw else raw
    if not isinstance(blocks, list) or not blocks:
        raise SystemExit(f"{path} is not a ledger chain (empty or non-list)")
    return blocks


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", default="/tmp/2026-08-27-ledger-repaired.json",
                    help="repaired chain JSON (output of repair_ledger_same_start_dedup.py --output)")
    ap.add_argument("--worker-url", "--url", help="override Worker URL")
    ap.add_argument("--api-key", help="override Worker API key")
    ap.add_argument("--seed", help="base64 32-byte recovery seed (overrides TEST_CREDENTIALS)")
    ap.add_argument("--apply", action="store_true",
                    help="actually write to R2 (default is dry-run)")
    ap.add_argument("--yes", action="store_true",
                    help="skip interactive confirmation when --apply")
    args = ap.parse_args()

    blocks = load_chain(args.input)
    print(f"Loaded repaired chain: {len(blocks)} blocks")

    url, api_key, seed = read_personal_creds()
    if args.worker_url:
        url = args.worker_url
    if args.api_key:
        api_key = args.api_key
    if args.seed:
        seed = args.seed
    mk = base64.b64decode(seed)
    if len(mk) != 32:
        raise SystemExit("seed must decode to 32 bytes")
    mk_hex = mk.hex()
    crypto = CryptoManager(mk)

    # 1. Re-verify the repaired chain before doing anything.
    print("\n=== Repaired chain verification ===")
    Verifier(blocks, mk_hex, None, False).verify()
    drop, _groups, _order = build_global_dedup(blocks, crypto, mk_hex)
    if drop:
        raise SystemExit(f"Input still has {len(drop)} duplicate seals — not a repaired chain")
    print("  dedup check: 0 same-start-ms duplicates")

    # 2. Connect to remote, list + pull actual blocks (read-only).
    print("\n=== Remote state (read-only) ===")
    print(f"Worker: {url}")
    transport = UrllibTransport(url, api_key)
    ls = RemoteLedgerSync(transport=transport, master_key=mk)

    remote_indices = ls._list_remote_block_indices()
    if not remote_indices:
        raise SystemExit("No remote blocks found — refusing to apply to an empty remote")
    print(f"Remote blocks: {len(remote_indices)} "
          f"(indices {min(remote_indices)}..{max(remote_indices)})")

    print("Pulling remote blocks for comparison...")
    remote_blocks = ls.pull_full_chain()
    remote_hashes = [get_block_hash(b) for b in remote_blocks]
    print(f"Pulled {len(remote_blocks)} remote blocks")

    # 3. Compute the plan by comparing seals.
    repaired_hashes = [get_block_hash(b) for b in blocks]
    to_overwrite, to_add, identical = [], [], []
    for i, rh in enumerate(repaired_hashes):
        if i < len(remote_hashes):
            (identical if remote_hashes[i] == rh else to_overwrite).append(i)
        else:
            to_add.append(i)
    orphans = list(range(len(repaired_hashes), len(remote_hashes)))

    # 4. Preview rebuilt indexes and diagnose the remote hash-index state.
    new_index = build_blind_index(blocks)
    new_hi_json = json.dumps(repaired_hashes).encode("utf-8")
    new_hi_sha = hashlib.sha256(new_hi_json).hexdigest()

    # Probe directly: pull_hash_index() folds "missing .sha256 sidecar" and
    # "missing .json" together into None, so distinguish them for the report.
    hi_raw = transport.pull(RemoteLedgerSync.REMOTE_HASH_INDEX)
    hi_sha_raw = transport.pull(RemoteLedgerSync.REMOTE_HASH_INDEX_SHA256)
    if hi_raw is None:
        old_hi_note = "(none)"
    else:
        try:
            old_hashes = json.loads(hi_raw.decode("utf-8"))
            old_hi_count = len(old_hashes) if isinstance(old_hashes, list) else None
        except Exception:
            old_hi_count = None
        if hi_sha_raw is None:
            old_hi_note = f"{old_hi_count} seals (stale — .sha256 sidecar MISSING)"
        else:
            expected = hashlib.sha256(hi_raw).hexdigest()
            actual = hi_sha_raw.decode("utf-8").strip()
            if expected != actual:
                old_hi_note = f"{old_hi_count} seals (stale — .sha256 MISMATCH)"
            else:
                old_hi_note = f"{old_hi_count} seals (sha256 {actual[:12]}..)"

    # 5. Report the plan.
    print("\n=== Apply plan ===")
    print(f"Blocks identical (skip):          {len(identical)}")
    print(f"Blocks to overwrite (re-sealed):  {len(to_overwrite)}")
    print(f"Blocks to add (new tail):         {len(to_add)}")
    print(f"Remote blocks beyond repaired:    {len(orphans)}")
    if to_overwrite:
        print(f"  overwrite: {fmt_ranges(to_overwrite)}")
    if to_add:
        print(f"  add:       {fmt_ranges(to_add)}")
    if orphans:
        print(f"  ⚠️ remote has extra block(s) {fmt_ranges(orphans)} beyond the "
              f"repaired chain — these will NOT be deleted")
    print(f"hash_index.json: {old_hi_note} -> {len(repaired_hashes)} seals "
          f"(sha256 {new_hi_sha[:12]}..)")
    print(f"index.json: rebuild {len(new_index)} date(s)")

    if not args.apply:
        print("\nDry-run complete — no writes performed.")
        print("Re-run with --apply to write the repaired chain + indexes to R2.")
        return 0

    # 6. Apply (after confirmation).
    if not args.yes:
        ans = input(f"\nWrite {len(to_overwrite) + len(to_add)} block(s) + indexes to R2? "
                    "(y/N): ")
        if ans.strip().lower() != "y":
            print("Cancelled.")
            return 0

    print("\n=== Applying ===")
    pushed = ls.push_blocks(
        blocks,
        existing_indices=set(remote_indices),
        overwrite_indices=set(to_overwrite),
    )
    print(f"Pushed {pushed} block(s)")

    ls.push_hash_index(blocks)
    print("Pushed ledger/hash_index.json + ledger/hash_index.sha256")

    ls.push_index(new_index)
    print(f"Pushed ledger/index.json ({len(new_index)} date(s))")

    print("\n✓ Apply complete. Clients should now do a full restore-from-cloud.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
