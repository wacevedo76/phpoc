# PH Ledger — Session Handoff

## Current State
- **Branch:** `mobile-poc` (Rust crypto core complete, WASM bindings done, Worker CORS added)
- **Commit (main):** `1c08002`
- **Commit (mobile-poc):** `784c1d0` (➕ Transport test suite, with GREEN implementation)
- **Tests:** 1341 passing, 0 failures (CLI); 61 passing, 0 failures (Rust crypto core); 205 passing, 0 failures (web: 74 WASM + 22 CryptoService + 49 transport + 60 sync)
- **Transport:** HTTP → Cloudflare Worker → R2 (staging blob + 93 ledger blocks + index)
- **Phases:** A (instant reads ✓), B (WAL writes ✓), C (daemon ✓), onboarding ✓
- **Auth gate:** Cookie-only fast path, device_uuid decides pull vs push after auth
- **Re-auth prompting:** All staging-interacting commands now auto-prompt (view, list, tags, add, modify, remove, review, revert, sync)
- **Recovery:** `ph recover` preserves user's seed (same master key), force-pushes re-chained blocks to remote
- **Remote blob:** ✅ 0 entries (empty staging)
- **Remote ledger:** 93 blocks (1 genesis + 90 day + 2 month_summary), 184 entries, Apr 23 → Jun 1
- **Both devices:** x13 (HTTP) and tpx270 (was git, now HTTP) — unified on HTTP
- **Timeouts:** ✅ Per-phase timeouts via pytest-timeout plugin (10s phase tests, 30s transport tests)
- **Mobile roadmap:** `MOBILE_ROADMAP.md` — comprehensive cross-platform plan (web, Flutter, React Native contingency)
- **Mobile PoC progress:**
  - ✅ `phpoc-crypto-core` Rust crate — 7 modules, 61 tests, compiles clean
  - ✅ WASM bindings module (`wasm.rs`) — 20 functions exported to JS
  - ✅ WASM build target — 134K `.wasm` binary + JS glue + TypeScript declarations
  - ✅ Worker CORS headers — all responses wrapped, OPTIONS preflight handled
  - ✅ WASM integration test — `phpoc-web/test/wasm_integration.mjs` — 74 tests, all 20 functions exercised against test vectors + round-trip
  - ✅ `CryptoService` wrapper — `phpoc-web/src/crypto/index.js` — singleton with async init, in-memory key cache, ready-guards, all 20 functions in camelCase
  - ✅ CryptoService smoke test — `phpoc-web/test/crypto_service_smoke.mjs` — 22 tests, singleton lifecycle, key cache, cached-key convenience wrappers, guard
  - ✅ Transport implementation + test suite (TDD GREEN) — `phpoc-web/src/sync/transport.js` — fetch()-based HttpTransport with ETag caching, 49 tests all passing
  - ✅ **Sync algorithm port** — `phpoc-web/src/sync/` — full auth gate (`checkAndSync()`), staging CRUD, device cookie, merge engine, remote blob sync, localStorage abstraction (StorageBackend + IndexedDBBackend). 60-test suite all passing.
- **Docs reorganized:** `docs/design/` for architectural docs, `archive/` for retired docs
- **CLI complete:** All commands have auto-re-auth prompting; CLI is in maintenance mode

## Auth Gate Design — `check_and_sync()` (2026-05-28)

The **device cookie** is the source of truth. Two concepts only: local TTL and specifier comparison. No `CryptoManager`/`_is_auth_fresh()` consulted for auth decisions.

```
┌──────────────────────────────────────────────────────────────┐
│ 1. Remote configured?                                         │
│    No  ──→ READY 🟢                                           │
│    Yes ──→ continue                                            │
└──────────────────────────────┬───────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────┐
│ 2. LOCAL COOKIE CHECK                                         │
│    Read local cookie from disk                                 │
│    ├─ No local cookie ──→ go to AUTH GATE                     │
│    ├─ Expired (TTL)    ──→ go to AUTH GATE                    │
│    └─ Valid ──→ continue to remote cookie check               │
└──────────────────────────────┬───────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────┐
│ 3. REMOTE COOKIE CHECK (fast path, ~50ms)                     │
│    Pull remote cookie from R2                                  │
│    ├─ Unreachable ──→ OFFLINE 🔶 (proceed with local)         │
│    └─ Got remote cookie ──→ compare device_specifier          │
│       ├── Match ──→ READY 🟢 (same device session)            │
│       └── Mismatch ──→ go to AUTH GATE                        │
└──────────────────────────────┬───────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────┐
│ 4. AUTH GATE                                                  │
│    Valid CryptoManager (master_key present)?                    │
│    ├─ No ──→ REAUTH_NEEDED 🔴 (caller prompts)                 │
│    └─ Yes ──→ pull remote cookie (to get device_uuid)         │
│       ├─ Unreachable ──→ OFFLINE 🔶                            │
│       └─ Got remote cookie ──→ compare device_uuid            │
│                                                               │
│       SAME device_uuid:                                        │
│         → Push local blob to remote (local authoritative)      │
│                                                               │
│       DIFFERENT device_uuid:                                   │
│         → Pull remote blob → reconcile (merge into local)      │
│         → Push merged blob to remote                           │
│                                                               │
│       Create new device_specifier, new TTL                     │
│       → Write local cookie                                     │
│       → PUT new remote cookie (overwrites, no destroy)         │
│       → READY 🟢                                               │
└──────────────────────────────────────────────────────────────┘
```

### Cookie format

| Location | Fields | Size |
|----------|--------|------|
| Remote (R2) | `{"device_uuid": "<UUID>", "device_specifier": "<random 32-char hex>"}` | ~200 bytes |
| Local (disk) | `{"device_specifier": "<same>", "creation_time": "<epoch_ms>"}` | ~150 bytes |

Two push paths:
| Method | Used by | Pushes cookie? |
|--------|---------|----------------|
| `push_to_remote()` | Write ops (add/end) | ✅ Yes — new specifier |
| `push_blob_only()` | `ph sync remote_staging` | ❌ No — blob only |

`ph login` now clears both session cache AND local device cookie → next `check_and_sync()` has no local cookie, falls through to auth gate, proceeds with valid CryptoManager.

### Auth Gate invariants

- Blob is **never** pulled before auth — cookie check is always the first remote call
- No `_is_auth_fresh()` or CryptoManager consulted for auth decisions — cookie is the truth
- After auth: same device_uuid = push local (no pull); different = pull+merge+push
- Remote cookie overwritten by PUT (no destroy-then-create race)
- Offline remote → OFFLINE, user proceeds with local data
- No remote configured → READY immediately

## Two Machines

| | x13 (laptop) | tpx270 (was pi/debagent04) |
|---|---|---|
| Device ID | `dc1da321-2c80-4815-a808-11295b8c59f9` | `42ef9447-4676-494b-8241-6154059d5226` |
| Passphrase | ✅ Updated | ✅ Updated |
| Transport | HTTP → Cloudflare Worker | HTTP → Cloudflare Worker (was git → GitHub) |
| API key | ✅ Set | ✅ Set |
| Cookie | ✅ Created | ✅ Created |
| Master key | same | same (shared seed) |
| Ledger blocks | 93 (in sync with remote) | 93 (pulled from remote via hotfix) |
| Remote blob | ✅ 0 entries (empty) | ✅ 0 entries (empty) |
| Remote ledger | 93 blocks, 184 entries, Apr 23 → Jun 1 | ✅ Exact hash match with remote |

## Key Files

### Source Code
| File | Purpose |
|------|---------|
| `main.py` | CLI entry — argparse, auth tiers, staging + orchestrator wiring with re-auth for all commands |
| `cli/interface.py` | `view_active()`, `list_habits()`, `_sync_before_command()` — one sync gate for all commands |
| `cli/strategies.py` | `InteractiveCLIStrategy` — sync confirmation UI |
| `cli/background.py` | Phase A instant reads, background sync check |
| `cli/wal.py` | WAL lifecycle + background push |
| `cli/daemon.py` | PhDaemon lifecycle |
| `cli/onboarding.py` | `ph onboarding` |
| `core/sync/orchestrator.py` | Sync pipeline — staging → ledger → remote |
| `core/sync/http_transport.py` | HTTP GET/PUT/LIST + ETag caching |
| `core/sync/transport.py` | Transport factory from config |
| `domain/staging/service.py` | `check_and_sync()` — the sync gate, device cookie auth |
| `domain/staging/remote_sync.py` | Blob obfuscation, pull/push, cookie pull/push |
| `domain/staging/local_cache.py` | CRUD, plain: prefix convention |
| `domain/staging/merge_engine.py` | Dedup by entry_id |
| `domain/cookie/device_cookie.py` | Random-specifier cookie |
| `domain/ledger/remote_sync.py` | Ledger block push/pull + chain verification |
| `domain/ledger/engine.py` | `LedgerEngine` — commit, revert, blind index |
| `security/auth.py` | `PassphraseAuthenticator`, `RecoveryAuthenticator` |
| `security/crypto.py` | `CryptoManager`, `NoAuthCryptoManager` |
| `security/config_manager.py` | Config with defaults merging + dot-notation |
| `worker/src/index.ts` | Cloudflare Worker (~195 lines TypeScript) — dumb blob store + CORS |
| `scripts/check_staging.sh` | List local staging entries with active status |
| `scripts/check_remote_blob.sh` | Deobfuscate and list remote staging blob entries |
| `scripts/check_remote_ledger.sh` | Count remote ledger blocks and range |
| `scripts/pull_remote_ledger.py` | **HOTFIX** — pull all remote blocks directly, bypassing onboarding |
| `phpoc-web/src/crypto/index.js` | `CryptoService` — singleton wrapper for all 20 WASM exports, key caching, ready-guards |
| `phpoc-web/src/sync/transport.js` | **NEW** — HttpTransport implementation — fetch()-based pull/push/listFiles with ETag caching, `arrayBuffer()` for binary-safe body reads (49 tests). See Step 1 review notes for remaining grooming items. |
| `phpoc-web/test/wasm_integration.mjs` | 74-test integration — all 20 WASM functions, test vectors, round-trips, error cases |
| `phpoc-web/test/crypto_service_smoke.mjs` | 22-test smoke — CryptoService lifecycle, key cache, convenience wrappers |
| `phpoc-web/test/transport_test.mjs` | **NEW** — 49-test transport suite (TDD GREEN: all passing, pull/push/listFiles/ETag/headers/URL/error cases) |
| `phpoc-web/src/context/DevModeContext.jsx` | DevModeProvider — auth bypass via DummyCryptoService + DummySyncService with seeded sample data |
| `phpoc-web/src/services/DummyLedger.js` | DummyCryptoService (all 20 WASM functions, browser-safe) + DummySyncService + factory |
| `phpoc-web/src/hooks/useActiveTasks.js` | Live elapsed timer hook (1s tick, pause-frozen, running-ticking) |
| `phpoc-web/src/components/screens/AuthScreen.jsx` | Passphrase entry screen with dev-mode auto-bypass |
| `phpoc-web/src/components/screens/Dashboard.jsx` | Main screen: active tasks pane + new task form, portrait/landscape layout |
| `phpoc-web/src/components/screens/NewTask.jsx` | Standalone task creation (title, tags, comment) |
| `phpoc-web/src/components/screens/History.jsx` | Completed entries grouped by day, date/tag filter |
| `phpoc-web/src/components/screens/Tags.jsx` | Tag list with counts, sorted by frequency |
| `phpoc-web/src/components/screens/SyncSettings.jsx` | Sync status display + manual sync trigger |
| `phpoc-web/src/components/screens/UserProfile.jsx` | Identity card, auth/key status, stats grid, config gateway |
| `phpoc-web/src/components/screens/Configuration.jsx` | 9 collapsible sections covering all 27 CLI config fields |
| `phpoc-web/src/components/screens/LedgerSync.jsx` | Phase 3 placeholder for block chain commit |
| `phpoc-web/src/components/screens/Settings.jsx` | App settings (dev toggle, remote config, about) |
| `phpoc-web/src/components/layout/AppLayout.jsx` | Bottom tab nav shell with 7 tabs |
| `phpoc-web/src/components/pills/ActiveTaskPill.jsx` | Pill-shaped task button: title top, pause/play left-bottom, stop right-bottom |
| `phpoc-web/src/components/sync/SyncIndicator.jsx` | Sync status badge (🟢🟡🔄🔶🔴) |
| `phpoc-web/src/App.jsx` | Root component: DevModeProvider → auth gate → navigation |
| `phpoc-web/src/App.css` | Complete dark theme (20KB): all screens, pills, forms, tabs, portrait/landscape breakpoints |
| `phpoc-web/vite.config.js` | Vite config with path aliases for @crypto, @sync, @components, @context, @hooks, @services |

### Documentation
| File | Purpose |
|------|---------|
| `SESSION_HANDOFF.md` | This file — current state, auth gate design, known issues |
| `MOBILE_ROADMAP.md` | **NEW** — comprehensive mobile app roadmap (iOS/Android) |
| `PHPSPEC.md` | Format spec — crypto, block structure, key derivation |
| `MAP.md` | File inventory with HOT/COLD annotations |
| `ROADMAP.md` | Project roadmap |
| `CHANGELOG.md` | Release changelog |
| `phpoc-web/test/wasm_integration.mjs` | 74-test WASM integration suite — covers all 20 exports against test vectors |
| `phpoc-web/src/crypto/index.js` | `CryptoService` — singleton WASM wrapper with key cache and ready-guards |
| `phpoc-web/test/crypto_service_smoke.mjs` | 22-test CryptoService smoke test — lifecycle, key cache, convenience wrappers |
| `docs/design/ARCHITECTURAL_DECISIONS.md` | Architectural decisions and rationale |
| `docs/design/DESIGN_GOALS.md` | Design goals and principles |
| `docs/design/DESIGN_MULTI_DEVICE_SESSION.md` | Multi-device session design |
| `PHPOC-REACT_WEB-DESIGN_DECISIONS.md` | React web UI design decisions — screen architecture, dev mode, component tree, navigation, layout, config coverage |
| `docs/design/PH-VIEW-Workflow.md` | ph view workflow diagrams |
| `archive/REMOTE_STAGING_ISSUE_TRACKING.md` | Resolved issue tracking (archived) |
| `archive/ARCHITECTURAL_MIGRATION_STRATEGY.md` | Archived migration strategy |

## Recent Commits
```
784c1d0  feat: CryptoService wrapper for all 20 WASM functions
8f2a9e2  test: WASM integration test — 74 tests exercising all 20 exported functions
87a9f8d  chore: move architectural and design docs into docs/design/
8e5e7df  chore: reorganize root directory — archive retired docs, add mobile roadmap
d04bd79  docs: mark cross-device handoff verified (item #6) and ledger push superseded (item #7)
de06b5e  test: verify cross-device handoff with 3 end-to-end round-trip tests
a4e2b1d  docs: remote blob verified readable; update issue tracking and check script
0ac3621  fix: add per-phase test timeouts via pytest-timeout plugin
5651625  Merge branch 'P3-Remote_Sync' of github.com:wacevedo76/phpoc into P3-Remote_Sync
f10e9e1  fix: auto-prompt for re-auth on all staging-interacting commands
e536cfd  fix: prevent infinite CPU loop in phase4 tests — configure MagicMock prompt_choice return value
94f1c1d  docs: update next step — implement option 1 (mock return_value) for phase4 CPU-lock fix
```

## Resolved Issues

### CPU-Lock Bug: MagicMock View Causes Infinite Loop (2026-05-30)
- **Root cause:** `InteractiveCLIStrategy.decide()` enters `while True` calling `view.prompt_choice()`. A plain `MagicMock()` returns another `MagicMock()` — truthy but matching no exit condition → 100% CPU.
- **Fix:** `view.prompt_choice.return_value = "S"` on MagicMock views in 7 tests (commit `e536cfd`).
- **Result:** All 69 phase4 tests pass in ~0.30s.

### Remote Blob Verification (2026-05-31)
- "Remote blob permanently garbled" was a **false alarm**. Decrypted with master key `00fb89ef...`: valid JSON, 844 bytes, 1 entry.
- Per-phase test timeouts added via `pytest-timeout` (10s/30s tiers) — prevents any future CPU-lock hang.

## This Session (2026-05-28)

### Docs & UX fixes (2026-05-29)

### `ph dev push-status` subcommand
`main.py`: Added `ph dev push-status` diagnostic command showing:
- WAL state (pending or clear)
- Remote blobs found via `list_files()`
- Staging blob path

### Ctrl+C protection on passphrase/seed prompts
`security/auth.py`: Wrapped `getpass.getpass()` and `input()` calls in both
`PassphraseAuthenticator` and `RecoveryAuthenticator` with try/except for
`(KeyboardInterrupt, EOFError)` — prints a newline and returns `False`
cleanly instead of mangling terminal echo on Ctrl+C/Ctrl+D.

### Clean exit on KeyboardInterrupt at top level
`main.py`: Wrapped `main()` call in `if __name__ == "__main__"` with
try/except for `KeyboardInterrupt` and `EOFError` — prints newline and
exits with code 130 instead of dumping a traceback.

### Empty-ledger robustness
`domain/ledger/chain.py`: Added `None` guards in fallback adapters
(`_make_read_blocks_fallback`, `_make_get_block_count_fallback`,
`_make_get_last_block_fallback`) so `LedgerChain` doesn't crash when
`read_ledger()` returns `None` (no ledger.json yet).

`domain/ledger/engine.py`: `_commit_day()` now handles the first-ever
sync when `prev_block is None` — builds a day block with `"0"*64` as
prev_hash and appends it, instead of silently returning.

`storage/file_store.py`: `read_ledger()` kept returning `None` (not `[]`)
so callers can distinguish "empty ledger" from "ledger not yet created."

### NoAuth read commands
`main.py`: Split auth requirements into three tiers:
- `require_auth` (must prompt): `sync`, `verify`, `rep`, `modify`, `review`, `add`
- `read_commands` (cached session or NoAuth): `list`, `view`, `tags`
- Everything else (cached session or NoAuth): `add start/end/pause/unpause`

`cli/interface.py::view_active()`: Wrapped `self._crypto.decrypt(start_val)`
in try/except — skips entries with undecryptable timestamps instead of
crashing, enabling `ph view` / `ph list active` without a passphrase.

### P0 — `_deep_merge` shallow-copy bug
`security/config_manager.py:_deep_merge()` assigned `result[key] = default_val` for non-overridden dict values — shared reference with `ConfigManager.DEFAULTS`. Callers could mutate the class-level defaults globally. Fixed: deep-copy dict values via recursive `_deep_merge(default_val, {})`.

### P2 — `ph recover` leaves old chain on remote
`RemoteLedgerSync.push_blocks()` added `force=True` parameter. When set, existing remote blocks are overwritten instead of skipped by index. `ph recover` in `main.py` now force-pushes all re-chained blocks after recovery.

### P3 — Seed invalidation concern resolved
`RecoveryAuthenticator` already prompts for the user's existing recovery seed. The master key is preserved identically — remote blobs remain decryptable.

### P4 — Latency: redundant `list_files()` calls
`pull_blocks()` and `push_blocks()` each independently called `_list_remote_block_indices()` (2 HTTP `list_files()` calls). Added optional `existing_indices` parameter to both. `SyncOrchestrator._sync_ledger_blocks()` now calls `list_files()` once and shares the result — saves ~100ms per sync.

### `ph login` runtime error
`main.py:428` used `login_staging.READY` / `login_staging.OFFLINE` — `StagingService` doesn't expose those enum-style attrs. Fixed to `SyncCheckResult.READY` / `SyncCheckResult.OFFLINE` (already imported). Commit: `23f510f`.

### Stale-remote bug (blob-before-cookie push order)
`domain/staging/service.py::push_to_remote()` pushed cookie before blob. If cookie push failed, local cookie lost + remote blob stale → reconcile pulled old blob → re-committed duplicates on next sync. Fix: push blob first, then cookie. Cookie failure is soft — cookie mismatch on next check triggers reconcile (self-healing). Commit: `3b67fbc`.

### Mock transport test failures from reorder
Mock `push()` in tests used `transport._blob` for both blob and cookie. Cookie push overwrote blob data. Fixed: route by path — cookie paths → `transport._cookie`, blob paths → `transport._blob`. All 1338 tests pass.

### CLIView wiring — `ph sync` interactive workflow missing
`SyncOrchestrator` was constructed with `view_interface=cli._view if hasattr(cli, '_view') else None` at both construction sites in `main.py`. `CLIInterface` has no `_view` attribute, so `view_interface` was always `None` → `InteractiveCLIStrategy.decide()` was never called → the edit/remove/confirm workflow was silently skipped on every `ph sync`, even without `--yes`.

**Fix:** Replaced with `view_interface=CLIView(ledger)` at both sites. Now `ph sync` (without `--yes`) shows the full interactive workflow:

```
--- Pending Sync ---
  #0: Coding Practice | 2026-05-28 | 09:00-11:00 | 120m
  #1: Walking | 2026-05-28 | 14:00-14:48 | 48m

[S]ync now, [E]dit, [R]emove, [C]ancel, [?] help?
```

`ph sync --yes` still skips straight to commit.

### Ledger deduplication (full repair)
Removed **102 duplicate entries** from 15 entirely-duplicate blocks embedded in the chain. Used crypto-authenticated script (`scripts/repair_ledger_dedup.py`) to:
1. Dedup by (title, duration) per date (encrypted timestamps differ across commits)
2. Remove entire blocks where all entries were duplicates (15 blocks)
3. Trim duplicate entries from mixed blocks (entries with unique content are preserved)
4. Re-seal all blocks with correct `prev_hash` linkage
5. Rebuild blind index from scratch
6. Clean 29 stale staging entries matching already-committed ledger content

**Result**: 63 blocks (down from 83), zero duplicate entries, valid chain linkage. Backups: `ledger.json.bak`, `.bak2`, `.bak3`, `staging.json.bak`.

## Next Steps — Cross-Platform Expansion

The CLI reference implementation is complete at 1341 tests and serves as the anchor platform. The project is now expanding to web and mobile, with the CLI remaining a first-class target alongside them — all platforms share the same wire protocol, crypto, and Worker backend.

### Chosen Direction: Rust Crypto Core, Web Prototype, Flutter Primary

| Phase | Platform | Framework | Crypto Integration | Purpose |
|-------|----------|-----------|-------------------|---------|
| 0 | **All** | Rust crate (`phpoc-crypto-core`) | `ring` (BoringSSL), compiled to WASM + `.a` + `.so` | Implement all crypto primitives once. Validate against `crypto_test_vectors.json`. |
| 1 | **Web** | React (familiarity choice — any WASM-compatible framework works) | Rust → WASM | Prove the interaction model, sync algorithm, and full workflow in a browser. Fastest iteration cycle. |
| 2 | **Mobile (primary)** | **Flutter** | Rust → `.a`/`.so` via `flutter_rust_bridge` (auto-generated Dart bindings, zero hand-written FFI) | Native mobile experience. Biometrics, background sync, platform storage. |
| 3 | **Mobile (contingency)** | React Native | Rust → `.a`/`.so` via TurboModules (hand-written ObjC + Kotlin wrappers, ~50 lines each) | Only if Flutter proves problematic. View layer is a rewrite; model layer (crypto, sync, wire protocol) is shared. |

### Why This Direction

- **Crypto written once.** The Rust library is compiled to every target — WASM (web), `.a` (iOS), `.so` (Android). One implementation to audit, test, and maintain.
- **Web prototype ships first.** The web app runs on a laptop with `npm start`, proving the full workflow (start task, sync, view history) in days, not weeks. Framework choice is pragmatic (React for familiarity) — any WASM-compatible web framework works.
- **Flutter has the cleanest Rust integration.** `flutter_rust_bridge` auto-generates all Dart bindings from the Rust crate — zero hand-written FFI glue. Direct C ABI calls avoid the JS↔Native bridge overhead of React Native.
- **React Native is a contingency, not a commitment.** If Flutter proves problematic, the Rust crypto is already compiled to `.a`/`.so` and ready for RN via TurboModules. The decision to switch requires a documented finding that Flutter blocks a specific feature.
- **Worker stays dumb.** The existing 149-line Worker handles everything — no REST API layer, no session tokens, no server-side sync endpoint.
- **CLI compatibility is automatic.** Every client uses the same wire protocol, storage paths, and crypto as the CLI. Verified by a shared `crypto_test_vectors.json` suite.

### Completed Steps

1. ✅ Extract `crypto_test_vectors.json` from the CLI's existing test suite
2. ✅ Scaffold `phpoc-crypto-core` Rust crate with `ring` bindings — 7 modules, 61 tests
3. ✅ Compile to WASM — 20 functions exported via `wasm.rs` bindings module
4. ✅ Worker CORS headers — all responses wrapped, OPTIONS preflight
5. ✅ WASM integration test — `phpoc-web/test/wasm_integration.mjs` — 74 tests, all 20 functions verified
6. ✅ `CryptoService` wrapper — `phpoc-web/src/crypto/index.js` — singleton, key cache, ready-guards, camelCase API
7. ✅ HTTP Transport wrapper — `phpoc-web/src/sync/transport.js` — fetch()-based pull/push/listFiles with ETag caching, 49 test suite passing
8. ✅ Sync Algorithm Port — full auth gate (`checkAndSync()`), staging CRUD, device cookie, merge engine, remote sync, storage abstraction. 9 modules, 60-test suite.
9. 🔄 Build the React web UI — next: auth screen, dashboard, new task, history

### CLI — Active Cross-Platform Target
- ✅ All 1341 tests pass
- ✅ Auth gate with re-auth prompting for all commands
- ✅ Cross-device handoff verified (3 end-to-end tests)
- ✅ Per-phase timeouts prevent hangs
- ✅ Docs reorganized: `docs/design/` for design docs, `archive/` for retired docs
- 🔄 ETag caching in long-running daemon mode (lower priority, not blocking mobile)

### Mobile PoC — Progress (2026-06-07)
- ✅ Phase 0 complete: `phpoc-crypto-core` Rust crate with all 7 modules, 61 tests
- ✅ WASM bindings: `src/wasm.rs` — 20 `#[wasm_bindgen]` functions exported
- ✅ WASM build: 134K `.wasm` binary, JS glue, TypeScript declarations in `pkg/`
- ✅ Worker CORS: OPTIONS preflight + CORS headers on all responses (~45 lines added)
- ✅ WASM integration test: `phpoc-web/test/wasm_integration.mjs` — 74 tests, all 20 functions verified
- ✅ CryptoService wrapper: `phpoc-web/src/crypto/index.js` — singleton, in-memory key cache, ready-guards, 20 camelCase methods + 5 cached-key convenience wrappers
- ✅ Transport implementation + test suite — `phpoc-web/src/sync/transport.js` — fetch()-based HttpTransport with ETag caching. `phpoc-web/test/transport_test.mjs` — 49 tests covering pull, push, listFiles, ETag caching, error handling, headers, URL construction, cache reset. All passing (TDD GREEN).
- ✅ Sync algorithm port — `phpoc-web/src/sync/` — 9 modules (storage abstraction, IndexedDB backend, device cookie, merge engine, remote sync, local cache, SyncService, barrel export). Full `checkAndSync()` auth gate with fast path, specifier mismatch, TTL expiry, reconcile-and-claim. 60-test suite all passing.
- 🔄 Next: React web UI (auth screen, dashboard, new task, history)

## ~~Critical Open Issue: Wrong Session Key on Both Machines~~ **RESOLVED — Misdiagnosis**

**Status:** Resolved 2026-05-29. There is NO wrong-session-key bug.

**Background:** Both machines cached session key
`00fb89ef9116b5e0899bd8b1d3fc4763efc9a2345e85c5f0651e578905a6794d`
after `ph login`. This key was initially diagnosed as a "PDK that cannot
decrypt the Sovereign Seed" because `CryptoManager(key).decrypt(enc_seed)`
failed.

**Root cause of misdiagnosis:** The master key is NOT supposed to decrypt

the seed. The PDK (passphrase-derived key) decrypts the seed, and the
seed's decoded bytes ARE the master key. Testing `CryptoManager(mk).decrypt(enc_seed)`
was the wrong test — it expected the master key to decrypt the seed, but
that's not the protocol.

**Verification (2026-05-29):**
1. `ph login` with the correct passphrase produced PDK `ce08b69f...`
2. The 600K PDK successfully decrypted `recovery_seed_enc`
3. `RecoveryManager.seed_to_key(seed)` returned `00fb89ef...`
4. The master key `00fb89ef...` correctly decrypts ledger entries,
   staging blob, and identity secret

**Lesson:** `authenticate()` was working correctly all along. The session
handoff's debug script tested the wrong thing. The cached key WAS the
correct master key — it was never supposed to decrypt the seed.

**Improvement made:** Added 100K PBKDF2 fallback in `authenticate()` for
ledgers created before commit `e25a26c` (2026-04-28), which bumped
iterations from 100,000 to 600,000. Without this fallback, pre-R3 genesis
blocks would fail to decrypt despite the correct passphrase.

## Known Issues
- ETag caching stale in long-running daemon mode (low priority, not a current issue)
- 100K PBKDF2 fallback for pre-R3 genesis blocks — added in commit `3002952` for backward compatibility
- Pre-R3 ledgers created before commit `e25a26c` (2026-04-28) use 100K iterations instead of 600K

## Hotfix: `ph onboarding` Fails to Pull Remote Ledger — Direct Pull Script

**Issue:** On tpx270, after deleting the local ledger and running `ph onboarding`,
the local ledger was NOT replaced with the remote chain. The old 90-block divergent
chain persisted. Root cause: onboarding either encountered an auth failure (wrong seed)
or the "Overwrite? (y/N)" prompt was answered "n".

**Root cause of divergence:** tpx270 was originally configured with **git transport**
(`git@github.com:wacevedo76/phpoc-staging.git`) while x13 used **HTTP transport**
(Cloudflare Worker). The two backends received different data. After switching tpx270
to HTTP transport, the chains had already diverged at block 19 (2026-05-02). The remote
chain has an extra empty genesis block at index 0, creating a 1-index offset: remote
blocks 1-89 = local blocks 0-88 (matching content), but the chains split at block 19
where remote has 0 entries vs local has 1 entry.

**Resolution:** A direct pull script (`scripts/pull_remote_ledger.py`) was created to
bypass onboarding and pull all remote blocks directly using the cached session key.

**Steps if this happens again:**

```bash
# 1. Ensure authenticated session
ph login

# 2. Run the direct pull script (bypasses onboarding entirely)
python3 scripts/pull_remote_ledger.py

# 3. Fix staging format (remote blob is dict, local store expects list)
echo '[]' > ~/.local/share/phpoc/staging.json

# 4. Verify
ph verify          # Should be True
ph list synced     # Should show data through Jun 1
ph sync --yes      # Clean sync (no pending entries)
```

**Long-term fix needed:** `ph onboarding` should be hardened to:
1. Better handle the "Overwrite?" prompt (default to yes if no ledger exists)
2. Show progress during block pull
3. Fall back gracefully when chains diverge (force-pull from remote)
4. `scripts/pull_remote_ledger.py` should be merged into onboarding as `ph onboarding --force`

---

## Context Loading Reference (`/new`)

When starting a fresh context with `/new`, the following files should be loaded in order. The document you're reading (`SESSION_HANDOFF.md`) is always the entry point — it captures the current state, direction, and key decisions.

### Always Load (core context)

| Order | File | Purpose |
|-------|------|---------|
| 1 | `SESSION_HANDOFF.md` | **This file.** Current state, auth gate design, cross-platform direction, recent fixes. Always load first. |
| 2 | `PHPSPEC.md` | Format specification — crypto primitives, block structure, key derivation, blob obfuscation. Required for any crypto, sync, or wire protocol work. |
| 3 | `docs/design/CROSS_PLATFORM_ARCHITECTURAL_DECISIONS.md` | Full architectural rationale for the Rust crypto core, dumb Worker, and cross-platform strategy. |
| 4 | `MOBILE_ROADMAP.md` | Detailed phased plan: Web (React) → Flutter (primary mobile) → React Native (contingency). Prerequisites, build targets, platform-specific features. |
| 5 | `PHPOC-REACT_WEB-DESIGN_DECISIONS.md` | React web UI design decisions — screen architecture, dev mode, component tree, navigation, layout, CLI config coverage. Read when working on the React web UI. |
| 6 | `VISION.md` | Project vision and philosophy — "know thyself," zero-knowledge, platform independence. Read for design alignment. |

### Load When Relevant

| File | When to Read |
|------|--------------|
| `MAP.md` | Navigating source code — file inventory with HOT/COLD annotations. Read when you need to find where something lives. |
| `docs/design/DESIGN_GOALS.md` | Making design decisions that affect the ledger, sync, or user experience. Clarifies principles and non-goals. |
| `docs/design/ARCHITECTURAL_DECISIONS.md` | Original architectural decisions (pre-dates the cross-platform pivot). Read for historical context on CLI-era choices. |
| `docs/design/DESIGN_MULTI_DEVICE_SESSION.md` | Multi-device session design details. Read when working on device cookie, auth gate, or cross-device reconciliation. |
| `ROADMAP.md` | High-level project roadmap. Read for milestone awareness. |
| `CHANGELOG.md` | Release history. Read to understand what changed and when. |
| `BACKLOG.md` | Project backlog. Read if picking up a new task or checking what's planned. |
| `docs/design/PH-VIEW-Workflow.md` / `ph-view-workflow-updated.md` | Workflow diagrams for the CLI view command. Read when working on UI equivalents. |

### Source Files by Layer (read when modifying)

## Next Steps — Immediate

The crypto layer is complete and verified. The next work is the web platform layer:

### Step 1: HTTP Transport Wrapper ✅

Port `core/sync/http_transport.py` to JS:
- `fetch()`-based `pull(path)`, `push(path, data)`, `listFiles(prefix)`
- ETag caching (conditional GET with `If-None-Match`, 304 returns cached body, push clears path cache)
- CORS-compatible (Worker already has CORS headers)
- Constructor validates baseUrl (non-empty, http/https scheme), normalizes trailing slash
- `X-Api-Key` header on all requests when configured
- Binary-safe body reading via `response.arrayBuffer()` → `new Uint8Array()` — preserves encrypted/obfuscated bytes exactly, no UTF-8 decode risk
- URL construction handles base URLs with sub-paths
- File: `phpoc-web/src/sync/transport.js`
- Tests: `phpoc-web/test/transport_test.mjs` — 49 tests, all passing
- Refs: `core/sync/http_transport.py`, `domain/staging/remote_sync.py` (path constants)
- **Status:** ✅ DONE — 49/49 tests passing. Ready for sync algorithm port.

**Review notes (grooming):**
- `timeoutMs` parameter is accepted but unused. Async orchestration in SyncService prevents UI blocking, but transport should still wire `AbortSignal.timeout(ms)` as a circuit breaker for background retry loops (prevents stalled socket leaks).
- Error messages include raw `err.message` from fetch (can leak internal IPs in `ECONNREFUSED`). Not a transport concern — error sanitization belongs at SyncService → UI boundary.
- ✅ **Resolved:** `text()`+`charCodeAt` O(n) loop → `response.arrayBuffer()`. Body reading now uses native binary API with zero JS loop. See commit notes.

### Step 2: Sync Algorithm Port (`check_and_sync()`) ✅

Port the auth gate logic from `domain/staging/service.py` to JS. Full implementation with 60-test suite, all passing.

**Files created (9 modules):**
- `phpoc-web/src/sync/storage.js` — `StorageBackend` interface + `MemoryBackend` for testing
- `phpoc-web/src/sync/indexeddb_storage.js` — `IndexedDBBackend` via `idb-keyval` (browser production storage)
- `phpoc-web/src/sync/cookie.js` — `DeviceCookie` static methods (create, validate TTL, parse remote, match specifiers, destroy)
- `phpoc-web/src/sync/merge_engine.js` — `mergeEntries()` pure function (dedup by `entry_id` or fallback `(title, start_epoch)`)
- `phpoc-web/src/sync/remote_sync.js` — `RemoteSync` (blob pull/push with CryptoService obfuscation, cookie pull/push, reachability check)
- `phpoc-web/src/sync/local_cache.js` — `LocalCache` (staging CRUD, pause management, tag normalization, SHA-256 hashing via WASM)
- `phpoc-web/src/sync/sync.js` — `SyncService` with full `checkAndSync()` auth gate, `_reconcileAndClaim()`, `pushToRemote()`, `pushBlobOnly()`, plus all local CRUD methods (capture/end/pause/unpause/modify/remove)
- `phpoc-web/src/sync/index.js` — barrel export
- `phpoc-web/test/sync_test.mjs` — 60 tests: 14 merge, 14 cookie, 22 local cache, 10 remote sync

**Architecture:**
```
SyncService
  ├── LocalCache         → StorageBackend (IndexedDBBackend / MemoryBackend)
  ├── RemoteSync         → HttpTransport + CryptoService
  ├── DeviceCookie       → StorageBackend + CryptoService
  └── mergeEntries()     → pure function
```

**Auth gate flow (ported faithfully from CLI reference):**
```
checkAndSync():
  ├─ No remote?                    → READY
  ├─ Local cookie valid?
  │   ├─ Pull remote cookie
  │   │   ├─ Match specifier      → push blob + touch cookie → READY
  │   │   ├─ Mismatch             → REAUTH_NEEDED
  │   │   └─ No cookie/unparseable → continue
  │   └─ Unreachable              → OFFLINE
  ├─ No local cookie / expired    → REAUTH_NEEDED
  ├─ No remote cookie (have MK)   → _reconcileAndClaim()
  │   ├─ Same device_uuid         → push blob, touch cookie → READY
  │   └─ Different / first time   → pull blob → deobfuscate → merge → push → new cookie → READY
  └─ No remote cookie (no MK)     → REAUTH_NEEDED
```

**Key design decisions:**
- Storage abstraction via `StorageBackend` — SyncService never touches IndexedDB directly. Flutter implements same `get/set/remove/clear` contract.
- Blob obfuscation delegated to `CryptoService` (Rust WASM) — not reimplemented in JS.
- No `plain:` prefix convention — entries stored as plain JS objects. Encryption only at the remote boundary.
- WASM-free test path — `MemoryBackend` + `MockCrypto` allow full CI without WASM binary.
- `idb-keyval` dependency added (npm) for IndexedDB wrapper.

**Status:** ✅ DONE — 60/60 tests passing. Ready for React UI.

### Step 3: React Web UI Scaffold ✅

Scaffolded Vite + React 18 project with 9 screen components, DevModeContext for auth bypass, dashboard with portrait/landscape layout, and bottom tab navigation. All 14 modules compile cleanly.

**Screens implemented:**
- **AuthScreen** — passphrase entry with dev-mode auto-bypass (300ms transition)
- **Dashboard** — main screen: active tasks (top/left) + new task form (bottom/right)
- **ActiveTaskPill** — pill-shaped task button: title top, pause/play left-bottom, stop right-bottom
- **NewTask** — standalone task creation with title, tags, comment
- **History** — completed entries grouped by day, date/tag filter
- **Tags** — tag list with counts per tag
- **SyncSettings** — sync status display + manual sync trigger
- **UserProfile** — identity card, auth/key status, stats grid, configuration gateway
- **Configuration** — 9 collapsible sections covering all 27 CLI config fields with range/toggle/select/text inputs
- **LedgerSync** — phase 3 placeholder

**Cross-cutting:**
- **DevModeContext** — context provider with `dev`/`production` modes, auto-provisions DummyCryptoService + DummySyncService with seeded sample data
- **AppLayout** — bottom tab nav with 7 tabs (Home, History, New, Tags, Profile, Sync, Settings)
- **SyncIndicator** — status badge (🟢🟡🔄🔶🔴)
- **useActiveTasks** — custom hook with 1-second tick for live elapsed timers
- **DummyLedger** — DummyCryptoService (browser-compatible, no WASM needed) + DummySyncService with 4 pre-seeded entries

**Design decisions documented in:** `PHPOC-REACT_WEB-DESIGN_DECISIONS.md`

**Next:** wire real SyncService into production mode, implement ledger sync (commit blocks, chain verification), Flutter port.

| Layer | Key Files | What They Do |
|-------|-----------|--------------|
| CLI entry | `main.py` | Argparse, auth tiers, command wiring. Only modify if adding CLI commands. |
| Sync algorithm | `domain/staging/service.py` | `check_and_sync()` — the auth gate, blob pull/push, reconcile. Ported to every platform. |
| Wire protocol | `core/sync/http_transport.py` | HTTP GET/PUT/LIST + ETag. Reference for all client implementations. |
| Staging blob | `domain/staging/remote_sync.py` | Blob obfuscation, device cookie, push/pull. |
| Ledger chain | `domain/ledger/chain.py` | Block chain building, sealing, verification. |
| Ledger sync | `domain/ledger/remote_sync.py` | Ledger block push/pull, path constants. |
| Cookie | `domain/cookie/device_cookie.py` | Device specifier format, TTL. |
| Merge engine | `domain/staging/merge_engine.py` | Cross-device dedup by `entry_id`. |
| Crypto | `security/crypto.py` | `CryptoManager`, encrypt/decrypt wrappers. The Rust `phpoc-crypto-core` replaces this for non-CLI platforms. |
| Worker | `worker/src/index.ts` | Cloudflare Worker (149-line dumb blob store). Extend with caution — keep it dumb. |
| **Web: Crypto** | `phpoc-web/src/crypto/index.js` | `CryptoService` — singleton WASM wrapper, key cache, 20 methods + 5 cached-key convenience wrappers. |
| **Web: Transport** | `phpoc-web/src/sync/transport.js` | ✅ `fetch()`-based HTTP transport with ETag caching. 49 tests passing. |
| **Web: Sync (9 modules)** | `phpoc-web/src/sync/` — `sync.js`, `cookie.js`, `remote_sync.js`, `merge_engine.js`, `local_cache.js`, `storage.js`, `indexeddb_storage.js`, `index.js` | ✅ **DONE** — Full auth gate port (`checkAndSync()`), staging CRUD, device cookie, merge engine, remote sync. 60 tests all passing. Prerequisites: CryptoService + HttpTransport (both ✅). |
| **Web: UI (14 modules)** | `phpoc-web/src/` — see `PHPOC-REACT_WEB-DESIGN_DECISIONS.md` and file tree below | ✅ **DONE** — Vite + React 18 scaffold, 9 screen components, DevModeContext auth bypass, DummyLedger, dashboard, bottom tab nav. All compile clean. |
