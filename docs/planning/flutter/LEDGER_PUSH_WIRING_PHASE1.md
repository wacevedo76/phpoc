# LedgerPushService Wiring — Test Exploration (Phase 1)

> **Plan:** Wire `LedgerPushService` into Riverpod providers and SyncScreen UI
> **Purpose:** Blueprint of all needed test assertions before writing any test code.
> **Status:** ✅ Phase 1 (test exploration) → ✅ Phase 2 (RED: test definition) → ✅ Phase 3 (GREEN: implementation)
> **Next Phase:** Phase 4 (REFACTOR: code review)

## Architecture Overview

`LedgerPushService` is fully implemented and tested (Groups A–I, 45 tests GREEN)
but not connected to the app. Wiring it requires three layers:

```
LedgerPushService (✅ complete)         ← pushes blocks → R2
    ↑
ledgerPushServiceProvider (NEW)         ← Riverpod singleton
    ↑
SyncService.commitEntries() (✅)        ← commit → local ledger
    ↑
SyncScreen "Push to Cloud" button (NEW) ← user trigger
```

### What Already Exists

| Component | Status | Notes |
|-----------|--------|-------|
| `LedgerPushService` | ✅ | 45 tests GREEN (Groups A–I), pushes blocks to `ledger/blocks/NNNNNN.json` |
| `LedgerPushService.pushAll()` | ✅ | Reads all blocks from DB, obfuscates, pushes to Worker/R2 |
| `SyncService.commitEntries()` | ✅ | Commits staging → local SQLite ledger via `LedgerEngine.commit()` |
| `SyncService.pushToRemote()` | ✅ | Pushes staging blob only (not ledger blocks) |
| `providers.dart` | ✅ | Existing: `databaseProvider`, `cryptoServiceProvider`, `syncServiceProvider`, etc. |
| `SyncScreen` | ✅ | Shows uncommitted entries + "Commit to Local Ledger" button |
| `HttpTransport` | ✅ | Already wired for staging sync; same transport used for ledger push |

### What's New

1. **`ledgerPushServiceProvider`** — Riverpod provider (~5 lines) injecting `AppDatabase`, `CryptoService`, `HttpTransport`
2. **Commit→Push integration** — After `commitEntries()`, blocks exist in DB; `pushAll()` must send them to R2
3. **SyncScreen "Push to Cloud" button** — UI trigger for `pushAll()`, with loading/error/success states

### Key Constraints

1. **Push requires transport:** Button hidden or disabled when `HttpTransport` is null (local-only mode)
2. **Push requires MK:** `pushAll()` throws `StateError` without cached master key — must be caught in UI
3. **Push requires non-empty DB:** `pushAll()` throws `StateError` on empty ledger — safety guard
4. **Idempotent:** Repeated pushes produce identical remote state; safe to re-push
5. **Concurrent guard:** `LedgerPushService._pendingPush` serializes concurrent calls — second caller waits for first

---

## Test Groups

### Group J: Provider Definition & Wiring — 5 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| J1 | `ledgerPushServiceProvider` returns `LedgerPushService` singleton (same instance on repeat reads) | Verify provider constructs and caches correctly | Riverpod singletons must return the same instance; duplicate instances would duplicate `_pendingPush` guards |
| J2 | Provider injects `AppDatabase`, `CryptoService`, `HttpTransport` without missing-dependency crash | Full dependency resolution | If any dep is miswired, the app crashes at runtime — this test catches it at build time |
| J3 | Provider disposes cleanly — no unclosed DB handles or leaked transports after container disposal | Resource cleanup | Riverpod `onDispose` must release resources; leaks compound across app lifecycle |
| J4 | Provider resolves when `HttpTransport` is null (local-only mode) — returns service that will fail gracefully at `pushAll()` time | Graceful degradation | The provider itself must construct; the push-time guard handles the null transport case |
| J5 | Updated provider graph (all existing providers + `ledgerPushServiceProvider`) resolves without circular dependency errors | Regression guard | Adding a new provider must not introduce cycles in the existing 8-provider graph |

### Group K: SyncService ↔ LedgerPushService Integration — 4 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| K1 | `commitEntries()` followed by `pushAll()` — committed block appears at `ledger/blocks/NNNNNN.json` on fake transport | End-to-end: commit writes blocks to DB, push sends them to R2 | This is the core user workflow: complete entries → commit → push. Must work without gaps. |
| K2 | `pushAll()` with no new commits is idempotent — second push overwrites same blocks, remote state unchanged | Safety: re-push must not corrupt or duplicate | Users may push multiple times; idempotency is a stated design constraint of the push service |
| K3 | `pushAll()` after transport disconnect returns `PushResult.failure`, does not throw unhandled exception | Graceful offline handling | Network failures must produce structured errors, not crashes — the UI catches `PushResult` |
| K4 | `pushAll()` without cached MK throws `StateError` with descriptive message | Auth guard: must unlock before pushing | User must have authenticated before pushing ledger blocks; the error message guides debugging |

### Group L: SyncScreen UI — 5 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| L1 | "Push Ledger to Cloud" button renders when transport is configured and at least one block exists in DB | Discoverability | Button must be visible to users who have committed entries; hidden when there's nothing to push |
| L2 | Button shows loading spinner and is disabled during `pushAll()` (prevents double-push) | UX guard | `LedgerPushService._pendingPush` serializes backend calls but the UI must also prevent rapid taps |
| L3 | Successful push shows SnackBar with "Pushed N blocks — a1b2c3d4e5" confirmation | User feedback | Users need confirmation their data reached the cloud; hash prefix provides verifiability |
| L4 | Failed push shows error SnackBar with failure reason, button re-enables | Error resilience | Errors must be surfaced without blocking the UI; user can retry after fixing connectivity |
| L5 | Push button hidden when transport is null (local-only mode, no Worker configured) | Clean UI | Users who haven't set up cloud sync should not see a non-functional button |

---

## Assertion Summary

| Group | Area | Assertions | Test File |
|-------|------|-----------|-----------|
| J | Provider definition & wiring | 5 | `providers_test.dart` (extend H group) |
| K | SyncService ↔ LedgerPush integration | 4 | `sync_service_test.dart` (extend E group) |
| L | SyncScreen push button UI | 5 | `sync_screen_test.dart` (extend R group) |
| **Total** | | **14** | 3 existing files |

## Coverage Map

- **Happy path:** J1–J2 (provider resolves), K1 (commit→push), L1–L3 (button → push → confirmation)
- **Error paths:** J4 (null transport), K3 (offline), K4 (no MK), L4 (push failure SnackBar)
- **Safety:** J5 (no cycles), K2 (idempotent), L2 (double-push guard), L5 (hidden offline)
- **Resource hygiene:** J3 (dispose cleanup)

## Existing RED Tests (Pre-Existing)

None. The push button tests R1–R5 (SyncScreen commit button) are separate — those test the "Commit to Local Ledger" button, not the "Push to Cloud" button. The new L group adds the push button alongside the existing commit button.

## Out of Scope

- **Auto-push on commit:** Whether `commitEntries()` should automatically trigger `pushAll()`. This is a UX decision for Phase 3 — the test blueprint covers the explicit push button flow.
- **Pull/restore integration:** `LedgerPullService` is already wired via `onboardingServiceProvider`. No new tests needed.
- **Push progress bar:** A progress indicator showing block-by-block push status is a nice-to-have, not in scope for initial wiring.
