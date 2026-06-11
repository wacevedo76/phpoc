# PH Ledger — Session Handoff

## Current State
- **Branch:** `mobile-poc` (Rust crypto core complete, WASM bindings done, Worker CORS added, HttpBackend complete)
- **CLI:** Maintenance mode — 1341 tests, fully functional, not actively worked on
- **Transport:** HTTP → Cloudflare Worker → R2 (staging blob + ledger blocks + index)
- **Storage decision (ledger):** Option B — direct `StorageBackend` consumption with key convention `ledger:blocks` (array) / `ledger:index` (JSON). No adapter layer.
- **Auth gate:** Cookie-only fast path. Full implementation in `src/sync/sync.js` (60 tests). Documented in `docs/design/DESIGN_MULTI_DEVICE_SESSION.md`.
- **Architecture:** Multi-deployment via `StorageBackend` interface — standalone PWA (IndexedDB), self-hosted LAN/Docker (bridge server), SaaS (Worker→R2). Full details in `PHPOC-REACT_WEB-DESIGN_DECISIONS.md` §11.
- **Onboarding:** New phase-based lifecycle system with Landing, Onboarding, Auth, and Ready phases. Production mode collects **username** and **email** (per PHPSPEC §4.1) alongside passphrase, creates a PHPSPEC-compliant genesis block with encrypted recovery seed, encrypted identity secret, HMAC seal, and identity signature. Dev mode preserved for backward compat via `?dev=true`.

### Web Platform — Completed Steps

| Step | What | Status | Tests |
|------|------|--------|-------|
| 1 | `HttpTransport` — fetch()-based HTTP with ETag caching | ✅ | 49 |
| 2 | Sync algorithm port — `checkAndSync()`, auth gate, staging CRUD, merge engine | ✅ | 60 |
| 3 | React Web UI — Vite + React 18, 9 screens, dev mode, auth overlay | ✅ | — |
| 4 | `StorageBackend` + `HttpBackend` — interface + Transport→StorageBackend adapter | ✅ | 41 |
| 5 | Browser import/export via File API | ✅ | 83 |
| 6 | **Ledger Engine JS Port + Refactoring** — Chain, Index, Summary, Engine | ✅ | 266 |
| 7 | **Onboarding Workflow** — Landing screen, onboarding wizard (Import/New/Export), phase-based lifecycle, IndexedDB seed storage, passphrase auth with PBKDF2, identity fields (username + email), PHPSPEC-compliant genesis block creation with encrypted seed + identity secret + seal + signature | ✅ | — |
| 8 | Staging CRUD in UI | 🔜 | — |
| 9 | Companion bridge server (Python) | 🔜 | — |
| 10 | Docker + multi-tenant Worker | 🔜 | — |

### Ledger Engine — Step 6 Detailed Status

Four modules all green. Completed a 3-phase code review refactoring (2026-06-11) resolving 16 findings:

| Module | File | Tests | Purpose |
|--------|------|-------|---------|
| `LedgerChain` | `src/ledger/chain.js` | 70 | Block ops, seal/sign, build/append/truncate, chain + single-block verification |
| `IndexManager` | `src/ledger/index_manager.js` | 36 | Blind index, query, update, clear, reload, rebuild |
| `SummaryPolicy` | `src/ledger/summary_policy.js` | 49 | YearMonth, YearOnly, NoSummary boundary detection |
| `LedgerEngine` | `src/ledger/engine.js` | 111 | Commit (encrypt, group, summaries), verify, revert, queryIndex |

**Shared infrastructure:**
- `src/ledger/utils.js` — `sortKeys`, `jsonSort`, `computeEntryHash`, `getBlockHash`
- `test/mock_crypto.mjs` — `MockCrypto` + `deterministicHash`
- `test/test_helpers.mjs` — `TestHelpers` class with all assertion methods

**Refactoring summary (3 phases, all complete):**

| Phase | Area | Findings | Key Deliverables |
|-------|------|----------|-----------------|
| 1 | Modularity | 5 | `utils.js`, `mock_crypto.mjs`, `test_helpers.mjs` extracted. `_encryptEntry()`/`_groupByDate()` split. ~100 LOC net reduction. |
| 2 | Clarity | 6 | Sync `buildDayBlock()` removed. No `_blockCache`. `_flush()`/`reload()` properly async. `revert()` persists to staging. Array sort uses `localeCompare`. +7 tests. |
| 3 | Security | 5 | Decrypt errors propagate (no silent fallthrough). `verifyBlock(0)` delegates to `_verifyBlockData`. Missing signature = failure. `reload()` uses StorageBackend interface. Input validation in `commit()`. +10 tests, 3 mutation fixes. |

**Total: 266 assertions across 4 suites, 0 failures. Zero regressions in 787 total web tests.**

## Key Files

### Web Platform (active development)
| File | Purpose |
|------|---------|
| `phpoc-web/src/ledger/engine.js` | `LedgerEngine` — commit, verify, revert, queryIndex |
| `phpoc-web/src/ledger/chain.js` | `LedgerChain` — block ops, seal/sign, verification |
| `phpoc-web/src/ledger/index_manager.js` | `IndexManager` — blind index CRUD |
| `phpoc-web/src/ledger/summary_policy.js` | Summary policies (YearMonth, YearOnly, NoSummary) |
| `phpoc-web/src/ledger/utils.js` | Shared utilities: `sortKeys`, `jsonSort`, `computeEntryHash`, `getBlockHash` |
| `phpoc-web/src/sync/sync.js` | `SyncService` — full `checkAndSync()` auth gate, staging CRUD |
| `phpoc-web/src/sync/transport.js` | `HttpTransport` — fetch()-based HTTP with ETag caching |
| `phpoc-web/src/sync/http_backend.js` | `HttpBackend` — Transport→StorageBackend adapter |
| `phpoc-web/src/sync/storage.js` | `StorageBackend` interface + `MemoryBackend` |
| `phpoc-web/src/sync/indexeddb_storage.js` | `IndexedDBBackend` via idb-keyval |
| `phpoc-web/src/crypto/index.js` | `CryptoService` — singleton WASM wrapper, 20 functions |
| `phpoc-web/src/services/ledger_export.js` | `exportLedger()` — entries → signed JSON Blob |
| `phpoc-web/src/services/ledger_import.js` | `importLedger()` — file → verified entries |
| `phpoc-web/src/App.jsx` | Root — phase-based routing, DevModeProvider → lifecycle phases |
| `phpoc-web/src/context/DevModeContext.jsx` | Phase-based lifecycle: boot → landing → onboarding → auth → ready |
| `phpoc-web/src/components/screens/LandingScreen.jsx` | Landing screen — detects IndexedDB data, Login vs Onboarding choices |
| `phpoc-web/src/components/screens/OnboardingScreen.jsx` | Onboarding wizard — Import / New Ledger / Export flows. New ledger form includes Username + Email fields. |
| `phpoc-web/src/components/screens/AuthScreen.jsx` | Passphrase entry — async PBKDF2, spinner, error handling |
| `phpoc-web/src/ledger/chain.js` | `LedgerChain.buildGenesisBlock()` — builds PHPSPEC §4.1 genesis block with identity, encrypted seed/secrets, seal, and signature |
| `phpoc-web/src/ledger/engine.js` | `LedgerEngine.init()` — orchestrates genesis block creation + append during onboarding |
| `phpoc-web/src/context/DevModeContext.jsx` | `createNewLedger()` now accepts username + email, creates genesis block via `engine.init()` |
| `phpoc-web/src/components/screens/UserProfile.jsx` | Shows `user.username` as display name and `user.email` underneath |
| `phpoc-web/src/components/screens/Settings.jsx` | Settings — Data Management section with Import/Export |
| `phpoc-web/test/*.mjs` | Test suites — ledger (4 suites), sync, transport, import/export, etc. |

### Cross-Platform (reference)
| File | Purpose |
|------|---------|
| `worker/src/index.ts` | Cloudflare Worker (~200 lines) — GET/PUT/DELETE/LIST + CORS, dumb blob store |
| `phpoc-crypto-core/` | Rust crate — all crypto primitives, compiled to WASM |
| `core/sync/http_transport.py` | CLI reference: HTTP GET/PUT/LIST + ETag (wire protocol spec) |
| `domain/staging/service.py` | CLI reference: `check_and_sync()` — auth gate algorithm |

### Documentation
| File | Purpose |
|------|---------|
| `SESSION_HANDOFF.md` | This file — current state, key files, next steps |
| `MOBILE_ROADMAP.md` | Mobile app roadmap (iOS/Android/Web) |
| `PHPSPEC.md` | Format spec — crypto, block structure, key derivation |
| `PHPOC-REACT_WEB-DESIGN_DECISIONS.md` | React web UI design decisions + multi-deployment architecture |
| `MAP.md` | File inventory with HOT/COLD annotations |
| `docs/design/CROSS_PLATFORM_ARCHITECTURAL_DECISIONS.md` | Rust crypto core rationale |
| `docs/design/DESIGN_MULTI_DEVICE_SESSION.md` | Device cookie, auth gate, cross-device reconciliation |
| `VISION.md` | Project vision — "know thyself," zero-knowledge |

## Context Loading Reference (`/new`)

When starting a fresh context, load these in order:

1. `SESSION_HANDOFF.md` — this file
2. `PHPSPEC.md` — format spec
3. `docs/design/CROSS_PLATFORM_ARCHITECTURAL_DECISIONS.md` — architecture rationale
4. `MOBILE_ROADMAP.md` — phased plan
5. `PHPOC-REACT_WEB-DESIGN_DECISIONS.md` — web UI + deployment architecture
6. `VISION.md` — project vision

Also relevant: `MAP.md` (file inventory), `ROADMAP.md`, `BACKLOG.md`, `CHANGELOG.md`.

## Next Steps

### 1. Wire Device Cookie TTL to Re-auth Overlay

The re-auth overlay (`reauthOverlay` state in `App.jsx`) exists but isn't triggered yet. Need to:
- Check `DeviceCookie.isValidLocally()` on app resume / periodic interval
- Pop the `AuthScreen` overlay when TTL expires (30 min default)
- Call `login(passphrase)` on re-auth, which re-derives master key and touches cookie

### 2. Show Recovery Seed After New Ledger Creation

Currently the seed is silently stored. The user has no way to back it up. After "Begin a new ledger", show a one-time "Recovery Seed" screen with:
- The base64 seed in a large monospace display
- "Write this down" instruction
- Confirm button ("I've saved it")
- Should never show again (stored in IndexedDB as `phpoc_seed`)

### 3. Staging CRUD in UI (was Step 7)

Following onboarding, wire full staging CRUD to the UI components:
- Dashboard active tasks → linked to real SyncService
- History screen → linked to real entries
- Edit/delete entries in UI

### 4. Wire Identity Secret into LedgerEngine for Commit Signing

The identity secret is stored during genesis creation but not yet loaded into `LedgerEngine` when commits happen. Update `bootstrapServices` to decrypt `identity_secret_enc_fallback` from the genesis block and cache it for the engine.

## Known Issues
- `HttpTransport.delete()`: `timeoutMs` parameter accepted but unused. `AbortSignal.timeout()` not yet wired.
- MockRemoteBackend `listFiles()` returns full paths; Worker strips prefix to return filenames only. Pre-existing inconsistency.
- ETag caching stale in long-running daemon mode (CLI-only, low priority).
- WASM CryptoService dynamic import (`@vite-ignore`) may fail in dev HMR mode — falls back to DummyCryptoService transparently.
- IndexedDB unavailable in private/incognito browsing — falls back to in-memory storage, data lost on reload.
