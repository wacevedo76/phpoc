# System Architecture — PH Ledger (phpoc)

> **Audience:** Implementers, contributors, and anyone seeking a single-document
> overview of the full PHPOC system — from key derivation to cross-platform strategy.
> **Status:** Living document. Updated as architecture evolves.

This document synthesizes the 11 top-level directives (D1–D11), 26 Architectural
Decision Records (ADR-001 through ADR-026), cross-platform strategy, and reference
implementations into one coherent system description. It is the map; the ADRs,
PHPSPEC.md, and source code are the territory.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Key Hierarchy](#2-key-hierarchy)
3. [Chain Structure](#3-chain-structure)
4. [Staging Pipeline](#4-staging-pipeline)
5. [Transport Layer](#5-transport-layer)
6. [Multi-Device Sync](#6-multi-device-sync)
7. [Cross-Platform Strategy](#7-cross-platform-strategy)
8. [Crypto Core (`phpoc-crypto-core`)](#8-crypto-core-phpoc-crypto-core)
9. [Web Application (`phpoc-web`)](#9-web-application-phpoc-web)
10. [CLI Reference Implementation](#10-cli-reference-implementation)
11. [Architectural Invariants](#11-architectural-invariants)

---

## 1. System Overview

PHPOC is an **open, encrypted, self-sovereign ledger format** for personal activity
tracking. It has four major subsystems:

```
┌──────────────────────────────────────────────────────────┐
│                     CLI (Python)                          │
│  main.py → cli/ → core/sync/ → domain/ → security/       │
│  Pure Python stdlib. Reference implementation.            │
│  Local JSON files on disk.                                │
└──────────────────────┬───────────────────────────────────┘
                       │  HTTP (Worker API)
┌──────────────────────┴───────────────────────────────────┐
│                 Cloudflare Worker                         │
│  Dumb byte store. GET/PUT/LIST + row-level CRUD.         │
│  R2 object storage backend.                               │
│  No decryption, no domain logic, no sessions.             │
└──────────────────────┬───────────────────────────────────┘
                       │  HTTP (Worker API)
┌──────────────────────┴───────────────────────────────────┐
│              Web App (React + WASM)                       │
│  phpoc-web/src/ → Vite → IndexedDB → browser.            │
│  Rust crypto compiled to WASM.                            │
│  Same remote protocol as CLI.                             │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│           phpoc-crypto-core (Rust + ring)                 │
│  Compiled to WASM (web), .a (iOS), .so (Android).        │
│  One crypto implementation, all platforms.                │
└──────────────────────────────────────────────────────────┘
```

### Core Principles

| Principle | Directive | Summary |
|-----------|-----------|---------|
| **Protocol sovereignty** | D1 | User owns data. Open format. No platform lock-in. |
| **Zero-knowledge** | D2 | Only the user can decrypt. Server sees opaque bytes. |
| **Zero external deps** | D3 | CLI: Python stdlib only. Web/Mobile: shared Rust core. |
| **Chain of trust** | D4 | Every block signed. Every entry content-hashed. |
| **Append-only** | D5 | Never edit, delete, or rewrite history. Revert from end only. |
| **Local-first** | D6 | All core ops work offline. Network is optional. |
| **Compartmentalization** | D7 | Independent sub-keys. Selective sharing at crypto layer. |
| **Recoverability** | D8 | Seed recovers entire ledger from genesis alone. |
| **Backward compatibility** | D9 | No breaking changes. Migration is opt-in, non-destructive. |
| **Testing integrity** | D10 | Chain verified after every modification in tests. |
| **Staging/ledger separation** | D11 | Staging is mutable scratchpad. Ledger is immutable history. |

### Reference Implementations

| Component | Language | Lines | Key Docs |
|-----------|----------|-------|----------|
| **CLI core** | Python 3.x | ~12,000 | `main.py`, `cli/`, `core/`, `domain/`, `security/`, `storage/` |
| **Web app** | JavaScript (React) | ~8,000 | `phpoc-web/src/` |
| **Crypto core** | Rust (ring) | ~1,500 | `phpoc-crypto-core/src/` |
| **Worker** | TypeScript | ~200 | `worker/src/` |
| **Format spec** | — | ~1,800 | `docs/spec/PHPSPEC.md` |

---

## 2. Key Hierarchy

The Recovery Seed is the single root of all cryptographic material. Everything derives
from it via deterministic HMAC-SHA256.

### 2.1 Seed → Master Key → Sub-Keys

```
Recovery Seed (32 bytes, base64-encoded)
  │
  └── derive_mk(seed, version)  →  Master Key vN (32 bytes)
       │                              [ADR-026: versioned MKs]
       │
       ├── HMAC(MK, "encryption-key")   → encryption_key  (AES-CTR)
       ├── HMAC(MK, "integrity-key")    → integrity_key   (HMAC-SHA256 auth tags)
       ├── HMAC(MK, "identity-secret")  → identity_secret (block signing)
       ├── HMAC(MK, "phpoc-blind-index-v1")  → index_key  (blind index encryption, I-02)
       ├── HMAC(MK, "phpoc-staging-keys-v1") → field_key  (staging field tokens, I-02a)
       └── HMAC(MK, "phpoc:cookie-key") → cookie_key     (device cookie, ADR-022)
```

**Seed encryption at rest:** The seed is encrypted with a Passphrase-Derived Key (PDK)
using PBKDF2-HMAC-SHA256 at 600,000 iterations (ADR-004) and stored as
`recovery_seed_enc` in the genesis block. The passphrase never leaves the device.

**Per-user salt (I-05):** PBKDF2 salt is derived from `SHA-256(identity_pub_key)[:16]`
instead of a fixed constant — prevents cross-user rainbow tables.

**Session caching:** Derived MKs (v1 through current genesis `key_version`) are cached
in `/dev/shm/phpoc_session` (CLI) or memory (web) for the session duration (ADR-014).
Cleared on logout, reboot, or TTL expiry.

**Key rotation (ADR-026):** `derive_mk(seed, version)` produces versioned master keys.
Soft rotation increments `key_version` and re-encrypts staging, index, cookie, and
genesis identity envelope — O(1), existing blocks untouched. Hard rotation (`--full`)
re-encrypts every entry in every block — O(N), full chain rewrite with backup.

**Identity secret:** A random 32-byte value, encrypted with the current MK and stored
in genesis as `identity_secret_enc_fallback` (ADR-003). Version-independent — identity
MACs on old blocks remain valid across rotations.

### 2.2 Authentication Flow

```
Passphrase ──▶ PBKDF2(600K) ──▶ PDK
                                    │
                 recovery_seed_enc ─┼──▶ AES decrypt ──▶ Seed (32 bytes)
                                    │
                                    └──▶ derive_mk(seed, 1..N) ──▶ MKs in cache
```

---

## 3. Chain Structure

### 3.1 Hierarchical Lock Chain

```
Genesis (sealed + signed, identity fallback embedded)
  │  prev_hash: 000...000
  │
  └── Year Summary (sealed + signed)
        │  prev_hash → genesis.day_hash
        │
        └── Month Summary (sealed + signed)
              │  prev_hash → year.year_hash
              │
              └── Day (sealed + signed)
                    │  prev_hash → month.month_hash
                    │
                    └── Entries (individually content-hashed)
```

Each block contains:
- `prev_hash`: Links to predecessor — breaking one link invalidates downstream chain
- `day_hash` / `month_hash` / `year_hash`: Block content hash (excludes `signature`)
- `signature` → `identity_seal`: HMAC-SHA256 identity seal over block hash (I-04 renamed)
- `format_version`: In genesis only — enables version-aware tooling (ADR-011)
- `key_version`: In genesis + day blocks — tracks which MK version encrypted entries (ADR-026)

### 3.2 Block Types

| Block | Contains | Frequency |
|-------|----------|-----------|
| **Genesis** | Seed encryption, identity fallback, format_version, key_version, prev_hash=0 | 1 per ledger |
| **Year Summary** | year_hash, entry count, date range | 1 per year |
| **Month Summary** | month_hash, entry count, date range | 1 per active month |
| **Day** | Array of encrypted entries, day_hash, key_version | 1 per active day |

### 3.3 Content Hash

Every entry carries a `content_hash` — SHA-256 of all plaintext fields (sorted keys,
decrypting `*_enc` suffixes). Survives re-encryption: same plaintext → same hash,
different ciphertext. Required at format v0.4.0+ (I-06).

Uses an **extensible all-keys iterator** (ADR-005): iterates every key in the entry
data dict, decrypts `*_enc` fields, sorts list values. New fields are automatically
included — no code changes needed. Try-both verification handles legacy (v0.3.0)
hardcoded-field content hashes alongside the extensible algorithm.

### 3.4 Verification

`verify()` traverses the chain:
1. Genesis `prev_hash` must be `000...000`
2. Each block's `prev_hash` must match predecessor's computed hash
3. Each block's `identity_seal` must verify against the identity secret
4. Each day block's entries must pass content_hash + MAC verification
5. `key_version` per block determines which MK to use for decryption and seal verification
6. Missing blocks or failed checks → verification failure (tamper detected)

**Partial traversal:** Summary blocks enable verifying a single day without reading
the entire chain — follow the hierarchy path (Genesis → Year → Month → Day).

### 3.5 Operations

- **Commit:** Staging entries → encrypt with current MK → seal into new day block
  → append to chain → remove from staging → rebuild index
- **Revert:** Remove last N day blocks from end → restore entries to staging as `plain:`
  (ADR-010). Preserves chain integrity — no middle-of-chain deletion.
- **Chain splitting:** Split at summary boundaries for archiving/export (ADR-012).
  Each segment independently verifiable.
- **Migration:** One-time scripts (`scripts/migrate_format_version.py`) handle format
  bumps. Creates backup, transforms data, validates result (ADR-011).

---

## 4. Staging Pipeline

### 4.1 Staging vs Ledger

| | Staging | Ledger |
|---|---|---|
| **Mutability** | Mutable scratchpad | Immutable append-only chain |
| **Encryption** | `plain:` prefix → AES-CTR encrypted (I-03) | Always AES-CTR + HMAC auth tag |
| **Auth required** | No (quick capture) | Yes (commit) |
| **Content hash** | No (structurally incompatible) | Yes (required at v0.4.0+) |
| **Chain linkage** | None | prev_hash, seal, identity seal |
| **Queryable** | Via staging service | Via ledger engine + blind index |

**The only path from staging to ledger is explicit user review and commit (D11).**
No automated promotion. Staging entries carry `plain:` or encrypted field prefixes —
these are stripped during commit, never appearing in a sealed day block.

### 4.2 Entry Lifecycle

```
Capture (no auth)  →  Staging (plain:/encrypted)
                          │
                    User reviews, decides
                          │
                    Commit (auth required)
                          │
                    ┌─────┴─────┐
                    ▼           ▼
              Day Block    Blind Index
              (encrypted,  (encrypted title→duration,
               sealed,      I-02)
               content_hash)
```

Entry schema (encrypted fields marked `_enc`):
```json
{
  "title": "plaintext (intentionally, for blind index queries)",
  "startTime_enc": "<AES-CTR>",
  "endTime_enc": "<AES-CTR>",
  "pauses_enc": "<AES-CTR>",
  "metadata_enc": "<AES-CTR>",
  "comment_enc": "<AES-CTR>",
  "device_id_enc": "<AES-CTR, unique nonce per entry>",
  "transitions_enc": "<AES-CTR, action trail for multi-device>",
  "content_hash": "SHA-256 of all plaintext fields"
}
```

### 4.3 Staging Encryption (I-03)

Staging entries are encrypted at rest using AES-CTR with the current MK. Legacy
`plain:` entries are supported for backward compatibility — transformed to encrypted
format on next write cycle. Field names are tokenized via HMAC (staging field
key encryption, I-02a) to prevent schema structure leakage.

### 4.4 Blind Index (ADR-008)

A separate encrypted file (`index.json`) stores aggregated daily durations per
activity title. Encrypted with an MK-derived index key (I-02). Rebuildable from
the chain at any time.

```json
{
  "2026-05-04": {
    "Working": 3600000,
    "Coffee": 1800000
  }
}
```

Enables fast reputation queries (`ph rep`) without decrypting individual entries.
The index leaks activity titles and daily totals — this is what the user sees
in the CLI anyway.

---

## 5. Transport Layer

### 5.1 Architecture

```
┌──────────┐  HTTPS   ┌──────────────┐  S3 API   ┌────────┐
│  Client  │ ────────▶│  Cloudflare   │ ────────▶│   R2   │
│ (CLI/Web)│ ◀────────│   Worker      │ ◀────────│ Bucket │
└──────────┘          └──────────────┘          └────────┘
```

**The Worker is a dumb byte store** (ADR-023): ~200 lines of TypeScript. No decryption,
no domain logic, no sessions. Two service tiers:

1. **Generic blob store:** `GET/PUT /{path}` for opaque encrypted blobs with `ETag`
   support + `GET /?prefix={prefix}` for listing
2. **Row-level staging** (ADR-025): `GET/PUT/DELETE /.../storage/staging/rows/{id}` +
   `GET /.../storage/staging/manifest` with push guard (`409 Conflict` on stale `updated_at`)

**Auth:** Pre-shared `X-Api-Key` header. CORS headers on all responses.

### 5.2 Remote Storage Layout

```
phpoc-data/
├── staging/
│   └── blobs/
│       ├── current.json          ← Encrypted staging blob (ADR-015b)
│       └── device_cookie.bin     ← 32-byte HMAC cookie (ADR-022)
├── ledger/
│   ├── blocks/
│   │   ├── 000000.json           ← Genesis (pushed once)
│   │   ├── 000001.json           ← Day block
│   │   └── ...
│   ├── index.json                ← Lightweight chain summary
│   ├── hash_index.json           ← Block seal array (ADR-024)
│   └── hash_index.sha256         ← SHA-256 of hash_index.json
└── storage/
    └── staging/
        ├── manifest               ← Row-level manifest (ADR-025)
        └── rows/
            └── {activity_id}      ← Per-activity encrypted row
```

### 5.3 Blob Obfuscation (ADR-015b)

Staging blobs are padded to fixed-size tiers before encryption:

| Tier | Size | For |
|------|------|-----|
| 64K | Light usage | Few active entries |
| 128K | Light-moderate | Typical usage |
| 256K | Moderate | With comments |
| 512K | Heavy usage | Many entries + lengthy comments |

Random fill bytes pad to the class ceiling. The remote sees only constant-size
encrypted blobs with no timing or volume signal. User-configurable tier.

### 5.4 Transports

The `AbstractStagingTransport` interface abstracts the transport from domain logic:

| Transport | Status | Use case |
|-----------|--------|----------|
| `HttpStagingTransport` | ✅ Active | Primary — Worker + R2 |
| `GitStagingTransport` | ✅ Implemented | Git remote (shells out to `git`) |
| `TransportSpy` | ✅ Test only | Test double for sync tests |

`HttpStagingTransport` uses only Python stdlib (`urllib.request`), preserving zero
external dependencies. ETag-based `304 Not Modified` for freshness checks.

### 5.5 Device Cookie (ADR-022)

A deterministic 32-byte HMAC token for fast-path identity verification without
decrypting the full staging blob:

```python
cookie_key = HMAC-SHA256(master_key, b"phpoc:cookie-key")
cookie = HMAC-SHA256(cookie_key, device_id + ":" + epoch_ms)
```

- Stored remote (32 bytes, no decryption needed — compare bytes)
- TTL-enforced locally via plaintext metadata (`device_cookie.meta`)
- Eliminates circular dependency: know if auth is needed before having MK to decrypt
- ~2000× smaller than full staging blob pull

---

## 6. Multi-Device Sync

### 6.1 Sync Lifecycle

```
1. Device Cookie check           ← Fast path: 32 bytes, no decrypt (ADR-022)
2. Genesis Gate (hash index)     ← Tier 1 SHA-256 match → skip (ADR-024)
                                 ← Tier 2 fork detection → incremental pull
                                 ← Fallback → full chain pull
3. Staging reconciliation        ← Pull remote staging, merge with local
4. Staging push                  ← Push local changes to remote
5. Ledger block push/pull        ← Append new blocks, push local (async, ADR-025)
6. Hash index push               ← Both clients update for mutual benefit
```

### 6.2 Hash Index Fast Path (ADR-024)

Two new remote files enable O(1) chain comparison:

- `hash_index.json`: Array of `block.day_hash || block.month_hash || block.year_hash`
  for every block in the chain
- `hash_index.sha256`: SHA-256 of the index file

**Three-tier genesis check:**

| Tier | Network cost | When |
|------|-------------|------|
| Tier 1 | 1 GET (check SHA-256 match) | Identical chains (re-login) |
| Tier 2 | 1–2 GETs (find fork point via seal comparison) | Remote extends local |
| Fallback | N GETs (all blocks) | First sync, divergent chains, missing index |

This cuts login/unlock from ~10–30s (N round trips) to ~0.1s (1 round trip) for
the common re-login case.

### 6.3 Device Identity (I-09)

Device IDs are derived from `HMAC(MK, device_local_secret)` where `device_local_secret`
is a random UUID4 generated on first run and stored locally. This prevents MK-based
device impersonation — two devices with the same MK produce different device IDs.

Client suffixes (`-cli`, `-web`) disambiguate same-machine clients.

### 6.4 Merge Engine

Cross-device staging entries are merged by `entry_id` (UUID, stable across devices).
LWW by `updated_at` timestamp. Backward-compatible fallback to `(title, start_epoch)`
for legacy entries without `entry_id` (ADR-021).

### 6.5 Row-Level Staging Sync (ADR-025)

The architectural direction (implementation in progress) replaces monolithic blob sync
with per-activity row sync. A manifest tracks `(activity_id, status, updated_at)`,
enabling:

- 100×+ smaller sync payloads (pull only changed rows, not 64KB–512KB blob)
- Push guard on Worker: rejects `PUT` when `updated_at ≤ existing.updated_at` → `409`
- Ledger hash index serves as tombstone mechanism (no ghost rows in staging)
- Staging sync blocks user (fast, manifest ~500B); ledger sync is async

---

## 7. Cross-Platform Strategy

### 7.1 Chosen Architecture

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

**Crypto is written once, compiled everywhere.** The Rust library implements all
cryptographic primitives (PBKDF2, AES-CTR, HMAC, SHA-256, blob obfuscation, cookie
format). Compiled to:

| Target | Platform | Integration |
|--------|----------|-------------|
| `wasm32-unknown-unknown` | Web (React) | `wasm-pack` → npm package |
| `aarch64-apple-ios` | iOS (Swift) | Static lib + C header / uniffi |
| `aarch64-linux-android` | Android (Kotlin) | .so + JNI / uniffi |
| `x86_64-unknown-linux-gnu` | Linux (CI) | Native test harness |

**Contract testing:** A shared `crypto_test_vectors.json` file with known inputs
and expected outputs for every primitive. All platform implementations must pass
before any UI work begins.

### 7.2 Platform Implementations

| Phase | Platform | Status | Crypto | Storage |
|-------|----------|--------|--------|---------|
| 0 | Rust crypto core | ✅ Built | ring | — |
| 1 | React web | ✅ Active | WASM | IndexedDB |
| 2 | iOS (Swift) | 🔮 Future | .a static lib | Keychain |
| 3 | Android (Kotlin) | 🔮 Future | .so + JNI | EncryptedSharedPrefs |
| 4 | Flutter | 🔮 Optional | .a/.so FFI | Platform-specific |

### 7.3 Wire Protocol

All platforms speak the same HTTP protocol to the same Worker. The Worker is the
compatibility seam — clients are independent implementations verified by shared
test vectors, not by sharing code. No SDK, no shared runtime, no synchronization
beyond the wire format.

---

## 8. Crypto Core (`phpoc-crypto-core`)

### 8.1 Structure

```
phpoc-crypto-core/
├── Cargo.toml
├── src/
│   ├── lib.rs              # Public API, re-exports
│   ├── pbkdf2.rs           # PBKDF2-HMAC-SHA256 (600K + 100K fallback)
│   ├── aes_ctr.rs          # AES-256-CTR encrypt/decrypt
│   ├── hmac_utils.rs       # HMAC-SHA256 sign/verify
│   ├── sha256.rs           # SHA-256 hash
│   ├── random.rs           # Secure random bytes (getrandom)
│   ├── blob_obfuscation.rs # 4-tier pad + HMAC sub-key (PHPSPEC.md)
│   ├── cookie.rs           # Device cookie JSON serialize/deserialize
│   ├── key_derivation.rs   # MK → sub-key derivation
│   ├── device.rs           # Device identity: derive_device_id, local secret
│   └── wasm.rs             # wasm-bindgen exports (WASM target)
├── pkg/                    # Built WASM artifacts (copied to phpoc-web)
└── tests/
    ├── crypto_test_vectors.json
    └── integration_test.rs
```

### 8.2 Dependency: `ring`

The single external dependency is the `ring` crate — BoringSSL bindings providing
audit-grade, FIPS 140-2 validated implementations of PBKDF2, AES-CTR, HMAC, and
SHA-256. This is the only cryptographic dependency. It replaces hand-rolled Python
AES-CTR for all non-CLI platforms.

### 8.3 WASM Integration

The web app imports the Rust library via `wasm-pack`:
```
phpoc-crypto-core/pkg/  →  copied to  →  phpoc-web/src/crypto/wasm/
```

JavaScript wrappers in `phpoc-web/src/crypto/index.js` provide async guards and
a singleton `CryptoService` with 20+ exported functions. The WASM binary (~134KB)
is content-hashed in production builds.

---

## 9. Web Application (`phpoc-web`)

### 9.1 Stack

| Layer | Technology |
|-------|-----------|
| **Framework** | React 18 |
| **Build** | Vite |
| **Storage** | IndexedDB (via `IndexedDBStoragePlugin`) |
| **Crypto** | Rust → WASM (`phpoc-crypto-core`) |
| **Sync** | HTTP to Worker (same protocol as CLI) |
| **Testing** | Node test runner + Vitest (React Testing Library) |

### 9.2 Architecture

```
src/
├── App.jsx                  # Root: routing, error boundary, TTL banner
├── components/
│   ├── screens/             # Auth, Dashboard, History, SyncSettings, Onboarding, etc.
│   ├── modals/              # PassphraseModal
│   ├── layout/              # AppLayout (nav + content)
│   ├── pills/               # ActiveTaskPill (floating active task indicator)
│   └── sync/                # SyncIndicator (status display)
├── ledger/                  # Ledger logic (ported from Python)
│   ├── chain.js             # LedgerChain: append, verify, block storage
│   ├── engine.js            # LedgerEngine: commit, revert
│   ├── index_manager.js     # Blind index: build, query
│   ├── merge.js             # LedgerMerge: cross-chain merge
│   ├── summary_policy.js    # Summary block generation
│   └── utils.js             # jsonSort() — Python-compatible JSON serialization
├── sync/                    # Sync pipeline
│   ├── sync.js              # Core orchestrator: genesis gate, reconcile, push
│   ├── genesis_gate.js      # Tier 1/2/3 hash index genesis check
│   ├── hash_index.js        # buildHashIndex(), compareHashIndexes()
│   ├── remote_sync.js       # RemoteSync: blob pull/push via HTTP
│   ├── local_cache.js       # Staging cache: read/write, field tokens, encryption (I-03)
│   ├── device_uuid.js       # Device identity: getOrCreateDeviceSecret() (I-09)
│   ├── cookie.js            # DeviceCookie: create, TTL check
│   ├── entry_dto.js         # DTO conversion: rawCommittedEntryToDTO, etc.
│   ├── merge_engine.js      # Cross-device staging merge
│   ├── row_staging_store.js # Row-level staging IndexedDB store (ADR-025)
│   ├── row_sync.js          # Row sync worker client + buildDiff()
│   └── migration.js         # Blob→rows migration
├── crypto/
│   ├── index.js             # CryptoService singleton (WASM wrappers, MK cache)
│   └── wasm/                # Bundled WASM artifacts from phpoc-crypto-core
├── context/
│   └── DevModeContext.jsx   # Services, sync lifecycle, TTL monitoring
├── hooks/
│   ├── useActiveTasks.js    # Active task polling
│   ├── useAutoSync.js       # Auto-sync on interval
│   └── useCookieMonitor.js  # Proactive cookie TTL polling
└── services/
    ├── ledger_export.js     # Export chain to file
    └── ledger_import.js     # Import chain from file (v1/v2/raw)
```

### 9.3 Browser-Specific Concerns

- **No `/dev/shm`:** MK cached in JavaScript memory, cleared on page unload
- **No filesystem:** IndexedDB for all persistent storage (ledger, staging, index, identity, config)
- **No Keychain:** Device secret stored in IndexedDB (acceptable for browser; mobile will use platform Keychain)
- **Web Crypto API:** Used for `deriveMk()` (browser-compatible HMAC, not Node.js `crypto`)
- **WASM async init:** Crypto operations gated behind `CryptoService.ready` promise

---

## 10. CLI Reference Implementation

### 10.1 Package Structure

```
main.py                     # CLI entry: argparse, auth tiers, dispatch
cli/                        # Interface + display layer
├── interface.py            # view_active, show_rep, list_habits
├── strategies.py           # InteractiveCLIStrategy (sync confirmation UI)
├── onboarding.py           # Unified onboarding pipeline (remote + file import)
├── onboarding_file.py      # Local JSON file import (v1/v2/chain)
├── rotate_keys.py          # ph rotate-keys command (I-01a)
├── migrate.py              # ph migrate command (canonical format, I-07/I-17)
├── wal.py                  # Write-ahead log, background push
├── daemon.py               # PhDaemon lifecycle
├── background.py           # Background sync check
├── transport_cmd.py        # ph transport subcommand
└── parsers.py              # Time/date input parsing
core/                       # Orchestration + transport
└── sync/
    ├── orchestrator.py     # SyncOrchestrator: lifecycle coordinator + merge
    ├── http_transport.py   # HttpStagingTransport (urllib, zero deps)
    ├── git_transport.py    # GitStagingTransport (shells out to git)
    └── transport_registry.py # TransportProvider discovery for onboarding
domain/                     # Domain logic
├── ledger/
│   ├── chain.py            # Chain building, sealing, verification
│   ├── engine.py           # LedgerEngine: commit, revert, build
│   ├── index_manager.py    # Blind index: build, query, encrypt (I-02)
│   ├── remote_sync.py      # RemoteLedgerSync: push/pull blocks + hash index
│   ├── merge.py            # LedgerMerge: cross-chain merge
│   └── summary_policy.py   # Summary block generation
├── staging/
│   ├── service.py          # StagingService: auth gate, check_and_sync, push
│   ├── remote_sync.py      # RemoteStagingSync: blob pull/push, cookie
│   ├── local_cache.py      # Local staging cache: encrypt/decrypt (I-03)
│   └── merge_engine.py     # Cross-device merge, dedup by entry_id
└── cookie/
    └── device_cookie.py    # DeviceCookie: create, validate, TTL
security/                   # Crypto + identity
├── crypto.py               # CryptoManager, NoAuthCryptoManager
├── auth.py                 # Authenticator: passphrase + seed + per-user salt (I-05)
├── device_identity.py      # DeviceIdentity: derive_device_id (I-09)
└── config_manager.py       # ConfigManager: 9 sections, 27 fields, XDG resolution
storage/                    # Abstract interfaces + file-based implementations
└── implementations/
    ├── file_ledger.py      # JSON file ledger store
    ├── file_staging.py     # JSON file staging store
    ├── file_index.py       # JSON file index store
    ├── file_identity.py    # JSON file identity store
    └── file_config.py      # JSON file config store (XDG paths)
```

### 10.2 Key Design Decisions

- **Zero external dependencies:** Pure Python stdlib — `hashlib`, `hmac`, `json`, `os`,
  `argparse`, `copy`, `struct`, `base64`, `tempfile`, `urllib` (ADR-006)
- **Hand-rolled AES-CTR:** ~180 lines, no side-channel resistance. Acceptable for
  a personal ledger; real AES comes from `ring` in the Rust crypto core for all
  other platforms.
- **Storage abstraction:** 5 split interfaces (`AbstractStagingStore`, `AbstractLedgerStore`,
  `AbstractIndexStore`, `AbstractIdentityStore`, `AbstractConfigStore`) enable SQLite
  or other backends without changing domain logic.
- **View interface:** `ViewInterface` + `CLIView` + strategies decouple display from
  domain logic. Zero `print()` calls in core packages.

---

## 11. Architectural Invariants

These must never be broken. They are the accumulated constraints from all ADRs,
directives, and the project map.

### Data Format

1. **Master Key** = `derive_mk(seed, key_version)` — 32 bytes, HMAC-SHA256 versioned
2. **Encryption** = AES-256-CTR + HMAC-SHA256 auth tag (encrypt-then-MAC)
3. **_enc suffix convention:** Any field may be encrypted by appending `_enc` —
   no hardcoded field lists (ADR-013)
4. **Content hash** = SHA-256 of all plaintext fields via extensible all-keys iterator
   (ADR-005). Required at format v0.4.0+ (I-06).
5. **Chain structure:** Genesis → (Year → Month)* → Day blocks, each sealed + identity-sealed
6. **Genesis seal** excludes `signature`/`identity_seal` field when computing `day_hash`
7. **Blind index:** `{date: {title: total_ms}}` — encrypted with index key (I-02)
8. **Staging encryption:** AES-CTR with current MK. `plain:` prefix for legacy compat (I-03).
   Staging fields tokenized via HMAC field keys (I-02a).

### Identity & Recovery

9. **Seed is root:** Recovery Seed → versioned MKs → all sub-keys. Seed recovers
   everything (ADR-001, ADR-026).
10. **Identity secret** is random, version-independent, encrypted with current MK,
    stored in genesis as in-ledger fallback (ADR-003).
11. **Device ID** = `HMAC(MK, device_local_secret)` with client suffix (`-cli`/`-web`).
    Bare UUID4 and WASM-derived UUIDs migrated on first read (I-09).

### Integrity & Immutability

12. **Append-only:** Never edit, delete, or rewrite historical data. Revert from
    end only (D5, ADR-010).
13. **Every block sealed + identity-sealed.** No unsigned blocks (D4).
14. **Chain verified after every modification in tests** (D10).
15. **Migration creates backup first.** Never destructive in place (D9).

### Local-First

16. **All core operations work offline** (D6). Network is optional.
17. **Local ledger is authoritative.** Remote is a convenience copy.
18. **Staging is mutable scratchpad.** Ledger is immutable history. The only path
    from staging to ledger is explicit user commit (D11).

### Dependencies & Platform

19. **CLI:** Zero external dependencies — pure Python stdlib only (D3, ADR-006).
20. **Web/Mobile:** Shared Rust crypto core (`phpoc-crypto-core` / `ring`) —
    one implementation, compiled to all targets.
21. **Worker:** Dumb byte store — no domain logic, no decryption, no sessions (ADR-023).

### Transport & Sync

22. **Device cookie:** 32-byte HMAC fast path for identity without blob decryption
    (ADR-022).
23. **Hash index:** Plaintext block seal array + SHA-256 checksum for O(1) chain
    comparison (ADR-024).
24. **Staging blobs obfuscated:** Fixed-size padded encryption, 4-tier classes
    (ADR-015b).
25. **Config:** XDG Base Directory compliant. Independent resolution chains for
    config file and data directory (ADR-016, ADR-019).

---

## Cross-Reference

| Topic | Primary Sources |
|-------|----------------|
| Key hierarchy | ADR-001, ADR-004, ADR-026, DESIGN_GOALS §2, §5 |
| Chain structure | ADR-005, ADR-007, ADR-010, ADR-011, ADR-012, PHPSPEC.md §4-5 |
| Staging | ADR-009, ADR-013, ADR-015, ADR-021, DESIGN_GOALS §4, D11 |
| Transport | ADR-015a, ADR-015b, ADR-022, ADR-023 |
| Multi-device sync | ADR-015, ADR-021, ADR-022, ADR-024, ADR-025, DESIGN_MULTI_DEVICE_SESSION.md |
| Cross-platform | CROSS_PLATFORM_ARCHITECTURAL_DECISIONS.md, ADR-023 |
| Crypto core | CROSS_PLATFORM_ARCHITECTURAL_DECISIONS.md §5-6 |
| Web app | phpoc-web/AGENTS.md, ADR-024, ADR-025 |
| CLI | ADR-006, ADR-014, ADR-016 through ADR-019, DESIGN_GOALS §4 |
| Directives (D1–D11) | TOP_LEVEL_DIRECTIVES.md |
| Format spec | PHPSPEC.md (docs/spec/) |
| Project map | MAP.md (docs/reference/) |
| Roadmap / backlog | ROADMAP.md, BACKLOG.md (docs/planning/) |
