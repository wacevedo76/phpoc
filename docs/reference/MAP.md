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
| `cli/onboarding.py` | HOT | `run_onboarding()` — remote transport import |
| `cli/onboarding_file.py` | HOT | `run_onboarding_file()` — local JSON file import (v1/v2/chain) |
| `cli/transport_cmd.py` | COLD | `ph transport` subcommand |
| `core/sync/orchestrator.py` | COLD | `SyncOrchestrator` — sync lifecycle coordinator |
| `core/sync/http_transport.py` | COLD | `HttpStagingTransport` — HTTP GET/PUT/LIST + ETag |
| `core/sync/git_transport.py` | COLD | `GitStagingTransport` |
| `security/crypto.py` | HOT | `CryptoManager`, `NoAuthCryptoManager` |
| `security/auth.py` | COLD | Passphrase + Recovery authenticators |
| `security/device_identity.py` | COLD | `DeviceIdentity`, `AbstractDeviceIdentityProvider` |
| `domain/ledger/chain.py` | HOT | Chain building, sealing, verification, `RemoteLedgerSync` |
| `domain/staging/service.py` | HOT | `StagingService` — auth gate, `check_and_sync()`, push |
| `domain/staging/remote_sync.py` | COLD | Blob obfuscation, pull/push, device cookie |
| `domain/staging/merge_engine.py` | COLD | Cross-device merge, dedup by `entry_id` |
| `domain/cookie/device_cookie.py` | COLD | Random-specifier device cookie |
| `worker/src/index.ts` | COLD | Cloudflare Worker (149 lines, dumb blob store) |

### Web/Mobile (phpoc-web)

| File | Temp | Key contents |
|---|---|---|
| `phpoc-web/src/sync/genesis_gate.js` | HOT | GenesisGate.check() — genesis compatibility gate (GREEN, 89 tests) |
| `phpoc-web/test/genesis_gate_test.mjs` | HOT | 20-test suite for genesis gate (all GREEN) |
| `phpoc-web/test/settings_genesis_test.mjs` | HOT | 13-test Settings UI genesis gate integration |
| `phpoc-web/test/sync_service_test.mjs` | HOT | 45 tests (SyncService auth gate + 3 new genesis gate integration tests) |
| `phpoc-web/test/worker_connect_onboarding_test.mjs` | HOT | 65 tests — Worker Connect onboarding (fetch genesis, passphrase verify, persistence) |
| `phpoc-web/src/sync/remote_import.js` | HOT | `WorkerImportSource` — cloud backup import source (list, fetch, validate). 57-test suite. (2026-06-20) |
| `phpoc-web/test/remote_import_test.mjs` | HOT | 57 assertions — 6 groups (connection, list, fetch, validate happy/error, edge cases) |
| `phpoc-web/src/components/screens/OnboardingScreen.jsx` | HOT | 5 onboarding paths including "From Cloud" import sub-option (2026-06-20) |
| `phpoc-web/src/context/DevModeContext.jsx` | HOT | `connectToWorker()` + `importFromCloud()` + `effectiveServices` Proxy (auto-sync) + `handleReauth` (reauth overlay). |
| `phpoc-web/src/ledger/utils.js` | HOT | `jsonSort()` — Python-compatible JSON serialization (2026-06-20) |
| `phpoc-web/test/utils_test.mjs` | HOT | 27 tests — validates jsonSort() matches Python output |
| `phpoc-web/src/hooks/useAutoSync.js` | HOT | Auto-sync hook — `createAutoSync()` + `useAutoSync()` React hook (GREEN, 58 assertions, 0 failures) |
| `phpoc-web/test/auto_sync_hook_test.mjs` | HOT | 24-assertion test suite for auto-sync hook (all GREEN) |
| `phpoc-web/src/sync/sync.js` | HOT | `checkAndSync()` auth gate + `_reconcileAndClaim` — cookie management, staging blob push |
| `phpoc-web/src/components/screens/SyncSettings.jsx` | HOT | Sync UI — status display, reauth overlay triggering, commit flow. |
| `phpoc-web/src/App.jsx` | HOT | Re-auth overlay rendering (`AuthScreen overlay`) via context `reauthActive` state. |

*(See full file listing in MAP.md — this is a quick-reference summary.)*

### Tests (30 files, ~13,000 lines, 1341 tests)

Key test files:
- `tests/test_staging_sync_optimization.py` — 85 tests, auth gate, cross-device, merge
- `tests/test_http_transport.py` — 68 tests, HTTP + ETag
- `tests/test_wal.py` — WAL lifecycle
- `tests/test_phase4_staging_interaction_flow.py` — 69 tests, sync lifecycle
- `tests/conftest.py` — `TransportSpy`, cookie helpers, staging blob factories

### Active docs

| File | Use when... |
|---|---|
| `../spec/PHPSPEC.md` | Block structure, encryption, chain validation spec |
| `../planning/WEB_ROADMAP.md` | Web/mobile build log — completed steps, bugs found, test plans |
| `../../SESSION_HANDOFF.md` | Context restoration anchor — session-level snapshot |
| `../planning/ROADMAP.md` | Migration arc (CLI → Browser → Flutter) + feature roadmap |
| `../planning/BACKLOG.md` | Paused issues |
| `../VISION.md` | Protocol philosophy, use cases |
| `../design/DESIGN_GOALS.md` | Architectural mandates |
| `../design/ARCHITECTURAL_DECISIONS.md` | ADR log (ADR-001 through ADR-020) |
| `../design/PH-VIEW-Workflow.md` | Auth gate workflow (moved to archive — superseded) |
| `../design/workflows/cli/ph-view-workflow-updated.md` | Auth gate workflow (test scenarios) |
| `../design/DESIGN_MULTI_DEVICE_SESSION.md` | Multi-device session architecture |
| `../design/workflows/web/Remote_Local-Workflow.md` | Compressed remote/local sync workflow (AI troubleshooting reference) |
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

---

## Quick Refs

| Action | Command |
|---|---|
| Run CLI | `PYTHONPATH=. python3 main.py <command>` |
| Run all tests | `python3 -m pytest` |
| Run single test file | `python3 -m pytest tests/test_<name>.py -v` |
| Run single test | `python3 -m pytest tests/test_<name>.py::TestClass::test_method -v` |
| Run with warnings | `python3 -m pytest -W ignore::DeprecationWarning` |
| Test count | 1341 passing |
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
