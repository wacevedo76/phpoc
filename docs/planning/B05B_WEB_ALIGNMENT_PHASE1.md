# B-05b: Web Staging Format Alignment — Test Exploration (Phase 1)

> **Plan:** `docs/planning/CROSS_PLATFORM_STAGING_FORMAT_ALIGNMENT.md`
> **Purpose:** Blueprint of all needed test assertions before writing any test code.
> **Status:** 🔜 Phase 1 (test exploration)
> **Next Phase:** Phase 2 (RED: test definition)

## Architecture Overview

B-05b aligns the Web client's staging format with the canonical PHPSPEC §8 spec already implemented in Flutter. The web client currently uses a legacy format (`staging/blobs/current.json`, raw spec entries with `{hash, data: {_enc}}`, envelope `updated_at`, remote-wins merge) and must be updated to use:

- **Canonical blob path:** `staging/blob`
- **Canonical row format:** `{activity_id, activity_status, activity, updated_at, committed}`
- **No `updated_at` in envelope** (hash index supersedes it)
- **No `entry_id` in envelope** (keep at row level for legacy compat)
- **Local-wins merge tie-break** (matching Flutter)
- **Hash index fast path** in `checkAndSync` (Tier 1 SHA-256 + Tier 2 diff)
- **Single-blob transport** — retire `RowSyncWorker` (Worker endpoints don't exist)

### Files to change (6)

| File | Change |
|------|--------|
| `phpoc-web/src/sync/keys.js` | `REMOTE_STAGING_BLOB = 'staging/blob'` |
| `phpoc-web/src/sync/remote_sync.js` | Drop `updated_at` from envelope; emit canonical rows (`{activity_id, activity_status, activity, updated_at, committed}`) instead of raw spec format (`{hash, data: {_enc}}`) |
| `phpoc-web/src/sync/sync.js` | Wire hash index fast path into `checkAndSync`; use canonical `mergeRows()` in `_reconcileDifferentDevice` (no DTO conversion); envelope changes |
| `phpoc-web/src/sync/row_sync.js` | Delete `RowSyncWorker` class; change S3 tie-break to local-wins; add `mergeRows()` (port Flutter's `MergeEngine.mergeEntries()`) |
| `phpoc-web/src/sync/merge_engine.js` | Superseded by `mergeRows()`; remove import from `sync.js` |
| `phpoc-web/src/sync/staging_hash_index.js` | Already correct; wire pull side in `sync.js` |

### Reference implementations

- **Flutter canonical merge:** `phpoc-flutter/lib/data/sync/merge_engine.dart` — `mergeEntries(localRows, remoteRows)` with local-wins on equal `updated_at`
- **PHPSPEC §8:** `docs/spec/PHPSPEC.md` lines 1280–1415 — canonical row schema, blob envelope, hash index, merge strategy, sync workflow

---

## Test Groups

### Group A: remote_sync.js — Canonical Blob Format — ~14 tests

The `pushBlob()` and `pullBlob()` methods must emit/consume canonical rows instead of raw spec format. Envelope drops `updated_at`.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | pushBlob emits envelope with `entries`, `device_id`, `device_proof` — no `updated_at` | Envelope shape matches PHPSPEC §8.2 | `updated_at` on envelope is redundant with hash index and per-row timestamps |
| A2 | pushBlob row has `activity_id` (string), `activity_status` (string), `activity` (JSON string), `updated_at` (int), `committed` (bool) | Row shape matches PHPSPEC §8.1 | All five canonical fields must be present |
| A3 | pushBlob row does NOT have `hash` at top level | `hash` was part of legacy raw spec format | `hash` is internal to the `activity` JSON, not the row envelope |
| A4 | pushBlob row does NOT have `data` at top level | `data` wrapper was part of legacy raw spec format | Rows are flat — the entry payload is in `activity` |
| A5 | pullBlob returns parsed canonical blob with `entries` array of rows | Round-trip: what pushBlob emits, pullBlob can parse | Ensures format stability |
| A6 | pullBlob returns null when no remote blob exists (unchanged behavior) | Backward-compatible null handling | Existing callers depend on null for "no blob" |
| A7 | pullBlob returns BLOB_KEY_MISMATCH when deobfuscation fails (unchanged) | Wrong-key detection preserved | Critical for data safety — must not silently corrupt |
| A8 | pushBlob preserves `entry_id` inside `activity` JSON when present (legacy compat) | Legacy `entry_id` survives format migration | Web entries created before activity_id still need `entry_id` for dedup |
| A9 | pushBlob with empty entries array produces valid envelope | Edge case: no staging entries | Must not crash or emit invalid JSON |
| A10 | pushBlob obfuscates blob when master key is available (unchanged behavior) | Encryption path preserved | Security regression check |
| A11 | pushBlob emits plaintext JSON when no master key (unchanged) | Unauthenticated fallback preserved | Used in pre-auth sessions |
| A12 | pullBlob handles plaintext JSON fallback (unchanged backward compat) | Legacy plaintext blobs still readable | Migration safety net |
| A13 | pushBlob `device_id` matches the passed device ID | Device identity in envelope | Auth gate depends on device_id matching |
| A14 | pushBlob row `updated_at` is set to current time when entry has no explicit timestamp | Default timestamp for new rows | Required for LWW merge — every row needs a timestamp |

### Group B: sync.js — Staging Hash Index Fast Path — ~12 tests

The `checkAndSync()` flow must use hash index for O(1) change detection before pulling the full blob.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | checkAndSync pulls `staging/hash_index.json` SHA-256 before full blob | Tier 1 fast path | Avoids pulling full blob when nothing changed |
| B2 | When remote SHA-256 matches local → returns READY without pulling blob | Fast path skip | Matches Flutter behavior — identical hash index = no work |
| B3 | When remote SHA-256 differs → pulls full blob for reconciliation | Tier 2 fallback | Only pull blob when hash index shows changes |
| B4 | When no remote hash index exists (legacy) → pulls full blob directly | Bootstrap: legacy remote without hash index | First sync after upgrade — remote has blob but no hash index |
| B5 | After successful push, staging hash index is pushed to remote | Keep remote in sync | Subsequent syncs benefit from fast path |
| B6 | Hash index push failure does not block READY result | Best-effort, non-fatal | Hash index is an optimization, not a correctness requirement |
| B7 | When transport is null (no remote) → checkAndSync returns READY (unchanged) | Local-only mode preserved | Regression guard |
| B8 | Hash index fast path skipped when genesis incompatible | Genesis gate is authoritative | Genesis mismatch must block all blobs ops |
| B9 | After reconcile, hash index is cached locally | Local cache enables next Tier 1 comparison | Without caching, every sync pulls full blob |
| B10 | Hash index diff identifies rows with status changes (active→paused, paused→ended) | Incremental detection | Avoids full blob pull when only one row changed status |
| B11 | Hash index diff identifies new remote rows (local doesn't have) | Incremental detection | Pull only new rows, not full blob |
| B12 | Hash index diff identifies removed local rows (remote doesn't have) | Incremental detection | Clean up locally-committed rows still on remote |

### Group C: sync.js — _reconcileDifferentDevice with Canonical Rows — ~10 tests

The reconcile path must use canonical row format and `mergeRows()` instead of DTO-based `mergeEntries()`.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | _reconcileDifferentDevice calls mergeRows() with canonical rows, not mergeEntries() with DTOs | Row-level merge path | Canonical format is the source of truth |
| C2 | After reconcile, local entries are stored in canonical row format | Write path uses canonical format | Subsequent reads/syncs work without conversion |
| C3 | mergeRows uses activity_id for dedup (not entry_id) | Primary key is activity_id | Matches PHPSPEC §8.5 — activity_id is canonical key |
| C4 | mergeRows falls back to entry_id when activity_id is missing (legacy compat) | Legacy entry support | Web entries created before activity_id still need dedup |
| C5 | mergeRows preserves `committed: true` flag — committed is irreversible | Cross-device cleanup signal | Prevents activity duplication (B-01 bug) |
| C6 | mergeRows on equal updated_at gives local priority (local-wins tie-break) | Tie-break matches Flutter | Single-human constraint — same-ms conflicts are theoretical |
| C7 | After reconcile, committed entries are filtered from staging | Cleanup committed entries | matches CLI service.py:505-507 logic |
| C8 | When remote blob is BLOB_KEY_MISMATCH → returns OFFLINE (unchanged) | Data safety: don't overwrite with wrong key | Regression guard |
| C9 | When remote blob is null (no remote staging) → pushes local only | First-write path | Unchanged behavior but using canonical format |
| C10 | reconcile preserves entry_index for local entries | Entry indexing for UI | Display layer depends on entry_index for order |

### Group D: row_sync.js — mergeRows() Function — ~8 tests

New `mergeRows()` porting Flutter's `MergeEngine.mergeEntries()` to JS.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | mergeRows merges two arrays of canonical rows by activity_id | Core merge logic | Primary key deduplication |
| D2 | When both sides have same activity_id, newer updated_at wins | LWW resolution | Matches PHPSPEC §8.5 rule 2 |
| D3 | When both sides have equal updated_at, local row wins | Local-wins tie-break | Matches Flutter behavior (decision resolved in planning doc) |
| D4 | Remote-only rows are included in merge result | Pull new entries | PHPSPEC §8.5 rule 3 |
| D5 | Local-only rows with committed: true are excluded | Cleanup committed entries | PHPSPEC §8.5 rule 4 |
| D6 | Local-only rows without committed flag are preserved | New local entries survive merge | PHPSPEC §8.5 rule 4 |
| D7 | mergeRows is a pure function — no side effects | Testability | Makes testing deterministic and fast |
| D8 | mergeRows handles empty arrays on either side | Edge case robustness | Empty local, empty remote, or both empty |

### Group E: row_sync.js — buildDiff Tie-Break Change — ~4 tests

The S3 scenario in `buildDiff()` changes from remote-wins to local-wins on same-timestamp ties. `buildDiff` itself is preserved — it's still needed for hash index diff logic.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | S3: equal updated_at, different status → local row wins (push, not pull) | Tie-break flips from remote-wins to local-wins | Consistent with mergeRows() and Flutter |
| E2 | S3: equal updated_at, same status → no-op (identical rows) | No unnecessary network calls | Optimization — don't push rows that haven't changed |
| E3 | All other buildDiff scenarios (S1, S2, S4, S5, S6, S7) unchanged | Non-tie-break scenarios are format-independent | Only the tie-break direction changes — other logic is correct |
| E4 | buildDiff fastPath true when no push/pull needed (unchanged) | Fast path detection preserved | Critical for sync performance |

### Group F: row_sync.js — RowSyncWorker Removal — ~2 tests

The `RowSyncWorker` class is deleted. Worker row-level endpoints don't exist and won't be built.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| F1 | RowSyncWorker class is deleted from row_sync.js | Remove dead code | Worker endpoints (`/storage/staging/manifest`, `/storage/staging/rows/*`) don't exist |
| F2 | No imports of RowSyncWorker remain in sync.js or any other module | Clean dependency graph | Prevents accidental use of deleted class |

### Group G: keys.js — Path Change — ~2 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| G1 | REMOTE_STAGING_BLOB = 'staging/blob' | Canonical path | Matches PHPSPEC §8.4 and Flutter |
| G2 | All existing tests that use REMOTE_STAGING_BLOB still pass with new path | Regression guard | Path constant is used by remote_sync.js and sync.js |

### Group H: Integration — End-to-End Sync with New Format — ~6 tests

Full sync cycle tests to catch regressions across the entire pipeline.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| H1 | Full sync cycle: capture → pushBlob → pullBlob → reconcile → verify rows match | End-to-end canonical format round-trip | Catches mismatches between push and pull format |
| H2 | Two-device simulation: device A pushes rows, device B pulls and merges | Cross-device sync with canonical format | Most common real-world scenario |
| H3 | Hash index fast path: push → pull hash index (identical) → skip blob pull | Tier 1 fast path E2E | Performance regression test |
| H4 | Hash index diff: push row A → pull (diff) → full blob pull | Tier 2 fallback E2E | Catches hash index comparison bugs |
| H5 | Legacy blob (old format) is still readable by pullBlob | Backward compatibility | Existing remote data must not be lost |
| H6 | After reconcile with committed entry, committed row is removed from local staging | Committed cleanup E2E | B-01 bug prevention |

---

## Summary

| Group | Area | Assertions |
|-------|------|-----------|
| A | remote_sync.js — Canonical blob format | 14 |
| B | sync.js — Hash index fast path | 12 |
| C | sync.js — _reconcileDifferentDevice with canonical rows | 10 |
| D | row_sync.js — mergeRows() function | 8 |
| E | row_sync.js — buildDiff tie-break change | 4 |
| F | row_sync.js — RowSyncWorker removal | 2 |
| G | keys.js — Path change | 2 |
| H | Integration — E2E sync | 6 |
| **Total** | | **58** |

### Key coverage areas

- **Format migration:** Groups A, C cover the shift from raw spec `{hash, data: {_enc}}` to canonical `{activity_id, activity_status, activity, updated_at, committed}` 
- **Hash index fast path:** Group B covers Tier 1 (SHA-256) and Tier 2 (diff) optimization
- **Merge semantics:** Groups C, D, E cover local-wins tie-break and activity_id dedup
- **Cleanup:** Group F removes RowSyncWorker dead code
- **Regression:** Groups G, H catch path changes and end-to-end breakage
- **Backward compat:** A8, A12, H5 ensure legacy entries survive the migration

### Test file assignment

| Test file | Groups | Notes |
|-----------|--------|-------|
| `test/remote_sync_test.mjs` (new) | A | Isolated tests for pushBlob/pullBlob format |
| `test/sync_service_test.mjs` (modify) | B, C | Hash index fast path + reconcile changes |
| `test/row_sync_test.mjs` (modify) | D, E, F | mergeRows() + buildDiff change + RowSyncWorker removal |
| `test/keys_test.mjs` (new or modify sync_service) | G | Path constant verification |
| `test/staging_alignment_integration_test.mjs` (new) | H | E2E sync cycle tests |
