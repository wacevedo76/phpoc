# PH Ledger — Session Handoff

## Current State
- **Branch:** `main` — all fixes committed (normalization, display guards, --till)
- **Tests:** 360/360 passing
- **Dependencies:** Pure Python 3.x standard library — zero external deps
- **Working tree:** clean, all changes committed
- **Config dir:** `~/.config/personal_history_poc/` is now a git repo (initial commit with staging, ledger, index)
- **Sandbox:** `/tmp/test_user_history/` is a clean copy of config for safe experimentation

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

### This Session — CLI/UX + Protocol Vision + Revert/Normalization Fixes

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

**New Feature: `phpoc sync --till MM-DD`**
- `--till MM-DD` (renamed from `--since` for clearer semantics) filters pending entries by date before sync
- Only entries with `date <= till_date` are offered for sync — syncs everything up to and including that date
- `MM-DD` borrows current year; `YYYY-MM-DD` also works
- Works with both `--yes` (auto) and interactive modes
- Implementation: `_resolve_till_date()` in main.py, `till_date` param on `sync_with_strategy()`
- Commit: `041a245`

**Bug Fix: plain: prefix guards in display paths**
- `_print_entry()`, `list_habits()` staging grouping, and `view_active()` all called `crypto.decrypt()` without checking for `plain:` prefix
- Would crash with `ValueError: non-hexadecimal number found in fromhex()` when listing entries with `plain:` formatted fields
- Fixed by adding `startswith("plain:")` check before each decrypt call
- Commit: `ad7060a`

**Bug Fix: [R]emove now actually deletes entries from staging**
- Previously, `[R]` in interactive sync only excluded entries from `selected_indices` — they stayed in staging forever
- Added `removal_indices: Set[int]` to `SyncDecision` dataclass
- `sync_day_with_selection()` now accepts `removal_indices` parameter, deletes those staging entries during cleanup
- `sync_with_strategy()` handles all-removed case (no entries to sync, only deletions)
- Commit: `77a2a96`

**U1 — Sync Removal Auth Tag Mismatch — WIN: Partial Resolve**
- **Reproduced:** staging entries where some encrypted fields are bound to a DIFFERENT crypto key than current session
- **Fix (commit `9727637`):** `_normalize_staging_entry()` converts hex-encrypted staging fields to `plain:` before sync. Entries with undecryptable fields are skipped with `WARN:` instead of crashing.
- **Fix (commit `ad7060a`):** `_print_entry()`, `list_habits()` grouping, and `view_active()` now handle `plain:` prefix in all display paths
- **User test result (2026-04-29):** `ph sync --yes --till 04-27` ran successfully:
  - ✅ "Cooking - Diner" synced cleanly
  - ✅ "Tidying - Kitchen" synced cleanly
  - ✅ "1", "2", "1" (04-28 test entries) left in staging untouched
  - ✅ "Working on phpoc", "Music", "YT", "Nitrotype", "Tidying" (04-28) left in staging
  - ⚠️ "Learning Pi agent" skipped with WARN: "undecryptable data (stale crypto context)"
  - ✅ `ph list all` displayed without crash (all 360 tests passing)
- **Remaining:** "Learning Pi agent" has at least one encrypted field that can't be decrypted — needs manual conversion or the `repair_staging.py` script
- **Remaining:** The numbered entries ("1", "2", "1") from 04-28 also have hex-encrypted fields from the old revert format — may or may not be decryptable with current key

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
| `sync [--yes] [--till MM-DD]` | Yes | Commits staging → immutable ledger (interactive or --yes auto); `--till` syncs only entries up to and including that date |
| `verify` | Yes | Full chain integrity check (incl. content_hash) |
| `rep [days] [--date/--week/--month/--year/--from/--to]` | Yes | Blind-index reputation summary with rich date filtering |
| `list {all,synced,staged} [days] [--date/--week/--month/--year/--from/--to]` | Yes | Decrypted detailed listing with rich date filtering |
| `revert <count>` | Yes | Remove last N day blocks from ledger, restore entries to staging |
| `revert --list` | Yes | Show ledger summary with recent day blocks |

## Unresolved Issues

### D1 — Git Versioning of Config Directory ✅
- **Done:** User git-initted `~/.config/personal_history_poc/` with initial commit of staging.json, ledger.json, index.json
- **Template:** `/tmp/test_user_history/` recreated from config dir for safe experimentation
- **Workflow:** `git add -A && git commit -m "before"` → run test → `git diff HEAD -- staging.json`

### U1 — Stale Crypto Context in Reverted Entries (PARTIALLY RESOLVED)
- **Symptom:** Some staging entries (from old revert code) have encrypted fields bound to a different crypto key. Sync now skips them gracefully with `WARN:` instead of crashing.
- **Fix (commit `9727637`):** `_normalize_staging_entry()` converts hex→plain: at sync start; undecryptable entries skipped.
- **Fix (commit `ad7060a`):** All display paths handle `plain:` prefix.
- **Fix (commit `77a2a96`):** Entries marked for removal via `[R]` are now ACTUALLY deleted from staging after sync (not just excluded from selected_indices).
- **Temp workaround for syncing:** `ph sync --yes --till YYYY-MM-DD` syncs everything up to a date, leaving broken entries for later.
- **Permanent fix needed:** Either:
  a) Revert the broken day blocks and re-revert with fixed code (`revert_entries()` now produces `plain:` format)
  b) Run `scripts/repair_staging.py` to manually convert all hex fields to `plain:`
  c) Use the interactive sync removal (`[R]`) to delete stale entries from staging
- **Status:** "Learning Pi agent" confirmed to have undecryptable fields. Remaining 04-28 entries untested but likely same issue.
- **Ongoing investigation:** Using `/tmp/test_user_history/` as sandbox copy, tracked via git diff on `~/.config/personal_history_poc/

## Next Up (Priority Order)

| Priority | Item | Description | Dependencies |
|---|---|---|---|
| 🔴 Critical | **U1 — Stale Crypto Context** | Repair reverted entries with mismatched encryption key ("Learning Pi agent" + possibly 04-28 entries). Options: revert blocks + re-revert with fixed code, run repair_staging.py, or use [R]emove sync to delete stale entries | None — investigation phase |
| 🔴 Critical | **D1 — Git Versioning of Config** ✅ | Git-initted, first commit done. Debug workflow: commit before test, diff after | Done |
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
