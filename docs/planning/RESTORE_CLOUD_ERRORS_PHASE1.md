# Restore from Cloud — Error Surfacing (Phase 1)
> **Plan:** Fix credential error opacity in `restoreFromCloud` flow
> **Purpose:** Blueprint of all needed test assertions before writing any test code.
> **Status:** ✅ Phase 1-4 complete (2026-07-28)
> **Phase 2:** 10 tests RED → 10 tests GREEN (Groups I/J/K)
> **Phase 3:** Implementation verified — all 79 tests GREEN
> **Phase 4:** Unused import removed; no other refactors needed

## Problem
`restoreFromCloud()` swallows all connection/credential errors via empty `catch (_)` blocks. Wrong seed (valid format), wrong Worker URL, or wrong API key all produce a blank interface with zero blocks and no error message.

## Architecture
Two changes:
1. **`onboarding_service.dart::restoreFromCloud`** — change return type from `Future<void>` to `Future<PullResult>`. Return the actual `PullResult` (including detailed errors) instead of swallowing it.
2. **`onboarding_screen.dart::_restoreFromCloud`** — check `result.success` after restore. If false, display the first error from `result.errors` as red text.

## Test Groups

### Group I: restoreFromCloud returns PullResult with errors — ~5 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| I1 | `restoreFromCloud` returns `PullResult` (not void) | Contract change verified | Ensures return type change is test-covered |
| I2 | Valid credentials → `PullResult.success=true` with blocksPulled > 0 | Happy path regression | Existing behavior must continue to work |
| I3 | Wrong Worker URL (unreachable) → `PullResult.success=false`, errors non-empty | Credential error surfacing | Ensures connection failures are surfaced, not swallowed |
| I4 | All blocks fail deobfuscation → `PullResult.success=false`, errors list contains "deobfuscate" | Key mismatch surfacing | Ensures wrong-seed errors reach the caller |
| I5 | `connectWorker` throws → pull still attempted or PullResult returned with error | Graceful degradation | Ensures partial failures don't crash |

### Group J: UI displays restore errors — ~3 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| J1 | `_restoreFromCloud` sets `_errorMessage` when `PullResult.success=false` | Error visible in UI | Primary UX fix — user sees what went wrong |
| J2 | `_restoreFromCloud` navigates to Auth when `PullResult.success=true` | Happy path unchanged | Regression guard |
| J3 | Loading spinner stops regardless of success/failure | UI responsiveness | Ensures spinner doesn't hang on error |

### Group K: Validation errors still throw (unchanged) — ~2 tests
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| K1 | Invalid seed format → throws `FormatException` (not returns error PullResult) | Pre-condition validation unchanged | Existing contract preserved for format errors |
| K2 | Short passphrase → throws `FormatException` (not returns error PullResult) | Pre-condition validation unchanged | Existing contract preserved |

**Total: 10 assertions across 3 groups.**
