# PH Ledger — Session Handoff

## Current State
- **Branch:** `main` (P3-Remote_Sync merged)
- **Commit:** `87a9f8d`
- **Tests:** 1341 passing, 0 failures
- **Transport:** HTTP → Cloudflare Worker → R2 (staging blob + 56 ledger blocks + index migrated)
- **Phases:** A (instant reads ✓), B (WAL writes ✓), C (daemon ✓), onboarding ✓
- **Auth gate:** Cookie-only fast path, device_uuid decides pull vs push after auth
- **Recovery:** `ph recover` preserves user's seed (same master key), force-pushes re-chained blocks to remote
- **Remote blob:** ✅ **Verified readable** — decrypted with master key `00fb89ef...`, 844 bytes JSON, 1 entry (device `bc315840...`). NOT garbled.
- **Timeouts:** ✅ Per-phase timeouts via pytest-timeout plugin (10s phase tests, 30s transport tests)

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
| Session key | `00fb89ef...` (PDK, **wrong**) | `00fb89ef...` (PDK, **wrong**) |
| Ledger blocks | 85 (pre-dedup, from remote) | 85 (same) |

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
| `scripts/check_staging.sh` | List local staging entries with active status |
| `scripts/check_remote_blob.sh` | Deobfuscate and list remote staging blob entries |
| `scripts/check_remote_ledger.sh` | Count remote ledger blocks and range |

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

## This Session (2026-05-30) — CPU-Lock Bug: MagicMock View Causes Infinite Loop

### Discovery
Running `test_phase4_staging_interaction_flow.py` on debagent04 (2-core Pi, 3.8GB RAM)
locked the machine 3 times, requiring hard reset each time. Isolated 7 tests that
spin at 100% CPU indefinitely.

### Root Cause

`InteractiveCLIStrategy.decide()` enters a `while True` loop calling
`view.prompt_choice()`. When the view is a plain `MagicMock()` (not configured to
return a specific value), `prompt_choice()` returns another `MagicMock` object —
truthy but not equal to any of `"S"`, `"C"`, `"E"`, `"R"`. The loop never matches
a condition and spins at 100% CPU forever.

### Hanging tests

| Class | Method | Lines |
|-------|--------|-------|
| `TestSyncOrchestratorFullFlow` | All 6 tests calling `sync()` | setUp at line 503 creates `self.view = MagicMock()` |
| `TestSyncOrchestratorEdgeCases` | `test_sync_notifies_view_on_completion` | Line 1073 creates inline `view = MagicMock()` |

### Fix chosen (option 1)

**Fix the tests** — Configure `view.prompt_choice.return_value = "S"` on MagicMock views passed to `SyncOrchestrator`. This makes `InteractiveCLIStrategy.decide()` exit the loop with "sync all", exercising the real strategy flow without hanging.

### Safe test results (60/69 phase4 tests, no hangs)

```
60 passed, 9 deselected in 0.25s
```
The 7 hanging tests + 2 abstract-contract tests (non-instantiable classes) were deselected.

### Fix applied (commit `e536cfd`, 2026-05-31)

`view.prompt_choice.return_value = "S"` added to both `TestSyncOrchestratorFullFlow.setUp()` and `test_sync_notifies_view_on_completion`. All 69 phase4 tests now pass in ~0.30s, no hangs.

## This Session (2026-05-31) — Remote Blob Verification

### Remote blob IS readable

The "Remote blob permanently garbled (wrong key)" issue was a **false alarm**. The blob on R2 was decrypted successfully with master key `00fb89ef...`:
- **Salt:** `1ba4e5d0...`, **Nonce:** `8c580e51...`
- **HMAC tag:** ✅ matches (integrity check passed)
- **Plaintext:** 844 bytes of valid JSON
- **Entries:** 1 active entry ("Working on Phpoc", device `bc315840-6975-4fb5-af5d-e907a8600557`)
- **Updated at:** epoch 1780255104003 (May 2026)

### Per-phase test timeouts

Added `pytest-timeout` plugin with per-file timeout configuration via `pytest_collection_modifyitems` hook in `conftest.py`:
- Phase 1-7: 10s each
- Feature tests (WAL, daemon, tags, etc.): 10s
- HTTP/git transport tests: 30s
- Global fallback: 30s (from `pytest.ini`)

This prevents any CPU-lock hang from locking a test runner indefinitely.

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

## Design Docs Reorganization (2026-06-01)

Architectural and design documents moved to `docs/design/` to reduce root directory clutter:
- `MOBILE_ROADMAP.md` — Mobile implementation plan (kept at root for visibility)
- `PHPSPEC.md` — Format specification (kept at root, referenced by mobile SDK)
- `ARCHITECTURE.md` → `docs/design/ARCHITECTURE.md`
- `SYNC_FLOW.md` → `docs/design/SYNC_FLOW.md`
- `REPUTATION_SPEC.md` → `docs/design/REPUTATION_SPEC.md`
- `KEY_DERIVATION.md` → `docs/design/KEY_DERIVATION.md`
- `WORKER_ARCHITECTURE.md` → `docs/design/WORKER_ARCHITECTURE.md`
- Retired docs (`SYNC_STATUS.md`, `RECOVERY_PLAN.md`, `AUTH_GATE_PLAN.md`) archived in `docs/archived/`

## Next Phase: Mobile PoC

All CLI remote-sync work is complete. The project now shifts to implementing a **mobile proof of concept** (per `MOBILE_ROADMAP.md`). The remote sync infrastructure and format spec are the foundation — mobile will reuse the existing Worker + R2 backend.

### Prerequisites (in priority order)

#### P1 — REST API Worker (extend existing Worker → structured API)

The current Worker (`worker/src/index.ts`, 149 lines) is a dumb blob store. Mobile needs a structured JSON API. Plan:
- Extend the existing Cloudflare Worker with a [Hono](https://hono.dev/) router
- Add endpoints: `/api/v1/auth/login`, `/api/v1/staging`, `/api/v1/cookie`, `/api/v1/sync`, `/api/v1/ledger/blocks`, `/api/v1/reputation`
- Auth: session tokens via Durable Objects or KV (replacing shared API key for mobile)
- Keep zero-knowledge: crypto stays on device, Worker never sees plaintext
- Response body limit (128KB) and CPU timeout (30s) constraints to design around

#### P2 — REST API Spec (OpenAPI 3.0)

- Formal spec covering all 15+ endpoints from MOBILE_ROADMAP.md §1
- Request/response schemas for staging entries, ledger blocks, cookies, auth
- Generated from or co-located with the Worker implementation

#### P3 — HTTP Ledger Transport (Python SDK)

- `HttpLedgerTransport` class (analogous to `HttpStagingTransport`)
- Ledger block push/pull with chain verification
- Shared ETag caching pattern (reuse from staging transport)
- Package as `phpoc-sdk` for reuse by CLI and potential mobile backend

#### P4 — Auth Token Flow

- `POST /api/v1/auth/login` — passphrase → signed challenge → session token (TTL via cookie pattern)
- `POST /api/v1/auth/logout` — revoke session
- API key retained for CLI; session tokens for mobile
- State store decision: Durable Objects vs KV vs Worker-local

#### P5 — Native Crypto SDK (Swift — first platform)

Per MOBILE_ROADMAP.md recommendation, iOS first (fewer targets, CryptoKit built-in):
| Primitive | Purpose |
|-----------|---------|
| PBKDF2-HMAC-SHA256 (600K iter) | Passphrase → PDK |
| AES-CTR encrypt/decrypt | Field-level encryption |
| HMAC-SHA256 | Block seals, auth tags, blob obfuscation |
| SHA-256 | Content/entry hashing |
| Random 32 bytes | Entry IDs, device specifiers |
| Blob obfuscation (4-tier pad + HMAC sub-key) | Remote staging transport |

Reference: `PHPSPEC.md` §4 (Crypto Primitives), §6 (Key Derivation), §7 (Blob Format)

#### P6 — Device Identity (Mobile)

- Persistent UUID4 stored in Keychain / EncryptedSharedPreferences
- HMAC-SHA256 proof derived from master key
- `device_label` for user-friendly identification
- Reference: `security/device_identity.py`

### Architectural Decision: Option C (Hybrid)

Per MOBILE_ROADMAP.md, the recommended architecture is:
```
[Mobile App (crypto)] ←→ [Lightweight API] ←→ [Worker] ←→ [R2]
```
- Mobile does all crypto locally (Swift CryptoKit)
- API layer provides structured endpoints but never sees plaintext
- Worker remains the dumb blob store for R2
- Shared Python SDK (`phpoc-sdk`) for CLI + backend reuse

### Architectural Options Considered

| Option | Crypto Location | API Complexity | Zero-Knowledge | Effort |
|--------|:---------------:|:--------------:|:--------------:|:-----:|
| **A — Thin client + Thick API** | Server | High | ❌ Lost | Medium |
| **B — Thick client + Dumb Worker** | Device | None | ✅ Preserved | High (full native crypto) |
| **C — Hybrid** ✅ | Device | Medium | ✅ Preserved | Medium-High |

### Platform Decision

**iOS (Swift) first** — initial PoC target:
- Fewer device targets for testing
- `CryptoKit` has PBKDF2, AES-CTR, HMAC, SHA-256 built-in (no FFI)
- Keychain for secure storage (device identity, session cache)
- Android (Kotlin) follow once iOS PoC validates the approach

### Mobile PoC Definition of Done

1. ✅ REST API Worker deployed and serving structured endpoints
2. ✅ OpenAPI 3.0 spec published in `docs/design/`
3. ✅ HTTP ledger transport in `phpoc-sdk` package
4. ✅ Auth token flow working (login → session → authenticated requests)
5. ✅ Swift crypto SDK ported: PBKDF2, AES-CTR, HMAC, SHA-256, blob obfuscation
6. ✅ Device identity provisioned (UUID4 + HMAC proof)
7. ✅ One end-to-end mobile test: login → pull staging → decrypt → display entries
8. ✅ Cross-device: CLI writes entry → mobile reads it via remote sync

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
- ETag caching stale in long-running daemon mode (not a current issue)
- `_reconcile_and_claim` blob overwrite protection (`BLOB_KEY_MISMATCH` sentinel) — resolved in commit `1dacf40`
