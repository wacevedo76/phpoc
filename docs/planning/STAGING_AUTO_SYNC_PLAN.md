# Staging Auto-Sync — Plan

> **Status:** 🔜 Queued (after CCS-4)
> **Depends on:** CCS-2 (Web), CCS-3 (CLI), CCS-4 (E2E testing)
> **Scope:** Flutter — upgrade debounced auto-push to full bidirectional staging sync

## Problem

The SyncService already has a debounced auto-push: every staging mutation (`capture`,
`end`, `pause`, `unpause`, `modify`, `remove`) calls `_schedulePush()` → `_doPush()`
→ `_pushStagingRowsToRemote()`. But this is **push-only** — it pushes local staging
up to the Worker but never pulls remote staging down. The manual "Sync Staging" button
(`checkAndSync()`) does the full bidirectional merge, but it requires the user to
remember to tap it.

## Change

In `_doPush()`, replace the push-only `_attemptPush()` call with `checkAndSync()`:

```
Before: _doPush() → _attemptPush() → _pushStagingRowsToRemote()  [push only]
After:  _doPush() → checkAndSync()                                [pull + merge + push]
```

`checkAndSync()` already handles:
- **Fast path** (valid cookie): hash-index compare → push only if changed (efficient)
- **Full reconcile** (no cookie): pull remote, LWW merge, push back (bidirectional)
- **No transport / no MK**: no-ops

The one edge case: `checkAndSync()` can return `reauthNeeded` (cookie expired/conflict).
In auto-sync, we just skip silently — no UI prompt.

## Test Coverage

### Existing Tests (auto-push trigger — push-only)

From `sync_service_overhaul_test.dart`:

| ID | Assertion | What it verifies |
|----|-----------|-----------------|
| D2 | `capture()` calls `_schedulePush()` after write | Debounce triggers after capture |
| D4 | `end(activityId)` calls `_schedulePush()` after write | Debounce triggers after end |
| D6 | `pause(activityId)` calls `_schedulePush()` after write | Debounce triggers after pause |
| D8 | `unpause(activityId)` calls `_schedulePush()` after write | Debounce triggers after unpause |
| D10 | `modify(activityId, fields)` calls `_schedulePush()` after write | Debounce triggers after modify |
| D12 | `remove(activityId)` calls `_schedulePush()` after write | Debounce triggers after remove |

All 6 verify `transport.pushedBlobs.isNotEmpty` — i.e., "something got pushed."
They do NOT verify that remote entries are pulled or merged.

### Missing Tests (bidirectional auto-sync)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| AS1 | Auto-sync after `capture()` pulls remote staging entries and merges them locally | Bidirectional merge on auto-push | Core behavior change: remote data must appear locally without manual button press |
| AS2 | Auto-sync handles `reauthNeeded` silently (no throw, no UI prompt) | Graceful degradation | Cookie conflicts should not crash or disrupt the user during auto-sync |
| AS3 | Auto-sync no-ops when no transport configured | Local-only safety | Should not throw or schedule work when `transport == null` |
| AS4 | With valid cookie, auto-sync uses fast path (hash-index compare, push only if needed) | Efficiency | Existing `checkAndSync()` fast path must be exercised in auto-sync context |

**Total: 4 new tests** (AS1–AS4), all in `sync_service_overhaul_test.dart`.

## Files to Modify

| File | Change |
|------|--------|
| `phpoc-flutter/lib/data/sync/sync_service.dart` | `_doPush()`: call `checkAndSync()` instead of `_attemptPush()` |
| `phpoc-flutter/test/data/sync/sync_service_overhaul_test.dart` | Add AS1–AS4 |

## Dependencies

- CCS-2 (Web row-level sync) must land first — ensures remote staging format is stable
- CCS-3 (CLI row-level sync) must land first — ensures Worker path is canonical
- CCS-4 (E2E testing) must land first — ensures all clients agree on blob format
