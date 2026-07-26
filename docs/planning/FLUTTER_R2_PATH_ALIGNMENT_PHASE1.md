# Flutter R2 Path Alignment — Test Exploration (Phase 1)

> **Plan:** Align Flutter R2 staging paths with CLI + Web canonical paths
> **Purpose:** Blueprint of all needed test assertions before writing any test code.
> **Status:** ✅ Phase 3 Complete (GREEN)
> **Next Phase:** Phase 4 (REFACTOR: code review)

## Architecture Overview

Three clients (CLI, Web, Flutter) share a remote Cloudflare Worker/R2 for staging
and ledger storage. CLI and Web use canonical paths defined in `phpoc-web/src/sync/keys.js`
and `domain/staging/remote_sync.py`. Flutter uses different (incorrect) paths, breaking
cross-client sync.

### Current State — Path Mismatch Matrix

| Resource | CLI (Python) | Web (JS) | Flutter (Dart) | Gap |
|---|---|---|---|---|
| Staging Blob | `staging/blobs/current.json` | `staging/blobs/current.json` | `staging/blob.bin` | ❌ |
| Device Cookie | `staging/blobs/device_cookie.bin` | `staging/blobs/device_cookie.bin` | `device_cookie.bin` | ❌ |
| Staging Hash Index | (in blob) | `staging/hash_index.json` | `staging_hash_index.json` | ❌ |
| Ledger Blocks | `ledger/blocks/` | `ledger/blocks/` | `ledger/blocks/` | ✅ |
| Ledger Hash Index | `ledger/hash_index.json` | `ledger/hash_index.json` | `ledger/hash_index.json` | ✅ |

### Solution

1. Create `lib/data/sync/staging_paths.dart` — canonical path constants matching CLI/web
2. Update `lib/data/sync/sync_service.dart` — replace 5 hardcoded path strings with constants
3. Update test files that reference old paths

### Files in Scope

| File | Action | Details |
|---|---|---|
| `lib/data/sync/staging_paths.dart` | **Create** | 5 static const path strings |
| `lib/data/sync/sync_service.dart` | **Modify** | Replace 5 inline path literals with `StagingPaths.*` |
| `test/data/sync/staging_paths_test.dart` | **Create** | Group P: constant value assertions |
| `test/data/sync/transport_test.dart` | **Modify** | Update A3, A5 test data paths |
| `test/data/sync/restore_pull_test.dart` | **Modify** | Update B1 test name string |
| `test/data/sync/device_cookie_restore_test.dart` | **Modify** | Update E2 comment string |

---

## Test Groups

### Group P: StagingPaths Constants — ~7 tests

Verify the canonical path constants have correct values matching CLI/web.

| ID | Assertion | Purpose | Rationale |
|---|---|---|---|
| P1 | `StagingPaths.remoteStagingBlob` equals `'staging/blobs/current.json'` | Verify staging blob path matches CLI/web | This is the primary path — staging entries sync through this blob. A mismatch here is a silent data fork. |
| P2 | `StagingPaths.remoteDeviceCookie` equals `'staging/blobs/device_cookie.bin'` | Verify device cookie path matches CLI/web | Cookie drives fast-path detection. Wrong path = every sync is a slow reconcile. |
| P3 | `StagingPaths.remoteStagingHashIndex` equals `'staging/hash_index.json'` | Verify staging hash index path matches CLI/web | Hash index enables incremental sync. Wrong path = full blob transfer every time. |
| P4 | `StagingPaths.remoteLedgerBlocksPrefix` equals `'ledger/blocks/'` | Verify ledger blocks prefix is correct | Already correct today; test prevents regression. |
| P5 | `StagingPaths.remoteHashIndex` equals `'ledger/hash_index.json'` | Verify ledger hash index path is correct | Already correct today; test prevents regression. |
| P6 | All StagingPaths members are `static const` (compile-time constants) | Prevent runtime mutation | Paths must never change at runtime. `const` guarantees immutability. |
| P7 | `StagingPaths.remoteStagingBlob` does not equal old Flutter path `'staging/blob.bin'` | Confirm old incorrect path is not accidentally used | Defensive check: the old path must not be the new constant value. |

### Group Q: Source File Updates — ~3 tests

Verify that sync_service.dart uses StagingPaths constants for all remote operations.
These are behavioral tests using mock transport to verify the correct paths are passed.

| ID | Assertion | Purpose | Rationale |
|---|---|---|---|
| Q1 | `_pushBlobOnly()` calls `transport.push(StagingPaths.remoteStagingBlob, ...)` | Verify blob push uses canonical path | Must push to the path CLI/web read from. |
| Q2 | `_pullRemoteBlob()` calls `transport.pull(StagingPaths.remoteStagingBlob)` | Verify blob pull uses canonical path | Must pull from the path CLI/web write to. |
| Q3 | `_pushCookie()` calls `transport.push(StagingPaths.remoteDeviceCookie, ...)` | Verify cookie push uses canonical path | Cookie at wrong path = cross-device detection broken. |

### Group R: Test Maintenance — ~2 tests

Update existing transport tests to use canonical paths instead of old Flutter paths.

| ID | Assertion | Purpose | Rationale |
|---|---|---|---|
| R1 | Transport test A3 uses `StagingPaths.remoteStagingBlob` instead of `'staging/blob.bin'` | Test data reflects production paths | Transport tests should exercise the actual paths used in production. |
| R2 | Transport test A5 uses `StagingPaths.remoteStagingBlob` instead of `'staging/blob.bin'` | Test data reflects production paths | Same as R1 — consistency between test data and production code. |

---

## Summary

| Group | Tests | Type |
|---|---|---|
| P — Path Constants | 7 | New unit tests |
| Q — Source Verification | 3 | New integration tests |
| R — Test Maintenance | 2 | Existing test updates |
| **Total** | **12** | |

### Key Coverage Areas
- **Cross-client compatibility:** P1–P3 verify paths match CLI/web canonical values
- **Regression prevention:** P4–P5 guard ledger paths (currently correct) from future drift
- **Immutability:** P6 guarantees paths cannot change at runtime
- **Defensive check:** P7 confirms old incorrect path is not reused
- **Production path usage:** Q1–Q3 verify sync_service actually uses constants
- **Test accuracy:** R1–R2 ensure test data mirrors production
