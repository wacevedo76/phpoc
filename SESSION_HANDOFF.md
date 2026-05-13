# PH Ledger — Session Handoff

> **⚠️ Emergency Handoff (2026-05-04):** The user and assistant were discussing **Multi-Device Session & Staging Architecture** — a design exploration sparked by the downstream implications of Portable Export (P2).
> **Key insight:** Cross-device staging is an attack vector that must be encrypted. Direction B was chosen: shared encrypted staging with a single active session cookie per device.
> **Design document:** `DESIGN_MULTI_DEVICE_SESSION.md` (saved 2026-05-04)
> **Also discussed:** Equality correlation problem for `device_id` field. Proposed solution: default field in every entry, randomized encryption, keyed-HMAC proof for attribution.
> **Status:** ✅ Implemented in Phase 2 — `security/device_identity.py`, `domain/staging/` complete.
> See [ARCHITECTURAL_MIGRATION_STRATEGY.md](./ARCHITECTURAL_MIGRATION_STRATEGY.md) for full migration status.

## Current State
- **Branch:** `Phpoc-Architectual_Migration` (8 commits past main)
- **Tests:** 610 total, 1 pre-existing failure (test_date_filters), no regressions
- **Dependencies:** Pure Python 3.x standard library — zero external deps
- **Working tree:** Clean — all changes committed
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

### This Session (Current) — Extensible Content Hash (v0.4.0)

**Content hash made extensible:** The `content_hash` algorithm was changed from a hardcoded 9-field canonical dict to an **all-keys iterator** that automatically covers any future fields added to activity data. Key changes:

- `core/ledger.py`: `_compute_content_hash()` now takes `(data: dict, decrypt_fn)` and iterates all keys — decrypts `*_enc` fields, sorts lists, excludes `content_hash` itself, uses `sort_keys=True` for deterministic ordering
- `PHPSPEC.md`: §5.5 and §6 rewritten with both legacy (v0.3.0, 9-field) and extensible (v0.4.0+, all-keys) algorithms documented. §9.3 version table updated with v0.4.0. Migration section added.
- `scripts/migrate_format_version.py`: Full rewrite supporting v0.2.0→v0.3.0 (existing) and v0.3.0→v0.4.0 (new: content hash recompute + chain cascade). Auto-detects current version and dispatches appropriately.
- `verify()`: Uses try-both approach — tries extensible algorithm first, falls back to legacy — handles mixed-version ledgers without format_version dependency.

**Committed as `36f4cec`** — resolved. User may revisit with design questions later.

---

### Prior Session — Format Specification (PHPSPEC.md)

**P1 — Format Spec completed:** Created [PHPSPEC.md](PHPSPEC.md) — a standalone format specification (v0.3.0 draft, ~1450 lines) covering:
- §1–2: Overview, key derivation, Sovereign Key Model, identity
- §3: Encryption scheme (AES-CTR + encrypt-then-MAC, wire format)
- §4: Full JSON schemas for all 4 block types with field tables
- §5: Chain validation (prev_hash linkage, seals, signatures, entry hashes, content hashes, full algorithm)
- §6: Content hash algorithm (canonical form, normalization rules)
- §7: Blind index (format, query protocol, rebuild-from-chain)
- §8: Staging area (plain: prefix, sync pipeline)
- §9: Implementation considerations (legacy formats, versioning with `format_version`, edge cases including chain splitting)
- §10: Annotated 3-block example ledger

**Key decisions documented in spec:**
- `format_version` field added to genesis (§4.1) — explicitly versioned format evolution (§9.3)
- One-time migration script at `scripts/migrate_format_version.py` for v0.2.0 → v0.3.0 upgrade
- Chain splitting at any summary block boundary (§9.4.5) — foundation for Portable Export
- Any field may be encrypted using `_enc` suffix convention (not hardcoded set)
- Ledger is self-contained (identity secret fallback in genesis)

**Scripts created:** `scripts/migrate_format_version.py` — argparse-based migration tool with dry-run, in-place, and target-version options.

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

## Unresolved Issues

### D2 — Multi-Device Session & Staging Architecture ✅ (Resolved 2026-05-05)

**Design doc:** `DESIGN_MULTI_DEVICE_SESSION.md`

All open questions resolved in favor of the **Timeline Model**:

| # | Question | Resolution |
|---|----------|------------|
| Q5 | Remote staging transport? | Git remote as first implementation via `AbstractStagingTransport` (pull/push). Shared encrypted blob at `staging/blobs/`. Fixed-size obfuscation tiers (64K/128K/256K/512K). |
| Q6 | Evicted device behavior? | **No eviction exists** — timeline model is additive by timestamp. Multiple devices can append concurrently. Device ID mismatch triggers re-auth, not exclusion. |
| Q7 | Device identity mechanism? | `DeviceIdentityProvider` interface. Default: MK-derived (HMAC). Pluggable for alternate strategies. |
| D3 | Offline reconciliation? | **No reconciliation needed** — entries are timestamped and additive. On reconnect: push local, pull remote, merge by timestamp. No conflicts possible. |

**Key model shift:** The initial direction (session cookie with sequence numbers for mutual exclusion) was replaced during Q5 discussion with the **timeline model** — staging is a timestamped additive log. The remote blob is authoritative; local staging is a cache. Every interaction: check device_id → re-auth if mismatch → modify local → push to remote → pull remote → local == remote.

**All P2/P3/P5/P6 blockers resolved.**

---

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
| ✅ Done | **P0 — Extensible Content Hash (v0.4.0)** | `content_hash` algorithm changed from hardcoded 9-field dict to all-keys iterator. Auto-covers future fields. See commit `36f4cec`. Files touched: `core/ledger.py`, `PHPSPEC.md`, `scripts/migrate_format_version.py` | Committed |
| ✅ Done | **U1 — Stale Crypto Context** | Fixed normalization, display guards, --till, removal deletion, repair script. User verified live. | All fixes committed (363 tests pass) |
| ✅ Done | **D1 — Git Versioning of Config** | Git-initted, snapshots before/after each run | Done |
| ✅ Done | **P1 — Format Spec (PHPSPEC.md)** | Standalone spec document (block structure, encryption, chain validation, content hash, blind index, staging, versioning). See [PHPSPEC.md](PHPSPEC.md). Includes `format_version` field, migration script `scripts/migrate_format_version.py`, and chain splitting mechanics in §9.4.5. | Done |
| ✅ Done | **U2 — Recovery Chain Integrity** | `main.py recover` now re-chains all subsequent blocks. 5 tests in `tests/test_recovery_verify.py`. | Done |
| ✅ Done | **D2 — Multi-Device Session & Staging** | Timeline model, DeviceIdentityProvider, AbstractStagingTransport, staging blob format. All Q5/Q6/Q7/D3 resolved. | Done — blocks P2/P3/P5/P6 removed |
| 🥇 Highest | **P2 — Portable Export** | `phpoc export --range` produces verifiable chain segment. Chain splitting in [PHPSPEC §9.4.5](PHPSPEC.md#945-chain-splitting-at-summary-boundaries). | None |
| 🥇 High | **P3 — Remote Sync (git-based)** | Implement `AbstractStagingTransport` + `GitStagingTransport`. Blob format in [PHPSPEC §8.5](PHPSPEC.md#85-multi-device-remote-staging). | None |
| 🥇 High | **P7 — Web Viewer (Phone POC)** | Lowest-barrier phone access: static HTML/JS page or PWA that reads ledger + staging blob. | P3 (transport) |
| 🥇 High | **P5 — Mobile POC (Swift/Kotlin)** | Minimal phone app for reading/adding entries. | P3 (transport) |
| 🥈 Medium | **P4 — CLI kinks & UX polish** | Colored output, table formatting, summaries, error messages | None |
| 🥈 Medium | **P6 — Wearable POC** | Blind-index writes from watchOS/WearOS | P3 (transport) |
| 🥈 Medium | **P11 — Day-Boundary Span** | Activities crossing midnight: display marker, filter inclusion, or split-at-sync | None |

## Architecture Notes
- **Protocol, not just a tool:** PHPOC is now explicitly positioned as an open data format. The CLI is the reference implementation.
- **Compartmentalized data:** The format enforces separation at the data level — a platform sees only what you authorize.
- **Zero-dependency commitment:** Core engine remains pure Python stdlib. Mobile implementations are independent.
- **All historical blockers resolved:** R1 (auth tag), R2 (identity fallback), R3 (600K KDF), R4 (content hash) — all finished.
- See `VISION.md` for the full protocol pitch, `ROADMAP.md` for the feature roadmap, `BACKLOG.md` for task-level tracking.

---

See `CHANGELOG.md` for full history.

---

### Key Docs
| File | Purpose |
|------|---------|
| `ARCHITECTURAL_DECISIONS.md` | Formal ADR record — every architectural decision with context, rationale, and consequences (15 decisions so far, ADR-001 through ADR-015). |
| `DESIGN_MULTI_DEVICE_SESSION.md` | D2 design exploration — **fully resolved** timeline model, transport interface, device identity, staging obfuscation. |
| `PHPSPEC.md` | Format specification — block types, encryption, chain validation, content hash, blind index, staging. |
| `ROADMAP.md` | Feature roadmap with completed/planned/future items. |
| `BACKLOG.md` | Task-level tracking with priorities. |

---

## Triage Log

*Entries added by `/triage` template. Each entry: date — one-line summary (files touched).*

- 2026-04-30 — Fixed `oneoff` duration from 2 minutes to 1 second by changing `-120000` to `-1000` in `main.py` line 215 (`main.py`)
- Marked `main.py` as HOT in MAP.md
- 2026-04-30 — Extensible content_hash: changed from hardcoded 9-field dict to all-keys iterator that auto-covers future fields. Updated `_compute_content_hash()` in `core/ledger.py`, rewrite `PHPSPEC.md` §5.5/§6/§9.3, full rewrite of `scripts/migrate_format_version.py` with v0.3.0→v0.4.0 path. **Resolved — committed as `36f4cec`.** (`core/ledger.py`, `PHPSPEC.md`, `scripts/migrate_format_version.py`)
- 2026-05-04 — P0 marked resolved, handoff updated. User may revisit design questions later.
- 2026-05-04 — **D2 Multi-Device Session & Staging Architecture** — Architectural discussion sparked by P2 (Portable Export). Direction B chosen: shared encrypted staging, single active session cookie. Equality correlation problem identified for `device_id`. Created `DESIGN_MULTI_DEVICE_SESSION.md`. **Next issue to resolve — user paused discussion.**
- 2026-05-04 — **D2 progress:** Q1-Q4 resolved (offline, seq numbers, logout). Q5 partially resolved (git remote as first transport, `AbstractStagingTransport` interface, multi-staging after mobile). Staging obfuscation: 4-tiered fixed-size padding (64K/128K/256K/512K), user-configurable, encrypted blob. Remaining: Q6 (evicted device behavior), Q7 (device identity), D3 (offline sync reconciliation).
- 2026-05-09 — Fixed negative duration bug: `_compute_duration` in `core/ledger.py` returns `max(0, ...)` to clamp pauses extending past end time. Caused by end-time override during interactive sync without trimming pauses. (`core/ledger.py`)
- 2026-05-09 — Added three staging tools: `modify` (edit end time & pauses of staged entry), `remove` (delete staged entry by index), `review` (preview staged entries post-sync). On branch `tools-modify-remove-review`. (`main.py`, `core/ledger.py`)
