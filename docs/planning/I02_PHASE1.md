# I-02: Blind Index & Staging Field Key Encryption — Test Exploration (Phase 1)
> **Plan:** `docs/planning/BACKLOG.md` §Phase 3 — I-02
> **Purpose:** Blueprint of all needed test assertions before writing any test code.
> **Status:** ✅ Phase 1 (test exploration) → ✅ Phase 2 (RED: test definition)
> **Next Phase:** Phase 3 (GREEN: implementation)

## Architecture Overview

I-02 has two distinct privacy leaks that both expose plaintext metadata next to encrypted data:

### Sub-task A: Blind Index Encryption (index.json / `ledger:index`)
`index.json` stores `{date: {activity_title: total_duration_ms}}` in plaintext JSON. This reveals what activities the user does, for how long, and on which dates — next to the fully encrypted ledger. The index is used by `ph rep` (CLI) and `ph phpoc-web` query APIs.

**Flow:** `LedgerEngine.commit()` → `IndexManager.update()` → `IndexManager._flush()` → `store.write_index()` (plain JSON to disk)  |  `phpoc_cli/interface.py show_rep()` → `IndexManager.get_all()` → reads plaintext
**JS mirror:** `LedgerEngine.commit()` → `IndexManager.update()` → `IndexManager._flush()` → `store.set('ledger:index', ...)` (plain JSON to IndexedDB)

### Sub-task B: Staging Field Key Encryption (staging.json / IndexedDB entries)
After I-03, staging field VALUES are encrypted (AES-CTR), but the JSON KEY NAMES (`startTime_enc`, `endTime_enc`, `pauses_enc`, `metadata_enc`, `device_uuid_enc`, `end_device_uuid_enc`) remain plaintext. This leaks the data schema: an attacker with disk access can see which fields exist and infer the structure.

**Approach:** Deterministic key-name mapping using HMAC-SHA256 of a derived key + field name. The same field name always maps to the same token, enabling lookups without iterating all possible keys.

**Flow:** `LocalStagingCache.write_entries()` → `_encrypt_field()` encrypts values but keys stay plain → `store.write_entries()` | `LocalStagingCache.read_entries()` → looks up by plaintext key name → `_from_plain()` decrypts values
**JS mirror:** `LocalCache._dtoToRaw()` / `append()` / `update()` → `_encrypt()` encrypts values but keys stay plain | `_rawToDto()` → looks up by plaintext key name → `_decrypt()` decrypts values

### Key Derivation
Both sub-tasks need a key derived from the Master Key:
- Index encryption key: `HMAC-SHA256(MK, "phpoc-blind-index-v1")` — AES-128-CTR for whole-blob encrypt/decrypt
- Field key mapping key: `HMAC-SHA256(MK, "phpoc-staging-keys-v1")` — used to produce deterministic tokens via `HMAC-SHA256(derived, field_name)[:16]`

### Cross-client compatibility
Both Python (CLI) and JS (web) must produce identical derived keys and index blobs from the same MK, so `ledger:index` pushed/pulled via sync is readable by both clients.

---

## Test Groups

### Group A: Index blob encryption — IndexManager (Python) — ~12 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | `write_index()` stores encrypted ciphertext, not the plaintext dict | Verify on-disk format is opaque | Core security property: an attacker reading index.json sees only ciphertext |
| A2 | `read_index()` decrypts and returns the original dict | Verify roundtrip | Index must be usable by higher layers |
| A3 | `IndexManager._flush()` writes encrypted data through store | Verify IndexManager integration | _flush() is the single write path; must produce encrypted output |
| A4 | `IndexManager._load()` reads and decrypts from store | Verify IndexManager integration | _load() is the single read path; must decrypt |
| A5 | `IndexManager.update()` → `query()` returns correct result after roundtrip through encrypted store | Verify update+query cycle | The most common path: commit updates index, rep reads it |
| A6 | `IndexManager.clear()` writes encrypted empty dict | Verify clear still produces opaque output | Empty index should not reveal it's empty |
| A7 | `IndexManager.reload()` re-reads from encrypted store correctly | Verify reload roundtrip | Used when external writes happen; must still decrypt |
| A8 | Index on a fresh store (no existing file) creates encrypted output on first write | Verify first-use path | New ledger should start encrypted, not plaintext then upgrade |
| A9 | Legacy plaintext index is readable (backward compat) | Don't break existing ledgers | Users upgrading to new code with existing index.json must still work |
| A10 | Legacy plaintext index is upgraded to encrypted on next write | Auto-migration | Index should be encrypted after first mutation post-upgrade |
| A11 | Corrupt ciphertext → `read_index()` returns empty dict (doesn't crash) | Graceful degradation | Index is rebuildable; corruption should not crash the app |
| A12 | Index encryption uses key derived from MK, not raw MK | Key separation | Prevents MK exposure through index encryption vectors |

### Group B: Index integration — LedgerEngine / CLI (Python) — ~8 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | `LedgerEngine.commit()` produces encrypted index | Verify commit pipeline | The primary write path for index must encrypt |
| B2 | `LedgerEngine.query_index(from, to)` returns correct results after encrypted commit | Verify query pipeline | `ph rep` must work correctly |
| B3 | `LedgerEngine.revert()` updates encrypted index (subtracts durations) | Verify revert pipeline | Index must stay consistent with ledger after revert |
| B4 | `LedgerEngine.rebuild_index()` produces encrypted index from scratch | Verify rebuild | Index can be fully reconstructed; must be encrypted when done |
| B5 | `show_rep()` in CLI displays correct data from encrypted index | Verify end-to-end user-facing path | The `ph rep` command is the primary consumer of the index |
| B6 | `show_rep()` with `--from`/`--to` date filters works from encrypted index | Verify date-filtered query | Date filtering is a core rep feature |
| B7 | `show_rep()` with `--days` limit works from encrypted index | Verify days-limited query | Another common rep usage |
| B8 | Remote sync: encrypted index pushed and pulled correctly (ledger sync) | Verify cross-client index sync | Index is synced alongside ledger blocks; must be readable by both sides |

### Group C: Index blob encryption — IndexManager (JS) — ~10 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | `IndexManager._flush()` stores encrypted ciphertext in IndexedDB | Verify web-side storage is opaque | IndexedDB is world-readable in browser; index data must be encrypted |
| C2 | `IndexManager.reload()` decrypts and loads from encrypted store | Verify web-side roundtrip | Core read path |
| C3 | `IndexManager.update()` → `query()` returns correct result after _flush+reload roundtrip | Verify update+query cycle | Mirrors A5 for JS |
| C4 | `IndexManager.clear()` writes encrypted empty dict | Verify empty state opaque | Mirrors A6 |
| C5 | `IndexManager.getAll()` returns correct data from encrypted cache | Verify getAll | Used by UI components that display rep data |
| C6 | Legacy plaintext index readable (backward compat, JS) | Don't break existing web clients | Mirrors A9 |
| C7 | Legacy plaintext index upgraded to encrypted on next write (JS) | Auto-migration | Mirrors A10 |
| C8 | Corrupt ciphertext → `reload()` returns empty cache (no crash, JS) | Graceful degradation | Mirrors A11 |
| C9 | Index encryption uses derived key, not raw MK (JS) | Key separation | Mirrors A12 |
| C10 | `_flush()` without prior key derivation (no MK available) → stores plaintext as fallback | NoAuthCryptoManager path | Web may operate without MK before auth; index should still work |

### Group D: Index integration — LedgerEngine / sync (JS) — ~6 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | `LedgerEngine.commit()` produces encrypted index via IndexManager | Verify commit pipeline (JS) | Mirrors B1 |
| D2 | `LedgerEngine.queryIndex(from, to)` returns correct after encrypted commit | Verify query pipeline (JS) | Mirrors B2 |
| D3 | `LedgerEngine.revert()` updates encrypted index (JS) | Verify revert pipeline (JS) | Mirrors B3 |
| D4 | `LedgerEngine.rebuildIndex()` produces encrypted index (JS) | Verify rebuild (JS) | Mirrors B4 |
| D5 | Sync push: encrypted index uploaded to remote | Verify sync push path | Index sync is Tier 1/Tier 2 fast path; must push encrypted |
| D6 | Sync pull: encrypted index downloaded and decrypted | Verify sync pull path | Pulled index must be readable |

### Group E: Staging field key encryption — LocalStagingCache (Python) — ~11 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | `write_entries()` stores entries with encrypted key names (no plaintext `_enc` keys visible) | Verify on-disk format hides field structure | Core security: attacker cannot identify fields |
| E2 | `read_entries()` decrypts key names and returns correct DTO with all fields | Verify roundtrip integrity | All DTO fields must have correct values after decrypt |
| E3 | `append()` writes new entry with encrypted key names | Verify create path | New entries must use encrypted keys |
| E4 | `update()` reads and writes with encrypted key names | Verify update path | Field modifications must work through encrypted keys |
| E5 | `add_pause()` / `close_pause()` work with encrypted key names | Verify pause management | Pause state must be readable/writable through encrypted storage |
| E6 | Staging hash index rebuild (`_safeRefreshHashIndex`) unaffected by key name encryption | Verify hash index still works | Hash index is built from DTOs (plaintext), not raw storage; must not break |
| E7 | Entry hash computation identical regardless of storage key encoding (same DTO → same hash) | Verify hash stability | Hashes are computed from plaintext DTO fields; must not change |
| E8 | Legacy entries with plaintext key names are readable (backward compat) | Don't break existing staging data | Users with existing staging.json must still read their entries |
| E9 | Legacy entries upgraded to encrypted key names on write | Auto-migration | After any mutation, staging should be fully encrypted |
| E10 | Encrypted key names use derived key, not raw MK | Key separation | Mirrors key derivation pattern |
| E11 | Deterministic: same field name always maps to same encrypted token | Lookup correctness | Read path must find the right field by computing its token |

### Group F: Staging field key encryption — StagingService remote sync (Python) — ~4 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| F1 | `_raw_entry_to_dto()` decrypts remote blob entries that use encrypted key names | Cross-client staging read | Remote blobs may have encrypted key names (from web client); must decode |
| F2 | `_raw_entry_to_dto()` handles legacy `plain:` entries with plaintext key names | Blob backward compat | Remote may still have old-format entries |
| F3 | Merge engine unaffected — operates on DTOs, not raw storage format | Merge correctness | Merge must work regardless of how raw entries are stored |
| F4 | Push/pull roundtrip preserves encrypted key names | Cross-client format stability | Encrypted keys must survive serialization + obfuscation + transport |

### Group G: Staging field key encryption — LocalCache (JS) — ~10 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| G1 | `writeEntries()` / `_dtoToRaw()` stores encrypted key names in IndexedDB | Verify web storage is opaque | Mirrors E1 for JS |
| G2 | `readEntries()` / `_rawToDto()` decrypts key names and returns correct DTO | Verify roundtrip (JS) | Mirrors E2 |
| G3 | `append()` writes with encrypted key names (JS) | Verify create path (JS) | Mirrors E3 |
| G4 | `update()` reads/writes with encrypted key names (JS) | Verify update path (JS) | Mirrors E4 |
| G5 | `addPause()` / `closePause()` with encrypted key names (JS) | Verify pause management (JS) | Mirrors E5 |
| G6 | Legacy plaintext key names readable (backward compat, JS) | Don't break existing web data | Mirrors E8 |
| G7 | Legacy entries upgraded to encrypted on write (JS) | Auto-migration | Mirrors E9 |
| G8 | Entry hash computation stable regardless of storage key encoding (JS) | Verify hash stability (JS) | Mirrors E7 |
| G9 | Deterministic field-name → token mapping (JS) | Lookup correctness (JS) | Mirrors E11 |
| G10 | No MK available → fallback to plaintext key names (NoAuth path, JS) | Auth-free staging access | Web must allow reading staging before auth |

### Group H: Key derivation (Python + JS) — ~7 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| H1 | Index encryption key derived as `HMAC-SHA256(MK, "phpoc-blind-index-v1")` | Deterministic derivation | Same MK must always produce same index key |
| H2 | Staging field key mapping key derived as `HMAC-SHA256(MK, "phpoc-staging-keys-v1")` | Deterministic derivation | Separate key for staging field encryption |
| H3 | Same MK produces identical derived keys in Python and JS | Cross-client determinism | CLI and web must produce identical encrypted blobs |
| H4 | Different MKs produce different derived keys | Key isolation | Different ledgers must have different encryption keys |
| H5 | Index encrypted by Python is readable by JS, and vice versa | Cross-client index compat | Sync must work bidirectionally |
| H6 | Staging entries encrypted with field-key tokens by Python are readable by JS, and vice versa | Cross-client staging compat | Staging blobs pushed by one client must be read by the other |
| H7 | Derived keys cannot be reversed to recover MK | Forward security | Even if derived key is compromised, MK must remain protected |

### Group I: Edge cases & migration — ~6 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| I1 | Corrupt encrypted staging entry → skipped (not crash) in both Python and JS | Graceful degradation | Corrupted data should not crash the app |
| I2 | Partial migration scenario: some entries encrypted keys, some plaintext → all readable | Mixed-format resilience | During migration window, both formats coexist |
| I3 | Empty staging → read/write with encrypted keys works | Edge case: empty state | First-use path with no existing staging data |
| I4 | Large index (100+ activities across 365 days) encrypts and decrypts correctly | Performance edge case | Index encryption must scale |
| I5 | Index rebuild after migration correctly produces fully encrypted index | Migration completeness | After migration, index must be encrypted |
| I6 | Concurrent read during write does not produce torn encrypted blob | Atomic write safety | Index file must be atomically written (write-to-temp → rename) |

---

## Summary

| Group | Area | Assertions | Scope |
|-------|------|-----------|-------|
| A | Index encryption — IndexManager (PY) | 12 | Core index read/write with encryption |
| B | Index integration — Engine/CLI (PY) | 8 | Commit, revert, rebuild, rep display |
| C | Index encryption — IndexManager (JS) | 10 | Core index read/write with encryption |
| D | Index integration — Engine/Sync (JS) | 6 | Commit, revert, rebuild, sync |
| E | Staging field keys — LocalStagingCache (PY) | 11 | Field key encryption read/write/update |
| F | Staging field keys — StagingService (PY) | 4 | Remote blob + merge cross-client |
| G | Staging field keys — LocalCache (JS) | 10 | Field key encryption read/write/update |
| H | Key derivation (PY + JS) | 7 | Deterministic, cross-client, secure |
| I | Edge cases & migration | 6 | Corruption, mixed-format, scale |
| **Total** | **9 groups** | **74** | |

### Key coverage areas
- **Python CLI:** 35 assertions (Groups A, B, E, F, and shared H, I)
- **JavaScript web:** 26 assertions (Groups C, D, G, and shared H, I)
- **Cross-client:** 7 assertions (Group H — determinism)
- **Backward compat:** 8 assertions across groups A, C, E, G, I
- **Edge cases:** 6 assertions (Group I)

### Files expected to change (implementation)
- `domain/ledger/index_manager.py` — encrypt/decrypt in `_load()` / `_flush()`
- `storage/file_store.py` — `read_index()` / `write_index()` encryption
- `storage/index_store.py` — possibly interface update
- `domain/staging/local_cache.py` — key name encryption in `write_entries()` / `read_entries()` / `append()` / `update()`
- `domain/staging/service.py` — `_raw_entry_to_dto()` key name decryption
- `security/crypto.py` — `derive_index_key()` / `derive_field_key()` + deterministic field token
- `phpoc-web/src/ledger/index_manager.js` — `_flush()` / `reload()` encryption
- `phpoc-web/src/sync/local_cache.js` — `_dtoToRaw()` / `_rawToDto()` key name encryption
- `phpoc-web/src/crypto/index.js` — matching key derivation
- `phpoc_cli/interface.py` — may need decryption before `show_rep()` (or IndexManager handles it)
- `docs/spec/PHPSPEC.md` — document encrypted index + staging field key format
