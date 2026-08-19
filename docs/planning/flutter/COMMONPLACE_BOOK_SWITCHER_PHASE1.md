# Commonplace Book Switcher — Test Exploration (Phase 1)

> **Plan:** this file — the book-switcher UI wiring slice of the Commonplace Book feature
> **ADR:** ADR-031 (Commonplace Book — separate sealed chain, shared master key)
> **Purpose:** Blueprint of all needed test assertions for the persistent book-switcher bar
>               (PH Ledger ↔ PH Commonplace Book) rendered above each main page's AppBar,
>               before writing any test/implementation code.
> **Status:** 🔜 Phase 1 (test exploration)
> **Next Phase:** Phase 2 (RED: test definition)
>
> **Scope boundary:** This slice delivers the **visual book indicator + selection state only**.
> The Dashboard/History/Sync/Settings content remains the ledger's until the Commonplace
> screens (chained-engine UI slice) are built. Theme remains the shared app-wide theme.

## Context / User Requirement

The user wants a clear **visual clue** that distinguishes the Ledger from the Commonplace
Book. Per user decision (2026-08):
- A clickable app **title bar** that reveals a pull-down with "PH Ledger" and
  "PH Commonplace Book". Currently the Dashboard shows `PH Ledger` as its AppBar title,
  and History/Sync/Settings show their own main titles (`History`, `Sync`, `Settings`).
- The book switcher must appear **above each page's main title** — i.e. rendered by the
  shell (`AppScaffold`), not per-page, so all four main pages share one instance.
- This slice only *shows* the switcher and records the selection; it does **not** yet swap
  page content to Commonplace screens. Commonplace Dashboard/entry-list content is a later
  slice (per BACKLOG "UI wiring" follow-on).

## Architecture Overview

```
lib/features/shared/book_switcher.dart
├── enum Book { ledger, commonplace }        // + labels
├── bookProvider                             // Riverpod StateNotifierProvider<BookNotifier, Book>
├── class BookNotifier                       // persists select via AppPreferences
├── class BookSwitcher                       // ConsumerWidget — the clickable title bar
└── (AppPreferences.getBookMode/setBookMode) // persistence key 'book_mode'
```

`AppScaffold` (shell) renders, in its Scaffold `body`:
```
Column(
  children: [
    BookSwitcher(),          // the title bar — one instance for the whole shell
    Expanded(child: child),  // the page (own Scaffold + AppBar below the switcher)
  ],
)
```

This places the book switcher **above** the page's AppBar/main title as the user requested,
shared across Dashboard, History, Sync, Settings. Selecting a book updates `bookProvider`
(persisted), but the page content stays unchanged in this slice.

## Test Groups

### Group A: Book enum + labels — ~2 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| BS-A1 | `Book.ledger` and `Book.commonplace` exist with labels "PH Ledger" and "PH Commonplace Book" | Enum contract | The two book identities are the core data the switcher exposes |
| BS-A2 | `Book` has exactly two values | Fixed book set | Prevents accidental expansion; book set is bounded (Ledger, Commonplace) |

### Group B: bookProvider + persistence — ~4 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| BS-B1 | `bookProvider` defaults to `Book.ledger` when no persisted value | Safe default | First run shows the Ledger by default |
| BS-B2 | Selecting `Book.commonplace` updates `bookProvider` state | Selection works | The switcher records the user's choice |
| BS-B3 | The selection is persisted via `AppPreferences.getBookMode`/`setBookMode` | Survives restart | Book choice is remembered across app relaunch |
| BS-B4 | `AppPreferences` default (no key) reads `Book.ledger` | Backward compatible | Existing ledgers/installs keep the Ledger as default |

### Group C: BookSwitcher widget — ~5 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| BS-C1 | `BookSwitcher` renders the active book label | Visual clue | The current book is always visible |
| BS-C2 | Tapping the switcher opens a menu listing both books | Discoverability | User can switch between Ledger and Commonplace |
| BS-C3 | Selecting "PH Commonplace Book" in the menu updates state + re-renders label | Switch works | Choosing the book reflects in the title bar |
| BS-C4 | The switcher is a single instance at the shell level | No duplication | One persistent bar across all four pages |
| BS-C5 | The switcher appears above the page content (rendered by AppScaffold) | Layout contract | Matches the "above each page's main title" requirement |

### Group D: AppScaffold integration — ~2 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| BS-D1 | `AppScaffold` renders a `BookSwitcher` above the page child | Shared placement | All main pages get the book bar without per-page duplication |
| BS-D2 | Existing bottom-nav behavior is unchanged (4 tabs) | Non-regression | The switcher addition must not break navigation |

## Test Inventory Summary

| Group | Focus | Tests |
|-------|-------|-------|
| A | Book enum + labels | 2 |
| B | Provider + persistence | 4 |
| C | BookSwitcher widget | 5 |
| D | AppScaffold integration | 2 |
| **Total** | | **13** |

## Next Steps

- **Phase 2 (RED):** write the assertions as widget/unit tests in
  `phpoc-flutter/test/features/book_switcher_test.dart` and watch them fail (no
  implementation yet).
- **Phase 3 (GREEN):** implement `lib/features/shared/book_switcher.dart` +
  `AppPreferences.getBookMode/setBookMode` + `AppScaffold` rendering to satisfy them.
- **Phase 4 (REFACTOR):** review; update DOX docs (ROADMAP / BACKLOG / SESSION_HANDOFF).
