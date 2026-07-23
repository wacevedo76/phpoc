# Flutter Screens — Test Exploration (Phase 1)

> **Plan:** `docs/planning/flutter/INITIAL_PLAN.md` §Phase 6
> **Purpose:** Blueprint of all needed test assertions before writing any screen test code.
> **Status:** ✅ Phase 1+2+3+4 complete (109/109 GREEN)
> **Next Phase:** N/A (all phases complete)

## Architecture Overview

Eight screens consumed by a `GoRouter`-based navigation system. Screens are **presentation only**
(Axiom B4) — they read state from Riverpod providers and delegate actions to services
(`AuthService`, `OnboardingService`, `SyncService`). The `AppLifecycleNotifier` drives route
redirects through five phases: `boot → landing → onboarding → auth → ready`.

```
Boot flow:
  /loading   → probe existing data → /landing (new) or /unlock (existing) or / (biometric-cached)

Main shell (after auth):
  /             → DashboardScreen
  /history      → HistoryScreen
  /sync         → SyncScreen
  /settings     → SettingsScreen
```

All screens are currently stubs with `const Center(child: Text('... — coming soon'))` bodies.
`LandingScreen` is a `_LandingPlaceholder` in `app_router.dart` — it needs its own file.
`AppScaffold` (bottom nav shell) is fully implemented.

## Test Groups

### Group A: Loading Screen — ~4 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | `LoadingScreen` renders without error | Widget smoke test | Every screen must at minimum render without throwing |
| A2 | `LoadingScreen` displays "Initializing PH Ledger..." text | User feedback during boot | Users need to know the app is loading, not frozen |
| A3 | `LoadingScreen` shows a `CircularProgressIndicator` | Visual progress feedback | Indeterminate spinner signals boot is in progress |
| A4 | `LoadingScreen` has no back navigation (no AppBar with back button) | Boot is non-interruptible | Users should not navigate away during boot probe |

### Group B: Landing Screen — ~7 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | `LandingScreen` renders without error | Widget smoke test | Creates the file from `_LandingPlaceholder` — must render |
| B2 | `LandingScreen` displays "Log In" button | Route to unlock for returning users | Returning users need a clear path to authentication |
| B3 | `LandingScreen` displays "New Ledger" button | Route to onboarding for new users | New users need a clear path to ledger creation |
| B4 | Tapping "Log In" navigates to `/unlock` | Correct routing | GoRouter must transition to auth route |
| B5 | Tapping "New Ledger" navigates to `/onboarding` | Correct routing | GoRouter must transition to onboarding route |
| B6 | `LandingScreen` is NOT wrapped in `AppScaffold` (no bottom nav) | Correct shell context | Landing/auth screens are outside the main shell |
| B7 | `LandingScreen` shows app branding/logo/title | Visual identity | First screen users see — must communicate "PH Ledger" |

### Group C: Unlock Screen — ~12 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | `UnlockScreen` renders without error | Widget smoke test | Must render with passphrase field and unlock button |
| C2 | `UnlockScreen` shows a passphrase text field | Primary input | Core unlock mechanism |
| C3 | Passphrase field is obscured (`obscureText: true`) | Security (Axiom A2) | Passphrase must never be visible on screen |
| C4 | Passphrase field has a visibility toggle (eye icon) | UX convenience | Long passphrases benefit from optional visibility |
| C5 | Tapping "Unlock" with empty passphrase shows validation error | Input validation | Prevent unnecessary crypto operations |
| C6 | Tapping "Unlock" with passphrase < 8 chars shows validation error | Input validation | Matches `AuthService.unlock()` contract |
| C7 | Tapping "Unlock" with wrong passphrase shows error message | Error feedback | `AuthException` message must reach the user |
| C8 | Tapping "Unlock" with correct passphrase calls `authService.unlock()` then `goToReady()` | Happy path | Core authentication flow |
| C9 | After successful unlock, router redirects to `/` | Phase transition | `AppPhase.ready` → GoRouter redirect fires |
| C10 | "Unlock" button is disabled / shows spinner during passphrase validation | Loading state | Prevent double-submit, show in-progress state |
| C11 | Error state clears when user starts typing again | UX polish | Previous error should not persist after user corrects input |
| C12 | Biometric icon/button shown when biometric auth is available (optional) | Biometric support | Future Phase 8 requirement — stub if unavailable |

### Group D: Onboarding Screen — ~16 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | `OnboardingScreen` renders without error | Widget smoke test | Must render with onboarding options |
| D2 | `OnboardingScreen` shows "Create New Ledger" option | Primary CTA | Main path for new users |
| D3 | `OnboardingScreen` shows "Import from Recovery Seed" option | Recovery path | Users restoring from seed backup |
| D4 | `OnboardingScreen` shows "Connect to Worker" option (optional step) | Remote sync config | Worker connection is part of onboarding but skippable |
| D5 | Selecting "Create New Ledger" shows passphrase input form | Sub-flow display | Passphrase is required before genesis creation |
| D6 | Create New: passphrase < 8 chars shows validation error | Input validation | Matches `OnboardingService.createNewLedger()` contract |
| D7 | Create New: valid passphrase calls `onboardingService.createNewLedger()` | Happy path | Core onboarding flow |
| D8 | Create New: after successful creation, recovery seed is displayed | Seed backup | User must see seed once for backup (Axiom A7) |
| D9 | Create New: seed screen requires acknowledgment checkbox before continuing | Seed acknowledgment | User must confirm they saved the seed |
| D10 | Create New: after seed acknowledgment, transitions to `/unlock` | Phase transition | `goToAuth()` → router redirects to unlock |
| D11 | Selecting "Import" shows seed base64 input field | Sub-flow display | Seed import requires text input |
| D12 | Import: invalid base64 seed shows validation error | Input validation | Must reject malformed seed before calling service |
| D13 | Import: valid seed + valid passphrase calls `onboardingService.importFromSeed()` | Happy path | Core import flow |
| D14 | Import: after successful import, transitions to `/unlock` | Phase transition | Same as Create New — auth follows onboarding |
| D15 | "Connect to Worker" shows URL + API key fields | Sub-flow display | Remote storage configuration |
| D16 | Connect Worker: valid URL format validation (reject malformed URLs) | Input validation | Prevent invalid Worker URLs before service call |
| D17 | Connect Worker: valid inputs call `onboardingService.connectWorker()` | Happy path | Core Worker connection flow |
| D18 | `LedgerExistsException` during Create/Import shows error dialog | Error handling | User must know data already exists |
| D19 | Back navigation from any sub-flow returns to main onboarding options | Navigation | Users can change their mind |

### Group E: Dashboard Screen — ~15 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | `DashboardScreen` renders without error within `AppScaffold` | Widget smoke test | Must render inside the bottom-nav shell |
| E2 | `DashboardScreen` shows "Start New Task" form with title input | Core capture UI | Users need to create tasks from the dashboard |
| E3 | Tapping capture button with empty title shows validation error | Input validation | Prevent empty-title entries |
| E4 | Tapping capture button with valid title calls `syncService.capture()` | Happy path | Core capture flow |
| E5 | After capture, active task card appears with title | Active task display | User confirmation that task was created |
| E6 | Active task card shows elapsed time / start time | Duration feedback | Users need to know how long a task has been running |
| E7 | Active task card has "End" button → calls `syncService.end()` | Task completion | Core end-task action |
| E8 | After ending, active task card disappears and "No active tasks" shows | State cleanup | Completed tasks move to history |
| E9 | Active task card has "Pause" / "Resume" toggle button | Pause/resume | Core pause/unpause actions (Axiom A5) |
| E10 | Pausing calls `syncService.pause()`, resuming calls `syncService.unpause()` | Correct delegation | Screen delegates to sync service |
| E11 | Recent entries list shown below active task card (or full-width when no active) | History preview | Quick access to recent task context |
| E12 | Recent entries show title, date, and duration | Entry summary | Minimal info for quick scan |
| E13 | Tapping a recent entry navigates to `/history` (filtered to that date) | Cross-screen navigation | Deep-link from dashboard to history |
| E14 | Empty state: no active task AND no recent entries → "No tasks yet" message | Empty state UX | Clear feedback that the app is working but empty |
| E15 | Capture failure shows error via SnackBar or inline message | Error feedback | `SyncService` errors must be surfaced to user |
| E16 | Active task card updates duration live (periodic timer) | Real-time feedback | Running task timer — key UX differentiator |

### Group F: History Screen — ~10 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| F1 | `HistoryScreen` renders without error within `AppScaffold` | Widget smoke test | Must render inside the bottom-nav shell |
| F2 | `HistoryScreen` loads entries from `syncService.getEntries()` | Data integration | Screen reads from sync service |
| F3 | Entry list items show title, date, duration, and tags | Entry display | Complete entry summary |
| F4 | Date filter control (date range picker or segmented filter) | Filtering | Users need to narrow down entry lists |
| F5 | Selecting a date range updates the displayed entry list | Filter behavior | Filter must re-query or filter in UI |
| F6 | Empty state: no entries shows "No entries yet" message | Empty state UX | Clear feedback when no entries exist |
| F7 | Empty state: filtering to a date with no entries shows "No entries for this period" | Filtered empty state | Different from global empty — filtering, not absence |
| F8 | Tapping an entry expands or navigates to detail view | Entry drill-down | Users need to see pauses, metadata, tags |
| F9 | Expanded entry detail shows pause history, tags, metadata | Detail completeness | Full entry information available |
| F10 | Loading state shows spinner while entries are fetched | Loading UX | Async data fetch needs visual feedback |
| F11 | Entry list scrolls when entries exceed screen height | Scroll behavior | Large ledgers must be navigable |

### Group G: Sync Screen — ~12 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| G1 | `SyncScreen` renders without error within `AppScaffold` | Widget smoke test | Must render inside the bottom-nav shell |
| G2 | `SyncScreen` displays sync status indicator (ready / offline / syncing / error) | Status visibility | Users must know sync state at a glance (Axiom A6) |
| G3 | Status shows "Ready" when `syncService.isRemoteAvailable` is true and no pending | Ready state | Normal operating state |
| G4 | Status shows "Offline" with appropriate icon when `transport` is null | Offline state | Graceful offline handling (Axiom A6) |
| G5 | Status shows "Syncing…" during `checkAndSync()` or `pushToRemote()` | In-progress state | User feedback during sync operations |
| G6 | "Sync Now" button calls `syncService.checkAndSync()` | Manual sync trigger | Users initiate sync on demand |
| G7 | After successful sync, last-sync timestamp updates | Success feedback | Confirmation that sync completed |
| G8 | After successful sync, pending entry count updates (or shows zero) | Data freshness | Users know their data is on the Worker |
| G9 | Shows count of locally modified entries pending push | Pending count | Transparency about what hasn't been synced |
| G10 | When `checkAndSync()` returns `SyncResult.reauthNeeded`, screen shows re-auth prompt | Auth-gate handling | `REAUTH_NEEDED` must be surfaced, not silently ignored |
| G11 | Sync error (network failure) shows error message with retry option | Error recovery | Users can retry after connectivity returns |
| G12 | Sync error clears on next successful sync attempt | Error cleanup | Stale errors must not persist |
| G13 | Commit-entry UI (deferred — ledger engine is Phase 7) shows "Coming in a future update" | Future feature placeholder | Honest about MVP scope (staging-only) |

### Group H: Settings Screen — ~12 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| H1 | `SettingsScreen` renders without error within `AppScaffold` | Widget smoke test | Must render inside the bottom-nav shell |
| H2 | `SettingsScreen` displays current Worker URL (or "Not configured") | Config visibility | Users can verify their remote sync setup |
| H3 | `SettingsScreen` displays Worker connection status (connected / disconnected) | Status visibility | Quick health check for remote sync |
| H4 | Tapping Worker config opens editor for URL + API key | Config editing | Users can update Worker settings |
| H5 | Saving Worker config calls `onboardingService.connectWorker()` | Config persistence | Settings changes must reach the service layer |
| H6 | "Change Passphrase" option opens old/new passphrase fields | Passphrase change UI | Core security operation |
| H7 | Change passphrase: new passphrase < 8 chars shows validation error | Input validation | Matches `AuthService.changePassphrase()` contract |
| H8 | Change passphrase: wrong old passphrase shows `AuthException` error | Auth validation | Old passphrase must be correct before change |
| H9 | Change passphrase: correct old + valid new calls `authService.changePassphrase()` | Happy path | Core passphrase rotation flow |
| H10 | "Export Recovery Seed" option shows warning dialog before revealing seed | Security (Axiom A7) | Seed is sensitive — must confirm user intent |
| H11 | Export seed: after confirmation, seed is displayed (requires re-authentication) | Seed export flow | Additional auth gate for seed export |
| H12 | "Lock / Log Out" option clears MK and transitions to `/unlock` | Session termination | Calls `authService.lock()` + `appLifecycleNotifier.goToAuth()` |
| H13 | "About" section shows app name, version, and build info | App info | Standard settings expectation |

### Group I: Navigation / AppScaffold — ~8 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| I1 | `AppScaffold` bottom nav has 4 tabs: Dashboard, History, Sync, Settings | Navigation structure | All four main sections accessible |
| I2 | Tapping each bottom-nav tab navigates to the correct route | Tab routing | Dashboard→`/`, History→`/history`, Sync→`/sync`, Settings→`/settings` |
| I3 | Selected tab icon is filled, unselected tabs are outlined | Visual feedback | Material 3 NavigationBar convention |
| I4 | `AppScaffold` is only rendered when `AppPhase.ready` (not during boot/auth) | Shell gating | ShellRoute only wraps ready-state routes |
| I5 | At boot (`AppPhase.boot`), router redirects to `/loading` | Boot redirect | Initial state before data probe |
| I6 | At landing (`AppPhase.landing`), router redirects to `/landing` | Landing redirect | No existing data → onboarding choice |
| I7 | At auth (`AppPhase.auth`), router redirects to `/unlock` | Auth redirect | Existing data, locked → must unlock |
| I8 | At ready (`AppPhase.ready`), router redirects `/loading` and `/unlock` to `/` | Ready redirect | Unlocked → main app, no auth screens accessible |

### Group J: App Lifecycle Integration — ~6 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| J1 | Full flow: onboarding → create ledger → unlock → dashboard renders active task | E2E integration | Happy path from cold install to active use |
| J2 | Full flow: existing data → unlock → dashboard shows previous entries | E2E integration | Returning user path |
| J3 | Lock from settings → `authService.lock()` called, phase → auth, router → `/unlock` | Lock lifecycle | Lock clears MK and redirects |
| J4 | Unlock from `/unlock` → `authService.unlock()` called, phase → ready, router → `/` | Unlock lifecycle | Auth completion transitions to app |
| J5 | Onboarding complete → `hasExistingData()` returns true on next probe | State persistence | Boot probe must detect previously created ledger |
| J6 | `AppLifecycleNotifier.goToX()` calls are idempotent (calling twice doesn't crash) | State machine robustness | Phase transitions must tolerate duplicate calls |

## Summary

| Group | Screen | Assertions | Key Focus |
|-------|--------|-----------|-----------|
| A | Loading | 4 | Boot splash, loading indicator |
| B | Landing | 7 | New vs returning user routing |
| C | Unlock | 12 | Passphrase input, validation, auth flow |
| D | Onboarding | 19 | Create/import/connect flows, seed backup |
| E | Dashboard | 16 | Active task card, capture, pause/resume, timer |
| F | History | 11 | Entry list, date filter, detail expansion |
| G | Sync | 13 | Status indicators, manual sync, offline handling |
| H | Settings | 13 | Worker config, passphrase change, seed export, lock |
| I | Navigation | 8 | Bottom nav tabs, GoRouter redirects, shell gating |
| J | Lifecycle | 6 | Full flows, phase transitions, state persistence |
| **Total** | **10 groups** | **109** | |

### Coverage Areas
- **Rendering:** Every screen renders without error (A1–J6)
- **Navigation:** GoRouter redirects at every phase, bottom-nav tab routing, deep linking
- **User Input:** Text fields, buttons, toggles, checkboxes — validation and submission
- **Error States:** Auth failures, network errors, validation errors, ledger-exists errors
- **Loading States:** Spinners during async operations, disabled buttons during submission
- **Empty States:** No tasks, no entries, no Worker, filtered-empty results
- **Axiom Compliance:** B4 (screen≠service), A2 (obscured passphrase), A5 (staging-only MVP), A6 (offline)
- **Cross-Screen Integration:** Dashboard→History linking, phase transitions driving router redirects
