# PH Ledger — Session Handoff

## Current State
- **Branch:** `mobile-poc` (Rust crypto core complete, WASM bindings done, Worker CORS added, HttpBackend complete)
- **Commit (mobile-poc):** `784c1d0` (➕ Transport test suite, with GREEN implementation)
- **Web tests:** 270 passing, 0 failures (49 transport + 46 mock_remote + 60 sync + 74 wasm + 41 http_backend)
- **Transport:** HTTP → Cloudflare Worker → R2 (staging blob + ledger blocks + index)
- **Auth gate:** Cookie-only fast path, device_uuid decides pull vs push after auth (ported to JS)
- **CLI:** In maintenance mode — 1341 tests, fully functional, not actively worked on
- **Mobile roadmap:** `MOBILE_ROADMAP.md` — comprehensive cross-platform plan (web, Flutter, React Native contingency)

### Web Platform Progress
- ✅ `phpoc-crypto-core` Rust crate — 7 modules, 61 tests, compiles clean
- ✅ WASM bindings — 20 functions exported via `wasm.rs`, 134K `.wasm` binary + JS glue + TS types
- ✅ Worker CORS + DELETE — all responses wrapped, OPTIONS preflight, 3 HTTP verbs (GET/PUT/DELETE)
- ✅ `CryptoService` wrapper — singleton, key cache, ready-guards, all 20 functions in camelCase (22 smoke tests)
- ✅ `HttpTransport` — fetch()-based pull/push/listFiles/delete/resetCache with ETag caching (49 tests)
- ✅ **Sync algorithm port** — full `checkAndSync()` auth gate, staging CRUD, device cookie, merge engine, remote sync, storage abstraction (9 modules, 60 tests)
- ✅ **MockRemoteBackend** — in-browser R2/S3 simulation (IndexedDB-backed, latency, ETags, 404s, error simulation, 46 tests)
- ✅ **MockDataSeeder** — 14 days of realistic staging entries + cookie + genesis + index (205 tests)
- ✅ **DevModeContext rewired** — real SyncService + MockRemoteBackend + MockDataSeeder (no more DummySyncService)
- ✅ **StorageBackend interface** — abstract class with get/set/remove/clear/list + MemoryBackend + IndexedDBBackend
- ✅ **HttpBackend** — Transport→StorageBackend adapter wrapping pull/push/delete/listFiles into get/set/remove/list (41 tests)
- ✅ **React Web UI** — Vite + React 18, 9 screen components, bottom tab nav, dark theme
- ✅ **Auth overlay** — full-screen on first launch, blurred-backdrop overlay on re-auth, Lock button on bottom nav + Profile
- 🔄 Next: Browser import/export via File API, ledger engine JS port, companion bridge server, import wizard UI

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

### Auth Gate invariants

- Blob is **never** pulled before auth — cookie check is always the first remote call
- No `_is_auth_fresh()` or CryptoManager consulted for auth decisions — cookie is the truth
- After auth: same device_uuid = push local (no pull); different = pull+merge+push
- Remote cookie overwritten by PUT (no destroy-then-create race)
- Offline remote → OFFLINE, user proceeds with local data
- No remote configured → READY immediately

## Key Files

### Web Platform (active development)
| File | Purpose |
|------|---------|
| `phpoc-web/src/sync/transport.js` | `HttpTransport` — fetch()-based HTTP with ETag caching, pull/push/listFiles/delete |
| `phpoc-web/src/sync/http_backend.js` | `HttpBackend` — Transport→StorageBackend adapter (41 tests) |
| `phpoc-web/src/sync/storage.js` | `StorageBackend` interface + `MemoryBackend` |
| `phpoc-web/src/sync/indexeddb_storage.js` | `IndexedDBBackend` via idb-keyval |
| `phpoc-web/src/sync/mock_remote.js` | `MockRemoteBackend` — in-browser R2 simulation |
| `phpoc-web/src/sync/sync.js` | `SyncService` — full checkAndSync() auth gate, staging CRUD |
| `phpoc-web/src/sync/cookie.js` | `DeviceCookie` — create, validate TTL, match specifiers |
| `phpoc-web/src/sync/merge_engine.js` | `mergeEntries()` — dedup by entry_id |
| `phpoc-web/src/sync/remote_sync.js` | `RemoteSync` — blob pull/push with CryptoService obfuscation |
| `phpoc-web/src/sync/local_cache.js` | `LocalCache` — staging CRUD, pause mgmt, SHA-256 via WASM |
| `phpoc-web/src/crypto/index.js` | `CryptoService` — singleton WASM wrapper, 20 functions |
| `phpoc-web/src/services/MockDataSeeder.js` | Generates 14 days realistic staging data |
| `phpoc-web/src/services/DummyLedger.js` | DummyCryptoService + DummySyncService |
| `phpoc-web/src/context/DevModeContext.jsx` | Dev mode provider — real SyncService + mock remote |
| `phpoc-web/src/components/screens/*.jsx` | 9 screen components (Auth, Dashboard, History, etc.) |
| `phpoc-web/src/components/layout/AppLayout.jsx` | Bottom tab nav shell with 7 tabs + Lock button |
| `phpoc-web/src/App.jsx` | Root — DevModeProvider → auth gate → navigation |
| `phpoc-web/src/App.css` | Dark theme, portrait/landscape breakpoints |
| `phpoc-web/test/transport_test.mjs` | 49 tests — HttpTransport |
| `phpoc-web/test/http_backend_test.mjs` | 41 tests — HttpBackend |
| `phpoc-web/test/mock_remote_test.mjs` | 46 tests — MockRemoteBackend |
| `phpoc-web/test/sync_test.mjs` | 60 tests — full sync algorithm |
| `phpoc-web/test/wasm_integration.mjs` | 74 tests — all 20 WASM exports |
| `phpoc-web/test/crypto_service_smoke.mjs` | 22 tests — CryptoService lifecycle |

### Cross-Platform (reference)
| File | Purpose |
|------|---------|
| `worker/src/index.ts` | Cloudflare Worker (~200 lines) — GET/PUT/DELETE/LIST + CORS, dumb blob store |
| `phpoc-crypto-core/` | Rust crate — all crypto primitives, compiled to WASM |
| `core/sync/http_transport.py` | CLI reference: HTTP GET/PUT/LIST + ETag (wire protocol spec) |
| `domain/staging/service.py` | CLI reference: `check_and_sync()` — the auth gate algorithm |
| `domain/staging/remote_sync.py` | CLI reference: blob obfuscation, device cookie, path constants |
| `domain/staging/merge_engine.py` | CLI reference: cross-device dedup by entry_id |
| `domain/cookie/device_cookie.py` | CLI reference: device specifier format, TTL |

### Documentation
| File | Purpose |
|------|---------|
| `SESSION_HANDOFF.md` | This file — current state, auth gate, known issues |
| `MOBILE_ROADMAP.md` | Mobile app roadmap (iOS/Android/Web) |
| `PHPSPEC.md` | Format spec — crypto, block structure, key derivation |
| `MAP.md` | File inventory with HOT/COLD annotations |
| `PHPOC-REACT_WEB-DESIGN_DECISIONS.md` | React web UI design decisions |
| `docs/design/CROSS_PLATFORM_ARCHITECTURAL_DECISIONS.md` | Rust crypto core rationale |
| `docs/design/ARCHITECTURAL_DECISIONS.md` | Original CLI-era architectural decisions |
| `docs/design/DESIGN_GOALS.md` | Design goals and principles |
| `docs/design/DESIGN_MULTI_DEVICE_SESSION.md` | Multi-device session design |
| `ROADMAP.md` | Project roadmap |
| `CHANGELOG.md` | Release changelog |

## This Session (2026-06-09)

### Browser Import/Export via File API — Design Decisions

**What:** Browser-native import/export of the user's ledger via File API. Entry data only — no cookie, no device identity, no app metadata.

**Auth gate:** Both import and export require passphrase entry. Passphrase → `crypto.authenticate()` → master key. In dev mode (DummyCryptoService), any passphrase is accepted — UX convention. When real WASM crypto is wired (Step 9), it becomes real authentication.

**Integrity:**
- File sealed via HMAC-SHA256 (`crypto.computeSeal`/`verifySeal`, PHPSPEC §5.2 key derivation path)
- Seal covers `JSON.stringify(entries)` only — file wrapper metadata (`exported_at`, `format_version`) sits outside seal
- Import re-verifies seal, then re-computes each entry's hash
- Any verification failure → reject entirely, no partial import

**Key decisions:**
- Ledger = entries only. No cookie, no device metadata.
- Import overwrites local entries entirely (no merge)
- `exported_at` is informational for user transparency (backup log), not part of ledger
- `format_version` allows evolution (entries-only now, ledger blocks in v2)
- Active task flags preserved as-is on import
- Passphrase prompt: lightweight modal overlay (reuses AuthScreen overlay pattern)

**UI:** New Backup & Restore section in Settings with Export/Import buttons.

**Implementation order (TDD):**
1. `ledger_export.js` — exportLedger(storage, crypto, masterKey) → Blob
2. `ledger_import.js` — importLedger(storage, crypto, masterKey, file) → imported count
3. `PassphraseModal.jsx` — reusable passphrase prompt overlay
4. Settings screen: Backup & Restore section with Export/Import buttons
5. TDD test suites: `test/ledger_export_test.mjs`, `test/ledger_import_test.mjs`, `test/passphrase_modal_test.mjs`

Design documented in: `PHPOC-REACT_WEB-DESIGN_DECISIONS.md` §11.11

### HttpBackend — Transport→StorageBackend Adapter (TDD, 41 tests)

**What:** `HttpBackend` wraps a Transport (HttpTransport or MockRemoteBackend) to conform to the StorageBackend interface. Bridges binary blob I/O (Uint8Array) to structured key-value storage (JSON-serializable values).

**Files created/modified:**
- `phpoc-web/src/sync/http_backend.js` — **NEW** — HttpBackend class (87 LOC, 5 public methods)
- `phpoc-web/src/sync/storage.js` — Added `list(prefix)` to StorageBackend + MemoryBackend
- `phpoc-web/src/sync/transport.js` — Added `delete(path)` to HttpTransport (maps to HTTP DELETE)
- `phpoc-web/src/sync/mock_remote.js` — Added `delete(path)` to MockRemoteBackend
- `phpoc-web/src/sync/index.js` — Added HttpBackend to barrel export
- `phpoc-web/test/http_backend_test.mjs` — **NEW** — 41-test TDD suite
- `worker/src/index.ts` — Added DELETE handler + CORS method

**Architecture:**
```
StorageBackend (structured JSON values)
  └── HttpBackend { transport }
        ├── get(key)    → pull(key)    → decode bytes → JSON.parse
        ├── set(key,v)  → JSON.stringify → encode → push(key, bytes)
        ├── remove(key) → delete(key)
        ├── clear()     → throws (remote is shared)
        └── list(prefix)→ listFiles(prefix)
              │
        Transport (binary Uint8Array)
              ├── HttpTransport    (production: fetch→Worker→R2)
              └── MockRemoteBackend (development: IndexedDB)
```

**Test results:** 41/41 passing. Zero regressions in 155 existing web tests (49 transport + 46 mock_remote + 60 sync).

**Review findings:**
- Modularity ✅ — single responsibility, dependency injection, no coupling to core sync
- Security ✅ — JSON.parse (not eval), idempotent DELETE, same auth as GET/PUT
- Clarity ✅ — JSDoc on every method, error messages include class + method
- Notable: MockRemoteBackend.listFiles returns full paths, Worker strips prefix — pre-existing inconsistency, HttpBackend passes through faithfully

### Architecture Decision — Multi-Deployment StoragePlugin

**Decision:** phpoc-web supports four deployment targets from a single codebase, selected at startup via config.

| Deployment | Storage Backend | Multi-user |
|-----------|----------------|------------|
| **Standalone PWA** | IndexedDB | Single user |
| **Local network / LAN** | Companion bridge server (HTTP → filesystem) | Single user |
| **Docker / LXC** | Bridge server bundled in container | Single user |
| **SaaS** | Cloudflare Worker → R2 (multi-tenant) | Multi-tenant |

The key interface is `StorageBackend` / `HttpBackend` — the UI and sync logic are deployment-agnostic. Only the backend changes.

```
phpoc-web (React)
  ├── SyncService / LedgerEngine (same logic)
  │     └── StorageBackend (interface)
  │           ├── IndexedDBBackend (standalone)
  │           ├── HttpBackend (bridge server or Worker)
  │           ├── MemoryBackend (testing)
  │           └── MockRemoteBackend (dev, simulates R2)
  └── Browser File API (import/export — free, no server)
```

**Status:**
- ✅ `StorageBackend` interface (get/set/remove/clear/list) — `storage.js`
- ✅ `MemoryBackend` — in-memory Map for testing
- ✅ `IndexedDBBackend` — browser production storage via idb-keyval
- ✅ `HttpBackend` — wraps HttpTransport/MockRemoteBackend as StorageBackend (41 tests)
- ✅ `MockRemoteBackend` — in-browser R2/S3 simulation (46 tests)
- ❌ Config-driven factory (`createStoragePlugin()`) — not yet wired
- ❌ Companion bridge server (Python, ~50 lines) — not started
- ❌ Dockerfile (nginx + bridge server) — not started
- ❌ Multi-tenant Worker (user isolation) + registration — not started

### Mock Ledger Data Generator
`scripts/generate_mock_data.py`: Generates one month of realistic staging entries for development/testing. Features:
- 30-day schedule with weighted random activities
- Weekday/weekend templates with different routines
- Uses `plain:` prefix convention so data is readable without auth
- `--apply`, `--days`, `--start-date`, `--seed`, `--avg-entries` flags
- Backward compatible: appends to existing staging entries instead of overwriting

### Auth Overlay — Re-auth While App Is Running
**Files changed:**
- `phpoc-web/src/App.jsx` — `hasBeenAuthenticated` tracking. First launch → full-screen AuthScreen. Re-auth → overlay.
- `phpoc-web/src/components/screens/AuthScreen.jsx` — `overlay` prop with backdrop blur + pop-in animation.
- `phpoc-web/src/components/screens/UserProfile.jsx` — "🔒 Lock & Re-authenticate" button.
- `phpoc-web/src/components/layout/AppLayout.jsx` — Lock button as last nav item with visual divider.
- `phpoc-web/src/App.css` — `.auth-overlay`, `.auth-overlay-card`, `.btn-danger`, `.nav-separator` styles.

## ~~Critical Open Issue: Wrong Session Key on Both Machines~~ **RESOLVED — Misdiagnosis**

**Status:** Resolved 2026-05-29. No wrong-session-key bug. The master key is NOT supposed to decrypt the seed — the PDK does. Testing `CryptoManager(mk).decrypt(enc_seed)` was the wrong test.

**Lesson:** `authenticate()` was working correctly all along. The session handoff's debug script tested the wrong thing.

**Improvement:** Added 100K PBKDF2 fallback for pre-R3 genesis blocks (commits before `e25a26c`, 2026-04-28, which bumped iterations from 100K→600K).

## Known Issues
- `HttpTransport.delete()`: `timeoutMs` parameter accepted but unused (same as pull/push). `AbortSignal.timeout(ms)` not yet wired. Existing limitation — not a regression.
- MockRemoteBackend `listFiles()` returns full paths; Worker strips prefix to return filenames only. Pre-existing inconsistency.
- ETag caching stale in long-running daemon mode (CLI-only, low priority, not blocking web/mobile).

---

## Context Loading Reference (`/new`)

When starting a fresh context with `/new`, the following files should be loaded in order.

### Always Load (core context)

| Order | File | Purpose |
|-------|------|---------|
| 1 | `SESSION_HANDOFF.md` | **This file.** Current state, auth gate design, cross-platform direction, recent work. |
| 2 | `PHPSPEC.md` | Format spec — crypto primitives, block structure, key derivation, blob obfuscation. |
| 3 | `docs/design/CROSS_PLATFORM_ARCHITECTURAL_DECISIONS.md` | Full architectural rationale for Rust crypto core, dumb Worker, cross-platform strategy. |
| 4 | `MOBILE_ROADMAP.md` | Phased plan: Web (React) → Flutter (primary mobile) → React Native (contingency). |
| 5 | `PHPOC-REACT_WEB-DESIGN_DECISIONS.md` | React web UI design decisions — screen architecture, dev mode, component tree, navigation. |
| 6 | `VISION.md` | Project vision — "know thyself," zero-knowledge, platform independence. |

### Load When Relevant

| File | When to Read |
|------|--------------|
| `MAP.md` | Navigating source code — file inventory with HOT/COLD annotations |
| `docs/design/DESIGN_GOALS.md` | Design decisions affecting ledger, sync, or user experience |
| `docs/design/ARCHITECTURAL_DECISIONS.md` | Historical context on CLI-era choices |
| `docs/design/DESIGN_MULTI_DEVICE_SESSION.md` | Device cookie, auth gate, cross-device reconciliation details |
| `ROADMAP.md` | High-level project roadmap and milestones |
| `CHANGELOG.md` | Release history |
| `BACKLOG.md` | Project backlog |

---

## Next Steps — Immediate

The crypto layer and sync algorithm are complete. The web StorageBackend interface is fully implemented. The next work is the web platform layer, prioritized for maximum iteration speed:

### Step 1: HTTP Transport Wrapper ✅
`phpoc-web/src/sync/transport.js` — 49 tests. Port of `core/sync/http_transport.py` with ETag caching, `arrayBuffer()` binary-safe reads, DELETE support.

### Step 2: Sync Algorithm Port ✅
`phpoc-web/src/sync/` — 9 modules, 60 tests. Full `checkAndSync()` auth gate, staging CRUD, merge engine, remote blob sync.

### Step 3: React Web UI Scaffold ✅
Vite + React 18, 9 screen components, DevModeContext, bottom tab nav, auth overlay, portrait/landscape layout, configuration covering 27 CLI config fields.

### Step 4: StorageBackend Interface + HttpBackend ✅
`StorageBackend` (get/set/remove/clear/list), `MemoryBackend`, `IndexedDBBackend`, `HttpBackend` (Transport→StorageBackend adapter, 41 tests). `delete()` on `HttpTransport` + `MockRemoteBackend`. DELETE handler on Worker. `list()` on StorageBackend interface.

### Step 5: Browser Import/Export via File API 🔜

**Design (2026-06-09):** Auth-gated (passphrase prompt + `crypto.authenticate()`). Ledger entries sealed via HMAC-SHA256 (`crypto.computeSeal`/`verifySeal`, PHPSPEC §5.2). Single `.json` file with `{ format_version, exported_at, entries, seal }`. Seal covers `JSON.stringify(entries)` only — file wrapper metadata is outside seal. Import verification failure → reject entirely (no partial import). Entry hash re-validation on import. Overwrite-only (no merge).

**Implementation order (TDD):**
1. `phpoc-web/src/services/ledger_export.js` — exportLedger(storage, crypto, masterKey) → returns Blob
2. `phpoc-web/src/services/ledger_import.js` — importLedger(storage, crypto, masterKey, file) → imported count
3. `phpoc-web/src/components/modals/PassphraseModal.jsx` — reusable passphrase prompt overlay
4. Settings screen: Backup & Restore section with Export/Import buttons
5. Test suite: `test/ledger_export_test.mjs`, `test/ledger_import_test.mjs`, `test/passphrase_modal_test.mjs`

### Step 6: Ledger Engine JS Port 🔜
Commit staging → ledger chain, chain verification, block push/pull. Largest remaining work item. Port of `domain/ledger/engine.py` and `domain/ledger/chain.py`.

### Step 7: Staging CRUD in UI 🔜
Full staging interaction (add/edit/delete entries directly in UI). Currently wired to dummy data.

### Step 8: Companion Bridge Server 🔜
~50-100 lines Python HTTP server implementing same API contract as Worker. Enables self-hosted LAN deployment.

### Step 9: Dockerfile + Multi-tenant Worker 🔜
One-command self-hosted deployment + SaaS multi-tenant isolation.
