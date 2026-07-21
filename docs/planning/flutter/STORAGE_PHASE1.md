# Flutter Storage Layer — Test Exploration (Phase 1)

> **Plan:** `docs/planning/flutter/INITIAL_PLAN.md` §Phase 3
> **ADR:** ADR-028 — Drift (SQLite) + SharedPreferences + flutter_secure_storage
> **Purpose:** Blueprint of all needed test assertions before writing any test code.
> **Status:** ✅ Phase 1 complete, ✅ Phase 2 complete, ✅ Phase 3 complete
> **Next Phase:** Phase 4 (REFACTOR)

## Architecture Overview

The storage layer is the persistence foundation of the Flutter mobile app. It has three tiers:

```
┌─────────────────────────────────────────────────────────────┐
│ Drift / SQLite (structured data)                            │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐             │
│  │ entries  │  │ blocks   │  │ index_entries │             │
│  │ (CRUD)   │  │ (append) │  │ (blind index) │             │
│  └──────────┘  └──────────┘  └───────────────┘             │
├─────────────────────────────────────────────────────────────┤
│ SharedPreferences (config: Worker URL, device UUID, cookie) │
├─────────────────────────────────────────────────────────────┤
│ flutter_secure_storage (secrets: Worker API key)            │
└─────────────────────────────────────────────────────────────┘
```

### Dependencies

- **Drift:** `drift: ^2.21.0`, `sqlite3_flutter_libs: ^0.5.0`, `drift_dev: ^2.21.0` (dev)
- **SharedPreferences:** `shared_preferences: ^2.3.0`
- **flutter_secure_storage:** (to be added — not yet in pubspec)
- **path_provider:** `path_provider: ^2.1.0` (for DB file location)
- **path:** `path: ^1.9.0` (for path joining)

### Key Design Decisions (from ADR-028)

- Tags and pauses stored as JSON text columns (not join tables) — they're small, read/written atomically with the entry
- Configuration values use SharedPreferences (not a `settings` table) — single-key reads, no relationships
- API key uses flutter_secure_storage — OS-level encryption (EncryptedSharedPreferences / Keychain)
- Master Key never touches disk — Phase 5 (Services) concern, not Storage
- Migrations are additive-only (never drop columns, per A4/A8)

### Consumer Contracts

- **Phase 4 (Sync Core):** `LocalCache` will use `EntryDao` and `BlockDao` for staging CRUD
- **Phase 5 (Services):** `AuthService` will use preferences for cookie/device UUID
- **Phase 7 (Ledger Engine):** `IndexManager` will use `IndexEntryDao` for blind index queries

---

## Test Groups

### Group A: Database Schema & Bootstrap — ~12 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | `AppDatabase` extends `$AppDatabase` (Drift-generated) | Verify correct Drift setup | Drift requires `@DriftDatabase` annotation + generated superclass |
| A2 | Database opens without error with in-memory or temp-file backend | Basic connectivity | First thing to fail if Drift/sqlite3 setup is broken |
| A3 | `entries` table has all required columns with correct types | Schema completeness | Column mismatch = silent data loss or migration failures |
| A4 | `blocks` table has all required columns with correct types | Schema completeness | Same reasoning |
| A5 | `index_entries` table has all required columns with correct types | Schema completeness | Same reasoning |
| A6 | `entries.created_at` and `entries.updated_at` auto-populate on insert | Audit trail | Consumers (sync, history) depend on timestamps |
| A7 | `entries.is_active` defaults to `true` | Correct defaults | `capture()` in SyncService expects this default |
| A8 | `entries.committed` defaults to `false` | Correct defaults | New entries are staging, not committed |
| A9 | `blocks.key_version` defaults to `1` | Correct defaults | Genesis and early blocks use key version 1 |
| A10 | Indexes exist on `entries(is_active)`, `entries(committed)`, `entries(start_epoch)` | Query performance | Dashboard and history queries use these indexes |
| A11 | Indexes exist on `blocks(block_type)`, `blocks(block_index)` | Query performance | Chain verification and block queries use these |
| A12 | Indexes exist on `index_entries(date)`, `index_entries(tag)` | Query performance | History filtering by date/tag uses these |

---

### Group B: EntryDao — CRUD — ~18 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | `insertEntry()` persists an entry and returns it | Basic create | Foundation for all staging operations |
| B2 | Inserted entry preserves all field values (title, startEpoch, tags, pauses, etc.) | Data integrity | Roundtrip: insert → read must match |
| B3 | `insertEntry()` auto-generates `created_at` and `updated_at` | Timestamp audit | Sync and history depend on correct timestamps |
| B4 | `getEntry(id)` returns the correct entry by primary key | Point lookup | Used by `end()`, `pause()`, `modify()` |
| B5 | `getEntry(id)` returns `null` for non-existent entry | Safe lookup | Callers must handle missing entries gracefully |
| B6 | `getAllEntries()` returns all entries ordered by `start_epoch DESC` | Bulk read | Used by history screen and sync blob serialization |
| B7 | `getActiveEntries()` returns only entries where `is_active = true` | Active task query | Dashboard's "active task card" depends on this |
| B8 | `getActiveEntries()` returns empty list when no active entries | Empty state | Dashboard renders "no active task" correctly |
| B9 | `getEntriesByDateRange(from, to)` returns entries within the range | Date filter | History screen date picker |
| B10 | `getEntriesByDateRange(from, to)` excludes entries outside the range | Boundary correctness | Off-by-one in date filtering = wrong history view |
| B11 | `getEntriesByTag(tag)` returns entries containing that tag | Tag filter | Tag-based filtering in history (falls back to blind index later) |
| B12 | `getUncommittedEntries()` returns only entries where `committed = false` | Pending sync query | SyncService's `pushToRemote()` needs this |
| B13 | `updateEntry()` modifies specified fields and bumps `updated_at` | Partial update | `end()`, `pause()`, `modify()` all use partial updates |
| B14 | `updateEntry()` preserves unspecified fields | Non-destructive update | Updating `endEpoch` must not clear `tags` |
| B15 | `updateEntry()` returns `true` when entry exists, `false` when not | Update feedback | Callers need to know if update succeeded |
| B16 | `deleteEntry(id)` removes the entry and returns count | Basic delete | `remove()` in SyncService |
| B17 | `deleteEntry(id)` returns `0` for non-existent entry | Safe delete | No error on double-delete |
| B18 | `getEntryCount()` returns the total number of entries | Count query | Dashboard badges, sync status indicators |

---

### Group C: EntryDao — Edge Cases — ~8 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | Insert entry with `endEpoch = null` (active task) stores NULL | Nullable field | Active tasks have no end time |
| C2 | Insert entry with empty tags list stores `[]` as JSON | Empty collections | `jsonEncode([])` ≠ `null` — must be explicit |
| C3 | Insert entry with empty pauses list stores `[]` as JSON | Empty collections | Same reasoning |
| C4 | Insert entry with many tags (50+) stores and retrieves correctly | Large JSON column | Tags are user-controlled — must handle edge cases |
| C5 | Insert entry with complex pauses (multiple open/close cycles) stores correctly | Nested JSON integrity | Pauses are JSON arrays of objects — must roundtrip |
| C6 | Insert duplicate `entry_id` throws a constraint violation | Uniqueness | Silent duplicate = data corruption in merge engine |
| C7 | Insert entry with very long title (10K+ chars) stores and retrieves correctly | Large text field | Users may paste long titles |
| C8 | Insert entry with special characters in title (emoji, unicode, quotes) | Encoding safety | SQLite text is UTF-8 — must handle all Unicode |

---

### Group D: BlockDao — CRUD — ~12 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | `insertBlock()` persists a block and returns it | Basic create | Foundation for ledger engine |
| D2 | Inserted block preserves all field values | Data integrity | Roundtrip: insert → read must match |
| D3 | `getBlock(id)` returns the correct block by primary key | Point lookup | Chain verification: look up prev_hash target |
| D4 | `getBlock(id)` returns `null` for non-existent block | Safe lookup | Chain traversal terminates cleanly |
| D5 | `getAllBlocks()` returns all blocks ordered by `block_index ASC` | Bulk read | Chain rebuild needs all blocks in order |
| D6 | `getBlocksByType(BlockType.genesis)` returns only genesis blocks | Type filter | Onboarding: check for existing genesis |
| D7 | `getBlocksByType(BlockType.day)` returns only day blocks | Type filter | Ledger views filter by block type |
| D8 | `getLastBlock()` returns the block with highest `block_index` | Chain tip | Sync gate: compare local vs remote tip |
| D9 | `getLastBlock()` returns `null` when no blocks exist | Empty state | Fresh install, no genesis yet |
| D10 | `getBlockCount()` returns total number of blocks | Count query | Sync status, chain health indicators |
| D11 | Insert block with `null` identity_seal stores NULL | Nullable seal | Day blocks don't have identity seals |
| D12 | Insert genesis block with all-zeros `prev_hash` stores correctly | Genesis invariant | Genesis is the chain root — must store correctly |

---

### Group E: BlockDao — Edge Cases — ~6 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | Insert duplicate `block_id` throws a constraint violation | Uniqueness | Duplicate blocks = chain fork ambiguity |
| E2 | Insert duplicate `block_index` throws a constraint violation | Uniqueness | Two blocks at same index = corrupted chain |
| E3 | `getBlocksByType(BlockType.genesis)` returns at most one block | Genesis uniqueness | There can be only one genesis |
| E4 | Insert block with all four `BlockType` enum values works | Enum coverage | Year, month, day, genesis — all must work |
| E5 | Block with very large `data_enc` (1MB+) stores and retrieves | Large blob | Encrypted day blocks with many entries can be large |
| E6 | Block `created_at` auto-populates on insert | Timestamp audit | Chain timeline depends on accurate block timestamps |

---

### Group F: IndexEntryDao — CRUD — ~8 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| F1 | `insertIndexEntry()` persists an index entry | Basic create | Blind index population |
| F2 | Inserted index entry preserves all field values | Data integrity | Roundtrip: insert → read must match |
| F3 | `getIndexEntriesByDate('2026-07-17')` returns entries for that date | Date query | History: filter by day |
| F4 | `getIndexEntriesByDate('2026-07-17')` returns empty for no-match | Empty state | No entries on that date |
| F5 | `getIndexEntriesByTag('coding')` returns entries with that tag | Tag query | History: filter by tag |
| F6 | `getIndexEntriesByBlockId(blockId)` returns entries for that block | Block linkage | Chain integrity: verify all entries in a block |
| F7 | `deleteIndexEntriesByBlockId(blockId)` removes all entries for that block | Index rebuild | On revert, remove index entries for the reverted block |
| F8 | `clearAllIndexEntries()` removes all rows | Index rebuild | Full index rebuild from chain |

---

### Group G: Preferences (SharedPreferences) — ~10 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| G1 | `getWorkerUrl()` returns `null` when not set | Default state | Fresh install has no Worker configured |
| G2 | `setWorkerUrl(url)` → `getWorkerUrl()` returns the same URL | Roundtrip | Settings screen: save → read back |
| G3 | `setWorkerUrl(null)` clears the stored URL | Clear | Settings screen: disconnect Worker |
| G4 | `getDeviceUuid()` returns `null` when not set | Default state | Fresh install, before identity creation |
| G5 | `setDeviceUuid(uuid)` → `getDeviceUuid()` returns the same UUID | Roundtrip | Identity creation persists device UUID |
| G6 | `getDeviceCookie()` returns `null` when not set | Default state | No active sync session |
| G7 | `setDeviceCookie(json)` → `getDeviceCookie()` returns the same JSON | Roundtrip | Sync gate stores cookie for fast-path check |
| G8 | `clearAll()` removes all stored preferences | Reset | Logout/onboarding reset |
| G9 | `hasExistingData()` returns `true` after genesis block is stored | Boot probe | App lifecycle: route to unlock instead of onboarding |
| G10 | `hasExistingData()` returns `false` on fresh install | Boot probe | App lifecycle: route to onboarding |

---

### Group H: Secure Preferences (flutter_secure_storage) — ~6 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| H1 | `getApiKey()` returns `null` when not set | Default state | No Worker configured |
| H2 | `setApiKey(key)` → `getApiKey()` returns the same key | Roundtrip | Settings screen: save → read back |
| H3 | `setApiKey(null)` or `deleteApiKey()` clears the stored key | Clear | Settings screen: disconnect Worker |
| H4 | API key survives app restart (test by creating a new instance) | Persistence | API key must persist across cold starts |
| H5 | API key is NOT stored in SharedPreferences (separate storage) | Isolation | ADR-028: API key goes to secure storage, not SP |
| H6 | `getApiKey()` returns correct value after multiple writes (no caching bugs) | Write consistency | Repeated saves in settings must work |

---

### Group I: Migrations — ~10 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| I1 | Fresh database opens at current schema version (`schemaVersion`) | Migration baseline | First install creates current schema |
| I2 | `schemaVersion` getter returns the current version number | Version tracking | Drift's migration system depends on this |
| I3 | Migration from v1 to v2 preserves all existing entry data | Data preservation | Additive-only migrations (A4/A8) — never lose data |
| I4 | Migration from v1 to v2 preserves all existing block data | Data preservation | Same reasoning |
| I5 | Migration adds new columns with correct default values | Additive migration | New column must not break existing queries |
| I6 | Migration creates new indexes if added in schema | Index migration | Performance must not regress after migration |
| I7 | Opening database at current version twice is idempotent | Idempotency | Re-opening should not re-run migrations |
| I8 | Database opened at old version auto-upgrades on first open | Auto-upgrade | Users don't manually migrate |
| I9 | Downgrade attempt (newer schema than code supports) throws clear error | Safety | Prevent silent data corruption from accidental downgrades |
| I10 | `beforeOpen` callback configures SQLite pragmas (WAL mode, foreign keys ON) | SQLite tuning | WAL mode = better concurrent read performance; FK ON = referential integrity |

---

### Group J: Database Provider (Riverpod) — ~5 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| J1 | `databaseProvider` returns an `AppDatabase` instance | Provider wiring | Rest of the app gets DB via Riverpod |
| J2 | `databaseProvider` is a singleton (same instance on repeated reads) | Singleton | Single DB connection, not N connections |
| J3 | `entryDaoProvider` returns `EntryDao` from the database | DAO provider | Phase 4 SyncService needs EntryDao |
| J4 | `blockDaoProvider` returns `BlockDao` from the database | DAO provider | Phase 7 LedgerEngine needs BlockDao |
| J5 | Database can be closed via provider disposal | Cleanup | App shutdown: close DB connection |

---

### Group K: Integration / Cross-DAO — ~5 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| K1 | Insert entry → insert block with `block_id` → insert index entry referencing both | Multi-table write | Normal flow: commit entries to a block, build index |
| K2 | Delete block → index entries for that block are orphaned (no cascading required) | Referential integrity awareness | PH Ledger doesn't use FK cascades — must document |
| K3 | Multiple entries can reference the same tag in index_entries | Many-to-many | Tag "coding" on 5 entries → 5 index rows |
| K4 | Entry with `committed = true` and `block_index` set survives separate block insert | Cross-table consistency | Commit flow: entry + block are separate operations |
| K5 | All three DAOs can operate in a single transaction (atomic commit) | Transactional integrity | Partial failure = corrupt state — must be atomic |

---

## Summary

| Group | Area | Assertions | Priority |
|-------|------|-----------|----------|
| A | Schema & Bootstrap | 12 | 🔴 Critical — must pass first |
| B | EntryDao CRUD | 18 | 🔴 Critical — Phase 4 dependency |
| C | EntryDao Edge Cases | 8 | 🟡 High — data integrity |
| D | BlockDao CRUD | 12 | 🟡 High — Phase 7 dependency |
| E | BlockDao Edge Cases | 6 | 🟢 Medium |
| F | IndexEntryDao CRUD | 8 | 🟢 Medium — Phase 7 dependency |
| G | Preferences | 10 | 🔴 Critical — Phase 4+5 dependency |
| H | Secure Preferences | 6 | 🟡 High — Worker auth |
| I | Migrations | 10 | 🟡 High — production safety |
| J | Database Provider | 5 | 🟡 High — Riverpod wiring |
| K | Integration | 5 | 🟢 Medium — cross-DAO |
| **Total** | | **100** | |

### Key Coverage Areas

- **Schema correctness:** All three tables, indexes, defaults, constraints (Groups A, I)
- **CRUD completeness:** Every DAO supports insert, read, update, delete (Groups B, D, F)
- **Edge cases:** Nulls, empty collections, large values, Unicode, duplicates (Groups C, E)
- **Preferences:** Config values across SharedPreferences and secure storage (Groups G, H)
- **Migration safety:** Additive-only migrations preserve data (Group I)
- **Provider wiring:** Riverpod singletons and disposal (Group J)
- **Cross-table integrity:** Transactions and multi-table operations (Group K)

### Out of Scope (deferred to Phase 4+)

- Encrypted field storage (AES-CTR `enc:` prefix) — this is `LocalCache` responsibility (Phase 4)
- Content hash computation — CryptoService responsibility
- Staging hash index — `LocalCache` responsibility
- Blob serialization/deserialization — `LocalCache` responsibility
- Reactive streams (`watch()`) — Drift provides them natively; consumer tests in Phase 4
- Database file path resolution — handled by Drift + `path_provider`; test via temp directory
