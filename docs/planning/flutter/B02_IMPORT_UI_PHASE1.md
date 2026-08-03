# B-02: Flutter — Import UI Layer — Test Exploration (Phase 1)

> **Plan:** `docs/planning/flutter/B02_IMPORT_ENTRIES_PHASE1.md` (Flutter import blueprint)
> **Reference:** `docs/planning/B02_CROSS_LEDGER_MIGRATION_PHASE1.md` (cross-client blueprint)
> **Purpose:** Blueprint for completing the UI layer: real screens, provider state machine, route, settings tile.
> **Status:** ✅ Phase 4 complete (2026-08-03)
> **Result:** 40 assertions → 40 GREEN tests → 7 Phase 4 improvements

## Architecture Overview

### What's Done vs What's Needed

| Layer | File | Status |
|-------|------|--------|
| Models | `import_result.dart` | ✅ Done |
| Service | `import_service.dart` | ✅ Done — `dryRun`, `import`, `importFromFile`, `rollback` |
| Tests | 4 test files, 79 tests | ✅ All GREEN |
| **ImportScreen** | `import_screen.dart` | 🔧 Stub — needs real wiring |
| **ImportPreviewSheet** | *doesn't exist* | 🔧 Needs to be built |
| **ImportProgressSheet** | *doesn't exist* | 🔧 Needs to be built |
| **ImportProvider** | `import_providers.dart` | 🔧 Needs state machine upgrade |
| **Route** | `app_router.dart` | 🔧 No `/import` route |
| **Settings tile** | `settings_screen.dart` | 🔧 No import entry tile |

### Component Tree

```
ImportScreen (ConsumerStatefulWidget)
├── Seed TextField (obscured, 44-char base64)
├── [Pick ledger.json file] OutlinedButton
├── [Preview] ElevatedButton (disabled until seed/file provided)
│
├── ImportPreviewSheet (ModalBottomSheet, shown after dryRun)
│   ├── "N entries found" summary
│   ├── Date range: "Jan 1 → Jan 15, 2024"
│   ├── Conflicts list (if any) with ⚠️ icon
│   ├── [Cancel] TextButton
│   └── [Import] / [Import Anyway] FilledButton
│
└── ImportProgressSheet (ModalBottomSheet, shown during/after import)
    ├── Phase label: "Decrypting source entries…"
    ├── LinearProgressIndicator (indeterminate)
    ├── Success state:
    │   ├── "✅ 42 entries imported in 5 day blocks"
    │   └── [Back to Dashboard] FilledButton
    └── Error state:
        ├── Error message with icon
        ├── [Try Again] OutlinedButton
        └── [Cancel] TextButton
```

### State Machine (ImportNotifier)

```
                   ┌──────────────────────────────┐
                   │         ImportInitial          │
                   │  seed: null, file: null        │
                   └──────────┬───────────────────┘
                              │ user enters seed / picks file
                              ▼
                   ┌──────────────────────────────┐
                   │         ImportReady            │
                   │  seed: "…", file: bytes?       │
                   └──────────┬───────────────────┘
                              │ [Preview] tapped
                              ▼
                   ┌──────────────────────────────┐
                   │        ImportPreviewing        │
                   │  running dryRun()              │
                   └─────┬────────────┬───────────┘
                         │            │
                    dryRun ok     dryRun error
                         │            │
                         ▼            ▼
              ┌──────────────┐  ┌──────────────┐
              │ ImportPreview│  │ ImportError   │
              │ preview data │  │ message       │
              └──────┬───────┘  └──────┬────────┘
                     │ [Import] tapped  │ dismiss
                     ▼                  ▼
              ┌──────────────┐  ┌──────────────┐
              │ImportRunning │  │ ImportReady  │
              │ phase label  │  │ (retry)      │
              └──┬──────┬────┘  └──────────────┘
                 │      │
            import ok  import error
                 │      │
                 ▼      ▼
          ┌───────┐ ┌──────────────┐
          │Done   │ │ ImportError  │
          │result │ │ message      │
          └───────┘ └──────────────┘
```

### Files in Scope

| File | Role | Change |
|------|------|--------|
| `lib/features/import/import_providers.dart` | `ImportNotifier` (AsyncNotifier) with state machine | **Rewrite** |
| `lib/features/import/import_screen.dart` | Real `ConsumerStatefulWidget` wired to provider | **Rewrite** |
| `lib/features/import/import_preview_sheet.dart` | Modal bottom sheet for dry-run results | **New** |
| `lib/features/import/import_progress_sheet.dart` | Modal bottom sheet for import progress/result | **New** |
| `lib/routing/app_router.dart` | Add `/import` route | Minor |
| `lib/features/settings/settings_screen.dart` | Add "Import entries from another ledger" tile | Minor |

### Test Helpers Available

- `pumpScreenWidget(tester, screen)` — pumps a widget inside `ProviderScope` with in-memory overrides
- `defaultScreenOverrides()` — in-memory DB, crypto, auth, sync, onboarding
- `AppPhase.ready` — the default phase for most screen tests
- Models already tested: `ImportPreview`, `ImportResult`, `DateRange`, `ImportException`
- `ImportService` already tested: `dryRun`, `import`, `importFromFile`, `rollback`

---

## Test Groups

### Group N: ImportNotifier — Provider State Machine (~8 tests)
**File:** `test/features/import_providers_test.dart` (replace existing J-group placeholder tests)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| N1 | Initial state is `ImportInitial` with no seed, no file, preview disabled | Default state | Screen must start clean on first visit |
| N2 | Setting seed transitions to `ImportReady` with `previewEnabled: true` | Seed-only enable | Seed alone is sufficient — entries extracted from seed-derived chain |
| N3 | Setting file bytes transitions to `ImportReady` with `previewEnabled: true` | File-only enable | File alone enables preview (seed asked later if needed) |
| N4 | Calling `dryRun()` transitions through `ImportPreviewing` → `ImportPreview` with preview data | Dry-run flow | Full state cycle for the happy-path preview |
| N5 | Calling `dryRun()` with no seed/file throws `StateError` with clear message | Guard clause | Prevent accidental empty dry-run calls |
| N6 | Calling `dryRun()` when source seed matches target seed throws `ImportException` (self-import) | Self-import guard | Catches the service-layer error and transitions to `ImportError` |
| N7 | Calling `import()` transitions through `ImportRunning` → `ImportDone` with result | Import flow | Full state cycle for the happy-path import |
| N8 | Calling `import()` when conflicts exist and `force: false` transitions to `ImportError` with overlap message | Conflict rejection | Non-force import must surface the overlap error through the state machine |

### Group O: ImportScreen — Real Widget (~10 tests)
**File:** `test/features/import_screen_test.dart` (replace existing H-group placeholder tests)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| O1 | Screen shows seed text field with "Recovery Seed" label and placeholder text | Seed input UI | User must recognize where to paste the source seed |
| O2 | Screen shows "Pick ledger.json file" button that opens file picker dialog | File picker UI | Alternative input method for users with the source file |
| O3 | Preview button is disabled when both seed and file are empty | Disabled state | Prevent empty submissions |
| O4 | Entering text in seed field enables the Preview button | Seed enablement | Reactive UI: button state follows input state |
| O5 | Tapping file picker button and selecting a file enables the Preview button | File enablement | File selection triggers reactive enablement |
| O6 | Tapping Preview while seed is entered calls `importService.dryRun()` and shows loading indicator | Preview trigger | User action → service call → loading feedback |
| O7 | After successful dry-run, ImportPreviewSheet appears with entry count and date range | Preview sheet display | User sees what will be imported before confirming |
| O8 | After dry-run with conflicts, ImportPreviewSheet shows ⚠️ warning and conflict dates | Conflict display | User must see exactly which dates conflict |
| O9 | After dry-run with 0 entries, shows "No entries to import" and hides import button | Empty preview | No-op: don't let user proceed with nothing |
| O10 | Tapping back arrow returns to previous screen without side effects | Safe navigation | User can cancel at any point before import |

### Group P: ImportPreviewSheet (~8 tests)
**File:** `test/features/import_preview_sheet_test.dart` (new)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| P1 | Sheet displays "N entries found" with correct count from preview data | Entry count display | User sees the total being imported |
| P2 | Sheet displays date range as "first → last" with formatted dates | Date range display | User sees the time span of imported entries |
| P3 | Sheet shows no conflicts section when `conflicts` is empty | Clean preview | Happy path: clean preview omits conflict UI |
| P4 | Sheet shows conflicts list with ⚠️ icon and each conflicting date when `hasConflicts` is true | Conflict display | User must acknowledge conflicts before proceeding |
| P5 | Sheet has [Import] button when no conflicts, [Import Anyway] when conflicts exist | Conditional button label | Visual distinction between clean and forced import |
| P6 | Tapping [Cancel] dismisses the sheet and returns to ImportScreen without modifying state | Cancel behavior | User can back out after seeing the preview |
| P7 | Tapping [Import] / [Import Anyway] calls `importService.import()` with the previewed seed/file | Import trigger | Preview confirm → actual import |
| P8 | Sheet is a `ModalBottomSheet` — tapping scrim dismisses without side effects | Sheet dismiss | Standard modal behavior: dismiss on outside tap |

### Group Q: ImportProgressSheet (~7 tests)
**File:** `test/features/import_progress_sheet_test.dart` (new)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| Q1 | During import (`ImportRunning`), sheet shows current phase text: "Decrypting source entries…" | Phase display | User sees what step is currently executing |
| Q2 | During import, sheet shows indeterminate `LinearProgressIndicator` | Progress indicator | Visual feedback for a potentially long operation |
| Q3 | On success (`ImportDone`), sheet shows "✅ N entries imported in M day blocks" | Success summary | Clear, countable confirmation |
| Q4 | On success, sheet shows "Back to Dashboard" button that navigates to `/` | Success navigation | User returns to main app |
| Q5 | On error (`ImportError`), sheet shows error icon + message text from the exception | Error display | User sees a clear, actionable error message |
| Q6 | On error, sheet shows "Try Again" button that resets to `ImportReady` state | Error recovery | User can fix the input and retry |
| Q7 | On error, sheet shows "Cancel" button that pops the route (returns to settings) | Error dismissal | User can give up completely |

### Group R: Route Registration (~3 tests)
**File:** `test/routing/import_route_test.dart` (new)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| R1 | Navigating to `/import` renders `ImportScreen` | Route wiring | The route exists and maps to the correct widget |
| R2 | `/import` route is only accessible in `AppPhase.ready` (redirects to unlock otherwise) | Auth gate | Must not expose import when ledger isn't unlocked |
| R3 | Navigating back from `/import` pops to the previous route (settings or wherever) | Navigation stack | Standard back behavior |

### Group S: Settings Integration (~4 tests)
**File:** `test/features/settings_screen_test.dart` (add to existing)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| S1 | Settings screen shows "Import entries from another ledger" tile in the Data/Storage section | Settings tile presence | User discovers the feature from settings |
| S2 | Tapping the import tile navigates to `/import` | Settings → import navigation | Tile → route linkage |
| S3 | Import tile has an appropriate icon (e.g., `Icons.call_merge` or `Icons.file_open`) | Visual affordance | Consistent with the action |
| S4 | Tile subtitle describes the feature: "Move entries from an old ledger" or similar | Feature description | User understands what the tile does before tapping |

---

## Summary

| Group | Area | Tests | Key Coverage |
|-------|------|-------|-------------|
| N | ImportNotifier state machine | 8 | Initial → Ready → Previewing → Preview → Running → Done/Error |
| O | ImportScreen widget | 10 | Seed field, file picker, preview button, state-driven UI, navigation |
| P | ImportPreviewSheet | 8 | Entry count, date range, conflicts, Import/ImportAnyway, Cancel, dismiss |
| Q | ImportProgressSheet | 7 | Phase label, progress bar, success summary, error recovery, navigation |
| R | Route registration | 3 | `/import` route, auth gate, back navigation |
| S | Settings integration | 4 | Tile presence, navigation, icon, subtitle |
| **Total** | | **40** | |

### External Dependencies
| Dependency | File | Used For |
|---|---|---|
| `ImportService` | `import_service.dart` ✅ | `dryRun()`, `import()`, `importFromFile()` |
| `ImportPreview` / `ImportResult` | `import_result.dart` ✅ | State data |
| `pumpScreenWidget` | `test/features/test_helpers.dart` ✅ | Widget test infrastructure |
| `file_picker` | package | File selection |
| `go_router` | `app_router.dart` | Route + navigation |
| `Riverpod` | `flutter_riverpod` | `AsyncNotifier` provider |

### Design Directives Checklist
- **D1 (Protocol Sovereignty):** Import is local-only; no server involvement ✅
- **D2 (Zero-Knowledge):** Source seed entered on-device; never leaves the app ✅
- **D5 (Append-Only):** No target chain editing in the UI — service handles append-only ✅
- **D10 (Testing):** 40 assertions across 6 groups covering provider, screens, route, and settings ✅
