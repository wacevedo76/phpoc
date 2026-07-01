# PHPOC — Project Map

## File Inventory
Each file annotated **[HOT]** (active dev area — re-read if in scope)
or **[COLD]** (stable — skip unless handoff says otherwise).

### Source (core Python packages)

| File | Temp | Key contents |
|---|---|---|
| `main.py` | HOT | CLI entry — argparse, auth tiers, staging + orchestrator wiring |
| `cli/interface.py` | HOT | Display: `view_active`, `show_rep`, `list_habits` |
| `cli/strategies.py` | COLD | `InteractiveCLIStrategy` — sync confirmation UI |
| `cli/background.py` | COLD | Phase A instant reads, background sync check |
| `cli/daemon.py` | COLD | `PhDaemon` lifecycle |
| `cli/wal.py` | COLD | Write-ahead log, background push |
| `cli/onboarding.py` | HOT | `run_onboarding()` (unified pipeline), `run_onboarding_picker()` (interactive provider picker) — transport-agnostic import |
| `cli/onboarding_file.py` | HOT | `run_onboarding_file()` — local JSON file import (v1/v2/chain) |
| `cli/transport_cmd.py` | COLD | `ph transport` subcommand |
| `core/sync/orchestrator.py` | HOT | `SyncOrchestrator` — sync lifecycle coordinator + same-genesis merge via `LedgerMerge.merge()` |
| `core/sync/http_transport.py` | COLD | `HttpStagingTransport` — HTTP GET/PUT/LIST + ETag |
| `core/sync/git_transport.py` | COLD | `GitStagingTransport` |
| `core/sync/transport_registry.py` | HOT | `TransportProvider` dataclass, `TransportRegistry` — extensible transport discovery for onboarding |
| `security/crypto.py` | HOT | `CryptoManager`, `NoAuthCryptoManager` |
| `security/auth.py` | COLD | Passphrase + Recovery authenticators |
| `security/device_identity.py` | HOT | `DeviceIdentity`, `AbstractDeviceIdentityProvider`. Bug 3a: `-cli` suffix, migration for bare UUIDs. |
| `domain/ledger/chain.py` | HOT | Chain building, sealing, verification |
| `domain/ledger/remote_sync.py` | HOT | `RemoteLedgerSync` — push/pull ledger blocks + `pull_full_chain()` + `pull_block_by_index()` |
| `domain/ledger/merge.py` | HOT | `LedgerMerge` — merge divergent chains sharing genesis (GREEN phase — 47 tests all pass) |
| `domain/staging/service.py` | HOT | `StagingService` — auth gate, `check_and_sync()`, push |
| `domain/staging/remote_sync.py` | COLD | Blob obfuscation, pull/push, device cookie |
| `domain/staging/merge_engine.py` | COLD | Cross-device merge, dedup by `entry_id` |
| `domain/cookie/device_cookie.py` | COLD | Random-specifier device cookie |
| `worker/src/index.ts` | COLD | Cloudflare Worker (149 lines, dumb blob store) |

### Web/Mobile (phpoc-web)

| File | Temp | Key contents |
|---|---|---|
| `phpoc-web/src/sync/genesis_gate.js` | 🟢 GREEN | GenesisGate.check() — Bug 1: 6 typed error classes, throw-based API, tampered-seal detection. Uses shared `base64.js` + `keys.js` (2026-07-01 Green phase) |
| `phpoc-web/test/genesis_gate_test.mjs` | 🟢 GREEN | 129-test suite for genesis gate — Groups A-C (100+) + Group D typed error hierarchy (6, Bug 1) + tampered-seal groups (2026-07-01) |
| `phpoc-web/test/local_cache_test.mjs` | 🟢 GREEN | 58-test suite for staging entry format canonicalization (Bug 3b fix, GREEN phase) |
| `phpoc-web/test/device_uuid_test.mjs` | 🟢 GREEN | 36-test suite — Groups 1-8 (original) + Groups 9-12 client suffix tests (Bug 3a fix) |
| `phpoc-web/test/settings_genesis_test.mjs` | 🟢 GREEN | 13-test Settings UI genesis gate integration (updated for Bug 1 throw API) |
| `phpoc-web/test/sync_service_test.mjs` | 🟢 GREEN | 190 tests — Groups A-R: all GREEN. Bug 1 (Group R), Bug 2 (Group P), Bug 3a (Group Q). |
| `phpoc-web/test/worker_connect_onboarding_test.mjs` | HOT | 65 tests — Worker Connect onboarding (fetch genesis, passphrase verify, persistence) |
| `phpoc-web/test/worker_connect_blocks_format.test.mjs` | 🟢 GREEN | **NEW** — 56 tests: Group A blocks-format onboarding (7 scenarios, stale `ledger:blocks` delete) + Group B bootstrap auto-clear recovery (5 scenarios) (2026-06-29) |
| `phpoc-web/test/onboarding_import_component.test.mjs` | 🟢 GREEN | **NEW** — 21 Vitest+RTL component tests for OnboardingScreen import form state machine (file picker gating, destroy warnings, checkbox gates, error display, back navigation) |
| `phpoc-web/test/onboarding_cloud_conflict.test.mjs` | 🟢 GREEN | **NEW** — 23 tests: Phase 3 deferred — cloud onboarding dual-format conflict detection (`probeDualFormats()`) (2026-06-29) |
| `phpoc-web/src/sync/remote_import.js` | HOT | `WorkerImportSource` — cloud backup import source (list, fetch, validate). 57-test suite. (2026-06-20) |
| `phpoc-web/test/remote_import_test.mjs` | HOT | 57 assertions — 6 groups (connection, list, fetch, validate happy/error, edge cases) |
| `phpoc-web/src/components/screens/OnboardingScreen.jsx` | HOT | 5 onboarding paths including "From Cloud" import sub-option (2026-06-20) |
| `phpoc-web/src/crypto/index.js` | HOT | `CryptoService` — singleton WASM wrapper (20 exports), master key cache, ready guards. Imports from `./wasm/` (bundled by Vite, not external). |
| `phpoc-web/src/crypto/wasm/phpoc_crypto_core.js` | HOT | WASM glue JS — copied from `phpoc-crypto-core/pkg/` for Vite bundling. |
| `phpoc-web/src/crypto/wasm/phpoc_crypto_core_bg.wasm` | HOT | WASM binary — 134KB, content-hashed in production build. |
| `phpoc-web/src/context/DevModeContext.jsx` | HOT | `connectToWorker()` + `importFromCloud()` + `effectiveServices` Proxy (auto-sync) + `ttlWarning` banner state + `handleTtlExpiry` (auto-logout on cookie expiry). Reauth overlay removed (2026-06-28). |
| `phpoc-web/src/ledger/utils.js` | HOT | `jsonSort()` — Python-compatible JSON serialization (2026-06-20) |
| `phpoc-web/test/utils_test.mjs` | HOT | 27 tests — validates jsonSort() matches Python output |
| `phpoc-web/src/hooks/useAutoSync.js` | HOT | Auto-sync hook — `createAutoSync()` + `useAutoSync()` React hook (GREEN, 58 assertions, 0 failures) |
| `phpoc-web/test/auto_sync_hook_test.mjs` | HOT | 24-assertion test suite for auto-sync hook (all GREEN) |
| `phpoc-web/test/ledger_sync_test.mjs` | 🟢 GREEN | 31-test TDD suite for `pushLedgerBlocks()` — GREEN phase complete, 76 assertions all passing |
| `phpoc-web/test/commit_push_integration_test.mjs` | 🟢 GREEN | 14-test Commit→Push Wiring suite — all 60 assertions pass (wiring complete) |
| `phpoc-web/test/cross_client_web_test.mjs` | 🟢 GREEN | 78 tests: auth gate (5), reconcile merge (15), full round-trip (15), auth timing (6), pause/unpause lifecycle across devices (37). Updated for Bug 3a/3b format changes (2026-07-01) |
| `phpoc-web/test/sync_indicator_test.mjs` | 🟢 GREEN | 32-test SyncIndicator unit test — status config, 6 status mappings, compact mode, fallback |
| `phpoc-web/test/display_status_test.mjs` | 🟢 GREEN | 20-test `computeDisplayStatus()` unit test — SYNCING priority, NOT_SYNCED, READY passthrough, edge cases |
| `phpoc-web/test/reauth_ttl_test.mjs` | 🟢 GREEN | 50-test (was 35) suite for `checkCookieTtl()` + `createCookieMonitor()` — all 50 pass (GREEN phase complete) |
| `phpoc-web/test/reauth_integration_test.mjs` | 🟢 GREEN | 40-test suite for full re-auth flow integration — 39 pass / 1 test-only MK mismatch (mock sha256≠PBKDF2) |
| `phpoc-web/test/ledger_import_chain_test.mjs` | 🟢 GREEN | **NEW** — 31 tests for raw chain import path (genesis detection, block seals, prev_hash linkage, entry hash validation, mixed block types) |
| `phpoc-web/test/ledger_import_v2_test.mjs` | 🟢 GREEN | **NEW** — 42 tests for v2 format import path (genesis hash extraction, ledger+staging preservation, empty edge cases) |
| `phpoc-web/test/import_orchestration_test.mjs` | 🟢 GREEN | **NEW** — 51 tests for two-phase validate→confirm orchestration (in-memory storage, genesis gating, staging merge dedup, identity persistence) |
| `phpoc-web/test/ledger_roundtrip_test.mjs` | 🟢 GREEN | **NEW** — 46 tests for full export→import fidelity (v1, v2, active/paused entries, deterministic seal, wrong key rejection) |
| `phpoc-web/src/hooks/useCookieMonitor.js` | HOT | `checkCookieTtl()` + `createCookieMonitor()` — proactive cookie TTL polling + MK clearing + `onWarning` callback (pre-expiry), wired into DevModeContext (2026-06-28) |
| `phpoc-web/src/sync/display_status.js` | HOT | `computeDisplayStatus()` pure function + STATUS_* constants extracted from SyncSettings.jsx |
| `phpoc-web/src/sync/base64.js` | HOT | **NEW** — shared `base64ToBytes`/`bytesToBase64` utilities, used by sync.js, remote_sync.js, genesis_gate.js (2026-06-30) |
| `phpoc-web/src/sync/keys.js` | HOT | **NEW** — canonical path constants (7 keys: remote staging/cookie/ledger, local cookie/blocks/index), single source of truth (2026-06-30) |
| `phpoc-web/src/sync/entry_dto.js` | 🟢 GREEN | DTO conversion: `rawCommittedEntryToDTO`, `rawEntryToDTO`, `parsePlainInt`, `parsePlainJSON`. Bug 3b: handles `device_uuid_enc` field. (2026-07-01) |
| `phpoc-web/src/sync/remote_sync.js` | 🟢 GREEN | `RemoteSync` — blob pull/push, cookie pull/push via transport. Bug 3b: pushBlob converts DTOs to raw spec format. Uses shared `base64.js` + `keys.js`. |
| `phpoc-web/src/sync/cookie.js` | COLD | `DeviceCookie` — TTL fallback bug fixed (nullish coalescing), stale header updated, uses `COOKIE_KEY` constant. |
| `phpoc-web/src/sync/sync.js` | 🟢 GREEN | Core sync orchestrator. Bug 1: _genesisGatePhase catches typed errors. Bug 2: pushLedgerBlocks position counter. Bug 3a: _fastPathPhase relaxed, same-device fast path removed. Bug 3b: reconcile via writeEntries DTO→raw. (2026-07-01 Green phase) |
| `phpoc-web/src/components/screens/SyncSettings.jsx` | HOT | Sync UI — status display (`computeDisplayStatus` + `isAutoSyncing`), commit flow. Reauth overlay refs removed (2026-06-28). |
| `phpoc-web/test/settings_genesis_component.test.mjs` | 🟢 GREEN | 26-test Vitest + RTL component test suite for Settings genesis gate (B: 20, E: 6, F: 4). All 26 pass (accessibility attributes added). |
| `phpoc-web/src/App.jsx` | HOT | Re-auth overlay replaced with TTL warning banner + `ErrorBoundary` class component (2026-06-28) |

*(See full file listing in MAP.md — this is a quick-reference summary.)*

**Test files:** phpoc-web has 38 test files (~2,200 total tests across all suites). All GREEN (0 failures).

### Tests (39 files, ~22,000 lines, ~1929 tests)

Key test files:
- `tests/test_ledger_merge.py` — 47 tests for `LedgerMerge.merge()` — TDD GREEN phase (47 PASS, 0 FAIL)
- `tests/test_staging_sync_optimization.py` — 85 tests, auth gate, cross-device, merge
- `tests/test_http_transport.py` — 68 tests, HTTP + ETag
- `tests/test_wal.py` — WAL lifecycle
- `tests/test_phase4_staging_interaction_flow.py` — 69 tests, sync lifecycle
- `tests/test_onboarding_e2e.py` — 76 E2E tests (all GREEN), Phase 5d: 44 pipeline tests + 14 registry-integration + 8 picker UI + 10 real-transport E2E
- `tests/test_phase5_main_wiring.py` — 72 tests, sync/onboarding CLI dispatch + argparse routing
- `tests/test_transport_registry.py` — 50 tests (all GREEN), TransportProvider + TransportRegistry unit tests
- `tests/conftest.py` — `TransportSpy`, cookie helpers, staging blob factories

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
| `../VISION.md` | Protocol philosophy, use cases |
| `../design/DESIGN_GOALS.md` | Architectural mandates |
| `../design/ARCHITECTURAL_DECISIONS.md` | ADR log (ADR-001 through ADR-020) |
| `../design/PH-VIEW-Workflow.md` | Auth gate workflow (moved to archive — superseded) |
| `../design/workflows/cli/ph-view-workflow-updated.md` | Auth gate workflow (test scenarios) |
| `../design/workflows/cli/onboarding-workflow.md` | CLI onboarding: remote + file import flows |
| `../design/workflows/cli/CLI_Staging_Interaction-Workflow.md` | CLI staging interaction + multi-machine sharing via Worker/R2 |
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

1. **Zero external dependencies** — pure Python stdlib only. No pip installs.
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
