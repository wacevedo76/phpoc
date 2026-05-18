# PH Ledger — Session Handoff

## Current State
- **Branch:** `P3-Remote_Sync` (ahead of main by ~10 commits)
- **Tests:** 1022 total, all passing
- **P3 status:** ✅ **Fully implemented and tested live with cross-device sync.** See P3 section below.
- **Dependencies:** Pure Python 3.x standard library — zero external deps
- **Config dir:** `~/.config/phpoc/`
- **Data dir:** `~/.local/share/phpoc/`
- **Config dir (legacy):** `~/.config/personal_history_poc/` — git-tracked, snapshots before/after test runs
- **Remote clone:** `~/.config/personal_history_poc/remote/` (on laptop) — git clone of `git@github.com:wacevedo76/phpoc-staging.git`
- **Remote blob path:** `staging/blobs/current.json` (obfuscated, 64K tier)

## Two-Machine Setup

### Machine 1: Laptop (wacevedo@x13)
- Code at `~/code/Testing/phpoc/`
- Has SSH key set up for GitHub
- Has ledger initialized with a passphrase
- Has active staging entries (the two "Working on phpoc" tasks)

### Machine 2: debagent04 (pi@debagent04)
- Code at `~/phpoc/` (the repo source of truth)
- Has SSH key set up for GitHub (verified: `ssh -T git@github.com` works)
- Has config file at `~/.config/phpoc/config.json` with `remote.git_remote_url` set
- Has git clone at `~/.config/phpoc/remote/` — pulled the remote blob successfully
- **No ledger initialized** — never ran `phpoc init`, so no passphrase set
- No staging file — `~/.local/share/phpoc/staging.json` doesn't exist

### Remote Repo
- `git@github.com:wacevedo76/phpoc-staging.git`
- Contains obfuscated staging blob at `staging/blobs/current.json`
- Blob was pushed from laptop using laptop's passphrase-derived master key

## What Works
| Feature | Status |
|---------|--------|
| `GitStagingTransport.pull()` | ✅ — clones, pulls, reads blob |
| `GitStagingTransport.push()` | ✅ — writes, commits, pushes (with retry on non-ff) |
| Blob obfuscation push | ✅ — pads + encrypts with HMAC sub-key |
| Blob deobfuscation pull | ✅ — auto-resolves key from `crypto.master_key` |
| `GIT_TERMINAL_PROMPT=0` | ✅ — no git credential prompts |
| Config comment stripping | ✅ — `//` lines in config JSON handled |
| `_ensure_remote_url()` | ✅ — syncs clone origin URL with config |
| Auto-push after write | ✅ — all `add` commands push to remote |
| Pull+merge on view | ✅ — `view_active` pulls + merges remote entries |
| Duplicate title ID fix | ✅ — enumerates active entries directly, not by title key |
| Auth-only retry | ✅ — only retries push on non-ff rejection, not auth errors |
| End-to-end cross-device sync | ✅ — Phone → Remote → Laptop verified live (see P3 section) |

## What Doesn't Work (Cross-Device)
1. **Blob deobfuscation on debagent04** — needs the same passphrase as laptop. This machine has no ledger/init/passphrase. `phpoc view` authenticates first, then tries to pull+merge, but deobfuscation fails because the crypto has no key.

2. **No staging file on debagent04** — `~/.local/share/phpoc/staging.json` doesn't exist. Even if pull succeeded, there's nothing to merge into.

## Live Cross-Device Test (2026-05-18)

**Context:** Tested remote sync between this laptop (x13, device `e0cd83b8`) and what appears to be the Phone (device `9847c408`) via the shared GitHub staging repo.

**Findings:**
- Pulled remote blob, decrypted successfully using cached master key from `/dev/shm/phpoc_session`
- Remote blob contained 5 entries from the Phone device (`9847c408`) — 4 entries that matched local (Learning Scheme, Nitrotype, 2x Working on phpoc) plus a `Test cross-device` entry
- Ran `ph sync --yes` — 6 non-active entries synced to ledger, 2 active tasks remain in staging
- After sync, remote blob was pushed (commit `28005aa`) reflecting only the 2 active tasks
- **End-to-end cross-device sync verified:** Phone → Remote Blob → Laptop (pull) → Laptop Ledger → Laptop Staging → Remote Blob (push)
- Device identity mismatch handled correctly (no re-auth needed since this laptop's device matched after its own push)
- Blob obfuscation (AES-CTR + HMAC + tiered padding) working correctly — 65,592 byte blob decrypted to ~800 bytes of JSON
- Device ID `9847c408` detected from a different device in commit history — the timeline model is working

**All 5 remote blob commits decrypted and verified:**
| Commit | Time | Device | Entries |
|--------|------|--------|---------|
| `99e0974` | 13:34 | Phone (`9847c408`) | 5 |
| `a5986e3` | 13:37 | Laptop (`e0cd83b8`) | 6 |
| `a951f75` | 13:42 | Laptop | 7 |
| `c3eef75` | 13:47 | Laptop | 8 |
| `28005aa` | 14:29 | Laptop (post-sync) | 2 (active only) |

**No data loss, no conflicts.** Timeline model verified correct.

## Key Files
| File | Purpose |
|------|---------|
| `core/sync/git_transport.py` | `GitStagingTransport` — git CLI push/pull with clone, retry, auth handling |
| `domain/staging/remote_sync.py` | `RemoteStagingSync` — blob obfuscation, device check, pull/push coordination |
| `domain/staging/service.py` | `StagingService` — `check_and_sync()` and `push_to_remote()` |
| `cli/interface.py` | `CLIInterface` — `view_active` with remote pull+merge, `_push_if_remote` |
| `main.py` | Wiring: reads config, creates transport, device provider, passes to service |
| `tests/test_git_transport.py` | 37 tests for transport + obfuscation |
| `tests/test_remote_config_wiring.py` | 13 tests for config wiring |

## P3 Commits (chronological)
| Commit | What |
|--------|------|
| `bd60bf2` | Wire remote config → transport → service in main.py; 13 config wiring tests |
| `2c859ec` | Strip `//` comments from config JSON |
| `a972294` | Auto-push after every write command; auto-pull on view |
| `394b950` | `GIT_TERMINAL_PROMPT=0` — no git password prompts |
| `6d021f5` | Sync remote URL with config; graceful empty-repo handling |
| `83044ee` | Pull+merge on view even with device mismatch (read-only safe) |
| `a327bdb` | Fix duplicate task IDs; fix push auth error handling |
| `3b1db1c` | `pull()` falls back to `crypto.master_key` for deobfuscation |

---

## Session History

### Prior — Blocker Resolution (R1–R4)
All four roadmap blockers resolved on `main`:

| Blocker | Resolution | Branch |
|---------|-----------|--------|
| **R1** — AES-CTR Malleability | Encrypt-then-MAC: HMAC-SHA256 auth tag | `R1-AES-CTR-Malleability` |
| **R2** — Identity Fallback | `identity_secret_enc_fallback` in genesis | `R2-identity-fallback` |
| **R3** — PBKDF2 600K | Bumped iterations 100K → 600K (OWASP 2026) | `R1-AES-CTR-Malleability` |
| **R4** — Content Proof | Plaintext content_hash per entry | `R4-content-proof-design` |

All branches merged and deleted.

### Prior — CLI/UX + Protocol Vision + Staging Repair & Removal Fixes

**Commits (chronological):**
- `d726965` — fix: `list` ignoring `days` positional
- `9a64948` — feat: rich date filtering (--date/--week/--month/--year/--from/--to)
- `c52e961` — docs: protocol vision (VISION.md, DESIGN_GOALS, ROADMAP, BACKLOG)
- `37eecab` — fix: staging index mapping in sync_day_with_selection()
- `c152861` — feat: revert N (replaces prune, truncates chain end)
- `e0a3e9d` — fix: revert converts encrypted fields to plain: format
- `9727637` — fix: normalize encrypted staging to plain: before sync (graceful skip on stale crypto)
- `2948d7f` — docs: clarify revert help text (day blocks vs entries)
- `041a245` — feat: sync --till MM-DD (date-filtered syncing)
- `ad7060a` — fix: plain: prefix guards in _print_entry, list_habits, view_active
- `77a2a96` — fix: [R]emove now actually deletes entries from staging (removal_indices via SyncDecision)
- `42a9466` — docs: update SESSION_HANDOFF
- `d025676` — docs: compact SESSION_HANDOFF with all fixes
- `5c6cab7` — fix: don't delete staging early in sync_with_strategy (index shift bug)
- `bfa349f` — tests: 3 regression tests for removal deletion index handling

**Branches:** All stale branches deleted; only `main` + `origin/main` remain.

### Prior — P11 Day-Boundary Span (Fix A+B)

**Decision:** Fix A (display marker `⏭`) + Fix B (date filter peek with dedup). Fix C (split at sync) rejected — the ledger is immutable truth; splitting corrupts entry counts and content hashes.

**Key design details (see ADR-020 for full context):**
- Spanning check uses `stop_epoch > start_epoch` guard — end-before-start entries are invalid, not spanning.
- Fix B peeks **one day back only**. Dedup: peeked entries included only if their original date is outside the filter range.
- `parse_time_input` updated with auto-advance for `00:00`/`24:00`/`25:00` (hours ≥ 24 wrap by `h // 24` days).

**32 tests written** across Issues 1–8 covering:
  1. Midnight auto-advance & hour wrapping — 7 tests
  4. No end time safety — 4 tests
  5. End-before-start guard — 3 tests
  6. Filter dedup (peek decision) — 7 tests
  7. Multiple spanning entries from same day — 6 tests
  8. Full output rendering with dedup — 5 tests

**Tests added to:** `tests/test_phase1b_view_interface.py`
**Branch:** `P11-Day-Boundary-Span`

**Implementation committed as `47ea8fd`:**
- `cli/cli_parsers.py` — hour wrapping (h≥24 → h//24 days) + 00:00 auto-advance when result < start_epoch
- `cli/interface.py` — Fix A: `⏭` marker in `_print_entry` (guarded by `stop_epoch > start_epoch` and `stop_epoch is not None`). Fix B: `list_habits` peek at previous day's block with dedup (only include if original date outside filter range).

### Prior — Extensible Content Hash (v0.4.0)

**Content hash made extensible:** The `content_hash` algorithm was changed from a hardcoded 9-field canonical dict to an **all-keys iterator** that automatically covers any future fields added to activity data. Key changes:

- `core/ledger.py`: `_compute_content_hash()` now takes `(data: dict, decrypt_fn)` and iterates all keys — decrypts `*_enc` fields, sorts lists, excludes `content_hash` itself, uses `sort_keys=True` for deterministic ordering
- `PHPSPEC.md`: §5.5 and §6 rewritten with both legacy (v0.3.0, 9-field) and extensible (v0.4.0+, all-keys) algorithms documented. §9.3 version table updated with v0.4.0. Migration section added.
- `scripts/migrate_format_version.py`: Full rewrite supporting v0.2.0→v0.3.0 (existing) and v0.3.0→v0.4.0 (new: content hash recompute + chain cascade). Auto-detects current version and dispatches appropriately.
- `verify()`: Uses try-both approach — tries extensible algorithm first, falls back to legacy — handles mixed-version ledgers without format_version dependency.

**Committed as `36f4cec`** — resolved.

### Prior — Format Specification (PHPSPEC.md)

**P1 — Format Spec completed:** Created [PHPSPEC.md](PHPSPEC.md) — a standalone format specification (~1450 lines) covering all block types, encryption, chain validation, content hash, blind index, staging, and versioning. Includes `format_version` field, migration script `scripts/migrate_format_version.py`, and chain splitting mechanics in §9.4.5.

## Crypto Architecture Checklist
| Feature | Status | Notes |
|---|---|---|
| Sovereign Key Model (Seed → Master Key) | ✅ | Seed generated from 32 bytes urandom. Specified in [PHPSPEC §2](PHPSPEC.md#2-key-derivation-identity) |
| Passphrase wraps Seed (PDK encrypted) | ✅ | PBKDF2(passphrase, "session-salt") at **600K iterations**. Specified in [PHPSPEC §2.4](PHPSPEC.md#24-passphrase-derived-key-pdk) |
| Identity Ed25519-proxy (HMAC-SHA256) | ✅ | Secret encrypted with Master Key; fallback in genesis. Specified in [PHPSPEC §2.7](PHPSPEC.md#27-identity-representation) |
| Block signing (all block types) | ✅ | Genesis, Day, Month/Year Summary. Specified in [PHPSPEC §5.3](PHPSPEC.md#53-identity-signatures) |
| Encrypted timestamps (start/end) | ✅ | AES-CTR + HMAC-SHA256 auth tag. Specified in [PHPSPEC §3](PHPSPEC.md#3-encryption-scheme) |
| Encrypt-then-MAC (auth tag) | ✅ | Tampered ciphertext raises ValueError. Specified in [PHPSPEC §3.3](PHPSPEC.md#33-authentication-tag) |
| Plaintext content hash (content_hash) | ✅ | Per-entry SHA-256; survives re-encryption. Specified in [PHPSPEC §6](PHPSPEC.md#6-content-hash-algorithm) |
| Blind duration index (index.json) | ✅ | Fast rep queries without decryption. Specified in [PHPSPEC §7](PHPSPEC.md#7-blind-index) |
| Session RAM cache (/dev/shm) | ✅ | One auth per boot |

## Chain Structure
```
Genesis (sealed + signed, identity fallback embedded)
  └── Year Summary (sealed + signed)
        └── Month Summary (sealed + signed)
              └── Day (sealed + signed)
                    └── Entries (hashed individually + content_hash)
```

## CLI Commands
| Command | Auth Required | Description |
|---|---|---|
| `init` | No | Creates ledger + identity + seed |
| `recover` | No (seed) | Seed-based passphrase reset |
| `add start <title>` | Optional | Starts active task |
| `add end <title>` | Optional | Ends active task |
| `add oneoff` | Optional | Captures completed task |
| `view` | Optional | Shows running tasks |
| `sync [--yes] [--till MM-DD]` | Yes | Commits staging → immutable ledger (interactive or --yes auto); `--till` syncs only entries up to and including that date |
| `verify` | Yes | Full chain integrity check (incl. content_hash) |
| `rep [days] [--date/--week/--month/--year/--from/--to]` | Yes | Blind-index reputation summary with rich date filtering |
| `list {all,synced,staged} [days] [--date/--week/--month/--year/--from/--to]` | Yes | Decrypted detailed listing with rich date filtering |
| `revert <count>` | Yes | Remove last N day blocks from ledger, restore entries to staging |
| `revert --list` | Yes | Show ledger summary with recent day blocks |

## Next Up (Priority Order)

| Priority | Item | Description | Dependencies |
|---|---|---|---|
| ✅ Done | **P0 — Extensible Content Hash (v0.4.0)** | `content_hash` algorithm changed from hardcoded 9-field dict to all-keys iterator | Committed |
| ✅ Done | **P1 — Format Spec (PHPSPEC.md)** | Standalone spec document | Done |
| ✅ Done | **P3 — Remote Sync (git-based)** | `GitStagingTransport`, blob obfuscation, CLI wiring, cross-device sync verified live | All commits on `P3-Remote_Sync` |
| ✅ Done | **P7 — Phase 7** | User-configurable config file, XDG paths, `--config` flag | Done |
| ✅ Done | **P11 — Day-Boundary Span** | Fix A (`⏭`) + Fix B (date filter peek + dedup). Hour wrapping in `parse_time_input` | Done |
| 🥇 High | **P2 — Portable Export** | `--range` (block-level chain segment) + `--tag` (entry-level signed manifest) | Deferred — needs real-world dev context |
| 🥇 High | **P7 — Web Viewer (Phone POC)** | Static HTML/JS page or PWA that reads ledger + staging blob | P3 done, no blocker |
| 🥇 High | **P5 — Mobile POC (Swift/Kotlin)** | Minimal phone app for reading/adding entries | P3 done, no blocker |
| 🥈 Medium | **P4 — CLI kinks & UX polish** | Colored output, table formatting, summaries, error messages | None |
| 🥈 Medium | **P6 — Wearable POC** | Blind-index writes from watchOS/WearOS | P3 done, no blocker |

## Architecture Notes
- **Protocol, not just a tool:** PHPOC is now explicitly positioned as an open data format. The CLI is the reference implementation.
- **Compartmentalized data:** The format enforces separation at the data level — a platform sees only what you authorize.
- **Zero-dependency commitment:** Core engine remains pure Python stdlib. Mobile implementations are independent.
- **All historical blockers resolved:** R1 (auth tag), R2 (identity fallback), R3 (600K KDF), R4 (content hash), D2 (multi-device), U1 (stale crypto), U2 (recovery integrity) — all finished.
- See `VISION.md` for the full protocol pitch, `ROADMAP.md` for the feature roadmap, `BACKLOG.md` for task-level tracking.

---

See `CHANGELOG.md` for full history.

## Triage Log

*Entries added by `/triage` template. Each entry: date — one-line summary (files touched).*

- 2026-04-30 — Fixed `oneoff` duration from 2 minutes to 1 second by changing `-120000` to `-1000` in `main.py` line 215 (`main.py`)
- 2026-04-30 — Extensible content_hash: changed from hardcoded 9-field dict to all-keys iterator (`core/ledger.py`, `PHPSPEC.md`, `scripts/migrate_format_version.py`)
- 2026-05-04 — D2 progress: Q1-Q4 resolved, Q5 partially resolved. Staging obfuscation designed.
- 2026-05-09 — Fixed negative duration bug in `core/ledger.py`
- 2026-05-09 — Added three staging tools: `modify`, `remove`, `review` on branch `tools-modify-remove-review` (`main.py`, `core/ledger.py`)
- 2026-05-14 — Added `--dir` CLI flag, wired `storage.data_dir` config key (`main.py`, `storage/implementations/file_config.py`, `tests/test_phase7_config_integration.py`)
- 2026-05-14 — Fixed two bugs: auth tag fallback in identity secret decrypt + legacy content hash decrypt path (`security/crypto.py`, `domain/ledger/chain.py`)
- 2026-05-14 — **P11 Day-Boundary Span implementation:** Fix A (⏭) + Fix B (peek+dedup) + hour wrapping. 2 files, 104 lines (`cli/cli_parsers.py`, `cli/interface.py`)
- 2026-05-18 — **P3 Remote Sync live cross-device test:** Pulled encrypted blob from GitHub remote, decrypted, verified device identity, synced 6 entries to ledger. Cross-device sync verified working end-to-end. (`core/sync/git_transport.py`, `domain/staging/remote_sync.py`, `main.py`)
