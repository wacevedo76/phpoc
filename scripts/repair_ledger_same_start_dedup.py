#!/usr/bin/env python3
"""Option (a) remediation: remove superseded same-start-ms duplicate seals.

Targets the residual "Aug 7 doubling" — baked-in historical double-seals of
long-running "Working on phpoc/Phpoc" tasks (May 18/22/27) that share an
identical `startTime` millisecond but carry a growing `end`. These are the
oldest committed entries (Apr 23 → Jul) carrying NO `activity_id`; the commit
path appended a fresh seal to the *current* day's block every time the still-
running task was re-committed, so the SAME startTime (ms) now appears in
multiple day blocks.

Option (a) = one-time data repair: GLOBALLY group by startTime (exact ms), keep
the seal with the latest `end`, drop the superseded copies (which may live in
other day blocks), then re-seal the chain from the first affected block to the
tip (prev_hash linkage cascades). Blocks that become empty are kept (structure
+ day_index preserved) — matches "remove seals, not blocks".

Dedup criterion: same EXACT start-ms. A human cannot start two tasks in the
same millisecond, so entries sharing a start ms are the SAME activity — even if
the title was edited (e.g. "phpoc"→"Phpoc") between duplicate commits. Title is
deliberately NOT part of the key.

SAFETY: NEVER writes to ~/.local/share/phpoc/ and NEVER pushes to remote.
Dry-run (default) only reports. `--output FILE` writes the re-sealed chain to a
review file. Apply + push are separate user-initiated steps (see
docs/planning/AUG7_DOUBLING_REMEDIATION_PLAN.md).

Identity seals: the remote genesis carries NO identity metadata (Flutter strips
it pre-push), so the device-scoped identity secret is NOT recoverable from R2.
Pass `--identity-secret HEX` to re-sign; otherwise identity_seal is dropped on
re-sealed blocks (safe — verify() skips blocks lacking identity_seal).

Usage:
    python3 scripts/repair_ledger_same_start_dedup.py                 # dry-run (remote)
    python3 scripts/repair_ledger_same_start_dedup.py --output /tmp/repair.json
    python3 scripts/repair_ledger_same_start_dedup.py --input chain.json   # offline
"""
import argparse
import base64
import copy
import json
import os
import re
import sys
from collections import defaultdict
from urllib.request import Request, urlopen
from urllib.parse import urlencode

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PROJECT_ROOT)

from domain.staging.remote_sync import RemoteStagingSync
from domain.ledger.chain import compute_seal
from domain.ledger.helpers import get_block_hash
from security.crypto import CryptoManager
from scripts.verify_ledger import decrypt_field, Verifier

HASH_KEY = {
    "genesis": "block_hash",
    "day": "day_hash",
    "month_summary": "month_hash",
    "year_summary": "year_hash",
}


# ── Credentials / transport ────────────────────────────────────────

def read_personal_creds():
    txt = open(os.path.join(PROJECT_ROOT, "TEST_CREDENTIALS.md")).read()
    personal = txt.split("## ⚠️ Personal Ledger")[1].split("## Quick Reference")[0]
    url = re.search(r"\*\*Worker URL\*\*\s*\|\s*`([^`]+)`", personal).group(1)
    key = re.search(r"\*\*Worker API Key\*\*\s*\|\s*`([^`]+)`", personal).group(1)
    seed = re.search(r"\*\*Recovery Seed\*\*\s*\|\s*`([^`]+)`", personal).group(1)
    return url, key, seed


def _fetch(url, key, path):
    u = url.rstrip("/") + "/" + path.lstrip("/")
    req = Request(u, headers={"X-Api-Key": key, "User-Agent": "phpoc-repair/1.0"})
    with urlopen(req, timeout=30) as r:
        if r.status == 404:
            return None
        return r.read()


def _list(url, key, prefix):
    u = url.rstrip("/") + "/?" + urlencode({"prefix": prefix})
    req = Request(u, headers={"X-Api-Key": key, "User-Agent": "phpoc-repair/1.0"})
    with urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def pull_remote(url, key, mk):
    files = sorted(f for f in _list(url, key, "ledger/blocks/") if f.endswith(".json"))
    blocks = []
    for f in files:
        raw = _fetch(url, key, "ledger/blocks/" + f)
        if raw is None:
            continue
        plain = RemoteStagingSync._deobfuscate(raw, mk)
        if plain is None:
            raise SystemExit(f"deobfuscation failed for {f}")
        blocks.append(json.loads(plain.decode("utf-8")))
    return blocks


# ── Decrypt helpers ────────────────────────────────────────────────

def _decrypt_epoch(crypto, mk_hex, data, field):
    val = data.get(field)
    if not val:
        return None
    try:
        return decrypt_field(val, mk_hex).decode("utf-8")
    except Exception:
        try:
            return crypto.decrypt(val)
        except Exception:
            return None


def _epoch_int(s):
    try:
        return int(s)
    except (TypeError, ValueError):
        return None


# ── Global dedup (option a) ────────────────────────────────────────

def build_global_dedup(blocks, crypto, mk_hex):
    """Group every day entry by decrypted startTime (exact ms) ALONE, then mark
    all but the latest-end copy for removal.

    Same-exact-start-ms is the dedup criterion: it is virtually impossible for a
    human to start two tasks in the same millisecond, so two entries sharing a
    start ms are the SAME activity — even if the title was edited (case drift)
    between commits. Title is therefore NOT part of the key.

    Returns (drop, groups, order) where drop maps (block_idx, entry_idx) → entry
    and groups maps start-ms string → [(block_idx, entry_idx, end_int, entry)].
    """
    groups = defaultdict(list)   # start-ms -> [(block_idx, entry_idx, end_int, entry)]
    order = []
    for bi, b in enumerate(blocks):
        if b.get("type") != "day":
            continue
        for ei, e in enumerate(b.get("entries", []) or []):
            data = e.get("data") if isinstance(e, dict) else None
            if not isinstance(data, dict):
                continue
            start = _decrypt_epoch(crypto, mk_hex, data, "startTime_enc")
            if not start:
                continue
            if start not in groups:
                order.append(start)
            end = _decrypt_epoch(crypto, mk_hex, data, "endTime_enc")
            groups[start].append((bi, ei, _epoch_int(end), e))

    drop = {}
    for key in order:
        rows = groups[key]
        if len(rows) <= 1:
            continue
        # keep the LATEST end (max end; max entry idx breaks ties)
        rows_sorted = sorted(rows, key=lambda r: (r[2] is not None, r[2] or 0, r[1]))
        for r in rows_sorted[:-1]:
            drop[(r[0], r[1])] = r[3]
    return drop, groups, order


def find_first_affected(drop):
    if not drop:
        return None
    return min(bi for (bi, _ei) in drop)


def reseal(blocks, crypto, mk_hex, identity_secret, drop, first_affected):
    """Re-seal from first_affected to the tip. Only entries (dedup), prev_hash,
    the hash key, and identity_seal change; every other field is preserved."""
    out = [copy.deepcopy(b) for b in blocks[:first_affected]]
    prev_hash = get_block_hash(out[-1]) if out else ("0" * 64)
    for i in range(first_affected, len(blocks)):
        b = copy.deepcopy(blocks[i])
        btype = b.get("type")
        if btype == "day":
            b["entries"] = [
                e for ei, e in enumerate(b.get("entries", []) or [])
                if (i, ei) not in drop
            ]
        if i > 0:
            b["prev_hash"] = prev_hash
        hk = HASH_KEY.get(btype)
        # This migrated chain stores BOTH a uniform `block_hash` AND the
        # type-specific alias (day_hash/month_hash/year_hash), all equal.
        # Python get_block_hash reads `block_hash` first; Flutter getBlockHash
        # reads the type-specific key. Update BOTH to the same new seal.
        b.pop("block_hash", None)
        b.pop("day_hash", None)
        b.pop("month_hash", None)
        b.pop("year_hash", None)
        b.pop("identity_seal", None)
        b.pop("signature", None)
        if hk:
            new_seal = compute_seal(crypto, b)
            b["block_hash"] = new_seal
            if hk != "block_hash":
                b[hk] = new_seal
            if identity_secret is not None:
                b["identity_seal"] = crypto.mac(new_seal, identity_secret)
        prev_hash = get_block_hash(b)
        out.append(b)
    return out


# ── Main ───────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--input", help="local ledger JSON file (skip remote pull)")
    ap.add_argument("--output", help="write the re-sealed chain to this file")
    ap.add_argument("--worker-url", "--url")
    ap.add_argument("--api-key")
    ap.add_argument("--seed", help="base64 32-byte recovery seed (overrides TEST_CREDENTIALS)")
    ap.add_argument("--identity-secret", help="64-hex device identity secret to re-sign with")
    args = ap.parse_args()

    if args.input:
        with open(args.input) as f:
            raw = json.load(f)
        blocks = raw["ledger"] if isinstance(raw, dict) and "ledger" in raw else raw
        seed = args.seed or read_personal_creds()[2]
    else:
        url, api_key, seed = read_personal_creds()
        if args.worker_url:
            url = args.worker_url
        if args.api_key:
            api_key = args.api_key
        if args.seed:
            seed = args.seed
        print(f"Worker: {url}")
        mk = base64.b64decode(seed)
        blocks = pull_remote(url, api_key, mk)
        print(f"Pulled {len(blocks)} blocks")

    mk = base64.b64decode(seed)
    if len(mk) != 32:
        raise SystemExit("seed must decode to 32 bytes")
    mk_hex = mk.hex()
    crypto = CryptoManager(mk)

    identity_secret = None
    if args.identity_secret:
        identity_secret = bytes.fromhex(args.identity_secret)
    identity_secret_hex = identity_secret.hex() if identity_secret else None

    # 1. Verify the SOURCE chain before touching anything
    print("\n=== Source chain verification ===")
    Verifier(blocks, mk_hex, identity_secret_hex, False).verify()
    if identity_secret_hex is None:
        print("  (identity_seal not checked — no --identity-secret provided)")

    # 2. Global dedup analysis
    drop, groups, order = build_global_dedup(blocks, crypto, mk_hex)
    print("\n=== Dedup analysis (option a) ===")
    if not drop:
        print("No same-start-ms duplicates found — chain already clean.")
        return 0

    dup_groups = [(k, v) for k, v in groups.items() if len(v) > 1]
    print(f"Same-start-ms groups with >1 seal: {len(dup_groups)}")
    for start, rows in dup_groups:
        ends = sorted((r[2] for r in rows), key=lambda x: (x is None, x or 0))
        keep = max(rows, key=lambda r: (r[2] is not None, r[2] or 0, r[1]))
        titles = sorted({(r[3].get("data") or {}).get("title") for r in rows})
        if len(titles) == 1:
            title_disp = repr(titles[0])
        else:
            title_disp = f"{titles!r} ⚠️ TITLE DRIFT (title edited between duplicate seals)"
        print(f"  start={start} copies={len(rows)} title={title_disp}")
        print(f"     ends={ends} → keep end={keep[2]} (block {keep[0]})")
        for r in sorted(rows, key=lambda x: x[1]):
            marker = "  " if r is keep else "x "
            print(f"       {marker}block {r[0]} entry {r[1]} end={r[2]}")

    first = find_first_affected(drop)
    affected = sorted({bi for (bi, _ei) in drop})
    print(f"\nSuperseded seals to remove: {len(drop)}")
    print(f"Affected blocks: {affected}")
    print(f"First affected block: {first} "
          f"(re-seal {len(blocks) - first} blocks: {first}..{len(blocks) - 1})")

    if not args.output:
        print("\nDry-run complete. Use --output FILE to materialize the repaired chain.")
        return 0

    # 3. Build + verify the repaired chain
    repaired = reseal(blocks, crypto, mk_hex, identity_secret, drop, first)
    print(f"\n=== Repaired chain verification (removed {len(drop)} seals) ===")
    Verifier(repaired, mk_hex, identity_secret_hex, False).verify()

    with open(args.output, "w") as f:
        json.dump(repaired, f, indent=2)
    print(f"\nWrote repaired chain ({len(repaired)} blocks) to {args.output}")
    print("Apply + push are separate, user-initiated steps — see "
          "docs/planning/AUG7_DOUBLING_REMEDIATION_PLAN.md")
    return 0


if __name__ == "__main__":
    sys.exit(main())
