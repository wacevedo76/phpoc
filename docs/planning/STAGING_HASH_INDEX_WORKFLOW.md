# Staging Activity ID / Hash Index Workflow

> **Status:** 🔜 SPECIFICATION — defining before mock transport implementation
> **Parent:** `STAGING_ACTIVITY_ID_IMPLEMENTATION_AND_EXECUTION_PLAN.md`
> **Created:** 2026-07-07
> **Purpose:** Specifies the complete data flow contract for staging activity_id + hash index across push, pull, merge, and worker transport. This document is the single source of truth that mock transport infrastructure and remaining test suites (Categories E/F/G/H/I/J) must implement against.
> **Directives:** D1 (Protocol Sovereignty), D2 (Zero-Knowledge), D4 (Chain of Trust)

---

## 1. Full Lifecycle: activity_id from Creation to Cross-Device Merge

```
Device A                                    Remote (R2)                                  Device B
───────────────────────────────────────────────────────────────────────────────────────────────────

1. CREATE
   LocalCache.append({title, startEpoch})
   → activity_id = generateActivityId()   // "xK7mQp2vN9"
   → entry.data.activity_id = activityId
   → write to IndexedDB
   → _refreshHashIndex()                   // local hash index updated

2. PUSH (checkAndSync / pushToRemote)
   LocalCache.readEntries()                // current DTOs
   → buildStagingHashIndex(entries)        // [{id: "xK7mQp2vN9", status: "active"}, ...]
   → JSON.stringify(index)
   → obfuscateBlob(indexJson, mk)          // encrypt (D3)
                                                ──────────────────────────────→
                                                PUT staging/hash_index.json      // encrypted blob
                                                PUT staging/hash_index.sha256    // sha256(encryptedBlob)
                                                ──────────────────────────────→

3. PULL (Device B, checkAndSync)
   // TIER 1 — Fast path
   LocalCache.readHashIndex()              // local index from last sync
   → serialized local index
                                                                    GET staging/hash_index.sha256
                                                                    ←──────────── 64-char hex ────────
   → sha256(localEncryptedIndex) === remoteSha256?
   ├─ YES → DONE (no changes)              // ~1 round-trip, ~0.1s
   └─ NO → TIER 2

   // TIER 2 — Incremental diff
                                                                    GET staging/hash_index.json
                                                                    ←──────── encrypted blob ────────
   → deobfuscateBlob(b64, mk)              // decrypt
   → JSON.parse → remoteIndex
   → compareStagingHashIndexes(localIndex, remoteIndex)
      → {identical, newRemote, removedLocal, statusChanged}

   // Apply deltas
   For each entry in newRemote:
                                                                    GET staging/blob (entry slice)
                                                                    ←──────── entry bytes ───────────
      → deobfuscate + parse
      → LocalCache.append()                // preserves remote's activity_id

   For each id in removedLocal:
      → LocalCache.deleteByActivityId(id)

   For each {id, oldStatus, newStatus} in statusChanged:
      → LocalCache.updateStatus(id, newStatus)  // matches remote

   // Push updated hash index
   → buildStagingHashIndex(entries)
   → push staging/hash_index.json + .sha256

4. MERGE (reconcileDifferentDevice)
   Pull remote staging blob (full)
   → compare with local entries by activity_id
   → merge: remote-new entries appended, local-new preserved
   → push merged blob + hash index
```

---

## 2. checkAndSync() Integration Contract

The `checkAndSync()` method currently pulls the full staging blob. It must be extended with the three-tier cascade:

```
checkAndSync(masterKeyHex):
  1. Tier 1: sha256 fast path
     → localHashIndex = LocalCache.readHashIndex()
     → if localHashIndex is null/empty → skip to Tier 2 (first sync)
     → localEncrypted = obfuscateBlob(JSON.stringify(localHashIndex), mk)
     → localSha256 = sha256(localEncrypted)
     → remoteSha256 = Transport.pull(REMOTE_STAGING_HASH_INDEX_SHA256)
     → if remoteSha256 === localSha256 → return SyncResult.READY (no-op)

  2. Tier 2: incremental diff
     → remoteIndexBytes = Transport.pull(REMOTE_STAGING_HASH_INDEX)
     → if remoteIndexBytes === null → skip to Tier 3 (legacy remote)
     → remoteIndex = deobfuscateBlob(...) + JSON.parse
     → diff = compareStagingHashIndexes(localHashIndex || [], remoteIndex)
     → apply diff (pull new entries, delete removed, update statuses)
     → push updated hash index + sha256
     → return SyncResult.READY

  3. Tier 3: full blob pull (fallback)
     → pull full staging blob → merge → push hash index → return SyncResult.READY
```

### Fallback triggers (Tier N → Tier N+1)

| Condition | Fallback |
|---|---|
| No local hash index cached | Tier 1 → Tier 2 |
| Transport.pull(hash_index.sha256) returns null/404 | Tier 1 → Tier 3 |
| Transport.pull(hash_index.json) returns null | Tier 2 → Tier 3 |
| Deobfuscation of hash_index.json fails | Tier 2 → Tier 3 |
| SHA-256 cross-check fails after decrypt | Tier 2 → Tier 3 |
| Any transport error in Tier 1 or Tier 2 | Proceed to Tier 3 |
| Tier 3 transport error | Return SyncResult.ERROR |

### Post-Tier-3 bootstrap

After a Tier 3 fallback, the client MUST:
1. Build a fresh hash index from merged entries
2. Push `staging/hash_index.json` (encrypted) + `.sha256` to remote
3. Cache locally via `LocalCache.writeHashIndex()`

This ensures the next poll uses Tier 1.

---

## 3. Worker Endpoint Contract

### `GET /storage/staging/hash_index.sha256`

**Auth:** Same as all staging endpoints (`X-Api-Key` header when `PHPOC_API_KEY` is set).
**Purpose:** Return `sha256()` of the raw encrypted `staging/hash_index.json` blob for Tier 1 comparison.

**Behavior:**

| R2 State | Response | HTTP Status |
|---|---|---|
| `staging/hash_index.json` exists | 64-char lowercase hex sha256 | 200 |
| `staging/hash_index.json` missing | Empty body | 404 |
| `staging/hash_index.json` is zero bytes | sha256 of empty bytes (e3b0...) | 200 |

**Headers:**
```
Content-Type: text/plain
ETag: <sha256 value>
Access-Control-Allow-Origin: *
Cache-Control: no-cache
```

**Implementation pseudocode:**
```ts
async function handleHashIndexSha256(request, env) {
  const object = await env.STAGING_BUCKET.get('staging/hash_index.json');
  if (object === null) return new Response(null, { status: 404 });

  const bytes = await object.arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  return new Response(hex, {
    headers: {
      'Content-Type': 'text/plain',
      'ETag': hex,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
    },
  });
}
```

**Key constraint:** The worker computes over the **encrypted** blob. It never sees the plaintext index. The client decrypts and cross-checks locally.

---

## 4. LocalCache API Surface for Hash Index

These methods already exist and are the interface that `checkAndSync` uses:

```js
// Build and read
await cache.readHashIndex()          // → [{id: string, status: string}, ...] | null
await cache.writeHashIndex(index)    // Persist after pull/merge
await cache._refreshHashIndex()      // Rebuild from entries, called after mutations

// Entry lookup by activity_id (needed for Tier 2 deltas)
await cache.findByActivityId(id)     // → StagingEntry | null
await cache.deleteByActivityId(id)   // → void
await cache.updateStatus(id, status) // → void (active/paused/ended)
```

### Methods still needed for Tier 2

| Method | Contract | Purpose |
|---|---|---|
| `findByActivityId(id)` | Returns entry DTO for the given activity_id, or null | Pull single changed entry from remote by ID |
| `deleteByActivityId(id)` | Removes entry with given activity_id from storage | Apply removedLocal delta |
| `updateStatus(id, status)` | Updates `is_active`/`is_paused` fields to match status string | Apply statusChanged delta |

---

## 5. Transport Contract

### Push side (existing, verified by current tests)

```
Transport.push(REMOTE_STAGING_HASH_INDEX, encryptedBytes)       // → staging/hash_index.json
Transport.push(REMOTE_STAGING_HASH_INDEX_SHA256, sha256Bytes)   // → staging/hash_index.sha256
```

Both are pushed immediately after `pushBlob()` in `pushToRemote()` and `pushBlobOnly()`. Already wired ✅.

### Pull side (needed for Tier 1 / Tier 2)

```
Transport.pull(REMOTE_STAGING_HASH_INDEX_SHA256)  // → Uint8Array | null
Transport.pull(REMOTE_STAGING_HASH_INDEX)          // → Uint8Array | null
```

For Tier 2 entry-level pulls:
```
Transport.pullEntry(entryId)  // → Uint8Array | null — pulled from staging/blob entry slice
// OR
Transport.pull(REMOTE_STAGING_BLOB)  // → full blob, client extracts single entry
```

**Design choice needed:** Does Tier 2 pull individual entries or the full blob? The current transport API (`Transport.pull(key)`) only supports whole-blob operations. Options:

1. **Pull full blob, extract locally** — Simpler, less worker changes. Full blob may be ~10s of KB anyway for typical staging. No bandwidth savings for single-entry change (blob already small).
2. **Pull per-entry** — Needs new transport method and worker endpoint. More complex. Only worth it if blobs are > 100KB.

**Recommendation: Pull full blob (option 1).** The bandwidth difference is negligible for staging blobs (typically < 50KB) and avoids adding a new worker endpoint. The optimization is on the *compute/decrypt* side (don't decrypt the whole blob if the sha256 matches), not strictly the *bandwidth* side.

Revised Tier 2 contract:
```
Tier 2:
  1. Pull staging/hash_index.json (encrypted, < 1KB)
  2. Decrypt, compute diff
  3. If diff is non-trivial → pull full staging blob → merge local
  4. Else (status-change only, same entries) → pull full blob, apply status updates
```

---

## 6. Backward Compatibility Contract

### 6.1 Legacy entries (no activity_id)

| Scenario | Behavior |
|---|---|
| `readEntries()` encounters entry without `activity_id` | DTO field is `undefined` or `""` |
| `buildStagingHashIndex()` with legacy entries | Legacy entries are **omitted** from index. Only entries with valid `activity_id` appear. |
| `compareStagingHashIndexes()` with legacy entries | Comparison operates only on indexed entries. Legacy entries are invisible to diff engine. |
| Tier 2 diff applied when local has legacy entries | Tier 3 fallback. Cannot incrementally reconcile entries without stable IDs. |
| New entry appended alongside legacy entries | Gets `activity_id`, appears in hash index, participates in diff |

**Rationale:** Legacy entries without `activity_id` cannot be reliably matched across devices — `entry_index` is position-based and `hash` changes with any field. Rather than building fragile heuristics, omit them from the hash index entirely and fall back to full blob pull when they're present.

### 6.2 Legacy remote (no hash index files)

| Scenario | Behavior |
|---|---|
| Remote has staging blob but no `staging/hash_index.*` | Tier 1 `sha256` pull returns null → Tier 2 `hash_index.json` pull returns null → fallback to Tier 3 full blob pull |
| After Tier 3 fallback | Client builds hash index from merged entries → pushes `hash_index.json` + `.sha256` → remote now bootstrapped |
| Remote has `hash_index.json` but no `.sha256` | Tier 1 skipped (no sha256 to compare) → Tier 2 runs from json |

### 6.3 Stale / mismatched index

| Scenario | Behavior |
|---|---|
| Index has entries not in blob | On next push, rebuilt from blob entries |
| Blob has entries not in index | On next push, rebuilt including all entries |
| Index and blob completely desynced | Tier 2 diff produces garbage deltas → detected by cross-check → fallback to Tier 3 |

---

## 7. Encryption & Integrity Model

```
CLIENT                                      WORKER
══════                                      ══════
hashIndex = [{id, status}, ...]              
indexJson = JSON.stringify(hashIndex)        
encryptedB64 = obfuscateBlob(indexJson, mk)  ──PUT──→ staging/hash_index.json
sha256 = sha256(encryptedBytes)              ──PUT──→ staging/hash_index.sha256
                                               │
                                               │  worker computes:
                                               │  sha256(staging/hash_index.json bytes)
                                               │  ←──GET── sha256 response
                                               │
verify: sha256(localEncrypted) == remote?     │
  YES → identical, DONE                       │
  NO  → pull hash_index.json ──────GET──────→ │
                                              
encryptedBytes ←────────────── response ──────
decrypted = deobfuscateBlob(encryptedB64, mk) 
remoteIndex = JSON.parse(decrypted)           
reEncrypted = obfuscateBlob(decrypted, mk)    
verify: sha256(reEncrypted) == sha256(encryptedBytes)
  YES → integrity confirmed
  NO  → tampered → fallback Tier 3
```

**The worker is blind:** It computes `sha256()` over the raw encrypted bytes. It never decrypts, parses, or inspects the hash index contents. The client re-encrypts after decryption and cross-checks the sha256 to detect tampering.

---

## 8. Test Coverage Map

| Category | # Tests | What it verifies | Contract dependency |
|---|---|---|---|
| A | 7 | activity_id generation | ✅ Done |
| B | 16 | activity_id in entry lifecycle | ✅ Done |
| C | 13 | buildStagingHashIndex() | ✅ Done |
| D | 14 | compareStagingHashIndexes() | ✅ Done |
| E | 11 | Tier 1 sha256 fast path | Needs §2, §5, §7 |
| F | 12 | Tier 2 incremental reconciliation | Needs §2, §4 (new methods), §5 |
| G | 10 | Worker GET hash_index.sha256 | Needs §3 |
| H | 9 | E2E full staging sync | Needs §1, §2, §5 |
| I | 10 | Backward compat | Needs §6 |
| J | 14 | Edge cases & stress | Needs §2 (fallbacks), §4, §7 |

---

## 9. Implementation Sequence (post-workflow-spec)

1. **Implement missing LocalCache methods** (§4): `findByActivityId`, `deleteByActivityId`, `updateStatus`
2. **Wire Tier 1 into checkAndSync()** (§2): sha256 comparison gate
3. **Wire Tier 2 into checkAndSync()** (§2): incremental diff + delta application
4. **Wire fallback cascade** (§2): Tier 3 when Tiers 1/2 fail
5. **Implement Worker endpoint** (§3): `GET /storage/staging/hash_index.sha256`
6. **Green tests** Categories E, F, G, H, I, J

---

## 10. Open Design Questions

| # | Question | Options | Recommendation |
|---|---|---|---|
| Q1 | Tier 2 entry pull: full blob vs per-entry? | (a) Pull full blob, filter locally (b) Add `GET /staging/entries/:activity_id` | **(a)** — staging blobs are small (< 50KB typical), no new worker endpoint needed |
| Q2 | How to handle legacy entries during reconciliation? | (a) Omit from index, force Tier 3 fallback (b) Assign activity_id on-the-fly to legacy entries | **(a)** — consistent with §6.1; avoids mutating data during read |
| Q3 | Hash index push timing: sync or async? | (a) Push immediately after every mutation (b) Push only on checkAndSync / explicit push | **(b)** — already wired this way; avoids churn on rapid local edits |
| Q4 | SHA-256 precomputation location? | (a) Client precomputes and pushes alongside index (b) Worker computes on-demand | Current impl uses **(a)** (client pushes .sha256 alongside .json). Worker endpoint (§3) is a read-only view for GET. |

---

## Related Documents

- `STAGING_ACTIVITY_ID_IMPLEMENTATION_AND_EXECUTION_PLAN.md` — Design decisions D1–D5, Phase plan
- `STAGING_ACTIVITY_ID_TESTS.md` — Full test catalog (116 tests, 10 categories)
- `ONBOARDING_UNLOCK_REAUTH_SPEEDUP_STRATEGY.md` — Ledger hash index architecture (mirrored design)
- `docs/spec/PHPSPEC.md` — Format specification (§4.5 entry fields, §8 staging)
- `docs/design/TOP_LEVEL_DIRECTIVES.md` — D1–D10 binding constraints
- `docs/design/ARCHITECTURAL_DECISIONS.md` — ADR-024 (ledger hash index)
