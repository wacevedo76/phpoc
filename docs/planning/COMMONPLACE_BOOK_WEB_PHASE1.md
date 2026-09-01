# Commonplace Book Web Port — Test Exploration (Phase 1)

> **Plan:** `docs/planning/COMMONPLACE_BOOK_WEB_ROADMAP.md` (Slice 1 — Chain / engine / storage JS port)
> **ADR:** ADR-031 (Commonplace Book — separate sealed chain, shared master key)
> **Mirror (Flutter reference):** `docs/planning/flutter/COMMONPLACE_BOOK_PHASE1.md` (55 assertions, groups A–F) — this blueprint ports those exact assertions to `phpoc-web`.
> **Purpose:** Blueprint of all needed test assertions before writing any test code.
> **Status:** ✅ Phase 4 (REFACTOR) complete — 55 tests / 130 assertions passing (2026-08-31)
> **Next Phase:** None (Slice 1 complete). Next slice: Slice 2 (Book Switcher).

## Scope of This Slice

Port the Flutter Commonplace **chain engine** (55/55 GREEN in Flutter) to `phpoc-web`:
chain → engine → storage, plus the `seal_fields.js` per-type whitelist extension. No UI (Slice 3),
no Book Switcher (Slice 2), no remote sync (Slice 5), no key-rotation wiring (Slice 6). The
application-layer `CommonplaceService` (Flutter) is out of scope here — it lands with the UI slice.

Deliverables (web, `phpoc-web/src/commonplace/`):

```
src/commonplace/commonplace_chain.js    — genesis + day-block building, sealing, append/truncate, verify
src/commonplace/commonplace_engine.js   — buildGenesis, commit, verify, readEntries (unified API)
src/commonplace/commonplace_storage.js  — separate-file persistence for `commonplace.json` (IndexedDB-backed)
src/ledger/seal_fields.js               — extend SEAL_FIELDS with `commonplace_genesis` + `commonplace`
```

Supporting pieces reused (not new):
- `src/ledger/utils.js` — `jsonSort`, `jsonSortIndent2`, `computeEntryHash`, `verifyEntryHash`, `getBlockHash`
- `src/ledger/seal_fields.js` — `selectSealFields` / `computeSeal` (the ADR-029a closed whitelist)
- `src/sync/storage.js` — `StorageBackend` / `MemoryBackend` (key-value store, mirrors `ledger:blocks`)
- `CryptoService` (WASM) — `seal`/`verifySeal`, `sha256`, `encrypt`/`decrypt`, `mac`/`verifyMac` (no new crypto)

Test file: `phpoc-web/test/commonplace_chain_test.mjs` (+ engine/storage tests grouped below).

## Architecture Overview

The Commonplace Book is a **separate sealed chain** (ADR-031): a distinct `commonplace.json`
holding its own `commonplace_genesis → commonplace day blocks` sequence. It shares the **same
Master Key** as the activity ledger (same seed → same MK), so all encryption/sealing primitives
are shared — but it is a structurally independent chain with its own genesis, entry schema, and
append-only history (D7). **Byte-format compatible with Flutter** (acceptance criterion #1):
same genesis shape, same ADR-029a `commonplace` seal, same entry schema.

```
src/commonplace/commonplace_storage.js  -- save/load/replaceAll `commonplace.json` (IndexedDB)
src/commonplace/commonplace_chain.js    -- buildGenesis/buildDayBlock/append/appendBlocks/truncate/verify
src/commonplace/commonplace_engine.js   -- buildGenesis, commit (staging->sealed), verify, readEntries
```

**Entry schema (no `comment`):**
```json
{
  "type": "commonplace",
  "title":            "...",       // encrypted at rest
  "tags":             ["..."],     // encrypted at rest
  "entry":            "...",       // the single text passage (encrypted at rest)
  "ad_hoc":           {"k": "v"},  // optional extra key/value pairs (encrypted), may be absent
  "timestamp_ms":      0,          // when the entry was taken in (plaintext, not content)
  "date":             "2026-08-21" // plaintext, not content
}
```

**Sealed entry data shape (what actually lives in a day block, after encryption):**
```json
{
  "type": "commonplace",
  "timestamp_ms": 0,
  "date": "2026-08-21",
  "title_enc": "<AES-CTR>",
  "entry_enc": "<AES-CTR>",
  "tags_enc": "<AES-CTR of jsonEncode(tags)>",
  "ad_hoc_enc": "<AES-CTR of jsonEncode(ad_hoc)>",   // only when ad_hoc present & non-empty
  "content_hash": "<sha256 over canonical plaintext-decrypted content>"
}
```

### Web-specific design decisions (documented divergences from Flutter, kept parity-safe)

1. **Store & key convention (web-idiomatic).** Web `LedgerChain` reads/writes the `StorageBackend`
   directly under key `ledger:blocks`. `CommonplaceChain` mirrors this with key
   `commonplace:blocks` — `_getBlocks()`/`_saveBlocks()` over `store.get/set`, **not** the
   Flutter block-store contract (`readBlocks`/`appendBlocks`/`truncate`). This reuses the exact
   `LedgerChain` pattern and needs no new block-store adapter. Tests use `MemoryBackend`.
2. **`commonplace_storage.js` = export/import persistence only** (Flutter's `CommonplaceStorage`
   doubles as the block store; the web `StorageBackend` already fills that role). It provides
   `save()`/`load()`/`replaceAll()` over the portable shape
   `{"type":"commonplace_chain","genesis":…,"blocks":[…]}` persisted under key `commonplace:export`.
3. **Genesis schema = Flutter flattened shape** (NOT the web ledger's nested `identity: {…}`):
   top-level `username`, `email`, `recovery_seed_enc`, `identity_pub_key`,
   `identity_secret_enc_fallback`, `format_version`, `key_version`. `buildGenesis` takes the
   already-computed `recoverySeedEnc`/`identityPubKey`/`identitySecretEncFallback` as **params**
   (mirrors Flutter — the web ledger computes them internally, but the Commonplace caller owns
   them so both books share one identity).
4. **Identity seal uses `crypto.mac`/`verifyMac`** (web `LedgerChain` convention), not Flutter's
   `sign`/`verifySignature`. Optional (only when `identitySecret` set) and **excluded from the
   ADR-029a seal whitelist**, so it does not affect core cross-client byte parity of
   `block_hash`/`day_hash`/entry/content hashes.
5. **`day_index`** = count of existing `commonplace` day blocks + 1 (mirrors Flutter
   `countDayBlocks()+1`; no summary blocks exist in the Commonplace chain).
6. **Content hash** reuses the web ledger `_computeContentHash` extensible algorithm — keep the
   `_enc` suffix, decrypt the value (plaintext stays a string, never JSON-decoded), sort lists,
   exclude `content_hash`, then `sha256(jsonSort(content))`. This already matches Flutter's
   canonical `computeContentHash` (PHPSPEC §5.5/§6.1). **Entry hash** = `computeEntryHash(data)` =
   `sha256(jsonSortIndent2(data))` — reuse `utils.js`.
7. **Seal whitelist** (extend `seal_fields.js`):
   ```js
   commonplace_genesis: ['type', 'day_index', 'date', 'prev_hash', 'entries', 'original_hash'],
   commonplace:         ['type', 'day_index', 'date', 'prev_hash', 'entries', 'original_hash'],
   ```
   `commonplace_genesis` hashes under `block_hash`; `commonplace` hashes under `day_hash`.
   Genesis `date` is absent (mirrors Flutter — the whitelist seals only present fields).

## Test Groups

### Group A: CommonplaceGenesis — Build & Sealing — 11 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| CP-A1 | `buildGenesis` creates block type=commonplace_genesis, day_index=0, entries=[] | Correct root shape | The Commonplace chain has exactly one genesis |
| CP-A2 | `buildGenesis` embeds the shared identity fields (username, email, recovery_seed_enc, identity_pub_key) | User identity embedded | Reuses the same identity/seed recovery as the activity ledger |
| CP-A3 | `buildGenesis` uses `block_hash` (not `day_hash`) | I-17-style genesis hashing | Mirrors activity genesis hash key |
| CP-A4 | `buildGenesis` computes an identity seal over the block hash when an identity secret is set | Chain-root commitment | Distinct root seal anchors the Commonplace chain |
| CP-A5 | `buildGenesis` prev_hash is 64 zeros | No predecessor | Sentinel for the separate chain's first block |
| CP-A6 | `buildGenesis` throws if the Commonplace chain already has blocks | No double genesis | Exactly one Commonplace genesis |
| CP-A7 | `buildGenesis` seals a distinct genesis from the activity ledger genesis | Same-seed, separate chain (D7) | Both chains exist independently under one MK |
| CP-A8 | Commonplace genesis hashes/keys derive from the same MK the activity ledger uses | Shared crypto root (ADR-031 §2) | One seed → one MK → both books |
| CP-A9 | A Commonplace genesis and an activity genesis do not share block hashes | No accidental dataset mixing (D7) | Distinct chains produce distinct roots |
| CP-A10 | Genesis records `format_version` and `key_version` | Rotation-ready (ADR-026) | Participates in the shared rotation workflow |
| CP-A11 | `verify` on a fresh genesis passes | Integrity baseline | A valid single-block chain is verifiable |

### Group B: CommonplaceDayBlock — Build & Sealing — 12 tests

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

### Group C: CommonplaceChain — Append & Truncate — 8 tests

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

### Group D: CommonplaceEngine — Commit, Verify, Read — 10 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| CP-D1 | `commit` seals a staged Commonplace entry into a day block | Staging → commit (D11) | The staging→ledger move applies to Commonplace |
| CP-D2 | `commit` groups entries by date, inserting a new day block per new date | Date grouping | Entries merge into day-grouped blocks |
| CP-D3 | `commit` updates the chain's last-hash pointer after each append | Chain cursor integrity | The engine tracks the current tip |
| CP-D4 | `verify` returns true for a valid committed chain | Verification gate | Must pass after every commit (D10) |
| CP-D5 | `verify` returns false after a middle block is swapped | Tamper detection | Swapping a sealed block is fatal downstream |
| CP-D6 | `readEntries` returns committed Commonplace entries in order, decrypted | Public read API | Users and UI read the sealed record |
| CP-D7 | Committing to the Commonplace chain does not touch the activity ledger (`ledger:blocks`) | D7 compartmentalization | Separate keys, no cross-contamination |
| CP-D8 | `commit` never injects staging `plain:`/unsealed rows into a sealed block | D11 | No staging data reaches sealed blocks |
| CP-D9 | A Commonplace entry without a `comment` field seals normally | Schema: no comment | The `entry` field replaces `comment` entirely |
| CP-D10 | The engine can verify a chain committed with earlier then later entries | Chronological correctness | Entry timestamps respect chain order |

### Group E: CommonplaceStorage — Separate-File Persistence — 9 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| CP-E1 | `load()` reads a `commonplace.json` that exports as a chain structure | Separate file | No integration with `ledger.json` |
| CP-E2 | `save()` writes a standalone, importable `commonplace.json` shape | Export output | `{"type":"commonplace_chain","genesis":…,"blocks":[…]}` |
| CP-E3 | A saved-then-loaded Commonplace chain verifies identically | Round-trip integrity | Persistence preserves the chain |
| CP-E4 | `commonplace.json` contains no staging rows | D11 separation | Staging never leaks into the exported chain |
| CP-E5 | Loading a missing `commonplace.json` returns a fresh (genesis-able) chain | First-run default | The book starts empty but structured |
| CP-E6 | Loading a corrupt `commonplace.json` surfaces an error, not a crash | Fail-safe load | Corrupt files are detected, not silently read |
| CP-E7 | `commonplace.json` content is encrypted at rest (no plaintext title/entry/tags) | D2 zero-knowledge at rest | Even the persisted chain is encrypted |
| CP-E8 | The storage key is decoupled from the shared master key derivation | Least-resistance path (ADR-031 §10) | The storage location is independent of crypto identity |
| CP-E9 | Same-passphrase re-auth re-derives the MK that decrypts an existing `commonplace.json` | Shared MK + passphrase change | The passphrase system unlocks both books |

### Group F: Commonplace ad-hoc Key/Value — 5 tests

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

All tests target pure JS engine logic (no UI, no HTTP, no WASM). They use `MockCrypto` +
`MemoryBackend` + `TestHelpers` (the same harness as `ledger_chain_test.mjs` /
`ledger_engine_test.mjs`), run via `node test/commonplace_chain_test.mjs`.

## Web-specific parity notes (review before Phase 3)

- **Genesis identity shape:** Flutter flattens `username`/`email`/`recovery_seed_enc`/
  `identity_pub_key`/`identity_secret_enc_fallback` at the top level; the web activity ledger nests
  them under `identity`. The web Commonplace genesis **must mirror Flutter's flattened shape** for
  byte parity — do not copy `LedgerChain.buildGenesisBlock`.
- **`format_version`/`key_version` are top-level plaintext** and excluded from the seal (they are
  not in the whitelist). `key_version` invariant (mirrors Flutter `verify`): a day block's
  `key_version` may not exceed the genesis `key_version`.
- **Identity seal is `mac`-based on web** and excluded from the whitelist; it is not a parity
  blocker. `original_hash` is optional-presence (never emitted by this slice; sealed only if present).
- **`buildDayBlock` does NOT append** (mirrors web `LedgerChain` and Flutter `buildDayBlock`); the
  engine (or caller) appends. `buildGenesis` **does** append immediately (mirrors Flutter) so a
  fresh chain is immediately verifiable and day blocks can link onto it.

## Next Steps

- ✅ **Phase 2 (RED):** 55 assertions written in `phpoc-web/test/commonplace_*_test.mjs`; all RED against Phase 2 skeletons.
- ✅ **Phase 3 (GREEN):** implemented `commonplace_chain.js`, `commonplace_engine.js`,
  `commonplace_storage.js`, and extended `seal_fields.js`; 55 tests / 130 assertions GREEN.
- ✅ **Phase 4 (REFACTOR):** deduped shared version/content-hash/zero-hash helpers into
  `ledger/utils.js`; ledger + commonplace suites re-verified GREEN (no regressions).
- → Next: Slice 2 (Book Switcher), then Slice 3 (UI), Slice 4 (Settings).
