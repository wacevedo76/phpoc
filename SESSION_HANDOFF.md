# PH Ledger — Session Handoff

## Current State
- **Branch:** `mobile-poc` (Rust crypto core complete, WASM bindings done, Worker CORS added, HttpBackend complete)
- **CLI:** Maintenance mode — 1341 tests, fully functional, not actively worked on
- **Transport:** HTTP → Cloudflare Worker → R2 (staging blob + ledger blocks + index)
- **Storage decision (ledger):** Option B — direct `StorageBackend` consumption with key convention `ledger:blocks` (array) / `ledger:index` (JSON). No adapter layer.
- **Auth gate:** Cookie-only fast path. Full implementation in `src/sync/sync.js` (60 tests). Documented in `docs/design/DESIGN_MULTI_DEVICE_SESSION.md`.
- **Architecture:** Multi-deployment via `StorageBackend` interface — standalone PWA (IndexedDB), self-hosted LAN/Docker (bridge server), SaaS (Worker→R2). Full details in `PHPOC-REACT_WEB-DESIGN_DECISIONS.md` §11.

### Web Platform — Completed Steps

| Step | What | Status | Tests |
|------|------|--------|-------|
| 1 | `HttpTransport` — fetch()-based HTTP with ETag caching | ✅ | 49 |
| 2 | Sync algorithm port — `checkAndSync()`, auth gate, staging CRUD, merge engine | ✅ | 60 |
| 3 | React Web UI — Vite + React 18, 9 screens, dev mode, auth overlay | ✅ | — |
| 4 | `StorageBackend` + `HttpBackend` — interface + Transport→StorageBackend adapter | ✅ | 41 |
| 5 | Browser import/export via File API | ✅ | 83 |
| 6 | **Ledger Engine JS Port + Refactoring** — Chain, Index, Summary, Engine | ✅ | 266 |
| 7 | Staging CRUD in UI | 🔜 | — |
| 8 | Companion bridge server (Python) | 🔜 | — |
| 9 | Docker + multi-tenant Worker | 🔜 | — |

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
| `phpoc-web/src/App.jsx` | Root — DevModeProvider → auth gate → navigation |
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

1. **Step 7: Staging CRUD in UI** — Full staging interaction (add/edit/delete entries directly in UI). Currently wired to dummy data.
2. **Step 8: Companion bridge server** — ~50 lines Python HTTP server implementing same API contract as Worker. Enables self-hosted LAN deployment.
3. **Step 9: Dockerfile + Multi-tenant Worker** — One-command self-hosted deployment + SaaS multi-tenant isolation.

## Known Issues
- `HttpTransport.delete()`: `timeoutMs` parameter accepted but unused. `AbortSignal.timeout()` not yet wired.
- MockRemoteBackend `listFiles()` returns full paths; Worker strips prefix to return filenames only. Pre-existing inconsistency.
- ETag caching stale in long-running daemon mode (CLI-only, low priority).
