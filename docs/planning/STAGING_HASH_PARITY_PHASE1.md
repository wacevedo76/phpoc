# Staging-Hash Parity Gate (ADR-034 P0) — Test Exploration (Phase 1)

> **Plan:** `STAGING_CHANGE_DETECTION_PLAN.md` §10 step 1 (P0) + `../design/STAGING_CHANGE_DETECTION_DESIGN.md` §4
> **Purpose:** Blueprint of all test assertions needed for the P0 go/no-go gate — the shared
> `compute_staging_hash` helper + parity vectors **V1 (canonical serialization)** and
> **V2 (digest)** across CLI (Python), Web (JS), Flutter (Dart).
> **Status:** 🔜 Phase 1 (test exploration)
> **Next Phase:** Phase 2 (RED: test definition)

---

## Architecture Overview

`staging_hash` is a **deterministic, key-independent, byte-identical** SHA-256 digest of the
non-committed staging rows' **canonical plaintext** form (ADR-034 §4.1). It is computed at
mutation time (when the master key is in memory) and *compared* on the read fast path (no MK,
no decrypt). P0 proves the digest is identical across all three clients before any cookie/wiring
work begins.

```
staging_hash = SHA-256( json.dumps(canonical_rows, sort_keys=True, separators=(",", ":")) )
  canonical_rows = [ canonical_row(r) for r in non-committed rows ]
                   sorted ascending by activity_id
  canonical_row(r) = { activity_id, activity_status, activity, updated_at, committed }   (5 fields)
  activity = compact JSON string, pinned Python-literal key order:
             title, start_epoch, end_epoch, duration, tags, comment, media, entry_id,
             is_active, is_paused, pauses, metadata, device_uuid, end_device_uuid, block_index
```

**The one normalization rule (ADR-034 §4.1):** `comment` empty-string → **`null`**.
Python `dtoToCanonicalRow` currently emits `""`; Web already emits `null` (`e.comment || null`).
Python adds the coercion; Dart matches.

**Serialization contracts (the byte-parity crux):**

| Client | Outer array serializer | Digest |
|--------|------------------------|--------|
| Python | `json.dumps(rows, sort_keys=True, separators=(",", ":"))` | `hashlib.sha256(...).hexdigest()` (lowercase) |
| Web | `jsonSortNoSpaces(rows)` (`src/ledger/utils.js`, compact sorted keys) | `sha256(...)` (Rust WASM, lowercase hex) |
| Flutter | `encodeValueNoSpaces(rows)` (`lib/data/ledger/helpers.dart`, compact sorted keys) | `sha256(...)` (`package:crypto`, lowercase hex) |

The **inner `activity` string is NOT key-sorted** — it is a pre-serialized string whose byte
order is the *insertion* order of each client's `dtoToCanonicalRow`. Only the **outer 5-field
row** is key-sorted (alphabetically → `activity, activity_id, activity_status, committed,
updated_at`). This is why every client's `dtoToCanonicalRow` must build the `activity` dict in
the **exact pinned order**.

**Committed rows are excluded** (D11 — they moved to the ledger).

---

## Key findings from Phase-1 exploration

1. **Golden digest verified correct.** Re-deriving the spec by hand (Python, with the `comment`
   coercion) reproduces the committed golden `dfe1405377c86f030ce49d90c6fffa7a38f1e1b825b01f6aa8ab60b73c4463a4`.
2. **Python is RED for V1 and V2** — `dtoToCanonicalRow` lacks the `comment` coercion; `compute_staging_hash` does not exist.
3. **Web V1 is already GREEN** (`comment: e.comment || null`); Web V2 is RED (`computeStagingHash` does not exist). Web already has `jsonSortNoSpaces`.
4. **Flutter has NO `dtoToCanonicalRow`** — its `_buildActivityData` (in `sync_service.dart`) emits
   `activity` in a *different key order and field set* (missing `media`/`entry_id`/`metadata`/
   `block_index`; `is_active`/`is_paused`/`pauses` before `tags`). **Flutter needs a canonical
   `dtoToCanonicalRow` + `computeStagingHash`** in a new `lib/data/sync/staging_hash.dart`.
   Flutter already has the compact sorted-key serializer (`encodeValueNoSpaces`).
5. **Flutter's `jsonSort` (`json_utils.dart`) is SPACED** (`": "`, `", "`) — NOT compatible with
   the compact staging_hash spec. The helper MUST use `encodeValueNoSpaces`, not `jsonSort`.

---

## Test Groups

### Group A — Python canonical serialization (V1) — 5 assertions
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | `dtoToCanonicalRow(dto)` emits the full 5-field canonical row matching golden, for every seed DTO | Full-row parity | Locks the exact 5-field shape (`activity_id`/`activity_status`/`activity`/`updated_at`/`committed`) |
| A2 | `row["activity"]` string matches golden byte-for-byte | Pinned key order | The inner string is not sorted; any key-order drift breaks the digest |
| A3 | `comment == ""` normalizes to `null` (seed `act-0002`) | Normalization rule | Python currently emits `""`; this is the one V1 RED fix |
| A4 | canonical array (filter committed + sort by `activity_id` + compact sorted-key JSON) matches golden | Array parity | Exercises exclusion + sort + compact separators together |
| A5 | `act-0004` (committed) is absent from the array | Committed exclusion (D11) | Committed rows moved to ledger must not be hashed |

### Group B — Python digest (V2) — 3 assertions
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | `compute_staging_hash(rows)` returns golden hex `dfe14053…` | Digest correctness | The go/no-go gate itself |
| B2 | digest is 64-char **lowercase** hex | Encoding | Uppercase/other encodings break cross-client compare |
| B3 | deterministic: repeated calls identical; independent of input row order (after sort) | Determinism | Event-driven compare depends on stable digests |

### Group C — Web canonical serialization (V1) — 3 assertions (guard-green)
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | Web `dtoToCanonicalRow` `activity` string matches golden | Pinned order + `comment` `|| null` | Web already correct — guard against regression |
| C2 | Web canonical array (committed-filter + sort + `jsonSortNoSpaces`) matches golden | Array parity | Locks Web's sorted-key compact serializer |
| C3 | Web excludes committed rows | Committed exclusion | Same D11 rule as A5 |

### Group D — Web digest (V2) — 2 assertions (RED)
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | `computeStagingHash(rows)` returns golden hex | Digest correctness | New helper in `remote_sync.js` |
| D2 | Web digest bytes equal Python digest bytes for identical rows | Python↔Web parity | Proves the two serializers converge |

### Group E — Flutter canonical serialization (V1) — 4 assertions (RED)
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | Flutter `dtoToCanonicalRow` emits the 5-field canonical row | New canonical bridge | Flutter currently has no such function |
| E2 | Flutter `activity` string matches golden byte-for-byte | Pinned key order | Dart map insertion order must match the pinned list exactly |
| E3 | `comment == ""` normalizes to `null` | Normalization rule | Dart must match Python/Web |
| E4 | Flutter canonical array (via `encodeValueNoSpaces`) matches golden | Array parity | Uses compact sorted-key serializer, NOT `jsonSort` |

### Group F — Flutter digest (V2) — 2 assertions (RED)
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| F1 | `computeStagingHash(rows)` returns golden hex | Digest correctness | New helper in `staging_hash.dart` |
| F2 | deterministic + lowercase hex | Determinism/encoding | Matches B2/B3 |

### Group G — Cross-client byte-parity (V1/V2) — 3 assertions
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| G1 | Python ↔ Web byte-parity (drive `node` on a `.mjs` helper, mirror `ccs4_cross_client.mjs`) | Two-client proof | Strongest guarantee: exact same bytes + digest |
| G2 | Flutter ↔ golden byte-parity (Dart test `test/data/sync/staging_hash_test.dart` against the shared golden) | Third-client proof | Both Web and Flutter assert the same golden → transitively Web↔Flutter |
| G3 | All three clients equal the single committed golden digest | Adoption gate | ADR-034 §4.4 requires V1/V2 parity before adoption completes |

### Deferred (explicit follow-on — NOT in P0)
- **V3 — key-independence** (digest unchanged after `rekey_seed` re-encryption): needs real crypto; P1.
- **V4 — change-sensitivity** (any field change flips the digest): pure-function property; next increment.
- Cookie schema + CAS (P1), mutation/read wiring (P2/P3), polling removal + hash unification (P4).

---

## Implementation map (Phase 3 preview)

| Client | File | Add |
|--------|------|-----|
| Python | `domain/staging/row_merge.py` | `comment` coercion in `dtoToCanonicalRow`; `compute_staging_hash(rows)` |
| Web | `phpoc-web/src/sync/remote_sync.js` | `computeStagingHash(rows)` (reuse `jsonSortNoSpaces` from `ledger/utils.js`) |
| Flutter | `phpoc-flutter/lib/data/sync/staging_hash.dart` (new) | `dtoToCanonicalRow(dto)` + `computeStagingHash(rows)` (reuse `encodeValueNoSpaces` from `data/ledger/helpers.dart`) |

## Test file map (Phase 2 preview)

- Python: `tests/test_staging_hash_parity.py` (already drafted RED — Groups A/B; add Web cross-client leg, wire the Flutter leg note)
- Web: `phpoc-web/test/staging_hash_parity.mjs` (node subprocess helper, mirrors `ccs4_cross_client.mjs`)
- Flutter: `phpoc-flutter/test/data/sync/staging_hash_test.dart` (asserts against the shared golden)

## Verification

- `PYTHONPATH=. .venv/bin/python -m pytest tests/test_staging_hash_parity.py -v` → RED now (4 fails / 2 skips), GREEN at Phase 3
- `node --test phpoc-web/test/staging_hash_parity.mjs`
- `cd phpoc-flutter && flutter test test/data/sync/staging_hash_test.dart`
