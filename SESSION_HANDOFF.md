# PH Ledger — Session Handoff

## Current State
- **Branch:** `mobile-poc` (Rust crypto core complete, WASM bindings done, Worker CORS added, HttpBackend complete)
- **CLI:** Maintenance mode — 1341 tests, fully functional, not actively worked on
- **Transport:** HTTP → Cloudflare Worker → R2 (staging blob + ledger blocks + index)
- **Storage decision (ledger):** Option B — direct `StorageBackend` consumption with key convention `ledger:blocks` (array) / `ledger:index` (JSON). No adapter layer.
- **Auth gate:** Cookie-only fast path. Full implementation in `src/sync/sync.js` (60 tests). Documented in `docs/design/DESIGN_MULTI_DEVICE_SESSION.md`.
- **Architecture:** Multi-deployment via `StorageBackend` interface — standalone PWA (IndexedDB), self-hosted LAN/Docker (bridge server), SaaS (Worker→R2). Full details in `PHPOC-REACT_WEB-DESIGN_DECISIONS.md` §11.
- **Onboarding:** New phase-based lifecycle system with Landing, Onboarding, Auth, and Ready phases. Production mode collects **username** and **email** (per PHPSPEC §4.1) alongside passphrase, creates a PHPSPEC-compliant genesis block with encrypted recovery seed, encrypted identity secret, HMAC seal, and identity signature. Dev mode preserved for backward compat via `?dev=true`.
- **Sync Screen:** Complete rewrite of the Sync screen (`SyncSettings.jsx`). Shows all uncommitted entries (active + stopped) as compact cards. Stopped entries get a yellow border/yellow left syncability indicator, can be selected for committing, and expand on click to show inline tag/comment editing (× buttons to remove tags, +input to add, debounced comment textarea), **end-time adjustment** (`type="time"` input with −5m/+5m/+15m quick-adjust buttons), **duration editor** (text field accepting `1h30m`, `90m`, `1.5h`, `1:30`, raw minutes — auto-calculates active duration net of pauses), and **pause management** (list existing pauses with start/stop times + duration badge, × to remove, inline form to add new pauses with start/end time inputs + Save/Cancel). Active entries show a red left indicator, lock icon, and are non-expandable. Commit buttons sit between the entries list and the sync status section. Status shows "Not synced" (`NOT_SYNCED`) when staging has uncommitted entries. Enter key in tag input no longer collapses the card (stopPropagation fix).
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

### ✅ 1. Import Workflow Enhancement — Destroy Warning + Staging Persistence

**COMPLETED (2026-06-11).** Full two-phase import flow with safety gates:

**A. Destroy warning + export offer:** ✅ Before replacing the existing ledger, confirmation dialog shows:
- "The ledger currently in use will be destroyed." warning banner (orange)
- Block count display ("N committed blocks will be replaced")
- Import summary (entry count, format version, genesis identity check)
- "📤 Export current ledger before proceeding" button → calls `exportLedgerFull()`

**B. Staging persistence option:** ✅ If staging has uncommitted entries, green banner shows:
- "You have N uncommitted entries. Keep them staged after import?" checkbox
- If checked: entries read BEFORE `storage.clear()`, merged into imported staging after write
- Running entries stay running; stopped entries stay stopped
- Imported entries take precedence on entry_id collision

**C. Manual testing:** ✅ Import from any `.json` file via file picker (both Settings and Onboarding screens)

**Architecture:** Split into `validateImport()` (read-only, 5 validation gates) + `confirmImport()` (destructive write). Old `importLedgerAction` auto-confirms for backward compat.

**Design constraint met:** All gates are read-only until user explicitly clicks "Confirm Import".

### ✅ 2. Fix v2 Import Loses Committed Chain

**COMPLETED (2026-06-11).** `importLedger()` now returns `{ledger}` array for v2 files. `confirmImport()` writes it to `ledger:blocks`. Also writes identity info (username, email) from genesis block to storage.

### ✅ 7. Sync Screen — Delete from Staging Button

**COMPLETED (2026-06-16).** Added a "🗑 Delete from staging" button to the expanded details section of stopped (commitable) entries in the Sync screen.

- Button appears only on stopped entries when expanded, between the comment textarea and the EndTimeEditor
- Calls `sync.remove(entryIndex)` to delete the entry from the staging area
- Immediately removes the entry from the UI list and cleans up all associated state (selection, expansion, tags, comments, end-time, pauses)
- Shows `⋯` spinner during the delete operation; button is disabled while deleting
- Uses `.btn-danger` styling (red background/border)

**Files changed:**
- `SyncSettings.jsx` — new `handleDelete` callback, `deleting` state map, button JSX in `renderCompactPill()`
- `App.css` — `.sync-pill-delete-row`, `.sync-pill-delete-btn` styles

### ✅ 6. History Calendar Widget + Committed Entry Decryption

**COMPLETED (2026-06-11).** Two-part fix for the History screen:

**A. Custom Month Calendar Widget:** Replaced plain `<input type="date">` with:
- Year/month navigation (`◀◀ ◀ [Month Year] ▶ ▶▶`)
- 7-column day grid (Su–Sa headers)
- Green dots on dates with entries
- Today highlighted with blue border, selected date filled blue
- Click a date → filter entries; click again → clear filter
- [Today] and [Clear date] shortcut buttons
- Tag filter below the calendar

**B. Committed Entry Decryption in `getCompleted()`:** `sync.getCompleted()` previously only read staging entries from IndexedDB. Imported committed entries are stored encrypted in `ledger:blocks` — they use AES-128-CTR hex ciphertext fields (`startTime_enc`, `endTime_enc`, `metadata_enc`) unlike staging entries which use `plain:` prefixed plaintext.

New method `_rawCommittedEntryToDTO(rawEntry)`:
- Decrypts `startTime_enc` via `crypto.decryptWithCachedKey()`
- Decrypts `endTime_enc` and `metadata_enc`
- Builds DTO with `committed: true`, `block_index`, and computed `date`
- Uses `rawEntry.hash` as `entry_id` (committed entries have no separate entry_id field)

`getCompleted()` now returns `[...committedDTOs, ...stagingCompleted]` — committed entries first. Falls back gracefully (try/catch) if master key isn't cached yet, so staging entries still show.

**Files changed:**
- `sync.js` — new `_rawCommittedEntryToDTO()`, extended `getCompleted()`
- `History.jsx` — calendar state, navigation helpers, `datesWithEntries`, `calendarDays` computation, new calendar JSX
- `App.css` — `.history-calendar`, `.calendar-week`, `.calendar-day`, `.calendar-day-today`, `.calendar-day-selected`, `.calendar-day-has-entries`, `.calendar-day-dot`, `.calendar-actions`, `.history-tag-filter` styles

### 3. rclone Bridge Loader — Cloud Storage via Google Drive, Dropbox, and 40+ Providers

The bridge server (step 6 in the existing roadmap) reads/writes local files. By combining it with [rclone](https://rclone.org/) — a FUSE filesystem that mounts cloud storage as a local directory — the bridge server becomes a **zero-code cloud backend** with zero changes to the bridge server itself.

**What needs to be built:**

| File | Purpose |
|------|---------|
| `phpoc-bridge/bridge_server.py` | HTTP server (Worker-compatible API). GET/PUT/DELETE/LIST to local filesystem. ~80-100 lines. |
| `phpoc-bridge/rclone_bridge.py` | Loader script: interactive provider menu, rclone config, FUSE mount, bridge lifecycle, cleanup. Also provides `status`, `stop`, `reconnect` commands. |
| `phpoc-bridge/setup.py` | One-time setup: detect/install rclone, run rclone config wizard, create PH-Ledger remote folder, save bridge-config.json. |

**Key design decisions (see PHPOC-REACT_WEB-DESIGN_DECISIONS.md §11.28 for full details):**

- **Bridge server has zero rclone awareness** — it reads/writes files. rclone is a separate process managed by the loader.
- **Async cloud sync** — the browser talks to the bridge over LAN (sub-ms). rclone syncs changes to the cloud in the background. The user never waits on cloud latency.
- **40+ providers** — Google Drive, Dropbox, OneDrive, Box, Nextcloud, S3, Backblaze B2, etc. All handled by rclone, zero code per provider.
- **Offline-safe** — the bridge serves from local files. If internet drops, the app still works. Sync resumes when connectivity returns.
- **Perceived speed: <1ms writes** vs 30-80ms for direct cloud API or Cloudflare Worker.

**Why this is the next priority:** It unlocks cloud-backed multi-device sync without deploying a Cloudflare Worker, without writing API adapters, and without managing OAuth flows. Export/Import works today for manual transfer; the rclone bridge makes it automatic.

### 4. Staging CRUD in UI (Dashboard)

Full staging interaction — add/edit/delete entries directly in the Dashboard UI. Currently the UI allows creating new tasks (timed and one-off) and inline editing of tags/comments on Sync/History screens, but there is no way to delete a staging entry or modify title/duration fields from the UI.

### 5. Wire Device Cookie TTL to Re-auth Overlay

The re-auth overlay (`reauthOverlay` state in `App.jsx`) exists but isn't triggered yet. Need to:
- Check `DeviceCookie.isValidLocally()` on app resume / periodic interval
- Pop the `AuthScreen` overlay when TTL expires (30 min default)
- Call `login(passphrase)` on re-auth, which re-derives master key and touches cookie

### 6. Wire Identity Secret into LedgerEngine for Commit Signing

The identity secret is stored during genesis creation but not yet loaded into `LedgerEngine` when commits happen. Update `bootstrapServices` to decrypt `identity_secret_enc_fallback` from the genesis block and cache it for the engine.

- **Duplicate entries in ledger (2026-06-16):** ✅ FIXED. Read-modify-write race condition in `LocalCache.update()` caused committed entries to lose their `committed: true` flag when inline edits (end time, duration, pauses, tags, comments) raced with `markCommitted()`. Fix: `update()` now re-reads from storage immediately before writing, applies changes to the fresh state, and skips the write if the entry was committed or replaced between reads. Three guards: early committed check, index-out-of-range check, entry_id + committed race check. Identified duplicate entries in blocks 93, 94, and 98 (same title, different hash/duration).

## Known Issues
- `HttpTransport.delete()`: `timeoutMs` parameter accepted but unused. `AbortSignal.timeout()` not yet wired.
- MockRemoteBackend `listFiles()` returns full paths; Worker strips prefix to return filenames only. Pre-existing inconsistency.
- ETag caching stale in long-running daemon mode (CLI-only, low priority).
- WASM CryptoService dynamic import (`@vite-ignore`) may fail in dev HMR mode — falls back to DummyCryptoService transparently.
- IndexedDB unavailable in private/incognito browsing — falls back to in-memory storage (`FallbackStorage`), data lost on refresh. Now cached at module level so it survives logout/login within the same session.
- **Ledger merge not yet implemented:** Importing a file with the same genesis as the existing ledger is rejected with "merge is not yet supported." The import code has an open interface at the genesis-check branch for plugging in merge reconciliation logic (decrypt start times, sort entries, rebuild blocks from fork point). Entry hashes are self-contained (computed from `data` dict only, no genesis hash involvement — PHPSPEC §5.4), so entries from divergent ledgers sharing the same genesis can be merged by discarding divergent block wrappers and rebuilding the chain from the fork point.
- **Cross-platform JSON:** JavaScript `JSON.stringify()` and Python `json.dumps()` produce different whitespace and key ordering. The `jsonDumps()` helper in `ledger_import.js` bridges this gap for raw chain verification. Long-term, consider using a single library (e.g., a WASM-based Python `json.dumps` or a cross-platform spec for canonical JSON) to avoid per-platform serializers.
