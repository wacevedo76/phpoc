# PH Ledger — Session Handoff

> **Agent:** On first read, run `git log --oneline -5 && echo "---changed-files---" && git diff --stat HEAD~2` to load recent context.
> Before making edits, consult the Documentation Impact Contract in root `AGENTS.md`.
> For architectural decisions, read `docs/design/TOP_LEVEL_DIRECTIVES.md` first — D1–D10 are the binding principles.
>
> **⚠️ Git operations require user approval.** Never run `git commit` or `git push` automatically. Ask first.
>
> **Full issue queue:** `docs/planning/BACKLOG.md`
> **Completed milestones (archived):** `docs/planning/archive/` (…2026-08-21, 2026-08-22, 2026-08-28, **2026-08-29**)

## Current State
- **Branch:** `Flutter-features_and_ux` → pushed `d3d6e68` (C-2 seed re-key `ph rekey-seed` + transport adapter gap + Flutter content_hash parity)
- **C-2 CLI↔client cross-client verify — 4-phase TDD COMPLETE (2026-08-29):** `docs/planning/C2_CLI_CLIENT_VERIFY_PHASE1.md` — option (a) raw-seed re-key (ADR-032); hermetic matrix GREEN all 4 directions; Phase 4 (REFACTOR + Group E docs) DONE. Detail archived 2026-08-29.
- **C-2 Live R2 E2E ✅ GREEN (2026-08-29):** restored canonical test ledger to R2 (genesis `e718daf3…`, 31 blocks, hash-index consistent) + fixed forward leg (`renew_seed()` `transport=None` → isolated push, no canonical `ledger/blocks/` overwrite). `test_c2_cli_client_live_r2.py` 2/2 + `test_c2_live_r2.py` 1/1.
- **Flutter test suite:** `+2147` / 0 failures (4 skip) · **Remote sync E2E:** 8/8 GREEN (`--timeout 180s`)
- **Phone `RFCW50FZQPJ`:** debug 0.1.0 deployed + local ledger repaired (132 blocks == remote, 280 staging rows)

## Immediate Next Steps 🎯
- **✅ C-2 `identity_pub_key` raw-bytes parity (Web + Flutter) — Phase 3 (GREEN) DONE (2026-08-31):** raw-bytes `identity_pub_key` implemented end-to-end — Rust `digest::identity_pub_key_hex` + `wasm.rs::identity_pub_key` + `frb.rs::identity_pub_key`; WASM rebuilt + copied to `phpoc-web/src/crypto/wasm/*` (also exported `hmac_hex`/`derive_field_key`); Web `CryptoService.identityPubKey` → `identity_pub_key` binding; Flutter `CryptoService`/`CryptoServiceNative.identityPubKey` → `frb_generated.dart::identityPubKey`; call sites switched (`chain.js:289`, `c2_fixture_gen.mjs`, `rekey_service_web_test.mjs`); fixtures regenerated `271a413b…` → `9a2db2e2…`; Python `test_c8_genesis_parity_after_cli_pull` fixed (string-hash → raw-bytes). Blueprint `docs/planning/C2_IDENTITY_PUB_KEY_RAW_BYTES_PHASE1.md` (29 assertions) → Phase 4 (REFACTOR) ✅. **Full-suite re-run GREEN (2026-08-31):** Python `2685 passed / 1 skip / 0 fail`, Flutter `2147 passed / 4 skip / 0 fail`; targeted Rust `cargo test` 65+15, Web crypto suites + `identity_pub_key_web_test.mjs` 8/8 + `c2_cross_client_verify.mjs` 18/2skip + `rekey_service_web_test.mjs` 29/29 + vitest 119/1skip all GREEN.
- **🟠 Web↔Flutter parity queue (2026-08-28, ordered):** spec `docs/planning/WEB_FLUTTER_PARITY_SPEC.md`. P4 ✅ → P2 (C-2 cross-client verify, Web↔Flutter) ✅ → **P1 `COMMONPLACE_BOOK_WEB_ROADMAP.md` (Commonplace web port; slices 1–4 now, 5–6 when Flutter finishes them) → P3 `WEB_STAGING_OPTION_A_PHASE1.md` (staging Option A refactor, last — no user-facing value).**
- **🟡 C-2 Seed Re-Key cross-client — status:** Flutter ✅ (option a, 2026-08-22) · Web ✅ 4-phase TDD (2026-08-24, COMMITTED `4364ac2`) · CLI Phase A ✅ (2026-08-29) · Web↔Flutter verify ✅ (2026-08-28) · CLI↔client verify ✅ (2026-08-29) · raw-bytes parity ✅ (2026-08-31). **C-2 is complete.**

## Known Issues
- **R6 follow-up (RESOLVED 2026-08-31):** `identity_pub_key` canonical = raw-bytes (Rust `digest.rs`, PHPSPEC §2.7.1) — Web/Flutter now hash raw bytes via the `identity_pub_key` binding (was `sha256(String)` divergence). Blueprint: `docs/planning/C2_IDENTITY_PUB_KEY_RAW_BYTES_PHASE1.md`.
- **`i02a_field_token_wasm_test.mjs` — 2 formerly-failing WASM-binding tests (RESOLVED 2026-08-31):** `hmac_hex`/`derive_field_key` now exported after the WASM rebuild (`phpoc-crypto-core/pkg/*` was stale). 28/28 GREEN.
- **🔴 "activities through Aug 7 doubled" — Option (a) APPLIED to R2 (2026-08-27):** `scripts/apply_ledger_repair_r2.py` (dry-run default; `--apply` writes). Remote now VALID 141 blocks / 0 dups, `.sha256` sidecar restored. **Full restore-from-cloud per client next.** Detail: `docs/planning/AUG7_DOUBLING_REMEDIATION_PLAN.md`.
- **OPEN: Aug 13–14 2026 activities missing from remote ledger + web History** (9 committed activities in phone blocks 132–135, dropped during earlier phone repair; survive only in `/tmp/phpoc_phone_backup/pre_repair_20260814_124924/phpoc.db` staging table `committed=1`). Recovery needs re-commit from that backup or another device — not fixable in web History. Root cause (fixed `2d05aff`): `_prepareEntries` stripped `entry_id`/`hash` but retained `activity_id` → re-seeded dups.
- **🔴 Pre-existing credential leak (git history only — working tree neutralized):** personal seed/passphrase/API-key/worker-url hardcoded in `onboarding_screen.dart:205-208` + `diag_verify.dart:19` (commits `a5b124e`/`08235f8`). Working tree fixed 2026-08-21 (creds → gitignored `TEST_CREDENTIALS.md` + env var). History rewrite is user-initiated; only a C-2 seed re-key truly nullifies the leaked seed.
- **Live debug visibility:** phone `RFCW50FZQPJ` debuggable (rebuild 2026-08-19); DB dump `run-as com.phpoc.phpoc_flutter cat app_flutter/phpoc.db`. Emulator `emulator-5554` also debug.
- `_pushBlobOnly()` + `StagingPaths.remoteStagingBlob` — RETIRED ✅. `stagingStore` required/non-null.
- `verify()` after cloud restore — FIXED (Plan B: RC1–RC3, `VERIFY_RESTORE_FIX_PLAN_B.md`).

## Flutter Mobile App
- **Flutter:** 3.44.6 (stable) | **Emulator:** `pixel_6_avg` (API 35, x86_64)
- **Tech stack:** Riverpod + go_router + SQLite + SharedPreferences + flutter_secure_storage
- **Test creds:** `TEST_CREDENTIALS.md` (gitignored)
- **Cross-client sync reference:** `docs/reference/CROSS_CLIENT_STAGE_SYNCING_REFERENCE.md` §12
