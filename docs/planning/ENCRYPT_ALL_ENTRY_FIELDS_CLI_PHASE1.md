# Encrypt All Entry Fields — CLI (Phase 1)

> **Plan:** Test exploration / blueprint for CLI reference implementation (Python)
> **Purpose:** Blueprint of all needed test assertions for per-activity field encryption
> **Status:** 🔜 Phase 1 (test exploration)
> **Next Phase:** Phase 2 (RED: test definition)

## Design Decisions (from discussion 2026-07-18)

| Decision | Choice |
|----------|--------|
| Encryptable fields | `title`, `tags`, `comment`, `duration` (all opt-in) |
| Default fields encrypted | `startTime_enc`, `endTime_enc`, `pauses_enc` (no change) |
| Structural fields | `is_active`, `is_paused` stay plaintext |
| Backward compat | Dual read: try `title_enc` first, fall back to `title`. No migration of committed entries (would break chain). |
| Default display | Encrypted entries show `[encrypted]` placeholder. User must authenticate to reveal. |
| Reveal triggers | (1) Global `--show-encrypted` flag, (2) Per-activity, (3) Per date-range (week/month/year) |
| Blind index | Skip encrypted entries entirely |
| Export | Ciphertext survives — chain blocks preserved as-is |
| Staging opt-in UX | ⚠️ **Deferred** — specific flag names and command syntax decided during implementation. Options: `ph start --encrypt-title`, `ph encrypt <title>`, `ph modify --encrypt`, or interactive prompts in edit mode. |

## Architecture Overview

The CLI has a layered architecture with many touch points. Encrypted field support must thread through all of them:

```
┌─────────────────────────────────────────────────────────┐
│                   CLI Commands Layer                     │
│  ph start, ph end, ph pause, ph modify, ph view,        │
│  ph list, ph rep, ph export, ph sync, ph encrypt        │
│                                                         │
│  ⚠️ New/updated flags: --encrypt-title, --encrypt-tags,  │
│     --encrypt-comment, --encrypt-duration, --encrypt-all │
│     --show-encrypted, --show-range                       │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│                  CLI View Layer                          │
│  cli_view.py: render_entry_line(), render_overview(),   │
│  edit mode display, active task display                 │
│                                                         │
│  ⚠️ Changes: Show [encrypted] for protected fields;     │
│     decrypt on reveal; per-field visibility flags       │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│               Staging Service Layer                      │
│  domain/staging/service.py: capture(), end(), pause(),   │
│  unpause(), modify()                                    │
│  domain/staging/local_cache.py: write_entries(),        │
│  read_entries(), _raw_entry_from_dto(), _compute_hash() │
│                                                         │
│  ⚠️ Changes: Accept encryption flags; dual-read _enc;   │
│     entry hash uses canonical plaintext (not ciphertext) │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│                 Ledger Engine Layer                      │
│  domain/ledger/engine.py: _build_day_block(),            │
│  _update_index()                                        │
│  domain/ledger/chain.py: _decrypt_entry_fields(),        │
│  verify(), _verify_entry_hash()                         │
│                                                         │
│  ⚠️ Changes: Decrypt title_enc in _decrypt_entry_fields; │
│     skip encrypted entries in index build;              │
│     entry hash verification handles both formats        │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│                 Crypto / Security Layer                  │
│  security/crypto.py: encrypt(), decrypt() — NO CHANGE   │
│  (field-agnostic — already handles any string)          │
└─────────────────────────────────────────────────────────┘
```

## Test Groups

### Group A: Staging write path — ~14 tests
Encryption flags flow from capture → local_cache write

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | `local_cache.write_entries()` encrypts `title` → `title_enc` when encrypt_title flag set | Core write-path: title encryption | Most common encrypted field |
| A2 | `local_cache.write_entries()` encrypts `tags` → `tags_enc` (JSON array) when encrypt_tags set | Tags round-trip through JSON serialization | Array → string → encrypt |
| A3 | `local_cache.write_entries()` encrypts `comment` → `comment_enc` when encrypt_comment set | Comment encryption | Simple string |
| A4 | `local_cache.write_entries()` encrypts `duration` → `duration_enc` (int→string) when encrypt_duration set | Duration encryption with type coercion | Integer must be stringified before encrypt |
| A5 | `local_cache.write_entries()` stores plaintext `title` when encrypt_title=false (default) | Backward compat: no change for existing behavior | Existing entries unbroken |
| A6 | Encrypted `title_enc` output is valid hex ciphertext (salt+nonce+ciphertext+tag per spec §3.4) | Wire format compliance | Interop with web and spec |
| A7 | `local_cache.write_entries()` encrypts all 4 fields when encrypt_all flag set | Master flag convenience | Batch encryption UX |
| A8 | `local_cache.write_entries()` does NOT encrypt `is_active` or `is_paused` | Structural fields exempt from encryption | Never committed; staging-only metadata |
| A9 | Entry hash computed from canonical plaintext values, not ciphertext | Hash stability across encryption states | Same entry with/without encryption = same hash |
| A10 | Two writes of same entry with encryption produce different ciphertext (random nonce) | Semantic security | Random salt per encryption operation |
| A11 | `write_entries()` handles empty title with encryption flag | Edge case: empty string | Should not raise |
| A12 | `write_entries()` handles null comment with encryption flag | Edge case: None value | Should skip or encrypt empty string |
| A13 | `capture()` passes encryption flags through to `_local.append()` | Service layer pass-through | CLI → service → cache chain intact |
| A14 | `modify()` can change encryption state of existing staging entry | User can encrypt/decrypt before commit | Pre-commit flexibility |

### Group B: Staging read path — ~9 tests
Dual-read and decryption in local_cache.read_entries()

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | `read_entries()` decrypts `title_enc` → returns title string in DTO | Read path: encrypted title recoverable | Symmetric to write path |
| B2 | `read_entries()` falls back to plaintext `title` when `title_enc` absent | Backward compat with existing entries | Pre-feature entries readable |
| B3 | `read_entries()` decrypts `tags_enc` → JSON.parse → list | Tags round-trip: array preserved | JSON structure integrity |
| B4 | `read_entries()` decrypts `comment_enc` → string | Comment round-trip | Simple string |
| B5 | `read_entries()` decrypts `duration_enc` → integer | Duration round-trip: int preserved | Type coercion correct |
| B6 | `read_entries()` returns None/skip for corrupt ciphertext | Graceful degradation | Don't crash on bad data |
| B7 | `read_entries()` handles partial encryption (title encrypted, tags plaintext) | Mixed encryption per entry | Real-world usage pattern |
| B8 | `read_entries()` marks entries with `has_encrypted_fields: true` in DTO | Display layer can identify encrypted entries | Enables `[encrypted]` placeholder |
| B9 | `read_entries()` without MK (NoAuth) returns entries with `_enc` fields as raw ciphertext | Unauthenticated read path | Staging viewable without auth |

### Group C: Ledger engine (committed entries) — ~10 tests
Encryption handling in engine.py and chain.py

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | `_build_day_block()` preserves `title_enc` in committed entry data | Encrypted title survives commit | Chain integrity |
| C2 | `_build_day_block()` preserves `tags_enc` in committed entry data | Encrypted tags survive commit | Chain integrity |
| C3 | `_build_day_block()` preserves `comment_enc` in committed entry data | Encrypted comment survives commit | Chain integrity |
| C4 | `_build_day_block()` preserves `duration_enc` in committed entry data | Encrypted duration survives commit | Chain integrity |
| C5 | `_decrypt_entry_fields()` decrypts `title_enc` for committed entries | Read path for committed encrypted entries | Used by verify and display |
| C6 | `_decrypt_entry_fields()` decrypts `tags_enc` → JSON array | Tags decryption in committed context | Consistent with staging |
| C7 | `_decrypt_entry_fields()` decrypts `comment_enc` | Comment decryption in committed context | Full field coverage |
| C8 | `_decrypt_entry_fields()` decrypts `duration_enc` → integer | Duration decryption in committed context | Type preservation |
| C9 | `_decrypt_entry_fields()` falls back to plaintext field when `_enc` absent | Backward compat for committed entries | Existing chain entries work |
| C10 | `verify()` correctly verifies entries with `title_enc` (entry hash checks canonical plaintext) | Chain verification works with encrypted fields | Core integrity check |

### Group D: Blind index — ~5 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | `_update_index()` skips entry when `title_enc` present and title not decryptable | Encrypted-title entries excluded from index | Design decision: skip, don't bucket |
| D2 | `_update_index()` includes entry with plaintext `title` normally | Unencrypted entries still indexed | Backward compat |
| D3 | `rebuild_index()` excludes encrypted-title entries | Full rebuild respects encryption | Consistency |
| D4 | `ph rep` output does not include encrypted entries in totals or breakdown | Reputation query excludes encrypted | User-facing correctness |
| D5 | `ph rep --show-encrypted` decrypts and includes encrypted entries in output | Optional reveal in reputation | Per design: reveal triggers apply to rep too |

### Group E: Entry hash / integrity — ~6 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | Entry hash identical for same entry with `title` vs `title_enc` (same plaintext) | Hash uses canonical plaintext, not ciphertext | Key design requirement |
| E2 | `_compute_entry_hash()` uses plaintext field names (`title`, not `title_enc`) | Canonical field names for hash | Consistent across encryption states |
| E3 | Changing encryption state (encrypt → decrypt) does not change entry hash | Reversible without chain impact | User can change their mind pre-commit |
| E4 | Entry with `title_enc` + plaintext `tags` hashes the same as all-plaintext version | Mixed fields hash correctly | Partial encryption works |
| E5 | `_verify_entry_hash()` handles committed entries with `title_enc` (decrypts before recomputing) | Chain verification with encrypted entries | Backward compat in verify path |
| E6 | Tampered `title_enc` ciphertext causes entry hash mismatch in verify | Tamper detection works on encrypted fields | Security property |

### Group F: Display (CLI view) — ~10 tests
cli_view.py rendering and reveal behavior

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| F1 | `render_entry_line()` shows `[encrypted]` for title when entry has title_enc and no MK | Default privacy display | Core UX requirement |
| F2 | `render_entry_line()` shows decrypted title when MK available | Authenticated display | Normal operation |
| F3 | `render_entry_line()` shows normal title for plaintext entries | Mixed encrypted + plaintext coexist | Backward compat display |
| F4 | `render_entry_line()` shows tags/time/duration normally when those fields are plaintext | Non-encrypted fields visible | Partial visibility |
| F5 | `render_entry_line()` shows `[encrypted]` for tags when tags_enc present | Field-level granularity in display | Each field independently hidden/shown |
| F6 | `render_overview()` (sync preview) shows `[encrypted]` for pending encrypted entries | Pre-commit preview respects privacy | Sync confirmation UX |
| F7 | `ph view --show-encrypted` decrypts and displays all encrypted entries | Global reveal flag | Command-line override |
| F8 | `ph view --show-range 2026-07` decrypts entries in July 2026 | Per-range reveal | Week/month/year granularity |
| F9 | `ph list` shows encrypted entries in list with `[encrypted]` marker | List command respects encryption | Consistent across commands |
| F10 | `ph list --show-encrypted` decrypts and shows encrypted entries | List with reveal | Flag works across commands |

### Group G: Commands (CLI interface) — ~8 tests
⚠️ Specific flag names TBD during implementation — these test the concepts

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| G1 | `ph start` accepts encryption flags (title/tags/comment/duration/--encrypt-all) | Capture with encryption opt-in | Creation-time control |
| G2 | `ph start` without encryption flags stores plaintext (default behavior) | Default is plaintext | No surprise encryption |
| G3 | `ph modify` can encrypt previously plaintext entry | Pre-commit encryption of existing staging entry | Flexibility |
| G4 | `ph modify` can decrypt previously encrypted entry | Pre-commit decryption | User changes their mind |
| G5 | `ph encrypt <title>` encrypts fields of existing staging entry | Standalone encrypt command | Alternative UX pattern |
| G6 | Interactive edit mode supports toggling encryption per-field | TUI-style encryption control | Edit mode workflow |
| G7 | `ph sync` commits entries with encrypted fields correctly | Encrypted entries survive sync/commit | End-to-end flow |
| G8 | `ph export` preserves `title_enc` as ciphertext in output | Export preserves encrypted state | Archive integrity |

### Group H: Sync / remote — ~5 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| H1 | Remote push includes `title_enc` ciphertext in staging blob | Encrypted title pushed to remote | Remote staging sync |
| H2 | Remote pull returns `title_enc` ciphertext when no MK | Unauthenticated pull preserves encrypted state | Cross-device without auth |
| H3 | Remote pull with MK decrypts `title_enc` → plaintext | Authenticated pull reveals content | Normal cross-device flow |
| H4 | Cross-device roundtrip: CLI encrypts → push → web pulls → decrypts with shared MK | Multi-client encryption interop | Shared MK enables cross-client decrypt |
| H5 | Remote merge handles encrypted fields from different devices | Staging merge with encrypted fields | Merge correctness |

### Group I: Integration / end-to-end — ~5 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| I1 | Full flow: capture with encryption → sync → verify → view (decrypted) | End-to-end correctness | Happy path |
| I2 | Full flow: capture with encryption → view before sync (no MK) → shows [encrypted] | Default display behavior end-to-end | Privacy by default |
| I3 | Full flow: capture encrypted → modify (decrypt) → sync → verify (plaintext) | Change encryption state before commit | Pre-commit flexibility |
| I4 | Full flow with mixed entries: 2 encrypted + 3 plaintext → sync → verify → list | Mixed entries in same chain | Real-world usage |
| I5 | Existing chain with no encrypted entries → verify passes (no regression) | Backward compat: old chains still verify | Upgrade safety |

## Summary

| Group | Area | Tests |
|-------|------|-------|
| A | Staging write path | 14 |
| B | Staging read path | 9 |
| C | Ledger engine (committed) | 10 |
| D | Blind index | 5 |
| E | Entry hash / integrity | 6 |
| F | Display (CLI view) | 10 |
| G | Commands (CLI interface) | 8 |
| H | Sync / remote | 5 |
| I | Integration / E2E | 5 |
| **Total** | | **72** |

## Key Implementation Files (expected changes)

| File | Change |
|------|--------|
| `domain/staging/local_cache.py` | `write_entries()`: encrypt title/tags/comment/duration based on flags; `read_entries()`: dual-read `_enc` fallback; `_compute_entry_hash()`: uses canonical plaintext fields |
| `domain/staging/service.py` | `capture()`, `modify()`: accept and forward encryption flags |
| `domain/ledger/engine.py` | `_build_day_block()`: preserve `_enc` fields; `_update_index()`: skip encrypted-title entries |
| `domain/ledger/chain.py` | `_decrypt_entry_fields()`: add title_enc/tags_enc/comment_enc/duration_enc to decrypt set; `verify()`: entry hash verification handles canonical plaintext |
| `cli/cli_view.py` | `render_entry_line()`: `[encrypted]` display + reveal logic; `render_overview()`: respect encryption in sync preview |
| `cli/interface.py` | Encryption flag handling in command dispatch |
| `cli/strategies.py` | Pass encryption flags from commands to service layer |
| `cli/cli_parsers.py` | Parse encryption flags (⚠️ specific names TBD) |
| `security/crypto.py` | No changes needed — field-agnostic encrypt/decrypt already handles any string |
