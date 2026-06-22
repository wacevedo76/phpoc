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
- `src/ledger/` — Ledger logic ported from Python: chain, engine, index_manager, merge, summary_policy, utils
- `src/sync/` — Sync logic ported: cookie, device_uuid, http_backend, indexeddb_storage, local_cache, merge_engine, remote_sync, storage, storage_plugin, sync, transport, plugin_factory
- `src/services/` — DummyLedger, MockDataSeeder, ledger_export, ledger_import
- `src/crypto/` — Crypto bridge to WASM (phpoc-crypto-core)
- `src/context/` — DevModeContext
- `src/hooks/` — useActiveTasks, useAutoSync, useCookieMonitor
- `test/` — JavaScript test suite (32 test files)

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
- `test/` directory: 30 test files covering crypto, sync, ledger, storage, and transport
- New RED: `reauth_ttl_test.mjs` (35 tests), `reauth_integration_test.mjs` (27 tests) — Re-auth TTL overlay tests
- Run with: `npm test` (vitest)
- Node-based tests: `node --experimental-vm-modules test/<name>.mjs`
- Smoke tests for WASM integration

## Child DOX Index
None — flat source structure under `src/`.
