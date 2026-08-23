# Flutter Restore Pull: Isolate Offload + Concurrent Block Fetch — Phase 1 Blueprint

> **Bug (live, 2026-08-22):** Restoring the personal ledger from cloud on the Android emulator
> "recognized the CF Worker/R2" but imported **zero** blocks and **zero** activities, despite R2
> holding 136 valid, deobfuscatable blocks (281 entry hashes all verify). The emulator DB ended
> with only a fresh local genesis (`blocks=1`, `entries=0`, `staging=0`).
> **Root cause:** `LedgerPullService.pullAll()` runs the whole pull **synchronously on the UI isolate** —
> sequential 136× HTTP fetch, pure-Dart AES-128-CTR deobfuscation, SHA-256 entry-hash validation, DB
> import, staging seed — with **no `compute()`/`Isolate`/`Isolate.run` anywhere in `lib/`**. The UI
> thread blocked for >120 s (logcat shows **two ANRs**, ~149 s of 118% CPU) → the OS killed the
> activity mid-pull → the block-import DB transaction never committed.
> **Fix:** (1) fetch blocks **concurrently** (bounded `Future.wait`), (2) offload the CPU-bound
> deobfuscation + chain validation to a **background isolate** via a testable execution seam.
> **Status:** 🟢 Phase 3 (GREEN) done (2026-08-22) — 25/25 assertions GREEN
> **Next Phase:** ✅ Phase 4 (REFACTOR) done (2026-08-22) — 4-phase TDD COMPLETE
>
> **Phase 2 summary:** `LedgerPullService` gained an optional `offload`
> `OffloadRunner` seam (defaults to `isolateOffloadRunner` backing `Isolate.run`;
> injectable for tests) + new `pull_stage_functions.dart` skeleton
> (`decodePullBlockBytes`/`validatePulledChain`, throw `UnimplementedError`).
> Tests in `test/services/ledger_pull_offload_test.dart` (25 assertions,
> groups C/O/S/R/E): **6 RED** (O1/O2/O3/O4 = seam not yet routed through,
> C3 = still sequential so peak-concurrency is 1, R2 = serial wall-time
> exceeds bound); C4 is guard-green with R2 as the definitive serial-bind test;
> the remaining **18 guard-green** are behavior-preserving dependencies that
> become meaningful once Phase 3 wires the seam. Full suite: no regressions
> (rekey baseline `-31` unchanged; my file `+19/-6`).
>
> **Phase 3 summary (GREEN, 2026-08-22):** implemented `decodePullBlockBytes`
> (self-contained `deobfuscateBlob`-equivalent in `pull_stage_functions.dart`)
> + `validatePulledChain` as top-level isolate-sendable helpers; replaced the
> sequential block loop with a bounded concurrent `Future.wait`
> (`pullConcurrencyLimit=5`) preserving chain order; routed per-block
> deobfuscation + chain validation through the `offload` seam;
> `providers.dart` injects `isolateOffloadRunner`. All **25/25 GREEN**
> (O1/O2/O3/O4/C3/R2 now pass). Two implementation notes: (1) closures handed
> to `Isolate.run` must not transitively capture `this` — `_fetchDecodeParseBlock`
> is now `static` and `offload` is captured into a local so no sibling closure
> binds the receiver (else `l'object is unsendable'`); (2) C3's `pullCalls`
> guard corrected 20 → 21 (hash_index discovery + 20 blocks). Full suite
> `+1979/-31` (only the gated C-2 re-key RED baseline remains); analyze 0 err/warn.

---

## 1. Architecture Overview

The pull path (`lib/services/ledger_pull_service.dart`) currently does **all** work on the caller's
isolate (the UI isolate during onboarding restore):

```
pullAll()                                  // public API — MUST stay identical signature/behavior
└── _doPullAll()
    ├── 1. pull hash_index.json                 (1 HTTP round-trip)
    ├── 2. listFiles('ledger/blocks/')          (1 HTTP round-trip)
    ├── 3. for i in sortedIndices:              ← SEQUENTIAL 136× HTTP
    │       └── _pullBlock(): bytes → deobfuscateBlob() [pure-Dart AES-CTR + HMAC]  ← CPU-BOUND
    ├── 4. _validateImportedChain(): SHA-256 entry-hash on all 281 entries           ← CPU-BOUND
    ├── 5. backupService.importFromJson (DB write)
    └── 6. _seedStagingFromBlocks (DB write + per-entry decrypt/JSON)                ← partly CPU
```

**Target design (fix):**

```
pullAll()                                  // public API unchanged (D9)
└── _doPullAll()
    ├── 1–2. hash_index + listFiles            (unchanged)
    ├── 3. concurrent block fetch              (bounded Future.wait, preserves chain order)
    │       └── per block: bytes (I/O) → _offload(decodePullBlockBytes)  ← isolate seam
    ├── 4. _offload(validatePulledChain)       ← isolate seam
    ├── 5. backupService.importFromJson (DB write, async)
    └── 6. _seedStagingFromBlocks (DB write)
```

**Execution seam (key testability requirement):** introduce a single swappable boundary so Phase-2
tests run hermetically without spawning real isolates (slow/flaky in `flutter_test`):

- `typedef OffloadRunner = Future<T> Function<T>(FutureOr<T> Function() compute);`
- `LedgerPullService` gains an `offload` runner (default: wraps `Isolate.run` in production).
- Production wiring (`providers.dart`) injects the real `Isolate.run`-backed runner; tests inject an
  inline runner and assert it was invoked for the CPU-bound stages.
- Pure stage functions extracted as **top-level** (isolate-sendable, closure-free):
  `decodePullBlockBytes(Uint8List raw, String mkHex) → String` and
  `validatePulledChain(List<Map<String,dynamic>> blocks) → void` (throw on invalid). These mirror the
  current `_pullBlock` deobfuscation and `_validateImportedChain` bodies exactly (behavior-preserving),
  so D4/D5 integrity is unchanged.

**Components in scope**

| File | Change |
|---|---|
| `lib/services/ledger_pull_service.dart` | Concurrent fetch loop; `offload` seam; extract pure `decodePullBlockBytes` / `validatePulledChain`; route cross-stage work through them |
| `lib/services/pull_stage_functions.dart` (new) | Top-level pure helpers `decodePullBlockBytes` / `validatePulledChain` (isolate-sendable) |
| `lib/data/storage/providers.dart` | Inject the production `OffloadRunner` into `ledgerPullServiceProvider` (and `syncService` if `pullIfRemoteHasMore` shares it) |
| tests | `test/services/ledger_pull_offload_test.dart` (new); extend `test/services/ledger_pull_service_test.dart` |

Guardrails preserved: **D4** (chain/entry validation still runs before import, now off-thread),
**D5** (append-only import unchanged), **D7** (per-entry crypto encapsulation unchanged),
**D9** (public `pullAll()` signature/returns unchanged), **D10** (new + regression tests).

---

## 2. Test Groups

### Group C: Concurrent block fetch — 5 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | Concurrent `pullAll` returns the same block set as sequential pull | Concurrency must be behavior-equivalent (D4/D9) | Prevents refactor from changing what blocks are downloaded |
| C2 | Blocks are imported in chain order (index order) regardless of fetch completion order | Ordering is load-bearing for prev_hash linkage | Concurrent completion must not scramble the chain |
| C3 | In-flight HTTP stays bounded (a counting `FakePullTransport` observes ≤ limit concurrent calls) | Bounded concurrency | Guards against firing 136 parallel requests at once |
| C4 | A blocked/slow single block does not stall the other blocks | Responsiveness under partial slowness | The ANR was caused by serialization; concurrency must not reintroduce it |
| C5 | A fetch failure reports the failed index and still returns the successfully-fetched blocks | Fail-partial semantics stable | Error handling of `PullResult` must not regress |

### Group O: Isolate offload of CPU-bound stages — 6 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| O1 | `decodePullBlockBytes` is invoked through the `offload` runner (runner called with a deobfuscation closure) | Off-thread deobfuscation actually occurs | This is the core ANR fix; must be exercised |
| O2 | `validatePulledChain` is invoked through the `offload` runner | Off-thread chain/entry-hash validation | Keeps D4 integrity while off the UI thread |
| O3 | Off-loaded deobfuscation output is byte-identical to the current in-thread result | Behavior-preserving move (D9) | Proves the extracted pure function matches today's `_pullBlock` exactly |
| O4 | A tampered entry hash still fails chain validation when off-loaded | D4 integrity preserved off-thread | Tampering must be detected regardless of isolation |
| O5 | Wrong MK → all blocks fail deobfuscation → `PullResult.failure` (unchanged) | Error behavior unchanged | Offload must not alter wrong-key handling |
| O6 | Default `offload` runner (production) is `Isolate.run`-backed; inline runner is injectable for tests | Seam contract | Defines the DI boundary and its test path |

### Group S: Seeding after concurrent + offloaded pull — 5 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| S1 | Staging is still seeded with all entries after a concurrent + offloaded pull | Restore still yields activities (the fix's goal) | Regression guard for the empty-History symptom |
| S2 | No duplicate staging rows across concurrently-fetched blocks | Dedup (activity_id/entry_id/hash) still applies | Concurrent fetch must not introduce duplicates (recall prior dedup fix) |
| S3 | Seeded row fields (title, start_epoch, duration, tags, date, activity_id, committed) are correct | Format contract for UI rendering | Offload must not disturb row shape |
| S4 | `pullIfRemoteHasMore` (freshness detector) still works unchanged | ADR-030 fast path intact | Concurrency/offload must not break the reauth-time light pull |
| S5 | Page-level call: `pullAll` result counts (`loaded`, `skipped`) reflect concurrent fetch correctly | Return-contract stability (D9) | Counters must match downloaded blocks |

### Group R: Restore integration (end-to-end regression for the ANR) — 4 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| R1 | `restoreFromCloud` completes and seeds entries from a multi-block remote (N ≥ 20 blocks) | Reproduce + fix the empty-History scenario | The live bug was >120 s UI-thread wedge; a large pull must now complete |
| R2 | `pullAll` completes (no ANR window) — returns `PullResult.ok` within a test wall-clock bound | The offload must keep the UI isolating responsive | Directly targets the ANR root cause |
| R3 | Failed big pull stays fail-open (local genesis preserved, no partial block import) | D5/D6 graceful degradation | Must not leave a half-imported ledger if offload fails |
| R4 | `importFromJson` runs only after concurrent fetch + validation succeeds | Ordering guarantee | DB writes must not precede validation (D4) |

### Group E: Edge & error cases — 5 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | Empty remote (no hash_index / empty list) → `PullResult.ok(0,0)`, no offload invoked | No-op short-circuit | Avoids isolate spin on an empty pull |
| E2 | Null transport → `PullResult.ok(0,0)` | Graceful no-transport | Existing contract (A10/H5) unchanged |
| E3 | Network failure on hash_index → `PullResult.failure` | Error surface unchanged | Must not throw an unexpected exception |
| E4 | Retry/skip: a transient per-block HTTP failure degrades gracefully (reported, does not abort the whole pull) | Robustness | Concurrent path must not 500 the entire restore on one bad block |
| E5 | MK not cached → `StateError` (unchanged) | Precondition intact | Offload must not mask the un-cached-MK guard |

---

## 3. Coverage Summary

| Group | Name | Assertions |
|---|---|---|
| C | Concurrent block fetch | 5 |
| O | Isolate offload of CPU-bound stages | 6 |
| S | Seeding after concurrent + offloaded pull | 5 |
| R | Restore integration (ANR regression) | 4 |
| E | Edge & error cases | 5 |
| **Total** | | **25** |

**Key coverage areas:** concurrency equivariance (C1), chain-order preservation (C2), bounded
parallelism (C3), off-load proof (O1/O2/O6), off-thread integrity (O4), result/return contract
stability (S5/R4), end-to-end ANR regression (R1/R2), graceful degradation (R3/E4), no-op and
error surfaces (E1–E5).

**Dependency notes (Phase 2):** tests inject an inline `OffloadRunner` so no real isolates spawn in
`flutter_test` (deterministic, fast). One optional true-`Isolate.run` smoke test (O6) can be marked
`@Tags(['isolate'])` to keep the default suite hermetic.

---

## 4. Phase 1 Deliverables

- [x] This blueprint (assertion table above) — **written (Phase 1)**.
- [x] DOX pass: add this doc to `docs/planning/AGENTS.md` child index; note the live-bug diagnosis.
- [x] `SESSION_HANDOFF.md`: record the fix as next-in-queue, plus the diagnosis.

---

## 5. Phase 2 (RED) Deliverables

- [x] **Test file:** `phpoc-flutter/test/services/ledger_pull_offload_test.dart` — 25 assertions
      (groups C/O/S/R/E), all runnable, hermetic (inline `CountingOffloadRunner`; a
      `ConcurrencyTrackingTransport` for concurrency assertions; base
      `FakePullTransport` mirrors `ledger_pull_service_test`).
- [x] **Seam skeleton:** `phpoc-flutter/lib/services/pull_stage_functions.dart` — top-level
      `decodePullBlockBytes`/`validatePulledChain` + `OffloadRunner` typedef +
      `isolateOffloadRunner` (production `Isolate.run`). Signatures land now so tests compile
      and fail on assertions; bodies throw `UnimplementedError` (Phase 3 fills them).
- [x] **LedgerPullService seam:** added optional named `offload` param (defaults to
      `isolateOffloadRunner`); additive — existing construction sites unchanged.
- [x] **RED surface (6):** O1/O2 (seam not routed through yet), O3/O4 (pure-fn skeletons throw
      `UnimplementedError` instead of real work), C3 (peak concurrency is 1, not >1), R2 (serial
      wall-time exceeds the bound).
- [x] **Guard-green (19):** C1/C2/C4/C5, O5/O6, S1–S5, R1/R3/R4, E1–E5 are behavior-preserving and
      pass today; they become meaningful once Phase 3 wires the seam. C4 is weaker (one slow block
      among fast ones); R2 is the definitive serialization/ANR regression test.
- [x] **No regressions:** full Flutter suite `+1973/-37` = rekey baseline `-31` (unchanged, gated
      C-2 RED) + `-6` new RED. Existing `ledger_pull_service_test`/`ledger_pull_staging_dedup_test`/
      `providers_test` all pass.

**Next:** Phase 3 (GREEN) — implement `decodePullBlockBytes`/`validatePulledChain` (move current
`_pullBlock` deobfuscation and `_validateImportedChain` bodies unchanged), replace the sequential
block loop with a bounded concurrent fetch (preserving chain order), route both CPU-bound stages
through `offload`, and wire the production `offload` into `providers.dart`.
