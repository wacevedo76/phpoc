# PHPOC — Mobile Roadmap

> **Goal:** A native mobile app (iOS/Android) that reads and writes a PHPOC ledger,
> interoperating with the existing CLI reference implementation through the remote
> sync infrastructure (HTTP → Cloudflare Worker → R2).

---

## Status

| Layer | CLI (Reference) | Mobile |
|-------|:---------------:|:------:|
| Core engine (chain, crypto, storage) | ✅ | ❌ |
| CLI UX (`add`, `view`, `sync`, `verify`) | ✅ | N/A |
| Remote staging sync | ✅ | ❌ |
| Auth gate (device cookies) | ✅ | ❌ |
| Cross-device handoff | ✅ | ❌ |
| Ledger block sync | ✅ | ❌ |
| Format spec (`PHPSPEC.md`) | ✅ | ✅ |

---

## What a Mobile App Needs

### 🔴 Phase 1 — Foundation (Must Have)

#### 1. Structured REST API

The current Cloudflare Worker (`worker/src/index.ts`) is a **dumb blob store** — GET/PUT/LIST of opaque bytes. A mobile app needs a structured API that speaks JSON, not opaque blobs. This is the single largest gap.

**Proposed endpoints:**

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `POST` | `/api/v1/auth/login` | Passphrase → session token |
| `POST` | `/api/v1/auth/logout` | Clear session |
| `GET` | `/api/v1/staging` | List staging entries |
| `POST` | `/api/v1/staging` | Add a staging entry |
| `PUT` | `/api/v1/staging/:id/end` | End a task |
| `PUT` | `/api/v1/staging/:id/pause` | Pause/resume |
| `PUT` | `/api/v1/staging/:id` | Modify entry |
| `DELETE` | `/api/v1/staging/:id` | Remove entry |
| `GET` | `/api/v1/staging/blob` | Get obfuscated blob bytes |
| `PUT` | `/api/v1/staging/blob` | Replace blob bytes |
| `GET` | `/api/v1/cookie` | Get device cookie state |
| `PUT` | `/api/v1/cookie` | Update device cookie |
| `POST` | `/api/v1/sync` | Commit staging → ledger |
| `GET` | `/api/v1/ledger/blocks` | List ledger block indices |
| `GET` | `/api/v1/ledger/blocks/:index` | Get a ledger block |
| `PUT` | `/api/v1/ledger/blocks/:index` | Push a ledger block |
| `GET` | `/api/v1/ledger/verify` | Check chain integrity |
| `GET` | `/api/v1/reputation` | Blind index queries |

**Design decisions to make:**
- **Stateless or stateful API?** Stateless (current dumb Worker) keeps crypto on the client. Stateful API could handle auth tokens, session management, and push notifications but requires a stateful server.
- **API versioning** (`/api/v1/...`) for future evolution.
- **Auth model:** API key (current) vs session tokens vs OAuth. Mobile needs session tokens — the API key is a shared secret, not per-user.

#### 2. HTTP Ledger Sync Client (Python SDK)

The existing `RemoteLedgerSync` in `domain/ledger/remote_sync.py` is wired only for CLI use. Need:

- HTTP endpoints for ledger block push/pull with chain verification
- An `HttpLedgerTransport` analogous to `HttpStagingTransport`
- Sync orchestrator that coordinates staging + ledger over HTTP
- ETag caching for ledger blocks (same pattern as staging)

This could be built as a shared Python package (`phpoc-sdk`) that both the CLI and a future mobile backend could use.

#### 3. Native Crypto SDK (Swift / Kotlin)

A mobile app can't shell out to Python. Needed reimplementations:

| Primitive | Used For | Mobile API |
|-----------|----------|------------|
| PBKDF2-HMAC-SHA256 (600K iter) | Passphrase → PDK | `CryptoKit.PBKDF2` / `SecretKeyFactory` |
| AES-CTR encrypt/decrypt | Field-level encryption | `CryptoKit.AES` / `Cipher` |
| HMAC-SHA256 | Block seals, auth tags, blob obfuscation | `CryptoKit.HMAC` / `Mac` |
| SHA-256 | Content hashing, entry hashing | `CryptoKit.SHA256` / `MessageDigest` |
| Random 32 bytes | Entry IDs, device specifiers | `SecRandomCopyBytes` / `SecureRandom` |
| Blob obfuscation (4-tier pad + HMAC sub-key) | Remote staging transport | Custom implementation per spec |

The format spec (`PHPSPEC.md`) defines all of these precisely. This is a port, not a design task.

#### 4. Device Identity (Mobile)

Each mobile device needs:
- A persistent UUID4 (stored in Keychain / EncryptedSharedPreferences)
- HMAC-SHA256 proof derived from the master key
- `device_label` for user-friendly identification in the sync UI

The existing `security/device_identity.py` is the reference. The mobile implementation mirrors it.

### 🟡 Phase 2 — Core Mobile UX (Should Have)

#### 5. Mobile Staging CRUD

The core workflow for a mobile time tracker:

- **Start task** (capture with title, optional tags)
- **View active tasks** (list running tasks with elapsed time)
- **End task** (stop, compute duration)
- **Pause / resume** (interruptions)
- **View history** (recent staged entries)
- **Quick-add** (one-off completed entry)

All local-first: writes hit local storage first, sync to remote in background.

#### 6. Auth Flow (Mobile)

```
1. First launch → prompt for passphrase
2. PBKDF2-600K locally → derive master key → cache in memory
3. Derive device identity → create/update device cookie on remote
4. Pull remote staging blob → decrypt locally → merge into local
5. On subsequent launches: check cookie TTL → fast path if valid
   → otherwise re-prompt for passphrase
```

Biometric unlock (FaceID / fingerprint) as a convenience for the in-memory cache.

#### 7. Background Sync

- WAL-based: queue writes locally, push on connectivity
- Daemon-like periodic check (Phase C equivalent)
- Conflict resolution via existing `MergeEngine` (dedup by `entry_id`)
- Cookie management: touch local cookie on writes, reconcile on specifier mismatch

### 🟢 Phase 3 — Parity (Nice to Have)

#### 8. Ledger Sync (Commit)

- `ph sync` equivalent: commit staged entries to the ledger chain
- Chain verification on device
- Push new blocks to remote
- Pull remote blocks and verify chain linkage

#### 9. History & Reputation

- Browse committed ledger history by day / month / year
- Blind index queries (reputation with date range)
- Chain verification display
- Search / filter by tags

#### 10. Export & Share

- Portable export (`--range` block-level export)
- Tag-signed manifest for sharing on social platforms
- Read-only view URLs (if API server supports it)

---

## Architectural Options

### Option A: Thin Client + Thick API Server

```
[Mobile App] ←→ [API Server] ←→ [Worker] ←→ [R2]
```

- API server handles auth, session management, crypto
- Mobile app is thin: sends/receives plaintext JSON, no local crypto
- Pro: simpler mobile app, faster to build
- Con: server sees decrypted data (defeats zero-knowledge goal)

### Option B: Thick Client + Dumb Worker (Current Model)

```
[Mobile App (crypto)] ←→ [Worker] ←→ [R2]
```

- Mobile app does all crypto locally (Swift CryptoKit / Android Keystore)
- Worker remains dumb: GET/PUT opaque bytes
- Pro: zero-knowledge preserved, reuses existing Worker
- Con: full crypto SDK needed for mobile, heavier app

### Option C: Hybrid

```
[Mobile App (crypto)]  ←→  [Lightweight API] ←→ [Worker] ←→ [R2]
```

- Mobile app does crypto locally
- API layer provides structured endpoints but never sees plaintext
- API handles: auth tokens, push notifications, multi-device coordination
- Pro: best of both worlds
- Con: most infrastructure to build

**Recommendation:** Option C. The existing Worker is already deployed and battle-tested.
Add a lightweight API layer (Cloudflare Workers with a Router, or a separate small service)
that understands the data model but doesn't handle plaintext. Mobile does crypto locally.

---

## Prerequisites (Must Exist Before Mobile Sprint Starts)

| # | Item | Est. Effort | Depends On |
|---|------|-------------|------------|
| 1 | REST API spec (OpenAPI 3.0) | 1-2 days | Current Worker + PHPSPEC.md |
| 2 | API Worker implementation | 1-2 weeks | Spec |
| 3 | HTTP ledger transport (Python SDK) | 3-5 days | API endpoints |
| 4 | Auth token flow (login/logout/sessions) | 3-5 days | API Worker |
| 5 | Native crypto SDK (Swift) | 1-2 weeks | PHPSPEC.md |
| 6 | Native crypto SDK (Kotlin) | 1-2 weeks | PHPSPEC.md |
| 7 | Device identity (mobile) | 1-2 days | Native crypto SDK |

---

## Questions to Resolve

1. **API Worker: extend the existing Worker or build a separate service?**
   - Extend: simpler ops (one deploy target), but the Worker's 128KB response body limit and 30s CPU time may constrain
   - Separate: more infra, but can use any stack (FastAPI, etc.)
   - Middle ground: Cloudflare Workers with [Hono](https://hono.dev/) router for structured API, keep R2 access

2. **Auth: API key (current) vs session tokens?**
   - Current API key is a single shared secret — fine for CLI, wrong for mobile (no per-user isolation)
   - Session tokens require a state store (Durable Objects, SQLite, or KV)
   - Could the passphrase itself be the auth mechanism? (Mobile derives key, signs a challenge)

3. **Which mobile platform first?**
   - iOS (Swift) — fewer device targets, CryptoKit has PBKDF2/AES/HMAC built-in
   - Android (Kotlin) — wider audience, but more fragmentation
   - Cross-platform (Flutter / React Native) — single codebase, but native crypto requires FFI

4. **Do we build a shared SDK package first?**
   - A `phpoc-sdk` Python package with `HttpStagingTransport`, `HttpLedgerTransport`,
     `RemoteLedgerSync`, and `DeviceIdentityProvider` would decouple the API client
     from the CLI tool. The mobile backend (if any) could reuse it.

---

## References

- `worker/src/index.ts` — Current Cloudflare Worker (149 lines, dumb blob store)
- `core/sync/http_transport.py` — Python HTTP transport client
- `domain/ledger/remote_sync.py` — Ledger block sync via HTTP
- `domain/staging/remote_sync.py` — Staging blob sync + device cookie
- `domain/staging/service.py` — Auth gate, `check_and_sync()`, `_reconcile_and_claim()`
- `PHPSPEC.md` — Format specification (crypto, block structure, key derivation)
- `SESSION_HANDOFF.md` — Current state of the CLI reference implementation
