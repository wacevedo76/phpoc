# Row-Level Staging Sync — Implementation Plan

> **ADR:** `../design/ARCHITECTURAL_DECISIONS.md` §ADR-025
> **Status:** 🔜 Design complete — implementation pending
> **Date:** 2026-07-08

## Purpose

Define the concrete implementation rules, phases, and contract for converting the
staging sync layer from monolithic blob push/pull to row-level LWW sync. This is
the implementation companion to ADR-025. Refer to ADR-025 for rationale and context;
this document is the engineer's reference during implementation.

## Sync Contract: 8-Scenario Resolution Table

This table is the source of truth for every resolution decision. Every implementation
(web, CLI) must produce identical outcomes for each scenario.

| # | Situation | Resolution |
|---|---|---|
| 1 | Same `activity_id`, `activity_status` differs, remote `updated_at` newer | Pull full row from remote → overwrite local |
| 2 | Same `activity_id`, `activity_status` differs, local `updated_at` newer | Push local row to remote in push phase |
| 3 | Same `activity_id`, same `activity_status`, `updated_at` differs | LWW on full row. Pull if remote newer; push if local newer. `updated_at` is the single version signal — no content hash comparison needed. |
| 4 | In remote manifest, not in local | Pull full activity row to local |
| 5 | In local, not in remote manifest, `entry_id` found in ledger hash index | Delete from local staging (committed elsewhere) |
| 6 | In local, not in remote manifest, `entry_id` NOT in ledger hash index | Push to remote (genuinely new activity, never pushed) |
| 7 | Remote manifest empty (all committed) | Fast path: clear local staging, return READY |
| 8 | Committed on device A, deleted from staging; device B still has it | Resolved by scenario 5 — ledger hash index reveals committed status |

## Sync Cycle: Step-by-Step

### Phase 1: Entry Guard (unchanged from current)
```
check_and_sync():
  1. Cookie fast path (ADR-022)
     ├── Valid cookie + match → READY (no sync needed)
     └── No/expired cookie or mismatch → continue to Phase 2
```

### Phase 2: Pull + Diff
```
  2. Pull remote staging manifest
     GET /storage/staging/manifest
     → {rows: [{activity_id, activity_status, updated_at}, ...], version: N}

  3. Pull ledger hash index (inline, always fresh)
     GET /storage/ledger/hash-index
     → {entry_id → committed_at, ...}

  4. Build diff:
     remote_ids = set(manifest.rows.map(r => r.activity_id))
     local_ids  = set(local_rows.map(r => r.activity_id))

     for each row in (remote_ids ∪ local_ids):
       apply scenario table (1–8)
       collect actions: {pull: [...], push: [...], delete: [...]}
```

### Phase 3: Execute Pulls
```
  5. Pull changed/new rows from remote
     for each row in actions.pull:
       GET /storage/staging/rows/{activity_id}
       → {activity_id, activity_status, activity, updated_at}
       upsert into local staging
```

### Phase 4: Execute Local Changes
```
  6. Delete committed rows
     for each row in actions.delete:
       remove from local staging

  7. Push new/changed rows to remote
     for each row in actions.push:
       PUT /storage/staging/rows/{activity_id}
         body: {activity_id, activity_status, activity, updated_at}
       ├── 200 OK → done
       └── 409 Conflict → re-pull manifest for this row, re-resolve
```

### Phase 5: Return Control
```
  8. Return READY — staging sync complete
  9. Trigger async ledger sync (background)
```

## Worker Contract (New Endpoints)

Replaces the current single-blob `GET/PUT /storage/staging` endpoints.

### Manifest

```
GET /storage/staging/manifest
  → 200: {
      rows: [{activity_id: string, activity_status: string, updated_at: number}, ...],
      version: number  // monotonic, for future etag use
    }
  → 200: {rows: [], version: 0}  // empty staging (all committed)
```

### Row Operations

```
GET /storage/staging/rows/{activity_id}
  → 200: {activity_id, activity_status, activity, updated_at}
  → 404: row not found

PUT /storage/staging/rows/{activity_id}
  body: {activity_id, activity_status, activity, updated_at}
  → 200: row stored
  → 409: incoming updated_at ≤ stored updated_at (rejected)

DELETE /storage/staging/rows/{activity_id}
  → 200: row deleted
  → 404: row not found
```

### Push Guard (Worker-Side)

```
On PUT /storage/staging/rows/{activity_id}:
  existing = storage.get(activity_id)
  if existing and body.updated_at <= existing.updated_at:
    return 409 Conflict
  storage.put(activity_id, body)
  return 200 OK
```

Simple numeric comparison. No version tokens, no etags. Client treats 409 as
"re-pull manifest and re-resolve for this row."

## Per-Row Obfuscation Format

Each row stored on the Worker uses the same obfuscation scheme as ADR-015b,
applied per-row:

```
per_row_key = HMAC(master_key, "phpoc:staging-row-key:" + activity_id)
obfuscated_row = AES-CTR(JSON(row), per_row_key) | nonce | HMAC(per_row_hmac_key, ciphertext)
```

The `updated_at` field in the manifest is **plaintext** — it's a timestamp, not
user content. The `activity` blob within a row is obfuscated. The `activity_id`
and `activity_status` in the manifest are plaintext.

## Row Schema

```
activity_id:    string    10-char CSPRNG (e.g., "AbC3XyZ7Qr")
activity_status:string    "staged" | "active" | "paused"
activity:       string    obfuscated entry blob (title, tags, times, etc.)
updated_at:     number    Unix epoch milliseconds
```

## Implementation Phases

### Phase A: Web (phpoc-web)

1. **Define IndexedDB object store schema** — `staging` store with `activity_id` as
   key path, indexes on `activity_status` and `updated_at`
2. **Implement `StagingStore` (IndexedDB)** — CRUD for rows, bulk read for diff
3. **Implement `buildDiff()`** — compare local rows vs remote manifest → action lists
4. **Implement pull phase** — fetch manifest, fetch hash index, diff, pull changed rows
5. **Implement push phase** — push local changes with 409 retry
6. **Wire into `checkAndSync()`** — replace blob-based sync with row-based sync
7. **Test** — all existing staging tests must pass; add scenario-specific tests

### Phase B: CLI (phpoc-cli)

1. **Define `SqliteStagingStore`** — three-column schema:
   ```sql
   CREATE TABLE staging (
     activity_id TEXT PRIMARY KEY,
     activity_status TEXT NOT NULL,
     activity TEXT NOT NULL,        -- obfuscated entry blob
     updated_at INTEGER NOT NULL
   );
   ```
2. **Implement store** — CRUD methods, bulk read, migration from `staging.json`
3. **Implement `buildDiff()`** — same logic as web, language-portable
4. **Implement pull/push phases** — Python equivalents of web implementation
5. **Wire into `StagingService.sync()`** — replace blob-based sync
6. **Test** — all 1609 Python tests must pass

### Phase C: Worker (phpoc-worker)

1. **Implement manifest endpoint** — `GET /storage/staging/manifest`
2. **Implement row endpoints** — `GET/PUT/DELETE /storage/staging/rows/{id}`
3. **Implement push guard** — `updated_at` comparison on PUT
4. **Add vitest tests** — manifest format, row CRUD, 409 rejection, edge cases

## Migration

### Web: Blob → IndexedDB Rows
```
1. On first load after update, detect old blob format
2. Read existing blob, deobfuscate
3. Extract entries array
4. For each entry, generate activity_id (if missing), insert as row
5. Drop old blob key
6. Write migration marker so it only runs once
```

### CLI: staging.json → SQLite
```
1. Detect staging.json exists and SQLite DB does not
2. Read staging.json entries
3. For each entry, generate activity_id (if missing from Phase 3 work),
   set updated_at = file mtime or current time, insert row
4. Create SQLite DB with migrated rows
5. Rename staging.json → staging.json.migrated (keep as backup)
```

## Test Strategy

### Web Tests (new)
| Category | Tests | Covers |
|---|---|---|
| StagingStore CRUD | ~20 | Read/write/delete rows, bulk operations |
| buildDiff() | ~30 | All 8 scenarios, edge cases |
| Sync pull phase | ~20 | Manifest fetch, row pull, upsert |
| Sync push phase | ~20 | Push with 409 retry, guard behavior |
| Migration | ~10 | Blob-to-rows conversion |
| Integration | ~20 | Full sync cycle, cross-client simulation |

### CLI Tests (new)
| Category | Tests | Covers |
|---|---|---|
| SqliteStagingStore | ~30 | Schema, CRUD, migration, error handling |
| buildDiff() | ~30 | Identical logic to web, Python-specific edge cases |
| Sync pull/push | ~30 | Transport calls, 409 handling |
| Integration | ~20 | Full sync cycle, backward compat |

### Worker Tests (new)
| Category | Tests | Covers |
|---|---|---|
| Manifest endpoint | ~10 | Format, empty state, version increment |
| Row CRUD endpoints | ~15 | GET/PUT/DELETE, 404 handling |
| Push guard | ~10 | 409 on stale update_at, exact-match behavior |
| Obfuscation | ~5 | Per-row encrypt/decrypt round-trip |

## Open Questions

1. **Clock skew tolerance:** Two devices may disagree on `updated_at` by a few seconds.
   In LWW, the device whose clock is ahead wins even if its change happened later in
   real time. Mitigation: single-user reality makes this marginal. If it becomes a
   problem, a future iteration could use a logical clock (Lamport timestamp) sourced
   from the Worker.

2. **Manifest version field:** Currently included as `version: number` for future
   etag/conditional-request use. Not used in Phase A implementation. Can be ignored
   until a specific use case arises.

3. **Per-row padding:** ADR-015b uses tiered padding (64KB/128KB/256KB/512KB) for the
   monolithic blob. For per-row storage, padding per individual row (~1KB each) may
   be unnecessary overhead. Decision deferred to Worker implementation phase — start
   without per-row padding and add it only if timing analysis reveals a privacy leak.
