# PH Ledger — Session Handoff

## Current State
- **Branch:** `main` — all fixes committed (normalization, display guards, --till, removal deletion)
- **Tests:** 363/363 passing
- **Dependencies:** Pure Python 3.x standard library — zero external deps
- **Working tree:** clean, all changes committed (latest: `bfa349f`)
- **Config dir:** `~/.config/personal_history_poc/` is a git repo (snapshots before/after each test run)
- **Sandbox:** `/tmp/test_user_history_after/` has post-sync state for investigation

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

### This Session (Current) — CLI/UX + Protocol Vision + Staging Repair & Removal Fixes

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

**U1 — Stale Crypto Context: current status**
- Root cause: old revert code (pre-`e0a3e9d`) copied hex-encrypted fields from ledger to staging; some fields encrypted with a different key than current session
- Fixes now in place:
  1. ✅ `_normalize_staging_entry()` — converts hex→plain: at sync start; skips undecryptable entries with `WARN:`
  2. ✅ `plain:` prefix guards in all display paths — no crash on `list all`
  3. ✅ `--till MM-DD` — sync only entries up to a date, leaving stale ones in staging
  4. ✅ `[R]emove` now truly deletes entries from staging — mark stale entries for removal, press S to purge them
  5. ✅ `scripts/repair_staging.py` — one-time migration to convert all hex fields to plain:
- **User proof-of-fix:** `ph sync --yes --till 04-27` synced 2 of 3 04-27 entries cleanly; "Learning Pi agent" skipped without crash. `ph list all` displayed without error.
- **✅ User verified (2026-04-29):** Used `[R]emove` on 4 stale entries (1, 2, 1, Learning Pi agent) + synced 5 real entries (Working, Music, YT, Nitrotype, Tidying) with one-shot fix. All 5 reached ledger, all 4 stale entries deleted from staging. Chain integrity verified. Full scenario reproduces cleanly in automated regression tests.

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

### U1 — Stale Crypto Context in Reverted Entries ✅ (Resolved)
- **Symptom:** Old revert code left hex-encrypted fields in staging bound to a different key.
- **All 5 fixes committed and tested (363 tests pass):**
  1. `_normalize_staging_entry()` — converts hex→plain: at sync start; skips undecryptable entries
  2. `plain:` prefix guards in all display paths
  3. `--till MM-DD` — date-filtered syncing
  4. `[R]emove` now truly deletes entries from staging
  5. `scripts/repair_staging.py` — one-time migration
- **✅ User verified (2026-04-29):** Interactive sync with [R] on 4 stale entries + sync of 5 real entries worked correctly. All 5 reached ledger, all 4 removed from staging.

## Next Up (Priority Order)

| Priority | Item | Description | Dependencies |
|---|---|---|---|
| ✅ Done | **U1 — Stale Crypto Context** | Fixed normalization, display guards, --till, removal deletion, repair script. User verified live. | All fixes committed (363 tests pass) |
| ✅ Done | **D1 — Git Versioning of Config** | Git-initted, snapshots before/after each run | Done |
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
