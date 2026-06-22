# Storage Layer

## Purpose
Abstract storage interfaces and file-based implementations for all persistence I/O — ledger, staging, index, identity, and config data.

## Ownership
- `interface.py` — Abstract base classes: `AbstractLedgerStore`, `AbstractStagingStore`, `AbstractIndexStore`, `AbstractIdentityStore`, `AbstractConfigStore`
- `ledger_store.py` — Ledger storage interface
- `staging_store.py` — Staging storage interface
- `index_store.py` — Index storage interface
- `identity_store.py` — Identity storage interface
- `config_store.py` — Config storage interface
- `file_store.py` — File-backed implementations
- `implementations/file_ledger.py` — File-based ledger storage
- `implementations/file_staging.py` — File-based staging storage
- `implementations/file_index.py` — File-based index storage
- `implementations/file_identity.py` — File-based identity storage
- `implementations/file_config.py` — File-based config storage

## Local Contracts
- All storage access goes through abstract interfaces — never read/write files directly from domain or CLI
- Data directory resolution order: `--dir` flag → `$PHPOC_DATA_DIR` env → `storage.data_dir` in config → XDG default → legacy fallback
- Config file resolution: `--config` flag → `$PHPOC_CONFIG` env → XDG default
- New backends (SQLite, etc.) must implement the same abstract interfaces

## Work Guidance
- Use abstract interfaces as type hints in domain and core
- File-based implementations are the reference backend
- Never import storage implementations directly in non-storage code — use the interfaces

## Verification
- Tests: `test_phase1_storage_interfaces.py`, `test_phase1b_view_interface.py`

## Child DOX Index
- `storage/implementations/` — File-backed storage implementations
