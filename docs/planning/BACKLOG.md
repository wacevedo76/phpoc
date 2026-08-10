# PHPOC Backlog — Active Issue Queue

> **Last updated:** 2026-08-10
> **Sources consolidated:** `docs/design/flaws/ISSUES_TO_ADDRESS.md` (17 issues, 3 Critical / 5 High / 6 Medium / 3 Low),
> `docs/design/flaws/PHPSPEC-Design_Flaws.md` (13 flaws + 4 observations).
> Those files are retired — this document is the single queue.
>
> **Severity tiers** (from flaw documents): 🔴 Critical — 🟠 High — 🟡 Medium — 🟢 Low
>
> **Rule:** Every item here has a concrete next action. No "someday" items.
> Phases are ordered — each phase unblocks the next.
> Within each phase, items are ordered by severity (Critical → High → Medium → Low).

---

## ✅ B-03: Flutter — Staging Schema Overhaul ✅

**Plan:** `docs/planning/flutter/STAGING_OVERHAUL_PHASE1.md` (110 assertions, 11 groups)
**Completed:** 2026-07-28 — Full 4-Phase TDD. Phase 4: 6 improvements across 3 files.
- **Phase 1:** 110 assertions blueprinted across 11 groups (A–K)
- **Phase 2:** 111 RED tests across 7 files
- **Phase 3:** 111/111 GREEN + 125/125 old tests pass
- **Phase 4:** 6 improvements (conciseness: consolidated `_readColumn`, deduplicated `_dedupKey`/`_mapDedupKey`, extracted `_inDateRange()`, deduplicated `_doPush()` retry; clarity: extracted `_buildActivityData()` + `_decodeActivityBlob()`). Full suite: 1339/1341 GREEN.

**Deliverables delivered:** ActivityIdGenerator, StagingStore, StagingMigration, StagingHashIndex, row-level SyncService mutations, commitAndSync pipeline, debounced auto-push, unified Sync button with checkboxes, offline queue, syncStatus stream.

---

## 🟠 CCS: Cross-Client Staging Sync & Reconciliation

**Goal:** Full staging sync interoperability across Flutter, Web, and CLI.
**Primary reference:** `docs/reference/CROSS_CLIENT_STAGE_SYNCING_REFERENCE.md` §12 (abstract workflow)
**Implementation plan:** `docs/planning/CROSS_CLIENT_REMOTE-LOCAL_STAGING_SYNC-RECONCILIATION_PLAN.md` (scorecard, phases, dependency graph)
**Consolidates:** B-04, B-05, ADR-025, P3

### Canonical Format (All Decisions Resolved ✅)

| Decision | Resolution |
|----------|-----------|
| Transport model | Single blob + hash index (Model C) — retire per-row CRUD (`row_sync.js`) |
| Blob path | `staging/blob` (canonical) |
| Hash index path | `staging/hash_index.json` |
| Entry identity | `activity_id` as single primary key; `entry_id` legacy only |
| Merge tie-break | Local-wins on equal `updated_at` |
| Envelope `updated_at` | Omitted (hash index supersedes) |
| JSON serialization | Compact (no whitespace) |
| Obfuscation | Flutter/Web scheme (simpler than CLI 4-tier) |
| `committed` flag | Canonical row field (cross-device cleanup signal) |
| Backward compat | Immediate cutover (single user — no migration window) |

### Status Matrix

| Client | `staging/blob` | Hash Index Wired | `activity_id` | Local Row Store | Sync Gate Wired |
|--------|----------------|-----------------|---------------|-----------------|-----------------|
| **Flutter** | ✅ | ✅ | ✅ | ✅ SQLite | ✅ |
| **Web** | ❌ old path | ❌ code exists, not wired | ✅ | ✅ IndexedDB | ❌ |
| **CLI** | ✅ | ✅ | ✅ | ❌ `staging.json` | ❌ |

### Already Completed (Foundation)

- ✅ **B-03:** Flutter Staging Schema Overhaul — SQLite row store, activity IDs, hash index, debounced auto-push (`staging/blob`) — `STAGING_OVERHAUL_PHASE1.md` (110 assertions)
- ✅ **B-04:** Flutter Row-Level Sync Wiring — `_fastPathRowLevel()`, `_reconcileAndClaimRowLevel()`, `StagingPaths.remoteRowLevelBlob`, merge via `mergeEntries()` — `B04_ROW_LEVEL_SYNC_PHASE1.md` (56 assertions, 54/54 GREEN, Phase 4 done)
- ✅ **B-05c:** CLI transport alignment — `staging/blob` path, `StagingHashIndex`, `ActivityIdGenerator`, compact JSON — 52/52 GREEN
- ✅ **B-05b old status was inaccurate:** Web `RowStagingStore` exists (GREEN) but sync gate (`sync.js`) still uses `staging/blobs/current.json` — no references to `RowStagingStore` or `staging/blob` in `sync.js` (verified 2026-08-07)
- ✅ Canonical format decisions resolved (see table above)
- ✅ Worker generic blob handlers serve any R2 path — no Worker changes needed for single-blob model

---

### ✅ CCS-1: Flutter — Close Remaining Gaps ✅

**Status:** ✅ 4-Phase TDD Complete (2026-08-07).

**Phase 1:** 30 assertions → `docs/planning/CCS1_PHASE1.md`
**Phase 2:** 30 RED (9 pass/21 fail) → `phpoc-flutter/test/data/sync/ccs1_gap_closure_test.dart`
**Phase 3:** 30 GREEN → `sync_service.dart` + `device_cookie.dart`
**Phase 4:** 2 improvements — extracted `_filterRemoteRowsForMerge()` (modularity/clarity: names the 8-line remote-row filtering lambda), extracted `_afterMutation()` (conciseness: deduplicates `_touchLocalCookie()`+`_schedulePush()` pattern repeated 6× across mutation wrappers)

**Gates closed:**

| # | Gate | Fix | Lines |
|---|------|-----|-------|
| 1 | R7 | Push hash index after blob in `_pushStagingRowsToRemote`, `pushToRemote` | `sync_service.dart` |
| 2 | R4 | Filter committed rows in `_pushStagingRowsToRemote` + `_reconcileAndClaimRowLevel` (remote-committed-only) | `sync_service.dart` |
| 3 | A2 | Check cookie existence before TTL; return `reauthNeeded` on expiry; `isValidLocally` no longer destroys cookie | `sync_service.dart` + `device_cookie.dart` |
| 4 | F1 | Implement `hasPendingWrites()`; skip network in `checkAndSync` on zero writes | `sync_service.dart` |

**Remaining known issue:** `_pushBlobOnly()` + `StagingPaths.remoteStagingBlob` — old-path zombie (line 738, `staging/blobs/current.json`). Only hit when `stagingStore == null` (legacy LocalCache fallback, never reached in normal operation). Remove after CCS-2 lands.

---

### ✅ CCS-2: Web — Wire Row-Level Sync (Option B) — COMPLETE

**Status:** ✅ Complete (4-phase TDD). **Option B** adopted — `LocalCache` stays the authoritative CRUD/DTO store; a row-level **reconcile layer** threads canonical-row (activity_id) semantics through `SyncService.checkAndSync()` while preserving the DTO contract. Unified 4-phase plan: `docs/planning/CCS2_PHASE1.md` (24 assertions; **14 new RED** across Groups A/B/C + U-rehome, **10 🟢 anchors**).

| Phase | Deliverable |
|-------|-------------|
| P1 ✅ | Blueprint `docs/planning/CCS2_PHASE1.md` |
| P2 ✅ | RED tests `phpoc-web/test/ccs2_row_level_reconcile_test.mjs` |
| P3 ✅ | GREEN — merged into `sync.js` `_reconcileDifferentDevice` via `mergeRows` (activity_id LWW local-wins-on-tie); `dtoToCanonicalRow` exported from `remote_sync.js`; canon/legacy blob bridge; committed-exclusion; C2 status-only fast-path detection |
| P4 ✅ | REFACTOR — extracted `_mergeRemoteIntoLocal()` + module-level `_rowsFromRemoteBlob()`; removed dead `compareStagingHashIndexes`/`computeHashForIndex` imports |

**Result:** CCS-2 suite **41/41 GREEN**; full web suite no regressions (76/14, 14 pre-existing env/WASM/DOM). 21 `sync_service_test` ledger-chain failures remain known/out-of-scope.

**Explicitly NOT done (Option A deferred):** migrating `SyncService` CRUD to `RowStagingStore` as authoritative store — deferred to a future CCS task.

**Blocks:** CCS-4 (Web cross-client testing).

---

### ✅ CCS-3: CLI — Build Row-Level Store + Wire Sync Gate ✅

**Status:** ✅ 4-Phase TDD Complete. Store-level foundation (tasks 1–3) covered by `tests/test_sqlite_staging.py` (104 tests GREEN); sync-gate wiring (tasks 4–8) covered by `tests/test_cli_sync_gate_wiring.py` (**60/60 GREEN**). **Phase 4 (REFACTOR):** extracted `StagingService._resolve_device_id()` (dedup device-identity resolution across `_ensure_cookie`/`_reconcile_and_claim`/`push_to_remote`/`push_blob_only`; removed dead nested `_remote is None` guards) and `_remote_entries_to_dtos()` (consolidates raw→DTO conversion across `_push_on_fast_path`/`_reconcile_and_claim`/`_merge_remote_into_local`); simplified `dtoToCanonicalRow` device_id default. Full suite GREEN: 2535 pass / 1 skip / 0 fail.

**Plan:** `docs/planning/CLI_SYNC_GATE_WIRING_PHASE1.md` (Phase 1–3 done)

**What needs to happen:**

| # | Task | Source file |
|---|------|------------|
| 1 | Implement `SqliteStagingStore` — schema: `(activity_id TEXT PK, activity_status TEXT, activity TEXT, updated_at INTEGER)` | new file |
| 2 | Implement CRUD: `getAllRows()`, `putRow()`, `deleteRow()`, `getRow()` | new file |
| 3 | Implement `migrate_from_staging_json()` — one-shot conversion, generate activity_ids if missing | new file |
| 4 | Wire `StagingHashIndex.build(store)` — reads from SQLite, builds sorted index | `core/staging_hash_index.py` |
| 5 | Wire `SqliteStagingStore` into `StagingService.check_and_sync()` — replace LocalCache reads/writes | `domain/staging/service.py` |
| 6 | Switch merge to activity_id-based LWW (currently entry_id-based) | `domain/staging/merge_engine.py` |
| 7 | Update `_reconcile_and_claim()` to use StagingStore + mergeEntries | `domain/staging/service.py` |
| 8 | Tests: SqliteStagingStore CRUD (~30), migration (~10), sync gate wiring (~30), integration (~20) | test files |

**Test plan:** ~66 tests from `ROW_LEVEL_STAGING_SYNC_PLAN.md` categories E–J.

**Effort:** Medium (~1-2 days). **Blocks:** CCS-4 (CLI cross-client testing).

---

### 🔜 CCS-4: Cross-Client E2E Testing

**Depends on:** CCS-2 ✅ (Web), CCS-3 ✅ (CLI)

**Goal:** Verify full staging sync interoperability between all client pairs against a live Worker.

**Test pairs:**

| Pair | What to Verify | Test Environment |
|------|---------------|-----------------|
| Flutter ↔ Web | Same MK → create entries on Flutter, sync, pull on Web → entries match | Emulator + Vivaldi browser |
| Flutter ↔ CLI | Same MK → create entries on Flutter, sync, pull via CLI → entries match | Emulator + Python CLI |
| Web ↔ CLI | Same MK → create entries on Web, sync, pull via CLI → entries match | Vivaldi browser + Python CLI |

**Key assertions per pair:**
1. Hash index is byte-identical across clients (same SHA-256)
2. Obfuscated blob is byte-identical (same plaintext + MK → same ciphertext)
3. Merge produces identical result regardless of which client merges
4. Cookie specifier matches across clients (same MK + device_id → same specifier)
5. Committed entries cleaned up on both sides after one client commits

**Existing E2E infra:** `tests/test_cross_platform_integration.py` (CLI ↔ Worker), `BROWSER_E2E_TEST_PLAN.md` (Web E2E).

**Effort:** Medium (~1-2 days). **Blocks:** None (final validation gate).

---

### 🔜 Staging Auto-Sync: Flutter — Upgrade Auto-Push to Bidirectional Sync

**Status:** Queued (after CCS-4). **Plan:** `docs/planning/STAGING_AUTO_SYNC_PLAN.md`

**What:** Replace `_doPush()` → `_attemptPush()` (push-only) with `checkAndSync()` (pull + merge + push). Every staging mutation automatically syncs bidirectionally instead of just pushing.

**Tests needed:** 4 new tests (AS1–AS4) for bidirectional merge, reauth handling, no-transport safety, fast-path efficiency.

**Effort:** Small (~1-2 hours). **Blocks:** Nothing.

---

## ~~🔴 B-02: Flutter — Auto-push staging blob on every mutation~~ (subsumed by B-03)

B-02's scope (debounced auto-push on mutation) is folded into B-03 deliverable #4. The broader architectural changes (activity IDs, row schema, commit-and-clean) make B-03 the correct tracking unit.

---

## ✅ Completed: Web Staging Committed-Flag Loss

### B-01: Committed ledger entries duplicated as staging (web sync) ✅

**Plan:** `docs/planning/WEB_STAGING_COMMITTED_FLAG_LOSS_PHASE1.md`

**Completed:** 2026-07-15 — Full 4-phase TDD.
- Phase 1: 27 assertions across 5 groups (A–E)
- Phase 2: 28 RED tests across 4 files
- Phase 3: 3 bugs fixed — `entry_dto.js` (committed/block_index in rawEntryToDTO + rawCommittedEntryToDTO), `remote_sync.js` (serialization in pushBlob), `sync.js` (post-merge committed filter in `_reconcileDifferentDevice`)
- Phase 4: 2 refactors — fixed undefined `mk` bug, removed dead `_reconcileSameDevice`

---

## ✅ Completed: Phase 0 — Doc Fixes

| # | Sev | Action | File | What changed |
|---|-----|--------|------|-------------|
| I-08 | 🟠 | Add Known Limitations section | `docs/spec/PHPSPEC.md` | New section + TOC entry: HMAC≠signature, plaintext index/staging, key-derived device IDs, no key rotation. Cross-linked to BACKLOG. |
| I-10 | 🟡 | Fix zero-dependency claim | `docs/spec/PHPSPEC.md` §1.1 | Changed to "CLI reference implementation uses only Python stdlib crypto. Web/mobile use a shared Rust crypto core." |
| I-13 | 🟡 | Fix Invariant #1 | `docs/reference/MAP.md` Architecture Invariants §1 | Scoped to CLI + web/mobile exception. |
| I-14 | 🟡 | Remove forward-looking content | `docs/spec/PHPSPEC.md` §5.5, §6.1, §9.3 | Bumped version to 0.4.0; removed forward-looking framing; deleted future v0.3.0→v0.4.0 migration section. |
| I-15 | 🟢 | Fix AES-128 justification | `docs/spec/PHPSPEC.md` §2.6 | Replaced incorrect "effective security level is 256 bits" with accurate AES-128 justification. |
| I-16 | 🟢 | Delete duplicate paragraph | `docs/spec/PHPSPEC.md` §9.3 | Removed duplicate "cascades through the entire chain" paragraph. |

**Completed:** 2026-07-15 — All 6 doc fixes applied, no code impact.

---

---

## ✅ Phase 1 — Complete: Staging Alignment + E2E

### 1a. Align web staging sharing with CLI ✅

**Plan:** `docs/planning/ALIGN_WEB_STAGING_SHARING_WITH_CLI.md`
**Completed:** Stages 1.1–1.5 all done.

### 1b. Browser E2E tests ✅

**Plan:** `docs/planning/BROWSER_E2E_TEST_PLAN.md`
**Completed:** E2E-03 (9/9), E2E-04 (4/4), E2E-05 (Phases 1-4), E2E-06 (complete), E2E-07 (13/13) — all 5 E2E tests pass.

---

## 🟡 Phase 2 — Low-Effort Code Fixes

*After Phase 1. Small, low-risk changes that improve correctness.
Ordered per flaw-doc recommended attack sequence: naming → salt → integrity → platform warnings.*

### I-04 🟠: Rename HMAC "signature" → "seal"/"tag" — PENDING

**Status:** 🔜 Not started. No Phase 1 blueprint yet.
**Why:** Misleads implementers about security properties. Must happen before real Ed25519 is added.
**Flaw doc attack order:** Step 2 (naming fixes).

**Partial progress (from I-01 key rotation work):**
- ✅ Block field name `identity_seal` used in `build_day_block()` (Python + JS)
- ✅ Dual field acceptance: `identity_seal || signature` in both `chain.py` and `chain.js`
- ✅ Methods `mac()` and `verifyMac()` added to `crypto.py`

**Remaining:**
| File | Change |
|------|--------|
| `docs/spec/PHPSPEC.md` §2.7, §4, §5.3 | Rename `signature` field → `identity_seal` in all block type tables, examples, and validation rules (~10 occurrences) |
| `security/crypto.py` | Rename `signature` parameter → `seal_hex` in `verify_seal()` (3 locations: abstract base, JS bridge, seal implementation) |
| `domain/ledger/chain.py` | Rename `signature` parameter in `verify_seal()` |
| All test files | Update field names and parameter names |

**Effort:** ~1 hour (mostly spec + parameter rename, field-level rename already done). **Blocked by:** nothing.

### I-05 ✅: Per-user PBKDF2 salt

**Why:** Fixed `b"session-salt"` enables cross-user rainbow tables when passphrases are reused.
**Flaw doc attack order:** Step 3 (salt fix).

**Completed:**
- ✅ `security/auth.py`: `derive_pdk_salt()` — `SHA-256(identity_pub_key)[:16]` per-user salt
- ✅ `get_pdk_salt_from_genesis()` — reads genesis pub_key, falls back to `b"session-salt"` for old ledgers
- ✅ `OLD_SALT = b"session-salt"` — backward-compat salt detection (tries new first, falls back)
- ✅ `docs/spec/PHPSPEC.md` §2.4 updated

### I-06 🟠→✅: Make `content_hash` required at v0.4.0+

**Why:** Optional means entries without it have zero re-encryption-survivable integrity.
**Status:** ✅ 4-Phase TDD Complete (2026-07-15)

**Phase 3 implementation:**
- `domain/ledger/chain.py`: Added `_parse_format_version()` and `_is_format_version_at_least()` helpers; `verify()` now extracts format_version from genesis and requires content_hash at ≥ 0.4.0
- `phpoc-web/src/ledger/chain.js`: Added version helpers + `_verifyContentHash()` with extensible + legacy fallback algorithms; `_verifyBlockData()` now async, looks up genesis format_version
- `phpoc-web/src/ledger/merge.js`: Added matching content_hash verification with `requireContentHash` parameter; `_verifyChain()` extracts format_version from genesis
- `docs/spec/PHPSPEC.md` §5.5: Updated validation rule and field table; §5.6 pseudocode shows format_version gating

**Test results:** 14 PY + 94 chain JS + 105 merge JS = 213 total I-06 tests GREEN. Full suite: 1853 PY pass, all web tests pass (no regressions).
**Phase 4:** Hoisted `requireContentHash` out of `_verifyBlockData` to `verify()` caller (avoids N redundant genesis reads); aligned `hasContentHash` empty-string check with merge.js.

### I-11 ✅: Add blob obfuscation portability warning + test vectors (Complete 2026-07-15)

**4-Phase TDD:**
- Phase 1: 21 assertions → `docs/planning/I11_BLOB_OBFUSCATION_PORTABILITY_PHASE1.md`
- Phase 2 (RED): 19 PY + 10 Rust integration tests
- Phase 3 (GREEN): `_obfuscate_deterministic()` (Python) / `obfuscate_blob_deterministic()` (Rust) + spec §8.5 portability warning
- Phase 4 (REFACTOR): 2 improvements — deduped `_obfuscate_deterministic()` via `_obfuscate_core(padding_fill=0)`, single `_derive_blob_encryption_keys()` call in `_deobfuscate()`

---

## 🟠 Phase 3 — Encryption Gaps

*After Phase 1. Real security holes that need closing.
Both rated Critical in the flaw documents — they undermine the protocol's core privacy promises.*

### I-03 ✅: Encrypt staging at rest

**Why:** `staging.json` uses `plain:` prefix — on-disk staging is unencrypted, contradicting the protocol's first design principle.
**Flaw doc severity:** Critical. The most recent, most sensitive data is the least protected.
**Status:** ✅ Phase 1-4 complete — 52/52 PY + 35/35 web tests pass. AES-CTR encryption on all staging fields (startTime, endTime, pauses, metadata, device UUIDs) with backward compatibility for legacy `plain:` entries.

| File | Change |
|------|--------|
| `domain/staging/service.py` | Encrypt entries with MK before writing; decrypt on read |
| `domain/staging/remote_sync.py` | Handle encrypted local entries for blob push/pull |
| `phpoc-web/src/sync/sync.js` | Encrypt staging entries in IndexedDB |
| `docs/spec/PHPSPEC.md` §8.2, §8.4 | Document encryption requirement |

**Effort:** ~1 week. **Depends on:** Phase 1a (staging alignment must finish first). **ADR:** ADR-015 (D2 design direction).

**Next action:** After Phase 1a, implement encrypted staging write/read in `service.py` first.

### I-02 ✅: Encrypt blind index + staging field key encryption

**Why:** `index.json` stored `{date: {activity_title: total_duration_ms}}` in plain JSON next to the encrypted ledger. Staging field key names (`startTime_enc`, etc.) were also plaintext, revealing schema structure.
**Status:** ✅ Phase 1-4 complete (2026-07-16). 74 assertions blueprinted, 103 PY + 67 JS tests GREEN. 6 Phase-4 refactors.

**Files changed:**
- `security/crypto.py`: `derive_index_key()`, `derive_field_key()`, `build_field_token_map()`, `STAGING_ENCRYPTABLE_FIELDS`
- `domain/ledger/index_manager.py`: `_load()` / `_flush()` encrypt/decrypt via `_enc` wrapper
- `domain/staging/local_cache.py`: field-name HMAC tokenization, backward compat for legacy `_enc` keys
- `domain/staging/service.py`: `_raw_entry_to_dto()` decodes encrypted field-name tokens from remote blobs
- `phpoc-web/src/ledger/index_manager.js`: `_flush()` / `reload()` encrypt/decrypt via AES-CTR
- `phpoc-web/src/sync/local_cache.js`: `_fieldToken()`, `_encodeDataKeys()`, `_decodeDataKeys()`

**🟡 Follow-up: JS `_fieldToken()` uses SHA-256 without MK (see §I-02a below)**

### I-02a ✅: JS `_fieldToken()` — use MK-derived HMAC for field-name tokens

**Why:** `phpoc-web/src/sync/local_cache.js` `_fieldToken()` uses `SHA256("phpoc-staging-keys-v1" + fieldName)` instead of `HMAC-SHA256(derive_field_key(MK), fieldName)`. This means field-name tokens are the same for every user — an attacker who reads IndexedDB and knows the PHPOC source can trivially map tokens back to field names (`de31e1f1cf5d6fa6` → `startTime_enc`).

**Impact:** Schema obfuscation is weakened — the structure of staging entries is revealed (which fields exist), but the actual field VALUES remain AES-CTR encrypted with the master key. This is defense-in-depth, not a primary encryption failure. The tokens are local-only (IndexedDB), never pushed to remote.

**Fix:** Add `hmac_hex` WASM binding (Rust `hmac_utils.rs` already has the function), add JS wrapper in `crypto/index.js`, then update `_fieldToken()` to use it. Also need `derive_field_key` WASM binding.

**Files:**
- `phpoc-crypto-core/src/wasm.rs` — add `hmac_hex` + `derive_field_key` WASM exports
- `phpoc-web/src/crypto/index.js` — add `hmacHex()` + `deriveFieldKey()` wrappers
- `phpoc-web/src/sync/local_cache.js` — update `_fieldToken()`

**Effort:** ~1 hour. **Depends on:** nothing. **Next action:** Add WASM bindings for `hmac_hex` and `derive_field_key`.

---

## 🔴 Phase 4 — Architectural Rework

*After Phases 2–3. Major features that need design work before implementation.*

### I-01 🔴: Key rotation

**Why:** One MK protects everything forever. Compromise = permanent, catastrophic, no remediation path.
**Flaw doc severity:** Critical — the single biggest architectural gap in the protocol.
**Status:** ✅ Phases 1-4 complete (2026-07-17). ADR-026 implemented: `derive_mk()` + versioned `CryptoManager` in crypto.py, multi-version `verify()`/`verify_block()` with `get_mk_for_version` in chain.py, `get_mk()`/`key_version`/`_keys` in auth.py, `RotateKeysCommand` skeleton in phpoc_cli/rotate_keys.py, JS `deriveMk()` + `CryptoManager` in phpoc-web. 95/95 PY + 13/13 JS GREEN. 5 Phase-4 improvements.

**Required:** `key_version` field on blocks, re-encryption workflow, coexistence of blocks under different key versions.

| Deliverable | What |
|-------------|------|
| ~~ADR~~ | ✅ ADR-026: versioned MKs, per-block key_version, soft+hard rotation |
| `domain/ledger/engine.py` | Key version field + multi-version verification |
| `security/crypto.py` | Re-encrypt entry with new MK |
| Migration | Re-encrypt existing chain under new key |

**Effort:** High (weeks). **Depends on:** I-04 (naming) ✅, I-06 (content_hash required) ✅.

**Next action:** See I-01a below.

### I-01a ✅: RotateKeysCommand execution

**Why:** I-01 built the crypto primitives (versioned MK derivation, multi-version chain
verification) but the actual rotation command is still a skeleton. Without this, the MK
cannot actually be rotated — it's all infrastructure and no action.
**Status:** ✅ Phases 1-4 complete (141/141 PY). **Depends on:** I-01 (crypto foundation) ✅.
**Blocks:** I-09 (device attribution needs rotation to re-derive device IDs).

**Soft rotation deliverables:**
- Re-authenticate and verify chain integrity
- Derive new MK (key_version = current + 1)
- Re-encrypt `identity_secret_enc_fallback` with new MK
- Re-encrypt all staging entries with new MK
- Rebuild and re-encrypt blind index with new index key
- Re-derive device cookie with new MK
- Re-seal genesis with new MK (increment `key_version`)

**Hard rotation (`--full`) adds:**
- Create backup of current chain
- Re-encrypt every entry in every day block
- Update `key_version` on all blocks
- Recompute all seals, MACs, and `prev_hash` links

**Files:** `phpoc_cli/rotate_keys.py` (main), `security/auth.py` (`_keys` population),
`domain/ledger/chain.py` (re-seal helpers), `storage/` (backup).

**Effort:** Medium. **Next action:** Phase 1 (test blueprint) → Phase 2-4 TDD.

### I-09 ✅: Hardware-bound device attribution — Phases 1-4 complete

**Plan:** `docs/planning/I09_DEVICE_ATTRIBUTION_PHASE1.md` (49 assertions, 9 groups)
**Why:** Device IDs are derived from MK. Any device with the MK can impersonate any other device.
**Flaw doc severity:** Medium — "device attribution is theater."

| File | Change |
|------|--------|
| `domain/cookie/device_cookie.py` | Derive device ID from MK + device-local secret (UUID4, not from MK) |
| `security/auth.py` | Generate and store per-device secret on first run |
| `phpoc-web/src/sync/sync.js` | Use IndexedDB-stored device secret |

**Effort:** Medium. **Depends on:** nothing.

**Completed:** 2026-07-17 — 49 assertions, Phases 1-4. `_ensure_device_local_secret()` in `security/auth.py`, `derive_device_id(mk, device_local_secret)` in `security/device_identity.py`. Device IDs now use UUID4 device-local secret + MK derivation, not MK alone.

### I-12 ✅: System architecture document (Complete 2026-07-17)

**Deliverable:** `docs/design/SYSTEM_ARCHITECTURE.md` — 11-section comprehensive architecture document synthesizing all 11 directives (D1–D11), 26 ADRs, cross-platform strategy, and reference implementations. Covers: system overview, key hierarchy (seed→MK→sub-keys, versioned MKs, rotation), chain structure (hierarchical lock chain, block types, content hash, verification), staging pipeline (staging vs ledger, entry lifecycle, encryption, blind index), transport layer (Worker, R2 layout, blob obfuscation, device cookie), multi-device sync (lifecycle, hash index fast path, device identity, merge engine, row-level staging), cross-platform strategy (Rust→WASM/.a/.so), crypto core (phpoc-crypto-core structure + ring dependency), web application (React + IndexedDB + WASM architecture), CLI reference implementation (package map), and 25 architectural invariants. Includes cross-reference table to all source documents.

---

## 🔵 Phase 5 — Cross-Client Format Unification

*After architectural work stabilizes. Cross-client format unification may change serialization paths, so it should land before CLI polish.*

### P1: Canonical cross-client serialization ✅

**Problem:** 3 incompatible serializations exist (raw chain, v2 envelope, per-block R2).
**Decision:** Option A1 — Unified canonical JSON serialization (`sort_keys=True`) across all three contexts.
**Completed:** Phases 1-4 complete — 43/43 GREEN. `docs/planning/CROSS_CLIENT_SERIALIZATION_PHASE1.md` (43 assertions, 6 groups).

### Entry hash indent=2 consolidation — ✅ Phase 1-4 complete

**Plan:** `docs/planning/ENTRY_HASH_CONSOLIDATION_PHASE1.md` (17 assertions, 4 groups)

**Completed:** 2026-07-18 — Full 4-phase TDD.
- Phase 1: 17 assertions across 4 groups (A–D)
- Phase 2: 17 RED tests in `tests/test_entry_hash_consolidation.py`
- Phase 3: 4 functions updated — `_verify_ledger_entry_hash` (→ 3-way flex), `_verify_entry_hash` (→ 2-way), `_verify_entry_hash_updated` (→ 2-way)
- Phase 4: 3 improvements — extracted `verify_entry_hash_two_way()` to `helpers.py` (shared by all 3 verifiers), simplified `_verify_entry_hash_flex()` (chain.py), reduced ~30 lines of duplicated hash logic across 3 call sites

---

## 🔵 Phase 6 — CLI Polish

*After cross-client format unification. Polish and performance fixes for the CLI reference implementation.*

### P5: CLI unlock latency — ✅ Phase 1-4 complete

**Plan:** `docs/planning/P5_CLI_UNLOCK_LATENCY_PHASE1.md` (32 assertions, 6 groups)

**Phase 4 improvements:** Extracted `_timeout_s()` in HttpStagingTransport, simplified `effective_key` in RemoteStagingSync.pull(), updated 23 tests for P5 read-only fast path.

### P4: CLI kinks & UX polish ✅

**Status:** Phases 1-4 complete (24 assertions). Phase 4 refactor: extracted `_reauth_staging()` helper (eliminated 6 duplicated re-auth blocks), moved `_list_tags` → `CLIInterface.list_tags()`, explicit `_reauth_notified` init.

---

## 🔵 Phase 7 — Remote Sync

### P3: Remote sync (git-based)

**Status:** Deferred. Infrastructure exists (`GitStagingTransport` implemented, 37 tests pass, blob obfuscation done). Remaining: `init --git-create` (GitHub API PAT → create private repo).

**Note:** Consolidated into CCS goal (§CCS-1 through CCS-4 above) — single-blob + hash index model (Model C) is canonical. Git transport is an alternative backend, not a separate staging architecture.

**Next action:** After cross-client staging sync is fully interoperable.

---

## ✅ Phase 8 — Per-Activity Field Encryption (Complete)

*Allow users to encrypt title, tags, comment, and duration on a per-activity basis. Default is plaintext (current behavior). Encrypted entries show `[encrypted]` placeholder until user reveals via auth.*

### P6: Encrypt all entry fields — Web (React) ✅

**Plan:** `docs/planning/ENCRYPT_ALL_ENTRY_FIELDS_WEB_PHASE1.md` (61 assertions, 9 groups)
**Completed:** Phases 1-4 complete — all 61 assertions GREEN. Per-field encryption with `[encrypted]` placeholders.

### P7: Encrypt all entry fields — CLI (Python) ✅

**Plan:** `docs/planning/ENCRYPT_ALL_ENTRY_FIELDS_CLI_PHASE1.md` (72 assertions, 9 groups)
**Completed:** Phases 1-4 complete — 72/72 GREEN. 5 Phase-4 improvements: extracted `_decrypt_staging_field()`, cleaned `_apply_entry_encryption()` API, extracted `_toggle_encryption()`, added `_PER_FIELD_ENCRYPTABLE` list, extracted `_verify_content_hash_v030()`.

---

## Summary by Phase

| Phase | Items | Status |
|-------|-------|--------|
| **0** — Doc fixes | I-08, I-10, I-13, I-14, I-15, I-16 (6) | ✅ Complete 2026-07-15 |
| **1** — Staging + E2E | Staging alignment (5 stages) + E2E (5 tests) | ✅ Complete |
| **2** — Low-effort code | I-04, I-05, I-06, I-11, I-02a (5) | ✅ Complete |
| **3** — Encryption gaps | I-03, I-02 (2) | ✅ Complete |
| **4** — Architectural | I-01, I-01a, I-09, I-12 (4) | ✅ Complete |
| **5** — Cross-client | P1, indent=2 (2) | ✅ Complete |
| **6** — CLI polish | P5, P4 (2) | ✅ Complete |
| **7** — Remote sync | P3 (git-based, deferred) | 🔵 Deferred |
| **8** — Per-activity encryption | P6 (Web, 61), P7 (CLI, 72) | ✅ Complete |
| **CCS** — Cross-Client Staging Sync | CCS-1 (Flutter verify), CCS-2 (Web wire), CCS-3 (CLI row store), CCS-4 (E2E testing) | 🔴 🟠 Active |
| **Flutter** — Mobile app | Models (94), Crypto FFI (74), Services (65), Storage (100), Sync Core (106), Screens (109), Ledger Engine (196) — 7 modules, 744 assertions + B-03 (110) + B-04 (56) | ✅ Phases 1-4 complete (~1500 tests) |

**Resolved:** I-07 (format_version in seal) ✅, I-17 (day_hash → block_hash) ✅, I-12 (system architecture doc) ✅ — Canonical Ledger Format, 2026-07-17.

---

## 🚀 Flutter Mobile App (phpoc-flutter/)

*Riverpod + go_router + SQLite (Drift) — 7 modules, all Phases 1-4 complete (747/747 GREEN).*
*Current suite: 1084/1091 GREEN — 7 pre-existing failures below.*

| Module | Assertions | Phase 1 doc |
|--------|-----------|-------------|
| Models | 94 | `docs/planning/flutter/MODELS_PHASE1.md` |
| Crypto FFI | 74 | `docs/planning/flutter/CRYPTO_FFI_PHASE1.md` |
| Services | 65 | `docs/planning/flutter/SERVICES_PHASE1.md` |
| Storage | 100 | `docs/planning/flutter/STORAGE_PHASE1.md` |
| Sync Core | 106 | `docs/planning/flutter/SYNC_CORE_PHASE1.md` |
| Screens | 109 | `docs/planning/flutter/SCREENS_PHASE1.md` |
| Ledger Engine | 196 | `docs/planning/flutter/LEDGER_PHASE1.md` |
| **Total** | **744** | |

**Tech:** Flutter 3.44.6, Dart 3.12.2, Rust crypto core (`phpoc-crypto-core`), Riverpod, go_router, Drift/SQLite, SharedPreferences.

### ✅ Active Issues — All Resolved

*All test failures have been fixed. Only X1 remains as a pre-existing E2E failure tracked in SESSION_HANDOFF.md.*

---

#### ✅ Chain A: Millisecond Collision Flakiness (5 tests, 1 root cause) — FIXED

**Root cause:** `SyncService.capture()` used `DateTime.now().millisecondsSinceEpoch` internally (ms precision only), and `LocalCache.append()` threw on any same-ms collision. Two rapid `capture()` calls in fast test suites hit the same millisecond → flaky failures.

| # | ID | Test | Symptom | Status |
|---|-----|------|---------|--------|
| **F3** | **F3** | `sync_service_test.dart:455` | `Collision detected` — 3 rapid captures | ✅ Fixed |
| **L1** | **L1** | `sync_service_test.dart:735` | `Collision detected` — 2 rapid captures | ✅ Fixed |
| **S4** | **S4** | `sync_service_test.dart:1859` | `Collision detected` — 2 rapid captures | ✅ Fixed |
| **S6** | **S6** | `sync_service_test.dart:1898` | `Collision detected` — 2 rapid captures | ✅ Fixed |
| **S7** | **S7** | `sync_service_test.dart:1921` | `Collision detected` — 3 rapid captures | ✅ Fixed |

**Fix (Option C):** Two-part fix. (A) `SyncService.capture()` now accepts optional `startEpoch` param (matches Python API). (B) `LocalCache.append()` auto-increments on same-ms collision instead of throwing. **Effort:** ~20 min.

**Files:** `lib/data/sync/sync_service.dart`, `lib/data/sync/local_cache.dart`, `test/data/sync/local_cache_test.dart` (B6 updated).

> **Note:** Original BACKLOG entries F-01 (E13) and F-02 (E16) were already GREEN — the `update()` method was correct. The real failures were the collision flakiness above.

---

#### ✅ Chain B: History Screen — Imported Ledger Rendering (3 tests, 1 root cause) — FIXED

**Root cause:** `_selectedCalendarDate` was initialized to today's date in `HistoryScreen.initState()`. `_applyFilters()` filtered all 146 test ledger entries (June 2026) to zero — no Cards rendered.

**Fix:** Removed `_selectedCalendarDate` default → `null`. Toggle-on/toggle-off behavior preserved.

| # | ID | Test | Symptom | Status |
|---|-----|------|---------|--------|
| **F-03** | **G2** | `history_screen_test.dart:394` | `findsAtLeastNWidgets(1)` for Card — zero cards visible | ✅ Fixed |
| F-04 | G3 | `history_screen_test.dart:438` | `findsWidgets` for `'Working on Project Alpha'` | ✅ Fixed (cascaded) |
| F-05 | G4 | `history_screen_test.dart:480` | `findsWidgets` for `'coding'` tag | ✅ Fixed (cascaded) |

**File:** `lib/features/history/history_screen.dart` — removed `_selectedCalendarDate` default from `initState()`.

---

#### ✅ Chain C: Dashboard Validation Gap (1 test) — FIXED (2026-07-28)

**Root cause:** `DashboardScreen` already validates empty titles in `_capture()` (line ~89: `if (title.isEmpty) setState(() => _errorMessage = 'Please enter a task title')`). The test was already GREEN — BACKLOG entry was stale.

| # | ID | Test | Symptom | Status |
|---|-----|------|---------|--------|
| **F-06** | **Dashboard E3** | `dashboard_screen_test.dart:79` | ~~Empty title + tap "Start" → no validation error~~ | ✅ Done (already implemented) |

---

#### 🔗 Chain D: Stale Test Signature (1 test, independent)

**Status:** ✅ Done (2026-07-28) — signature already corrected in both source and test.

| # | ID | Test | Symptom | Priority |
|---|-----|------|---------|----------|
| **F-07** | **local_cache_test** | `local_cache_test.dart:187` | ~~Compilation error: `Too many positional arguments: 1 allowed, but 2 found`~~ | ✅ Done |

---

### Recommended Attack Order

| Order | Chain | Items | Impact | Effort |
|-------|-------|-------|--------|--------|
| ~~1~~ | ~~D~~ | ~~F-07~~ | ~~Stale test signature~~ | ✅ Done |
| ~~2~~ | ~~A~~ | ~~F3/L1/S4/S6/S7~~ | ~~Millisecond collision flakiness~~ | ✅ Done |
| ~~3~~ | ~~B~~ | ~~F-03 → F-05~~ | ~~History screen rendering~~ | ✅ Done |
| ~~4~~ | ~~C~~ | ~~F-06~~ | ~~Dashboard validation gap~~ | ✅ Done |

**All chains resolved.** Only X1 (pre-existing E2E) remains — see SESSION_HANDOFF.md.

## 🟢 Nice-to-Have — Tooling

### SESSION_HANDOFF.md auto-archiver

**Why:** The agent enforces the 100-line limit manually (AGENTS.md preference, 2026-07-04). A script would make this faster and more reliable.

**What:** `scripts/archive_handoff.py` — parses `SESSION_HANDOFF.md`, finds sections with `✅` / `🟢` status markers, moves them to a dated archive file (`docs/planning/archive/SESSION_HISTORY_YYYY-MM-DD.md`), and writes back the trimmed handoff. Invoked by the agent at session closeout.

**Effort:** ~30 min. **Trigger:** When manual archiving friction becomes real. **Next action:** N/A — pick up when needed.

### B-02 ✅: Cross-ledger entry migration

**Flutter Phase 1–4:** ✅ Complete — 79 Flutter assertions → 79 GREEN tests → 5 Phase 4 improvements.
**Web Phase 1–4:** ✅ Complete — 30 assertions → 55 GREEN tests → 7 Phase 4 improvements across 2 files.

**Phase 1:** ✅ Complete — 116 assertions across 13 groups (A–M) covering all three clients.
Blueprint: `docs/planning/B02_CROSS_LEDGER_MIGRATION_PHASE1.md`.

**Why:** A user with two separate ledgers (old and new, different seeds, non-overlapping
activity periods) may want to retire the newer one and consolidate all entries into the
older ledger. Two seeds = two cryptographic domains — chains can't be spliced — but
entries can be decrypted from one, re-encrypted under the other, and committed as new
day blocks.

**Constraints:** All entries in the newer ledger must be chronologically after the older
ledger's last entry (no overlaps). The newer ledger is retired after migration.

The protocol has all the building blocks (two seeds → two `CryptoManager`s, versioned MK
derivation, export/import formats) but no packaged command.

**Deliverable:** `phpoc_cli/import_ledger.py` — `ph import-ledger --seed <seed>` or `--file <path>` command.
Also: `phpoc-web/src/ledger/import_entries.js`, `lib/services/import_service.dart`.

**Effort:** Medium (~1 day). **Depends on:** I-01 (versioned MK) ✅, I-01a (rotation execution) ✅,
I-06 (content_hash required) ✅, I-09 (device attribution) ✅.
**Priority:** 🟢 Low — useful but not protocol-critical; workaround exists via manual export→import→commit.

### Migration: Remove encryption migration code before public launch

**Why:** The encryption migration (`LedgerMigrationService`, settings button) is a
one-time fix for pre-standardization dev ledgers. New users will never need it —
their ledgers are created with canonical encryption from genesis.

**What to remove:**
- `phpoc-flutter/lib/services/ledger_migration_service.dart` (entire file)
- "Migrate Encryption" button in `settings_screen.dart`
- `ledgerMigrationServiceProvider` in `providers.dart`
- This backlog entry

**Effort:** ~10 min. **Trigger:** Before public launch.
**Priority:** 🟢 Low — harmless if left, but clutters the codebase.
