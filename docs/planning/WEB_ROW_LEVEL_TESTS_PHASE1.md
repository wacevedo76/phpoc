# Web Row-Level Staging — Test Exploration (Phase 1)

> **Plan:** `ROW_LEVEL_STAGING_SYNC_PLAN.md` §Phase A
> **Purpose:** Blueprint of all needed test assertions before writing any test code.
> **Status:** 🔜 Phase 1 (test exploration) — to be consumed by Phase 2 (RED: test definition).
> **Date:** 2026-07-11
> **Next Phase:** `WEB_ROW_LEVEL_TESTS_PHASE2.md` (or direct implementation in `test/row_staging_store_test.mjs` + `test/row_sync_test.mjs`)

## Architecture Overview

The web-side row-level staging introduces two new modules and updates `sync.js`:

```
RowStagingStore  ← IndexedDB with activity_id key path
       ↑
buildDiff()      ← Pure function: local rows vs remote manifest → action lists
       ↑
RowSync           ← HTTP client for Worker row-level endpoints
       ↑
SyncService      ← Wire into checkAndSync(), replacing blob push/pull
```

## Test Groups

### Group S: RowStagingStore (CRUD) — ~25 tests

Tests the new IndexedDB-backed store with `activity_id` as key path.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| S1 | `putRow(row)` stores a row retrievable by `getRow(activityId)` | Core write/read round-trip | Foundation of all row operations — must ensure data integrity |
| S2 | `getRow(nonexistent)` returns `null` | Missing key semantics | Callers must be able to detect absent rows for scenario 4/5 ("in remote but not local") |
| S3 | `putRow()` with same `activity_id` overwrites (upsert semantics) | Duplicate handling | Pull phase may upsert rows that already exist locally; must update, not error |
| S4 | `putRow()` preserves all fields exactly (activity_id, activity_status, activity, updated_at) | Field completeness | No field loss on round-trip — critical for sync correctness |
| S5 | `deleteRow(activityId)` removes the row | Core delete | Scenario 5 requires deleting committed rows from staging |
| S6 | `deleteRow()` on nonexistent row does not throw | Idempotent delete safety | Remote may send delete for a row already removed locally (race condition) |
| S7 | `getAllRows()` returns all stored rows | Bulk read for diff | `buildDiff()` needs the full local row set to compare against manifest |
| S8 | `getAllRows()` returns empty array for empty store | Empty state handling | First-sync state — must not crash, must return valid empty result |
| S9 | `getAllRows()` order is deterministic (by `updated_at` or insertion) | Ordering guarantee | Consistent diff results needed; slight order differences shouldn't change logic but determinism aids debugging |
| S10 | `getRowsByStatus(status)` filters correctly | Status-indexed lookup | Pull phase may need to find only "active" rows; avoids full scan |
| S11 | `putRow()` handles large `activity` blob (512KB) | Large data storage | Blob-size boundary test — Worker accepts 100MB, 512KB is a realistic staging entry |
| S12 | Store survives `putRow` → `deleteRow` → `putRow` with same ID | Recreate after delete | Edge case: user deletes then recreates an entry before sync completes |
| S13 | Forward-compat: extra fields in row are preserved | Schema evolution | If a future version adds fields (e.g., `sync_priority`), current code must not strip them |
| S14 | `activity_id` with special chars (non-alphanumeric) is accepted at store level | Store vs validation boundary | Store should be a dumb persistence layer; validation belongs in `RowSync`/Worker |
| S15 | Multiple concurrent `putRow` calls for different IDs all succeed | Concurrent mutation safety | Real-world: rapid task creation or batch sync updates |
| S16 | `putRow()` with empty `activity` string is allowed at store level | Store is validation-neutral | Validation at Worker-boundary, not storage layer |
| S17 | `activity_status` of any string value is stored (not validated by store) | Store is validation-neutral | Same rationale as S16 — store doesn't enforce business rules |
| S18 | `updated_at` of 0 (epoch) is stored correctly | Boundary value | 0 is a valid timestamp (Jan 1, 1970) |
| S19 | `updated_at` of `Number.MAX_SAFE_INTEGER` is stored correctly | Large integer boundary | Push guard comparison must work across the full safe integer range |
| S20 | Store initializes empty — no pre-existing data | Clean slate guarantee | New installations must not have phantom rows |
| S21 | Row fields survive JSON serialization round-trip (store → JSON → parse → read) | Serialization fidelity | IndexedDB uses structured clone; must ensure Date/number/string fidelity |
| S22 | `putRow` with `activity_status: null` — store handles as-is (not validated) | Edge type handling | Boundary test for store neutrality |
| S23 | `putRow` with `updated_at: NaN` — store behavior defined (not crash) | Edge type handling | JS NaN propagation can corrupt comparisons; store should either reject or store as-is consistently |
| S24 | Bulk `getAllRows()` for 100+ rows within reasonable time (< 100ms) | Performance baseline | Real-world staging may have dozens of entries; bulk read must be fast |
| S25 | `getRow()` for same key after multiple overwrites returns latest | Ultimate write-wins semantics | Verifies no caching or stale data after repeated updates |

### Group D: buildDiff() Pure Function — ~35 tests

Pure function: `buildDiff(localRows, remoteManifest, ledgerHashIndex) → DiffResult`.
Implements the 8-scenario resolution table from `ROW_LEVEL_STAGING_SYNC_PLAN.md`.

**DiffResult:** `{ pull: activity_id[], push: activity_id[], deleteLocal: activity_id[], fastPath: boolean }`

| ID | Input Setup | Expected DiffResult | Scenario | Rationale |
|----|-------------|---------------------|----------|-----------|
| D1 | Same row in both, remote `updated_at` newer, status differs | `pull: [id]` | Scenario 1 | LWW: remote wins when its timestamp is newer, regardless of status |
| D2 | Same row in both, local `updated_at` newer, status differs | `push: [id]` | Scenario 2 | LWW: local wins when its timestamp is newer |
| D3 | Same row in both, same status, remote `updated_at` newer | `pull: [id]` | Scenario 3 | updated_at is the single version signal — no content hash comparison needed per plan |
| D4 | Same row in both, same status, local `updated_at` newer | `push: [id]` | Scenario 3 | Symmetric: local timestamp wins |
| D5 | Row in remote manifest, not in local | `pull: [id]` | Scenario 4 | Remote has new data this device doesn't — must pull |
| D6 | Row in local, not in remote manifest, entry_id found in ledger hash index | `deleteLocal: [id]` | Scenario 5 | Entry was committed on another device and removed from staging there; clean up locally |
| D7 | Row in local, not in remote manifest, entry_id NOT in ledger hash index | `push: [id]` | Scenario 6 | Genuinely new activity never pushed; push to remote |
| D8 | Remote manifest empty (0 rows) | `{ deleteLocal: [...all_local_ids], fastPath: true }` | Scenario 7 | All committed elsewhere — clear local staging, return READY |
| D9 | Both local and remote empty | `{ pull: [], push: [], deleteLocal: [], fastPath: true }` | Edge: both empty | Nothing to do — fast path |
| D10 | Local empty, remote has rows | `{ pull: [all_remote_ids], ... }` | Scenario 4 aggregate | Brand new device pulling all staging rows |
| D11 | Only local has rows, remote manifest empty, none committed | `{ push: [all_local_ids], ... }` | Scenario 6 aggregate | First device pushing all new entries |
| D12 | Same updated_at on both sides with different status | Defined tie-break (document choice) | Edge: clock collision | Must have a deterministic rule — prefer remote or local consistently |
| D13 | 50 rows with mixed scenarios — verify all classifications correct | Multiple simultaneous scenarios | Stress test for large diff — validates core algorithm at scale |
| D14 | Entry with activity_id that appears in manifest but `activity_status` is null/undefined | Handle gracefully (pull) | Defensive: malformed remote data must not crash diff |
| D15 | Local rows array is null/undefined (treated as empty) | Diff works with null local | Defensive: first call before local rows are loaded |
| D16 | Remote manifest.rows is null/undefined (treated as empty) | Diff works with null manifest | Defensive: network error in manifest fetch |
| D17 | ledgerHashIndex is null/undefined (treated as empty) | Diff works without hash index | Scenario 5/6 become 6 (all local-only rows become push candidates) |
| D18 | Row appears in BOTH pull and push lists after diff | Impossible — should not happen | Invariant check: a row can only be in one action list |
| D19 | Same `entry_id` with different `activity_id` in local vs remote | Treat as different rows (no merge) | activity_id is the identity anchor — entry_id correlation is for migration only |
| D20 | `updated_at` is string "100" vs number 100 | Type coercion behavior defined | Defensive: malformed data must not cause NaN comparisons |
| D21 | `updated_at` is negative number | treat as older than any positive (still LWW) | Edge: negative timestamps should be valid but sorted correctly |
| D22 | Row with `activity_id` matching regex `[A-Za-z0-9]{10}` | Correctly diffed | Normal case — all real activity_ids match this pattern |
| D23 | Duplicate `activity_id` in remote manifest (corrupted data) | First entry wins or last entry wins — document | Defensive: malformed remote may have duplicates |
| D24 | buildDiff is a pure function — same inputs → same outputs | Deterministic | Called multiple times across sync phases; must be idempotent |
| D25 | buildDiff does not mutate its inputs | Immutability | Prevents side effects that could corrupt local rows or manifest |
| D26 | Fast path: nothing to do (all rows match exactly, same updated_at and status) | `{ pull: [], push: [], deleteLocal: [] }` | No-op case | Common case after immediate re-sync — must not waste network calls |
| D27 | Row in local `activity_status: 'active'`, remote `activity_status: 'paused'`, same updated_at | Defined tie-break | Status-only change with no timestamp difference — needs deterministic resolution |
| D28 | Scenario 5 + 6 mixed: 3 local-only rows, 2 committed, 1 new | 2 in deleteLocal, 1 in push | Realistic batch: some entries committed while others are new |
| D29 | Empty string `activity_id` in manifest | Skips/handles gracefully | Defensive: no row should have empty ID but guard against it |
| D30 | Manifest version field is ignored by diff (or passed through) | Version not used in diff logic | Per plan: version is for future etag use, not for current diff |
| D31 | buildDiff handles `activity_id` with max length (20 chars per ACTIVITY_ID_RE) | Works correctly | Upper boundary of spec |
| D32 | buildDiff handles `activity_id` with min length (10 chars) | Works correctly | Lower boundary of spec |
| D33 | Scenario 8: committed on A, deleted from A's staging, still in B's staging, found in B's ledger hash index | `deleteLocal: [id]` for B | Cross-device committed cleanup — must not re-push committed entries |
| D34 | Remote manifest has row with `activity_id` but no `activity_status` field | Handle gracefully (default status or skip) | Defensive: schema evolution backward compat |
| D35 | Remote manifest has row with no `updated_at` field | Handle gracefully (treat as 0 or skip) | Defensive: malformed remote row |

### Group W: RowSync HTTP Integration — ~30 tests

Tests the HTTP client that talks to Worker row-level endpoints. Mocked transport (MockRemoteBackend or custom mock functions).

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| W1 | `fetchManifest()` returns `{rows: [...], version: N}` on 200 | Core manifest pull | Entry point for all sync — must correctly parse Worker response |
| W2 | `fetchManifest()` returns `{rows: [], version: 0}` for empty staging | Empty remote state | First sync on clean Worker — must handle gracefully |
| W3 | `fetchManifest()` throws/handles network error | Offline resilience | Offline mode must not crash — surfacing error cleanly |
| W4 | `fetchManifest()` throws/handles invalid JSON response | Malformed response guard | Worker bug or proxy corruption must not cause unhandled parse errors |
| W5 | `fetchManifest()` throws/handles 403 (auth failure) | Auth error handling | Wrong API key or expired key must produce clear error |
| W6 | `fetchRow(activityId)` returns full row on 200 | Core row pull | Pull phase fetches individual rows by ID after diff |
| W7 | `fetchRow(activityId)` returns null/sentinel on 404 | Missing row handling | Row may have been deleted between manifest fetch and row pull (race) |
| W8 | `fetchRow(activityId)` returns full row with all fields intact | Field completeness | Round-trip: Worker GET must match what was PUT |
| W9 | `fetchRow()` with special chars in activity_id (URL-encodable) | URL encoding correctness | IDs are alphanumeric but transport layer must still handle encoding |
| W10 | `pushRow(row)` returns success on 200 | Core row push | Push phase sends individual rows after diff |
| W11 | `pushRow(row)` returns 409 conflict when `updated_at` is not newer | Push guard detection | Client must detect 409 and re-resolve — critical for conflict-free sync |
| W12 | `pushRow(row)` after 409: row data unchanged on remote | Push guard integrity | Verification that 409 actually prevented overwrite |
| W13 | `pushRow(row)` returns 400 on invalid body (missing field) | Validation error handling | Worker validates; client must surface validation errors |
| W14 | `pushRow(row)` with large body (512KB) succeeds | Large payload support | Realistic obfuscated entry size boundary |
| W15 | `deleteRow(activityId)` returns success on 200 | Core row delete | Scenario 5 triggers remote delete after local commit |
| W16 | `deleteRow(activityId)` returns 404 for nonexistent row | Idempotent delete | If row already deleted on remote, client should treat as success |
| W17 | Pull phase: fetch manifest → diff → fetch changed rows → yield results | End-to-end pull orchestration | Main pull workflow — must correctly sequence all steps |
| W18 | Push phase: push local changes → handle 409s → verify final state | End-to-end push orchestration | Main push workflow — 409 retry is critical |
| W19 | Push phase: 409 triggers re-pull of that specific row + re-resolve | Conflict resolution flow | Core sync contract: on 409, re-pull manifest row, re-diff, re-attempt |
| W20 | Pull rows batched: multiple rows fetched in parallel | Performance optimization | Multiple rows to pull should be fetched concurrently, not sequentially |
| W21 | Push rows batched: multiple rows pushed in parallel | Performance optimization | Same rationale as W20 for push direction |
| W22 | Network error during push of one row does not affect other pushes | Partial failure isolation | If push of row A fails but row B succeeds, state should reflect partial success |
| W23 | RowSync honors auth header (X-Api-Key) on all requests | Auth consistency | Every request must include API key for Worker auth |
| W24 | RowSync includes CORS-safe headers | Browser compatibility | Web app must make cross-origin requests successfully |
| W25 | `pushRow()` with `activity_id` mismatch between URL path and body → error | Path/body consistency | Worker validates this; client should catch early to avoid wasted round-trips |
| W26 | `fetchManifest()` response version field is preserved | Version passthrough | While not used in diff, version may be used for future etag optimization |
| W27 | Concurrent `pushRow` + `fetchManifest` (simulated race) — no data corruption | Race condition safety | Real-world: user creates entry while background sync is pulling manifest |
| W28 | Retry logic: transient network failure → retry N times → eventual success | Resilience | Transient network issues (wifi blip) should not cause sync to fail |
| W29 | Full pull + push cycle: local changes → push → pull from another "device" → verify | Cross-device simulation | Full end-to-end with mock Worker simulating two clients |
| W30 | Clear remote staging: DELETE all rows then verify manifest is empty | Remote cleanup | Needed for "clear remote" functionality |

### Group M: Migration — ~12 tests

Tests conversion from old blob format (`'entries'` array) to new row-level store.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| M1 | `migrateBlobToRows()` detects old blob format present | Migration trigger | Must correctly identify when migration is needed |
| M2 | `migrateBlobToRows()` skips when marker already exists (idempotent) | Idempotency | Must not re-run migration and duplicate rows |
| M3 | Blob with 3 entries → migrates to 3 rows in new store | Core migration: entry count | Exact 1:1 mapping from old entries to new rows |
| M4 | Migrated rows preserve all fields: activity_id, activity_status, updated_at, activity | Data fidelity | No field loss during conversion |
| M5 | Entries without `activity_id` get one generated during migration | activity_id backfill | Older entries created before Phase 3 work may lack activity_id |
| M6 | Migration writes marker after completion | Marker persistence | Prevents re-migration on next load |
| M7 | Migration with empty `'entries'` array (no data) | Empty migration | Clean install shouldn't crash migration |
| M8 | Migration with corrupted blob data → handled gracefully (skip/best-effort) | Corruption resilience | Corrupt local data must not block migration entirely |
| M9 | Migration drops old `'entries'` key after success | Cleanup | Old blob must be removed to free storage |
| M10 | `migrateBlobToRows()` runs at most once (marker check before all operations) | Performance guard | Migration check must be O(1) on every app start |
| M11 | Migration preserves `committed` and `block_index` fields on each entry | Commit state fidelity | Committed entries must remain committed after migration |
| M12 | Migration with large blob (200+ entries) completes within 5 seconds | Performance baseline | Realistic worst-case: heavy user with many staging entries |

### Group I: Integration / End-to-End — ~18 tests

Full sync cycle with mock Worker (extending MockRemoteBackend to simulate Worker endpoints).

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| I1 | Full sync: local entry created → `checkAndSync` → row appears on remote via pushRow | Basic push integration | Core workflow: create locally, sync, verify on remote |
| I2 | Full sync: remote has new row → `checkAndSync` → row appears locally via pull | Basic pull integration | Core workflow: remote change, sync, verify locally |
| I3 | Full sync: remote has updated row (newer `updated_at`) → local row updated | LWW pull resolution | Integrates scenario 1/3: remote wins, local updated |
| I4 | Full sync: local has updated row (newer `updated_at`) → remote row updated | LWW push resolution | Integrates scenario 2/3: local wins, pushed to remote |
| I5 | Full sync: committed entry removed from local staging, also removed from remote | Commit cleanup | Integrates scenario 5: commit triggers remote delete |
| I6 | Full sync: 409 conflict → re-resolve → eventual consistency | Conflict resolution integration | Full 409 retry flow with real state changes |
| I7 | Cross-device: device A creates → syncs → device B syncs → B sees A's entry | Multi-device simulation | Two `SyncService` instances with shared mock Worker |
| I8 | Safe start: no remote, local has entries → `checkAndSync` returns READY (push local) | Offline-to-online transition | No remote means push-only; must not lose local data |
| I9 | Fast path: `checkAndSync` with no changes returns READY without network calls | Cookie fast-path preserved | Existing cookie-based fast path must still work with row-level sync |
| I10 | `checkAndSync` with empty local + empty remote → READY (no-op) | Clean state | First install, nothing to do |
| I11 | Offline: transport unavailable → `checkAndSync` returns OFFLINE | Offline handling | Must not block UI when network is down |
| I12 | Re-auth: cookie mismatch → `checkAndSync` returns REAUTH_NEEDED | Auth gate preserved | Existing auth gate must work alongside new row sync |
| I13 | Genesis mismatch: different genesis on remote → GENESIS_MISMATCH | Genesis gate preserved | Existing genesis check must still work |
| I14 | Sync with 50 local + 50 remote rows → complete within 5 seconds | Performance integration | Realistic scale test: moderate user with many staging entries |
| I15 | `checkAndSync` updates local cookie after successful sync | Cookie TTL refresh | Cookie must be touched so fast-path works on next call |
| I16 | Pull phase correctly updates `updated_at` on local rows | Timestamp sync | Pulled rows must carry remote's updated_at for future diff correctness |
| I17 | `pushToRemote()` (direct push without pull) works with row-level sync | Direct push flow | Existing push-only use cases must work with new row storage |
| I18 | `clearRemote()` deletes all remote rows and manifest | Remote cleanup | Clear-remote functionality must work at row level |

## Summary

| Group | Tests | Focus |
|-------|-------|-------|
| S — RowStagingStore CRUD | 25 | IndexedDB row storage with activity_id keypath |
| D — buildDiff() | 35 | Pure function: 8-scenario resolution table |
| W — RowSync HTTP | 30 | Worker endpoint communication + push guard handling |
| M — Migration | 12 | Blob → rows conversion with idempotency |
| I — Integration | 18 | Full sync cycle with mock Worker |
| **Total** | **120** | |

## Test Architecture Notes

- **RowStagingStore tests (S)** — Test against MemoryBackend for unit tests; same MemoryBackend that existing tests use. RowStagingStore wraps a StorageBackend with key prefix (e.g., `staging:row:`) but otherwise looks like the existing store pattern.
- **buildDiff tests (D)** — Pure function, zero dependencies. Test with simple arrays of row objects. Ideal candidate for property-based testing.
- **RowSync tests (W)** — Use a mock Worker implementation that extends MockRemoteBackend's transport interface to add Worker-specific endpoint simulation (manifest, row CRUD, push guard, auth).
- **Migration tests (M)** — Test with MemoryBackend seeded with old blob format. Migrator reads from old `'entries'` key, writes to new store, writes marker.
- **Integration tests (I)** — Wire `SyncService` to mock Worker. Two `SyncService` instances share one mock Worker to simulate multi-device.

## Existing Code Impact

| Module | Change |
|--------|--------|
| `src/sync/row_staging_store.js` | **NEW** — RowStagingStore class |
| `src/sync/row_sync.js` | **NEW** — buildDiff + RowSyncWorker |
| `src/sync/migration.js` | **NEW** — migrateBlobToRows |
| `src/sync/sync.js` | **MODIFY** — Wire row sync into checkAndSync, pushToRemote |
| `src/sync/keys.js` | **MODIFY** — Add row-level remote paths |
| `src/sync/mock_remote.js` | **EXTEND** — Add Worker endpoint simulation |
| `test/row_staging_store_test.mjs` | **NEW** |
| `test/row_sync_test.mjs` | **NEW** |
| `test/row_integration_test.mjs` | **NEW** |
