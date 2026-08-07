# Cross-Client Local/Remote Staging Sync & Reconciliation — Plan

> **Status:** 🔴🟠 Active — CCS-1 pending, CCS-2 blocked, CCS-3 blocked, CCS-4 blocked
> **Last updated:** 2026-08-07
> **Primary reference:** `docs/reference/CROSS_CLIENT_STAGE_SYNCING_REFERENCE.md` §12 (Abstract Protocol Workflow)
> **Consolidates:** B-04, B-05, ADR-025, P3 → single CCS goal in `BACKLOG.md`

## Purpose

This document is the **implementation plan** for cross-client staging sync and reconciliation. It defines the ordered phases, per-client deliverables, dependencies, and the abstract workflow framework that all implementations code against.

---

## 1. Reference Architecture

The abstract protocol workflow is defined in `docs/reference/CROSS_CLIENT_STAGE_SYNCING_REFERENCE.md` §12. Every implementation must follow this state machine:

```
check_and_sync()
  ├─ G1: Remote configured?
  ├─ G2: Genesis gate
  ├─ G3: Cookie TTL check
  │     ├─ Valid → FAST PATH (F1–F4)
  │     └─ Invalid/expired → AUTH GATE (A1–A4)
  │
  ├─ FAST PATH
  │     ├─ F1: Pending writes? No → READY
  │     ├─ F2: Pull remote cookie
  │     ├─ F3: Specifier match?
  │     │     ├─ Match → F4: Hash index Tier-1
  │     │     │         ├─ Identical → push local → READY
  │     │     │         └─ Different → RECONCILE
  │     │     └─ Mismatch → AUTH GATE
  │
  └─ AUTH GATE
        ├─ A1: Specifier mismatch → REAUTH_NEEDED
        ├─ A2: TTL expired → REAUTH_NEEDED
        ├─ A3: No master key → REAUTH_NEEDED
        └─ A4: Valid → RECONCILE (R1–R8)
              ├─ R1: Pull remote blob (staging/blob)
              ├─ R2: Read local rows
              ├─ R3: Merge (activity_id LWW)
              ├─ R4: Filter committed
              ├─ R5: Write to local store
              ├─ R6: Push blob to staging/blob
              ├─ R7: Push hash index
              └─ R8: Create device cookie → READY
```

The full decision table (18 gates) and merge algorithm are specified in §12.4–12.5 of the reference doc.

---

## 2. Terminal States

| State | Meaning |
|-------|---------|
| `READY` | Sync complete — local staging is authoritative |
| `OFFLINE` | Remote unreachable — retry on next gate check |
| `REAUTH_NEEDED` | User must authenticate — no sync occurs |
| `GENESIS_MISMATCH` | Remote ledger genesis differs — different crypto domain |

---

## 3. Canonical Format (Resolved)

All decisions from B-05 are final:

| Decision | Resolution |
|----------|-----------|
| Transport model | Single blob + hash index (Model C) |
| Blob path | `staging/blob` |
| Hash index path | `staging/hash_index.json` |
| Cookie path | `staging/blobs/device_cookie.bin` |
| Entry identity | `activity_id` as single primary key |
| Merge tie-break | Local-wins on equal `updated_at` |
| Envelope `updated_at` | Omitted |
| JSON serialization | Compact (no whitespace) |
| Obfuscation | Flutter/Web scheme |
| Backward compat | Immediate cutover |

---

## 4. Implementation Scorecard

Before cross-client testing (CCS-4), every client must have ✅ in every cell.

| Gate | CLI | Web | Flutter | Description |
|------|-----|-----|---------|-------------|
| G1 | ✅ | ✅ | ✅ | Remote configured check |
| G2 | ✅ | ✅ | ✅ | Genesis gate |
| G3 | ✅ | ✅ | ✅ | Cookie TTL check |
| F1 | ✅ | ✅ | ✅ | Read-only fast path |
| F2 | ✅ | ✅ | ✅ | Pull remote cookie |
| F3 | ✅ | ✅ | ✅ | Specifier match |
| F4 | ✅ | ❌ | ✅ | Hash index Tier-1 |
| A1 | ✅ | ✅ | ✅ | Specifier mismatch → REAUTH_NEEDED |
| A2 | ✅ | ✅ | ✅ | TTL expiry → REAUTH_NEEDED |
| A3 | ✅ | ✅ | ✅ | CryptoManager check |
| R1 | ✅ | ✅ | ✅ | Pull remote blob (staging/blob) |
| R2 | ✅ | ✅ | ✅ | Read all local rows |
| R3 | ⚠️* | ❌ | ✅ | Merge (activity_id LWW) |
| R4 | ✅ | ✅ | ✅ | Filter committed |
| R5 | ❌ | ❌ | ✅ | Write merged rows to store |
| R6 | ✅ | ❌ | ✅ | Push to staging/blob |
| R7 | ✅ | ❌ | ✅ | Push hash index |
| R8 | ✅ | ✅ | ✅ | Create device cookie |

> ⚠️* CLI R3 uses `entry_id`-based merge, not `activity_id`-based LWW. Must switch.

---

## 5. Phased Implementation Plan

### CCS-1: Flutter — Verify & Close Remaining Gaps 🔜

**Status:** Largely complete. B-03 + B-04 delivered full row-level sync gate.

**Remaining gaps:**

| # | Gap | Severity |
|---|-----|----------|
| 1 | `_pushBlobOnly()` (line 738) still pushes to `StagingPaths.remoteStagingBlob` (`staging/blobs/current.json`) — old path zombie, only hit in legacy LocalCache fallback | 🟡 Low |
| 2 | `StagingPaths.remoteStagingBlob` legacy constant still exists | 🟢 Nice-to-have |
| 3 | Cross-client obfuscation compatibility: verify byte-identical ciphertext with Web/CLI for same plaintext + MK | 🟠 High |

**Effort:** ~1 hour. **Blocks:** Nothing directly, but #3 is prerequisite for CCS-4.

**Deliverables:**
- [ ] Remove or redirect `_pushBlobOnly()` old-path fallback
- [ ] Verify obfuscation compatibility with Web (deterministic mode test vectors)
- [ ] Verify hash index format compatibility with Web

---

### CCS-2: Web — Wire Row-Level Sync Gate 🔴

**Status:** RowStagingStore, staging_hash_index.js, merge_engine.js all exist and pass unit tests. But `sync.js` uses old `staging/blobs/current.json` path and old merge logic. **320 RED tests waiting (Phase 2).**

**Plan:** `docs/planning/WEB_ROW_LEVEL_TESTS_PHASE1.md` (120 assertions)

**Required changes (order matters — each step unblocks the next):**

| Step | File | Change | Gate |
|------|------|--------|------|
| 1 | `keys.js` | Add `staging/blob` and `staging/hash_index.json` constants | — |
| 2 | `sync.js` | Switch `_reconcileDifferentDevice()` blob path → `staging/blob` | R1, R6 |
| 3 | `sync.js` | Wire `RowStagingStore.getAllRows()` into read path | R2 |
| 4 | `merge_engine.js` | Switch to `activity_id`-based LWW (currently `entry_id`-based) | R3 |
| 5 | `sync.js` | Wire `MergeEngine.mergeEntries()` into reconcile | R3 |
| 6 | `sync.js` | Wire `RowStagingStore.putRow()` / `deleteRow()` into write path | R5 |
| 7 | `sync.js` | Wire `StagingHashIndex.compare()` into `_fastPathPhase()` | F4 |
| 8 | `sync.js` | Push hash index after blob push | R7 |
| 9 | `remote_sync.js` | Drop envelope `updated_at` from serialization | R6 |
| 10 | Test files | Bump 320 RED → GREEN | All |

**Test files to convert:**
- `staging_hash_index_test.mjs` (43 tests)
- `staging_backward_compat_test.mjs` (24 tests)
- `row_staging_store_test.mjs` (49 tests)
- `row_sync_test.mjs` (134 tests)
- `row_integration_test.mjs` (70 tests)

**Effort:** ~1–2 days. **Blocks:** CCS-4 (Web cross-client testing). **Depends on:** CCS-1 #3 (obfuscation vectors).

---

### CCS-3: CLI — Build Row-Level Store + Wire Sync Gate 🔜

**Status:** Transport uses `staging/blob` and hash index (B-05c). Local storage is still `staging.json` via `LocalCache`.

**Plan:** `docs/planning/CLI_SQLITE_STAGING_PHASE1.md`

**Required changes:**

| Step | File | Change | Gate |
|------|------|--------|------|
| 1 | New file | `SqliteStagingStore` — schema: `(activity_id TEXT PK, activity_status TEXT, activity TEXT, updated_at INTEGER)` | — |
| 2 | New file | CRUD: `getAllRows()`, `putRow()`, `deleteRow()`, `getRow()` | R2, R5 |
| 3 | New file | `migrate_from_staging_json()` — one-shot, generate activity_ids if missing | — |
| 4 | `core/staging_hash_index.py` | Wire `StagingHashIndex.build(store)` — read from SQLite | F4, R7 |
| 5 | `domain/staging/merge_engine.py` | Switch to `activity_id`-based LWW (currently `entry_id`-based) | R3 |
| 6 | `domain/staging/service.py` | Wire `SqliteStagingStore` into `check_and_sync()` / `_reconcile_and_claim()` / `_push_on_fast_path()` | R2, R5, R6, R7 |
| 7 | Tests | SqliteStagingStore CRUD (~30), migration (~10), sync gate (~30), integration (~20) | All |

**Test catalog:** ~66 tests from `ROW_LEVEL_STAGING_SYNC_PLAN.md` categories E–J.

**Effort:** ~1–2 days. **Blocks:** CCS-4 (CLI cross-client testing). **Depends on:** CCS-1 #3 (obfuscation vectors).

---

### CCS-4: Cross-Client E2E Testing 🔜

**Depends on:** CCS-2 ✅ (Web), CCS-3 ✅ (CLI)

| Pair | Verifies | Environment |
|------|----------|-------------|
| Flutter ↔ Web | Same MK → create on Flutter, sync, pull on Web → entries match | Emulator + Vivaldi |
| Flutter ↔ CLI | Same MK → create on Flutter, sync, pull via CLI → entries match | Emulator + Python CLI |
| Web ↔ CLI | Same MK → create on Web, sync, pull via CLI → entries match | Vivaldi + Python CLI |

**Key assertions (per pair):**
1. Hash index byte-identical (same SHA-256)
2. Obfuscated blob byte-identical (same plaintext + MK → same ciphertext)
3. Merge produces identical result regardless of which client merges
4. Cookie specifier matches (same MK + device_id → same specifier)
5. Committed entries cleaned up on both sides after one client commits

**Effort:** ~1–2 days.

---

## 6. Dependency Graph

```
CCS-1 (Flutter verify) ─────────────────────────────────────────────┐
  │                                                                   │
  ├─ #3 Obfuscation vectors ────► CCS-2 (Web) ────┐                  │
  │                                                 ├──► CCS-4 (E2E)  │
  └─ #3 Obfuscation vectors ────► CCS-3 (CLI) ────┘                  │
                                                                      │
                          CCS-4 depends on CCS-2 + CCS-3              │
```

CCS-2 and CCS-3 can proceed in parallel once CCS-1 #3 (obfuscation test vectors) is done. CCS-4 is the final gate — it requires both Web and CLI to be fully wired.

---

## 7. Per-Client Source Files

### Flutter (`phpoc-flutter/lib/data/sync/`)
| File | Role |
|------|------|
| `sync_service.dart` | `checkAndSync()`, `_fastPathRowLevel()`, `_reconcileAndClaimRowLevel()`, `_pullRemoteBlob()`, `_pushStagingRowsToRemote()` |
| `staging_store.dart` | Row-level SQLite store |
| `merge_engine.dart` | `mergeEntries()` — activity_id LWW |
| `device_cookie.dart` | Specifier, TTL, create/destroy/match |
| `staging_hash_index.dart` | Build, compare, computeHash |
| `activity_id.dart` | 10-char CSPRNG |
| `staging_paths.dart` | Path constants |
| `transport.dart` | HTTP pull/push |
| `genesis_gate.dart` | Genesis compatibility |

### Web (`phpoc-web/src/sync/`)
| File | Role |
|------|------|
| `sync.js` | `checkAndSync()`, `_fastPathPhase()`, `_authGatePhase()`, `_reconcileAndClaim()`, `_reconcileDifferentDevice()` |
| `remote_sync.js` | Blob pull/push, cookie pull/push |
| `local_cache.js` | Field-level encrypt/decrypt |
| `merge_engine.js` | Entry dedup |
| `cookie.js` | DeviceCookie |
| `activity_id.js` | 10-char CSPRNG |
| `staging_hash_index.js` | Build, compare, computeHash |
| `row_staging_store.js` | IndexedDB row store |
| `row_sync.js` | buildDiff, RowSyncWorker (to be retired) |
| `migration.js` | blob→rows migration |
| `genesis_gate.js` | Genesis compatibility |
| `keys.js` | Path constants |

### CLI (`domain/staging/`, `core/`)
| File | Role |
|------|------|
| `domain/staging/service.py` | `StagingService.check_and_sync()`, `_reconcile_and_claim()`, `_push_on_fast_path()` |
| `domain/staging/remote_sync.py` | Blob obfuscation, pull/push, cookie, hash index I/O |
| `domain/staging/local_cache.py` | Local encrypt/decrypt (to be replaced by SqliteStagingStore) |
| `domain/staging/merge_engine.py` | `MergeEngine.merge()` — entry_id-based (to be updated) |
| `core/staging_hash_index.py` | Build, compute hash, compare |
| `core/activity_id.py` | 10-char CSPRNG |
| `core/sync/transport.py` | Abstract transport |
| `core/sync/http_transport.py` | HTTP transport |

---

## 8. References

- **Abstract Protocol Workflow:** `docs/reference/CROSS_CLIENT_STAGE_SYNCING_REFERENCE.md` §12 — state machine, decision table, merge algorithm, invariants
- **Architecture Decisions:** `docs/design/ARCHITECTURAL_DECISIONS.md` §ADR-015 through ADR-025
- **Format Spec:** `docs/spec/PHPSPEC.md` §8 — staging area spec
- **Backlog:** `BACKLOG.md` §CCS — consolidated task tracking
- **Flutter B-04 Plan:** `docs/planning/flutter/B04_ROW_LEVEL_SYNC_PHASE1.md` — 56 assertions
- **Web Row-Level Tests:** `docs/planning/WEB_ROW_LEVEL_TESTS_PHASE1.md` — 120 assertions
- **CLI SQLite Plan:** `docs/planning/CLI_SQLITE_STAGING_PHASE1.md`
- **Row-Level Sync Plan:** `docs/planning/ROW_LEVEL_STAGING_SYNC_PLAN.md`
- **Cross-Platform Alignment:** `docs/planning/CROSS_PLATFORM_STAGING_FORMAT_ALIGNMENT.md`
- **E2E Cross-Client Fix:** `docs/planning/E2E_CROSS_CLIENT_FIX_PLAN.md`
