# Flutter Ledger Engine — Test Exploration (Phase 1)

> **Plan:** `docs/planning/flutter/INITIAL_PLAN.md` §Phase 7
> **Purpose:** Blueprint of all needed test assertions for the Flutter ledger engine port.
> **Status:** ✅ Phase 1+2+3+4 complete
> **Next Phase:** None (all 4 phases complete)
> **Constraint:** Axiom B5 — match Python/JS behavior exactly, don't improve.

## Architecture Overview

The ledger engine is the most complex port in the Flutter app. It implements the append-only
cryptographic chain that turns staging entries into committed blocks. Five modules:

```
lib/data/ledger/
├── helpers.dart          — getBlockHash, computeEntryHash, content hash verification
├── chain.dart            — block building, sealing, signing, append/truncate, verify
├── engine.dart           — commit, verify, revert — unified public API
├── index_manager.dart    — blind index: {date: {title: total_ms}}, encrypted at rest
├── summary_policy.dart   — year/month boundary summary block insertion
└── merge.dart            — chain-level merge: fork detection, dedup, rebuild
```

**Dependency:** All modules depend on `CryptoService` (Phase 2) for encrypt/decrypt/seal/mac/sha256.
The ledger engine is additive — the app works without it (staging-only MVP in Phases 1–6).

**Data flow:** Staging → Engine.commit() → encrypt fields → build day blocks → insert summaries →
seal blocks → sign blocks → append to chain → update blind index.

**Key contracts:**
- Block format must be byte-identical to Python `domain/ledger/chain.py` output (constraint O8)
- Chain structure: Genesis → (Year Summary → Month Summary)* → Day blocks
- Every block is sealed (HMAC-SHA256) and optionally identity-signed
- Blind index: `{date: {title: total_ms}}` — plaintext, queryable without decryption
- Content hash: SHA-256 of resolved plaintext fields — survives re-encryption

## Test Groups

### Group A: Helpers & Utilities — ~15 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | `getBlockHash` returns `block_hash` for genesis blocks | Correct hash key for genesis (I-17) | Genesis uses block_hash; other types use type-specific keys |
| A2 | `getBlockHash` returns `day_hash` for day blocks | Correct hash key for day blocks | Day blocks use day_hash |
| A3 | `getBlockHash` returns `month_hash` for month_summary blocks | Correct hash key for month summaries | Month summaries use month_hash |
| A4 | `getBlockHash` returns `year_hash` for year_summary blocks | Correct hash key for year summaries | Year summaries use year_hash |
| A5 | `getBlockHash` returns empty string when no hash key present | Graceful fallback for malformed blocks | Prevents null errors in verification loops |
| A6 | `getBlockHash` falls back `day_hash` for legacy genesis without `block_hash` | Backward compat with pre-I-17 genesis | Existing ledgers may have genesis with day_hash |
| A7 | `computeEntryHash` produces SHA-256 of sort_keys+indent=2 JSON | Canonical cross-client entry hash | Must match Python helpers.py compute_entry_hash byte-for-byte |
| A8 | `computeEntryHash` output matches Python for known test vector | Cross-platform byte-identical output | Entry hash is the link between platforms |
| A9 | `verifyEntryHashTwoWay` matches sort+indent2 (canonical) | Primary verification format | Cross-client canonical format |
| A10 | `verifyEntryHashTwoWay` matches sort+compact (legacy fallback) | Backward compat with pre-v0.4 | Old CLI/test fixtures use compact format |
| A11 | `verifyEntryHashTwoWay` returns false for wrong hash | Correct rejection of tampered hash | Integrity check must catch changes |
| A12 | `verifyContentHash` extensible algorithm: decrypts _enc fields, sorts lists | Content hash survives re-encryption | Decrypted values + canonical key names = stable hash |
| A13 | `verifyContentHash` legacy v0.3.0 algorithm fallback | Backward compat with pre-v0.4 content_hash | Old entries use hardcoded 9-field format with indent=2 |
| A14 | `verifyContentHash` returns false when decryption fails and hash differs | Graceful failure on corrupted encrypted fields | Don't crash verifier on bad ciphertext |
| A15 | `verifyContentHash` returns false for wrong hash | Correct rejection of tampered content_hash | Integrity check must catch entry data changes |

### Group B: LedgerChain — Block Building — ~14 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | `buildGenesisBlock` creates block with type=genesis, day_index=0, entries=[] | Correct genesis structure per PHPSPEC §4.1 | First block must match spec exactly |
| B2 | `buildGenesisBlock` includes identity fields: username, email, recovery_seed_enc, identity_pub_key | User identity embedded in genesis | Identity fields required for recovery and device attribution |
| B3 | `buildGenesisBlock` includes identity_secret_enc_fallback | Encrypted identity secret for recovery | Allows recovery if device-local secret is lost |
| B4 | `buildGenesisBlock` computes block_hash (not day_hash) | I-17: genesis uses block_hash | Cross-platform consistency |
| B5 | `buildGenesisBlock` computes identity_seal over block_hash | Identity signature on genesis | Device attribution from block 0 |
| B6 | `buildGenesisBlock` prev_hash is 64 zeros | Genesis has no predecessor | Sentinel value for first block |
| B7 | `buildGenesisBlock` throws if ledger already has blocks | Prevent double genesis | Ledger must have exactly one genesis |
| B8 | `buildDayBlock` creates block with type=day, correct day_index | Day block structure | day_index increments from last day block |
| B9 | `buildDayBlock` accepts both pre-hashed {hash,data} and raw dict entries | Flexible entry format | CLI and web use different entry formats |
| B10 | `buildDayBlock` always recomputes entry hash from actual data | Integrity: hash reflects data | Prevents hash/data mismatch attacks |
| B11 | `buildDayBlock` computes day_hash via crypto.seal(sorted JSON) | Block seal integrity | Seal must match Python/JS output |
| B12 | `buildDayBlock` adds identity_seal when identitySecret is set | Optional identity signing | Identity secret may be null (e.g., in tests) |
| B13 | `buildDayBlock` omits identity_seal when identitySecret is null | No-identity mode works | Merge and tests may skip identity signing |
| B14 | `buildDayBlock` day_index starts at 1 when no prior day blocks exist | First day block index | After genesis (index 0), first day is index 1 |

### Group C: LedgerChain — Append & Truncate — ~11 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | `append` adds single block to chain | Basic append works | Chain grows by one |
| C2 | `append` verifies prev_hash linkage to last block | Chain integrity on append | Prevents broken chain insertion |
| C3 | `append` throws on prev_hash mismatch | Reject broken linkage | Must fail loudly, not silently corrupt |
| C4 | `append` succeeds when chain is empty (first block) | No linkage check needed for first block | Genesis has no predecessor |
| C5 | `appendBlocks` adds multiple blocks with linkage verification | Batch append with integrity | Multi-block atomic append |
| C6 | `appendBlocks` verifies linkage between all blocks in batch | Internal batch linkage | All blocks in batch must chain together |
| C7 | `appendBlocks` verifies bridge linkage (last existing → first new) | Cross-batch linkage | Prevents gap between existing chain and new blocks |
| C8 | `appendBlocks` throws on internal linkage mismatch | Reject broken batch | Catch errors before any blocks are written |
| C9 | `truncate(removeCount)` removes N blocks from end | Basic truncation | Undo recent blocks |
| C10 | `truncate` preserves at minimum block 0 (genesis) | Genesis protection | Ledger must always have genesis |
| C11 | `truncate` returns removed blocks in order | Removed blocks available for inspection | Caller may need removed blocks for revert |

### Group D: LedgerChain — Verification — ~16 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | `verify` returns true for empty chain | Edge case: no blocks | Trivially valid |
| D2 | `verify` returns true for valid chain (genesis + days) | Full chain verification passes | Normal operation |
| D3 | `verify` returns false when prev_hash is wrong | Linkage break detection | Tampered prev_hash must be caught |
| D4 | `verify` returns false when block seal is invalid | Seal integrity check | Tampered block data must be caught |
| D5 | `verify` returns false when identity_seal is wrong (with identitySecret) | Identity signature check | Tampered identity must be caught |
| D6 | `verify` passes when identitySecret is null (skips identity check) | No-identity mode works | Merge and tests skip identity signing |
| D7 | `verify` returns false when entry hash doesn't match entry data | Entry hash integrity | Tampered entry data must be caught |
| D8 | `verify` content_hash required at format_version >= 0.4.0 | I-06 enforcement | Genesis format_version gates content_hash requirement |
| D9 | `verify` content_hash optional at format_version < 0.4.0 | Backward compat | Old ledgers may lack content_hash |
| D10 | `verify` returns false when content_hash is wrong at v0.4.0+ | Content hash integrity | Prevents entry data tampering |
| D11 | `verifyBlock(index)` checks single block validity | Targeted verification | Useful for status displays and debugging |
| D12 | `verifyBlock(0)` checks genesis type + seal | Genesis-specific checks | Genesis has different validation rules |
| D13 | `verifyBlock` checks prev_hash linkage for non-zero blocks | Linkage for specific block | Must check predecessor |
| D14 | `verifyBlock` returns false for out-of-range index | Graceful bounds handling | Don't crash on bad index |
| D15 | `_hashKeyForBlock` returns correct key for each block type | Hash key resolution | Genesis→block_hash, day→day_hash, month→month_hash, year→year_hash |
| D16 | `verify` key_version invariant: day block kv must not exceed genesis kv | Rotation safety | Prevents blocks from being sealed with future key versions |

### Group E: LedgerChain — Seal & Identity — ~8 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | `computeSeal` produces deterministic HMAC-SHA256 of sorted JSON | Seal is deterministic | Same data = same seal |
| E2 | `computeSeal` output changes when data changes | Seal detects modification | Cryptographic integrity |
| E3 | `verifySeal` returns true for valid seal | Seal verification passes | Roundtrip works |
| E4 | `verifySeal` returns false for wrong seal | Catch tampered seal | Integrity check |
| E5 | `verifySeal` tries compact JSON fallback (cross-platform compat) | Match Python output | Python sort_keys=True produces different whitespace than JS |
| E6 | `computeIdentityMac` returns hex string when identitySecret is set | Identity MAC computation | Used for block signing |
| E7 | `verifyIdentityMac` returns true for valid MAC | MAC verification passes | Roundtrip works |
| E8 | `verifyIdentityMac` returns false for wrong MAC | Catch tampered MAC | Integrity check |

### Group F: LedgerEngine — Commit — ~18 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| F1 | `commit([])` returns null (no entries) | Empty commit is no-op | Graceful handling of empty input |
| F2 | `commit` rejects entry with non-string title | Input validation | Prevent malformed data from entering chain |
| F3 | `commit` rejects entry with non-positive start_epoch | Input validation | Epoch must be valid |
| F4 | `commit` groups entries by date (UTC) | Date grouping | One day block per date |
| F5 | `commit` encrypts startTime_enc, endTime_enc, metadata_enc, pauses_enc | Field encryption | All time/state fields are encrypted |
| F6 | `commit` computes content_hash for each entry | Content hash generation | Survives re-encryption |
| F7 | `commit` computes entry hash (sha256 of sort+indent2 JSON) | Entry hash generation | Cross-client canonical format |
| F8 | `commit` strips staging-only fields (is_active, entry_id, device_uuid, hash) | Clean entry data | Staging fields don't belong in ledger |
| F9 | `commit` appends day block to chain | Day block creation | Each date gets one block |
| F10 | `commit` updates blind index with title→duration | Index maintenance | Index stays in sync with chain |
| F11 | `commit` returns hashPrefix (first 10 chars of last block hash) | Return value | Caller can verify what was committed |
| F12 | `commit` handles entries spanning multiple dates | Multi-day commit | One day block per date, sorted |
| F13 | `commit` per-field encryptable fields (title_enc, tags_enc, comment_enc, duration_enc) when has_encrypted_fields=true | Per-field encryption | Opt-in field-level encryption |
| F14 | `commit` removes plaintext per-field values when encrypted variants exist | Plaintext cleanup | No plaintext leak in ledger |
| F15 | `commit` encrypts empty title/tags when has_encrypted_fields=true | Empty-field encryption | Even empty strings get encrypted to hide whether data exists |
| F16 | `commit` only encrypts comment/duration when non-empty/non-zero | Sparse encryption | Avoid encrypting defaults unnecessarily |
| F17 | `commit` handles entries without end_epoch (estimates from start+duration) | Missing end time | Staging entries may lack explicit end |
| F18 | `commit` first-ever day block uses 64-zero prev_hash when no genesis exists | No-ledger commit | First commit after init |

### Group G: LedgerEngine — Per-field Encryptable Fields — ~6 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| G1 | `_prepareEntries` encrypts title→title_enc when has_encrypted_fields=true | Title encryption | Per-field opt-in |
| G2 | `_prepareEntries` encrypts tags→tags_enc as sorted JSON array | Tags encryption | Tags must be JSON-serialized before encryption |
| G3 | `_prepareEntries` encrypts comment→comment_enc only when non-empty | Sparse comment encryption | Don't encrypt empty comments |
| G4 | `_prepareEntries` encrypts duration→duration_enc only when non-zero | Sparse duration encryption | Don't encrypt zero durations |
| G5 | `_prepareEntries` removes plaintext title/tags/comment/duration when encrypted | Plaintext cleanup | No dual representation in block |
| G6 | `_indexableTitle` returns null for entries with title_enc but no plaintext title | Index skips encrypted titles | Blind index is plaintext only |

### Group H: LedgerEngine — Verify & Revert — ~12 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| H1 | `verify()` delegates to chain.verify() | Engine delegates verification | Single responsibility: chain owns verify logic |
| H2 | `verify()` returns true for valid chain | Full chain passes | End-to-end integrity check |
| H3 | `revert(0)` returns 0 entries (no-op) | Zero revert | Graceful no-op |
| H4 | `revert(count)` restores entries to staging in plain: format | Revert to staging | Entries return to editable state |
| H5 | `revert` decrypts startTime_enc, endTime_enc, metadata_enc, pauses_enc | Decryption on revert | plain: prefix for staging compatibility |
| H6 | `revert` returns correct count of restored entries | Return value | Caller knows how many were restored |
| H7 | `revert` returns -1 when count exceeds available day blocks | Error indicator | Prevents over-revert |
| H8 | `revert` removes reverted blocks from chain | Chain truncation | Chain shrinks on revert |
| H9 | `revert` updates blind index (subtracts reverted durations) | Index consistency | Index stays in sync after revert |
| H10 | `revert` decrypts per-field _enc variants back to plaintext | Per-field decrypt on revert | Encrypted fields become plaintext in staging |
| H11 | `revert` handles entries with pauses_enc (defaults to plain:[]) | Pauses default | Entries may not have pauses |
| H12 | `revert` removes summary blocks between reverted day blocks | Summary cleanup | Summary blocks between days also get reverted |

### Group I: LedgerEngine — Query & Index — ~8 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| I1 | `getBlockCount()` returns total blocks in chain | Block count accessor | Delegate to chain |
| I2 | `getDayBlocks()` returns only day-type blocks | Filtered block access | Excludes summary blocks and genesis |
| I3 | `getLastBlock()` returns most recent block | Last block accessor | Delegate to chain |
| I4 | `queryIndex(fromDate, toDate)` aggregates durations by title | Index query | Date-range aggregation |
| I5 | `queryIndex` returns empty for inverted dates (from > to) | Edge case | Graceful bounds handling |
| I6 | `rebuildIndex()` rebuilds entire index from chain | Index rebuild | Recovery from corruption |
| I7 | `rebuildIndex()` clears existing index before rebuild | Fresh start | Old data purged |
| I8 | `rebuildIndex()` skips entries with encrypted titles (no plaintext) | Index skips encrypted | Blind index is plaintext only |

### Group J: IndexManager — Core Operations — ~14 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| J1 | `update(date, title, +duration)` adds duration to index | Positive update | New entry adds to total |
| J2 | `update` with same title accumulates durations | Aggregation | Multiple entries for same title on same date |
| J3 | `update(date, title, -duration)` removes title when total reaches 0 | Auto-cleanup | Zero-duration titles don't pollute index |
| J4 | `update` removes date entry when last title is removed | Date cleanup | Empty dates don't pollute index |
| J5 | `update` is no-op when subtracting from non-existent date | Edge case | Don't create entries on subtraction |
| J6 | `query(from, to)` aggregates across date range | Range query | Sums all titles in range |
| J7 | `query` returns empty for date range with no data | Empty result | No false positives |
| J8 | `query` handles single-date range (from == to) | Single day query | Boundary inclusivity |
| J9 | `getAll()` returns full index copy | Full index access | Caller can inspect entire index |
| J10 | `clear()` removes all index data | Full reset | Rebuild prerequisite |
| J11 | `clear()` persists empty state to store | Write-through clear | Store reflects cleared state |
| J12 | `reload()` re-reads from store | External update support | Legacy code paths may write directly |
| J13 | `reload()` handles store returning null/empty | Graceful empty load | First-time load |
| J14 | Index data survives reload (roundtrip) | Persistence | Store read/write consistency |

### Group K: IndexManager — Encryption at Rest — ~6 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| K1 | `_flush` encrypts index as `{_enc: ciphertext}` when crypto is available | Encrypted index format | Index at rest is encrypted |
| K2 | `_load` decrypts `{_enc: ...}` wrapper format | Encrypted index loading | Read back what was written |
| K3 | `_load` handles legacy plaintext dict format | Backward compat | Existing ledgers have plaintext index |
| K4 | `_load` handles empty/falsy store value | Fresh start | No existing index |
| K5 | `_flush` writes plaintext when crypto is null | No-crypto fallback | Tests and legacy code without crypto manager |
| K6 | `_load` returns empty cache when decryption fails | Corruption resilience | Don't crash on bad ciphertext |

### Group L: SummaryPolicy — YearMonthSummaryPolicy — ~14 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| L1 | `getSummaryBlocks` returns empty when same month+year as previous block | No boundary | No summary needed for same month |
| L2 | `getSummaryBlocks` inserts month_summary when month changes (same year) | Month boundary | e.g., March → April inserts March summary |
| L3 | `getSummaryBlocks` inserts year_summary then month_summary on year boundary | Year+month boundary | e.g., Dec 2025 → Jan 2026 inserts year_summary(2025) + month_summary(2026-01) |
| L4 | `getSummaryBlocks` handles cross-year month gap (Dec→Feb skips Jan) | Month gap | Jan summary inserted even though no Jan data |
| L5 | `getSummaryBlocks` month_summary has correct month field (YYYY-MM) | Month format | Machine-parseable month identifier |
| L6 | `getSummaryBlocks` year_summary has correct year field (int) | Year format | Simple year number |
| L7 | `getSummaryBlocks` prev_hash of first summary links to previous block | Hash linkage | Chain integrity through summaries |
| L8 | `getSummaryBlocks` prev_hash of second summary links to first summary | Sequential linkage | Adjacent summaries chain together |
| L9 | `getSummaryBlocks` does not insert year_summary if prev is already year_summary | Dedup | Don't double-insert on same boundary |
| L10 | `getSummaryBlocks` does not insert month_summary if prev is already month_summary for same month | Dedup | Don't double-insert same month |
| L11 | `getSummaryBlocks` does not insert month summary for December when year summary just inserted | Dec+year dedup | Year summary already covers December |
| L12 | `getSummaryBlocks` month_summary seal (month_hash) is valid | Block seal | Summary blocks are sealed like day blocks |
| L13 | `getSummaryBlocks` year_summary seal (year_hash) is valid | Block seal | Summary blocks are sealed like day blocks |
| L14 | `getSummaryBlocks` adds identity_seal when identitySecret is set | Identity signing | Optional identity signature on summaries |

### Group M: SummaryPolicy — Alternative Policies — ~3 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| M1 | `YearOnlySummaryPolicy` inserts year_summary but never month_summary | Year-only mode | Some deployments may skip month summaries |
| M2 | `YearOnlySummaryPolicy` does not insert when prev is year_summary | Dedup in year-only | Same dedup logic, different scope |
| M3 | `NoSummaryPolicy` never inserts any summary blocks | No-summary mode | Minimal chain, test environments |

### Group N: LedgerMerge — Fork Detection — ~10 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| N1 | `merge` throws when genesis blocks differ | Genesis mismatch | Different genesis = different ledgers, cannot merge |
| N2 | `merge` finds fork point where blocks diverge | Fork detection | Common prefix preserved, divergent parts merged |
| N3 | `merge` handles identical chains (no divergence) | Identity merge | No-op merge, local chain returned unchanged |
| N4 | `merge` handles local-only entries after fork | Local ahead | Local entries preserved, no remote entries to add |
| N5 | `merge` handles remote-only entries after fork | Remote ahead | Remote entries incorporated into merged chain |
| N6 | `merge` handles both-local-and-remote entries after fork | Both diverged | All unique entries appear in merged chain |
| N7 | `merge` deduplicates by content_hash (strict match) | Dedup by content | Same content = same entry, keep local copy |
| N8 | `merge` sorts entries alphabetically by title | Deterministic ordering | §11.30: privacy-first ordering |
| N9 | `merge` validates both chains before merging | Input validation | Don't merge corrupted chains |
| N10 | `merge` throws with descriptive message when local chain fails validation | Error clarity | Debug merge failures |

### Group O: LedgerMerge — Chain Rebuild — ~10 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| O1 | Rebuilt chain preserves common prefix up to fork point | Common ancestry preserved | Blocks before fork are untouched |
| O2 | Rebuilt chain inserts summary blocks during rebuild | Summary insertion | Day blocks grouped by date, summaries between |
| O3 | Rebuilt chain day blocks have correct day_index (continues from fork) | Index continuity | Day indices don't reset |
| O4 | Rebuilt chain resets day_index to 1 when fork point is a summary block | PHPSPEC §4.4 reset rule | Summary block as fork → fresh day numbering |
| O5 | Rebuilt chain blocks are properly sealed | Block integrity | Every new block has valid seal |
| O6 | Rebuilt chain blocks have identity_seal when identitySecret is set | Identity signing | New blocks signed with identity |
| O7 | Rebuilt chain entries maintain original order (alphabetical by title) | Sort order preserved | Within-day order matches merge sort |
| O8 | Rebuilt chain all prev_hash links are valid | Chain integrity | Rebuilt chain passes verification |
| O9 | Rebuilt chain returns correct stats (localEntries, remoteEntries, duplicatesSkipped, mergedEntries, newBlockCount) | Merge statistics | Caller gets accurate merge summary |
| O10 | Rebuilt chain returns rebuilt index | Index output | Caller can replace local index with merged index |

### Group P: LedgerMerge — Content Hash in Merge — ~5 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| P1 | `_verifyChain` enforces content_hash at format_version >= 0.4.0 | I-06 in merge path | Merge validation enforces content_hash |
| P2 | `_verifyChain` allows missing content_hash at format_version < 0.4.0 | Backward compat in merge | Old ledgers can still be merged |
| P3 | `_verifyChain` validates content_hash when present | Content hash in merge | Correct content_hash is verified |
| P4 | `_verifyBlockData` matches chain.js `_verifyBlockData` behavior | Cross-module consistency | Merge and chain use identical verification logic |
| P5 | `_verifyContentHash` in merge matches chain.js algorithm | Algorithm consistency | Both modules produce same content hash verdict |

### Group Q: LedgerMerge — Edge Cases — ~6 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| Q1 | `merge` handles empty local chain (throws — genesis required) | Empty input rejection | Must have at least genesis |
| Q2 | `merge` handles empty remote chain (throws — genesis required) | Empty input rejection | Both chains must have genesis |
| Q3 | `merge` handles fork at block 0 (immediate divergence after genesis) | Early fork | Common prefix = genesis only |
| Q4 | `merge` with no unique remote entries returns local chain unchanged | Optimized no-rebuild path | Don't rebuild when remote adds nothing |
| Q5 | `merge` preserves entry order within day blocks (alphabetical by title) | Stable sort | Deterministic output across platforms |
| Q6 | `merge` handles entries across multiple dates post-fork | Multi-day merge | Day grouping works correctly after fork |

### Group R: Integration — Commit-to-Verify Roundtrip — ~12 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| R1 | Commit 5 entries → chain has 1 day block with 5 entries | Basic commit | Single-day commit produces one block |
| R2 | Commit 5 entries → verify() returns true | End-to-end integrity | Full chain verification passes |
| R3 | Commit entries on 2 different dates → 2 day blocks | Multi-day commit | Date grouping produces multiple blocks |
| R4 | Commit entries spanning year boundary → year_summary + month_summary inserted | Summary insertion | Year/month boundaries trigger summaries |
| R5 | Commit → revert(1) → entries back in staging → verify() still passes | Revert roundtrip | Chain integrity after partial revert |
| R6 | Revert restores correct number of entries | Revert count accuracy | Engine reports exact restored count |
| R7 | Modify committed block data → verify() returns false | Tamper detection | Chain verification catches modification |
| R8 | Modify committed entry hash → verify() returns false | Entry hash tamper | Entry-level tampering caught |
| R9 | Commit → rebuildIndex() → queryIndex() returns correct totals | Index rebuild | Full index reconstruction from chain |
| R10 | Commit with has_encrypted_fields → encrypted title not in index | Encrypted title exclusion | Blind index skips encrypted titles |
| R11 | Commit with per-field encryption → revert restores plaintext fields | Per-field revert | Encrypted fields become plaintext on revert |
| R12 | Content hash survives re-commit (identical entry → same content_hash) | Content hash stability | Same plaintext fields = same hash regardless of encryption |

### Group S: Cross-Platform Byte Identity — ~8 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| S1 | Dart `computeEntryHash` output matches Python for known test vector | Cross-platform hash | Same entry = same hash across platforms |
| S2 | Dart `getBlockHash` returns same value as Python for known block | Cross-platform block hash | Same block = same hash key resolution |
| S3 | Dart seal output matches Python seal for same data+key | Cross-platform seal | HMAC-SHA256 deterministic across platforms |
| S4 | Dart day block structure matches Python `buildDayBlock` output | Cross-platform block structure | Same field names, types, nesting |
| S5 | Dart genesis block structure matches Python genesis format | Cross-platform genesis | Same identity fields, same seal logic |
| S6 | Dart content_hash matches Python for known entry with encrypted fields | Cross-platform content hash | Decrypt→canonicalize→hash produces same output |
| S7 | Dart entry hash matches JS `computeEntryHash` for known test vector | Dart→JS compatibility | Flutter app can verify web-created entries |
| S8 | Dart seal matches JS seal for same data+key | Dart→JS compatibility | Flutter app can verify web-created blocks |

---

## Summary

| Group | Area | Assertions |
|-------|------|-----------:|
| A | Helpers & Utilities | 15 |
| B | Chain — Block Building | 14 |
| C | Chain — Append & Truncate | 11 |
| D | Chain — Verification | 16 |
| E | Chain — Seal & Identity | 8 |
| F | Engine — Commit | 18 |
| G | Engine — Per-field Encryptable | 6 |
| H | Engine — Verify & Revert | 12 |
| I | Engine — Query & Index | 8 |
| J | IndexManager — Core | 14 |
| K | IndexManager — Encryption | 6 |
| L | SummaryPolicy — YearMonth | 14 |
| M | SummaryPolicy — Alternatives | 3 |
| N | Merge — Fork Detection | 10 |
| O | Merge — Chain Rebuild | 10 |
| P | Merge — Content Hash | 5 |
| Q | Merge — Edge Cases | 6 |
| R | Integration Roundtrip | 12 |
| S | Cross-Platform Identity | 8 |
| **Total** | | **196** |

### Key Coverage Areas

1. **Block integrity** — Every block type (genesis, day, month_summary, year_summary) has
   correct structure, sealing, and optional identity signing
2. **Chain operations** — Append with linkage verification, truncate with genesis protection,
   full and single-block verification
3. **Commit pipeline** — Field encryption, content hash, entry hash, date grouping,
   summary insertion, index update — the full end-to-end flow
4. **Revert** — Decryption back to staging, index subtraction, summary cleanup
5. **Blind index** — Encrypted at rest, plaintext query interface, rebuild from chain
6. **Summary policy** — Year/month boundary detection, dedup prevention, seal+sign
7. **Chain merge** — Fork detection, content-hash dedup, chain rebuild with summaries,
   cross-module verification consistency
8. **Cross-platform** — Byte-identical output with Python and JS reference implementations
9. **Per-field encryption** — Opt-in title/tags/comment/duration encryption, sparse defaults,
   plaintext removal, revert back to plaintext
10. **Edge cases** — Empty chains, zero-ops, boundary conditions, format version gating,
    backward compatibility with legacy formats
