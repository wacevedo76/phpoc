# PHPOC — Project Map

## File Inventory
Each file annotated **[HOT]** (active dev area — re-read if in scope)
or **[COLD]** (stable — skip unless handoff says otherwise).

### Reference Docs

| File | Temp | Key contents |
|---|---|---|
| `CROSS_CLIENT_STAGE_SYNCING_REFERENCE.md` | HOT | **Primary living reference** for staging sync & reconciliation across all clients: architecture, sync gate flow, merge engine, blob obfuscation, device cookie, hash index, row-level sync (ADR-025), source code index, test coverage map, protocol contracts, abstract workflow (§12) |
| `DEVICE_COOKIE_AND_STAGING_DATABASE_SCHEMA.md` | COLD | Cross-client reference: Device Cookie purpose/format/flow, Staging Database Schema (legacy + row-level), encryption layers, remote paths, LWW merge (detailed schema; see CROSS_CLIENT_STAGE_SYNCING_REFERENCE.md for protocol-level overview) |

### Planning Docs

| File | Temp | Key contents |
|---|---|---|
| `CROSS_CLIENT_REMOTE-LOCAL_STAGING_SYNC-RECONCILIATION_PLAN.md` | HOT | **Implementation plan**: CCS-1 through CCS-4 phases, scorecard matrix, dependency graph, per-client source file index. References abstract workflow in reference doc §12. |

### Source (core Python packages)

| File | Temp | Key contents |
|---|---|---|
| `lib/core/crypto/frb_generated.dart` | HOT | **NEW (Phase 3)** — 23-function Dart FFI API surface matching Rust `frb.rs` crypto core (AES-128-CTR, PBKDF2, HMAC-SHA256, blob obfuscation, device identity) |
| `lib/core/crypto/crypto_service_native.dart` | HOT | **NEW (Phase 3)** — Thin wrapper delegating to `frb_generated.dart`, 29-method public API matching `CryptoService` contract |
| `lib/core/crypto/crypto_service.dart` | HOT | Pure-Dart crypto shim (85 tests incl. deterministic blob obfuscation), to be replaced by native FFI backend |
| `../phpoc-crypto-core/src/frb.rs` | HOT | **NEW (Phase 3)** — flutter_rust_bridge Rust API surface (23 functions, mirrors wasm.rs), compiles with flutter_rust_bridge v2.12.0 |
| `main.py` | HOT | CLI entry — argparse, auth tiers, staging + orchestrator wiring |
| `phpoc_cli/interface.py` | HOT | Display: `view_active`, `show_rep`, `list_habits` |
| `phpoc_cli/strategies.py` | COLD | `InteractiveCLIStrategy` — sync confirmation UI |
| `phpoc_cli/background.py` | COLD | Phase A instant reads, background sync check |
| `phpoc_cli/daemon.py` | COLD | `PhDaemon` lifecycle |
| `phpoc_cli/wal.py` | COLD | Write-ahead log, background push |
| `phpoc_cli/onboarding.py` | HOT | `run_onboarding()` (unified pipeline), `run_onboarding_picker()` (interactive provider picker) — transport-agnostic import, uses canonical `staging/blob` path |
| `phpoc_cli/onboarding_file.py` | HOT | `run_onboarding_file()` — local JSON file import (v1/v2/chain) |
| `phpoc_cli/migrate.py` | NEW | `migrate_chain()` — canonical format migration (I-07/I-17) |
| `phpoc_cli/transport_cmd.py` | COLD | `ph transport` subcommand |
| `core/sync/orchestrator.py` | HOT | `SyncOrchestrator` — sync lifecycle coordinator + same-genesis merge via `LedgerMerge.merge()` |
| `core/sync/http_transport.py` | COLD | `HttpStagingTransport` — HTTP GET/PUT/LIST + ETag |
| `core/sync/git_transport.py` | COLD | `GitStagingTransport` |
| `core/sync/transport_registry.py` | HOT | `TransportProvider` dataclass, `TransportRegistry` — extensible transport discovery for onboarding |
| `core/activity_id.py` | 🟢 GREEN | **NEW (B-05c Phase 3)** — `ActivityIdGenerator` — CSPRNG 10-char alphanumeric activity IDs, port of Flutter `activity_id.dart` |
| `core/staging_hash_index.py` | 🟢 GREEN | **NEW (B-05c Phase 3)** — `StagingHashIndex` + `StagingHashDiff` — compact manifest for O(1) staging change detection, port of Flutter/Web |
| `security/crypto.py` | HOT | `CryptoManager`, `NoAuthCryptoManager` |
| `security/auth.py` | HOT | Passphrase + Recovery authenticators — per-user PBKDF2 salt, transparent upgrade |
| `security/device_identity.py` | HOT | `DeviceIdentity`, `AbstractDeviceIdentityProvider`. Bug 3a: `-cli` suffix. I-09: `derive_device_id()` from MK + device_local_secret. |
| `domain/ledger/helpers.py` | HOT | `get_block_hash()`, `compute_entry_hash()`, `verify_entry_hash_two_way()` — canonical hash extraction + cross-client entry hash + 2-way hash verifier (used by onboarding + chain flex) |
| `domain/ledger/chain.py` | HOT | Chain building, sealing, verification — uses `compute_entry_hash` from helpers |
| `domain/ledger/remote_sync.py` | HOT | `RemoteLedgerSync` — push/pull ledger blocks + `pull_full_chain()` + `pull_block_by_index()`. TEMP: [DIAG] logging for chain integrity investigation (2026-07-05).
| `domain/ledger/merge.py` | HOT | `LedgerMerge` — merge divergent chains sharing genesis (GREEN phase — 47 tests all pass) |
| `domain/staging/service.py` | HOT | `StagingService` — auth gate, `check_and_sync()`, push |
| `domain/staging/remote_sync.py` | HOT | Blob obfuscation, pull/push, device cookie, hash index pull/push, canonical `staging/blob` path (PHPSPEC §8) |
| `domain/staging/merge_engine.py` | COLD | Cross-device merge, dedup by `entry_id` |
| `domain/cookie/device_cookie.py` | COLD | Random-specifier device cookie |
| `worker/src/index.ts` | HOT | Cloudflare Worker router (~175 lines): CORS, auth, generic blob handlers + row-level staging dispatch |
| `worker/src/row_level_staging.ts` | HOT | **NEW (Phase 4 REFACTOR)** — Row-level staging types, validation, manifest helpers, 4 HTTP handlers extracted from index.ts (ADR-025) |

### Flutter (phpoc-flutter)

| File | Temp | Key contents |
|---|---|---|
| `lib/core/utils/format_utils.dart` | HOT | Shared date/time/duration formatters: dateTime, date, dateShort, time, duration, epochToIsoDate, epochToDateStr, monthAbbr, parseIsoDateStr |
| `lib/core/models/import_result.dart` | HOT | **NEW (B-02 Phase 3)** — ImportPreview, ImportResult, DateRange, ImportException |
| `lib/data/ledger/helpers.dart` | HOT | **NEW** — getBlockHash, computeEntryHash, verifyEntryHashTwoWay, computeContentHash, verifyContentHash |
| `lib/data/ledger/chain.dart` | HOT | **NEW** — LedgerChain: buildGenesisBlock, buildDayBlock, append, appendBlocks, truncate, verify, computeSeal, verifySeal, identity MAC |
| `lib/data/ledger/engine.dart` | HOT | **NEW** — LedgerEngine: commit, verify, revert, queryIndex, rebuildIndex (coordinates chain + index + staging) |
| `lib/data/ledger/index_manager.dart` | HOT | **NEW** — IndexManager: blind index (date→title→duration), encrypted at rest, plaintext fallback |
| `lib/data/ledger/summary_policy.dart` | HOT | **NEW** — SummaryPolicy hierarchy: YearMonthSummaryPolicy, YearOnlySummaryPolicy, NoSummaryPolicy |
| `lib/data/ledger/merge.dart` | HOT | **NEW** — Chain merge: fork detection, content-hash dedup, chain rebuild with summaries |
| `lib/services/import_service.dart` | HOT | **NEW (B-02 Phase 3)** — ImportService: dryRun, import, importFromFile, rollback |
| `lib/features/landing/landing_screen.dart` | HOT | Landing screen — Log In / New Ledger routing |
| `lib/features/auth/unlock_screen.dart` | HOT | Unlock screen — passphrase entry, validation, auth flow |
| `lib/features/onboarding/onboarding_screen.dart` | HOT | Onboarding — create/import/connect sub-flows |
| `lib/features/dashboard/dashboard_screen.dart` | HOT | Dashboard — active task card, capture, timer |
| `lib/features/history/history_screen.dart` | HOT | History — CalendarMonthGrid, entry list grouped by date, single-date toggle + date-range filter, detail expansion |
| `lib/features/history/calendar_month_grid.dart` | HOT | **NEW (Phase 3)** — CalendarMonthGrid widget: month grid, green dots, prev/next month+year navigation, date selection |
| `lib/features/sync/sync_screen.dart` | HOT | Sync — status, manual trigger, pending count |
| `lib/features/settings/settings_screen.dart` | HOT | Settings — Worker config, passphrase change, seed export to file, ledger backup/restore, import tile (B-02) |
| `lib/features/import/import_screen.dart` | HOT | **B-02 Phase 3** — ImportScreen (ConsumerStatefulWidget): seed field, file picker, preview button, preview/progress sheets |
| `lib/features/import/import_providers.dart` | HOT | **B-02 Phase 3** — ImportNotifier (Notifier<ImportState>) + importServiceProvider: sealed state machine (Initial→Ready→Previewing→Loaded→Running→Done/Failed) |
| `lib/features/import/import_preview_sheet.dart` | HOT | **NEW (B-02 Phase 3)** — ImportPreviewSheet (ModalBottomSheet): entry count, date range, conflicts, Import/ImportAnyway |
| `lib/features/import/import_progress_sheet.dart` | HOT | **NEW (B-02 Phase 3)** — ImportProgressSheet (ModalBottomSheet): .running (phase + indicator), .success (summary), .error (recovery) |
| `lib/features/shared/app_scaffold.dart` | HOT | Bottom-nav shell (Dashboard/History/Sync/Settings) |
| `lib/features/shared/loading_indicator.dart` | HOT | Shared loading indicator widget |
| `lib/routing/app_router.dart` | HOT | GoRouter + AppLifecycleNotifier (5-phase lifecycle), /import route (B-02) |

### Web/Mobile (phpoc-web)

| File | Temp | Key contents |
|---|---|---|
| `phpoc-web/src/sync/genesis_gate.js` | 🟢 GREEN | GenesisGate.check() — Tier 1 SHA-256 fast path + Tier 2 hash index fork detection + stale index defense + `merged` flag on all return paths. 6 typed error classes, throw-based API. 218 tests pass. (2026-07-02) |
| `phpoc-web/src/sync/hash_index.js` | 🟢 GREEN | **NEW** — `buildHashIndex(chain)` and `compareHashIndexes(local, remote)` pure functions (85 lines). Powers Tier 1/2 hash index genesis gate speedup. 58 unit tests pass in `hash_index_test.mjs`. (2026-07-02) |
| `phpoc-web/test/hash_index_test.mjs` | 🟢 GREEN | **NEW** — 58 tests: `buildHashIndex` (A: 9 categories, 31 assertions) + `compareHashIndexes` (B: 13 tests, 23 assertions). All GREEN — Phase 3 implementation complete. (2026-07-02) |
| `phpoc-web/test/genesis_gate_test.mjs` | 🟢 GREEN | 213 tests — Groups A-D (existing) + Groups E/F/G (Tier 1/2 hash index). Group E: Tier 1 fast path (9). Group F: Tier 2 incremental pull (11). Group G: Full integration (10). All GREEN. (2026-07-02) |
| `phpoc-web/test/local_cache_test.mjs` | 🟢 GREEN | 58-test suite for staging entry format canonicalization (Bug 3b fix, GREEN phase) |
| `phpoc-web/test/device_uuid_test.mjs` | 🟢 GREEN | 36-test suite — Groups 1-8 (original) + Groups 9-12 client suffix tests (Bug 3a fix) |
| `phpoc-web/test/settings_genesis_test.mjs` | 🟢 GREEN | 13-test Settings UI genesis gate integration (updated for Bug 1 throw API) |
| `phpoc-web/test/sync_service_test.mjs` | 🟢 GREEN | 287 tests — Groups A-W all GREEN + Groups X/Y/Z (32 staging tests, RED phase). Phase B2: push gating (W1-W4), genesisCompatible caching (V1-V2), duplicate pullCookie prevention (U1-U2), unnecessary push prevention (T1-T4), M2/M5 updated expectations. (2026-07-02, updated 2026-07-07) |
| `phpoc-web/test/activity_id_test.mjs` | 🔴 RED | **NEW** — 7 tests (Category A): `generateActivityId()` format, entropy, uniqueness. Phase 2 RED. (2026-07-07) |
| `phpoc-web/test/staging_hash_index_test.mjs` | 🔴 RED | **NEW** — 43 tests (Categories B/C/D): activity_id lifecycle (B1-B16), `buildStagingHashIndex()` (C1-C13), `compareStagingHashIndexes()` (D1-D14). Phase 2 RED. (2026-07-07) |
| `phpoc-web/test/staging_backward_compat_test.mjs` | 🔴 RED | **NEW** — 24 tests (Categories I/J): legacy entries/remote backward compat (I1-I10), edge cases & stress (J1-J14). Phase 2 RED. (2026-07-07) |
| `phpoc-web/test/unlock_performance_regression_test.mjs` | 🔴 RED | **NEW** — 34 tests (Groups A-D) for unlock performance regression fixes: hash index bootstrap gap (A1-A6), cookie catch-22 (B1-B6), specifier mismatch short-circuit (C1-C6), combined scenarios (D1-D3). Current: 15 pass / 19 fail (RED phase, fix not implemented). (2026-07-05) |
| `phpoc-web/test/worker_connect_onboarding_test.mjs` | HOT | 65 tests — Worker Connect onboarding (fetch genesis, passphrase verify, persistence) |
| `phpoc-web/test/worker_connect_blocks_format.test.mjs` | 🟢 GREEN | **NEW** — 56 tests: Group A blocks-format onboarding (7 scenarios, stale `ledger:blocks` delete) + Group B bootstrap auto-clear recovery (5 scenarios) (2026-06-29) |
| `phpoc-web/test/onboarding_import_component.test.mjs` | 🟢 GREEN | **NEW** — 21 Vitest+RTL component tests for OnboardingScreen import form state machine (file picker gating, destroy warnings, checkbox gates, error display, back navigation) |
| `phpoc-web/test/onboarding_cloud_conflict.test.mjs` | 🟢 GREEN | **NEW** — 23 tests: Phase 3 deferred — cloud onboarding dual-format conflict detection (`probeDualFormats()`) (2026-06-29) |
| `phpoc-web/src/sync/remote_import.js` | HOT | `WorkerImportSource` — cloud backup import source (list, fetch, validate). 57-test suite. (2026-06-20) |
| `phpoc-web/test/remote_import_test.mjs` | HOT | 57 assertions — 6 groups (connection, list, fetch, validate happy/error, edge cases) |
| `phpoc-web/src/components/screens/OnboardingScreen.jsx` | HOT | 5 onboarding paths including "From Cloud" import sub-option (2026-06-20) |
| `phpoc-web/src/crypto/index.js` | HOT | `CryptoService` — singleton WASM wrapper (20 exports), master key cache, ready guards. Imports from `./wasm/` (bundled by Vite, not external). |
| `phpoc-web/src/services/export_auth.js` | 🟢 GREEN | **NEW** — `exportWithAuth()` — always-fresh passphrase auth + genesis seal verification via `_verifyGenesisSeal()`. 40 tests pass. E2E-06 Phase 4 complete. (2026-07-04) |
| `phpoc-web/src/services/import_service.js` | 🟢 GREEN | **B-02 Web Phase 4 Complete** — `ImportService` + 3 data classes + `_validateSeed`, `_collectTargetData`, `_parseChainBuffer`. 55 tests. (2026-08-03) |
| `phpoc-web/test/export_passphrase_validation_test.mjs` | 🟢 GREEN | **NEW** — 40 assertions (A-E groups): cached MK bypass, seal verification, cache safety, error messaging, integration. (2026-07-04) |
| `phpoc-web/src/crypto/wasm/phpoc_crypto_core.js` | HOT | WASM glue JS — copied from `phpoc-crypto-core/pkg/` for Vite bundling. |
| `phpoc-web/src/crypto/wasm/phpoc_crypto_core_bg.wasm` | HOT | WASM binary — 134KB, content-hashed in production build. |
| `phpoc-web/src/context/DevModeContext.jsx` | HOT | `connectToWorker()` + `importFromCloud()` + `effectiveServices` Proxy (auto-sync) + `ttlWarning` banner state + `handleTtlExpiry` (auto-logout on cookie expiry). Chain integrity: `onboardFromRemote` verifies full prev_hash linkage (2026-07-05).
| `phpoc-web/src/ledger/utils.js` | HOT | `jsonSort()`, `jsonSortIndent2()`, `computeEntryHash()` — Python-compatible JSON serialization + canonical entry hashing (2026-07-16) |
| `phpoc-web/src/ledger/chain.js` | HOT | `LedgerChain` — block storage, append/appendBlocks (prev_hash verification in `append()` added 2026-07-05) |
| `phpoc-web/src/ledger/import_entries.js` | 🟢 GREEN | **B-02 Web Phase 4 Complete** — `EntryImporter` + `_entryData`, `_coerceField`, `_deriveDate` helpers. 55 tests. (2026-08-03) |
| `phpoc-web/test/utils_test.mjs` | HOT | 27 tests — validates jsonSort() matches Python output |
| `phpoc-web/src/hooks/useAutoSync.js` | HOT | Auto-sync hook — `createAutoSync()` + `useAutoSync()` React hook (GREEN, 58 assertions, 0 failures) |
| `phpoc-web/test/auto_sync_hook_test.mjs` | HOT | 24-assertion test suite for auto-sync hook (all GREEN) |
| `phpoc-web/test/ledger_sync_test.mjs` | 🟢 GREEN | 31-test TDD suite for `pushLedgerBlocks()` — GREEN phase complete, 76 assertions all passing |
| `phpoc-web/test/commit_push_integration_test.mjs` | 🟢 GREEN | 14-test Commit→Push Wiring suite — all 60 assertions pass (wiring complete) |
| `phpoc-web/test/cross_client_web_test.mjs` | 🟢 GREEN | 78 tests: auth gate (5), reconcile merge (15), full round-trip (15), auth timing (6), pause/unpause lifecycle across devices (37). Updated for Bug 3a/3b format changes (2026-07-01) |
| `phpoc-web/test/sync_indicator_test.mjs` | 🟢 GREEN | 32-test SyncIndicator unit test — status config, 6 status mappings, compact mode, fallback |
| `phpoc-web/test/display_status_test.mjs` | 🟢 GREEN | 20-test `computeDisplayStatus()` unit test — SYNCING priority, NOT_SYNCED, READY passthrough, edge cases |
| `phpoc-web/test/reauth_ttl_test.mjs` | 🟢 GREEN | 50-test suite for `checkCookieTtl()` + `createCookieMonitor()` — all 50 pass (GREEN phase complete) |
| `phpoc-web/test/reauth_integration_test.mjs` | 🟢 GREEN | 40-test suite for full re-auth flow integration |
| `phpoc-web/test/no_fallback_cookie_test.mjs` | 🟢 GREEN | **NEW** — 29 tests for Stage 1.3: no-cookie→true, monitor grace, fallback removal (Jul 4) |
| `phpoc-web/test/reauth_genesis_mismatch_test.mjs` | 🟢 GREEN | **NEW** — 47 tests for Stage 1.4-1.5: `_reconcileAndClaim` genesis gate, `performReauth` mismatch propagation, error-path coverage (Jul 4) |
| `phpoc-web/test/ledger_import_chain_test.mjs` | 🟢 GREEN | **NEW** — 31 tests for raw chain import path (genesis detection, block seals, prev_hash linkage, entry hash validation, mixed block types) |
| `phpoc-web/test/ledger_import_v2_test.mjs` | 🟢 GREEN | **NEW** — 42 tests for v2 format import path (genesis hash extraction, ledger+staging preservation, empty edge cases) |
| `phpoc-web/test/import_orchestration_test.mjs` | 🟢 GREEN | **NEW** — 51 tests for two-phase validate→confirm orchestration (in-memory storage, genesis gating, staging merge dedup, identity persistence) |
| `phpoc-web/test/ledger_roundtrip_test.mjs` | 🟢 GREEN | **NEW** — 46 tests for full export→import fidelity (v1, v2, active/paused entries, deterministic seal, wrong key rejection) |
| `phpoc-web/src/hooks/useCookieMonitor.js` | HOT | `checkCookieTtl()` + `createCookieMonitor()` — proactive cookie TTL polling + MK clearing + `onWarning` callback. Stage 1.3: no cookie → returns `true` (graceful skip) instead of `false` (Jul 4) |
| `phpoc-web/src/sync/display_status.js` | HOT | `computeDisplayStatus()` pure function + STATUS_* constants extracted from SyncSettings.jsx |
| `phpoc-web/src/sync/display_title.js` | HOT | **NEW** — `formatDisplayTitle()` + `ENCRYPTED_PLACEHOLDER` constant, extracted from ActiveTaskPill/History/SyncSettings (Phase 4 refactor) |
| `phpoc-web/src/sync/base64.js` | HOT | **NEW** — shared `base64ToBytes`/`bytesToBase64` utilities, used by sync.js, remote_sync.js, genesis_gate.js (2026-06-30) |
| `phpoc-web/src/sync/keys.js` | HOT | **NEW** — canonical path constants (10 keys: remote staging/cookie/ledger + hash index, local cookie/blocks/index + hash_index), single source of truth (2026-06-30, updated 2026-07-02, 2026-07-05) |
| `phpoc-web/src/sync/entry_dto.js` | 🟢 GREEN | DTO conversion: `rawCommittedEntryToDTO`, `rawEntryToDTO`, `parsePlainInt`, `parsePlainJSON`. Bug 3b: handles `device_uuid_enc` field. (2026-07-01) |
| `phpoc-web/src/sync/remote_sync.js` | 🟢 GREEN | `RemoteSync` — blob pull/push, cookie pull/push via transport. Bug 3b: pushBlob converts DTOs to raw spec format. Uses shared `base64.js` + `keys.js`. |
| `phpoc-web/src/sync/cookie.js` | COLD | `DeviceCookie` — TTL fallback bug fixed (nullish coalescing), stale header updated, uses `COOKIE_KEY` constant. |
| `phpoc-web/src/sync/sync.js` | 🔴 RED | Core sync orchestrator. Bug 1: _genesisGatePhase catches typed errors. Bug 2: pushLedgerBlocks position counter. Bug 3a: _fastPathPhase relaxed. Bug 3b: reconcile via writeEntries DTO→raw. Hash index: pushLedgerBlocks pushes hash_index artifacts, _genesisGatePhase caches locally. Phase B2: `merged` flag gating, `_genesisCompatible` caching, `_lastRemoteCookie` reuse. Chain integrity (Jul 5): enumerate-order push, genesis collision guard. (2026-07-05)
| `phpoc-web/src/sync/activity_id.js` | 🟢 GREEN | **NEW (Phase 3)** — `generateActivityId()` 10-char CSPRNG alphanumeric IDs (~59 bits entropy) |
| `phpoc-web/src/sync/staging_hash_index.js` | 🟢 GREEN | **NEW (Phase 3)** — `buildStagingHashIndex()`, `compareStagingHashIndexes()`, `computeHashForIndex()` |
| `phpoc-web/src/sync/local_cache.js` | 🟢 GREEN | **MODIFIED (Phase 3)** — activity_id field, hash index persistence, injectible `generateId` test seam |
| `phpoc-web/src/sync/row_staging_store.js` | 🟢 GREEN | **NEW (Phase 3 GREEN)** — `RowStagingStore` — row-per-activity staging via `staging:row:{id}` keys. Also transport-compatible (`pull`/`push`/`delete` path-based). |
| `phpoc-web/src/sync/row_sync.js` | 🟢 GREEN | **NEW (Phase 3 GREEN)** — `buildDiff()` 8-scenario LWW resolution + `RowSyncWorker` HTTP client (manifest, row CRUD, retry). |
| `phpoc-web/src/sync/migration.js` | 🟢 GREEN | **NEW (Phase 3 GREEN)** — `migrateBlobToRows()` blob→rows conversion, idempotent (marker key), best-effort. |
| `phpoc-web/src/components/screens/SyncSettings.jsx` | HOT | Sync UI — status display (`computeDisplayStatus` + `isAutoSyncing`), commit flow. Reauth overlay refs removed (2026-06-28). |
| `phpoc-web/src/components/screens/ImportScreen.jsx` | 🟢 GREEN | **B-02 Web Phase 4 Complete** — Import entries placeholder screen. Route: /import. (2026-08-03) |
| `phpoc-web/src/components/ui/EncryptionFlags.jsx` | HOT | **NEW** — reusable encryption checkbox group (master + per-field), extracted from Dashboard + NewTask (Phase 4 refactor) |
| `phpoc-web/test/settings_genesis_component.test.mjs` | 🟢 GREEN | 26-test Vitest + RTL component test suite for Settings genesis gate (B: 20, E: 6, F: 4). All 26 pass (accessibility attributes added). |
| `phpoc-web/src/App.jsx` | HOT | Re-auth overlay replaced with TTL warning banner + `ErrorBoundary` class component + /import route → ImportScreen (2026-08-03) |

*(See full file listing in MAP.md — this is a quick-reference summary.)*

**Test files:** phpoc-web has 42 test files (~2,400+ total tests). Most GREEN; ~116 new RED tests for staging hash index (Phase 2 complete — implementation in Phase 3).

### Tests (39 files, ~22,000 lines, ~1929 tests)

Key test files:
- `tests/test_ledger_merge.py` — 47 tests for `LedgerMerge.merge()` — TDD GREEN phase (47 PASS, 0 FAIL)
- `tests/test_staging_sync_optimization.py` — 85 tests, auth gate, cross-device, merge
- `tests/test_http_transport.py` — 68 tests, HTTP + ETag
- `tests/test_wal.py` — WAL lifecycle
- `tests/test_phase4_staging_interaction_flow.py` — 69 tests, sync lifecycle
- `tests/test_migration.py` — 🔴 27 tests for canonical ledger format migration (Groups A–F), Phase 2 RED (12P/6F/9S, 2026-07-03)
- `tests/test_onboarding_e2e.py` — 76 E2E tests (all GREEN), Phase 5d: 44 pipeline tests + 14 registry-integration + 8 picker UI + 10 real-transport E2E
- `testdata/canonical_test_vectors.json` — 🔴 Shared seal test vectors for cross-platform (PY + JS) canonical format tests (2026-07-03)
- `tests/test_phase5_main_wiring.py` — 72 tests, sync/onboarding CLI dispatch + argparse routing
- `tests/test_transport_registry.py` — 50 tests (all GREEN), TransportProvider + TransportRegistry unit tests
- `tests/conftest.py` — `TransportSpy`, cookie helpers, staging blob factories
- `tests/test_cross_platform_integration.py` — 🔜 Cross-platform live integration tests (CLI ↔ Worker), blob/cookie/ledger round-trips, full 8-step workflow
- `tests/test_cross_platform_crypto.py` — 🔜 Python ↔ WASM obfuscation compatibility verification
- `tests/test_i09_device_attribution.py` — 🟢 GREEN **NEW (Phase 3)** — 27 tests for I-09 device attribution (Groups A, B, C, D, I): device_local_secret generation, HMAC-derived device_id, migration, cookie integration, edge cases
- `worker/test/index.test.ts` — 🟢 GREEN — 49 Worker blob store integration tests (auth, CORS, GET/PUT/DELETE, list, error handling)
- `worker/test/row_level_endpoints.test.ts` — 🟢 GREEN **NEW (Phase 3)** — 55 row-level staging endpoint tests (manifest, row CRUD, push guard, auth/cors, edge cases)
- `phpoc-web/test/row_staging_store_test.mjs` — 🔴 RED **NEW (Phase 2)** — 49 assertions, Group S (S1–S25): RowStagingStore IndexedDB CRUD with activity_id key path
- `phpoc-web/test/row_sync_test.mjs` — 🔴 RED **NEW (Phase 2)** — 134 assertions, Groups D (D1–D35: buildDiff 8-scenario resolution) + W (W1–W30: RowSync HTTP integration)
- `phpoc-web/test/row_integration_test.mjs` — 🔴 RED **NEW (Phase 2)** — 70 assertions, Groups M (M1–M12: blob→rows migration) + I (I1–I18: full sync integration)
- `phpoc-web/test/i09_device_attribution.test.mjs` — 🟢 GREEN **NEW (Phase 3)** — 17 tests for I-09 device attribution (Groups E, F, G): device_local_secret, deriveDeviceId, migration, sync.js integration

### Active docs

| File | Use when... |
|---|---|
| `../spec/PHPSPEC.md` | Block structure, encryption, chain validation spec |
| `../planning/WEB_ROADMAP.md` | Web/mobile build log — completed steps, bugs found, test plans |
| `../../SESSION_HANDOFF.md` | Context restoration anchor — session-level snapshot |
| `../planning/LEDGER_MERGE_PYTHON_PORT.md` | 🔜 **ACTIVE** — TDD test spec for Python LedgerMerge port: 41 tests across 10 groups (A–J), helper inventory, 7-step algorithm reference |
| `../planning/ROADMAP.md` | Migration arc (CLI → Browser → Flutter) + feature roadmap |
| `../planning/BACKLOG.md` | Paused issues |
| `../planning/PUSHLEDGERBLOCKS_TDD_PLAN.md` | `pushLedgerBlocks()` TDD test plan — 31 tests across 7 categories (GREEN phase, 76 assertions) |
| `../planning/COMMIT_PUSH_WIRING_TESTS.md` | Commit→push wiring TDD test outline — 14 tests across 4 categories, execution plan (RED, not started) |
| `../planning/LEDGER_MERGE_PYTHON_PORT.md` | Porting `merge.js` → `merge.py` — 41+ test catalog, 7-step algorithm, wiring plan |
| `../planning/REAUTH_TTL_TDD_PLAN.md` | Re-auth overlay for TTL expiry TDD test plan — ~47 tests across 2 new files + 3 additions, 9 categories (A–I) (🔴 RED, tests not yet written) |
| `../planning/ALIGN_WEB_STAGING_SHARING_WITH_CLI.md` | 🔜 **ACTIVE** — Plan to align web staging sharing behavior with CLI multi-machine pattern: 5 phases, 9 files touched |
| `../planning/E2E_CROSS_CLIENT_BUGS.md` | ✅ **RESOLVED** — E2E cross-client test findings: 4 bugs fixed in Green phase (2026-07-01) |
| `../planning/ONBOARDING_UNLOCK_REAUTH_SPEEDUP_STRATEGY.md` | 🔜 **ACTIVE** — Hash-index genesis check strategy. 4-phase TDD. 210× speedup. (2026-06-30) |
| `../planning/STAGING_ACTIVITY_ID_IMPLEMENTATION_AND_EXECUTION_PLAN.md` | 🔜 **ACTIVE** — Stable `activity_id` + staging hash index plan. 4-phase TDD. (2026-07-07) |
| `../planning/STAGING_ACTIVITY_ID_TESTS.md` | 🔴 **NEW** — Phase 1 test catalog: 116 tests (A–J). Phase 2 RED pending. (2026-07-07) |
| `../planning/ROW_LEVEL_STAGING_SYNC_PLAN.md` | 🔜 **NEW** — Row-level staging sync plan: 8-scenario LWW resolution, sync cycle contract, Worker endpoints, migration. Companion to ADR-025. (2026-07-08) |
| `../planning/CLI_SQLITE_STAGING_PHASE1.md` | 🔜 **NEW** — Phase 1 test blueprint for CLI SQLite staging store: 104 assertions across 10 groups (A–J). |
| `../planning/CLI_COMMAND_TIMING_FIXES.md` | 🔜 **NEW** — `ph view` latency investigation: 4 fixes (F1–F4) with 4-phase TDD per fix. Target: 16→2–4 HTTP requests, 5–26s→1–4s. (2026-07-14) |
| `../planning/CLI_COMMAND_TIMING_F2_PHASE1.md` | 🔜 **NEW** — F2 Phase 1 blueprint: persistent cache for remote ledger blocks. 23 assertions across 6 groups (A–F). (2026-07-14) |
| `../VISION.md` | Protocol philosophy, use cases |
| `../design/DESIGN_GOALS.md` | Architectural mandates |
| `../design/SYSTEM_ARCHITECTURE.md` | 🟢 **NEW** — Comprehensive system architecture document: key hierarchy, chain, staging, transport, multi-device sync, cross-platform, crypto core, web, CLI, invariants |
| `../design/ARCHITECTURAL_DECISIONS.md` | ADR log (ADR-001 through ADR-026) |
| `../design/PH-VIEW-Workflow.md` | Auth gate workflow (moved to archive — superseded) |
| `../design/workflows/phpoc_cli/ph-view-workflow-updated.md` | Auth gate workflow (test scenarios) |
| `../design/workflows/phpoc_cli/onboarding-workflow.md` | CLI onboarding: remote + file import flows |
| `../design/workflows/phpoc_cli/CLI_Staging_Interaction-Workflow.md` | CLI staging interaction + multi-machine sharing via Worker/R2 |
| `../design/DESIGN_MULTI_DEVICE_SESSION.md` | Multi-device session architecture |
| `../design/workflows/web/Remote_Local-Workflow.md` | Compressed remote/local sync workflow (AI troubleshooting reference) |
| `../design/workflows/web/Local_Import-Export-Workflow.md` | File-based import/export workflow: v1/v2/raw-chain, two-phase validation, genesis gating |
| `../design/workflows/Cross_Device_Staging-Workflow.md` | Cross-device staging sharing: CLI ↔ Web via Worker/R2 — sync gate, merge engine, device cookie, genesis gate |
| `../design/TRANSPORT_RECONFIGURATION_ANALYSIS.md` | SyncService transport reconfiguration tradeoff analysis (Solutions A/B/C). 🔴 Decision pending. |
| `design/flaws/ISSUES_TO_ADDRESS.md` | 🔴 **ACTIVE** — 17 design flaws organized by severity (3 Critical, 5 High, 6 Medium, 3 Low), dependency graph, recommended attack order |
| `design/flaws/PHPSPEC-Design_Flaws.md` | Brutally honest assessment of 13 PHPSPEC design flaws — conflicts, weaknesses, negative aspects |
| `MAP.md` | This file — project map |

### Archive (`archive/` — retired docs kept for reference)

| File | What it was |
|---|---|
| `ARCHITECTURAL_MIGRATION_STRATEGY.md` | 7-phase refactoring plan (complete) |
| `PH-VIEW-Workflow.md` | Original auth gate workflow (superseded by updated version in ../design/) |
| `POSSIBLE_PROOF_OF_EXISTANCE.md` | External anchoring (speculative) |
| `verify_phase5.py` | Phase 5 one-time verification |
| `verify_phase6.py` | Phase 6 one-time verification |

---

## Architecture Invariants (NEVER break these)

1. **Zero external dependencies** — CLI reference implementation: zero external dependencies (pure Python stdlib only, no pip installs). Web/mobile: single shared Rust crypto core (`phpoc-crypto-core` / `ring`).
2. **Master Key** = 32 bytes from base64-decoded seed (`RecoveryManager.seed_to_key`)
3. **Staging format** = `NoAuthCryptoManager` uses `"plain:..."` prefix. Sync converts hex-encrypted → plain: at the boundary.
4. **Chain structure**: `Genesis → (Year Summary → Month Summary)* → Day blocks`, each sealed + signed
5. **Blind index** (`index.json`): `{date: {title: total_ms}}` — plaintext, queryable without decryption
6. **Content hash**: SHA-256 of resolved plaintext fields — survives re-encryption
7. **Config file**: XDG-resolved (`~/.config/phpoc/config.json` by default) — contains all settings as commented defaults
8. **Data directory**: XDG-resolved (`~/.local/share/phpoc/` by default) — holds ledger.json, staging.json, index.json, identity.json
9. **CLIInterface constructor**: `CLIInterface(staging_service, ledger_engine, crypto)` — no `self.ledger` references
10. **Device UUID suffix**: `{UUID4}-{client_type}` where client_type is `web` (browser) or `cli` (Python CLI). Bare UUID4 and WASM-derived UUIDs are migrated to this format on first read. This disambiguates same-machine clients and enables per-client identity for cross-device staging sync.
11. **Genesis mismatch typed errors**: `GenesisGate.check()` throws typed error instances (GenesisMismatchError, NetworkGenesisError, AuthGenesisError, InvalidChainError, InvalidGenesisError, InvalidFormatError). Catchers distinguish permanent genesis mismatch from transient transport/auth errors by checking `instanceof` rather than inspecting reason strings.
12. **Genesis seal excludes signature**: When computing `day_hash` for genesis blocks, the `signature` field is stripped from the block JSON before hashing. This matches the verification path which also excludes `signature`.

---

## Quick Refs

| Action | Command |
|---|---|
| Run CLI | `PYTHONPATH=. python3 main.py <command>` |
| Run all tests | `python3 -m pytest` |
| Run single test file | `python3 -m pytest tests/test_<name>.py -v` |
| Run single test | `python3 -m pytest tests/test_<name>.py::TestClass::test_method -v` |
| Run with warnings | `python3 -m pytest -W ignore::DeprecationWarning` |
| Test count | 1493 passing (Python), plus web test suites (38 test files, all GREEN) |
| Session cache | `/dev/shm/phpoc_session` (Master Key, chmod 600) |

### Config commands

| Command | Description |
|---|---|
| `phpoc config show` | Print full active config as JSON (user values merged with defaults) |
| `phpoc config get <key>` | Read one config value by dot path (e.g. `auth.cache_timeout_minutes`) |
| `phpoc config set <key> <val>` | Write one config value (value is JSON-parsed, falls back to string) |
| `phpoc config init` | Generate a fully-commented config template at the config path |
| `phpoc --config <path>` | Override config file path for this invocation |
| `phpoc --dir <path>` | Override data directory for this invocation (all commands) |

### Path resolution

| Priority | Variable / Path | Purpose |
|---|---|---|
| 1 (highest) | `phpoc --dir <path>` | CLI flag overrides everything for this one invocation |
| 2 | `$PHPOC_DATA_DIR` env var | Per-session override via environment |
| 3 | `storage.data_dir` in config.json | Persistent per-ledger setting (set via `phpoc config set storage.data_dir <path>`) |
| 4 | `$XDG_DATA_HOME/phpoc/` | XDG default (fallback: `~/.local/share/phpoc/`) |
| 5 (lowest) | `~/.config/personal_history_poc/` | Legacy fallback (auto-detected if new path doesn't exist) |

**Config file path** (separate from data dir, always independent):

| Priority | Variable / Path |
|---|---|
| 1 (highest) | `phpoc --config <path>` |
| 2 | `$PHPOC_CONFIG` env var |
| 3 | `$XDG_CONFIG_HOME/phpoc/config.json` (fallback: `~/.config/phpoc/`) |
