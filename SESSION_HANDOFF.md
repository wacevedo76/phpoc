# PH Ledger — Session Handoff

## Current State
- **Branch:** `cli-ux` — CLI/UX improvements for date filtering
- **Tests:** 353/353 passing (test_modular: 12, test_hierarchy: 2, test_recovery: 2, test_date_filters: 38, + sync/tags/pause tests)
- **Dependencies:** Pure Python 3.x standard library — zero external deps
- **Working tree:** clean, all changes committed

## Previous Session — Blockers Resolved (on `main`)

All four roadmap blockers (R1–R4) resolved in prior session, merged into `main`:

| Blocker | Resolution | Branch |
|---------|-----------|--------|
| **R1** — AES-CTR Malleability | Encrypt-then-MAC: HMAC-SHA256 auth tag | `R1-AES-CTR-Malleability` |
| **R2** — Identity Fallback | `identity_secret_enc_fallback` in genesis | `R2-identity-fallback` |
| **R3** — PBKDF2 600K | Bumped iterations 100K → 600K (OWASP 2026) | `R1-AES-CTR-Malleability` |
| **R4** — Content Proof | Plaintext content_hash per entry | `R4-content-proof-design` |

## This Session — CLI/UX Improvements (branch `cli-ux`)

### Bug Fix: `list` ignoring `days` positional
- `list_habits()` accepted `days_limit` parameter but never converted it to a `from_date` filter
- `list synced 1` showed all history instead of last day
- Fixed: `days_limit` now correctly converts to a `from_date` string (matching `show_rep()` behavior)
- **Commit:** `d726965`

### New Feature: Rich Date Filtering
Added `_resolve_date_filters()` static method to `CLIInterface` — a centralized date filter resolver supporting multiple input formats and filter chaining via intersection.

**New CLI flags on `list` and `rep`:**

| Flag | Example | Description |
|------|---------|-------------|
| `--date` | `--date 2026-04-28` | Exact day (overrides `days` positional) |
| `--week` | `--week 2026-W17` | ISO week |
| `--week` | `--week 2026-04-22` | Resolves date to its containing week |
| `--month` | `--month 2026-04` | Full month |
| `--month` | `--month 04` | Month only — borrows year from `--year` or current year |
| `--year` | `--year 2026` | Full year |
| `--from` | `--from 04/26` | Now accepts flexible formats |
| `--to` | `--to 2026-06` | Now accepts flexible formats |

**Flexible `--from`/`--to` formats:** `YYYY-MM-DD`, `YYYY-MM`, `YYYY`, `MM/YY`, `MM` (borrows year from `--year` or current year)

**Filter chaining:** All filters combine via intersection — narrows to the smallest unit of time specified. E.g.:
- `--year 2026 --month 04` → April 2026
- `--year 2026 --month 04 --week 2026-W17` → that specific week
- `--year 2026 --month 04 --week 2026-W17 --date 2026-04-22` → that exact day

**Conflict detection:** Prints `WARN:` to stderr when bounds are incompatible (e.g., `--year 2025 --date 2026-04-28`).

**Files changed:**
- `cli/interface.py` — added `_resolve_date_filters()` + imports (`calendar`, `re`, `datetime`)
- `main.py` — added new CLI args, wired resolver into `list` and `rep` dispatch
- `tests/test_date_filters.py` — 38 new tests (format parsing, chaining, conflicts, edge cases)

**Commit:** `9a64948`

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
| `sync` | Yes | Commits staging → immutable ledger |
| `verify` | Yes | Full chain integrity check (incl. content_hash) |
| `rep [days] [--date/--week/--month/--year/--from/--to]` | Yes | Blind-index reputation summary with rich date filtering |
| `list {all,synced,staged} [days] [--date/--week/--month/--year/--from/--to]` | Yes | Decrypted detailed listing with rich date filtering |

## Roadmap — All Unblocked

| Item | Priority | Notes |
|------|----------|-------|
| **Media Witness linkage** | 🔜 High | Link content hashes to activities. No blockers. |
| **Reconciliation / Chain-Bridging** | 🔜 Medium | R1+R4 resolved. content_hash enables plaintext verification after re-keying. |
| **Remote Sync (git-based)** | 🔜 Medium | R1+R2+R3 resolved. Auth tags, identity fallback, 600K KDF. |
| **Archival Automation** | 🔜 Medium | `phpoc archive --year X`. No blockers. |
| **CLI/UX improvements** | 🔜 In Progress | Rich date filtering done. Next: colored output, table formatting, summaries, plugin system. |
| **Real Ed25519 signatures** | 🔮 Low | R2 resolved — key loss no longer permanent. |
| **Shareable Export** | 🔮 Low | R1 resolved — entry-level integrity assured. |
| **Single-file export** | 🔮 Low | R2 resolved — identity in genesis. |

## Architecture Notes
- Cloud-folder sync strategy preferred (Dropbox/iCloud/etc) — no provider-specific code needed
- Storage layer already abstracted via `AbstractLedgerStore`
- `NoAuthCryptoManager` unchanged (local per-device staging convenience)
- Date filtering is pure CLI-layer: no core/security/storage changes

See `CHANGELOG.md` for full history and `ROADMAP.md` / `ROADMAP-BLOCKS.md` for detailed planning.
