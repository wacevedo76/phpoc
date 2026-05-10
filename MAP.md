# PHPOC — Project Map

## File Inventory
Each file annotated **[HOT]** (active dev area — re-read if in scope)
or **[COLD]** (stable — skip unless handoff says otherwise).

### Source (10 files, 2,649 lines)

| File | Lines | Temp | Key contents |
|---|---|---|---|
| `main.py` | 333 | HOT | CLI entry — argparse dispatch to all commands |
| `cli/interface.py` | 426 | COLD | Display: `view_active`, `show_rep`, `list_habits`, `_print_entry`, `_resolve_date_filters` |
| `core/ledger.py` | 855 | HOT | Domain: `capture_habit`, `end_habit`, `pause/unpause`, `sync_day_with_selection`, `sync_with_strategy`, `verify` (try-both extensible+legacy content hash), `revert_entries` |
> Changed 2026-05-09: `_compute_duration` clamped to `max(0, ...)` to prevent negative durations from pauses extending past end time.
| `core/sync_confirmation.py` | 509 | COLD | Strategy pattern: `AutoSyncStrategy`, `InteractiveCLIStrategy` (3-stage: overview→edit→sync) |
| `core/factory.py` | 69 | COLD | `LedgerFactory.initialize()` — creates genesis + identity |
| `security/crypto.py` | 204 | COLD | Pure AES-CTR + HMAC-SHA256. `CryptoManager`, `NoAuthCryptoManager` |
| `security/auth.py` | 119 | COLD | `PassphraseAuthenticator` (PBKDF2 600K → decrypt seed → `/dev/shm` cache) |
| `security/recovery.py` | 33 | COLD | Seed gen (32B urandom→base64), `seed_to_key`, encrypt/decrypt_seed |
| `storage/file_store.py` | 49 | COLD | JSON file I/O: staging, ledger, index, identity |
| `storage/interface.py` | 36 | COLD | `AbstractLedgerStore` ABC |

### Tests (9 files, 4,925 lines)

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
| `tests/test_date_filters.py` | 290 | Date parsing & filtering |

### Scripts (2 files, 480 lines)

| File | Lines | Purpose |
|---|---|---|
| `scripts/migrate_format_version.py` | 616 | Format migration v0.2.0→v0.3.0 + v0.3.0→v0.4.0 (extensible content hash + chain cascade) |
| `scripts/repair_staging.py` | 113 | Convert hex-encrypted staging fields to plain: format |

### Key docs
| File | Lines | Use when... |
|---|---|---|
| `PHPSPEC.md` | 1,529 | Need block structure, encryption format, chain validation spec, content hash (extensible + legacy) |
| `VISION.md` | ~200 | Protocol philosophy, use cases |
| `SESSION_HANDOFF.md` | ~238 | Detailed session history, full crypto checklist |
| `BACKLOG.md` | ~430 | Task-level tracking |
| `ROADMAP.md` | ~250 | Feature roadmap |
| `DESIGN_MULTI_DEVICE_SESSION.md` | ~120 | Multi-device session & staging architecture design exploration (D2) |
| `ARCHITECTURAL_DECISIONS.md` | ~380 | Formal ADR document — all architectural decisions with context, rationale, consequences (ADR-001 through ADR-015) |

---

## Architecture Invariants (NEVER break these)

1. **Zero external dependencies** — pure Python stdlib only. No pip installs.
2. **Master Key** = 32 bytes from base64-decoded seed (`RecoveryManager.seed_to_key`)
3. **Staging format** = `NoAuthCryptoManager` uses `"plain:..."` prefix. Sync converts hex-encrypted → plain: at the boundary.
4. **Chain structure**: `Genesis → (Year Summary → Month Summary)* → Day blocks`, each sealed + signed
5. **Blind index** (`index.json`): `{date: {title: total_ms}}` — plaintext, queryable without decryption
6. **Content hash**: SHA-256 of resolved plaintext fields — survives re-encryption
7. **Config dir**: `~/.config/personal_history_poc/` (is a git repo for before/after snapshots)

---

## Quick Refs

| Action | Command |
|---|---|
| Run CLI | `PYTHONPATH=. python3 main.py <command>` |
| Run all tests | `PYTHONPATH=. python3 -m pytest tests/` |
| Run single test | `PYTHONPATH=. python3 tests/test_<name>.py` |
| Test count | 363/363 passing |
| Session cache | `/dev/shm/phpoc_session` (Master Key, chmod 600) |
