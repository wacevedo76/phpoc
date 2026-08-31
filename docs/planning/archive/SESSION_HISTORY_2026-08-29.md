# Session History — 2026-08-29

Archived completed milestones from `SESSION_HANDOFF.md` (C-2 cross-client verify + CLI re-key closure).

## C-2 CLI↔client cross-client verify — 4-phase TDD COMPLETE

**`docs/planning/C2_CLI_CLIENT_VERIFY_PHASE1.md`** (48 assertions, Groups A–E). Option (a) raw-seed re-key (ADR-032).

- **Phase 1 (blueprint):** 5 divergences documented — R1 CLI `key_version` bump vs Web/Flutter option (a) raw-seed; R2 raw-seed (`key_version=0`) test ledger vs CLI `_get_current_key_version` default-1 gate; R3 web verify harness raw-MK convention; R4 `key_version=1` raw-seed-vs-HMAC ambiguity; R5 CLI multi-version lookup starts at v=1; R6 `identity_pub_key` convention.
- **Phase 2 (RED):** Python `tests/test_c2_cli_client_verify.py` 22 RED/12 guard-green; Flutter `c2_cli_verify_test.dart` 9 RED/2 skip; live `test_c2_cli_client_live_r2.py` skip offline.
- **Phase 3 (GREEN):** option (a) raw-seed re-key — `_get_current_key_version` default-0, `_make_multi_version_mk_lookup` v=0 coverage, `_prepare_rekey` `mk_v2 = derive_mk(new_seed, 0)` raw seed, no `key_version` bump; `_rebuild_rekeyed_blocks` preserves source hash key. Hermetic matrix GREEN all 4 directions: `test_c2_cli_client_verify.py` 34/34, `test_rekey_seed.py` 34/34 (M1 rewritten to `key_version`-unchanged), Flutter `c2_cli_verify_test.dart` 9/2skip, `test_i01_*` 56 GREEN.
  - **R6 RESOLVED:** raw-bytes `identity_pub_key` is canonical (Rust `digest.rs`, PHPSPEC §2.7.1 — Python correct; Web/Flutter diverge via `sha256(String)`; follow-up = expose raw-bytes path through FRB/WASM).
  - Also fixed: legacy universal `block_hash` on day blocks (`_hash_key_for_block` mirrors `get_block_hash`); `_require_wire` guard no longer eager-concats `None` reason; `test_e2` corrected to ADR-026 raw-seed default.
- **Phase 4 (REFACTOR + Group E docs) DONE:** `_rebuild_rekeyed_blocks` re-seals via canonical `LedgerChain._hash_key_for_block` (removes inline day/summary hash-key selection); `test_c2_cli_client_verify.py` gained `_content_hash_map` helper (DRY's A4+D4); PHPSPEC §2.10 harness citation lists both legs; Group E docs (ROADMAP/WEB_ROADMAP Build 65/MAP/BACKLOG/C2 roadmap/planning AGENTS/blueprint) updated; CHANGELOG deferred to release.
- **Live R2 E2E (`tests/test_c2_cli_client_live_r2.py`)** remains live-only (needs clean live Worker state; currently fails online on stale-state deobfuscation tag mismatch).

**Artifacts:** `testdata/c2_cli_rekeyed_wire.json`, `testdata/c2_cli_rekeyed_live_wire.json`, `phpoc-web/test/c2_cli_rekey_verify.mjs`, `phpoc-flutter/test/services/c2_cli_verify_test.dart`.

## C-2 CLI seed re-key (Phase A) — 4-phase TDD COMPLETE (2026-08-29)

- `renew_seed`/`mint_new_seed`/`seed_fingerprint` + `ph rekey-seed` in `main.py`. 34/34 `test_rekey_seed.py` GREEN; full Python suite 2649 pass/1 skip/0 fail.
- **Phase 4 (REFACTOR):** DRY'd the per-`_enc` re-key loop shared with `hard_rotate` (`_enc_fields`/`_decrypt_crypto_for_version`/`_prevalidate_entries_decryptable`/`_reencrypt_entry_data`); split `renew_seed` into `_prepare_rekey`/`_rebuild_rekeyed_blocks`/`_persist_rekeyed_state`/`_push_rekeyed_state`.
- **Transport adapter gap RESOLVED:** `_push_transport_updates`/`_push_rekeyed_state` route through the real `AbstractStagingTransport` contract — cookie `transport.push(REMOTE_COOKIE_PATH, …)`, staging `RemoteStagingSync.push`, ledger `RemoteLedgerSync.push_blocks/hash_index/index`; `except Exception: pass` → `logger.warning`; `_RekeyTransportSpy` + P1–P6 rewritten to the real contract; `test_i01_rotatekeys_integration.py` I6 mock updated.

## C-2 Cross-Client Verify (Web↔Flutter) — Phase 3+4 (GREEN/REFACTOR) DONE (2026-08-28)

- Hermetic matrix GREEN both directions: Web harness `phpoc-web/test/c2_cross_client_verify.mjs` 18/0/2 (A1–A6 + B7–B11 + C1–C8; B10/B12 live-only skip); Flutter harness 18/0/2 (B1–B6 + A7–A11 + C1–C8; A10/A12 live-only skip).
- Fixed 4 cross-client divergences: (1) `verifyContentHash` accepts kept-`_enc`-suffix + Python indent2 fallback; (2) genesis nested `identity` preserved on import/export; (3) `rekey_service.dart` ledger re-key fully canonical (whitelist `jsonSort` seal, ciphertext-bound entry-hash recompute, `prev_hash` cascade, recovered-identity re-sign); (4) `CryptoService.derivePdk` salt → canonical `session-salt`.
- Phase 4 REFACTOR: DRY'd harness (`runRekey`/`collectContentHashes` web; `_collectEnc`/`_chain` Flutter), Group D spec pass (PHPSPEC §2.3 + §2.10), Group E docs.

## C-2 Live R2 E2E — GREEN (2026-08-28)

`tests/test_c2_live_r2.py` + `phpoc-web/test/c2_live_rekey.mjs` pull the real test ledger (31 blocks/146 entries) under OLD MK → re-key via REAL WASM `RekeyService` → push isolated R2 prefix under NEW MK → pull+verify under NEW MK → old-seed device fails. Fixed Python `content_hash` divergence to PHPSPEC §5.5/§6.1 (KEEP `_enc` suffix, string values) — `engine.py` reorder, `migrate_format.py`, `chain.py` (KEEP-primary/STRIP-fallback), `generate_test_ledger.py` (ADR-029a seals); regenerated + re-pushed test ledger (genesis `e718daf3…`, identity `47262dce…`); 146/146 content_hash cross-check vs Web.

## Earlier completed milestones (2026-08-21 → 2026-08-28)

- **P4 Web vitest harness hygiene — 4-phase TDD COMPLETE (2026-08-28):** single `test.include` glob; 3 load errors fixed (`ledger_merge_test.mjs` 105/105, `genesis_gate_test.mjs` 218/218, `sync_indicator_test.mjs` 32/32); 8 node suites renamed `*.test.mjs`→`*_test.mjs`; 2 `verifyLedgerChain` mock gaps patched; config meta-test added. `npx vitest run` clean (9 files / 119 passed / 1 skip / 0 fail).
- **settings_genesis_component GenesisGate status-card — 4-phase TDD COMPLETE (2026-08-27):** `Settings.jsx` `handleSaveRemote` goes straight to `GenesisGate.check`; persists worker-url/API-key synchronously; offline/incompatible/error status cards. Phase 4: extracted `checkGenesis` helper + `genesisCheckSeq` latest-request-wins guard; collapsed string-state to boolean `justSaved`. 26/26 GREEN.
- **Commonplace Book Settings — 4-phase TDD COMPLETE (2026-08-24):** 34/34 widget + 12/12 service; book-scoped settings, shared worker creds, per-book theme, `RekeyService.commonplaceService`, `clearAllData` wipes both books. Phase 4: shared `ThemeVariantNotifier`, `_rekeyCommonplace` extraction. COMMITTED (`bd3e9e5`).
- **Commonplace Settings theme selector gap FIXED (2026-08-24):** Appearance→Theme dropdown → `commonplace_theme_mode`. 35/35 widget.
- **Restore-pull isolate offload + concurrent fetch — 4-phase TDD COMPLETE (2026-08-22):** bounded concurrent fetch (`pullConcurrencyLimit=5`) + CPU offload via `OffloadRunner` seam. 25/25 GREEN.
- **Smart Sync Button — 4-phase TDD COMPLETE (2026-08-21):** option (b) reconcile-then-push; `commitAndSync({forceLocal})` + `reconcileRemoteLedger`. 20/20 GREEN.
- **C-2 Full Seed Replacement (Flutter) — 4-phase TDD COMPLETE (2026-08-22), COMMITTED `07d09b0`:** option (a) new seed = new raw MK, key_version unchanged. 28/28 + 6/6 + full suite 2010/2010. Phase 4: named phase helpers + `_reencryptEntryMap`.
- **Pre-existing red-suite remediation DONE (2026-08-21):** all 43 baseline failures fixed (`RED_SUITE_REMEDIATION_PHASE1.md`); suite `+1931` GREEN.
- **Commonplace Book UI wiring COMPLETE (2026-08-23):** 40/40 GREEN; `CommonplaceService` + screens + `AppScaffold` content-swap by book.
- **Web Wipe Ledger parity (2026-08-22):** `DevModeContext.wipeLedger()` + `AuthScreen.jsx` Wipe button. 6/6 RTL GREEN (WEB_ROADMAP Build 63).
- **Book Switcher DONE (2026-08-21):** `AppScaffold` switcher bar, `book_mode` persisted. 13/13 GREEN.

## Resolved known issues (archived)

- Flutter `computeContentHash` strip divergence — all three impls KEEP the `_enc` suffix (4-phase TDD COMPLETE 2026-08-28).
- Flutter Dashboard keyboard covered "New Task" form — FIXED (2026-08-29): `AppScaffold` `.removeViewInsets(removeBottom: true)` + shrink-wrapping `ListView`.
- `verify_ledger.py` false-INVALID on canonical entry hashes — RESOLVED (2026-08-27): canonical form added (mirrors `chain._verify_entry_hash_flex`).
- Pre-existing Flutter red suite — RESOLVED 2026-08-21 (43 baseline failures).
- `day_index` corruption on push/export; deleted staged entry resurrects; flaky ordering tests — RESOLVED (archived 2026-08-18).
