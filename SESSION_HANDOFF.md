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
| 17 | Companion bridge server (Python) | 🔜 | — |
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
| `phpoc-web/src/sync/sync.js` | `SyncService` — full `checkAndSync()` auth gate, staging CRUD. `getCompleted()` now includes committed entries from `ledger:blocks` with AES-128-CTR field decryption (`_rawCommittedEntryToDTO`).
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
| `phpoc-web/src/sync/sync.js` | Exposes `markCommitted()` from LocalCache |
| `phpoc-web/src/ledger/engine.js` | `commit()` returns `{hashPrefix, committedEntryIds, blockIndex}` for caller tracking. `_commitDay()` returns block index. Staging entry IDs preserved through commit flow. Tests: 114 |
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

### 🔴 NOW: Remote Sync Wiring — phpoc-web ↔ Cloudflare Worker (2026-06-18)

Wire phpoc-web to use the Cloudflare Worker as a remote backend. All transport and backend pieces are built and tested (HttpTransport 49 tests, HttpBackend 41 tests, Worker ~195 lines). The gap is the boot sequence in `DevModeContext.jsx` hardcoding `IndexedDBBackend` instead of using the `createStoragePlugin()` factory, and a Settings UI for configuring remote services.

**Architecture decisions from discussion:**

- **Dual-backend model (not single HttpBackend):** phpoc-web follows the same architecture as the CLI — `SyncService` receives `storage` (local IndexedDB) and `transport` (remote HttpTransport) as separate parameters. The factory's `"saas"` mode currently returns a single HttpBackend, but the correct SaaS setup is IndexedDB (local) + HttpTransport (remote). The factory produces a StorageBackend for local use; the remote transport is constructed separately from config.
- **Device UUID must be per-device, not per-passphrase:** The WASM `get_device_id(MK)` returns `HMAC(MK, "device:id")` — deterministic from the master key (per PHPSPEC §2.8 default). The CLI uses `RandomUUIDDeviceIdentityProvider` which generates and persists a random UUID4. If the web app uses the WASM default, all devices with the same passphrase get the same device ID. The cookie mechanism's Case A/Case B decision (`remote_device_uuid == local_device_uuid`) would incorrectly treat different devices as the same device, skipping the pull+merge path. **Fix:** Generate `crypto.randomUUID()` on first boot, persist in IndexedDB, use that UUID for cookie operations.
- **Settings UI:** Replace hardcoded "Worker URL" + "API Key" text boxes with a dropdown of storage services (None, Cloudflare Worker, Bridge LAN, Bridge Docker, Google Drive [future]). Conditional fields per service. Destructive transition warning when switching from local-only to remote (no ledger reconciliation yet — export current ledger first).
- **Auth applies to all remote operations:** Remote staging blob is obfuscated + encrypted with blob sub-key. Entry fields are AES-128-CTR encrypted. Device identity requires master key. Ledger blocks are HMAC-sealed. The auth flow (AuthScreen → PBKDF2 → master key) must complete before any remote data is pulled, decrypted, or loaded into IndexedDB.

**Phase 1 — Tests before implementation (in progress):**

| Test Suite | What | Priority |
|-----------|------|:---:|
| `test/sync_service_test.mjs` | `SyncService.checkAndSync()` auth gate: READY/OFFLINE/REAUTH_NEEDED with mock transport | P1 |
| `test/sync_service_test.mjs` | `SyncService._reconcileAndClaim()`: Case A (same UUID → push only) vs Case B (different UUID → pull+merge) | P1 |
| `test/device_uuid_test.mjs` | Device UUID generation, IndexedDB persistence, survives refresh/re-login, not derived from master key | P1 |
| `test/factory_sync_wiring_test.mjs` | Factory produces correct dual-setup (local IndexedDB + remote HttpTransport) for each deployment mode | P2 |
| `test/remote_config_test.mjs` | localStorage persistence for deployment, baseUrl, apiKey; fallback to standalone on invalid config | P2 |
| `test/sync_service_test.mjs` | Cookie TTL expiry, specifier mismatch, BLOB_KEY_MISMATCH, remote unreachable, empty remote | P2 |

All P1 tests use `MemoryBackend` + `MockTransport` — no real Worker, no network. Pure logic tests against the sync algorithm.

**After tests pass → Phase 2 — Implementation:**

1. Add device UUID persistence to boot sequence
2. Wire `createStoragePlugin()` into `DevModeContext.jsx` for local storage
3. Construct `HttpTransport` from config and pass to `SyncService` as remote transport
4. Replace Settings Remote Sync section with service dropdown + conditional fields
5. Add destructive transition warning dialog with export button
6. Wire re-auth overlay trigger on cookie TTL expiry

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
- **Ledger merge not yet implemented:** Importing a file with the same genesis as the existing ledger is rejected with "merge is not yet supported." The import code has an open interface at the genesis-check branch for plugging in merge reconciliation logic (decrypt start times, sort entries, rebuild blocks from fork point). Entry hashes are self-contained (computed from `data` dict only, no genesis hash involvement — PHPSPEC §5.4), so entries from divergent ledgers sharing the same genesis can be merged by discarding divergent block wrappers and rebuilding the chain from the fork point.
- **Cross-platform JSON:** JavaScript `JSON.stringify()` and Python `json.dumps()` produce different whitespace and key ordering. The `jsonDumps()` helper in `ledger_import.js` bridges this gap for raw chain verification. Long-term, consider using a single library (e.g., a WASM-based Python `json.dumps` or a cross-platform spec for canonical JSON) to avoid per-platform serializers.
