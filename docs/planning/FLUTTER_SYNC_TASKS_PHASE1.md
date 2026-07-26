# Flutter Sync Tasks T2/T3/T8 — Test Exploration (Phase 1)

> **Plan:** SESSION_HANDOFF §Immediate Next Steps
> **Purpose:** Blueprint of all needed test assertions before writing any test code.
> **Status:** ✅ Phase 4 complete — all 4 groups (36/36 tests GREEN)
> **Next:** Mop-up: Group M Phase 4 refactor, or backlog items

## Architecture Overview

Three sync tasks share one code path: `SyncService.checkAndSync()`. T2 (cookie validity) gates entry to the decision tree. T3 (cookie comparison) decides fast-path vs auth-gate. T8 (commit to ledger) is a new public method on `SyncService` that delegates to `LedgerEngine`.

```
checkAndSync():
  1. No transport? → READY (not tested here — G1 covers this)
  2. Genesis gate passthrough (MVP: always skip)
  3. No MK? → REAUTH_NEEDED (tested: G10)
  4. [T2] isValidLocally(storage, 30min)?
     ├─ null (expired/missing) → fall to _reconcileAndClaim
     └─ cookie → [T3] pull remote cookie
         ├─ network error → OFFLINE
         ├─ matches? → _pushBlobOnly() → READY (fast path)
         └─ mismatch → destroyLocal → REAUTH_NEEDED
  5. _reconcileAndClaim: pull blob → merge → push blob + new cookie → READY

[T8] commitEntries(entryIds):
  1. Filter: only is_active==false + committed!=true
  2. LedgerEngine.commit(filtered)
  3. Mark committed in staging
  4. Return hash prefix
```

### Key Modules

| Module | Path | Role |
|---|---|---|
| SyncService | `lib/data/sync/sync_service.dart` | Sync gate + T2/T3 logic + T8 entry point |
| DeviceCookie | `lib/data/sync/device_cookie.dart` | isValidLocally(), matches(), create(), destroyLocally() |
| LedgerEngine | `lib/data/ledger/engine.dart` | commit(), verify(), revert() |
| LocalCache | `lib/data/sync/local_cache.dart` | readEntries(), writeEntries(), update() |
| MergeEngine | `lib/data/sync/merge_engine.dart` | mergeMaps() for auth-gate reconcile |

### Existing Test Coverage

| Group | File | Tests | Status |
|---|---|---|---|
| D | `device_cookie_test.dart` | 12 | ✅ GREEN — cookie unit tests |
| C | `merge_engine_test.dart` | 8 | ✅ GREEN — merge engine |
| G | `sync_service_test.dart` | 18 | ⚠️ Mixed — skeleton RED tests, code is GREEN |
| E | `sync_service_test.dart` | 16 | ✅ GREEN — local CRUD |
| F | `sync_service_test.dart` | 5 | ✅ GREEN — queries |
| Q | `sync_service_test.dart` | 3 | ✅ GREEN — StagingPaths usage |
| H | `sync_service_test.dart` | 8 | ⚠️ Mixed — push operations |
| J | `sync_integration_test.dart` | 10 | 🔴 RED — integration stubs |

## Test Groups

### Group K: T2 — Cookie Check (isValidLocally wiring) — ~7 tests

The `DeviceCookie.isValidLocally()` unit is already tested (D3–D6). These tests verify the **wiring** inside `checkAndSync()` — that the result of the cookie check correctly gates the decision tree.

| ID | Assertion | Purpose | Rationale |
|---|---|---|---|
| K1 | `checkAndSync` with valid local cookie + matching remote → READY (fast path exercised) | Verify T2 gate passes to T3 | Current G3 only tests no-transport; need spy with real cookie + matching remote |
| K2 | `checkAndSync` with expired local cookie → falls to auth gate (reconcile) | Verify TTL expiry triggers reconcile, not fast path | Expired cookies must force full auth, not silent push |
| K3 | Expired cookie is removed from storage after `checkAndSync` detects it | Verify garbage collection on expiry path | `isValidLocally` already cleans up, but verify checkAndSync doesn't leave orphans |
| K4 | `checkAndSync` with malformed cookie (null specifier) → treated as expired → reconcile | Graceful degradation for corrupt data | Corrupt local state must not crash sync |
| K5 | `checkAndSync` with valid cookie but no MK cached → REAUTH_NEEDED | Verify MK gate takes priority over cookie validity | Cookie alone is not enough — must have crypto to push |
| K6 | `checkAndSync` with valid cookie + no transport → READY (local-only) | Verify local-only path still works with cookie present | Regression guard: G1 tests no-cookie+no-transport; must also test with-cookie+no-transport |
| K7 | `checkAndSync` honors configurable TTL (not hardcoded 30 min) | Verify TTL parameter propagates to isValidLocally | Must match CLI/web behavior where TTL is configurable |

### Group M: T3 — Cookie Compare (matches + push-after-match) — ~10 tests

These tests verify the **fast path** and **mismatch path** through spy transport — confirming blob push ordering, cookie lifecycle, and network-error handling.

| ID | Assertion | Purpose | Rationale |
|---|---|---|---|
| M1 | Fast path: valid local + matching remote → `_pushBlobOnly` called → READY | Verify the happy-path fast sync | Core optimization: skip full blob pull when cookies match |
| M2 | Spy transport confirms blob pushed to `StagingPaths.remoteStagingBlob` during fast path | Verify correct remote path on fast-path push | Regression guard: blob must go to canonical path for CLI/web interop |
| M3 | Fast path does NOT push cookie (only blob) | Verify fast path doesn't waste a cookie round-trip | Cookie is unchanged when specs match; pushing wastes bandwidth |
| M4 | Mismatch: valid local + different remote specifier → destroyLocal → REAUTH_NEEDED | Verify cookie rotation on device switch | Different specs = different device session → must re-auth |
| M5 | Mismatch: verify cookie removed from storage after destroyLocal | Verify cleanup on mismatch path | Stale local cookie left behind would cause wrong device identity |
| M6 | No remote cookie: valid local + empty remote → falls to reconcile (creates cookie) | Verify first-push-wins path | When remote has no cookie, local device claims it by pushing |
| M7 | Network error during remote cookie pull → OFFLINE | Verify offline resilience on cookie pull | Network blip must not destroy local cookie or mislabel as REAUTH |
| M8 | Fast path works when device_uuid in remote cookie matches local (same device) | Verify fast path for same-device reboot | After app restart, same device should hit fast path, not auth gate |
| M9 | Fast path updates `_lastPushAt` timestamp | Verify diagnostic tracking | Downstream UI uses lastPushAt for "Last synced: X min ago" |
| M10 | Fast path with empty staging (no entries) still pushes blob | Verify empty-push is valid | Empty blob clears remote; must not crash or skip push |

### Group N: T8 — Commit to Ledger (SyncService.commitEntries) — ~14 tests

Completely new method. No existing tests. The `commitEntries` method filters staging entries, delegates to `LedgerEngine.commit()`, marks entries committed, and returns the block hash prefix.

| ID | Assertion | Purpose | Rationale |
|---|---|---|---|
| N1 | `commitEntries` returns hash prefix (first 10 chars of last block hash) | Verify return value matches LedgerEngine contract | Callers need the hash for display/verification |
| N2 | `commitEntries` filters out `is_active==true` entries | Verify only completed entries are committed | Active tasks have no end time — cannot build a day block |
| N3 | `commitEntries` filters out already-committed entries (`committed==true`) | Verify dedup — no double-commit | Re-committing corrupts the ledger with duplicate blocks |
| N4 | `commitEntries` with empty list returns null (no-op) | Verify graceful empty handling | UI may call commit with empty selection |
| N5 | `commitEntries` with all entries already committed returns null | Verify all-done no-op | Sync screen may re-trigger commit; must not crash |
| N6 | After commit, committed entries marked `committed=true` in staging | Verify staging state updated | Without this, entries would be re-committed on next call |
| N7 | After commit, non-committed entries preserved in staging unchanged | Verify selectivity — only target entries are committed | Committing entry A must not touch entry B |
| N8 | `commitEntries` calls `LedgerEngine.commit()` with correct entries | Verify delegation to engine | Must use LedgerEngine, not bypass it |
| N9 | `commitEntries` with no LedgerEngine (missing identity) throws clear error | Verify error path for uninitialized ledger | First boot before onboarding must not crash silently |
| N10 | `commitEntries` passes entries with `has_encrypted_fields` flag preserved | Verify per-field encryption metadata survives to engine | Fields encrypted in staging must stay encrypted in ledger blocks |
| N11 | Committed entries retain `hash` field from LedgerEngine in staging | Verify hash stored for cross-reference | Downstream UI and merge engine use hash for dedup |
| N12 | `commitEntries` handles entries from mixed dates (groups by date) | Verify multi-day commit works | User may have entries spanning multiple days in staging |
| N13 | `commitEntries` preserves `entry_id`, `device_uuid`, `end_device_uuid` through commit | Verify provenance data survives | Cross-device merge needs these fields for conflict resolution |
| N14 | `commitEntries` available as public method on `SyncService` | Verify API contract | SESSION_HANDOFF lists T8 as "not implemented" — method must exist |

### Group R: T8 UI — Sync Screen Commit Button — ~5 tests

UI-level tests for the commit button on the sync screen. Currently G13 shows "Coming in a future update" — these tests define the UX contract.

| ID | Assertion | Purpose | Rationale |
|---|---|---|---|
| R1 | Sync screen shows "Commit to Ledger" button (replaces placeholder) | Verify commit entry point visible | Users need a discoverable way to commit completed entries |
| R2 | Commit button disabled when no completable entries exist | Verify UX guard against empty commit | Prevents confusion: "why did nothing happen?" |
| R3 | Commit button enabled when completable entries exist (is_active==false, not committed) | Verify UX enablement logic | Button must react to staging state changes |
| R4 | Tapping commit button calls `syncService.commitEntries()` | Verify wiring to T8 method | UI must delegate to SyncService, not LedgerEngine directly |
| R5 | After successful commit, UI shows hash prefix confirmation | Verify user feedback | Users need to know commit succeeded and see the block hash |

---

## Assertion Summary

| Group | Task | Assertions | Status |
|---|---|---|---|
| K | T2 — Cookie Check wiring | 7 | ✅ Phase 4 done (7/7 GREEN) |
| M | T3 — Cookie Compare + fast path | 10 | ✅ Phase 2 done (10 GREEN — implementation already existed) |
| N | T8 — Commit to Ledger (SyncService) | 14 | 🔴 New — unimplemented method |
| R | T8 UI — Sync Screen Commit Button | 5 | 🔴 Phase 2 done — 5 RED (button not yet wired) |
| **Total** | | **36** | |

### Coverage Map

- **T2 happy path:** K1, K6
- **T2 edge cases:** K2 (expired), K3 (cleanup), K4 (malformed), K5 (no MK), K7 (configurable TTL)
- **T3 happy path:** M1, M2, M3, M8, M9, M10
- **T3 edge cases:** M4 (mismatch), M5 (cleanup), M6 (first push), M7 (offline)
- **T8 core:** N1–N7, N14
- **T8 edge cases:** N8 (delegation), N9 (no engine), N10 (encrypted fields), N11 (hash), N12 (multi-date)
- **T8 UI:** R1–R5

### Not Covered (Deferred to Later Phases)

- **T8 recovery:** Reverting a commit, rollback on partial failure (LedgerEngine.revert already exists)
- **T8 index update:** Blind index update side effects (tested in LedgerEngine unit tests)
- **T2/T3 with real HTTP:** Network-layer integration tests (transport_test.dart covers transport; integration covered by Group J)
- **Auto-commit trigger after sync:** Web auto-commits after "Sync Now"; Flutter doesn't have this yet
- **Genesis gate full implementation:** MVP always passes through; real genesis check is Phase 7
