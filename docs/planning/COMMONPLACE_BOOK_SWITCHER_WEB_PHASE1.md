# Commonplace Book Web Port — Book Switcher (Slice 2) — Test Exploration (Phase 1)

> **Plan:** `docs/planning/COMMONPLACE_BOOK_WEB_ROADMAP.md` (Slice 2 — Book Switcher)
> **ADR:** ADR-031 (Commonplace Book — separate sealed chain, shared master key)
> **Mirror (Flutter reference):** `docs/planning/flutter/COMMONPLACE_BOOK_SWITCHER_PHASE1.md` (13 assertions, groups A–D) — this blueprint ports those exact assertions to `phpoc-web`.
> **Status:** ✅ Phase 4 (REFACTOR) complete — 13 tests GREEN (2026-08-31)
> **Next Phase:** None (Slice 2 complete). Next slice: Slice 3 (UI wiring).

## Scope of This Slice

Port the Flutter **Book Switcher** (13 assertions, groups A–D) to `phpoc-web`: the shell-level
persistent title bar (`PH Ledger` ↔ `PH Commonplace Book`) rendered above each screen's content,
plus the `Book` identity + selection state, persisted to localStorage.

**This slice delivers the visual book indicator + selection state only.** The Dashboard/History/Sync/
Settings/Tags/Profile content remains the ledger's until the Commonplace UI slice (Slice 3) is built.
Mirrors the Flutter scope boundary exactly (see BACKLOG "Book Switcher — visible book indicator").

Deliverables (web, `phpoc-web/`):

```
src/commonplace/book.js                  — Book identity (ledger ↔ commonplace) + labels + fromKey
                                           + getBookMode()/setBookMode() persistence (localStorage)
src/components/layout/BookSwitcher.jsx   — the clickable title bar + pull-down menu (React)
src/components/layout/AppLayout.jsx      — renders <BookSwitcher /> above <main class="app-content">
src/App.css                              — .book-switcher / .book-switcher-* styles
```

**Web deltas vs Flutter (documented so the port stays faithful):**
- Flutter `enum Book` + Riverpod `bookProvider`/`BookNotifier` → web `Book` object literal (`.key`/`.label`/
  `values`/`fromKey`) + React `useState` seeded from persistence. No Riverpod equivalent exists in
  `phpoc-web`; the mirror of the "theme-mode pattern" is the existing localStorage convention
  (`phpoc_worker_url`, `phpoc_dev_mode`), so persistence uses key **`phpoc_book_mode`**.
- Flutter `AppPreferences.getBookMode()`/`setBookMode()` (SharedPreferences) → web `getBookMode()`/
  `setBookMode()` over `localStorage`, with an injectable `storage` param for tests (mirrors the
  `rekey_settings_web.test.mjs` localStorage mock pattern).
- Flutter `AppScaffold` (shell) → web `AppLayout` (the nav shell). The switcher renders as the first
  child of `.app-layout`, above `<main class="app-content">`.
- Flutter bottom nav has 4 tabs (Dashboard/History/Sync/Settings); web `AppLayout` has **6 tabs**
  (Home/History/Tags/Profile/Sync/Settings) + a Logout button. BS-D2 therefore asserts the **existing
  6-tab + logout** nav is unchanged (non-regression), not "4 tabs".

## Architecture Overview

```
src/commonplace/book.js
├── Book.ledger / Book.commonplace        // { key, label } — "PH Ledger" / "PH Commonplace Book"
├── Book.values                           // the fixed two-book set (length 2)
├── Book.fromKey(key)                     // persisted key → Book; unknown → Book.ledger
├── BOOK_MODE_KEY                         // 'phpoc_book_mode'
├── getBookMode(storage?)                 // reads BOOK_MODE_KEY; default 'ledger'
└── setBookMode(mode, storage?)           // writes BOOK_MODE_KEY (localStorage)
```

`AppLayout` (shell) renders, in its flex-column root:
```
<div class="app-layout">
  <BookSwitcher />              // the title bar — one instance for the whole shell
  <main class="app-content">    // the screen content (page below the switcher)
    {children}
  </main>
  <nav class="app-nav">…</nav>  // existing bottom tab nav (unchanged)
</div>
```

`BookSwitcher` is a controlled React component: `useState(() => Book.fromKey(getBookMode()))`; selecting
a book updates local state + calls `setBookMode(b.key)`. Page content is not swapped in this slice.

## Test Groups

### Group A: Book identity + labels — 2 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| BS-A1 | `Book.ledger.label === 'PH Ledger'` and `Book.commonplace.label === 'PH Commonplace Book'` | Enum contract | The two book identities are the core data the switcher exposes |
| BS-A2 | `Book.values` has exactly two entries | Fixed book set | Prevents accidental expansion; book set is bounded (Ledger, Commonplace) |

### Group B: book-mode persistence — 4 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| BS-B1 | `getBookMode()` defaults to `'ledger'` when nothing is persisted | Safe default | First run shows the Ledger by default |
| BS-B2 | `setBookMode('commonplace')` then `getBookMode()` returns `'commonplace'` | Selection works | The persisted choice round-trips |
| BS-B3 | `setBookMode('commonplace')` writes `'commonplace'` under `phpoc_book_mode` in localStorage | Survives restart | Book choice is remembered across page reloads |
| BS-B4 | `Book.fromKey(null)` and `Book.fromKey('unknown')` return `Book.ledger` | Backward compatible | Existing installs/unknown keys keep the Ledger as default |

### Group C: BookSwitcher component — 5 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| BS-C1 | `BookSwitcher` renders the active book label (`PH Ledger` by default) | Visual clue | The current book is always visible |
| BS-C2 | Clicking the switcher opens a menu listing both books | Discoverability | User can switch between Ledger and Commonplace |
| BS-C3 | Selecting "PH Commonplace Book" updates the label + persists `'commonplace'` | Switch works | Choosing the book reflects in the title bar and survives restart |
| BS-C4 | A single `BookSwitcher` renders exactly one switcher bar | No duplication | One persistent bar, not a bar per page |
| BS-C5 | The switcher renders **above** the page content (DOM order) | Layout contract | Matches the "above each page's main title" requirement |

### Group D: AppLayout integration — 2 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| BS-D1 | `AppLayout` renders a `BookSwitcher` above the page child (both present) | Shared placement | All main pages get the book bar without per-page duplication |
| BS-D2 | Existing bottom-nav behavior is unchanged (6 tabs + Logout) | Non-regression | The switcher addition must not break navigation |

## Test Inventory Summary

| Group | Focus | Tests |
|-------|-------|-------|
| A | Book identity + labels | 2 |
| B | Persistence | 4 |
| C | BookSwitcher component | 5 |
| D | AppLayout integration | 2 |
| **Total** | | **13** |

## Next Steps

- **Phase 2 (RED):** write the 13 assertions in `phpoc-web/test/book_switcher_web.test.mjs`
  (Vitest + `@testing-library/react`) and watch them fail (no `book.js` / `BookSwitcher.jsx` yet).
- **Phase 3 (GREEN):** implement `src/commonplace/book.js` + `src/components/layout/BookSwitcher.jsx`
  + `AppLayout` rendering + `App.css` styles to satisfy them.
- **Phase 4 (REFACTOR):** review; update DOX docs (ROADMAP / BACKLOG / SESSION_HANDOFF / phpoc-web AGENTS).
