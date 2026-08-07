# PH Ledger — Session Handoff

> **Agent:** On first read, run `git log --oneline -5 && echo "---changed-files---" && git diff --stat HEAD~2` to load recent context.
> Before making edits, consult the Documentation Impact Contract in root `AGENTS.md`.
> For architectural decisions, read `docs/design/TOP_LEVEL_DIRECTIVES.md` first — D1–D10 are the binding principles.
>
> **⚠️ Git operations require user approval.** Never run `git commit` or `git push` automatically. Ask first.
>
> **Full issue queue:** `docs/planning/BACKLOG.md`

## Current State
- **Branch:** `Flutter-features_and_ux`
- **Flutter test suite:** 1544/1586 passing (42 failing: all pre-existing)
- **Remote sync E2E:** 8/8 GREEN (requires `--timeout 180s`)

## Cross-Client Staging Sync — Reference Chain
- **Plan:** `docs/planning/CROSS_CLIENT_REMOTE-LOCAL_STAGING_SYNC-RECONCILIATION_PLAN.md` — phases, scorecard, dependencies
- **Protocol:** `docs/reference/CROSS_CLIENT_STAGE_SYNCING_REFERENCE.md` §12 — abstract state machine (18 gates, merge algorithm, invariants)
- **Backlog:** `docs/planning/BACKLOG.md` §CCS — consolidated task tracking

## Immediate Next Steps 🎯

### ✅ CCS-1b: 4-Phase TDD Complete ✅

**Blueprint:** `docs/planning/CCS1b_PHASE1.md` — 16 assertions across 5 groups (A–E)
**Phase 2:** 11 RED tests → `phpoc-flutter/test/core/crypto/crypto_service_test.dart` Group L
**Phase 3:** 11 GREEN → `phpoc-flutter/lib/core/crypto/crypto_service.dart` `obfuscateBlobDeterministic()`
**Phase 4:** 1 improvement — extracted `_obfuscateBlobCore()` (modularity: eliminated ~30 lines of duplication between `obfuscateBlob()` and `obfuscateBlobDeterministic()`; clarity: now clear both methods share the same wire format via a single implementation)
**Full suite:** 85/85 crypto tests GREEN, 1544/1586 total

### Next Up
- **CCS-2:** Web — wire `RowStagingStore` + `StagingHashIndex` + `mergeEntries` into `sync.js`
- **CCS-3:** CLI — build `SqliteStagingStore`, switch to activity_id LWW, wire into `StagingService`
- **CCS-4:** Cross-client E2E testing (Flutter↔Web, Flutter↔CLI, Web↔CLI)

---

## Flutter Mobile App
- **Flutter:** 3.44.6 (stable) | **Emulator:** `pixel_6_avg` (API 35, x86_64)
- **Tech stack:** Riverpod + go_router + SQLite + SharedPreferences + flutter_secure_storage
- **Test creds:** `TEST_CREDENTIALS.md` (gitignored)

## Known Issues
- 2 pre-existing `restore_integration` flaky tests (G3, G8) — pass in isolation, fail in full suite due to test isolation
- `_pushBlobOnly()` + `StagingPaths.remoteStagingBlob` — old-path zombie (line 738, `staging/blobs/current.json`). Only hit when `stagingStore == null` (legacy LocalCache fallback, never reached in normal operation). Remove after legacy path cleanup.

