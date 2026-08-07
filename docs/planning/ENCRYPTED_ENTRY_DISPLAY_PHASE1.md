# Encrypted Entry Display — Test Exploration (Phase 1)

> **Plan:** User request — show [Encrypted] for locked entries with passphrase reveal
> **Purpose:** Blueprint of all needed test assertions before writing any test code.
> **Status:** 🔜 Phase 1 (test exploration)
> **Next Phase:** Phase 2 (RED: test definition)

## Architecture Overview

Entry data flows: **Block (encrypted) → _seedStagingFromBlocks → staging table → _stagingRowToDto → UI cards**

Currently `_seedStagingFromBlocks` decrypts all fields (title, tags, comment) before storing in staging. The change: **keep title_enc/tags_enc/comment_enc in staging**, flag `is_sensitive_encrypted=true`, decrypt on-demand in UI after passphrase auth.

### Modules affected:
- **`ledger_pull_service.dart`** — `_seedStagingFromBlocks`: stop decrypting, preserve encrypted fields
- **`sync_service.dart`** — `_stagingRowToDto`: add encrypted fields + flag to DTO
- **Dashboard** — `_buildActiveTaskCard`, `_buildUncommittedCard`: encrypted card UI
- **History** — `_buildEntryTile`: encrypted card UI
- **New widget** — `PassphraseAuthDialog`: passphrase input + validation via AuthService
- **`auth_service.dart`** — already has `reauthenticate(passphrase)` (used by unlock screen)

## Test Groups

### Group A: DTO Conversion — ~8 tests
`_stagingRowToDto` must preserve encrypted fields and flag entries correctly.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | `_stagingRowToDto` sets `is_sensitive_encrypted=true` when `activity` blob has `title_enc` | Detects encrypted entries | Primary flag that drives UI encrypted mode |
| A2 | `_stagingRowToDto` sets `is_sensitive_encrypted=true` when `activity` blob has `tags_enc` | Tags alone triggers encryption mode | Any encrypted field means the entry is sensitive |
| A3 | `_stagingRowToDto` sets `is_sensitive_encrypted=true` when `activity` blob has `comment_enc` | Comment alone triggers encryption mode | Same rationale as A2 |
| A4 | `_stagingRowToDto` sets `is_sensitive_encrypted=false` when all fields are plaintext | No false positives | Legacy entries without encryption must not be locked |
| A5 | `_stagingRowToDto` preserves `title_enc` hex value in DTO when present | Encrypted title available for on-demand decrypt | UI needs the ciphertext to decrypt after auth |
| A6 | `_stagingRowToDto` preserves `tags_enc` hex value in DTO when present | Encrypted tags available for on-demand decrypt | Same as A5 |
| A7 | `_stagingRowToDto` preserves `comment_enc` hex value in DTO when present | Encrypted comment available for on-demand decrypt | Same as A5 |
| A8 | `_stagingRowToDto` sets `title` to `[Encrypted]` when `is_sensitive_encrypted=true` and no plaintext title | UI default display | Card header must show "[Encrypted]" not empty string |

### Group B: Staging Seed (blocks → staging) — ~6 tests
`_seedStagingFromBlocks` must preserve encrypted fields.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | `_seedStagingFromBlocks` stores `title_enc` in activity blob when block entry has `title_enc` | Preserve ciphertext | Only hashed-out data in transit/staging |
| B2 | `_seedStagingFromBlocks` stores `tags_enc` in activity blob when block entry has `tags_enc` | Preserve ciphertext | Same as B1 |
| B3 | `_seedStagingFromBlocks` stores `comment_enc` in activity blob when block entry has `comment_enc` | Preserve ciphertext | Same as B1 |
| B4 | `_seedStagingFromBlocks` still decrypts `startTime_enc` and `endTime_enc` | Times always visible | Start/stop times are never encrypted for display |
| B5 | `_seedStagingFromBlocks` still stores decrypted `start_epoch`/`end_epoch` in activity blob | Times in plaintext | UI needs plaintext epochs for formatting |
| B6 | `_seedStagingFromBlocks` sets `committed=true` in staging row | Completed entries marked | Matches existing committed-flag behavior |

### Group C: PassphraseAuthDialog Widget — ~10 tests
New dialog widget for on-demand decryption authentication.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | Dialog renders passphrase field and Authenticate/Cancel buttons | UI contract | User must be able to enter passphrase or cancel |
| C2 | Tapping Cancel calls `onCancel` callback | Cancel flow | User can dismiss without authenticating |
| C3 | Tapping Authenticate with valid passphrase calls `onAuthenticated` with derived MK | Success flow | Caller gets the MK to decrypt |
| C4 | Tapping Authenticate with wrong passphrase shows error message | Error feedback | User knows why authentication failed |
| C5 | Wrong passphrase does NOT call `onAuthenticated` | Security | Only correct passphrase unlocks |
| C6 | Dialog shows loading indicator during authentication | UX feedback | Auth may take time (PDK derivation) |
| C7 | Dialog disables Authenticate button while loading | Prevent double-submit | Avoid race conditions |
| C8 | Dialog validates against genesis block via AuthService.reauthenticate | Correct auth target | Must use same auth as unlock screen |
| C9 | Passphrase field is obscured by default | Privacy | Passphrase must not be visible to shoulder-surfers |
| C10 | Dialog has visibility toggle for passphrase field | UX | User can verify they typed correctly |

### Group D: Encrypted Card UI — Dashboard — ~8 tests
Dashboard active-task and uncommitted cards in encrypted mode.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | Encrypted active card shows `[Encrypted]` as title when `is_sensitive_encrypted=true` | Visual indicator | User knows this entry is locked |
| D2 | Encrypted active card shows start time / elapsed time normally | Times always visible | Per design requirement |
| D3 | Encrypted uncommitted card shows `[Encrypted]` as title | Visual indicator | Same as D1 for uncommitted |
| D4 | Tapping `[Encrypted]` header opens PassphraseAuthDialog | Interaction trigger | User initiates decryption |
| D5 | After successful auth, card reveals plaintext title | Decryption success | User sees the real content |
| D6 | After successful auth, card reveals tags (if any) | Full reveal | All sensitive fields become visible |
| D7 | After successful auth, card reveals comment (if any) | Full reveal | Same as D6 |
| D8 | Revealed card shows "Hide" button that re-hides all sensitive fields | Re-encryption UI | User can return to locked state |

### Group E: Encrypted Card UI — History — ~6 tests
History entry tiles in encrypted mode.

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | Encrypted history tile shows `[Encrypted]` as title | Visual indicator | Same behavior as dashboard |
| E2 | Encrypted history tile shows date/time normally | Times always visible | Per design requirement |
| E3 | Tapping encrypted history tile opens PassphraseAuthDialog | Interaction trigger | Same flow as dashboard |
| E4 | After successful auth, tile reveals plaintext title, tags, comment | Full reveal | Consistent with dashboard behavior |
| E5 | Revealed history tile shows "Hide" button | Re-encryption UI | Consistent with dashboard |
| E6 | Hide button returns tile to `[Encrypted]` state | State reset | Full round-trip works |

## Summary

| Group | Area | Assertions |
|-------|------|-----------|
| A | DTO conversion (`_stagingRowToDto`) | 8 |
| B | Staging seed (`_seedStagingFromBlocks`) | 6 |
| C | PassphraseAuthDialog widget | 10 |
| D | Dashboard encrypted cards | 8 |
| E | History encrypted tiles | 6 |
| **Total** | | **38** |

### Key Coverage Areas
- Data integrity: encrypted fields preserved through staging pipeline (A, B)
- Security: passphrase auth matches genesis block validation (C)
- UI consistency: dashboard and history behave identically for encrypted cards (D, E)
- Start/stop times always visible regardless of encryption state (B4–B5, D2, E2)
- Round-trip: encrypt → reveal → hide (D8, E5–E6)
- Edge cases: wrong passphrase (C4–C5), loading state (C6–C7), no false positives (A4)
