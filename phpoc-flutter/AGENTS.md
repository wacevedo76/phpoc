# PH Ledger Flutter Mobile Application

## Purpose
Flutter (Dart) mobile client for the PH Ledger — the reference mobile implementation of personal
history tracking, with a second "Commonplace Book" chain sharing the same seed→master-key. Must
maintain **behavioral parity** with the Python reference (`domain/ledger/chain.py`) and the web client
(`phpoc-web`) at the canonical PHPSPEC wire layer.

## Ownership
- `lib/app.dart`, `lib/main.dart` — application root, provider bootstrap
- `lib/core/` — crypto (`crypto_service.dart` pure-Dart shim, `crypto_service_native.dart` + `frb_generated.dart` FFI bridge), models (`block`, `entry`, `identity`, `device_cookie`, …), utils (`json_utils`, `phpsec_format`, `helpers`, `hash_utils`, `base64`, …)
- `lib/data/ledger/` — chain engine: `chain.dart` (`LedgerChain`), `sealable_chain.dart` (ADR-029/029a mixin), `helpers.dart`, `engine.dart`, `index_manager.dart`, `merge.dart`, `summary_policy.dart`, `store_adapters.dart`
- `lib/data/commonplace/` — Commonplace Book chain/engine/storage/service (ADR-031)
- `lib/data/storage/` — drift/SQLite database, DAOs, migrations, preferences, secure preferences
- `lib/data/sync/` — staging (row-level) store, merge engine, hash index, device cookie, genesis gate, sync service, transport
- `lib/services/` — application services: `auth_service`, `onboarding_service`, `ledger_push_service`, `ledger_pull_service`, `ledger_backup_service`, `rekey_service` (C-2 seed re-key), `import_service`, `staging_seed_helpers`, `pull_stage_functions`
- `lib/features/` — screens by area (auth, onboarding, landing, dashboard, history, sync, settings, import, commonplace, shared widgets)
- `lib/routing/` — go_router app router
- `lib/theme/` — app theme
- `test/` — 118 Dart test files

## Local Contracts
- Dart SDK `^3.12.2`, package `phpoc_flutter` (0.1.0+1); Flutter 3.x
- State: Riverpod (`flutter_riverpod` + generators). Routing: `go_router`. Storage: `drift`/`sqlite3`
  + `shared_preferences` + `flutter_secure_storage`. Auth: `local_auth` (biometric). HTTP: `http`.
  Crypto: `flutter_rust_bridge` FFI (Rust `phpoc-crypto-core`) with a pure-Dart shim fallback; also
  `pointycastle`/`crypto`.
- Codegen via `build_runner` (`freezed`, `json_serializable`, `riverpod_generator`, `drift_dev`).
- Canonical wire format is `docs/spec/PHPSPEC.md` §4, NOT any local storage shape. Export/import paths
  (`PhpSpecFormat.blockToMap`, `LedgerBackupService._blockToPhpSpec`, `LedgerPushService`) must emit the
  nested `identity.{recovery_seed_enc, identity_pub_key, identity_secret_enc_fallback}` shape.

## Work Guidance
- **4-phase TDD** (skill `.pi/skills/tdd-four-phase/SKILL.md`): Phase 1 blueprint → Phase 2 RED →
  Phase 3 GREEN → Phase 4 REFACTOR. No refactoring in Phase 3. Blueprints live under repo-root
  `docs/planning/flutter/` (owned by `docs/planning/AGENTS.md`).
- **Canonical seals only (ADR-029/029a):** every seal/verify path must go through the closed per-type
  whitelist via `json_utils.dart` `jsonSort` (`sealable_chain.dart`). No open-set/legacy seal builders.
- **Cross-client invariants (do not break):** entry `hash` is ciphertext-bound (recompute after
  re-encrypt); `content_hash` is plaintext-bound (carry unchanged through re-key); `derivePdk` salt is
  canonical `session-salt` (600,000 iters) — never the dev shim; genesis wire `identity` is nested;
  `computeContentHash` KEEPs the `_enc` suffix on decrypted fields (§5.5/§6.1, plaintext-as-string);
  `verifyContentHash` tries KEEP-first, then strip, then indent2 fallback (Web/Python legacy).
- **Re-key (C-2) is canonical:** `rekey_service.dart` re-encrypts `_enc`, recomputes ciphertext-bound
  entry `hash`, cascades `prev_hash`, re-seals via whitelist `jsonSort`, re-signs with the recovered
  identity secret; `content_hash` and `key_version` unchanged.
- **No secrets in repo.** Test creds come from `TEST_CREDENTIALS.md` (repo root, gitignored). Never
  duplicate credentials in source or tests.
- **Live ledger protection:** never read/write `~/.local/share/phpoc/`. Mock/fixture data goes to
  `/tmp/`, `testdata/`, or a user-provided path.

## Verification
- `flutter test` — full suite **~2115 tests / 0 failures / 2 skip** (118 files).
- `flutter analyze` — **0 errors** on changed files (pre-existing lints tolerated).
- Cross-client hermetic harness: `test/services/c2_cross_client_verify_test.dart` (18/18, 2 live-only
  skip) — paired with `phpoc-web/test/c2_cross_client_verify.mjs`.

## Child DOX Index
None — flat `lib/` source structure. Flutter planning blueprints are owned by `docs/planning/AGENTS.md`
(repo-root `docs/planning/flutter/`).
