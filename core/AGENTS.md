# Core Orchestration

## Purpose
Wiring layer between CLI and domain — factory initialization, sync orchestration lifecycle, sync confirmation, and transport abstractions for remote staging.

## Ownership
- `core/activity_id.py` — `ActivityIdGenerator`: CSPRNG 10-char alphanumeric activity IDs for row-level staging
- `core/staging_hash_index.py` — `StagingHashIndex` + `StagingHashDiff`: compact manifest for O(1) staging change detection
- `core/factory.py` — `LedgerFactory`: ledger initialization, identity creation
- `core/ledger.py` — Legacy ledger code (being migrated to domain/ledger/)
- `core/sync/orchestrator.py` — `SyncOrchestrator`: full sync lifecycle (pull → merge → commit → verify → push)
- `core/sync/decision.py` — `SyncDecision`: data class for sync choices
- `core/sync/transport.py` — `AbstractStagingTransport`: abstract base for remote staging transports
- `core/sync/transport_registry.py` — `TransportProvider` dataclass, `TransportRegistry`: extensible transport discovery for onboarding
- `core/sync/http_transport.py` — `HttpStagingTransport`: HTTP GET/PUT/LIST + ETag
- `core/sync/git_transport.py` — `GitStagingTransport`: git-based remote staging
- `core/sync_confirmation.py` — Sync confirmation strategies

## Local Contracts
- `SyncOrchestrator` coordinates `StagingService` and `LedgerEngine` — does not own domain logic
- `AbstractStagingTransport` defines the remote staging interface (pull/push/list/delete)
- Zero external dependencies (pure Python stdlib only)
- All transports implement the same abstract interface

## Work Guidance
- **Cross-client sync plan**: `docs/planning/CROSS_CLIENT_REMOTE-LOCAL_STAGING_SYNC-RECONCILIATION_PLAN.md` — implementation plan and scorecard. Primary reference: `docs/reference/CROSS_CLIENT_STAGE_SYNCING_REFERENCE.md` §12 (abstract protocol workflow).
- Core coordinates but does not implement domain logic — delegate to domain/
- New transports must implement `AbstractStagingTransport`
- Sync lifecycle order: check_and_sync → commit → verify → push → ledger sync

## Verification
- Tests: `test_transport_registry.py`, `test_http_transport.py`, `test_git_transport.py`, `test_sync_confirmation*.py`, `test_phase5_main_wiring.py`, `test_phase6c_orchestrator_cli.py`

## Child DOX Index
- `core/sync/` — Sync transport, orchestrator, and decision logic
