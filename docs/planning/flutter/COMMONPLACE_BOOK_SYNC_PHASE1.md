# Flutter Commonplace Book Remote Sync — Test Exploration (Phase 1)

> **Plan:** this file — the Commonplace Book **remote-sync** slice (follow-on to UI wiring + Settings)
> **ADR:** ADR-031 (Commonplace Book — separate sealed chain, shared master key)
> **Purpose:** Blueprint of all needed test assertions for syncing the Commonplace sealed chain to/from the
> same Cloudflare Worker under a **new R2 path** (`commonplace/...`), reusing the ledger's transport,
> MK-obfuscation, freshness, and append-only reconcile semantics. No test/implementation code yet.
> **Status:** ✅ Phase 4 (REFACTOR: ledger↔commonplace push/pull/reconcile overlap deduped into
> `chain_reconcile.dart` + `chain_transport_helpers.dart` — 31/31 sync GREEN, full Flutter suite 2178 passed)
> **Next Phase:** return to web Slice 5 (Remote sync) — now unblocked by the completed Flutter sync phases.
>
> **Prerequisite (complete):**
> - `COMMONPLACE_BOOK_PHASE1.md` — chain/engine/storage slice (55/55 GREEN, shared `SealableChain` mixin).
> - `COMMONPLACE_BOOK_SWITCHER_PHASE1.md` — Book Switcher (13/13 GREEN).
> - `COMMONPLACE_BOOK_UI_PHASE1.md` — `CommonplaceService` + screen/add/topic surface (40/40 GREEN).
> - `COMMONPLACE_BOOK_SETTINGS_PHASE1.md` — Settings surface (in progress / blueprint).
> - Ledger remote-sync machinery to mirror: `LedgerPushService`, `LedgerPullService`,
>   `SyncService.reconcileRemoteLedger`, `StagingPaths`, `HttpTransport`, `DeviceCookie`.

## Scope Boundary

- **In scope:** the **sealed-chain** sync layer — push + pull + freshness + append-only reconcile of the
  Commonplace `commonplace.json` chain (genesis + day blocks) under a new R2 prefix, mirroring the ledger's
  `ledger/blocks/*` + `ledger/hash_index.json` layout 1:1.
- **Out of scope (later BACKLOG slices):** staging-row sync + device-cookie auth-gate (see scope decision
  below), tag-search blind index, shared key-rotation extension (ADR-026), Web/CLI parity ports of *sync*
  (Web Slice 5 depends on this slice).

### Scope decision — the "device cookie + staging" clause

The BACKLOG entry for this slice says *"an MK-derived device cookie (mirrors the ledger's cookie
auth-gating model); staging rows sync like ledger staging rows."* That clause does **not** apply to the
current Commonplace book, for a deliberate reason already fixed in `COMMONPLACE_BOOK_UI_PHASE1.md`:

- The ledger has a **staging table** (mutable `active`/`paused`/`ended` rows) that is synced *before*
  commit via `staging/blob` + `staging/hash_index.json` + `device_cookie.bin`, gated by a per-device
  cookie whose `device_proof` is **MK-derived** (`crypto.deviceProof(mk, deviceId)`).
- The Commonplace book is **direct-commit** — `CommonplaceService.addEntry()` seals immediately via
  `engine.commit(...)`. There is **no staging table** (the UI slice explicitly chose "no staging for
  one-shot add"), so there is no staging blob to gate and no ownership-handoff cookie to reconcile.

Therefore **this slice syncs only the sealed chain**, and the sealed chain is auth-gated by **MK
obfuscation alone** (any holder of the shared master key can deobfuscate; everyone else cannot), exactly
like the ledger's sealed `ledger/blocks/*` — the cookie never gates sealed blocks in the ledger either.

If a later slice introduces a Commonplace *draft/staging* model, then the cookie-gated staging sync
(`device_cookie.bin`, `device_proof`, `commonplace/blob`, `commonplace/hash_index.json` staging index)
will be added as a follow-on. This blueprint intentionally keeps that out so the sync slice does not
invent a staging model the book does not have.

## Architecture Overview

```
lib/data/sync/staging_paths.dart                    ← MODIFY: + commonplace/blocks/ prefix + commonplace/hash_index.json
lib/services/commonplace_push_service.dart          ← NEW: CommonplacePushService (mirror LedgerPushService)
lib/services/commonplace_pull_service.dart          ← NEW: CommonplacePullService (mirror LedgerPullService)
lib/data/commonplace/commonplace_service.dart       ← MODIFY: + reconcileRemoteChain(remoteBlocks) → CommonplaceReconcileResult
test/services/commonplace_push_service_test.dart    ← NEW: Group P
test/services/commonplace_pull_service_test.dart    ← NEW: Group L
test/data/commonplace/commonplace_reconcile_test.dart ← NEW: Group F
test/services/commonplace_sync_e2e_test.dart        ← NEW: Group R (hermetic two-device, fake transport)
```

### R2 path layout (new `commonplace/` prefix)

| Path | Format | Gated by | Purpose |
|------|--------|----------|---------|
| `commonplace/blocks/NNNNNN.json` | MK-obfuscated PHPSPEC JSON | MK (obfuscate/deobfuscate) | One sealed Commonplace block per file, 6-digit zero-padded index (`000000` = genesis) |
| `commonplace/hash_index.json` | **plaintext** JSON array | — | Block hashes in chain order; block-count freshness source (mirrors `ledger/hash_index.json`) |

Not created (deferred): `commonplace/index.json` (blind index), `commonplace/blob`,
`commonplace/device_cookie.bin`, `commonplace/staging_hash_index.json` (staging).

### Service design

- **`CommonplacePushService({required CryptoService crypto, required HttpTransport transport, required CommonplaceChain chain})`**
  - `Future<PushResult> pushAll()` — read all blocks from the chain, serialize each (sorted, space-free
    PHPSPEC), obfuscate with MK, push to `commonplace/blocks/NNNNNN.json`, then push the plaintext
    `commonplace/hash_index.json` array of `chain.getBlockHashFor(block)` hashes in order. Refuse an empty
    chain (no genesis) with `StateError` (never wipes the remote). Serialize concurrent calls.
  - `Future<PushResult> pushBlocks(List<Map<String,dynamic>> blocks)` — explicit-chain path (commit
    auto-push), 0-indexed list position → remote filename.
- **`CommonplacePullService({required CryptoService crypto, required HttpTransport? transport, required CommonplaceStorage storage, OffloadRunner offload})`**
  - `Future<PullResult> pullAll()` — read `commonplace/hash_index.json` (plaintext) → `listFiles('commonplace/blocks/')`
    → pull+deobfuscate+parse each discovered index (bounded concurrency, index order) → validate assembled
    chain (genesis-first, seals, prev_hash linkage, per-entry content hashes) → import into `CommonplaceStorage`
    (fresh local → `replaceAll`; else append-only). Null transport → `ok(0)`; no MK → `StateError`.
  - `Future<PullResult> pullIfRemoteHasMore({required int localBlockCount})` — freshness detector:
    compare `commonplace/hash_index.json` length to local block count; never re-downloads an unchanged chain.
- **`CommonplaceService.reconcileRemoteChain(List<Map<String,dynamic>> remoteBlocks)` → `CommonplaceReconcileResult`**
  - append-only merge mirroring `SyncService.reconcileRemoteLedger`: skip identical, append bridging tail,
    report (never write) divergences. Returns `{conflictedIndices, appended}`.

### Wire format (cross-client parity)

- **Block hash** for `hash_index.json`: `CommonplaceChain.getBlockHashFor(block)` — `block_hash` for
  `commonplace_genesis`, `day_hash` for `commonplace` day blocks (already resolved by the chain's
  `hashKeyFor`).
- **Serialization:** `jsonEncodeSortedNoSpaces(block)` (sorted keys, compact, no spaces — the same
  JS/Python-compatible form the ledger push and `LedgerBackupService` use), so the Commonplace R2 wire
  bytes converge with Web/CLI ports the way `ledger/blocks/*` already does.
- **Obfuscation:** `crypto.obfuscateBlob(jsonStr, mkHex)` on push; `crypto.deobfuscateBlob(raw, mkHex)` on
  pull — identical to the ledger, so the same seed → same MK unlocks both books' remote chains.

## Test Groups

### Group P: `CommonplacePushService` — push to R2 (~9 tests)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| CPSY-P1 | `pushAll()` pushes every block (genesis + day blocks) to `commonplace/blocks/NNNNNN.json` with a 6-digit zero-padded index | Sealed-chain upload | Remote chain is discoverable by the pull side |
| CPSY-P2 | `pushAll()` pushes `commonplace/hash_index.json` as a plaintext JSON array of `getBlockHashFor` hashes in chain order | Freshness + integrity source | Mirrors `ledger/hash_index.json`; hash is `block_hash` for genesis, `day_hash` for day blocks |
| CPSY-P3 | Each pushed block payload is the sorted, space-free PHPSPEC JSON (`jsonEncodeSortedNoSpaces`) obfuscated with the MK | Byte-parity wire format | Cross-client convergence (Web/CLI) + MK-only readability |
| CPSY-P4 | `pushAll()` throws `StateError` on an empty chain (no genesis) | Never wipe the remote | An empty push would overwrite `hash_index.json` with `[]`, destroying remote |
| CPSY-P5 | `pushAll()` throws `StateError` when no master key is cached | MK guard | Obfuscation is impossible without the MK |
| CPSY-P6 | `pushBlocks(blocks)` pushes an explicit block list using 0-indexed positions | Commit auto-push path | The commit path feeds fresh blocks without reloading the store |
| CPSY-P7 | Repeated `pushAll()` is idempotent — same paths overwritten, no error | Idempotent upload | Re-push after a partial failure must not corrupt |
| CPSY-P8 | A transport failure yields `PushResult.failure` with the failed block indices in `failedBlocks` | Partial-failure reporting | Callers can surface which blocks failed |
| CPSY-P9 | Concurrent `pushAll()` calls are serialized — the second waits on the first | Concurrency guard | Mirrors `LedgerPushService._pendingPush` |

### Group L: `CommonplacePullService` — pull from R2 (~10 tests)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| CPSY-L1 | `pullAll()` with no remote `commonplace/hash_index.json` returns `ok(blocksPulled: 0)` | Empty remote | First-run device pulls nothing |
| CPSY-L2 | `pullAll()` reads `commonplace/hash_index.json` (plaintext) to learn the remote block count | Discovery | Same plaintext-count discovery as the ledger |
| CPSY-L3 | `pullAll()` lists files under `commonplace/blocks/` and pulls only discovered indices in ascending order (bounded concurrency) | Ordered fetch | Preserves `prev_hash` linkage while never firing unbounded requests |
| CPSY-L4 | Each pulled block is deobfuscated with the MK then JSON-parsed into a chain map | Decode | MK-only readability; parse failures are captured, not thrown |
| CPSY-L5 | A block deobfuscated under the wrong MK (or a tampered blob) is reported in `failedBlocks` and never imported | Wrong-MK / tamper detection | A non-MK-holder must not import garbage |
| CPSY-L6 | The assembled chain is validated before import — the first block must be `commonplace_genesis` | Genesis-first rule | A chain without a genesis cannot seed a book |
| CPSY-L7 | The assembled chain is validated — `identity_seal` signature, `prev_hash` linkage, and per-entry content hashes all verify | Chain integrity | Reuses the chain's existing verification, mirroring `validatePulledChain` |
| CPSY-L8 | A valid chain is imported into `CommonplaceStorage` (fresh local → replace-all; existing local → append) with the on-disk `genesis`/`blocks` split kept consistent | Import | `CommonplaceStorage.replaceAll`/`appendBlocks` + `save` |
| CPSY-L9 | `pullAll()` throws `StateError` without a cached MK, and returns `ok(0)` as a no-op when `transport` is null | MK / local-only guards | Mirrors `LedgerPullService.pullAll` |
| CPSY-L10 | When fewer blocks are found than `hash_index` expects, the missing indices are reported in `failedBlocks` | Missing-block report | Partial remote is surfaced, not silently accepted |

### Group F: Freshness + append-only reconcile (~7 tests)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| CPSY-F1 | `pullIfRemoteHasMore(localBlockCount)` returns `blocksPulled: 0` when the remote hash index is absent/empty | No remote | Fail-safe "no change" |
| CPSY-F2 | Returns `blocksPulled: 0` when the remote count ≤ local count | Unchanged chain | Never re-downloads an identical chain |
| CPSY-F3 | Returns `blocksPulled: N` when the remote count is N greater than the local count | Freshness signal | Callers trigger `pullAll` only on growth |
| CPSY-F4 | `reconcileRemoteChain` skips remote blocks whose hash matches the local block at the same index (no write) | Identical skip | Idempotent re-pull |
| CPSY-F5 | Appends a remote tail whose first `prev_hash` bridges to the local last block, in order, reporting the `appended` count | Behind-device catch-up | Append-only (D5); never truncates the local tail |
| CPSY-F6 | A remote block at an existing index with a *different* hash (or a tail that does not bridge) is reported in `conflictedIndices` and **never written** | Fork protection | A stale device never clobbers canonical remote blocks |
| CPSY-F7 | An empty local chain only accepts a remote chain that begins with `commonplace_genesis`; otherwise conflict at index 0 | Genesis bootstrap guard | Mirrors the ledger's empty-chain genesis rule |

### Group R: Hermetic two-device round-trip E2E (~5 tests)

*(In-memory `FakeHttpTransport implements HttpTransport` shared between two device instances with the same
MK but independent stores — the same pattern as `test/services/ledger_push_service_test.dart` and
`test/services/two_device_auto_sync_e2e_test.dart`. No real network.)*

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| CPSY-R1 | Device A pushes a 2-block chain (genesis + day block); Device B (same MK) pulls and `readEntries()` returns the identical committed passage | End-to-end round-trip | The full push→pull→read loop works |
| CPSY-R2 | Device B with a genesis-only chain pulls Device A's day blocks and appends them (append-only catch-up) | Catch-up | A behind device converges without clobbering |
| CPSY-R3 | Device B with an empty local chain pulls Device A's full chain and bootstraps genesis + blocks | Fresh-device restore | Restore-from-cloud works for the book |
| CPSY-R4 | Device B holding a divergent block (same index, different hash) reports a conflict and keeps its local chain intact | No clobber on fork | Cross-device divergence is surfaced, not silently overwritten |
| CPSY-R5 | A wrong-MK device cannot decrypt the pulled blocks (no committed entries are readable) | Leak-nullification | Only the shared-MK holder reads the book, matching the ledger |

## Test Inventory Summary

| Group | Focus | Tests |
|-------|-------|-------|
| P | `CommonplacePushService` — push to R2 | 9 |
| L | `CommonplacePullService` — pull from R2 | 10 |
| F | Freshness + append-only reconcile | 7 |
| R | Hermetic two-device round-trip E2E | 5 |
| **Total** | | **31** |

Tests target pure-Dart services using an in-memory `FakeHttpTransport` + a real `CryptoService`
(obfuscate/deobfuscate are exercised for byte-parity, not mocked) + an in-memory `CommonplaceStorage`.
No HTTP/real Worker in the unit groups; an optional tagged E2E against the testing Worker can be added
later, mirroring `two_device_auto_sync_e2e_test.dart`.

## Next Steps

- **Phase 2 (RED):** ✅ **DONE** — 31 assertions written as compile-blocking tests across:
  - `test/services/commonplace_push_service_test.dart` (Group P, 9)
  - `test/services/commonplace_pull_service_test.dart` (Group L, 10)
  - `test/data/commonplace/commonplace_reconcile_test.dart` (Group F, 7)
  - `test/services/commonplace_sync_e2e_test.dart` (Group R, 5)
  - shared support: `test/services/commonplace_sync_test_support.dart`
    (`FakeSyncTransport`, `FakeCommonplaceStore`, `initCrypto`, `buildChain`, `seedRemoteChain`,
    `rawEntry`, path constants).

  RED confirmed: all 4 files fail to compile **only** on the missing modules/methods
  (`CommonplacePushService`, `CommonplacePullService`, `CommonplaceService.reconcileRemoteChain`,
  `CommonplacePullService.pullIfRemoteHasMore`) — no unrelated errors.
- **Phase 3 (GREEN):** ✅ **DONE** — implemented:
  - `lib/services/commonplace_push_service.dart` — `CommonplacePushService`
    (`pushAll()` / `pushBlocks()`; sorted space-free PHPSPEC JSON obfuscated with MK; plaintext hash_index;
    `StateError` on empty chain / no MK; concurrent `pushAll` serialized; per-block `failedBlocks`).
  - `lib/services/commonplace_pull_service.dart` — `CommonplacePullService`
    (`pullAll()` / `pullIfRemoteHasMore({localBlockCount})`; hash_index-driven block discovery; per-block
    deobfuscate+parse; genesis-first + `verifyBlocks` integrity gate; append-only `reconcileRemoteChain`
    import; wrong-MK → `failedBlocks` with nothing imported; null transport → `ok(0)`).
  - `lib/data/commonplace/commonplace_chain.dart` — extracted `verifyBlocks(List)` (shared by `verify()`
    and pull pre-import validation) + added `reconcileRemoteChain(...)` + `CommonplaceReconcileResult`
    (`conflictedIndices`, `appended`, `hasConflicts`).
  - `lib/data/commonplace/commonplace_service.dart` — `reconcileRemoteChain(...)` delegate.
  - `lib/data/sync/staging_paths.dart` — `commonplaceBlocksPrefix` + `commonplaceHashIndex`.

  31/31 GREEN (P9/L10/F7/R5); full Flutter suite 2178 passed (no regressions); `flutter analyze` clean.
- **Phase 4 (REFACTOR):** ✅ **DONE** — extracted the shared chain machinery without changing behavior:
  - `lib/data/ledger/chain_reconcile.dart` — `reconcileChainCore(...)` pure function (the append-only
    merge loop). `SyncService.reconcileRemoteLedger` and `CommonplaceChain.reconcileRemoteChain` now
    delegate to it, each wrapping the result in its own `ReconcileResult` / `CommonplaceReconcileResult`.
  - `lib/services/chain_transport_helpers.dart` — `ChainBlockPayload`, `chainBlockPath`, `textBytes`,
    `pushChainPayloads(...)` (shared serialize→obfuscate→push→plaintext-hash_index loop), and
    `pullRemoteHasMore(...)` (shared freshness detector). `LedgerPushService` / `CommonplacePushService`
    and `LedgerPullService` / `CommonplacePullService` now delegate to these (dropping the duplicated
    `_BlockPayload`, `_textBytes`, `_pushChainPayloads`, and `_doPullIfRemoteHasMore` copies).
  - **Intentionally not deduped:** the per-block fetch/decode/parse path — the ledger keeps its
    background-isolate offload seam + bounded concurrency, while Commonplace stays deliberately
    sequential and inline (a personal sealed book, not the long staging-backed activity ledger).

  31/31 sync GREEN + full Flutter suite 2178 passed; `flutter analyze` clean.
