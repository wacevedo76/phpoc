# PH Ledger — Session Handoff

## Current State
- **Branch:** `main` — CLI/UX improvements, revert, staging normalization
- **Tests:** 360/360 passing (test_modular: 12, test_hierarchy: 2, test_recovery: 2, test_date_filters: 38, test_sync_confirmation: 63, + sync/tags/pause/revert tests)
- **Dependencies:** Pure Python 3.x standard library — zero external deps
- **Working tree:** clean, all changes committed
- **Stale branches:** All deleted — only `main` + `origin/main` remain

---

## Session History

### Prior Session — Blocker Resolution (R1–R4)
All four roadmap blockers resolved on `main`:

| Blocker | Resolution | Branch |
|---------|-----------|--------|
| **R1** — AES-CTR Malleability | Encrypt-then-MAC: HMAC-SHA256 auth tag | `R1-AES-CTR-Malleability` |
| **R2** — Identity Fallback | `identity_secret_enc_fallback` in genesis | `R2-identity-fallback` |
| **R3** — PBKDF2 600K | Bumped iterations 100K → 600K (OWASP 2026) | `R1-AES-CTR-Malleability` |
| **R4** — Content Proof | Plaintext content_hash per entry | `R4-content-proof-design` |

All branches merged and deleted.

### This Session — CLI/UX + Protocol Vision

**Bug Fix: `list` ignoring `days` positional**
- `list_habits()` accepted `days_limit` but never applied it as a filter
- Fixed: now converts `days_limit` → `from_date` (matching `show_rep()` behavior)
- Commit: `d726965`

**New Feature: Rich Date Filtering**
- `_resolve_date_filters()` static method on `CLIInterface`
- New CLI flags: `--date`, `--week`, `--month`, `--year`
- Flexible `--from`/`--to` formats: YYYY-MM-DD, YYYY-MM, YYYY, MM/YY, MM
- Filter chaining via intersection; conflict detection with `WARN:` to stderr
- 38 new tests in `tests/test_date_filters.py`
- Commit: `9a64948`

**Protocol Vision Documented**
- `VISION.md` — full protocol pitch: platform-free personal data, compartmentalized social networking, reputation without gatekeepers
- `DESIGN_GOALS.md` — added §0 Protocol Vision at top; strikethrough on resolved blockers
- `ROADMAP.md` — reorganized with §0 Protocol Layer as top priority; all historical blockers noted as resolved; new items: Format Spec, Portable Export, Remote Sync, Mobile/Wearable/Web POCs
- `BACKLOG.md` — reorganized with P1–P11 protocol items; R1–R4 moved to historical record; priorities updated
- Commit: `c52e961`

**Edge Case Identified: Day-Boundary Spanning Activities**
- Activities crossing midnight (e.g., 23:30 → 03:30) stored under start date only
- Date filters miss entries that span INTO the filtered range but started before it
- Display shows `[23:30 - 03:30]` with no indicator that 03:30 is next day
- Documented as P11 in BACKLOG.md with three fix options (display marker, filter inclusion, or split-at-sync)

**Bug Fix: Staging Index Mapping in sync_day_with_selection()**
- `selected_indices` (staging-level indices) were incorrectly used to index into `all_completed` (a filtered list)
- Fixed by indexing directly into `staging[]` with a set membership check
- 2 new tests: `test_sync_partial_with_active_entries` and `test_sync_partial_remove_with_active_entries`
- Commit: `37eecab`

**Revert Feature (replaces prune)**
- `prune_entries()` (arbitrary block editing) replaced with `revert_entries(count)` — truncates only from end of chain
- New CLI: `phpoc revert <count>` and `phpoc revert --list`
- 5 new tests
- Commit: `c152861`

**Revert Fix: Convert encrypted fields to plain: format**
- Reverted entries carried encrypted `pauses_enc`/`metadata_enc` from ledger
- Sync pipeline expects `plain:` format (NoAuthCryptoManager compat)
- Now converts all encrypted fields back to `plain:` during revert
- Commit: `e0a3e9d`

**Sync Normalization (graceful decryption fallback)**
- `_normalize_staging_entry()` converts hex-encrypted staging fields to `plain:` before sync
- If decryption fails (auth tag mismatch), entry is skipped with `WARN:` message
- Handles stale encrypted data from old reverts or different crypto context
- Commit: `9727637`

**Branch Cleanup**
- `cli-ux` merged to `main` and deleted
- All stale branches (R1-AES-CTR-Malleability, R2-identity-fallback, R4-content-proof-design, feature-habit-pause, feature-sync_confirmation, feature-tags, ledger-creation, modularization) deleted
- Only `main` + `origin/main` remain

## Crypto Architecture Checklist
| Feature | Status | Notes |
|---|---|---|
| Sovereign Key Model (Seed → Master Key) | ✅ | Seed generated from 32 bytes urandom |
| Passphrase wraps Seed (PDK encrypted) | ✅ | PBKDF2(passphrase, "session-salt") at **600K iterations** |
| Identity Ed25519-proxy (HMAC-SHA256) | ✅ | Secret encrypted with Master Key; fallback in genesis |
| Block signing (all block types) | ✅ | Genesis, Day, Month/Year Summary |
| Encrypted timestamps (start/end) | ✅ | AES-CTR + HMAC-SHA256 auth tag |
| Encrypt-then-MAC (auth tag) | ✅ | Tampered ciphertext raises ValueError |
| Plaintext content hash (content_hash) | ✅ | Per-entry SHA-256; survives re-encryption |
| Blind duration index (index.json) | ✅ | Fast rep queries without decryption |
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
| `sync` | Yes | Commits staging → immutable ledger (interactive confirmation) |
| `verify` | Yes | Full chain integrity check (incl. content_hash) |
| `rep [days] [--date/--week/--month/--year/--from/--to]` | Yes | Blind-index reputation summary with rich date filtering |
| `list {all,synced,staged} [days] [--date/--week/--month/--year/--from/--to]` | Yes | Decrypted detailed listing with rich date filtering |
| `revert <count>` | Yes | Remove last N day blocks from ledger, restore entries to staging |
| `revert --list` | Yes | Show ledger summary with recent day blocks |

## Unresolved Issues

### U1 — Sync Removal Auth Tag Mismatch (HIGH PRIORITY)
- **Symptom:** When using `phpoc sync` → toggle removal (`R`) → press `S` to sync, user gets:
  `ValueError: Encrypted data integrity check failed: auth tag mismatch`
  at `sync_day_with_selection()` line ~411, `pauses_json_str = self.crypto.decrypt(data["pauses_enc"])`
- **Stack trace:** `main.py:232` → `sync_with_strategy()` → `sync_day_with_selection()`
- **Confirmed:** User's staging has 11 entries with hex-encrypted `pauses_enc` (not `plain:` format)
- **Could NOT reproduce:** All test scenarios (clean data, old-style revert, multiple revert cycles, mixed format entries) pass without error
- **Partial fix:** Added `_normalize_staging_entry()` that converts encrypted fields to `plain:` before sync, skipping undecryptable entries with a warning (commit `9727637`)
- **Likely cause:** Staging entries carry encrypted data from a stale/different crypto context — `pauses_enc` auth tag doesn't match current master key
- **Still open:** User needs to test the fix on their actual data to confirm resolution
- **Notes:** `get_pending_sync()` works (decrypts `startTime_enc`/`endTime_enc` successfully); the failure is only on `pauses_enc` in the grouping section of `sync_day_with_selection()`

## Next Up (Priority Order)

| Priority | Item | Description | Dependencies |
|---|---|---|---|
| 🔴 Critical | **U1 — Sync Removal Auth Tag Mismatch** | Verify fix works on user's actual data; debug further if still failing | User's actual staging data |
| 🥇 Highest | **P1 — Format Spec (PHPSPEC.md)** | Document the block structure, encryption, chain validation as a standalone spec | None |
| 🥇 High | **P2 — Portable Export** | `phpoc export --range` produces verifiable chain segment | P1 |
| 🥇 High | **P3 — Remote Sync (git-based)** | Push/pull encrypted ledger via git | None — all blockers resolved |
| 🥇 High | **P4 — CLI kinks & UX polish** | Colored output, table formatting, summaries, error messages | None |
| 🥈 Medium | **P5 — Mobile POC** | Minimal Swift/Kotlin ledger reader/writer | P1, P2 |
| 🥈 Medium | **P6 — Wearable POC** | Blind-index writes from watchOS/WearOS | P1, P2 |
| 🥈 Medium | **P7 — Web Viewer** | Static HTML page that renders exported segments | P2 |
| 🥈 Medium | **P11 — Day-Boundary Span** | Activities crossing midnight: display marker, filter inclusion, or split-at-sync | None |

## Architecture Notes
- **Protocol, not just a tool:** PHPOC is now explicitly positioned as an open data format. The CLI is the reference implementation.
- **Compartmentalized data:** The format enforces separation at the data level — a platform sees only what you authorize.
- **Zero-dependency commitment:** Core engine remains pure Python stdlib. Mobile implementations are independent.
- **All historical blockers resolved:** R1 (auth tag), R2 (identity fallback), R3 (600K KDF), R4 (content hash) — all finished.
- See `VISION.md` for the full protocol pitch, `ROADMAP.md` for the feature roadmap, `BACKLOG.md` for task-level tracking.

---

See `CHANGELOG.md` for full history.
