# Onboarding Restore & Import Fixes — Test Exploration (Phase 1)

> **Plan:** ad-hoc bug-fix task — make the 7 pre-existing failing tests in
> `phpoc-flutter/test/services/onboarding_service_test.dart` GREEN
> (G1, L2, L5, V2, V4, L4-End, L7-End).
> **Purpose:** Blueprint of every assertion + fix needed for each of the 7
> failures, classifying each as *fix-the-code* (real bug) or *fix-the-test*
> (bad assertion), before writing any test/code.
> **Status:** ✅ 4-Phase TDD COMPLETE (P1–P4)
> **Phases:** P1 (exploration) ✅, P2 (RED) ✅, P3 (GREEN) ✅, P4 (REFACTOR) ✅

## Background / Discovery

The 7 failures reproduce identically at `4bd51b4` (before this work) and at
`714f1ea` — they are **pre-existing** and unrelated to the Staging Auto-Sync
change. Investigation isolated **3 genuine code bugs** + **1 bad test
assertion**. All 7 map to those 4 clusters. The code lives in
`phpoc-flutter/lib/services/onboarding_service.dart` (+
`lib/core/crypto/crypto_service.dart` as reference).

## Architecture Overview

`OnboardingService` is the Flutter onboarding/restore entry point. Relevant
contracts (per `docs/design/TOP_LEVEL_DIRECTIVES.md`):

- **D8 Recoverability:** the genesis block is the *cryptographic root*; the seed
  must be recoverable from genesis. → every final ledger state must have a
  genesis block.
- **D9 Backward Compat:** an imported/pulled canonical (R2) genesis must be
  preserved, not replaced by a Flutter-format `{seed}` genesis.
- **D10 Testing:** each fix requires regression assertions.

### Key code paths

```
restoreFromCloud(seed, pp, url, key)           [lib/onboarding_service.dart ~111]
  └─ _ensureNoLedger(wipeExisting)             throws LedgerExists if genesis exists & !wipe
  └─ derive MK, setMasterKey
  └─ _pullFromCloud(...)                       connectWorker + ledgerPullService.pullAll()
     (fake pull returns PullResult.ok WITHOUT writing blocks)
  └─ result.success → _postImportSetup(passphrase, seed,
                                        keepExistingGenesis: true)
         └─ _storeSeedInVault                  always stores seed
         └─ keepExistingGenesis ? skip genesis build   ← BUG-1 (G1/V2/L4-End)
         └─ clientUUID, setHasExistingData

importFromFile(path, seed, pp)
  └─ _importV2 / _importV1 / _importRawChain
     └─ _writeStagingEntries(entries)          no-ops when syncService.stagingStore==null ← BUG-2 (L2/L5)
     └─ _postImportSetup(...)
```

## Test Groups

### Group A: Genesis root always exists after cloud restore — 5 tests (BUG-1)

Root cause (G1/V2/L4-End): `_postImportSetup(keepExistingGenesis: true)` **skips
genesis building unconditionally**, but a fake/empty pull writes no blocks. Result:
`db.blockDao` is empty → no ledger root (violates D8). Correct behavior: **build a
Flutter-format genesis IF AND ONLY IF no genesis exists**; when an R2/pulled
canonical genesis IS present, preserve it (D9). This satisfies both the empty-pull
case and the preserve-canonical case, and is consistent with the Ph-7 Path-B fix.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | After `restoreFromCloud` with an empty pull, at least one genesis block exists in the DB | Genesis is the D8 cryptographic root; a restore must leave a recoverable ledger | Without it `reauthenticate()`/recovery cannot derive the seed from genesis |
| A2 | That genesis carries an encrypted seed (`data_enc.length > 10`) and `identity_seal` is present | The genesis must be usable for seed recovery (D8) | A genesis with no seal is worthless for reauth |
| A3 | When an R2/canonical genesis is pre-seeded (or pulled), `restoreFromCloud` **preserves** its `blockId` rather than replacing it | Do not destroy an existing canonical genesis (D9, Ph-7 Path-B) | Replacing a canonical genesis breaks chain verification |
| A4 | `restoreFromCloud` returns `success: true` even when the pull provided no blocks (empty restore still yields a valid local ledger) | Empty remote must not strand the user with a broken ledger | A partial restore must still produce a functioning, verifiable ledger |
| A5 | The vault (`recovery_seed_enc`) is populated during the same restore | Seed storage is independent of genesis presence | Vault + genesis are two layers of the same seed; both must exist |

### Group B: restoreFromCloud adopts an existing ledger (V4) — 3 tests

Root cause (V4): the test pre-seeds an R2 genesis+day block (with block-1
`prev_hash` → R2 genesis) then calls `restoreFromCloud` **without
`wipeExisting: true`**, but `_ensureNoLedger(false)` throws
`LedgerExistsException`. Correct behavior: cloud restore into an area that already
has a compatible/well-formed chain **adopts it** (keeps the existing chain, does
not replace its genesis or rewrite block-1 `prev_hash`) instead of throwing — while
`createNewLedger`/`importFromSeed`/`importFromFile` keep the strict
`LedgerExistsException` guard (a *different* existing ledger should not be silently
overwritten).

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | `restoreFromCloud` over an existing R2 genesis+day chain does **not** throw | Cloud restore may run into a chain already seeded from R2 | A usable restored ledger must not be blocked merely because blocks already exist |
| B2 | Block index 1's `prev_hash` still points at the R2 genesis after the restore (unchanged) | Do not mutate historical chain linkage (D5 append-only, D4 chain trust) | Rewriting prev_hash would break chain verification downstream |
| B3 | The R2 genesis `blockId` is identical before and after restore | Genesis identity is immutable once adopted (D9) | A changed genesis implies an integrity break |
| B4 | `createNewLedger`/`importFromSeed` still throw `LedgerExistsException` when a ledger exists and `wipeExisting` is false | The strict guard is scoped to *creation* flows, not restore | Safety: creation must not silently overwrite an unrelated existing ledger |

### Group C: importFromFile writes staging entries regardless of row-level store — 4 tests (BUG-2)

Root cause (L2/L5): `_writeStagingEntries` does `if (syncService.stagingStore ==
null) return;` — silently dropping all staging entries when the legacy
(non-row-level) SyncService is used (as in `_makeOnboarding`). Correct behavior:
write staging entries to the row-level `stagingStore` **when available**, else fall
back to the legacy `entries` table (`db.entryDao`) via `LocalCache`. A v1/v2 import
must never silently discard the user's staging data.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | After a v2 import with the legacy SyncService (no `stagingStore`), the legacy `entries` table is non-empty | Staging entries must survive import even in the legacy path | Dropping staging on import loses user data |
| C2 | After a v1 import with the legacy SyncService, the `entries` table is non-empty and **no** non-genesis ledger blocks exist | v1 is staging-only; its entries must land somewhere | v1 export has no ledger blocks — staging is the only output |
| C3 | After a v2 import with a row-level `stagingStore`, rows are written to `stagingStore` (not the legacy table) | Preserve the row-level path when available | Both staging backends must work |
| C4 | The imported staging entry preserves its `entry_id` / `activity_id` and core fields | Imported data must round-trip accurately | Field fidelity prevents dangling/mismatched staging entries |

### Group D: Vault seed accuracy on passphrase change (L7-End) — 2 tests (fix-the-test)

Root cause (L7-End): `createNewLedger` generates a **random** 32-byte seed via
`crypto.generateSeed()`. The test decrypts the vault seed and asserts it equals the
hardcoded constant `validSeedB64` (= 32×`0x42`). This is a **broken assertion** —
the vault legitimately stores the *random* seed, not the constant. Correct test:
decrypt the vault seed and assert it equals the `seed` value returned by
`createNewLedger`, with the same passphrase (D8: passphrase-derived PDK unlocks the
seed).

> Note: this confirms the *implementation* is correct (random seed stored + PDK
> decrypts it). Only the test's fixed-constant comparison is wrong. Phase 2 rewrites
> the assertion; Phase 3 makes **no source change** for this case (or only doc/name
> hygiene).

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | `createNewLedger(pp)` returns seed `S`; decrypting the vault with PDK(pp) yields exactly `S` | The stored seed must round-trip through the PDK vault | Verify the vault holds the same seed that was created |
| D2 | After the mock `changePassphrase` re-encrypt step, the old PDK can no longer decrypt but the new PDK can, recovering `S` | Passphrase change correctly re-encrypts (not corrupts) the seed | Guards re-encryption integrity (D2/D8) |

## Coverage Map & Classification Summary

| Failing test (group) | Cluster | Fix category | Source change (Phase 3) |
|----------------------|---------|--------------|--------------------------|
| G1 | A (genesis root on restore) | code | `_postImportSetup` genesis-existence fallback |
| V2 | A | code | same |
| L4-End | A | code | same |
| V4 | B (adopt existing on restore) | code | `restoreFromCloud` adopt-existing + guard scope |
| L2 | C (staging write on import) | code | `_writeStagingEntries` legacy fallback |
| L5 | C | code | same |
| L7-End | D (vault seed assertion) | test | `onboarding_service_test.dart` assertion (no source) |

## Summary Report

- **Total assertions:** 14 (A1–A5, B1–B4, C1–C4, D1–D2)
- **By group:** Group A = 5 (genesis root, D8), Group B = 3 (adopt existing),
  Group C = 4 (staging fidelity), Group D = 2 (vault accuracy)
- **Fix-the-code:** 13 assertions → `onboarding_service.dart` (3 code changes:
  genesis fallback, adopt-existing restore, staging-write fallback)
- **Fix-the-test:** 1 assertion → test file only (L7-End vault round-trip)
- **Files to modify (Phase 2/3):**
  - `phpoc-flutter/lib/services/onboarding_service.dart`
  - `phpoc-flutter/test/services/onboarding_service_test.dart`

## Key Coverage Areas
1. Every final ledger state has a genesis root (D8) — including cloud restore with an empty/partial pull
2. Canonical/pulled genesis is preserved, not replaced (D9), and existing chain linkage (block-1 prev_hash) is never mutated (D4/D5)
3. v1/v2 import staging entries survive in both the row-level and legacy staging backends (no silent data loss)
4. The vault seed round-trips exactly through the PDK used at creation / after passphrase change
5. Restore guard scope: strict `LedgerExistsException` remains for creation/seed/import; restore adopts a compatible existing chain
