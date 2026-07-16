# PHPOC Backlog — Active Issue Queue

> **Last updated:** 2026-07-15
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

## 🔜 Phase 1 — Active: Staging Alignment + E2E

### 1a. Align web staging sharing with CLI

**Plan:** `docs/planning/ALIGN_WEB_STAGING_SHARING_WITH_CLI.md`

| Stage | What | Files |
|-------|------|-------|
| 1.1 | Remove MK bypass: no cookie → always `REAUTH_NEEDED` | `phpoc-web/src/sync/sync.js` ~line 527 |
| 1.2 | New `ReauthOverlay.jsx` component | New file + `DevModeContext.jsx`, `SyncSettings.jsx`, `App.jsx` |
| 1.3 | Remove fallback `DeviceCookie.create('local', ...)` | `phpoc-web/src/context/DevModeContext.jsx` ~line 405 |
| 1.4 | Handle `GENESIS_MISMATCH` in re-auth flow | Integration |
| 1.5 | Tests — update existing + new overlay tests | 4 test files |

**Next action:** Phase 1 Stage 1.1 — edit `sync.js` line 527, remove the 4-line MK bypass.

### 1b. Browser E2E tests

**Plan:** `docs/planning/BROWSER_E2E_TEST_PLAN.md`

| Test | What |
|------|------|
| E2E-03 | Import file upload + same-genesis rejection, auth errors |
| E2E-04 | Import with wrong passphrase/seed → error display |
| E2E-05 ✅ | Full roundtrip: export → clear → import → verify (Phases 1-4 done) |
| E2E-06 | Export with wrong passphrase → error display |
| E2E-07 ✅ | Onboarding import flow |

**Next action:** After Phase 1a completes.

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

### I-02a 🟡: JS `_fieldToken()` — use MK-derived HMAC for field-name tokens

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

**Required:** `key_version` field on blocks, re-encryption workflow, coexistence of blocks under different key versions.

| Deliverable | What |
|-------------|------|
| ADR | Design the rotation protocol |
| `domain/ledger/engine.py` | Key version field + multi-version verification |
| `security/crypto.py` | Re-encrypt entry with new MK |
| Migration | Re-encrypt existing chain under new key |

**Effort:** High (weeks). **Depends on:** I-04 (naming), I-06 (content_hash required).

**Next action:** Write ADR. No code until design is reviewed.

### I-09 🟡: Hardware-bound device attribution

**Why:** Device IDs are derived from MK. Any device with the MK can impersonate any other device.
**Flaw doc severity:** Medium — "device attribution is theater."

| File | Change |
|------|--------|
| `domain/cookie/device_cookie.py` | Derive device ID from MK + device-local secret (UUID4, not from MK) |
| `security/auth.py` | Generate and store per-device secret on first run |
| `phpoc-web/src/sync/sync.js` | Use IndexedDB-stored device secret |

**Effort:** Medium. **Depends on:** nothing. **Next action:** Generate device-local UUID4 secret, use in HMAC derivation.

### I-12 🟡: System architecture document

**Why:** The spec is narrow (format only). DESIGN_GOALS is broad (aspirations). No single document describes the full system.
**Flaw doc observation:** #16 — the spec is the narrowest document but claims to be authoritative.

**Deliverable:** New `docs/design/SYSTEM_ARCHITECTURE.md` covering: key hierarchy, chain structure, staging pipeline, transport layer, multi-device sync, cross-platform strategy, crypto core.

**Effort:** ~2 days. **Next action:** Create outline from existing ADRs + CROSS_PLATFORM + DESIGN_GOALS.

---

## 🔵 Phase 5 — CLI Polish

*Existing backlog items. After architectural work stabilizes.*

### P5: CLI unlock latency

**3 remaining root causes:**

| # | Action | File |
|---|--------|------|
| B | Pre-check remote reachability before cookie/blob pulls | `domain/staging/service.py` |
| A | Fix timeout plumbing (60s → 5s default) | `core/sync/http_transport.py` + `service.py` + `remote_sync.py` |
| C | Skip network calls for read-only commands | `main.py` read-command dispatch |

**Next action:** Fix timeout plumbing first (largest impact per line of code).

### P4: CLI kinks & UX polish

**Next action:** Audit `ph view`/`ph list`/`ph tags` for specifier-mismatch blocking.

---

## 🔵 Phase 6 — Cross-Client Format Unification

### P1: Canonical cross-client serialization

**Problem:** 3 incompatible serializations exist (raw chain, v2 envelope, per-block R2).

**Next action:** Hold format decision discussion. Record as ADR.

### Entry hash indent=2 consolidation

**Next action:** When all chains are indent=2 only, remove `_verify_entry_hash_flex()` dual-format shims from `chain.py` and `onboarding_file.py`.

---

## 🔵 Phase 7 — Remote Sync

### P3: Remote sync (git-based)

**Next action:** After browser client reaches parity with CLI sync features.

---

## Summary by Phase

| Phase | Items | Critical | High | Medium | Low |
|-------|-------|----------|------|--------|-----|
| **0** — Doc fixes ✅ | I-08, I-10, I-13, I-14, I-15, I-16 (6) — complete 2026-07-15 | 0 | 0 | 0 | 0 |
| **1** — Active | Staging alignment (5 stages) + E2E (5 tests) | — | — | — | — |
| **2** — Low-effort code | I-04✅, I-05✅, I-06✅, I-11✅, I-02a (5) | 0 | 0 | 1 | 0 |
| **3** — Encryption gaps | I-03✅, I-02✅ (2 done) | 0 | 0 | 0 | 0 |
| **4** — Architectural | I-01, I-09, I-12 (3) | 1 | 0 | 2 | 0 |
| **5** — CLI polish | P5, P4 (2) | — | — | — | — |
| **6** — Cross-client | P1, indent=2 (2) | — | — | — | — |
| **7** — Remote sync | P3 (1) | — | — | — | — |
| **Totals** | **21 open** | **2** | **3** | **5** | **2** |

**Resolved:** I-07 (format_version in seal) ✅, I-17 (day_hash → block_hash) ✅ — Canonical Ledger Format, 2026-07-03.

---

## 🟢 Nice-to-Have — Tooling

### SESSION_HANDOFF.md auto-archiver

**Why:** The agent enforces the 100-line limit manually (AGENTS.md preference, 2026-07-04). A script would make this faster and more reliable.

**What:** `scripts/archive_handoff.py` — parses `SESSION_HANDOFF.md`, finds sections with `✅` / `🟢` status markers, moves them to a dated archive file (`docs/planning/archive/SESSION_HISTORY_YYYY-MM-DD.md`), and writes back the trimmed handoff. Invoked by the agent at session closeout.

**Effort:** ~30 min. **Trigger:** When manual archiving friction becomes real. **Next action:** N/A — pick up when needed.
