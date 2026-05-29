# PH Ledger — Session Handoff

## Current State
- **Branch:** `P3-Remote_Sync`
- **Commit:** `da4ac16`
- **Tests:** 1269 passing, 0 failures (1 pre-existing hang in phase4)
- **Transport:** HTTP → Cloudflare Worker → R2 (staging blob + 56 ledger blocks + index migrated)
- **Phases:** A (instant reads ✓), B (WAL writes ✓), C (daemon ✓), onboarding ✓
- **Auth gate:** Cookie-only fast path, device_uuid decides pull vs push after auth
- **Recovery:** `ph recover` preserves user's seed (same master key), force-pushes re-chained blocks to remote

## Auth Gate Design — `check_and_sync()` (2026-05-28)

The **device cookie** is the source of truth. Two concepts only: local TTL and specifier comparison. No `CryptoManager`/`_is_auth_fresh()` consulted for auth decisions.

```
┌──────────────────────────────────────────────────────────────┐
│ 1. Remote configured?                                         │
│    No  ──→ READY 🟢                                           │
│    Yes ──→ continue                                            │
└──────────────────────────────┬───────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────┐
│ 2. LOCAL COOKIE CHECK                                         │
│    Read local cookie from disk                                 │
│    ├─ No local cookie ──→ go to AUTH GATE                     │
│    ├─ Expired (TTL)    ──→ go to AUTH GATE                    │
│    └─ Valid ──→ continue to remote cookie check               │
└──────────────────────────────┬───────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────┐
│ 3. REMOTE COOKIE CHECK (fast path, ~50ms)                     │
│    Pull remote cookie from R2                                  │
│    ├─ Unreachable ──→ OFFLINE 🔶 (proceed with local)         │
│    └─ Got remote cookie ──→ compare device_specifier          │
│       ├── Match ──→ READY 🟢 (same device session)            │
│       └── Mismatch ──→ go to AUTH GATE                        │
└──────────────────────────────┬───────────────────────────────┘
                               ▼
┌──────────────────────────────────────────────────────────────┐
│ 4. AUTH GATE                                                  │
│    Valid CryptoManager (master_key present)?                    │
│    ├─ No ──→ REAUTH_NEEDED 🔴 (caller prompts)                 │
│    └─ Yes ──→ pull remote cookie (to get device_uuid)         │
│       ├─ Unreachable ──→ OFFLINE 🔶                            │
│       └─ Got remote cookie ──→ compare device_uuid            │
│                                                               │
│       SAME device_uuid:                                        │
│         → Push local blob to remote (local authoritative)      │
│                                                               │
│       DIFFERENT device_uuid:                                   │
│         → Pull remote blob → reconcile (merge into local)      │
│         → Push merged blob to remote                           │
│                                                               │
│       Create new device_specifier, new TTL                     │
│       → Write local cookie                                     │
│       → PUT new remote cookie (overwrites, no destroy)         │
│       → READY 🟢                                               │
└──────────────────────────────────────────────────────────────┘
```

### Cookie format

| Location | Fields | Size |
|----------|--------|------|
| Remote (R2) | `{"device_uuid": "<UUID>", "device_specifier": "<random 32-char hex>"}` | ~200 bytes |
| Local (disk) | `{"device_specifier": "<same>", "creation_time": "<epoch_ms>"}` | ~150 bytes |

Two push paths:
| Method | Used by | Pushes cookie? |
|--------|---------|----------------|
| `push_to_remote()` | Write ops (add/end) | ✅ Yes — new specifier |
| `push_blob_only()` | `ph sync remote_staging` | ❌ No — blob only |

`ph login` now clears both session cache AND local device cookie → next `check_and_sync()` has no local cookie, falls through to auth gate, proceeds with valid CryptoManager.

### Auth Gate invariants

- Blob is **never** pulled before auth — cookie check is always the first remote call
- No `_is_auth_fresh()` or CryptoManager consulted for auth decisions — cookie is the truth
- After auth: same device_uuid = push local (no pull); different = pull+merge+push
- Remote cookie overwritten by PUT (no destroy-then-create race)
- Offline remote → OFFLINE, user proceeds with local data
- No remote configured → READY immediately

## Two Machines

| | x13 (laptop) | debagent04 (pi) |
|---|---|---|
| Device ID | `dc1da321-2c80-4815-a808-11295b8c59f9` | `bbb3badc-6365-49ea-b43c-53869ca0195f` |
| Passphrase | ✅ Updated | ✅ Updated |
| Transport | HTTP → Cloudflare Worker | HTTP (same URL) |
| API key | ✅ Set | ✅ Set |
| Cookie | Created (last write from x13) | Present (mismatch with remote) |

## Key Files

| File | Purpose |
|------|---------|
| `core/sync/http_transport.py` | HTTP GET/PUT/LIST + ETag caching |
| `core/sync/transport.py` | Transport factory from config |
| `domain/staging/service.py` | `check_and_sync()` — the sync gate |
| `domain/staging/remote_sync.py` | Blob obfuscation, pull/push, cookie pull/push |
| `domain/cookie/device_cookie.py` | Random-specifier cookie |
| `domain/staging/local_cache.py` | CRUD, plain: prefix convention |
| `domain/staging/merge_engine.py` | Dedup by entry_id |
| `cli/interface.py` | `view_active()`, `_sync_before_command()` |
| `cli/background.py` | Phase A instant reads |
| `cli/wal.py` | WAL lifecycle + background push |
| `cli/daemon.py` | PhDaemon lifecycle |
| `cli/onboarding.py` | `ph onboarding` |
| `worker/src/index.ts` | Cloudflare Worker (149 lines TypeScript) |
| `security/config_manager.py` | Config with defaults merging + dot-notation |
| `domain/ledger/remote_sync.py` | Ledger block push/pull + chain verification |
| `core/sync/orchestrator.py` | Sync pipeline — staging → ledger → remote |

## Recent Commits
```
bc7078e  docs: update session handoff with stale-remote fix and sync confirmation
45ae00d  fix: stale-remote overwrite only needed block instead of force-pushing all
06fd058  fix: bare import json inside main() shadows top-level import
e76bbeb  fix: remove 102 duplicate ledger entries + 29 stale staging entries
3b67fbc  fix: push staging blob before device cookie to prevent stale-remote bug
23f510f  fix: ph login uses SyncCheckResult enum instead of StagingService attrs
01d4f24  fix: resolve tracked issues P0-P4
3b0e92f  fix: resolve 54 pre-existing test failures from API drift
17cb5fd  Remove 10% TTL window from cookie touch — unconditional touch
d967675  Add POSSIBLE_PROOF_OF_EXISTANCE.md
f5aeda3  [this session] fix: CLIView wiring — ph sync shows interactive modify/remove/confirm workflow
```

## This Session (2026-05-28)

### Docs & UX fixes (2026-05-29)

### Ctrl+C protection on passphrase/seed prompts
`security/auth.py`: Wrapped `getpass.getpass()` and `input()` calls in both
`PassphraseAuthenticator` and `RecoveryAuthenticator` with try/except for
`(KeyboardInterrupt, EOFError)` — prints a newline and returns `False`
cleanly instead of mangling terminal echo on Ctrl+C/Ctrl+D.

### Clean exit on KeyboardInterrupt at top level
`main.py`: Wrapped `main()` call in `if __name__ == "__main__"` with
try/except for `KeyboardInterrupt` and `EOFError` — prints newline and
exits with code 130 instead of dumping a traceback.

### Empty-ledger robustness
`domain/ledger/chain.py`: Added `None` guards in fallback adapters
(`_make_read_blocks_fallback`, `_make_get_block_count_fallback`,
`_make_get_last_block_fallback`) so `LedgerChain` doesn't crash when
`read_ledger()` returns `None` (no ledger.json yet).

`domain/ledger/engine.py`: `_commit_day()` now handles the first-ever
sync when `prev_block is None` — builds a day block with `"0"*64` as
prev_hash and appends it, instead of silently returning.

`storage/file_store.py`: `read_ledger()` kept returning `None` (not `[]`)
so callers can distinguish "empty ledger" from "ledger not yet created."

### NoAuth read commands
`main.py`: Split auth requirements into three tiers:
- `require_auth` (must prompt): `sync`, `verify`, `rep`, `modify`, `review`, `add`
- `read_commands` (cached session or NoAuth): `list`, `view`, `tags`
- Everything else (cached session or NoAuth): `add start/end/pause/unpause`

`cli/interface.py::view_active()`: Wrapped `self._crypto.decrypt(start_val)`
in try/except — skips entries with undecryptable timestamps instead of
crashing, enabling `ph view` / `ph list active` without a passphrase.

### P0 — `_deep_merge` shallow-copy bug
`security/config_manager.py:_deep_merge()` assigned `result[key] = default_val` for non-overridden dict values — shared reference with `ConfigManager.DEFAULTS`. Callers could mutate the class-level defaults globally. Fixed: deep-copy dict values via recursive `_deep_merge(default_val, {})`.

### P2 — `ph recover` leaves old chain on remote
`RemoteLedgerSync.push_blocks()` added `force=True` parameter. When set, existing remote blocks are overwritten instead of skipped by index. `ph recover` in `main.py` now force-pushes all re-chained blocks after recovery.

### P3 — Seed invalidation concern resolved
`RecoveryAuthenticator` already prompts for the user's existing recovery seed. The master key is preserved identically — remote blobs remain decryptable.

### P4 — Latency: redundant `list_files()` calls
`pull_blocks()` and `push_blocks()` each independently called `_list_remote_block_indices()` (2 HTTP `list_files()` calls). Added optional `existing_indices` parameter to both. `SyncOrchestrator._sync_ledger_blocks()` now calls `list_files()` once and shares the result — saves ~100ms per sync.

### `ph login` runtime error
`main.py:428` used `login_staging.READY` / `login_staging.OFFLINE` — `StagingService` doesn't expose those enum-style attrs. Fixed to `SyncCheckResult.READY` / `SyncCheckResult.OFFLINE` (already imported). Commit: `23f510f`.

### Stale-remote bug (blob-before-cookie push order)
`domain/staging/service.py::push_to_remote()` pushed cookie before blob. If cookie push failed, local cookie lost + remote blob stale → reconcile pulled old blob → re-committed duplicates on next sync. Fix: push blob first, then cookie. Cookie failure is soft — cookie mismatch on next check triggers reconcile (self-healing). Commit: `3b67fbc`.

### Mock transport test failures from reorder
Mock `push()` in tests used `transport._blob` for both blob and cookie. Cookie push overwrote blob data. Fixed: route by path — cookie paths → `transport._cookie`, blob paths → `transport._blob`. All 1338 tests pass.

### CLIView wiring — `ph sync` interactive workflow missing
`SyncOrchestrator` was constructed with `view_interface=cli._view if hasattr(cli, '_view') else None` at both construction sites in `main.py`. `CLIInterface` has no `_view` attribute, so `view_interface` was always `None` → `InteractiveCLIStrategy.decide()` was never called → the edit/remove/confirm workflow was silently skipped on every `ph sync`, even without `--yes`.

**Fix:** Replaced with `view_interface=CLIView(ledger)` at both sites. Now `ph sync` (without `--yes`) shows the full interactive workflow:

```
--- Pending Sync ---
  #0: Coding Practice | 2026-05-28 | 09:00-11:00 | 120m
  #1: Walking | 2026-05-28 | 14:00-14:48 | 48m

[S]ync now, [E]dit, [R]emove, [C]ancel, [?] help?
```

`ph sync --yes` still skips straight to commit.

### Ledger deduplication (full repair)
Removed **102 duplicate entries** from 15 entirely-duplicate blocks embedded in the chain. Used crypto-authenticated script (`scripts/repair_ledger_dedup.py`) to:
1. Dedup by (title, duration) per date (encrypted timestamps differ across commits)
2. Remove entire blocks where all entries were duplicates (15 blocks)
3. Trim duplicate entries from mixed blocks (entries with unique content are preserved)
4. Re-seal all blocks with correct `prev_hash` linkage
5. Rebuild blind index from scratch
6. Clean 29 stale staging entries matching already-committed ledger content

**Result**: 63 blocks (down from 83), zero duplicate entries, valid chain linkage. Backups: `ledger.json.bak`, `.bak2`, `.bak3`, `staging.json.bak`.

## Next Steps
1. Verify on debagent04: pull, run `ph view` to test cross-device handoff flow

## Known Issues
- ETag caching stale in long-running daemon mode (not a current issue)
- `test_sync_calls_check_and_sync_first` in `test_phase4_staging_interaction_flow.py` hangs (pre-existing, likely integration/networking)
