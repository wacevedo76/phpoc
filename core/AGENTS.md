# Core Orchestration

## Purpose
Wiring layer between CLI and domain — factory initialization, sync orchestration lifecycle, sync confirmation, and transport abstractions for remote staging.

## Ownership
- `core/factory.py` — `LedgerFactory`: ledger initialization, identity creation
- `core/ledger.py` — Legacy ledger code (being migrated to domain/ledger/)
- `core/sync/orchestrator.py` — `SyncOrchestrator`: full sync lifecycle (pull → merge → commit → verify → push)
- `core/sync/decision.py` — `SyncDecision`: data class for sync choices
- `core/sync/transport.py` — `AbstractStagingTransport`: abstract base for remote staging transports
- `core/sync/http_transport.py` — `HttpStagingTransport`: HTTP GET/PUT/LIST + ETag
- `core/sync/git_transport.py` — `GitStagingTransport`: git-based remote staging
- `core/sync_confirmation.py` — Sync confirmation strategies

## Local Contracts
- `SyncOrchestrator` coordinates `StagingService` and `LedgerEngine` — does not own domain logic
- `AbstractStagingTransport` defines the remote staging interface (pull/push/list/delete)
- Zero external dependencies (pure Python stdlib only)
- All transports implement the same abstract interface

## Work Guidance
- Core coordinates but does not implement domain logic — delegate to domain/
- New transports must implement `AbstractStagingTransport`
- Sync lifecycle order: check_and_sync → commit → verify → push → ledger sync

## Verification
- Tests: `test_http_transport.py`, `test_git_transport.py`, `test_sync_confirmation*.py`, `test_phase5_main_wiring.py`, `test_phase6c_orchestrator_cli.py`

## Child DOX Index
- `core/sync/` — Sync transport, orchestrator, and decision logic
