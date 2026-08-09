# Verify/Restore Fix (Plan B) — Test Exploration (Phase 1)

> **Plan:** `docs/planning/VERIFY_RESTORE_FIX_PLAN_B.md`
> **Purpose:** Blueprint of all needed test assertions before writing any test code.
> **Status:** 🔜 Phase 1 (test exploration)
> **Next Phase:** Phase 2 (RED: test definition)

## Architecture Overview

Approach B fixes `LedgerChain.verify()` returning false after cloud restore by making
verification tolerant of multiple JSON serialization formats and separating seed storage
from the genesis block. Three root causes are addressed:

| RC | Fix | Files |
|----|-----|-------|
| RC1 | `_verifyBlockSeal` uses `verifySeal()` with 3-way fallback instead of direct comparison | `chain.dart` |
| RC2 | `_buildAndPersistGenesis` no longer SQL-updates block 1's prev_hash (R2 genesis preserved) | `onboarding_service.dart` |
| RC3 | `_validateImportedChain` validates-only, throws on failure (no auto-heal mutations) | `ledger_pull_service.dart` |

Seed storage moves from genesis `data_enc` into `_phpoc_meta` vault (`database.dart`),
with genesis fallback for backward compatibility (`auth_service.dart`).

## Test Groups

### Group A: `_verifyBlockSeal` — 3-way seal verification — 9 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | Genesis block sealed with `jsonSort` (Flutter canonical) → `_verifyBlockSeal` returns true | RC1 fix: Flutter-created genesis verified correctly | `jsonSort` is the canonical Flutter format; must verify |
| A2 | Genesis block sealed with Python `sort_keys` format (indent2) → `_verifyBlockSeal` returns true | RC1 fix: CLI-created genesis verified correctly | Python `json.dumps(sort_keys=True, indent=2)` creates this format |
| A3 | Genesis block sealed with JS no-space compact format → `_verifyBlockSeal` returns true | RC1 fix: Web-created genesis verified correctly | Web/JS `JSON.stringify` with sorted keys produces no extra spaces |
| A4 | Day block sealed with `jsonSort` → `_verifyBlockSeal` returns true | Day block seal parity with genesis | Same 3-way fallback applies to all block types |
| A5 | Day block sealed with Python indent2 format → `_verifyBlockSeal` returns true | Cross-client day block verification | Day blocks created by CLI must verify on Flutter |
| A6 | Day block sealed with JS no-space format → `_verifyBlockSeal` returns true | Cross-client day block verification | Day blocks created by Web must verify on Flutter |
| A7 | Block with intentionally wrong seal → `_verifyBlockSeal` returns false | Tamper detection works | Wrong seal must fail — the fallback must not produce false positives |
| A8 | Block with empty/null hash key → `_verifyBlockSeal` returns false | Edge case: missing seal field | Empty/null seal is invalid regardless of serialization |
| A9 | Block with missing `type` field → `_verifyBlockSeal` returns false | Edge case: malformed block | Type determines hash key name; missing type is unresolvable |

### Group B: Seed vault — database helpers — 4 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1 | `setSeedVault(encSeed)` stores key `recovery_seed_enc` in `_phpoc_meta` | Vault write: new seed storage path | Core mechanism for separating seed from chain |
| B2 | `getSeedVault()` returns null when no seed stored | Vault read: empty state | Null return triggers genesis fallback in AuthService |
| B3 | `getSeedVault()` returns previously stored encrypted seed | Vault read: normal path | Round-trip integrity |
| B4 | `setSeedVault` called twice → second call overwrites first (INSERT OR REPLACE) | Vault write: idempotent overwrite | `changePassphrase` calls `setSeedVault` for the new encryption |

### Group C: `_storeSeedInVault` + `_postImportSetup` — 4 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | `restoreFromCloud` → `_postImportSetup(keepExistingGenesis: true)` stores seed in vault only, R2 genesis block remains untouched | RC2 fix: genesis not replaced on cloud restore | Preserves R2 genesis hash so block 1 linkage doesn't break |
| C2 | `createNewLedger` → `_postImportSetup(keepExistingGenesis: false)` builds genesis AND stores seed in vault | Local creation: both genesis + vault populated | New chains get both storage paths for uniform access |
| C3 | Genesis seal computed with `jsonSort` (not `json.encode`) → verifiable by all clients | RC1 fix for local chains | `json.encode` produces unsorted output that differs from canonical |
| C4 | `_buildAndPersistGenesis` does NOT SQL-update block 1 prev_hash when genesis already exists from R2 | RC2 fix: no mutation of imported blocks | Removing the UPDATE preserves chain integrity after restore |

### Group D: `_readEncryptedSeed` — vault + genesis fallback — 4 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | Reads from vault when `_phpoc_meta` has `recovery_seed_enc` | Post-fix path: vault is primary source | All new chains use vault; must be read first |
| D2 | Falls back to genesis `data_enc` when vault is empty | Pre-fix backward compat: genesis fallback | Chains created before this fix still have seed in genesis |
| D3 | Returns null when neither vault nor genesis has seed | Edge case: no seed anywhere | Clean null — caller handles (e.g., new ledger with seed provided directly to `unlock()`) |
| D4 | Vault seed takes priority when both vault and genesis have seed values | Conflict resolution: vault wins over genesis | Vault is the authoritative source post-fix |

### Group E: `_decryptSeed` — simplified decryption — 4 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | Decrypts an encrypted seed string directly (takes encrypted seed, not genesis block) | Refactored API: simpler, single-responsibility | Separation from genesis allows seed from either vault or genesis |
| E2 | Throws `AuthException` when PDK is wrong (decryption fails) | Security: wrong passphrase detected | `CryptoService.decrypt` throws on auth tag mismatch |
| E3 | Validates decrypted seed length is 32 bytes | Integrity: seed format check | Wrong-length seed indicates corruption or wrong key |
| E4 | Returns decrypted seed as base64 string | Correct return type for downstream use | `deriveMasterKey` expects base64 seed input |

### Group F: `unlock()` — read from vault — 5 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| F1 | `unlock()` with post-fix chain reads seed from vault, not genesis | Primary path: vault-based unlock | Verifies the new code path without genesis dependency |
| F2 | `unlock()` with pre-fix chain (vault empty, seed in genesis) still works | Backward compat: genesis fallback | Existing chains must continue to unlock |
| F3 | `unlock()` succeeds when vault has seed and passphrase is correct | Happy path: vault unlock | Core correctness assertion |
| F4 | `unlock()` throws `AuthException` when passphrase is wrong (vault path) | Security: wrong passphrase rejected | Decryption of vault seed fails with wrong PDK |
| F5 | `unlock()` with no genesis and no vault (fresh seed provided directly) succeeds | New ledger scenario: seed passed in, no DB state | `unlock(passphrase, seedB64)` should work even with empty DB |

### Group G: `reauthenticate()` — read from vault — 4 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| G1 | `reauthenticate()` reads seed from vault (post-fix) | App restart: vault is primary source | Most common re-auth scenario after fix |
| G2 | `reauthenticate()` falls back to genesis when vault empty (pre-fix) | Backward compat: genesis fallback | Existing chains before fix still re-authenticate |
| G3 | `reauthenticate()` throws `AuthException` when no seed found anywhere | Error: no seed available | Neither vault nor genesis has seed — can't derive MK |
| G4 | `reauthenticate()` throws `AuthException` when passphrase is wrong | Security: wrong passphrase rejected | PDK derivation + decryption fails with wrong passphrase |

### Group H: `exportSeed()` — read from vault — 3 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| H1 | `exportSeed()` returns correct seed from vault | Seed backup: vault path | User can back up their recovery seed |
| H2 | `exportSeed()` falls back to genesis when vault empty | Backward compat: genesis fallback | Pre-fix chains still exportable |
| H3 | `exportSeed()` throws `AuthException` when no seed found anywhere | Error: no seed to export | Clear error instead of null/silent failure |

### Group I: `changePassphrase()` — write to vault — 5 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| I1 | `changePassphrase()` writes new encrypted seed to vault | Core behavior: vault is updated | New PDK encryption stored in vault |
| I2 | After `changePassphrase()`, old passphrase no longer decrypts vault seed | Security: old credentials invalidated | Decryption with old PDK must fail |
| I3 | After `changePassphrase()`, new passphrase unlocks successfully | Security: new credentials work | New PDK correctly decrypts vault seed |
| I4 | `changePassphrase()` does not alter genesis block (post-fix chain) | Immutability: chain untouched | Genesis block hashes are preserved |
| I5 | `changePassphrase()` updates genesis `data_enc` for pre-fix chains (backward compat) | Legacy support: genesis still updated when it's the only seed store | Pre-fix chains have seed only in genesis; must update there |

### Group J: `_validateImportedChain` — validate-only, no mutations — 9 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| J1 | Valid chain with correct entry hashes passes validation (no throw) | Happy path: clean import | Core correctness — good data imports cleanly |
| J2 | Entry hash mismatch throws `FormatException` (no auto-heal) | RC3 fix: bad data is rejected, not silently fixed | Silent auto-heal masks bugs and produces unverifiable chains |
| J3 | Prev_hash linkage break throws `FormatException` (no auto-heal) | RC3 fix: linkage errors are rejected | Auto-healing prev_hash breaks cross-client hash consistency |
| J4 | Genesis block missing `type` field throws `FormatException` | Validation: malformed genesis detected | Missing type is an import error |
| J5 | Entry that is not a Map throws `FormatException` | Validation: malformed entry detected | Non-Map entries are corrupt data |
| J6 | Entry missing `hash` field throws `FormatException` | Validation: incomplete entry detected | Hash is required for verification |
| J7 | Valid chain with `jsonSort`-formatted entries passes | Cross-client: Flutter-format entries accepted | Flutter-created chain data imported correctly |
| J8 | Valid chain with Python-serialized entries passes | Cross-client: CLI-format entries accepted | CLI-created chain data imported correctly |
| J9 | Valid chain with JS no-space entries passes | Cross-client: Web-format entries accepted | Web-created chain data imported correctly |

### Group K: `verify()` end-to-end — 6 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| K1 | Locally-created chain (genesis only) → `verify()` returns true | Baseline: empty chain verifies | Simplest case must work |
| K2 | Locally-created chain with day blocks → `verify()` returns true | Baseline: populated chain verifies | Ensures day block path works after changes |
| K3 | After cloud restore (CLI-created blocks) → `verify()` returns true | RC1–3: CLI cross-client parity | This is the primary bug fix — must verify CLI blocks |
| K4 | After cloud restore (Web-created blocks) → `verify()` returns true | RC1–3: Web cross-client parity | Must verify Web blocks with no-space JSON format |
| K5 | Chain with tampered seal → `verify()` returns false | Tamper detection preserved | Fallback seal verification must not weaken tamper detection |
| K6 | Chain with broken prev_hash linkage → `verify()` returns false | Linkage detection preserved | Chain integrity checks still work |

### Group L: End-to-end flows — 8 tests

| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| L1 | `createNewLedger` → genesis + vault both populated → `verify()` passes | Full flow: local creation | Verifies both storage paths work for new chains |
| L2 | `importFromSeed` → genesis + vault both populated → `verify()` passes | Full flow: seed import | Seed import should use same post-import setup |
| L3 | `importFromFile` → genesis + vault both populated → `verify()` passes | Full flow: file import | File import should use same post-import setup |
| L4 | `restoreFromCloud` → R2 genesis preserved, vault populated → `verify()` passes | Full flow: cloud restore (the bug) | This is the reproduction test for the original bug |
| L5 | `unlock()` after `createNewLedger` → reads from vault → succeeds | Auth flow: local chain unlock | AuthService vault path works end-to-end |
| L6 | `unlock()` after `restoreFromCloud` → reads from vault → succeeds | Auth flow: cloud restore unlock | AuthService vault path works after restore |
| L7 | `changePassphrase()` after `createNewLedger` → updates vault → old fails, new succeeds | Auth flow: passphrase change | Full passphrase rotation works |
| L8 | `exportSeed()` after `createNewLedger` → returns seed from vault | Auth flow: seed export | Seed exportability preserved |

## Summary

| Group | Area | Tests |
|-------|------|-------|
| A | `_verifyBlockSeal` — 3-way seal verification | 9 |
| B | Seed vault — database helpers | 4 |
| C | `_storeSeedInVault` + `_postImportSetup` | 4 |
| D | `_readEncryptedSeed` — vault + genesis fallback | 4 |
| E | `_decryptSeed` — simplified decryption | 4 |
| F | `unlock()` — read from vault | 5 |
| G | `reauthenticate()` — read from vault | 4 |
| H | `exportSeed()` — read from vault | 3 |
| I | `changePassphrase()` — write to vault | 5 |
| J | `_validateImportedChain` — validate-only | 9 |
| K | `verify()` end-to-end | 6 |
| L | End-to-end flows | 8 |
| **Total** | | **65** |

Key coverage areas: seal serialization tolerance (A, J7–J9), seed vault CRUD (B), cloud restore immutability (C1, C4), backward compat (D2, F2, G2, H2, I5), tamper detection (A7, K5), chain integrity (J2–J6, K6), and full auth lifecycles (F–I, L5–L8).
