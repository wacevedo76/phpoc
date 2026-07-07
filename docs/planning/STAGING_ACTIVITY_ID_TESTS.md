# Staging Activity ID — Test Catalog

> **Status:** ✅ Phase 2 — RED (failing tests written)
> **Parent:** `STAGING_ACTIVITY_ID_IMPLEMENTATION_AND_EXECUTION_PLAN.md`
> **Created:** 2026-07-07
> **Purpose:** Exhaustive catalog of all unit, integration, and E2E tests needed for the staging `activity_id` + staging hash index. Output of Phase 1 — no code written.

---

## Architecture Summary

**Current behavior:** Clients pull + decrypt the entire staging blob on every sync poll. Even when nothing changed. ~1 full round-trip per poll, O(n) bandwidth on the staging entry count.

**New behavior (Tier 1 + Tier 2):**

```
Tier 1: Pull staging/hash_index.sha256 (64 bytes) → compare with local sha256(hash_index)
        ├─ Match → DONE (1 round-trip, ~0.1s)
        └─ Mismatch → proceed to Tier 2

Tier 2: Pull staging/hash_index.json → decrypt → compare element-by-element
        ├─ New entries on remote → pull only new staging entries → merge locally
        ├─ Status changes on remote → update local entry status (no full re-pull)
        ├─ Entries removed on remote → remove from local
        └─ Corrupted index → fall back to full blob pull

Fallback: Any tier failure → pull full staging blob (current behavior, backward compatible)
```

**Key design decisions (from the plan):**

| Decision | Detail |
|---|---|
| D1 | `activity_id` is plaintext — opaque random string with zero semantic content |
| D2 | `activity_id` included in content hash automatically (extensible algo covers all keys) |
| D3 | Staging hash index is **encrypted** — unlike ledger hash index. `status` field leaks per-entry state. |
| D4 | File naming: `staging/hash_index.json` and `staging/hash_index.sha256` |
| D5 | Format: 10-char alphanumeric, CSPRNG-generated |

**Staging hash index format (after decryption):**

```json
[
  {"id": "xK7mQp2vN9", "status": "active"},
  {"id": "aB3dEfGhJk", "status": "paused"},
  {"id": "sT9uVwXyZ0", "status": "ended"}
]
```

Ordered list matching the order of staging entries. Entry position is the implicit index into the staging array. The hash index mirrors the staging entry order — no separate sorting.

**New artifacts:**

| Artifact | R2 Path | IndexedDB Key | Purpose |
|---|---|---|---|
| Staging hash index data | `staging/hash_index.json` | `staging:hash_index` | Encrypted ordered list of `{id, status}` pairs |
| Staging hash index SHA-256 | `staging/hash_index.sha256` | (none, worker-computed) | `sha256(staging/hash_index.json)` of encrypted blob |
| Staging hash index worker endpoint | `GET /storage/staging/hash_index.sha256` | — | Returns sha256 (Tier 1), computes over encrypted blob |
| `activity_id` field | In entry `data` dict | — | 10-char random string, immutable |

**Encryption model for staging hash index (D3):**

| Layer | File | Worker sees | Client sees after decrypt |
|---|---|---|---|
| Ledger | `ledger/hash_index.json` | Plain JSON (seals only) | Same |
| Staging | `staging/hash_index.json` | Encrypted blob | Decrypted `[{id, status}, …]` |
| Staging | `staging/hash_index.sha256` | `sha256()` of encrypted blob | Cross-checked locally |

The worker computes `sha256()` over the *encrypted* blob — it never sees the decrypted contents. Client decrypts locally and cross-checks the sha256 matches what it expects.

---

## Test Files to Create

| File | Phase | Categories | Est. lines | Status |
|---|---|---|---|---|
| `phpoc-web/test/activity_id_test.mjs` | 2 | A | 175 | ✅ Written, 7 RED |
| `phpoc-web/test/staging_hash_index_test.mjs` | 2 | B, C, D | 701 | ✅ Written, 43 RED |
| `phpoc-web/test/sync_service_test.mjs` | 2 (modify) | E, F, H (Groups X/Y/Z) | +~200 | ✅ Written, 32 RED |
| `phpoc-web/test/staging_backward_compat_test.mjs` | 2 | I, J | 332 | ✅ Written, 24 RED |
| `worker/test/staging_hash_endpoint_test.ts` | 2 | G | 214 | ✅ Written, 10 RED |

---

## Category A: activity_id Generation (Unit)

**File:** `phpoc-web/test/activity_id_test.mjs` (new)
**Module under test:** `phpoc-web/src/sync/activity_id.js` — `generateActivityId()`
**Type:** Pure function (wraps CSPRNG), no transport, no crypto key.

| ID | Test | Input | Expected Output | Rationale |
|---|---|---|---|---|
| **A1** | Correct length | `generateActivityId()` | String of exactly 10 characters | Spec (D5) mandates 10-char length |
| **A2** | Alphanumeric only | Generate 100 IDs, inspect each | All chars match `[A-Za-z0-9]` | No special characters or whitespace |
| **A3** | No consecutive duplicates within a batch | Generate 1000 IDs | All 1000 IDs are unique (Set dedup) | 95 bits entropy — collisions impossible at this scale |
| **A4** | Deterministic per call (calls a CSPRNG, but result is stable once generated) | Call once, store, call again later | Two calls return different values (because CSPRNG) | Each call produces a fresh random — no caching |
| **A5** | No embedded patterns or timestamps | Generate 100 IDs, inspect | No visible time-based progression; chars uniformly distributed | Opaque ID must not leak creation time |
| **A6** | Null/undefined input ignored | `generateActivityId(null)` | Returns a valid 10-char string (ignores input) | Defensive — no dependency on caller state |
| **A7** | Integration with `crypto.generateUuid()` | Call in sequence with UUID generation | activity_id format ≠ UUID format (no dashes, different length) | These serve different purposes — must not be confused |

---

## Category B: activity_id in Entry Lifecycle (Unit / Integration)

**File:** `phpoc-web/test/staging_hash_index_test.mjs` (new, shared with C)
**Module under test:** `LocalCache.append()` (modified to include activity_id) and ledger commit flow
**Type:** Integration — MemoryBackend + MockCrypto.

### B1–B7: Creation & Persistence

| ID | Test | Setup | Assertions | Rationale |
|---|---|---|---|---|
| **B1** | activity_id assigned at creation time | `localCache.append({title: "Task", startEpoch: 1000})` | Returned entry has `activity_id` field, 10-char alphanumeric | Every new staging entry gets an activity_id |
| **B2** | activity_id present in raw stored data | Append → read raw entries from storage | Raw entry `data.activity_id` is a 10-char string | activity_id is stored as part of the entry data dict |
| **B3** | activity_id is plaintext (not encrypted) | Append → inspect raw data field | `data.activity_id` has no `plain:` prefix, no hex ciphertext. Just 10 alphanumeric chars. | Design Decision D1 — opaque ID needs no encryption |
| **B4** | Two entries created sequentially get different activity_ids | Append entry A, append entry B | `entryA.activity_id !== entryB.activity_id` | Uniqueness within a device's staging |
| **B5** | activity_id included in entry hash computation | Append → inspect `entry.hash` | Hash changes when activity_id is present vs absent (verifiable by hashing data dict with/without the field) | Design Decision D2 — activity_id is part of content hash |
| **B6** | activity_id survives `readEntries()` round-trip as DTO | Append → call `readEntries()` | DTO has `activity_id` field matching the stored value | DTO conversion preserves the field |
| **B7** | activity_id survives `update()` operation | Append → call `update(index, {title: "Changed"})` → read back | activity_id unchanged after update | activity_id is immutable for the entry's lifetime |

### B8–B12: Staging → Commit Lifecycle

| ID | Test | Setup | Assertions | Rationale |
|---|---|---|---|---|
| **B8** | activity_id survives staging → commit (encryption step) | Create entry in staging → sync to ledger (normalize + encrypt + content hash) → read committed block | Committed entry's `data.activity_id` matches staging entry's value | activity_id is stable across the encryption boundary |
| **B9** | activity_id survives re-encryption (device switch) | Entry committed on Device A (with device_id_enc) → pulled to Device B → decrypted with different key | activity_id unchanged after re-encryption with different key | activity_id is plaintext, unaffected by which key encrypts other fields |
| **B10** | activity_id present in committed entry DTO | Commit entry → read committed DTO via `rawCommittedEntryToDTO()` | DTO has `activity_id` field | DTO conversion for committed entries preserves the field |
| **B11** | activity_id survives content hash recomputation | Entry created, content_hash computed → modify non-activity_id fields → recompute content_hash → modify back → recompute | content_hash changes when other fields change but activity_id stays the same; when restored, content_hash matches original (proving activity_id is stable anchor) | Design Decision D2 verified — activity_id as stable anchor in content hash |
| **B12** | activity_id unchanged across pause/unpause/end lifecycle | Create → pause → unpause → end → commit | activity_id same at all lifecycle stages | Full lifecycle stability |

### B13–B16: Staging Hash Index Integration

| ID | Test | Setup | Assertions | Rationale |
|---|---|---|---|---|
| **B13** | Hash index entry created when staging entry appended | Append entry → build staging hash index | Hash index contains exactly one entry with correct `{id, status: "active"}` | Index mirrors staging state |
| **B14** | Hash index status updates when entry paused | Create → pause → build index | Hash index status is `"paused"` | Status tracking in index |
| **B15** | Hash index status updates when entry ended | Create → end → build index | Hash index status is `"ended"` | Status tracking in index |
| **B16** | Hash index entry removed when staging entry deleted | Create → delete entry → build index | Hash index length decremented, removed entry's ID absent | Index mirrors removals |

---

## Category C: Staging Hash Index Data Structure (Unit)

**File:** `phpoc-web/test/staging_hash_index_test.mjs` (same file as B)
**Module under test:** `phpoc-web/src/sync/staging_hash_index.js` — `buildStagingHashIndex(entries)`
**Type:** Pure function over entry DTOs — no transport, no encryption.

| ID | Test | Input | Expected Output | Rationale |
|---|---|---|---|---|
| **C1** | Single active entry | `[{activity_id: "id1", is_active: true, is_paused: false}]` | `[{id: "id1", status: "active"}]` | Basic mapping |
| **C2** | Single paused entry | `[{activity_id: "id1", is_active: true, is_paused: true}]` | `[{id: "id1", status: "paused"}]` | Pause state → `"paused"` status |
| **C3** | Single ended entry | `[{activity_id: "id1", is_active: false, is_paused: false}]` | `[{id: "id1", status: "ended"}]` | Completed entry → `"ended"` status |
| **C4** | Mixed-status entries | `[{active}, {active+paused}, {ended}]` | `[{id:…, status:"active"}, {id:…, status:"paused"}, {id:…, status:"ended"}]` | All three statuses represented |
| **C5** | Order preservation | Entries in specific order | Hash index elements match entry order exactly | Index mirrors staging array order — no re-sort |
| **C6** | Empty staging | `[]` | `[]` (empty array) | Graceful — no staging entries |
| **C7** | Null/undefined input | `null`, `undefined` | `[]` (empty array) | Defensive handling |
| **C8** | Entry missing activity_id | `[{title: "Legacy", is_active: true}]` (no activity_id field) | Entry omitted from hash index (or `{id: null, status: "active"}` — design choice) | Backward compat — legacy entries have no activity_id |
| **C9** | Determinism | Same entries built twice | Identical arrays (deep equality) | No randomness or timestamp injection |
| **C10** | Status classification exhaustive | Entry with `is_active: true`, every possible pause/active combo | Status is one of `"active"`, `"paused"`, or `"ended"` — no other values | Only three states exist |
| **C11** | All output objects have exactly `{id, status}` | Any valid input | Every element is `{id: string, status: string}` with no extra properties | Worker-compatible format |
| **C12** | id is string, not null or undefined (for entries with activity_id) | Entries with valid activity_id | Every `id` is a 10-char non-empty string | Format consistency |
| **C13** | Large staging (200 entries) | 200 entries mixed statuses | Hash index has 200 elements, order matches input, no drops | Performance — build scales linearly |

---

## Category D: Staging Hash Index Comparison (Unit)

**File:** `phpoc-web/test/staging_hash_index_test.mjs` (same file as B, C)
**Module under test:** `phpoc-web/src/sync/staging_hash_index.js` — `compareStagingHashIndexes(local, remote)`
**Type:** Pure function — no transport, no crypto.

| ID | Test | Local Hash Index | Remote Hash Index | Expected Output | Rationale |
|---|---|---|---|---|---|
| **D1** | Identical | `[{id:"a", status:"active"}, {id:"b", status:"paused"}]` | Same | `{identical: true, newRemote: [], removedLocal: [], statusChanged: []}` | Common case — nothing changed |
| **D2** | New entry on remote | `[{id:"a", status:"active"}]` | `[{id:"a", status:"active"}, {id:"b", status:"active"}]` | `{identical: false, newRemote: [{id:"b", status:"active"}], removedLocal: [], statusChanged: []}` | Remote has entry local doesn't → pull it |
| **D3** | Entry removed on remote | `[{id:"a"}, {id:"b"}]` | `[{id:"a"}]` | `{identical: false, newRemote: [], removedLocal: ["b"], statusChanged: []}` | Entry deleted on another device → remove locally |
| **D4** | Status changed (active → paused) | `[{id:"a", status:"active"}]` | `[{id:"a", status:"paused"}]` | `{identical: false, newRemote: [], removedLocal: [], statusChanged: [{id:"a", oldStatus:"active", newStatus:"paused"}]}` | Pause on another device → update local status |
| **D5** | Status changed (paused → ended) | `[{id:"a", status:"paused"}]` | `[{id:"a", status:"ended"}]` | `{identical: false, newRemote: [], removedLocal: [], statusChanged: [{id:"a", oldStatus:"paused", newStatus:"ended"}]}` | End on another device → update local status |
| **D6** | Status changed (active → ended) | `[{id:"a", status:"active"}]` | `[{id:"a", status:"ended"}]` | `{identical: false, newRemote: [], removedLocal: [], statusChanged: [{id:"a", oldStatus:"active", newStatus:"ended"}]}` | Direct end without pause → update status |
| **D7** | Multiple changes (add + status change + remove) | `[{id:"a", status:"active"}, {id:"b", status:"paused"}, {id:"c", status:"ended"}]` | `[{id:"a", status:"paused"}, {id:"c", status:"ended"}, {id:"d", status:"active"}]` | newRemote: `[d]`, removedLocal: `[b]`, statusChanged: `[a: active→paused]` | Complex delta computed in one pass |
| **D8** | Local empty, remote has entries | `[]` | `[{id:"a", status:"active"}]` | `{identical: false, newRemote: [all], removedLocal: [], statusChanged: []}` | First pull on new device |
| **D9** | Remote empty, local has entries | `[{id:"a", status:"active"}]` | `[]` | `{identical: false, newRemote: [], removedLocal: [all], statusChanged: []}` | Remote cleared — local must sync down |
| **D10** | Both empty | `[]` | `[]` | `{identical: true, newRemote: [], removedLocal: [], statusChanged: []}` | Both clean |
| **D11** | Null inputs (defensive) | `null` | `[{id:"a"}]` | Treat null as empty: `newRemote: [{id:"a"}]` | Defensive — null treated as empty |
| **D12** | Entry with null activity_id in local | `[{id:null, status:"active"}, {id:"b", status:"active"}]` | `[{id:"b", status:"active"}]` | null-id entries handled gracefully (skipped in comparison or flagged) | Legacy entries without activity_id |
| **D13** | Reorder detection (entries at different positions but same IDs) | `[{id:"a"}, {id:"b"}]` | `[{id:"b"}, {id:"a"}]` | Treated as identical (same IDs, same statuses) OR reorder flagged — design choice documented | Entries are identified by activity_id, not position |
| **D14** | Very large indexes (500 entries) | 500 entries, remote has 1 status change | Correct delta found in O(n) time; no O(n²) behavior | Performance — linear scan |

---

## Category E: Tier 1 — SHA-256 Fast Path (Integration)

**File:** `phpoc-web/test/sync_service_test.mjs` — **New Group T**
**Module under test:** `SyncService` staging sync with Tier 1 fast path
**Type:** Integration — MockTransport with pre-seeded remote data, MockCrypto.

| ID | Test | Setup | Assertions | Rationale |
|---|---|---|---|---|
| **E1** | Matching SHA-256 → Tier 1 succeeds, no staging blob pull | Local and remote staging identical → push hash index to remote → compute sha256 | `checkAndSync()` → READY. Transport pullCalls does NOT include staging blob pull. Only `staging/hash_index.sha256` pulled. | Common background poll — nothing changed on remote |
| **E2** | Mismatching SHA-256 → falls through to Tier 2 | Remote has different staging (added entry), different sha256 | Proceeds to Tier 2 (pulls hash_index.json, then diff reconciliation) | Normal incremental update |
| **E3** | Network error on SHA-256 pull → falls back to full blob pull | Transport throws on `staging/hash_index.sha256` | Falls back to full staging blob pull; sync still completes | Graceful degradation |
| **E4** | No SHA-256 file on remote (404) → falls back to full blob pull | `staging/hash_index.sha256` returns null/404 | Falls back to full blob pull; sync still works | Legacy remote without hash index |
| **E5** | SHA-256 file exists but empty → falls back to full blob pull | Remote SHA-256 is empty string | Falls back to full blob pull | Corrupted file — safe fallback |
| **E6** | Local has no hash index cached → skip Tier 1, go to Tier 2 | No local `staging:hash_index` in IndexedDB | Tier 1 skipped, Tier 2 runs (pull hash_index.json from remote, decrypt, compare) | First sync after feature deploy or cache miss |
| **E7** | SHA-256 is computed over encrypted hash index blob (not plaintext) | Build hash index, encrypt, push, compute worker-side sha256 | Worker's sha256 matches client's `sha256(encryptedBlob)`, NOT `sha256(plainJSON)` | D3 — worker never sees plaintext |
| **E8** | Client cross-checks: decrypted hash index → re-encrypt → sha256 matches remote | Pull sha256, decrypt hash_index.json, validate locally | Client re-encrypts decrypted index and verifies sha256 matches remote's value | Integrity — remote can't be spoofed |
| **E9** | SHA-256 is 64 hex characters | Pull remote SHA-256 | Content is exactly 64 lowercase hex chars | Format validation |
| **E10** | SHA-256 comparison case-insensitive | Remote has uppercase hex | Still matches lowercase local sha256 | Defensive normalization |
| **E11** | Tier 1 also checks staging-hash-index exists (not just the sha256) | SHA-256 matches but hash_index.json missing | Falls through to Tier 2 / full blob pull | Stale sha256 without corresponding index |

---

## Category F: Tier 2 — Incremental Reconciliation (Integration)

**File:** `phpoc-web/test/sync_service_test.mjs` — **New Group U** (same file as E)
**Module under test:** `SyncService` staging sync with Tier 2 incremental reconciliation
**Type:** Integration — MockTransport with pre-seeded remote data.

| ID | Test | Setup | Assertions | Rationale |
|---|---|---|---|---|
| **F1** | New entry on remote → pull only that entry | Local: 2 entries. Remote: 3 entries (first 2 same). Tier 1 mismatch triggers Tier 2. | Only the 1 new entry pulled from remote staging blob (not all 3). Hash index updated locally. | Core optimization — incremental entry pull |
| **F2** | Status change on remote (paused) → pull only changed entry | Local: `[{id:"a", status:"active"}]`. Remote: `[{id:"a", status:"paused"}]`. | Full blob NOT pulled. Only entry "a" pulled and status updated locally. | Status updates don't need full blob transfer |
| **F3** | Status change on remote (ended) → pull only changed entry | Similar to F2 with `"ended"` status | Entry pulled, local status updated to ended, local `is_active: false` | End lifecycle update |
| **F4** | Entry removed on remote → delete locally | Local: `[{id:"a"}, {id:"b"}]`. Remote: `[{id:"a"}]`. | Entry "b" removed from local staging. No blob pull (just local delete). | Remove operations don't need network |
| **F5** | Hash index push after reconciliation | After any Tier 2 sync that modifies local staging | `staging/hash_index.json` and `staging/hash_index.sha256` pushed to remote | Index must stay in sync with blob |
| **F6** | Multiple simultaneous changes resolved correctly | Local: 3 entries. Remote: +1 new, 1 status changed, 1 removed. | All three deltas applied. Local staging matches remote. One hash index push. | Complex delta batch |
| **F7** | Local has entries remote doesn't → push them | Local: 3 entries. Remote: 2 (first 2 match). Tier 1 mismatch. | Hash index comparison detects local-only entries → push staging blob with merged entries | Local created entries while remote stale |
| **F8** | Hash index push failure is non-fatal | Transport throws on hash index push | Staging blob push succeeds, sync completes, warning logged | Blob is critical; hash index is recoverable |
| **F9** | Index driven-pull fails → fallback to full blob pull | After Tier 2 delta computed but entry pull returns null/corrupt | Fall back to full staging blob pull | Corrupted index entry recovery |
| **F10** | Stale hash index on remote (index has entries blob doesn't) | Remote: index has 5 entries, blob has 3 | After reconciliation, local matches blob (not index). New hash index built and pushed. | Index recovery |
| **F11** | Stale hash index on remote (index missing entries blob has) | Remote: index has 2 entries, blob has 4 | Extra entries pulled as if new; index updated and pushed | Index recovery |
| **F12** | Concurrency: local entry created during Tier 2 reconciliation | Tier 2 detects remote changes, but local also changed during pull | Merge handles both local + remote changes | Concurrency safety |

---

## Category G: Worker Endpoint (Unit)

**File:** `worker/test/staging_hash_endpoint_test.ts` (new)
**Module under test:** Worker `GET /storage/staging/hash_index.sha256` handler
**Type:** Unit — Miniflare or vitest with `SELF.fetch`.

> **Note:** The worker does NOT decrypt the hash index. It computes `sha256()` over the raw encrypted blob stored at `staging/hash_index.json` on R2. The client decrypts and cross-checks locally.

| ID | Test | Request | Assertions | Rationale |
|---|---|---|---|---|
| **G1** | Valid encrypted hash index → returns sha256 as hex | `GET /storage/staging/hash_index.sha256` | 200, body is 64 hex chars, `Content-Type: text/plain` | Happy path |
| **G2** | No hash index on R2 → 404 | Same request, no `staging/hash_index.json` on R2 | 404 (not found) | Client handles by falling back to full blob pull |
| **G3** | Hash index exists but is corrupted → still returns sha256 of corrupted blob | Corrupted bytes stored as `staging/hash_index.json` | 200 with sha256 of corrupted content; client cross-check catches mismatch | Worker is blind — computes sha256 over whatever bytes exist |
| **G4** | Authorization required | Request without `X-Api-Key` header (when `PHPOC_API_KEY` is set) | 403 Forbidden | Same auth model as all staging endpoints |
| **G5** | Response is fast — minimal compute | Valid request | Response time under 50ms in test environment | sha256 of small file is trivial |
| **G6** | CORS headers present | Browser-like request with `Origin` | `Access-Control-Allow-Origin: *` present | Web client access |
| **G7** | ETag matches sha256 value | GET with hash index present | `ETag` header matches sha256 response body | Browser caching optimization |
| **G8** | Content-Type is text/plain not application/json | Valid request | `Content-Type: text/plain` (64 hex chars, not JSON) | Consistent with ledger/hash_index.sha256 format |
| **G9** | Large hash index (500 entries → ~20KB encrypted) | 500-entry staging | sha256 computed quickly, response still 64 bytes | O(1) response size regardless of staging size |
| **G10** | Multiple concurrent requests → consistent sha256 | Two simultaneous GETs, no writes between | Both responses identical | Idempotent read |

---

## Category H: E2E — Full Staging Sync with activity_id (Integration)

**File:** `phpoc-web/test/sync_service_test.mjs` — **New Group V**
**Module under test:** Full `SyncService` staging sync flow with activity_id + hash index
**Type:** Integration — MockTransport + MemoryBackend + MockCrypto.

| ID | Test | Setup | Assertions | Rationale |
|---|---|---|---|---|
| **H1** | Full flow: Tier 1 match → instant sync | Local and remote identical, hash index present | `checkAndSync()` → READY. ~1-2 pulls (sha256 only). No blob transfer. | Common background poll |
| **H2** | Full flow: Tier 1 mismatch → Tier 2 → incremental pull → hash index push | Remote has 1 new entry | All three tiers exercised. New entry synced locally. Hash index pushed. | Incremental update end-to-end |
| **H3** | Full flow: Tier 1 skip (no local cache) → Tier 2 → full reconcile | New device, no local hash index cache | Tier 1 skipped. Tier 2 pulls hash_index.json and reconciles from scratch. | First-sync scenario |
| **H4** | Full flow: Tier 1/2 fail → fallback full blob pull → sync complete | Corrupted remote hash index | Fallback works. Sync completes. New hash index pushed. | Recovery path |
| **H5** | activity_id preserved through full sync cycle | Capture entry → push → pull on second client → verify | activity_id identical on both clients | Cross-client stability |
| **H6** | Hash index locally cached after successful sync | Sync completes → read `staging:hash_index` from IndexedDB | Cache entry exists, content matches decrypted remote index | Next poll uses cached index for Tier 1 |
| **H7** | Hash index SHA-256 locally cached for Tier 1 | Sync completes → sha256 stored locally | Cache entry exists, matches remote sha256 | Tier 1 speedup on next poll |
| **H8** | Multiple sync cycles — hash index evolves correctly | Sync 1: 1 entry. Sync 2: 2 entries (one new on remote). Sync 3: 2 entries (local unchanged) | Each sync updates hash index correctly. Tier 1 match on cycle 3. | Stability across repeated polls |
| **H9** | Offline → create local entries → online → push with hash index | Go offline, create 2 entries, come online | Entries pushed with activity_ids. Hash index pushed. Remote now has updated index. | Offline-first workflow |

---

## Category I: Backward Compatibility (Unit / Integration)

**File:** `phpoc-web/test/staging_backward_compat_test.mjs` (new)
**Type:** Mixed unit + integration — MemoryBackend with pre-existing legacy data.

### I1–I6: Legacy Entries (no activity_id)

| ID | Test | Setup | Assertions | Rationale |
|---|---|---|---|---|
| **I1** | Legacy entry (no activity_id) loaded correctly | Storage contains entry without `activity_id` field | `readEntries()` returns DTO with `activity_id: undefined` or `null` | Old ledgers remain readable |
| **I2** | Legacy entry excluded from or flagged in hash index | Build staging hash index from entries where one legacy entry has no activity_id | Hash index either omits the entry or marks it with `{id: null, status: …}` — design choice documented | Indexer handles missing activity_id gracefully |
| **I3** | Hash index comparison with legacy entries doesn't crash | Local hash index has `{id: null, …}` entry, remote has real IDs | Comparison completes without error; null-id entries handled gracefully | Mixed old/new data |
| **I4** | New entries (with activity_id) coexist with legacy entries | Append new entry (gets activity_id) while legacy entry exists | Both entries readable; new has activity_id, legacy doesn't | Incremental adoption |
| **I5** | content_hash recomputation handles missing activity_id | Entry without activity_id → compute content_hash → add activity_id → recompute | content_hash changes when activity_id added (extensible algo covers all keys) | Old content_hash format detection |
| **I6** | Legacy entries survive full sync → commit cycle | Legacy entry in staging → encrypt + commit to ledger | Committed entry in block, readable, no activity_id field | Full pipeline backward compat |

### I7–I10: Legacy Remote (no hash index files)

| ID | Test | Setup | Assertions | Rationale |
|---|---|---|---|---|
| **I7** | Remote without staging hash index → falls back to full blob pull | Remote has staging blob but no `staging/hash_index.*` files | Sync completes via full blob pull. Hash index pushed for future polls. | Rollout safety |
| **I8** | Remote without hash index sha256 → falls back to full blob pull | Remote has `staging/hash_index.json` but no `.sha256` | Tier 1 skipped (no sha256). Tier 2 runs from hash_index.json. | Partial rollout |
| **I9** | Remote with hash index but no activity_ids in entries | Remote staging entries are all legacy (no activity_id) | Hash index built from entries; entries without IDs handled gracefully | Mixed old entries + new index |
| **I10** | Old client pushes staging blob → new client reads with hash index | Remote blob pushed by pre-activity_id client | New client pulls, detects no hash index → falls back to full blob pull → builds hash index → pushes index for future use | Bilateral backward compat |

---

## Category J: Edge Cases & Stress Tests (Unit / Integration)

**File:** `phpoc-web/test/staging_backward_compat_test.mjs` (same file as I)
**Type:** Mixed unit + integration.

### J1–J8: Data Integrity Edge Cases

| ID | Test | Setup | Assertions | Rationale |
|---|---|---|---|---|
| **J1** | Empty staging — hash index builds to empty array | No staging entries | `buildStagingHashIndex([])` → `[]`. Tier 1: sha256 matches empty encrypted index. | Clean-slate state |
| **J2** | Corrupted hash index decryption → fallback | Remote hash index encrypted with wrong key / corrupted ciphertext | Decryption fails → fall back to full blob pull | Crypto error recovery |
| **J3** | Hash index SHA-256 mismatch after decryption (tampered remote) | Remote index decrypted, re-encrypted → sha256 doesn't match | Client detects mismatch → falls back to full blob pull | Tamper detection |
| **J4** | Hash index has entries not in staging blob | Index: 5 entries, blob: 3 entries | Reconciliation: pulled entries that don't exist; orphaned index entries removed from rebuilt index | Index/staging blob inconsistency recovery |
| **J5** | Staging blob has entries not in hash index | Index: 2 entries, blob: 4 entries | Hash index rebuilt to include all 4 entries; pushed to remote | Index rebuild on mismatch |
| **J6** | Duplicate activity_ids (should never happen, but defensive) | Two entries somehow have same activity_id | `compareStagingHashIndexes` handles duplicates gracefully (first-match or last-match wins, consistent) | Collision defense |
| **J7** | Very long activity_id (format violation) | Entry with 64-char activity_id | Still works — hash index doesn't enforce length at comparison level | Defensive — trust the data |
| **J8** | Non-alphanumeric chars in activity_id | Entry with `"id-with-dashes"` | Still works — no character validation in comparison | Defensive |

### J9–J14: Concurrency & Performance

| ID | Test | Setup | Assertions | Rationale |
|---|---|---|---|---|
| **J9** | Concurrent Tier 1 + local entry creation | Tier 1 in flight, local entry appended | No race condition; local entry included in next sync cycle | Concurrent mutation safety |
| **J10** | Rapid sequential polls with no changes | 5 polls in sequence, no remote changes | All 5 polls use Tier 1 (sha256 match), zero blob transfers | Background poll efficiency |
| **J11** | Large staging (500 entries) — hash index build performance | 500 entries with mixed statuses | `buildStagingHashIndex()` completes under 5ms | O(n) linear build |
| **J12** | Large staging (500 entries) — comparison performance | Two 500-entry hash indexes with 1 status change | `compareStagingHashIndexes()` completes under 10ms | O(n) linear comparison |
| **J13** | Hash index encryption → decryption round-trip | Build index → encrypt with master key → decrypt → compare | Decrypted index matches original | Encryption integrity |
| **J14** | Hash index push with obfuscated staging blob (size tiers) | Push staging blob (obfuscated to class ceiling) + hash index | Hash index pushed as separate file, NOT embedded in obfuscated blob | Independent artifacts |

---

## Category Summary

| Category | Count | Type | New/Modified File |
|---|---|---|---|
| A — activity_id generation | 7 | Unit | `activity_id_test.mjs` (new) |
| B — activity_id lifecycle | 16 | Unit/Integration | `staging_hash_index_test.mjs` (shared) |
| C — Hash index data structure | 13 | Unit | `staging_hash_index_test.mjs` (shared) |
| D — Hash index comparison | 14 | Unit | `staging_hash_index_test.mjs` (shared) |
| E — Tier 1 fast path | 11 | Integration | `sync_service_test.mjs` (new groups) |
| F — Tier 2 incremental | 12 | Integration | `sync_service_test.mjs` (new groups) |
| G — Worker endpoint | 10 | Unit | `staging_hash_endpoint_test.ts` (new) |
| H — E2E full sync | 9 | Integration | `sync_service_test.mjs` (new groups) |
| I — Backward compat | 10 | Unit/Integration | `staging_backward_compat_test.mjs` (new) |
| J — Edge cases | 14 | Unit/Integration | `staging_backward_compat_test.mjs` (shared) |
| **Total** | **116** | | **4 files (3 new, 1 modified)** |

---

## Design Decisions Requiring Test Coverage

These are explicit design choices from the implementation plan. Each maps to specific tests above.

| Decision | Tests Covering It |
|---|---|
| D1 — activity_id is plaintext | A2, B3, B9 |
| D2 — activity_id in content hash | B5, B11 |
| D3 — Staging hash index encrypted | E7, E8, G3, J2, J3 |
| D4 — File naming convention | C1–C14 (use keys.js constants) |
| D5 — 10-char alphanumeric format | A1, A2, A4, A5 |
| Worker is blind | E7, G3 |
| Tier 1 → Tier 2 → Fallback cascade | E3, E4, E5, E6, F9, H4 |
| Backward compatible rollout | I1–I10 |

---

## Related Documents

- `STAGING_ACTIVITY_ID_IMPLEMENTATION_AND_EXECUTION_PLAN.md` — Parent plan with design decisions and phases
- `ONBOARDING_SPEEDUP_TESTS.md` — Ledger hash index test catalog (architectural template)
- `docs/spec/PHPSPEC.md` — Format specification (§4.5 entry fields, §8 staging area)
- `docs/design/TOP_LEVEL_DIRECTIVES.md` — Binding design directives D1–D10
- `SESSION_HANDOFF.md` — Current session state and next steps
