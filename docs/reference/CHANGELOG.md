# Changelog

> **Only tagged, released versions belong here.** Work-in-progress is tracked in
> `../../SESSION_HANDOFF.md` and `../planning/WEB_ROADMAP.md`. Entries with `TBD` or commit hashes
> as versions are pre-release snapshots — they move to versioned entries on release.

All notable changes to the PH Ledger (phpoc) project.

## [0.6.2] — TBD (P3-Remote_Sync — remote ledger sync)

### Changed
- **Auth gate fix** — `checkAndSync()` now proceeds to `_reconcileAndClaim()` when the master key is cached but no local cookie exists (fresh device after onboarding/login). Previously returned `REAUTH_NEEDED` unconditionally, which was never handled by the reauth overlay.
- **SyncSettings status fix** — `displayStatus` no longer overrides `STATUS_READY` with `STATUS_NOT_SYNCED` when uncommitted staging entries exist. Only shows `NOT_SYNCED` when `remoteStatus !== READY`.
- **Re-auth overlay wired** — `triggerReauth`/`dismissReauth`/`handleReauth` added to DevModeContext. `reauthActive` state exposed via context. SyncSettings triggers the `AuthScreen` overlay when `checkAndSync()` returns `REAUTH_NEEDED`. `handleReauth()` derives the master key from passphrase+seed on the existing crypto instance (no re-bootstrap), caches it, and dismisses the overlay.
- **Cross-platform JSON serialization** — `jsonSort()` in `src/ledger/utils.js` now produces output byte-identical to Python's `json.dumps(obj, sort_keys=True)` (sorted keys at all nesting levels, `": "` and `", "` separators). All seal/hash computation across the web codebase uses this canonical format: `ledger_export.js`, `ledger_import.js`, `summary_policy.js`, `local_cache.js`, `MockDataSeeder.js`. `LedgerChain.verifySeal()` has dual-verification fallback for pre-migration compact-JSON ledgers. New `utils_test.mjs` (27 tests) validates Python parity. (2026-06-20)
- **Auto-sync Proxy fix** — `effectiveServices` now uses a `Proxy` instead of `{ ...rawSync }` spread to preserve class prototype methods (`getCompleted`, `markCommitted`, `_local`, etc.). The spread operator only copies own enumerable properties, silently dropping methods on the prototype. (2026-06-20)

### Added
- **Multi-device auto-sync hook** (`createAutoSync` / `useAutoSync`) — wraps all 6 SyncService mutation methods with debounced `pushToRemote()`. After any staging mutation, a debounced push fires once the batch settles. `isSyncing` tracks debounce/push lifecycle; `dispose()` cancels pending debounce and suppresses in-flight state updates. Push skipped when no master key cached. Push errors logged but never break mutations. 24-assertion test suite (58 sub-checks), 0 failures. (2026-06-20)
- **`getMasterKey()` on SyncService** — exposes cached master key (or null) for external consumers like the auto-sync hook.
- **Remote import from cloud storage** — `WorkerImportSource` wraps `HttpTransport` to list and fetch ledger backup files from `backups/` prefix. Abstract interface (`listBackups()`, `fetchBackup()`, `validateConnection()`) for future storage providers. `fetchAndValidate()` combines fetch with full import validation (v1/v2/raw chain formats). OnboardingScreen gains "From Cloud" sub-option. `importFromCloud()` action handles PDK derivation for passphrase-only auth. 57-test suite. (2026-06-20)
- **Genesis compatibility gate** (`GenesisGate.check()`) — verifies remote ledger shares same genesis before syncing. 8 reason codes, in-flight dedup, ~90 tests.
- **Settings UI genesis indicator** — Worker URL save triggers genesis check with visual status (compatible/incompatible/offline/checking). Resets on URL clear; re-checks on API key change.
- **SyncService genesis gate integration** — `checkAndSync()` runs gate before any blob sync (cached, skipped when no local ledger). New `SyncResult.GENESIS_MISMATCH` return value.
- **Settings genesis tests** (`settings_genesis_test.mjs`) — 13 tests covering save/compatible, genesis_mismatch, network_error, URL clear, API key change, skip-on-no-data.
- **Remote ledger sync** — new `ph sync remote_ledger` subcommand pushes/pulls
  ledger blocks to/from the same git repo as staging (append-only, no merge conflicts).
- **`RemoteLedgerSync` class** (`domain/ledger/remote_sync.py`) — push_blocks,
  pull_blocks, push_index, pull_index, get_remote_block_count, _verify_chain.
- **`list_files(prefix)` on transport** — `AbstractStagingTransport` gains the
  method (default `[]`); `GitStagingTransport` implements via `git ls-tree`.
- **ADR-015** — documents the append-log remote ledger design (sequence-numbered
  blocks, same obfuscation, forced auth + confirmation).
- **ETag cache TTL expiry** — JS `HttpTransport` (`cacheTtlMs`) and Python `HttpStagingTransport` (`cache_ttl_s`) support time-bound cache expiration. Entries auto-evicted on access when older than TTL. New `evictStale()`/`evict_stale()` methods for periodic daemon cleanup. 6 new TTL tests (JS).
- **AbortSignal.timeout() wired to timeoutMs** — all 4 transport methods (pull, push, listFiles, delete) now pass `AbortSignal.timeout(timeoutMs)` to `fetch()`. Previously the parameter was accepted but ignored in most methods. 5 new tests.
- **HTTP DELETE method** — `HttpTransport.delete()` fully implemented with 404-as-success, ETag cache clearing for the deleted path, and error throwing on 403/500. 6 new tests.
- **SessionStorageBackend** — sessionStorage-based storage for private browsing. Survives page refreshes within a tab session. Falls back to in-memory Map on quota errors or unavailability.

### Changed
- `SyncService` now imports and runs `GenesisGate` before staging blob operations.
- `SyncResult` frozen object includes `GENESIS_MISMATCH`.
- `DevModeContext` handles `GENESIS_MISMATCH` result from `checkAndSync()`.
- `ph sync --help` now lists both `remote_staging` and `remote_ledger` subcommands.
- **WASM crypto fallback made visible** — DummyCryptoService fallback now emits `console.error` and sets `cryptoStatus='fallback'`. App shows a red sticky warning banner in production mode. Removed `@vite-ignore` (dev HMR compat) and added `build.rollupOptions.external` for production safety.
- **Storage cascade for private browsing** — `createStorage()` cascade: IndexedDB → `SessionStorageBackend` (survives refresh) → in-memory Map. `storageStatus` state drives amber (session) or red (memory) warning banners.
- **Entry hash format aligned** — Python CLI now uses 2-space indent for entry hashes (`json.dumps(data, sort_keys=True, indent=2)`), matching the web app's `computeEntryHash()`. Verification in both `chain.py` and `onboarding_file.py` accepts both formats (legacy no-indent and current indent=2) for backward compatibility. (2026-06-25)

### Fixed
- **Auto-sync hook code review (6 findings resolved):** `useCallback([])` stale closures → ref-based reads; `require('react')` → ES `import`; 100ms `isSyncing` polling → push-based `onSyncingChange` callback; `_syncing` state leak on dispose-during-push → unconditional reset; dead `_disposed` check removed; silent `{}` fallback → lazy init. Also: `_wrap` → `_wrapMutation`, debounce comment added, `getMasterKey` contract enforced. Zero regressions across all 28 test suites. (2026-06-20)
- Genesis gate code review findings: `TextDecoder` promoted to module-level constant; merge error catch no longer masks real errors as `invalid_chain`.
- **MockRemoteBackend `listFiles()` now strips prefix** — returns basenames only, matching Worker and Git transport contracts. Updated test expectations in `mock_remote_test.mjs` and `http_backend_test.mjs`.
- **Connect to Existing Worker onboarding** — Fourth onboarding path: enter Worker URL + API key, fetch remote `ledger:blocks`, validate genesis structure, passphrase verification against pulled genesis (PDK → decrypt recovery_seed → master key → verify seal). `DevModeContext.connectToWorker()` handles full 8-step auth + storage write + remote config persist + service bootstrap. 65 tests, 0 failures.

## [0.6.1] — 389e268 (P3-Remote_Sync — recover session cache fix)

### Fixed
- **`ph recover` now caches the master key** after re-sealing the ledger.
  Previously the session cache held a stale key after recover, causing all
  subsequent commands to fail decryption until the user ran `ph login`.
- **Cross-device staging sync** — `ph view` now routes through `check_and_sync()`
  for proper device check, auth gate, and error handling on pull failures.
- **Trace log redaction** — `_redact()` masks 32-byte keys and sensitive kwargs
  (master_key, passphrase, password, secret, seed) from trace output.
- **`ls-remote` argument order** — `--heads` before `origin` for git 2.53.0+
  compatibility.
- **Undecryptable timestamps** — `_print_entry()` and staged data grouping now
  skip entries with undecryptable startTime_enc/endTime_enc/metadata_enc
  instead of crashing with UnicodeDecodeError.

### Added
- **`login`/`logout` subcommands** — force re-authentication without restart.
  `login` clears session and re-prompts for passphrase; `logout` clears cache.
- **Config-driven tracing** — `debug.trace_enabled` setting (default enabled).

**ADR:** ADR-014 consequences updated (session cache now populated by
`ph recover`).

## [0.6.0] — bc888c2 (P3-Remote_Sync — sync optimization)

### Added
- **Stable entry IDs** — every staging entry now gets a UUID (`entry_id`) on
  creation. Persisted through write/read cycles and used as the primary dedup
  key in the merge engine. Enables cross-device referencing: create on device A,
  end on device B, device A sees the correct entry ended after pull.
- **Single-pull `check_and_sync()`** — reduced from 3 transport pulls per command
  to 1. The single pull handles device check, freshness check, AND merge data.
- **Freshness-based pull skip** — `_last_push_at` timestamp + `_needs_full_pull()`
  method. Same device + remote not newer → skip merge entirely. Handles
  concurrent terminals on the same device.
- **Merge engine entry_id dedup** — dedup by `entry_id` with backward-compatible
  fallback to `(title, start_epoch)` for entries created before the change.
- **24 new tests** in `test_staging_sync_optimization.py` covering: stable IDs,
  cross-device lifecycle, freshness pull, push timeout/retry, auth cache,
  offline recovery.

**Metrics:** 1049 tests, 0 failures. 7 files changed, 1044 insertions, 39 deletions.

**ADR:** ADR-021 adopted — sync optimization with stable IDs + freshness pull.

## [0.5.0] — 47ea8fd (P11-Day-Boundary-Span branch)

### Added
- **P11 — Day-Boundary Spanning Activities (Fix A + Fix B):**
  - **Fix A — Display marker:** `_print_entry` appends `⏭` (U+23ED) to entries
    whose UTC end date differs from their UTC start date. Guarded by
    `stop_epoch > start_epoch` (invalid data not flagged) and `stop_epoch is not
    None` (no end time = no marker).
  - **Fix B — Date filter peek:** `list_habits` with date filters now peeks at the
    previous day's synced block and surfaces entries that span into the target
    date. Dedup: only includes if the entry's original date is outside the filter
    range, preventing double-appearance when the full range is in view.
  - **`parse_time_input` hour wrapping:** Hours ≥ 24 (e.g. `24:00`, `25:00`,
    `48:00`) wrap by `h // 24` days, enabling intuitive entry of next-day times.
  - **`parse_time_input` midnight auto-advance:** `00:00` that would parse before
    the entry's start time (late-night scenario) auto-advances to the next day.
- **32 new tests** in `TestSpanningMarkerSafety` + `TestTimeParsingEdgeCases`
  covering: midnight auto-advance, hour wrapping, no-end-time safety,
  end-before-start guard, filter dedup, multiple spanning entries, full output
  rendering.

**Metrics:** 972 tests, 0 failures. 2 files changed: `cli/cli_parsers.py` (+19),
`cli/interface.py` (+85).

**ADR:** ADR-020 adopted — display-layer fix only. Fix C (split at sync) rejected.

## [0.4.2] — 3ba470f (Phpoc-Architectual_Migration branch merged to main)

### Architectural Migration Complete

All 7 phases of the architectural migration from monolithic `core/ledger.py` to a layered MVC-like structure are complete and merged.

**Key outcomes:**
- **Phase 1:** Split storage interfaces (5 abstract stores + 5 file implementations)
- **Phase 1b:** Abstract `ViewInterface` + `CLIView` + `InteractiveCLIStrategy`
- **Phase 2:** `StagingService` + `LocalStagingCache` + `MergeEngine` + `RemoteStagingSync` + `DeviceIdentityProvider` — `plain:` prefix fully internalized
- **Phase 3:** `LedgerEngine` + `LedgerChain` + `IndexManager` + `SummaryPolicy` — chain logic extracted with format equivalence verified
- **Phase 4:** `SyncOrchestrator` + every-command sync with 500ms timeout / offline tolerance
- **Phase 5:** `SyncOrchestrator` wired into `main.py` replacing old sync path
- **Phase 6:** Deep integration — `CLIInterface` migration, backward compat shims, equivalence tests
- **Phase 7:** XDG config file (`config.json`), `phpoc config {show,get,set,init}` subcommands, `--dir`/`--config` flags, env var overrides

**Metrics:** 941 tests, 0 failures, 0 regressions. 17,000+ lines added (new domain/core/cli layers), 1,300 lines removed (legacy).

### Fixed
- **Recovery command breaks chain integrity** — `recover` modified the genesis block
  (new `recovery_seed_enc`, added `identity_secret_enc_fallback`) and re-sealed it,
  changing its `day_hash`, but never updated subsequent blocks' `prev_hash`.
  This caused `verify()` to fail at block 1 with a chain hash mismatch.
  Fix: after re-sealing the genesis, walk forward through every subsequent block
  updating `prev_hash`, re-sealing, and re-signing.
- **Seal/verify mismatch in recovery** — recovery code sealed genesis with
  `signature` included in check_data, but `verify()` excludes `signature` from
  its seal check. Fix: exclude `signature` from check_data during recovery,
  matching `verify()` exactly.

### Added
- `tests/test_recovery_verify.py`: 5 integration tests covering:
  - Recovery re-chains single-block ledger
  - Recovery re-chains multi-block ledger
  - Recovery WITHOUT re-chaining correctly fails verify
  - Recovery across month boundaries (handles month_summary blocks)
  - New passphrase works for seed decryption after recovery

## [0.4.0] — 36f4cec

### Added
- **Extensible content hash algorithm** — `_compute_content_hash()` now iterates all keys in entry data dict (v0.4.0+), automatically covering any future fields without spec updates. Legacy 9-field algorithm (v0.3.0) retained for backwards compatibility.
- `../spec/PHPSPEC.md` §5.5, §6, §9.3 rewritten: both legacy and extensible algorithms documented with normalization rules, version table, and migration guide
- `scripts/migrate_format_version.py` now supports v0.3.0→v0.4.0 migration path (bump format_version, recompute content hashes, cascade chain seals)
- `verify()` try-both approach — tries extensible algorithm first, falls back to legacy — handles mixed-version ledgers without format_version dependency

## [0.3.0] — Working Tree

### Fixed
- `core/factory.py`: Config directory now created before writing identity/ledger files — fixes `FileNotFoundError` on first `init`
- `cli/interface.py`: Removed duplicate `show_rep()` method that was overriding the first definition
- `cli/interface.py`: Fixed `list_habits()` — synced entries were collected but never printed; added `_print_entry()` helper and unified date iteration
- `main.py`: `verify` command now prints `True`/`False` result (was silently returning)

### Added
- `cli/interface.py`: `list_habits()` now splits into `{all, synced, staged}` subcommands with date filtering
- `cli/interface.py`: `show_rep()` extracted from duplicate code into standalone method
- `tests/test_modular.py`: Added tests for `list all`, `list synced`, `list staged`, and date filtering
- `archive/IMPLEMENTATION_GUIDE.md`: Complete rewrite — organized by DESIGN_GOALS.md design principles with full command reference, auth model, file structure, and troubleshooting

---

## [0.2.0] — 641e10e

### Added
- **Lazy Authentication**: RAM-cached session (`/dev/shm/phpoc_session`) for "once-per-boot" passphrase entry
- `add start/end/oneoff` commands now work without passphrase using `NoAuthCryptoManager` (plain-text staging)
- `view` command works without authentication if cached session exists

### Changed
- `main.py`: Commands `sync, verify, rep, list, view` require auth; `add` commands use NoAuth fallback

---

## [0.1.0] — 1cda5c2

### Added
- **Sovereign Key Model**: 256-bit Recovery Seed generated on `init`; passphrase-derived key (PDK) encrypts the seed
- **Recovery Command**: `phpoc recover` — enter seed + set new passphrase; re-encrypts seed and re-seals Genesis
- **Identity System**: Ed25519-proxy (HMAC-SHA256) identity generated during `init`; private key stored encrypted in `identity.json`
- **Identity Signatures**: Every block (Genesis, Day, Month/Year Summary) signed with identity secret
- **Hierarchical Lock Chain**: Genesis → Year Summary → Month Summary → Day → Task, all sealed with HMAC
- **Encrypted Timestamps**: `startTime_enc` / `endTime_enc` in every task entry (AES-CTR)
- **Blind Duration Index**: `index.json` aggregates durations by date for private reputation queries
- **Session Auth**: RAM cache (`/dev/shm`) for Master Key
- `core/factory.py`: `LedgerFactory.initialize()` creates full ledger with identity
- `tests/test_recovery.py`: 2 tests covering seed generation and recovery flow
- `tests/test_hierarchy.py`: 2 tests covering hash chain and summary blocks

---

## [0.0.2] — 30287e4

### Changed
- Modularization checkpoint: split monolith into `core/`, `security/`, `storage/`, `cli/` packages
- Abstract storage interface (`AbstractLedgerStore`) for future database backends
- Abstract crypto interface (`AbstractCryptoManager`) allowing `NoAuthCryptoManager` fallback

---

## [0.0.1] — db5b3e4

### Added
- Initial proof-of-concept: single-file ledger with basic add/sync/list
- Genesis block creation with hardcoded identity
- PBKDF2 passphrase hashing
- Day sync with basic seal
- Verify command (chain traversal)
