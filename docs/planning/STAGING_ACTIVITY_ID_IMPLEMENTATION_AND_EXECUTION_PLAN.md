# Staging Activity ID — Implementation & Execution Plan

> **Status:** 🔜 PLANNING
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

1. **`activity_id`** — A random opaque string (e.g., 16-char alphanumeric) assigned at activity creation time. Immutable for the activity's lifetime. Embedded in the entry's `data` dict.
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

- **Length:** 16 characters
- **Alphabet:** `[A-Za-z0-9]` (62 possibilities → ~95 bits entropy)
- **Generation:** CSPRNG at activity creation time
- **Collision probability:** Negligible (~1 in 2^95 per ID) within a single user's device
- **Cross-device:** If two devices independently create entries, their `activity_id` values are independent. No coordination needed — the device context makes collisions irrelevant.

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
    "activity_id": "xK7mQp2vN9rL5sT8",   ← NEW: optional, plaintext, 16-char random
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
