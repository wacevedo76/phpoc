# PH Ledger — Web/Mobile Build Log

> **Purpose:** What was built, when, and in what order. A durable record of completed work.
> For planned features, see [`ROADMAP.md`](ROADMAP.md).
> For design rationale, see [`PHPOC-REACT_WEB-DESIGN_DECISIONS.md`](PHPOC-REACT_WEB-DESIGN_DECISIONS.md).
> For current session state, see [`../../SESSION_HANDOFF.md`](../../SESSION_HANDOFF.md).

---

## Crypto Core Status

| Layer | CLI (Reference) | Web/Mobile PoC |
|-------|:---------------:|:----------:|
| Rust crypto core (`phpoc-crypto-core`) | ✅ | ✅ 7 modules, 61 tests |
| WASM bindings (20 exports to JS) | N/A | ✅ `wasm.rs` module |
| WASM build target | N/A | ✅ 134K `.wasm` + JS glue + TS types |
| WASM integration test (74 tests) | N/A | ✅ `phpoc-web/test/wasm_integration.mjs` |
| CryptoService wrapper (20 functions) | N/A | ✅ `phpoc-web/src/crypto/index.js` |
| Device identity | ✅ | ✅ `device.rs` module |
| Worker: CORS headers | N/A | ✅ OPTIONS + CORS on all responses |
| Crypto test vector suite | ✅ | ✅ 19 vectors, validated |
| HTTP Transport implementation + test suite (49 tests) | N/A | ✅ GREEN — `phpoc-web/src/sync/transport.js` |
| Core engine (chain, crypto, storage) | ✅ | ✅ 4 modules (Chain 70, Index 36, Summary 49, Engine 111), 266 tests |
| CLI UX (`add`, `view`, `sync`, `verify`) | ✅ | N/A |
| Remote staging sync (port to JS) | ✅ | ✅ SyncService with `checkAndSync()`, `_reconcileAndClaim()`, 60-test suite |
| Auth gate (device cookies port) | ✅ | ✅ DeviceCookie + 14-test suite |
| Cross-device handoff (port) | ✅ | ✅ Merge engine + `_reconcileAndClaim()` |
| Sync modules (storage abstraction) | N/A | ✅ StorageBackend interface + MemoryBackend + IndexedDBBackend |
| Sync modules (local cache) | ✅ | ✅ LocalCache (staging CRUD, pause management, tag normalization) |
| Sync modules (merge engine) | ✅ | ✅ `merge_engine.js` (dedup by entry_id) |
| Sync modules (remote blob) | ✅ | ✅ RemoteSync (pull/push with CryptoService obfuscation) |
| Sync test suite | N/A | ✅ 60 tests covering all 4 layers + edge cases |
| Ledger block sync (port) | ✅ | ✅ LedgerEngine.verify() catches tampered chain |
| Format spec ([`../spec/PHPSPEC.md`](../spec/PHPSPEC.md)) | ✅ | ✅ |

---

## Build Steps

| Step | What | Status | Tests | Completed |
|------|------|--------|-------|-----------|
| 1 | `HttpTransport` — fetch()-based HTTP with ETag caching | ✅ | 49 | — |
| 2 | Sync algorithm port — `checkAndSync()`, auth gate, staging CRUD, merge engine | ✅ | 60 | — |
| 3 | React Web UI — Vite + React 18, 9 screens, dev mode, auth overlay | ✅ | — | — |
| 4 | `StorageBackend` + `HttpBackend` — interface + Transport→StorageBackend adapter | ✅ | 41 | — |
| 5 | Browser import/export via File API | ✅ | 83 | — |
| 6 | **Ledger Engine JS Port + Refactoring** — Chain, Index, Summary, Engine (4 modules, 266 tests) | ✅ | 269 (70+36+49+114) | — |
| 7 | **Onboarding Workflow** — Landing screen, onboarding wizard (Import/New/Export), phase-based lifecycle, IndexedDB seed storage, passphrase auth with PBKDF2, identity fields (username + email), PHPSPEC-compliant genesis block | ✅ | — | — |
| 8 | **History screen — staging vs committed differentiation** — visual badges (Not Committed / Committed), expand/collapse tags & comments, red border for staging, blue when expanded. Inline editing for staging entries: add/remove tags, edit comments. | ✅ | — | — |
| 9 | **Inline tag & comment editing on staging entries** — × on tags to remove, +input to add, editable textarea with debounced auto-save. Committed entries read-only. | ✅ | — | — |
| 10 | **Export works in dev mode** — uses cached master key from bootstrap instead of requiring seed authentication. | ✅ | — | — |
| 11 | **Recovery seed display** — after new ledger creation, full-screen overlay shows base64 seed. "I've saved it" confirm button. Only shown once. | ✅ | — | — |
| 12 | **Logout button** — renamed from "Lock" to "Logout" with exit-door icon. Clears crypto master key, returns to Landing screen. Fixed blank screen bug (hasExistingData) and in-memory data loss on re-login (FallbackStorage caching). | ✅ | — | — |
| 13 | **Sync Screen with Commit UI** — dedicated Sync screen. Uncommitted entries (active + stopped) as compact cards. Stopped: yellow border/syncability indicator, expandable inline tag & comment editing, end-time adjustment (time input with −5m/+5m/+15m quick-adjust), duration editor (1h30m/90m/1.5h formats, accounts for pauses), pause management (list/add/remove pauses with start/end time), delete-from-staging button. Active: red border, compact non-expandable with lock icon. Commit button bar (Commit Selected / Commit All). NOT_SYNCED status. Tag-add Enter key no longer collapses card (stopPropagation fix). | ✅ | — | — |
| 14 | **One-off Task Checkbox** — Dashboard "Start New Task" form: ☐ one-off checkbox. Checked → "Log" button, `isActive: false` + `endEpoch: now`. Unchecked → "Start" button, timed task. Resets after submission. | ✅ | — | — |
| 15 | **Full Ledger Export + Import Interface** — `exportLedgerFull()` v2 format with committed chain + staging, seal over `{ledger, staging}`. Pure read. 72 tests. Import updated for v1/v2 dual-format with `genesisHash` return. Genesis-aware import: same genesis → reject with merge placeholder, different → replace. | ✅ | 72 | — |
| 16 | **History Calendar Widget + Committed Entry Decryption** — Replaced `<input type="date">` with custom inline month calendar (year/month nav, day grid with entry-dot indicators, today highlighting, click-to-filter). Extended `sync.getCompleted()` to decrypt committed entries from `ledger:blocks` via new `_rawCommittedEntryToDTO()` (AES-128-CTR field decryption). Calendar dots and date filtering now work across all committed entries. | ✅ | — | — |
| 17 | **Mock Data Generator** — `scripts/generate_mock_data.py` generates 30 days of realistic staging entries. Weighted weekday/weekend templates, plain: prefix, SHA-256 hashes, UUID4 entry IDs. `--apply` writes to staging.json. 115 entries spanning Jun 4 → Jul 3, 2026. | ✅ | — | Jun 9 2026 |
| 18 | **MockRemoteBackend** — in-browser R2/S3 simulation (IndexedDB, latency, ETags, 404s). 46 tests. | ✅ | 46 | Jun 9 2026 |
| 19 | **MockDataSeeder** — realistic staging data generator for web dev mode. 14 days of entries + cookie + genesis + index. 205 tests. | ✅ | 205 | Jun 9 2026 |
| 20 | **DevModeContext rewired** — DummySyncService replaced with real SyncService + MockRemoteBackend. Real auth gate, cookie setup, entry pull from mock remote. Full-stack simulation in-browser. | ✅ | — | Jun 9 2026 |
| 21 | **HttpBackend + StorageBackend.list + Worker DELETE** — Transport→StorageBackend adapter, `delete()` on HttpTransport/MockRemoteBackend, DELETE handler on Worker. 41 tests. Zero regressions (155 web tests, 270 total). | ✅ | 41 | Jun 9 2026 |
| 22 | **Ledger Engine JS Port + Refactoring** — 4 modules, then 3-phase code review refactoring (16 findings: Modularity, Clarity, Security). 266 tests, 0 failures. Chain (70), Index (36), Summary (49), Engine (111). Shared utilities, proper async, security hardening. | ✅ | 266 | Jun 10-11 2026 |
| 23 | **Onboarding Workflow** — Landing screen, onboarding wizard (Import/New/Export), phase-based lifecycle, IndexedDB seed storage, passphrase auth with PBKDF2. Production mode: `?dev=false` or `defaultDevMode={false}`. | ✅ | — | Jun 11 2026 |
| 24 | **Genesis block creation** — `LedgerChain.buildGenesisBlock()` + `LedgerEngine.init()` producing PHPSPEC §4.1 genesis block with identity, encrypted seed, encrypted identity secret, HMAC seal, and identity signature. Onboarding form collects username + email. | ✅ | — | Jun 11 2026 |
| 25 | **History staging/committed differentiation** — History screen shows status badges (Not Committed / Committed), expand/collapse tags & comments on card click, red border for staging (blue when expanded). `StagingEntry` tracks `committed` + `block_index`. | ✅ | 269 | Jun 11 2026 |
| 26 | **Inline tag & comment editing** — staging entries in History can add/remove tags (× button, +input with Enter) and edit comments (textarea with debounced auto-save). Committed entries read-only. | ✅ | — | Jun 11 2026 |
| 27 | **Export fix (dev mode)** — export uses cached master key when available, skipping seed authentication. Works in both dev and production. | ✅ | — | Jun 11 2026 |
| 28 | **Recovery seed display** — after onboarding, full-screen overlay shows base64 seed with "I've saved it" confirmation. | ✅ | — | Jun 11 2026 |
| 29 | **Logout button** — renamed from Lock to Logout, exit-door icon. Fixed blank screen + in-memory data loss on re-login. | ✅ | — | Jun 11 2026 |
| 30 | **Sync Screen End-Time + Duration Editing** — Expanded stopped entries include `EndTimeEditor` with time input + quick-adjust buttons (−5m, +5m, +15m) and a Duration field accepting `1h30m`, `90m`, `1.5h`, `1:30`, `45` (raw minutes). Duration accounts for pauses. Changing one updates the other. Commits on Enter/blur. | ✅ | — | Jun 16 2026 |
| 31 | **Sync Screen Pause Management** — `PausesEditor` component beneath end-time/duration. Lists existing pauses with start/stop times and duration badge. × button removes each pause. "+ Add pause" opens inline form with start/end time inputs + Save/Cancel. Pauses inserted sorted by start time. Recalculates duration on every pause change. | ✅ | — | Jun 16 2026 |
| 32 | **Sync Screen Enter-Key Fix** — Fixed bug where pressing Enter in the tag-add input collapsed the entire card. Root cause: React keydown event bubbled from the input to the card's `onKeyDown` handler. Fix: `e.stopPropagation()` in `handleTagInputKeyDown` + `onKeyDown={(e) => e.stopPropagation()}` on the expanded details wrapper div. | ✅ | — | Jun 16 2026 |
| 33 | **Duplicate Entry Race Condition Fix** — Fixed read-modify-write race in `LocalCache.update()` that caused committed entries to lose their `committed: true` flag when inline edits raced with `markCommitted()`. Three guards: early committed check, index-out-of-range check, entry_id + committed race check. | ✅ | — | Jun 16 2026 |
| 34 | **Sync Screen Delete-From-Staging Button** — Expanded stopped entries show "🗑 Delete from staging" button that calls `sync.remove()`. Immediate UI update with all editing/selection state cleaned up. | ✅ | — | Jun 16 2026 |
| 35 | **Full Ledger Export** — `exportLedgerFull(blocks, staging, crypto, masterKey)` exports committed chain + staging in v2 format. HMAC seal over {ledger, staging}. Pure read. 72 tests. | ✅ | 72 | Jun 11 2026 |
| 36 | **Import Workflow Enhancement** — Five read-only validation gates before any destructive write. Destroy warning + export offer in confirmation dialog. Staging persistence checkbox. Fixed v2 committed chain loss. Fixed raw chain format detection with Python-compatible JSON serializer (`jsonDumps`). 98 import/export tests. | ✅ | 98 | Jun 11 2026 |
| 37 | **Ledger Merge — GREEN phase** — `LedgerMerge.merge()` implemented in `src/ledger/merge.js`. Standalone module, 7-step algorithm (fork detection, entry extraction, content_hash dedup, alphabetical sort, chain rebuild with summary inserts, index rebuild). Input chain validation (`_verifyChain`/`_verifyBlockData`) runs as Step 0 before fork detection. Ordering tests (J8-J10) prove validation fires before genesis mismatch check. 99 assertions, 0 failures. | ✅ | 99 | Jun 19 2026 |
| 38 | **Remote Sync Wiring — phpoc-web ↔ Cloudflare Worker** — Dual-backend model (local IndexedDB + remote HttpTransport), device UUID persistence (random UUID4 per device, not HMAC-derived), ledger merge strategy (GREEN with input validation + ordering tests), Settings UI with genesis compatibility gate. | ✅ | 149 | Jun 18-20 2026 |
| 38.1 | Genesis Compatibility Gate — Phase 1 RED: `genesis_gate.js` stub + `genesis_gate_test.mjs` (20 tests, all failing). Group A (8): genesis hash comparison. Group B (7): merge on genesis match. Group C (5): edge cases (empty local, format_version mismatch, ETag caching, concurrent dedup, large remote). | ✅ RED | 20 (all fail) | Jun 20 2026 |
| 38.2 | Genesis Compatibility Gate — Phase 2 GREEN: full `check()` implementation. Fetches remote `ledger:blocks`, validates format/type/seals/linkage, compares genesis hashes, delegates to `LedgerMerge.merge()`. In-flight dedup for concurrent calls. 8 reason codes. All 20 TDD tests pass (89 assertions, 0 failures). C2 test corrected (format_version is sealed → different hashes → genesis_mismatch). | ✅ GREEN | 89 (0 fail) | Jun 20 2026 |
| 38.3 | Genesis Gate — Phase 3: Code review (4 criteria passed, 2 minor fixes), Settings UI integration (genesis status indicator on Worker URL save), SyncService integration (`checkAndSync()` gate before blob sync, `GENESIS_MISMATCH` result, cached + skipped when no local ledger), 16 new tests (settings 13 + sync integration 3). Zero regressions across full test suite. | ✅ | 149 (89+13+45+2 new) | Jun 20 2026 |
| 39 | **Connect to Existing Worker — Onboarding Flow** — Fourth onboarding path: enter Worker URL + API key, fetch remote `ledger:blocks`, validate genesis, passphrase verification against pulled genesis, sync staging blobs after auth. Pivoted from bridge server (deferred) — real Worker testing surfaces cross-client concerns that Flutter will need. | ✅ | 65 | Jun 20 2026 |
| 40 | **Remote Import from Cloud Storage** — `WorkerImportSource` wraps `HttpTransport` to list/fetch backup files from `backups/` prefix. OnboardingScreen gains "From Cloud" sub-option (source selection → connect → list → select → auth → import). `importFromCloud()` action: PDK derivation for passphrase-only, direct authenticate fallback. 57-test suite. Zero existing tests modified. | ✅ | 57 | Jun 20 2026 |
| 41.1 | **Multi-Device Auto-Sync Hook — Phase 1 RED**: `useAutoSync.js` stub + `auto_sync_hook_test.mjs` (24 assertions, 22 failing). Group A (6): capture/end/pause/unpause/modify/remove triggers. Group B (2): readEntries + checkAndSync non-triggers. Group C (3): debounce coalescing. Group D (3): error resilience. Group E (2): isSyncing state. Group F (2): no-MK skip. Group G (2): multi-type batch. Group H (2): cleanup/dispose. | 🔴 RED | 22 fail | Jun 20 2026 |
| 41.2 | **Multi-Device Auto-Sync Hook — Phase 2 GREEN**: `createAutoSync()` wraps 6 mutation methods with debounced `pushToRemote()`. `isSyncing()` tracks debounce/push lifecycle. No-MK skip, error resilience (mutations succeed despite push failures), `dispose()` cleanup (cancel debounce, suppress in-flight updates). `getMasterKey()` added to `SyncService` for MK access. React `useAutoSync()` hook: `useRef` instance, interval-based `isSyncing` polling, `useEffect` cleanup on unmount, `useCallback` wrappers. 24 assertions (58 sub-checks), 0 failures. | ✅ GREEN | 58 (0 fail) | Jun 20 2026 |
| 41.3 | **Auto-Sync Hook — Code Review: 6 findings addressed.** (1) `useCallback([])` stale closures → ref-based read at call time. (2) `require('react')` → ES `import`. (3) 100ms polling → push-based `onSyncingChange` callback. (4) `_syncing` never reset on dispose-during-push → unconditional reset in `finally`. (5) Dead `_disposed` check in setTimeout → removed. (6) Silent `{}` fallback → lazy init guarantees instance. Also: `_wrap` → `_wrapMutation`, comment on debounce reset behavior, contract enforcement for `getMasterKey`. Zero regressions. | ✅ | 58 (0 fail) | Jun 20 2026 |
| 42 | **Auto-Sync Wiring — GREEN**: `DevModeContext.jsx` wraps `services.sync` with `createAutoSync()` via `useMemo`-based `effectiveServices` using a Proxy. All 6 mutation methods auto-trigger debounced `pushToRemote()`. Proxy preserves prototype methods (getCompleted, markCommitted, etc.). Cleaned up on unmount. | ✅ | 0 regressions | Jun 20 2026 |
| 43 | **Auth Gate + Status Display + Reauth Overlay Fix**: `checkAndSync()` auth gate: when no local cookie but MK cached, proceed to `_reconcileAndClaim`. Status display: only shows `NOT_SYNCED` when `remoteStatus !== READY`. Reauth overlay: `handleReauth` re-derives MK from passphrase+seed without re-bootstrapping, auto-runs sync, dismisses overlay. Triggered by SyncSettings on REAUTH_NEEDED. | ✅ | 0 regressions | Jun 20 2026 |

---

## Bugs Found and Fixed

### Device UUID Bug (2026-06-18)

The WASM `get_device_id(MK)` returns `HMAC(MK, "device:id")` — deterministic from passphrase (per PHPSPEC §2.8 default). The CLI uses `RandomUUIDDeviceIdentityProvider` which generates and persists a random UUID4. If the web app uses WASM's default, all devices with the same passphrase produce the same device UUID, causing the cookie mechanism to incorrectly treat different devices as the same device (Case A — push only, no merge).

**Fix:** `getOrCreateDeviceUuid(storage)` in `src/sync/device_uuid.js` generates `crypto.randomUUID()` on first boot, persists in IndexedDB, and auto-migrates WASM-derived hex UUIDs. `SyncService._getDeviceId()` now reads from storage first, falls back to WASM only as last resort.

**Follow-up fix (2026-06-18):** `_reconcileAndClaim()` cookie creation was still using `this._crypto.getDeviceId(masterKeyHex)` — the WASM-derived UUID — to populate the remote cookie's `device_uuid` field. Changed to `await this._getDeviceId()`. Without this, the remote cookie always held a WASM UUID while the local device had a UUID4, causing permanent Case B (pull+merge+push) on every sync.

122 tests (22 + 40 + 60) all passing.

### Other Issues

- **Duplicate Entry Race Condition** (Step 33): Fixed read-modify-write race in `LocalCache.update()`. Three guards: early committed check, index-out-of-range check, entry_id + committed race check. (2026-06-16)
- **Sync Screen Enter-Key Bug** (Step 32): Enter in tag-add input collapsed the card. Fixed with `stopPropagation()`. (2026-06-16)
- **Cross-platform JSON:** JavaScript `JSON.stringify()` and Python `json.dumps()` produce different whitespace and key ordering. The `jsonDumps()` helper in `ledger_import.js` bridges this gap for raw chain verification. (2026-06-18)

---

## Remote Sync Wiring — Test Plan

Phase 1 tests written. P1 suites complete, P2 suites pending.

| Suite | What | Priority | Status |
|-------|------|:---:|:---:|
| `test/sync_service_test.mjs` | `SyncService.checkAndSync()` auth gate: READY/OFFLINE/REAUTH_NEEDED with mock transport | P1 | ✅ 40 tests |
| `test/sync_service_test.mjs` | `SyncService._reconcileAndClaim()`: Case A (same UUID → push only) vs Case B (different UUID → pull+merge) | P1 | ✅ |
| `test/device_uuid_test.mjs` | Device UUID generation, IndexedDB persistence, survives refresh/re-login | P1 | ✅ 22 tests |
| `test/remote_transport_test.mjs` | `createRemoteTransport()`: null for standalone/mock/memory, HttpTransport for saas/lan | P2 | ✅ 40 assertions |
| `test/remote_config_test.mjs` | localStorage persistence for deployment, baseUrl, apiKey; URL param priority; fallback to standalone on invalid config | P2 | ✅ 35 tests |

**Existing test coverage:** 512 tests across 14 suites (transport 49, http_backend 41, storage_plugin ~50, sync 60, ledger engine 4 suites 266, mock_remote 46). All green.

---

## Answered Decisions

| Question | Answer |
|----------|--------|
| **API Worker: extend or separate?** | Extend the existing Worker with ~20 lines. No separate service needed. |
| **Auth: API key vs session tokens?** | API key (shared secret) is sufficient. The passphrase is the real auth mechanism — it never leaves the device. |
| **Stateless or stateful API?** | Stateless. The Worker has no session state. Mobile handles cookies and auth locally. |
| **Which platform first?** | **Web (React)** — uses Rust → WASM crypto. **Flutter** follows in Phase 2 (uses Rust → `.a`/`.so` via `flutter_rust_bridge`, zero hand-written FFI). React Native is Phase 3 contingency. |
| **Shared Python SDK?** | Not needed. Every client ports the sync algorithm natively — ~100 lines of branching + crypto calls. |
| **OpenAPI spec?** | Not needed. The wire protocol is three HTTP verbs, fully defined by `core/sync/http_transport.py`. |
| **`POST /sync` endpoint?** | Not needed. Sync runs client-side. The server is not involved. |

---

## References

- `worker/src/index.ts` — Current Cloudflare Worker (~200 lines, dumb blob store)
- `core/sync/http_transport.py` — Python HTTP transport client (wire protocol reference)
- `domain/ledger/remote_sync.py` — Ledger block sync via HTTP (path constants, push/pull logic)
- `domain/staging/remote_sync.py` — Staging blob sync + device cookie (blob obfuscation, cookie format)
- `domain/staging/service.py` — Auth gate, `check_and_sync()`, `_reconcile_and_claim()` (sync algorithm reference)
- [`../spec/PHPSPEC.md`](../spec/PHPSPEC.md) — Format specification (crypto, block structure, key derivation)
- [`../../SESSION_HANDOFF.md`](../../SESSION_HANDOFF.md) — Current state of the project (context restoration anchor)
- `phpoc-web/src/crypto/index.js` — `CryptoService` — singleton WASM wrapper (key cache, ready-guards, all 20 exports)
- `phpoc-web/test/wasm_integration.mjs` — 74-test integration suite (all 20 functions vs test vectors)
