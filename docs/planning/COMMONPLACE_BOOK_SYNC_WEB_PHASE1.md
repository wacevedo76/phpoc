# Web Commonplace Book Remote Sync — Test Exploration (Phase 1)

> **Plan:** this file — the **Web** Commonplace Book **remote-sync** slice (follow-on to Slices 1–4).
> **Mirror:** `flutter/COMMONPLACE_BOOK_SYNC_PHASE1.md` (31 assertions, groups P/L/F/R) — Flutter's slice is now ✅ complete (`b9baa2f`), unblocking this web port.
> **ADR:** ADR-031 (Commonplace Book — separate sealed chain, shared master key).
> **Purpose:** Blueprint of all needed test assertions for syncing the Commonplace sealed chain to/from the
> same Cloudflare Worker under a **new R2 path** (`commonplace/...`), reusing the web ledger's transport,
> MK-obfuscation, freshness, and append-only reconcile semantics. No test/implementation code yet.
> **Status:** ✅ **Phases 1–4 COMPLETE (2026-09-03)** — Phase 3 (GREEN): `CommonplacePushService`/`CommonplacePullService` + `CommonplaceService.reconcileRemoteChain` + `CommonplaceChain.verifyBlocks`/`reconcileRemoteChain` + `ledger/utils.js` `jsonSortNoSpaces` + `sync/keys.js` `REMOTE_COMMONPLACE_*`; all 31 tests GREEN (push 28 / pull 29 / reconcile 18 / e2e 17 = 92 assertions); one Phase 2 assertion corrected (P3 space-separator check). Phase 4 (REFACTOR): extracted `reconcileChainCore` (`src/ledger/chain_reconcile.js`) + shared push/pull/freshness helpers (`src/sync/chain_transport_helpers.js` — `chainBlockPath`/`readRemoteHashIndex`/`pushChainPayloads`/`pullRemoteHasMore`); all suites re-verified GREEN.
> **Next Phase:** — (slice complete; Slice 6 key-rotation extension is the follow-on, still pending Flutter ADR-026).

## Prerequisite (complete)

- `COMMONPLACE_BOOK_WEB_PHASE1.md` — Slice 1 chain/engine/storage (55 tests / 130 assertions GREEN).
- `COMMONPLACE_BOOK_SWITCHER_WEB_PHASE1.md` — Slice 2 Book Switcher (13 GREEN).
- `COMMONPLACE_BOOK_UI_WEB_PHASE1.md` — Slice 3 UI wiring (`CommonplaceService` + screen, 40 GREEN).
- `COMMONPLACE_BOOK_SETTINGS_WEB_PHASE1.md` — Slice 4 Settings surface (44 GREEN).
- `flutter/COMMONPLACE_BOOK_SYNC_PHASE1.md` — Flutter reference slice, ✅ Phases 1–4 complete.
- Web ledger remote-sync machinery to mirror: `SyncService.pushLedgerBlocks()` (serialize→obfuscate→push +
  plaintext hash-index), `WorkerImportSource.fetchChain()` (list→pull→deobfuscate→parse→validate), `HttpTransport`
  (`pull`/`push`/`listFiles`), `CryptoService.obfuscateBlob`/`deobfuscateBlob`.

## Scope Boundary

- **In scope:** the **sealed-chain** sync layer — push + pull + freshness + append-only reconcile of the
  Commonplace `commonplace.json` chain (genesis + day blocks) under a new R2 prefix, mirroring the ledger's
  `ledger/blocks/*` + `ledger/hash_index.json` layout 1:1.
- **Out of scope (later BACKLOG slices):** staging-row sync + device-cookie auth-gate, tag-search blind index,
  shared key-rotation extension (ADR-026), CLI parity port of Commonplace sync.

### Scope decision — the "device cookie + staging" clause (inherited from Flutter)

The BACKLOG clause "an MK-derived device cookie … staging rows sync like ledger staging rows" does **not**
apply to the current Commonplace book, for the same reason already fixed in the Flutter blueprint:

- The ledger has a **staging table** (mutable rows) synced *before* commit via `staging/blob` +
  `staging/hash_index.json` + `device_cookie.bin`, gated by an MK-derived per-device cookie.
- The Commonplace book is **direct-commit** — `CommonplaceService.addEntry()` seals immediately via
  `engine.commit(...)`. There is **no staging table**, so no staging blob to gate and no ownership-handoff
  cookie to reconcile.

**Therefore this slice syncs only the sealed chain**, auth-gated by **MK obfuscation alone** (any holder of
the shared master key can deobfuscate; everyone else cannot) — exactly like the ledger's sealed
`ledger/blocks/*`. If a later slice introduces a Commonplace draft/staging model, cookie-gated staging sync is
a follow-on; this blueprint intentionally keeps it out.

## Architecture Overview

```
src/sync/keys.js                                  ← MODIFY: + commonplace/blocks/ prefix + commonplace/hash_index.json
src/commonplace/commonplace_push_service.js       ← NEW: CommonplacePushService (mirror SyncService.pushLedgerBlocks)
src/commonplace/commonplace_pull_service.js       ← NEW: CommonplacePullService (mirror WorkerImportSource.fetchChain + append-only)
src/commonplace/commonplace_chain.js              ← MODIFY: + verifyBlocks(List) (shared by verify() + pull pre-import) + reconcileRemoteChain delegate
src/commonplace/commonplace_service.js            ← MODIFY: + reconcileRemoteChain(remoteBlocks) → CommonplaceReconcileResult
src/commonplace/commonplace_storage.js            ← (reuse) replaceAll / chain appendBlocks for import
src/ledger/utils.js                               ← MODIFY (Phase 3): jsonSortNoSpaces (sorted-keys compact, no-space separators) — wire serialization
src/ledger/chain_reconcile.js                     ← NEW (Phase 4): reconcileChainCore(...) pure append-only merge
src/sync/chain_transport_helpers.js               ← NEW (Phase 4): chainBlockPath / pushChainPayloads / pullRemoteHasMore

test/commonplace_push_service_test.mjs            ← NEW: Group P
test/commonplace_pull_service_test.mjs            ← NEW: Group L
test/commonplace_reconcile_test.mjs               ← NEW: Group F
test/commonplace_sync_e2e_test.mjs                ← NEW: Group R (hermetic two-device, fake transport)
test/commonplace_sync_test_support.mjs            ← NEW: shared FakeSyncTransport + builders + path constants
```

### R2 path layout (new `commonplace/` prefix)

| Path | Format | Gated by | Purpose |
|------|--------|----------|---------|
| `commonplace/blocks/NNNNNN.json` | MK-obfuscated PHPSPEC JSON | MK (obfuscate/deobfuscate) | One sealed Commonplace block per file, 6-digit zero-padded index (`000000` = genesis) |
| `commonplace/hash_index.json` | **plaintext** JSON array | — | Block hashes in chain order; block-count freshness source (mirrors `ledger/hash_index.json`) |

Not created (deferred): `commonplace/index.json` (blind index), `commonplace/blob`,
`commonplace/device_cookie.bin`, `commonplace/staging_hash_index.json` (staging).

### Service design

- **`CommonplacePushService({ crypto, transport, chain })`**
  - `pushAll()` — read all blocks from the chain, serialize each (sorted-keys compact PHPSPEC), obfuscate with
    MK, push to `commonplace/blocks/NNNNNN.json`, then push the plaintext `commonplace/hash_index.json` array
    of `chain.getBlockHashFor(block)` hashes in order. Refuse an empty chain (no genesis) — never wipes the
    remote. Serialize concurrent calls.
  - `pushBlocks(blocks)` — explicit-chain path (commit auto-push), 0-indexed list position → remote filename.
  - Returns `{ pushed, failedBlocks }` (plain object; web has no Dart `PushResult`).
- **`CommonplacePullService({ crypto, transport, chain, storage })`**
  - `pullAll()` — read `commonplace/hash_index.json` (plaintext) → `listFiles('commonplace/blocks/')` → pull +
    deobfuscate + parse each discovered index (ascending order, bounded concurrency) → validate assembled chain
    (genesis-first, seals, prev_hash linkage, per-entry content hashes) via `chain.verifyBlocks(blocks)` →
    import into the `commonplace:blocks` store (fresh local → `replaceAll`; else append-only via
    `chain.appendBlocks`). Null transport → `ok(0)`; no MK → throw.
  - `pullIfRemoteHasMore({ localBlockCount })` — freshness detector: compare `commonplace/hash_index.json`
    length to local block count; never re-downloads an unchanged chain.
  - Returns `{ blocksPulled, failedBlocks }` (plain object).
- **`CommonplaceService.reconcileRemoteChain(remoteBlocks)` → `CommonplaceReconcileResult`**
  - append-only merge mirroring Flutter's `SyncService.reconcileRemoteLedger`: skip identical, append bridging
    tail, report (never write) divergences. Returns `{ conflictedIndices, appended, hasConflicts }`.

### Wire format (cross-client parity)

- **Block hash** for `hash_index.json`: `CommonplaceChain.getBlockHashFor(block)` — `block_hash` for
  `commonplace_genesis`, `day_hash` for `commonplace` day blocks (already resolved by the chain's `hashKeyFor`
  / `getBlockHashFor`).
- **Serialization:** sorted-keys **compact** JSON — mirroring Flutter's `jsonEncodeSortedNoSpaces` (sorted keys,
  `:` and `,` with no spaces). **Web delta:** the existing `ledger/utils.js` `jsonSort()` emits Python-style
  `": "`/`", "` separators (with spaces), so Phase 3 adds a `jsonSortNoSpaces` helper (sorted keys, no-space
  separators) for the wire bytes. Note this is a *determinism / byte-identical-R2* property, not an interop
  requirement: the obfuscated block bytes are opaque, and interop is guaranteed by (a) the identical shared-Rust
  obfuscation algorithm, (b) canonical seal validation on pull (whitelist `selectSealFields` + `jsonSort`), and
  (c) `hash_index.json` parity (seal-derived 64-char hex, serialization-independent).
- **Obfuscation:** `crypto.obfuscateBlob(jsonStr, mkHex)` on push; `crypto.deobfuscateBlob(rawB64, mkHex)` on
  pull — identical to the ledger, so the same seed → same MK unlocks both books' remote chains.

## Web deltas vs Flutter (kept faithful to the port)

1. **No `StateError` class** — Flutter's `StateError` maps to a plain `Error` with a descriptive message on web.
2. **No isolate offload / `OffloadRunner`** — the browser event loop makes the Commonplace pull sequential +
   bounded-concurrency inline; the Flutter `OffloadRunner` seam and its background-isolate concerns do not apply.
3. **No separate `LedgerPushService`/`LedgerPullService` classes** — the web ledger push is
   `SyncService.pushLedgerBlocks()` and the ledger pull is `WorkerImportSource.fetchChain()`. The Commonplace
   services are new, but Phase 4 extracts the shared serialize→obfuscate→push + freshness loops into
   `src/sync/chain_transport_helpers.js` (analogue of Flutter's `chain_transport_helpers.dart`) and the
   append-only merge into `src/ledger/chain_reconcile.js` (`reconcileChainCore`, analogue of
   `chain_reconcile.dart`).
4. **Obfuscation byte-parity is guaranteed by construction** — web and Flutter call the same Rust
   `obfuscate_blob` binding (already locked by the C-2 cross-client harness). Web unit tests therefore use
   `MockCrypto`'s reversible `obfuscateBlob`/`deobfuscateBlob` (consistent with the other Commonplace node
   suites) to exercise the service serialize→obfuscate→push→pull→parse loop; real-WASM byte parity is out of
   scope here (C-2 already covers it).
5. **`jsonSort` spacing delta** — web `jsonSort()` has Python-style spaces; a `jsonSortNoSpaces` helper is added
   for the wire bytes (see Wire format above). `hash_index.json` parity is spacing-independent.

## Test Groups

### Group P: `CommonplacePushService` — push to R2 (9 tests)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| CPSW-P1 | `pushAll()` pushes every block (genesis + day blocks) to `commonplace/blocks/NNNNNN.json` with a 6-digit zero-padded index | Sealed-chain upload | Remote chain is discoverable by the pull side |
| CPSW-P2 | `pushAll()` pushes `commonplace/hash_index.json` as a plaintext JSON array of `getBlockHashFor` hashes in chain order | Freshness + integrity source | Mirrors `ledger/hash_index.json`; hash is `block_hash` for genesis, `day_hash` for day blocks |
| CPSW-P3 | Each pushed block payload is the sorted-keys compact PHPSPEC JSON obfuscated with the MK (deobfuscate → exact `jsonSortNoSpaces(block)` round-trips) | Byte-parity wire format | Cross-client convergence (Web/Flutter/CLI) + MK-only readability |
| CPSW-P4 | `pushAll()` throws on an empty chain (no genesis) | Never wipe the remote | An empty push would overwrite `hash_index.json` with `[]`, destroying remote |
| CPSW-P5 | `pushAll()` throws when no master key is cached | MK guard | Obfuscation is impossible without the MK |
| CPSW-P6 | `pushBlocks(blocks)` pushes an explicit block list using 0-indexed positions | Commit auto-push path | The commit path feeds fresh blocks without reloading the store |
| CPSW-P7 | Repeated `pushAll()` is idempotent — same paths overwritten, no error | Idempotent upload | Re-push after a partial failure must not corrupt |
| CPSW-P8 | A transport failure yields `{ pushed, failedBlocks }` with the failed block indices in `failedBlocks` | Partial-failure reporting | Callers can surface which blocks failed |
| CPSW-P9 | Concurrent `pushAll()` calls are serialized — the second waits on the first | Concurrency guard | Mirrors `LedgerPushService._pendingPush` (web: a promise-chain guard) |

### Group L: `CommonplacePullService` — pull from R2 (10 tests)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| CPSW-L1 | `pullAll()` with no remote `commonplace/hash_index.json` returns `blocksPulled: 0` | Empty remote | First-run device pulls nothing |
| CPSW-L2 | `pullAll()` reads `commonplace/hash_index.json` (plaintext) to learn the remote block count | Discovery | Same plaintext-count discovery as the ledger |
| CPSW-L3 | `pullAll()` lists files under `commonplace/blocks/` and pulls only discovered indices in ascending order (bounded concurrency) | Ordered fetch | Preserves `prev_hash` linkage while never firing unbounded requests |
| CPSW-L4 | Each pulled block is deobfuscated with the MK then JSON-parsed into a chain map | Decode | MK-only readability; parse failures are captured, not thrown |
| CPSW-L5 | A block deobfuscated under the wrong MK (or a tampered blob) is reported in `failedBlocks` and never imported | Wrong-MK / tamper detection | A non-MK-holder must not import garbage |
| CPSW-L6 | The assembled chain is validated before import — the first block must be `commonplace_genesis` | Genesis-first rule | A chain without a genesis cannot seed a book |
| CPSW-L7 | The assembled chain is validated — `identity_seal` signature, `prev_hash` linkage, and per-entry content hashes all verify | Chain integrity | Reuses the chain's `verifyBlocks(blocks)`, mirroring Flutter's `validatePulledChain` |
| CPSW-L8 | A valid chain is imported into the `commonplace:blocks` store (fresh local → replace-all; existing local → append) with the on-disk `genesis`/`blocks` split kept consistent | Import | `CommonplaceStorage.replaceAll` / `chain.appendBlocks` |
| CPSW-L9 | `pullAll()` throws without a cached MK, and returns `blocksPulled: 0` as a no-op when `transport` is null | MK / local-only guards | Mirrors Flutter's `LedgerPullService.pullAll` |
| CPSW-L10 | When fewer blocks are found than `hash_index` expects, the missing indices are reported in `failedBlocks` | Missing-block report | Partial remote is surfaced, not silently accepted |

### Group F: Freshness + append-only reconcile (7 tests)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| CPSW-F1 | `pullIfRemoteHasMore(localBlockCount)` returns `blocksPulled: 0` when the remote hash index is absent/empty | No remote | Fail-safe "no change" |
| CPSW-F2 | Returns `blocksPulled: 0` when the remote count ≤ local count | Unchanged chain | Never re-downloads an identical chain |
| CPSW-F3 | Returns `blocksPulled: N` when the remote count is N greater than the local count | Freshness signal | Callers trigger `pullAll` only on growth |
| CPSW-F4 | `reconcileRemoteChain` skips remote blocks whose hash matches the local block at the same index (no write) | Identical skip | Idempotent re-pull |
| CPSW-F5 | Appends a remote tail whose first `prev_hash` bridges to the local last block, in order, reporting the `appended` count | Behind-device catch-up | Append-only (D5); never truncates the local tail |
| CPSW-F6 | A remote block at an existing index with a *different* hash (or a tail that does not bridge) is reported in `conflictedIndices` and **never written** | Fork protection | A stale device never clobbers canonical remote blocks |
| CPSW-F7 | An empty local chain only accepts a remote chain that begins with `commonplace_genesis`; otherwise conflict at index 0 | Genesis bootstrap guard | Mirrors the ledger's empty-chain genesis rule |

### Group R: Hermetic two-device round-trip E2E (5 tests)

*(In-memory `FakeSyncTransport` shared between two device instances with the same MK but independent stores —
the same pattern as `web_ledger_auto_pull_test.mjs` / `commit_push_integration_test.mjs`. No real network.)*

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| CPSW-R1 | Device A pushes a 2-block chain (genesis + day block); Device B (same MK) pulls and `readEntries()` returns the identical committed passage | End-to-end round-trip | The full push→pull→read loop works |
| CPSW-R2 | Device B with a genesis-only chain pulls Device A's day blocks and appends them (append-only catch-up) | Catch-up | A behind device converges without clobbering |
| CPSW-R3 | Device B with an empty local chain pulls Device A's full chain and bootstraps genesis + blocks | Fresh-device restore | Restore-from-cloud works for the book |
| CPSW-R4 | Device B holding a divergent block (same index, different hash) reports a conflict and keeps its local chain intact | No clobber on fork | Cross-device divergence is surfaced, not silently overwritten |
| CPSW-R5 | A wrong-MK device cannot decrypt the pulled blocks (no committed entries are readable) | Leak-nullification | Only the shared-MK holder reads the book, matching the ledger |

## Test Inventory Summary

| Group | Focus | Tests |
|-------|-------|-------|
| P | `CommonplacePushService` — push to R2 | 9 |
| L | `CommonplacePullService` — pull from R2 | 10 |
| F | Freshness + append-only reconcile | 7 |
| R | Hermetic two-device round-trip E2E | 5 |
| **Total** | | **31** |

Tests target pure-JS services using an in-memory `FakeSyncTransport` + `MockCrypto`
(obfuscate/deobfuscate round-trip, not mocked for the service loop) + `MemoryBackend` + the real
`CommonplaceChain`/`CommonplaceEngine` (seal/verify are exercised through the MockCrypto's deterministic
`seal`/`verifySeal`). Node harness (`node test/<name>.mjs`) + `TestHelpers`, consistent with the other
Commonplace node suites. No HTTP/real Worker in the unit groups; an optional tagged E2E against the testing
Worker can be added later (mirroring the C-2 live R2 tests).

## Next Steps

- **Phase 2 (RED):** write the 31 assertions as compile-blocking tests across
  `test/commonplace_push_service_test.mjs` (P), `test/commonplace_pull_service_test.mjs` (L),
  `test/commonplace_reconcile_test.mjs` (F), `test/commonplace_sync_e2e_test.mjs` (R), plus the shared
  `test/commonplace_sync_test_support.mjs` (`FakeSyncTransport`, `buildChain`, `seedRemoteChain`, `rawEntry`,
  path constants). RED = fail only on the missing modules/methods (`CommonplacePushService`,
  `CommonplacePullService`, `CommonplaceService.reconcileRemoteChain`, `CommonplacePullService.pullIfRemoteHasMore`).
- **Phase 3 (GREEN):** implement the services + `verifyBlocks` + `reconcileRemoteChain` + `jsonSortNoSpaces` +
  `keys.js` constants.
- **Phase 4 (REFACTOR):** extract `reconcileChainCore` (`src/ledger/chain_reconcile.js`) + shared
  push/pull/freshness helpers (`src/sync/chain_transport_helpers.js`).
