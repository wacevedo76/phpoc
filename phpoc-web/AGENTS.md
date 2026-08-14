# PH Ledger React Web Application

## Purpose
React-based web frontend for the PH Ledger — user interface for task tracking, ledger visualization, sync management, onboarding, and authentication. Runs entirely in the browser with IndexedDB storage and WASM cryptography.

## Ownership
- `src/App.jsx` — Application root
- `src/components/screens/` — Screen components: Auth, Configuration, Dashboard, History, Landing, LedgerSync, NewTask, Onboarding, Settings, SyncSettings, Tags, UserProfile
- `src/components/modals/` — Modal components: PassphraseModal
- `src/components/layout/` — Layout component: AppLayout
- `src/components/pills/` — ActiveTaskPill
- `src/components/sync/` — SyncIndicator
- `src/components/ui/` — Icon components
- `src/ledger/` — Ledger logic ported from Python: chain, engine, index_manager, merge, summary_policy, utils, **seal_fields** (`SEAL_FIELDS`/`selectSealFields`/`computeSeal` — canonical ADR-029/029a block-seal whitelist, mirror of Python `chain.py`)
- `src/sync/` — Sync logic ported: cookie, device_uuid, http_backend, indexeddb_storage, local_cache, merge_engine, remote_sync, storage, storage_plugin, sync, transport, plugin_factory, row_staging_store, row_sync, migration
- `src/services/` — DummyLedger, MockDataSeeder, ledger_export, ledger_import
- `src/crypto/` — Crypto bridge to WASM (phpoc-crypto-core); `wasm/` subdirectory contains bundled artifacts from `phpoc-crypto-core/pkg/`
- `src/context/` — DevModeContext (dev and production share the same boot path; no mock services or DummyCryptoService fallbacks remain)
- `src/hooks/` — useActiveTasks, useAutoSync, useCookieMonitor
- `test/` — JavaScript test suite (79 test files)

## Local Contracts
- Built with Vite + React
- Uses IndexedDB for local storage (IndexedDBStoragePlugin)
- Crypto operations bridge to Rust WASM (`phpoc-crypto-core`)
- HTTP backend for remote sync (`HttpBackend`)
- Must maintain behavioral parity with Python reference implementation
- Device UUID and cookie management for cross-device session detection

## Work Guidance
- Component hierarchy: screens use modals + layout; layout wraps screens
- Sync flow follows same pattern as Python: check_and_sync → merge → push
- WASM crypto module loaded asynchronously
- Use context for dev mode state; hooks for derived data

## Verification
- `test/` directory: 37 test files covering crypto, sync, ledger, storage, import/export, transport, and component rendering
- New (Jun 2026): `ledger_import_chain_test.mjs` (31), `ledger_import_v2_test.mjs` (42), `import_orchestration_test.mjs` (51), `ledger_roundtrip_test.mjs` (46) — 170 tests for web import/export workflow coverage
- **CCS-2 (Jul 2026):** `ccs2_row_level_reconcile_test.mjs` — 41/41 GREEN — canonical-row (activity_id LWW) reconcile layer in `sync.js` (Option B). Blueprint: `docs/planning/CCS2_PHASE1.md`
- **Chain seal whitelist (ADR-029/029a, Web):** `chain_seal_whitelist_test.mjs` — 27 assertions (groups A–E) targeting convergence of Web seamers/verifiers (`chain.js`, `merge.js`, `summary_policy.js`) onto the closed `SEAL_FIELDS` whitelist. **GREEN 28/28 — Phases 1–4 complete.** P4 deduped the leftover open-set `checkData` builders in `sync.js`/`genesis_gate.js` through the shared whitelist; confirmed no `format_version`/`key_version` sealing. `export_auth.js`/`ledger_import.js`/`remote_import.js`/`DevModeContext.jsx` intentionally kept legacy-open-set tolerant (backward-compat multi-format verify). Blueprint: `docs/planning/CANONICAL_SEALFIELD_WEB_PHASE1.md`
- **ADR-030 ledger-aware ownership-handoff (Web):** `web_ledger_auto_pull_test.mjs` — 17 assertions across groups W1 (ledger pull on handoff), W2 (Scenario-5/6 uncommitted-sealed-row drop), W3 (Web `_ledgerActivityIds()` derivation). **GREEN 17/17 — 4-Phase TDD complete (Phases 1–4).** `sync.js`: `_pullLedgerOnHandoff()` (block-count-gated, fail-safe) wired into `_reconcileAndClaim()`; `_ledgerActivityIds()`; Scenario-5/6 drop in `_mergeRemoteIntoLocal` via pure `SyncService._dropSealedUncommitted` (mirrors Flutter `MergeEngine.dropLedgerCommitted`); merge awaited before push. Blueprint: `docs/planning/WEB_LEDGER_AUTO_PULL_PHASE1.md`
- **connectToWorker full-chain fix (2026-08-21):** `worker_connect_fullchain_regression.test.mjs` — 23/23 GREEN. Locks in that `connectToWorker` fetches the FULL remote `ledger/blocks/` chain into `ledger:blocks` (so committed history loads), keeps only genuinely-uncommitted staging rows uncommitted (no D11 auto-commit), converts them via `canonicalRowToDTO` + `LocalCache.writeEntries` so the Sync cards render full fields (no blank cards), and never promotes staging into the ledger. Fixes the `588b034` "staging-based connectToWorker" regression.
- Node-based tests: `node test/<name>.mjs`
- Vitest component tests: `npx vitest run test/settings_genesis_component.test.mjs`
- Smoke tests for WASM integration
- Remote Worker testing credentials: `TEST_CREDENTIALS.md` at repo root (gitignored)

## Child DOX Index
None — flat source structure under `src/`.
