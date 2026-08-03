# B-02: Web — Cross-Ledger Entry Migration — Test Exploration (Phase 1)

> **Plan:** `docs/planning/B02_CROSS_LEDGER_MIGRATION_PHASE1.md` (cross-client blueprint, Groups J & K)
> **Reference:** Flutter implementation — `import_service.dart`, `import_result.dart`, UI layer (40 tests)
> **Purpose:** Blueprint for the web-specific test assertions before writing any code.
> **Status:** 🔜 Phase 1 (test exploration)
> **Next Phase:** Phase 2 (RED: test definition)

## Architecture Overview

### What's Done vs What's Needed

| Layer | File | Status |
|-------|------|--------|
| Crypto WASM | `src/crypto/` | ✅ Done — WASM bridge, dual-instance capable |
| Ledger chain | `src/ledger/chain.js` | ✅ Done — `buildDayBlock`, `append`, `verify` |
| Ledger merge | `src/ledger/merge.js` | ✅ Done — chain verification, merge engine |
| Entry hash | `src/ledger/utils.js` | ✅ Done — `computeEntryHash`, `getBlockHash`, `jsonSort` |
| Storage | `src/sync/storage.js` | ✅ Done — IndexedDB via StorageBackend |
| File import (onboarding) | `src/services/ledger_import.js` | ✅ Done — file validation, seal + hash checks |
| Remote import | `src/sync/remote_import.js` | ✅ Done — cloud backup fetch |
| **ImportService** | `src/services/import_service.js` | 🔧 **New** — cross-ledger merge pipeline |
| **EntryImporter** | `src/ledger/import_entries.js` | 🔧 **New** — core: decrypt → re-encrypt → build |
| **ImportScreen** | `src/components/screens/ImportScreen.jsx` | 🔧 **New** — UI with seed input, file picker, preview |
| **Route** | `src/App.jsx` | 🔧 Add `/import` route |
| **Settings tile** | `src/components/screens/Settings.jsx` | 🔧 Add import entry in Data section |
| **Tests** | `test/import_entries_test.mjs` | 🔧 **New** — Group J + K tests |

### Component Tree

```
ImportScreen (React component)
├── Seed TextField (password type, 44-char base64)
├── [Pick ledger.json file] button (file input)
├── [Preview] button (disabled until seed/file provided)
│
├── Preview panel (shown after dryRun)
│   ├── "N entries found" summary
│   ├── Date range display
│   ├── Conflicts list with ⚠️ (if any)
│   ├── [Cancel] button
│   └── [Import] / [Import Anyway] button
│
└── Progress panel (shown during/after import)
    ├── Phase label: "Decrypting source entries…"
    ├── Progress indicator (indeterminate)
    ├── Success state: "✅ N entries imported in M day blocks" + [Back to Dashboard]
    └── Error state: message + [Try Again] / [Cancel]
```

### State Machine

```
ImportInitial → seed/file provided → ImportReady → [Preview] → ImportPreviewing
  → ImportPreviewLoaded → [Import] → ImportRunning → ImportDone / ImportFailed
```

### Cross-Platform Parity

The web `ImportService` implements the same pipeline as Flutter's `ImportService`:
1. Validate seed (base64 format check) + self-import guard (same seed → reject)
2. Derive source MK from seed (dual `CryptoManager` — target from session, source from seed)
3. Verify source chain integrity
4. Extract entries from source day blocks, decrypt all `_enc` fields
5. Compute `content_hash` on decrypted plaintext for deduplication
6. Detect date conflicts against target ledger's day blocks
7. Skip duplicates (content_hash already in target)
8. Re-encrypt entries with target MK
9. Build new day blocks and append to target chain
10. Return `ImportResult` with counts

Key differences from Flutter:
- WASM crypto via `phpoc-crypto-core` (not Dart `CryptoService`)
- IndexedDB storage via `StorageBackend` (not SQLite)
- React state (not Riverpod)
- `node --test` test runner (not `flutter test`)

### Files in Scope

| File | Role | Change |
|------|------|--------|
| `src/ledger/import_entries.js` | `EntryImporter`: extract, decrypt, reencrypt, build | **New** |
| `src/services/import_service.js` | `ImportService`: orchestrator, dryRun, import, importFromFile | **New** |
| `src/components/screens/ImportScreen.jsx` | React component: seed input, file picker, preview, progress | **New** |
| `src/App.jsx` | Add `/import` route | Minor |
| `src/components/screens/Settings.jsx` | Add import tile | Minor |
| `test/import_entries_test.mjs` | Group J + K tests | **New** |

### Test Helpers Available

- `tests/helpers/web-test-helpers.mjs` — `createMockCrypto()`, `createMockStore()`, `createTestChain()`
- `tests/helpers/test-vectors.mjs` — canonical test vectors (seed, blocks, entries)
- `node --test` — Node.js native test runner
- WASM crypto mocked in unit tests; real WASM used in integration tests

---

## Test Groups

### Group J: Core Import — EntryImporter (~10 tests)
**File:** `test/import_entries_test.mjs` (new)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| J1 | `EntryImporter.extractEntries(chain, sourceCrypto)` produces correct entry count from day blocks | Full extraction | Only day blocks carry entries; genesis + summaries skipped |
| J2 | `EntryImporter.extractEntries()` decrypts `startTime_enc`, `endTime_enc`, `metadata_enc`, `pauses_enc` fields | Field decryption | All encrypted fields must produce correct plaintext |
| J3 | `EntryImporter.reencryptEntry(entry, targetCrypto)` produces entry decryptable with target MK | Re-encryption roundtrip | Re-encrypted ciphertext must be readable by target |
| J4 | `EntryImporter.reencryptEntry()` preserves `content_hash` (matches before/after) | Content hash invariance | content_hash is computed from plaintext; must survive re-encryption |
| J5 | `EntryImporter.detectConflicts(sourceEntries, targetChain)` detects overlapping dates | Conflict detection | Day-level overlap must be flagged before import |
| J6 | `EntryImporter.detectConflicts()` returns empty array when no overlap | Clean import path | Happy path: no conflicts = safe to import |
| J7 | `EntryImporter.buildAndAppendEntries(migratedEntries, targetChain, targetCrypto)` produces valid chain | Chain rebuild | Appended chain must pass `LedgerChain.verify()` |
| J8 | `EntryImporter` handles `key_version > 1` on source ledger correctly | Multi-version support | Source may be at different key_version; correct MK must be derived |
| J9 | `EntryImporter.extractEntries()` skips entries with unparseable ciphertext (not fatal) | Corruption tolerance | One bad entry shouldn't block the entire migration |
| J10 | `EntryImporter` produces same entry hash as Python/Flutter for same plaintext + same MK | Cross-platform hash parity | Entry hash formula must be identical across clients |

### Group K: ImportService — Orchestrator (~8 tests)
**File:** `test/import_entries_test.mjs`

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| K1 | `ImportService.dryRun(sourceSeed, sourceChain)` returns `ImportPreview` with entry count and date range | Dry run output | User must see what will be imported before confirming |
| K2 | `ImportService.dryRun()` throws `ImportException` when source seed matches target seed | Self-import guard | Same seed = same ledger = nothing to import |
| K3 | `ImportService.dryRun()` with empty source chain returns 0 entries | Empty source | Graceful no-op for genesis-only source |
| K4 | `ImportService.import(sourceSeed, sourceChain)` returns `ImportResult` with correct counts | Full pipeline | migratedCount + skippedCount + newBlockCount must be accurate |
| K5 | `ImportService.import()` deduplicates entries with same `content_hash` as target | Deduplication | Entries already in target are skipped (counted in skippedCount) |
| K6 | `ImportService.import()` rejects on date conflict unless `force: true` | Conflict gate | Non-force import must throw on overlap |
| K7 | `ImportService.importFromFile(fileBuffer, sourceSeed)` parses and imports from ledger.json | File import | End-to-end file path works |
| K8 | `ImportService.import()` target chain is append-only — original blocks unchanged | Append-only guarantee | Existing blocks must retain their original seals + hashes |

### Group L: ImportScreen — React Component (~8 tests)
**File:** `test/import_entries_test.mjs` or Vitest component test

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| L1 | Screen shows seed text field with "Recovery Seed" label | Seed input UI | User must recognize where to paste the source seed |
| L2 | Screen shows file picker button for ledger.json | File picker UI | Alternative input method for users with the source file |
| L3 | Preview button is disabled when both seed and file are empty | Disabled state | Prevent empty submissions |
| L4 | Entering text in seed field enables the Preview button | Seed enablement | Reactive UI: button state follows input state |
| L5 | Tapping Preview calls `importService.dryRun()` and shows loading indicator | Preview trigger | User action → service call → loading feedback |
| L6 | After successful dry-run, preview panel shows entry count and date range | Preview display | User sees what will be imported before confirming |
| L7 | After dry-run with conflicts, preview shows ⚠️ warning and "Import Anyway" button | Conflict display | User must acknowledge conflicts before forced import |
| L8 | After import success, shows "✅ N entries imported in M day blocks" and Back to Dashboard button | Success UX | Clear confirmation and navigation |

### Group M: Route + Settings Integration (~4 tests)
**File:** `test/import_entries_test.mjs` or Vitest component test

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| M1 | Navigating to `/import` renders ImportScreen | Route wiring | The route exists and maps to the correct component |
| M2 | Settings screen shows "Import entries from another ledger" option | Settings tile presence | User discovers the feature from settings |
| M3 | Tapping import in settings navigates to `/import` | Settings → import navigation | Tile → route linkage |
| M4 | Import tile has descriptive text: "Move entries from an old ledger" | Feature description | User understands the feature before tapping |

---

## Summary

| Group | Area | Tests | Key Coverage |
|-------|------|-------|-------------|
| J | EntryImporter core | 10 | Extract, decrypt, reencrypt, conflict detection, chain rebuild, hash parity |
| K | ImportService orchestrator | 8 | Dry run, self-import guard, dedup, conflict gate, file import, append-only |
| L | ImportScreen component | 8 | Seed field, file picker, preview, conflicts, success/error states |
| M | Route + settings | 4 | `/import` route, settings tile, navigation |
| **Total** | | **30** | |

### External Dependencies
| Dependency | Location | Used For |
|---|---|---|
| `LedgerChain` | `src/ledger/chain.js` ✅ | `buildDayBlock()`, `append()`, `verify()` |
| `computeEntryHash` / `getBlockHash` | `src/ledger/utils.js` ✅ | Entry + block hash computation |
| CryptoService (WASM) | `src/crypto/` ✅ | Dual-instance: target (session) + source (seed-derived) |
| StorageBackend | `src/sync/storage.js` ✅ | Read/write chain blocks |
| `ledger_import.js` | `src/services/` ✅ | File validation reused for `importFromFile` path |
| `react-router-dom` | package | Route + navigation |

### Design Directives Checklist
- **D1 (Protocol Sovereignty):** Import is local-only; no server involvement ✅
- **D2 (Zero-Knowledge):** Source seed entered on-device; never leaves the browser ✅
- **D4 (Chain of Trust):** Pre- and post-migration chain verification ✅
- **D5 (Append-Only):** Target chain appended to, never modified ✅
- **D10 (Testing):** 30 assertions across 4 groups covering core, service, UI, and routes ✅
