# Flutter Staging Schema Overhaul — Test Exploration (Phase 1)

> **Reference:** `docs/planning/ROW_LEVEL_STAGING_SYNC_PLAN.md` (web row-level sync plan)
> **Purpose:** Blueprint of all needed test assertions before writing any test code.
> **Status:** 🔜 Phase 1 (test exploration)
> **Next Phase:** Phase 2 (RED: test definition)

## Architecture Overview

Replaces Flutter's monolithic `entries` JSON-array blob in `_staging_kv` with a row-per-activity
schema matching phpoc-web's `RowStagingStore`. Introduces activity IDs, `updated_at` LWW
timestamps, auto-push on mutation, commit-and-clean pipeline, and offline retry.

### Modules affected

| Module | File | Change |
|--------|------|--------|
| ActivityIdGenerator | **new** `lib/data/sync/activity_id.dart` | Generate 10-char CSPRNG activity_id |
| StagingStore | **new** `lib/data/sync/staging_store.dart` | Row-per-activity SQLite table CRUD |
| LocalCache | `lib/data/sync/local_cache.dart` | Replaced by StagingStore; existing hash/I/O helpers may move |
| SyncService | `lib/data/sync/sync_service.dart` | Auto-push on mutation, commit-and-clean, offline queue |
| LedgerEngine | `lib/data/ledger/engine.dart` | expose `committedActivityIds:` from `commit()` |
| SyncScreen | `lib/features/sync/sync_screen.dart` | Single Sync button, commit-all vs commit-selected, status indicator |
| Database | `lib/data/storage/database.dart` | New `staging` table migration |
| MigrationRunner | **new** `lib/data/storage/migration.dart` | Migrate old `entries` blob → new `staging` rows |

### Schema: old → new

| Old (`_staging_kv` entries JSON array) | New (`staging` table) |
|---|---|
| `entry_index` (positional) | `activity_id` (TEXT PK, 10-char CSPRNG) |
| `is_active` / `is_paused` (booleans) | `activity_status` (TEXT: `"active"` / `"paused"` / `"ended"`) |
| `data: {...}` (nested encrypted blob) | `activity` (TEXT, JSON-encoded encrypted entry data) |
| (none) | `updated_at` (INTEGER, epoch ms — LWW tiebreaker) |

### Workflow: One Sync button

```
Sync (tap)
  ├─ 1. Commit selected/all ended activities → local ledger (build block, seal)
  ├─ 2. Remove committed activities from staging by activity_id
  ├─ 3. Push ledger blocks to R2 (if remote configured + network available)
  └─ 4. Push staging rows to R2 (now clean)
```

### Workflow: Auto-push on mutation

```
capture/end/pause/unpause/modify
  ├─ Write to local staging table (bump updated_at)
  └─ Debounced (500ms) push staging rows to R2
```

### Workflow: Offline → online

```
Network unavailable during auto-push
  → Queue pending activity_ids
  → Show 🟡 indicator
Network restored (connectivity listener)
  → Flush queue: push pending rows + ledger blocks
  → Show 🟢 indicator
```

---

## Test Groups

### Group A: ActivityIdGenerator — ~8 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | `generateActivityId()` returns 10-char alphanumeric string | Output format contract | All platforms must produce same length/character set |
| A2 | Two consecutive calls produce different IDs | Uniqueness | IDs must be distinct within a session |
| A3 | 10,000 IDs have zero collisions | Collision resistance | 36^10 ≈ 3.6×10^15 space; 10K draws should have zero collisions |
| A4 | Only `[A-Za-z0-9]` characters appear in output | Character set | No special chars that break URLs or JSON keys |
| A5 | Output is not predictable from input seed (basic entropy check) | CSPRNG quality | Uses `dart:math` Random.secure() |
| A6 | No sequential pattern across 100 IDs | Non-sequential | Prev ID should not predict next ID |
| A7 | `generateActivityId()` doesn't throw in any environment | Graceful degradation | Falls back to pseudo-random if CSPRNG unavailable |
| A8 | `isValidActivityId(id)` validates format (10-char alphanumeric) | Input validation | Guard against malformed IDs from remote |

### Group B: StagingStore CRUD — ~18 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | `putRow(row)` stores a row and returns void | Core insert | Basic CRUD path |
| B2 | `getRow(activityId)` returns stored row | Core read | Primary key lookup |
| B3 | `getRow(nonexistentId)` returns null | Missing key | Must not throw, must return null |
| B4 | `putRow()` on existing activity_id overwrites (upsert) | Update semantics | LWW push uses upsert |
| B5 | `putRow()` preserves all 4 core fields (activity_id, activity_status, activity, updated_at) | Field integrity | No data loss on round-trip |
| B6 | `putRow()` preserves extra fields beyond the 4 core fields | Forward compat | Matches RowStagingStore forward-compat rule |
| B7 | `deleteRow(activityId)` removes the row | Core delete | Deletion by PK |
| B8 | `deleteRow(nonexistentId)` is idempotent (no throw) | Idempotent delete | Safe to call when row already deleted |
| B9 | `getAllRows()` returns all rows sorted by activity_id | Bulk read | Deterministic order for diff comparison |
| B10 | `getAllRows()` returns [] when table is empty | Empty state | Must not return null |
| B11 | `getRowsByStatus('active')` filters correctly | Status query | Used by Dashboard for active tasks |
| B12 | `getRowsByStatus('paused')` returns only paused rows | Status query | Used by Dashboard for paused tasks |
| B13 | `getRowsByStatus('ended')` returns only ended rows | Status query | Used by "Ready to Commit" section |
| B14 | `count()` returns correct count after inserts/deletes | Diagnostics | Used by sync status badge |
| B15 | `putRow()` bumps `updated_at` to current time | Timestamp freshness | Required for LWW comparison |
| B16 | Concurrent `putRow` on same activity_id (last wins) | Concurrency | Final state = last write |
| B17 | Storage survives app restart (data persisted to SQLite) | Persistence | Must use DB, not in-memory |
| B18 | Schema migration creates `staging` table if not exists | Migration | First-run creates table |

### Group C: Migration (old entries blob → rows) — ~12 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | Migration detects old `entries` blob and migrates | Trigger | Only runs when old format exists |
| C2 | Migration is a no-op when `staging` table already has rows | Idempotent | Safe to run multiple times |
| C3 | Each migrated entry gets a generated `activity_id` | ID assignment | Old entries have no activity_id |
| C4 | Migrated entry's `activity_status` derived from is_active/is_paused | Status mapping | active→"active", paused→"paused", !active→"ended" |
| C5 | Migrated entry's `activity` field contains original encrypted data blob | Data preservation | No data loss during migration |
| C6 | Migrated entry's `updated_at` set to migration time (or original end_epoch) | Timestamp seeding | Reasonable initial timestamp |
| C7 | Migration sets a `migrated_v1` flag in storage to prevent re-run | Migration marker | Prevents double-migration |
| C8 | Entry with `committed: true` in old blob is NOT migrated to staging table | Committed filter | Committed entries should already be in ledger, not staging |
| C9 | Entry with existing `activity_id` in old blob preserves it | ID preservation | Web-originated entries already have activity IDs |
| C10 | Migration handles empty `entries` blob gracefully (no crash) | Edge case | Fresh install with empty staging |
| C11 | Migration handles malformed `entries` blob (not a valid list) gracefully | Error resilience | Corrupted storage shouldn't crash app |
| C12 | After migration, old `entries` key is deleted from storage | Cleanup | No stale data left behind |

### Group D: SyncService mutation wrappers — ~15 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | `capture()` generates activity_id, sets status="active", bumps updated_at | New entry contract | Every capture must produce valid row |
| D2 | `capture()` calls `_schedulePush()` after write (auto-push trigger) | Auto-push integration | Mutation → debounced push |
| D3 | `end(activityId)` sets status="ended", bumps updated_at | End contract | Status transition |
| D4 | `end(activityId)` calls `_schedulePush()` after write | Auto-push integration | |
| D5 | `pause(activityId)` sets status="paused", bumps updated_at | Pause contract | |
| D6 | `pause(activityId)` calls `_schedulePush()` after write | Auto-push integration | |
| D7 | `unpause(activityId)` sets status="active", bumps updated_at | Unpause contract | |
| D8 | `unpause(activityId)` calls `_schedulePush()` after write | Auto-push integration | |
| D9 | `modify(activityId, fields)` updates activity blob, bumps updated_at | Modify contract | Content change must update LWW timestamp |
| D10 | `modify(activityId, fields)` calls `_schedulePush()` after write | Auto-push integration | |
| D11 | `remove(activityId)` deletes row from staging | Delete contract | |
| D12 | `remove(activityId)` calls `_schedulePush()` after write | Auto-push integration | |
| D13 | Multiple rapid mutations coalesce into single push (debounce) | Debounce behavior | 3 captures in 100ms → 1 push after 500ms |
| D14 | Mutation before master key is cached skips auto-push (no crash) | Pre-auth safety | Don't push without MK |
| D15 | Mutation when transport is null skips auto-push (no crash) | Local-only safety | Don't crash without remote config |

### Group E: Debounce strategy — ~6 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | Default debounce window is 500ms | Config contract | Matches web useAutoSync default |
| E2 | First mutation starts timer; push fires after 500ms of inactivity | Debounce logic | Timer resets on each new mutation within window |
| E3 | 10 rapid mutations in 400ms → exactly 1 push | Coalescing | Spam protection |
| E4 | `dispose()` cancels pending timer → no push | Cleanup | No push after service destroyed |
| E5 | `isSyncing` is true between first mutation and push completion | State tracking | UI can show spinner during pending push |
| E6 | Push failure resets `isSyncing` to false (doesn't hang) | Error recovery | Network error must not lock UI |

### Group F: Commit-and-Clean pipeline — ~12 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| F1 | `commitAndSync()` commits all ended activities to ledger | Commit all mode | Default behavior: commit all is_active=false |
| F2 | `commitAndSync(selectedIds: [...])` commits only selected activities | Commit selected mode | User checkbox selection |
| F3 | After commit, committed activity_ids are deleted from staging | Cleanup | No committed tombstones in staging |
| F4 | After commit, ledger blocks are pushed to R2 (if remote configured) | Ledger push | Committed data reaches cloud |
| F5 | After commit, clean staging rows are pushed to R2 | Staging push | Other devices see clean staging |
| F6 | commitAndSync with no ended entries returns null (no-op) | Empty state | Nothing to commit → no block created |
| F7 | commitAndSync with only active entries returns null | Active filter | is_active=true entries not committed |
| F8 | commitAndSync with only already-committed entries returns null | Dedup | committed=true entries not re-committed |
| F9 | LedgerEngine.commit() returns list of committed activity_ids | Return value | Needed for cleanup step |
| F10 | Deleted staging entries' activity_ids appear in ledger hash index | Hash index update | Other devices must know they're committed (S5 cleanup) |
| F11 | commitAndSync is idempotent (calling twice produces no duplicate blocks) | Idempotent | Safe to retry |
| F12 | commitAndSync offline: commits locally, queues push, shows 🟡 | Offline resilience | Commit must work without network |

### Group G: Offline queue + visual indicator — ~10 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| G1 | `syncStatus` stream emits `SyncingStatus.inSync` when remote matches local | Green state | Normal operation |
| G2 | `syncStatus` stream emits `SyncingStatus.pendingPush` after mutation without network | Yellow state | Local ahead of remote |
| G3 | `syncStatus` stream emits `SyncingStatus.error` after persistent push failure | Red state | Network or auth error |
| G4 | `connectivityStream` triggers flush of pending queue on reconnect | Auto-retry | Network restored → push pending |
| G5 | Pending queue survives app restart (persisted to disk) | Durability | User closes app with pending → pushes on next launch |
| G6 | Queue flush pushes staging rows first, then ledger blocks | Order | Staging must reflect cleaned state before ledger |
| G7 | Queue items are deduplicated (same activity_id pushed once) | Dedup | Multiple mutations on same activity → single push row |
| G8 | Queue flush failure on one item doesn't block remaining items | Partial progress | Bad row doesn't stop the queue |
| G9 | `isSyncing` is true during queue flush | State tracking | UI can show spinner |
| G10 | Status indicator updates within 200ms of state change | Responsiveness | Perception of real-time feedback |

### Group H: Staging Hash Index — ~8 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| H1 | `buildStagingHashIndex()` returns `[{id, status}, ...]` array | Index format | Matches web staging_hash_index.js |
| H2 | Hash index is pushed alongside staging blob | Push integration | Tier 1 fast path on next sync |
| H3 | Hash index is pulled and cached during `checkAndSync` | Pull integration | Local cache for Tier 1 comparison |
| H4 | `compareStagingHashIndexes(local, remote)` returns `{identical, added, removed, changed}` | Diff output | Tier 1 byte-for-byte comparison |
| H5 | Identical hash indexes → fast path, no row pull needed | Tier 1 fast path | Skip network calls when nothing changed |
| H6 | Changed hash index → fall through to row-by-row diff | Tier 2 fallback | Pull only changed rows |
| H7 | No remote hash index → bootstrap from local entries | Bootstrap | First push creates hash index |
| H8 | Hash index sha256 is computed and pushed for integrity check | Tier 1 integrity | Match web behavior |

### Group I: SyncScreen UI — ~10 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| I1 | SyncScreen shows one "Sync" button (replaces 3 separate buttons) | Unified UX | Single action for full pipeline |
| I2 | "Ready to Commit" section shows ended activities with checkboxes | Selection UI | User can pick which to commit |
| I3 | "Select All" / "Deselect All" toggle affects all checkboxes | Bulk selection | Convenience for commit-all case |
| I4 | Tapping Sync with no selections commits all ended (default) | Commit all default | Fast path: user doesn't need to check boxes |
| I5 | Tapping Sync with selections commits only selected | Commit selected | Respects user choice |
| I6 | Sync button shows spinner during commit+push | Loading state | User knows action is in progress |
| I7 | Error during commit shows SnackBar with message | Error UX | User sees what went wrong |
| I8 | StatusBar shows 🟡 indicator when local ahead of remote | Offline indicator | User knows push is pending |
| I9 | StatusBar shows 🟢 indicator when in sync | Sync indicator | User knows all is good |
| I10 | StatusBar shows 🔴 indicator on persistent error | Error indicator | User knows something is wrong |

### Group J: Merge engine compatibility — ~6 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| J1 | `mergeEntries(local, remote)` uses activity_id as merge key | Merge contract | Replaces positional index-based merge |
| J2 | Remote newer wins for same activity_id (LWW on updated_at) | LWW rule | Matches buildDiff scenario S1 |
| J3 | Local newer wins for same activity_id (LWW on updated_at) | LWW rule | Matches buildDiff scenario S2 |
| J4 | Remote-only activity_id → added to local | Add new | Matches buildDiff scenario S4 |
| J5 | Local-only + committed → removed from local | Cleanup | Matches buildDiff scenario S5 |
| J6 | Local-only + not committed → kept in local | Preserve new | Matches buildDiff scenario S6 |

### Group K: Legacy API backwards compatibility — ~5 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| K1 | `readEntries()` still returns flat DTO list for Dashboard/SyncScreen consumers | Consumer compat | Dashboard & SyncScreen use readEntries() |
| K2 | `getActive()` returns rows where status="active" in StagingStore | Active query | Dashboard "Active" tab |
| K3 | `getCompleted()` returns rows where status="ended" AND not in ledger | Completed query | Dashboard History + SyncScreen "Ready to Commit" |
| K4 | Index-based `modify(index, fields)` adapter maps index → activity_id internally | Adapter | SyncScreen card edit uses index-based modify |
| K5 | `commitEntries()` (old name) delegates to `commitAndSync()` with no selections | Alias | Existing callers don't break |

---

## Summary

| Group | Area | Count |
|-------|------|-------|
| A | ActivityIdGenerator | 8 |
| B | StagingStore CRUD | 18 |
| C | Migration (old → new) | 12 |
| D | Mutation wrappers (auto-push) | 15 |
| E | Debounce strategy | 6 |
| F | Commit-and-Clean pipeline | 12 |
| G | Offline queue + visual indicator | 10 |
| H | Staging Hash Index | 8 |
| I | SyncScreen UI | 10 |
| J | Merge engine compatibility | 6 |
| K | Legacy API backwards compat | 5 |
| **Total** | | **110** |

### Key design decisions captured

1. **Four-column schema** (`activity_id`, `activity_status`, `activity`, `updated_at`) — matches phpoc-web RowStagingStore exactly
2. **Single Sync button** — commits → cleans → pushes ledger → pushes staging, all in one pipeline
3. **Auto-push with debounce** — html-useAutoSync pattern, 500ms window
4. **Offline-first** — commit happens locally regardless of network; push queued
5. **Activity ID as PK** — replaces positional entry_index; stable across mutations and merges
6. **LWW on updated_at** — no content hash comparison; newer timestamp wins full row
7. **Staging hash index** — Tier 1 fast path (SHA-256 compare), Tier 2 row-by-row diff
