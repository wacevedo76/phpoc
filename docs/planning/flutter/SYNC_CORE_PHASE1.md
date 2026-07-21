# Flutter Sync Core — Test Exploration (Phase 1)

> **Plan:** `docs/planning/flutter/INITIAL_PLAN.md` §Phase 4
> **Reference:** `phpoc-web/src/sync/sync.js` (770 lines), `merge_engine.js`, `cookie.js`, `transport.js`, `remote_sync.js`, `local_cache.js`
> **Purpose:** Blueprint of all needed test assertions before writing any test code.
> **Status:** ✅ Phase 1+2+3+4 complete
> **Next Phase:** N/A — Sync Core complete

## Architecture Overview

The Sync Core is a staging-only MVP port of the web `SyncService`. It manages local staging
CRUD with per-field encryption, remote sync via a device-cookie gate, and cross-device entry
merging. The ledger engine is deferred to Phase 7 — this phase handles capture + sync only.

```
┌──────────────────────────────────────────────────────────────────┐
│ SyncService (lib/data/sync/sync_service.dart)                    │
│  Unified entry point: CRUD + checkAndSync() + pushToRemote()    │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │ LocalCache   │  │ DeviceCookie │  │ MergeEngine          │   │
│  │ (enc staging)│  │ (TTL+match)  │  │ (entry_id dedup)     │   │
│  └──────┬───────┘  └──────────────┘  └──────────────────────┘   │
│         │                                                        │
│  ┌──────┴───────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │ EntryDao     │  │ CryptoService│  │ Transport (interface) │   │
│  │ (Phase 3)    │  │ (Phase 2)    │  │ → HttpTransport       │   │
│  └──────────────┘  └──────────────┘  └──────────────────────┘   │
│                                                                  │
│  ┌──────────────┐                                                │
│  │ GenesisGate  │  MVP: passthrough (no local blocks → null)    │
│  └──────────────┘                                                │
└──────────────────────────────────────────────────────────────────┘
```

### Key Design Decisions

- **Staging-only:** No ledger commit on mobile. Entries captured on mobile sync to Worker;
  CLI/web handle sealing into blocks. `pushLedgerBlocks()`, `getCompleted()`, and
  `markCommitted()` are deferred to Phase 7.
- **Axiom B5:** Match JS behavior exactly — do not improve, do not refactor. The JS sync.js is
  the source of truth.
- **Cookie is the truth:** Auth decisions use the device cookie (TTL + specifier match), not
  the cached master key. Same-device touch extends TTL; cross-device mismatch forces re-auth.
- **Encrypted staging fields:** `LocalCache` wraps the Phase 3 storage layer, encrypting fields
  on write and decrypting on read. Uses `plain:` prefix when MK unavailable (no-auth fallback).
- **Blob obfuscation:** Remote blobs are obfuscated via `CryptoService.obfuscateBlob()`.
  Transport pushes/pulls raw bytes; `RemoteSync` handles encrypt/decrypt.
- **Genesis gate passthrough:** No local ledger blocks exist on mobile (staging-only), so
  `GenesisGate.check()` returns null and `checkAndSync()` skips genesis validation.

### Sync Gate Flow

```
checkAndSync():
  1. No remote transport? → READY
  2. Genesis gate → passthrough (no local ledger → continue)
  3. Fast path: local cookie valid? → pull remote cookie
     ├─ Match → pushBlobOnly() → READY
     └─ Mismatch/absent → fall through
  4. Auth gate: MK available?
     ├─ Yes → pull remote blob → merge → push merged → create cookie → READY
     └─ No → REAUTH_NEEDED
  5. Network error at any step → OFFLINE
```

### Dependencies

- **Phase 2 (Crypto):** `CryptoService` — encrypt/decrypt fields, obfuscate blobs, random UUID,
  generate device specifier
- **Phase 3 (Storage):** `EntryDao`, `BlockDao` (schema exists), `Preferences` (Worker URL,
  device UUID), `SecurePreferences` (API key)

---

## Test Groups

### Group A: Transport Interface — ~10 tests

The HTTP transport is the injection seam for remote sync. It abstracts `fetch()` with a
clean interface: `pull`, `push`, `listFiles`, `delete`, plus ETag caching.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | Constructor rejects empty baseUrl | Validates required config | Catches misconfiguration at construction time |
| A2 | Constructor rejects non-http/https baseUrl | Enforces protocol prefix | Prevents silent failures from `file://` or bare hostnames |
| A3 | `pull(path)` returns Uint8List body on 200 | Core read path | Happy-path data retrieval |
| A4 | `pull(path)` returns null on 404 | Backward-compat missing file | Callers distinguish "no data" from "error" |
| A5 | `pull(path)` throws on network failure | Error propagation | Callers catch and return OFFLINE |
| A6 | `push(path, bytes)` succeeds on 2xx | Core write path | Happy-path blob upload |
| A7 | `push(path, bytes)` throws on non-2xx | Error propagation | Prevents silent data loss |
| A8 | `listFiles(prefix)` returns string array | Ledger block enumeration | Needed for future Phase 7 `pushLedgerBlocks` |
| A9 | `listFiles(prefix)` returns empty array on 404 | Graceful empty | No remote ledger = empty, not an error |
| A10 | `delete(path)` succeeds on 2xx/404 | Remote cleanup | Idempotent delete for `clearRemote()` |

### Group B: LocalCache — ~15 tests

Wraps the Phase 3 `EntryDao` with per-field encryption/decryption. Fields are stored encrypted
(`plain:` prefix when MK unavailable). Maintains a staging hash index for cross-device fast-path
comparison.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | `readEntries()` returns decrypted DTO array from storage | Core read path | Consumers get plaintext fields |
| B2 | `readEntries()` returns empty list when no entries exist | Empty state | Graceful empty — no crash |
| B3 | `append()` writes encrypted fields to storage | Encryption on write | Verifies fields stored as encrypted, not plaintext |
| B4 | `append()` computes and stores entry content hash | Hash integrity | Each entry carries its own content hash for verification |
| B5 | `append()` generates unique entry_id per entry | Stable identity | UUIDs required for cross-device merge dedup |
| B6 | `append()` throws on start_epoch collision | Collision detection | Same-ms collision = genuine duplicate |
| B7 | `update()` modifies fields and recomputes hash | Mutation with integrity | Hash always matches current data |
| B8 | `update()` is a no-op on committed entry | Commit guard | Once committed, staging entry is immutable |
| B9 | `delete()` removes entry at index | Deletion | Basic CRUD completeness |
| B10 | `addPause()` appends open pause record | Pause lifecycle | Pauses are JSON arrays, encrypted in storage |
| B11 | `closePause()` closes the last open pause | Pause lifecycle | Completes the pause interval |
| B12 | `computeDuration()` returns correct active time | Duration accuracy | Wall time minus all completed pause intervals |
| B13 | `writeEntries()` replaces all entries (merge use case) | Bulk write | Used after cross-device merge |
| B14 | Encrypt/decrypt roundtrip preserves value | Encryption correctness | `decrypt(encrypt(x)) == x` |
| B15 | `readHashIndex()` / `writeHashIndex()` roundtrip | Hash index persistence | Index cached for Tier 1 fast-path comparison |

### Group C: Merge Engine — ~8 tests

Pure function — no I/O, no crypto, no dependencies. Merges local and remote entry arrays,
deduplicating by `entry_id` (primary) with `(title, start_epoch)` fallback. Remote wins on
ties. Result sorted by `start_epoch` ascending.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | Identical entries in both → one copy, remote source | Dedup correctness | Prevents duplicate entries after merge |
| C2 | entry_id match → remote wins | Remote authority | Remote represents more recent state |
| C3 | title+start_epoch match without entry_id → dedup | Backward compat | Pre-entry_id entries still dedup correctly |
| C4 | Local-only entry preserved in merged result | Local preservation | Entries not on remote survive merge |
| C5 | Remote-only entry added to merged result | Remote addition | New entries from other device are included |
| C6 | Disjoint local + remote → merged has all entries | Union completeness | Cross-device capture produces combined list |
| C7 | Merged result sorted by start_epoch ascending | Sort stability | Deterministic output for hash computation |
| C8 | committed=true preserved across merge (irreversible) | Commit flag integrity | Once committed, can't be downgraded by stale remote |

### Group D: Device Cookie — ~12 tests

Manages the device-specifier cookie used as the auth gate truth. Local cookie carries
`{device_specifier, creation_time}`; remote cookie carries `{device_uuid, device_specifier}`.
TTL defaults to 30 minutes.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | `create()` generates random specifier and persists local cookie | Cookie lifecycle start | Fresh cookie on onboarding/re-auth |
| D2 | `create()` returns remote cookie dict for push | Remote push | Separates local persistence from remote sync |
| D3 | `isValidLocally()` returns cookie when TTL fresh | Fast path gate | Cookie valid = can attempt fast path |
| D4 | `isValidLocally()` returns null when TTL expired | TTL enforcement | Expired cookie triggers auth gate |
| D5 | `isValidLocally()` returns null when no cookie exists | Missing cookie | First sync after cold start |
| D6 | `isValidLocally()` cleans up expired cookie | Garbage collection | Prevents stale data accumulation |
| D7 | `matches()` returns true for identical specifiers | Fast path success | Same device session detected |
| D8 | `matches()` returns false for different specifiers | Cross-device detection | Triggers auth gate for merge |
| D9 | `matches()` returns false when either specifier empty | Null safety | Defensive against corrupt cookies |
| D10 | `parseRemote()` decodes JSON bytes to cookie dict | Transport deserialization | Raw bytes → structured cookie |
| D11 | `parseRemote()` returns null on invalid JSON | Error tolerance | Corrupt remote data doesn't crash |
| D12 | `destroyLocally()` removes cookie from storage | Cleanup | Called before creating new cookie on re-auth |

### Group E: SyncService — Local CRUD — ~16 tests

Local staging operations that never call remote. Each write touches the local cookie to extend
TTL. Operations resolve the device UUID for attribution.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | `capture({title})` creates active entry in storage | Core capture | Primary user action |
| E2 | `capture()` returns entry hash prefix | Hash return | Consumers can reference the new entry |
| E3 | `capture()` touches local cookie TTL | Cookie refresh | Each write extends the fast-path window |
| E4 | `capture()` includes device_uuid attribution | Device tracking | Required for cross-device merge |
| E5 | `end(title, endEpoch)` sets is_active=false + end_epoch | Task completion | Marks task as completed |
| E6 | `end()` throws when no active task matches title | Error on missing | Prevents silent failure |
| E7 | `end()` auto-closes open pause before ending | Pause cleanup | Ensures correct duration computation |
| E8 | `end()` recomputes duration after pause closure | Duration accuracy | End timestamp minus start minus pauses |
| E9 | `pause(title, pauseEpoch)` adds open pause record | Pause start | Tracks interruption intervals |
| E10 | `pause()` throws when no active task matches title | Error on missing | Consistent with end() behavior |
| E11 | `unpause(title, unpauseEpoch)` closes open pause | Pause end | Completes pause interval |
| E12 | `unpause()` throws when no active task matches title | Error on missing | Consistent error handling |
| E13 | `modify(index, fields)` updates entry fields | In-place edit | Change title/tags/comment |
| E14 | `remove(index)` deletes entry from staging | Deletion | Remove unwanted entries |
| E15 | Multiple captures + ends produce correct entries | Sequential operations | Real-world usage pattern |
| E16 | All CRUD ops work without remote transport | Offline resilience | Local operations never depend on network |

### Group F: SyncService — Queries — ~5 tests

Read queries that return decrypted entry DTOs. No remote calls.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| F1 | `getActive()` returns only is_active=true entries | Active filter | Dashboard shows running tasks |
| F2 | `getActive()` returns empty when no active entries | Empty state | Graceful empty dashboard |
| F3 | `getEntries()` returns all staging entries sorted | Full listing | History view |
| F4 | `getEntries(from, to)` filters by date range | Date filter | Narrow history to specific period |
| F5 | Entries are returned as decrypted DTOs with entry_index | DTO format | Consumers receive flat, usable objects |

### Group G: SyncService — Sync Gate — ~18 tests

The `checkAndSync()` gate is the central sync decision point. It runs genesis gate (passthrough),
fast path (cookie match → push only), and auth gate (pull → merge → push → cookie). Returns
`SyncCheckResult`: READY, OFFLINE, or REAUTH_NEEDED.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| G1 | No remote transport → returns READY | Local-only mode | App works without Worker configured |
| G2 | Genesis gate passthrough (no local blocks → continue) | MVP simplification | Mobile has no ledger, skip genesis check |
| G3 | Local cookie valid + remote cookie match → READY (fast path) | Fast path success | Same device, no merge needed |
| G4 | Fast path pushes local blob only (pushBlobOnly) | Blob push on fast path | Remote gets latest staging without full auth gate |
| G5 | Local cookie valid + remote cookie mismatch → REAUTH_NEEDED | Cross-device detection | Different device wrote last, require re-auth |
| G6 | Local cookie valid + no remote cookie → auth gate (merge) | First push | No remote = first sync, proceed to merge |
| G7 | Local cookie expired → REAUTH_NEEDED | TTL enforcement | Expired cookie = must re-authenticate |
| G8 | No local cookie → REAUTH_NEEDED | Missing cookie | Never synced or cookie destroyed |
| G9 | MK available + cookie valid → reconcile (pull+merge+push) | Auth gate success | Authenticated user, full sync cycle |
| G10 | MK not available → REAUTH_NEEDED | Auth requirement | Can't decrypt remote blob without MK |
| G11 | Network error during cookie pull → OFFLINE | Network resilience | Transient failure, keep local state |
| G12 | Network error during blob pull → OFFLINE | Network resilience | Can't reconcile, stay local |
| G13 | Remote blob key mismatch → OFFLINE (no overwrite) | Data safety | Wrong MK = don't overwrite remote blob |
| G14 | Merge produces combined entries from local + remote | Reconciliation | Cross-device entries unified |
| G15 | Committed entries filtered from merged result | Commit filtering | Committed entries belong in ledger, not staging |
| G16 | New cookie created after successful auth gate merge | Cookie rotation | Fresh cookie claims ownership after merge |
| G17 | Cookie pushed to remote after merge | Remote cookie sync | Other devices see new cookie on next check |
| G18 | Same-device cookie match before remote push prevents race | Race prevention | Cookie pushed before blob = other devices wait |

### Group H: SyncService — Push — ~8 tests

Explicit push operations that serialize local staging, obfuscate, and write to remote. Pushes
blob first, cookie second (order matters for crash recovery).

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| H1 | `pushToRemote()` serializes all staging entries | Full push | All local entries reach remote |
| H2 | `pushToRemote()` pushes blob obfuscated with MK | Encryption | Transport never sees plaintext |
| H3 | `pushToRemote()` pushes blob BEFORE cookie | Crash safety | Blob push fails → cookie unchanged → retry |
| H4 | `pushToRemote()` includes device_id + device_proof in blob | Device attribution | Remote blob identifies writing device |
| H5 | `pushToRemote()` no-ops when no remote transport | Local-only safety | No crash when Worker not configured |
| H6 | `pushBlobOnly()` pushes blob without touching cookie | Sync-only push | Fast path pushes data but doesn't claim ownership |
| H7 | Staging hash index pushed after blob (best-effort) | Fast path optimization | Enables Tier 1 hash comparison on next check |
| H8 | `lastPushAt` timestamp updated after successful push | Diagnostics | Consumers can check last sync time |

### Group I: Genesis Gate — ~4 tests

MVP: the genesis gate only checks if local ledger blocks exist. Since the mobile app is
staging-only (no local blocks), it always returns null (passthrough). Full genesis validation
(block pulls, hash comparison, chain merge) comes in Phase 7.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| I1 | `check()` returns null when no local blocks exist | MVP passthrough | Staging-only app skips genesis check |
| I2 | `check()` returns null when local blocks array is empty | Empty chain | Same as no blocks |
| I3 | Genesis gate integrated into checkAndSync() but bypassed | Integration | Gate runs, returns null, sync continues |
| I4 | `resetGenesisGate()` clears compatibility cache | Reconfiguration | Changing Worker URL resets gate state |

### Group J: Integration — ~10 tests

Cross-component flows that exercise the full sync cycle end-to-end. These tests wire together
transport, local cache, merge engine, cookie, and sync service.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| J1 | Capture on device A → pushToRemote → checkAndSync on device B → entry visible | Cross-device sync | Full capture→push→pull→merge cycle |
| J2 | Capture on both devices → merge produces union | Cross-device merge | Both devices' entries survive merge |
| J3 | Same entry modified on both → remote wins | Conflict resolution | Remote authority prevents split-brain |
| J4 | Offline capture → go online → checkAndSync pushes | Offline resilience | Queue of local changes syncs when connected |
| J5 | `checkAndSync()` returns OFFLINE when transport unreachable | Graceful degradation | App continues working offline |
| J6 | `checkAndSync()` returns REAUTH_NEEDED when MK missing | Auth gate | Unlocked app requires passphrase for sync |
| J7 | Full cycle: capture → end → push → pull on other device → merge → entries match | End-to-end | Verifies all components wire correctly |
| J8 | Cookie TTL expires → fast path fails → auth gate → re-auth → new cookie → sync | TTL cycle | Full cookie lifecycle from expiry to renewal |
| J9 | `reconfigure(transport)` replaces transport + resets genesis | Hot-swap transport | Settings changes take effect immediately |
| J10 | isRemoteAvailable returns false when transport is null | Null safety | UI can check sync availability |

---

## Summary

| Group | Name | Assertions |
|-------|------|-----------|
| A | Transport Interface | 10 |
| B | LocalCache | 15 |
| C | Merge Engine | 8 |
| D | Device Cookie | 12 |
| E | SyncService — Local CRUD | 16 |
| F | SyncService — Queries | 5 |
| G | SyncService — Sync Gate | 18 |
| H | SyncService — Push | 8 |
| I | Genesis Gate (MVP) | 4 |
| J | Integration | 10 |
| **Total** | | **106** |

### Coverage Distribution

```
 Transport (A):  ████████░░  9%
 LocalCache (B): ████████████  14%
 MergeEngine (C): ██████░░  8%
 Cookie (D):     █████████  11%
 CRUD (E):       ████████████  15%
 Queries (F):    ████░░  5%
 SyncGate (G):   ██████████████  17%
 Push (H):       ██████░░  8%
 Genesis (I):    ███░░  4%
 Integration (J): ████████░░  9%
```

### Deferred to Phase 7 (Ledger Engine)

- `pushLedgerBlocks()` — enumerate order, genesis collision guard, hash index push
- `getCompleted()` — read committed entries from ledger chain, dedup by entry_id
- `markCommitted(entryIds, blockIndex)` — mark staging entries as committed
- Genesis gate full check — fetch remote chain, verify seals, compare genesis hashes, merge chains
- `clearRemote()` — delete all remote keys + reset gate

### Key Coverage Areas

- **Offline-first:** Every CRUD operation works without transport (E16). `checkAndSync()` handles
  network failures gracefully (G11, G12, J5).
- **Cross-device merge:** Merge engine dedup is tested in isolation (C1–C8) and integration (J1–J3).
- **Cookie lifecycle:** Full TTL cycle from creation to expiry to renewal (D1–D12, J8).
- **Data safety:** Wrong MK never overwrites remote blob (G13). Committed flag is irreversible (C8, G15).
- **Axiom B5 compliance:** All assertions derived from JS reference behavior, not idealized design.
