# Concurrent Activities — Test Exploration (Phase 1)

> **Purpose:** Blueprint of all needed test assertions before writing any code.
> **Status:** Phase 1 ✅ → Phase 2 ✅ → Phase 3 ✅ (23 GREEN)
> **Next Phase:** Phase 4 (REFACTOR)

## Problem

phpoc-flutter's UI layer (`DashboardScreen` + `SyncService.getActive()`) assumes one active task at a time. The data layer (`LocalCache`) already supports multiple entries with `is_active == true`. phpoc-web correctly handles this with `useActiveTasks` returning an array and a per-task `elapsedMap`.

## Architecture Overview

- **LocalCache** (no changes needed) — `append()` creates entries with `isActive: true`; never checks/stops other entries
- **SyncService** — `getActive()` returns `Map?` → must return `List<Map>`; task actions (`end`/`pause`/`unpause`) identify by `title` → add `entry_id`-based variants
- **DashboardScreen** — `_activeTask` is a single map → must become `_activeTasks` list; one task card → one card per active task with independent timers and actions

## Test Groups

### Group S: SyncService — Multi-Active Queries & Actions (~8 tests)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| S1 | `getActive()` returns list of 2 when 2 active entries exist | Core API contract change | Proves the return type change works |
| S2 | `getActive()` returns empty list when no active entries | Null/empty handling | Empty list is safer than null for iteration |
| S3 | `capture()` does not deactivate existing active entries | Data integrity | The fix must not break concurrent-activity support |
| S4 | `capture()` appends new active entry without affecting other active | Non-destructive append | Starting task 2 must not end task 1 |
| S5 | `endByEntryId(entryId, endEpoch)` ends correct entry among 2 active | Precise targeting | `title`-based end is ambiguous with concurrent tasks |
| S6 | `pauseByEntryId(entryId, epoch)` pauses correct entry among 2 active | Independent pause | Each running task must be independently pausable |
| S7 | `unpauseByEntryId(entryId, epoch)` unpauses correct entry | Independent resume | Pause/resume must be per-entry |
| S8 | Existing `end(title)` continues to work (backward compat) | Regression safety | Existing callers using title-based end must not break |

### Group T: DashboardScreen — Multi-Active UI (~12 tests)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| T1 | Dashboard renders N active task cards for N active entries | Core UI change | Proves the list rendering works |
| T2 | Each active card displays its own title | Correct per-task display | Prevents title mix-up |
| T3 | Each active card has independent elapsed time display | Per-task timer | Timers must not share state |
| T4 | Each active card has its own Pause/Resume button | Independent controls | Each task independently controllable |
| T5 | Each active card has its own End button | Independent ending | One End must not affect other tasks |
| T6 | Ending one active task removes its card, others remain | Partial completion | Ending task A leaves task B visible |
| T7 | Ending last active task → all cards gone, empty state if no uncommitted | Clean state transition | Empty-state logic still works |
| T8 | "New Task" button available while tasks are running | Capture while active | Users must be able to start tasks regardless of active count |
| T9 | Capturing new task while one active → second card appears | Live addition | Newly captured tasks must appear immediately |
| T10 | All active cards are visible in scrollable viewport | Scroll overflow | Many tasks must not push cards off-screen |
| T11 | Pausing one task does not affect elapsed display of other | Timer isolation | Pause must be per-task, not global |
| T12 | Active tasks section header says "Running" (plural OK) | Section labeling | Header remains appropriate for 1 or N tasks |

### Group U: Integration — Multi-Active End-to-End (~3 tests)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| U1 | Start task1 → start task2 → both in dashboard → end task1 → task2 remains → end task2 → empty state | Full lifecycle | Proves complete multi-active flow |
| U2 | Start two tasks → pause first → elapsed of paused freezes, running keeps ticking | Timer correctness | Pause isolation across tasks |
| U3 | Start three tasks → end all → getEntries() filters correctly (none active) | Data consistency | Data layer and UI stay synchronized |

## Summary

| Group | Tests | Area |
|-------|-------|------|
| S | 8 | SyncService multi-active API |
| T | 12 | DashboardScreen multi-active UI |
| U | 3 | Integration / end-to-end |
| **Total** | **23** | |

## Files Affected (expected)

| File | Change |
|------|--------|
| `lib/data/sync/sync_service.dart` | `getActive()` return type; add `endByEntryId`, `pauseByEntryId`, `unpauseByEntryId` |
| `lib/features/dashboard/dashboard_screen.dart` | `_activeTask` → `_activeTasks` list; per-task cards, per-task timers |
| `test/data/sync/sync_service_test.dart` | Group S assertions |
| `test/features/dashboard_screen_test.dart` | Group T assertions (expand Group E) |
| `test/features/dashboard_screen_test.dart` (or new integration file) | Group U assertions |
