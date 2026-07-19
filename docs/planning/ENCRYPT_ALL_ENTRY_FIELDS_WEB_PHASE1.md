# Encrypt All Entry Fields — Web (Phase 1)

> **Plan:** Test exploration / blueprint for web client (React + IndexedDB)
> **Purpose:** Blueprint of all needed test assertions for per-activity field encryption
> **Status:** ✅ Phase 2 (RED: test definition)
> **Next Phase:** Phase 3 (GREEN: implementation)

## Design Decisions (from discussion 2026-07-18)

| Decision | Choice |
|----------|--------|
| Encryptable fields | `title`, `tags`, `comment`, `duration` (all opt-in) |
| Default fields encrypted | `startTime_enc`, `endTime_enc`, `pauses_enc` (no change — these were already encrypted) |
| Structural fields | `is_active`, `is_paused` stay plaintext (staging-only, never committed) |
| Backward compat | Dual read: try `title_enc` first, fall back to `title`. No migration of committed entries (would break chain). |
| Default display | Encrypted entries show `[encrypted]` placeholder for protected fields. User must authenticate to reveal. |
| Reveal triggers | (1) Global toggle, (2) Per-activity click, (3) Per date-range (week/month/year) |
| Blind index | Skip encrypted entries entirely (titles unavailable for grouping) |
| Export | Ciphertext survives — chain blocks preserved as-is |
| Staging opt-in UX | "Encrypt entire activity" master checkbox + per-field checkboxes (title, tags, comment) at task creation and on sync-tab cards before commit |

## Architecture Overview

```
User creates task (NewTask.jsx / Dashboard.jsx)
  │
  ├─ [opt-in] encrypt_title: true     ──┐
  ├─ [opt-in] encrypt_tags: true      ──┤  Encryption flags travel with the entry
  ├─ [opt-in] encrypt_comment: true   ──┤  as part of the DTO / staging data
  ├─ [opt-in] encrypt_duration: true  ──┘
  │
  ▼
SyncService.capture() / updateEntryFlags()
  │
  ▼
local_cache.js write_entries()
  │  Encrypt fields marked for encryption:
  │    title   → title_enc   = encrypt(title, mk)
  │    tags    → tags_enc    = encrypt(JSON.stringify(tags), mk)
  │    comment → comment_enc = encrypt(comment, mk)
  │    duration→ duration_enc= encrypt(String(duration), mk)
  │  Non-encrypted fields keep plaintext names (backward compat)
  │
  ▼
Stored in IndexedDB staging
  │
  ▼
On commit: engine.py / entry_dto.js processes _enc fields
  │  (same existing pipeline — _enc suffix already handled)
  │
  ▼
Committed to ledger chain
```

**Read path:**
```
entry_dto.js rawCommittedEntryToDTO() / rawEntryToDTO()
  │
  ├─ Check title_enc → decrypt if present → fall back to title
  ├─ Check tags_enc  → decrypt → JSON.parse if present → fall back to tags
  ├─ Check comment_enc → decrypt if present → fall back to comment
  ├─ Check duration_enc → decrypt → parseInt if present → fall back to duration
  │
  ▼
Display layer (Dashboard.jsx, History.jsx, etc.)
  │
  ├─ If entry has any encrypted fields AND user not authenticated:
  │     Show "[encrypted]" for those fields
  │     Show non-sensitive fields normally (is_active, start/end times if decrypted)
  │
  ├─ If user authenticated or reveal triggered:
  │     Show decrypted values normally
  │
  ▼
```

## Test Groups

### Group A: Staging write path — ~12 tests
Encryption of fields at capture time in local_cache.js

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | `write_entries()` stores `title_enc` when encrypt_title=true | Verify title is encrypted in staging | Core write-path correctness |
| A2 | `write_entries()` stores `tags_enc` when encrypt_tags=true | Verify tags are encrypted in staging | JSON array must be serialized before encrypt |
| A3 | `write_entries()` stores `comment_enc` when encrypt_comment=true | Verify comment is encrypted in staging | Simple string field |
| A4 | `write_entries()` stores `duration_enc` when encrypt_duration=true | Verify duration is encrypted in staging | Integer → string conversion before encrypt |
| A5 | `write_entries()` stores plaintext `title` when encrypt_title=false | Backward compat — no encryption when not opted in | Existing entries must read correctly |
| A6 | `write_entries()` stores `title_enc` with hex ciphertext format | Ciphertext follows spec wire format (salt+nonce+ciphertext+tag) | Interop with CLI and spec compliance |
| A7 | `write_entries()` encrypts all 4 fields when "encrypt_all" is set | Master checkbox encrypts everything | Convenience UX |
| A8 | `write_entries()` does NOT encrypt `is_active` or `is_paused` | Structural fields stay plaintext regardless of flags | These are staging-only, never committed |
| A9 | Encrypted entry hash matches between `title_enc` and plaintext `title` for same content | Entry hash uses canonical plaintext values, not ciphertext | Hash must be stable regardless of encryption state |
| A10 | `write_entries()` with encrypt_title=true produces different ciphertext on each write | Random nonce ensures semantic security | No two encryptions of same title produce identical output |
| A11 | `write_entries()` handles empty title with encryption | Edge case: empty string encryption | Should not crash or corrupt |
| A12 | `write_entries()` handles null comment with encryption flag | Edge case: null value with encryption | Should skip or encrypt empty string |

### Group B: Staging read path — ~8 tests
Decryption and dual-read in local_cache.js read_entries()

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | `read_entries()` decrypts `title_enc` → `title` in DTO | Encrypted title is readable after auth | Read-path symmetry with write |
| B2 | `read_entries()` falls back to plaintext `title` when `title_enc` absent | Backward compat with existing entries | Entries created before this feature work |
| B3 | `read_entries()` decrypts `tags_enc` → JSON.parse → array | Tags round-trip correctly | JSON structure preserved |
| B4 | `read_entries()` decrypts `duration_enc` → parseInt → integer | Duration round-trips correctly | Integer type preserved |
| B5 | `read_entries()` returns null/empty for corrupt `title_enc` ciphertext | Graceful degradation on corruption | Don't crash on bad data |
| B6 | `read_entries()` handles partial encryption (e.g., only title encrypted, tags plaintext) | Mixed encryption state per entry | User may encrypt some fields but not others |
| B7 | `read_entries()` without crypto (no auth) returns entries with `_enc` fields still ciphertext | Read without decryption is possible | Supports unauthenticated staging view |
| B8 | `read_entries()` marks entries as `has_encrypted_fields: true` when any _enc field present | Display layer can identify encrypted entries | Enables `[encrypted]` placeholder behavior |

### Group C: Committed entry DTO — ~6 tests
Decryption in rawCommittedEntryToDTO() (entry_dto.js)

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | `rawCommittedEntryToDTO()` decrypts `title_enc` from committed entry | Committed entries with encrypted title are readable | Ledger chain read path |
| C2 | `rawCommittedEntryToDTO()` falls back to plaintext `title` | Backward compat with unencrypted committed entries | Vast majority of existing entries |
| C3 | `rawCommittedEntryToDTO()` decrypts `tags_enc` from committed entry | Encrypted tags in committed entries | Consistent with staging |
| C4 | `rawCommittedEntryToDTO()` decrypts `comment_enc` from committed entry | Encrypted comments in committed entries | Full field coverage |
| C5 | `rawCommittedEntryToDTO()` decrypts `duration_enc` from committed entry | Encrypted duration in committed entries | Integer via string conversion |
| C6 | `rawCommittedEntryToDTO()` returns null when decryption fails (corrupt ciphertext) | Don't crash on bad committed data | Robustness |

### Group D: Remote blob DTO — ~5 tests
Decryption in rawEntryToDTO() for remote staging blobs

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | `rawEntryToDTO()` decrypts `title_enc` from remote blob | Cross-device sync preserves encrypted title | Multi-device staging sharing |
| D2 | `rawEntryToDTO()` falls back to plaintext `title` | Remote blob may contain entries from pre-feature clients | Cross-version interop |
| D3 | `rawEntryToDTO()` decrypts all 4 encrypted fields from remote blob | Full cross-device round-trip | All fields survive sync |
| D4 | `rawEntryToDTO()` handles remote blob with no crypto (NoAuth) | Unauthenticated pull shows ciphertext in DTO | Graceful degradation |
| D5 | `rawEntryToDTO()` with decodeDataKeys handles tokenized + encrypted field names | I-02/I-02a field-name tokens + new encrypted content fields coexist | Combined encryption layers work |

### Group E: Display behavior — ~10 tests
Dashboard, History, and sync-tab rendering of encrypted entries

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | Dashboard shows `[encrypted]` for title when entry has title_enc and user not authenticated | Default privacy behavior | Core UX requirement |
| E2 | Dashboard shows decrypted title after authentication | Reveal-on-auth works | User can see their data |
| E3 | Dashboard shows normal title for entries without encryption | Mixed encrypted + plaintext entries coexist | Backward compat in UI |
| E4 | History screen shows `[encrypted]` for encrypted entries in list | Consistent display across screens | Same behavior everywhere |
| E5 | Sync-tab card shows `[encrypted]` for encrypted staging entries | Pre-commit preview respects privacy | User can verify what will be committed |
| E6 | Per-activity click on `[encrypted]` triggers re-auth → decrypts that entry | Per-activity reveal works | Fine-grained access |
| E7 | Global "Show encrypted" toggle reveals all encrypted entries | Global reveal works | Convenience for power users |
| E8 | Date-range reveal (e.g., "Show this week") decrypts entries in range | Per-range reveal works | Practical for sharing a week's data |
| E9 | `[encrypted]` entries in list still show duration and time range (if those are plaintext) | Non-encrypted fields remain visible | Activity exists but details hidden |
| E10 | Comment field shows `[encrypted]` or decrypted value based on auth state | Field-level granularity | Each field independently visible/hidden |

### Group F: Blind index — ~4 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| F1 | Index builder skips entries with `title_enc` (title unavailable) | Encrypted-title entries excluded from index | Can't group by unknown title |
| F2 | Index includes entries with plaintext `title` normally | Unencrypted entries still indexed | Backward compat |
| F3 | `ph rep` / reputation query does not include encrypted entries in totals | Encrypted entries invisible to reputation queries | Consistent with design decision |
| F4 | Rebuilding index after reveal does not add encrypted entries | Index rebuild respects encryption | Cannot accidentally leak via rebuild |

### Group G: Sync push/pull — ~6 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| G1 | Push obfuscated blob contains `title_enc` ciphertext for encrypted entries | Encrypted title survives push to remote | Remote staging stores encrypted data |
| G2 | Pull from remote returns `title_enc` ciphertext when no crypto available | Unauthenticated pull preserves encrypted state | Cross-device without auth |
| G3 | Pull with crypto decrypts `title_enc` → plaintext title in DTO | Authenticated pull reveals content | Normal flow |
| G4 | Cross-device roundtrip: Device A encrypts title → push → Device B pulls → decrypts with shared MK | Multi-device encryption works | Shared MK enables decryption |
| G5 | Push handles mixed plaintext + encrypted fields in same entry | Partial encryption survives sync | Fine-grained control |
| G6 | Merge engine handles encrypted fields from different devices | Staging merge with encrypted fields doesn't corrupt | Merge correctness |

### Group H: Export — ~3 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| H1 | Export includes `title_enc` as hex ciphertext in chain blocks | Ciphertext survives export | Export preserves ledger as-is |
| H2 | Export does not decrypt encrypted fields | No accidental plaintext leak in export file | Privacy-preserving export |
| H3 | Import of exported ledger with `title_enc` works (decrypts with correct MK) | Roundtrip through export works | Archive + restore |

### Group I: UI controls (opt-in) — ~7 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| I1 | NewTask form has "Encrypt activity details" master checkbox | Master encrypt-all control | Convenience UX |
| I2 | NewTask form has per-field checkboxes: encrypt title, encrypt tags, encrypt comment | Granular encryption control | User chooses what to hide |
| I3 | Master checkbox toggles all per-field checkboxes | Linked control behavior | Expected checkbox UX |
| I4 | Sync-tab entry cards show per-field encryption toggles before commit | Last chance to encrypt/decrypt before commit | Pre-commit control |
| I5 | Toggling encryption on sync-tab card re-encrypts/decrypts immediately (with cached MK) | Real-time toggle | Instant feedback |
| I6 | Encryption flags persist through page navigation (IndexedDB) | State survives tab changes | Data consistency |
| I7 | Encryption flag on NewTask form resets on successful submission | Clean state for next task | Expected form behavior |

## Summary

| Group | Area | Tests |
|-------|------|-------|
| A | Staging write path | 12 |
| B | Staging read path | 8 |
| C | Committed entry DTO | 6 |
| D | Remote blob DTO | 5 |
| E | Display behavior | 10 |
| F | Blind index | 4 |
| G | Sync push/pull | 6 |
| H | Export | 3 |
| I | UI controls | 7 |
| **Total** | | **61** |

## Key Implementation Files (expected changes)

| File | Change |
|------|--------|
| `phpoc-web/src/sync/local_cache.js` | `write_entries()`: encrypt title/tags/comment/duration based on flags; `read_entries()`: dual-read `_enc` fallback |
| `phpoc-web/src/sync/entry_dto.js` | `rawCommittedEntryToDTO()`: decrypt title_enc/tags_enc/comment_enc/duration_enc; `rawEntryToDTO()`: dual-read for remote blobs |
| `phpoc-web/src/sync/sync.js` | `capture()`: accept encryption flags; commit path: pass flags through |
| `phpoc-web/src/components/screens/NewTask.jsx` | Add encryption checkboxes (master + per-field) |
| `phpoc-web/src/components/screens/Dashboard.jsx` | Add encryption checkboxes to task creation form; `[encrypted]` display logic |
| `phpoc-web/src/components/screens/History.jsx` | `[encrypted]` display logic; reveal controls |
| `phpoc-web/src/components/screens/SyncSettings.jsx` | Sync-tab cards: encryption toggles + `[encrypted]` display |
| `phpoc-web/src/ledger/index_manager.js` | Skip encrypted-title entries in index build |
| `phpoc-web/src/context/DevModeContext.jsx` | Re-auth flow for reveal; global encrypted-visibility state |
