# PHPOC Backlog — Active Issue Queue

> **Last updated:** 2026-07-28
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

## 🟠 B-04: Flutter — Wire cross-device sync for row-level staging

**Depends on:** B-03 ✅
**Phase 1:** ✅ 56 assertions → `docs/planning/flutter/B04_ROW_LEVEL_SYNC_PHASE1.md`
**Phase 2:** ✅ RED — 56 tests across 9 groups (A–I), 27 RED / 29 GREEN
**Phase 3:** ✅ GREEN — 54/54 B-04 tests pass. Full suite 1412/1414.

**Implementation:**
- `checkAndSync()` branches on `stagingStore`: cookie fast path → `_fastPathRowLevel()` (hash index compare); reconcile → `_reconcileAndClaimRowLevel()` (mergeEntries + row-level push)
- `_pullRemoteBlob()` → `_pullRemoteRows()` when stagingStore is wired (pulls from `staging/blob`)
- `_reconcileAndClaim()` → `_reconcileAndClaimRowLevel()`: reads/writes StagingStore, merges via `MergeEngine.mergeEntries()`, pushes via `_pushStagingRowsToRemote()`, cleans up committed rows
- `StagingStore.putRow(preserveUpdatedAt:)` flag for merge writeback (LWW timestamps preserved)
- `MergeEngine.mergeEntries()` LWW tie-break: `>` (local wins) replaced `>=`
- Test infrastructure: `_RowTestHarness.addRow()` uses `preserveUpdatedAt: true`

**Phase 4:** ✅ REFACTOR — 5 improvements across 3 files. Conciseness: merged duplicate `import 'dart:convert'`, consolidated `_pullRemoteRows` → `_pullRemoteBlob` (~25 lines deduped), extracted shared `safeJsonDecode` to `StagingStore`. Clarity: hardcoded `'staging/blob'` → `StagingPaths.remoteRowLevelBlob`, replaced J-numbered test assertion refs with descriptive comments in `mergeEntries`. Full suite: 1412/1414.

**Problem:** The staging overhaul (B-03) auto-pushes to `staging/blob` but the sync gate (`checkAndSync` / `_reconcileAndClaim`) still operates on `staging/blobs/current.json`. Push and pull are on different paths — cross-device sync is disconnected.

**Worker note:** The Worker's generic blob handlers already serve any R2 path (GET/PUT/DELETE pass-through). No new routes needed — `staging/blob` and `staging/hash_index.json` work today.

**Reference:** phpoc-web's `row_sync.js` — `buildDiff()` (8-scenario LWW resolution) + `RowSyncWorker`. Web has same disconnect.

**Phase 1 groups:** A (Pull 8), B (Merge 10), C (Push 5), D (Fast path 7), E (Store 6), F (Bootstrap 4), G (Gates 6), H (Integration 8), I (Paths 2) = 56 total.

**Next action:** Phase 4 (REFACTOR) — code review for modularity, clarity, security, conciseness.

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

### I-04 ✅~~🟠~~: Rename HMAC "signature" → "seal"/"tag"

**Why:** Misleads implementers about security properties. Must happen before real Ed25519 is added.
**Flaw doc attack order:** Step 2 (naming fixes).

| File | Change |
|------|--------|
| `docs/spec/PHPSPEC.md` §2.7, §4, §5.3 | Rename `signature` field → `identity_seal`; rename `sign()` → `mac()`, `verify_signature()` → `verify_mac()` |
| `security/crypto.py` | Rename `sign()` → `mac()`; rename `verifySignature()` → `verifyMac()` |
| `domain/ledger/chain.py` | Update field references |
| `phpoc-web/src/ledger/chain.js` | Update field references |
| All test files | Update field names |

**Effort:** ~2 hours. **Blocked by:** nothing. **Blocks:** I-01 (key rotation).

**Next action:** Pick up after Phase 1. Start with spec rename, then code.

### I-05 ✅: Per-user PBKDF2 salt

**Why:** Fixed `b"session-salt"` enables cross-user rainbow tables when passphrases are reused.
**Flaw doc attack order:** Step 3 (salt fix).

| File | Change |
|------|--------|
| `docs/spec/PHPSPEC.md` §2.4 | Document salt derivation from `identity_pub_key` |
| `security/auth.py` | Derive salt: `SHA-256(identity_pub_key)[:16]` instead of `b"session-salt"` |
| `cli/onboarding.py` | Use new salt for seed encryption during init |
| `tests/test_auth.py` | Update salt expectations |
| All decryption paths | Must try both old salt and new salt (backward compat) |

**Effort:** ~1 hour code + migration for existing ledgers. **Blocked by:** nothing. **Blocks:** nothing.

**Next action:** Add backward-compat salt detection (try new salt first, fall back to old).

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
**Status:** ✅ Phases 1-4 complete (2026-07-17). ADR-026 implemented: `derive_mk()` + versioned `CryptoManager` in crypto.py, multi-version `verify()`/`verify_block()` with `get_mk_for_version` in chain.py, `get_mk()`/`key_version`/`_keys` in auth.py, `RotateKeysCommand` skeleton in cli/rotate_keys.py, JS `deriveMk()` + `CryptoManager` in phpoc-web. 95/95 PY + 13/13 JS GREEN. 5 Phase-4 improvements.

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

**Files:** `cli/rotate_keys.py` (main), `security/auth.py` (`_keys` population),
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

**Next action:** After browser client reaches parity with CLI sync features.

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
| **7** — Remote sync | P3 (1) | 🔵 Deferred |
| **8** — Per-activity encryption | P6 (Web, 61), P7 (CLI, 72) | ✅ Complete |
| **Flutter** — Mobile app | Models (94), Crypto FFI (74), Services (65), Storage (100), Sync Core (106), Screens (109), Ledger Engine (196) — 7 modules, 744 assertions | ✅ Phases 1-4 complete (747/747 GREEN) |

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

### B-02 🟢: Cross-ledger entry migration

**Why:** A user with two separate ledgers (old and new, different seeds, non-overlapping
activity periods) may want to retire the newer one and consolidate all entries into the
older ledger. Two seeds = two cryptographic domains — chains can't be spliced — but
entries can be decrypted from one, re-encrypted under the other, and committed as new
day blocks.

**Constraints:** All entries in the newer ledger must be chronologically after the older
ledger's last entry (no overlaps). The newer ledger is retired after migration.

The protocol has all the building blocks (two seeds → two `CryptoManager`s, versioned MK
derivation, export/import formats) but no packaged command.

**Deliverable:** `cli/migrate_ledger.py` — `ph migrate-ledger --from-seed <seed>` command:
1. Auth with both seeds → two `CryptoManager` instances
2. Decrypt all entries from new ledger's day blocks
3. Re-encrypt with old ledger's MK and commit as new day blocks (preserving dates)
4. Rebuild index, archive/retire new ledger
5. Verify chain integrity post-migration

**Effort:** Medium (~1 day). **Depends on:** I-01 (versioned MK) ✅, I-01a (rotation execution) ✅ —
not a hard dependency but rotation should land first. **Priority:** 🟢 Low — useful but not
protocol-critical; workaround exists via manual export→import→commit.
