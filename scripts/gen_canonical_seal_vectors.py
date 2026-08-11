#!/usr/bin/env python3
"""
Generate `testdata/canonical_seal_vectors.json` — the cross-client, closed
block-seal vector fixture for ADR-029/029a.

Each vector carries:
  * `block_data` — a WIDE block row that includes BOTH the ADR-029a per-type
    whitelisted fields AND excluded fields (`identity`, `format_version`,
    `key_version`, `identity_seal`, `signature`, and for summaries the old
    fixture-only `month_index`/`year_index`/`total_entries`/`total_duration_ms`).
    The wide block proves the closed-set rule: excluded fields never enter the
    seal.
  * `expected_seal` — HMAC-SHA256 over exactly `select_seal_fields(block_data)`
    serialized with `json.dumps(..., sort_keys=True)` under the fixed
    `deadbeef…` MASTER_KEY. This matches Python `_MockCrypto.seal`, Web
    `CryptoService.seal` (WASM), and Flutter `CryptoService.seal` — all derive
    `seal_key = HMAC(MK, "integrity-key-salt")` then `HMAC(seal_key, data)`.

Vectors (8 = 4 block types × original_hash absent/present):
  V-genesis, V-day, V-month, V-year  (+ `-orig` present variants of each).

This supersedes the stale pre-ADR-029a open-set `testdata/canonical_test_vectors.json`
whose V-genesis/V-month/V-year seals baked excluded fields (identity,
month_index/year_index, totals). No live consumer may depend on those old
open-set values after this phase.

Usage:
    python3 scripts/gen_canonical_seal_vectors.py [--output testdata/canonical_seal_vectors.json]

Zero external dependencies (D3): hashlib/hmac/json only.
"""

import argparse
import hashlib
import hmac
import json
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
MASTER_KEY_HEX = "deadbeef" * 8
SALT = b"integrity-key-salt"
ZERO_HASH = "0" * 64

# ADR-029a per-type whitelists (mirror domain/ledger/chain.py SEAL_FIELDS).
SEAL_FIELDS = {
    "genesis": {"type", "day_index", "date", "prev_hash", "entries",
                "original_hash"},
    "day": {"type", "day_index", "date", "prev_hash", "entries",
            "original_hash"},
    "month_summary": {"type", "month", "date", "prev_hash", "original_hash"},
    "year_summary": {"type", "year", "date", "prev_hash", "original_hash"},
}


def seal(data_str: str) -> str:
    """HMAC-SHA256 seal: key = HMAC(MASTER_KEY, 'integrity-key-salt')."""
    key = hmac.new(bytes.fromhex(MASTER_KEY_HEX), SALT, hashlib.sha256).digest()
    return hmac.new(key, data_str.encode(), hashlib.sha256).hexdigest()


def select_seal_fields(block: dict) -> dict:
    """Return only the ADR-029a per-type whitelisted fields present."""
    btype = block.get("type", "day")
    field_set = SEAL_FIELDS.get(btype)
    if field_set is None:
        raise ValueError(f"Unknown block type for seal: {btype!r}")
    return {k: v for k, v in block.items() if k in field_set}


def expected_seal(block: dict) -> str:
    return seal(json.dumps(select_seal_fields(block), sort_keys=True))


# ── Canonical wide rows (whitelisted + excluded fields) ─────────────────────
EXCLUDED = {
    "format_version": (0, 4, 0),
    "key_version": 1,
    "identity_seal": "a" * 64,
    "signature": "b" * 64,
    "identity": {
        "username": "testuser",
        "email": "test@example.com",
        "recovery_seed_enc": "enc:deadbeef",
        "identity_pub_key": "c" * 64,
        "identity_secret_enc_fallback": "enc:cafebabe",
    },
}


def _wide(*, btype: str, fields: dict, orig: bool) -> dict:
    row = {"type": btype, **fields}
    if orig:
        row["original_hash"] = "d" * 64
    # Excluded-by-whitelist metadata stays on the WIDE block.
    row.update(EXCLUDED)
    # Fixture-only summary telemetry (removed from the real format) are placed
    # on the wide summary rows to PROVE they are excluded from the seal too.
    if btype == "month_summary":
        row["month_index"] = 0
        row["total_entries"] = 10
        row["total_duration_ms"] = 36000000
    elif btype == "year_summary":
        row["year_index"] = 0
        row["total_entries"] = 120
        row["total_duration_ms"] = 432000000
    return row


def _chain_link(vectors: dict, child: str, parent_seal: str):
    """Link a vector's prev_hash to an upstream vector's expected_seal and
    re-derive (mutate in place) the child's expected_seal accordingly."""
    v = vectors[child]
    v["block_data"]["prev_hash"] = parent_seal
    v["expected_seal"] = expected_seal(v["block_data"])


_DAY_ROW = {"day_index": 1, "date": "2026-07-03", "entries": []}
_MONTH_ROW = {"month": "2026-07", "date": "2026-07"}
_YEAR_ROW = {"year": 2026, "date": "2026"}


def build_vectors() -> dict:
    vectors = {}

    def add(name: str, row: dict):
        vectors[name] = {
            "description": (
                f"{name} block (type={row['type']}, "
                f"original_hash={'present' if 'original_hash' in row else 'absent'})."
            ),
            "block_data": row,
            "expected_seal": expected_seal(row),
        }

    # Two chains (original_hash ABSENT / PRESENT), each linking all four types
    # in the D4 hierarchy Genesis → Year → Month → Day. Each downstream
    # prev_hash points at the upstream block's expected_seal, so the four
    # vectors form a verifiable chain end-to-end (B7) AND each expected_seal
    # is exact.
    for orig in (False, True):
        suffix = "" if not orig else "-orig"
        add("V-genesis" + suffix, _wide(
            btype="genesis", orig=orig,
            fields={"day_index": 0, "date": "2026-07-03",
                    "prev_hash": ZERO_HASH, "entries": []},
        ))
        add("V-day" + suffix, _wide(btype="day", orig=orig, fields=_DAY_ROW))
        add("V-month" + suffix,
            _wide(btype="month_summary", orig=orig, fields=_MONTH_ROW))
        add("V-year" + suffix,
            _wide(btype="year_summary", orig=orig, fields=_YEAR_ROW))
        _chain_link(vectors, "V-year" + suffix,
                    vectors["V-genesis" + suffix]["expected_seal"])
        _chain_link(vectors, "V-month" + suffix,
                    vectors["V-year" + suffix]["expected_seal"])
        _chain_link(vectors, "V-day" + suffix,
                    vectors["V-month" + suffix]["expected_seal"])

    return vectors


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--output", default=None,
                    help="Output path (default: testdata/canonical_seal_vectors.json)")
    args = ap.parse_args()

    out_path = Path(args.output) if args.output else \
        PROJECT_ROOT / "testdata" / "canonical_seal_vectors.json"

    fixture = {
        "_description": (
            "Cross-client, CLOSED block-seal vector fixture (ADR-029/029a). "
            "Each expected_seal is the HMAC-SHA256 over exactly "
            "select_seal_fields(block_data) — the ADR-029a per-type whitelist — "
            "serialized with json.dumps(..., sort_keys=True) under MASTER_KEY "
            "deadbeef… with salt 'integrity-key-salt'. The wide block_data ALSO "
            "carries excluded fields (identity, format_version, key_version, "
            "identity_seal, signature, and for summaries the removed "
            "month_index/year_index/total_* telemetry) to prove closed-set "
            "exclusion. Supersedes the stale open-set canonical_test_vectors.json."
        ),
        "_master_key_hex": MASTER_KEY_HEX,
        "_vectors_count": 8,
        "vectors": build_vectors(),
    }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(fixture, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(fixture['vectors'])} vectors -> {out_path}")


if __name__ == "__main__":
    main()
