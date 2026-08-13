# Cross-Device Activity-End Propagation — Test Exploration (Phase 1)
> **Plan:** Row-level staging sync (`docs/planning/ROW_LEVEL_STAGING_SYNC_PLAN.md`) + live bug found on-device
> **Purpose:** Blueprint of test assertions for making a device that still treats an activity as `active` adopt a remote `ended` state — fixing end-propagation across devices.
> **Status:** ✅ Phase 1 (test exploration) COMPLETE
> **Next Phase:** ✅ Phase 2–4 COMPLETE (RED/GREEN/REFACTOR done 2026-08-19, see planning/AGENTS.md)

## Problem Statement
On-device (emulator ↔ phone via the DEV Worker), an activity "Working on phpoc"
(`activity_id GXmRySa0EE`) was stopped on the **emulator** (→ `ended`, pushed to
remote), but the **phone** kept showing it as **Running**. Root cause (proven with a
focused probe): `MergeEngine.mergeEntries` applies a **pure LWW on `updated_at`** with no
preference for terminal states. A device with a *newer local `active` copy* of an
activity the remote has already `ended` will keep its local `active` copy — the remote
`ended` transition is **silently discarded forever**, so end-propagation stalls.

This is a **cross-device end-propagation bug**: `ended` is a **terminal, irreversible**
transition of an activity. A conflicting `active`/`paused` copy from another device must
yield to `ended` (the activity cannot re-open on a peer just because that peer's local
copy carries a newer `updated_at`).

## Fix Design
In `mergeEntries`, when local and remote share an `activity_id` and **exactly one side is
`ended`** while the other is `active`/`paused` or unset, the **`ended` row wins** for the
latest state — regardless of `updated_at`. All other cases (both `active`, both `ended`,
one side missing) keep the existing LWW-on-`updated_at` behavior. The existing
committed-flag irreversibility rule is preserved for every branch.

## Modules
- `phpoc-flutter/lib/data/sync/merge_engine.dart` — `MergeEngine.mergeEntries` (the only change).
- `phpoc-flutter/test/data/sync/merge_engine_overhaul_test.dart` — Group K (new assertions).

## Test Groups

### Group K: Terminal-state preference in mergeEntries — ~6 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| K1 | local `active` + remote `ended`, remote older → merged `ended` | Ending wins even when local copy is `updated_at`-newer | THE missing rule: a device that still has a newer `active` copy must adopt a peer's `ended` |
| K2 | local `active` + remote `ended`, remote newer → merged `ended` | `ended` wins on its own (LWW would already do this) | Regression guard for the symmetric active/ended LWW case |
| K3 | local `paused` + remote `ended`, local newer → merged `ended` | `paused` (non-terminal) also yields to `ended` | Paused is not terminal; a peer's end still must apply |
| K4 | both `ended` → newest `updated_at` wins (unchanged LWW) | Preserve existing ended/ended resolution | No behavior change when both sides agree the activity is over |
| K5 | both `active` → newest `updated_at` wins (unchanged LWW) | Preserve existing active/active resolution | No behavior change when no terminal state is involved |
| K6 | local `active` + remote `ended` → the winner carries the ended `end_epoch`/duration | Data of the `ended` row survives, not just the status flag | The peer must end up with correct end time, not just a status flip |

### Group K-INT (integration guard): combined row set — 1 test
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| K-INT1 | Mixed set: active-only + active/ended-conflict + both-ended → each resolved independently, committed flags preserved | Full reconcile respects the rule per activity_id, not just in isolation | Guards against the fix accidentally affecting unrelated rows |

## Summary
- **Total assertions:** 7 (Group K: 6, Group K-INT: 1)
- **Groups:** MergeEngine.mergeEntries terminal-state preference + integration.
- **Key coverage:** the exact on-device failure (K1) and no-regression guards (K2–K6, K-INT1).
- **Out of scope:** the device-cookie/reauth path (separate concern, see handoff).
