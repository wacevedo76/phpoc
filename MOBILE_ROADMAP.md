# PH Ledger — Mobile Roadmap

> **Goal:** A cross-platform app (web, iOS, Android) that reads and writes PH Ledger data,
> interoperating with the existing CLI reference implementation through the remote
> sync infrastructure (HTTP → Cloudflare Worker → R2).

---

## Architecture Decision (2026-06-01)

**After architectural review, the recommendation has shifted from "Hybrid (Option C)" to a clear "Smart Client + Dumb Worker" model.**

The existing 149-line Cloudflare Worker already handles everything the mobile app needs — GET/PUT/LIST of opaque bytes by path. The mobile app is a **port of the CLI's remote sync layer**, not an integration with a new API server. The Worker stays:

- **Stateless** — no Durable Objects, no KV for sessions
- **Dumb** — cannot decrypt anything, knows nothing about the data model
- **Tiny** — ~195 lines including CORS and optional token check

**No REST API layer is needed between the mobile app and the Worker.** The protocol is three HTTP verbs:

| Operation | Worker Request | Worker Response |
|-----------|---------------|-----------------|
| Read blob | `GET /{path}` | 200 + bytes, 304 (ETag match), or 404 |
| Write blob | `PUT /{path}` | 200 |
| Delete blob | `DELETE /{path}` | 200 |
| List blobs | `GET ?prefix={prefix}` | JSON array of keys |

The mobile app sends the same `X-Api-Key` header and uses the same path constants as the CLI. The Worker doesn't know or care which client is talking to it.

---

## Status

| Layer | CLI (Reference) | Mobile PoC |
|-------|:---------------:|:----------:|
| Rust crypto core (`phpoc-crypto-core`) | ✅ | ✅ 7 modules, 61 tests |
| WASM bindings (20 exports to JS) | N/A | ✅ `wasm.rs` module |
| WASM build target | N/A | ✅ 134K `.wasm` + JS glue + TS types |
| WASM integration test (74 tests) | N/A | ✅ `phpoc-web/test/wasm_integration.mjs` |
| CryptoService wrapper (20 functions) | N/A | ✅ `phpoc-web/src/crypto/index.js` |
| Device identity | ✅ | ✅ `device.rs` module |
| Worker: CORS headers | N/A | ✅ OPTIONS + CORS on all responses |
| Crypto test vector suite | ✅ | ✅ 19 vectors, validated |
| HTTP Transport implementation + test suite (49 tests) | N/A | ✅ GREEN — `phpoc-web/src/sync/transport.js` (full fetch()-based impl with ETag caching) — `phpoc-web/test/transport_test.mjs` (49 tests, all passing) |
| Core engine (chain, crypto, storage) | ✅ | ❌ |
| CLI UX (`add`, `view`, `sync`, `verify`) | ✅ | N/A |
| Remote staging sync (port to JS) | ✅ | ✅ FULL — `phpoc-web/src/sync/sync.js` — SyncService with `checkAndSync()`, `_reconcileAndClaim()`, `pushToRemote()`, `pushBlobOnly()`. Full auth gate flow with cookie fast path. 60-test suite. |
| Auth gate (device cookies port) | ✅ | ✅ FULL — `phpoc-web/src/sync/cookie.js` — DeviceCookie (create, validate TTL, parse remote, match specifiers, destroy). 14-test suite. |
| Cross-device handoff (port) | ✅ | ✅ INFERRED — `merge_engine.js` + `_reconcileAndClaim()` handles device_uuid comparison, pull+merge+push for different devices. |
| Sync modules (storage abstraction) | N/A | ✅ — `storage.js` (StorageBackend interface + MemoryBackend), `indexeddb_storage.js` (IndexedDBBackend via idb-keyval) |
| Sync modules (local cache) | ✅ | ✅ — `local_cache.js` — LocalCache (staging CRUD, pause management, tag normalization, SHA-256 via WASM) |
| Sync modules (merge engine) | ✅ | ✅ — `merge_engine.js` — mergeEntries() pure function (dedup by entry_id) |
| Sync modules (remote blob) | ✅ | ✅ — `remote_sync.js` — RemoteSync (pull/push with CryptoService obfuscation, cookie pull/push) |
| Sync test suite | N/A | ✅ — `test/sync_test.mjs` — 60 tests covering all 4 layers + edge cases |
| **React Web UI scaffold** | N/A | ✅ **DONE** — Vite + React 18, 9 screen components, DevModeContext, DummyLedger, dashboard, bottom tab nav. 14 modules, all compile clean. See `SESSION_HANDOFF.md` Step 3. |
| **Auth overlay system** | ✅ (CLI re-auth prompt) | ✅ **DONE** — Full-screen AuthScreen on first launch; blurred-backdrop overlay on re-auth while app is running. Lock button on bottom nav + Profile screen. See `SESSION_HANDOFF.md` (2026-06-09). |
| **Mock data generator** | N/A | ✅ **DONE** — `scripts/generate_mock_data.py` generates 30 days of realistic staging entries for testing. Weighted weekday/weekend templates, plain: prefix, SHA-256 hashes, UUID4 entry IDs. `--apply` writes to staging.json. 115 entries generated spanning Jun 4 → Jul 3, 2026. |
| Ledger block sync (port) | ✅ | ❌ |
| Format spec (`PHPSPEC.md`) | ✅ | ✅ |

---

---

## Platform Phasing

The Rust crypto core (`phpoc-crypto-core`) decouples crypto from the UI framework entirely. The phased approach below targets platforms in order of iteration speed and risk reduction, not by framework loyalty.

| Phase | Platform | Framework | Crypto Integration | Purpose |
|-------|----------|-----------|-------------------|---------|
| **1** | **Web** | React (chosen for familiarity — any WASM-compatible framework works) | Rust → WASM | Prove the interaction model, sync algorithm, and full workflow in a browser. Fastest iteration. |
| **2** | **Mobile (primary)** | **Flutter** | Rust → `.a`/`.so` via `flutter_rust_bridge` (auto-generated Dart bindings, zero hand-written FFI) | Native mobile experience. Biometrics, background sync, platform storage. |
| **3** | **Mobile (contingency)** | React Native | Rust → `.a`/`.so` via TurboModules (hand-written ObjC + Kotlin wrappers, ~50 lines each) | Only if Flutter proves problematic. Shares UI patterns from Phase 1, but view layer is a rewrite. |

**Why Flutter over React Native as the primary mobile target:**
- `flutter_rust_bridge` auto-generates all Dart bindings from the Rust crate — **zero lines of hand-written FFI glue** vs. ~50 lines each in ObjC and Kotlin for TurboModules
- Direct C ABI FFI calls avoid the JS↔Native bridge overhead on every crypto operation
- If Flutter doesn't work out for any reason (performance, platform API gaps, team preference), the Rust crypto core makes the React Native fallback straightforward — the crypto is already compiled to `.a`/`.so`

**Why React Web:**
- Fastest feedback loop for the hardest problems (crypto correctness, sync algorithm, interaction design)
- Framework choice is pragmatic, not architectural — React is used because of familiarity. Any web framework can consume the same Rust→WASM module
- The web app is a prototype for the interaction model; the insights transfer to any mobile framework

---

## What Each Platform Needs

### 🔴 Phase 1 — Web Prototype (Must Have)

#### 1. Minimal Worker Additions (~20 lines)

The current Worker needs three small additions for mobile compatibility:

| Addition | Lines | Status | Why |
|----------|-------|--------|-----|
| CORS headers | ~5 | ✅ Done (`14f8c8f`) | Mobile fetch requests from dev builds, WebView, or arbitrary origins |
| Optional bearer token check | ~5 | ❌ Not yet | Per-device auth (separate from the shared API key) — a simple KV lookup, not a session system |
| Structured JSON wrapper (optional) | ~10 | ❌ Not yet | Thin JSON coat on GET/PUT responses for mobile convenience (e.g., `{"data": "<base64>", "etag": "..."}`) |

That's the entire delta. The Worker stays under 210 lines (~205), stateless, and domain-ignorant.

**No client platform needs:**
- Session tokens (the passphrase is the auth mechanism — it never leaves the device)
- A server-side sync endpoint (sync runs client-side, just like the CLI)
- CRUD endpoints for staging (each client manipulates its local cache, then pushes the full blob)
- An OpenAPI spec (the protocol is four HTTP verbs, fully defined by `core/sync/http_transport.py` and `worker/src/index.ts`)

#### 2. Wire Protocol — Already Defined (No New Work)

Every client implements the same four-operation protocol that the CLI's `HttpStagingTransport` uses:

```
GET    /{path}                    → bytes | None (404)
PUT    /{path}  (body: bytes)     → None
DELETE /{path}                    → None
GET    ?prefix={prefix}           → List[str]
```

The storage paths are constants from the CLI reference — every client uses the exact same strings:

| Data | R2 Path (CLI constant) | Defined In |
|------|------------------------|------------|
| Staging blob | `staging/blobs/current.json` | `domain/staging/remote_sync.py:77` |
| Device cookie | `staging/blobs/device_cookie.bin` | `domain/staging/remote_sync.py:42` |
| Ledger blocks | `ledger/blocks/{seq}.json` | `domain/ledger/remote_sync.py:39` |
| Ledger index | `ledger/index.json` | `domain/ledger/remote_sync.py:40` |

ETag caching (conditional GETs with `If-None-Match` / `304 Not Modified`) is strongly recommended for all clients to minimize data transfer, especially on cellular connections.

#### 3. Portable Crypto Library (`phpoc-crypto-core`)

Crypto is the gating factor — one wrong byte and the client can't read blobs written by the CLI. Instead of reimplementing crypto per platform, the project uses a **shared Rust library compiled to every target**.

**`phpoc-crypto-core`** is a Rust crate (using `ring` — BoringSSL bindings, FIPS 140-2 validated) that implements all cryptographic primitives once:

| Primitive | Used For |
|-----------|----------|
| PBKDF2-HMAC-SHA256 (600K + 100K fallback) | Passphrase → PDK |
| AES-256-CTR encrypt/decrypt | Field-level encryption |
| HMAC-SHA256 | Block seals, auth tags, blob obfuscation |
| SHA-256 | Content hashing, entry hashing |
| Secure random bytes | Entry IDs, device specifiers |
| Blob obfuscation (4-tier pad + HMAC sub-key) | Remote staging transport (per PHPSPEC.md) |
| Key derivation | Master key → sub-keys |

**Compiled per target:**

| Target | Output | Used By | Integration |
|--------|--------|---------|-------------|
| `wasm32-unknown-unknown` | `.wasm` | Web (any framework — React, Svelte, vanilla JS, etc.) | ~10 lines JS (`npm install phpoc-crypto-core` + async import) |
| `aarch64-apple-ios` | `.a` static lib | Flutter (Phase 2, primary), React Native (Phase 3, contingency), Swift native (optional) | `flutter_rust_bridge` (auto-generated, 0 FFI lines) or TurboModule (~50 lines ObjC) |
| `aarch64-linux-android` | `.so` shared lib | Flutter (Phase 2, primary), React Native (Phase 3, contingency), Kotlin native (optional) | `flutter_rust_bridge` (auto-generated, 0 FFI lines) or TurboModule (~50 lines Kotlin) |

**Test vector suite**: A shared `crypto_test_vectors.json` with known inputs and expected outputs for every primitive. The Rust library is validated against this suite once — every platform inherits correctness. The only platform-specific test is: "does the HTTP client send/receive bytes correctly?"

This is the approach chosen in `docs/design/CROSS_PLATFORM_ARCHITECTURAL_DECISIONS.md` — crypto is written once, audited once, maintained once.

#### 4. Device Identity

Each client device (web or mobile) needs:
- A persistent UUID4 (stored in platform secure storage — Keychain, EncryptedSharedPreferences, or IndexedDB)
- HMAC-SHA256 proof derived from the master key (via `phpoc-crypto-core`)
- `device_label` for user-friendly identification in the sync UI

The existing `security/device_identity.py` is the reference. All client implementations mirror it.

#### 5. Sync Algorithm — Port, Don't Re-invent

Every client must replicate the CLI's `check_and_sync()` logic from `domain/staging/service.py`. It's ~50 lines of branching — not an SDK dependency:

```
1. No remote configured? → READY (local only)
2. Local cookie expired/missing? → AUTH GATE
3. Remote cookie reachable?
   - Same specifier? → READY (no-op)
   - Mismatch? → AUTH GATE
   - Unreachable? → OFFLINE (proceed locally)
4. Auth Gate: decrypt blob
   - Same device UUID? → push local (local authoritative)
   - Different UUID? → pull remote → merge → push merged
```

The cookie format, merge engine (dedup by `entry_id`), and blob obfuscation are all specified in the CLI reference. This is a faithful port, not a redesign.

## Build Targets

The Rust crate is compiled per target:

| Target | Output | Used By | Status |
|--------|--------|---------|--------|
| `wasm32-unknown-unknown` | `.wasm` (132K) + JS glue + TS types | Web prototype | ✅ `wasm-bindgen` generates `pkg/` |
| `aarch64-apple-ios` | `.a` static lib | Flutter (Phase 2) | ❌ Not yet |
| `aarch64-linux-android` | `.so` shared lib | Flutter (Phase 2) | ❌ Not yet |

---

### 🔵 StoragePlugin — Multi-Deployment Architecture

**Decision (2026-06-09):** phpoc-web supports four deployment targets from a single codebase, selected at startup via config. The `StoragePlugin` interface decouples all sync/ledger logic from the storage backend.

```
phpoc-web (React)
  ├── SyncService / LedgerEngine (deployment-agnostic)
  │     └── StoragePlugin (interface)
  │           ├── IndexedDBBackend (standalone PWA)
  │           ├── HttpBackend (bridge server or Worker)
  │           ├── MockRemoteBackend (dev, simulates R2/S3)
  │           └── S3Backend (future: advanced deployments)
  └── Browser File API (import/export — free, no server)
```

| Deployment | Storage Backend | Multi-user | Use Case |
|-----------|----------------|------------|----------|
| **Standalone PWA** | IndexedDB | Single user | Local machine, no infra needed |
| **Local network / LAN** | Companion bridge server (HTTP → filesystem) | Single user | Accessible within home/office network |
| **Docker / LXC** | Bridge server bundled in container | Single user | One-command deploy, repeatable |
| **SaaS** | Cloudflare Worker → R2 (multi-tenant) | Multi-tenant | Hosted service for non-technical users |

**Companion bridge server** (~50 lines Python) exposes the same HTTP API as the Worker:
```
GET  /staging/blobs/current.json  → reads filesystem
PUT  /staging/blobs/current.json  → writes filesystem
GET  /ledger/blocks/{n}.json      → reads ledger block
GET  ?prefix=...                  → lists paths
```
This enables CLI ↔ web app file sharing without a remote Worker. The bridge is optional — standalone mode uses IndexedDB directly.

**MockRemoteBackend** (built, 46 tests) simulates R2/S3 in-browser for development — same contract as the real Worker/bridge, zero infra needed.

**HttpBackend** (built, 41 tests) wraps any Transport (HttpTransport or MockRemoteBackend) to conform to the StorageBackend interface — enabling use of a remote HTTP backend wherever code expects a StorageBackend.

**Worker DELETE** added — `DELETE /{path}` removes a blob. Enables `HttpBackend.remove()` → `HttpTransport.delete()` → Worker DELETE. Idempotent (404 treated as success).

**Next steps:**
1. ✅ `MockRemoteBackend` — built, 46 tests, 300 across mock infra
2. ✅ `HttpBackend` — built, 41 tests, bridges Transport→StorageBackend interface
3. ✅ `StorageBackend.list()` + `HttpTransport.delete()` + Worker DELETE
4. 🔲 **Browser import/export via File API** — auth-gated (passphrase prompt), entries sealed via HMAC-SHA256 (`crypto.computeSeal`), single `.json` file format. Design complete in `PHPOC-REACT_WEB-DESIGN_DECISIONS.md §11.11`.
5. 🔲 Companion bridge server (Python, ~50 lines)
6. 🔲 Dockerfile (nginx + bridge server)
7. 🔲 Multi-tenant Worker + registration for SaaS

Detailed design decisions documented in: `PHPOC-REACT_WEB-DESIGN_DECISIONS.md` (Section 11 — Multi-Deployment Architecture)

---

### 🟡 Phase 2 — Flutter Mobile App (Should Have)

With the Rust crypto core already compiled to `.a`/`.so` and `flutter_rust_bridge` auto-generating Dart bindings, the Flutter app imports the crypto layer as a compiled binary with zero hand-written FFI glue.

#### 6. Mobile Staging CRUD

The core workflow for a mobile time tracker:

- **Start task** (capture with title, optional tags)
- **View active tasks** (list running tasks with elapsed time)
- **End task** (stop, compute duration)
- **Pause / resume** (interruptions)
- **View history** (recent staged entries)
- **Quick-add** (one-off completed entry)

All local-first: writes hit local storage first, sync to remote in background.

**CLI → screen mapping:**

| CLI Command | Mobile Screen |
|-------------|---------------|
| `ph add` | New Task screen (title, tag picker, start timer) |
| `ph view` | Dashboard/Home with active tasks + elapsed timers |
| `ph list` | History screen with filter/sort |
| `ph sync` | Pull-to-refresh + background sync indicator |
| `ph tags` | Tag management screen |
| `ph login` / auth | AuthScreen → UserProfile (identity card, session status) |
| `ph dev push-status` | Profile → Stats grid / Sync screen |
| `ph config` (CLI config) | Profile → Configuration (9 sections, 27 fields) |
| `ph verify` | Settings → Chain Verification |
| `ph recover` | Settings → Advanced → Recover from Seed |

#### 7. Auth Flow (Mobile)

```
1. First launch → prompt for passphrase
2. PBKDF2-600K locally (via Rust `.a`/`.so`) → derive master key → cache in memory
3. Store encrypted master key in Keychain / EncryptedSharedPreferences
4. Enable biometric unlock for subsequent launches
5. Derive device identity → create/update device cookie on remote
6. Pull remote staging blob → decrypt locally → merge into local
7. On subsequent launches:
   - Master key in memory? → fast path (proceed)
   - Master key in Keychain? → biometric prompt → decrypt → proceed
   - Cookie TTL expired? → re-prompt for passphrase
   - Cookie specifier mismatch? → show which device → offer "Sync Now"
```

**Note:** PBKDF2-600K takes ~500ms on desktop, likely 2-3s on mobile. Run it on a background thread with a spinner — never block the main thread. The Rust→`.a`/`.so` call is direct C ABI FFI — no JS↔Native bridge overhead.

#### 8. Background Sync

- WAL-based: queue writes locally, push on connectivity
- Daemon-like periodic check via BGTaskScheduler (iOS) / WorkManager (Android)
- Conflict resolution via existing `MergeEngine` (dedup by `entry_id`)
- Cookie management: touch local cookie on writes, reconcile on specifier mismatch
- **Optimistic UI**: writes appear immediately; a subtle "pending" indicator shows un-synced changes
- **Sync badge**: visual indicator of pending changes (like `ph dev push-status`)

#### Transport Porting Notes (Flutter)

When porting `HttpTransport` from JS to Dart during Phase 2, two issues from the JS review carry forward with higher severity in Flutter:

1. **Unbounded ETag cache** — The JS `Map` has no eviction; page reloads reset it so it's tolerable in the web app. In Flutter, sessions can last days or weeks (the app stays in memory). Implement LRU eviction (e.g., max 100 entries) when porting the transport layer. Simpler option: skip ETag caching entirely in Flutter and rely on `Cache-Control` headers — the Worker already sets them, and HTTP clients on mobile handle caching natively.

2. **No HTTPS certificate validation control** — The JS transport delegates to the browser/Node.js trust store, which is fine for standard public CAs. Flutter's `http` package also uses the platform trust store, so this is acceptable for standard deployments. If enterprise deployment requires custom CAs (MITM proxies, internal PKI), Flutter supports `SecurityContext` for pinned certificates or custom roots via `dart:io`'s `HttpClient`. No change needed at the protocol level — just a Flutter configuration detail.

---

### 🟢 Phase 3 — Parity & Contingency (Nice to Have)

#### 9. Ledger Sync (Commit)

- `ph sync` equivalent: commit staged entries to the ledger chain
- Chain verification on device
- Push new blocks to remote
- Pull remote blocks and verify chain linkage

#### 10. History & Reputation

- Browse committed ledger history by day / month / year
- Blind index queries (reputation with date range)
- Chain verification display
- Search / filter by tags

#### 11. Export & Share

- Portable export (`--range` block-level export)
- Tag-signed manifest for sharing on social platforms
- Read-only view URLs (if API server supports it)

#### 12. React Native (Contingency)

If Flutter proves problematic (performance, platform API gaps, team preference, or ecosystem maturity concerns), the Rust crypto core is already compiled to `.a`/`.so` and ready for React Native via TurboModules. The view layer is a rewrite (React DOM → React Native components), but the model layer — crypto, sync algorithm, wire protocol — is shared.

The decision to switch to React Native should only be made after:
- A clear, documented finding that Flutter is blocking a specific feature
- The same feature is achievable in React Native without equivalent tradeoffs
- The rewrite cost is justified by the specific problem being solved

---

## What the CLI Needs to Change

**Nothing. The CLI is already mobile-compatible.**

The protocol (three HTTP verbs), the storage paths, the crypto primitives, the cookie format, the blob obfuscation, and the sync algorithm are all fully defined by the CLI reference. The mobile app ports these. Both are independent clients of the same dumb Worker.

The only potential CLI-adjacent change: if you add per-device bearer tokens to the Worker (separate from the shared API key), the CLI would need a new config field for its token. But even this is optional — the shared API key works fine for both platforms.

---

## Layering SaaS Features (Forward-Looking)

The minimal architecture doesn't prevent multi-user, sharing, dashboards, or social features — it constrains *where* they live. Every SaaS feature can be layered on top by having the client **publish structured data alongside the encrypted blobs**.

### Multi-User Isolation

The Worker already handles arbitrary paths. User isolation is a path prefix:
```
/users/{user_id}/staging/blobs/current.json
/users/{user_id}/ledger/blocks/{seq}.json
```
No Worker change needed — the path is just longer. User registration is a separate service (KV for user ID → API key mapping) that sits alongside the data plane but never touches encrypted data.

### Sharing

1. User A's client wraps a copy of the shared data with User B's public key
2. Writes to a shared path: `/shares/{share_id}/data.bin`
3. Sends User B the share ID + wrapping key (out of band)
4. User B's client pulls the blob and decrypts

The server stores opaque bytes. Sharing is a key-exchange protocol between clients, not a server feature.

### Team Dashboards

Two approaches:

**Client-side aggregation** (small teams, 2-10 people): Each client fetches all team members' encrypted blobs, decrypts locally, renders charts. Feasible because each blob is small (<100KB).

**Opt-in plaintext summaries** (scales to any team size): The client pushes daily aggregate summaries alongside the encrypted blob:
```
/summaries/2026/06/01/user_abc.json
```
Format: `{"tag_hours": {"coding": 4.5, "reading": 1.2}, "hmac": "..."}` — plaintext but HMAC-signed with a derivation of the master key. The server or a dashboard frontend reads these for team-level charts without ever decrypting the private ledger.

### Notifications

A separate Cron Trigger Worker (independent of the data plane):
1. Lists paths under `/users/{user_id}/staging/`
2. Checks for stale active tasks (detectable from blob size or a tiny metadata flag the client writes alongside the blob)
3. Fires APNs / FCM

No data decryption needed. The notification Worker doesn't know *what* task is active, only *that* one is.

### Social Features (Signed Proofs)

"Tracked 500 hours of guitar practice" → the client generates a signed block export (the block is already HMAC-sealed) and posts it to a public path. Anyone can verify the HMAC against the user's public identity key.

### The Design Principle

**The client always pushes what the server needs to know, in a form the server can use — but the client chooses what that is.**

The user's private ledger stays encrypted. If they want dashboards, their client pushes plaintext summaries. If they want sharing, their client wraps data for the recipient. If they want streaks, their client pushes a presence flag. Every SaaS feature is an *opt-in data publication*, not a *server-side breach* of the encrypted store.

This is the same philosophy as the current design: the server is a dumb store; clients are the smart layer. SaaS just adds more clients (team members, dashboards, notification services) that the user's client explicitly authorizes.

---

## Prerequisites — Status

| # | Item | Est. Effort | Status | Completed In |
|---|------|-------------|--------|-------------|
| 1 | Worker: CORS headers | 1 day | ✅ Done | `14f8c8f` (mobile-poc) |
| 2 | Crypto test vector suite (JSON) | 1 day | ✅ Done | `f7f2cfd` (mobile-poc) |
| 3 | Rust crypto library (`phpoc-crypto-core`) | 1-2 weeks | ✅ Done — 7 modules, 61 tests | `f199a81` (mobile-poc) |
| 4 | WASM build target + bindings | 2-3 days | ✅ Done — 20 JS exports, 134K `.wasm` | `f199a81` (mobile-poc) |
| 5 | Device identity | 1-2 days | ✅ Done — `device.rs` module | `f199a81` (mobile-poc) |
| 6 | WASM integration test (JS) | 1 day | ✅ Done — 74 tests, all 20 functions vs test vectors | `8f2a9e2` (mobile-poc) |
| 7 | CryptoService wrapper (JS) | 1-2 days | ✅ Done — singleton, key cache, 20 camelCase methods, 5 cached-key convenience wrappers | `784c1d0` (mobile-poc) |
| 8 | HTTP Transport implementation (JS) | 1 day | ✅ GREEN — 49 tests, full fetch()-based HttpTransport with ETag caching + `delete()` method, all passing | `this commit` |
| 9 | Sync Algorithm Port (JS) — StorageBackend, IndexedDBBackend, DeviceCookie, RemoteSync, LocalCache, MergeEngine, SyncService | 2-3 days | ✅ DONE — 9 modules, 60-test suite, full auth gate + staging CRUD + blob sync | `this commit` |
| 10 | React Web UI Scaffold — Vite + React 18, 9 screen components, DevModeContext, DummyLedger, dashboard, navigation | 2-3 days | ✅ DONE — 14 modules, all compile clean. Auth bypass via DevModeContext. Active task pills with pause/stop. Portrait/landscape layout. Bottom tab nav (7 tabs). UserProfile + Configuration screens covering all 27 CLI config fields. | Jun 8 2026 |
| 11 | **Auth Overlay System** — full-screen AuthScreen on first launch, blurred-backdrop overlay on re-auth while app is running. Lock button on bottom nav + Profile. | 1 day | ✅ DONE — 5 files changed: App.jsx, AuthScreen.jsx, AppLayout.jsx, UserProfile.jsx, App.css. Lock icon turns red on hover, overlay has backdrop blur + pop-in animation. | Jun 9 2026 |
| 12 | **Mock Data Generator** — script to generate realistic staging entries for testing | 1 day | ✅ DONE — `scripts/generate_mock_data.py`. 30 days, weighted activities, weekday/weekend templates, plain: prefix, SHA-256 hashes. 115 entries (Jun 4 → Jul 3, 2026) applied to staging.json. | Jun 9 2026 |
| 13 | **MockRemoteBackend** — in-browser R2/S3 simulation (IndexedDB, latency, ETags, 404s) | 1 day | ✅ DONE — `phpoc-web/src/sync/mock_remote.js`. 46 tests. Implements same pull/push/listFiles contract as HttpTransport. | Jun 9 2026 |
| 14 | **MockDataSeeder** — realistic staging data generator for web dev mode | 1 day | ✅ DONE — `phpoc-web/src/services/MockDataSeeder.js`. 14 days of entries + cookie + genesis + index. 205 tests. | Jun 9 2026 |
| 15 | **DevModeContext rewired** — DummySyncService replaced with real SyncService + MockRemoteBackend | 1 day | ✅ DONE — Real auth gate, cookie setup, entry pull from mock remote. Full-stack simulation in-browser. | Jun 9 2026 |
| 16 | **HttpBackend + StorageBackend.list + Worker DELETE** — Transport→StorageBackend adapter, `delete()` on HttpTransport/MockRemoteBackend, DELETE handler on Worker | 1 day | ✅ GREEN — 41 tests (TDD). `list()` added to StorageBackend + MemoryBackend. Worker now handles DELETE method. Zero regressions (155 web tests, 270 total). | Jun 9 2026 |

---

## Answered Decisions

| Question | Answer |
|----------|--------|
| **API Worker: extend or separate?** | Extend the existing Worker with ~20 lines. No separate service needed. |
| **Auth: API key vs session tokens?** | API key (shared secret) is sufficient. The passphrase is the real auth mechanism — it never leaves the device. No session tokens, no OAuth. |
| **Stateless or stateful API?** | Stateless. The Worker has no session state. Mobile handles cookies and auth locally. |
| **Which platform first?** | **Web (React)** — uses Rust → WASM crypto, ships with `npm start`. Fastest iteration cycle for UI and sync algorithm. **Flutter** follows in Phase 2 (uses Rust → `.a`/`.so` via `flutter_rust_bridge`, zero hand-written FFI). React Native is Phase 3 contingency — only if Flutter proves problematic. Swift/Kotlin native apps remain optional but are not a priority. |
| **Shared Python SDK?** | Not needed. Every client ports the sync algorithm natively — it's ~100 lines of branching + crypto calls. A Python SDK would only be useful if you build a server-side component, which the architecture explicitly avoids. |
| **OpenAPI spec?** | Not needed. The wire protocol is three HTTP verbs, fully defined by `core/sync/http_transport.py`. The paths are constants in `remote_sync.py`. |
| **`POST /sync` endpoint?** | Not needed. Sync runs client-side (commit staging → ledger). The server is not involved. |

---

## References

- `worker/src/index.ts` — Current Cloudflare Worker (149 lines, dumb blob store)
- `core/sync/http_transport.py` — Python HTTP transport client (wire protocol reference)
- `domain/ledger/remote_sync.py` — Ledger block sync via HTTP (path constants, push/pull logic)
- `domain/staging/remote_sync.py` — Staging blob sync + device cookie (blob obfuscation, cookie format)
- `domain/staging/service.py` — Auth gate, `check_and_sync()`, `_reconcile_and_claim()` (sync algorithm reference)
- `PHPSPEC.md` — Format specification (crypto, block structure, key derivation)
- `SESSION_HANDOFF.md` — Current state of the CLI reference implementation
- `phpoc-web/src/crypto/index.js` — `CryptoService` — singleton WASM wrapper (key cache, ready-guards, all 20 exports)
- `phpoc-web/test/wasm_integration.mjs` — 74-test integration suite (all 20 functions vs test vectors)
- `phpoc-web/test/crypto_service_smoke.mjs` — 22-test CryptoService smoke test
