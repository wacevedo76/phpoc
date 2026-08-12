# Cross-Client Staging Sync & Reconciliation — Living Reference

> **Status:** Living document — the primary source of truth for staging sync across all clients.
> **Last updated:** 2026-09-15 (CCS-3/CCS-4: CLI + Web row-level sync gate GREEN — §12.9 matrix reconciled; canonical compact cross-client formats verified)
> **Scope:** Local/Remote staging sync, reconciliation, cross-device merge, blob obfuscation, device cookie, hash index, row-level sync (ADR-025).

This document is the authoritative reference for how PHPOC staging sync and reconciliation work across CLI (Python), Web (JavaScript), and Flutter (Dart) clients. It defines the protocol contracts, sync flow, resolution rules, and the relationship between current (monolithic blob) and target (row-level) architectures.

> **Flutter note (2026-08, Option A retirement):** The Flutter `SyncService` legacy `LocalCache` monolithic-blob path (`staging/blobs/current.json`, `_pushBlobOnly`) was **fully retired**. `stagingStore` is now required/non-null; all Flutter sync operations use the row-level `StagingStore` and push `staging/blob` (+ `staging/hash_index.json`). See `docs/planning/ZOMBIE_BLOB_CLEANUP_PHASE3.md`.

---

## 1. Architecture Overview

The staging sync system spans 4 layers across 3 platforms:

```
┌─────────────────────────────────────────────────────────────────────┐
│                  SyncOrchestrator (CLI) / SyncService (Web/Flutter)  │
│  Full sync lifecycle: pull → merge → commit → verify → push → ledger│
├─────────────────────────────────────────────────────────────────────┤
│                StagingService (CLI) / SyncService (Web/Flutter)      │
│  Sync gate: cookie fast-path → auth gate → reconcile → claim        │
├─────────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐   │
│  │ LocalCache   │  │ DeviceCookie │  │ MergeEngine              │   │
│  │ (enc I/O)    │  │ (specifier)  │  │ (entry_id LWW dedup)     │   │
│  └──────┬───────┘  └──────────────┘  └──────────────────────────┘   │
│         │                                                            │
│  ┌──────┴──────────────────────────────────────────────────────┐    │
│  │ RemoteStagingSync — blob obfuscation (AES-CTR + HMAC)       │    │
│  │  + StagingHashIndex — compact manifest for O(1) diff        │    │
│  └──────┬──────────────────────────────────────────────────────┘    │
│         │                                                            │
│  ┌──────┴──────────┐                                                │
│  │ Transport       │ — abstraction: pull / push / list / delete      │
│  │ (HTTP / Git)    │                                                │
│  └─────────────────┘                                                │
└─────────────────────────────────────────────────────────────────────┘
```

### Key Architectural Decisions (ADRs)

| ADR | Topic | Status | Location |
|-----|-------|--------|----------|
| ADR-015 | Multi-device encrypted staging blob | ✅ | `docs/design/ARCHITECTURAL_DECISIONS.md` §ADR-015 |
| ADR-015b | Blob obfuscation (AES-CTR + tiered padding) | ✅ | `docs/design/ARCHITECTURAL_DECISIONS.md` §ADR-015b |
| ADR-021 | Stable entry IDs + single-pull freshness optimization | ✅ | `docs/design/ARCHITECTURAL_DECISIONS.md` §ADR-021 |
| ADR-022 | Device Cookie — HMAC fast-path identity check (32 bytes vs 64KB) | ✅ | `docs/design/ARCHITECTURAL_DECISIONS.md` §ADR-022 |
| ADR-023 | Serverless HTTP transport — Cloudflare Worker + R2 | ✅ | `docs/design/ARCHITECTURAL_DECISIONS.md` §ADR-023 |
| ADR-024 | Hash Index fast path — Tier 1/2/3 for login/reauth speedup | ✅ CLI + Web | `docs/design/ARCHITECTURAL_DECISIONS.md` §ADR-024 |
| ADR-025 | Row-Level Staging Sync — LWW resolution model | 🔮 Design complete | `docs/design/ARCHITECTURAL_DECISIONS.md` §ADR-025 |

---

## 2. Sync Gate: `check_and_sync()`

This is the single entry point for remote staging sync, implemented identically across all clients.

### Flow Diagram

```
check_and_sync():
  1. No remote configured? → READY (local-only)
  2. Local cookie valid (TTL not expired)?
     ├─ No pending writes? → READY (skip network entirely, read-only optimization)
     └─ Has pending writes → pull remote cookie (32 bytes)
         ├─ Cookie specifier match → push_blob_only (fast path: pull + merge + push)
         └─ Cookie mismatch or no remote cookie → auth gate
  3. Auth gate:
     ├─ Specifier mismatch? → REAUTH_NEEDED (unconditional — user must consent)
     ├─ No local cookie and cookie file existed? → REAUTH_NEEDED (TTL expired)
     ├─ No valid CryptoManager? → REAUTH_NEEDED
     └─ Valid MK + no specifier mismatch → _reconcile_and_claim()
         ├─ Pull remote blob → decrypt
         ├─ MergeEngine.merge(local, remote) → remote-wins by entry_id
         ├─ Filter out committed entries (marked committed:true by another client)
         ├─ Push merged blob
         └─ Create fresh device cookie (new specifier, local + remote) → READY
```

### Cookie Fast Path (ADR-022)

The Device Cookie avoids pulling the ~64KB staging blob on every command:

- **Local cookie**: `{"device_specifier": "<32-char hex>", "creation_time": <epoch_ms>}` — stored in `device_cookie.meta`
- **Remote cookie**: `{"device_uuid": "<UUID>", "device_specifier": "<32-char hex>"}` — stored at `staging/blobs/device_cookie.bin`
- **TTL**: 30 minutes (configurable via `cookie_ttl_minutes`)
- **Touch**: Every local write extends `creation_time` (local only, no remote push)
- **Destroy**: On TTL expiry or specifier mismatch

Specifier comparison is byte-for-byte — no decryption needed. Specifier mismatch **always forces REAUTH_NEEDED**, regardless of cached crypto keys.

---

## 3. Merge Engine — Cross-Device Reconciliation

The merge engine deduplicates entries when pulling remote staging data.

### Algorithm

```python
def merge(local_entries, remote_entries):
    seen = {}
    # Process local entries first
    for entry in local_entries:
        key = dedup_key(entry)  # (entry_id,) or (title, start_epoch) fallback
        seen[key] = entry  # source = "local"

    # Remote overwrites on tie (more recent)
    for entry in remote_entries:
        key = dedup_key(entry)
        seen[key] = entry  # source = "remote"

    # Sort by start_epoch ascending
    return sorted(seen.values(), key=lambda e: e["start_epoch"])
```

### Dedup Key Priority

1. **Primary**: `entry_id` — stable UUID4, survives across devices
2. **Fallback**: `(title, start_epoch)` — for legacy entries created before `entry_id`

### Resolution Rules

| Rule | Rationale |
|------|-----------|
| Remote wins on tie | Remote is the more recent source (was pushed after local was read) |
| Committed entries filtered out | Entries marked `committed: true` by another client are removed during merge |
| Entry IDs preserved | `entry_id` from remote is kept exactly — same stable reference across devices |
| Source tracking | Each merged entry carries `source: "local"` or `source: "remote"` metadata |

---

## 4. Blob Obfuscation

### Format (ADR-015b, PHPSPEC §8)

```
salt(16) + nonce(8) + plaintext_len(4) + padded_data + tag(32)
```

- **Key derivation**: `blob_key = HMAC-SHA256(master_key, "blob-obfuscation")[:16]`
- **Encryption**: `enc_key = HMAC-SHA256(blob_key, salt)[:16]` — AES-128-CTR
- **Integrity**: `integrity_key = HMAC-SHA256(blob_key, salt + "-integrity")[:16]` — 32-byte HMAC tag
- **Padding**: Tiered to nearest ceiling (64K / 128K / 256K / 512K)
- **Deterministic mode**: `_obfuscate_deterministic()` — for cross-platform test vectors (zero-fill padding)

### Blob Envelope

```json
{
  "device_id": "uuid-string",
  "device_proof": "hmac-hex",
  "entries": [...]
}
```

### Remote Paths (PHPSPEC §8)

| Resource | Remote Path |
|----------|-------------|
| Staging blob | `staging/blob` |
| Hash index | `staging/hash_index.json` |
| Device cookie | `staging/blobs/device_cookie.bin` |

---

## 5. Hash Index — Fast Path (ADR-024)

### Three-Tier Cascade

| Tier | What | Network Cost | When |
|------|------|-------------|------|
| Tier 1 | Pull `hash_index.sha256`, compare to local SHA-256 | 1 GET | Chains identical (re-login) |
| Tier 2 | Pull `hash_index.json`, find fork point via comparison | 1-2 GETs | Remote extends local |
| Fallback | Full chain pull | N GETs | First sync, divergent, or missing index |

### StagingHashIndex Format

```json
[{"activity_id": "xK7mQp2vN9", "activity_status": "active"}, ...]
```

- Sorted by `activity_id` for deterministic SHA-256
- Legacy entries (no `activity_id`) are **omitted** from the index
- Compare two indexes → `StagingHashDiff { identical, added[], removed[], changed[] }`

---

## 6. Source Code Reference

### CLI (Python)

| File | Lines | Purpose |
|------|-------|---------|
| `domain/staging/service.py` | 1162 | `StagingService` — sync gate, CRUD, `check_and_sync()`, cookie handling, push, reconcile |
| `domain/staging/remote_sync.py` | 509 | `RemoteStagingSync` — blob obfuscation, pull/push, device cookie, hash index I/O |
| `domain/staging/local_cache.py` | 1051 | `LocalStagingCache` — encrypt/decrypt at `plain:` boundary, per-field encryption, `entry_id` |
| `domain/staging/merge_engine.py` | 72 | `MergeEngine` — entry_id dedup, remote-wins, backward compat fallback |
| `domain/cookie/device_cookie.py` | 140 | `DeviceCookie` — deterministic specifier, TTL, create/destroy/match |
| `core/sync/orchestrator.py` | 750 | `SyncOrchestrator` — full sync pipeline, ledger sync, hash index tiers, same-genesis merge |
| `core/staging_hash_index.py` | 136 | `StagingHashIndex` + `StagingHashDiff` — build, compute hash, compare |
| `core/activity_id.py` | — | `ActivityIdGenerator` — CSPRNG 10-char alphanumeric activity IDs |
| `core/sync/transport.py` | — | `AbstractStagingTransport` — pull/push/list/delete interface |
| `core/sync/http_transport.py` | — | `HttpStagingTransport` — HTTP GET/PUT/LIST + ETag |

### Web (JavaScript)

| File | Purpose |
|------|---------|
| `phpoc-web/src/sync/sync.js` | Core sync orchestrator — `checkAndSync()`, `pushToRemote()`, gate logic |
| `phpoc-web/src/sync/remote_sync.js` | `RemoteSync` — blob pull/push, cookie pull/push via transport |
| `phpoc-web/src/sync/local_cache.js` | `LocalCache` — encrypt/decrypt staging fields, activity_id, hash index persistence |
| `phpoc-web/src/sync/merge_engine.js` | `MergeEngine` — entry_id dedup, remote-wins |
| `phpoc-web/src/sync/cookie.js` | `DeviceCookie` — specifier, TTL, match |
| `phpoc-web/src/sync/activity_id.js` | `generateActivityId()` — 10-char CSPRNG IDs |
| `phpoc-web/src/sync/staging_hash_index.js` | `buildStagingHashIndex()`, `compareStagingHashIndexes()`, `computeHashForIndex()` |
| `phpoc-web/src/sync/entry_dto.js` | DTO conversion — raw entry ↔ decrypted DTO |
| `phpoc-web/src/sync/genesis_gate.js` | `GenesisGate.check()` — Tier 1/2 hash index, typed errors |
| `phpoc-web/src/sync/keys.js` | Canonical path constants (10 keys) |
| `phpoc-web/src/sync/row_staging_store.js` | `RowStagingStore` — row-per-activity staging (Phase 3 GREEN) |
| `phpoc-web/src/sync/row_sync.js` | `buildDiff()` — 8-scenario LWW resolution + `RowSyncWorker` HTTP client |
| `phpoc-web/src/sync/migration.js` | `migrateBlobToRows()` — blob→rows conversion |

### Flutter (Dart)

| File | Purpose |
|------|---------|
| `phpoc-flutter/lib/data/sync/sync_service.dart` | `SyncService` — unified sync gate, CRUD, checkAndSync (row-level staged) |
| `phpoc-flutter/lib/data/sync/local_cache.dart` | `LocalCache` — field-level encrypt/decrypt |
| `phpoc-flutter/lib/data/sync/merge_engine.dart` | `MergeEngine` — entry_id dedup |
| `phpoc-flutter/lib/data/sync/device_cookie.dart` | `DeviceCookie` — HMAC specifier |
| `phpoc-flutter/lib/data/sync/staging_hash_index.dart` | `StagingHashIndex` — build, compare |
| `phpoc-flutter/lib/data/sync/activity_id.dart` | `ActivityIdGenerator` — 10-char CSPRNG |
| `phpoc-flutter/lib/data/sync/staging_store.dart` | `StagingStore` — **row-level SQLite store** (ADR-025 active) |
| `phpoc-flutter/lib/data/sync/staging_storage.dart` | Storage abstraction layer |
| `phpoc-flutter/lib/data/sync/transport.dart` | `HttpTransport` — HTTP pull/push/list/delete |
| `phpoc-flutter/lib/data/sync/genesis_gate.dart` | `GenesisGate` — genesis compatibility check |
| `phpoc-flutter/lib/data/sync/staging_paths.dart` | Remote path constants |

### Worker (TypeScript)

| File | Purpose |
|------|---------|
| `worker/src/index.ts` | Cloudflare Worker router — CORS, auth, generic blob handlers + row-level staging dispatch |
| `worker/src/row_level_staging.ts` | Row-level staging types, validation, manifest helpers, 4 HTTP handlers (ADR-025) |

---

## 7. Test Coverage

### CLI (Python) — ~17 staging-related test files

| Test File | Coverage |
|-----------|----------|
| `tests/test_phase2_staging_service.py` | StagingService CRUD, auth gate |
| `tests/test_phase4_staging_interaction_flow.py` | Full sync flows, cross-device scenarios |
| `tests/test_phase6a_staging_equivalence.py` | CLI ↔ Web staging format equivalence |
| `tests/test_staging_sync_optimization.py` | Freshness skip, entry_id dedup, auth gate, merge |
| `tests/test_remote_staging_sync.py` | Remote sync, blob obfuscation, cookie |
| `tests/test_staging_at_rest_encryption.py` | AES-CTR at rest encryption |
| `tests/test_i02_staging_keys.py` | Encrypted field-name tokens |
| `tests/test_sqlite_staging.py` | SQLite staging store (row-level) |
| `tests/test_ledger_merge.py` | Ledger chain merge (cross-device divergence, 47 tests) |
| `tests/test_ledger_remote_sync.py` | Remote ledger block sync |
| `tests/test_b05c_cli_staging_alignment.py` | CLI staging alignment with web |
| `tests/test_background_sync.py` | Background sync |
| `tests/test_daemon_sync.py` | Daemon sync |
| `tests/test_cross_platform_integration.py` | Cross-platform live integration (CLI ↔ Worker) |
| `tests/test_sync_confirmation.py` | Sync confirmation strategies |
| `tests/test_transport_registry.py` | Transport provider registry (50 tests) |
| `tests/test_http_transport.py` | HTTP transport (68 tests + ETag) |

### Web (JavaScript) — 42 test files

| Test File | Tests | Status |
|-----------|-------|--------|
| `phpoc-web/test/sync_service_test.mjs` | 287 | 🟢 GREEN |
| `phpoc-web/test/genesis_gate_test.mjs` | 213 | 🟢 GREEN |
| `phpoc-web/test/cross_client_web_test.mjs` | 78 | 🟢 GREEN |
| `phpoc-web/test/local_cache_test.mjs` | 58 | 🟢 GREEN |
| `phpoc-web/test/hash_index_test.mjs` | 58 | 🟢 GREEN |
| `phpoc-web/test/ledger_sync_test.mjs` | 31 | 🟢 GREEN |
| `phpoc-web/test/staging_hash_index_test.mjs` | 43 | 🔴 RED (Phase 2) |
| `phpoc-web/test/staging_backward_compat_test.mjs` | 24 | 🔴 RED (Phase 2) |
| `phpoc-web/test/row_staging_store_test.mjs` | 49 | 🔴 RED (Phase 2) |
| `phpoc-web/test/row_sync_test.mjs` | 134 | 🔴 RED (Phase 2) |
| `phpoc-web/test/row_integration_test.mjs` | 70 | 🔴 RED (Phase 2) |

### Worker (TypeScript)

| Test File | Tests | Status |
|-----------|-------|--------|
| `worker/test/index.test.ts` | 49 | 🟢 GREEN |
| `worker/test/row_level_endpoints.test.ts` | 55 | 🟢 GREEN |

---

## 8. Row-Level Staging Sync — ADR-025 (Target Architecture)

### What Changes

| Current (Blob) | Target (Row-Level) |
|---|---|
| Pull full ~64KB blob every sync | Pull only changed rows (~1KB each) |
| Manifest is separate staging hash index blob | Rows themselves ARE the index |
| Merge entire blob locally | LWW resolution by `updated_at` per-row |
| Blob obfuscation per whole blob | Per-row obfuscation with per-row keys |

### Row Schema (PHPSPEC §8.1)

| Field | Type | Description |
|-------|------|-------------|
| `activity_id` | string (10-char) | Stable CSPRNG ID, survives staging→ledger |
| `activity_status` | string | `"active"`, `"paused"`, `"ended"`, or `"committed"` |
| `activity` | string (JSON) | Obfuscated entry data blob |
| `updated_at` | integer (ms epoch) | Last modification timestamp — LWW signal |
| `committed` | boolean | Cross-device cleanup signal |

### 8-Scenario LWW Resolution Table

| # | Situation | Resolution |
|---|---|---|
| 1 | Same id, status differs, remote `updated_at` newer | Pull full row → overwrite local |
| 2 | Same id, status differs, local `updated_at` newer | Push local row to remote |
| 3 | Same id, same status, `updated_at` differs | LWW on full row (whichever is newer) |
| 4 | In remote manifest, not in local | Pull full row to local |
| 5 | In local, not in remote manifest, IN ledger hash index | Delete from local (committed elsewhere) |
| 6 | In local, not in remote manifest, NOT in ledger hash index | Push to remote (new activity) |
| 7 | Remote empty (all committed) | Clear local staging |
| 8 | Committed on A, deleted from staging; B still has it | Resolved by scenario 5 |

### Worker Push Guard

```
On PUT /storage/staging/rows/{activity_id}:
  existing = storage.get(activity_id)
  if existing and body.updated_at <= existing.updated_at:
    return 409 Conflict
  storage.put(activity_id, body)
  return 200 OK
```

### Implementation Phases (from `docs/planning/ROW_LEVEL_STAGING_SYNC_PLAN.md`)

| Phase | Client | Key Deliverables |
|-------|--------|-----------------|
| A | Web | IndexedDB object store, `buildDiff()`, pull/push phases |
| B | CLI | SQLite staging store, migration from `staging.json` |
| C | Worker | Manifest endpoint, row CRUD endpoints, push guard |

### Implementation Status by Client

| Client | Blob Sync | activity_id | Hash Index | Row-Level Store | Row Sync (LWW) |
|--------|-----------|-------------|------------|-----------------|----------------|
| **CLI** | ✅ | ✅ | ✅ | 🔜 Planned | 🔜 Planned |
| **Web** | ✅ | ✅ | ✅ | 🟢 Phase 3 GREEN | 🔴 RED (Phase 2 tests) |
| **Flutter** | ✅ | ✅ | ✅ | ✅ Active | 🔜 Planned |
| **Worker** | ✅ | — | ✅ (sha256) | 🟢 Endpoints GREEN | 🔜 Entry-level endpoints needed |

---

## 9. Ledger Block Sync (Cross-Device)

While staging sync handles mutable entries, ledger blocks are synced independently (append-only).

### Flow

```
_sync_ledger_blocks():
  1. Hash Index Fast Path (Tier 1): SHA-256 match → skip pull
  2. Hash Index Fast Path (Tier 2): fork detection → pull only new blocks
  3. Full Pull/Push: pull missing, push new, push index, push hash_index
  4. Same-genesis divergence detection → interactive chain merge (LedgerMerge)
```

### Key Files

| File | Purpose |
|------|---------|
| `domain/ledger/remote_sync.py` | `RemoteLedgerSync` — push/pull blocks, hash index, pull_full_chain |
| `domain/ledger/merge.py` | `LedgerMerge` — merge divergent chains sharing genesis (47 tests) |
| `core/sync/orchestrator.py` | `_sync_ledger_blocks()`, `_deduplicate_from_remote_ledger()`, `_try_ledger_merge()` |

---

## 10. Cross-Reference Index

### Specs & Format
- **PHPSPEC §8 (Staging Area)**: `docs/spec/PHPSPEC.md` — row schema, blob format, remote paths, obfuscation
- **PHPSPEC §4.5 (Entry fields)**: `docs/spec/PHPSPEC.md` — entry data dictionary structure

### Architecture & Design
- **ADR-015 through ADR-025**: `docs/design/ARCHITECTURAL_DECISIONS.md` — all staging/sync ADRs
- **Top-Level Directives D1–D10**: `docs/design/TOP_LEVEL_DIRECTIVES.md` — binding constraints
- **CCS Implementation Plan**: `docs/planning/CROSS_CLIENT_REMOTE-LOCAL_STAGING_SYNC-RECONCILIATION_PLAN.md` — phased implementation plan, scorecard, dependency graph
- **Device Cookie & Staging DB Schema**: `docs/reference/DEVICE_COOKIE_AND_STAGING_DATABASE_SCHEMA.md` — cookie format, database schema per-client
- **Cross-Device Staging Workflow**: `docs/design/workflows/Cross_Device_Staging-Workflow.md`
- **CLI Staging Interaction Workflow**: `docs/design/workflows/phpoc_cli/CLI_Staging_Interaction-Workflow.md`
- **Remote/Local Sync Workflow**: `docs/design/workflows/web/Remote_Local-Workflow.md`

### Planning & Implementation
- **Row-Level Staging Sync Plan**: `docs/planning/ROW_LEVEL_STAGING_SYNC_PLAN.md` — ADR-025 implementation blueprint
- **Staging Hash Index Workflow**: `docs/planning/STAGING_HASH_INDEX_WORKFLOW.md` — three-tier cascade contract
- **Staging Activity ID Plan**: `docs/planning/STAGING_ACTIVITY_ID_IMPLEMENTATION_AND_EXECUTION_PLAN.md`
- **Staging Activity ID Tests**: `docs/planning/STAGING_ACTIVITY_ID_TESTS.md` — 116 tests, 10 categories
- **CLI SQLite Staging Plan**: `docs/planning/CLI_SQLITE_STAGING_PHASE1.md`
- **Flutter Sync Core Plan**: `docs/planning/flutter/SYNC_CORE_PHASE1.md`
- **Flutter Row-Level Sync Plan**: `docs/planning/flutter/B04_ROW_LEVEL_SYNC_PHASE1.md`
- **Web Row-Level Tests Plan**: `docs/planning/WEB_ROW_LEVEL_TESTS_PHASE1.md`
- **E2E Cross-Client Fix Plan**: `docs/planning/E2E_CROSS_CLIENT_FIX_PLAN.md`
- **Align Web Staging Sharing**: `docs/planning/ALIGN_WEB_STAGING_SHARING_WITH_CLI.md`

### Backup & Restore
- **Flutter Restore From Cloud**: `docs/planning/flutter/RESTORE_FROM_CLOUD_PHASE1.md`
- **Flutter Staging Sync in Restore**: `docs/planning/flutter/B06_STAGING_SYNC_IN_RESTORE_PHASE1.md`
- **Flutter Staging Overhaul**: `docs/planning/flutter/STAGING_OVERHAUL_PHASE1.md`

---

## 11. Protocol Contracts (All Clients Must Uphold)

1. **Cookie is the truth**: Auth decisions use device cookie (specifier match), not cached crypto keys. Specifier mismatch ALWAYS forces REAUTH_NEEDED.
2. **Remote wins on merge tie**: `MergeEngine.merge()` gives remote entries precedence for the same `entry_id`.
3. **Committed entries filtered**: Entries marked `committed: true` are removed during merge — they've been sealed into ledger blocks by another client.
4. **Blob obfuscation is identical**: All clients produce byte-identical obfuscated blobs for the same plaintext + master key. Tested via deterministic obfuscation mode.
5. **Hash index format is identical**: All clients produce the same sorted `[{activity_id, activity_status}]` array.
6. **Entry IDs are preserved**: `entry_id` (UUID4) is generated once, never regenerated, and survives the full staging→ledger lifecycle.
7. **Device UUID suffix**: `{UUID4}-{client_type}` — disambiguates same-machine clients.
8. **Row-level `updated_at` is LWW**: No content hash comparison — `updated_at` alone determines winner.
9. **Worker is blind**: Worker never decrypts blob or hash index. SHA-256 is computed over raw encrypted bytes.
10. **Per-row obfuscation keys**: `per_row_key = HMAC(master_key, "phpoc:staging-row-key:" + activity_id)`
11. **Pull ledger on ownership-handoff reauth (ADR-030)**: when a device triggers REAUTH via a **cookie specifier mismatch** or a **fresh no-cookie reconcile-and-claim**, it MUST pull the remote ledger (freshness = `ledger/hash_index.json` block-count vs local; pull only if remote count > local) **before** reinstating staging ownership, then reconcile staging with the ledger hash index (Scenario 5/6). It must NOT pull the ledger on a valid-cookie fast path nor on TTL-expiry with an unchanged specifier (same device). Commit is user-initiated and moves committed rows out of staging; the committing device auto-pushes the new ledger block(s).

---

## 12. Abstract Protocol Workflow

This section defines the staging sync protocol as an **implementation-agnostic state
machine**. Every client (CLI, Web, Flutter) must produce identical outcomes given the
same inputs. This is the formal specification to code against.

### 12.1 Terminal States (Sync Gate Output)

| State | Value | Meaning |
|-------|-------|--------|
| `READY` | `"READY"` | Sync complete — local staging is authoritative. Caller may proceed with read/write operations. |
| `OFFLINE` | `"OFFLINE"` | Remote unreachable. Local operations continue; sync retried on next gate check. |
| `REAUTH_NEEDED` | `"REAUTH_NEEDED"` | User must explicitly authenticate (enter passphrase). No sync occurs. |
| `GENESIS_MISMATCH` | `"GENESIS_MISMATCH"` | Remote ledger genesis differs from local. Sync impossible — different cryptographic domain. |

### 12.2 Data Types

**StagingEntry** (row schema):
```
{
  activity_id:     string       // 10-char CSPRNG, stable across staging→ledger lifecycle
  activity_status:  "active" | "paused" | "ended" | "committed"
  activity:         string       // obfuscated entry payload (title, tags, times, etc.)
  updated_at:       integer      // Unix epoch milliseconds — LWW version signal
  committed:        boolean      // cross-device cleanup flag
}
```

**StagingBlob** (envelope):
```
{
  device_id:    string           // UUID with client-type suffix (e.g., "abc123-cli")
  device_proof: string           // HMAC proof of device identity
  entries:      StagingEntry[]   // all non-committed staging rows
}
```

**HashIndex**:
```
[{ activity_id: string, activity_status: string }]
// Sorted by activity_id ascending. SHA-256 of JSON.stringify(compact).
// Legacy entries (no activity_id) are OMITTED.
```

**DeviceCookie** (local):
```
{ device_specifier: string, creation_time: integer }
```

**DeviceCookie** (remote):
```
{ device_uuid: string, device_specifier: string }
```

### 12.3 Complete State Machine

```
                    ┌─────────────────────────────────────┐
                    │        check_and_sync()              │
                    └──────────────────┬──────────────────┘
                                       │
                    ┌──────────────────▼──────────────────┐
                    │ G1: Remote configured?               │
                    │     No  → READY (local-only)         │
                    │     Yes → continue                   │
                    └──────────────────┬──────────────────┘
                                       │
                    ┌──────────────────▼──────────────────┐
                    │ G2: Genesis Gate                     │
                    │     No local ledger? → skip          │
                    │     Already cached? → use cached     │
                    │     Pull remote ledger, verify       │
                    │     genesis block.                   │
                    │     ├─ Mismatch → GENESIS_MISMATCH   │
                    │     ├─ Compatible → cache, continue  │
                    │     └─ Unreachable → continue        │
                    │         (fall through to OFFLINE)    │
                    └──────────────────┬──────────────────┘
                                       │
                    ┌──────────────────▼──────────────────┐
                    │ G3: Local Cookie Check               │
                    │     isValidLocally(ttl_minutes)?     │
                    │     ├─ Valid → FAST PATH             │
                    │     └─ Invalid/expired/absent        │
                    │         → AUTH GATE                  │
                    └──────┬───────────┬───────────────────┘
                           │           │
              ┌────────────▼──┐  ┌─────▼──────────────────┐
              │   FAST PATH    │  │      AUTH GATE          │
              │ (local cookie  │  │ (no/invalid local       │
              │  valid)        │  │  cookie)                │
              └───────┬───────┘  └─────┬──────────────────┘
                      │                │
         ┌────────────▼──────────┐    │
         │ F1: Has pending       │    │
         │ writes?               │    │
         │  No → READY           │    │
         │  (read-only fast      │    │
         │   path, no network)   │    │
         │  Yes → continue       │    │
         └────────────┬──────────┘    │
                      │                │
         ┌────────────▼──────────┐    │
         │ F2: Pull remote       │    │
         │ cookie (32 bytes)     │    │
         │  ├─ Unreachable       │    │
         │  │  → OFFLINE         │    │
         │  ├─ No remote cookie  │    │
         │  │  → AUTH GATE       │    │
         │  └─ Parsed → check    │    │
         └────────────┬──────────┘    │
                      │                │
         ┌────────────▼──────────┐    │
         │ F3: Specifier match?  │    │
         │  ├─ Match             │    │
         │  │  → F4 (hash index) │    │
         │  └─ Mismatch          │    │
         │     → AUTH GATE       │    │
         └───────────┬───────────┘    │
                     │                │
         ┌───────────▼──────────┐     │
         │ F4: Hash Index       │     │
         │ Tier-1 compare       │     │
         │  ├─ Identical?       │     │
         │  │  → push local     │     │
         │  │  → READY          │     │
         │  └─ Different?       │     │
         │     → RECONCILE      │     │
         └──────────────────────┘     │
                                      │
                    ┌─────────────────▼─────────────┐
                    │ A1: Specifier mismatch flag?   │
                    │     Yes → REAUTH_NEEDED        │
                    │     (unconditional — user      │
                    │      must consent)             │
                    │     No → continue              │
                    └─────────────────┬─────────────┘
                                      │
                    ┌─────────────────▼─────────────┐
                    │ A2: Cookie file existed?       │
                    │     (TTL expired)              │
                    │     Yes → REAUTH_NEEDED        │
                    │     (unconditional)            │
                    │     No → continue              │
                    └─────────────────┬─────────────┘
                                      │
                    ┌─────────────────▼─────────────┐
                    │ A3: CryptoManager valid?       │
                    │     (master_key is 32 bytes)   │
                    │     No → REAUTH_NEEDED         │
                    │     Yes → continue             │
                    └─────────────────┬─────────────┘
                                      │
         ┌────────────────────────────┴──────────────────────┐
         │            RECONCILE AND CLAIM                     │
         │  ┌─────────────────────────────────────────────┐  │
         │  │ R1: Pull remote blob (staging/blob)          │  │
         │  │     ├─ Unreachable → OFFLINE                 │  │
         │  │     ├─ Key mismatch → OFFLINE                │  │
         │  │     │  (MUST NOT overwrite remote)            │  │
         │  │     └─ Valid → deobfuscate, continue         │  │
         │  └─────────────────┬───────────────────────────┘  │
         │                    │                               │
         │  ┌─────────────────▼───────────────────────────┐  │
         │  │ R2: Read all local rows from row store       │  │
         │  └─────────────────┬───────────────────────────┘  │
         │                    │                               │
         │  ┌─────────────────▼───────────────────────────┐  │
         │  │ R3: MERGE                                    │  │
         │  │   mergeEntries(local_rows, remote_rows)      │  │
         │  │   → dedup by activity_id                     │  │
         │  │   → remote-wins on same activity_id          │  │
         │  │   → local-wins on same updated_at (tie)      │  │
         │  └─────────────────┬───────────────────────────┘  │
         │                    │                               │
         │  ┌─────────────────▼───────────────────────────┐  │
         │  │ R4: FILTER                                   │  │
         │  │   Remove rows with committed == true         │  │
         │  └─────────────────┬───────────────────────────┘  │
         │                    │                               │
         │  ┌─────────────────▼───────────────────────────┐  │
         │  │ R5: WRITE merged rows to local store         │  │
         │  │   (preserve updated_at from merge source)    │  │
         │  │   Delete local-only rows not in merged set   │  │
         │  └─────────────────┬───────────────────────────┘  │
         │                    │                               │
         │  ┌─────────────────▼───────────────────────────┐  │
         │  │ R6: PUSH                                     │  │
         │  │   Build blob → obfuscate → PUT staging/blob  │  │
         │  └─────────────────┬───────────────────────────┘  │
         │                    │                               │
         │  ┌─────────────────▼───────────────────────────┐  │
         │  │ R7: PUSH hash index                          │  │
         │  │   Build index → PUT staging/hash_index.json  │  │
         │  └─────────────────┬───────────────────────────┘  │
         │                    │                               │
         │  ┌─────────────────▼───────────────────────────┐  │
         │  │ R8: Create fresh device cookie               │  │
         │  │   (local specifier + remote push)            │  │
         │  │   Non-critical — failure does not block      │  │
         │  └─────────────────┬───────────────────────────┘  │
         │                    │                               │
         │                    ▼                               │
         │                  READY                             │
         └────────────────────────────────────────────────────┘
```

### 12.4 Decision Table

Each gate is an atomic decision. The outcome must be identical across all clients.

| Gate | Input | Question | Output | Notes |
|------|-------|----------|--------|-------|
| **G1** | Transport exists | Remote configured? | `skip→READY` / `continue` | Local-only mode skips all network |
| **G2** | Local ledger blocks | Genesis compatible with remote? | `GENESIS_MISMATCH` / `continue` | Cached after first check; skip if no local ledger |
| **G3** | Local cookie, TTL | Cookie valid and not expired? | `FAST_PATH` / `AUTH_GATE` | TTL defaults to 30 minutes |
| **F1** | Local staging rows | Any pending writes? | `READY` / `continue` | Read-only optimization — skip network entirely |
| **F2** | Remote cookie bytes | Remote reachable? Cookie parsable? | `OFFLINE` / `continue` / `→AUTH_GATE` | 32 bytes, no decryption needed |
| **F3** | Local + remote specifiers | Specifiers match? | `F4` / `→AUTH_GATE(mismatch)` | Byte-for-byte comparison |
| **F4** | Local + remote hash index SHA-256 | Indexes identical? | `READY(after push)` / `RECONCILE` | Tier-1 fast path; fail-open on network error |
| **A1** | Specifier mismatch flag | Did F3 detect mismatch? | `REAUTH_NEEDED` / `continue` | Unconditional — user must consent |
| **A2** | Cookie file existence + validity | TTL expired? (file exists but invalid) | `REAUTH_NEEDED` / `continue` | Distinguish "expired" from "never existed" |
| **A3** | CryptoManager.master_key | Valid MK cached? (32 bytes) | `REAUTH_NEEDED` / `continue` | 32-byte key required |
| **A4** | Remote cookie pull | Remote reachable? | `OFFLINE` / `continue` | May reuse F2 result if cached |
| **R1** | Remote blob pull + deobfuscation | Remote reachable? Key correct? | `OFFLINE` / `continue` | MUST NOT overwrite remote on key mismatch |
| **R2** | Local row store | Read all local rows | `StagingEntry[]` | All non-committed rows |
| **R3** | Local + remote rows | Merge | `StagingEntry[]` | See §12.5 Merge Algorithm |
| **R4** | Merged rows | Filter committed | `StagingEntry[]` | Remove rows with committed == true |
| **R5** | Merged+filtered rows | Write to local store | `void` | Preserve updated_at from merge source |
| **R6** | Local rows | Build blob, obfuscate, push | `void` | Uses `staging/blob` path |
| **R7** | Local rows | Build hash index, push | `void` | Uses `staging/hash_index.json` path |
| **R8** | Device ID | Create cookie (local + remote) | `void` | Fresh specifier; non-critical failure |

### 12.5 Merge Algorithm (Abstract)

```
function merge(local: StagingEntry[], remote: StagingEntry[]): StagingEntry[]
  seen = empty map  // key → (entry, source)

  // Pass 1: Local entries (lower priority on conflict)
  for each entry in local:
    key = entry.activity_id
    key = key || (entry.title, entry.start_epoch)  // fallback for legacy (no activity_id)
    seen[key] = (entry, source = "local")

  // Pass 2: Remote entries (higher priority — remote-wins on same activity_id)
  for each entry in remote:
    key = entry.activity_id
    key = key || (entry.title, entry.start_epoch)
    seen[key] = (entry, source = "remote")

  // Return sorted by start_epoch ascending
  return sort(seen.values(), by: start_epoch)
```

**Resolution rules:**

| Conflict | Rule | Rationale |
|----------|------|-----------|
| Same `activity_id` | Remote overwrites local | Remote was pushed more recently |
| Same `updated_at` (tie) | Local wins | Deterministic; single-user makes this theoretical |
| Entry only in local, NOT in ledger index | Keep (push to remote) | New activity — never pushed (scenario 6) |
| Entry only in local, IS in ledger index | Delete from local | Committed on another device (scenario 5) |
| Entry only in remote | Add to local | New from other device (scenario 4) |
| Committed flag set | Remove from merged set | Committed elsewhere — cleanup signal (scenario 8) |

### 12.6 Blob Lifecycle

```
BUILD_BLOB(entries, device_id, device_proof):
  1. Build envelope:
     {
       device_id: device_id,
       device_proof: device_proof,
       entries: entries  // all non-committed StagingEntry rows
     }
  2. Serialize: JSON.stringify(envelope) — compact, no whitespace
  3. Obfuscate: AES-CTR(serialized, per_blob_key) | nonce | HMAC
     where per_blob_key = HMAC(master_key, "blob-obfuscation")[:16]
  4. Push to: staging/blob
  5. Push hash index to: staging/hash_index.json

DEOBFUSCATE_BLOB(raw_bytes, master_key):
  1. Extract: nonce(8) | ciphertext | hmac_tag(32)
  2. Verify HMAC
  3. Decrypt: AES-CTR(ciphertext, per_blob_key, nonce)
  4. Parse JSON → { device_id, device_proof, entries[] }
  5. Return entries array
```

### 12.7 Hash Index Fast Path (Tier 1)

```
HASH_INDEX_FAST_PATH():
  1. Pull remote SHA-256: GET staging/hash_index.json
     (Worker computes SHA-256 of ENCRYPTED blob for blind comparison)
  2. Build local hash index: [{activity_id, activity_status}] sorted by activity_id
  3. Compute local SHA-256 over ENCRYPTED local hash index
  4. Compare:
     ├─ Identical → push local blob, READY (no merge needed)
     └─ Different → fall through to full reconcile (R1–R8)
  5. On network error → fall through to full reconcile (fail-open)
```

### 12.8 Invariants (Must Hold Across All Clients)

| # | Invariant | Verification |
|---|-----------|-------------|
| I1 | Cookie is the sole auth decision mechanism | Specifier mismatch → REAUTH_NEEDED always |
| I2 | Same plaintext + same MK → identical obfuscated blob | Cross-client test vectors (deterministic mode) |
| I3 | Same staging rows → identical hash index (same sort, same SHA-256) | Cross-client test vectors |
| I4 | Merge is deterministic given same inputs | Unit tests with known input pairs |
| I5 | Blob key mismatch → never overwrite remote | R1 returns OFFLINE on BLOB_KEY_MISMATCH |
| I6 | Committed entries filtered before push | R4 executes after R3, before R6 |
| I7 | No network on read-only (no pending writes) | F1 returns READY with zero network calls |
| I8 | activity_id preserved across staging→ledger lifecycle | Same ID in staging row and committed block entry |
| I9 | Worker never decrypts blob or hash index | SHA-256 computed over encrypted bytes |
| I10 | Remote paths are constants, not inline strings | All clients use same path values |

### 12.9 Phase Coverage Matrix (Implementation Scorecard)

Before cross-client testing (CCS-4), every client must have ✅ in every row.

| Gate | CLI | Web | Flutter | Description |
|------|-----|-----|---------|-------------|
| G1 | ✅ | ✅ | ✅ | Remote configured check |
| G2 | ✅ | ✅ | ✅ | Genesis gate |
| G3 | ✅ | ✅ | ✅ | Cookie TTL check |
| F1 | ✅ | ✅ | ✅ | Read-only fast path (no writes → skip network) |
| F2 | ✅ | ✅ | ✅ | Pull remote cookie (32 bytes) |
| F3 | ✅ | ✅ | ✅ | Specifier match (byte-for-byte) |
| F4 | ✅ | ✅ | ✅ | Hash index Tier-1 fast path |
| A1 | ✅ | ✅ | ✅ | Specifier mismatch → REAUTH_NEEDED |
| A2 | ✅ | ✅ | ✅ | TTL expiry → REAUTH_NEEDED |
| A3 | ✅ | ✅ | ✅ | CryptoManager.master_key check |
| R1 | ✅ | ✅ | ✅ | Pull remote blob (staging/blob) |
| R2 | ✅ | ✅ | ✅ | Read all local rows |
| R3 | ✅ | ✅ | ✅ | Merge (activity_id LWW) |
| R4 | ✅ | ✅ | ✅ | Filter committed entries |
| R5 | ✅ | ✅ | ✅ | Write merged rows to store |
| R6 | ✅ | ✅ | ✅ | Push to staging/blob |
| R7 | ✅ | ✅ | ✅ | Push hash index to staging/hash_index.json |
| R8 | ✅ | ✅ | ✅ | Create fresh device cookie |

**CCS-3 (CLI)** switched R3 to `MergeEngine.merge_rows()` (activity_id LWW,
local-wins-on-tie, committed-exclusion) and wired row-mode `LocalStagingCache`
for R4/R5. **CCS-4 (cross-client E2E)** verified all gates byte-consistent
across CLI/Web/Flutter: compact canonical `activity` JSON, JS `canonicalRowToDTO`
block_index preservation, deterministic JS `mergeRows` sort, and canonical
compact hash index (Flutter `json.encode` already compact — no divergence).
