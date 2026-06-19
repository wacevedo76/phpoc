# PH Ledger — Session Handoff

## Current State
- **Branch:** `mobile-poc` (Rust crypto core complete, WASM bindings done, Worker CORS added, HttpBackend complete)
- **CLI:** Maintenance mode — 1341 tests, fully functional, not actively worked on
- **Transport:** HTTP → Cloudflare Worker → R2 (staging blob + ledger blocks + index)
- **Storage decision (ledger):** Option B — direct `StorageBackend` consumption with key convention `ledger:blocks` (array) / `ledger:index` (JSON). No adapter layer.
- **Auth gate:** Cookie-only fast path. Full implementation in `src/sync/sync.js` (60 tests). Documented in `docs/design/DESIGN_MULTI_DEVICE_SESSION.md`.
- **Architecture:** Multi-deployment via `StorageBackend` interface — standalone PWA (IndexedDB), self-hosted LAN/Docker (bridge server), SaaS (Worker→R2). Full details in `PHPOC-REACT_WEB-DESIGN_DECISIONS.md` §11.
- **Onboarding:** New phase-based lifecycle system with Landing, Onboarding, Auth, and Ready phases. Production mode collects **username** and **email** (per PHPSPEC §4.1) alongside passphrase, creates a PHPSPEC-compliant genesis block with encrypted recovery seed, encrypted identity secret, HMAC seal, and identity signature. Dev mode preserved for backward compat via `?dev=true`.
- **Sync Screen:** Complete rewrite of the Sync screen (`SyncSettings.jsx`). Shows all uncommitted entries (active + stopped) as compact cards. Stopped entries get a yellow border/yellow left syncability indicator, can be selected for committing, and expand on click to show inline tag/comment editing (× buttons to remove tags, +input to add, debounced comment textarea), **end-time adjustment** (`type="time"` input with −5m/+5m/+15m quick-adjust buttons), **duration editor** (text field accepting `1h30m`, `90m`, `1.5h`, `1:30`, raw minutes — auto-calculates active duration net of pauses), **pause management** (list existing pauses with start/stop times + duration badge, × to remove, inline form to add new pauses with start/end time inputs + Save/Cancel), and a **delete-from-staging button** (🗑 to remove stopped entries from the staging area with immediate UI update). Active entries show a red left indicator, lock icon, and are non-expandable. Commit buttons sit between the entries list and the sync status section. Status shows "Not synced" (`NOT_SYNCED`) when staging has uncommitted entries. Enter key in tag input no longer collapses the card (stopPropagation fix).
- **One-off Tasks:** Dashboard "Start New Task" form has ☐ one-off checkbox next to the title input. When checked, the button changes to "Log" and the task is captured with `isActive: false` + `endEpoch: now` (zero duration, immediately stoppable/commitable). Resets after submission.
- **Full Ledger Export:** `exportLedgerFull(blocks, staging, crypto, masterKey)` in `ledger_export.js` — v2 format with committed chain + staging in separate arrays, HMAC seal over `{ledger, staging}`. Pure read — never commits staging entries. 72 tests with real mock ledger data (97 blocks, 205 entries).
- **Import Interface:** `importLedger()` handles three formats: v1 export, v2 export, and raw CLI chain (JSON array of blocks). Returns `{entries, count, genesisHash, formatVersion, ledger}`. Two-phase import in DevModeContext: `validateImport()` (read-only, 5 validation gates) + `confirmImport()` (destructive write + bootstrap). Cross-platform Python-compatible JSON serializer (`jsonDumps`) for block seal / entry hash verification on raw chain imports. See `PHPOC-REACT_WEB-DESIGN_DECISIONS.md` §11.11 for format details.
- **History Calendar + Committed Entry Decryption (2026-06-11):** ✅ DONE. Replaced plain `<input type="date">` with a custom inline month calendar widget (year/month navigation, day grid with entry-dot indicators, today highlighting, click-to-filter). Extended `sync.getCompleted()` to also read committed entries from `ledger:blocks` and decrypt them via new `_rawCommittedEntryToDTO()` method (AES-128-CTR field decryption vs staging's `plain:` prefix convention). Calendar dots and date filtering now work across all 205 imported entries. Committed entries show ✓ Committed badge with block index. See `PHPOC-REACT_WEB-DESIGN_DECISIONS.md` §11.27.
- **Import Security Analysis (2026-06-11):** Passphrase verification happens BEFORE any destructive operations. Five read-only validation gates (parse → format detection → seal verify → entry hash re-validate → genesis check) pass before `storage.clear()` is ever called. Wrong passphrase or tampered file is rejected with zero impact on existing data.
- **Known Bug — v2 Import Loses Committed Chain:** ✅ FIXED (2026-06-11). `importLedger()` now returns `{ledger}` array for v2 files. `confirmImport()` writes it to `ledger:blocks`. Also writes identity info (username, email) from genesis block to storage.
- **Raw chain import (2026-06-11):** ✅ DONE. `importLedger()` detects raw CLI `ledger.json` files (top-level JSON array of blocks). Validates per-block HMAC seals (PHPSPEC §5.2), `prev_hash` chain linkage, and entry hash integrity. Uses Python-compatible `jsonDumps()` serializer — Python's `json.dumps(obj, sort_keys=True)` uses `": "`/`", "` separators and sorts all nested keys recursively, unlike JavaScript's `JSON.stringify()`. See `PHPOC-REACT_WEB-DESIGN_DECISIONS.md` §11.11.
- **Staging Entry Portability (confirmed):** Staging entries carry plaintext `start_epoch`, `duration`, `title`, `tags`, `comment` at the outer level. `_encryptEntry()` reads plaintext fields and re-encrypts fresh with the current master key — it never decrypts existing `_enc` fields. This makes staging entries portable across ledgers with different seeds/master keys. The genesis hash is not involved in entry hash computation (confirmed against PHPSPEC §5.4).

### Web Platform — Completed Steps

| Step | What | Status | Tests |
|------|------|--------|-------|
| 1 | `HttpTransport` — fetch()-based HTTP with ETag caching | ✅ | 49 |
| 2 | Sync algorithm port — `checkAndSync()`, auth gate, staging CRUD, merge engine | ✅ | 60 |
| 3 | React Web UI — Vite + React 18, 9 screens, dev mode, auth overlay | ✅ | — |
| 4 | `StorageBackend` + `HttpBackend` — interface + Transport→StorageBackend adapter | ✅ | 41 |
| 5 | Browser import/export via File API | ✅ | 83 |
| 6 | **Ledger Engine JS Port + Refactoring** — Chain, Index, Summary, Engine | ✅ | 269 (70+36+49+114) |
| 7 | **Onboarding Workflow** — Landing screen, onboarding wizard (Import/New/Export), phase-based lifecycle, IndexedDB seed storage, passphrase auth with PBKDF2, identity fields (username + email), PHPSPEC-compliant genesis block creation with encrypted seed + identity secret + seal + signature | ✅ | — |
| 8 | **History screen — staging vs committed differentiation** — visual badges (Not Committed / Committed), expand/collapse tags & comments on card click, red border for staging, blue when expanded. **Inline editing for staging entries**: add/remove tags (× buttons, +input with Enter), edit comments (textarea debounced auto-save). Commit UI removed from History (moves to Sync screen). | ✅ | — |
| 9 | **Inline tag & comment editing on staging entries** — when expanded, staging cards show × on tags to remove, an input to add tags (Enter to confirm), and an editable textarea for comments with debounced auto-save. Committed entries read-only. | ✅ | — |
| 10 | **Export works in dev mode** — uses cached master key from bootstrap instead of requiring seed authentication. Dev mode: any passphrase works. | ✅ | — |
| 11 | **Recovery seed display** — after new ledger creation, a full-screen overlay shows the base64 seed in monospace. "I've saved it" confirm button. Only shown once. | ✅ | — |
| 12 | **Logout button** — renamed from "Lock" to "Logout" with exit-door icon. Clears crypto master key, returns to Landing screen. Fixed blank screen bug (hasExistingData) and in-memory data loss on re-login (FallbackStorage caching). | ✅ | — |
| 13 | **Sync Screen with Commit UI** — dedicated Sync screen replacing old sync status panel. Shows all uncommitted entries (active + stopped) in compact cards. Stopped entries: yellow border/syncability indicator, expandable inline tag & comment editing (× remove, +input add, debounced comment textarea) + end-time adjustment (time input with −5m/+5m/+15m quick-adjust) + duration editor (1h30m/90m/1.5h formats, accounts for pauses) + pause management (list/add/remove pauses with start/end time, auto-recalculated active duration) + **delete-from-staging button** for stopped entries. Active entries: red border (not syncable), compact non-expandable with lock icon. Commit button bar (Commit Selected / Commit All) between entries and status section. NOT_SYNCED status when staging has entries. Tag-add Enter key no longer collapses card (stopPropagation fix). | ✅ | — |
| 14 | **One-off Task Checkbox** — Dashboard "Start New Task" form: ☐ one-off checkbox. Checked → "Log" button, `isActive: false` + `endEpoch: now`. Unchecked → "Start" button, timed task. Resets after submission. | ✅ | — |
| 15 | **Full Ledger Export + Import Interface** — `exportLedgerFull()` v2 format with committed chain + staging, seal over `{ledger, staging}`. Pure read. 72 tests. Import updated for v1/v2 dual-format with `genesisHash` return. Genesis-aware import: same genesis → reject with merge placeholder, different → replace. | ✅ | 72 |
| 16 | **History Calendar Widget + Committed Entry Decryption** — Replaced `<input type="date">` with custom inline month calendar (year/month nav, day grid with entry-dot indicators, today highlighting, click-to-filter). Extended `sync.getCompleted()` to decrypt committed entries from `ledger:blocks` via new `_rawCommittedEntryToDTO()` (AES-128-CTR field decryption). Calendar dots and date filtering now work across all committed entries. | ✅ | — |
| 16 | Staging CRUD in UI (Dashboard) | 🔜 | — |
| 16b | **Sync Screen Delete-From-Staging Button** — expanded stopped entries show "🗑 Delete from staging" button that calls `sync.remove()` to remove the entry from the staging area. Immediate UI update with all editing/selection state cleaned up. | ✅ | Jun 16 2026 |
| 17 | **Ledger Merge — TDD GREEN** — 36 tests written, module implemented in `src/ledger/merge.js`. Covers fork detection, dedup, summary blocks, alphabetical ordering, chain integrity, index rebuild, stats, and edge cases. All 89 assertions GREEN. `LedgerMerge.merge()` standalone with 7-step algorithm per §11.31. | ✅ GREEN | Jun 19 2026 |
| 17b | Companion bridge server (Python) | 🔜 | — |
| 17b | **rclone bridge loader** (`rclone_bridge.py`) — interactive setup for Google Drive, Dropbox, 40+ cloud providers | 🔜 | Step 17 (bridge server) |
| 18 | Docker + multi-tenant Worker | 🔜 | — |

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
| `phpoc-web/src/sync/sync.js` | `SyncService` — full `checkAndSync()` auth gate, staging CRUD. `_getDeviceId()` now reads per-device UUID4 from storage before falling back to WASM (2026-06-18). `getCompleted()` includes committed entries from `ledger:blocks` with AES-128-CTR field decryption (`_rawCommittedEntryToDTO`).
| `phpoc-web/src/sync/device_uuid.js` | `getOrCreateDeviceUuid(storage)` + `isWasmDerivedUuid(uuid)` — per-device UUID4 generation with IndexedDB persistence. Migrates WASM-derived hex UUIDs. 22 tests. |
| `phpoc-web/src/sync/transport.js` | `HttpTransport` — fetch()-based HTTP with ETag caching |
| `phpoc-web/src/sync/http_backend.js` | `HttpBackend` — Transport→StorageBackend adapter |
| `phpoc-web/src/sync/storage.js` | `StorageBackend` interface + `MemoryBackend` |
| `phpoc-web/src/sync/indexeddb_storage.js` | `IndexedDBBackend` via idb-keyval |
| `phpoc-web/src/crypto/index.js` | `CryptoService` — singleton WASM wrapper, 20 functions |
| `phpoc-web/src/services/ledger_export.js` | `exportLedger()` (v1, staging-only) + `exportLedgerFull()` (v2, committed chain + staging). HMAC seal over {ledger, staging}. Pure read. |
| `phpoc-web/src/services/ledger_import.js` | `importLedger()` — three-format detection (v1/v2 export + raw CLI chain). Returns `{entries, count, genesisHash, formatVersion, ledger}`. Cross-platform `jsonDumps()` serializer for Python-compatible hash verification. |
| `phpoc-web/src/App.jsx` | Root — phase-based routing, DevModeProvider → lifecycle phases |
| `phpoc-web/src/context/DevModeContext.jsx` | Phase-based lifecycle: boot → landing → onboarding → auth → ready. Two-phase import: `validateImport()` (read-only gates) + `confirmImport()` (destructive write). `exportLedgerFullAction()` for pre-import backup. |
| `phpoc-web/src/components/screens/LandingScreen.jsx` | Landing screen — detects IndexedDB data, Login vs Onboarding choices |
| `phpoc-web/src/components/screens/OnboardingScreen.jsx` | Onboarding wizard — Import / New Ledger / Export flows. Import now has two-phase confirmation with destroy warning, staging persistence, and export offer. New ledger form includes Username + Email fields. |
| `phpoc-web/src/components/screens/AuthScreen.jsx` | Passphrase entry — async PBKDF2, spinner, error handling |
| `phpoc-web/src/ledger/chain.js` | `LedgerChain.buildGenesisBlock()` — builds PHPSPEC §4.1 genesis block with identity, encrypted seed/secrets, seal, and signature |
| `phpoc-web/src/ledger/engine.js` | `LedgerEngine.init()` — orchestrates genesis block creation + append during onboarding |
| `phpoc-web/src/context/DevModeContext.jsx` | `createNewLedger()` now accepts username + email, creates genesis block via `engine.init()` |
| `phpoc-web/src/components/screens/UserProfile.jsx` | Shows `user.username` as display name and `user.email` underneath |
| `phpoc-web/src/components/screens/Settings.jsx` | Settings — Data Management section with Import/Export. Import has two-phase confirmation (destroy warning, staging persistence checkbox, export offer). |
| `phpoc-web/src/components/screens/SyncSettings.jsx` | Sync screen — compact pills for all uncommitted entries, selection checkboxes, expand/collapse with inline tag & comment editing, Commit Selected/Commit All buttons, sync status section below |
| `phpoc-web/src/components/screens/History.jsx` | History — custom month calendar widget with entry-dot indicators, day grid, year/month navigation. Click-to-filter date. Staging/committed badges, expand/collapse details, tag/comment inline editing for staging entries. |
| `phpoc-web/src/sync/local_cache.js` | `StagingEntry` now tracks `committed` (boolean) and `block_index` (number). Added `markCommitted()`. |
| `phpoc-web/test/ledger_export_full_test.mjs` | 72 tests for `exportLedgerFull()` — v2 format, seal integrity, data preservation, real mock ledger data (97 blocks, 205 entries), error handling |
| `phpoc-web/src/ledger/merge.js` | **NEW (2026-06-19)** — `LedgerMerge.merge()` standalone module. 7-step merge algorithm: fork detection, entry extraction, content_hash dedup, alphabetical sort, chain rebuild with summary inserts, index rebuild, verification. 89 tests green. |
| `phpoc-web/src/sync/sync.js` | Exposes `markCommitted()` from LocalCache |
| `phpoc-web/src/ledger/engine.js` | `commit()` returns `{hashPrefix, committedEntryIds, blockIndex}` for caller tracking. `_commitDay()` returns block index. Staging entry IDs preserved through commit flow. Tests: 114 |
| `phpoc-web/test/*.mjs` | Test suites — ledger (4 suites), sync, transport, import/export, etc. |
| `phpoc-web/test/sync_service_test.mjs` | **NEW (2026-06-18)** — 40 tests for `checkAndSync()` auth gate (READY/OFFLINE/REAUTH_NEEDED) + `_reconcileAndClaim()` Case A/B + BLOB_KEY_MISMATCH + edge cases. Uses `MockTransport` with `queueResponse()` for two-phase cookie pulls. |
| `phpoc-web/test/device_uuid_test.mjs` | **NEW (2026-06-18)** — 22 tests for `getOrCreateDeviceUuid()` and `isWasmDerivedUuid()`. ✅ GREEN — all passing. Tests: UUID4 generation, storage persistence, logout/re-login survival, MK independence, format validation, WASM-derived detection, migration. |
| `phpoc-web/test/remote_config_test.mjs` | **NEW (2026-06-18)** — 35 tests for `detectDeployment()` config detection: localStorage persistence, URL param priority, auto-detect SaaS from worker URL, invalid deployment fallback, config mutation. ✅ GREEN — all passing. |
| `phpoc-web/test/remote_transport_test.mjs` | **NEW (2026-06-18)** — 35 tests for `createRemoteTransport()`: null for standalone/mock/memory, HttpTransport for saas/lan with baseUrl, null fallback, instance isolation, ETag cache. ✅ GREEN — 40 assertions, 0 failures. `createRemoteTransport()` implemented in `plugin_factory.js`. |
| `phpoc-web/test/ledger_merge_test.mjs` | **NEW (2026-06-19)** — 36 tests for `LedgerMerge.merge()`: fork detection (4), simple merge (4), content_hash dedup (6), summary blocks (3), alphabetical ordering (3), chain integrity (5), index rebuild (2), stats accuracy (5), edge cases (4). ✅ GREEN — 89 assertions, 0 failures. Module implemented in `src/ledger/merge.js`. |

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

### 🔴 NOW: Remote Sync Wiring — phpoc-web ↔ Cloudflare Worker (2026-06-18)

> **⏭ Next session resume:** Step 7 — Settings genesis compatibility gate. LedgerMerge is GREEN (89 tests, 0 failures). Wire merge into the Settings UI's remote connection flow: pull genesis from remote, compare hashes, use merge for same-genesis divergent chains, block connection for different genesis.

Wire phpoc-web to use the Cloudflare Worker as a remote backend. All transport and backend pieces are built and tested (HttpTransport 49 tests, HttpBackend 41 tests, Worker ~195 lines). The gap is the boot sequence in `DevModeContext.jsx` hardcoding `IndexedDBBackend` instead of using the `createStoragePlugin()` factory, and a Settings UI for configuring remote services.

**Architecture decisions from discussion:**

- **Dual-backend model (not single HttpBackend):** phpoc-web follows the same architecture as the CLI — `SyncService` receives `storage` (local IndexedDB) and `transport` (remote HttpTransport) as separate parameters. The factory's `"saas"` mode currently returns a single HttpBackend, but the correct SaaS setup is IndexedDB (local) + HttpTransport (remote). The factory produces a StorageBackend for local use; the remote transport is constructed separately from config.
- **Device UUID must be per-device, not per-passphrase:** The WASM `get_device_id(MK)` returns `HMAC(MK, "device:id")` — deterministic from the master key (per PHPSPEC §2.8 default). The CLI uses `RandomUUIDDeviceIdentityProvider` which generates and persists a random UUID4. If the web app uses the WASM default, all devices with the same passphrase get the same device ID. The cookie mechanism's Case A/Case B decision (`remote_device_uuid == local_device_uuid`) would incorrectly treat different devices as the same device, skipping the pull+merge path. **Fix:** Generate `crypto.randomUUID()` on first boot, persist in IndexedDB, use that UUID for cookie operations.
- **Settings UI:** Replace hardcoded "Worker URL" + "API Key" text boxes with a dropdown of storage services (None, Cloudflare Worker, Bridge LAN, Bridge Docker, Google Drive [future]). Conditional fields per service. Destructive transition warning when switching from local-only to remote (no ledger reconciliation yet — export current ledger first).
- **Auth applies to all remote operations:** Remote staging blob is obfuscated + encrypted with blob sub-key. Entry fields are AES-128-CTR encrypted. Device identity requires master key. Ledger blocks are HMAC-sealed. The auth flow (AuthScreen → PBKDF2 → master key) must complete before any remote data is pulled, decrypted, or loaded into IndexedDB.

**Phase 1 — Tests (DONE 2026-06-18):**

| Test Suite | What | Priority | Status |
|-----------|------|:---:|:---:|
| `test/sync_service_test.mjs` | `SyncService.checkAndSync()` auth gate: READY/OFFLINE/REAUTH_NEEDED with mock transport | P1 | ✅ 40 tests, all passing |
| `test/sync_service_test.mjs` | `SyncService._reconcileAndClaim()`: Case A (same UUID → push only) vs Case B (different UUID → pull+merge) | P1 | ✅ included above — 2-phase cookie pull pattern with `queueResponse()` mock |
| `test/device_uuid_test.mjs` | Device UUID generation, IndexedDB persistence, survives refresh/re-login, not derived from master key | P1 | ✅ 22 tests, all passing — `device_uuid.js` module implemented, `_getDeviceId()` wired |
| `test/remote_transport_test.mjs` | `createRemoteTransport()`: null for standalone/mock/memory, HttpTransport for saas/lan with baseUrl, null fallback without baseUrl. Instance isolation, ETag cache. | P2 | ✅ GREEN — 40 assertions, 0 failures. `createRemoteTransport()` implemented in `plugin_factory.js`. |
| `test/remote_config_test.mjs` | localStorage persistence for deployment, baseUrl, apiKey; URL param priority; auto-detect saas from worker URL; fallback to standalone on invalid config | P2 | ✅ 35 tests, all passing |

All tests use `MemoryBackend` + `MockTransport` — no real Worker, no network. Pure logic tests against the sync algorithm. SyncService tests pass because the auth gate + reconcile logic already works correctly; the WASM-derived UUID happens to differentiate correctly for test scenarios (different MK → different UUID). The real production fix is in the device UUID tests.

**🧩 Phase 2 — Implementation (IN PROGRESS):**

1. ✅ **Implement `getOrCreateDeviceUuid(storage)`** in new module `src/sync/device_uuid.js` — generate `crypto.randomUUID()`, persist under key `device_uuid`, read on subsequent calls. Handle migration from WASM-derived UUIDs (`isWasmDerivedUuid()` detection). **DONE (2026-06-18)** — 22 tests, all passing.
2. ✅ **Wire into `SyncService._getDeviceId()`** — read `device_uuid` from storage first, fall back to WASM `getDeviceId(MK)` only as last resort. `_getDeviceId()` now async, all 5 call sites updated. `sync_service_test.mjs` Group E (Case A) tests updated to pre-populate device_uuid in storage. **DONE (2026-06-18)** — 40 sync_service tests + 22 device_uuid tests all passing.
2b. ✅ **Code review (2026-06-18)** — 14 findings across `device_uuid.js` and `sync.js`. Two fixes applied: (a) removed unused `isWasmDerivedUuid` import, (b) fixed `_reconcileAndClaim()` cookie creation to use per-device UUID4 instead of WASM-derived UUID (was causing permanent Case A/B mismatch — remote cookie always had WASM UUID while local had UUID4).
3. ✅ **TDD RED phase — `test/remote_transport_test.mjs` (DONE 2026-06-18)** — 35 tests written for `createRemoteTransport()`. Tests cover: standalone/mock/memory → null, saas/lan + baseUrl → HttpTransport, saas/lan without baseUrl → null fallback, instance isolation, ETag cache starts empty, invalid deployment → null. Architecture decision: transport is a separate concern from local storage. `createRemoteTransport(config)` → `HttpTransport | null`. `createStoragePlugin()` stays for local storage (IndexedDB/Memory/MockRemote). Both feed into `SyncService(storage, crypto, transport)`.
4. ✅ **GREEN phase — Implement `createRemoteTransport()`** in `src/sync/plugin_factory.js` (DONE 2026-06-18). ~25 lines. Returns `null` for local-only deployments (standalone/mock/memory/invalid), `new HttpTransport({baseUrl, apiKey})` for saas/lan with baseUrl, `null` for saas/lan without baseUrl. Trailing slash normalization and protocol validation delegated to HttpTransport constructor. 39 assertions, 0 failures (duplicate test removed). Code review: 13 findings (F1-F13), 4 low-severity fixes applied (F1: JSDoc, F5: duplicate test removal). F2 (HttpBackend for lan/saas) and F7 (apiKey normalization) deferred to Step 5.
5. ✅ **Wired into `DevModeContext.jsx`** — DONE (2026-06-18). Added `createTransportFromDeployment()` helper to `plugin_factory.js` that wraps `detectDeployment()` + `createRemoteTransport()` with try/catch fallback (bad URL → null transport + console.warn). `bootstrapServices()` in `DevModeContext.jsx` now calls `createTransportFromDeployment()` instead of hardcoding `null`. `detectDeployment()` fixed: explicit deployment keys now include `baseUrl`/`apiKey` from localStorage via `readRemoteConfig()`. 19 new integration tests (`transport_wiring_test.mjs`). Exports added to barrel.
### ⏭ Next Steps (2026-06-18)

6. ✅ **Ledger merge strategy** — TDD GREEN phase **COMPLETE (2026-06-19)**. `LedgerMerge.merge()` implemented in `src/ledger/merge.js`. Standalone module with 7-step algorithm per `PHPOC-REACT_WEB-DESIGN_DECISIONS.md` §11.31. **89 assertions, 0 failures.** Fork detection walks both chains forward; content_hash dedup uses Set from all local entries; alphabetical sort by title per §11.30; chain rebuild inserts summary blocks via YearMonthSummaryPolicy; only rebuilds when unique remote entries exist (local chain used as-is for subset/identical cases). **Test infrastructure bug fixed:** `buildDayBlock` seal computation in `ledger_merge_test.mjs` now uses proper sorted-key JSON instead of `JSON.stringify(obj, replacerArray)` which acted as a property whitelist, stripping nested entry data and making all same-position blocks appear identical.

7. 🔜 **Settings service dropdown with genesis compatibility gate** — Replace hardcoded text boxes with deployment picker. On remote connection, pull genesis block from remote (`GET /ledger/blocks/0.json`), decrypt with master key, compare against local genesis hash:
   - **G₁ ≠ G₂ (different ledgers):** Block connection. Show clear message: "This remote contains a different ledger. Export your current ledger from Data Management, then import the remote ledger."
   - **G₁ = G₂ (same genesis):** Allow connection for staging sync. Use merge strategy from Step 6 to reconcile divergent chains.
   - **No local ledger (fresh install):** Bootstrap from remote genesis — valid onboarding path.
   Without this gate, a user could connect to the wrong Worker and silently sync staging entries to an unrelated ledger.

### ✅ 1. Import Workflow Enhancement — Destroy Warning + Staging Persistence

**COMPLETED (2026-06-11).** Full two-phase import flow with safety gates. See `PHPOC-REACT_WEB-DESIGN_DECISIONS.md` §11.11 for details.

### ✅ 2. Fix v2 Import Loses Committed Chain

**COMPLETED (2026-06-11).** `importLedger()` now returns `{ledger}` array. `confirmImport()` writes to `ledger:blocks`.

### ✅ 7. Sync Screen — Delete from Staging Button

**COMPLETED (2026-06-16).** 🗑 button on expanded stopped entries in Sync screen. Calls `sync.remove()`, immediate UI update.

### ✅ 6. History Calendar Widget + Committed Entry Decryption

**COMPLETED (2026-06-11).** Custom month calendar + committed entry decryption from `ledger:blocks` via `_rawCommittedEntryToDTO()`.

### Deferred: rclone Bridge Loader

Discussed 2026-06-17. Deferred in favor of Worker wiring (already built, tested, and available). The rclone bridge remains the Tier 4 self-hosted option. See `PHPOC-REACT_WEB-DESIGN_DECISIONS.md` §11.28-11.29.

### Deferred: Staging CRUD in UI (Dashboard)

Full staging interaction — add/edit/delete entries directly in the Dashboard UI. Currently only inline tag/comment editing on Sync/History screens.

### Deferred: Wire Device Cookie TTL to Re-auth Overlay

The re-auth overlay exists but isn't triggered. Will be wired as part of the Remote Sync Wiring feature.

### Deferred: Wire Identity Secret into LedgerEngine for Commit Signing

Identity secret stored during genesis but not loaded into `LedgerEngine` for commits.

### ✅ Duplicate Entry Race Condition Fix

**FIXED (2026-06-16).** Three guards in `LocalCache.update()`: early committed check, index-out-of-range, entry_id + committed race check.

## Known Issues
- `HttpTransport.delete()`: `timeoutMs` parameter accepted but unused. `AbortSignal.timeout()` not yet wired.
- MockRemoteBackend `listFiles()` returns full paths; Worker strips prefix to return filenames only. Pre-existing inconsistency.
- ETag caching stale in long-running daemon mode (CLI-only, low priority).
- WASM CryptoService dynamic import (`@vite-ignore`) may fail in dev HMR mode — falls back to DummyCryptoService transparently.
- IndexedDB unavailable in private/incognito browsing — falls back to in-memory storage (`FallbackStorage`), data lost on refresh. Now cached at module level so it survives logout/login within the same session.
- **Ledger merge — GREEN (2026-06-19):** `LedgerMerge.merge()` implemented in `src/ledger/merge.js`. Standalone module, 7-step algorithm per §11.31. 89 assertions, 0 failures. Fork detection walks both chains forward; content_hash dedup uses Set from all local entries; alphabetical sort by title per §11.30; only rebuilds when unique remote entries exist. Test infrastructure seal-computation bug fixed (replacer-array whitelist → proper sorted-key JSON). ⏭ Next: Wire into genesis compatibility gate (Step 7).
- **No genesis gate on remote connection (2026-06-18):** The Settings screen lets users configure a Worker URL without verifying it belongs to the same ledger. A user could silently connect to the wrong Worker and sync staging entries to an unrelated ledger. Step 6 addresses this with a genesis compatibility gate: pull remote block 0, decrypt, compare hashes. G₁≠G₂ → block connection.
- **Cross-platform JSON:** JavaScript `JSON.stringify()` and Python `json.dumps()` produce different whitespace and key ordering. The `jsonDumps()` helper in `ledger_import.js` bridges this gap for raw chain verification. Long-term, consider using a single library (e.g., a WASM-based Python `json.dumps` or a cross-platform spec for canonical JSON) to avoid per-platform serializers.
- **`isWasmDerivedUuid` regex too broad (2026-06-18):** The hex regex `/^[0-9a-f]{32,}$/` matches MD5 (32 chars), SHA-1 (40), and even dash-stripped UUID4 (32 chars). Should be `{64}` for HMAC-SHA256 which is the actual WASM output. Low risk in practice — worst case is unnecessary migration of a dash-stripped UUID4.
- **Index-based staging operations have stale-index race (2026-06-18):** `end()`, `pause()`, `unpause()` call `readEntries()` to find an index, then call `update()` by that index. Between the read and write, another operation could change the array order (insert/delete), causing the index to point to the wrong entry. `LocalCache.update()` guards against committed-flag races but not index-shift races.
- **`_getDeviceId()` called twice in push operations:** `pushToRemote()` calls it for `pushBlob` and again for `_pushCookie`. `_reconcileAndClaim` calls it and then `pushBlobOnly` calls it again internally. Consider caching in a `_deviceUuid` instance variable after first resolution.
- **`createStoragePlugin` lan/saas branch still creates `HttpBackend` (2026-06-18 code review F2):** The architecture decision says SaaS should be IndexedDB (local) + HttpTransport (remote). But `createStoragePlugin()` for `lan`/`saas` returns `HttpBackend` directly, bypassing local IndexedDB. Step 5 added `createTransportFromDeployment()` which provides the transport layer, but `DevModeContext` still uses its own `createStorage()` helper (not `createStoragePlugin`). Full storage unification deferred.
- **apiKey normalization differs between factories (2026-06-18 code review F7):** `createRemoteTransport` uses `|| null` (canonical sentinel for HttpTransport). `createStoragePlugin` uses `|| ''`. Both are intentional but divergent in the same file. Add comment noting HttpTransport expects `null`.
