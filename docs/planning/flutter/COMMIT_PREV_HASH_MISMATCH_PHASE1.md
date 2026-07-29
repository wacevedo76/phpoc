# Commit prev_hash Mismatch Fix — Test Exploration (Phase 1)

> **Plan:** Fix chain.append prev_hash mismatch when committing new entries after blocks with entries-only data_enc
> **Purpose:** Blueprint of all needed test assertions before writing any test code.
> **Status:** ✅ Complete (4-Phase TDD: 5 Phase 4 refactor improvements, 1356/1358 GREEN)
> **Next Phase:** ✅ Done — 4-Phase TDD complete

## Bug Summary

When `_blockToMap` reconstructs a day block whose `data_enc` stores only the entries array (e.g., `[{"data": {...}, "hash": "..."}]`), the cast to `Map<String, dynamic>` fails and falls back to `{}`. Critical block-level fields — most importantly `date` — are lost.

`YearMonthSummaryPolicy.getSummaryBlocks()` reads `prevBlock['date']` which is null, defaults to `"1970-01-01"`, and generates spurious year_summary + month_summary blocks for the 1970→2026 boundary. These summaries produce hashes matching existing summary blocks (inserted by a prior commit), and `INSERT OR IGNORE` silently drops them. The `commit` method continues with the in-memory summary hashes as `prevHash`, but the DB last block is unchanged — causing the `chain.append` bridge linkage check to fail.

**Three bugs interact:**
1. `_blockToMap` loses `date` when data_enc stores entries array → null date propagated
2. `YearMonthSummaryPolicy` defaults null date to `1970-01-01` → spurious summaries
3. `INSERT OR IGNORE` silently drops duplicate summary blocks → DB state ≠ in-memory state

## Architecture Overview

```
Engine.commit()
  ├─ getBlockHash(lastBlock)           ← CORRECT: resolves via DB overlay
  ├─ SummaryPolicy.getSummaryBlocks()  ← BUG: prevBlock['date'] is null → 1970
  ├─ chain.appendBlocks(summaries)     ← SILENT FAIL: INSERT OR IGNORE drops dupes
  ├─ buildDayBlock(prevHash: ...)      ← USES STALE in-memory prevHash
  └─ chain.append(dayBlock)            ← THROWS: prev_hash mismatch
       └─ getBlockHash(last)          ← DB still has old last block
       └─ dayBlock['prev_hash']       ← from in-memory summary, not in DB
```

Key files:
- `data/ledger/store_adapters.dart:126-180` — `_blockToMap()`: fallback reconstruction
- `data/ledger/summary_policy.dart:76-140` — `getSummaryBlocks()`: null date default
- `data/storage/database.dart:501` — `insertBlockSync()`: `INSERT OR IGNORE`
- `data/ledger/engine.dart:59-113` — `commit()`: uses in-memory prevHash after appendBlocks

## Test Groups

### Group AB: `_blockToMap` — Entries-Only data_enc Reconstruction — ~5 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| AB1 | `_blockToMap` recovers `date` from first entry's start_epoch when data_enc is entries array | Ensures block reconstruction includes date for summary policy | Without date, summary policy generates spurious blocks. Date is derivable from entries' start_epoch. |
| AB2 | `_blockToMap` recovers `entries` field when data_enc is entries array | Ensures entries survive roundtrip | Downstream code reads block['entries'] for verification and revert. Empty entries break those paths. |
| AB3 | `_blockToMap` preserves empty entries array (data_enc = `[]`) | Handles edge case of summary blocks or day blocks with no entries | Summary blocks and some legacy day blocks have empty entries. Must not crash. |
| AB4 | getBlockHash() returns non-empty hash for block reconstructed from entries-only data_enc | Chain linkage depends on resolvable hashes | Currently DB overlay sets day_hash correctly, but verify it via public API. |
| AB5 | Full roundtrip: appendBlock with entries-only data_enc → readBlocks → date is recoverable | Integration test for the full store adapter pipeline | Verifies the end-to-end reconstruction works with the fake DAO. |

### Group AC: `_blockToMap` — date Derivation Edge Cases — ~3 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| AC1 | When data_enc is entries array with multiple entries, use earliest start_epoch | Deterministic date for blocks with multi-entry days | The commit grouping would put all entries from the same date in one block, so earliest is correct. |
| AC2 | When data_enc is entries array and entries have no start_epoch, fall back to epoch 0 → 1970-01-01 | Graceful degradation for corrupted data | Avoids crash; 1970-01-01 is the explicit sentinel for "unknown date". |
| AC3 | When data_enc is a valid block map (not entries array), date from data_enc is preserved (not overwritten) | Regression guard: correctly-formatted blocks must not be affected | The fix must only apply to the entries-array fallback path. |

### Group AD: `YearMonthSummaryPolicy` — Null Date Handling — ~3 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| AD1 | getSummaryBlocks with prevBlock missing `date` field returns empty summaries when currDate matches block period derivable from other fields | Prevents spurious summary generation for blocks with lost date | The fix to _blockToMap makes this mostly redundant, but the policy should be robust to missing date. |
| AD2 | getSummaryBlocks with prevBlock date='1970-01-01' (sentinel) does not generate summaries for every future commit | 1970-01-01 is the explicit "unknown" sentinel | Without this guard, every commit after a reconstructed block would generate year/month summaries for all 56 years between 1970 and now. |
| AD3 | getSummaryBlocks with prevBlock having null date does not crash | Defensive coding: null date should not throw | Currently null.date causes parse error in _parseDate. Must be handled gracefully. |

### Group AE: Commit with Entries-Only Blocks in Chain — ~4 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| AE1 | commit succeeds when previous day block has entries-only data_enc (no date field in data_enc map) | End-to-end regression test for the reported bug | This is the exact reproduction: chain has entries-only blocks, user tries to commit new entries. |
| AE2 | commit does NOT insert duplicate summary blocks when they already exist in chain | Verifies INSERT OR IGNORE → INSERT fix | After summaries exist, a second commit for the same month should not generate new summaries or fail. |
| AE3 | commit returns correct hash prefix after successful commit in entries-only chain | Smoke test for return value correctness | Ensures the fix doesn't break the hash prefix contract. |
| AE4 | Full chain with 2 commits on different dates: entries-only block → commit → another commit → chain.verify() passes | Chain integrity after multiple commits | The chain must remain verifiable after the fix. |

### Group AF: Database INSERT Conflict Handling — ~2 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| AF1 | insertBlockSync throws on duplicate block_id (not silently ignored) | Replaces INSERT OR IGNORE with INSERT | Silent ignore is the root cause of the state mismatch. An exception should surface the conflict. |
| AF2 | appendBlocks rolls back on duplicate (transactional safety) or detects conflict before insert | Data integrity: partial insert of summary batch must not happen | If year_summary succeeds but month_summary fails, the chain is corrupted. |

## Summary

| Group | Area | Tests |
|-------|------|-------|
| AB | _blockToMap entries-only reconstruction | 5 |
| AC | _blockToMap date derivation edge cases | 3 |
| AD | SummaryPolicy null date handling | 3 |
| AE | Commit with entries-only chain | 4 |
| AF | INSERT conflict handling | 2 |
| **Total** | | **17** |

## Notes

- All tests go in `phpoc-flutter/test/data/ledger/store_adapters_test.dart` (AB, AC), `phpoc-flutter/test/data/ledger/summary_policy_test.dart` (AD), and `phpoc-flutter/test/data/ledger/engine_test.dart` (AE)
- Group AF tests go alongside the existing BlockDao tests or in a new DB-level test file
- AF2 may be deferred if transactions require significant restructuring — the minimum fix is AF1 (INSERT not INSERT OR IGNORE)
- AD2 (1970-01-01 sentinel) is a design decision: treat 1970-01-01 as "unknown date" rather than a real date
- AB1 and AB2 are the critical assertions that directly fix the root cause
