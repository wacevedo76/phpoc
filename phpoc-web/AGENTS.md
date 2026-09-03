# PH Ledger React Web Application

## Purpose
React-based web frontend for the PH Ledger — user interface for task tracking, ledger visualization, sync management, onboarding, and authentication. Runs entirely in the browser with IndexedDB storage and WASM cryptography.

## Ownership
- `src/App.jsx` — Application root
- `src/components/screens/` — Screen components: Auth, Configuration, Dashboard, History, Landing, LedgerSync, NewTask, Onboarding, Settings, SyncSettings, Tags, UserProfile, **CommonplaceScreen** (Commonplace book surface — Slice 3), **AddEntrySheet** (add-not-in-place capture — Slice 3), **TopicIndex** (tag/topic filter chips — Slice 3), **CommonplaceSettingsScreen** (Commonplace-mode Settings surface — Slice 4)
- `src/components/modals/` — Modal components: PassphraseModal, **RekeyModal** (shared two-secret re-key dialog — Slice 4)
- `src/components/layout/` — Layout components: AppLayout (nav shell), **BookSwitcher** (Commonplace book-switcher bar rendered above page content), **BookBody** (content-swap helper — Commonplace Slice 3)
- `src/components/pills/` — ActiveTaskPill
- `src/components/sync/` — SyncIndicator
- `src/components/ui/` — Icon components
- `src/ledger/` — Ledger logic ported from Python: chain, engine, index_manager, merge, summary_policy, utils, **seal_fields** (`SEAL_FIELDS`/`selectSealFields`/`computeSeal` — canonical ADR-029/029a block-seal whitelist, mirror of Python `chain.py`; extended 2026-08-31 with `commonplace_genesis`/`commonplace` rows for the Commonplace Book), **chain_reconcile** (`reconcileChainCore` shared append-only merge — Slice 5 Phase 4)
- `src/commonplace/` — Commonplace Book chain/engine/storage (ADR-031): `commonplace_chain.js` (genesis + day-block build/seal/append/truncate/verify over `commonplace:blocks`), `commonplace_engine.js` (commit/verify/readEntries), `commonplace_storage.js` (export/import `commonplace:export`), **`book.js`** (Book identity + `getBookMode`/`setBookMode` localStorage persistence — Slice 2), **`book_mode.jsx`** (`BookModeProvider` + `useBookMode` reactive shared book state — Slice 3), **`commonplace_service.js`** (`CommonplaceService` + `createCommonplaceService` factory — Slice 3)
- `src/sync/` — Sync logic ported: cookie, device_uuid, http_backend, indexeddb_storage, local_cache, merge_engine, remote_sync, storage, storage_plugin, sync, transport, plugin_factory, row_staging_store, row_sync, migration, **chain_transport_helpers** (shared sealed-chain push/pull/freshness helpers — Slice 5 Phase 4)
- `src/services/` — DummyLedger, MockDataSeeder, ledger_export, ledger_import, export_auth, import_service, rekey_service
- `src/crypto/` — Crypto bridge to WASM (phpoc-crypto-core); `wasm/` subdirectory contains bundled artifacts from `phpoc-crypto-core/pkg/`
- `src/context/` — DevModeContext (dev and production share the same boot path; no mock services or DummyCryptoService fallbacks remain)
- `src/hooks/` — useActiveTasks, useAutoSync, useCookieMonitor, **useRekeyFlow** (shared re-key modal state/handlers — Slice 4)
- `test/` — JavaScript test suite (83 test files)

## Local Contracts
- Built with Vite + React
- Uses IndexedDB for local storage (IndexedDBStoragePlugin)
- Crypto operations bridge to Rust WASM (`phpoc-crypto-core`)
- HTTP backend for remote sync (`HttpBackend`)
- Must maintain behavioral parity with Python reference implementation
- Device UUID and cookie management for cross-device session detection

## Work Guidance
- **Wipe Ledger (unlock screen, Flutter parity):** `AuthScreen.jsx` renders a destructive
  red `auth-btn--wipe` button (full-screen login only, never the re-auth overlay) beside/below
  the Unlock button, gated behind a confirmation dialog. `DevModeContext.wipeLedger()` clears the
  local IndexedDB backend + localStorage worker creds + master key, then navigates to landing as a
  fresh start (`hasExistingData=false`). Cloud (R2) data is NOT touched. Strict mirror of Flutter
  `AuthService.wipeLedger()`. See ROADMAP §4 + WEB_ROADMAP Build 63.
- Component hierarchy: screens use modals + layout; layout wraps screens
- Sync flow follows same pattern as Python: check_and_sync → merge → push
- WASM crypto module loaded asynchronously
- Use context for dev mode state; hooks for derived data

## Verification
- **Commonplace Book Slice 1 (ADR-031, 2026-08-31):** `commonplace_chain_test.mjs` (67), `commonplace_engine_test.mjs` (28), `commonplace_storage_test.mjs` (19), `commonplace_ad_hoc_test.mjs` (16) — 55 tests / 130 assertions GREEN (**Phases 1–4 complete**). Phase 4 deduped `parseFormatVersion`/`isFormatVersionAtLeast`/`CONTENT_HASH_REQUIRED_VERSION`/`ZERO_HASH_64`/`computeContentHash` into `ledger/utils.js` (were duplicated across `chain.js`, `engine.js`, `commonplace_chain.js`). Run: `node test/commonplace_*_test.mjs`. Blueprint: `docs/planning/COMMONPLACE_BOOK_WEB_PHASE1.md`.
- **Commonplace Book Slice 3 — UI wiring (ADR-031, 2026-08-31):** `commonplace_service_test.mjs` (S+V, 15 node tests / 37 assertions) + `commonplace_screen_web.test.mjs` (L+A+T, 19 Vitest/RTL) + `commonplace_swap_web.test.mjs` (R, 6 Vitest/RTL) — **40 tests GREEN (Phases 1–4 complete)**. `src/commonplace/commonplace_service.js` + `book_mode.jsx`; `src/components/screens/{CommonplaceScreen,AddEntrySheet,TopicIndex}.jsx`; `src/components/layout/BookBody.jsx` (content-swap); `BookSwitcher.jsx` switched to `useBookMode()`; `DevModeContext.services.commonplaceService` + `App.jsx` `BookModeProvider`/`BookBody` + `.commonplace-*` styles. Phase 4 extracted `usePersistedBookState` (book_mode) + `normalizeTags` (service). Run: `node test/commonplace_service_test.mjs` + `npx vitest run test/commonplace_screen_web.test.mjs test/commonplace_swap_web.test.mjs`. Blueprint: `docs/planning/COMMONPLACE_BOOK_UI_WEB_PHASE1.md`.
- **Commonplace Book Slice 2 — Book Switcher (ADR-031, 2026-08-31):** `book_switcher_web.test.mjs` — 13 Vitest+RTL tests (groups A–D: Book identity, `book.js` persistence, `BookSwitcher` component, `AppLayout` integration) GREEN (**Phases 1–4 complete**). `src/commonplace/book.js` (Book identity + `getBookMode`/`setBookMode` over localStorage `phpoc_book_mode`), `src/components/layout/BookSwitcher.jsx`, `AppLayout` renders the switcher above `.app-content`, `.book-switcher*` styles in `App.css`. Phase 4 deduped `Book.values` to share object references with `Book.ledger`/`Book.commonplace`. Run: `npx vitest run test/book_switcher_web.test.mjs`. Blueprint: `docs/planning/COMMONPLACE_BOOK_SWITCHER_WEB_PHASE1.md`.
- **Commonplace Book Slice 4 — Settings surface (ADR-031, 2026-08-31):** `commonplace_settings_service_test.mjs` (B1–B3, 13 node assertions) + `commonplace_settings_rekey_test.mjs` (R1–R7, 7 node tests) + `commonplace_settings_swap_web.test.mjs` (S1–S6, 6 Vitest/RTL) + `commonplace_settings_screen_web.test.mjs` (W/P/V/B4/C/X/R8, 18 Vitest/RTL) — **44 test cases GREEN (Phases 1–4 complete)**. `CommonplaceSettingsScreen` + `BookBody` `settings`/`dashboard`-only swap (over-swap fix) + `CommonplaceService.exportForBackup`/`restoreFromBackup` + `RekeyService` re-encrypts `commonplace:blocks` in lockstep (flattened genesis; R6 abort-before-write). Phase 4 extracted shared `useRekeyFlow` hook + `RekeyModal` component (deduped re-key modal/state across ledger `Settings.jsx`/`CommonplaceSettingsScreen.jsx`) and unified `_rebuildChain` in `rekey_service.js`. Run: `node test/commonplace_settings_{service,rekey}_test.mjs` + `npx vitest run test/commonplace_settings_{swap,screen}_web.test.mjs`. Blueprint: `docs/planning/COMMONPLACE_BOOK_SETTINGS_WEB_PHASE1.md`.
- **Commonplace Book Slice 5 — Remote sync (ADR-031, Phases 1–4 COMPLETE, 2026-09-03):** `commonplace_push_service_test.mjs` (P 9) + `commonplace_pull_service_test.mjs` (L 10) + `commonplace_reconcile_test.mjs` (F 7) + `commonplace_sync_e2e_test.mjs` (R 5) + shared `commonplace_sync_test_support.mjs` harness (`KeyedMockCrypto` + `FakeSyncTransport` + `buildChain`/`seedRemoteChain`). **31 tests GREEN (92 assertions)** — implemented `src/commonplace/commonplace_{push,pull}_service.js`, `CommonplaceService.reconcileRemoteChain`, `CommonplaceChain.verifyBlocks`/`reconcileRemoteChain`, `ledger/utils.js` `jsonSortNoSpaces`, `sync/keys.js` `REMOTE_COMMONPLACE_*`. One Phase 2 assertion corrected (P3 space-separator check — mock crypto embeds plaintext "Passage 0"). **Phase 4 (REFACTOR):** extracted `reconcileChainCore` (`src/ledger/chain_reconcile.js`) + shared push/pull/freshness helpers (`src/sync/chain_transport_helpers.js` — `chainBlockPath`/`readRemoteHashIndex`/`pushChainPayloads`/`pullRemoteHasMore`); all suites re-verified GREEN. Run: `node test/commonplace_{push_service,pull_service,reconcile,sync_e2e}_test.mjs`. Blueprint: `docs/planning/COMMONPLACE_BOOK_SYNC_WEB_PHASE1.md` (31 assertions, groups P/L/F/R).
- `test/` directory: 37 test files covering crypto, sync, ledger, storage, import/export, transport, and component rendering
- New (Jun 2026): `ledger_import_chain_test.mjs` (31), `ledger_import_v2_test.mjs` (42), `import_orchestration_test.mjs` (51), `ledger_roundtrip_test.mjs` (46) — 170 tests for web import/export workflow coverage
- **CCS-2 (Jul 2026):** `ccs2_row_level_reconcile_test.mjs` — 41/41 GREEN — canonical-row (activity_id LWW) reconcile layer in `sync.js` (Option B). Blueprint: `docs/planning/CCS2_PHASE1.md`
- **Chain seal whitelist (ADR-029/029a, Web):** `chain_seal_whitelist_test.mjs` — 27 assertions (groups A–E) targeting convergence of Web seamers/verifiers (`chain.js`, `merge.js`, `summary_policy.js`) onto the closed `SEAL_FIELDS` whitelist. **GREEN 28/28 — Phases 1–4 complete.** P4 deduped the leftover open-set `checkData` builders in `sync.js`/`genesis_gate.js` through the shared whitelist; confirmed no `format_version`/`key_version` sealing. `export_auth.js`/`ledger_import.js`/`remote_import.js`/`DevModeContext.jsx` intentionally kept legacy-open-set tolerant (backward-compat multi-format verify). Blueprint: `docs/planning/CANONICAL_SEALFIELD_WEB_PHASE1.md`
- **ADR-030 ledger-aware ownership-handoff (Web):** `web_ledger_auto_pull_test.mjs` — 17 assertions across groups W1 (ledger pull on handoff), W2 (Scenario-5/6 uncommitted-sealed-row drop), W3 (Web `_ledgerActivityIds()` derivation). **GREEN 17/17 — 4-Phase TDD complete (Phases 1–4).** `sync.js`: `_pullLedgerOnHandoff()` (block-count-gated, fail-safe) wired into `_reconcileAndClaim()`; `_ledgerActivityIds()`; Scenario-5/6 drop in `_mergeRemoteIntoLocal` via pure `SyncService._dropSealedUncommitted` (mirrors Flutter `MergeEngine.dropLedgerCommitted`); merge awaited before push. Blueprint: `docs/planning/WEB_LEDGER_AUTO_PULL_PHASE1.md`
- **Wipe Ledger from unlock screen (Flutter parity) (2026-08-22):** `auth_screen_wipe_test.mjs` — 7/7 GREEN.
  Verifies the `AuthScreen` destructive Wipe button gating (full-screen only, requires `onWipe`), the
  confirm-dialog open/cancel/confirm flow, `onWipe` invocation + wiping state, and error surfacing.
  Backing logic: `DevModeContext.wipeLedger()` clears the IndexedDB backend + localStorage worker creds
  + master key, then → landing fresh start. See WEB_ROADMAP Build 63.
- **connectToWorker full-chain fix (2026-08-21):** `worker_connect_fullchain_regression_test.mjs` — 23/23 GREEN. Locks in that `connectToWorker` fetches the FULL remote `ledger/blocks/` chain into `ledger:blocks` (so committed history loads), keeps only genuinely-uncommitted staging rows uncommitted (no D11 auto-commit), converts them via `canonicalRowToDTO` + `LocalCache.writeEntries` so the Sync cards render full fields (no blank cards), and never promotes staging into the ledger. Fixes the `588b034` "staging-based connectToWorker" regression.
- **C-2 Seed Re-Key Web (2026-08-24):** `rekey_service_web_test.mjs` — 28 Node tests (Groups R11/B5/M6/P6) + `rekey_settings_web.test.mjs` — 6 Vitest/RTL tests (Group S1–S6). **Phase 3 GREEN: 28/28 + 6/6.** Implemented `src/services/rekey_service.js` (`RekeyService`, option a: new seed = new raw MK, key_version unchanged) + Settings Security & Recovery tile/dialog + `DevModeContext.rekey(...)`. Node harness uses the REAL WASM `CryptoService` (`src/crypto/wasm/phpoc_crypto_core_bg.wasm`) + `MemoryBackend`; Group S mirrors Flutter `settings_screen_test.dart` Group S. Run: `node --test test/rekey_service_web_test.mjs` / `npx vitest run test/rekey_settings_web.test.mjs`.
- **C-2 Cross-Client Verification harness (Phase 4 REFACTOR, 2026-08-28):** `test/c2_fixture_gen.mjs` (shared canonical fixture generator + CLI → `testdata/c2_cross_client_fixture.json`) + `test/c2_cross_client_verify.mjs` (`node --test`: Group A Web re-keyer A1–A6, Group B Web verifier of the Flutter wire B7–B12, Group C crypto invariants C1–C8). Companion Flutter probe: `phpoc-flutter/test/services/c2_cross_client_verify_test.dart`. **18/18 GREEN + 2/2 live-only skip** (B10/B12); Phase 4 DRY'd the harness (`runRekey`/`collectContentHashes`). Run: `node --test test/c2_cross_client_verify.mjs`. Blueprint: `docs/planning/C2_CROSS_CLIENT_VERIFY_PHASE1.md`.
- Node-based tests: `node test/<name>.mjs`
- Vitest component tests: `npx vitest run test/settings_genesis_component.test.mjs`
- Smoke tests for WASM integration
- Remote Worker testing credentials: `TEST_CREDENTIALS.md` at repo root (gitignored)

## Child DOX Index
None — flat source structure under `src/`.
