# Onboarding/Unlock/ReAuth Speedup — Test Catalog

> **Status:** 🟡 IN PROGRESS — Phase 1 complete (test identification), Phase 2 complete (RED test creation)
> **Parent:** `ONBOARDING_UNLOCK_REAUTH_SPEEDUP_STRATEGY.md`
> **Created:** 2026-07-02
> **Purpose:** Exhaustive catalog of all unit, integration, and E2E tests needed for the hash-index speedup. Output of Phase 1 — no code written.

---

## Architecture Summary

**Current behavior:** `GenesisGate.check()` pulls every block from R2 sequentially (one round-trip per block), decrypts each, verifies seals, computes genesis hash, and merges. ~200 sequential pulls for a 200-block ledger → ~21s.

**New behavior (Tier 1 + Tier 2):**

```
Tier 1: Pull ledger/hash_index.sha256 (64 bytes) → compare with local sha256(hash_index)
        ├─ Match → DONE (1 round-trip, ~0.1s)
        └─ Mismatch → proceed to Tier 2

Tier 2: Pull ledger/hash_index.json (~13KB for 200 blocks) → compare element-by-element
        ├─ Linear fork (remote extends local) → pull only new blocks after fork point
        ├─ Linear fork (local extends remote) → push only new blocks after fork point
        ├─ Divergent fork → pull remote blocks after fork → merge → push merged result
        └─ Genesis mismatch → GenesisMismatchError

Fallback: Any tier failure → pull full chain (current behavior, backward compatible)
```

**Hash index format:**
```json
["0a1b2c...64-hex-chars...", "3d4e5f...64-hex-chars...", "..."]
```
Array of block seals (`day_hash` / `month_hash` / `year_hash`) in chain order. Genesis at index 0.

**New artifacts:**

| Artifact | R2 Path | IndexedDB Key | Purpose |
|---|---|---|---|
| Hash index data | `ledger/hash_index.json` | `ledger:hash_index` | Ordered list of block seals |
| Hash index SHA-256 | `ledger/hash_index.sha256` | (none) | `sha256(hash_index.json)` for Tier 1 |
| Hash index request | `GET ledger/hash_index.sha256` | — | Tiny 64-byte Tier 1 check |

**Tier 1 implementation choice:** Either a Worker endpoint or a companion `.sha256` file on R2. The `.sha256` file approach requires zero Worker changes (existing generic blob store handles it) and achieves the same 1-round-trip check. Test catalog reflects the Worker endpoint pattern from the strategy doc; Phase 3 chooses the final approach.

---

## Test Files to Create

| File | Phase | Categories | Est. lines |
|---|---|---|---|
| `phpoc-web/test/hash_index_test.mjs` | 2 | A, B | ~400 |
| `phpoc-web/test/genesis_gate_test.mjs` | 2 (modify) | D, E, G (new); H (modify) | +~500 |
| `phpoc-web/test/sync_service_test.mjs` | 2 (modify) | C (new Group S); H (modify) | +~300 |
| `worker/test/hash_endpoint_test.ts` | 2 (optional) | F | ~150 |

---

## Category A: Hash Index Data Structure (Unit)

**File:** `phpoc-web/test/hash_index_test.mjs` (new)
**Module under test:** `phpoc-web/src/sync/hash_index.js` — `buildHashIndex(chain)`
**Type:** Pure function, no transport, no crypto side effects.

| ID | Test | Input | Expected Output | Rationale |
|---|---|---|---|---|
| **A1** | Day blocks only | Chain: [genesis, dayBlock(date=06-10), dayBlock(date=06-11)] | `[genesis.day_hash, dayBlock1.day_hash, dayBlock2.day_hash]` | Most common chain shape |
| **A2** | Mixed type blocks (day + month_summary + year_summary) | Chain with all 4 block types | Array with `day_hash`, `month_hash`, `year_hash` in order | All block types have seals, must be included |
| **A3** | Order preservation | Chain with blocks in specific order | Hash at index N corresponds to block[N] | Build must not reorder — chain order is canonical |
| **A4** | Determinism | Same chain built twice | Identical arrays (deep equality) | No randomness, no timestamp injection |
| **A5** | Genesis-only chain | [genesisBlock] | Single-element array: `[genesis.day_hash]` | Minimal valid chain |
| **A6** | Empty chain | `[]` | `[]` (empty array) | Graceful handling, no crash |
| **A7** | Null/undefined chain | `null`, `undefined` | `[]` or throw with clear message | Defensive input handling |
| **A8** | Plain array output | Any valid chain | `Array.isArray(result) === true`, all elements are strings | Worker must parse this — no nested objects |
| **A9** | Hash string format | Any valid chain | Every element is exactly 64 hex chars | Consistency check — corrupted blocks produce bad hashes |

---

## Category B: Fork Detection (Unit)

**File:** `phpoc-web/test/hash_index_test.mjs` (same file as A)
**Module under test:** `phpoc-web/src/sync/hash_index.js` — `compareHashIndexes(local, remote)`
**Type:** Pure function, no I/O.

| ID | Test | Local Hash Index | Remote Hash Index | Expected `{forkType, forkIndex}` | Rationale |
|---|---|---|---|---|---|
| **B1** | Identical lists | `[h0, h1, h2]` | `[h0, h1, h2]` | `{forkType: 'none'}` | Most common case — ledgers in sync |
| **B2** | Remote extends local (linear) | `[h0, h1, h2]` | `[h0, h1, h2, h3, h4]` | `{forkType: 'linear_remote', forkIndex: 3}` | CLI added blocks, web catches up |
| **B3** | Local extends remote (linear) | `[h0, h1, h2, h3]` | `[h0, h1, h2]` | `{forkType: 'linear_local', forkIndex: 3}` | Web added blocks, CLI catches up |
| **B4** | Divergent after common prefix | `[h0, h1, h2a]` | `[h0, h1, h2b]` | `{forkType: 'divergent', forkIndex: 2}` | Both devices added entries independently |
| **B5** | Remote empty | `[h0, h1]` | `[]` | `{forkType: 'linear_local', forkIndex: 0}` | New remote — local pushes everything |
| **B6** | Local empty | `[]` | `[h0, h1]` | `{forkType: 'linear_remote', forkIndex: 0}` | New local — pull everything from remote |
| **B7** | Both empty | `[]` | `[]` | `{forkType: 'none'}` | Both ledgers empty after clearRemote |
| **B8** | Mismatch at index 0 (different genesis) | `[h0a]` | `[h0b]` | `{forkType: 'genesis_mismatch'}` | Clear fork — no common ancestry |
| **B9** | Single hash mismatch mid-chain, rest identical | `[h0, h1, h2a, h3]` | `[h0, h1, h2b, h3]` | `{forkType: 'divergent', forkIndex: 2}` | Corrupted seal or actual divergence |
| **B10** | Fork at very end of chain | `[h0, h1, h2]` | `[h0, h1, h2a]` | `{forkType: 'divergent', forkIndex: 2}` | Only last block differs (unusual but possible) |
| **B11** | Remote has fewer elements + divergence | `[h0, h1a, h2]` | `[h0, h1b]` | `{forkType: 'divergent', forkIndex: 1}` | Local extended beyond remote's length after fork |
| **B12** | Null inputs | `null`, `[h0, h1]` | Treat null as empty | `{forkType: 'linear_remote', forkIndex: 0}` | Defensive — null treated as empty |
| **B13** | Very long identical prefix (stress test) | 100 identical hashes + 1 diff | Same | `{forkType: 'divergent', forkIndex: 100}` | Verify algorithm doesn't O(n²) on long chains |

---

## Category C: Hash Index Push (Integration)

**File:** `phpoc-web/test/sync_service_test.mjs` — **New Group S**
**Module under test:** `SyncService.pushLedgerBlocks()` with hash index side effect
**Type:** Integration — MockTransport + MemoryBackend, no real network.

| ID | Test | Setup | Assertions | Rationale |
|---|---|---|---|---|
| **C1** | Hash index pushed after block push | Chain with 3 blocks, pushLedgerBlocks({forceAll:true}) | `ledger/hash_index.json` exists on remote, content is valid JSON array with 3 elements | Hash index always accompanies blocks |
| **C2** | Hash index SHA-256 pushed alongside | Same as C1 | `ledger/hash_index.sha256` exists on remote, content is 64 hex chars matching `sha256(hash_index.json)` | Tier 1 needs the companion `.sha256` file |
| **C3** | Hash index NOT pushed when 0 blocks changed | Push once, then push again (no blocks to push) | First push: hash index exists. Second push: hash index unchanged (or: no unnecessary blob pushes) | Don't push on no-ops |
| **C4** | Hash index pushed on forceAll even with 0 new blocks | Push once, forceAll again | Hash index pushed on both calls | forceAll should always push hash index |
| **C5** | Hash index push failure is non-fatal | Transport throws on hash index push | pushLedgerBlocks returns block count (blocks succeeded), no exception propagates | Block push is critical; hash index is recoverable |
| **C6** | Hash index SHA-256 push failure is non-fatal | Transport throws on sha256 push | Same as C5 — blocks still pushed | Same rationale — recoverable |
| **C7** | Hash index pushed when masterKey is available | MockCrypto with MK set | Hash index is pushed | No push when MK is null (can't obfuscate) |
| **C8** | Hash index NOT obfuscated (unlike blocks) | Inspect remote `hash_index.json` | Valid JSON array, NOT base64-encoded obfuscated blob | Hash index is not user data — just ordered seals. No privacy risk. Worker can serve it directly. |
| **C9** | Hash index is built from the same chain being pushed | Chain with specific block hashes | Hash index elements match block seals exactly | Consistency — index and blocks must agree |
| **C10** | Hash index push after genesis merge | Simulate merge result → pushLedgerBlocks({forceAll:true}) | Hash index represents merged chain, not just local | Merge updates the chain; hash index must follow |

---

## Category D: Tier 1 — Fast Path Hash Comparison (Integration)

**File:** `phpoc-web/test/genesis_gate_test.mjs` — **New Group E** (after existing A-D)
**Module under test:** `GenesisGate.check()` with Tier 1
**Type:** Integration — MockTransport with pre-seeded remote data.

| ID | Test | Setup | Assertions | Rationale |
|---|---|---|---|---|
| **D1** | Matching SHA-256 → Tier 1 succeeds, zero block pulls | Remote has matching `hash_index.sha256` | `compatible: true`, transport.pullCount ≤ 2 (sha256 + maybe hash_index.json), NO block pulls | Common case — background poll, nothing changed |
| **D2** | Mismatching SHA-256 → falls through to Tier 2 | Remote SHA-256 differs from local | Proceeds to Tier 2 (pulls `hash_index.json`, then blocks as needed) | Normal incremental update |
| **D3** | Network error on SHA-256 pull → falls back to full pull | Transport throws on `hash_index.sha256` | Falls back to current full-pull behavior; `compatible: true` on success | Backward compatibility — hash index is an optimization |
| **D4** | No SHA-256 file on remote (404) → falls back to full pull | `hash_index.sha256` returns null | Falls back to full pull; genesis check still works | Legacy remote without hash index |
| **D5** | SHA-256 file exists but empty → falls back to full pull | Remote SHA-256 is empty string | Falls back to full pull | Corrupted file, not a network error — still safe |
| **D6** | Local has no hash index cached → skip Tier 1, go to Tier 2 | No local `ledger:hash_index` in IndexedDB | Tier 1 skipped, Tier 2 runs (pull hash_index.json from remote) | First sync after feature deploy |
| **D7** | SHA-256 is computed from same data as local `sha256()` | Build hash index locally, compute sha256, compare with remote | Match: Tier 1 succeeds. Mismatch: Tier 2. | Cross-check — local and remote algorithms agree |
| **D8** | SHA-256 is 64 hex characters | Pull remote SHA-256 | Content is exactly 64 lowercase hex chars | Format validation — corrupted file detection |
| **D9** | SHA-256 comparison is case-insensitive | Remote has uppercase hex | Still matches lowercase local sha256 | Defensive — different clients may normalize differently |

---

## Category E: Tier 2 — Fork + Incremental Pull (Integration)

**File:** `phpoc-web/test/genesis_gate_test.mjs` — **New Group E** (same group as D)
**Module under test:** `GenesisGate.check()` with Tier 2
**Type:** Integration — MockTransport with pre-seeded remote data.

| ID | Test | Setup | Assertions | Rationale |
|---|---|---|---|---|
| **E1** | Linear fork (remote has more) → pull only new blocks after fork | Local: 3 blocks. Remote: 5 blocks (first 3 same). Hash index shows `linear_remote` at index 3 | Only blocks at indices 3 and 4 pulled from remote. Total pulls: sha256 + hash_index.json + 2 blocks ≈ 4 pulls (vs ~5 full pulls) | Core optimization — skip common prefix |
| **E2** | Linear fork (local has more) → push only new blocks | Local: 5 blocks. Remote: 3 blocks. Hash index shows `linear_local` at index 3 | No remote blocks pulled. `compatible: true`, mergedChain = local (longer) | Local wins — nothing to pull |
| **E3** | Divergent fork → pull remote blocks from fork → merge → push merged result | Same genesis, divergent at block 2. Hash index shows `divergent` at index 1 | Remote blocks after fork pulled. LedgerMerge.merge() called. Merged chain returned. | Full merge required |
| **E4** | Fork at genesis → GenesisMismatchError | Hash index comparison returns `genesis_mismatch` | `GenesisMismatchError` thrown | Permanent incompatibility |
| **E5** | Only blocks after fork point have seal re-verification run | Track which blocks are seal-verified during check | Common prefix blocks NOT re-verified. Fork-block verified. | Performance — skip verification for known-good blocks |
| **E6** | Common prefix blocks are NOT pulled | Track pull() calls | No pull() for blocks from common prefix | Same as E1 — network savings confirmation |
| **E7** | Number of blocks pulled after fork matches expected count | Fork at index 5, remote total 10 | Exactly 5 blocks pulled (indices 5-9) | Precise count — no off-by-one |
| **E8** | Fork at very end of chain (only one block differs) | Fork at index 49, remote total 50 | Only block at index 49 pulled | Edge case — minimal pull |
| **E9** | Hash index on remote is stale (blocks exist but index is old) | Remote has more blocks than hash index lists | Full blocks listed in index are NOT pulled; extra blocks ARE pulled. After merge, new hash index built and pushed. | Consistency recovery |
| **E10** | Hash index file is corrupted/truncated → fall back to full pull | Remote `hash_index.json` is invalid JSON | Falls back to full pull. `compatible: true` on success. | Graceful degradation |
| **E11** | Hash index local cache is corrupted → rebuild from local chain | Mock local `ledger:hash_index` with garbage JSON | Rebuilt from local chain before comparison. Tier 2 proceeds normally. | Data recovery |

---

## Category F: Worker Endpoint (Unit — Optional)

**File:** `worker/test/hash_endpoint_test.ts` (new, if Worker endpoint approach is chosen)
**Module under test:** Worker `GET ledger/hash_index.sha256` handler
**Type:** Unit — Miniflare or vitest with `SELF.fetch`.

> **Note:** If the companion `.sha256` file approach is used (R2 blob, not computed endpoint), these tests simplify to verifying the file exists in R2 after push — already covered by Category C. This category assumes a Worker endpoint that computes `sha256()` on-the-fly.

| ID | Test | Request | Assertions | Rationale |
|---|---|---|---|---|
| **F1** | Valid hash index → returns sha256 as hex | `GET /ledger/hash_index.sha256` | 200, body is 64 hex chars, `Content-Type: text/plain` | Happy path |
| **F2** | No hash index on R2 → 404 or empty body | Same request, no `hash_index.json` on R2 | 404 (not found) or 200 with `null` body | Client handles both |
| **F3** | Hash index exists but is invalid JSON → 500 or error | Corrupted `hash_index.json` | Non-200 response; client falls back to Tier 2/full pull | Data corruption recovery |
| **F4** | Authorization required | Request without `X-Api-Key` header (when `PHPOC_API_KEY` is set) | 403 Forbidden | Security — same as all other endpoints |
| **F5** | Response is fast — no body parsing burden | Valid request | Response time under 50ms in test environment | Performance requirement |
| **F6** | CORS headers present | Browser-like request with `Origin` | `Access-Control-Allow-Origin: *` present | Web client access |
| **F7** | Valid hash index → returns ETag for caching | GET with hash index present | `ETag` header matches `sha256` value | Browser caching optimization |

---

## Category G: Genesis Gate Full Integration (Integration)

**File:** `phpoc-web/test/genesis_gate_test.mjs` — **New Group F** (after D/E)
**Module under test:** `GenesisGate.check()` end-to-end through Tier 1 → Tier 2
**Type:** Integration — full flow tests with MockTransport.

| ID | Test | Setup | Assertions | Rationale |
|---|---|---|---|---|
| **G1** | Full flow: Tier 1 match → instant compatible | Remote has same chain as local, hash index + sha256 present | `compatible: true`, transport.pullCount ≤ 2 (sha256 + maybe hash index), NO block file pulls | Happy path — common background poll |
| **G2** | Full flow: Tier 1 mismatch → Tier 2 → linear fork → incremental pull → seal verify → compatible | Remote has 2 more blocks, different sha256 | `compatible: true`, only new blocks pulled, seals verified on new blocks only | Incremental update |
| **G3** | Full flow: Tier 1 mismatch → Tier 2 → divergent → pull remote after fork → merge → compatible | Both chains diverge at block 2 | `compatible: true`, merge called, merged chain returned with stats | Cross-device merge |
| **G4** | Full flow: Tier 1 mismatch → Tier 2 → genesis mismatch → GenesisMismatchError | Different genesis on remote | `GenesisMismatchError` thrown | Permanent incompatibility |
| **G5** | Backward compat: transport doesn't have hash index files → falls back to full pull | Remote has blocks but no hash_index files | Falls back to full pull; genesis check still works; `compatible: true` on match | Rollout safety — old remotes still work |
| **G6** | Genesis hash from hash index vs from block — must match | First element of hash_index vs block[0].day_hash | Values are identical | Consistency verification |
| **G7** | Hash index is cached locally after successful genesis check | Run check → read `ledger:hash_index` from IndexedDB | Cache entry exists, content matches remote's hash index | Speedup on next poll |
| **G8** | In-flight dedup still works with hash index flow | Two concurrent check() calls | Only 1 set of network calls (not doubled); both return same result | Existing dedup logic must work with new flow |
| **G9** | Remote returns hash_index.json after sha256 mismatch → pull happens once | sha256 mismatch triggers pull of hash_index.json | hash_index.json pulled exactly once (not per-block) | Efficiency assertion |
| **G10** | Large ledger (200 blocks) → Tier 1 response under 10ms | 200-block chain, matching hash indexes | `compatible: true`, fast (mock latency simulates real timing) | Performance benchmark |

---

## Category H: Existing Tests Requiring Modification

Tests that mock or assert against the old full-pull behavior and need updates.

### H1: `genesis_gate_test.mjs` — Group A (Genesis Hash Comparison)

| Sub-ID | Existing Test | Change Needed |
|---|---|---|
| **H1a** | A1 — Same genesis → compatible | Add assertions: transport.pullCount is optimized (not pulling all blocks). Currently asserts `compatible: true` — add check that hash index flow was used. |
| **H1b** | A4 — Remote empty → compatible | Verify hash index is not pulled (no blocks → no hash index). Or: pull returns null for hash_index.sha256 → immediate compatible. |
| **H1c** | A3 — Remote unreachable | Transport throws on hash_index.sha256 pull → falls back to full pull, which also fails → NetworkGenesisError. Behavior preserved. |
| **H1d** | A5 — Tampered seal | Hash index won't match (different seal → different hash index). Falls to Tier 2 → full pull → seal verification catches tampering. Behavior preserved. |

### H2: `genesis_gate_test.mjs` — Group C (Edge Cases)

| Sub-ID | Existing Test | Change Needed |
|---|---|---|
| **H2a** | C3 — ETag caching | Hash index supersedes ETag caching. Test should verify that Tier 1 match is even faster than ETag-based pull. |
| **H2b** | C4 — Concurrent gate checks | Same dedup logic, now with hash index. Assert hash index pulled once, not twice. |
| **H2c** | C5 — Large remote chain | Key test! With matching hash index, should make ≤ 2 pulls total (sha256 + hash_index.json), NOT 30+ block pulls. This is the performance test. |

### H3: `sync_service_test.mjs` — Group I (Genesis Gate Integration)

| Sub-ID | Existing Test | Change Needed |
|---|---|---|
| **H3a** | I1 — No remote → READY | No change. Local-only path doesn't touch genesis gate. |
| **H3b** | I2 — Genesis compatible → proceeds to fast path | After hash index implementation: verify that genesis check used Tier 1 (no block pulls) when chains match. |
| **H3c** | I3 — Genesis mismatch → GENESIS_MISMATCH | Hash index comparison at index 0 → `genesis_mismatch`. Verify sha256 mismatch first, then hash_index_json reveal of genesis mismatch. |
| **H3d** | I4 — Network error → OFFLINE | Hash index pull fails → fallback fails → appropriate error. |

### H4: `sync_service_test.mjs` — Group M (Same-Genesis Merge)

| Sub-ID | Existing Test | Change Needed |
|---|---|---|
| **H4a** | M1-M8 — Merge tests | After merge + force-push, verify hash index is pushed alongside merged chain. |

### H5: `sync_service_test.mjs` — Group P (pushLedgerBlocks)

| Sub-ID | Existing Test | Change Needed |
|---|---|---|
| **H5a** | P1-P4 — Block push tests | Add assertions: `ledger/hash_index.json` and `ledger/hash_index.sha256` present on remote after push. |

### H6: `cross_client_web_test.mjs`

| Sub-ID | Existing Test | Change Needed |
|---|---|---|
| **H6a** | Groups 3-5 (round-trip, pause lifecycle) | Verify hash index flow works across device scenarios. After one device adds blocks, the other detects via hash index mismatch and pulls incrementally. |

---

## Category I: Browser E2E Tests (Smoke)

**File:** To be run via agent_browser or Playwright (Step 7 tooling).

| ID | Test | Setup | Assertions | Rationale |
|---|---|---|---|---|
| **I1** | Login with existing ledger → Settings shows "Genesis compatible" in < 2s | Open app, login with passphrase, navigate to Settings | "Genesis compatible" visible within 2s of page load | Real-world speedup verification |
| **I2** | Background sync poll → no block pulls | Open DevTools Network tab, wait for background sync interval (~30s) | No `ledger/blocks/000*.json` requests; only hash index requests visible | Verifies Tier 1 is the common case |
| **I3** | After CLI adds blocks → web detects change on next poll | Add block via CLI, wait for web background sync | Web pulls only new blocks (not full chain), sync succeeds | Cross-client incremental update |
| **I4** | After web adds blocks → CLI detects change on next pull | Add entry via web, run `ph pull` | CLI pulls only new blocks | Reverse direction |
| **I5** | Large ledger (50+ blocks) → login speed improved | Import or build large ledger, login | Login takes < 3s (vs 5-10s without hash index) | Real performance benchmark |

---

## Category J: Edge Cases & Error Handling

Tests for unusual but possible states.

| ID | Test | Scenario | Expected Behavior | Rationale |
|---|---|---|---|---|
| **J1** | Hash index on R2 is stale (blocks exist but index wasn't updated) | Remote has 10 blocks, hash_index lists only 8 | Tier 1 mismatch → Tier 2: pull hash_index.json → blocks after index pulled from remote → merge → new hash index pushed | Partial push recovery |
| **J2** | Hash index file is corrupted / truncated on R2 | `hash_index.json` is `"garbage"` not a JSON array | JSON.parse fails → fall back to full pull → check succeeds → new hash index pushed | Data recovery |
| **J3** | Hash index local cache is corrupted | `ledger:hash_index` in IndexedDB is `"%%%"` | Rebuilt from local chain before comparison | Recovery from bad cache |
| **J4** | Concurrent push during genesis check | check() in progress, another client pushes new block + new hash index | In-flight dedup prevents double fetch; result reflects state at fetch time | Race condition safety |
| **J5** | Very large ledger (1000+ blocks) → hash index still lightweight | 1000-block chain | Hash index: ~1000 × 64 bytes = 64KB JSON. Fetch under 200ms. | Scalability headroom |
| **J6** | Summary-only chain (no day blocks, just month/year summaries) | Chain: [genesis, month_summary, year_summary] | Hash list includes `month_hash` and `year_hash` values | Mixed block type chain is valid |
| **J7** | Hash index on remote is empty array `[]` | Remote has genesis but empty hash index | Tier 1: sha256 of `[]` matches → compatible. Tier 2: hash_index.json is `[]` → forkType: 'linear_local' | After genesis-only push before any entries |
| **J8** | Remote SHA-256 file present but hash_index.json missing | sha256 mismatch → pull hash_index.json → 404 | Fall back to full pull → check succeeds → rebuild and push hash index | Inconsistent remote state recovery |
| **J9** | Hash index is rebuilt on every push, not mutated | Call pushLedgerBlocks twice, inspect hash_index.json | Both pushes produce correct hash index (no stale entries, no duplicate hashes) | Idempotent push |
| **J10** | Entry-level hash changes but block-level seal stays same | Modified entry within a block (entry reordering) → block seal changes → hash index changes → mismatch detected | Tier 1 mismatch → pulls new blocks → merge handles | Integrity: hash index is seal-based, covers all block content |

---

## Test Execution Order (Phase 2)

```
1. Create hash_index_test.mjs (Categories A + B) — unit, runs first
   ├── 9 tests in Category A (buildHashIndex)
   └── 13 tests in Category B (compareHashIndexes)

2. Add Group S to sync_service_test.mjs (Category C)
   └── 10 tests (hash index push behavior)

3. Add Groups E+F to genesis_gate_test.mjs (Categories D, E, G)
   ├── 9 tests in Group E (Tier 1 — fast path hash comparison)
   ├── 11 tests in Group F (Tier 2 — fork + incremental pull)
   └── 10 tests (full integration flows + backward compat)

4. Update existing tests (Category H)
   ├── genesis_gate_test.mjs: update Groups A, C
   ├── sync_service_test.mjs: update Groups I, M, P
   └── cross_client_web_test.mjs: verify hash index flow

5. Category J (edge cases) — distributed across above files

6. (Optional) worker/test/hash_endpoint_test.ts — Category F
```

**Total new tests:** ~62 (A:9 + B:13 + C:10 + D:9 + E:11 + G:10)
**Existing tests modified:** ~15
**Total Phase 2 delta:** ~77 tests

---

## Files Touched Summary (Updated)

| File | Phase 1 | Phase 2 | Phase 3 | Phase 4 |
|------|:-------:|:-------:|:-------:|:-------:|
| `docs/planning/ONBOARDING_SPEEDUP_TESTS.md` | ✅ created | — | — | — |
| `phpoc-web/test/hash_index_test.mjs` | — | ✏️ create | — | — |
| `phpoc-web/test/genesis_gate_test.mjs` | — | ✏️ modify (+3 groups) | ✅ verify | ✅ verify |
| `phpoc-web/test/sync_service_test.mjs` | — | ✏️ modify (+1 group) | ✅ verify | ✅ verify |
| `phpoc-web/test/cross_client_web_test.mjs` | — | ✏️ verify | ✅ verify | ✅ verify |
| `phpoc-web/src/sync/hash_index.js` | — | — | ✏️ create | ✏️ refactor |
| `phpoc-web/src/sync/genesis_gate.js` | — | — | ✏️ modify | ✏️ refactor |
| `phpoc-web/src/sync/sync.js` | — | — | ✏️ modify | ✏️ refactor |
| `phpoc-web/src/sync/keys.js` | — | — | ✏️ modify | — |
| `worker/src/index.ts` | — | — | ✏️ modify (optional) | — |
| `docs/planning/WEB_ROADMAP.md` | — | — | ✏️ Build 61 | ✏️ Build 61 |
| `docs/reference/CHANGELOG.md` | — | — | ✏️ update | — |
| `docs/reference/MAP.md` | ✏️ update | ✏️ update | ✏️ update | ✏️ update |

---

## Related Documents

- `docs/planning/ONBOARDING_UNLOCK_REAUTH_SPEEDUP_STRATEGY.md` — Full 4-phase strategy (parent document)
- `docs/planning/ROADMAP.md` — Protocol-layer roadmap (Mobile POC item)
- `docs/planning/WEB_ROADMAP.md` — Build log (this will be Build 61)
- `docs/planning/E2E_CROSS_CLIENT_FIX_PLAN.md` — Cross-client sync fixes (completed, hash index must be compatible)
- `docs/design/ARCHITECTURAL_DECISIONS.md` — ADR for hash index strategy (create during Phase 3)
- `docs/reference/CHANGELOG.md` — Release notes on completion
- `SESSION_HANDOFF.md` — Current session state
