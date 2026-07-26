# E13: LocalCache.update() Title Fix — Test Exploration (Phase 1)

> **Bug:** `LocalCache.update()` writes `fields['title']` to `data['title']` but doesn't sync `data['title_enc']`. On read, `_rawToDto()` finds the stale `title_enc` (set by `append()`) and overrides the updated title with the original.
> **Status:** 🔜 Phase 1 (test exploration)
> **Next Phase:** Phase 2 (RED: test definition)

## Architecture Overview

`LocalCache` stores staging entries with a dual-field pattern for per-field encryptable fields:
- `data['title']` — plaintext value
- `data['title_enc']` — encrypted (or `plain:`-prefixed) copy

`_rawToDto()` reads `data['title']` first, then if `title_enc` exists, overrides with its decrypted value.
`append()` sets both. `update()` must keep both in sync.

Tags and comment already handle this correctly in `update()`. Only `title` is broken.

## Test Groups

### Group A: Title Update — Core Fix — 4 tests

| ID | Assertion | Purpose | Rationale |
|---|---|---|---|
| A1 | `update(0, {'title': 'X'})` → `readEntries()[0]['title'] == 'X'` | Verify title_enc is synced on plaintext title update | Direct fix for E13 — this is the bug |
| A2 | `update(0, {'title': 'X'}, encryptFields: {'title'})` → `readEntries()[0]['title'] == 'X'` | Verify title update works when title IS in encryptFields | Encrypted path must also work (removes title_enc, keeps encrypted title) |
| A3 | `update(0, {'end_epoch': 5000})` does not corrupt title | Verify partial update (other fields) preserves title | Regression guard: updating end_epoch alone must not touch title or title_enc |
| A4 | `update(0, {'title': 'X', 'tags': ['a']})` → both fields update correctly | Verify multi-field update with title + other field | Combination test — title fix must not break tags which already works |

### Group B: Duration — Existing Correct Behavior — 1 test

| ID | Assertion | Purpose | Rationale |
|---|---|---|---|
| B1 | `update(0, {'duration': 99})` → `readEntries()[0]['duration'] == 99` | Verify duration update still works (no _enc variant in append) | Duration has no dual-field pattern — confirm it was never broken |

### Group C: Edge Cases — 2 tests

| ID | Assertion | Purpose | Rationale |
|---|---|---|---|
| C1 | `update(0, {'title': 'X'})` on committed entry → no-op, title unchanged | Verify committed guard still works for title | Regression: committed entries must stay immutable |
| C2 | `update(999, {'title': 'X'})` on out-of-range index → no-op, no crash | Verify bounds check still works | Regression: out-of-range must not crash or corrupt storage |

### Group D: SyncService.modify() Integration — 2 tests

| ID | Assertion | Purpose | Rationale |
|---|---|---|---|
| D1 | `modify(0, {'title': 'X'})` → `getEntries()[0]['title'] == 'X'` | Verify SyncService.modify → LocalCache.update title chain works | This is the existing E13 test — must go GREEN |
| D2 | modify + end: `modify(0, {'title': 'X'})` then `end('X', 5000)` succeeds | Verify E16 downstream scenario works after fix | Existing E16 test — must go GREEN after D1 fix |

---

## Assertion Summary

| Group | Area | Assertions |
|---|---|---|
| A | Core title_enc sync | 4 |
| B | Duration (existing correct) | 1 |
| C | Edge cases | 2 |
| D | SyncService integration | 2 |
| **Total** | | **9** |

## Coverage Map

- **Bug fix direct:** A1 (plaintext), A2 (encrypted)
- **Regression guard:** A3 (no corruption on partial update), A4 (multi-field), B1 (duration), C1 (committed), C2 (oob)
- **Integration:** D1 (E13), D2 (E16 downstream)
- **Already covered by existing tests:** Tags update, comment update, pause operations (all correct in `update()` already)

## Existing RED Tests

- **E13** (`sync_service_test.dart:375`) — `modify(0, {'title': 'Modified Title'})` → expects `'Modified Title'`, gets `'Modify Me'`
- **E16** (`sync_service_test.dart:416`) — downstream: modify + end → exception, cascade of E13
- **B7** (`local_cache_test.dart:162`) — `update(0, {'title': 'Updated', 'end_epoch': 5000})` → expects `'Updated'`, gets `'Original'` (but file can't compile due to F-07)

These 3 tests exist and are RED. Phase 2 will add the remaining 6 assertions (A2–A4, B1, C1–C2).
