# PHPOC — Mobile Roadmap

> **Goal:** A native mobile app (iOS/Android) that reads and writes a PHPOC ledger,
> interoperating with the existing CLI reference implementation through the remote
> sync infrastructure (HTTP → Cloudflare Worker → R2).

---

## Architecture Decision (2026-06-01)

**After architectural review, the recommendation has shifted from "Hybrid (Option C)" to a clear "Smart Client + Dumb Worker" model.**

The existing 149-line Cloudflare Worker already handles everything the mobile app needs — GET/PUT/LIST of opaque bytes by path. The mobile app is a **port of the CLI's remote sync layer**, not an integration with a new API server. The Worker stays:

- **Stateless** — no Durable Objects, no KV for sessions
- **Dumb** — cannot decrypt anything, knows nothing about the data model
- **Tiny** — ~170 lines including CORS and optional token check

**No REST API layer is needed between the mobile app and the Worker.** The protocol is three HTTP verbs:

| Operation | Worker Request | Worker Response |
|-----------|---------------|-----------------|
| Read blob | `GET /{path}` | 200 + bytes, 304 (ETag match), or 404 |
| Write blob | `PUT /{path}` | 200 |
| List blobs | `GET ?prefix={prefix}` | JSON array of keys |

The mobile app sends the same `X-Api-Key` header and uses the same path constants as the CLI. The Worker doesn't know or care which client is talking to it.

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

#### 1. Minimal Worker Additions (~20 lines)

The current Worker needs three small additions for mobile compatibility:

| Addition | Lines | Why |
|----------|-------|-----|
| CORS headers | ~5 | Mobile fetch requests from dev builds, WebView, or arbitrary origins |
| Optional bearer token check | ~5 | Per-device auth (separate from the shared API key) — a simple KV lookup, not a session system |
| Structured JSON wrapper (optional) | ~10 | Thin JSON coat on GET/PUT responses for mobile convenience (e.g., `{"data": "<base64>", "etag": "..."}`) |

That's the entire delta. The Worker stays under 200 lines, stateless, and domain-ignorant.

**The mobile app does not need:**
- Session tokens (the passphrase is the auth mechanism — it never leaves the device)
- A server-side sync endpoint (sync runs client-side, just like the CLI)
- CRUD endpoints for staging (the mobile app manipulates its local cache, then pushes the full blob)
- An OpenAPI spec (the protocol is three HTTP verbs, fully defined by `core/sync/http_transport.py`)

#### 2. Wire Protocol — Already Defined (No New Work)

The mobile app implements the same three-operation protocol that the CLI's `HttpStagingTransport` uses:

```
GET  /{path}                    → bytes | None (404)
PUT  /{path}  (body: bytes)     → None
GET  ?prefix={prefix}           → List[str]
```

The storage paths are constants from the CLI reference — the mobile app uses the exact same strings:

| Data | R2 Path (CLI constant) | Defined In |
|------|------------------------|------------|
| Staging blob | `staging/blobs/current.json` | `domain/staging/remote_sync.py:77` |
| Device cookie | `staging/blobs/device_cookie.bin` | `domain/staging/remote_sync.py:42` |
| Ledger blocks | `ledger/blocks/{seq}.json` | `domain/ledger/remote_sync.py:39` |
| Ledger index | `ledger/index.json` | `domain/ledger/remote_sync.py:40` |

ETag caching (conditional GETs with `If-None-Match` / `304 Not Modified`) is strongly recommended for the mobile app to minimize data transfer on slow cellular connections.

#### 3. Native Crypto SDK (Swift / Kotlin)

A mobile app can't shell out to Python. Needed reimplementations:

| Primitive | Used For | iOS API | Android API |
|-----------|----------|---------|-------------|
| PBKDF2-HMAC-SHA256 (600K iter) | Passphrase → PDK | `CryptoKit.PBKDF2` | `SecretKeyFactory("PBKDF2WithHmacSHA256")` |
| AES-CTR encrypt/decrypt | Field-level encryption | `CryptoKit.AES` (CTR mode) | `Cipher("AES/CTR/NoPadding")` |
| HMAC-SHA256 | Block seals, auth tags, blob obfuscation | `CryptoKit.HMAC` | `Mac("HmacSHA256")` |
| SHA-256 | Content hashing, entry hashing | `CryptoKit.SHA256` | `MessageDigest("SHA-256")` |
| Random 32 bytes | Entry IDs, device specifiers | `SecRandomCopyBytes` | `SecureRandom` |
| Blob obfuscation (4-tier pad + HMAC sub-key) | Remote staging transport | Custom per PHPSPEC | Custom per PHPSPEC |

The format spec (`PHPSPEC.md`) defines all of these precisely. This is a port, not a design task.

**Test vector suite**: Create a shared JSON file (`crypto_test_vectors.json`) with known inputs and expected outputs for every primitive. Both the Swift and Kotlin implementations must pass these vectors before any UI work begins. This prevents subtle cross-platform crypto bugs and ensures CLI ↔ mobile compatibility.

#### 4. Device Identity (Mobile)

Each mobile device needs:
- A persistent UUID4 (stored in Keychain / EncryptedSharedPreferences)
- HMAC-SHA256 proof derived from the master key
- `device_label` for user-friendly identification in the sync UI

The existing `security/device_identity.py` is the reference. The mobile implementation mirrors it.

#### 5. Sync Algorithm — Port, Don't Re-invent

The mobile app must replicate the CLI's `check_and_sync()` logic from `domain/staging/service.py`. It's ~50 lines of branching — not an SDK dependency:

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

### 🟡 Phase 2 — Core Mobile UX (Should Have)

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
| `ph verify` | Settings → Chain Verification |
| `ph recover` | Settings → Advanced → Recover from Seed |

#### 7. Auth Flow (Mobile)

```
1. First launch → prompt for passphrase
2. PBKDF2-600K locally → derive master key → cache in memory
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

**Note:** PBKDF2-600K takes ~500ms on desktop, likely 2-3s on mobile. Run it on a background thread with a spinner — never block the main thread.

#### 8. Background Sync

- WAL-based: queue writes locally, push on connectivity
- Daemon-like periodic check via BGTaskScheduler (iOS) / WorkManager (Android)
- Conflict resolution via existing `MergeEngine` (dedup by `entry_id`)
- Cookie management: touch local cookie on writes, reconcile on specifier mismatch
- **Optimistic UI**: writes appear immediately; a subtle "pending" indicator shows un-synced changes
- **Sync badge**: visual indicator of pending changes (like `ph dev push-status`)

### 🟢 Phase 3 — Parity (Nice to Have)

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

## Prerequisites (Must Exist Before Mobile Sprint Starts)

| # | Item | Est. Effort | Depends On |
|---|------|-------------|------------|
| 1 | Worker: CORS headers + optional bearer token | 1 day | Current Worker |
| 2 | Crypto test vector suite (JSON) | 1 day | PHPSPEC.md |
| 3 | Native crypto SDK (Swift) | 1-2 weeks | Test vectors + PHPSPEC.md |
| 4 | Native crypto SDK (Kotlin) | 1-2 weeks | Test vectors + PHPSPEC.md |
| 5 | Device identity (mobile) | 1-2 days | Native crypto SDK |

---

## Answered Decisions

| Question | Answer |
|----------|--------|
| **API Worker: extend or separate?** | Extend the existing Worker with ~20 lines. No separate service needed. |
| **Auth: API key vs session tokens?** | API key (shared secret) is sufficient. The passphrase is the real auth mechanism — it never leaves the device. No session tokens, no OAuth. |
| **Stateless or stateful API?** | Stateless. The Worker has no session state. Mobile handles cookies and auth locally. |
| **Which mobile platform first?** | **iOS (Swift)** — CryptoKit has all primitives built-in (PBKDF2, AES-CTR, HMAC, SHA-256) with no FFI needed. Fewer device targets. Port to Android (Kotlin) after iOS is working. Cross-platform (Flutter/React Native) is not recommended due to native crypto FFI complexity. |
| **Shared Python SDK?** | Not needed. The mobile app ports the sync algorithm natively — it's ~100 lines of branching + crypto calls. A Python SDK would only be useful if you build a server-side component, which the architecture explicitly avoids. |
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
