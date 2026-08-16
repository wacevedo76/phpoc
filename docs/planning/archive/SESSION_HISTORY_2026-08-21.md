# Session History — 2026-08-21

Merged milestone detail, condensed out of `SESSION_HANDOFF.md` to keep it under 100 lines.

## Commonplace Book — 4-PHASE TDD COMPLETE
ADR-031 separate sealed `commonplace.json` chain (same seed→same MK, own genesis, not tied to the activity
ledger; schema `title`/`tags`/`entry` + optional ad-hoc k/v, no `comment`; append-only day-grouped sealed
commits; all content encrypted; staging→commit D11; Flutter-first).
- **Phase 3 (GREEN) 55/55:** `lib/data/commonplace/` — `commonplace_chain.dart` (genesis/day-block seal,
  encrypt-at-rest, append/truncate/verify), `commonplace_engine.dart` (commit date-grouped, verify, read
  decrypts), `commonplace_storage.dart` (separate `commonplace.json` save/load, block-store contract).
  Test-fixture fixes (Phase 2 latent bugs): `_genHash` `Map→String`; CP-D2 timestamps spanned 2 UTC days →
  A/B/C moved to Nov 14 & D to Nov 15; null-safe `getLastBlock()!` (3 sites); CP-C2 double-append
  `build:true→false`; `_dayBlockWith` default `build:false` (fixed C5/C7/C8). No source regressions (44
  pre-existing failures, none in commonplace).
- **Phase 4 (REFACTOR):** extracted shared `SealableChain` mixin (`lib/data/ledger/sealable_chain.dart`)
  consolidating HMAC seal compute/verify, identity MAC, prev_hash linkage, day-block count,
  sealBlock/verifyBlockSeal (ADR-029/029a). Both `LedgerChain` + `CommonplaceChain` `with` it → removed
  ~105 dup lines from `chain.dart` (476→371) + ~65 from `commonplace_chain.dart` (521→456); merged
  duplicated `type=='commonplace'` verify gate; removed dead engine marker. **349/349 GREEN** (55
  commonplace + 294 ledger data/backup-fidelity/integration), analyzer clean; 29 pre-existing
  data/service failures unchanged (verified at baseline). Follow-ons: UI, sync, rotation, blind index.

## Staging-seed dedup fix — 4-PHASE TDD COMPLETE
Blueprint `STAGING_SEED_DEDUP_FIX_PHASE1.md` (S:6, I:5, U:3=14). P1 (dedup by `activity_id`) + P2 (reuse
`data['activity_id']`, not `generateActivityId()`) in `_seedStagingFromBlocks` (ledger_pull_service) +
`_seedStagingFromImportedBlocks` (onboarding_service). Tests 11/11 GREEN. Phase 4: shared `StagingSeedDeduper`
+ `resolveSeedActivityId()` in `lib/services/staging_seed_helpers.dart` (~20 dup lines/call-site removed;
regression proven by baseline diff: services 380 pass/25 fail vs baseline 371/33, zero new failures).

## Phone ledger repair — DONE
Deployed fixed debug build to `RFCW50FZQPJ` (`install -r`, debug preserved) + repaired live DB: dropped 4
local-only blocks (132–135) and 8 re-seed staging rows. Phone chain now == clean remote 132, staging
288→280, no dups, app launches clean. Backups on-host `/tmp/phpoc_phone_backup/pre_repair_20260814_124924/`
+ on-device `app_flutter/repair_backup_pre/`. Post-repair sync CLOSED OUT: remote stable 132, staging
hash_index 280 unique, fix held on 5s periodic sync; `I4FjqLRKT3` present local+remote (committed staging
rows are a denormalized display cache, so block-135 removal orphaned it from the ledger but it survives in
staging — expected).

## WEB connectToWorker full-chain fix — DONE
`588b034` regression made Web `connectToWorker` pull only genesis + rebuild by re-committing the staging
blob. Fixed to fetch full `ledger/blocks/` chain via `WorkerImportSource.fetchChain`, write to `ledger:blocks`,
keep only genuinely-uncommitted staging rows (D11). Matches `f1b466c` canonical blocks format.
`worker_connect_fullchain_regression.test.mjs` 23/23 GREEN; verified on personal ledger R2 (132 blocks).
**BLANK-CARD fix:** convert each uncommitted staging row via `canonicalRowToDTO` + `LocalCache.writeEntries`
so Sync cards render full fields (C6/C7 assert title + start_epoch survive round-trip).
