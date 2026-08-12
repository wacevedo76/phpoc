# Ledger Auto-Pull on Ownership-Handoff Reauth — Implementation Plan

> **Type:** Implementation blueprint (Phase 1 of the 4-phase TDD workflow for this workstream)
> **ADR:** `docs/design/ARCHITECTURAL_DECISIONS.md` §ADR-030
> **Status:** ✅ Complete — 4-phase TDD done (2026-08-11); Phase 4 REFACTOR landed. One follow-on gap tracked in BACKLOG (Scenario-5/6 `dropLedgerCommitted` not yet wired into the handoff reconcile).
> **Session link:** `../../SESSION_HANDOFF.md` (kickoff reference for this plan)

## Purpose

Make a device, after the user **re-authenticates on a device switch**, see **both** the
ledger's last state and the staging scratchpad's last state, automatically — without an
extra manual step. This is ADR-030's owned workstream.

**In scope (this plan):**

1. **Ledger auto-pull on ownership-handoff reauth** — pull the remote ledger only when a
   device switch is detected (cookie specifier mismatch, or fresh no-cookie claim), using a
   **plain block-count freshness detector** so an unchanged chain is never re-downloaded.
2. **Scenario-5/6 staging cleanup** — after the local ledger is current, reconcile local
   staging rows that are missing from remote: if the activity_id is in the local ledger →
   delete from staging; if not → keep/push.
3. **User-initiated "Commit to Ledger" that** seals the block, **auto-pushes the ledger to
   Remote**, and **wipes committed rows from staging** (local + remote) per D11.

**Out of scope (this plan):**

- Changing the MK derivation or the cookie specifier semantics (ADR-001/022 divergence —
  documented in ADR-030, not resolved here).
- Ledger pull on TTL-expiry-with-matching-specifier (same-device aging out) — explicitly
  excluded to avoid re-download churn.
- CLI/Web parity implementation (documented as a protocol rule; Flutter is the concrete target).

## Background / Current Behavior

- Staging auto-sync already pulls+merges remote staging (`checkAndSync`), so **staging** last
  state mostly works (running/uncommitted rows arrive).
- **Ledger committed history does NOT** arrive via staging — R4 filters `committed:true` rows
  on both push and merge. Only a manual "Push Ledger to Cloud" (`LedgerPushService.pushAll`) +
  `LedgerPullService` step moves blocks.
- `commitEntries()` marks rows `committed:true` and keeps them locally (for History), but does
  **not** wipe them from staging, and does **not** auto-push the new ledger blocks. Both
  contradict D11's move-semantics and the user's stated goal.

## Architecture Decisions (from the confirmed discussion)

- **Trigger of ledger pull = ownership handoff only.** `checkAndSync` REAUTH via specifier
  mismatch, or a fresh reconcile-and-claim.
- **Skip trigger = valid-cookie fast path, or TTL-expiry-with-matching-specifier.**
  Requirement: **preserve the last-known specifier across TTL expiry** so the expired path can
  still distinguish "same device aged out" (no pull) from "different device claimed" (pull).
- **Freshness = block-count equality** via `ledger/hash_index.json` length vs local count.
  Equal → skip; greater → pull missing blocks.
- **Ordering = ledger first, then staging reconcile**; fail-safe: never delete local staging
  rows on unverified ledger info.
- **Commit = user-initiated; move semantics**: seal → auto-push blocks → wipe committed rows
  from staging (local + remote).

## Files / Modules Affected (planned)

| File | Change (Phase 3 target) |
|---|---|
| `lib/data/sync/sync_service.dart` | `checkAndSync()` — gate ledger-pull on handoff; preserve specifier across TTL-expiry; trigger `LedgerPullService` at the handoff point; `commitEntries()` auto-push ledger + wipe committed staging rows |
| `lib/services/ledger_pull_service.dart` | Add/expose a "pull ledger if remote block-count > local, else no-op" entry point (reuse existing pull-all, add fresher count check) |
| `lib/data/sync/merge_engine.dart` | Scenario-5/6: consult local ledger hash index — delete local-only-remote-missing committed-in-ledger rows; keep non-ledger local rows |
| `lib/data/sync/device_cookie.dart` | Preserve prior specifier across TTL (A2 refinement) for handoff detection |
| `lib/features/sync/sync_screen.dart` | Ensure reauth success runs the handoff ledger-pull (wire into `_promptReauth` completion already calls `_syncNow`) |

## Test Groups (Phase 2 RED candidates — to be refined after file inspection)

### Group L1: Ownership-Handoff Ledger Pull

| ID | Assertion |
|----|-----------|
| L1.1 | Cookie specifier mismatch → REAUTH → on success, pulls remote ledger when remote block-count > local |
| L1.2 | Fresh no-cookie reconcile-and-claim → pulls remote ledger |
| L1.3 | TTL-expiry with unchanged specifier → does NOT pull ledger (same device) |
| L1.4 | Valid-cookie fast path → does NOT pull ledger |

### Group L2: Block-Count Freshness

| ID | Assertion |
|----|-----------|
| L2.1 | Remote hash_index length == local block count → no block download |
| L2.2 | Remote hash_index length > local block count → pulls only missing blocks |
| L2.3 | Remote hash_index absent/empty → treat as no change (no download) |

### Group L3: Scenario-5/6 Staging Cleanup (ledger-aware)

| ID | Assertion |
|----|-----------|
| L3.1 | Local-only row, absent remote, activity_id IN local ledger → deleted from staging |
| L3.2 | Local-only row, absent remote, activity_id NOT in ledger → kept and pushed |
| L3.3 | Remote-only committed row → filtered (cleanup signal) |
| L3.4 | Ledger pull/verify fails → local staging rows preserved (fail-safe, no delete) |

### Group L4: Commit → Auto-Push Ledger + Wipe Staging

| ID | Assertion |
|----|-----------|
| L4.1 | User commit seals new block |
| L4.2 | User commit auto-pushes the new ledger block(s) to Remote |
| L4.3 | User commit removes committed rows from local staging (moved, not kept) |
| L4.4 | User commit propagates remote staging cleanup so stale devices reconcile them away |
| L4.5 | Pre-commit edits to staged activities are allowed; commit is the only promotion path (D11) |

## Documentation Impact (per Documentation Impact Contract)

| Doc | Action |
|-----|--------|
| `docs/design/ARCHITECTURAL_DECISIONS.md` | **Done (Phase 1):** added ADR-030 |
| `docs/planning/AGENTS.md` | Add this plan to the planning index |
| `docs/planning/BACKLOG.md` | Add a paused entry for the not-yet-started phases, or track as 🔜 |
| `docs/reference/CROSS_CLIENT_STAGE_SYNCING_REFERENCE.md` | Protocol rule: pull ledger on ownership-handoff reauth (§12 parity) |
| `SESSION_HANDOFF.md` | Reference this plan + current status (done in kickoff) |
| `docs/reference/CHANGELOG.md` | On release (post-implementation) |
| `docs/planning/ROADMAP.md` | Status update once implemented |

## Next Steps (Phase 2 RED)

1. Load the TDD skill + re-read the applicable DOX chain for `lib/data/sync` and `lib/services`.
2. Inspect `LedgerPullService` internals and `sync_screen._promptReauth` to confirm where the
   handoff pull hooks.
3. Write RED tests for Groups L1–L4 in the appropriate test files
   (`sync_service_row_level_test.dart` or a new `ledger_auto_pull_on_reauth_test.dart`).
4. Implement the Phase 3 changes above; run FULL suites to guard against regressions.
5. Phase 4 REFACTOR; docs closeout.

## Verification Gate

- Full Flutter suite GREEN (no new regressions beyond documented pre-existing failures).
- A controlled live test on the **testing Worker** (`phpoc-staging-testing`) proving the
  handoff pull−ledger-then-staging flow with a shared seed.
- `flutter analyze` clean on changed files.
