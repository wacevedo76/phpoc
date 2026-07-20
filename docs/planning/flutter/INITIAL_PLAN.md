# Flutter Mobile App — Initial Development Plan

> **Date:** 2026-07-17
> **Branch:** `feature/flutter-mobile`
> **Status:** Draft — under discussion
> **Context:** 8-phase bottom-up build plan. Builds on the Riverpod scaffold, 31 axioms
> (`FLUTTER_AXIOMS.md`), and ADR-027/ADR-028. Dependency direction: Presentation → Application
> → Data → Domain (core). Phases are sequential with each phase depending on the one before it.

---

## Core Design Decision: Staging-Only MVP

The mobile MVP is a **capture device**, not a commit device. Staging entries live in SQLite and
sync to the Worker. The CLI and web app handle ledger commits (sealing entries into blocks). The
mobile app captures tasks and syncs staging — that's it.

**Why:**
- Axiom A5: staging is sacred, commit is explicit. The mobile app doesn't need to commit.
- Reduces Phase 4 (SyncService) from ~770 lines (web, with ledger) to ~400 lines (staging-only).
- The ledger engine (Phase 7) is the most complex port — chain building, sealing, verification,
  index management. Deferring it means we ship a working app in 6 phases instead of 8.
- F6 (cross-client compatibility): mobile captures, web/CLI commits, all three sync via Worker.
  Tested from day one.

---

## Dependency Hierarchy

```
Presentation (features/) → Application (services/) → Data (data/) → Domain (core/)
```

Core has no Flutter imports. Data has no Widget imports. Services orchestrate but don't own
domain logic. Features consume services. Each phase builds on the one before it.

---

## Phase 1 — Domain Models

**Directory:** `lib/core/models/` + `lib/core/utils/`
**Constraint:** Pure Dart. No Flutter imports. No external deps.
**Testable with:** `dart test` (no emulator)

### Models

| File | Fields | Notes |
|------|--------|-------|
| `entry.dart` | entry_id, title, start_epoch, end_epoch, is_active, tags, pauses, metadata_enc, device_uuid, content_hash, committed | Immutable, `copyWith()`. JSON serialization via Freezed. |
| `block.dart` | block_id, block_type, block_index, key_version, data_enc, identity_seal, prev_hash | Defines block structure but not built/verified in this phase. |
| `device_cookie.dart` | device_specifier, creation_time, device_uuid | JSON encode/decode. TTL validation logic. |
| `identity.dart` | device_id, client_suffix | HMAC-SHA256 derivation from MK + device secret. |
| `sync_result.dart` | enum: READY, OFFLINE, REAUTH_NEEDED, GENESIS_MISMATCH | Matches web's `SyncResult`. |

### Utils

| File | Purpose |
|------|---------|
| `base64.dart` | Encode/decode base64 (standard + URL-safe). Match web's `base64ToBytes`/`bytesToBase64`. |
| `json_utils.dart` | JSON canonical sort (`jsonSortIndent2`). Recursive key sort. Match web's `jsonSortIndent2` byte-for-byte. |
| `hash_utils.dart` | SHA-256 wrapper (delegates to `dart:crypto` or Rust FFI). |

### Tests

- Roundtrip serialization for every model
- JSON canonical sort matches web output (byte-for-byte comparison against known test vectors)
- Identity derivation produces consistent device_id from same MK + secret
- DeviceCookie TTL validation: valid, expired, missing
- Entry `copyWith()` preserves immutability

### Deliverable

All domain types defined and tested. No emulator needed. `dart test` passes. This phase can
proceed in parallel with toolchain setup for Phase 2.

---

## Phase 2 — Crypto FFI Bridge

**Directory:** `lib/core/crypto/`
**Constraint:** Exactly one crypto implementation (Axiom B2). Bridge to Rust `phpoc-crypto-core`.
**Risk:** Highest — Rust cross-compilation for Android NDK targets.

### Tasks

1. Add `flutter_rust_bridge: ^2.0.0` to `pubspec.yaml`
2. Configure `rust_crate_dir: ../phpoc-crypto-core`
3. Cross-compile Rust for Android targets:
   - `aarch64-linux-android` (ARM64 — physical devices)
   - `x86_64-linux-android` (x86_64 — emulator)
4. `crypto_service.dart` — thin Dart wrapper around generated bindings:

| Method | Rust function | Purpose |
|--------|--------------|---------|
| `deriveMasterKey(passphrase, seed, iterations)` | `derive_master_key` | PBKDF2-SHA256, 600K iterations |
| `encryptField(plaintext, mk)` | `encrypt_field` | AES-256-GCM per-field encryption |
| `decryptField(ciphertext, mk)` | `decrypt_field` | AES-256-GCM per-field decryption |
| `obfuscateBlob(data, mk)` | `obfuscate_blob` | Blob-level AES-CTR + HMAC |
| `deobfuscateBlob(data, mk)` | `deobfuscate_blob` | Blob-level decrypt + verify |
| `computeContentHash(fields, mk)` | `compute_content_hash` | Per-entry content hash (matches web) |
| `randomUuid()` | `random_uuid` | UUIDv4 (matches web's `crypto.randomUUID`) |
| `sha256(data)` | `sha256` | SHA-256 hash (for hash index, seals) |

### Tests

- PBKDF2 produces identical MK from same (passphrase, seed, iterations) as web WASM output
- `encryptField` / `decryptField` roundtrip: `decrypt(encrypt(plaintext)) == plaintext`
- `obfuscateBlob` / `deobfuscateBlob` roundtrip
- `computeContentHash` matches web's output for known test vectors
- Encrypted field format matches PHPSPEC.md (`enc:<version>:<nonce>:<ciphertext>:<tag>`)
- Cross-client test: encrypt in Dart, decrypt in JS, and vice versa

### Risk Mitigation

If `flutter_rust_bridge` + Android NDK hits toolchain issues:
- **Fallback:** Pure-Dart crypto shim (`dart_crypto.dart`) implementing the same interface.
  Clearly marked with `// TEMPORARY: Replace with Rust FFI. See Phase 2 risk mitigation.`
- The Dart shim unblocks Phase 3. The FFI bridge is fixed in parallel.
- The shim does NOT ship to production. It's a development unblocker only.
- Axiom B2 (one implementation) is temporarily violated but documented and gated.

### Deliverable

Crypto working on Android emulator. Same bytes as web WASM output. `flutter test` passes on
emulator with Rust `.so` loaded (or Dart shim as fallback).

---

## Phase 3 — Storage

**Directory:** `lib/data/storage/`
**Constraint:** Drift (SQLite) + SharedPreferences + flutter_secure_storage (ADR-028).
**Requires:** Phase 2 (crypto for encrypted fields).

### Schema

```sql
CREATE TABLE entries (
  entry_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  start_epoch INTEGER NOT NULL,
  end_epoch INTEGER,           -- NULL = still running
  is_active INTEGER NOT NULL DEFAULT 1,
  committed INTEGER NOT NULL DEFAULT 0,
  device_uuid TEXT,
  content_hash TEXT,
  metadata_enc TEXT,           -- encrypted JSON, base64
  tags TEXT,                   -- JSON array ["coding", "work"]
  pauses TEXT,                 -- JSON array of {start, end}
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_entries_active ON entries(is_active);
CREATE INDEX idx_entries_committed ON entries(committed);
CREATE INDEX idx_entries_start ON entries(start_epoch);

CREATE TABLE blocks (
  block_id TEXT PRIMARY KEY,
  block_type TEXT NOT NULL,    -- genesis, year, month, day
  block_index INTEGER NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  data_enc TEXT NOT NULL,      -- encrypted JSON, base64
  identity_seal TEXT,
  prev_hash TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE index_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  block_id TEXT REFERENCES blocks(block_id),
  date TEXT NOT NULL,          -- YYYY-MM-DD
  tag TEXT,
  entry_id TEXT NOT NULL
);
```

### DAOs

| File | Purpose |
|------|---------|
| `entry_dao.dart` | CRUD for entries. Queries: active, by date range, by tag, pending sync. |
| `block_dao.dart` | Insert blocks, query by index, query by type. (Schema exists; ledger engine in Phase 7.) |

### Preferences

| File | Purpose |
|------|---------|
| `preferences.dart` | SharedPreferences wrapper: Worker URL, device UUID, device cookie. Typed getters/setters. |
| `secure_preferences.dart` | flutter_secure_storage for Worker API key. |

### Migrations

- Schema version tracking in Drift
- Migration from v1 → vN (additive only — never drop columns per A4/A8)
- Migration tests: insert data at version N, upgrade to N+1, verify data intact

### Tests

- Insert entry → query by active → returns correct entry
- Insert entry → end task → is_active = false, end_epoch set
- Date range query: entries between two timestamps
- Insert entry → close app → reopen → entry still there
- Migration: v1 data survives schema upgrade

### Deliverable

SQLite database created on app launch. Entries persist across restarts. Encrypted fields stored
as `enc:<version>:<nonce>:<ct>:<tag>` strings (not plaintext). Preferences survive cold start.

---

## Phase 4 — Sync Core

**Directory:** `lib/data/sync/`
**Constraint:** Port of web `src/sync/sync.js` — staging-only, no ledger. Axiom B5: match behavior
exactly, don't improve.
**Requires:** Phase 3 (storage + preferences).

### Scope — Staging-Only MVP

| Included (from web sync.js) | Deferred to Phase 7 (ledger) |
|---|---|
| `capture`, `end`, `pause`, `unpause`, `modify`, `remove` | `pushLedgerBlocks()` |
| `getActive`, `getEntries` | `getCompleted()` (needs ledger chain) |
| `checkAndSync()` — genesis gate (passthrough), fast path, auth gate, reconcile | `markCommitted()` |
| `pushToRemote()` — blob + cookie | Genesis gate full check (needs local ledger blocks) |
| Merge engine (`mergeEntries` — cross-device dedup) | Ledger block sync |
| Device cookie: create, validate, touch | |
| Transport: pull, push, listFiles, delete | |

### Files

| File | Purpose | Source (web) |
|------|---------|-------------|
| `sync_service.dart` | Unified entry point: CRUD + sync gate + cookie management | `sync.js` (staging-only subset) |
| `local_cache.dart` | Encrypted staging read/write. Encrypt fields on write, decrypt on read. | `local_cache.js` |
| `merge_engine.dart` | Cross-device dedup: merge local + remote entries by entry_id. | `merge_engine.js` |
| `genesis_gate.dart` | Genesis compatibility check. MVP: returns null (no local ledger = passthrough). | `genesis_gate.js` |
| `device_cookie.dart` | Cookie create, validate, match, touch. TTL = 30 min. | `cookie.js` |
| `transport.dart` | HTTP transport interface: `pull(path)`, `push(path, bytes)`, `listFiles(prefix)`, `delete(path)`. | `transport.js` |

### Sync Service API

```dart
class SyncService {
  // ── Local CRUD ────────────────────────────
  Future<Entry> capture({required String title, List<String> tags});
  Future<Entry> end(String entryId);
  Future<void> pause(String entryId);
  Future<void> unpause(String entryId);
  Future<void> modify(int index, Map<String, dynamic> fields);
  Future<void> remove(int index);

  // ── Queries ───────────────────────────────
  Future<Entry?> getActiveTask();
  Future<List<Entry>> getEntries({DateTime? from, DateTime? to});

  // ── Sync gate ─────────────────────────────
  Future<SyncCheckResult> checkAndSync();

  // ── Push ──────────────────────────────────
  Future<void> pushToRemote();
}
```

### Sync Gate Flow (staging-only)

```
checkAndSync():
  1. No remote transport? → READY
  2. Genesis gate → passthrough (no local ledger → return null)
  3. Fast path: local cookie valid? → pull remote cookie
     ├─ Match → push local blob → READY
     └─ Mismatch/absent → fall through
  4. Auth gate: MK available? → pull remote blob → merge → push merged → create cookie → READY
  5. No MK → REAUTH_NEEDED
  6. Network error → OFFLINE
```

### Tests

- Capture entry → `getActiveTask()` returns it → end → `getActiveTask()` returns null
- Capture on mobile → `pushToRemote()` → web `checkAndSync()` sees the entry
- Web captures entry → mobile `checkAndSync()` pulls and merges it
- Same-device: cookie match → fast path (push only, no pull)
- Cross-device: cookie mismatch → pull → merge → push merged → new cookie
- Cookie TTL expires → fast path fails → auth gate
- Network offline → `checkAndSync()` returns OFFLINE, local operations still work
- Merge engine: local [A, B], remote [B, C] → merged [A, B, C] (dedup by entry_id)

### Deliverable

Tasks captured on mobile appear on the Worker. Tasks captured on web appear on mobile after
`checkAndSync()`. All staging operations work offline. Sync is debounced (Axiom D5).

---

## Phase 5 — Services

**Directory:** `lib/services/`
**Constraint:** Application layer. Auth lifecycle + onboarding workflow. No domain logic.
**Requires:** Phase 4 (sync) + Phase 2 (crypto).

### AuthService

| Method | Purpose |
|--------|---------|
| `unlock(passphrase, seed)` | PBKDF2 → MK → store in memory. Optionally cache via biometric. |
| `lock()` | Zero MK from memory. Clear biometric cache (if biometric-only). |
| `isUnlocked()` | Is MK in memory? |
| `getMasterKey()` | Return MK bytes (or null if locked). |
| `changePassphrase(old, new)` | Re-derive MK, re-encrypt seed with new MK, update genesis block. |

### OnboardingService

| Method | Purpose |
|--------|---------|
| `hasExistingData()` | Probe SQLite for genesis block → if found, route to unlock. (Axiom F3) |
| `createNew(passphrase)` | Generate seed, derive MK, create genesis block, create device identity. |
| `importFromFile(filePath)` | Read seed file → validate format → store genesis → route to unlock. |
| `importFromSeed(seedB64)` | Parse seed → store genesis → route to unlock. |
| `connectWorker(url, apiKey)` | Store Worker URL + API key → test connectivity. |

### Riverpod Providers

```dart
// Services (singletons, initialized after boot)
final cryptoServiceProvider = Provider<CryptoService>((ref) => CryptoService());
final databaseProvider = Provider<AppDatabase>((ref) => AppDatabase());
final syncServiceProvider = Provider<SyncService>((ref) {
  return SyncService(
    storage: ref.watch(databaseProvider),
    crypto: ref.watch(cryptoServiceProvider),
    transport: ref.watch(transportProvider),
  );
});
final authServiceProvider = Provider<AuthService>((ref) {
  return AuthService(
    crypto: ref.watch(cryptoServiceProvider),
    database: ref.watch(databaseProvider),
  );
});

// App lifecycle
enum AppPhase { boot, landing, onboarding, auth, ready }

final appLifecycleProvider = StateNotifierProvider<AppLifecycleNotifier, AppPhase>((ref) {
  return AppLifecycleNotifier(
    onboarding: ref.watch(onboardingServiceProvider),
    auth: ref.watch(authServiceProvider),
  );
});
```

### Tests

- `unlock(correctPassphrase)` → MK derived → `isUnlocked()` returns true
- `unlock(wrongPassphrase)` → throws → `isUnlocked()` returns false
- `lock()` → MK zeroed → `getMasterKey()` returns null
- `hasExistingData()` → true when genesis exists, false on fresh install
- `createNew()` → genesis block written → `hasExistingData()` returns true
- `importFromSeed(knownSeed)` → produces same genesis as CLI (byte-for-byte)

### Deliverable

User can create a new ledger, import an existing one from a seed file, unlock with passphrase,
and lock (clear MK). App lifecycle states (boot → landing → onboarding → auth → ready) all
transition correctly.

---

## Phase 6 — Screens

**Directory:** `lib/features/`
**Constraint:** Presentation only. No crypto, sync, or database queries in screen files (Axiom B4).
Consume services via Riverpod providers.
**Requires:** Phase 5 (services wired with providers).

### Screens

| Screen | Route | Purpose | Key Interactions |
|--------|-------|---------|-----------------|
| **Loading** | `/loading` | Splash + boot probe | Check for existing data, determine phase |
| **Landing** | `/landing` | "Log in" + "New ledger" | Route to unlock or onboarding |
| **Onboarding** | `/onboarding` | New / Import from file / Connect Worker | Create genesis, import seed, configure remote |
| **Unlock** | `/unlock` | Passphrase input + biometric | Derive MK, transition to ready |
| **Dashboard** | `/` | Active task card, quick capture, recent entries | Capture, end, pause |
| **History** | `/history` | Entry list with date filter | Expand entries, view details |
| **Sync** | `/sync` | Pending entries, sync status, sync now | CheckAndSync, push |
| **Settings** | `/settings` | Worker config, passphrase change, seed export, about | Configure, export |

### go_router Configuration

```dart
GoRouter(
  initialLocation: '/',
  redirect: (context, state) {
    final phase = ref.read(appLifecycleProvider);
    if (phase == AppPhase.boot) return '/loading';
    if (phase == AppPhase.landing) return '/landing';
    if (phase == AppPhase.auth) return '/unlock';
    if (phase == AppPhase.ready && state.matchedLocation == '/unlock') return '/';
    return null;
  },
  routes: [
    GoRoute(path: '/loading', builder: (_, _) => const LoadingScreen()),
    GoRoute(path: '/landing', builder: (_, _) => const LandingScreen()),
    GoRoute(path: '/onboarding', builder: (_, _) => const OnboardingScreen()),
    GoRoute(path: '/unlock', builder: (_, _) => const UnlockScreen()),
    ShellRoute(
      builder: (_, _, child) => AppScaffold(child: child),
      routes: [
        GoRoute(path: '/', builder: (_, _) => const DashboardScreen()),
        GoRoute(path: '/history', builder: (_, _) => const HistoryScreen()),
        GoRoute(path: '/sync', builder: (_, _) => const SyncScreen()),
        GoRoute(path: '/settings', builder: (_, _) => const SettingsScreen()),
      ],
    ),
  ],
);
```

### Tests

- Widget tests for each screen: renders without error, responds to tap events
- Navigation guards: on boot → `/loading`, locked → `/unlock`, ready → `/` + bottom nav
- Dashboard: capture button creates entry, active task card updates
- Unlock: wrong passphrase shows error, correct passphrase transitions to dashboard
- Sync: pull from Worker shows entries, push sends local entries
- Bottom nav: all four tabs navigate correctly

### Deliverable

App is functionally complete. Capture tasks, sync with Worker, view history, configure settings.
Full navigation flow from cold start to ready state. All 6 screens render and respond.

---

## Phase 7 — Ledger Engine

**Directory:** `lib/data/ledger/`
**Constraint:** Port of web `src/ledger/` + CLI `domain/ledger/`. Axiom B5: match behavior exactly.
**Requires:** Phase 6 (app context — ledger engine is additive, not blocking).

### Files

| File | Purpose | Source |
|------|---------|--------|
| `chain.dart` | Block building, prev_hash linking, chain verification. `_verify_content_hash()` with legacy fallback. | `ledger/chain.js` + `domain/ledger/chain.py` |
| `engine.dart` | Commit entries → day blocks. Seal blocks with identity_seal. Verify chain integrity. Revert. | `ledger/engine.js` + `domain/ledger/engine.py` |
| `index_manager.dart` | Build blind index from chain. Rebuild when chain changes. Query by date + tag. | `ledger/index.js` + `domain/ledger/index_manager.py` |
| `summary_policy.dart` | Month/year summary blocks: merge entries, compute totals. | `ledger/summary_policy.js` |
| `merge.dart` | Chain-level merge: detect fork, reconcile divergent chains, rebuild index. | `domain/ledger/merge.py` |

### Extended SyncService

| Method | Purpose |
|--------|---------|
| `getCompleted()` | Read committed entries from ledger chain + staging completed |
| `markCommitted(entryIds, blockIndex)` | Mark staging entries as committed |
| `pushLedgerBlocks()` | Push local ledger blocks to remote (enumerate order, genesis collision guard) |
| `removeSynced(indices)` | Remove committed entries from staging |

### Tests

- Commit 5 entries → chain has 1 day block with 5 entries
- Chain verification: modify a committed entry → verification fails
- Revert: undo last day block → entries return to staging
- Blind index: insert entry with tag "coding" → query by tag → returns correct entry
- Summary: month block aggregates correct total duration
- Chain merge: divergent local + remote chains → merged chain with all entries
- Genesis collision guard: different genesis on remote → pushLedgerBlocks throws
- Content hash verification: legacy v0.3.0 fallback works

### Deliverable

Mobile can commit entries to the ledger. Full chain verification on device. Blind index queries
work. Chain merge works cross-device. This is the complete app — staging + ledger + sync.

---

## Phase 8 — Polish + Release

**Constraint:** Production-ready. Axiom E2: test on real hardware.

### Background Sync

| Platform | Mechanism | Capability |
|----------|----------|------------|
| Android | WorkManager | Periodic sync (min 15 min), network constraints |
| iOS | BGTaskScheduler | Opportunistic sync on background |

### Biometric Auth

| Platform | API | Key Storage |
|----------|-----|-------------|
| Android | BiometricPrompt | EncryptedSharedPreferences |
| iOS | LocalAuthentication | Keychain |

Flow: first unlock → encrypt MK with biometric-bound key → store. Subsequent unlocks: biometric
→ decrypt MK → ready. Fallback: passphrase.

### Release Engineering

- App signing key (keystore) — generated, stored outside repo (Axiom E6)
- AAB build for Play Store
- Version code + version name
- `docs/planning/RELEASE_CHECKLIST.md` §1–7 complete
- Internal testing track with physical devices (Pixel 6a, Galaxy, etc.)

### Final Tests

- E2E: cold install → onboarding → capture → sync → web sees entry → web commits → mobile sees
  committed entry → verify chain (full cross-client roundtrip)
- Offline: airplane mode → capture 5 tasks → go online → auto-sync pushes all 5
- Biometric: enroll fingerprint → lock → unlock with fingerprint → MK restored
- Background: capture task → background app → WorkManager fires → entry pushed to Worker
- Low storage: device near-full → entry capture still works (SQLite handles gracefully)

### Deliverable

App on Google Play Internal track. Physical device tested. Full cross-client roundtrip verified.

---

## Dependency Graph

```
Phase 1 (Models) ──────────────────────────────────────────────┐
   ↓                                                            │
Phase 2 (Crypto FFI) ← highest risk, temp Dart shim unblocks    │
   ↓                                                            │
Phase 3 (Storage)                                               │
   ↓                                                            │
Phase 4 (Sync Core) ← staging-only MVP                          │
   ↓                                                            │
Phase 5 (Services)                                              │
   ↓                                                            │
Phase 6 (Screens) ← functionally complete app                   │
   ↓                                                            │
Phase 7 (Ledger Engine) ← full ledger on mobile                 │
   ↓                                                            │
Phase 8 (Polish + Release)                                      │
```

**Parallelizable:** Phase 1 (models) and Phase 2 toolchain setup can proceed simultaneously.
Phase 6 screen layout/styling can start in parallel with Phase 4–5 if providers are stubbed.

**Phase 1–6 produces a working app.** Phase 7 is additive (ledger commit on mobile). Phase 8
is release polish.

---

## Cross-Reference

| Reference | Relevance |
|-----------|-----------|
| `FLUTTER_AXIOMS.md` | 31 axioms — binding principles for every phase |
| `FLUTTER_ARCHITECTURE.md` | Architecture: layers, patterns, anti-patterns |
| `ARCHITECTURAL_DECISIONS.md` | ADR-027 (go_router), ADR-028 (Drift + SharedPreferences) |
| `RELEASE_CHECKLIST.md` | Phase 8: device testing, Play Store, signing, compliance |
| `SESSION_HANDOFF.md` | Current state: scaffold, decisions, branch |
| `PHPSPEC.md` | Format specification — authoritative contract for field names, encryption, chain structure |
| `phpoc-web/src/sync/sync.js` | Reference SyncService (770 lines) — Phase 4 source of truth |
| `domain/staging/service.py` | Reference StagingService — Phase 4 alternative reference |
| `domain/ledger/engine.py` | Reference LedgerEngine — Phase 7 source of truth |
