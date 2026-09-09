# Plan: Cross-Client Staging Convergence (Web ↔ Flutter ↔ CLI)

> **Status:** 🔜 Planning
> **Created:** 2026-09-06
> **Scope:** Make remote staging converge bidirectionally across all three clients so a row written on one device becomes visible on the others without claiming ownership, and eliminate the cookie handoff race.
> **Contract anchor:** `docs/reference/CROSS_CLIENT_STAGE_SYNCING_REFERENCE.md` §12 (binding state machine) + §12.9 matrix; invariants I2/I3 (byte compatibility), I7 (no network on read-only), D1–D11.
>
> **Merge note (2026-09):** **C4 is merged into ADR-034** — `staging_hash` + `seq` + Worker CAS land in **one** cookie migration. This plan retains C1–C3; C4 is replaced by ADR-034 decision 8 / `STAGING_CHANGE_DETECTION_DESIGN.md` §3a (DS9).

---

## Context (live E2E findings, 2026-09-05/06)

Flutter (emulator) created an activity and auto-pushed it. Web (Vivaldi) did a fresh restore and showed "No active tasks". Four blockers were confirmed live:

1. **Web is push-only.** `useAutoSync` (`src/hooks/useAutoSync.js`) is a 500 ms debounced `pushToRemote`; there is no periodic pull. Flutter has a 5 s `checkAndSync` tick (`sync_service.dart:465`). Web never observes remote rows unless the user presses "Sync Now".
2. **The staging cookie gates both read and write.** `device_specifier` ownership is single-owner for everything; a non-owner gets `REAUTH_NEEDED` and must consent to a handoff just to *see* remote rows.
3. **Web restore skips `active` rows.** `connectToWorker` (`DevModeContext.jsx` ~line 1000) drops `active`/`is_active:true` rows on restore, while `mergeRows` (`row_sync.js`) and the CLI/Flutter canonical merge do not.
4. **Cookie handoff is racy.** `_reconcileDifferentDevice` (`sync.js:909`) pushes a fresh cookie at the end, but Flutter's running 5 s tick re-detected a hash-index diff and re-pushed its own cookie. The cookie PUT is plain last-write-wins (no `seq`, no CAS) — Web's local claim `cf0341a3…` lost to Flutter's re-asserted `a8e8e598…`.

## Governing principle

Every change is either **client-local** (no contract change) or a **protocol change** (alters the §12 state machine or the cookie/wire format). The **CLI is the reference implementation + byte-compatibility anchor** (I2/I3, CCS vectors), so protocol changes are spec-first → CLI-first → parity-ported → gated by cross-client vectors. Client-local changes are implemented directly, and where they touch merge/restore semantics they *converge* toward the CLI's existing behavior.

## Changes

### C1 — Web restore stops skipping `active` rows (client-local, ship first)
- **Phase 1 (test exploration) DONE (2026-09-07):** `C1_WEB_RESTORE_ACTIVE_PHASE1.md` — 23 assertions (A active-import 6, B mergeRows convergence 5, C status fidelity 4, D full-chain no-regression 5, E CLI anchor 3). **✅ Phase 2 (RED) DONE (2026-09-07):** `worker_connect_active_rows_test.mjs` (Groups A–D, 20 assertions) + `connectFullChain` mirror routed through shared `rowsFromRemoteBlob`/`mergeRows`; both RED for the right reason (`rowsFromRemoteBlob is not a function`). **✅ Phase 3 (GREEN) DONE (2026-09-07):** `rowsFromRemoteBlob` exported from `sync.js` (+ flat-web-row `synthesizeActivityBlob` branch) and the ad-hoc active-skip loop replaced in `connectToWorker`; `worker_connect_active_rows_test.mjs` 50/50 + `worker_connect_fullchain_regression_test.mjs` 23/23 GREEN, no regressions. **✅ Phase 4 (REFACTOR) DONE (2026-09-07):** flat rows reuse `dtoToCanonicalRow` (status derives from `is_active`/`is_paused`); `worker_connect_active_rows_test.mjs` 54/54 + `worker_connect_fullchain_regression_test.mjs` 23/23 GREEN. **C1 COMPLETE → next C2.**
- Remove `if (status === 'active' || row.is_active === true) continue;` from `connectToWorker` in `DevModeContext.jsx`, routing restore through the same `mergeRows` used by the sync path.
- **CLI impact:** none — CLI already imports active rows. This *aligns Web to CLI*, not a new contract.
- **Verify:** existing `tests/test_phase6a_staging_equivalence.py` + `cross_client_web_test.mjs` (no new vectors needed; it removes a divergence).

### C2 — Web foreground/focus pull (client-local, event-driven)
- Add an **event-driven** `checkAndSync`-based pull on `visibilitychange`/`focus` (and screen
  mount) so an idle Web session converges to remote when the user returns to the tab. Per
  ADR-034 decision 4 this is **event-triggered, not a periodic timer** — the continuous-poll variant
  (mirroring Flutter's `PERIODIC_AUTO_SYNC_TIMER_PHASE1.md`) is superseded; the `staging_hash`
  gate (ADR-034) is what makes each pull cheap.
- **CLI impact:** none — the CLI is command-driven; its per-command pull trigger is C3's observe branch.
- **Verify:** new Web hook test + manual Vivaldi E2E (Flutter push → Web converges without Sync Now).

### C3 — Read-only "observe" mode (protocol change, CLI-first)
- Add an `OBSERVE` branch to the §12 state machine: pull the device cookie → if
  `staging_hash` changed (ADR-034 decision 8), pull blob + `mergeRows` into local → `READY`, with
  **no push and no cookie claim**.
- Reconcile with **I7** explicitly: observe uses **`staging_hash`** (ADR-034) for change
  detection — not the coarse hash-index (Tier-1, ADR-024), which misses content edits — so
  read-only commands stay cheap and only hit the network on actual change.
- Implement in the CLI first: extract the pull+merge half of `_reconcile_and_claim` (`service.py:897`) into a shared helper reused by observe and claim. This **extends** `CLI_READONLY_STAGING_SYNC.md` (currently CLI-only) to a unified spec-level mode, then parity-port to Web (`_reconcileDifferentDevice`, `sync.js:909`) and Flutter (`_reconcileAndClaimRowLevel`, `sync_service.dart:648`).
- **Offline-lenient (D6):** a failed observe pull degrades to `READY`/local-only, never an error.
- **Verify:** PHPSPEC §8 + §12 update, CLI tests, Web + Flutter parity tests, CCS-5-style cross-client pass.

### C4 — Device cookie `seq` + Worker CAS — **MERGED into ADR-034 (2026-09)**
- ~~Add a monotonic `seq` to the cookie (all three clients' cookie schema + `push_cookie`), reject stale writes at the Worker (`if seq < current → 409`), and treat legacy cookies without `seq` as `seq=0` (D9 backward compat).~~ **Superseded** — this is now **ADR-034 decision 8 / `STAGING_CHANGE_DETECTION_DESIGN.md` §3a (DS9)**: `seq` + `staging_hash` land in **one** cookie migration `{device_uuid, device_specifier, staging_hash, seq}`.
- **CAS rule (final, ADR-034 §3a):** a cookie PUT whose `seq` is present and `<=` the stored `seq` is rejected (`409`); legacy cookies *without* `seq` are accepted last-write-wins (CAS applies only when `seq` is present — old clients are never broken). `seq` = a single monotonic counter on the cookie object (resolves D-C4-1).
- **CLI impact:** `device_cookie.py` + `_push_cookie` (`service.py`), plus Worker guard — now part of the ADR-034 implementation (`STAGING_CHANGE_DETECTION_PLAN.md`), not a separate effort.
- **Verify:** folded into ADR-034's parity vectors + a stale-write rejection pass (CCS-5-style).

## Sequencing

```
Phase 1 (no contract change)     C1 → C2
Phase 2 (first protocol change)  C3  (spec → CLI → Web → Flutter → vectors)
Phase 3 (cookie migration)       C4  → MERGED into ADR-034 (`staging_hash` + `seq` + CAS, one migration)
```

## Definition of done

The §12.9 matrix all-GREEN across CLI/Web/Flutter + Worker, with byte-identical hash-index/blob/cookie outputs (I2/I3) — the same bar as CCS-4. Each protocol change (C3, C4) carries its own PHPSPEC/ADR diff, CLI reference implementation, parity ports, and cross-client vectors.

## Open decisions

- **D-C3-1:** Is observe mode opt-in per command (CLI) / always-on for idle sessions (Web/Flutter), or gated by a `staging_hash` change check only? (I7 tension.)
- ~~**D-C4-1:** Cookie `seq` semantics — per-device monotonic vs. global; CAS response shape for stale writes.~~ **RESOLVED (ADR-034 §3a):** single global counter on the cookie object; `409` + re-pull + re-merge + one retry.

## Relation to existing plans

- `CLI_READONLY_STAGING_SYNC.md` — C3 generalizes this CLI-only read-only pull into the spec-level observe mode.
- `ALIGN_WEB_STAGING_SHARING_WITH_CLI.md` — the write-path auth-gate/re-auth alignment (Phase 1a done); C1/C2/C3 build on it.
- `STAGING_AUTO_SYNC_PLAN.md` / `flutter/PERIODIC_AUTO_SYNC_TIMER_PHASE1.md` — Flutter's bidirectional pull is the template for C2.
- `CROSS_CLIENT_REMOTE-LOCAL_STAGING_SYNC-RECONCILIATION_PLAN.md` — the authoritative CCS implementation plan; this plan is a follow-on convergence pass.
- `docs/design/STAGING_CHANGE_DETECTION_DESIGN.md` (ADR-034) + `STAGING_CHANGE_DETECTION_PLAN.md` — the merged `staging_hash` + `seq` + CAS cookie migration (C4).
- `docs/reference/CROSS_CLIENT_STAGE_SYNCING_REFERENCE.md` §12 — the binding state machine these changes extend.
