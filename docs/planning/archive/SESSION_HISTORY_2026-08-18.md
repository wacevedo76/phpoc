# Session History — 2026-08-18

Merged milestone detail, condensed out of `SESSION_HANDOFF.md` to keep it under 100 lines.

## day_index corruption on push/export — FIXED + VALIDATED (emulator)
`PhpSpecFormat.blockToMap` (shared by push + export) emitted `day_index = block.blockIndex`
(DB array position) instead of the sealed day_index carried in `data_enc`. Once month/year summary
blocks interleave, a day block's array index diverges from its true day sequence (blocks 132/133,
dates 08-14/15, had array pos 132/133 but sealed day_index 122/123) → the remote R2 blobs carried a
day_index the `day_hash` was never sealed over, so any pull + `verify()` failed the block seal
(emulator). **Fix:** prefer `encodedMap[kDayIndex]`, fall back to `blockIndex` only for legacy
entries-only data_enc. Regression test `ledger_day_index_roundtrip_test.dart` (RED without, GREEN
with). **Remote repaired** via `tool/repair_remote_blocks.dart` (re-pushed 000132/000133 from phone
DB with correct canonical day_index; hashes unchanged). **Emulator restore now verifies**:
`tool/diag_verify.dart` → `verify(): true`, ALL CHECKS PASSED (134 blocks; blocks 132/133 now
correct day_index 122/123). Root cause: blocks 132/133 were built post-phone-repair against a
truncated chain (reused day_index 122/123), then miscalized on push. Diagnostics kept in
`phpoc-flutter/tool/` (`diag_verify.dart`, `repair_remote_blocks.dart`, `verify_serialized_local.dart`).

## Deleted staged entry resurrects on next sync — FIXED
Deleting an activity on the entry screen only removed the LOCAL row; `sync.remove` never removed it
from the remote `staging/blob`, so the next `_reconcileAndClaimRowLevel` pull+merge re-inserted it
(mergeEntries treats a remote-only row as authoritative). Observed live: Push-ups `xZ30dtTwvn`
(ended, no commit flag) kept coming back after delete ×2 while phone synced to the Worker. **Fix:**
`sync.remove` now tombstone-propagates — deletes the local row AND pushes the remaining local staging
to remote (overwriting the blob WITHOUT the deleted row) before scheduling the debounced auto-sync,
mirroring the commit-move pattern in `commitAndSync`. Regression test
`test/data/sync/delete_resurrect_test.dart` (RED→GREEN, in-memory round-trip blob transport).
Baseline-verified: zero new failures; `sync_service_test` delete-path improved.

## Flaky ordering tests in sync_service_test — FIXED (E15/L4/N12)
`getEntries()`/`getAllRows()` order by random `activity_id ASC` (ids via `Random.secure()`); tests
asserting positional order (`entries[i]`) or positional `modify(<int>, …)` over multiple rows failed
~50–70% of runs (E15 empirically 7/10). Fixed in-test by resolving by title (`firstWhere` /
`modify('Title', …)`) instead of position — order-independent, deterministic. `sync_service_test.dart`
now passes 105/105 consistently. Test-only change, zero new failures.
