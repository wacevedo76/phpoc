# Python Test Suite

## Purpose
Comprehensive test suite for the Python reference implementation of PH Ledger. Covers all phases of development from storage interfaces through full integration testing.

## Ownership
- `conftest.py` — Shared fixtures: `TransportSpy`, cookie helpers, staging blob factories
- `test_modular.py` — Modular unit tests
- `test_hierarchy.py` — Chain hierarchy tests
- `test_recovery.py` / `test_recovery_verify.py` — Recovery and seed management
- `test_phase1_storage_interfaces.py` — Storage interface tests
- `test_phase1b_view_interface.py` — View interface tests
- `test_phase2_device_identity.py` — Device identity tests
- `test_phase2_staging_service.py` — Staging service tests
- `test_phase3_ledger_engine.py` — Ledger engine tests
- `test_phase4_staging_interaction_flow.py` — Staging interaction flow (69 tests)
- `test_phase5_main_wiring.py` — Main wiring tests
- `test_phase6a_staging_equivalence.py` — Staging equivalence
- `test_phase6b_ledger_equivalence.py` — Ledger equivalence
- `test_phase6c_orchestrator_cli.py` — Orchestrator CLI tests
- `test_phase7_config_integration.py` — Config integration tests
- `test_transport_registry.py` — TransportRegistry + TransportProvider tests (50 tests)
- `test_http_transport.py` — HTTP transport tests (68 tests)
- `test_git_transport.py` — Git transport tests
- `test_sync_confirmation*.py` — Sync confirmation tests (3 files)
- `test_staging_sync_optimization.py` — Staging sync optimization (85 tests + cross-device handoff)
- `test_cross_platform_integration.py` — Live Worker integration: blob/cookie/ledger round-trips, full staging cycle, format markers
- `test_tags.py` — Tags tests
- `test_daemon.py` / `test_daemon_sync.py` — Daemon tests
- `test_background_sync.py` — Background sync tests
- `test_wal.py` — Write-ahead log tests
- `test_pause.py` — Pause tests
- `test_date_filters.py` — Date filter tests
- `test_remote_config_wiring.py` — Remote config wiring
- `test_cross_platform_integration.py` — Cross-platform live integration tests (CLI ↔ Worker)
- `test_pbkdf2_per_user_salt.py` — Per-user PBKDF2 salt: derivation, auth upgrade, init flow, passphrase change, integration (29 tests, I-05)

## Local Contracts
- **33 test files, ~14,800 lines, 1583 tests passing (I-05 Phase 2 RED added 2026-07-15)**
- Run all: `python3 -m pytest`
- Run single file: `python3 -m pytest tests/test_<name>.py -v`
- Run with warnings: `python3 -m pytest -W ignore::DeprecationWarning`
- Uses RAM-backed disk for integration tests
- `PYTHONPATH=.` must be set before running
- Configuration in `pytest.ini`
- TESTS ARE THE SINGLE SOURCE OF TRUTH. DO NOT MODIFY PRODUCTION CODE WITHOUT COVERAGE

## Work Guidance
- Tests must pass before any change is considered complete
- Add tests for new functionality before or alongside implementation
- Use `conftest.py` fixtures for shared setup
- Phase-numbered tests reflect development history — maintain the numbering for new phases
- **Remote/live tests:** Use credentials from `TEST_CREDENTIALS.md` (gitignored) for Worker access. Set `PHPOC_CLOUDFLARE_API_KEY` env var before running `test_cross_platform_integration.py`.

## Verification
- Test suite itself verifies correctness
- 1493 tests, all passing as of last run

## Child DOX Index
None — flat directory structure.
