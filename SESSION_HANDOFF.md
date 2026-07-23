# PH Ledger — Session Handoff

> **Agent:** On first read, run `git log --oneline -5 && echo "---changed-files---" && git diff --stat HEAD~2` to load recent context.
> Before making edits, consult the Documentation Impact Contract in root `AGENTS.md`.
> For architectural decisions, read `docs/design/TOP_LEVEL_DIRECTIVES.md` first — D1–D10 are the binding principles.
>
> **Full issue queue:** `docs/planning/BACKLOG.md` (updated 2026-07-18 — authoritative status)
> **Flutter TDD plans (all 7 complete):**
> - `docs/planning/flutter/MODELS_PHASE1.md` (94) | `CRYPTO_FFI_PHASE1.md` (74) | `SERVICES_PHASE1.md` (65)
> - `STORAGE_PHASE1.md` (100) | `SYNC_CORE_PHASE1.md` (106) | `SCREENS_PHASE1.md` (109)
> - `LEDGER_PHASE1.md` (196) — **all ✅ Phase 1+2+3+4 complete**
- `CRYPTO_FFI_WIRING_PHASE1.md` (99) — **✅ Phase 1+2+3+4 complete** — flutter_rust_bridge wiring

- `RESTORE_FROM_CLOUD_PHASE1.md` (63) — **✅ Phase 1+2+3 complete** — restore ledger from Worker/R2 during onboarding
- `WIPE_CLOUD_ONBOARD_PHASE1.md` (38) — **✅ Phase 1+2+3 complete** — Stage 3: push→wipe→restore→pull→verify

## Current State
- **Branch:** `feature/flutter-mobile` (merged `feature/flutter-mobile-riverpod`, off `main`)
- **Last commit:** `1f57f29` — feat(flutter): Sync Core — Phases 1-4 complete (378/378 GREEN)
- **Flutter test suite:** 1042 total (1042 GREEN, 0 failures, 0 regressions)
- **Flutter analyzer:** 1 pre-existing info lint (_obscurePassphrase)
- **Flutter analyzer:** 4 info-level lint from raw sqlite3 API (pre-existing, not actionable)

### All Work Complete — Backend (Python + Web JS)
| Area | Items |
|------|-------|
| Doc fixes | I-08, I-10, I-13, I-14, I-15, I-16 |
| Low-effort | I-04 (HMAC naming), I-05 (PBKDF2 salt), I-06 (content_hash required), I-11 (blob obfuscation), I-02a (JS field tokens) |
| Encryption | I-03 (staging at rest), I-02 (blind index + staging keys) |
| Architecture | I-01 (key rotation), I-01a (RotateKeysCommand), I-09 (device attribution), I-12 (system architecture doc) |
| Cross-client | P1 (canonical serialization), entry hash indent=2 |
| CLI polish | P4 (UX polish), P5 (unlock latency) |
| Encrypt fields | P6 (Web, 61 assertions), P7 (CLI, 72 assertions) |
| Staging + E2E | Web staging alignment (1.1–1.5), browser E2E (E2E-03 through E2E-07) |
| Misc | B-01 (committed-flag loss), Settings Genesis Component (26/26) |

### All Work Complete — Flutter Mobile (7 modules)
| Module | Assertions | Phase 4 improvements |
|--------|-----------|---------------------|
| Models | 94 | — (included with Crypto FFI) |
| Crypto FFI | 74 | 7 (PBKDF2 benchmark, cleanup) |
| Services | 65 | 3 (provider cleanup) |
| Storage | 100 | 5 (dedup _selectOne/Two, rename _execute→_executeAndGetChanges, dedup setClauses.add, safe BlockType parse, 3 analyzer fixes) |
| Sync Core | 106 | 6 (_decodePauses, _buildBlobBytes, _findActiveEntryIndex, MergeEngine.mergeMaps, static _generateSpecifier, throw on crypto failure) |
| Screens | 109 | 5 (FormatUtils, dead state removal, _buildEntryDetail, sync status fix, _buildErrorCard) |
| Ledger Engine | 196 | 8 (jsonEncodeSortedNoSpaces, compareVersions, epochToDate, secretToHex, getBlockHashForBlock, _computeSeal; removed _buildLegacyJson; 11 analyzer warnings) |
| Crypto FFI Wiring | 99 | 5 (security: zero MK on clear, clarity: comments, modularity: deriveDeviceId/getDeviceSecret in frb, conciseness: dart:convert _toJson, List support in _sortMap) |
| Restore from Cloud | 63 | 8 (_pullRemoteBlob, _pushCookie, _pushBlobOnly reuse, _touchLocalCookie clarity, RegExp consolidation, _handleServiceError extraction) |
| Push to R2 | 39 | 4 (shared epochToIsoDate→FormatUtils, removed redundant sealFieldNames, blockId fallback comment, _textBytes helper) |

### Only Deferred Item
- **P3:** Remote sync (git-based) — infrastructure exists, `init --git-create` remaining. Not needed while Worker sync serves all active use cases.

## Flutter Mobile App
- **Flutter:** 3.44.6 (stable) at `/opt/flutter/bin/flutter`
- **Dart:** 3.12.2 | **Android Studio:** `/opt/android-studio/`
- **Emulator:** `pixel_6_avg` (API 35, x86_64, Google Play)
- **Crypto core:** `phpoc-crypto-core/` (Rust, `ring` crate) — ready for `flutter_rust_bridge` FFI
- **Architecture doc:** `docs/design/FLUTTER_ARCHITECTURE.md`
- **Tech stack:** Riverpod + go_router + Drift/SQLite + SharedPreferences
- **State Management:** Riverpod (compile-time safety, testability, lower boilerplate)

## Immediate Next Steps 🎯

### 🔜 Stage 3: Phase 4 (REFACTOR)
- Code review `LedgerPullService.pullAll()` (~195 lines) against modularity, clarity, security, conciseness
- After Phase 4: re-raise E2E tests (see Known Issues for blockers)

### Deferred
- **P3 (git sync):** Infrastructure exists, `init --git-create` remaining. Not needed while Worker sync covers all active use cases.

## Known Issues
- **7 vitest files fail** with environment/teardown errors (pre-existing): i01_key_rotation, i02_index_encryption, i02_staging_keys, i02a_field_token_wasm, i09_device_attribution, onboarding_cloud_conflict, worker_connect_blocks_format — 61/61 individual tests pass, files marked failed by test runner.
- **E2E tests (Group E) blocked by two pre-existing design issues (discovered 2026-07-25):**
  1. **`pushAll()` from empty DB wipes R2** — Tests call `pushService.pushAll()` with empty in-memory DB → pushes `hash_index: []` + empty `index.json`, overwriting the canonical 31-block test ledger.
  2. **Format mismatch** — Python `push_test_ledger.py` stores obfuscated blocks as raw binary bytes; Flutter's `deobfuscateBlob()` expects UTF-8-encoded base64 string. Pull fails with `FormatException: Unexpected extension byte`.
  - **Auth fix applied** (2026-07-25): `HttpTransport` now sends `X-Api-Key` header (5 methods), matching Worker expectation. Was sending `Authorization: Bearer` → always 403.
  - **Resolution options need exploration:** (A) align Python push format with Flutter expectations, or (B) fix tests to not overwrite R2 + handle format gap. Both require design discussion before re-raising E2E.

## Browser E2E Setup
- **Browser:** Vivaldi via `agent_browser`, port 9222
- **Dev server:** `cd phpoc-web && npx vite --host 0.0.0.0 --port 5173`
- **Tab rule:** `tab list` → find `localhost:5173`. Do NOT open new tabs.
- **Test creds:** passphrase `NewPass456!`, seed `g92sVRVPPxN4uRffWHBBkHskcEtCQvhaTO9GJJxWhlY=`
