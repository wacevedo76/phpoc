# Flutter File Import — Test Exploration (Phase 1)

> **Plan:** 4-Phase TDD for onboarding a ledger from a local JSON file
> **Purpose:** Blueprint of all needed test assertions before writing any test code.
> **Status:** ✅ Phase 1 (test exploration) · ✅ Phase 2 (RED: test definition) · ✅ Phase 3 (GREEN: implementation)
> **Next Phase:** Phase 4 (REFACTOR: code review)

## Architecture Overview

Two layers need changes:

1. **`OnboardingService`** — new `importFromFile()` method: read JSON file, detect format (v1/v2/chain), derive master key from seed, verify seals/hashes/chain, write blocks (via `LedgerBackupService`), staging entries, identity, set passphrase.

2. **`OnboardingScreen`** — new 5th card "Import Ledger from File", new `_OnboardingStep.importFile`, file picker via `file_picker`, seed + passphrase form, import button.

Existing Flutter assets (`LedgerBackupService.importFromJson()`, `PhpSpecFormat`, `file_picker` dep, `_confirmWipeExistingData()`) reduce the implementation surface.

## Test Groups

### Group L: OnboardingService — importFromFile (10 tests)

| ID | Assertion | Purpose | Rationale |
|---|---|---|---|
| L1 | `importFromFile` with v2 export → ledger blocks written to DB via `LedgerBackupService` | Core import path — v2 is the full export format | v2 is the canonical cross-client export; blocks must land in the DB so the ledger is usable after import |
| L2 | `importFromFile` with v2 → staging entries written to `entries` table | Staging must survive import | Users may have uncommitted entries in staging that were part of the export |
| L3 | `importFromFile` with v2 → identity extracted from genesis block | Auth must work post-import | `AuthService.reauthenticate()` reads `identity_secret_enc_fallback` from genesis `data_enc` |
| L4 | `importFromFile` with raw chain (`ledger.json`) → ledger blocks written | Support CLI's native format | Raw chain is the format of `testdata/ledger.json` and CLI-exported ledgers; must be accepted |
| L5 | `importFromFile` with v1 export → staging entries written, no ledger blocks | v1 is staging-only | v1 exports only staging; ledger blocks never existed. User needs entries available for review |
| L6 | `importFromFile` with malformed JSON → throws `FormatException` | Input validation before any DB writes | Bad files must fail fast; no partial writes, no corrupt state |
| L7 | `importFromFile` with wrong recovery seed → seal verification fails | Cryptographic gate | The seed is the user's proof of ownership; wrong seed = tamper detection or misremembered seed |
| L8 | `importFromFile` with tampered v2 file (seal mismatch) → throws validation error | Tamper detection | An attacker modifying the file between export and import must be detected; chain verification must fail |
| L9 | `importFromFile` when ledger already exists → throws `LedgerExistsException` | Data guard | Same as create/import seed flows — prevents accidental overwrite of an active ledger |
| L10 | `importFromFile` creates Flutter-format genesis block with PDK-encrypted seed | Auth compatibility | After import, `AuthService.reauthenticate()` must be able to extract the seed from `data_enc` using PDK (same pattern as `restoreFromCloud`) |

### Group M: OnboardingScreen — Import File UI (10 tests)

| ID | Assertion | Purpose | Rationale |
|---|---|---|---|
| M1 | Onboarding main screen shows "Import Ledger from File" card | Entry point discoverability | Users need a clear path to import an existing ledger from a file |
| M2 | Tapping "Import Ledger from File" navigates to file import form | Navigation works | Card tap must transition to the import sub-flow |
| M3 | File import form has a file picker button | File selection | User must be able to browse the device filesystem for `.json` exports |
| M4 | File import form has seed + passphrase input fields | Auth for decryption | Seed derives the master key needed for seal verification; passphrase protects the seed at rest |
| M5 | Selecting a file displays the filename on the form | Feedback on selection | User must see confirmation that a file was selected before proceeding |
| M6 | Import button is disabled until file + seed + passphrase are all provided | Prevent incomplete submissions | Must not call service with empty/missing inputs |
| M7 | Valid import → calls `onboardingService.importFromFile(filePath, seed, passphrase)` | Service wiring | The screen must delegate to the service, not duplicate import logic |
| M8 | Successful import → transitions to `/unlock` (auth phase) | Post-import flow | After import, user must unlock with their passphrase to start using the app |
| M9 | Import failure → error message displayed inline on the form | Error surfacing | User must see why the import failed (wrong seed, tampered file, etc.) without losing their form input |
| M10 | Back button from import form returns to main onboarding options | Navigation consistency | Same pattern as all other sub-flows (create, import seed, worker, restore) |

## Format Detection Surface

| Input | Format | Has ledger? | Has staging? | Seal location |
|---|---|---|---|---|
| `[{type: "genesis", ...}, ...]` | raw chain | Yes | No | Per-block `{type}_hash` field |
| `{format_version: "1", entries, seal}` | v1 export | No | Yes | Top-level `seal` over `entries` |
| `{format_version: "2", ledger, staging, seal}` | v2 export | Yes | Yes | Top-level `seal` over `{ledger, staging}` |

## Key Dependencies (already in Flutter)

| Utility | File | Coverage |
|---|---|---|
| `LedgerBackupService.importFromJson()` | `lib/services/ledger_backup_service.dart` | Parses PHPSPEC + legacy formats, writes blocks to DB in a transaction |
| `PhpSpecFormat` | `lib/core/utils/phpsec_format.dart` | Field name constants, seal field mapping, entry extraction |
| `CryptoService.seal()` / `deriveMasterKey()` | `lib/core/crypto/crypto_service.dart` | HMAC-SHA256 seal verification, seed→MK derivation |
| `file_picker` | pubspec.yaml | Already imported in onboarding and settings screens |
| `_confirmWipeExistingData()` | `onboarding_screen.dart` | Existing data guard dialog (reused by all onboarding paths) |
| `testdata/ledger.json` | project root | 31 blocks, 146 entries — ready-made test fixture for raw chain format |

## Summary

- **Total assertions:** 20 (L1–L10 service + M1–M10 UI)
- **Service layer:** 10 tests covering v1/v2/chain formats, validation errors, seal verification, tamper detection, data guard, auth compatibility
- **UI layer:** 10 tests covering card navigation, form elements, file picker integration, input validation, success/failure flows
- **Existing reusable code:** `LedgerBackupService.importFromJson()` handles block parsing + DB write; format detection and seal verification are the main new code
