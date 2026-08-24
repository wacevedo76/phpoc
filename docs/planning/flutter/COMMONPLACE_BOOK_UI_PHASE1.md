# Flutter Commonplace Book UI — Test Exploration (Phase 1)

> **Plan:** this file — the Commonplace Book **screen surface** slice (UI wiring, second step)
> **ADR:** ADR-031 (Commonplace Book — separate sealed chain, shared master key)
> **Purpose:** Blueprint of all needed test assertions for the Commonplace Book **screen**, the
> **add-entry** flow, and the **tag/topic index** — plus the `CommonplaceService` layer that wires the
> already-complete chain engine (`lib/data/commonplace/`) to the UI. No test/implementation code yet.
> **Status:** ✅ Phase 4 (REFACTOR: code review) complete
> **Next Phase:** none — full 4-phase task complete.
>
> **Prerequisite (complete):** `COMMONPLACE_BOOK_PHASE1.md` — the chain/engine/storage slice (55/55 GREEN,
> shared `SealableChain` mixin, 349/349 ledger-layer GREEN). `COMMONPLACE_BOOK_SWITCHER_PHASE1.md` — the
> Book Switcher bar (13/13 GREEN). This slice builds on both.

## Scope Boundary

- **In scope:** a `CommonplaceService` (application-layer service mirroring `SyncService`) plus the Commonplace
  Book screen surface when the Book Switcher is set to `commonplace`.
- **"Edit is add-not-in-place"** (D5): the UI always *adds a new entry*; there is **no in-place edit** of a
  committed passage. Refinements are new entries.
- **Out of scope (later BACKLOG slices):** remote sync (new R2 path), key-rotation extension, tag-search
  blind index (decrypt-and-scan here), Web/CLI parity ports.
- **No `comment` field** — the book's entry schema is `title`, `tags`, `entry` (passage), optional `ad_hoc`.

## Architecture Overview

```
lib/data/commonplace/                ← DONE (chain-engine slice): CommonplaceChain/Engine/Storage
lib/data/commonplace/commonplace_service.dart        ← NEW: application layer
lib/data/storage/providers.dart                      ← NEW: commonplaceServiceProvider + sqlite store
lib/features/commonplace/commonplace_screen.dart     ← NEW: the Book's dashboard surface
lib/features/commonplace/add_entry_bottom_sheet.dart ← NEW: add-entry capture
lib/features/commonplace/topic_index.dart            ← NEW: tag/topic browse + index
lib/features/shared/app_scaffold.dart                ← MODIFY: swap child content by bookProvider
routing/app_router.dart                              ← MODIFY: Commonplace routes under the shell
```

### Service layer (`CommonplaceService`)

A plain Dart service mirroring `SyncService`'s relationship to the engine. It owns a
`CommonplaceStorage` (file-backed, e.g. `commonplace.json` in the app dir) + a `CommonplaceEngine`,
and presents the UI with:

- `Future<List<Map<String, dynamic>>> readEntries()` — committed, decrypted, in chain order
  (delegates to `engine.readEntries()`).
- `Future<void> addEntry({required String title, List<String> tags, required String entry,
  Map<String, dynamic>? adHoc})` — builds a raw entry dict (`timestamp_ms`, `date`, schema) and
  `engine.commit([entry])`. There is **no staging table for one-shot add** in this slice: adding a
  passage commits it directly (append-only seal). A draft composer may hold text in memory only.
- `Future<bool> verify()` — `engine.verify()`.
- `String? getLastHash()` / `int getEntryCount()` — for the screen header/verification badge.
- `Map<String, int> buildTagIndex()` — frequency index `tag → entryCount` from `readEntries()`
  (decrypt-and-scan; not the deferred blind index).
- Genesis bootstrapping: `Future<void> ensureGenesis(...)` guards a missing `commonplace.json`
  with a fresh genesis (drawn from the ledger's shared identity/seed, ADR-031 — same MK).

### Content swap

`AppScaffold` watches `bookProvider`. When the active book is `Book.ledger`, it renders the existing
route child (Dashboard/History/Sync/Settings). When `Book.commonplace`, it swaps in the Commonplace
screen surface. The bottom-nav tabs still render; only the body content changes (book-scoped).

## Test Groups

### Group S: CommonplaceService — read / add / verify / tag index (~12 tests)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| CPUI-S1 | `readEntries()` returns committed Commonplace entries decrypted, in chain order | Public read API | UI lists the sealed library (delegates to engine.readEntries) |
| CPUI-S2 | `readEntries()` returns `[]` on a fresh (genesis-only) chain | First-run default | Empty state renders cleanly |
| CPUI-S3 | `addEntry(title, tags, entry)` seals a single Commonplace day block | One-shot commit | Adding a passage commits append-only |
| CPUI-S4 | `addEntry` records `timestamp_ms` (now) and `date` derived from it | Day-grouping source | Day-grouped blocks need a valid date |
| CPUI-S5 | `addEntry` stores the passage in the `entry` field (never `comment`) | Schema: no `comment` | UI must not resurrect the removed field |
| CPUI-S6 | `addEntry` with an `adHoc` map preserves all k/v pairs on read-back | Extensible metadata | Optional ad-hoc survives round-trip |
| CPUI-S7 | `addEntry` tags persist and are returned lower-cased/trimmed | Normalized tags | Tag chips + index rely on normalized tokens |
| CPUI-S8 | `verify()` returns true after a series of `addEntry` calls | Verification gate | Every commit must leave the chain verifiable |
| CPUI-S9 | `verify()` returns false if a committed block is tampered with | Tamper detection | Sealed-chain integrity is not defeatable by the UI |
| CPUI-S10 | `ensureGenesis` creates a fresh genesis for a missing `commonplace.json` | First-run bootstrap | Book starts structured even when empty |
| CPUI-S11 | `ensureGenesis` does not duplicate genesis if one already exists | No double genesis | App restarts must not re-seed |
| CPUI-S12 | `buildTagIndex()` returns tag frequencies from committed entries (front-loading decrypt-and-scan) | Decrypt-and-scan index | Topic list groups by tag without a blind index yet |

### Group R: Content swap in AppScaffold by book (~6 tests)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| CPUI-R1 | With `Book.ledger` active, AppScaffold renders the surrounding route's page child | Ledger default | Existing behavior unchanged |
| CPUI-R2 | With `Book.commonplace` active, AppScaffold renders the Commonplace screen instead of the ledger page | Content swap | The switcher actually changes content now |
| CPUI-R3 | The Book Switcher bar still renders above the page in both book modes | Shell persistence | One shared switcher across both books |
| CPUI-R4 | The bottom nav still shows 4 tabs in the Commonplace book | Non-regression | Navigation unchanged |
| CPUI-R5 | Switching book from commonplace → ledger restores the ledger page | Round-trip swap | The shell responds to every book change |
| CPUI-R6 | The active tab (Dashboard/History/Sync/Settings) is preserved when switching books | Tab remembered | Book switch does not reset the tab |

### Group L: Commonplace screen — list, empty state, verification badge (~6 tests)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| CPUI-L1 | The Commonplace screen lists each committed entry (title + passage preview) | Library rendering | Users read the committed passages |
| CPUI-L2 | Each listed entry shows its tags as chips | Tag display | Topic affiliation visible per entry |
| CPUI-L3 | An empty book shows an empty-state message with an add prompt | First-run UX | No crash on zero entries |
| CPUI-L4 | The screen header shows the entry count | Volume indicator | Users know the library size |
| CPUI-L5 | The screen shows a verification status badge (verified / failed) | Integrity visibility | Parity with Settings Verify Ledger |
| CPUI-L6 | Tapping an entry expands to show the full passage (not just title) | Read full passage | Long passages are not truncated away |

### Group A: Add-entry flow (~8 tests)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| CPUI-A1 | Add-entry opens from a "+ / Add" affordance on the Commonplace screen | Discoverability | Entry creation reachable from the book |
| CPUI-A2 | A blank title is rejected with an inline error (no commit) | Input validation | Passage needs at least a title |
| CPUI-A3 | A blank passage `entry` is rejected (no commit) | Input validation | The passage is required |
| CPUI-A4 | Entering title + passage + tags and saving calls `service.addEntry` | One-shot commit | Add path seals a new entry |
| CPUI-A5 | After a successful add the list refreshes and shows the new entry | List refresh | New passage becomes visible |
| CPUI-A6 | Cancel discards the draft without committing | No-commit cancel | Drafts never accidentally seal |
| CPUI-A7 | "Add" is **add-not-in-place** — there is no edit entry affordance on a listed entry | Append-only (D5) | UI enforces the no-in-place-edit contract |
| CPUI-A8 | Optional ad-hoc k/v is capturable in the add form and persisted | Extensible metadata | Power-user metadata path |

### Group T: Topic / tag index (~5 tests)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| CPUI-T1 | The topic index lists all distinct tags with entry counts | Topic grouping | Users browse by topic |
| CPUI-T2 | Selecting a topic filters the entry list to matching tags | Filtering | Browse-by-topic works end-to-end |
| CPUI-T3 | Clearing the topic selection restores the full list | Filter reset | No stuck filter state |
| CPUI-T4 | An entry with multiple tags appears under each of its topics | Multi-tag membership | A passage lives in several topics |
| CPUI-T5 | The topic index labels an entry with no tags as an "untagged" bucket | Untagged handling | No orphaned passages |

### Group V: Service provider wiring (~3 tests)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| CPUI-V1 | `commonplaceServiceProvider` resolves a `CommonplaceService` bound to a file store + crypto | DI wiring | The UI depends on a real provider |
| CPUI-V2 | The provider overridable in tests (in-memory store) | Testability | Feature tests use a fake store |
| CPUI-V3 | `CommonplaceService` uses the shared `CryptoService` (same MK as the ledger) | Shared master key (ADR-031) | One seed → one MK → both books |

## Test Inventory Summary

| Group | Focus | Tests |
|-------|-------|-------|
| S | CommonplaceService — read/add/verify/tag index | 12 |
| R | Content swap in AppScaffold by book | 6 |
| L | Commonplace screen — list/empty/badge | 6 |
| A | Add-entry flow | 8 |
| T | Topic / tag index | 5 |
| V | Service provider wiring | 3 |
| **Total** | | **40** |

Tests target pure-Dart `CommonplaceService` (unit) + widget tests for the screen/add flow (groups L/A/T/R)
using the overridable provider, plus a provider-wiring group (V). No HTTP/remote-sync in this slice.

## Next Steps

- **✅ Phase 2 (RED) done (2026-08-23):** 40 tests written and CONFIRMED RED (compile-blocking on the not-yet-implemented API modules only — no unrelated errors). Files:
  - `test/services/commonplace_service_test.dart` — Groups S (12) + V (3)
  - `test/features/commonplace_screen_test.dart` — Groups L (6) + A (8) + T (5)
  - `test/features/commonplace_swap_test.dart` — Group R (6)
  All target the expected `CommonplaceService` API (`readEntries`/`addEntry`/`verify`/`getLastHash`/`getEntryCount`/`buildTagIndex`/`ensureGenesis`), `commonplaceServiceProvider`, and the `CommonplaceScreen`/`AddEntryBottomSheet`/`TopicIndex` widget surfaces — none of which exist yet, so failures are genuine RED.
- **✅ Phase 3 (GREEN) done (2026-08-23):** all 40 assertions GREEN + full Flutter suite `+2050` / 0 failures (no regressions). Implemented:
  - `lib/data/commonplace/commonplace_service.dart` — the `CommonplaceService` application layer (`readEntries`/`addEntry`/`verify`/`getLastHash`/`getEntryCount`/`buildTagIndex`/`ensureGenesis`, tag normalization, `ad_hoc` passthrough, `_persist` to the file store when present).
  - `lib/data/storage/providers.dart` — `commonplaceServiceProvider` (shared MK via `cryptoServiceProvider`, `CommonplaceStorage` file store when `preResolvedPath` set, else in-memory). `lib/main.dart` pre-resolves `commonplace.json`.
  - `lib/features/commonplace/commonplace_screen.dart` + `add_entry_bottom_sheet.dart` + `topic_index.dart` — the dashboard surface, add-not-in-place entry sheet (title/passage/tags/ad-hoc, validation), and tag filter chips.
  - `lib/features/shared/app_scaffold.dart` — content swap by book via a new reactive `AppPreferences.bookMode` `ValueNotifier` (so both `BookSwitcher.select()` and direct `setBookMode` re-render the body); 7 source files added/modified.
- **✅ Phase 4 (REFACTOR) done (2026-08-23):** 3 behavior-neutral improvements, all 40/40 remaining GREEN + full suite `+2050`/0 fails, analyze 0 on changed files:
  1. **Clarity (C1):** removed a dead empty `if` block in `CommonplaceScreen._refresh()` (computed `service.crypto.hasMasterKey && getEntryCount()==0` then did nothing).
  2. **Security/Clarity (C2):** extracted `_ensureBookBootstrap()` in the screen and documented that the genesis is bootstrapped **identityless** (empty username/email/pubkey are intentional placeholders; chain integrity comes from the shared MK, ADR-031).
  3. **Modularity/Conciseness (M1/NC1):** consolidated `_persist()`'s double `dynamic` cast into a single null-aware `fileStore?.save()` in `CommonplaceService`, and removed the duplicated two-branch `as dynamic` store construction in `commonplaceServiceProvider` (providers.dart), switching on `filePath` only.
