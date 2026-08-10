# CCS-4: Cross-Client E2E Testing — RED (Phase 2)

> **Plan:** `docs/planning/CCS4_PHASE1.md`
> **Purpose:** Write all failing/runnable tests for the 24 CCS-4 assertions across Python ↔ JS ↔ live Worker.
> **Status:** ✅ Phase 2 (RED) complete
> **Next Phase:** Phase 3 (GREEN: implementation/fixes) → ✅ complete — see `CCS4_PHASE3.md`

## Empirically-verified classification (this phase)

During RED authoring I reconciled every blueprint assertion against the real
implementation. This surfaced **three latent cross-client divergences** that
CCS-4 is designed to catch, plus several assertions that already hold (guards).

| Group | 🔴 Genuinely RED (fails today) | 🟢 Guard (green today) | Deployment |
|-------|-------------------------------|------------------------|------------|
| A (Canonical row parity) | **A1–A5: `activity` JSON separator divergence** — Python `json.dumps` default-spaced (`, ` / `: `) vs JS `JSON.stringify` compact (`,` / `:`); and **A6-JS: `block_index` dropped through `canonicalRowToDTO`** (data loss) | A6-Python (within-client round-trip preserves block_index) | Pure (node subprocess for JS side) |
| B (Hash index parity) | **B2 latent: Python `StagingHashIndex.computeHash` (compact `(",",":")`) ≠ Flutter `computeHash` (`json.encode` default-spaced) → different SHA-256 for same rows** (asserted as the Phase-3 convergence target) | B1–B4 (Python↔JS already agree on the compact canonical digest) | Pure (node helper) |
| C (Merge parity) | **C6: JS `mergeRows` does not sort output by `activity_id`; Python `merge_rows` does → non-deterministic cross-client merge bytes** | C1–C5 (LWW merge parity) | Pure (node subprocess) |
| D (Cookie/dev identity) | none (derive_device_id/deriveDeviceId and device_proof already HMAC-interoperable) | D1–D3 | Pure (node subprocess) |
| E (Live Worker round-trip) | — (all 5 live round-trips GREEN against the real Worker; skipped offline) | E1–E5 | Live Worker + node + Python transport |

### The CCS-4 catches: genuine cross-client divergences

**A1–A5 — `activity` JSON separator divergence.** Python `row_merge.`
`dtoToCanonicalRow` emits `activity` via `json.dumps(activity)` (default-spaced
separators `", ":", "`), JS `entry_dto` uses `JSON.stringify` (compact `,`/`:`).
The serialized `activity` string differs byte-for-byte, propagating to blob
bytes and SHA-256. Phase 3 must converge on one serialization (canonical
compact).

**A6-JS — `block_index` data loss.** JS `canonicalRowToDTO` hard-codes
`block_index: null` and does not read the canonical row's `block_index` back,
so round-tripping a canonical row drops it; re-canonicalizing then differs
from the original. Phase 3 must preserve `block_index` through the JS
round-trip.

**C6 — merge-output sort divergence.** Python `merge_rows` sorts the merged
list by `activity_id`; JS `mergeRows` returns rows in insertion (map) order.
Cross-client merged output therefore differs byte-for-byte even when the same
LWW choices are made. Phase 3 must sort the JS merge output deterministically.

**B2 — hash-index serialization divergence (latent).**
- **Python** `core/staging_hash_index.py` `computeHash`:
  `json.dumps(idx, separators=(",",":"), sort_keys=True)` → **compact** `[{"activity_id":"a",...}]`
- **Flutter** `phpoc_flutter/.../staging_hash_index.dart` `computeHash`:
  `json.encode(sorted)` → **default-spaced** `[{"activity_id": "a", ...}]`

The identical row set yields **different SHA-256 digests**, so a Python-written
stage and a Flutter-computed local hash would falsely report Tier-1 divergence.
The test pins the canonical compact digest as GREEN and records the Flutter
divergence as the Phase-3 convergence target.

### Reconciliation notes (blueprint → implementation)

- **A6 reframed + RED catch.** Python `row_merge.canonicalRowToDTO` and JS
  `entry_dto.canonicalRowToDTO` deliberately produce different DTO shapes
  (`has_encrypted_fields`, `block_index: null` vs parsed, field order). They
  serve different downstream consumers. A6 asserts *within-client* round-trip
  fidelity on each engine independently. Python passes; **JS fails on
  `block_index` (see above) — a real data-loss bug CCS-4 caught.**
- **Group D mapped to the implemented contract.** The Phase-1 doc's
  `HMAC(mk, "phpoc:device:"+device_id)` is the deterministic **device identity/
  proof** derivation, not the random cookie specifier. JS `deriveDeviceId` is
  async (Web Crypto) and Python `derive_device_id` is sync; both are
  HMAC-SHA256 interop. D1 = device-ID derivation parity, D2 = client-type
  suffix (`-cli` vs `-web`), D3 = device-proof independent verification.
- **Group B JS engine.** JS `staging_hash_index.js` builds the *legacy* DTO
  index `{id,status}`; there is no row-level `{activity_id, activity_status}`
  index function on the JS side yet. The Node helper ports the canonical
  row-level build + compact `computeHash` as the JS counterpart.
- **Group E live result.** All 5 E-group tests passed against the real test
  Worker, proving the Web engine (Node protocol port, verified byte-identical
  to Python obfuscation) reads CLI-written canonical blobs and re-obfuscates
  identically on live infrastructure.

## Files

| File | Group(s) | Kind |
|------|----------|------|
| `phpoc-web/test/ccs4_cross_client.mjs` | A, B, C, D, E | Node parity/round-trip helper + executable parity runner |
| `tests/test_ccs4_cross_client.py` | A–D | Python tests driving the node helper for JS parity |
| `tests/test_ccs4_live_worker.py` | E | Python + node live Worker round-trips (network) |

## Run

```bash
# Groups A–D (process-local; needs node on PATH)
PYTHONPATH=. python3 -m pytest tests/test_ccs4_cross_client.py -v
#   Expected RED: A1, A2, A3, A4, A5, A6-JS, C6  (7)
#   Expected GREEN: A6-Python, B1–B4, C1–C5, D1–D3  (13)

# Group E (live Worker; requires TEST_CREDENTIALS.md + network)
PYTHONPATH=. python3 -m pytest tests/test_ccs4_live_worker.py -v --timeout 180
#   Skips offline (no API key); all 5 pass against the real Worker.
```
