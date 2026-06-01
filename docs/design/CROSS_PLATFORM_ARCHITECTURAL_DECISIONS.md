# Cross-Platform Architectural Decisions

> **Date:** 2026-06-01
> **Context:** Mobile roadmap review for PHPOC — a CLI time-tracker with zero-knowledge
> remote sync (HTTP → Cloudflare Worker → R2). Architects: CLI reference implementation
> (Python, complete at 1341 tests) and a planned mobile app (iOS/Android).

---

## Table of Contents

1. [Status of the CLI-Mobile Compatibility](#1-cli-mobile-compatibility)
2. [Minimal Worker Architecture](#2-minimal-worker-architecture)
3. [The Crypto Problem](#3-the-crypto-problem)
4. [Platform Strategy: Three Options](#4-platform-strategy)
5. [Chosen Direction](#5-chosen-direction)
6. [Crypto Library: The Cross-Platform Core](#6-crypto-library)
7. [Layering SaaS Features](#7-layering-saas-features)
8. [Key Design Principles](#8-key-design-principles)
9. [Glossary](#9-glossary)

---

## 1. CLI-Mobile Compatibility

### Decision

**The CLI does not need to change. It is already mobile-compatible.**

### Rationale

The seam between CLI and mobile is the Cloudflare Worker, and the Worker is a **dumb blob store** — a generic HTTP-to-R2 proxy (149 lines of TypeScript). It has zero knowledge of the PHPOC data model, encryption, or blob format. It stores and retrieves opaque bytes by key.

Both CLI and mobile speak the same three-verb protocol:

| Operation | Worker Request | Worker Response |
|-----------|---------------|-----------------|
| Read blob | `GET /{path}` | 200 + bytes, 304 (ETag match), or 404 |
| Write blob | `PUT /{path}` | 200 |
| List blobs | `GET ?prefix={prefix}` | JSON array of keys |

The storage paths are constants defined in the CLI reference — the mobile app uses the exact same strings:

| Data | R2 Path | Defined In |
|------|---------|------------|
| Staging blob | `staging/blobs/current.json` | `domain/staging/remote_sync.py:77` (configurable) |
| Device cookie | `staging/blobs/device_cookie.bin` | `domain/staging/remote_sync.py:42` (constant) |
| Ledger blocks | `ledger/blocks/{seq}.json` | `domain/ledger/remote_sync.py:39` (configurable) |
| Ledger index | `ledger/index.json` | `domain/ledger/remote_sync.py:40` (configurable) |

The mobile app sends the same `X-Api-Key` header and uses the same path constants. The Worker does not know or care which client is talking to it.

### What the mobile app must replicate (port, not re-invent)

| CLI Component | What to Port | Where It's Defined |
|---|---|---|
| Crypto primitives | PBKDF2-600K, AES-CTR, HMAC-SHA256, SHA-256, blob obfuscation | `PHPSPEC.md` |
| Sync algorithm | `check_and_sync()` flow (cookie check → blob pull/push → reconcile) | `domain/staging/service.py` |
| Cookie format | Device specifier + TTL JSON schema | `domain/cookie/device_cookie.py` |
| Merge engine | Dedup by `entry_id` | `domain/staging/merge_engine.py` |

### The only potential CLI-adjacent change

If per-device bearer tokens are added to the Worker (separate from the shared API key), the CLI would need a new config field for its token. This change is optional — the shared API key works for both platforms.

---

## 2. Minimal Worker Architecture

### Decision

**No REST API layer. No session tokens. No server-side sync endpoint. The Worker stays dumb.**

The original roadmap proposed 15+ structured API endpoints. After architectural review, these collapse to the three existing operations (GET/PUT/LIST) plus ~20 lines of additions:

| Addition | Lines | Purpose |
|----------|-------|---------|
| CORS headers | ~5 | Mobile fetch requests from dev builds, WebView, or arbitrary origins |
| Optional bearer token check | ~5 | Per-device auth — simple KV lookup, not a session system |
| Structured JSON wrapper (optional) | ~10 | Thin JSON coat for mobile convenience (e.g., `{"data": "<base64>", "etag": "..."}`) |

### Why the structured API was rejected

| Proposed Endpoint | Why Not Needed |
|---|---|
| `POST /auth/login` | Passphrase never leaves device. No session concept needed. |
| `POST /auth/logout` | No session to clear. |
| `GET/POST/PUT /staging/*` | Mobile manipulates local cache, pushes full blob. Same as CLI. |
| `POST /sync` | Sync runs client-side (commit staging → ledger). Server not involved. |
| `GET /ledger/verify` | Chain verification is client-side crypto. |
| `GET /reputation` | Blind index queries are client-side crypto. |

### Worker invariants

- **Stateless** — no Durable Objects, no KV for sessions, no server-side state
- **Dumb** — cannot decrypt anything, knows nothing about the data model
- **Thin** — stays under 200 lines
- **Path-agnostic** — user isolation is a path prefix (`/users/{id}/...`), not a database schema

---

## 3. The Crypto Problem

### Why crypto is the gating factor

The mobile app must produce and consume the exact same byte format as the CLI. Every primitive must produce identical outputs for identical inputs. The UI is forms and lists — easy to build and easy to verify visually. The crypto is ~200 lines per platform but **high risk** — one wrong byte means the mobile app cannot read blobs written by the CLI.

| Cryptographic primitive | Risk of incompatibility |
|---|---|
| PBKDF2-HMAC-SHA256 (600,000 iterations) | Low — standard algorithm, but iteration count and output length must match exactly |
| AES-CTR encrypt/decrypt | Medium — CTR mode requires matching counter width and initialization vector handling |
| HMAC-SHA256 | Low — standard algorithm |
| SHA-256 | Low — standard algorithm |
| Blob obfuscation (4-tier pad + HMAC sub-key) | **High** — custom algorithm defined in PHPSPEC.md, no standard library implementation |
| Device cookie format | Low — plain JSON |

### Mitigation: crypto test vector suite

Create a shared JSON file (`crypto_test_vectors.json`) with known inputs and expected outputs for every primitive and every edge case. ALL implementations (Swift, Kotlin, Rust, Web Crypto API, Python test suite) must pass these vectors before any UI work begins.

```
crypto_test_vectors.json
├── pbkdf2
│   ├── standard_iterations (600K)
│   └── fallback_iterations (100K, pre-R3 ledgers)
├── aes_ctr_encrypt
├── aes_ctr_decrypt
├── hmac_sha256
├── sha256
├── blob_obfuscation
│   ├── pad_to_tier (4 tiers)
│   ├── encrypt_with_sub_key
│   ├── decrypt_with_correct_key
│   └── fail_decrypt_with_wrong_key
└── device_cookie
    ├── serialize
    └── deserialize
```

---

## 4. Platform Strategy

### How platforms handle the crypto gap

| Platform | PBKDF2 | AES-CTR | HMAC | SHA-256 | Keychain Storage |
|---|---|---|---|---|---|
| **Swift (iOS native)** | CryptoKit ✓ | CryptoKit ✓ | CryptoKit ✓ | CryptoKit ✓ | Keychain ✓ |
| **Kotlin (Android native)** | JCA ✓ | JCA (Bouncy Castle for CTR) ✓ | JCA ✓ | JCA ✓ | EncryptedSharedPreferences ✓ |
| **React (Web)** | Web Crypto API ✓ | Web Crypto API ✓ | Web Crypto API ✓ | Web Crypto API ✓ | IndexedDB (no Keychain) ✗ |
| **React Native** | ❌ — no Web Crypto in JSC/Hermes | ❌ — needs native module or `react-native-quick-crypto` | ⚠️ partial | ✓ | Keychain via native module |
| **Flutter (Dart)** | ❌ — no PBKDF2 in `package:crypto` | ❌ — no AES in `package:crypto` | ✓ HMAC only | ✓ | Keychain via platform channel |
| **Rust (portable core)** | `ring` ✓ | `ring` ✓ | `ring` ✓ | `ring` ✓ | N/A (platform-specific) |

### Option A: React → React Native → Flutter

**Phase 1: React (Web)**
- Crypto via Web Crypto API — quick, correct, zero dependencies
- UI iteration fast — hot reload, browser dev tools
- Ships immediately on laptop
- **Deployable web app from week one**

**Phase 2: React Native**
- Crypto: Web Crypto API is unavailable in JSC/Hermes. Must re-implement via native module (Swift/Kotlin) or `react-native-quick-crypto` (Node.js API polyfill with native C++ backend)
- UI: Port from React (DOM) to React Native (native components). Significant rework — RN is not "React on mobile," it's a different rendering engine with different components, navigation, and gesture handling
- Bridge overhead: Every PBKDF2 call crosses JS ↔ native boundary

**Phase 3: Flutter**
- Crypto: Re-implement again — Dart has no PBKDF2 or AES. Requires either platform channels (back to Swift/Kotlin) or FFI via `flutter_rust_bridge`
- UI: Complete rewrite in Dart/Widgets
- Three independent codebases to maintain

**Cost: 3 crypto implementations, 3 UI implementations, high risk of crypto drift across platforms.**

### Option B: iOS (Swift) first → Android (Kotlin) port

**Phase 1: iOS (Swift)**
- CryptoKit has all primitives built-in — no FFI, no bridging, no external dependencies
- Sync algorithm ported from CLI reference (~50 lines of branching + crypto calls)
- Validated against test vectors — this implementation becomes the reference for all other platforms
- Keychain for secure master key storage — OS-level protection, no IndexedDB concerns
- SwiftUI for native look and feel

**Phase 2: Android (Kotlin)**
- Crypto via Java Cryptography Architecture (JCA) — same interfaces, different API
- Sync algorithm ported from CLI reference (same logic, Kotlin syntax)
- Tested against THE SAME test vectors — guaranteed CLI ↔ iOS ↔ Android compatibility
- EncryptedSharedPreferences for secure master key storage

**Cost: 2 crypto implementations (Swift + Kotlin), 2 UI implementations. Crypto risk is front-loaded and de-risked by shared test vectors.**

### Option C: Rust crypto core + any UI (recommended)

**Phase 0: Rust crypto library (`phpoc-crypto-core`)**
- Implements all primitives: PBKDF2, AES-CTR, HMAC, SHA-256, blob obfuscation, cookie format
- Uses `ring` crate (BoringSSL bindings, audit-grade crypto)
- Wrapped in a clean C API via `uniffi` or `cbindgen`
- Tested once against the `crypto_test_vectors.json` suite

**Phase 1: Any UI framework (React web first suggested)**
- Web: Compile Rust→WASM via `wasm-pack`. Import as `npm install phpoc-crypto-core`
- React Native: Compile Rust→.a/.so. Bind via turbo module or `uniffi-rs`
- Flutter: Compile Rust→.a/.so. Bind via `flutter_rust_bridge`
- Swift native: Compile Rust→.a. Bind via C bridge header
- Kotlin native: Compile Rust→.so. Bind via JNI (`uniffi-rs` generates Kotlin bindings)

**Cost: 1 crypto implementation, 1 UI implementation (or many, but crypto is never re-done).** Crypto is developed once, compiled to every target.

---

## 5. Chosen Direction

**Decision (2026-06-01): Rust crypto core + React web first.**
The team has committed to building a portable Rust crypto library (`phpoc-crypto-core`)
compiled to WASM (web) and static libraries (iOS, Android), with a React web app as the
first UI target. Crypto is written once, verified against the test vector suite, and reused
across all platforms. See the phased plan below.

### Chosen approach: Rust crypto core + React web first

```
         ┌──────────────────────────┐
         │   phpoc-crypto-core      │  ← One Rust library
         │   (ring + blob obfus.)   │
         └────┬────────┬────────┬───┘
              │        │        │
         WASM │    .a/.so   .a/.so
              │        │        │
         ┌────┴┐  ┌───┴──┐  ┌──┴───┐
         │ Web │  │  RN  │  │Flutter│
         │React│  │  App │  │ App  │
         └─────┘  └──────┘  └──────┘
```

| Phase | Platform | Crypto | UI | Time Estimate |
|---|---|---|---|---|
| 0 | Rust crypto library | All primitives, test vectors, WASM target | N/A | 1-2 weeks |
| 1 | React (web) | Rust → WASM (already done in Phase 0) | React components | 2-4 weeks |
| 2 | React Native | Rust → .a/.so (already done in Phase 0) | RN components (port UI) | 2-4 weeks |
| 3 | Optional: Flutter | Rust → .a/.so (already done in Phase 0) | Flutter widgets (port UI) | 2-4 weeks |

**Why this wins:**

1. **Crypto is implemented once.** The Rust library is compiled to WASM (web), .a (iOS, Swift), and .so (Android, Kotlin). There is exactly one implementation to audit, test, and maintain.

2. **The web app ships first.** React + Rust WASM works on a laptop with `npm start`. The user can begin testing the full workflow (start task, sync, view history) from day one. The crypto is already correct because it's the same Rust code that will power the mobile app.

3. **The RN/Flutter apps are UI ports, not re-implementations.** The hard part (crypto, sync algorithm, blob format) is a compiled binary that every platform imports. The mobile UI is a greenfield build anyway — whether you write it in RN, Flutter, or SwiftUI, you're building screens and navigation. The difference is whether you also re-implement PBKDF2.

4. **Contract testing is trivial.** Because every platform uses the same Rust binary, `crypto_test_vectors.json` tests the Rust library once. The platform-specific test is: "does the HTTP client send/receive bytes correctly?" — a much simpler test.

### Deferred alternative: Swift first (if Rust ecosystem proves unfamiliar)

If the team has no Rust experience and the WASM/FFI build chain proves impractical,
Swift-first remains a viable fallback:

| Phase | Platform | Time Estimate |
|---|---|---|
| 1 | iOS (Swift + CryptoKit) | 3-6 weeks |
| 2 | Android (Kotlin + JCA) | 2-4 weeks |
| 3 | Optional: React web (Web Crypto API) | 2-3 weeks |

The crypto implementations are separate but verified against shared test vectors. The cost is higher maintenance over time (two independent crypto backends), but the immediate risk is low because CryptoKit and JCA are both well-audited standard libraries.

### What we explicitly recommend against

| Path | Reason |
|---|---|
| React → React Native → Flutter **without a portable crypto core** | Three independent crypto implementations. High probability of drift. Every platform change requires re-testing compatibility with the CLI. |
| React Native as the first platform (without web prototyping first) | Slowest iteration cycle. Debugging crypto across the JS ↔ native bridge on a real device is harder than debugging Web Crypto API in a browser console. |
| Flutter first | Dart's lack of PBKDF2 and AES means you immediately need an FFI dependency. If you're writing native code anyway (via `flutter_rust_bridge`), start with the Rust library and decouple the UI choice. |

---

## 6. Crypto Library

### Rust crate: `phpoc-crypto-core`

```
phpoc-crypto-core/
├── Cargo.toml
├── src/
│   ├── lib.rs              # Public API, re-exports
│   ├── pbkdf2.rs           # PBKDF2-HMAC-SHA256 (600K + 100K fallback)
│   ├── aes_ctr.rs          # AES-256-CTR encrypt/decrypt
│   ├── hmac.rs             # HMAC-SHA256 sign/verify
│   ├── sha256.rs           # SHA-256 hash
│   ├── random.rs           # Secure random bytes
│   ├── blob_obfuscation.rs # 4-tier pad + HMAC sub-key (per PHPSPEC.md)
│   ├── cookie.rs           # Device cookie JSON serialize/deserialize
│   └── key_derivation.rs   # Master key → sub-key derivation
├── tests/
│   ├── crypto_test_vectors.json
│   └── integration_test.rs # Test against vectors
├── build.rs                 # uniffi build script (optional, for auto-generated bindings)
└── phpoc_crypto.h           # C header for direct FFI (generated by cbindgen)
```

### Dependencies

| Crate | Purpose | Audit Status |
|---|---|---|
| `ring` | PBKDF2, AES-CTR, HMAC, SHA-256 (BoringSSL bindings) | BoringSSL is FIPS 140-2 validated |
| `getrandom` | Secure random bytes | Supported by all targets (WASM, iOS, Android) |
| `serde` / `serde_json` | Cookie JSON serialization | Standard |
| `wasm-bindgen` (dev) | WASM target bindings | For web builds |
| `uniffi` (optional) | Auto-generated Kotlin/Swift bindings | For native mobile builds |

### Build targets

```
phpoc-crypto-core (Rust)
├── wasm32-unknown-unknown  →  phpoc_crypto_core.wasm   (web: React, etc.)
├── aarch64-apple-ios       →  libphpoc_crypto_core.a   (iOS: Swift native or RN)
├── aarch64-linux-android   →  libphpoc_crypto_core.so  (Android: Kotlin native or RN)
└── x86_64-unknown-linux-gnu → libphpoc_crypto_core.so  (Linux: CLI test harness, CI)
```

### Integration per platform

| Platform | Build Target | Integration Method | Lines of Glue |
|---|---|---|---|
| React (web) | WASM | `npm install phpoc-crypto-core` + async import | ~10 lines of JS |
| React Native | .a / .so | Turbo native module wrapping C functions | ~50 lines of ObjC/Kotlin |
| Flutter | .a / .so | `flutter_rust_bridge` auto-generates Dart bindings | 0 lines (auto-generated) |
| Swift native | .a | Xcode project includes static lib + C header | ~20 lines of Swift FFI |
| Kotlin native | .so | `uniffi-rs` generates Kotlin bindings | 0 lines (auto-generated) |

---

## 7. Layering SaaS Features

### The design principle

**The client always pushes what the server needs to know, in a form the server can use — but the client chooses what that is.**

The user's private ledger stays encrypted. The server is a dumb store. SaaS features are implemented by having the client publish structured data alongside the encrypted blobs, and by adding independent services that read only the metadata the client explicitly reveals.

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

Sharing is a key-exchange protocol between clients. The server stores opaque bytes.

### Team Dashboards

**Approach A: Client-side aggregation** (small teams, 2-10 people)
Each client fetches all team members' encrypted blobs, decrypts locally, renders charts. Feasible because each blob is small (<100KB).

**Approach B: Opt-in plaintext summaries** (scales to any team size)
The client pushes daily aggregate summaries alongside the encrypted blob:

```
/summaries/2026/06/01/user_abc.json
```

Format: `{"tag_hours": {"coding": 4.5, "reading": 1.2}, "hmac": "..."}` — plaintext but HMAC-signed with a derivation of the master key. The server or a dashboard frontend reads these for team-level charts without ever decrypting the private ledger.

### Notifications

A separate Cron Trigger Worker (independent of the data plane):

1. Lists paths under `/users/{user_id}/staging/`
2. Checks for stale active tasks (detectable from blob size or a tiny metadata flag the client writes alongside the blob)
3. Fires APNs / FCM

No data decryption needed. The notification Worker knows *that* a task is active, but not *what* it is.

### Social Features (Signed Proofs)

"Tracked 500 hours of guitar practice" → the client generates a signed block export (the block is already HMAC-sealed per PHPSPEC.md) and posts it to a public path. Anyone can verify the HMAC against the user's public identity key.

### What Cannot Be Layered

| Feature | Why It Doesn't Work | Workaround |
|---|---|---|
| Server-side search across all users | Server can't decrypt | Per-user client-side search, or opt-in plaintext summaries |
| Server-computed streaks | Server can't read dates | Client pushes a daily presence flag: `/streaks/{user_id}/{date}.txt` with HMAC proof |
| Server-side tag analytics | Can't read tags | Client pushes tag-aggregate summaries (count per tag, plaintext or encrypted) |
| Full-text search of entries | Encrypted fields are opaque to server | Client indexes locally (SQLite FTS); search is local-only |

### The layered architecture

```
                    ┌─────────────────────────────┐
                    │   Dashboard Frontend         │ ← reads plaintext summaries
                    │   (React, static site)        │
                    └──────┬──────────────────────┘
                           │
┌──────────────────────────┼──────────────────────────────┐
│   SaaS Layer (separate concerns)                         │
│                                                          │
│  ┌───────────────────┐    ┌────────────────────────┐    │
│  │ User Registration │    │ ShareCoordinator       │    │
│  │ (KV store)        │    │ (key exchange routing) │    │
│  └───────────────────┘    └────────────────────────┘    │
│                                                          │
│  ┌────────────────────────────────────────────────┐     │
│  │ Notification Cron (reads metadata flags,       │     │
│  │  NEVER encrypted content)                      │     │
│  └────────────────────────────────────────────────┘     │
└──────────────────────────┬──────────────────────────────┘
                           │
                    ┌──────┴──────┐
                    │  Data Plane │ (unchanged — dumb Worker)
                    └──────┬──────┘
                           │
                    ┌──────┴──────┐
                    │     R2      │
                    ├─────────────┤
                    │ /users/*    │ ← user-prefixed
                    │ /summaries/ │ ← opt-in plaintext
                    │ /shares/*   │ ← shared blobs
                    └─────────────┘
```

---

## 8. Key Design Principles

### 1. The Worker stays dumb

The server is an opaque byte store with no domain knowledge. All intelligence lives on the client. This is the foundation of zero-knowledge and cross-platform compatibility.

### 2. Crypto is written once, compiled everywhere

A portable Rust library (`phpoc-crypto-core`) implements all cryptographic primitives. WASM for web, static libraries for native, FFI for cross-platform frameworks. One test suite, one audit, one maintenance burden.

### 3. The client publishes what the server needs

SaaS features are built by having the client opt-in to publishing structured data (summaries, presence flags, signed proofs) alongside the encrypted blobs. The server never decrypts anything.

### 4. CLI compatibility is guaranteed by contract, not by sharing code

The CLI and mobile are independent clients of the same Worker. They are compatible because they implement the same wire protocol and the same crypto primitives, verified by a shared test vector suite. No SDK sharing required.

### 5. Local-first, offline-capable

Writes hit local storage first. Sync is background and opportunistic. The user can start, end, pause, and view tasks without any network connectivity. This is the same architecture as the CLI's WAL.

### 6. Biometric unlock is a cache convenience, not an auth mechanism

The passphrase is the source of truth. Biometric unlocks a Keychain-stored encrypted master key. If biometrics fail or are reconfigured, the app falls back to passphrase.

---

## 9. Glossary

| Term | Definition |
|---|---|
| **Worker** | Cloudflare Worker (149-line TypeScript HTTP-to-R2 proxy). The entire remote storage interface. |
| **Dumb Worker** | A Worker with no knowledge of the data model. It stores and retrieves opaque bytes. |
| **Smart Client** | The mobile app or CLI. All encryption, decryption, sync logic, and merge logic lives here. |
| **PHPSPEC.md** | The format specification defining crypto primitives, block structure, and key derivation. |
| **Crypto test vectors** | A JSON file with known inputs and expected outputs for every cryptographic primitive. All platform implementations must pass these vectors. |
| **`phpoc-crypto-core`** | Proposed Rust library implementing all PHPSPEC crypto primitives, compilable to WASM, .a, and .so. |
| **KDF** | Key derivation function. PBKDF2-HMAC-SHA256 with 600,000 iterations (or 100,000 for pre-R3 ledgers). |
| **Blob obfuscation** | Custom 4-tier padding + HMAC sub-key encryption for remote staging blob transport. Defined in PHPSPEC.md. |
| **Merge engine** | Dedup logic that reconciles staging entries across devices by `entry_id`. |
| **Sync algorithm** | `check_and_sync()` — the ~50-line branching flow for device cookie verification, blob pull/push, and reconciliation. |
| **WASM** | WebAssembly. Target for compiling Rust to run in the browser. |
| **FFI** | Foreign Function Interface. How Rust compiled to .a/.so is called from Swift, Kotlin, Dart, etc. |
| **`ring`** | Rust crate providing PBKDF2, AES-CTR, HMAC, and SHA-256 (BoringSSL bindings). |
| **uniffi** | Mozilla tool for auto-generating Kotlin and Swift bindings from a Rust library. |
| **Opt-in plaintext summary** | A client-published JSON file containing daily aggregate data (tag hours, etc.) stored alongside the encrypted blob. HMAC-signed but not encrypted — readable by dashboards and servers. |
| **Bearer token** | A per-device token (stored in KV) for distinguishing devices. Optional addition beyond the shared API key. |

---

## References

- `worker/src/index.ts` — Current Cloudflare Worker (149 lines, dumb blob store)
- `core/sync/http_transport.py` — Python HTTP transport client (wire protocol reference)
- `domain/ledger/remote_sync.py` — Ledger block sync via HTTP (path constants, push/pull logic)
- `domain/staging/remote_sync.py` — Staging blob sync + device cookie (blob obfuscation, cookie format)
- `domain/staging/service.py` — Auth gate, `check_and_sync()`, `_reconcile_and_claim()` (sync algorithm reference)
- `PHPSPEC.md` — Format specification (crypto, block structure, key derivation)
- `SESSION_HANDOFF.md` — Current state of the CLI reference implementation
- `MOBILE_ROADMAP.md` — Mobile roadmap (revised, reflects these decisions)
