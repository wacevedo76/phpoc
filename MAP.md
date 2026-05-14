# PHPOC — Project Map

## File Inventory
Each file annotated **[HOT]** (active dev area — re-read if in scope)
or **[COLD]** (stable — skip unless handoff says otherwise).

### Source (18 files, ~3,500 lines)

| File | Lines | Temp | Key contents |
|---|---|---|---|
| `main.py` | 462 | HOT | CLI entry — argparse dispatch to all commands, `_handle_config_command`, `_config_generate_template` |
| `cli/interface.py` | 426 | COLD | Display: `view_active`, `show_rep`, `list_habits`, `_print_entry`, `_resolve_date_filters` |
| `cli/strategies.py` | ~150 | COLD | View-based InteractiveCLIStrategy (new, co-exists with `core/sync_confirmation.py` shim) |
| `core/ledger.py` | 855 | COLD | Domain: `capture_habit`, `end_habit`, `pause/unpause`, `sync_day_with_selection`, `sync_with_strategy`, `verify` (try-both extensible+legacy content hash), `revert_entries` — thin backward-compat wrapper over engine |
| `core/sync/__init__.py` | 9 | COLD | Package — re-exports SyncDecision, SyncStrategy, SyncOrchestrator, AbstractStagingTransport |
| `core/sync/decision.py` | 93 | COLD | SyncDecision dataclass + SyncStrategy abstract base |
| `core/sync/transport.py` | 45 | COLD | AbstractStagingTransport interface (pull/push) |
| `core/sync/orchestrator.py` | 209 | COLD | SyncOrchestrator — sync lifecycle coordinator |
| `core/sync_confirmation.py` | 530 | COLD | Deprecated shim preserving old InteractiveCLIStrategy for test compat |
| `core/factory.py` | 69 | COLD | `LedgerFactory.initialize()` — creates genesis + identity |
| `security/crypto.py` | 204 | HOT | Pure AES-CTR + HMAC-SHA256. `CryptoManager`, `NoAuthCryptoManager` — decrypt() fallback-to-legacy fix for identity secret encrypted pre-R1 |
| `security/auth.py` | 119 | COLD | `PassphraseAuthenticator` (PBKDF2 600K → decrypt seed → `/dev/shm` cache) |
| `security/recovery.py` | 33 | COLD | Seed gen (32B urandom→base64), `seed_to_key`, encrypt/decrypt_seed |
| `security/config_manager.py` | 130 | COLD | `ConfigManager` — dot-notation get/set, defaults merging, nested write |
| `storage/file_store.py` | 49 | COLD | JSON file I/O: staging, ledger, index, identity |
| `storage/interface.py` | 36 | COLD | `AbstractLedgerStore` ABC |
| `storage/config_store.py` | 33 | COLD | `AbstractConfigStore` ABC |
| `storage/implementations/file_config.py` | 105 | COLD | `FileConfigStore`, `_resolve_config_path()`, `_resolve_data_dir()` |
| `domain/ledger/engine.py` | ~400 | COLD | `LedgerEngine` — new layered ledger operations (commit, verify, revert) |
| `domain/ledger/chain.py` | ~450 | HOT | Chain building, sealing, verification logic — legacy content_hash fallback fixed to decrypt _enc fields |
| `domain/ledger/index_manager.py` | ~200 | COLD | Blind index update, rebuild, date-key cleanup |
| `domain/staging/service.py` | ~300 | COLD | `StagingService` — staging CRUD with crypto |
| `domain/staging/merge_engine.py` | ~150 | COLD | Multi-device merge logic (skeleton) |

### Tests (16 files, ~10,000 lines)

| File | Lines | Scope |
|---|---|---|
| `tests/test_modular.py` | 271 | Main integration test — init, add, sync, verify lifecycle |
| `tests/test_sync_confirmation.py` | 902 | Sync strategy unit tests |
| `tests/test_sync_confirmation_refactor.py` | 970 | Sync strategy refactor tests |
| `tests/test_sync_confirmation_strategy.py` | 818 | Strategy-specific tests |
| `tests/test_pause.py` | 688 | Pause/unpause cascades |
| `tests/test_tags.py` | 790 | Tag normalization & listing |
| `tests/test_recovery.py` | 96 | Recovery flow |
| `tests/test_hierarchy.py` | 100 | Year/month transition blocks |
| `tests/test_phase1_storage_interfaces.py` | ~600 | Phase 1: Storage abstract interfaces + implementations |
| `tests/test_phase1b_view_interface.py` | ~500 | Phase 1b: View interface implementations |
| `tests/test_phase2_staging_service.py` | ~800 | Phase 2: StagingService, device identity |
| `tests/test_phase3_ledger_engine.py` | ~1200 | Phase 3: LedgerEngine, chain, index manager |
| `tests/test_phase4_staging_interaction_flow.py` | 1288 | Phase 4: 69 tests — SyncDecision, SyncOrchestrator, sync lifecycle |
| `tests/test_phase5_main_wiring.py` | ~500 | Phase 5: main.py wiring, CI strategies |
| `tests/test_phase6a_staging_equivalence.py` | ~200 | Phase 6: Staging equivalence tests |
| `tests/test_phase6b_ledger_equivalence.py` | ~200 | Phase 6: Ledger equivalence tests |
| `tests/test_phase6c_orchestrator_cli.py` | ~400 | Phase 6: Orchestrator + CLI interaction |
| `tests/test_phase7_config_integration.py` | ~500 | Phase 7: 34 tests — config path resolution, CLI config commands, template generation |

### Scripts (2 files, 480 lines)

| File | Lines | Purpose |
|---|---|---|
| `scripts/migrate_format_version.py` | 616 | Format migration v0.2.0→v0.3.0 + v0.3.0→v0.4.0 |
| `scripts/repair_staging.py` | 113 | Convert hex-encrypted staging fields to plain: format |

### Key docs
| File | Lines | Use when... |
|---|---|---|
| `PHPSPEC.md` | 1,529 | Need block structure, encryption format, chain validation spec, content hash (extensible + legacy) |
| `VISION.md` | ~200 | Protocol philosophy, use cases |
| `SESSION_HANDOFF.md` | ~250 | Detailed session history, full crypto checklist |
| `BACKLOG.md` | ~430 | Task-level tracking |
| `ROADMAP.md` | ~250 | Feature roadmap |
| `DESIGN_MULTI_DEVICE_SESSION.md` | ~120 | Multi-device session & staging architecture design exploration (D2) |
| `ARCHITECTURAL_DECISIONS.md` | ~580 | Formal ADR document — ADR-001 through ADR-018 |
| `ARCHITECTURAL_MIGRATION_STRATEGY.md` | ~2,000 | Multi-phase refactoring from monolithic to layered architecture |

---

## Architecture Invariants (NEVER break these)

1. **Zero external dependencies** — pure Python stdlib only. No pip installs.
2. **Master Key** = 32 bytes from base64-decoded seed (`RecoveryManager.seed_to_key`)
3. **Staging format** = `NoAuthCryptoManager` uses `"plain:..."` prefix. Sync converts hex-encrypted → plain: at the boundary.
4. **Chain structure**: `Genesis → (Year Summary → Month Summary)* → Day blocks`, each sealed + signed
5. **Blind index** (`index.json`): `{date: {title: total_ms}}` — plaintext, queryable without decryption
6. **Content hash**: SHA-256 of resolved plaintext fields — survives re-encryption
7. **Config file**: XDG-resolved (`~/.config/phpoc/config.json` by default) — contains all settings as commented defaults
8. **Data directory**: XDG-resolved (`~/.local/share/phpoc/` by default) — holds ledger.json, staging.json, index.json, identity.json
9. **CLIInterface constructor**: `CLIInterface(staging_service, ledger_engine, crypto)` — no `self.ledger` references

---

## Quick Refs

| Action | Command |
|---|---|
| Run CLI | `PYTHONPATH=. python3 main.py <command>` |
| Run all tests | `PYTHONPATH=. python3 -m unittest discover -s tests` |
| Run single test file | `PYTHONPATH=. python3 -m unittest tests.test_<name>` |
| Run single test | `PYTHONPATH=. python3 -m unittest tests.test_<name>.TestClass.test_method` |
| Test count | 941/941 passing |
| Session cache | `/dev/shm/phpoc_session` (Master Key, chmod 600) |

### Config commands

| Command | Description |
|---|---|
| `phpoc config show` | Print full active config as JSON (user values merged with defaults) |
| `phpoc config get <key>` | Read one config value by dot path (e.g. `auth.cache_timeout_minutes`) |
| `phpoc config set <key> <val>` | Write one config value (value is JSON-parsed, falls back to string) |
| `phpoc config init` | Generate a fully-commented config template at the config path |
| `phpoc --config <path>` | Override config file path for this invocation |
| `phpoc --dir <path>` | Override data directory for this invocation (all commands) |

### Path resolution

| Priority | Variable / Path | Purpose |
|---|---|---|
| 1 (highest) | `phpoc --dir <path>` | CLI flag overrides everything for this one invocation |
| 2 | `$PHPOC_DATA_DIR` env var | Per-session override via environment |
| 3 | `storage.data_dir` in config.json | Persistent per-ledger setting (set via `phpoc config set storage.data_dir <path>`) |
| 4 | `$XDG_DATA_HOME/phpoc/` | XDG default (fallback: `~/.local/share/phpoc/`) |
| 5 (lowest) | `~/.config/personal_history_poc/` | Legacy fallback (auto-detected if new path doesn't exist) |

**Config file path** (separate from data dir, always independent):

| Priority | Variable / Path |
|---|---|
| 1 (highest) | `phpoc --config <path>` |
| 2 | `$PHPOC_CONFIG` env var |
| 3 | `$XDG_CONFIG_HOME/phpoc/config.json` (fallback: `~/.config/phpoc/`) |
