# Staging Activity ID — Implementation & Execution Plan

> **Status:** ✅ Phase 3 — GREEN (core complete)
> **Created:** 2026-07-07
> **Goal:** Introduce a stable, random `activity_id` assigned at activity creation time to enable lifecycle tracking (Staging → Commit) and power a staging hash index for fast cross-client staging reconciliation.

---

## Motivation

### Problem

Currently there is no stable identifier for a staging entry that survives its lifecycle. Existing identifiers all change or aren't portable:

| Identifier | Stable across lifecycle? | Issue |
|---|---|---|
| `entry.hash` | ❌ | Changes when *any* data field changes (duration, endTime, tags, content_hash) |
| `content_hash` | ❌ | Changes when plaintext content changes (endTime, duration, metadata) |
| `entry_index` (staging array) | ❌ | Position-based; shifts on delete/reorder; not portable across devices |
| `device_id_enc` | ❌ | Identifies the device, not the activity |

In a multi-device staging setup, clients currently pull and decrypt the *entire* staging blob to detect what changed — even when nothing has changed. This wastes bandwidth and compute on every poll.

### Solution: Activity ID + Staging Hash Index

Two complementary additions that mirror the ledger hash index architecture:

1. **`activity_id`** — A random opaque string (e.g., 10-char alphanumeric) assigned at activity creation time. Immutable for the activity's lifetime. Embedded in the entry's `data` dict.
2. **Staging hash index** — An ordered list of `{activity_id, status}` pairs stored at `staging/hash_index.json` on R2, with a companion `staging/hash_index.sha256` for Tier 1 fast-path comparison.

### Architecture (mirrors ledger hash index)

```
Ledger layer:                       Staging layer:
─────────────────────────────────────────────────────────
ledger/hash_index.json              staging/hash_index.json
  [block_seal_0, block_seal_1, …]     [ {id, status}, {id, status}, … ]
  sha256(hash_index)                  sha256(hash_index)
  compare → fork detection            compare → diff detection
  pull only new blocks                pull only changed entries

Tier 1: sha256 match → identical     Tier 1: sha256 match → identical
Tier 2: pull index → reconcile       Tier 2: pull index → reconcile diffs
```

### Expected Savings

| Scenario | Current | New | Speedup |
|---|---|---|---|
| No changes (common background poll) | Pull + decrypt full staging blob | ~0.1s (sha256 comparison) | ~100×+ |
| New entry added on remote | Pull + decrypt full blob | Pull hash index + 1 entry | ~10× |
| Status change (pause/unpause/end) | Pull + decrypt full blob | Pull hash index → update local state | ~20× |
| First sync (no local cache) | N/A | Pull hash index (Tier 2 baseline) | — |

---

## Design Decisions

### D1: `activity_id` is plaintext (not encrypted)

**Rationale:** The `activity_id` is an opaque random string with zero semantic content about the activity. An attacker learning it gains:
- Confirmation that *some* activity exists (already leaked by blob file size tier)
- An opaque ID that can't be correlated to anything without the master key

This follows the same principle as `title` and `tags` — structurally needed in plaintext for indexing and display. The spec's encrypted fields (§3.1.1) protect *user content* (timestamps, metadata, pauses), not infrastructure identifiers.

### D2: `activity_id` is included in the content hash automatically

**Rationale:** The extensible content hash algorithm (PHPSPEC §6.1, v0.4.0+) iterates **all** keys in the entry's data dict. Since `activity_id` is assigned at creation and never changes, it becomes a **stable anchor** inside the content hash — it doesn't introduce variance, it ensures the content hash uniquely identifies *this specific activity's current version*.

### D3: Staging hash index is encrypted (unlike ledger hash index)

**Rationale:** The ledger hash index contains only block seals (HMACs) — already opaque to an observer. The staging hash index contains `{activity_id, status}` pairs. While `activity_id` is opaque, the `status` field (`active` / `paused` / `ended`) leaks per-entry state at a finer granularity than the current tier-based blob obfuscation allows.

Encrypting the staging hash index file keeps the transport blind while still enabling the worker to compute `sha256()` for Tier 1 comparison:

| Layer | File | Worker sees | Client sees |
|---|---|---|---|
| Ledger | `ledger/hash_index.json` | Plain JSON (seals only) | Same |
| Ledger | `ledger/hash_index.sha256` | `sha256()` result | Same |
| Staging | `staging/hash_index.json` | Encrypted blob | Decrypted `[{id, status}, …]` |
| Staging | `staging/hash_index.sha256` | `sha256()` of encrypted blob | Cross-checked locally |

### D4: File naming follows existing convention

**Decision:** `ledger/hash_index.json` and `staging/hash_index.json`. The `ledger/` and `staging/` directory prefixes already provide namespace isolation. No abbreviated prefixes (`lhash`/`shash`) — inconsistent with the existing file naming pattern.

### D5: `activity_id` format

- **Length:** 10 characters
- **Alphabet:** `[A-Za-z0-9]` (62 possibilities → ~59 bits entropy)
- **Generation:** CSPRNG at activity creation time
- **Collision probability:** ~6 × 10⁻¹³ with 1,000 simultaneous entries across all devices (birthday bound). Effectively zero within the bounded staging lifecycle (entries span hours to days, not the full ID space). Across the entire human population each creating 400M entries, ~1 collision expected — irrelevant in practice.
- **Rationale (vs 16-char):** The activity_id scope is a single user's staging window (hours to days, ≤~1,000 entries at any time), not global uniqueness. 10 chars provides ~59 bits — far beyond the birthday-bound collision threshold for this bounded scope — while keeping indexes compact. A collision between two devices' IDs would cause the hash index diff engine to misidentify a new entry as a status change, so the margin above the birthday bound must be comfortable. 10 chars provides that margin (10⁻¹³ for 1,000 entries). 16 chars was over-engineered under an implicit infinity assumption that doesn't match the staging lifecycle.

---

## Spec Conformance Analysis

### PHPSPEC compatibility: ✅ Conforms

The spec (v0.3.0, §9.3) explicitly allows optional field additions:

> - New fields must be optional (absent = old format)
> - Old ledgers must remain readable without migration
> - The content hash algorithm (v0.4.0+) automatically covers new data fields without requiring spec updates or version bumps for simple field additions

`activity_id` is a textbook "simple field addition":
- Optional — absent means pre-activity_id ledger
- Old ledgers remain readable (field absence is handled gracefully)
- Extensible content hash covers it automatically
- No `format_version` bump needed

### New entry data field

```json
{
  "data": {
    "activity_id": "xK7mQp2vN9",   ← NEW: optional, plaintext, 10-char random
    "title": "Guitar Practice",
    "duration": 3600000,
    "is_active": false,
    "is_paused": false,
    "startTime_enc": "<hex ciphertext>",
    "endTime_enc": "<hex ciphertext>",
    "pauses_enc": "<hex ciphertext>",
    "metadata_enc": "<hex ciphertext>",
    "tags": ["music", "learning"],
    "media": [],
    "content_hash": "<hex>",
    "comment": "Practiced scales",
    "device_id_enc": "<hex ciphertext>",
    "device_proof": "<hex>"
  }
}
```

### No encryption needed

The spec encrypts fields carrying user content (timestamps, metadata, pauses). `activity_id` carries no content — it's an opaque random key. Plaintext is appropriate and consistent with `title` and `tags`.

---

## New Artifacts

| Artifact | Location | Purpose |
|---|---|---|
| `activity_id` field | Entry `data` dict (§4.5) | Stable, random identifier for lifecycle tracking |
| Staging hash index | `staging/hash_index.json` (R2) / `staging:hash_index` (IndexedDB) | Ordered list of `{activity_id, status}` pairs |
| Staging hash index SHA-256 | `staging/hash_index.sha256` (R2) | `sha256(staging/hash_index.json)` for Tier 1 fast path |
| Worker endpoint | `GET /storage/staging/hash_index.sha256` | Returns `sha256(staging/hash_index.json)` (encrypted blob) |
| Hash index builder | `phpoc-web/src/sync/staging_hash_index.js` | Build `{id, status}` list from staging entries |
| Hash index comparator | `phpoc-web/src/sync/staging_hash_index.js` | Compare lists, compute diffs |

---

## Implementation Phases

### Phase 1 — Test Identification

**Output:** `docs/planning/STAGING_ACTIVITY_ID_TESTS.md` — exhaustive test catalog.

#### Test Categories

- **Category A: activity_id generation** — unit tests for ID format, length, entropy, uniqueness
- **Category B: activity_id in entry lifecycle** — unit tests verifying ID survives staging → commit, survives re-encryption
- **Category C: Staging hash index data structure** — unit tests for `buildStagingHashIndex(stagingEntries)`
- **Category D: Staging hash index comparison** — unit tests for diff detection (new, removed, status-changed, identical)
- **Category E: Tier 1 — SHA-256 fast path** — integration tests for worker-computed shortcut
- **Category F: Tier 2 — Incremental reconciliation** — integration tests for diff-based pull
- **Category G: Worker endpoint** — unit tests for `GET staging/hash_index.sha256`
- **Category H: Cross-client staging sync** — E2E tests for multi-device staging with activity_id
- **Category I: Backward compatibility** — tests for ledgers without activity_id fields
- **Category J: Edge cases** — empty staging, corrupted index, stale index, concurrent modifications

### Phase 2 — Test Creation (RED)

**Output:** All test files created/updated. New tests fail (code not yet implemented).

### Phase 3 — Implementation (GREEN)

**New files to create:**

| File | Purpose |
|---|---|
| `phpoc-web/src/sync/staging_hash_index.js` | `buildStagingHashIndex(entries)`, `compareStagingHashIndexes(local, remote)`, `computeHash` |
| `worker/src/staging_hash_index_handler.js` | Worker endpoint for `GET staging/hash_index.sha256` |

**Existing files to modify:**

| File | Change |
|---|---|
| `phpoc-web/src/staging/` (entry creation) | Assign `activity_id` on new entry creation |
| `phpoc-web/src/sync/sync.js` | Push staging hash index alongside staging blob; cache locally after sync |
| `phpoc-web/src/sync/keys.js` | Add `REMOTE_STAGING_HASH_INDEX`, `REMOTE_STAGING_HASH_INDEX_SHA256`, `LOCAL_STAGING_HASH_INDEX` constants |
| `phpoc-web/src/sync/staging_sync.js` | Add Tier 1 + Tier 2 fast path before full blob pull |
| `worker/src/index.js` | Register staging hash index endpoint route |
| `domain/staging/` (CLI) | Parallel changes for Python-side staging sync |
| `core/sync/orchestrator.py` | Wire staging hash index into CLI sync flow |

### Phase 4 — Refactoring & Integration

**Output:** Code is modular, all edge cases covered, tests green.

---

## Privacy Analysis

### What the staging hash index leaks (vs. current blob-only approach)

| Metadata | From blob (current) | From hash index (proposed) |
|---|---|---|
| Entry count | Tier range only (1-50? 51-100?) | Exact count |
| Which entries exist | Nothing | Opaque IDs (not linkable without MK) |
| Entry status | Nothing | Active / Paused / Ended |
| Timing of changes | Tier transitions only | Per-entry status transitions visible |

### Mitigation

The staging hash index file is **encrypted** with the master key before push. The worker computes `sha256()` over the encrypted blob for Tier 1 comparison but cannot read the contents. This matches the ledger hash index privacy model — the worker is a blind relay.

### Acceptable tradeoff

The ledger hash index (ADR-024) already accepts leaking block count and type distribution. The staging hash index accepts a slightly broader leak (per-entry status at the granularity of opaque IDs), but the speedup for cross-client staging sync justifies it. The same principle applies: the hash index is a cache, always rebuildable, and the worker is blind.

---

## Related Documents

- `docs/spec/PHPSPEC.md` — Format specification (§4.5 entry fields, §6.1 extensible content hash, §8 staging area, §9.3 format evolution)
- `docs/planning/ONBOARDING_UNLOCK_REAUTH_SPEEDUP_STRATEGY.md` — Ledger hash index design (architectural precedent)
- `docs/planning/ONBOARDING_SPEEDUP_TESTS.md` — Ledger hash index test catalog (template for Phase 1)
- `docs/design/ARCHITECTURAL_DECISIONS.md` — ADR-024 (ledger hash index)
- `docs/planning/E2E_CROSS_CLIENT_FIX_PLAN.md` — Cross-client staging sync context
- `SESSION_HANDOFF.md` — Current session state

---

## Future Direction: Row-Level Database Model (Exploration — 2026-07-07)

### Summary

A design exploration session considered converting the staging area from a single JSON blob to a proper row-per-activity database. The key insight: **with a SQLite-backed staging store, the entire staging hash index becomes redundant** — it exists solely as a workaround for the single-blob model's inability to do incremental sync efficiently.

### The current single-blob model

- **Storage:** One JSON array under a single key (`'entries'` in IndexedDB, `staging.json` on disk)
- **Mutations:** Read all → modify → write all (O(n) for every operation)
- **Remote sync:** Pull/push the entire encrypted blob, padded to size tiers (64K–512K)
- **Hash index:** Introduced as a workaround to detect changes without pulling the full blob — Tier 1 sha256 comparison on `{id, status}[]` list, Tier 2 pull the actual list and diff

### SQLite is zero-dependency for the CLI

The `sqlite3` module is part of Python's standard library — as bundled as `json` or `hashlib`. A `staging.db` file would not violate the CLI's zero-external-dependency goal. SQLite is a proper relational engine (B-tree indexes, ACID transactions, full SQL) that stores everything in a single file on disk.

### Proposed three-column schema

```sql
CREATE TABLE staging (
    activity_id TEXT PRIMARY KEY,
    activity_status TEXT NOT NULL,  -- 'active' | 'paused' | 'ended'
    activity TEXT NOT NULL          -- obfuscated entry JSON blob
);
```

The `activity` column holds the individual obfuscated entry data. The `activity_id` and `activity_status` columns are plaintext — structurally needed for querying, carrying no user content (same rationale as `title`, `tags`, and the current `activity_id` field per D1).

### What the hash index becomes

With this schema, the entire staging hash index (`staging_hash_index.js`, ~200 lines) collapses into a single SQL query:

```sql
SELECT activity_id, activity_status FROM staging ORDER BY activity_id;
```

That query _is_ the hash index. No separate build step, no separate storage key, no separate remote files.

### What goes away

| Artifact | Lines | Reason it existed |
|----------|-------|-------------------|
| `staging_hash_index.js` | ~200 | Build/compare/hash `{id, status}` arrays |
| `LOCAL_STAGING_HASH_INDEX` key | — | Cached copy of the index |
| `REMOTE_STAGING_HASH_INDEX` + `_SHA256` | — | Two remote files to sync |
| `_pushStagingHashIndex()` in `sync.js` | ~40 | Build + encrypt + push index after every mutation |
| `_pullAndCacheStagingHashIndex()` | ~20 | Pull + decrypt + cache after reconcile |
| `_refreshHashIndex()` in `local_cache.js` | ~10 | Called after every CRUD operation |
| Tier 1/Tier 2 diff logic | ~60 | `compareStagingHashIndexes()` — entire diff algorithm |
| Worker endpoint test | ~1 file | `staging_hash_endpoint_test.ts` |

### Sync payload comparison

| Scenario | Current (single blob) | Row-level DB |
|----------|----------------------|-------------|
| Nothing changed, cookie match | 0 bytes | 0 bytes |
| Nothing changed, no cookie match | 64KB–512KB (padded blob) | ~0 bytes (key listing) |
| One entry's status changed | 64KB–512KB | ~300–800 bytes (one row) |
| One new entry added | 64KB–512KB | ~300–800 bytes |
| Three entries modified | 64KB–512KB | ~1–3KB |
| Tags/comment/title changed | 64KB–512KB | ~300–800 bytes per row |
| Full reconcile (different device) | 64KB–512KB + 64KB–512KB push | ~n rows (same total, rare case) |

**Critical improvement:** The current hash index only detects status flips (active↔paused↔ended) via `is_active`/`is_paused` booleans. It completely misses content changes — tag edits, comment updates, title changes, timestamp modifications. Row-level storage with per-row `updated_at` versioning catches every change.

### Per-row obfuscation trade-offs

**Privacy regression:** An attacker who sees remote storage (R2 bucket) can count exactly how many staging entries exist (one file per row). The current blob model pads to size tiers that only leak a range (1–50? 51–100?). Mitigation: pad individual rows to a fixed size, or use a hybrid container (single encrypted file with internal B-tree index for O(log n) access).

**Performance trade-off:** Individual per-row encryption means _n_ AES operations for bulk reads instead of one. For Dashboard/History views that list all entries, this could be _slower_ at moderate sizes (~50 entries) than decrypting one blob. At very large sizes, the O(1) mutation speed dominates.

### Query benefits

IndexedDB (web) or SQLite (CLI) indexes enable:
- Filtering by status without loading all entries into memory
- Tag-based queries via a join table or multi-value index
- Date-range queries on `start_epoch`
- `committed` flag filtering for pending-sync views

### Open questions

1. **Hybrid approach:** Single encrypted container with internal B-tree index — gets O(log n) access + blob-level privacy, but adds container format complexity.
2. **Web side:** IndexedDB can do row-level storage natively (it already is a database). The `idb-keyval` library is deliberately using the minimal IndexedDB surface. Would replace with direct IndexedDB object store usage or a thin SQLite-in-WASM layer (`sql.js`).
3. **Worker redesign:** Row-level remote storage requires a new protocol — list rows, push/pull individual rows by `activity_id`. The Worker currently only handles monolithic blob push/pull.
4. **Migration path:** All existing users must migrate from single-blob to row-level. Must be atomic and recoverable.
5. **Python CLI:** Parallel change needed — replace `staging.json` file with `staging.db` SQLite database.

### Relationship to current Phase 3 work

The current Phase 3 hash index implementation remains valuable as a near-term improvement within the existing single-blob architecture. The row-level DB model is a future architectural shift that would supersede and simplify it. The hash index experience (Tier 1/Tier 2, privacy analysis, diff detection) directly informed the row-level design and will make the transition smoother when undertaken.

### Decision (2026-07-07)

Committed to the row-level DB direction. All staging hash index tests have been removed (4 files + 32 stubs across categories A–J). The implementation splits into two parallel work streams:

1. **Worker protocol redesign** — Row-level staging endpoints (`GET/PUT/DELETE /storage/staging/rows/{activity_id}`, `GET /storage/staging/manifest` for diff detection). Shared by both CLI and web.
2. **CLI: SQLite staging store** — `SqliteStagingStore` implementing `AbstractStagingStore` with the three-column schema. Migrate from `staging.json`.
3. **Web: Worker ↔ IndexedDB row-level staging** — Direct IndexedDB object store or per-row keys, replacing the single `'entries'` blob. Sync against row-level Worker endpoints.

See `SESSION_HANDOFF.md` for current status.
