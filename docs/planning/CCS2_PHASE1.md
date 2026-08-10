# CCS-2 — Web Row-Level Sync Wiring, Option B (Test Exploration / Phase 1)

> **Plan refs:** `docs/planning/ROW_LEVEL_STAGING_SYNC_PLAN.md` · `CROSS_CLIENT_REMOTE-LOCAL_STAGING_SYNC-RECONCILIATION_PLAN.md` §12
> **Decision:** **Option B** — `LocalCache` remains the authoritative CRUD store; add a **row-level reconcile layer** layered on top of it. `RowStagingStore` stays the wire/serialization + migration target, not the runtime store.
> **Status:** ✅ Phases 1–4 complete (CCS-2 web row-level sync, Option B)
> **Result:** `phpoc-web/test/ccs2_row_level_reconcile_test.mjs` **41/41 GREEN**; full web suite no regressions (76/14, 14 pre-existing env/WASM/DOM). Phase 4 refactor: `_mergeRemoteIntoLocal()` + `_rowsFromRemoteBlob()` extracted; dead `compareStagingHashIndexes`/`computeHashForIndex` imports removed.

## Scope After Review (adjusting the earlier draft)

The earlier `CCS-2_PHASE1` draft assumed **Option A** (migrate `SyncService` runtime storage to
`RowStagingStore`). Review found that is a **large, high-risk refactor**: `sync.js` calls **11
distinct `LocalCache` methods across 27 call sites**, and the 287 passing staging tests read
reconcile output via `readEntries()` (the LocalCache DTO boundary). Adopted **Option B** to keep
CCS-2 a coherent 4-phase-TDD increment that realizes the *sync behavior* (activity_id LWW merge,
canonical blob, Tier-1 structured fast path) without the CRUD storage migration.

### Verified current-state facts (grounding for this blueprint)

| Area | Current state |
|---|---|
| Reconcile merge (`sync.js:799`) | `mergeEntries(localEntries, remoteDTOs)` — **entry_id-based, remote-wins** |
| Local store | `LocalCache` monolithic `entries` array (authoritative) |
| `RowStagingStore` / `mergeRows` / `buildDiff` | Ready, GREEN, but **not referenced by any source module** |
| `compareStagingHashIndexes` | Imported at `sync.js:75` but **never called** (dead import) |
| Tier-1 fast path (`_fastPathPhase`) | compares **SHA-256 of the encrypted hash-index blob**, not `compareStagingHashIndexes` |
| `dtoToCanonicalRow` | **private** in `remote_sync.js` (not exported) — needed by a row-level reconcile layer |
| `row_integration_test.mjs` | M/I groups **gated off** on retired `RowSyncWorker` → 0 tests execute |
| `sync_service_test.mjs` | 289 pass / 21 fail — all 21 are **ledger-chain** (M/W/T groups), out of CCS-2 scope |

### CCS-2 (Option B) deliverable

A row-level **sync reconcile layer** that threads canonical-row semantics into the existing
`SyncService.checkAndSync()` flow while leaving the `LocalCache` CRUD/DTO contract untouched:

1. Read local entries from `LocalCache.readEntries()` (unchanged).
2. Convert local DTOs **and** remote blob rows to **canonical rows** (activity_id-keyed).
3. Merge with **`mergeRows`** (activity_id LWW, **local-wins on tie**, committed-exclusion,
   irreversibility) instead of `mergeEntries`.
4. Convert merged canonical rows back to DTOs and write via `LocalCache.writeEntries()`
   (contract preserved).
5. Wire **`compareStagingHashIndexes`** into the Tier-1 fast-path decision (currently dead
   import; fast path uses only encrypted-blob SHA-256 equality).
6. Keep the canonical blob serialization (`remote_sync.pushBlob`) and `REMOTE_STAGING_BLOB`
   path as-is.

**Explicitly NOT doing** (Option A, deferred): re-route `capture/end/pause/modify/remove`
CRUD through `RowStagingStore`; deprecate the `entries` array; make the row store authoritative.

## Test Groups (Option B)

> TDD taxonomy is explicit so Phase 2 writes **only** genuinely-new RED tests:
> - 🟢 **Regression anchor** = already GREEN; rerun every phase, must not regress.
> - 🔴 **New RED** = does not pass today; the actual CCS-2 target to implement.

### Group A: Standardize on `mergeRows` in reconcile (R1–R4) — 4 tests

| ID | Class | Assertion | Status today |
|----|-------|-----------|--------------|
| A1 | 🔴 | Reconcile merges a remote-only **canonical** row (`activity_id`) into local, producing the DTO in `readEntries()` | `mergeEntries` also handles it, but A1 pins the canonical path |
| A2 | 🔴 | Reconcile with the **same `activity_id`** on both sides, **local `updated_at` newer** → local wins and is pushed | `mergeEntries` is entry_id/remote-wins → **need `mergeRows`** → RED |
| A3 | 🔴 | Reconcile with same `activity_id`, **remote `updated_at` newer** → remote wins locally | RED until `mergeRows` wired |
| A4 | 🔴 | Reconcile with same `activity_id`, **equal `updated_at`**, different status → **local wins on tie** (PHPSPEC §8.5, matches Flutter) | `mergeEntries` remote-wins → **RED**, this is the defining LWW-tie assertion |

### Group B: Merge correctness via a canonical-row sync layer (B1–B7) — 7 tests

> Direct tests of the row-merge behavior exposed through `SyncService` reconcile.

| ID | Class | Assertion | Status today |
|----|-------|-----------|--------------|
| B1 | 🔴 | Reconcile filters **committed** rows before writing/pushing (remote-committed not re-synced) | Partial in legacy path; pin for row path → RED |
| B2 | 🔴 | A local-only row gathered via reconcile appears in the **canonical pushed blob** (activity_id-keyed, no `{hash,data}` wrapper) | `pushRemoteBlobWithCanonicalRows` format → RED for row path |
| B3 | 🔴 | Reconcile round-trips a row's **`updated_at`** through to the pushed blob intact | LWW timestamp fidelity → RED |
| B4 | 🟢 | Reconcile is **idempotent** (two runs → same rows, no duplicates) | likely GREEN; keep as guard |
| B5 | 🔴 | Reconcile merges a **legacy** remote blob (`{hash,data}` from `pushRemoteBlob`) into a canonical local row set without loss | legacy↔canonical bridge → RED |
| B6 | 🟢 | `BLOB_KEY_MISMATCH` → `OFFLINE`, local rows preserved | GREEN (G1); anchor |
| B7 | 🟢 | Remote blob missing `entries` (empty remote) → push local, no crash | GREEN (D8-like); anchor |

### Group C: Tier-1 fast path uses `compareStagingHashIndexes` (C1–C3) — 3 tests

> Current fast path compares **SHA-256 of the encrypted index blob** only. The structured
> `compareStagingHashIndexes` **is imported but never called** (`sync.js:75`). Wire it in as
> the Tier-1 decision (or the structured complement), with blob-SHA as fallback.

| ID | Class | Assertion | Status today |
|----|-------|-----------|--------------|
| C1 | 🔴 | Tier-1 fast path with **identical** local/remote hash indexes skips the blob push and returns `READY` | Fast path skips **only** on identical encrypted-blob SHA; not via comparator → RED |
| C2 | 🔴 | Tier-1 fast path with a **status-only** change (same ids, different status) is detected as a mismatch → forces push | SHA-of-encrypted-blob **may miss status-only** if hash index doesn't encode status → RED |
| C3 | 🟢 | Empty local + empty remote hash indexes → identical + fast-path `READY` | GREEN; anchor |

> **Note:** Correcting the earlier draft — `compareStagingHashIndexes` + `buildStagingHashIndex`
> behavior is **already GREEN** in `staging_hash_index`; the earlier H3–H5 unit assertions are
> NOT new RED work. Only the **wiring into the fast-path decision** (C1–C2) is RED.

### Group R: Regression anchors for the LocalCache/DTO contract — 6 tests

> These pin **Option B's** invariant: storage stays on `LocalCache`, DTO API preserved.

| ID | Assertion | Why it matters |
|----|-----------|----------------|
| R1 | `readEntries()` returns decrypted DTOs with flat field names after reconcile | All consumers depend on DTO shape; anchor |
| R2 | Cookie specifier mismatch + valid MK → reconcile proceeds → `READY` | Cross-client reconcile entry gate preserved |
| R3 | `genesisCompatible === false` → `GENESIS_MISMATCH` returned | Genesis gate untouched by reconcile work |
| R4 | No remote configured → `READY` (local-only) | G1 gate preserved |
| R5 | `clearRemote()` deletes ledger block + staging keys | Combined clear path keeps working |
| R6 | Same-device fast path (`_fastPathPhase`) → `READY` with no full reconcile | Fast-path still short-circuits local-only sessions |

### Group U: Re-home gated `row_integration_test.mjs` M/I groups (U1–U4) — 4 tests

> The M/I groups are **silently skipped** (guard `typeof RowSyncWorker === 'function'` is false,
> `RowSyncWorker` retired). Re-home the meaningful assertions against the **real**
> `SyncService` + `RowStagingStore` + `migrateBlobToRows` so they actually execute.

| ID | Class | Assertion | Status today |
|----|-------|-----------|--------------|
| U1 | 🔴 | `migrateBlobToRows()` converts a legacy `entries` array to `staging:row:{id}` keys + writes migration marker | Not self-executing; unblock and assert → RED |
| U2 | 🔴 | `migrateBlobToRows()` is idempotent (marker prevents duplicate rows on second run) | Not self-executing → RED |
| U3 | 🔴 | Cross-device: rows written to a shared `RowStagingStore` are visible to a second store instance | Not self-executing → RED |
| U4 | 🟢 | `clearRemote()` clears `staging/blob`, cookie, and hash-index keys | GREEN if present; keep as anchor |

## Summary

| Group | Tests | 🔴 new RED | 🟢 anchors |
|-------|-------|-----------|-----------|
| A — Standardize on `mergeRows` | 4 | 4 | 0 |
| B — Canonical-row reconcile layer | 7 | 5 | 2 |
| C — Tier-1 structured fast path | 3 | 2 | 1 |
| R — LocalCache/DTO anchors | 6 | 0 | 6 |
| U — Re-home gated integration | 4 | 3 | 1 |
| **Total** | **24** | **14** | **10** |

**Phase 2 writes the 14 🔴 RED tests.** The 10 🟢 anchors are regression guards (already green).

## Enabling changes (implement/verify in Phase 3, not Phase 1)

- Export `dtoToCanonicalRow` (currently private in `remote_sync.js`) so the reconcile layer can
  convert local DTOs → canonical rows for `mergeRows`, then back via `canonicalRowToDTO`
  (already exported in `entry_dto.js`).
- Add the canonical-row `mergeRows` call in the reconcile path (`sync.js:~799`), replacing
  `mergeEntries(...)`; keep DTO contract at the `readEntries()`/`writeEntries()` boundary.
- Wire `compareStagingHashIndexes` into `_pushStagingHashIndex`/`_fastPathPhase` Tier-1
  decision; retain encrypted-blob SHA-256 as the fast fallback.

## Out of Scope (explicit) — Option A is deferred, not dropped

- Migrating `SyncService` CRUD (`capture/end/pause/modify/remove/markCommitted`) to
  `RowStagingStore` as the authoritative store. **Deferred** to a future CCS task (Option A).
- The 21 `sync_service_test.mjs` **ledger-chain** failures (M/W/T groups) — tracked separately.
- CLI `SqliteStagingStore` (CCS-3), Flutter row merge, Worker entry endpoints.
- Rewriting the retired `RowSyncWorker` HTTP client (model C supersedes it).

## Test Architecture Notes

- **Reconcile wiring (A, B):** `createSyncService()` + `MemoryBackend` + mock transport +
  `MockCrypto` (existing pattern in `sync_service_test.mjs`). Seed remote blob with
  `pushRemoteBlob` (legacy) or `pushRemoteBlobWithCanonicalRows` (canonical). Run
  `checkAndSync()`. Assert on `sync.readEntries()` (DTOs) and, for write-path, the pushed blob
  bytes via `transport.pull(BLOB_PATH)`.
- **Fast path (C):** same-device session (no cookie specifier mismatch), seed identical vs
  modified remote hash index + its SHA-256, assert `_fastPathPhase` push behavior.
- **Re-home (U):** replace retired `RowSyncWorker` calls in `row_integration_test.mjs` with
  `RowStagingStore`/`migrateBlobToRows`/`SyncService` so the M/I groups execute and the guard
  (hardcoded `typeof RowSyncWorker === 'function'`) is removed.
