# Commonplace Book Web Port — UI Wiring (Slice 3) — Test Exploration (Phase 1)

> **Plan:** `docs/planning/COMMONPLACE_BOOK_WEB_ROADMAP.md` (Slice 3 — UI wiring)
> **ADR:** ADR-031 (Commonplace Book — separate sealed chain, shared master key)
> **Mirror (Flutter reference):** `docs/planning/flutter/COMMONPLACE_BOOK_UI_PHASE1.md` (40 assertions, groups S/R/L/A/T/V) — this blueprint ports those exact assertions to `phpoc-web`.
> **Status:** ✅ Phase 2 (RED) done — 3 test files written, 40 tests, all RED for the right reason (missing Phase 3 modules). ✅ **Phase 3 (GREEN) done (2026-08-31)** — all 40 tests GREEN. ✅ **Phase 4 (REFACTOR) done (2026-08-31)** — extracted `usePersistedBookState` (`book_mode.jsx`) + `normalizeTags` (`commonplace_service.js`); all tests still GREEN.
> **Next Phase:** none — Slice 3 complete (next: Slice 4 Settings surface)

## Scope Boundary

- **In scope:** a web `CommonplaceService` (application-layer service wrapping the already-complete
  `CommonplaceEngine`) plus the Commonplace Book screen surface when the Book Switcher is set to
  `commonplace` — the entry list, add-entry flow, and tag/topic index — and the shell content-swap.
- **"Edit is add-not-in-place"** (D5): the UI always *adds a new entry*; there is **no in-place edit** of a
  committed passage. Refinements are new entries.
- **Out of scope (later slices):** remote sync (new R2 path), key-rotation extension, tag-search blind
  index (decrypt-and-scan here), Settings surface (Slice 4).
- **No `comment` field** — the book's entry schema is `title`, `tags`, `entry` (passage), optional `ad_hoc`.

## Prerequisites (complete)

- **Slice 1 (chain/engine/storage):** `src/commonplace/commonplace_chain.js` / `commonplace_engine.js` /
  `commonplace_storage.js` — 55 tests / 130 assertions GREEN (`COMMONPLACE_BOOK_WEB_PHASE1.md`).
- **Slice 2 (Book Switcher):** `src/commonplace/book.js` (`Book` identity + `getBookMode`/`setBookMode`
  localStorage) + `src/components/layout/BookSwitcher.jsx` + `AppLayout` wiring — 13 tests GREEN
  (`COMMONPLACE_BOOK_SWITCHER_WEB_PHASE1.md`).

## Architecture Overview

```
src/commonplace/
├── book.js                       (exists — Slice 2: Book identity + getBookMode/setBookMode)
├── book_mode.jsx                 ← NEW: BookModeProvider + useBookMode() (reactive shared book state)
├── commonplace_service.js        ← NEW: CommonplaceService + createCommonplaceService factory
├── commonplace_chain.js          (exists — Slice 1)
├── commonplace_engine.js         (exists — Slice 1)
└── commonplace_storage.js        (exists — Slice 1)
src/components/screens/
├── CommonplaceScreen.jsx         ← NEW: list + header + verify badge + empty state + expand + add + topic index
├── AddEntrySheet.jsx             ← NEW: add-entry capture (title/passage/tags/ad-hoc) + validation
└── TopicIndex.jsx                ← NEW: tag chips + counts + filter + untagged bucket
src/components/layout/
├── BookSwitcher.jsx              ← MODIFY: use useBookMode() (was local useState)
├── BookBody.jsx                  ← NEW: content-swap helper (book → CommonplaceScreen vs ledger screen)
└── AppLayout.jsx                 (exists — renders BookSwitcher above .app-content + 6-tab nav)
src/App.jsx                       ← MODIFY: wrap BookModeProvider; AppLayout children = <BookBody …/>
src/context/DevModeContext.jsx    ← MODIFY: wire services.commonplaceService (createCommonplaceService)
src/App.css                       ← MODIFY: .commonplace-* styles
```

### Service layer (`CommonplaceService`)

A plain JS service mirroring `CommonplaceEngine`'s relationship to the chain, and Flutter
`CommonplaceService`'s relationship to its engine. It owns a `CommonplaceEngine` (over the shared
`StorageBackend`, key `commonplace:blocks`) and presents the UI with:

- `readEntries()` — committed, decrypted, in chain order (delegates to `engine.readEntries()`).
- `addEntry({ title, tags = [], entry, adHoc = null })` — normalizes tags (trim + lower-case, dedupe),
  builds a raw entry dict (`{ title, tags, entry, [ad_hoc], timestamp_ms: Date.now() }`), and
  `engine.commit([entry])`. **No staging table for one-shot add** — a passage commits directly
  (append-only seal). Draft text is held in component state only.
- `verify()` — `engine.verify()`.
- `getLastHash()` — chain tip hash (genesis `block_hash` / day `day_hash` via `getBlockHashFor`).
- `getEntryCount()` — total committed entries across day blocks.
- `buildTagIndex()` — frequency index `tag → count` from `readEntries()` (decrypt-and-scan; returns a
  plain JS object, the Map equivalent).
- `ensureGenesis(opts)` — guards a missing chain (block count 0) with `engine.buildGenesis(opts)`
  (drawn from the ledger's shared identity/seed, ADR-031 — same MK).

`createCommonplaceService({ crypto, store, masterKey, identitySecret })` is the web analogue of the
Flutter `commonplaceServiceProvider` — a pure factory returning a `CommonplaceService` (Group V).

### Reactive book mode + content swap

Flutter's Riverpod `bookProvider` becomes a small React context: `BookModeProvider` + `useBookMode()`
(`src/commonplace/book_mode.jsx`). Both `BookSwitcher` and `AppInner` consume it, so selecting a book
re-renders the body — the web mirror of Flutter's reactive `AppPreferences.bookMode` ValueNotifier.

`AppInner` renders `<BookBody ledgerScreen={renderScreen()} commonplaceService={services.commonplaceService} />`
as the `AppLayout` child. `BookBody` returns `CommonplaceScreen` when `book.key === 'commonplace'`,
else the ledger screen. The bottom-nav tabs still render; only the body changes (book-scoped). The
active `currentScreen` tab is independent of book mode, so switching books never resets it (R6).

## Web deltas vs Flutter (documented so the port stays faithful)

- Flutter `enum Book` + Riverpod `bookProvider` → web `Book` object (`book.js`) + `BookModeProvider`/
  `useBookMode()` React context. `BookSwitcher` drops its local `useState` in favour of the shared hook.
- Flutter `AppScaffold` content-swap → web `App.jsx` renders `<BookBody>` as the `AppLayout` child.
  `BookBody` is extracted to its own lightweight module (imports only `CommonplaceScreen` + `useBookMode`)
  so Group R is testable without the heavy `DevModeContext` import graph.
- Flutter `commonplaceServiceProvider` (Riverpod) → web `createCommonplaceService` factory +
  `DevModeContext.services.commonplaceService` (created in `bootstrapServices`, cleared on logout).
- Flutter widget tests → Vitest + `@testing-library/react`. Service tests (S/V) are pure Node tests on the
  existing `MockCrypto` + `MemoryBackend` + `TestHelpers` harness (mirrors `commonplace_engine_test.mjs`).
- Flutter bottom nav has 4 tabs; web `AppLayout` has **6 tabs + Logout**. R4 therefore asserts the
  **6-tab + logout** nav is unchanged (non-regression), not "4 tabs".
- `buildTagIndex()` returns a plain JS object `{ [tag]: count }` (the JS `Map` equivalent) for React
  ergonomics + deterministic string-key ordering in tests.
- `CommonplaceScreen` receives its `service` as a **prop** (not a context/provider), so Groups L/A/T
  render it against a mock service with zero `DevModeContext` mocking.

## Test Groups

### Group S: CommonplaceService — read / add / verify / tag index (12 tests)

Node tests in `phpoc-web/test/commonplace_service_test.mjs` (`MockCrypto` + `MemoryBackend`).

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| S1 | `readEntries()` returns committed Commonplace entries decrypted, in chain order | Public read API | UI lists the sealed library (delegates to `engine.readEntries`) |
| S2 | `readEntries()` returns `[]` on a fresh (genesis-only) chain | First-run default | Empty state renders cleanly |
| S3 | `addEntry(title, tags, entry)` seals a single Commonplace day block | One-shot commit | Adding a passage commits append-only |
| S4 | `addEntry` records `timestamp_ms` (now) and `date` derived from it | Day-grouping source | Day-grouped blocks need a valid date |
| S5 | `addEntry` stores the passage in the `entry` field (never `comment`) | Schema: no `comment` | UI must not resurrect the removed field |
| S6 | `addEntry` with an `adHoc` map preserves all k/v pairs on read-back | Extensible metadata | Optional ad-hoc survives round-trip |
| S7 | `addEntry` tags persist and are returned lower-cased/trimmed | Normalized tags | Tag chips + index rely on normalized tokens |
| S8 | `verify()` returns true after a series of `addEntry` calls | Verification gate | Every commit must leave the chain verifiable |
| S9 | `verify()` returns false if a committed block is tampered with | Tamper detection | Sealed-chain integrity is not defeatable by the UI |
| S10 | `ensureGenesis` creates a fresh genesis for a missing chain | First-run bootstrap | Book starts structured even when empty |
| S11 | `ensureGenesis` does not duplicate genesis if one already exists | No double genesis | App restarts must not re-seed |
| S12 | `buildTagIndex()` returns tag frequencies from committed entries | Decrypt-and-scan index | Topic list groups by tag without a blind index yet |

### Group R: Content swap by book (6 tests)

Vitest + RTL in `phpoc-web/test/commonplace_swap_web.test.mjs` (renders `BookModeProvider` +
`AppLayout` + `BookBody` with a mock `CommonplaceService`).

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| R1 | With `Book.ledger` active, the shell renders the ledger page (not `CommonplaceScreen`) | Ledger default | Existing behavior unchanged |
| R2 | With `Book.commonplace` active, the shell renders `CommonplaceScreen` instead of the ledger page | Content swap | The switcher actually changes content now |
| R3 | The BookSwitcher bar still renders above the page in both book modes | Shell persistence | One shared switcher across both books |
| R4 | The bottom nav still shows 6 tabs + Logout in the Commonplace book | Non-regression (web: 6 tabs) | Navigation unchanged |
| R5 | Switching book commonplace → ledger restores the ledger page | Round-trip swap | The shell responds to every book change |
| R6 | The active tab (`nav-tab-active`) is preserved when switching books | Tab remembered | Book switch does not reset the tab |

### Group L: Commonplace screen — list, empty state, verification badge (6 tests)

Vitest + RTL in `phpoc-web/test/commonplace_screen_web.test.mjs` (mock `CommonplaceService`).

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| L1 | The Commonplace screen lists each committed entry (title + passage preview) | Library rendering | Users read the committed passages |
| L2 | Each listed entry shows its tags as chips | Tag display | Topic affiliation visible per entry |
| L3 | An empty book shows an empty-state message with an add prompt | First-run UX | No crash on zero entries |
| L4 | The screen header shows the entry count | Volume indicator | Users know the library size |
| L5 | The screen shows a verification status badge (verified / failed) | Integrity visibility | Parity with Settings Verify Ledger |
| L6 | Clicking an entry expands to show the full passage (not just title) | Read full passage | Long passages are not truncated away |

### Group A: Add-entry flow (8 tests)

Vitest + RTL in `phpoc-web/test/commonplace_screen_web.test.mjs`.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | Add-entry opens from a "+ / Add" affordance on the Commonplace screen | Discoverability | Entry creation reachable from the book |
| A2 | A blank title is rejected with an inline error (no commit) | Input validation | Passage needs at least a title |
| A3 | A blank passage `entry` is rejected (no commit) | Input validation | The passage is required |
| A4 | Entering title + passage + tags and saving calls `service.addEntry` | One-shot commit | Add path seals a new entry |
| A5 | After a successful add the list refreshes and shows the new entry | List refresh | New passage becomes visible |
| A6 | Cancel discards the draft without committing | No-commit cancel | Drafts never accidentally seal |
| A7 | "Add" is **add-not-in-place** — there is no edit-entry affordance on a listed entry | Append-only (D5) | UI enforces the no-in-place-edit contract |
| A8 | Optional ad-hoc k/v is capturable in the add form and persisted | Extensible metadata | Power-user metadata path |

### Group T: Topic / tag index (5 tests)

Vitest + RTL in `phpoc-web/test/commonplace_screen_web.test.mjs`.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| T1 | The topic index lists all distinct tags with entry counts | Topic grouping | Users browse by topic |
| T2 | Selecting a topic filters the entry list to matching tags | Filtering | Browse-by-topic works end-to-end |
| T3 | Clearing the topic selection restores the full list | Filter reset | No stuck filter state |
| T4 | An entry with multiple tags appears under each of its topics | Multi-tag membership | A passage lives in several topics |
| T5 | The topic index labels an entry with no tags as an "untagged" bucket | Untagged handling | No orphaned passages |

### Group V: Service factory wiring (3 tests)

Node tests in `phpoc-web/test/commonplace_service_test.mjs`.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| V1 | `createCommonplaceService({crypto, store, masterKey})` resolves a `CommonplaceService` bound to a store + crypto | DI wiring | The UI depends on a real factory |
| V2 | The factory is overridable in tests (in-memory `MemoryBackend`) | Testability | Feature tests use a fake store |
| V3 | `CommonplaceService` uses the shared `CryptoService` (same MK as the ledger) | Shared master key (ADR-031) | One seed → one MK → both books |

## Test Inventory Summary

| Group | Focus | Tests |
|-------|-------|-------|
| S | CommonplaceService — read/add/verify/tag index | 12 |
| R | Content swap by book | 6 |
| L | Commonplace screen — list/empty/badge | 6 |
| A | Add-entry flow | 8 |
| T | Topic / tag index | 5 |
| V | Service factory wiring | 3 |
| **Total** | | **40** |

Test files (Phase 2): `commonplace_service_test.mjs` (S+V, 15 node tests), `commonplace_screen_web.test.mjs`
(L+A+T, 19 Vitest/RTL tests), `commonplace_swap_web.test.mjs` (R, 6 Vitest/RTL tests).

## Next Steps

- **Phase 2 (RED):** ✅ done — `commonplace_service_test.mjs` (S+V, 15 node tests) +
  `commonplace_screen_web.test.mjs` (L+A+T, 19 Vitest/RTL tests) + `commonplace_swap_web.test.mjs`
  (R, 6 Vitest/RTL tests) all fail on import of the missing Phase 3 modules.
- **Phase 3 (GREEN):** ✅ done — `commonplace_service.js` + `book_mode.jsx` (`BookModeProvider`/
  `useBookMode`) + `CommonplaceScreen`/`AddEntrySheet`/`TopicIndex` + `BookBody` content-swap +
  `DevModeContext.services.commonplaceService` wiring + `.commonplace-*` styles. 40 tests GREEN
  (S+V 37 assertions via `node test/commonplace_service_test.mjs`; L+A+T+R 38 via vitest).
  `useBookMode()` degrades provider-less (so Slice 2 `book_switcher_web.test.mjs` still passes).
- **Phase 4 (REFACTOR):** ✅ done — extracted the shared `usePersistedBookState` hook (`book_mode.jsx`,
  removing the provider/fallback duplication) and the `normalizeTags` pure helper
  (`commonplace_service.js`). All tests re-ran GREEN (node commonplace 37/28/67/19; vitest 157 passed /
  1 skipped); `vite build` succeeds. DOX docs updated (ROADMAP / MAP / BACKLOG / SESSION_HANDOFF /
  `phpoc-web/AGENTS.md`). Slice 3 is 4-phase complete.
