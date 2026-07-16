# I-03: Staging At-Rest Encryption — Test Exploration (Phase 1)

> **Plan:** BACKLOG.md §Phase 3 — I-03
> **ADR:** ADR-015 (Multi-Device Shared Encrypted Staging, D2 direction)
> **Purpose:** Blueprint of all needed test assertions before writing any test code.
> **Status:** ✅ Phase 1 (test exploration) → ✅ Phase 2 (RED: test definition)
> **Next Phase:** Phase 3 (GREEN: implementation)

## Architecture Overview

The change is architecturally contained to `LocalStagingCache` — the only class
that touches the `plain:` prefix convention. After I-03:

- **`CryptoManager` (with MK):** `encrypt()` → AES-CTR + auth tag (hex). `decrypt()` → plaintext.
- **`NoAuthCryptoManager` (no MK):** `encrypt()` → `"plain:{value}"` (unchanged). `decrypt()` → strips `"plain:"` (unchanged).

The key insight: `LocalStagingCache._encrypt_field()` already delegates to
`self._crypto.encrypt()`. When a `CryptoManager` with a real master key is
passed, entries on disk become AES-CTR ciphertext. When `NoAuthCryptoManager`
is passed (pre-auth), entries remain `plain:` — preserving D6 (staging capture
without auth).

The read path (`_from_plain`) needs a try-decrypt → fallback-to-plain: strategy
for backward compatibility with existing staging files.

### Files in scope

| File | Role | Change |
|------|------|--------|
| `domain/staging/local_cache.py` | `_to_plain`/`_from_plain` primitives | Replace with real encrypt/decrypt + plain: fallback |
| `domain/staging/service.py` | `_raw_entry_to_dto` remote blob parsing | Add encrypted-entry support to remote blob reader |
| `phpoc-web/src/sync/local_cache.js` | Web staging cache (37 `plain:` references) | Mirror Python changes in JS |
| `phpoc-web/src/sync/entry_dto.js` | Entry DTO translation (13 `plain:` refs) | Add encrypted-field support |
| `phpoc-web/src/sync/remote_sync.js` | Remote blob push/pull (4 `plain:` refs) | Handle encrypted local entries |
| `docs/spec/PHPSPEC.md` §8.2, §8.4 | Staging format spec | Document encryption, update staging vs ledger table |

---

## Test Groups

### Group A: `local_cache.py` — Encryption/Decryption Primitives (~8 tests)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | `_encrypt_field` with `CryptoManager` produces hex ciphertext (not starting with `plain:`) | Verify encryption produces real AES-CTR output | The core change: plain: → real crypto |
| A2 | `_encrypt_field` with `NoAuthCryptoManager` produces `"plain:{value}"` | Verify backward-compatible behavior without MK | D6 requires staging capture without auth; NoAuthCryptoManager preserves plain: |
| A3 | `_from_plain` on `"plain:1714000000000"` returns `"1714000000000"` | Backward compat: old plain: staging files still readable | Existing ledgers must not break (D9) |
| A4 | `_from_plain` on AES-CTR ciphertext returns original plaintext | Verify real decryption of new-format entries | Core correctness: encrypted entries round-trip |
| A5 | `_from_plain` on corrupt hex returns `None` (not crash) | Graceful degradation on corrupt encrypted data | Staging is transient; one corrupt entry shouldn't block all reads |
| A6 | `_from_plain` on `None` returns `None` | Handle null fields correctly | endTime_enc is null for active tasks |
| A7 | `_from_plain_int` on encrypted integer field returns correct int | Verify integer fields survive encryption round-trip | start_epoch and end_epoch are critical integers |
| A8 | `_from_plain_int` on corrupt/invalid data returns `None` | Graceful fallback for integer parsing failures | Malformed entries shouldn't crash read_entries |

### Group B: `local_cache.py` — `read_entries` Backward Compatibility (~6 tests)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | `read_entries` on existing `plain:` staging file returns correct decrypted DTOs | Existing staging files remain readable after upgrade | D9 backward compatibility; user data must survive the upgrade |
| B2 | `read_entries` on fully encrypted staging file returns correct decrypted DTOs | New-format staging files read correctly | The happy path for new staging entries after I-03 |
| B3 | `read_entries` on mixed-format file (some plain:, some encrypted) works | Transitional state: upgrade in progress | Real-world scenario: user authenticates mid-session, some entries pre-auth, some post-auth |
| B4 | `read_entries` on empty staging file returns `[]` | Empty staging file is valid | Edge case: fresh install, no tasks yet |
| B5 | `read_entries` skips entry with corrupt `startTime_enc` (not crash) | Graceful corruption handling | One corrupt entry must not block the rest |
| B6 | `read_entries` preserves all non-encrypted fields (title, tags, comment, media, entry_id, is_active, is_paused, duration) | Schema integrity: read path doesn't drop fields | DTO consumers depend on all fields being present |

### Group C: `local_cache.py` — `write_entries` (~5 tests)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | `write_entries` with `CryptoManager` produces no `"plain:"` strings in output | Verify encryption is applied on write | The core guarantee: staging at rest is encrypted when MK is available |
| C2 | `write_entries` with `NoAuthCryptoManager` produces `"plain:"` prefix fields | Verify plain: fallback still works without MK | D6: staging capture without auth still possible (plain: fallback) |
| C3 | Entry hash (`hash` field) is consistent for same data | Hash integrity: re-write same data → same hash | Hash is used for cross-device deduplication; must be deterministic |
| C4 | `write_entries` persists `comment` field unencrypted | Comment is intentionally plaintext in staging | Current design: comment is in data dict but not `_enc` suffixed. This may change or be preserved. |
| C5 | `write_entries` handles all field types: int (duration), bool (is_active), list (tags, media, pauses), dict (metadata) | All field types survive serialization | Schema completeness; one missing field type breaks downstream consumers |

### Group D: `local_cache.py` — CRUD Operations (~7 tests)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | `append` with `CryptoManager` stores encrypted startTime_enc, device_uuid_enc, pauses_enc, metadata_enc | New entries are encrypted end-to-end | The most common write path must produce encrypted output |
| D2 | `append` with `NoAuthCryptoManager` stores `plain:` prefixed fields | Pre-auth capture still works | D6: user can add tasks before entering passphrase |
| D3 | `update` with `CryptoManager` re-encrypts modified epoch fields | Partial updates preserve encryption | `end()` modifies end_epoch — must stay encrypted |
| D4 | `update` with `NoAuthCryptoManager` preserves `plain:` format on modified fields | Pre-auth updates work correctly | User can end a task started pre-auth, before authenticating |
| D5 | `add_pause` / `close_pause` preserve encryption format of `pauses_enc` | Pause operations don't break encryption | Pause records are stored in `pauses_enc`; must stay consistent |
| D6 | `update_by_entry_id` preserves encryption of modified fields | Entry-ID-based updates (used by web sync) work with encryption | Cross-client sync uses entry_id for stable updates |
| D7 | `delete` and `remove_multiple` work correctly with encrypted entries | Removal operations don't touch encryption of other entries | Deletion is index-based; must not cascade-corrupt remaining entries |

### Group E: `local_cache.py` — Round-Trip Integrity (~4 tests)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | Write with `CryptoManager` → read with same `CryptoManager` produces identical DTOs | Full round-trip: encrypt → persist → decrypt → verify | The fundamental integrity guarantee |
| E2 | Write with `CryptoManager` → read with new `CryptoManager` (same MK) produces identical DTOs | Different CryptoManager instances with same key work | Real-world: CryptoManager is created fresh per session |
| E3 | Write with `CryptoManager(mk1)` → read with `CryptoManager(mk2)` fails gracefully (skips entry) | Different MK → corrupt entry → skip, don't crash | Multi-user or wrong-passphrase scenarios |
| E4 | Write → read → write → read (double round-trip) preserves all fields | Idempotency: multiple reads/writes don't degrade data | Common pattern: read, merge, write, read back |

### Group F: `service.py` — `_raw_entry_to_dto` Remote Blob Parsing (~5 tests)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| F1 | Parse remote blob with `plain:` entries (current format) returns correct DTOs | Backward compat: remote staging may still have plain: entries from old clients | Cross-client: CLI updated but web not yet, or vice versa |
| F2 | Parse remote blob with encrypted entries (hex ciphertext) returns correct DTOs | New format: remote staging has encrypted entries | After both clients update, remote blobs will be encrypted |
| F3 | Parse remote blob with mixed entries (some plain:, some encrypted) returns correct DTOs | Transitional state: some entries committed pre-upgrade, some post-upgrade | Real-world migration scenario |
| F4 | Parse corrupt remote entry returns `None` (doesn't crash the merge loop) | Graceful handling of malformed remote data | Network/corruption errors shouldn't crash the merge |
| F5 | `_raw_entry_to_dto` handles `committed` flag on remote entries correctly | Committed entries still filtered correctly after encryption change | Committed flag is checked post-merge; must not regress |

### Group G: `service.py` — Integration (Full Flow) (~6 tests)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| G1 | `capture` → `read_entries` with `CryptoManager`: entry fields encrypted on disk, DTOs decrypted correctly | Full capture → read workflow | Primary user flow: add a task, view it |
| G2 | `end` → `read_entries`: modified end_epoch encrypted, DTO shows correct end_epoch | End task flow preserves encryption | User ends a task; end_epoch must be encrypted but readable |
| G3 | `push_to_remote`: local encrypted entries serialized and pushed correctly | Push flow: local encrypted → remote transport | Sync must not leak plaintext to transport layer |
| G4 | `_reconcile_and_claim`: merge local encrypted + remote encrypted (same device) → correct merged result | Same-device merge with encrypted entries | Fast path: same device session, pull + merge + push |
| G5 | `_reconcile_and_claim`: merge local encrypted + remote encrypted (different device) → correct merged result | Cross-device merge with encrypted entries | Auth gate path: different device wrote, must reconcile |
| G6 | `check_and_sync` fast path with encrypted entries: pull → merge → push → READY | Full check_and_sync fast path works with encryption | Most common sync path (same device, valid cookie) |

### Group H: Backward Compatibility — Migration (~4 tests)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| H1 | Existing `staging.json` with all `plain:` fields is readable after I-03 upgrade | No data loss on upgrade | D9: user must not lose staging data after upgrading |
| H2 | Read existing plain: staging → write with CryptoManager → re-read: values preserved, format now encrypted | Upgrade path: old staging can be transparently upgraded to encrypted | Normal usage after upgrade: auth → sync → staging becomes encrypted |
| H3 | Read existing plain: staging → write with NoAuthCryptoManager → re-read: values preserved, format still plain: | Pre-auth usage preserves plain: format | User adds tasks before auth; existing plain: entries stay plain: |
| H4 | Remote staging blob with old `plain:` entries is parsed correctly during sync | Cross-client backward compat | Web client updated before CLI, or vice versa; remote must work with both formats |

### Group I: Web Side — IndexedDB Staging Encryption (~6 tests)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| I1 | `local_cache.js` stores entries encrypted in IndexedDB when MK is available | Web staging at rest is encrypted | Mirror of Python change; web has same `plain:` vulnerability |
| I2 | `local_cache.js` reads encrypted entries from IndexedDB and returns decrypted DTOs | Web read path decrypts correctly | DTO consumers (UI, merge engine) must receive decrypted values |
| I3 | `local_cache.js` reads legacy `plain:` entries from IndexedDB (backward compat) | Web backward compat: existing IndexedDB data | Users with existing browser data must not lose staging entries |
| I4 | `entry_dto.js` `rawEntryToDTO` handles encrypted fields (not just `plain:`) | Web DTO translation works with encrypted entries | entry_dto.js is the bridge between raw storage and UI DTOs |
| I5 | `entry_dto.js` `rawCommittedEntryToDTO` handles encrypted fields | Committed entry translation works with encryption | Used for ledger entries that reference staging data |
| I6 | `remote_sync.js` pushBlob handles locally encrypted staging entries | Web push preserves encryption on the wire | Sync integrity: encrypted at rest → encrypted in transit |

### Group J: Edge Cases (~5 tests)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| J1 | Very long title (>256 chars) round-trips through encryption correctly | AES-CTR handles arbitrary-length plaintext | CTR mode has no length limits; verify implementation handles large fields |
| J2 | Unicode in title/tags/comment survives encryption round-trip | Non-ASCII data integrity | Real-world: emoji, accented characters, CJK in task titles |
| J3 | Empty strings and `None` values handled correctly across the boundary | Null/empty field handling | `end_epoch=None` for active tasks, `comment=None` when not set |
| J4 | Many entries (50+) read/write performance is acceptable | Scale: staging with many entries | Users may accumulate entries before committing; must not degrade |
| J5 | `plain:` string appearing in user data (e.g., title "plain: pancake recipe") not misinterpreted | No false positive on `plain:` prefix detection | The `plain:` prefix check in decrypt path must be unambiguous; AES-CTR ciphertext never starts with `plain:` |

---

## Summary

| Group | Area | Tests |
|-------|------|-------|
| A | Encryption/decryption primitives | 8 |
| B | read_entries backward compat | 6 |
| C | write_entries | 5 |
| D | CRUD operations | 7 |
| E | Round-trip integrity | 4 |
| F | _raw_entry_to_dto remote parsing | 5 |
| G | Service integration | 6 |
| H | Backward compatibility / migration | 4 |
| I | Web side (IndexedDB + DTO + sync) | 6 |
| J | Edge cases | 5 |
| **Total** | | **56** |

**Python tests (Groups A–H, J):** ~50 tests in `tests/test_staging_at_rest_encryption.py`  
**Web tests (Group I):** ~6 tests across existing test files (local_cache_test.mjs, entry_dto_committed_test.mjs, sync_service_test.mjs)

### Key Design Decisions Confirmed

1. **`CryptoManager` encrypts, `NoAuthCryptoManager` keeps `plain:`** — D6 preserved (capture without auth). D2 satisfied when MK is available.
2. **Read path: try-decrypt, fallback-to-plain:** — D9 backward compat. Existing staging files remain readable.
3. **`plain:` fallback in `_from_plain`, not in `CryptoManager.decrypt`** — The fallback belongs in the staging layer, not in crypto primitives. CryptoManager continues to be a pure encrypt/decrypt interface.
4. **`_raw_entry_to_dto` handles both formats** — Remote blobs may contain plain: entries from old clients. Decrypt both formats.
5. **Web mirrors Python approach** — Same try-decrypt + plain:-fallback pattern in web local_cache.js and entry_dto.js.

### Not in Scope for This Change

- **Blind index encryption (I-02):** Separate issue, independent implementation.
- **Remote staging blob obfuscation changes:** ADR-015b (fixed-size padding) is already implemented. The blob is already obfuscated before transport. This change only affects at-rest encryption on local disk / IndexedDB.
- **Staging hash index encryption:** The staging hash index (`staging_hash_index.json`) is a separate artifact not covered by this change.
- **`NoAuthCryptoManager` removal:** It remains the fallback for pre-auth staging operations. Only `CryptoManager`-backed writes produce real encryption.
