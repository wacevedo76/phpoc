# Architectural Migration Strategy — Plan, Obstacles & Mitigations

> **Date:** 2026-05-13 (Phase 2 complete)
> **Status:** Phase 1 ✅ + Phase 1b ✅ + Phase 2 ✅ — 22 files, 242 tests, no regressions. Next: Phase 3 (Ledger Engine).
> **Context:** Migration from the current monolithic `core/ledger.py` + `main.py` architecture to a layered, MVC-like structure that supports multi-device staging, ledger sync, and multiple frontends (CLI, TUI, web, wearable).
>
> All prior architectural decisions are documented in:
> - [`ARCHITECTURAL_DECISIONS.md`](./ARCHITECTURAL_DECISIONS.md)
> - [`DESIGN_MULTI_DEVICE_SESSION.md`](./DESIGN_MULTI_DEVICE_SESSION.md)
> - [`PHPSPEC.md`](./PHPSPEC.md)
> - [`DESIGN_GOALS.md`](./DESIGN_GOALS.md)

---

## Table of Contents

1. [Current Architecture (As-Is)](#1-current-architecture-as-is)
2. [Target Architecture (To-Be)](#2-target-architecture-to-be)
3. [Migration Items (Planned Changes)](#3-migration-items-planned-changes)
   - [Item 1: Staging Service — Local/Remote Split](#item-1-staging-service--localremote-split)
   - [Item 2: Ledger Engine — Local/Remote + IndexManager](#item-2-ledger-engine--localremote--indexmanager)
   - [Item 3: Sync Orchestrator — New Layer](#item-3-sync-orchestrator--new-layer)
   - [Item 4: Eliminate `plain:` Prefix Leakage](#item-4-eliminate-plain-prefix-leakage)
   - [Item 5: Abstract View Interface](#item-5-abstract-view-interface)
   - [Item 6: Blind Index Management (IndexManager)](#item-6-blind-index-management-indexmanager)
   - [Item 7: Split Storage Interfaces](#item-7-split-storage-interfaces)
   - [Item 8: Configurable Summary Policy](#item-8-configurable-summary-policy)
   - [Item 9: Device Identity Provider](#item-9-device-identity-provider)
   - [Item 10: Staging Interaction Flow — Every-Command Sync with Offline Tolerance](#item-10-staging-interaction-flow--every-command-sync-with-offline-tolerance)
   - [Item 11: Config File Format](#item-11-config-file-format)
4. [Dependency Graph & Ordering](#4-dependency-graph--ordering)
5. [Obstacles & Mitigations Summary](#5-obstacles--mitigations-summary)
6. [Testing Strategy](#6-testing-strategy)
7. [Backward Compatibility](#7-backward-compatibility)
8. [Cross-Stack Portability Assessment](#8-cross-stack-portability-assessment)

---

## 1. Current Architecture (As-Is)

### High-Level Structure

```
main.py
  └── argparse dispatch → handler functions (_handle_modify, _handle_remove, etc.)
  └── CLI-specific logic: _parse_time_input, _print_staging_line, _list_tags
  └── Authentication: PassphraseAuthenticator, CryptoManager / NoAuthCryptoManager

core/
  ├── ledger.py         ← MIXED: staging CRUD + ledger chain + print() calls
  ├── sync_confirmation.py ← SyncStrategy interface + InteractiveCLIStrategy (CLI in core/)
  └── factory.py        ← LedgerFactory.initialize()

cli/
  └── interface.py      ← CLIInterface (thin wrapper, some direct storage access)

storage/
  ├── interface.py      ← Single AbstractLedgerStore for everything
  └── file_store.py     ← Monolithic LedgerStore (staging, ledger, index, identity)

security/
  ├── crypto.py         ← CryptoManager, NoAuthCryptoManager (plain: prefix awareness)
  ├── auth.py           ← PassphraseAuthenticator
  └── recovery.py       ← RecoveryManager
```

### Pain Points

| Pain Point | Location | Severity |
|-----------|----------|----------|
| Staging CRUD + Ledger Chain in one class | `core/ledger.py` (800+ lines) | 🔴 High |
| `print()` calls in domain layer | `core/ledger.py` | 🔴 High |
| `plain:` prefix checked everywhere | `core/ledger.py` (7+ methods) | 🔴 High |
| InteractiveStrategy with `print()`/`input()` in `core/` | `core/sync_confirmation.py` | 🔴 High |
| CLI handler functions in `main.py` instead of `cli/` | `main.py` (300+ lines of handlers) | 🟡 Medium |
| Single storage interface for 4 concerns | `storage/interface.py` | 🟡 Medium |
| Summary cadence hardcoded | `core/ledger.py` (within sync methods) | 🟢 Low |
| View assumes CLI exclusively | `cli/interface.py`, `main.py` | 🟢 Low |

---

## 2. Target Architecture (To-Be)

### Layered Structure

```
┌────────────────────────────────────────────────────────────┐
│                       View Layer                           │
│                                                           │
│  interfaces/view.py         ← AbstractViewInterface       │
│                                                           │
│  cli/                       ← CLIView + CLIStrategy       │
│    ├── cli_view.py          ← CLIView(view interface impl)│
│    ├── cli_parsers.py       ← _parse_time_input & friends │
│    └── strategies.py        ← InteractiveCLIStrategy      │
│                                                           │
│  tui/     (future)                                        │
│  web/     (future)                                        │
│  wearable/ (future)                                       │
└──────────────────────────┬────────────────────────────────┘
                           │ calls (via ViewInterface)
                           ▼
┌────────────────────────────────────────────────────────────┐
│                    Sync Orchestrator                       │
│                                                           │
│  core/sync/                                               │
│    ├── orchestrator.py     ← SyncOrchestrator             │
│    ├── decision.py         ← SyncStrategy (abstract)      │
│    └── transport.py        ← AbstractStagingTransport     │
│                                                           │
│  Responsibilities:                                        │
│    - Device identity check before any operation            │
│    - Pull remote staging blob, merge with local            │
│    - Present entries via View → get SyncDecision           │
│    - Commit to LedgerEngine                                │
│    - Remove synced entries from StagingService             │
│    - Push remote staging blob after commit                 │
│    - Push new ledger blocks to remote                     │
│    - Handle offline queue (entries accumulate locally)     │
└──────────────────────────┬────────────────────────────────┘
                           │ calls
                           ▼
┌────────────────────────────────────────────────────────────┐
│                     Domain Layer                           │
│                                                           │
│  domain/                                                  │
│    ├── staging/                                           │
│    │   ├── service.py       ← StagingService (public API) │
│    │   ├── local_cache.py   ← LocalStagingCache           │
│    │   ├── remote_sync.py   ← RemoteStagingSync           │
│    │   └── merge_engine.py  ← MergeEngine                 │
│    │                                                      │
│    └── ledger/                                            │
│        ├── engine.py        ← LedgerEngine (public API)   │
│        ├── chain.py         ← LedgerChain                 │
│        ├── remote_sync.py   ← LedgerRemoteSync            │
│        ├── chain_splitter.py← ChainSplitter               │
│        ├── index_manager.py ← IndexManager                │
│        └── summary_policy.py← SummaryPolicy (strategy)    │
│                                                           │
│  Properties:                                              │
│    - No print() calls anywhere                             │
│    - No plain: prefix exposure to callers                  │
│    - Returns decoupled DTOs / value objects                │
│    - All notifications via ViewInterface callbacks         │
│    - All errors via exceptions or result types             │
└──────────────────────────┬────────────────────────────────┘
                           │ uses
                           ▼
┌────────────────────────────────────────────────────────────┐
│                Storage Abstraction                         │
│                                                           │
│  storage/                                                 │
│    ├── staging_store.py   ← AbstractStagingStore   ✅     │
│    ├── ledger_store.py    ← AbstractLedgerStore    ✅     │
│    ├── index_store.py     ← AbstractIndexStore     ✅     │
│    ├── identity_store.py  ← AbstractIdentityStore  ✅     │
│    ├── config_store.py    ← AbstractConfigStore    ✅     │
│    └── implementations/                           ✅     │
│        ├── file_staging.py ← FileStagingStore     ✅     │
│        ├── file_ledger.py  ← FileLedgerStore      ✅     │
│        ├── file_index.py   ← FileIndexStore       ✅     │
│        ├── file_identity.py← FileIdentityStore    ✅     │
│        └── file_config.py  ← FileConfigStore      ✅     │
│                                                           │
│  Properties:                                              │
│    - Each interface has single responsibility              │
│    - StagingStore supports local + remote (via transport)  │
│    - LedgerStore supports incremental reads (by offset)    │
│    - IndexStore is simple KV, rebuildable from chain       │
│    - IdentityStore is read-once-per-session                │
│    - ConfigStore is user-editable JSON with defaults       │
└──────────────────────────┬────────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────────┐
│                 Transport Layer (NEW)                      │
│                                                           │
│  transport/                                               │
│    ├── interface.py       ← AbstractStagingTransport      │
│    │                         pull(path) → bytes           │
│    │                         push(path, data) → None      │
│    ├── git_transport.py   ← GitTransport                  │
│    ├── blob_obfuscator.py ← BlobObfuscator                │
│    │                         (fixed-size padded encrypt)  │
│    ├── http_transport.py  (future)                        │
│    └── check.py           ← remote_available(timeout=0.5) │
│                                                           │
│  Properties:                                              │
│    - Minimal 2-method interface for transport              │
│    - Blob obfuscation is transport-agnostic                │
│    - Ledger transport reuses same interface pattern        │
│      but with offset/range support (future)               │
└──────────────────────────┬────────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────────┐
│              Middleware / Security                         │
│                                                           │
│  security/                                                │
│    ├── crypto.py           ← CryptoManager (AES-CTR+HMAC) │
│    ├── auth.py             ← PassphraseAuthenticator      │
│    ├── recovery.py         ← RecoveryManager              │
│    ├── device_identity.py  ← AbstractDeviceIdentityProvider│
│    │                         RandomUUIDDeviceIdentityProv │
│    ├── config_manager.py  ← ConfigManager        ✅      │
│    │                         (security/config_manager.py) │
│                              (read/write ~/.config/.../   │
│                               config.json, user-editable) │
│                                                           │
│  Properties:                                              │
│    - NoAuthCryptoManager removed (plain: handled by       │
│      StagingService internally)                           │
│    - AbstractDeviceIdentityProvider is pluggable           │
│    - RandomUUIDDeviceIdentityProv generates UUID on init  │
│    - ConfigManager owns remote paths, auth cache timeout  │
│    - All security injectable via dependency injection      │
└────────────────────────────────────────────────────────────┘
```

---

## 3. Migration Items (Planned Changes)

### Item 1: Staging Service — Local/Remote Split

**Problem:** The current `core/ledger.py` mixes staging CRUD (`capture_habit`, `end_habit`, `pause_habit`, `unpause_habit`, `modify_staged_entry`, `remove_staged_entry`) with ledger chain operations (`sync_day`, `verify`, `revert_entries`). Staging has two modes (local `plain:` vs remote encrypted blob) that need different handling.

**Target:**

```
domain/staging/service.py     ← StagingService (public API)
domain/staging/local_cache.py ← LocalStagingCache
domain/staging/remote_sync.py ← RemoteStagingSync
domain/staging/merge_engine.py← MergeEngine
```

**StagingService Public API:**

```python
class StagingService:
    def __init__(self, crypto, staging_store, transport=None, device_id_provider=None):
        self._local = LocalStagingCache(crypto, staging_store)
        self._remote = RemoteStagingSync(crypto, transport, device_id_provider) if transport else None
        self._merge = MergeEngine()

    # --- Entry CRUD ---
    def capture(self, title, start_epoch, stop_epoch=None, metadata=None,
                is_active=False, tags=None, comment=None, media=None) -> str:
        """Add entry to local staging. If remote available, push after."""
        # Returns entry hash prefix
        pass

    def end(self, title_or_id, end_epoch, comment=None):
        """End an active task."""
        pass

    def end_at(self, title_or_id, end_epoch, comment=None):
        """End at a specific past timestamp."""
        pass

    def pause(self, title_or_id, pause_epoch, comment=None):
        """Pause a running task."""
        pass

    def unpause(self, title_or_id, unpause_epoch, comment=None):
        """Unpause a paused task."""
        pass

    def modify(self, entry_index, end_epoch=None, pauses=None):
        """Modify a completed entry's end time and/or pauses."""
        pass

    def remove(self, entry_index):
        """Remove a staged entry by index."""
        pass

    # --- Queries (returns decrypted DTOs, no plain: prefix) ---
    def get_entries(self) -> List[StagingEntryDTO]:
        """All staged entries with decrypted fields."""
        pass

    def get_completed(self) -> List[StagingEntryDTO]:
        """Only completed entries (non-active, non-paused)."""
        pass

    def get_active(self) -> List[StagingEntryDTO]:
        """Only active (running) entries."""
        pass

    def get_pending_sync(self) -> List[StagingEntryDTO]:
        """Entries ready to sync (completed, not synced)."""
        # Merges get_completed() - already_synced_set
        pass

    # --- Remote Sync ---
    def check_and_sync(self, timeout_ms: int = 500) -> SyncCheckResult:
        """Event-driven remote check. Called on every staging command.

        1. Check if remote is reachable (within timeout_ms)
        2. If unreachable: return OFFLINE (local op only, queue for later)
        3. If reachable: check device_id match vs remote blob
        4. If device_id mismatch: re-auth if cached auth expired
        5. Pull remote blob -> merge with local by timestamp
        6. Return READY (proceed with local op, then push)

        Returns SyncCheckResult enum: READY, OFFLINE, REAUTH_NEEDED
        """
        pass

    def push_to_remote(self):
        """Serialize local staging, obfuscate, push via transport."""
        pass

    def push_queued(self):
        """Push locally queued entries (from offline period)."""
        pass

    def is_remote_available(self) -> bool:
        """Check if remote transport is configured and reachable."""
        pass

    def get_offline_queue(self) -> List[StagingEntryDTO]:
        """Entries added while offline that haven't been pushed."""
        pass

    def close(self):
        """Flush any queued entries, release resources."""
        pass

        pass
```

**LocalStagingCache:**

```python
class LocalStagingCache:
    """Manages local staging.json with plain: prefix convention.

    This is the ONLY class that knows about plain:. No other component
    should see startswith("plain:") checks.
    """

    def __init__(self, crypto, staging_store):
        self._crypto = crypto
        self._store = staging_store

    def read_entries(self) -> List[dict]:
        """Read raw staging, decrypt fields, return value objects."""
        pass

    def write_entries(self, entries: List[dict]):
        """Encrypt fields back to plain: format, write to store."""
        pass

    def append(self, entry: dict):
        """Append single entry (encrypt fields to plain: first)."""
        pass

    def update(self, index: int, fields: dict):
        """Update specific fields on an entry."""
        pass

    def delete(self, index: int):
        """Remove entry at index."""
        pass

    def _to_plain(self, field_value: str) -> str:
        """Internal: store as plain: prefix (no real encryption)."""
        pass

    def _from_plain(self, field_value: str) -> str:
        """Internal: strip plain: prefix (no real decryption)."""
        pass
```

**RemoteStagingSync:**

```python
class RemoteStagingSync:
    """Handles device identity, transport, and blob obfuscation for remote staging."""

    def __init__(self, crypto, transport, device_id_provider):
        self._crypto = crypto
        self._transport = transport
        self._device_id = device_id_provider

    def check_device(self) -> bool:
        """Compare local device_id with remote blob's device_id_enc.
        Returns True if match, False if re-auth needed."""
        pass

    def pull(self) -> List[dict]:
        """Pull remote blob, deobfuscate, decrypt, return entries."""
        pass

    def push(self, entries: List[dict], device_id: str):
        """Encrypt entries, obfuscate blob, push via transport."""
        pass

    def get_remote_device_id(self) -> Optional[str]:
        """Decrypt device_id_enc from remote blob."""
        pass
```

**MergeEngine:**

```python
class MergeEngine:
    """Merge entries from multiple sources by timestamp.

    Since real-world tasks don't start at the same millisecond
    on two devices, entries are additive and non-conflicting.
    """

    def merge(self, local_entries: List[dict], remote_entries: List[dict]) -> List[dict]:
        """Merge remote entries into local cache.
        Entries are deduplicated by (title, start_epoch).
        Remote wins on ties (more recent source).
        Returns merged list sorted by start_epoch.
        """
        pass
```

---

### Item 2: Ledger Engine — Local/Remote + IndexManager

**Problem:** The current `sync_day()`, `sync_day_with_selection()`, `verify()`, and `revert_entries()` methods in `core/ledger.py` handle chain operations, index updates, and summary insertion all in one flow. There's no separation between local chain operations and remote sync.

**Target:**

```
domain/ledger/engine.py         ← LedgerEngine (public API)
domain/ledger/chain.py          ← LedgerChain (local operations)
domain/ledger/remote_sync.py    ← LedgerRemoteSync (incremental push/pull)
domain/ledger/chain_splitter.py ← ChainSplitter (archive/export)
domain/ledger/index_manager.py  ← IndexManager (blind index)
domain/ledger/summary_policy.py ← SummaryPolicy (abstract + implementations)
```

**LedgerEngine Public API:**

```python
class LedgerEngine:
    def __init__(self, crypto, ledger_store, index_store, identity_store,
                 summary_policy=None):
        self._chain = LedgerChain(crypto, ledger_store)
        self._index = IndexManager(index_store)
        self._identity = identity_store
        self._summary = summary_policy or YearMonthSummaryPolicy()

    def commit(self, entries: List[StagingEntryDTO]) -> str:
        """Commit entries to the ledger chain.

        1. Group entries by date
        2. For each date: check summary policy → insert summary block if needed
        3. Build day block with entries (encrypt fields, compute hashes)
        4. Append to chain (update prev_hash, seal, sign)
        5. Update blind index

        Returns day_hash prefix of the last committed block.
        """
        pass

    def verify(self, full_check=True) -> VerificationResult:
        """Verify chain integrity.
        - prev_hash linkage
        - Block seals (HMAC)
        - Identity signatures (if available)
        - Entry hashes
        - Content hashes (optional deep check)
        """
        pass

    def revert(self, count: int) -> RevertResult:
        """Revert last N day blocks.
        Returns entries to restore to staging (as StagingEntryDTOs).
        Updates blind index (subtract reverted durations).
        """
        pass

    def query_index(self, from_date=None, to_date=None) -> Dict[str, int]:
        """Query blind index for reputation data.
        Title → total ms over the date range."""
        pass

    def sync_with_remote(self) -> SyncResult:
        """Pull new blocks from remote, append to local chain.
        Push local-only blocks to remote.
        """
        pass


    def rebuild_index(self):
        """Rebuild blind index from the full chain (fix corruption)."""
        pass
    def get_block_count(self) -> int:
        """Number of blocks in the ledger chain."""
        pass

    def get_day_blocks(self) -> List[DayBlockInfo]:
        """Summary info about day blocks (for revert --list display)."""
        pass
```

**LedgerChain:**

```python
class LedgerChain:
    """Local chain operations. Knows nothing about transports, views, or staging."""

    def __init__(self, crypto, ledger_store):
        self._crypto = crypto
        self._store = ledger_store

    def read_all(self) -> List[dict]:
        """Read full chain."""
        pass

    def append(self, block: dict):
        """Append block, compute seal and signature."""
        pass

    def append_blocks(self, blocks: List[dict]):
        """Append multiple blocks (from remote sync)."""
        pass

    def truncate(self, keep_count: int) -> List[dict]:
        """Truncate chain to keep_count blocks. Returns removed blocks."""
        pass

    def get_last_block(self) -> dict:
        pass

    def get_block(self, index: int) -> dict:
        pass

    def compute_seal(self, block: dict) -> str:
        """HMAC-SHA256 over block content (excluding seal + signature)."""
        pass

    def compute_signature(self, block_hash: str, identity_secret: bytes) -> str:
        """Identity HMAC over block hash."""
        pass

    def verify_block(self, block: dict, prev_hash: str) -> bool:
        """Verify a single block's seal, signature, prev_hash linkage."""
        pass
```

**LedgerRemoteSync:**

```python
class LedgerRemoteSync:
    """Incremental sync of ledger blocks across devices.

    Unlike staging (which pushes/pulls the entire blob),
    ledger sync is incremental — only new blocks are transferred.
    """

    def __init__(self, crypto, chain, transport, device_id_provider):
        pass

    def pull_new_blocks(self, last_known_index: int) -> List[dict]:
        """Pull blocks after last_known_index from remote.
        Returns blocks that need to be appended to local chain."""
        pass

    def push_new_blocks(self, local_count: int, remote_count: int) -> int:
        """Push local blocks that the remote doesn't have yet.
        Returns number of blocks pushed."""
        pass

    def get_remote_block_count(self) -> int:
        """Query remote for total block count."""
        pass
```

**IndexManager:**

See Item 6 for full detail.

---

### Item 3: Sync Orchestrator — New Layer

**Problem:** Currently sync orchestration is split across `core/ledger.py` (`sync_with_strategy`, `sync_day_with_selection`), `core/sync_confirmation.py` (strategy dispatch), and `main.py` (CLI entry). There's no single point that coordinates: staging read → device check → remote pull → view confirmation → ledger commit → staging cleanup → remote push.

**Target:**

```
core/sync/
  ├── orchestrator.py    ← SyncOrchestrator
  ├── decision.py        ← SyncDecision + SyncStrategy (abstract)
  └── transport.py       ← AbstractStagingTransport
```

**SyncOrchestrator:**

```python
class SyncOrchestrator:
    """Coordinates the full sync lifecycle across all layers.

    Flow:
    1. Check device identity (re-auth if remote device_id mismatch)
    2. If remote available: pull remote staging → merge into local
    3. Get pending entries from StagingService
    4. Present entries via ViewInterface → get SyncDecision
    5. Apply overrides to entries
    6. Commit to LedgerEngine
    7. Remove synced entries from StagingService
    8. If remote available: push updated staging blob
    9. If remote available: push new ledger blocks
    """

    def __init__(self, staging_service, ledger_engine, view, transport=None):
        self._staging = staging_service
        self._ledger = ledger_engine
        self._view = view
        self._transport = transport

    def sync(self, till_date=None):
        """Execute a full sync operation.

        Args:
            till_date: Optional date filter (YYYY-MM-DD).

        Returns:
            SyncResult with count of synced entries, or None on cancel.
        """
        # Step 1: Device identity check (if remote configured)
        if self._transport:
            if not self._staging.sync_with_remote():
                self._view.warn("Remote staging unavailable — syncing local only.")

        # Step 2: Get pending entries
        pending = self._staging.get_pending_sync()
        if till_date:
            pending = [p for p in pending if p.date <= till_date]

        if not pending:
            self._view.notify("Nothing to sync.")
            return None

        # Step 3: Present to user (or auto-confirm)
        strategy = SyncStrategyFactory.for_view(self._view)
        decision = strategy.decide(pending)

        if decision.cancelled:
            self._view.notify("Sync cancelled.")
            return None

        # Step 4: Apply overrides
        # (handled inside StagingService before commit)

        # Step 5: Commit to ledger
        result = self._ledger.commit(decision.selected_entries)

        # Step 6: Remove synced entries from staging
        self._staging.remove_synced(decision.selected_indices)

        # Step 7: Handle removal-only decisions
        if decision.removal_indices:
            for idx in sorted(decision.removal_indices, reverse=True):
                self._staging.remove(idx)

        # Step 8: Push to remote (if available)
        if self._transport:
            self._staging.push_to_remote()
            self._ledger.sync_with_remote()

        self._view.notify(f"Synced {len(decision.selected_entries)} entr{'y' if len(decision.selected_entries) == 1 else 'ies'}.")
        return result
```

**SyncDecision (refined from current):**

```python
@dataclass
class SyncDecision:
    """Result of sync confirmation strategy.

    Attributes:
        selected_indices: Indices of entries to sync.
        removal_indices: Indices of entries to remove from staging.
        overrides: Per-entry overrides {index: {field: value}}.
        cancelled: True if user cancelled the entire operation.
    """
    selected_indices: List[int] = field(default_factory=list)
    removal_indices: Set[int] = field(default_factory=set)
    overrides: Dict[int, Dict[str, Any]] = field(default_factory=dict)
    cancelled: bool = False

    @property
    def has_selection(self) -> bool:
        return bool(self.selected_indices) and not self.cancelled

    @property
    def has_removals(self) -> bool:
        return bool(self.removal_indices) and not self.cancelled
```

**SyncStrategy (abstract — stays in core/sync/):**

```python
class SyncStrategy(ABC):
    """Abstract sync confirmation strategy.

    A strategy receives pending entries (as DTOs) and returns a SyncDecision.
    The ViewInterface is available for displaying entries and getting user input.
    """

    def decide(self, pending: List[StagingEntryDTO], view: ViewInterface) -> SyncDecision:
        raise NotImplementedError
```

---

### Item 4: Eliminate `plain:` Prefix Leakage

**Problem:** The `plain:` prefix convention is checked in 7+ methods across `core/ledger.py`, plus in `cli/interface.py` (which decrypts fields directly). Every new method that reads staging must remember to handle `startswith("plain:")`. In multi-device mode, remote entries won't have `plain:` — they'll be real ciphertext from another device's encrypt, making the format detection even more complex.

**Target:** The `plain:` prefix is **entirely internal** to `LocalStagingCache`. No other component ever sees it.

**What changes:**

| File | Current | Target |
|------|---------|--------|
| `security/crypto.py` | `NoAuthCryptoManager` (strips `plain:` prefix) | **Removed** — staging handles its own format |
| `core/ledger.py` | 7+ methods with `startswith("plain:")` | All moved to `domain/staging/local_cache.py` |
| `cli/interface.py` | `_print_entry()` decrypts fields directly | Calls `StagingService.get_entries()` → gets DTOs |
| `core/ledger.py` `_reconcile_plain_pauses()` | Checks for `plain:` and re-encrypts | Moved to `LocalStagingCache._to_plain()` |
| `core/ledger.py` `_normalize_staging_entry()` | Converts hex→plain: before sync | Moved to `LocalStagingCache._from_plain()` |

**StagingEntryDTO (the public face of staging):**

```python
@dataclass
class StagingEntryDTO:
    """Decrypted staging entry — no encryption concerns visible to callers."""
    entry_index: int
    title: str
    start_epoch: int
    end_epoch: Optional[int]
    duration: int
    is_active: bool
    is_paused: bool
    pauses: List[PauseDTO]
    tags: List[str]
    comment: Optional[str]
    media: List[dict]
    metadata: dict
    date: str  # YYYY-MM-DD derived from start_epoch
    source: str = "local"  # "local" or "remote"

from enum import Enum


class SyncCheckResult(Enum):
    """Result of event-driven remote check before a staging command."""
    READY = "ready"           # Remote synced, proceed with local operation
    OFFLINE = "offline"       # Remote unreachable, local operation only
    REAUTH_NEEDED = "reauth"  # Device mismatch, passphrase required


@dataclass
class PauseDTO:
    pause_index: int
    pause_start: int
    pause_stop: Optional[int]
    comment: Optional[str]
```

**Flow for a capture operation:**

```
User: phpoc add oneoff "Guitar" --tag music
  → CLIInterface.add_oneoff("Guitar", ..., tags=["music"])
    → StagingService.capture("Guitar", now-1000, now, is_active=False, tags=["music"])
      → LocalStagingCache.append({
          "title": "Guitar",
          "startTime_enc": "plain:1714000000000",    ← internal
          "endTime_enc": "plain:1714001000000",      ← internal
          "pauses_enc": "plain:[]",                   ← internal
          ...
        })
      → if remote available:
          RemoteStagingSync.push(local_entries)
    ← returns hash prefix
  ← prints "✓ One-off habit captured: Guitar [@music]"
```

The CLI never sees `plain:`. The DTO returned by `get_entries()` has `start_epoch: 1714000000000` as an integer.

---

### Item 5: Abstract View Interface

**Problem:** Currently all view logic assumes CLI. `InteractiveCLIStrategy` (with `print()` and `input()`) lives in `core/sync_confirmation.py` — a core module dependent on terminal I/O. Adding TUI, web, or headless support would require reimplementing display logic for each.

**Target:**

```
domain/interfaces/view.py    ← ViewInterface (abstract)
cli/
  ├── cli_view.py            ← CLIView (implements ViewInterface)
  ├── cli_parsers.py         ← Time input parsing (CLI-specific)
  └── strategies.py          ← InteractiveCLIStrategy (moved from core/sync_confirmation.py)
```

**ViewInterface:**

```python
class ViewInterface(ABC):
    """Abstract view for all user interaction.

    Every method has a no-op default so views only override what they need.
    """

    # --- Display ---
    def render_entry_line(self, entry: StagingEntryDTO, overrides: dict = None,
                          excluded: set = None) -> str:
        """Format one entry as a single display line."""
        return ""

    def render_entry_list(self, entries: List[StagingEntryDTO]) -> str:
        """Format a list of entries for display."""
        return "\n".join(self.render_entry_line(e) for e in entries)

    def render_overview(self, pending: List[StagingEntryDTO],
                        overrides: dict, excluded: set):
        """Display overview of pending sync entries. Override for rich display."""
        pass

    def render_edit_menu(self, pending: List[StagingEntryDTO],
                         overrides: dict, excluded: set):
        """Display edit menu with original + proposed changes."""
        pass

    def render_review(self, entries: List[StagingEntryDTO]):
        """Display review of entries as they'd appear after sync."""
        pass

    def render_error(self, message: str):
        """Display an error message."""
        pass

    def render_success(self, message: str):
        """Display a success/confirmation message."""
        pass

    def render_warning(self, message: str):
        """Display a warning message."""
        pass

    # --- Input ---
    def prompt_choice(self, prompt: str, options: List[str],
                      help_items: dict = None) -> str:
        """Prompt user to choose from options. Returns the chosen key."""
        return ""

    def prompt_text(self, prompt: str, default: str = "") -> str:
        """Prompt for free-text input."""
        return default

    def prompt_time(self, prompt: str, date_str: str,
                    start_epoch: int, end_epoch: int = None) -> Optional[int]:
        """Prompt for time input. Returns epoch ms or None."""
        return None

    def prompt_yes_no(self, prompt: str, default: bool = False) -> bool:
        """Prompt for yes/no confirmation."""
        return default

    def prompt_int(self, prompt: str, min_val: int = None,
                   max_val: int = None) -> Optional[int]:
        """Prompt for integer input. Returns int or None on cancel."""
        return None

    def prompt_tag_action(self, current_tags: List[str]) -> TagEditResult:
        """Interactive tag editor. Returns (tags, modified)."""
        return TagEditResult(tags=current_tags, modified=False)
```

**CLIView:**

```python
class CLIView(ViewInterface):
    """Concrete view implementation for terminal/CLI."""

    def __init__(self):
        pass

    def render_entry_line(self, entry, overrides=None, excluded=None):
        """Format:  #idx: [HH:MM-HH:MM] Title (@tags) (Nm) comment"""
        # Moved from current _print_staging_line and _format_entry_line
        pass

    def render_edit_menu(self, pending, overrides, excluded):
        """Show original + proposed side by side."""
        # Moved from current InteractiveCLIStrategy._stage2_edit_menu
        pass

    def prompt_choice(self, prompt, options, help_items=None):
        """Single-character input with validation."""
        # Moved from current InteractiveCLIStrategy._prompt_choice
        pass

    def prompt_time(self, prompt, date_str, start_epoch, end_epoch=None):
        """Parse HH:MM, +offset, duration, or epoch ms."""
        # Moved from current _parse_time_input in main.py
        # Delegates to cli_parsers.parse_time_input()
        pass

    # ... remaining methods follow same pattern
```

**InteractiveCLIStrategy (moved to `cli/strategies.py`):**

```python
class InteractiveCLIStrategy(SyncStrategy):
    """Three-stage interactive sync confirmation using ViewInterface.

    Stage 1 (Overview): Show all pending entries.
    Stage 2 (Edit Menu): Show original + proposed changes.
    Stage 3 (Edit Single): Modify end time, comment, media.

    All I/O goes through the ViewInterface — compatible with any view.
    """

    def decide(self, pending: List[StagingEntryDTO], view: ViewInterface) -> SyncDecision:
        # Uses view.render_overview(), view.prompt_choice(), etc.
        # No direct print() or input() calls.
        pass
```

**AutoSyncStrategy (stays lightweight, no view needed):**

```python
class AutoSyncStrategy(SyncStrategy):
    """Sync everything without confirmation. For --yes / headless."""

    def decide(self, pending: List[StagingEntryDTO], view: ViewInterface = None) -> SyncDecision:
        if not pending:
            return SyncDecision(cancelled=True)
        return SyncDecision(
            selected_indices=[p.entry_index for p in pending]
        )
```

**What moves where:**

| Current Location | New Location | Reason |
|-----------------|-------------|--------|
| `core/sync_confirmation.py` (InteractiveCLIStrategy) | `cli/strategies.py` | CLI-specific implementation |
| `core/sync_confirmation.py` (SyncStrategy interface) | `core/sync/decision.py` | Abstract interface stays in core |
| `main.py` `_print_staging_line()` | `cli/cli_view.py` `render_entry_line()` | Belongs in view layer |
| `main.py` `_parse_time_input()` | `cli/cli_parsers.py` | CLI-specific input parsing |
| `main.py` `_handle_modify()` | `cli/cli_view.py` (as method) | Interactive CLI workflow |
| `main.py` `_handle_remove()` | `cli/cli_view.py` (as method) | Interactive CLI workflow |
| `main.py` `_handle_review()` | `cli/cli_view.py` (as method) | Interactive CLI workflow |
| `core/ledger.py` `print()` calls | Replaced with `view.notify()/warn()` | Domain should never print |

---

### Item 6: Blind Index Management (IndexManager)

**Problem:** The blind index (`index.json`) is currently a simple key-value store updated ad-hoc during `sync_day()` and `revert_entries()` in `core/ledger.py`. It's queried directly by `CLIInterface.show_rep()` which calls `self.ledger.store.read_index()` — bypassing any domain abstraction and coupling the view to storage internals.

**Target:**

```
domain/ledger/index_manager.py  ← IndexManager
```

**IndexManager API:**

```python
class IndexManager:
    """Manages the blind index — a plaintext aggregate of duration per date per title.

    The blind index is a derived cache, not canonical data. It can be fully
    rebuilt from the ledger chain if lost or corrupted.

    It stores: {date_str: {title: total_ms}}
    This leaks: activity titles + daily totals (no exact timestamps).
    This is acceptable — it's what the user sees in the CLI anyway.
    """

    def __init__(self, index_store: AbstractIndexStore):
        self._store = index_store

    def update(self, date: str, title: str, duration_delta: int):
        """Add or subtract duration for a title on a given date.

        Positive delta = sync (entry committed).
        Negative delta = revert (entry restored to staging).
        """
        index = self._store.read_index()
        if date not in index:
            index[date] = {}
        current = index[date].get(title, 0)
        new_value = current + duration_delta
        if new_value <= 0:
            index[date].pop(title, None)
            if not index[date]:
                index.pop(date, None)
        else:
            index[date][title] = new_value
        self._store.write_index(index)

    def query(self, from_date: Optional[str] = None,
              to_date: Optional[str] = None) -> Dict[str, int]:
        """Query duration totals over a date range.

        Returns dict mapping title → total milliseconds.
        Both dates are inclusive (YYYY-MM-DD format).
        """
        index = self._store.read_index()
        result = {}
        for date_str, activities in index.items():
            if from_date and date_str < from_date:
                continue
            if to_date and date_str > to_date:
                continue
            for title, duration in activities.items():
                result[title] = result.get(title, 0) + duration
        return result

    def rebuild_from_chain(self, ledger: List[dict], decrypt_fn) -> Dict[str, Any]:
        """Rebuild the entire index from the ledger chain.

        Iterates all day blocks, decrypts startTime_enc to determine date,
        and accumulates duration per title per date.

        Returns the rebuilt index (also persists it).
        """
        import time
        index = {}
        for block in ledger:
            if block.get("type", "day") != "day":
                continue
            for entry in block.get("entries", []):
                data = entry["data"]
                start_val = data["startTime_enc"]
                start_epoch = int(decrypt_fn(start_val))
                date_str = time.strftime("%Y-%m-%d", time.gmtime(start_epoch // 1000))
                title = data["title"]
                duration = data.get("duration", 0)
                if date_str not in index:
                    index[date_str] = {}
                index[date_str][title] = index[date_str].get(title, 0) + duration
        self._store.write_index(index)
        return index

    def get_all(self) -> Dict[str, Any]:
        """Get full index (for debugging or direct access)."""
        return self._store.read_index()

    def clear(self):
        """Reset index to empty."""
        self._store.write_index({})
```

**Integration with LedgerEngine:**

```python
class LedgerEngine:
    def commit(self, entries: List[StagingEntryDTO]) -> str:
        # ... group by date, build day blocks ...
        for date_str, day_entries in grouped.items():
            # Insert summary blocks if needed
            # Append day block to chain
            # Update index
            for entry in day_entries:
                self._index.update(date_str, entry.title, entry.duration)
        # ...

    def revert(self, count: int) -> RevertResult:
        removed_blocks = self._chain.truncate(count)
        restored = []
        for block in removed_blocks:
            if block.get("type", "day") != "day":
                continue
            for entry in block.get("entries", []):
                data = entry["data"]
                # Subtract from index
                start_epoch = int(self._crypto.decrypt(data["startTime_enc"]))
                date_str = time.strftime("%Y-%m-%d", time.gmtime(start_epoch // 1000))
                self._index.update(date_str, data["title"], -data.get("duration", 0))
                # Build DTO for staging restoration
                restored.append(self._entry_to_dto(entry, data))
        return RevertResult(entries=restored, count=len(removed_blocks))
```

**What this unblocks:**
- View layer queries `ledger_engine.query_index(from, to)` instead of `store.read_index()`
- Index can be encrypted in the future without changing the view
- Index corruption can be fixed by `ledger_engine.rebuild_index()` without exposing storage
- The `storage.interface` no longer needs `read_index()/write_index()` exposed to arbitrary callers

---

### Item 7: Split Storage Interfaces

**Problem:** `storage/interface.py` defines a single `AbstractLedgerStore` with methods for staging, ledger, index, and identity. A monolithic `LedgerStore` in `file_store.py` implements all four. This prevents different backends for different concerns and forces all callers to depend on the full interface even if they only need one piece.

**Target:**

```
storage/
  ├── staging_store.py    ← AbstractStagingStore
  ├── ledger_store.py     ← AbstractLedgerStore
  ├── index_store.py      ← AbstractIndexStore
  ├── identity_store.py   ← AbstractIdentityStore
  └── implementations/
      ├── file_staging.py ← FileStagingStore
      ├── file_ledger.py  ← FileLedgerStore
      ├── file_index.py   ← FileIndexStore
      └── file_identity.py← FileIdentityStore
```

**AbstractStagingStore:**

```python
class AbstractStagingStore(ABC):
    """Storage for mutable staging entries.

    Local implementation: JSON file on disk.
    Remote implementation (future): via transport + local cache.
    """

    @abstractmethod
    def read_entries(self) -> List[Dict[str, Any]]:
        """Read all staged entries."""
        pass

    @abstractmethod
    def write_entries(self, data: List[Dict[str, Any]]):
        """Overwrite all staged entries."""
        pass

    @abstractmethod
    def append_entry(self, entry: Dict[str, Any]):
        """Append a single entry."""
        pass

    @abstractmethod
    def remove_entries(self, indices: List[int]):
        """Remove entries by index (sorted descending to avoid shift issues)."""
        pass

    @abstractmethod
    def update_entry(self, index: int, fields: Dict[str, Any]):
        """Update specific fields on an entry."""
        pass
```

**AbstractLedgerStore:**

```python
class AbstractLedgerStore(ABC):
    """Storage for the append-only ledger chain.

    The chain is a JSON array of blocks. Only the tail is mutable (for revert).
    Supports partial reads for incremental remote sync.
    """

    @abstractmethod
    def read_blocks(self, start: int = 0, end: Optional[int] = None) -> List[Dict[str, Any]]:
        """Read a range of blocks. end is exclusive.

        For full chain: read_blocks()
        For last N blocks: read_blocks(start=-N)
        For incremental: read_blocks(start=last_known_count)
        """
        pass

    @abstractmethod
    def append_blocks(self, blocks: List[Dict[str, Any]]):
        """Append blocks to the end of the chain."""
        pass

    @abstractmethod
    def truncate(self, keep_count: int) -> List[Dict[str, Any]]:
        """Truncate chain to keep_count blocks. Returns removed blocks."""
        pass

    @abstractmethod
    def get_block_count(self) -> int:
        """Total number of blocks in the chain."""
        pass

    @abstractmethod
    def get_last_block(self) -> Optional[Dict[str, Any]]:
        """Get the most recent block."""
        pass
```

**AbstractIndexStore:**

```python
class AbstractIndexStore(ABC):
    """Storage for the blind index — a simple key-value cache."""

    @abstractmethod
    def read_index(self) -> Dict[str, Any]:
        pass

    @abstractmethod
    def write_index(self, data: Dict[str, Any]):
        pass
```

**AbstractIdentityStore:**

```python
class AbstractIdentityStore(ABC):
    """Storage for identity secret (optional cache — genesis has fallback)."""

    @abstractmethod
    def read_identity(self) -> Optional[Dict[str, Any]]:
        pass

    @abstractmethod
    def write_identity(self, data: Dict[str, Any]):
        pass
```

**File Implementations:**

Each file implementation follows the same pattern as current `LedgerStore` but handles only its own file:

```python
class FileStagingStore(AbstractStagingStore):
    def __init__(self, path: Path):
        self.path = path
        self._ensure_path()
        if not path.exists():
            self.write_entries([])

    def read_entries(self) -> List[Dict[str, Any]]:
        if not self.path.exists():
            return []
        return json.loads(self.path.read_text())

    def write_entries(self, data: List[Dict[str, Any]]):
        self.path.write_text(json.dumps(data, indent=2))

    def append_entry(self, entry):
        entries = self.read_entries()
        entries.append(entry)
        self.write_entries(entries)

    def remove_entries(self, indices):
        entries = self.read_entries()
        for idx in sorted(indices, reverse=True):
            if 0 <= idx < len(entries):
                entries.pop(idx)
        self.write_entries(entries)

    def update_entry(self, index, fields):
        entries = self.read_entries()
        if 0 <= index < len(entries):
            entries[index].update(fields)
            self.write_entries(entries)

    def _ensure_path(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
```

**Dependency injection:**

```python
# Current (monolithic):
store = LedgerStore(staging_path, ledger_path, index_path)
ledger = LedgerDomain(crypto, store)

# Target (separate stores):
staging_store = FileStagingStore(staging_path)
ledger_store = FileLedgerStore(ledger_path)
index_store = FileIndexStore(index_path)
identity_store = FileIdentityStore(identity_path)
config_store = FileConfigStore(config_path)

# Device identity: random UUID, stored in config
config = ConfigManager(config_store)
device_identity = RandomUUIDDeviceIdentityProvider(config)


staging = StagingService(crypto, staging_store, device_identity)
ledger = LedgerEngine(crypto, ledger_store, index_store, identity_store)
```

---

### Item 8: Configurable Summary Policy

**Problem:** Year and month summary insertion logic is hardcoded inside `sync_day()` and `sync_day_with_selection()` in `core/ledger.py`. If someone wants weekly summaries, quarterly summaries, or no summaries at all, they must modify the ledger engine.

**Target:**

```
domain/ledger/summary_policy.py  ← SummaryPolicy (abstract + implementations)
```

**SummaryPolicy Interface:**

```python
class SummaryPolicy(ABC):
    """Determines when summary blocks (year, month, week, etc.) are inserted
    into the chain during a commit operation.

    The policy examines the previous block and the date of the next day block
    being committed, and inserts any necessary summary blocks into the ledger.
    """

    @abstractmethod
    def check_and_insert(self, prev_block: Dict[str, Any],
                         next_date: str,
                         ledger: List[Dict[str, Any]],
                         crypto: CryptoManager,
                         identity_secret: Optional[bytes]) -> Dict[str, Any]:
        """Inspect the previous block and the upcoming commit date.

        If a summary block is needed (e.g., crossing a year boundary),
        insert it into the ledger list.

        Args:
            prev_block: The current last block in the ledger.
            next_date: The date (YYYY-MM-DD) of the day block about to be committed.
            ledger: The ledger list (mutated in place if summaries are inserted).
            crypto: For sealing and signing the summary block.
            identity_secret: For signing (optional).

        Returns:
            The new predecessor block (either original prev_block or the last
            inserted summary block).
        """
        pass
```

**Built-in Implementations:**

```python
class YearMonthSummaryPolicy(SummaryPolicy):
    """Current behavior: year and month boundary summaries.

    Insert sequence:
      Year summary when curr_date.year > prev_date.year
      Month summary when curr_date.month > prev_date.month
    """
    def check_and_insert(self, prev_block, next_date, ledger, crypto, identity_secret):
        import time
        prev_date = time.strptime(prev_block.get("date", "1970-01-01"), "%Y-%m-%d")
        curr_date = time.strptime(next_date, "%Y-%m-%d")

        # Year transition
        if curr_date.tm_year > prev_date.tm_year and prev_block.get("type") != "year_summary":
            summary = self._build_year_summary(prev_block, prev_date.tm_year, next_date, crypto, identity_secret)
            ledger.append(summary)
            prev_block = ledger[-1]
            prev_date = time.strptime(next_date, "%Y-%m-%d")

        # Month transition
        if curr_date.tm_mon > prev_date.tm_mon and prev_block.get("type") != "month_summary":
            summary = self._build_month_summary(prev_block, prev_date, next_date, crypto, identity_secret)
            ledger.append(summary)
            prev_block = ledger[-1]

        return prev_block

    def _build_year_summary(self, prev_block, year, next_date, crypto, identity_secret):
        year_hash_key = prev_block.get("day_hash") or prev_block.get("month_hash") or prev_block.get("year_hash")
        summary = {
            "type": "year_summary",
            "year": year,
            "prev_hash": year_hash_key,
            "date": next_date,
        }
        summary["year_hash"] = crypto.seal(json.dumps(summary, sort_keys=True))
        if identity_secret:
            summary["signature"] = crypto.sign(summary["year_hash"], identity_secret)
        return summary

    def _build_month_summary(self, prev_block, prev_date, next_date, crypto, identity_secret):
        month_hash_key = prev_block.get("day_hash") or prev_block.get("month_hash") or prev_block.get("year_hash")
        summary = {
            "type": "month_summary",
            "month": f"{prev_date.tm_year}-{prev_date.tm_mon:02d}",
            "prev_hash": month_hash_key,
            "date": next_date,
        }
        summary["month_hash"] = crypto.seal(json.dumps(summary, sort_keys=True))
        if identity_secret:
            summary["signature"] = crypto.sign(summary["month_hash"], identity_secret)
        return summary


class YearOnlySummaryPolicy(SummaryPolicy):
    """Only year summaries, no month summaries."""
    def check_and_insert(self, prev_block, next_date, ledger, crypto, identity_secret):
        import time
        prev_date = time.strptime(prev_block.get("date", "1970-01-01"), "%Y-%m-%d")
        curr_date = time.strptime(next_date, "%Y-%m-%d")

        if curr_date.tm_year > prev_date.tm_year and prev_block.get("type") != "year_summary":
            summary = self._build_year_summary(prev_block, prev_date.tm_year, next_date, crypto, identity_secret)
            ledger.append(summary)
            prev_block = ledger[-1]

        return prev_block


class WeeklySummaryPolicy(SummaryPolicy):
    """Insert ISO week summaries instead of months."""
    def check_and_insert(self, prev_block, next_date, ledger, crypto, identity_secret):
        import datetime
        prev_dt = datetime.datetime.strptime(prev_block.get("date", "1970-01-01"), "%Y-%m-%d")
        curr_dt = datetime.datetime.strptime(next_date, "%Y-%m-%d")

        prev_iso_year, prev_iso_week, _ = prev_dt.isocalendar()
        curr_iso_year, curr_iso_week, _ = curr_dt.isocalendar()

        # Insert week summaries for each week boundary crossed
        while (curr_iso_year, curr_iso_week) > (prev_iso_year, prev_iso_week):
            summary = {
                "type": "week_summary",
                "week": f"{prev_iso_year}-W{prev_iso_week:02d}",
                "prev_hash": prev_block.get("day_hash") or prev_block.get("week_hash") or prev_block.get("year_hash"),
                "date": next_date,
            }
            summary["week_hash"] = crypto.seal(json.dumps(summary, sort_keys=True))
            if identity_secret:
                summary["signature"] = crypto.sign(summary["week_hash"], identity_secret)
            ledger.append(summary)
            prev_block = ledger[-1]
            # Advance to next week
            prev_dt += datetime.timedelta(days=7)
            prev_iso_year, prev_iso_week, _ = prev_dt.isocalendar()

        return prev_block


class NoSummaryPolicy(SummaryPolicy):
    """Never insert summaries. Flat chain of day blocks only."""
    def check_and_insert(self, prev_block, next_date, ledger, crypto, identity_secret):
        return prev_block
```

**Integration with LedgerEngine:**

```python
class LedgerEngine:
    def __init__(self, crypto, ledger_store, index_store, identity_store,
                 summary_policy: Optional[SummaryPolicy] = None):
        self._crypto = crypto
        self._chain = LedgerChain(crypto, ledger_store)
        self._index = IndexManager(index_store)
        self._identity = identity_store
        self._summary = summary_policy or YearMonthSummaryPolicy()  # default preserves current behavior

    def commit(self, entries: List[StagingEntryDTO]) -> str:
        ledger = self._chain.read_all()
        identity_secret = self._get_identity_secret()

        grouped = self._group_by_date(entries)

        for date_str in sorted(grouped.keys()):
            prev_block = ledger[-1]

            # Let summary policy insert any needed summary blocks
            prev_block = self._summary.check_and_insert(
                prev_block, date_str, ledger, self._crypto, identity_secret
            )

            # Build and append day block
            day_block = self._build_day_block(prev_block, date_str, grouped[date_str],
                                               identity_secret)
            ledger.append(day_block)

            # Update index
            for entry in grouped[date_str]:
                self._index.update(date_str, entry.title, entry.duration)

        self._chain.write_all(ledger)
        return ledger[-1].get("day_hash", "")[:10]
```

---



### Item 9: Device Identity Provider

**Problem:** Multiple devices using the same master key passphrase produce the same device identity (derived purely from MK). The system cannot distinguish Device A from Device B, so the device_id mismatch check never triggers — meaning devices silently overwrite each other's entries.

**Target:**

```
security/device_identity.py
```

**AbstractDeviceIdentityProvider Interface:**

```python
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Optional
import uuid
import hmac
import hashlib


@dataclass
class DeviceIdentity:
    """An opaque device identity with a verifiable proof.

    The device_id is a stable identifier (unique per physical device).
    The device_proof is a cryptographic assertion that proves the holder
    knows the master key associated with this device_id.
    """
    device_id: str          # Stable, unique per device, never changes
    device_proof: str       # HMAC(mk, "phpoc:device:" + device_id)
    device_label: str       # Human-readable name (e.g. "MacBook Air")


class AbstractDeviceIdentityProvider(ABC):
    """Pluggable strategy for generating and resolving device identities.

    Implementations control HOW a device gets its identity:
      - Random UUID (recommended for simple use)
      - Hardware-bound (TPM, secure enclave)
      - OS-provided (/etc/machine-id)
      - User-chosen label + salt
      - Hybrid (UUID + HMAC proof)
    """

    @abstractmethod
    def get_device_identity(self, master_key: bytes) -> DeviceIdentity:
        """Return this device's stable identity.

        Called once per session (or once per cached auth window).
        The implementation decides whether to generate, read from config,
        or derive from hardware.
        """
        pass

    @abstractmethod
    def verify_device_proof(self, device_id: str, device_proof: str,
                             master_key: bytes) -> bool:
        """Verify that a device_proof matches a given device_id and master_key.

        This is the cross-device check: when device B encounters a blob
        last touched by device A, it verifies A's proof independently.
        """
        pass

    @abstractmethod
    def check_remote_identity(self, remote_device_id: str,
                               remote_device_proof: str,
                               local_identity: DeviceIdentity,
                               master_key: bytes) -> bool:
        """Check if the remote blob's last device matches this device.

        Returns True if remote was last touched by THIS device
        (no re-auth needed). Returns False if different device
        (pull + merge required before modifying).
        """
        pass
```

**RandomUUIDDeviceIdentityProvider (default implementation):**

```python
class RandomUUIDDeviceIdentityProvider(AbstractDeviceIdentityProvider):
    """Device identity via random UUID, stored in config.

    Translates to any stack:
      - Python: uuid4()
      - JavaScript: crypto.randomUUID()
      - Rust: Uuid::new_v4()
      - Go: uuid.New()
      - Swift: UUID()
      - Kotlin: UUID.randomUUID()
    """

    def __init__(self, config_manager):
        self._config = config_manager
        self._cached_identity: Optional[DeviceIdentity] = None

    def get_device_identity(self, master_key: bytes) -> DeviceIdentity:
        if self._cached_identity is not None:
            return self._cached_identity

        # Read or generate device_id from config
        config = self._config.read()
        if "device_id" not in config:
            config["device_id"] = str(uuid.uuid4())
            config["device_label"] = socket.gethostname() or "unknown"
            self._config.write(config)

        device_id = config["device_id"]
        device_label = config.get("device_label", device_id[:8])

        # Proof = HMAC(mk, "phpoc:device:" + device_id)
        proof = hmac.new(
            master_key,
            f"phpoc:device:{device_id}".encode(),
            hashlib.sha256
        ).hexdigest()

        identity = DeviceIdentity(
            device_id=device_id,
            device_proof=proof,
            device_label=device_label
        )
        self._cached_identity = identity
        return identity

    def verify_device_proof(self, device_id: str, device_proof: str,
                             master_key: bytes) -> bool:
        expected = hmac.new(
            master_key,
            f"phpoc:device:{device_id}".encode(),
            hashlib.sha256
        ).hexdigest()
        return hmac.compare_digest(expected, device_proof)

    def check_remote_identity(self, remote_device_id: str,
                               remote_device_proof: str,
                               local_identity: DeviceIdentity,
                               master_key: bytes) -> bool:
        # First verify the remote's proof is valid (proves they know MK)
        if not self.verify_device_proof(remote_device_id, remote_device_proof, master_key):
            return False  # Remote blob was touched by someone without this MK
        # Then check if it's the same physical device
        return remote_device_id == local_identity.device_id
```

**Interface rationale (for cross-stack portability):**

| Method | Standard library equivalent per language |
|--------|----------------------------------------|
| `uuid4()` | Python: `uuid.uuid4()`, JS: `crypto.randomUUID()`, Rust: `Uuid::new_v4()`, Go: `uuid.New()` |
| `HMAC-SHA256` | Python: `hmac.new()`, JS: `crypto.createHmac()`, Rust: `hmac::Hmac::<Sha256>`, Go: `hmac.New(sha256.New)` |
| `hmac.compare_digest()` | Python: `hmac.compare_digest()`, JS: `crypto.timingSafeEqual()`, Rust: `hmac::Hmac::verify_slice()` |

**What this enables:**
- Two devices with the same master key get different UUIDs → remote blob detects mismatch → triggers pull + merge
- Device proof prevents forgery: an attacker with the UUID can't impersonate the device without the master key
- Pluggable interface allows hardware-backed identity (TPM, Secure Enclave) without changing any other code

---

### Item 10: Staging Interaction Flow — Every-Command Sync with Offline Tolerance

**Problem:** The original design delays remote sync until an explicit `phpoc sync` command. This means entries added on Device B are invisible to Device A until A explicitly syncs. If A forgets to sync before switching to B, B sees stale staging.

**Target:** Every staging command (add, end, pause, unpause, modify, remove) acts as an event that triggers remote check-and-sync automatically. Remote is a mirror of local staging at all times (when network is available).

**Flow:**

```
Every staging command:

  ┌─ StagingService.capture() / end() / pause() / etc.
  │
  ├─► check_and_sync(timeout_ms=500)
  │     │
  │     ├─► remote available within 500ms?
  │     │     ├── Yes ──► check device_id match
  │     │     │              ├── Match ──► pull → merge
  │     │     │              └── No ──► cached auth valid?
  │     │     │                    ├── Yes (30m window) ──► pull → merge
  │     │     │                    └── No ──► re-auth → pull → merge
  │     │     └── No ──► OFFLINE (local op only)
  │     │
  │     ▼ Returns SyncCheckResult
  │
  ├─► Perform local op (CRUD on LocalStagingCache)
  │
  └─► If READY: push_to_remote()
      If OFFLINE: queue for later push
```

**Key design points:**

| Aspect | Decision | Rationale |
|--------|----------|-----------|
| Timeout | 500ms, configurable | CLI must feel responsive. If remote is slow, treat as offline. |
| Offline behavior | Local op only, queue for push | Never block the user. Entries accumulate in local cache. |
| Reconnection | Next command after network returns triggers check | No background service needed. Event-driven. |
| Merge semantics | Deduplicated by (title, start_epoch), sorted by start time | Timeline model: no two entries collide at millisecond precision. |
| Auth cache | 30 minutes, configurable in config file | User types passphrase once per session, not on every command. |

**SyncCheckResult enum:**

```python
class SyncCheckResult(Enum):
    READY = "ready"           # Remote synced, proceed with local op then push
    OFFLINE = "offline"       # Remote unreachable, local op only
    REAUTH_NEEDED = "reauth"  # Device mismatch and auth expired
```

**MergeEngine behavior:**

```python
class MergeEngine:
    def merge(self, local: List[dict], remote: List[dict]) -> List[dict]:
        """Merge remote entries into local cache.

        Entries are deduplicated by (title, start_epoch).
        Remote wins on ties (more recent source).
        Returns merged list sorted by start_epoch.
        """
        seen = {}
        for e in local:
            key = (e["title"], e["start_epoch"])
            seen[key] = e
        for e in remote:
            key = (e["title"], e["start_epoch"])
            seen[key] = e  # remote overwrites local on tie (remote is newer)
        return sorted(seen.values(), key=lambda e: e["start_epoch"])
```

**What this means for the user:**
- Switch from laptop to phone: first command on phone detects device_id mismatch, pulls remote, merges, adds your entry, pushes. All entries visible on both devices.
- Offline on a plane: add entries locally. Land, open phone, first command triggers sync. Everything pushes and merges.
- Slow cafe WiFi (3000ms latency): first command times out at 500ms, treats as offline. Second command (same session) also offline. Eventually connection improves, sync happens.

---

### Item 11: Config File Format

**Problem:** Currently paths, keys, and settings are hardcoded or passed as CLI arguments. There is no single user-editable configuration file where the user can set remote staging location, remote ledger location, auth cache timeout, or device identity.

**Target:**

```
~/.config/personal_history_poc/
  ├── config.json            ← User-editable configuration (NEW)
  ├── staging.json           ← Local staging cache (existing)
  ├── ledger.json            ← Ledger chain (existing)
  ├── index.json             ← Blind index (existing)
  └── identity.json          ← Identity storage (existing)
```

**ConfigManager API:**

```python
class ConfigManager:
    """Read/write config.json with defaults.

    The config file is user-editable JSON. If a field is missing,
    the default value is used. No validation — malformed files
    produce a clear error message.
    """

    DEFAULTS = {
        "remote": {
            "staging_path": None,       # e.g. "~/phpoc-sync/staging/blobs"
            "ledger_path": None,        # e.g. "~/phpoc-sync/ledger"
            "transport": "git",         # "git" | "http" (future)
            "git_remote_url": None,     # e.g. "https://github.com/user/phpoc-sync.git"
        },
        "auth": {
            "cache_timeout_minutes": 30,   # How long re-auth is cached
            "passphrase_required": True,   # Allow NoAuth mode? (future)
        },
        "device": {
            "device_id": None,          # Generated on first init (Item 9)
            "device_label": None,       # Human-readable name
        },
        "timeouts": {
            "remote_check_ms": 500,     # Max wait for remote check (Item 10)
            "push_timeout_ms": 5000,    # Max wait for push operation
        },
        "staging": {
            "blob_size_tier": "64K",    # "64K" | "128K" | "256K" | "512K"
        },
    }

    def __init__(self, config_store):
        self._store = config_store
        self._config = None

    def read(self) -> dict:
        """Read config, merging with defaults."""
        if self._config is not None:
            return self._config
        raw = self._store.read_config() or {}
        self._config = self._deep_merge(self.DEFAULTS, raw)
        return self._config

    def write(self, config: dict):
        """Write config (preserving comments/structure)."""
        self._config = config
        self._store.write_config(config)

    def get(self, key_path: str, default=None):
        """Access nested config with dot notation.

        config.get("remote.staging_path")
        config.get("auth.cache_timeout_minutes", 30)
        """
        keys = key_path.split(".")
        value = self.read()
        for k in keys:
            if not isinstance(value, dict):
                return default
            value = value.get(k)
            if value is None:
                return default
        return value

    @staticmethod
    def _deep_merge(defaults: dict, overrides: dict) -> dict:
        """Merge overrides into defaults (preserving all keys)."""
        result = {}
        for key, default_val in defaults.items():
            if key in overrides:
                if isinstance(default_val, dict) and isinstance(overrides[key], dict):
                    result[key] = ConfigManager._deep_merge(default_val, overrides[key])
                else:
                    result[key] = overrides[key]
            else:
                result[key] = default_val
        for key in overrides:
            if key not in result:
                result[key] = overrides[key]
        return result
```

**Example config.json (user-editable):**

```json
{
    "remote": {
        "staging_path": "staging/blobs",
        "ledger_path": "ledger",
        "transport": "git",
        "git_remote_url": "https://github.com/alice/phpoc-history.git"
    },
    "auth": {
        "cache_timeout_minutes": 30
    },
    "timeouts": {
        "remote_check_ms": 500,
        "push_timeout_ms": 5000
    }
}
```

**AbstractConfigStore (parallel to other storage stores):**

```python
class AbstractConfigStore(ABC):
    @abstractmethod
    def read_config(self) -> Optional[Dict[str, Any]]:
        pass

    @abstractmethod
    def write_config(self, data: Dict[str, Any]):
        pass
```

**FileConfigStore:**

```python
class FileConfigStore(AbstractConfigStore):
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if not self.path.exists():
            self.write_config(ConfigManager.DEFAULTS)

    def read_config(self) -> Optional[Dict[str, Any]]:
        if not self.path.exists():
            return None
        return json.loads(self.path.read_text())

    def write_config(self, data: Dict[str, Any]):
        self.path.write_text(json.dumps(data, indent=2))
```

**What this unblocks:**
- User edits `config.json` to point to a git remote → PHPOC uses it on next command
- User increases `cache_timeout_minutes` → fewer passphrase prompts
- `device_id` is generated here on first init (Item 9)
- All layers read from one config object instead of hardcoded paths

---

## 4. Dependency Graph & Ordering

Not all items can be done in parallel. Some depend on others:

```
Item 7: Split Storage Interfaces
  │
  ├──▶ Item 4: Eliminate plain: prefix (needs StagingStore)
  │       │
  │       └──▶ Item 1: Staging Service Local/Remote (needs Item 4 + Item 7)
  │               │
  │               └──▶ Item 10: Staging Interaction Flow (integrated into Item 1)
  │               └──▶ Item 3: Sync Orchestrator (needs Item 1 + Item 2)
  │
  ├──▶ Item 2: Ledger Engine + IndexManager (needs LedgerStore + IndexStore)
  │       │
  │       └──▶ Item 6: IndexManager (sub-item of Item 2)
  │       │
  │       └──▶ Item 8: Summary Policy (integrated into Item 2)
  │
  ├──▶ Item 5: Abstract View Interface (independent, but needs Item 1 for DTO types)
  │       │
  │       └──▶ Item 3: Sync Orchestrator (needs ViewInterface)
  │
  ├──▶ Item 9: Device Identity Provider (needs ConfigStore from Item 7)
  │
  └──▶ Item 11: Config File Format (needs ConfigStore from Item 7)
          │
          └──▶ Item 9: Device Identity (needs ConfigManager from Item 11)
          └──▶ Item 10: Staging Flow (reads timeout config from Item 11)
```

### Recommended Phase Order

| Phase | Items | Duration Estimate | Risk Level |
|-------|-------|-------------------|------------|
| **Phase 1** ✅ | Item 7 (Split Storage) + Item 11 (Config) | Weeks 1–2 | 🟢 Low — structural refactors + new config store |
| **Phase 1b** ✅ | Item 5 (View Interface) | Part of Phase 1 | 🟢 Low — move logic to ViewInterface + CLIView |
| **Phase 2** ✅ | Item 4 (Eliminate plain:) + Item 1 (Staging Service) + Item 9 (Device ID) | Weeks 3–4 | 🟡 Medium — extract from core/ledger.py, new identity provider |
| **Phase 3** | Item 2 (Ledger Engine + IndexManager + SummaryPolicy) | Weeks 5–6 | 🟡 Medium — extract from core/ledger.py, chain logic must remain correct |
| **Phase 4** | Item 10 (Staging Interaction Flow) | Week 7 | 🟡 Medium — integrates every-command sync into Item 1 |
| **Phase 5** | Item 3 (Sync Orchestrator) | Week 8 | 🟢 Low — wires existing components together |
| **Phase 6** | Item 6 (IndexManager deep integration) | Sub-task of Phase 3 | 🟢 Low — already done |
| **Phase 7** | Item 8 (SummaryPolicy) | Sub-task of Phase 3 | 🟢 Low — already done |

### Phase 1 Detail (Split Storage + Config — ✅ Complete)

See commit [`6b80b60`](https://github.com/.../commit/6b80b60).

**Completed files:**

(see 12-file listing above)

### Phase 1b Detail (View Interface — ✅ Complete)

See commit [`ab86b8b`](https://github.com/.../commit/ab86b8b).

**Completed files (5 new files, 62 tests):**

Abstract interface:
- `domain/interfaces/view.py`  ← ViewInterface (14 display + 6 input methods, all no-op defaults)

CLI files (extracted from main.py, cli/interface.py, core/sync_confirmation.py):
- `cli/cli_parsers.py`         ← parse_time_input() (from main.py)
- `cli/cli_view.py`            ← CLIView(ViewInterface) — 830 lines
- `cli/strategies.py`          ← InteractiveCLIStrategy + AutoSyncStrategy
                                   + SyncDecision + SyncStrategy

Tests:
- `tests/test_phase1b_view_interface.py`  ← 62 tests

**What moved where (all CLI code, 0 domain changes):**

| Source | Target |
|--------|--------|
| `main.py` `_parse_time_input()` | `cli/cli_parsers.py` `parse_time_input()` |
| `main.py` `_handle_modify()` | `cli/cli_view.py` `interactive_modify()` |
| `main.py` `_handle_remove()` | `cli/cli_view.py` `interactive_remove()` |
| `main.py` `_handle_review()` | `cli/cli_view.py` `interactive_review()` |
| `main.py` `_print_staging_line()` | `cli/cli_view.py` `_print_staging_line()` |
| `main.py` `_list_tags()` | `cli/cli_view.py` `render_tags()` |
| `cli/interface.py` `CLIInterface` | `cli/cli_view.py` `CLIView` (all methods) |
| `core/sync_confirmation.py` strategies | `cli/strategies.py` |

**Key design decisions:**
- ViewInterface uses duck-typed abstract with no-op defaults (not ABC) — views override only what their medium supports
- CLIView takes a `ledger` argument for decryption; this coupling will be removed in Phase 2 when `plain:` is eliminated
- InteractiveCLIStrategy delegates ALL I/O to ViewInterface — it contains zero `print()` or `input()` calls
- SyncDecision is a plain class (not dataclass) to avoid coupling strategies.py to Python stdlib

### Phase 2 Detail (plain: + Staging Service — ✅ Complete)

See commit [`f5fa377`](https://github.com/.../commit/f5fa377).

**Goal:** Extract all staging logic from `core/ledger.py` into `domain/staging/`.

**Completed files (5 new files, 112 tests):**

Domain files:
- `domain/staging/local_cache.py`  ← LocalStagingCache (sole owner of `plain:` prefix)
- `domain/staging/service.py`      ← StagingService (public API facade)
- `domain/staging/merge_engine.py` ← MergeEngine (timestamp-based dedup)
- `domain/staging/remote_sync.py`  ← RemoteStagingSync + SyncCheckResult

Security:
- `security/device_identity.py`    ← DeviceIdentity + AbstractDeviceIdentityProvider
                                       + RandomUUIDDeviceIdentityProvider

**Key design points:**
- `LocalStagingCache` is the ONLY class that knows about `plain:` — no other component
  sees `startswith("plain:")` checks
- `StagingService` exposes all CRUD methods with zero `plain:` leakage
- `StagingService` has zero `print()` calls — fully view-agnostic
- `MergeEngine` is a pure function: no I/O, no side effects
- `RandomUUIDDeviceIdentityProvider` uses UUID4 (persisted in config) +
  HMAC-SHA256 proof — cross-stack portable (uuid4, hmac, sha256)
- `RemoteStagingSync.check_remote_available()` is timeout-aware (500ms default)
- All 112 tests use mocks: no filesystem IO, no external dependencies
- Old `core/ledger.py` methods untouched (backward compat — will become
  thin wrappers in Phase 5)

### Phase 3 Detail (Ledger Engine)

**Goal:** Extract all ledger chain logic from `core/ledger.py` into `domain/ledger/`.

**Target files:**
```
domain/ledger/
  ├── chain.py           ← LedgerChain (local chain operations)
  ├── index_manager.py   ← IndexManager (blind index)
  ├── summary_policy.py  ← SummaryPolicy (abstract + implementations)
  └── engine.py          ← LedgerEngine (public API facade)
```

**Approach:** Test-first. Write `tests/test_phase3_ledger_engine.py` before implementing,
covering all methods extracted from `core/ledger.py`.

**LedgerChain (`domain/ledger/chain.py`):**
Move chain operations currently in `core/ledger.py`:
- `compute_seal()` / `verify_seal()` — HMAC seal over block content
- `compute_signature()` / `verify_signature()` — HMAC signature using identity secret
- `read_all()` — full chain read
- `get_block(index)` / `get_last_block()` — single block access
- `append(block)` — append single block
- `append_blocks(blocks)` — batch append (for remote sync)
- `truncate(keep_count)` — removes last N blocks, returns removed
- `verify_block(block, prev_hash)` — validate linkage, seal, signature
- `checksum_chain()` — verify entire chain integrity
- `verify_all_entry_hashes()` — verify every entry hash in every day block
- `verify_all_content_hashes()` — deep verify content hashes

**IndexManager (`domain/ledger/index_manager.py`):**
Move index operations currently in `core/ledger.py`:
- `update(date, title, duration_delta)` — add/subtract duration
- `query(from_date, to_date)` — aggregate durations over range
- `rebuild_from_chain(ledger, decrypt_fn)` — full rebuild
- `get_all()` / `clear()` — raw access

**SummaryPolicy (`domain/ledger/summary_policy.py`):**
Extract summary insertion logic from `sync_day()` / `sync_day_with_selection()`:
- `SummaryPolicy` abstract base class
- `YearMonthSummaryPolicy` (current behavior — year + month summaries)
- `YearOnlySummaryPolicy`, `WeeklySummaryPolicy`, `NoSummaryPolicy`

**LedgerEngine (`domain/ledger/engine.py`):**
High-level API:
- `commit(entries)` — group by date, run summary policy, build day blocks, append to chain, update index
- `verify(full_check)` — verify chain integrity + optional content hash deep check
- `revert(count)` — truncate N day blocks, restore entries to staging, subtract from index
- `query_index(from_date, to_date)` — delegate to IndexManager
- `rebuild_index()` — rebuild from chain
- `get_block_count()` / `get_day_blocks()` — chain introspection

**Critical constraint:** Chain format must remain IDENTICAL. Block generation logic
(seal, sign, hash computation) is extracted without changing the algorithm.
Verify by running `verify()` on an existing ledger before and after —
hash chain must produce identical results.

**Backward compatibility:**
The old `core/ledger.py` methods (`sync_day`, `sync_day_with_selection`,
`sync_with_strategy`, `verify`, `revert_entries`, etc.) become thin wrappers
that delegate to `LedgerEngine` + `StagingService`, ensuring all existing
callers (tests, main.py, CLI) continue working without changes.

### Phase 4 Detail (Sync Orchestrator)

**Goal:** Create the coordinator that ties all layers together.

Steps:
1. Create `core/sync/orchestrator.py` — implement the sync flow from the [SyncOrchestrator](#syncorchestrator) section above.
2. Create `core/sync/decision.py` — move `SyncDecision` and `SyncStrategy` interface here.
3. Update `main.py` to call `SyncOrchestrator.sync()` instead of `ledger.sync_with_strategy()`.
4. Remove old `core/sync_confirmation.py`.

---

## 5. Obstacles & Mitigations Summary

| # | Obstacle | Risk | Mitigation |
|---|----------|------|------------|
| O1 | Current tests test `core/ledger.py` directly — refactoring will break them | 🟡 Medium | Keep old class as a thin wrapper that delegates to new classes. Tests pass without changes. Remove wrapper once all callers migrate. |
| O2 | `NoAuthCryptoManager` is used in many places — removing it affects `add/start/end/pause/unpause` commands | 🟡 Medium | `StagingService` will handle `plain:` internally. The `add`/`start`/`end` commands in `main.py` just need to call `StagingService.capture()` instead of `ledger.capture_habit()`. The `NoAuthCryptoManager` class can be deprecated but kept until all callers migrate. |
| O3 | `main.py` has 300+ lines of handler functions that read/write staging directly | 🟡 Medium | Move handlers to `cli/cli_view.py` Phase 1. Then have them call `StagingService` Phase 2. Incremental — each handler is a self-contained migration. |
| O4 | `plain:` prefix convention requires testing for every staging operation | 🟢 Low | `LocalStagingCache` is the single point of truth. Unit test its `_to_plain()` and `_from_plain()` methods. Integration tests verify that `get_entries()` never returns `plain:`-prefixed values. |
| O5 | Remote transport (git) not yet implemented — can't fully test RemoteStagingSync | 🟢 Low | `RemoteStagingSync` can be tested with an in-memory mock transport. The `AbstractStagingTransport` interface is minimal (pull/push). Git implementation can be added later. |
| O6 | DeviceIdentityProvider is new code with no existing equivalent | 🟢 Low | Default implementation derives from Master Key via HMAC — same primitives already in use. Test with known MK and compare outputs. |
| O7 | Sync Orchestrator changes the sync flow — existing sync tests need updating | 🟡 Medium | Write new tests for `SyncOrchestrator` with mock `StagingService`, `LedgerEngine`, and `ViewInterface`. Old integration tests (staging → sync → verify) continue testing the same data path end-to-end. |
| O8 | Chain format must remain identical — refactoring must not change seals/signatures | 🔴 High | Block generation logic (seal, sign, hash computation) is extracted into `LedgerChain` without changing the algorithm. Verify by running `verify()` on an existing ledger before and after the refactor — hash chain must be identical. |
| O9 | File paths and config directory convention must be preserved | 🟢 Low | Each file store implementation takes a `Path` parameter — same paths as current config. The `LedgerFactory.initialize()` needs updating to create the new store instances. |
| O10 | Every staging command touches remote — performance concern for quick-fire operations (e.g., rapid `add` calls) | 🟡 Medium | 500ms timeout treats slow connections as offline. Operation is local-only, push is async. For rapid-fire CLI use (e.g., `add` then `start`), the second command likely reuses the already-pulled local cache without a full re-pull. |
| O11 | Device UUID collision across devices is astronomically unlikely (2^122) but not impossible | 🟢 Low | UUID4 has 122 random bits. Collision probability is negligible. If it happens (theoretical), the HMAC proof would still verify, but the device_id check would not trigger a merge. User would see stale data and file a bug — the fix is deleting the stale device's config. |
| O12 | Config file is user-editable — user can corrupt it, set invalid paths, or delete device_id | 🟢 Low | ConfigManager validates nothing. Missing fields fall back to defaults. Corrupt JSON raises a clear exception with the file path. Deleted device_id is regenerated (new UUID — device gets "new" identity, which is fine; it just triggers a full pull+merge on next remote check). |

---

## 6. Testing Strategy

The migration introduces new files and classes but should not change existing behavior. The testing strategy is:

### Unit Tests (Phase 1 ✅ — 68 tests, all passing)

| Component | File | Test Focus | Status |
|-----------|------|------------|--------|
| `FileStagingStore` | `storage/implementations/file_staging.py` | Read/write/append/remove/update, empty file, disk persistence | ✅ 12 tests |
| `FileLedgerStore` | `storage/implementations/file_ledger.py` | Partial reads (start/end/negative), truncate, get_block_count, get_last_block, empty chain | ✅ 13 tests |
| `FileIndexStore` | `storage/implementations/file_index.py` | Read/write/overwrite, missing file, disk persistence | ✅ 4 tests |
| `FileIdentityStore` | `storage/implementations/file_identity.py` | Read (exists/missing), write/overwrite, disk persistence | ✅ 5 tests |
| `FileConfigStore` | `storage/implementations/file_config.py` | Read (exists/missing/empty), write/roundtrip, disk persistence | ✅ 4 tests |
| `ConfigManager` | `security/config_manager.py` | Defaults merge, dot-notation get, write, deep_merge, cache, edge cases | ✅ 11 tests |
| Abstract contracts | — | Verify each abstract class cannot be instantiated | ✅ 5 tests |
| Multi-store isolation | — | Verify 5 stores don't interfere with each other, all files created independently | ✅ 5 tests |
| Edge cases | — | Corrupt JSON, empty files, remove/truncate on empty stores | ✅ 5 tests |
| **Total** | `tests/test_phase1_storage_interfaces.py` | | **✅ 68 tests** |

### Unit Tests (Phase 1b ✅ — 62 tests, all passing)

| Component | File | Test Focus | Status |
|-----------|------|------------|--------|
| `ViewInterface` | `domain/interfaces/view.py` | All 20 methods, no-op defaults, string return types | ✅ 5 tests |
| `CLIView` | `cli/cli_view.py` | Entry formatting, tag rendering, interactive workflows, prompt parsing, edge cases | ✅ 44 tests |
| `InteractiveCLIStrategy` | `cli/strategies.py` | Three-stage flow, edit menu, sync confirmation, empty state | ✅ 8 tests |
| `AutoSyncStrategy` | `cli/strategies.py` | Selects all, empty pending returns cancelled | ✅ 3 tests |
| `SyncDecision` | `cli/strategies.py` | Properties, cancellation, empty state | ✅ 2 tests |
| **Total** | `tests/test_phase1b_view_interface.py` | | **✅ 62 tests** |

### Unit Tests (Phase 2 ✅ — 112 tests, all passing)

| Component | File | Test Focus | Status |
|-----------|------|------------|--------|
| `LocalStagingCache` | `domain/staging/local_cache.py` | `plain:` encode/decode, CRUD operations, tag normalization, duration/pause computation, edge cases (corrupt entries) | ✅ 38 tests |
| `MergeEngine` | `domain/staging/merge_engine.py` | Timestamp dedup, remote-wins on ties, sorting, empty sources, large merge | ✅ 12 tests |
| `RemoteStagingSync` | `domain/staging/remote_sync.py` | Device ID check, pull/push round-trip, overwrite semantics | ✅ 9 tests |
| `StagingService` | `domain/staging/service.py` | All CRUD methods, no `plain:` leakage, pause/unpause, modify, remove, queries, check_and_sync timeout | ✅ 53 tests |
| `SyncCheckResult` | `domain/staging/remote_sync.py` | Enum values, issubclass | ✅ 4 tests |
| `RandomUUIDDeviceIdentityProvider` | `security/device_identity.py` | UUID4 format, HMAC proof, caching, config persistence, verify/check identity variants | ✅ 22 tests |
| `AbstractDeviceIdentityProvider` | `security/device_identity.py` | Cannot instantiate abstract | ✅ 1 test |
| **Total** | `tests/test_phase2_staging_service.py` + `tests/test_phase2_device_identity.py` | | **✅ 112 tests** |

### Unit Tests (planned for future phases)

| Component | Test Focus |
|-----------|------------|
| `LedgerChain` | Seal computation, signature, append, truncate, verify_block |
| `IndexManager` | Update (positive/negative), query (date range), rebuild_from_chain |
| `SummaryPolicy` | Each policy produces correct summary block sequence |
| `SyncOrchestrator` | Full flow with mocks — device check, pull, decide, commit, push |
| `LedgerRemoteSync` | Incremental push/pull, block count queries |
| `ChainSplitter` | Archive, export by date range |

### Integration Tests (update existing)

The existing test suite (`tests/test_modular.py`, `tests/test_pause.py`, etc.) exercises staging CRUD + sync + verify end-to-end. These should continue to pass with minimal changes:

1. Replace `LedgerDomain(crypto, store)` with the new `StagingService` + `LedgerEngine` + `SyncOrchestrator`
2. Verify that sync produces identical chain format (same seals, same hashes)
3. Verify that `verify()` still returns `True` for the same data

### Regression Tests

| Scenario | Ensures |
|----------|---------|
| Init → add → sync → verify | Chain format unchanged |
| Init → add → pause → unpause → end → sync → verify | Pause/unpause duration computation unchanged |
| Init → add → sync → revert → verify → add → sync | Revert behavior unchanged |
| Init → add (with tags) → sync → list | Tag storage unchanged |
| Init → add → sync → verify (with index check) | Index update unchanged |
| Multi-date sync (crosses month/year) | Summary insertion identical |

---

## 7. Backward Compatibility

### Data Format

The chain format (block types, seal algorithm, encryption scheme) is **unchanged** by this migration. The refactoring is purely structural — code moves between files, algorithms stay the same.

### Configuration

Config directory remains `~/.config/personal_history_poc/`. File paths remain:
- `staging.json`
- `ledger.json`
- `index.json`
- `identity.json`

### CLI Interface

The CLI commands (`add`, `start`, `end`, `pause`, `unpause`, `sync`, `verify`, `list`, `rep`, `modify`, `remove`, `review`, `revert`) remain identical. No user-facing changes.

### API Compatibility

The old `LedgerDomain` class in `core/ledger.py` will be kept as a thin wrapper during the migration phase, delegating to the new `StagingService` and `LedgerEngine`. This allows each caller to migrate independently.

---

## 8. Cross-Stack Portability Assessment

> **Question:** How translatable is PHPOC as a whole (architecture, implementation, strategy) to other application stacks?
> **Answer:** Highly portable. Every layer uses standardized primitives available in all modern languages.

### Layer-by-Layer Analysis

#### 8.1 Cryptographic Layer

| Primitive | Python | Rust | Go | TypeScript/Node | Swift | Kotlin |
|-----------|--------|------|-----|-----------------|-------|--------|
| AES-256-CTR | Custom pure-Python (zero-dep) | `aes::Aes256Ctr` crate | `crypto/aes` + CTR mode | `crypto.createCipheriv('aes-256-ctr')` | `kCCEncrypt(kCCAlgorithmAES)` | `Cipher.getInstance("AES/CTR/NoPadding")` |
| PBKDF2-SHA256 | `hashlib.pbkdf2_hmac` | `pbkdf2` crate | `x/crypto/pbkdf2` | `crypto.pbkdf2Sync` | `CommonCrypto.CCKeyDerivationPBKDF` | `SecretKeyFactory("PBKDF2WithHmacSHA256")` |
| HMAC-SHA256 | `hmac` stdlib | `hmac` crate | `crypto/hmac` | `crypto.createHmac('sha256')` | `CCHmac(kCCHmacAlgSHA256)` | `Mac.getInstance("HmacSHA256")` |
| SHA-256 | `hashlib.sha256` | `sha2` crate | `crypto/sha256` | `crypto.createHash('sha256')` | `CC_SHA256` | `MessageDigest.getInstance("SHA-256")` |

**Verdict:** 🟢 Excellent. The custom pure-Python AES is a reference-implementation choice (zero external dependencies). Production ports would use platform-native AES — faster and audited. The only requirement is matching the exact algorithm composition (salt → sub-key derivation → nonce + counter → AES-CTR → encrypt-then-MAC), which is documented in `PHPSPEC.md`. The `plain:` prefix is an internal detail being eliminated (Item 4).

#### 8.2 Storage Layer

Every language can:
- Read/write JSON files to disk (the 5 file stores are JSON wrappers)
- Define abstract interfaces (trait/interface/protocol)
- Handle errors (Result/Option/Try)

**Verdict:** 🟢 Excellent. JSON + file I/O + interfaces. Trivial in any stack.

#### 8.3 Transport Layer

The transport interface has 2 methods:
- `pull(path) -> bytes`
- `push(path, data) -> None`

Git implementations use subprocess (available everywhere). HTTP implementations use the language's HTTP client. Blob obfuscation is pad-then-encrypt using the same crypto primitives.

**Verdict:** 🟢 Excellent.

#### 8.4 Domain Logic — Staging

| Component | Primitives Used |
|-----------|----------------|
| `LocalStagingCache` | List/array CRUD, string operations |
| `MergeEngine` | Dict/hash-map dedup by tuple key, array sort |
| `RemoteStagingSync` | Crypto + transport interface calls |
| `StagingService` | Facade pattern — delegates to sub-components |

**Verdict:** 🟢 Excellent. No math, no concurrency, no platform-specific APIs.

#### 8.5 Domain Logic — Ledger

| Component | Primitives Used |
|-----------|----------------|
| `LedgerChain` | HMAC seal, SHA-256 prev_hash, array append/truncate |
| `IndexManager` | Nested dict arithmetic |
| `SummaryPolicy` | Date parsing + comparison + conditional block insertion |
| `ChainSplitter` | Array iteration, type field filtering |

The chain verification algorithm is deterministic by spec (`PHPSPEC.md`), not by Python. Any implementation following the spec produces identical verification results.

**Verdict:** 🟢 Excellent.

#### 8.6 View Layer

`ViewInterface` is an abstract contract:
- `render_entry_list()` → formatted output
- `prompt_choice()` → user input
- `notify()` / `warn()` → display

CLI: print/input equivalents. TUI: framework per language. Web: JSON serialization.

**Verdict:** 🟢 Excellent.

#### 8.7 Sync Orchestrator

Pure orchestration — calls other interfaces in sequence. No math, no crypto, no I/O. Trivial in any language.

**Verdict:** 🟢 Excellent.

#### 8.8 Device Identity

`AbstractDeviceIdentityProvider` has 3 methods, all using:
- UUID generation (`uuid4()` / `crypto.randomUUID()` / `Uuid::new_v4()`)
- HMAC-SHA256 (`hmac(mk, "phpoc:device:" + device_id)`)

**Verdict:** 🟢 Excellent.

#### 8.9 Config Manager

JSON read/write with recursive defaults merging. Trivial in every language.

**Verdict:** 🟢 Excellent.

### Overall Assessment

| Layer | Risk | Rationale |
|-------|------|-----------|
| Cryptography | 🟢 Low | Standardized algorithms. Pure-Python AES is a deployment detail, not a protocol requirement. |
| Storage | 🟢 Low | JSON files + abstract interfaces. Every language has this. |
| Transport | 🟢 Low | `pull(path)/push(data)` — 2 methods. Git via subprocess or HTTP client. |
| Staging Domain | 🟢 Low | Dict + sort + string ops. No complex math. |
| Ledger Domain | 🟢 Low | HMAC + SHA-256 + date comparisons. All standardized. |
| View Layer | 🟢 Low | Abstract I/O interface. CLI = print/input, Web = JSON. |
| Sync Orchestrator | 🟢 Low | Procedural orchestration, no math. |
| Device Identity | 🟢 Low | UUID + HMAC. Standard library in all languages. |
| Config Manager | 🟢 Low | JSON read/write + deep merge. |

**Overall: 🟢 Highly portable to any stack (Rust, Go, TypeScript, Swift, Kotlin).**

The only cross-stack requirement is matching the ledger format specification (`PHPSPEC.md`). As long as the new implementation follows the same block format, seal algorithm, and encryption scheme, it is fully compatible with ledgers produced by the Python reference implementation.

To validate this claim: write a Rust or TypeScript implementation that reads a `ledger.json` produced by the Python CLI and successfully verifies the chain. That is approximately one day of work and would fully validate the design.