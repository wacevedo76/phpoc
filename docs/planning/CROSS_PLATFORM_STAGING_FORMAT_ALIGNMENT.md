# Cross-Platform Staging Format Alignment

> **Status:** 🔜 Discussion & Decision Phase
> **Scope:** Align Flutter, Web, and CLI staging formats for cross-client interoperability
> **Depends on:** B-03 (Flutter staging schema) ✅, B-04 (Flutter row-level sync wiring) ✅

## Problem

Three clients implement remote staging with three incompatible architectures:

| | Flutter | Web | CLI |
|---|---|---|---|
| **Blob path** | `staging/blob` | `staging/blobs/current.json` | `staging/blobs/current.json` |
| **Hash index path** | `staging/hash_index.json` | `staging/hash_index.json` | ❌ None |
| **Cookie path** | `staging/blobs/device_cookie.bin` | `staging/blobs/device_cookie.bin` | `staging/blobs/device_cookie.bin` |
| **Blob envelope** | `{ entries, device_id, device_proof }` | `{ entries, device_id, device_proof, updated_at }` | `{ entries, device_id, device_proof, updated_at }` |
| **Entry identity** | `activity_id` (10-char CSPRNG) | `activity_id` + `entry_id` (dual — migration artifact) | `entry_id` (UUID4-based) |
| **Hash index format** | `[{ activity_id, activity_status }]` sorted, SHA-256 | `[{ activity_id, activity_status }]` sorted, SHA-256 | ❌ |
| **Merge strategy** | activity_id LWW, **local wins** on tie | buildDiff: activity_id LWW, **remote wins** on tie | None (single-device) |
| **JSON serialization** | `json.encode()` (compact) | `JSON.stringify()` (compact) | `json.dumps(indent=2)` |
| **Obfuscation** | AES-CTR + HMAC (same as web) | AES-CTR + HMAC | 4-tier padding (64K-512K) + AES-CTR + HMAC |
| **Transport model** | Single blob pull/push | Old: single blob. New (`row_sync.js`): per-row CRUD via Worker endpoints | Single blob pull/push |
| **Row-level staging** | ✅ Fully wired (B-03 + B-04) | ✅ Code exists (`RowStagingStore`, `row_sync.js`, `staging_hash_index.js`) — **not wired into sync gate** | ❌ None |

### Design rationale for current differences

**Why `updated_at` in the envelope (CLI/Web):** ADR-021 (2026-05-21) added it for a freshness optimization — compare `remote_updated_at` against `_last_push_at` to skip full blob deobfuscation when nothing changed. One integer comparison saved AES-CTR decrypt + JSON parse on every poll. With the hash index fast path (ADR-024), this optimization is redundant — the hash index provides more precise per-row change detection. The canonical format **drops `updated_at` from the envelope**.

**Why `activity_id + entry_id` dual identity (Web):** This is a migration artifact, not a deliberate two-system design:
1. **`entry_id` (ADR-021, May 2026):** First-generation stable identifier (UUID4, 36 chars). Replaced the fragile `(title, start_epoch)` dedup key so cross-device end/pause/modify could target the right entry.
2. **`activity_id` (Staging Activity ID Plan, July 2026):** Second-generation identifier (10-char CSPRNG). More compact for hash index arrays, survives the staging→commit lifecycle, embedded in content_hash.
3. **Web carries both** for backward compatibility with pre-activity_id entries. **Flutter skipped `entry_id` entirely** — built after the activity_id design was finalized.

**Canonical direction:** `activity_id` as the single primary key. `entry_id` is a legacy field that should not be required in new implementations.

### Concrete impact: what breaks today

1. **Flutter ↔ Web:** Different blob paths (`staging/blob` vs `staging/blobs/current.json`) → they never see each other's data. Even if paths aligned, envelope fields differ (`updated_at`).
2. **Flutter ↔ CLI:** Different paths, different entry identity (`activity_id` vs `entry_id`), different obfuscation padding schemes. Complete incompatibility.
3. **Web ↔ CLI:** Same path but different entry identity. Web has row-level code that would expect `activity_id`; CLI pushes `entry_id`-based entries.
4. **Hash index:** Flutter builds and pushes hash index to `staging/hash_index.json`. Web builds hash index but doesn't consistently push/read it from the sync gate. CLI has no hash index at all.

---

## Architecture Comparison

### Model A: Single Blob (Flutter, CLI, Web old path)

```
┌──────────┐     push(staging/blob, obfuscated_blob)     ┌──────────┐
│  Client  │ ──────────────────────────────────────────► │   R2     │
│          │ ◄────────────────────────────────────────── │  Storage │
└──────────┘     pull(staging/blob) → deobfuscate        └──────────┘
```

**How it works:**
1. Client reads all local rows from `StagingStore`
2. Wraps them in `{ entries: [...], device_id, device_proof }`
3. Obfuscates with master key
4. Pushes single blob to R2 path
5. On sync: pulls remote blob, deobfuscates, merges with local

**Pros:**
- Dead simple — two R2 operations (push + pull), no Worker logic needed
- Atomic — entire staging state is a single blob; no partial-sync inconsistencies
- Already works on R2 — the Worker's generic blob handlers serve any path
- Easy to reason about; easy to test
- Hash index provides O(1) fast-path without pulling full blob

**Cons:**
- Pulls full blob even for single-row changes (hash index mitigates this)
- ~64KB blob for typical staging (~20 active entries) — not huge but grows
- No granular conflict resolution — entire blob wins/loses on merge
- Two devices pushing simultaneously → last-write-wins at blob level, then merge reconciles

**Blob size estimate:** ~2-3KB per entry × typical 5-20 entries = 10-60KB. Under 64K tier.

---

### Model B: Per-Row CRUD (Web `row_sync.js`)

```
┌──────────┐     GET  /storage/staging/manifest            ┌──────────┐
│  Client  │ ──────────────────────────────────────────►   │  Worker  │
│          │ ◄── { rows: [{id, status, updated_at}], ... } │  (custom │
│          │                                                │  routes) │
│          │     GET  /storage/staging/rows/{id}            │          │
│          │ ──────────────────────────────────────────►   │          │
│          │ ◄── { activity_id, activity, status, ... }    │          │
│          │                                                │          │
│          │     PUT  /storage/staging/rows/{id}            │          │
│          │ ──────────────────────────────────────────►   │          │
│          │     body: { ... full row ... }                │          │
│          │                                                │          │
│          │     DELETE /storage/staging/rows/{id}          │          │
│          │ ──────────────────────────────────────────►   │          │
└──────────┘                                                └──────────┘
```

**How it works:**
1. Client fetches a lightweight manifest: `[{ activity_id, activity_status, updated_at }]`
2. Runs `buildDiff(localRows, remoteManifest, ledgerHashIndex)` → `{ pull, push, deleteLocal }`
3. Pulls only changed rows (individual GET per `activity_id`)
4. Pushes only locally-changed rows (individual PUT per `activity_id`)
5. Deletes locally-committed rows (individual DELETE per `activity_id`)

**Pros:**
- Minimal data transfer — only changed rows, not full blob
- Granular conflict resolution at row level
- Manifest is tiny (~200 bytes for 10 entries) → fast fetch
- Natural fit for CRDT-style sync
- Can scale to hundreds of staging entries

**Cons:**
- **Requires Worker changes** — the current Worker has no `/storage/staging/manifest` or `/storage/staging/rows/*` endpoints. These would need to be built.
- N+1 request problem — 10 changed rows = 10 individual GET/PUT calls
- More complex error handling — partial failures (some rows succeed, some fail)
- Harder to test — more network interactions to mock
- Manifest + per-row storage requires Worker-side state management (not just pass-through to R2)
- No atomicity guarantee — manifest and rows can get out of sync

**Current state:** `row_sync.js` is written and tested but talks to Worker endpoints that don't exist. The sync gate (`sync.js`) still uses the old single-blob path.

---

### Model C: Hash-Index-Augmented Single Blob (Hybrid)

```
┌──────────┐     pull(staging/hash_index.json)             ┌──────────┐
│  Client  │ ──────────────────────────────────────────►   │   R2     │
│          │ ◄── [{ activity_id, activity_status }]        │  Storage │
│          │                                                │          │
│          │     IF hash differs:                           │          │
│          │     pull(staging/blob) → deobfuscate → merge   │          │
│          │ ──────────────────────────────────────────►   │          │
│          │                                                │          │
│          │     push(staging/blob, obfuscated_blob)        │          │
│          │ ──────────────────────────────────────────►   │          │
└──────────┘                                                └──────────┘
```

**How it works (Flutter's current implementation):**
1. Pull hash index first (~200 bytes) — O(1) fast path
2. If identical → push local (no merge needed), return READY
3. If different → pull full blob, merge, push result
4. Hash index pushed alongside blob

**Pros:**
- Combines simplicity of single-blob with speed of hash-index fast path
- Hash index is tiny → fast-path check is ~50ms
- No Worker changes needed — all R2 blob storage
- Already fully implemented and tested in Flutter (1412 tests)
- Two-level fallback: hash index fail → full blob pull

**Cons:**
- Still pulls full blob on hash mismatch (same as Model A)
- Blob size grows with staging entries
- Two devices pushing simultaneously → last-write-wins race at blob level

**This is essentially Model A with an optimization.** The hash index is not a separate architecture — it's a cache that enables skipping the full blob pull.

---

## Decision: Canonical Format

### Recommendation: Model C (Hash-Index-Augmented Single Blob)

Model A is the foundation. Model C is Model A with the hash-index fast path — which Flutter already implements and Web has the code for (`staging_hash_index.js`). Model B (per-row CRUD) requires Worker-side infrastructure that doesn't exist and introduces significant complexity for marginal benefit at current staging scales (5-50 entries).

### Canonical Blob Format (target)

```json
{
  "entries": [
    {
      "activity_id": "a1b2c3d4e5",
      "activity_status": "active",
      "activity": "{... encrypted entry JSON ...}",
      "updated_at": 1714000000000,
      "committed": false
    }
  ],
  "device_id": "uuid-string",
  "device_proof": "hmac-hex-string"
}
```

### Canonical Hash Index Format

```json
[
  { "activity_id": "a1b2c3d4e5", "activity_status": "active" },
  { "activity_id": "f6g7h8i9j0", "activity_status": "ended" }
]
```

Sorted by `activity_id` ascending. SHA-256 of `JSON.stringify(sorted_array)`.

### Canonical Paths

| Purpose | Path |
|---------|------|
| Staging blob | `staging/blob` |
| Hash index | `staging/hash_index.json` |
| Device cookie | `staging/blobs/device_cookie.bin` |
| Ledger blocks | `ledger/blocks/{block_id}.json` (unchanged) |
| Ledger hash index | `ledger/hash_index.json` (unchanged) |

### Key Decisions to Resolve

| Decision | Options | Impact |
|----------|---------|--------|
| **D1: Merge tie-break (same updated_at)** | Local wins (Flutter) vs Remote wins (Web buildDiff) | Must be consistent across clients. Proposal: **local wins** (Flutter's behavior, simpler — no extra pull) |
| **D2: `updated_at` in envelope** | Include (CLI/Web) vs Omit (Flutter) | Flutter omits it; CLI/Web include it. Redundant — each row has its own `updated_at`. Proposal: **omit from envelope** |
| **D3: `indent=2` vs compact JSON** | CLI uses indent=2, Flutter/Web use compact | Hash index SHA-256 must be deterministic. Proposal: **compact** (no whitespace). Update CLI. |
| **D4: Obfuscation tier scheme** | CLI uses 4-tier padding (64K-512K), Flutter/Web use simpler obfuscation | Different schemes = different ciphertext. Must align. Proposal: **Flutter/Web scheme** (simpler, already cross-tested). CLI adopts. |
| **D5: Legacy path migration** | `staging/blobs/current.json` → `staging/blob` | ~~dual-read, single-write for one release cycle~~ **RESOLVED: immediate cutover.** Single user — no migration window needed. Switch and done. |
| **D6: CLI `entry_id` → `activity_id`** | CLI entries have no activity_id | CLI must generate activity_ids for new entries. Existing entries need migration. Proposal: **CLI adopts ActivityIdGenerator** (same CSPRNG scheme). |

---

## Implementation Plan

### Phase 1: Format Specification (this document → PHPSPEC.md §8)

Extract the canonical format into a standalone section of PHPSPEC.md:
- Blob envelope schema
- Row schema (core + extension fields)
- Hash index schema
- Obfuscation spec (aligned across all clients)
- Path constants
- Merge tie-break rule

### Phase 2: CLI Alignment (B-05c)

- Add `activity_id` generation to CLI staging entries (`ActivityIdGenerator` port)
- Switch blob path: `staging/blobs/current.json` → `staging/blob`
- Adopt compact JSON serialization (drop `indent=2`)
- Add `StagingHashIndex` build/compare (port from Flutter/Web)
- Add hash-index fast path to `RemoteStagingSync`
- Align obfuscation with Flutter/Web scheme
- **No migration window** — immediate cutover (single user)

### Phase 3: Web Alignment (B-05b)

- Switch sync gate blob path: `staging/blobs/current.json` → `staging/blob`
- Wire `buildDiff` + `RowStagingStore` into `_reconcileDifferentDevice`
- Wire `StagingHashIndex` fast path into `checkAndSync`
- Align merge tie-break: remote-wins → **local-wins** (resolved: both clients use local-wins on tie)
- Drop `updated_at` and `entry_id` from envelope (keep both at row level: `updated_at` for LWW, `entry_id` optional for legacy compat)
- **No migration window** — immediate cutover (single user)

---

## Open Questions

1. ~~**Merge tie-break:**~~ ✅ RESOLVED — Local-wins on tie. Single-human constraint makes same-ms conflicts a theoretical edge case. Both clients converge on Flutter's current behavior (`remoteTs > localTs → remote, else local`).

2. ~~**CLI migration path:**~~ ✅ RESOLVED — Full `StagingStore` (SQLite, row-level, activity_id, hash index), matching Flutter.

3. ~~**Worker `row_sync.js` endpoints:**~~ ✅ RESOLVED — Retire `row_sync.js`. Latency analysis shows per-row CRUD (N×RTTs) gains nothing over single blob (~2 RTTs) at PHPOC staging scales (5–100 entries, ~10–60KB). Single blob + hash index is canonical.

4. ~~**Backward compatibility window:**~~ ✅ RESOLVED — Immediate cutover, no dual-read. Single user; no migration window needed. Web and CLI switch directly from `staging/blobs/current.json` → `staging/blob`.

5. ~~**`committed` flag in blob:**~~ ✅ RESOLVED — Included as canonical row field. Essential for cross-device committed-entry cleanup (B-01 bug). Prevents activity duplication when device A commits and device B still has the entry in staging.

6. ~~**`updated_at` in envelope:**~~ ✅ RESOLVED — Omit from canonical envelope.

7. ~~**`entry_id` dual identity:**~~ ✅ RESOLVED — `activity_id` as single canonical key.

---

## References

- B-03: Flutter Staging Schema Overhaul — `docs/planning/flutter/STAGING_OVERHAUL_PHASE1.md`
- B-04: Flutter Row-Level Sync Wiring — `docs/planning/flutter/B04_ROW_LEVEL_SYNC_PHASE1.md`
- Web row-level staging: `phpoc-web/src/sync/row_sync.js`, `row_staging_store.js`, `staging_hash_index.js`
- CLI staging sync: `domain/staging/remote_sync.py`
- Web sync gate: `phpoc-web/src/sync/sync.js`
- Web staging paths: `phpoc-web/src/sync/keys.js`
- Flutter staging paths: `phpoc-flutter/lib/data/sync/staging_paths.dart`
- ADR-025: LWW resolution with ledger-aware cleanup
