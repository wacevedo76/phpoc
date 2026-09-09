# C1 — Web Restore Stops Skipping `active` Rows — Test Exploration (Phase 1)

> **Plan:** `docs/planning/CROSS_CLIENT_STAGING_CONVERGENCE_PLAN.md` (C1, client-local, ship first)
> **Purpose:** Blueprint of all needed test assertions before writing any test code.
> **Status:** ✅ Phase 1 (test exploration) DONE → ✅ Phase 2 (RED) DONE (2026-09-07) → ✅ Phase 3 (GREEN) DONE (2026-09-07) → ✅ Phase 4 (REFACTOR) DONE (2026-09-07)
> **Next Phase:** ✅ C1 COMPLETE — next is C2 (Web periodic + focus pull).

## Architecture Overview

`connectToWorker` (`phpoc-web/src/context/DevModeContext.jsx`, ~line 1008) performs the fresh
restore-from-cloud. After fetching the full committed chain into `ledger:blocks`, it pulls the
remote staging blob and loops over raw rows with an **ad-hoc filter + normalize + DTO** pipeline:

```js
for (const row of rawRows) {
  const status = row.activity_status || row.is_active;
  if (status === 'active' || row.is_active === true) continue;  // ← C1 bug
  if (row.committed === true) continue;
  // …synthesize canonical row, canonicalRowToDTO, push
}
```

The `if (status === 'active' || row.is_active === true) continue;` line **drops every in-progress
row** on a fresh Web restore, so a Web session shows "No active tasks" even though Flutter/CLI
pushed an active row to the shared blob.

Two correct reference paths already exist that do **not** skip active rows:

1. **Web sync path** — `SyncService._mergeRemoteIntoLocal` (`src/sync/sync.js:987`):
   `_rowsFromRemoteBlob(remoteBlob, now)` → `mergeRows(localRows, remoteRows)` →
   `canonicalRowToDTO` → committed-filter → `writeEntries`. `mergeRows`
   (`src/sync/row_sync.js`) includes remote-only rows **unconditionally** (rule 6), so an active
   remote row survives.
2. **CLI** (`domain/staging/service.py::_merge_remote_into_local`, ~line 996):
   `_remote_entries_to_dtos` → `dtoToCanonicalRow` → `merge_rows` → committed-filter. Same shape,
   no active skip. **CLI already imports active rows** — C1 aligns Web to CLI, not a new contract.

### Convergence design (Phase 3 target)

Extract the sync path's remote-blob conversion into a shared, exported helper and reuse it in
`connectToWorker`, replacing the ad-hoc loop entirely:

1. Export `_rowsFromRemoteBlob` from `sync.js` as `rowsFromRemoteBlob(remoteBlob, now)` — handles
   both canonical (`{activity_id, activity, …}`) and legacy (`{hash, data:{…_enc}}`) formats, no
   active skip.
2. In `connectToWorker`, replace the loop with:
   `rowsFromRemoteBlob(stagingData, now)` → `mergeRows([], rows)` (fresh restore = empty local) →
   `canonicalRowToDTO` → filter `!committed` → `LocalCache.writeEntries`.
3. Update the test mirror `connectFullChain` in
   `phpoc-web/test/worker_connect_fullchain_regression_test.mjs` to use the same shared helper
   (its inlined loop currently mirrors the active skip — stale after the fix).

This makes the restore path and the sync path share one canonical merge, so the active-row
divergence cannot regress. No wire format, PHPSPEC, or Worker change (client-local).

## Test Groups

### Group A: Active rows imported (core C1 fix) — ~6 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | `rowsFromRemoteBlob` keeps a canonical `activity_status:'active'` row (survives conversion, status preserved) | Active rows are no longer dropped at conversion | The skip lived at conversion; the shared converter must pass active through |
| A2 | `mergeRows([], rows)` keeps a remote-only active row with `activity_status:'active'` | Remote-only inclusion (mergeRows rule 6) applies to active rows | Fresh restore has empty local — merge must not filter active |
| A3 | Restored active row → `canonicalRowToDTO` yields `is_active:true`, `committed:false` | Active row renders as active, uncommitted | User-visible "No active tasks" fix depends on `is_active:true` surviving the DTO |
| A4 | Flat/legacy web row `{activity_id, title, start_epoch, is_active:true}` (no `activity` string) restores active | Legacy flat format is not skipped and derives `active` | The old skip caught `row.is_active === true`; the flat format must still import |
| A5 | Canonical row with empty `activity_status` but `activity` blob `is_active:true` restores active | Empty-status fallback derives active (fail-safe) | `dtoToCanonicalRow`/`_deriveStatusFromDTO` must drive the fallback, not the removed skip |
| A6 | Two distinct active rows (different `activity_id`s) both survive restore | No cross-id collapse/drop | Multi-active is a legitimate state; distinct ids must not dedup |

### Group B: mergeRows convergence (route through mergeRows) — ~5 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | `connectToWorker` staging restore and `_mergeRemoteIntoLocal` (empty local) produce identical canonical row sets for the same blob | Restore and sync share one merge | Structural parity prevents future drift between the two paths |
| B2 | `rowsFromRemoteBlob` handles both canonical `{activity_id, activity}` and legacy `{hash, data:{…_enc}}` rows | Shared converter covers both remote formats | Restore must not regress legacy-blob compatibility |
| B3 | Committed display-cache rows (`committed:true`) are still excluded from restored staging | Committed-exclusion unchanged (D11) | Route-through must not re-introduce committed rows into staging |
| B4 | A row both `active` and `committed:true` is excluded | Committed wins over active | Already-sealed rows must not appear as live active tasks |
| B5 | `connectToWorker` no longer contains the active-skip branch (behavioral: active rows appear after a real `connectToWorker`) | The bug line is gone | Guard against the literal regression returning |

### Group C: Status fidelity regression guards — ~4 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | Paused row (`activity_status:'paused'`) restores as paused (`is_paused:true`) | Paused semantics unchanged | Paused was already imported; route-through must preserve it |
| C2 | Ended row (`activity_status:'ended'`) restores as ended (`is_active:false`) | Ended semantics unchanged | Ended was already imported; no terminal-state surprise |
| C3 | Mixed blob `{active, paused, ended, committed}` restores to exactly 3 uncommitted rows | Full status spectrum, committed dropped | One fixture asserts the whole import matrix at once |
| C4 | Active row's `updated_at` survives conversion → merge → DTO rebuild | LWW timestamp fidelity | Future cross-client LWW depends on `updated_at` preservation |

### Group D: Full-chain restore no regression — ~5 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | Full committed chain still stored in `ledger:blocks` (all remote blocks) | History still loads | Route-through must not disturb the chain fetch |
| D2 | Restored staging rows are NOT promoted into the ledger (no D11 auto-commit) | Staging stays a scratchpad | Active rows must not sneak into the committed chain |
| D3 | Committed history still visible via `getCompleted` | History renders committed entries | No regression on the display merge |
| D4 | Uncommitted (non-active) rows still render with full fields (no blank cards) | Field fidelity | Route-through must preserve the write→read round-trip |
| D5 | Restore fails gracefully on wrong passphrase (no partial state) | Auth guard unchanged | The staging section is downstream of genesis verify; no partial writes |

### Group E: CLI reference anchor (VERIFY only — no new code/tests) — ~3 assertions
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | CLI `_remote_entries_to_dtos` + `merge_rows` imports an active remote row as active | Reference behavior already correct | C1 = "align Web to CLI"; anchor must be confirmed |
| E2 | Python `merge_rows` includes remote-only active rows unconditionally | CLI merge parity with Web `mergeRows` | Same rule (remote-only inclusion) must hold on both sides |
| E3 | Web + CLI restored active rows share the canonical `{activity_id, activity_status:'active', activity, updated_at, committed:false}` shape | Byte-shape parity anchor | Preconditions C3/C4 (observe) and CCS vectors later |

## Phase 2 (RED) Result — DONE (2026-09-07)

- **New test file:** `phpoc-web/test/worker_connect_active_rows_test.mjs` — Groups A–D written as
  20 assertions (A 6, B 5, C 4, D 5) via a `rowsFromRemoteBlob` + `mergeRows([], rows)` +
  `canonicalRowToDTO` + committed-filter `restoreStaging` mirror. Group E stays VERIFY-only (no code).
- **Mirror update:** `worker_connect_fullchain_regression_test.mjs` `connectFullChain` staging section
  now routes through the shared `rowsFromRemoteBlob` + `mergeRows` (namespace import
  `syncModule.rowsFromRemoteBlob`) instead of the inlined active-skip loop.
- **RED confirmation:** both suites fail for the right reason — `rowsFromRemoteBlob is not a
  function` (not yet exported). New suite: 0 passed / 4 group-level failures; regression suite
  throws the same `TypeError` at the mirror.
- **Phase 3 note (A4):** the current `_rowsFromRemoteBlob` treats a flat/legacy row
  `{activity_id, title, start_epoch, is_active}` as **canonical** (it has `activity_id` and no
  `data`), so a bare rename/export keeps the row `active` but **drops `title`/`start_epoch`**
  (they live only in the `activity` string, which the flat row lacks). A4's assertion (not dropped,
  derives `active`) passes under a bare export, but full field fidelity for the flat shape needs
  either a flat-row branch or fixture-only coverage — **resolved Phase 3: flat-row branch added.**

## Phase 3 (GREEN) Result — DONE (2026-09-07)

- **`sync.js`:** `_rowsFromRemoteBlob` renamed + exported as `rowsFromRemoteBlob(remoteBlob, now)`.
  Added the flat-web-row branch resolved from the A4 note: a canonical row with `activity_id` but no
  `activity` string synthesizes the activity blob from flat fields (`synthesizeActivityBlob`) so
  `canonicalRowToDTO` keeps title/start_epoch/tags/media. Internal caller `_mergeRemoteIntoLocal`
  switched to the exported name.
- **`DevModeContext.jsx` `connectToWorker`:** the ad-hoc active-skip loop is replaced with the
  shared converter — `rowsFromRemoteBlob(stagingData, Date.now())` → `mergeRows([], rows)` →
  `canonicalRowToDTO` → filter `!committed` → `LocalCache.writeEntries`. Active rows now restore.
- **Test mirror fix (Phase 2 latent bug):** both `connectFullChain` mirrors passed the raw JSON
  **string** to `rowsFromRemoteBlob` (→ `.entries` undefined → `[]`) instead of the parsed object;
  fixed to `rowsFromRemoteBlob(JSON.parse(json), …)` to match production (`JSON.parse(stagingJson)`).
- **GREEN confirmation:** `worker_connect_active_rows_test.mjs` **50/50** (Groups A–D) +
  `worker_connect_fullchain_regression_test.mjs` **23/23**. No regressions: `sync_service` 316,
  `row_sync` 108, `cross_client_web` 78, `ccs2` 41, `staging_alignment` 24, `local_cache` 60,
  `entry_dto_committed` 31, `worker_connect_onboarding` 65, `worker_connect_blocks_format` 56,
  `web_ledger_auto_pull` 17, `entry_dto_updated_at` 2, `local_cache_updated_at` 11, vitest 181/1 skip.
  `vite build` ✅.

## Phase 4 (REFACTOR) Result — DONE (2026-09-07)

- **Conciseness/Modularity:** removed the hand-rolled `synthesizeActivityBlob` helper from `sync.js`
  and reused the existing `dtoToCanonicalRow` converter (already imported and used by the legacy
  `{hash, data}` branch) for flat web rows. The canonical branch is now two clear sub-paths — a
  pass-through for rows already carrying the `activity` string, and `dtoToCanonicalRow` for flat
  rows — eliminating the near-duplicate activity-blob synthesis.
- **Correctness (status fidelity, Group C):** flat rows previously defaulted `activity_status` to
  `active` regardless of their flags; routing them through `dtoToCanonicalRow` makes status derive
  from `is_active`/`is_paused` (flat paused → `paused`, flat `is_active:false` → `ended`), matching
  the legacy branch's semantics. Locked in with 4 new A4b guard assertions.
- **Clarity:** extracted the repeated `(remoteBlob && remoteBlob.device_id) || ''` into a single
  `deviceId` local reused by both the flat and legacy branches.
- **GREEN:** `worker_connect_active_rows_test.mjs` 54/54 (was 50/50) +
  `worker_connect_fullchain_regression_test.mjs` 23/23. No regressions: sync_service 316,
  row_sync 108, cross_client 78, ccs2 41, staging_alignment 24, local_cache 60, entry_dto 31+2,
  worker_connect_onboarding 65, worker_connect_blocks_format 56, web_ledger_auto_pull 17,
  local_cache_updated_at 11; vitest 181/1 skip; `vite build` ✅.

## Summary

- **Total assertions:** 23 (Groups A 6, B 5, C 4, D 5, E 3)
- **New RED tests (Phase 2):** Groups A, B, C, D — Web node test
  `phpoc-web/test/worker_connect_active_rows_test.mjs` (+ update the `connectFullChain` mirror in
  `worker_connect_fullchain_regression_test.mjs` to route through the shared helper).
- **Verification anchor (no new code):** Group E — confirm existing CLI tests
  (`tests/test_phase6a_staging_equivalence.py`, staging merge tests) already assert active import.
- **Key coverage areas:** active-row import, mergeRows convergence, status fidelity, full-chain
  no-regression, CLI parity anchor.
