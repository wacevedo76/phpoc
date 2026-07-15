# PH Ledger — Session Handoff

> **Agent:** On first read, run `git log --oneline -5 && echo "---changed-files---" && git diff --stat HEAD~2` to load recent context.
> Before making edits, consult the Documentation Impact Contract in root `AGENTS.md`.
> For architectural decisions, read `docs/design/TOP_LEVEL_DIRECTIVES.md` first — D1–D10 are the binding principles.
>
> **Full issue queue:** `docs/planning/BACKLOG.md` (21 open, 3 Critical / 3 High / 4 Medium / 2 Low)
> **Completed history:** `docs/planning/archive/SESSION_HISTORY_2026-07-15.md`

## Current State
- **Branch:** `mobile-poc`
- **CLI:** 1787 PY tests pass (2 flaky: staging service timeout ordering)  |  **Web:** 583 JS tests GREEN across 6 suites  |  **Worker:** 104 vitest tests pass
- **B-01 (web staging committed-flag loss):** ✅ 4-phase TDD complete (2026-07-15)
- **Phase 0 (Doc Fixes):** ✅ All 6 items complete (2026-07-15) — I-08, I-10, I-13, I-14, I-15, I-16
- **Phase 1a (Staging Alignment):** ✅ Stages 1.1–1.5 complete — MK bypass removed, ReauthOverlay wired, fallback cookie removed, GENESIS_MISMATCH handled. 355 web tests pass (276 sync + 40 integration + 47 genesis mismatch + 20 reauth logic + 50 TTL + test helpers). Cookie-creation side-effect removed 2026-07-15.

## Backlog Priority (see BACKLOG.md for full detail)

| Pri | Phase | Items |
|-----|-------|-------|
| 0 | 🟢 Doc fixes (anytime) ✅ | I-08–I-16 all done 2026-07-15 |
| 1 | 🔜 Phase 1b (Browser E2E) | E2E-03 (import upload), E2E-07 (onboarding import) — both PARTIAL with C5 limitation |
| 2 | 🟡 Low-effort code | I-04✅ I-05✅ I-06✅ I-11🟡 |
| 3 | 🟠 Encryption gaps | I-03🔴 I-02🔴 — staging + blind index at-rest encryption |
| 4 | 🔴 Architectural | I-01🔴 I-09🟡 I-12🟡 — key rotation, device attribution, sys arch doc |
| 5 | 🔵 CLI polish | P5 (unlock latency), P4 (UX kinks) |
| 6 | 🔵 Cross-client | P1 (canonical serialization), indent=2 consolidation |
| 7 | 🔵 Remote sync | P3 (git-based) |

## I-04 — 4-Phase TDD Complete ✅
- **Phase 1:** Blueprint — 43 assertions → `docs/planning/I04_NAMING_CORRECTIONS_PHASE1.md`
- **Phase 2 (RED):** 22 PY + 21 JS naming tests defined
- **Phase 3 (GREEN):** ✅ — `sign()`→`mac()`, `verify_signature()`→`verify_mac()`, block field `"signature"`→`"identity_seal"`. Backward compat preserved.
- **Phase 4 (REFACTOR):** ✅ (2026-07-15) — 5 improvements: removed duplicate comment + camelCase overrides, updated docstrings, snake_case consistency. All 211 PY + 76 JS tests GREEN.

## I-05: Per-user PBKDF2 salt — ✅ 4-Phase TDD Complete (2026-07-15)
- **Phase 1:** Blueprint — 43 assertions → `docs/planning/I05_PBKDF2_PER_USER_SALT_PHASE1.md`
- **Phase 2 (RED):** 30 PY + 5 Rust + 7 JS tests defined, 7 genuinely RED
- **Phase 3 (GREEN):** ✅ All tests pass. 1839 PY pass, zero regressions.
- **Phase 4 (REFACTOR):** ✅ (2026-07-15) — 3 improvements:
  1. Extracted `get_pdk_salt_from_genesis()` into `security/auth.py` — eliminates duplicated salt-derivation pattern across `cli/onboarding.py`, `cli/onboarding_file.py`, `scripts/change_passphrase.py` (7→2 lines per site)
  2. Hoisted `CryptoManager` import to module level — removed 2 inline imports
  3. Removed dead `import os` + redundant `import os as _os` in `authenticate()`

## I-06: content_hash required at v0.4.0+ — ✅ 4-Phase TDD Complete (2026-07-15)
- **Phase 1:** Blueprint — 29 assertions → `docs/planning/I06_CONTENT_HASH_REQUIRED_PHASE1.md`
- **Phase 2 (RED):** 14 PY + 15 JS tests defined (6 PY RED + 6 JS RED)
- **Phase 3 (GREEN):** ✅ All tests pass.
  - `domain/ledger/chain.py`: `_parse_format_version()`, `_is_format_version_at_least()`, gated content_hash in `verify()`
  - `phpoc-web/src/ledger/chain.js`: async `_verifyBlockData`, `_verifyContentHash()` (extensible + legacy fallback)
  - `phpoc-web/src/ledger/merge.js`: `_verifyContentHash()` + `requireContentHash` param; `_verifyChain()` extracts genesis fv
  - `docs/spec/PHPSPEC.md` §5.5/§5.6: Updated validation rule, field table, pseudocode
- **Phase 4 (REFACTOR):** ✅ (2026-07-15) — 2 improvements:
  1. Hoisted `requireContentHash` from `_verifyBlockData` → `verify()` caller (matches merge.js pattern, avoids N redundant genesis reads)
  2. Aligned `hasContentHash` check with merge.js (added empty string guard `!== ''`)
- **213 I-06 tests GREEN. 1853 PY pass. All web tests pass. No regressions.**

## I-11: Blob Obfuscation Portability — ✅ 4-Phase TDD Complete (2026-07-15)
- **Phase 1:** Blueprint — 21 assertions → `docs/planning/I11_BLOB_OBFUSCATION_PORTABILITY_PHASE1.md`
- **Phase 2 (RED):** ✅ 19 PY + 10 Rust tests defined
- **Phase 3 (GREEN):** ✅ `_obfuscate_deterministic()` (PY) + `obfuscate_blob_deterministic()` (Rust) + spec §8.5 warning
- **Phase 4 (REFACTOR):** ✅ (2026-07-15) — 2 improvements:
  1. `_obfuscate_deterministic()` now delegates to `_obfuscate_core(padding_fill=0)` — removed ~20 lines of duplication (matches Rust architecture)
  2. `_deobfuscate()` derives enc+integrity keys in single `_derive_blob_encryption_keys()` call — removed redundant HMAC-SHA256 computation

## Immediate Next Steps
1. **Phase 1b:** Browser E2E tests E2E-03, E2E-07 (blocked by C5 file upload limitation)

## Known Issues
- **CLI read commands block on specifier mismatch** (Python-side, not web)
- **Deduplication bug in SyncOrchestrator** — ✅ FIXED.
- **CLI staging/ledger reconciliation for cross-platform commits** — ✅ FIXED (`cli/interface.py`).
- **Web test runner compatibility (minor):** 3 test files use vitest (`onboarding_import_component`, `reauth_overlay`, `settings_genesis_component`) and must run under `npx vitest`, not `node --test`. All pass when run with correct runner. `settings_genesis_component` is intentionally RED (Phase 2 TDD for a11y features). No production impact.

## Test Ledger Credentials

- **Active Browser Ledger (William Acevedo)**
  - Passphrase: `VZQKp6TrIBK/GUtsjoof75HRyzd7w8S0`
  - Recovery Seed: `Qy2OER5EbUcsL7PWp+e24hSTE/CAN/OOEF7fgDIGEsw=`
  - Username: `William Acevedo` | Email: `william.acevedo@gmail.com`

## Browser E2E Setup

- **Browser:** Vivaldi via `agent_browser` with `sessionMode: "fresh"` and `--executable-path "/usr/bin/vivaldi-stable"` (Vivaldi not started with `--remote-debugging-port`)
- **Tab rule:** `tab list` → find `localhost:5173`. Do NOT open new tabs.
- **Active tab:** `t1` (localhost:5173) — reused across sessions
- **Dev server:** `cd phpoc-web && npx vite --host 0.0.0.0 --port 5173`
- **Workers:**
  - **Testing:** `https://phpoc-staging-testing.wacevedo.workers.dev` — API token in `TEST_CREDENTIALS.md` (gitignored)
  - **Production (personal):** `https://phpoc-staging.wacevedo.workers.dev` — do not use for testing
- **E2E test creds:** passphrase `NewPass456!`, seed `g92sVRVPPxN4uRffWHBBkHskcEtCQvhaTO9GJJxWhlY=`
- **R2 test ledger (E2ETest):** passphrase `E2EPass123!`, seed `fK0kCIjLAzFTmHmE6XaD/Y+YfRyBVQ07dG8DaVRtS+4=`
