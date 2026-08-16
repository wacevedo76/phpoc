# Flutter Commonplace Book — Test Exploration (Phase 1)

> **Plan:** `docs/planning/flutter/COMMONPLACE_BOOK_PHASE1.md` (this file)
> **ADR:** ADR-031 (Commonplace Book — separate sealed chain, shared master key)
> **Purpose:** Blueprint of all needed test assertions for the Flutter Commonplace chain
>               engine — the first implementable slice of the Commonplace Book feature.
> **Status:** ✅ **4-Phase TDD COMPLETE (2026-08-21)**
> **Next Phase:** None (chain-engine slice done). Follow-on slices in BACKLOG.
> **Constraint:** Axiom B5 — match established phpoc crypto/chain behavior exactly. Where a
>               Commonplace concern parallels the activity ledger, mirror `chain.dart` /
>               `engine.dart` semantics so future cross-client parity (Web/CLI) is cheap.

## Scope of This Slice

This blueprint targets the **Commonplace chain engine** only — no UI, no remote sync, no key
rotation wiring, no blind index. Those are follow-on slices tracked in `BACKLOG.md`.

Deliverables in this slice (Flutter, `phpoc-flutter/`):

```
lib/data/commonplace/
├── commonplace_chain.dart    — genesis + day-block building, sealing, append/truncate, verify
├── commonplace_engine.dart   — commit, verify, read — unified public API (mirrors ledger engine)
└── commonplace_storage.dart  — separate-file persistence: write/read `commonplace.json`
```

Supporting pieces reused from the existing ledger layer (not new):
- `lib/data/ledger/helpers.dart` — `getBlockHash`, `computeEntryHash`, content-hash helpers
- crypto sealing/seal/MAC/sha256 via the existing `CryptoService` (no new crypto code)

Test file: `phpoc-flutter/test/data/commonplace/commonplace_chain_test.dart` (+ engine/storage
tests as grouped below).

## Architecture Overview

The Commonplace Book is a **separate sealed chain** (ADR-031): a distinct `commonplace.json`
holding its own `Genesis → commonplace day blocks` sequence. It shares the **same Master Key**
as the activity ledger (same seed), so all encryption/sealing primitives are shared — but it is
a structurally independent file with its own genesis, entry schema, and append-only history.

```
lib/data/commonplace/commonplace_storage.dart  -- reads/writes commonplace.json
lib/data/commonplace/commonplace_chain.dart    -- build/seal/append/truncate/verify
lib/data/commonplace/commonplace_engine.dart   -- commit (staging->sealed), verify, read
```

**Entry schema (no `comment`):**
```json
{
  "type": "commonplace",
  "title":            "...",       // encrypted at rest
  "tags":             ["..."],     // encrypted at rest
  "entry":            "...",       // the single text passage (encrypted at rest)
  "ad_hoc":           {"k": "v"},  // optional extra key/value pairs (encrypted), may be absent
  "timestamp_ms":      0,          // when the entry was taken in
  "date":             "2026-08-21"
}
```

**Chain/block contract (parallels activity ledger):**
- Structural link: `prev_hash` links every block to its predecessor.
- Each day block is sealed (HMAC-SHA256) over `{type, day_index, date, prev_hash, entries, original_hash}`.
- Each entry carries a **content hash** over its resolved plaintext fields (survives re-encryption).
- Genesis uses `block_hash`; seal of genesis is the category root of this chain.
- Append-only: after commit, a Commonplace entry is never edited in place (D5). Refinements are
  new entries.

**Key contracts:**
- `commonplace.json` export shape is stable and self-contained (chain + genesis only — no staging rows, D11).
- Staging is kept out of the sealed chain. Only committed Commonplace entries are sealed in day blocks.
- Same-seed MK reuse means a same-passphrase unlock reveals both books; rotation re-encrypts both (ADR-026).

## Test Groups

### Group A: CommonplaceGenesis — Build & Sealing — ~11 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| CP-A1 | `buildGenesis` creates block type=commonplace_genesis, day_index=0, entries=[] | Correct root shape | The Commonplace chain has exactly one genesis |
| CP-A2 | `buildGenesis` includes shared identity fields (username, email, recovery_seed_enc, identity_pub_key) | User identity embedded | Reuses the same identity/seed recovery as the activity ledger |
| CP-A3 | `buildGenesis` uses `block_hash` (not `day_hash`) | I-17-style genesis hashing | Mirrors activity genesis hash key |
| CP-A4 | `buildGenesis` computes identity seal over the block hash | Chain-root commitment | Distinct root seal anchors the Commonplace chain |
| CP-A5 | `buildGenesis` prev_hash is 64 zeros | No predecessor | Sentinel for the separate chain's first block |
| CP-A6 | `buildGenesis` throws if Commonplace chain already has blocks | No double genesis | Exactly one Commonplace genesis |
| CP-A7 | `buildGenesis` seals a distinct genesis from the activity ledger genesis | Same-seed, separate chain (D7) | Both chains exist independently under one MK |
| CP-A8 | Commonplace genesis hashes/keys derive from the same MK the activity ledger uses | Shared crypto root (ADR-031 §2) | One seed → one MK → both books |
| CP-A9 | A Commonplace genesis and an activity genesis do not share block hashes | No accidental dataset mixing (D7) | Distinct chains produce distinct roots |
| CP-A10 | Genesis records the seed's key_version | Rotation-ready (ADR-026) | Participates in the shared rotation workflow |
| CP-A11 | `verify` on a fresh genesis passes | Integrity baseline | A valid single-block chain is verifiable |

### Group B: CommonplaceDayBlock — Build & Sealing — ~12 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| CP-B1 | `buildDayBlock` creates type=commonplace day block with correct day_index | Day grouping | Mirrors activity day-block structure |
| CP-B2 | `buildDayBlock` accepts a fully-formed Commonplace entry dict | Schema validation | `{title, tags, entry[, ad_hoc], timestamp_ms, date}` |
| CP-B3 | `buildDayBlock` recomputes each entry's content hash from actual data | Integrity first | Prevents hash/data mismatch |
| CP-B4 | `buildDayBlock` computes day_hash via seal over `{type, day_index, date, prev_hash, entries, original_hash}` | Block seal integrity | Matches the per-type whitelist (ADR-029a) |
| CP-B5 | `buildDayBlock` adds identity_seal when identity secret is set | Optional signing parity | Same-as-ledger optional signing |
| CP-B6 | `buildDayBlock` omits identity_seal when identity secret is null | No-identity mode | Merge/tests may skip signing |
| CP-B7 | `buildDayBlock` day_index starts at 1 when no prior day blocks exist | First day block | After genesis (index 0), first Commonplace day is index 1 |
| CP-B8 | Entries without an `ad_hoc` field seal with an absent/empty ad-hoc map | Optional k/v | `ad_hoc` is optional, not required |
| CP-B9 | Entries with an `ad_hoc` map seal and preserve all k/v pairs | Custom metadata preserved | Extra key/value pairs survive round-trip |
| CP-B10 | `title` and `entry` are encrypted at rest in the sealed block | Zero-knowledge (D2) | All content encrypted; no plaintext in the chain |
| CP-B11 | `tags` list is encrypted at rest in the sealed block | Zero-knowledge (D2) | Tags are content, so they are encrypted |
| CP-B12 | Multiple entries on the same date merge into one day block | Day-grouped commits | Matches activity day-block grouping |

### Group C: CommonplaceChain — Append & Truncate — ~8 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| CP-C1 | `append` adds a single Commonplace block and links prev_hash | Basic append | Chain grows by one, linkage intact |
| CP-C2 | `append` verifies prev_hash linkage to the last block | Chain integrity on append | Prevents broken insertion |
| CP-C3 | `append` throws on prev_hash mismatch | Fail loudly on tamper | Never silently corrupt |
| CP-C4 | `appendBlocks` adds multiple blocks with internal + bridge linkage | Batch atomic append | Multi-block commit in one move |
| CP-C5 | `truncate(removeCount)` removes N blocks from the end, preserving remaining linkage | Undo recent commit | Same semantics as activity revert |
| CP-C6 | `append` rejects a block of an unknown/foreign type | Per-type whitelist (ADR-029a) | The activity logger's block types must not leak into the Commonplace chain |
| CP-C7 | Chain with exactly genesis + each day block verifies end-to-end | Full-chain verification | The whole Commonplace chain is verifiable |
| CP-C8 | Tampering with one entry's ciphertext breaks verification | Tamper detection (D4) | Any modification is detected downstream |

### Group D: CommonplaceEngine — Commit, Verify, Read — ~10 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| CP-D1 | `commit` seals a staged Commonplace entry into a day block | Staging → commit (D11) | The staging→ledger move applies to Commonplace |
| CP-D2 | `commit` groups entries by date, inserting a new day block per new date | Date grouping | Entries merge into day-grouped blocks (user requirement) |
| CP-D3 | `commit` updates the chain's last-hash pointer after each append | Chain cursor integrity | The engine tracks the current tip |
| CP-D4 | `verify` returns true for a valid committed chain | Verification gate | Must pass after every commit (D10) |
| CP-D5 | `verify` returns false after a middle block is swapped | Tamper detection | Swapping a sealed block is fatal downstream |
| CP-D6 | `readEntries` returns committed Commonplace entries in order | Public read API | Users and UI read the sealed record |
| CP-D7 | Committing to the Commonplace chain does not touch the activity ledger | D7 compartmentalization | Separate files, no cross-contamination |
| CP-D8 | `commit` never injects staging `plain:`/unsealed rows into a sealed block | D11 | No staging data reaches sealed blocks |
| CP-D9 | A Commonplace entry without a `comment` field seals normally | Schema: no comment | The `entry` field replaces `comment` entirely |
| CP-D10 | The engine can verify a chain committed with earlier then later entries | Chronological correctness | Entry timestamps respect chain order |

### Group E: CommonplaceStorage — Separate-File Persistence — ~9 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| CP-E1 | `load()` reads a `commonplace.json` that exports as a chain structure | Separate file | No integration with `ledger.json` |
| CP-E2 | `save()` writes a standalone, importable `commonplace.json` | Export output | User-specified export filename is `commonplace.json` |
| CP-E3 | A saved-then-loaded Commonplace chain verifies identically | Round-trip integrity | Persistence preserves the chain |
| CP-E4 | `commonplace.json` contains no staging rows | D11 separation | Staging never leaks into the exported chain |
| CP-E5 | Loading a missing `commonplace.json` returns a fresh (genesis-only) chain | First-run default | The book starts empty but structured |
| CP-E6 | Loading a corrupt `commonplace.json` surfaces an error, not a crash | Fail-safe load | Corrupt files are detected, not silently read |
| CP-E7 | `commonplace.json` content is encrypted at rest (no plaintext title/entry/tags) | D2 zero-knowledge at rest | Even the file on disk is encrypted |
| CP-E8 | The file path is decoupled from the shared master key derivation | Least-resistance path (ADR-031 §10) | The storage location is independent of crypto identity |
| CP-E9 | Same-passphrase re-auth re-derives the MK that decrypts an existing `commonplace.json` | Shared MK + passphrase change | The passphrase system unlocks both books |

### Group F: Commonplace ad-hoc Key/Value — ~5 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| CP-F1 | `ad_hoc` field accepts multiple arbitrary key/value pairs | Extensible metadata | Custom data beyond title/tags/entry |
| CP-F2 | `ad_hoc` values are encrypted at rest | Zero-knowledge (D2) | All content, including custom k/v, is encrypted |
| CP-F3 | `ad_hoc` pairs survive commit → read round-trip | Persistence | Custom metadata is not lost |
| CP-F4 | Missing `ad_hoc` does not invalidate an entry | Backward-compatible default | Ad-hoc is optional |
| CP-F5 | An entry with `ad_hoc` still produces a stable content hash across re-encryption | Rotation-safe (ADR-026) | Content hash survives re-encryption |

## Test Inventory Summary

| Group | Focus | Tests |
|-------|-------|-------|
| A | Commonplace genesis build + sealing | 11 |
| B | Commonplace day-block build + sealing | 12 |
| C | Commonplace chain append/truncate/verify | 8 |
| D | Commonplace engine commit/verify/read | 10 |
| E | Commonplace separate-file storage | 9 |
| F | Commonplace ad-hoc key/value | 5 |
| **Total** | | **55** |

All tests target pure Dart engine logic (no UI, no HTTP). The chain engine is the first slice;
UI, remote sync (separate Worker R2 path), tag-search blind index, and shared key-rotation
wiring are follow-on slices in `BACKLOG.md`.

## Next Steps

- **Phase 2 (RED):** write the 55 assertions above in
  `phpoc-flutter/test/data/commonplace/` and watch them fail (new engine, no implementation).
- **Phase 3 (GREEN):** implement `commonplace_chain.dart`, `commonplace_engine.dart`,
  `commonplace_storage.dart` to satisfy them.
- **Phase 4 (REFACTOR):** ✅ **DONE (2026-08-21).** Extracted the shared `SealableChain` mixin
  (`lib/data/ledger/sealable_chain.dart`) consolidating HMAC seal compute/verify, identity MAC,
  `prev_hash` linkage, day-block count, and `sealBlock`/`verifyBlockSeal` (ADR-029/029a). Both
  `LedgerChain` and `CommonplaceChain` now `with SealableChain` → removed ~105 dup lines from
  `chain.dart` (476→371) and ~65 from `commonplace_chain.dart` (521→456); merged the duplicated
  `if (type == 'commonplace')` verify gate; removed the dead engine marker section. **349/349 tests
  GREEN** (55 commonplace + 294 ledger data/backup-fidelity/integration), analyzer clean; the 29
  pre-existing data/service failures are unchanged (verified at baseline).
- After Phase 1-4: add BACKLOG entries for the follow-on slices (UI wiring, sync, rotation, blind index).
