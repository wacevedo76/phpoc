# B-02: Cross-Ledger Entry Migration — Test Exploration (Phase 1)

> **Plan:** BACKLOG.md §B-02 🟢: Cross-ledger entry migration
> **Purpose:** Blueprint of all needed test assertions before writing any test code.
> **Status:** 🔜 Phase 1 (test exploration)
> **Next Phase:** Phase 2 (RED: test definition)

## Problem Summary

A user with two independent ledgers (different seeds, different genesis blocks,
non-overlapping activity periods) wants to retire one and consolidate all entries
into the other. The target ledger is the one **already loaded and authenticated**
in the app. The user provides the source ledger — either by entering its recovery
seed or importing its `ledger.json` file.

Two seeds = two cryptographic domains — chains can't be spliced — but entries
can be decrypted from the source, re-encrypted under the target's MK, and
committed as new day blocks appended to the target chain.

### User Flow

```
User is already in the app (Ledger A loaded, authenticated)
         │
         │  "Import entries from another ledger"
         │
         ▼
  ┌─────────────────────────────┐
  │  Provide source:            │
  │  • Recovery seed, or        │
  │  • ledger.json file         │
  └─────────────┬───────────────┘
                │
                ▼
  ┌─────────────────────────────┐
  │  Dry-run preview:           │
  │  • N entries found          │
  │  • Date range: YYYY-MM-DD   │
  │    to YYYY-MM-DD            │
  │  • Conflicts: none / list   │
  └─────────────┬───────────────┘
                │
                ▼  [Confirm]
  ┌─────────────────────────────┐
  │  Decrypt source →           │
  │  Re-encrypt with target →   │
  │  Append to chain →          │
  │  Verify → Done              │
  └─────────────────────────────┘
```

### Constraints

- All source entries must not overlap with the target ledger's date range.
  Overlapping dates are rejected (unless `--force`).
- The source ledger file is never modified — only read.
- Content hashes survive re-encryption and serve as the deduplication bridge.
- Both ledgers must pass pre-migration chain verification.
- Target is implicitly the currently-loaded ledger; no path or additional auth needed.

### Building Blocks (Already Exist)

| Block | Where | Used For |
|-------|-------|----------|
| Versioned MK derivation (`derive_mk`) | `security/crypto.py` | Two `CryptoManager` instances from two seeds |
| Content hash (extensible, all-keys) | `domain/ledger/engine.py` | Dedup + integrity after re-encryption |
| Entry decryption (`crypto.decrypt`) | `security/crypto.py` | Decrypt source entries with source MK |
| Entry encryption (`crypto.encrypt`) | `security/crypto.py` | Re-encrypt with target MK |
| Chain verification (`LedgerChain.verify`) | `domain/ledger/chain.py` | Pre- and post-migration integrity |
| Block building (`build_day_block`) | `domain/ledger/chain.py` | Construct new day blocks for migrated entries |
| Summary policy (`YearMonthSummaryPolicy`) | `domain/ledger/summary_policy.py` | Insert summary blocks between target and new entries |
| Index rebuild (`IndexManager`) | `domain/ledger/index_manager.py` | Rebuild blind index after migration |
| Staging `activity_id` | §8.1 | Cross-client entry identity |
| Backup infrastructure | `phpoc_cli/rotate_keys.py:create_backup()` | Backup source ledger before migration |

## Architecture Overview

```
  ┌─────────────────────────────────────────────────────────┐
  │  Target Ledger (already loaded & authenticated)          │
  │  Seed A → MK_A → CryptoManager_A (in session)            │
  └─────────────────────────────────────────────────────────┘
                                ▲
                                │  append new day blocks
                                │  seal + sign with MK_A
                                │
  ┌─────────────────────────────┴───────────────────────────┐
  │              Re-encrypted Entries                        │
  │  - Same plaintext, new ciphertext                        │
  │  - Same content_hash (survives re-encryption)            │
  │  - New entry hash (ciphertext changed)                   │
  └─────────────────────────────┬───────────────────────────┘
                                │
                                │  re-encrypt with MK_A
                                │  verify content_hash matches
                                │
  ┌─────────────────────────────┴───────────────────────────┐
  │              Plaintext Entries                           │
  │  title, startTime, endTime, metadata, pauses, tags, ...  │
  └─────────────────────────────┬───────────────────────────┘
                                │
                                │  decrypt with MK_B
                                │
  ┌─────────────────────────────┴───────────────────────────┐
  │  Source Ledger (imported via seed or file)               │
  │  Seed B → MK_B → CryptoManager_B (created temporarily)   │
  └─────────────────────────────────────────────────────────┘
```

### Cross-Client API Surface

All three clients implement the same logical pipeline. The target ledger is the
already-authenticated, currently-loaded ledger — it is **not** passed as a
parameter. Only the source is provided.

```
importEntries(source, sourceSeed) → Result {
  sourceEntryCount: int,       // entries found in source
  migratedCount: int,          // entries successfully migrated
  skippedCount: int,           // duplicates or unparseable
  conflictsDetected: int,      // overlapping dates
  newBlockCount: int,          // day blocks added to target
  sourceDateRange: {first, last},
}
```

Where `source` is either:
- A file path/buffer (`ledger.json`), or
- A seed string (base64) — entries extracted and decrypted directly from that seed's chain

**Target ledger is always implicit** — it's the one the user already has open.

### Files in Scope

| File | Client | Role | Change |
|------|--------|------|--------|
| `phpoc_cli/import_ledger.py` | CLI | `ph import-ledger` command | **New** |
| `domain/ledger/import_entries.py` | CLI | `EntryImporter`: decrypt, re-encrypt, verify, rebuild | **New** |
| `domain/ledger/engine.py` | CLI | Passthrough for rebuild helpers | Minor (may reuse existing methods) |
| `phpoc-web/src/ledger/import_entries.js` | Web | `EntryImporter` JS equivalent | **New** |
| `phpoc-web/src/services/import_service.js` | Web | UI service layer for import | **New** |
| `lib/services/import_service.dart` | Flutter | `EntryImporter` Dart equivalent | **New** |
| `lib/models/import_result.dart` | Flutter | Import result model | **New** |

---

## Test Groups

### Group A: Dual CryptoManager Setup (Python, ~8 tests)
**File:** `tests/test_cross_ledger_migration.py` (new)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | Two `CryptoManager` instances from different seeds produce different encryption output for same plaintext | Key domain separation | Core property: two seeds = two independent cryptographic domains |
| A2 | `CryptoManager(derive_mk(seed_A, 1))` and `CryptoManager(derive_mk(seed_B, 1))` are independently functional | Dual instance viability | Both must encrypt/decrypt their own data without cross-contamination |
| A3 | Data encrypted with MK_A cannot be decrypted with MK_B | Cross-key rejection | Tamper detection: wrong key must fail with auth tag mismatch |
| A4 | Data encrypted with MK_A can be decrypted with MK_A (same-instance roundtrip) | Self-consistency | Basic sanity before migration |
| A5 | Two `CryptoManager`s from same seed but different key_versions are independent | Versioned key domains | Source and target may be at different key_versions |
| A6 | `derive_mk(seed, version=N)` is deterministic across repeated calls | Derivation stability | Seed + version always produces same MK |
| A7 | `CryptoManager` instances do not share mutable state | Instance isolation | Two cryptos must not interfere with each other's internal state |
| A8 | `NoAuthCryptoManager` (no MK) rejects migration with clear error | Auth gate | Migration requires both seeds; cannot operate without keys |

### Group B: Entry Extraction & Decryption from Source (Python, ~10 tests)
**File:** `tests/test_cross_ledger_migration.py`

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | All entries extracted from source ledger's day blocks (genesis + summary blocks skipped) | Full extraction | Only day blocks carry entries; genesis and summaries have none |
| B2 | Each extracted entry's `startTime_enc` decrypts to valid epoch milliseconds with source MK | Timestamp decryption | Need plaintext timestamps to determine chronological ordering |
| B3 | Each extracted entry's `endTime_enc` decrypts correctly (or null) | End time decryption | Null end times must be handled (active tasks) |
| B4 | Each extracted entry's `metadata_enc` decrypts to valid JSON | Metadata decryption | Arbitrary metadata must survive decryption |
| B5 | Each extracted entry's `pauses_enc` decrypts to valid JSON array | Pauses decryption | Pause intervals must survive decryption |
| B6 | Entries with `transitions_enc` decrypt correctly | Transitions decryption | Multi-device transition trails must survive |
| B7 | Entries with `device_id_enc` decrypt to opaque device identifier | Device ID decryption | Device attribution data survives migration |
| B8 | Entry with `device_proof` retains the proof field (unchanged — not re-encrypted) | Device proof preservation | device_proof is HMAC over entry_index, not encrypted; must survive as-is |
| B9 | Entry with optional `comment` field preserves the comment through extraction | Optional field preservation | Comments are plaintext; must survive |
| B10 | Entry extraction count matches `len([e for b in day_blocks for e in b.entries])` | Extraction completeness | Every entry must be accounted for; no silent drops |

### Group C: Entry Re-Encryption with Target MK (Python, ~10 tests)
**File:** `tests/test_cross_ledger_migration.py`

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | Re-encrypted `startTime_enc` with target MK decrypts to same plaintext epoch | Timestamp re-encryption fidelity | Plaintext must be identical after decrypt→re-encrypt cycle |
| C2 | Re-encrypted `endTime_enc` with target MK preserves null | Null end time preservation | Null must stay null (not become empty string or "null") |
| C3 | Re-encrypted `metadata_enc` decrypts to same JSON structure | Metadata re-encryption fidelity | Nested JSON objects must survive intact |
| C4 | Re-encrypted `pauses_enc` decrypts to same pause array | Pauses re-encryption fidelity | Pause intervals with comments must survive |
| C5 | Re-encrypted `transitions_enc` decrypts to same transition array | Transitions re-encryption fidelity | Multi-device action trails must survive |
| C6 | Re-encrypted `device_id_enc` decrypts to same device identifier | Device ID re-encryption fidelity | Must produce identical device ID after cycle |
| C7 | Plaintext fields (title, duration, tags, media, comment, is_active, is_paused) are unchanged | Plaintext field preservation | Fields without _enc suffix pass through untouched |
| C8 | `content_hash` is unchanged after re-encryption cycle | Content hash invariance | Core property: content_hash is computed from plaintext; re-encryption must not change it |
| C9 | Entry hash (`entry["hash"]`) changes after re-encryption | Entry hash mutation | Ciphertext changed → entry hash must change; this is expected |
| C10 | New entry hash verifies against new data dict | Entry hash integrity | Re-computed hash must match re-encrypted data |

### Group D: Content Hash Verification Bridge (Python, ~8 tests)
**File:** `tests/test_cross_ledger_migration.py`

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | `content_hash` computed from source entry's plaintext matches `content_hash` from re-encrypted entry | Cross-key content hash stability | The bridge: content_hash is the proof that plaintext didn't change |
| D2 | Entry with missing `content_hash` at format_version >= 0.4.0 is flagged as invalid | Content hash required gate | Per I-06: content_hash is mandatory at v0.4.0+ |
| D3 | Entry with missing `content_hash` at format_version < 0.4.0 is still migrated (best-effort) | Legacy ledger support | Pre-v0.4.0 ledgers may lack content_hash; migration should still work |
| D4 | Content hash mismatch after re-encryption (corrupted plaintext) is detected and entry is flagged | Corruption detection | If re-encryption produces wrong plaintext, content_hash won't match |
| D5 | Content hash verification uses extensible algorithm (all keys, not just 9-field legacy) | Current algorithm | v0.4.0+ extensible algorithm must be used for new migrations |
| D6 | Content hash verification for legacy source ledger uses legacy 9-field algorithm | Backward compat | v0.3.0 ledger content_hashes computed with legacy algorithm must still verify |
| D7 | Content hash verification works across key_versions (source v1, target v2) | Multi-version migration | Both ledgers may be at different key_versions |
| D8 | Content hash comparison deduplicates entries between source and target (same content_hash → skip) | Deduplication | If target already has the entry (via prior manual import), don't duplicate |

### Group E: Date Conflict Detection (Python, ~8 tests)
**File:** `tests/test_cross_ledger_migration.py`

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | Migration succeeds when all source entries are chronologically after target's last entry | Happy path: no overlap | The intended use case: non-overlapping ledgers |
| E2 | Migration succeeds when source entries are chronologically before target's first entry (reverse order) | Reverse append | User may want older ledger as target, newer as source (reverse case) |
| E3 | Migration rejects when any source entry overlaps with target's date range | Overlap rejection | PHPSPEC constraint: no overlapping periods between merged ledgers |
| E4 | Overlap detection reports the exact date(s) and count of conflicting entries | Actionable error | User needs to know which dates conflict to resolve manually |
| E5 | Migration of source ledger with entries on same date as target but non-overlapping times is rejected (full-day granularity) | Day-level conflict | Simpler: conflict at day level, not millisecond level |
| E6 | Empty source ledger (genesis only, no day blocks) produces 0 migrated entries | Empty source | No-op migration should succeed with count=0 |
| E7 | Empty target ledger (genesis only) accepts all source entries | Empty target | Fresh ledger with only genesis can absorb all entries |
| E8 | Migration detects conflicting dates even when source entries span multiple months/years | Multi-span conflict detection | Realistic: source may have entries across a wide date range |

### Group F: Chain Rebuild with Migrated Entries (Python, ~12 tests)
**File:** `tests/test_cross_ledger_migration.py`

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| F1 | Migrated entries are appended as new day blocks to the target chain | Chain extension | Target chain grows, preserving all original blocks |
| F2 | Original target blocks are unchanged (seals, hashes, signatures intact) | Target chain preservation | Migration is append-only; existing blocks are immutable |
| F3 | Summary blocks (year and month) are inserted between target's last block and new entries when crossing boundaries | Summary block insertion | Same policy as normal day block insertion |
| F4 | `day_index` continues correctly from target's last day block | Index continuity | day_index must increment monotonically |
| F5 | `prev_hash` chain is unbroken through the migration boundary | Hash linkage | Target's last day_hash → new first prev_hash → ... |
| F6 | Each new day block's `day_hash` seal is valid under target MK | Block seal integrity | New blocks must be sealed with target's MK |
| F7 | Each new day block carries `identity_seal` if target has identity secret | Identity signature | New blocks must be signed |
| F8 | `key_version` on new day blocks matches target genesis key_version | Key version consistency | New blocks use target's current key version |
| F9 | Entries within the same date are grouped into a single day block | Date grouping | Multiple entries on same date → one day block |
| F10 | Entries within and across day blocks are sorted alphabetically by title | Entry ordering | Consistent with merge algorithm (title-first, privacy-preserving) |
| F11 | Blind index is rebuilt to include migrated entries | Index update | `index.json` must reflect new entries for reputation queries |
| F12 | Full chain verification passes after migration | Post-migration integrity | D4: tampering must be detectable; migration must not break verification |

### Group G: CLI Command Interface (Python, ~10 tests)
**File:** `tests/test_cross_ledger_migration.py`

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| G1 | `ph import-ledger --seed <seed>` from within an authenticated ledger directory imports entries from that seed's chain | CLI entry point (seed) | Target is the current directory's ledger; source is identified by seed |
| G2 | `ph import-ledger --file <path>` imports entries from a `ledger.json` file | CLI entry point (file) | Alternative: user has the source ledger file on disk |
| G3 | `ph import-ledger --seed <seed> --file <path>` with both: file takes precedence, seed used for decryption | Seed + file combo | If user has the file but needs to decrypt it (seed from memory) |
| G4 | Command requires the target ledger to already be authenticated (no additional passphrase prompt, or re-auth for safety) | Implicit target | User is already in their ledger; target auth is a given in CLI context |
| G5 | Command verifies source chain integrity before extracting entries | Pre-flight integrity | D4: never import from a corrupted source |
| G6 | `--dry-run` flag reports what would be imported without modifying anything | Dry run | User can preview: entry count, date range, conflicts |
| G7 | `--dry-run` output includes: source entry count, date range, conflicts (if any) | Informative dry run | Enough info to decide whether to proceed |
| G8 | `--force` flag skips overlap rejection (user acknowledges risk) | Override for advanced users | User may accept overlap knowingly |
| G9 | Import creates a timestamped backup of the target ledger before modification | Backup requirement | D5: append-only with backup before mutation |
| G10 | Successful import prints summary: entries imported, new blocks created, backup path | User feedback | Clear confirmation of what happened |

### Group H: Error Handling & Edge Cases (Python, ~12 tests)
**File:** `tests/test_cross_ledger_migration.py`

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| H1 | Migration with wrong source seed (can't decrypt identity_secret_enc_fallback) fails with clear error | Wrong seed detection | Must detect invalid seed early |
| H2 | Migration with wrong target passphrase fails with clear error | Wrong passphrase detection | Must authenticate to target ledger |
| H3 | Migration with identical seeds (same ledger specified twice) is detected and rejected | Self-migration guard | Same seed means same ledger — nothing to migrate |
| H4 | Entry with unparseable ciphertext in source is skipped with warning, not fatal | Partial corruption tolerance | One bad entry shouldn't block the entire migration; skip and report |
| H5 | Source ledger with no day blocks (genesis only) completes with 0 entries migrated | Empty source | Graceful no-op |
| H6 | Target ledger with no day blocks (genesis only) accepts all source entries | Empty target | Fresh ledger absorption |
| H7 | Source ledger at format_version 0.2.0 (pre-spec) with legacy ciphertexts (no auth tag) migrates correctly | Legacy format support | D9: backward compatibility with old ledger formats |
| H8 | Source ledger at format_version 0.3.0 (legacy content_hash algorithm) migrates correctly | Legacy content hash | v0.3.0 9-field content hashes must be handled |
| H9 | Entries with `endTime_enc: null` (active tasks) migrate correctly | Active task migration | Un-ended tasks must survive re-encryption |
| H10 | Entries with empty `tags` array `[]` migrate correctly | Empty tags | Empty arrays must survive roundtrip |
| H11 | Entries with empty `media` array `[]` migrate correctly | Empty media | Same as H10 |
| H12 | Source ledger with 500+ entries migrates correctly (performance baseline) | Scale test | Realistic ledger size; migration must complete in reasonable time |

### Group I: Multi-Device Sync Awareness (Python, ~6 tests)
**File:** `tests/test_cross_ledger_migration.py`

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| I1 | After migration, remote staging blob is pushed with updated device cookie | Cross-device sync | Other devices must detect the chain change |
| I2 | Other device pulling after migration sees the new blocks and verifies them | Cross-device verification | Migrated blocks must be verifiable by other devices with same target seed |
| I3 | Migrated entries' `device_id_enc` preserves original device attribution | Device attribution preservation | Entries created on device B still show as device B after migration to ledger A |
| I4 | Migrated entries' `device_proof` remains verifiable by target ledger's device secret | Device proof portability | device_proof uses HMAC(MK_B, ...) — may need re-computation with MK_A |
| I5 | Staging entries in target ledger are NOT affected by migration | Staging isolation | Active staging entries remain untouched |
| I6 | Remote staging hash index is updated after migration if transport is configured | Remote sync consistency | Fast-path hash index must reflect new chain state |

### Group J: Web (JavaScript) — Core Import (~10 tests)
**File:** `phpoc-web/test/import_entries_test.mjs` (new)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| J1 | JS `EntryImporter.extractEntries(chain, sourceCrypto)` produces same entry count as Python | Cross-platform extraction parity | Same logic, same output |
| J2 | JS `EntryImporter.reencryptEntry(entry, targetCrypto)` produces entry decryptable with target MK | JS re-encryption | Web must produce entries that target can decrypt |
| J3 | JS `EntryImporter.reencryptEntry()` preserves content_hash (matches before/after) | JS content hash invariance | Same guarantee as Python |
| J4 | JS `EntryImporter.detectConflicts(sourceEntries, targetChain)` detects overlapping dates | JS conflict detection | Same day-level overlap detection |
| J5 | JS `EntryImporter.rebuildChain(targetChain, migratedEntries, targetCrypto)` produces valid chain | JS chain rebuild | Rebuilt chain must pass `LedgerChain.verify()` |
| J6 | JS import with `--seed` mode: seed → derive MK → extract from file (if provided) or remote | Seed-based import | User only has the seed, not the file |
| J7 | JS import handles file-uploaded source ledger (v1/v2/raw chain formats) | File import integration | Source ledger comes from file picker |
| J8 | JS `CryptoManager` dual-instance: target from session, source from provided seed | Cross-platform API parity | Target crypto already in session; source crypto created from provided seed |
| J9 | JS import with `keyVersion` > 1 on source ledger works correctly | Web multi-version support | Source may be at a different key_version |
| J10 | JS import produces byte-identical entry hash to Python for same plaintext + same MK | Cross-platform entry hash parity | Entry hash formula must be identical (sort+indent2) |

### Group K: Web (JavaScript) — UI & Service Layer (~6 tests)
**File:** `phpoc-web/test/import_entries_test.mjs`

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| K1 | `ImportService.importFromFile(file, sourceSeed)` — user is already logged in, picks file + enters seed | Web service entry point | Target is implicit (current session); source is file + seed |
| K2 | `ImportService.importFromSeed(sourceSeed)` — user enters seed, entries pulled from seed's derived chain | Seed-only import | User doesn't have the file, just the seed |
| K3 | Import UI shows dry-run preview (count, date range, conflicts) before confirm button | Dry run UX | Preview before destructive action |
| K4 | Import UI shows progress: decrypting → re-encrypting → building blocks → verifying | Progress UX | Long import needs progress indication |
| K5 | Import UI shows error state with actionable message on failure | Error UX | Wrong seed, corrupted entry, overlap conflict, etc. |
| K6 | Import UI shows success summary with entry count and new block count | Success UX | Clear confirmation |

### Group L: Flutter (Dart) — Core Import (~10 tests)
**File:** `test/import_service_test.dart` (new)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| L1 | Dart `EntryImporter.extractEntries(chain, sourceCrypto)` produces same entry count as Python | Cross-platform extraction parity | Three-client consistency |
| L2 | Dart `EntryImporter.reencryptEntry(entry, targetCrypto)` produces entry decryptable with target MK | Dart re-encryption | Flutter must produce entries that target can decrypt |
| L3 | Dart `EntryImporter.reencryptEntry()` preserves content_hash | Dart content hash invariance | Same guarantee as Python + JS |
| L4 | Dart `EntryImporter.detectConflicts()` detects overlapping dates | Dart conflict detection | Same day-level overlap logic |
| L5 | Dart `EntryImporter.rebuildChain()` produces valid, verifiable chain | Dart chain rebuild | Rebuilt chain passes Dart `LedgerChain.verify()` |
| L6 | Dart import reads source ledger from file import | Flutter import integration | Mobile may import source ledger via file picker |
| L7 | Dart `CryptoManager` from `phpoc-crypto-core` FFI supports dual-instance (target from session, source from provided seed) | Dart crypto integration | Target crypto already loaded; source crypto created from provided seed |
| L8 | Dart import with SQLite-backed target ledger (already loaded) works correctly | Flutter storage integration | Target is the active ledger in SQLite |
| L9 | Dart import handles `keyVersion` correctly on source ledger | Flutter multi-version | Must derive correct MK per source key_version |
| L10 | Dart import produces byte-identical entry hash to Python for same plaintext + same MK | Cross-platform hash parity | Three-client entry hash consistency |

### Group M: Flutter (Dart) — UI & Service Layer (~6 tests)
**File:** `test/import_service_test.dart`

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| M1 | `ImportService.importFromSeed(sourceSeed)` — user is already in the app, enters source seed → full pipeline | Flutter service entry point | Target is the active ledger; source seed is provided |
| M2 | `ImportService.importFromFile(filePath, sourceSeed)` — user picks a `ledger.json` file + enters seed | Flutter file import | Alternative: user has the source ledger file on device |
| M3 | Import screen shows dry-run preview (entry count, date range, conflicts) before confirm button | Dry run UX | Preview before destructive action |
| M4 | Import screen shows progress indicator during import | Progress UX | Decrypt+re-encrypt may be slow for large ledgers |
| M5 | Import screen shows error with actionable message on failure | Error UX | Wrong seed, corrupted entry, overlap conflict, etc. |
| M6 | Import screen shows success with entry count and navigates back to dashboard | Success UX | Clear confirmation and return |

---

## Summary

| Group | Client | Area | Tests | Key Coverage |
|-------|--------|------|-------|-------------|
| A | Python | Dual CryptoManager Setup | 8 | Target crypto from session, source crypto from provided seed; key domain separation |
| B | Python | Entry Extraction & Decryption | 10 | Full extraction from day blocks, all _enc fields, null handling, completeness |
| C | Python | Entry Re-Encryption | 10 | Re-encrypt with target MK, plaintext fidelity, content_hash invariance, entry hash update |
| D | Python | Content Hash Bridge | 8 | Cross-key stability, legacy format support, dedup, corruption detection |
| E | Python | Date Conflict Detection | 8 | Non-overlapping constraint, day-level conflict, empty edge cases |
| F | Python | Chain Rebuild | 12 | Append-only, summary blocks, hash linkage, seals, signatures, index rebuild |
| G | Python | CLI Command Interface | 10 | `ph import-ledger --seed/--file`, dry-run, --force, backup |
| H | Python | Error Handling & Edges | 12 | Wrong seed, self-import guard, corruption tolerance, legacy formats, scale |
| I | Python | Multi-Device Sync | 6 | Remote staging push, cross-device verification, device attribution, staging isolation |
| J | JS | Core Import | 10 | Extraction, re-encryption, conflict detection, chain rebuild, cross-platform parity |
| K | JS | UI & Service Layer | 6 | Seed input or file picker, dry-run preview, progress, errors, success |
| L | Dart | Core Import | 10 | Extraction, re-encryption, conflict detection, chain rebuild, FFI integration |
| M | Dart | UI & Service Layer | 6 | Seed input or file picker, dry-run preview, progress, errors, success |
| **Total** | | | **116** | |

### Critical Dependencies
- **I-01** ✅ (Versioned MK derivation) — dual `CryptoManager` with different seeds + key_versions
- **I-01a** ✅ (Rotation execution) — target ledger may be at any key_version
- **I-06** ✅ (Content hash required at v0.4.0+) — content_hash is the migration bridge
- **I-09** ✅ (Device attribution) — device_id_enc + device_proof must survive re-encryption

### Design Directives Checklist
- **D1 (Protocol Sovereignty):** Migration is local-only; no server involvement ✅
- **D2 (Zero-Knowledge):** Both seeds required; no backdoor; plaintext never leaves the device ✅
- **D4 (Chain of Trust):** Pre- and post-migration chain verification; all seals + signatures valid ✅
- **D5 (Append-Only):** Target chain is appended to, never modified; backup before mutation ✅
- **D8 (Recoverability):** Source ledger preserved; target backed up; user can undo ✅
- **D9 (Backward Compat):** Legacy format_version, legacy content_hash algorithm, legacy (no-auth-tag) ciphertext ✅
- **D10 (Testing):** 116 assertions across 13 groups covering all three clients ✅
