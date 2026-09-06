# Commonplace Book — Web Port Roadmap

> **ADR:** ADR-031 (Commonplace Book — separate sealed chain, shared master key)
> **Spec:** `docs/planning/WEB_FLUTTER_PARITY_SPEC.md` §P1
> **Reference (Flutter):** `flutter/COMMONPLACE_BOOK_PHASE1.md` (chain engine, 55), `flutter/COMMONPLACE_BOOK_SWITCHER_PHASE1.md` (13), `flutter/COMMONPLACE_BOOK_UI_PHASE1.md` (40), `flutter/COMMONPLACE_BOOK_SETTINGS_PHASE1.md` (46)
> **Status:** ✅ Slice 1 (chain/engine/storage) 4-phase TDD complete — `CommonplaceChain`/`CommonplaceEngine`/`CommonplaceStorage` implemented + `seal_fields.js` `commonplace_genesis`/`commonplace` whitelist; 55 tests / 130 assertions GREEN. Phase 4 deduped shared version/content-hash/zero-hash helpers into `ledger/utils.js`. ✅ **Slice 2 (Book Switcher) 4-phase TDD complete (2026-08-31):** `book.js` (`Book` identity + `getBookMode`/`setBookMode` localStorage persistence) + `BookSwitcher.jsx` rendered above page content in `AppLayout`; 13 tests GREEN. ✅ **Slice 3 (UI wiring) 4-phase TDD complete (2026-08-31):** `commonplace_service.js` + `book_mode.jsx` + `CommonplaceScreen`/`AddEntrySheet`/`TopicIndex` + `BookBody` + `DevModeContext.services.commonplaceService` wiring + `.commonplace-*` styles; 40 tests GREEN. Phase 4 (REFACTOR) extracted the shared `usePersistedBookState` hook (book_mode) and the `normalizeTags` pure helper (service). ✅ **Slice 4 (Settings surface) 4-phase TDD complete (2026-08-31):** blueprint `COMMONPLACE_BOOK_SETTINGS_WEB_PHASE1.md` (34 assertions, groups S/W/P/V/R/B/C/X). Phase 2 (RED): 34 tests / 31 RED + 3 regression-green. Phase 3 (GREEN): all GREEN — `CommonplaceSettingsScreen` + `BookBody` `settings` redirect (over-swap fix) + `CommonplaceService.exportForBackup`/`restoreFromBackup` + `RekeyService` re-encrypts `commonplace:blocks` in lockstep + backup/restore/clear-all. Phase 4 (REFACTOR): extracted shared `useRekeyFlow` hook + `RekeyModal` component (deduped the re-key modal/state across ledger `Settings.jsx` + `CommonplaceSettingsScreen.jsx`) and unified `_rebuildChain` in `rekey_service.js` (deduped `_rebuildBlocks`/`_rebuildCommonplaceBlocks`); all suites re-verified GREEN. Web deltas: Group T (per-book theme) and Group SP (shared security) deferred — no web theme system / no change-passphrase-export-seed-fingerprint yet. ✅ **Slice 5 (Remote sync) 4-phase TDD complete (2026-09-03):** `CommonplacePushService`/`CommonplacePullService` + `CommonplaceService.reconcileRemoteChain` + `CommonplaceChain.verifyBlocks`/`reconcileRemoteChain` + `jsonSortNoSpaces` + `REMOTE_COMMONPLACE_*`; 31 tests / 92 assertions GREEN. Phase 4 extracted `reconcileChainCore` (`src/ledger/chain_reconcile.js`) + shared push/pull/freshness helpers (`src/sync/chain_transport_helpers.js`).

## Purpose

Port the Commonplace Book to `phpoc-web`, mirroring the already-completed Flutter reference so the
two clients converge on the same `commonplace.json` format, seal (ADR-029a `commonplace` block type),
and same-seed Master Key (MK) semantics. Build order mirrors Flutter: engine → switcher → UI → settings,
then the follow-on slices (remote sync, key-rotation extension) that were still pending on Flutter too.

## Current state

| Slice | Flutter | Web |
|-------|---------|-----|
| Chain / engine / storage | ✅ 55/55 | ✅ Phases 1–4 complete — 55 tests / 130 assertions passing |
| Book Switcher | ✅ 13/13 | ✅ Phases 1–4 complete — 13 tests GREEN (`book_switcher_web.test.mjs`) |
| UI (screen / add-entry / topic index) | ✅ 40/40 | ✅ Phases 1–4 complete — 40 tests GREEN |
| Settings surface | ✅ 46/46 | ✅ Phases 1–4 complete — 34 assertion IDs / 44 test cases GREEN (service 13 / rekey 7 / swap 6 / screen 18) |
| Remote sync (`commonplace/...` R2 path + MK cookie) | ✅ 31/31 (2026-09-03, `b9baa2f`) | ✅ Phases 1–4 complete (2026-09-03) — 31 tests / 92 assertions GREEN (`COMMONPLACE_BOOK_SYNC_WEB_PHASE1.md`) |
| Shared key-rotation extension (ADR-026 re-encrypts both books) | 🔜 Flutter Phase 1 blueprint | ❌ |
| Tag-search blind index | ⏸️ Deferred (both clients) | ❌ |

## ADR-031 facts (contract to mirror)

- Separate sealed `commonplace.json` — **not** integrated with the activity `ledger.json` (D1, D7, D11).
- Same seed → same MK; **separate genesis block** + separate chain file.
- Entry schema: `title`, `tags`, `entry` (passage) + optional ad-hoc k/v; **no `comment`**.
- Commit into ledger-style sealed day-grouped blocks, **append-only** (D5 — no in-place edits; refinements are new entries).
- **All content encrypted at rest** (D2 — title/tags/entry/k/v all AES-CTR).
- Same-passphrase unlock; shared key rotation re-encrypts both books (ADR-026).
- Staging → commit workflow (D11: staging rows never reach sealed blocks).
- Same Worker transport, **separate R2 path** (`commonplace/...`).
- New `commonplace` block type in the ADR-029a per-type seal whitelist.

## Slices

Each slice runs the 4-phase TDD loop (blueprint → RED → GREEN → REFACTOR), mirroring its Flutter counterpart.

### Slice 1 — Chain / engine / storage JS port

**Mirror:** `flutter/COMMONPLACE_BOOK_PHASE1.md` (55 assertions, groups A–F).

- `phpoc-web/src/commonplace/commonplace_chain.js` — genesis + day-block build/seal/append/truncate/verify.
- `phpoc-web/src/commonplace/commonplace_engine.js` — commit / verify / read unified API (mirrors `ledger/engine.js`).
- `phpoc-web/src/commonplace/commonplace_storage.js` — separate-file persistence for `commonplace.json` (IndexedDB-backed).
- Extend `src/ledger/seal_fields.js` with the `commonplace` block type (ADR-029a per-type whitelist).
- Reuse the existing `CryptoService` WASM bindings — no new crypto code.

### Slice 2 — Book Switcher

**Mirror:** `flutter/COMMONPLACE_BOOK_SWITCHER_PHASE1.md` (13 tests, groups A–D).
**Status:** ✅ Phases 1–4 complete (2026-08-31) — blueprint `COMMONPLACE_BOOK_SWITCHER_WEB_PHASE1.md`; 13 tests GREEN.

- Shell-level switcher bar in `AppLayout` (`PH Ledger` ↔ `PH Commonplace Book`).
- `Book` identity (`ledger` ↔ `commonplace`) + selection state, persisted (mirrors the localStorage pattern).
- **Web deltas:** `AppScaffold` → `AppLayout`; Riverpod `bookProvider` → React `useState`; `AppPreferences` → `book.js` `getBookMode`/`setBookMode` over localStorage (`phpoc_book_mode`); 6-tab web bottom nav (BS-D2 asserts 6 tabs + Logout, not Flutter's 4).

### Slice 3 — UI wiring

**Mirror:** `flutter/COMMONPLACE_BOOK_UI_PHASE1.md` (40 assertions).
**Status:** ✅ Phases 1–4 complete (2026-08-31) — blueprint `COMMONPLACE_BOOK_UI_WEB_PHASE1.md`; 40 tests GREEN. Phase 4 (REFACTOR) extracted the shared `usePersistedBookState` hook (`book_mode.jsx`) and the `normalizeTags` pure helper (`commonplace_service.js`).

- `CommonplaceScreen` — list committed entries (title, passage, tag chips) via `CommonplaceEngine.readEntries()`.
- Add-entry (add-not-in-place) — capture `title` + `tags` + `entry` + optional k/v; stage → commit (D11).
- Topic/tag index — browse/group by tag; decrypt-and-scan initially (blind index deferred).
- `AppScaffold` content-swap by book.

### Slice 4 — Settings surface

**Mirror:** `flutter/COMMONPLACE_BOOK_SETTINGS_PHASE1.md` (46 assertions).
**Status:** ✅ Phases 1–4 complete (2026-08-31) — blueprint `COMMONPLACE_BOOK_SETTINGS_WEB_PHASE1.md`; 34 assertion IDs / 44 test cases GREEN (`node test/commonplace_settings_{service,rekey}_test.mjs` + `npx vitest run test/commonplace_settings_{swap,screen}_web.test.mjs`). Phase 4 (REFACTOR) extracted the shared `useRekeyFlow` hook + `RekeyModal` component and unified `_rebuildChain` in `rekey_service.js`.

- Commonplace Settings reachable while the book is active: verify / backup / restore / clear-all / re-key /
  shared Worker URL + API token.
- **Web deltas:** no per-book theme (no web theme system → Group T deferred), no change-passphrase / export-seed /
  fingerprint (Group SP deferred). Re-key extends `rekey_service.js` to re-encrypt `commonplace:blocks` in lockstep
  (flattened genesis shape); backup/restore via browser Blob download + file input.

### Slice 5 — Remote sync (follow-on)

**Depends on:** Flutter Commonplace remote sync (✅ complete, `b9baa2f`) + Slices 1–4. **✅ Phases 1–4 COMPLETE (2026-09-03):** `COMMONPLACE_BOOK_SYNC_WEB_PHASE1.md` — 31 assertions (P9/L10/F7/R5). Phase 3 (GREEN): `CommonplacePushService`/`CommonplacePullService` + `CommonplaceService.reconcileRemoteChain` + `CommonplaceChain.verifyBlocks`/`reconcileRemoteChain` + `jsonSortNoSpaces` + `REMOTE_COMMONPLACE_*`; all 31 tests / 92 assertions GREEN. Phase 4 (REFACTOR): extracted `reconcileChainCore` (`src/ledger/chain_reconcile.js`) + shared push/pull/freshness helpers (`src/sync/chain_transport_helpers.js`).

- Sync the sealed Commonplace chain like the ledger's `ledger/blocks/*`: same Worker transport, separate R2
  path (`commonplace/blocks/*` + plaintext `commonplace/hash_index.json`), MK-obfuscation auth — no staging
  table / device cookie (the book is direct-commit). Cookie-gated staging sync is deferred to a future
  Commonplace draft model.

### Slice 6 — Shared key-rotation extension (follow-on)

**Depends on:** Flutter ADR-026 Commonplace extension — 🔜 **Phase 1 blueprint done** (`docs/planning/flutter/COMMONPLACE_BOOK_KEY_ROTATION_PHASE1.md`, 59 assertions) + Slices 1–4.

- Extend ADR-026 rotation to re-encrypt `commonplace.json` in lockstep with the activity ledger.
- **Flutter prerequisite:** ADR-026 rotation itself is not yet in Flutter (only C-2 seed replacement). The
  blueprint therefore also scopes Flutter `deriveMk` + `soft_rotate`/`hard_rotate` + per-version MK selection.
- **C-2 note:** web `RekeyService` (`rekey_service.js`) currently treats Commonplace as N/A. Once Slices 1–4
  land, extend it to re-key `commonplace.json` in lockstep, mirroring Flutter `RekeyService.commonplaceService`.

### Deferred (both clients)

- **Tag-search blind index** — encrypted MK-derived index; decrypt-and-scan is the initial behavior.

## Acceptance criteria

1. Web can create/read/verify a `commonplace.json` that is byte-format compatible with Flutter's output
   (same genesis shape, same ADR-029a `commonplace` seal, same entry schema).
2. Book Switcher + screen + add-entry + topic index + Settings all functional and 4-phase TDD GREEN.
3. Follow-on slice (key-rotation extension) remains tracked here until Flutter completes the matching slice.

## Out of scope

- CLI Commonplace port (tracked separately; order is Flutter → Web → CLI).
- Tag-search blind index (deferred on all clients).
