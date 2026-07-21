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
- `file_store.py` — File-backed implementations (Python)
- `implementations/file_ledger.py` — File-based ledger storage (Python)
- `implementations/file_staging.py` — File-based staging storage (Python)
- `implementations/file_index.py` — File-based index storage (Python)
- `implementations/file_identity.py` — File-based identity storage (Python)
- `implementations/file_config.py` — File-based config storage (Python)

### Flutter Storage (phpoc-flutter/)
- `phpoc-flutter/lib/data/storage/database.dart` — AppDatabase + EntryDao, BlockDao, IndexEntryDao
- `phpoc-flutter/lib/data/storage/row.dart` — Row + SelectResult query helpers
- `phpoc-flutter/lib/data/storage/index_entry.dart` — IndexEntry model
- `phpoc-flutter/lib/data/storage/preferences.dart` — AppPreferences (SharedPreferences wrapper)
- `phpoc-flutter/lib/data/storage/secure_preferences.dart` — SecurePreferences (flutter_secure_storage wrapper)
- `phpoc-flutter/lib/data/storage/providers.dart` — Riverpod providers (databaseProvider, entryDaoProvider, blockDaoProvider)

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
- Python tests: `test_phase1_storage_interfaces.py`, `test_phase1b_view_interface.py`
- Flutter tests: `test/data/storage/` — 8 files, 100 tests (Groups A–K), `flutter test` passes

## Child DOX Index
- `storage/implementations/` — File-backed storage implementations
