# B-02: Flutter — Import Entries from Another Ledger — Test Exploration (Phase 1)

> **Plan:** `docs/planning/B02_CROSS_LEDGER_MIGRATION_PHASE1.md` (cross-client blueprint, 116 assertions)
> **Reference:** Groups L (Core Import, 10) + M (UI & Service, 6) from cross-client blueprint
> **Purpose:** Flutter-specific testing blueprint — expanded from the cross-client template with concrete Dart component, provider, and screen assertions.
> **Status:** 🔜 Phase 1 (test exploration)
> **Next Phase:** Phase 2 (RED: test definition)

## Architecture Overview

### User Flow

```
User is already in the app (Ledger A loaded, authenticated)
         │
         │  Settings → "Import entries from another ledger"
         │
         ▼
  ┌─────────────────────────────┐
  │  Import Screen              │
  │  • Seed text field          │
  │  • OR "Pick ledger.json"    │
  │    file button              │
  │  • [Preview] button         │
  └─────────────┬───────────────┘
                │  [Preview]
                ▼
  ┌─────────────────────────────┐
  │  Dry-Run Preview            │
  │  • N entries found          │
  │  • Date range: from → to    │
  │  • Conflicts: none / X dates│
  │  • [Cancel] [Import]        │
  └─────────────┬───────────────┘
                │  [Import]
                ▼
  ┌─────────────────────────────┐
  │  Progress                   │
  │  • Decrypting...            │
  │  • Re-encrypting...         │
  │  • Building blocks...       │
  │  • Verifying...             │
  └─────────────┬───────────────┘
                │  Done
                ▼
  ┌─────────────────────────────┐
  │  Success                    │
  │  • X entries imported       │
  │  • Y new day blocks         │
  │  • [Back to Dashboard]      │
  └─────────────────────────────┘
```

### Component Map

```
┌──────────────────────────────────────────────────────────────┐
│  UI Layer (lib/features/import/)                             │
│  ┌────────────────────┐  ┌─────────────────────────────┐     │
│  │ ImportScreen       │  │ ImportPreviewSheet          │     │
│  │ · seed controller  │  │ · entry count, date range   │     │
│  │ · file picker btn  │  │ · conflict list (if any)    │     │
│  │ · [Preview] btn    │  │ · [Cancel] [Import] btns    │     │
│  └────────┬───────────┘  └──────────────┬──────────────┘     │
│           │                             │                    │
│  ┌────────┴─────────────────────────────┴──────────────┐     │
│  │ ImportProgressSheet                                  │     │
│  │ · phase indicator (decrypt/re-encrypt/build/verify)  │     │
│  │ · error state with actionable message               │     │
│  └────────────────────────┬────────────────────────────┘     │
├───────────────────────────┼──────────────────────────────────┤
│  Providers (Riverpod)     │                                  │
│  ┌────────────────────────┴────────────────────────────┐     │
│  │ importServiceProvider   (AsyncNotifier)              │     │
│  │ · dryRun(sourceSeed, sourceFile?) → ImportPreview    │     │
│  │ · import(sourceSeed, sourceFile?) → ImportResult     │     │
│  │ · state: idle | previewing | importing | done | err  │     │
│  └────────────────────────┬────────────────────────────┘     │
├───────────────────────────┼──────────────────────────────────┤
│  Service Layer            │                                  │
│  ┌────────────────────────┴────────────────────────────┐     │
│  │ ImportService                                        │     │
│  │ · dryRun(sourceSeed, sourceChain) → ImportPreview    │     │
│  │ · import(sourceSeed, sourceChain) → ImportResult     │     │
│  │ · _extractEntries(chain, sourceCrypto)               │     │
│  │ · _reencryptEntries(entries, targetCrypto)           │     │
│  │ · _detectConflicts(entries, targetChain)             │     │
│  │ · _rebuildChain(targetChain, reencrypted, crypto)    │     │
│  └────────────────────────┬────────────────────────────┘     │
├───────────────────────────┼──────────────────────────────────┤
│  Data / Core Layer        │                                  │
│  ┌────────────┐  ┌────────┴───────────┐  ┌──────────────┐   │
│  │ AppDatabase│  │ CryptoService       │  │ LedgerChain   │   │
│  │ (blocks,   │  │ · deriveMk(seed, v) │  │ · verify()    │   │
│  │  index)    │  │ · encrypt/decrypt   │  │ · buildBlock()│   │
│  └────────────┘  │ · seal/verifySeal   │  └──────────────┘   │
│                  └────────────────────┘                      │
└──────────────────────────────────────────────────────────────┘
```

### Files in Scope

| File | Role | Change |
|------|------|--------|
| `lib/services/import_service.dart` | `ImportService`: orchestration — dry run + import pipeline | **New** |
| `lib/core/models/import_result.dart` | `ImportPreview` + `ImportResult` data classes | **New** |
| `lib/features/import/import_screen.dart` | Import screen UI: seed field, file picker, preview button | **New** |
| `lib/features/import/import_preview_sheet.dart` | Modal bottom sheet: dry-run results, confirm/cancel | **New** |
| `lib/features/import/import_progress_sheet.dart` | Modal bottom sheet: phase progress, success, error | **New** |
| `lib/features/import/import_providers.dart` | Riverpod providers: `importServiceProvider` | **New** |
| `lib/features/settings/settings_screen.dart` | Add "Import entries from another ledger" tile | Minor |
| `lib/routing/app_router.dart` | Add import route | Minor |

### Dependencies (Already Exist)

| Dependency | File | Used For |
|---|---|---|
| `CryptoService` | `lib/core/crypto/crypto_service.dart` | Dual `CryptoManager` from two seeds; decrypt/re-encrypt |
| `LedgerChain` | `lib/data/ledger/chain.dart` | Chain verification, block building, summary policy |
| `LedgerEngine` | `lib/data/ledger/engine.dart` | Commit entries, rebuild index |
| `AppDatabase` | `lib/data/storage/database.dart` | Read target chain, write migrated blocks |
| `LedgerBackupService` | `lib/services/ledger_backup_service.dart` | Parse `ledger.json` file for source chain |
| `SeedDerivation` | `lib/core/crypto/crypto_service.dart` | `deriveMk(seed, version)` for source MK |

---

## Test Groups

### Group A: ImportService — dryRun (Dart, ~8 tests)
**File:** `test/services/import_service_test.dart` (new)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | `dryRun(sourceSeed)` with valid seed returns `ImportPreview` with correct entry count | Basic dry run | User needs to see what will be imported before committing |
| A2 | `dryRun(sourceSeed)` includes source date range (first date, last date) in preview | Date range preview | User needs to see the time span of the imported entries |
| A3 | `dryRun(sourceSeed)` returns `conflicts: []` when no date overlap exists | Clean preview | Happy path: non-overlapping ledgers show zero conflicts |
| A4 | `dryRun(sourceSeed)` returns `conflicts: [date1, date2, ...]` when dates overlap | Conflict detection | User must see exactly which dates conflict |
| A5 | `dryRun()` with source chain that has NO day blocks returns `entryCount: 0` | Empty source | Graceful: genesis-only source shows zero entries to import |
| A6 | `dryRun(sourceSeed)` with wrong seed (can't decrypt genesis identity) throws `ImportException` with clear message | Wrong seed detection | Must fail early and clearly — not a cryptic crypto error |
| A7 | `dryRun(sourceSeed)` with same seed as target (self-import) throws `ImportException` | Self-import guard | Same seed = same ledger — nothing to import, prevent user confusion |
| A8 | `dryRun(sourceSeed)` verifies source chain before extracting entries | Pre-flight integrity | D4: never import from a corrupted chain |

### Group B: ImportService — import Pipeline (Dart, ~10 tests)
**File:** `test/services/import_service_test.dart`

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | `import(sourceSeed)` decrypts all entries from source chain with source MK | Extraction | Core step 1: source entries must be fully decrypted |
| B2 | `import(sourceSeed)` re-encrypts all decrypted entries with target MK | Re-encryption | Core step 2: entries now protected by target's key domain |
| B3 | `import(sourceSeed)` preserves `content_hash` on every re-encrypted entry | Content hash invariance | The bridge: content_hash proves plaintext didn't change |
| B4 | `import(sourceSeed)` recomputes entry hash for every re-encrypted entry | Entry hash update | Ciphertext changed → entry hash must change |
| B5 | `import(sourceSeed)` appends new day blocks to the target chain | Chain extension | Core step 3: migrated entries become new day blocks |
| B6 | `import(sourceSeed)` does NOT modify existing target blocks | Immutability | D5: append-only — existing blocks untouched |
| B7 | `import(sourceSeed)` inserts summary blocks when date boundaries are crossed | Summary insertion | Same policy as normal sync — year/month summary blocks |
| B8 | `import(sourceSeed)` builds valid `prev_hash` linkage through the migration boundary | Hash linkage | Chain integrity: last target day_hash → new first prev_hash |
| B9 | `import(sourceSeed)` rebuilds blind index to include migrated entries | Index update | `index_entries` table reflects new durations |
| B10 | `import(sourceSeed)` returns `ImportResult` with counts: `migratedCount`, `newBlockCount`, `sourceEntryCount` | Result reporting | Clear metrics for the success screen |

### Group C: ImportService — Crypto Dual-Instance (Dart, ~8 tests)
**File:** `test/services/import_service_test.dart`

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | Target `CryptoService` (already in session) and source `CryptoService` (from seed) are independent | Dual crypto isolation | Must not share mutable state or keys |
| C2 | Source `CryptoService` derives correct MK from seed via `deriveMk(seed, keyVersion)` | Source key derivation | Must use the source's key_version from its genesis |
| C3 | Source `CryptoService` handles `key_version > 1` (rotated source ledger) | Multi-version source | Source may have been through rotation; MK derivation must match |
| C4 | Data encrypted with source MK cannot be decrypted by target MK | Cross-key rejection | Confirms cryptographic domain separation |
| C5 | Source `CryptoService` decrypts entries including all `_enc` fields: startTime, endTime, metadata, pauses, transitions, device_id | Full field decryption | Every encrypted field must be readable with source MK |
| C6 | Target `CryptoService` re-encrypts all `_enc` fields with fresh nonces per encryption | Per-field nonces | Each field gets a unique salt+nonce — no ciphertext reuse |
| C7 | `device_proof` field is NOT re-encrypted (it's an HMAC, not ciphertext) and is preserved as-is | Device proof preservation | device_proof is plaintext hex HMAC; must survive untouched |
| C8 | Source `CryptoService` is cleared from memory after import completes | Key hygiene | Don't leave source MK in memory after import |

### Group D: ImportService — Conflict Detection & Edge Cases (Dart, ~8 tests)
**File:** `test/services/import_service_test.dart`

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | Import rejected when source entries overlap with target date range (no `--force`) | Overlap rejection | PHPSPEC constraint: non-overlapping ledgers only |
| D2 | Import proceeds with `force: true` even when dates overlap | Force override | Advanced users may knowingly accept overlap |
| D3 | `force: true` still reports conflicting dates in `ImportResult.conflicts` | Force transparency | User must see what was forced, even after the fact |
| D4 | Import with source chain at `format_version` 0.2.0 (legacy, no auth tag ciphertexts) succeeds | Legacy format support | D9: backward compatibility with pre-spec ledgers |
| D5 | Import with source chain at `format_version` 0.3.0 (legacy 9-field content hash) succeeds | Legacy content hash | v0.3.0 content hashes must be verified with legacy algorithm |
| D6 | Entry with unparseable ciphertext in source is skipped with warning, not fatal | Partial corruption tolerance | One bad entry shouldn't block the entire import |
| D7 | Import with source chain having 0 entries (genesis only) returns `migratedCount: 0` and succeeds | Empty source | Graceful no-op |
| D8 | Duplicate entries (same `content_hash` already in target) are skipped, not duplicated | Deduplication | If user re-imports, don't create duplicates |

### Group E: ImportService — File-Based Import (Dart, ~6 tests)
**File:** `test/services/import_service_test.dart`

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | `importFromFile(fileBytes, sourceSeed)` parses `ledger.json` file and extracts entries | File import | Alternative to seed-only: user has the source ledger file |
| E2 | `importFromFile(fileBytes, sourceSeed)` handles PHPSPEC format (type, day_index, entries) | PHPSPEC format | File may be in canonical PHPSPEC format |
| E3 | `importFromFile(fileBytes, sourceSeed)` handles legacy format (block_type, block_index, data_enc) | Legacy format | File may be in pre-PHPSPEC internal format |
| E4 | `importFromFile(malformedJson)` throws `ImportException` with "invalid JSON" message | Malformed file | Bad file input must fail clearly |
| E5 | `importFromFile(emptyArray)` throws `ImportException` with "empty ledger" message | Empty file | `[]` is technically valid JSON but not a usable ledger |
| E6 | `importFromFile()` with file seed different from provided seed (genesis seal mismatch) throws `ImportException` | Seed-file mismatch | Seed must decrypt the file's genesis; mismatch = wrong seed |

### Group F: ImportResult Model (Dart, ~5 tests)
**File:** `test/core/models/import_result_test.dart` (new)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| F1 | `ImportResult` holds `sourceEntryCount`, `migratedCount`, `skippedCount`, `newBlockCount` | Count fields | Service must return complete metrics |
| F2 | `ImportResult` holds `sourceDateRange` with `first` and `last` ISO date strings | Date range field | Preview and success screen need date range |
| F3 | `ImportResult` holds `conflicts` list of date strings | Conflicts field | `force: true` still reports what was overridden |
| F4 | `ImportResult` has `isSuccess` getter that is true when `migratedCount > 0` | Success indicator | UI uses this to decide success vs. no-op display |
| F5 | `ImportResult` has `hasConflicts` getter that is true when `conflicts.isNotEmpty` | Conflict indicator | UI uses this to show conflict warning |

### Group G: ImportPreview Model (Dart, ~4 tests)
**File:** `test/core/models/import_result_test.dart`

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| G1 | `ImportPreview` holds `entryCount`, `dateRange`, `conflicts` from dry run | Preview fields | Dry-run must return all preview data |
| G2 | `ImportPreview.hasConflicts` is true when `conflicts.isNotEmpty` | Conflict flag | UI uses this to show warning vs. clean preview |
| G3 | `ImportPreview.isEmpty` is true when `entryCount == 0` | Empty flag | UI uses this to show "nothing to import" message |
| G4 | `ImportPreview` is immutable (all fields final, no setters) | Immutability | Riverpod state objects should be immutable value types |

### Group H: ImportScreen UI (Dart, ~10 tests)
**File:** `test/features/import_screen_test.dart` (new)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| H1 | Import screen shows seed text field with placeholder text | Seed input | User must be able to paste/type the recovery seed |
| H2 | Import screen shows "Pick ledger.json file" button that opens file picker | File picker | Alternative to seed-only: user can select the source file |
| H3 | Import screen shows [Preview] button disabled when both seed and file are empty | Disabled state | Prevent empty submissions |
| H4 | Import screen enables [Preview] button when seed is entered (even without file) | Seed-only enable | Seed alone is sufficient — entries extracted from seed-derived chain |
| H5 | Import screen enables [Preview] button when file is picked (even without seed) | File-only enable | File can be parsed first; seed asked later if needed |
| H6 | Tapping [Preview] triggers `importServiceProvider.dryRun()` and shows loading indicator | Preview trigger | User feedback while dry-run is in progress |
| H7 | Preview result (clean, no conflicts) shows entry count, date range, and [Import] button | Clean preview UI | User sees what will be imported and can confirm |
| H8 | Preview result with conflicts shows warning icon, conflict date list, and [Import Anyway] button | Conflict preview UI | User must acknowledge conflicts before proceeding |
| H9 | Preview result with 0 entries shows "No entries to import" message and no [Import] button | Empty preview UI | No-op — don't let user proceed with nothing |
| H10 | Back navigation returns to settings/dashboard without side effects | Navigation | User can cancel at any point before [Import] |

### Group I: ImportProgressSheet & Result UI (Dart, ~8 tests)
**File:** `test/features/import_screen_test.dart`

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| I1 | After [Import] is tapped, import screen shows progress with current phase text | Progress display | User sees: "Decrypting source entries..." → "Re-encrypting..." → "Building blocks..." → "Verifying..." |
| I2 | Progress sheet shows indeterminate progress bar during import | Progress indicator | Long operation needs visual feedback |
| I3 | On success, progress sheet transitions to success summary with entry count and block count | Success display | Clear confirmation: "42 entries imported in 5 new day blocks" |
| I4 | Success summary includes "Back to Dashboard" button that navigates to dashboard | Success navigation | User returns to main app |
| I5 | On error, progress sheet transitions to error state with actionable message | Error display | "Wrong seed — could not decrypt source ledger" |
| I6 | Error state includes "Try Again" button that returns to the import screen | Error recovery | User can fix the seed or pick a different file |
| I7 | Error state includes "Cancel" button that returns to settings | Error dismissal | User can give up and go back |
| I8 | Import cannot be triggered twice (button disabled while import is in progress) | Double-submit guard | Prevent concurrent import calls |

### Group J: ImportProvider (Riverpod, ~6 tests)
**File:** `test/features/import_providers_test.dart` (new)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| J1 | `importServiceProvider` exposes `dryRun(seed, file?)` returning `AsyncValue<ImportPreview>` | Provider API | Screen reads preview state from provider |
| J2 | `importServiceProvider` exposes `import(seed, file?, force)` returning `AsyncValue<ImportResult>` | Provider API | Screen triggers import and reads result from provider |
| J3 | Provider state transitions: `idle` → `loading` (dry-run) → `data:preview` → `loading` (import) → `data:result` | State machine | UI rebuilds on each state change |
| J4 | Provider state on error: `AsyncValue.error(ImportException)` with message | Error state | UI shows error from provider's error state |
| J5 | Provider requires `CryptoService` (hasMasterKey=true) — throws `StateError` if no MK cached | Auth gate | Cannot import without target ledger unlocked |
| J6 | Provider disposes source `CryptoService` on `ref.onDispose` | Resource cleanup | Source MK must be cleared when provider is disposed |

### Group K: Integration — Full Pipeline (Dart, ~6 tests)
**File:** `test/services/import_service_test.dart` (integration section)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| K1 | Full pipeline: create two in-memory ledgers → import entries from source into target → target chain verifies | End-to-end happy path | Two seeds, non-overlapping dates, successful import |
| K2 | Full pipeline: target chain length = original + new day blocks (genesis counted once) | Chain growth metric | Verification that no blocks were lost or duplicated |
| K3 | Full pipeline: migrated entries' `content_hash` values match between source and target | Content hash E2E | End-to-end content hash bridge verification |
| K4 | Full pipeline: blind index after import aggregates durations from both original and migrated entries | Index E2E | `index_entries` table has correct totals |
| K5 | Full pipeline: revert to backup (restore pre-import chain) works and chain verifies | Rollback | User can undo import by restoring the backup |
| K6 | Full pipeline: import 50+ entries from source → target verifies successfully | Scale baseline | Realistic entry count must complete without issues |

---

## Summary

| Group | Area | Tests | Key Coverage |
|-------|------|-------|-------------|
| A | Service — dryRun | 8 | Preview: entry count, date range, conflicts, wrong seed, self-import, empty source |
| B | Service — import pipeline | 10 | Decrypt→re-encrypt→rebuild: content_hash, entry hash, chain append, summary blocks, index |
| C | Service — crypto dual-instance | 8 | Source/target CryptoService isolation, multi-version, field re-encryption, key hygiene |
| D | Service — conflicts & edges | 8 | Overlap rejection, force override, legacy formats, corruption tolerance, dedup |
| E | Service — file-based import | 6 | File parsing (PHPSPEC + legacy), malformed files, seed-file mismatch |
| F | ImportResult model | 5 | Count fields, date range, conflicts, isSuccess, hasConflicts |
| G | ImportPreview model | 4 | Preview fields, hasConflicts, isEmpty, immutability |
| H | ImportScreen UI | 10 | Seed input, file picker, disabled/enabled states, preview trigger, conflict display, navigation |
| I | Progress & Result UI | 8 | Phase progress, indeterminate bar, success/error display, navigation, double-submit guard |
| J | ImportProvider (Riverpod) | 6 | dryRun/import API, state machine, error state, auth gate, resource cleanup |
| K | Integration — full pipeline | 6 | E2E with two ledgers, chain growth, content hash E2E, index, rollback, scale |
| **Total** | | **79** | |

### Critical Dependencies (Flutter)
- **CryptoService** ✅ — `deriveMk(seed, version)`, `encrypt()`, `decrypt()`, `seal()`, `verifySeal()`
- **LedgerChain** ✅ — `verify()`, `buildDayBlock()`, summary policy
- **LedgerEngine** ✅ — `commit()`, index rebuild
- **AppDatabase** ✅ — `blockDao`, `indexDao`, `transaction()`
- **LedgerBackupService** ✅ — `importFromJson()` for file parsing

### Design Directives Checklist
- **D1 (Protocol Sovereignty):** Import is local-only; no server involvement ✅
- **D2 (Zero-Knowledge):** Both seeds stay in memory only; source MK cleared after import ✅ (C8, J6)
- **D4 (Chain of Trust):** Pre- and post-import chain verification; all seals + signatures valid ✅ (A8, B8, K1)
- **D5 (Append-Only):** Target chain appended to, never modified ✅ (B6)
- **D8 (Recoverability):** Rollback via backup restoration ✅ (K5)
- **D9 (Backward Compat):** Legacy format_version, legacy content_hash algorithm, legacy ciphertext ✅ (D4, D5, E3)
- **D10 (Testing):** 79 assertions across 11 groups covering service, model, UI, providers, and integration ✅
