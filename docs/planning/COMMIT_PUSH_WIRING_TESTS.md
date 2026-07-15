# commitEntries → pushLedgerBlocks Wiring — TDD Test Outline

> **Status:** 🟢 GREEN (wiring complete — all 60 assertions pass, 0 failures)
> **Created:** 2026-06-22
> **Completed:** 2026-06-22
> **Regression fixed:** 2026-07-15 — 3 bugs in test infrastructure (storage format, genesis date causing summary insertion, missing decryptWithCachedKey)
> **Test file:** `phpoc-web/test/commit_push_integration_test.mjs`
> **Code modified:** `phpoc-web/src/context/DevModeContext.jsx` (1 line) + `phpoc-web/src/sync/sync.js` (field name compatibility fix)

## Problem

`pushLedgerBlocks()` is implemented and GREEN (76 assertions, 0 failures), but never called. After `commitEntries` creates new ledger blocks via `LedgerEngine.commit()`, those blocks stay local-only. The wiring adds one line to `commitEntries`: call `sync.pushLedgerBlocks()` after `markCommitted`.

## Wiring location

`DevModeContext.jsx`, `commitEntries` callback, after `await sync.markCommitted(...)`:

```js
// Push committed blocks to remote (best-effort; handles all errors internally)
await sync.pushLedgerBlocks();
```

No try/catch needed — `pushLedgerBlocks()` already catches/logs all errors and never throws.

## Remote layout (reference)

```
ledger/blocks/000000.json   ← genesis, obfuscated
ledger/blocks/000001.json   ← day block
ledger/blocks/000002.json
...
ledger/index.json           ← lightweight index, also obfuscated
```

## New Test File: `phpoc-web/test/commit_push_integration_test.mjs`

### Test infrastructure (all already exist)

- `MockTransport` — push/pull/listFiles with error simulation (`_pushFailPath`, `_offline`)
- `MockCrypto` — obfuscateBlob/deobfuscateBlob/seal/sealBlock
- `MemoryBackend` — in-memory key-value storage
- `LedgerEngine` — real engine from `src/ledger/engine.js`
- `TestHelpers` — assert/assertEq/assertNeq/assertDeepEq/summary
- `makeBlock` / `makeIndex` / `readPushedBlock` — helpers from `ledger_sync_test.mjs`

### Category A — Full Commit + Push Flow (5 tests)

Verify that committing staging entries via LedgerEngine produces blocks which are then pushed to a mock remote via pushLedgerBlocks.

| # | Test | Setup | Assertions |
|---|---|---|---|
| A1 | **Commit entries → blocks on remote** | Create 2 staging entries, commit via LedgerEngine, call pushLedgerBlocks | Blocks `000000.json` and `000001.json` exist on transport; genesis block type=genesis; day block has committed entries |
| A2 | **Empty staging → no push** | Commit with no completed entries | pushLedgerBlocks returns 0; no remote listFiles calls |
| A3 | **Incremental commits** | Commit 2 entries → commit 1 more → call pushLedgerBlocks each time | First call: pushes 2 blocks; second call: pushes only 1 new block (block index 2); transport has 3 blocks total |
| A4 | **Round-trip fidelity** | Commit entry with title/comment/tags, push, de-obfuscate from remote | De-obfuscated block has correct entry data (title, startTime, duration, tags preserved through serialization→obfuscation→push→pull→de-obfuscation) |
| A5 | **markCommitted + push correctness** | Commit → readEntries | Committed entries no longer appear in readEntries; getCompleted includes committed entries from chain |

**Existing coverage in `ledger_sync_test.mjs` that A1-A4 build on:** A1 (basic push), A2 (partial push), C2 (round-trip), F2 (reads from storage), G4 (corrupt data handled)

### Category B — Commit Result Preservation (3 tests)

Verify the commit result is returned correctly even as pushLedgerBlocks runs — push is best-effort, commit is authoritative.

| # | Test | Setup | Assertions |
|---|---|---|---|
| B1 | **Result includes committedEntryIds + blockIndex** | Commit 2 entries | Result.committedEntryIds.length === 2; result.blockIndex is a number |
| B2 | **Push fails → commit result still returned** | Transport._pushError = new Error(); commit 2 entries | Blocks in local storage survive; result.committedEntryIds has correct count; pushLedgerBlocks returns 0 (caught internally) |
| B3 | **Already-committed entries → no-op** | Commit entries, then re-commit same entryIds | Second commit returns undefined or early exit; pushLedgerBlocks NOT called a second time with new blocks |

### Category C — Sync Now Integration (3 tests)

Verify the "Sync Now" flow (checkAndSync → commit → push) works end-to-end. This is the path SyncSettings takes.

| # | Test | Setup | Assertions |
|---|---|---|---|
| C1 | **Full Sync Now cycle** | checkAndSync → commit entries → pushLedgerBlocks | Blocks on remote; staging blob on remote; both coexist under different paths |
| C2 | **Staging + ledger paths independent** | Commit + pushLedgerBlocks → capture new entry → pushToRemote | `staging/blobs/current.json` and `ledger/blocks/*.json` both exist; no cross-contamination |
| C3 | **No completed entries → Sync Now no-ops on commit** | checkAndSync with only active entries → commit | commit has nothing to do; pushLedgerBlocks not called (or returns 0); staging blob push still runs |

### Category D — Regression (3 tests)

Verify existing behavior is preserved after wiring.

| # | Test | Setup | Assertions |
|---|---|---|---|
| D1 | **Auto-sync still works after commit** | Commit → capture new staging entry | pushToRemote fired (debounced) for the new staging entry; auto-sync wrapper unaffected |
| D2 | **readEntries() post-commit** | Commit 2 of 3 entries | readEntries returns only the 1 uncommitted entry; committed entries in chain but not staging |
| D3 | **getCompleted() sees committed entries** | Commit → getCompleted | Committed entry appears in getCompleted with committed=true, block_index set |

### Total: 14 tests (~40 assertions)

---

## Execution Plan (TDD)

1. **RED:** Write `commit_push_integration_test.mjs` — all 14 tests
2. **GREEN:** Add `await sync.pushLedgerBlocks()` after `markCommitted` in `commitEntries` (DevModeContext.jsx)
3. Run full suite: verify zero regressions across all 31 existing test files
4. Update docs: `WEB_ROADMAP.md`, `MAP.md`, `SESSION_HANDOFF.md`

## Files affected

| File | Change |
|---|---|
| `phpoc-web/test/commit_push_integration_test.mjs` | **CREATE** — 14 tests |
| `phpoc-web/src/context/DevModeContext.jsx` | **EDIT** — +1 line in `commitEntries` |
| `docs/planning/WEB_ROADMAP.md` | **UPDATE** — build step 45 |
| `docs/reference/MAP.md` | **UPDATE** — new test file |
| `SESSION_HANDOFF.md` | **UPDATE** — mark wiring DONE |
| `docs/planning/PUSHLEDGERBLOCKS_TDD_PLAN.md` | **UPDATE** — add wiring phase |
