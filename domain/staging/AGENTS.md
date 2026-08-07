# Staging Service

## Purpose
Staging area management for pending activity entries before they are committed to the immutable ledger. Handles auth gating, remote sync (pull/push), cross-device merge, and local caching.

## Ownership
- `service.py` — `StagingService`: auth gate, `check_and_sync()`, push, sync coordination
- `remote_sync.py` — Blob obfuscation, pull/push, device cookie handling, `SyncCheckResult`
- `merge_engine.py` — Cross-device merge, deduplication by `entry_id`
- `local_cache.py` — Local staging cache for offline/performance

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
- Merge engine deduplicates by `entry_id` — never create duplicates
- Remote blob is obfuscated (not plain JSON)

## Verification
- Tests: `test_phase2_staging_service.py`, `test_phase4_staging_interaction_flow.py`, `test_phase6a_staging_equivalence.py`, `test_staging_sync_optimization.py`

## Child DOX Index
None — flat directory structure.
