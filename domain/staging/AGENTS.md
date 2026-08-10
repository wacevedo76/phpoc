# Staging Service

## Purpose
Staging area management for pending activity entries before they are committed to the immutable ledger. Handles auth gating, remote sync (pull/push), cross-device merge, and local caching.

## Ownership
- `service.py` — `StagingService`: auth gate, `check_and_sync()`, push, `_merge_remote_into_local()` (canonical-row reconcile, CCS-3)
- `remote_sync.py` — Blob obfuscation, pull/push, device cookie handling, `SyncCheckResult`
- `merge_engine.py` — Cross-device merge, deduplication by `entry_id`; `merge_rows()` activity_id LWW (CCS-3)
- `row_merge.py` — `dtoToCanonicalRow` / `canonicalRowToDTO` canonical-row bridge (CCS-3)
- `local_cache.py` — Local staging cache for offline/performance; `plain:` convention; row-mode (canonical) support for `SqliteStagingStore`

## Local Contracts
- Staging format uses `NoAuthCryptoManager` with `"plain:..."` prefix
- Sync converts hex-encrypted → plain: at the staging boundary
- Only one device can own staging at a time (device_specifier gating)
- Auth is required for write operations; reads can use fast-path cookie check
- Depends on `domain/cookie/` for device cookie logic

## Work Guidance
- **Cross-client sync plan**: `docs/planning/CROSS_CLIENT_REMOTE-LOCAL_STAGING_SYNC-RECONCILIATION_PLAN.md` — implementation plan and scorecard. Primary reference: `docs/reference/CROSS_CLIENT_STAGE_SYNCING_REFERENCE.md` §12 (abstract protocol workflow).
- Always gate write access through `StagingService`
- Use `check_and_sync()` before any operation
- Merge deduplicates by `activity_id` (LWW, local-wins-on-tie); `entry_id` is the legacy fallback — canonical rows consolidate cross-client duplicates
- Remote blob is obfuscated (not plain JSON)
- Reconcile at the canonical-row level (`row_merge.py` + `merge_rows`), committing-excluded before persistence

## Verification
- Tests: `test_phase2_staging_service.py`, `test_phase4_staging_interaction_flow.py`, `test_phase6a_staging_equivalence.py`, `test_staging_sync_optimization.py`, `test_cli_sync_gate_wiring.py` (CCS-3, 60 tests)

## Child DOX Index
None — flat directory structure.
