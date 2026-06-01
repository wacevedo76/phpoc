# PH Ledger — Session Handoff

## Current State
- **Branch:** `main` (P3-Remote_Sync merged)
- **Commit:** `11f3b1a`
- **Tests:** 1341 passing, 0 failures
- **Transport:** HTTP → Cloudflare Worker → R2 (staging blob + 86 ledger blocks + index)
- **Phases:** A (instant reads ✓), B (WAL writes ✓), C (daemon ✓), onboarding ✓
- **Auth gate:** Cookie-only fast path, device_uuid decides pull vs push after auth
- **Re-auth prompting:** All staging-interacting commands now auto-prompt (view, list, tags, add, modify, remove, review, revert, sync)
- **Recovery:** `ph recover` preserves user's seed (same master key), force-pushes re-chained blocks to remote
- **Remote blob:** ✅ **Verified readable** — decrypted with master key `00fb89ef...`, 844 bytes JSON, 1 entry. NOT garbled.
- **Timeouts:** ✅ Per-phase timeouts via pytest-timeout plugin (10s phase tests, 30s transport tests)
- **Mobile roadmap:** `MOBILE_ROADMAP.md` — comprehensive plan for iOS/Android app
- **Docs reorganized:** `docs/design/` for architectural docs, `archive/` for retired docs (including `REMOTE_STAGING_ISSUE_TRACKING.md`)
- **CLI complete:** All commands have auto-re-auth prompting; CLI is in maintenance mode

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
| Cookie | ✅ Created (last write from x13) | ✅ Created after `ph login` |
| Master key | `00fb89ef...` (correct) | `00fb89ef...` (correct) |
| Ledger blocks | 86 (in sync with remote) | 86 (same) |
| Remote blob | ✅ Readable, 1 entry | ✅ Readable (same blob) |
| Cross-device | Verified `ph view` works | Verified `ph view` works |

## Key Files

### Source Code
| File | Purpose |
|------|---------|
| `main.py` | CLI entry — argparse, auth tiers, staging + orchestrator wiring with re-auth for all commands |
| `cli/interface.py` | `view_active()`, `list_habits()`, `_sync_before_command()` — one sync gate for all commands |
| `cli/strategies.py` | `InteractiveCLIStrategy` — sync confirmation UI |
| `cli/background.py` | Phase A instant reads, background sync check |
| `cli/wal.py` | WAL lifecycle + background push |
| `cli/daemon.py` | PhDaemon lifecycle |
| `cli/onboarding.py` | `ph onboarding` |
| `core/sync/orchestrator.py` | Sync pipeline — staging → ledger → remote |
| `core/sync/http_transport.py` | HTTP GET/PUT/LIST + ETag caching |
| `core/sync/transport.py` | Transport factory from config |
| `domain/staging/service.py` | `check_and_sync()` — the sync gate, device cookie auth |
| `domain/staging/remote_sync.py` | Blob obfuscation, pull/push, cookie pull/push |
| `domain/staging/local_cache.py` | CRUD, plain: prefix convention |
| `domain/staging/merge_engine.py` | Dedup by entry_id |
| `domain/cookie/device_cookie.py` | Random-specifier cookie |
| `domain/ledger/remote_sync.py` | Ledger block push/pull + chain verification |
| `domain/ledger/engine.py` | `LedgerEngine` — commit, revert, blind index |
| `security/auth.py` | `PassphraseAuthenticator`, `RecoveryAuthenticator` |
| `security/crypto.py` | `CryptoManager`, `NoAuthCryptoManager` |
| `security/config_manager.py` | Config with defaults merging + dot-notation |
| `worker/src/index.ts` | Cloudflare Worker (149 lines TypeScript) — dumb blob store |
| `scripts/check_staging.sh` | List local staging entries with active status |
| `scripts/check_remote_blob.sh` | Deobfuscate and list remote staging blob entries |
| `scripts/check_remote_ledger.sh` | Count remote ledger blocks and range |

### Documentation
| File | Purpose |
|------|---------|
| `SESSION_HANDOFF.md` | This file — current state, auth gate design, known issues |
| `MOBILE_ROADMAP.md` | **NEW** — comprehensive mobile app roadmap (iOS/Android) |
| `PHPSPEC.md` | Format spec — crypto, block structure, key derivation |
| `MAP.md` | File inventory with HOT/COLD annotations |
| `ROADMAP.md` | Project roadmap |
| `CHANGELOG.md` | Release changelog |
| `docs/design/ARCHITECTURAL_DECISIONS.md` | Architectural decisions and rationale |
| `docs/design/DESIGN_GOALS.md` | Design goals and principles |
| `docs/design/DESIGN_MULTI_DEVICE_SESSION.md` | Multi-device session design |
| `docs/design/PH-VIEW-Workflow.md` | ph view workflow diagrams |
| `archive/REMOTE_STAGING_ISSUE_TRACKING.md` | Resolved issue tracking (archived) |
| `archive/ARCHITECTURAL_MIGRATION_STRATEGY.md` | Archived migration strategy |

## Recent Commits
```
87a9f8d  chore: move architectural and design docs into docs/design/
8e5e7df  chore: reorganize root directory — archive retired docs, add mobile roadmap
d04bd79  docs: mark cross-device handoff verified (item #6) and ledger push superseded (item #7)
de06b5e  test: verify cross-device handoff with 3 end-to-end round-trip tests
a4e2b1d  docs: remote blob verified readable; update issue tracking and check script
0ac3621  fix: add per-phase test timeouts via pytest-timeout plugin
5651625  Merge branch 'P3-Remote_Sync' of github.com:wacevedo76/phpoc into P3-Remote_Sync
f10e9e1  fix: auto-prompt for re-auth on all staging-interacting commands
e536cfd  fix: prevent infinite CPU loop in phase4 tests — configure MagicMock prompt_choice return value
94f1c1d  docs: update next step — implement option 1 (mock return_value) for phase4 CPU-lock fix
```

## Resolved Issues

### CPU-Lock Bug: MagicMock View Causes Infinite Loop (2026-05-30)
- **Root cause:** `InteractiveCLIStrategy.decide()` enters `while True` calling `view.prompt_choice()`. A plain `MagicMock()` returns another `MagicMock()` — truthy but matching no exit condition → 100% CPU.
- **Fix:** `view.prompt_choice.return_value = "S"` on MagicMock views in 7 tests (commit `e536cfd`).
- **Result:** All 69 phase4 tests pass in ~0.30s.

### Remote Blob Verification (2026-05-31)
- "Remote blob permanently garbled" was a **false alarm**. Decrypted with master key `00fb89ef...`: valid JSON, 844 bytes, 1 entry.
- Per-phase test timeouts added via `pytest-timeout` (10s/30s tiers) — prevents any future CPU-lock hang.

## This Session (2026-05-28)

### Docs & UX fixes (2026-05-29)

### `ph dev push-status` subcommand
`main.py`: Added `ph dev push-status` diagnostic command showing:
- WAL state (pending or clear)
- Remote blobs found via `list_files()`
- Staging blob path

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

## Next Steps — Mobile App (Chosen Direction)

All CLI reference implementation features are complete. The project is now moving to a
mobile app. The chosen architectural direction (per `docs/design/CROSS_PLATFORM_ARCHITECTURAL_DECISIONS.md`) is:

### Chosen Direction: Rust Crypto Core + React Web First

| Phase | What | Est. Effort |
|-------|------|-------------|
| 0 | Rust crypto library (`phpoc-crypto-core`) — PBKDF2, AES-CTR, HMAC, SHA-256, blob obfuscation, compiled to WASM + .a/.so | 1-2 weeks |
| 1 | React web app — uses Rust → WASM crypto, same Worker backend as CLI | 2-4 weeks |
| 2 | React Native app — uses Rust → .a/.so crypto, shares UI design from Phase 1 | 2-4 weeks |
| 3 | Optional: Flutter — uses same Rust crypto via FFI | 2-4 weeks |

### Why This Direction

- **Crypto written once.** The Rust library is compiled to all targets: WASM (web), .a (iOS), .so (Android). One implementation to audit, test, and maintain.
- **Web app ships first.** React + Rust WASM runs on a laptop with `npm start`. Full workflow (start task, sync, view history) works day one.
- **Worker stays dumb.** The existing 149-line Worker handles everything — no REST API layer, no session tokens, no server-side sync endpoint.
- **CLI compatibility is automatic.** The mobile app uses the same wire protocol, storage paths, and crypto as the CLI. Verified by a shared `crypto_test_vectors.json` suite.

### First Steps

1. Extract `crypto_test_vectors.json` from the CLI's existing test suite
2. Scaffold the `phpoc-crypto-core` Rust crate with `ring` bindings
3. Compile to WASM and verify against test vectors in a browser console
4. Build the React web UI

### CLI Reference — Maintenance Mode
- ✅ All 1341 tests pass
- ✅ Auth gate with re-auth prompting for all commands
- ✅ Cross-device handoff verified (3 end-to-end tests)
- ✅ Per-phase test timeouts prevent hangs
- ✅ Docs reorganized: `docs/design/` for design docs, `archive/` for retired docs
- 🔄 ETag caching in long-running daemon mode (low priority)

## ~~Critical Open Issue: Wrong Session Key on Both Machines~~ **RESOLVED — Misdiagnosis**

**Status:** Resolved 2026-05-29. There is NO wrong-session-key bug.

**Background:** Both machines cached session key
`00fb89ef9116b5e0899bd8b1d3fc4763efc9a2345e85c5f0651e578905a6794d`
after `ph login`. This key was initially diagnosed as a "PDK that cannot
decrypt the Sovereign Seed" because `CryptoManager(key).decrypt(enc_seed)`
failed.

**Root cause of misdiagnosis:** The master key is NOT supposed to decrypt

the seed. The PDK (passphrase-derived key) decrypts the seed, and the
seed's decoded bytes ARE the master key. Testing `CryptoManager(mk).decrypt(enc_seed)`
was the wrong test — it expected the master key to decrypt the seed, but
that's not the protocol.

**Verification (2026-05-29):**
1. `ph login` with the correct passphrase produced PDK `ce08b69f...`
2. The 600K PDK successfully decrypted `recovery_seed_enc`
3. `RecoveryManager.seed_to_key(seed)` returned `00fb89ef...`
4. The master key `00fb89ef...` correctly decrypts ledger entries,
   staging blob, and identity secret

**Lesson:** `authenticate()` was working correctly all along. The session
handoff's debug script tested the wrong thing. The cached key WAS the
correct master key — it was never supposed to decrypt the seed.

**Improvement made:** Added 100K PBKDF2 fallback in `authenticate()` for
ledgers created before commit `e25a26c` (2026-04-28), which bumped
iterations from 100,000 to 600,000. Without this fallback, pre-R3 genesis
blocks would fail to decrypt despite the correct passphrase.

## Known Issues
- ETag caching stale in long-running daemon mode (low priority, not a current issue)
- 100K PBKDF2 fallback for pre-R3 genesis blocks — added in commit `3002952` for backward compatibility
- Pre-R3 ledgers created before commit `e25a26c` (2026-04-28) use 100K iterations instead of 600K
