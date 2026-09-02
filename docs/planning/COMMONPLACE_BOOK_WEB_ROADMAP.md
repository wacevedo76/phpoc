# Commonplace Book — Web Port Roadmap

> **ADR:** ADR-031 (Commonplace Book — separate sealed chain, shared master key)
> **Spec:** `docs/planning/WEB_FLUTTER_PARITY_SPEC.md` §P1
> **Reference (Flutter):** `flutter/COMMONPLACE_BOOK_PHASE1.md` (chain engine, 55), `flutter/COMMONPLACE_BOOK_SWITCHER_PHASE1.md` (13), `flutter/COMMONPLACE_BOOK_UI_PHASE1.md` (40), `flutter/COMMONPLACE_BOOK_SETTINGS_PHASE1.md` (46)
> **Status:** ✅ Slice 1 (chain/engine/storage) 4-phase TDD complete — `CommonplaceChain`/`CommonplaceEngine`/`CommonplaceStorage` implemented + `seal_fields.js` `commonplace_genesis`/`commonplace` whitelist; 55 tests / 130 assertions GREEN. Phase 4 deduped shared version/content-hash/zero-hash helpers into `ledger/utils.js`. ✅ **Slice 2 (Book Switcher) 4-phase TDD complete (2026-08-31):** `book.js` (`Book` identity + `getBookMode`/`setBookMode` localStorage persistence) + `BookSwitcher.jsx` rendered above page content in `AppLayout`; 13 tests GREEN. ✅ **Slice 3 (UI wiring) 4-phase TDD complete (2026-08-31):** `commonplace_service.js` + `book_mode.jsx` + `CommonplaceScreen`/`AddEntrySheet`/`TopicIndex` + `BookBody` + `DevModeContext.services.commonplaceService` wiring + `.commonplace-*` styles; 40 tests GREEN. Phase 4 (REFACTOR) extracted the shared `usePersistedBookState` hook (book_mode) and the `normalizeTags` pure helper (service).

## Purpose

Port the Commonplace Book to `phpoc-web`, mirroring the already-completed Flutter reference so the
two clients converge on the same `commonplace.json` format, seal (ADR-029a `commonplace` block type),
and same-seed Master Key (MK) semantics. Build order mirrors Flutter: engine → switcher → UI → settings,
then the follow-on slices (remote sync, key-rotation extension) that are still pending on Flutter too.

## Current state

| Slice | Flutter | Web |
|-------|---------|-----|
| Chain / engine / storage | ✅ 55/55 | ✅ Phases 1–4 complete — 55 tests / 130 assertions passing |
| Book Switcher | ✅ 13/13 | ✅ Phases 1–4 complete — 13 tests GREEN (`book_switcher_web.test.mjs`) |
| UI (screen / add-entry / topic index) | ✅ 40/40 | ✅ Phases 1–4 complete — 40 tests GREEN |
| Settings surface | ✅ 46/46 | ❌ |
| Remote sync (`commonplace/...` R2 path + MK cookie) | ⏸️ Pending | ❌ |
| Shared key-rotation extension (ADR-026 re-encrypts both books) | ⏸️ Pending | ❌ |
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

- Commonplace Settings reachable while the book is active: verify / backup / restore / clear-all / re-key /
  shared Worker URL + API token / per-book theme.

### Slice 5 — Remote sync (follow-on)

**Depends on:** Flutter Commonplace remote sync (still ⏸️ Pending) + Slices 1–3.

- Sync the Commonplace chain like the ledger: same Worker transport, separate R2 path (`commonplace/...`),
  MK-derived device cookie. Staging rows sync like ledger staging rows.

### Slice 6 — Shared key-rotation extension (follow-on)

**Depends on:** Flutter ADR-026 Commonplace extension (still ⏸️ Pending) + Slices 1–4.

- Extend ADR-026 rotation to re-encrypt `commonplace.json` in lockstep with the activity ledger.
- **C-2 note:** web `RekeyService` (`rekey_service.js`) currently treats Commonplace as N/A. Once Slices 1–4
  land, extend it to re-key `commonplace.json` in lockstep, mirroring Flutter `RekeyService.commonplaceService`.

### Deferred (both clients)

- **Tag-search blind index** — encrypted MK-derived index; decrypt-and-scan is the initial behavior.

## Acceptance criteria

1. Web can create/read/verify a `commonplace.json` that is byte-format compatible with Flutter's output
   (same genesis shape, same ADR-029a `commonplace` seal, same entry schema).
2. Book Switcher + screen + add-entry + topic index + Settings all functional and 4-phase TDD GREEN.
3. Follow-on slices (remote sync, key-rotation) remain tracked here until Flutter completes the matching slice.

## Out of scope

- CLI Commonplace port (tracked separately; order is Flutter → Web → CLI).
- Tag-search blind index (deferred on all clients).
