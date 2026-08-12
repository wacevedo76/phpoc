# Web LEDGER Auto-Pull on Ownership-Handoff Reauth — Test Exploration (Phase 1)

> **Plan:** `docs/planning/LEDGER_AUTO_PULL_ON_REAUTH_PLAN.md` (ADR-030, Groups L1/L3) +
> `docs/planning/SCENARIO56_WIRE_PHASE1.md` (Scenario-5/6 ledger-aware drop) +
> `docs/reference/CROSS_CLIENT_STAGE_SYNCING_REFERENCE.md` §12 (rule #11: pull on handoff)
> **ADR:** `docs/design/ARCHITECTURAL_DECISIONS.md` §ADR-030 (decision #3)
> **Purpose:** Blueprint of all needed test assertions for bringing `phpoc-web` (Web client) in line
> with the Flutter client for Local ⇄ Remote staging/ledger auto-sync, specifically the ADR-030
> **ownership-handoff** ledger-aware flow that Flutter already implements and Web does not.
> **Status:** 🔜 Phase 1 (test exploration)
> **Next Phase:** Phase 2 (RED: test definition) — `.mjs` node-unit tests in `phpoc-web/test/`.
> **Tracked:** `docs/planning/BACKLOG.md` (new); `SESSION_HANDOFF.md` Immediate Next Steps.

---

## What we are porting (and what already exists)

Flutter implements ADR-030 decision #3 (§12 rule #11): on an **ownership handoff** (cookie-specifier
mismatch, or a fresh no-cookie reconcile-and-claim), a device MUST:

1. **Pull the remote ledger first** (block-count/freshness-gated so an unchanged chain is not re-downloaded),
   importing missing blocks and seeding committed staging rows for History, then
2. **Reconcile staging with the local ledger hash index** — drop UNCOMMITTED rows whose `activity_id`
   is already sealed in the local ledger (Scenario 5, so stale scaffolding is not re-pushed as
   scratchpad), while keeping COMMITTED display rows (Scenario 6 / never-empty-History).

The Web client (`phpoc-web/src/sync/sync.js`) currently **does**: cookie/gate `checkAndSync()`,
blob + hash-index fast path, canonical-row `mergeRows` reconcile (CCS-2), `pushLedgerBlocks()`
(ledger push), and on-demand History seeding via `getCompleted()`. It **does NOT**: pull the remote
ledger automatically on a handoff, nor apply a Scenario-5/6 ledger-aware drop during the staging
reconcile. The ledger-pull primitives already exist in
`phpoc-web/src/sync/remote_import.js` (`WorkerImportSource.checkForRemoteChain`,
`fetchChain`); they are simply not wired into `checkAndSync()`/`_reconcileAndClaim()`.

## Seam (where the change hooks)

- **W1 — ledger pull on handoff:** `SyncService._reconcileAndClaim(masterKeyHex)` is invoked after a
  successful reauth (from `_authGatePhase` and `performReauth`). Before it calls
  `_reconcileDifferentDevice(...)`, insert a **block-count-freshness-gated** ledger pull:
  - local count = `(await storage.get(LOCAL_LEDGER_BLOCKS) || []).length`
  - remote count = `await WorkerImportSource.checkForRemoteChain(transport)`
  - if remote > local → `WorkerImportSource.fetchChain(...)` → deobfuscate/verify → persist to
    `LOCAL_LEDGER_BLOCKS` (+ `LOCAL_LEDGER_INDEX`, `LOCAL_HASH_INDEX`) using the same set sequence the
    genesis gate / import path already uses.
  - **fail-safe:** any ledger pull/verify error is swallowed so staging reconcile still runs; never
    delete local staging rows on unverified ledger info.
- **W2 — Scenario-5/6 ledger-aware drop:** after `_mergeRemoteIntoLocal` computes `mergedRows`
  (canonical LWW), compute the set of `activity_id`s sealed in the local ledger (from
  `LOCAL_LEDGER_BLOCKS` day-block entries' `data.activity_id`, mirroring
  `LedgerEngine.ledgerActivityIds()`), and DROP merged rows that are **UNCOMMITTED** whose id is in
  that set, KEEPING committed rows. Empty ledger → strict no-op.

## Test location & harness (Phase 2 decision)

New file `phpoc-web/test/web_ledger_auto_pull_test.mjs` — **node-unit** (`node test/<name>.mjs`),
following the existing `sync_service_test.mjs` harness: `MemoryBackend` + a `MockTransport`
(`map`-backed `pull`/`push`/`delete`/`listFiles`, `queueResponse` for sequential pull,
`_offline`, call-tracking for assertion). A crypto stub that implements `deobfuscateBlob`/
`obfuscateBlob`/`getMasterKey`/`hasMasterKey`/`sha256` is used so no WASM is needed (G1–G6 style:
tests that need WASM are deferred). `LOCAL_LEDGER_BLOCKS` is seeded directly to simulate a sealed
chain (so L3X derivation is a pure unit check on stored blocks).

## Test Groups

### Group W1: Ledger pull on ownership-handoff — ~5 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| W1.1 | After a fresh no-cookie reconcile-and-claim, when remote block-count > local, the remote ledger blocks are pulled and persisted to `LOCAL_LEDGER_BLOCKS`. | Core W1: auto-pull on fresh claim. | Proves the ledger actually arrives on a new device, matching Flutter L1.2. |
| W1.2 | After a cookie-specifier-mismatch reauth succeeds, the remote ledger is pulled when the remote has more blocks. | Core W1: pull on a different-device claim. | Matches Flutter L1.1; ownership handoff is the trigger. |
| W1.3 | When remote block-count == local block-count, NO ledger blocks are re-pulled (freshness gate). | Block-count freshness detector. | Unchanged chain must never be re-downloaded (Flutter L2.1). |
| W1.4 | When the remote ledger is absent/empty, the handoff proceeds as today (no throw, no ledger persisted). | Fail-safe on empty remote ledger. | New device with a bare remote must not break reconcile. |
| W1.5 | If the ledger pull/verify throws (offline / bad crypto), the handoff reconcile still runs (staging is reconciled, no local exception). | Fail-safe: swallowing ledger errors. | Rule from ADR-030: never break a handoff on unverified ledger info (Flutter L3.4). |

### Group W2: Scenario-5/6 ledger-aware staging cleanup — ~5 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| W2.1 | An UNCOMMITTED local-only merged row whose `activity_id` is sealed in the local ledger is dropped (not written/pushed) after the handoff reconcile. | Scenario-5 stale scaffold dropped. | The core parity win — stale scaffolding must not be re-pushed as scratchpad (Flutter L3W.1). |
| W2.2 | An UNCOMMITTED local-only merged row whose `activity_id` is NOT in the ledger survives and is pushed to remote. | Scenario-6 new activity preserved. | Guards against over-deletion; never discard genuine new activity (Flutter L3W.2). |
| W2.3 | A COMMITTED-flagged row with `activity_id` in the ledger is PRESERVED in local staging for History (not dropped, not filtered from display). | Never empty History after handoff. | Semantic decision: drop only UNCOMMITTED sealed rows (Flutter L3W.3). |
| W2.4 | When the local ledger is empty (no blocks), the reconcile behaves exactly as today (no rows dropped). | Empty-ledger fail-safe. | Cleanup must be a strict no-op on a fresh device (Flutter L3W.4 / L3Y.1). |
| W2.5 | The cleanup runs AFTER the LWW merge and BEFORE the remote push — the dropped rows are absent from the pushed remote blob. | Ordering correctness. | Proves the filter is wired into the reconcile pipeline, not just unit-tested (Flutter L3W.1 push assertion). |

### Group W3: Web `ledgerActivityIds` derivation — ~3 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| W3.1 | Day-block entries' `data.activity_id` values are collected into the sealed-id set. | Correct derivation. | Mirrors `LedgerEngine.ledgerActivityIds()`; committed day entries retain `activity_id`. |
| W3.2 | Non-`day`/summary/genesis blocks contribute nothing; days with no entries contribute nothing. | Only day entries seal activity. | Prevents phantom ids from summary/genesis blocks (Flutter L3X.2). |
| W3.3 | Malformed/missing `activity_id` entries are skipped safely (no throw). | Defensive derivation. | `LOCAL_LEDGER_BLOCKS` may surface legacy/foreign blocks (Flutter L3X.3). |

## Summary Report (Phase 1)

- **Total assertions:** 13
- **By group:** Group W1 = 5 (ledger pull on handoff); Group W2 = 5 (Scenario-5/6 cleanup); Group W3 = 3 (Web `ledgerActivityIds` derivation).
- **Files to be created (Phase 2):** `phpoc-web/test/web_ledger_auto_pull_test.mjs` (node-unit, RED).
- **Source files to modify (Phase 3):**
  - `phpoc-web/src/sync/sync.js` — `_reconcileAndClaim()`: add block-count-gated ledger pull (W1) before
    `_reconcileDifferentDevice`; add Scenario-5/6 drop of UNCOMMITTED sealed rows in/after `_mergeRemoteIntoLocal`
    (W2). Add a private `_ledgerActivityIds()` helper (W3) reading `LOCAL_LEDGER_BLOCKS`.
  - `phpoc-web/src/sync/remote_import.js` — likely *reused as-is* (already has `checkForRemoteChain`/`fetchChain`); no change expected unless a gap is found in Phase 3.
- **Key coverage areas:** (1) auto ledger pull on fresh-claim + mismatch-reauth; (2) freshness gate
  (no re-download); (3) fail-safe when ledger pull fails or is absent; (4) Scenario-5 stale-scaffold
  drop; (5) Scenario-6 / committed-display preservation; (6) empty-ledger no-op; (7) robust `activity_id`
  derivation from Web block storage.

## Documentation Impact (Phase 1 plan only — no code yet)

| Doc | Action |
|-----|--------|
| `docs/reference/CROSS_CLIENT_STAGE_SYNCING_REFERENCE.md` | **Done concurrently:** §8.3 stale implementation-status table reconciled (all clients row-level LWW GREEN). |
| `docs/planning/AGENTS.md` | Add this blueprint to the planning index. |
| `docs/planning/BACKLOG.md` | Add a 🟡 entry tracking this Web ADR-030 parity port. |
| `SESSION_HANDOFF.md` | Add this task to Immediate Next Steps (Phase 1 done → Phase 2 RED next). |
| `docs/planning/ROADMAP.md` | No status change yet (per Documentation Impact Contract, only on milestone). |

### Update after Phase 1
- [x] Reference §8.3 table reconciled (part of this task's step 1).
- [ ] This blueprint linked from `docs/planning/AGENTS.md`.
- [ ] BACKLOG entry added.
- [ ] SESSION_HANDOFF Immediate Next Steps updated.
