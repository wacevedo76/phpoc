# Wipe Ledger — Test Exploration (Phase 1)

> **Plan:** Feature request — add "Wipe Ledger" button to UnlockScreen
> **Purpose:** Blueprint of all needed test assertions before writing any test code.
> **Status:** ✅ Phase 4 complete — 20 GREEN tests, 1 refactor improvement
> **Next:** Ready for next task

## Problem

Users need a way to wipe all local data (ledger, staging, MK, credentials) and
start fresh without uninstalling the app. Cloud data (R2) is unaffected.

## Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│  UnlockScreen                                            │
│  ┌────────────────────────────────────────────────────┐  │
│  │  [Unlock] button                                   │  │
│  │  [Wipe Ledger] button  ← NEW                       │  │
│  │    → ConfirmationDialog                            │  │
│  │      → AuthService.wipeLedger()                    │  │
│  │        ├─ DB: DELETE FROM entries, blocks,          │  │
│  │        │        index_entries, staging,             │  │
│  │        │        _staging_kv, _phpoc_meta            │  │
│  │        ├─ SharedPreferences: clearAll()             │  │
│  │        ├─ SecureStorage: delete api_key + bio MK    │  │
│  │        └─ Memory: crypto.clearMasterKey()           │  │
│  │      → Navigate to /landing                         │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

## Test Groups

### Group A: wipeLedger() — Data Wipe (~7 tests)

Verify that AuthService.wipeLedger() removes all data from every store.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | wipeLedger() deletes all entries from SQLite | Ledger data removal | The entries table holds all activity records. Must be emptied. |
| A2 | wipeLedger() deletes all blocks from SQLite | Chain data removal | Genesis block + summary blocks must be removed. |
| A3 | wipeLedger() deletes all index_entries from SQLite | Index cleanup | Date/tag indexes must be cleared to prevent stale references. |
| A4 | wipeLedger() deletes all staging rows from SQLite | Staging cleanup | Active/paused staging entries must be removed. |
| A5 | wipeLedger() clears _staging_kv table | Staging KV cleanup | Staging key-value store (cookie, timestamps) must be emptied. |
| A6 | wipeLedger() clears SharedPreferences | Config cleanup | Worker URL, device UUID, cookie, has_existing_data, biometric flag all removed. |
| A7 | wipeLedger() clears flutter_secure_storage | Credential cleanup | Worker API key and biometric MK ciphertext removed. |

### Group B: wipeLedger() — State & Edge Cases (~5 tests)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | wipeLedger() locks the auth service (isUnlocked → false) | Session teardown | After wipe there's nothing to unlock — must clear session state. |
| B2 | wipeLedger() clears MK from memory | Key material cleanup | MK must be zeroed, not just reference-dropped. |
| B3 | wipeLedger() is idempotent — safe to call on already-empty DB | Robustness | User might tap twice or data might already be partially cleared. |
| B4 | wipeLedger() works when SharedPreferences are already empty | Robustness | First-launch edge case or partial wipe scenario. |
| B5 | wipeLedger() works regardless of locked/unlocked state | No precondition | User shouldn't need to unlock before wiping — the button is on the lock screen. |

### Group C: UnlockScreen — Wipe Button UI (~5 tests)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | "Wipe Ledger" button is visible below the "Unlock" button | Discoverability | Must be visible but not the primary action. |
| C2 | Tapping "Wipe Ledger" shows a confirmation dialog | Guard against accidental wipe | Destructive action requires explicit confirmation. |
| C3 | Dialog warns about staging deletion, ledger deletion, MK + credential removal | Informed consent | User must know exactly what they're losing. |
| C4 | Dialog has "Cancel" and "Wipe Ledger" action buttons | Standard dialog UX | Cancel = safe dismiss; Wipe Ledger = destructive confirm. |
| C5 | Tapping "Cancel" dismisses the dialog without wiping | Safe cancel | Dialog cancellation must not trigger any data deletion. |

### Group D: UnlockScreen — Wipe Action (~3 tests)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | Confirming wipe calls AuthService.wipeLedger() | Wired correctly | The button's confirm action must reach the service method. |
| D2 | After successful wipe, app navigates to LandingScreen | Fresh start UX | User should land on the "New Ledger" entry point. |
| D3 | Wipe error shows error message and stays on UnlockScreen | Error resilience | If DB close or storage access fails, user isn't stranded. |

## Summary

| Group | Assertions | Scope |
|-------|-----------|-------|
| A — Data Wipe | 7 | AuthService.wipeLedger() removes all data |
| B — State & Edge Cases | 5 | Lock state, idempotency, robustness |
| C — Wipe Button UI | 5 | UnlockScreen widget: button + dialog |
| D — Wipe Action | 3 | UnlockScreen widget: confirm flow + navigation |
| **Total** | **20** | 12 service-level, 8 widget-level |

Key coverage areas:
- **All data stores:** SQLite (5 tables), SharedPreferences, flutter_secure_storage
- **Session state:** MK cleared, isUnlocked → false
- **Idempotency:** Safe to call on already-empty state
- **UI safety:** Confirmation dialog with explicit warnings, cancel path
- **Post-wipe UX:** Navigate to landing screen for fresh start
