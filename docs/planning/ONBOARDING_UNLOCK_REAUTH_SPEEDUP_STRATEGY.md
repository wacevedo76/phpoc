# Onboarding / Unlock / ReAuth Speedup Strategy

> **Status:** 🔜 PLANNING — Phase 1 (test identification)
> **Created:** 2026-06-30
> **Goal:** Replace full-ledger block pulls during genesis check with a lightweight hash-index comparison. Cut Phase 3 from ~21s (200 blocks) to ~0.1s (common case: no changes). 210× speedup.

---

## Strategy Overview

### Problem

`GenesisGate.check()` currently pulls every block from R2 sequentially (one `await` per block), decrypts each, verifies seal integrity, checks chain linkage, computes genesis hash, and merges. For a 200-block ledger, that's 200 sequential network round-trips → ~21 seconds.

### Solution: Hash Index

Maintain an ordered list of block seals (`day_hash` / `month_hash` / `year_hash`) in chain order as a lightweight integrity fingerprint stored at `ledger/hash_index.json` on R2 and cached locally in IndexedDB. Two-tier verification:

```
┌─ Tier 1 (worker-computed) ──────────────────────────────────┐
│ Worker computes sha256(hash_index.json) — client compares   │
│ → Match: DONE. Ledgers identical. 1 round-trip.             │
│ → Mismatch: Pull hash_index.json, proceed to Tier 2.        │
└──────────────────────────────────────────────────────────────┘

┌─ Tier 2 (client-side) ──────────────────────────────────────┐
│ Compare hash lists element-by-element → find fork point.    │
│ Linear fork: pull/push only new blocks after fork.          │
│ Divergent fork: pull remote → merge → push result.          │
│ Seal re-verification runs ONLY on pulled blocks after fork. │
└──────────────────────────────────────────────────────────────┘
```

### Expected Savings (200-block ledger)

| Scenario | Current | New | Speedup |
|---|---|---|---|
| No changes (common: background poll, same device) | ~21s | ~0.1s | **210×** |
| Small append (10 new blocks, linear fork) | ~21s | ~1.3s | **16×** |
| Divergent fork (merge required) | ~21s | ~2.0s | **10×** |
| First sync (no local blocks) | ~21s | ~21s | 1× |

### Security Properties

- **Seal-level integrity**: Each hash in the index is an HMAC of block content. Cannot be forged without the master key. Hash match = proven content identity.
- **Seal re-verification preserved**: Re-verification runs on all blocks pulled after a fork point. The hash index defers verification, it doesn't replace it.
- **Hash index is a cache**: Always rebuildable from the full chain. If out of sync, fall back to full pull.
- **Worker can't decrypt**: The worker has no master key. It only computes `sha256()` of the hash index file — a hash of hashes. No content is exposed.
- **Metadata leakage**: Unencrypted hash index reveals block count and type distribution (day vs month vs year). Acceptable tradeoff — less information than `listFiles()` already exposes.

### New Artifacts

| Artifact | Location | Purpose |
|---|---|---|
| Hash index data | `ledger/hash_index.json` (R2) / `ledger:hash_index` (IndexedDB) | Ordered list of block seals |
| Worker endpoint | `GET /storage/ledger/hash_index/hash` | Returns `sha256(hash_index.json)` |
| Hash index builder | `phpoc-web/src/sync/hash_index.js` | Build hash list from chain |
| Hash index comparator | `phpoc-web/src/sync/hash_index.js` | Compare lists, find fork point |

---

## Phase 1 — Test Identification (THIS PHASE)

> **Output:** `docs/planning/ONBOARDING_SPEEDUP_TESTS.md` — catalog of all tests needed.
> **Duration:** One context window. Discussion + test identification only. No code written.

Identify every unit, integration, and E2E test needed for full coverage. Also identify existing tests that must be modified. Organize into categories with purpose and rationale for each test.

### Test Categories to Identify

#### Category A: Hash Index Data Structure (unit — `test/hash_index_test.mjs`)
Tests for building the hash list from a ledger chain. Pure function, no transport.

| ID | Concept |
|----|---------|
| A1 | Build hash list from chain containing day blocks only |
| A2 | Build hash list from chain with day + month_summary + year_summary blocks |
| A3 | Hash list preserves block order (genesis at index 0) |
| A4 | Hash list is deterministic — same chain produces same list every time |
| A5 | Hash list includes all block types (day_hash, month_hash, year_hash) |
| A6 | Empty chain → empty hash list |
| A7 | Genesis-only chain → single-element hash list |
| A8 | Hash list is a plain array, not nested (worker must be able to parse it) |

#### Category B: Fork Detection (unit — `test/hash_index_test.mjs`)
Tests for comparing two hash lists and determining fork type.

| ID | Concept |
|----|---------|
| B1 | Identical lists → `{forkType: 'none'}` |
| B2 | Remote extends local (remote is superset) → `{forkType: 'linear_remote', forkIndex: N}` |
| B3 | Local extends remote (local is superset) → `{forkType: 'linear_local', forkIndex: N}` |
| B4 | Both diverge after common prefix → `{forkType: 'divergent', forkIndex: N}` |
| B5 | Remote empty, local has blocks → `{forkType: 'linear_local', forkIndex: 0}` |
| B6 | Local empty, remote has blocks → `{forkType: 'linear_remote', forkIndex: 0}` |
| B7 | Both empty → `{forkType: 'none'}` |
| B8 | Hash mismatch at index 0 (different genesis) → `{forkType: 'genesis_mismatch'}` |
| B9 | Single hash mismatch mid-chain, rest identical → divergence detection correct |

#### Category C: Hash Index Push (unit — `test/sync_service_test.mjs` new group)
Tests for pushing the hash index alongside ledger blocks.

| ID | Concept |
|----|---------|
| C1 | `pushLedgerBlocks()` pushes hash index after blocks succeed |
| C2 | Hash index not pushed when zero blocks changed |
| C3 | Hash index pushed even when some blocks are skipped (already on remote) |
| C4 | Hash index push failure is non-fatal — blocks already pushed, index stale but recoverable |
| C5 | Hash index is obfuscated (same key as blocks) before push |
| C6 | `forceAll` push also pushes fresh hash index |

#### Category D: Tier 1 — Fast Path Comparison (integration — `test/genesis_gate_test.mjs`)
Tests for the worker-computed shortcut.

| ID | Concept |
|----|---------|
| D1 | Worker returns matching hash → Tier 1 succeeds, no blocks pulled |
| D2 | Worker returns mismatching hash → falls through to Tier 2 |
| D3 | Worker returns error (network) → falls back to full pull (backward compat) |
| D4 | Worker endpoint not available (404) → falls back to full pull |
| D5 | Worker returns empty response (no hash index on R2) → falls back to full pull |
| D6 | Tier 1 hash is computed from same data as local `sha256()` — cross-check |
| D7 | Local has no hash index cached → skip Tier 1, go directly to Tier 2 or full pull |

#### Category E: Tier 2 — Fork + Incremental Pull (integration — `test/genesis_gate_test.mjs`)
Tests for the hash-list comparison and selective block pull.

| ID | Concept |
|----|---------|
| E1 | Linear fork (remote has more) → pull only new blocks after fork point |
| E2 | Linear fork (local has more) → push only new blocks after fork point |
| E3 | Divergent fork → pull remote blocks → merge → push merged result |
| E4 | Fork at genesis → `GenesisMismatchError` thrown |
| E5 | Only blocks after fork point have seal re-verification run |
| E6 | Common prefix blocks are NOT pulled and NOT re-verified |
| E7 | Number of blocks pulled after fork matches expected count |
| E8 | Fork detection at very end of chain (only one block differs) |

#### Category F: Worker Endpoint (unit — worker tests)
Tests for the new Worker endpoint.

| ID | Concept |
|----|---------|
| F1 | `GET /storage/ledger/hash_index/hash` returns `sha256(hash_index.json)` as hex |
| F2 | No hash index on R2 → returns `null` or empty response |
| F3 | Hash index exists but is invalid JSON → returns error |
| F4 | Authorization required (Bearer token check) |
| F5 | Response is fast — no body parsing, just hash computation |
| F6 | CORS headers present for web client access |

#### Category G: Genesis Gate Integration (integration — `test/genesis_gate_test.mjs`)
Tests for the full end-to-end flow through GenesisGate.

| ID | Concept |
|----|---------|
| G1 | Full flow: Tier 1 match → returns `{compatible: true}` with no block pulls |
| G2 | Full flow: Tier 1 mismatch → Tier 2 → linear fork → pull new blocks → seal verify → compatible |
| G3 | Full flow: Tier 1 mismatch → Tier 2 → divergent fork → pull remote → merge → compatible |
| G4 | Full flow: Tier 1 mismatch → Tier 2 → genesis mismatch → `GenesisMismatchError` |
| G5 | Backward compat: transport doesn't support hash endpoint → falls back to full pull (current behavior) |
| G6 | Genesis check via hash index — first hash in list is genesis hash, compared directly |
| G7 | Hash index is cached locally after successful genesis check |
| G8 | In-flight dedup still works — concurrent check() calls share single promise |

#### Category H: Existing Tests Requiring Modification
Tests that need updates because they mock or assert against the old full-pull behavior.

| ID | Existing test group | Change needed |
|----|---------------------|---------------|
| H1 | `genesis_gate_test.mjs` — all tests that mock `listFiles`/`pull` | Add mock for hash index endpoint; some tests should assert zero block pulls on Tier 1 match |
| H2 | `sync_service_test.mjs` — Group I (Genesis Gate integration) | Update mocks; add assertions that genesis check doesn't pull blocks when hash matches |
| H3 | `sync_service_test.mjs` — `pushLedgerBlocks` tests | Assert hash index is pushed alongside blocks |
| H4 | `cross_client_web_test.mjs` — any tests exercising genesis check | Verify hash index flow in multi-device scenarios |

#### Category I: Browser E2E Tests
Smoke tests verifying the speedup is real in a browser.

| ID | Concept |
|----|---------|
| I1 | Login with existing ledger — verify Settings shows "Genesis compatible" in < 500ms |
| I2 | Background sync poll — verify no full block pulls occur |
| I3 | After CLI adds blocks — web detects change and pulls only new blocks |
| I4 | After web adds blocks — CLI detects change (hash mismatch on next pull) |

#### Category J: Edge Cases & Error Handling

| ID | Concept |
|----|---------|
| J1 | Hash index on R2 is stale (blocks exist but index wasn't updated) → fall back to full pull |
| J2 | Hash index file is corrupted / truncated → fall back to full pull |
| J3 | Hash index local cache is corrupted → rebuild from local chain |
| J4 | Concurrent push during genesis check → in-flight dedup handles it |
| J5 | Very large ledger (1000+ blocks) → hash index still lightweight (~64KB) |
| J6 | Summary-only chain (no day blocks, just month/year summaries) → hash list still valid |

---

## Phase 2 — Test Creation (RED)

> **Output:** All test files created/updated. All new tests fail (code not yet implemented).
> **Duration:** One context window. Write tests only — no implementation code.
> **Source:** `docs/planning/ONBOARDING_SPEEDUP_TESTS.md` (created in Phase 1).

1. Create `phpoc-web/test/hash_index_test.mjs` — Categories A + B
2. Add new test groups to `test/sync_service_test.mjs` — Category C
3. Add new test groups to `test/genesis_gate_test.mjs` — Categories D, E, G
4. Update worker test file — Category F
5. Update affected existing tests — Category H
6. Create E2E test script/smoke list — Category I (optional for this phase)
7. Create edge case tests — Category J

All tests must follow existing conventions:
- `vitest` for JS tests
- `describe`/`it` blocks with clear naming
- Mock transport + memory storage for isolation
- No real network calls in unit/integration tests

---

## Phase 3 — Implementation (GREEN)

> **Output:** All tests from Phase 2 pass. Strategy fully implemented.
> **Duration:** Multiple context windows as needed. Iterate until green.

### New files to create

| File | Purpose |
|------|---------|
| `phpoc-web/src/sync/hash_index.js` | `buildHashIndex(chain)`, `compareHashIndexes(local, remote)`, `computeHash` |
| `worker/src/hash_index_handler.js` | Worker endpoint handler for `GET ledger/hash_index/hash` |

### Existing files to modify

| File | Change |
|------|--------|
| `phpoc-web/src/sync/genesis_gate.js` | Add Tier 1 + Tier 2 logic before full pull fallback |
| `phpoc-web/src/sync/sync.js` | `pushLedgerBlocks()` pushes hash index; cache hash index locally after genesis check |
| `phpoc-web/src/sync/keys.js` | Add `REMOTE_HASH_INDEX`, `LOCAL_HASH_INDEX` constants |
| `worker/src/index.js` | Register hash index endpoint route |
| `worker/wrangler.toml` | No changes needed (same R2 bucket) |

### Implementation order (inside GenesisGate.check)

1. Try Tier 1: fetch `sha256(hash_index.json)` from worker → compare with local. Match → return compatible.
2. Tier 2: pull `hash_index.json` → call `compareHashIndexes()` → determine fork type.
3. Linear fork → pull/push only new blocks → seal-verify only new blocks.
4. Divergent fork → pull full remote chain from fork → merge → push result.
5. Any failure at any tier → fall back to full pull (current behavior). The hash index is an optimization, not a new requirement.

---

## Phase 4 — Refactoring

> **Output:** Code is modular, concise, secure, and efficient.
> **Duration:** One context window.

1. Extract hash index logic from `genesis_gate.js` into `hash_index.js` (if not already separated)
2. Ensure `compareHashIndexes()` is pure and testable independently
3. Review error handling — every failure mode falls back gracefully
4. Remove any dead code (old full-pull paths that are now unreachable)
5. Audit security: no master key leakage, no unencrypted content in transit
6. Verify all tests still pass after refactoring
7. Ensure hash index is rebuildable from chain (no new source of truth)
8. Add JSDoc to all new public APIs

---

## Files Touched Summary

| File | Phase 1 | Phase 2 | Phase 3 | Phase 4 |
|------|:-------:|:-------:|:-------:|:-------:|
| `docs/planning/ONBOARDING_SPEEDUP_TESTS.md` | ✏️ create | — | — | — |
| `phpoc-web/test/hash_index_test.mjs` | — | ✏️ create | — | — |
| `phpoc-web/test/genesis_gate_test.mjs` | — | ✏️ modify | — | ✅ verify |
| `phpoc-web/test/sync_service_test.mjs` | — | ✏️ modify | — | ✅ verify |
| `phpoc-web/src/sync/hash_index.js` | — | — | ✏️ create | ✏️ refactor |
| `phpoc-web/src/sync/genesis_gate.js` | — | — | ✏️ modify | ✏️ refactor |
| `phpoc-web/src/sync/sync.js` | — | — | ✏️ modify | ✏️ refactor |
| `phpoc-web/src/sync/keys.js` | — | — | ✏️ modify | — |
| `worker/src/hash_index_handler.js` | — | — | ✏️ create | — |
| `worker/src/index.js` | — | — | ✏️ modify | — |
| `docs/planning/WEB_ROADMAP.md` | — | — | ✏️ Build 61 | ✏️ Build 61 |
| `docs/reference/CHANGELOG.md` | — | — | ✏️ update | — |
| `docs/reference/MAP.md` | ✏️ update | ✏️ update | ✏️ update | ✏️ update |

---

## Related Documents

- `docs/planning/ROADMAP.md` — Protocol-layer roadmap (Mobile POC item)
- `docs/planning/WEB_ROADMAP.md` — Build log (this will be Build 61)
- `docs/planning/E2E_CROSS_CLIENT_FIX_PLAN.md` — Cross-client sync fixes (completed)
- `docs/design/ARCHITECTURAL_DECISIONS.md` — ADR for hash index strategy (create if needed)
- `docs/reference/CHANGELOG.md` — Release notes on completion
- `SESSION_HANDOFF.md` — Current session state
