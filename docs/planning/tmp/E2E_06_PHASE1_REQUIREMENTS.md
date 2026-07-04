# E2E-06 Phase 1 — Exploratory: Test Assertions & Rationale

> **Bug:** `exportLedgerAction` in `DevModeContext.jsx` reuses cached master key
> to skip passphrase validation after login. Any passphrase — including garbage —
> produces a valid export.
>
> **Root cause:** Both fast path (Settings, L1095) and slow path (Onboarding, L1123)
> check `getMasterKey()` first. If non-null, authentication is completely skipped.
>
> **Status:** ✅ Phase 1 complete (2026-07-04) — 28 planned assertions across 5 test groups.
>        ✅ Phase 2 complete (2026-07-04) — RED test file written, 39 assertions fail as expected.
>        ✅ Phase 3 complete (2026-07-04) — GREEN: `export_auth.js` created, `DevModeContext.jsx` wired, 40/40 pass, 0 regressions.
>        ✅ Phase 4 complete (2026-07-04) — VERIFY: Genesis seal verification for passphrase validation, PBKDF2 gap closed. 40/40 tests, 0 regressions.
>
> **Test file:** `phpoc-web/test/export_passphrase_validation_test.mjs` (GREEN phase, 40 assertions passing)
> **New module:** `phpoc-web/src/services/export_auth.js` — `exportWithAuth()` always calls `authenticate()`
> **Coverage target:** `DevModeContext.jsx` `exportLedgerAction` (~L1089–1141)

---

## Group A — Cached Master Key Bypass (Fast Path, 7 assertions)

**Rationale:** The fast path is the Settings → Export flow where services are already
loaded. This is the primary attack vector: the user is logged in, master key is cached,
and `getMasterKey()` returns non-null. The code currently skips authentication entirely
because `if (!masterKey)` is false.

| # | Assertion | Rationale |
|---|-----------|-----------|
| A1 | `exportLedgerAction('WrongPass') throws` when master key is cached | Direct reproduction of the bug. Confirms wrong passphrase is rejected even when MK is cached. |
| A2 | Error message includes "passphrase" or "auth" keyword | UX requirement: users must know passphrase was the problem, not a general error. |
| A3 | `exportLedgerAction(correctPassphrase)` succeeds when MK is cached | Regression protection: correct passphrase still works after the fix. |
| A4 | `authenticate()` is called even when `getMasterKey()` returns non-null | Core behavioral change: sensitive ops must always re-derive. The fix must call `authenticate(passphrase, seed)` unconditionally, ignoring cached MK. |
| A5 | Export with correct passphrase produces valid, seal-verifiable blob | Integrity check: the exported data is self-consistent and the seal matches. |
| A6 | Empty/whitespace passphrase is rejected, even with cached MK | Edge case: empty input should not be treated as a valid passphrase. |
| A7 | Export with wrong passphrase does NOT produce a downloadable blob | Security requirement: no export should be generated from invalid auth. |

---

## Group B — Cold-Start Auth (Slow Path, 4 assertions)

**Rationale:** The slow path is the Onboarding → Export flow where services are loaded
on demand. Even though no MK is cached yet, we must verify the fix doesn't break
cold-start auth and that authentication is always required.

| # | Assertion | Rationale |
|---|-----------|-----------|
| B1 | `exportLedgerAction('WrongPass')` throws in cold-start (no cached MK) | Existing behavior preserved: cold-start wrong passphrase is rejected. |
| B2 | `exportLedgerAction(correctPassphrase)` succeeds in cold-start | Existing behavior preserved: cold-start correct passphrase works. |
| B3 | `getMasterKey()` is null before cold-start export | Precondition verification: confirms the test is truly cold-start. |
| B4 | `getMasterKey()` is non-null after successful cold-start export | MK should be cached after successful auth for subsequent operations. |

---

## Group C — Master Key Cache Safety (5 assertions)

**Rationale:** The fix must be surgical — require re-authentication for export without
corrupting the master key cache for normal operations. A wrong export passphrase must
not poison the cached MK for other operations.

| # | Assertion | Rationale |
|---|-----------|-----------|
| C1 | Cached master key is NOT overwritten after failed export passphrase | Security: a wrong passphrase should not replace the valid cached MK with derived garbage. The fix should derive a temporary MK for verification only. |
| C2 | `getMasterKey()` returns the SAME value after failed export as before | Concrete check: MK cache is immutable after auth failure. |
| C3 | Cached master key is preserved after successful export | Regression: successful export should not clear or change the cached MK. |
| C4 | Subsequent non-export operations still use the cached MK normally | Integration: the rest of the app isn't broken by the fix (e.g., sync still works). |
| C5 | Repeated exports with correct passphrase produce identical seals | Determinism: same passphrase + same data = same seal. |

---

## Group D — Error Messaging & UX Flow (5 assertions)

**Rationale:** The fix changes the user-facing behavior. Users who type the wrong
passphrase during export should see a clear error, be able to retry, and not lose
their current session.

| # | Assertion | Rationale |
|---|-----------|-----------|
| D1 | Error message is human-readable, not a stack trace | UX requirement: "Incorrect passphrase" or similar, not raw crypto error. |
| D2 | Settings modal stays open after auth failure (export is not cancelled) | UX: user can retry without re-opening the dialog. |
| D3 | Passphrase input is cleared or error-highlighted after failure | UX: indicates what field needs correction. |
| D4 | Successful retry after initial wrong passphrase works | Self-healing: correct passphrase on second try produces valid export. |
| D5 | Export with both wrong passphrase AND no seed stored shows priority error | Edge ordering: "No recovery seed" is a precondition error, distinct from passphrase error. |

---

## Group E — Integration & Regression (7 assertions)

**Rationale:** Ensure the fix doesn't break the broader export ecosystem — the
export service itself (`ledger_export.js`), Settings component wiring, or
interactions with other DevModeContext features.

| # | Assertion | Rationale |
|---|-----------|-----------|
| E1 | Export with no entries and no blocks → "No data to export" error | Existing behavior preserved: empty ledger error is separate from auth failure. |
| E2 | `exportLedgerFull()` is called with the correct derived master key | Ensure the authenticated key (not the cached key) flows to the export service. |
| E3 | Export return value includes valid v2 format JSON | End-to-end: the result is usable for import later. |
| E4 | `triggerDownload()` is called with a `.json` filename | The blob is actually downloaded, not just generated. |
| E5 | The `STORED_SEED_KEY` is read from storage (not hardcoded) | The fix must come from the same seed source as login, not a mock. |
| E6 | Cached MK is NOT used as a shortcut when `authenticate()` throws | If auth fails, the export must fail — no fallback to cached key. |
| E7 | All existing export tests still pass (0 regressions) | The existing `ledger_export_full_test.mjs` and `ledger_export_test.mjs` suites continue to pass. |

---

## Test Infrastructure Design

**Test file:** `phpoc-web/test/export_passphrase_validation_test.mjs`
**Helpers:** Uses project-standard `TestHelpers` from `test_helpers.mjs`.
**Mock strategy:** 
- Mock crypto service with real `authenticate()` behavior (passphrase+seed → deterministic MK via PBKDF2 or simple hash)
- Mock storage with predefined seed
- Mock sync service with predefined entries/blocks
- Mock `triggerDownload` to capture calls
- Real `exportLedgerFull` from `ledger_export.js`

**Why not E2E browser tests for this?** The C2 limitation (React synthetic events for
file inputs via programmatic fill — see E2E-03) makes full E2E testing via
agent_browser unreliable for certain operations. The core logic — `exportLedgerAction`
in `DevModeContext.jsx` — is unit-testable. A separate browser E2E pass can verify
the Settings modal behavior without the file-upload bottleneck.

**Why unit test `DevModeContext.jsx` directly?** The bug is in `exportLedgerAction`
at L1089–1141, not in the export service itself. `ledger_export.js` tests already
validate the export format and seal integrity. The gap is the passphrase validation
step in the context layer.

---

## Fix Strategy (Phase 3 — GREEN ✅)

Implemented `phpoc-web/src/services/export_auth.js` with `exportWithAuth()` function.
Wired into `DevModeContext.jsx` `exportLedgerAction` (both fast and slow paths).

Core changes:
1. `exportWithAuth()` always reads seed from storage, always calls `authenticate()`
2. Never touches `getMasterKey()` — no cached MK bypass
3. Does NOT call `setMasterKey()` — temp auth, no cache pollution
4. Returns `{ blob, authMasterKey, filename }` — caller triggers download
5. Both fast path (Settings) and slow path (Onboarding) use `exportWithAuth()`

**PBKDF2 nuance for Phase 4:** The WASM `authenticate()` is key derivation, not
validation. Wrong passphrase → different key → different seal (no error thrown).
Phase 4 should add seal-verify-against-known-data for UX error messages.

---

## Files Touched by Phase 1

| File | Role |
|------|------|
| `docs/planning/tmp/E2E_06_PHASE1_REQUIREMENTS.md` | This document — assertions and rationale |
| `phpoc-web/test/export_passphrase_validation_test.mjs` | (Phase 2) RED test file — 28 failing tests |
| `phpoc-web/src/context/DevModeContext.jsx` L1089–1141 | (Phase 3) GREEN implementation — fix both paths |
| `SESSION_HANDOFF.md` | Updated to mark Phase 1 complete |

---

## Phase Progression

| Phase | Deliverable | Status |
|-------|-------------|--------|
| **Phase 1 — Exploratory** | This document: assertions + rationale | ✅ Complete |
| **Phase 2 — RED** | `export_passphrase_validation_test.mjs` with 39 failing assertions | ✅ Complete |
| **Phase 3 — GREEN** | Implement `export_auth.js` + wire into `DevModeContext.jsx` → 40 passing | ✅ Complete (2026-07-04) |
| **Phase 4 — Verify** | Genesis seal verification, PBKDF2 gap closed, browser E2E, cleanup | ✅ Complete (2026-07-04) |

---

## Phase 4 Implementation Details

### Genesis Seal Verification

PBKDF2 always derives a key from any passphrase+seed combination — it's key derivation,
not passphrase validation. A wrong passphrase produces a different key, which produces a
different seal on the export file, but no error is thrown by the crypto layer.

**Solution:** Verify the derived key against the genesis block's seal (`day_hash`) before
proceeding with export. If seal verification fails, the passphrase is incorrect.

**Implementation in `export_auth.js`:**

```
exportWithAuth(opts)
  ├── 1. Read recovery seed from IndexedDB
  ├── 2. crypto.authenticate(passphrase, seed, 600000) → derived key
  ├── 3. _findGenesisBlock(blocks) → genesis block
  ├── 4. _verifyGenesisSeal(crypto, genesis, derivedKey)
  │       ├── Rebuild genesis JSON (exclude day_hash, signature)
  │       ├── jsonSort for canonical form
  │       └── crypto.verifySeal(canonical, genesis.day_hash, derivedKey)
  │           → fail → throw "Incorrect passphrase."
  ├── 5. exportLedgerFull(blocks, entries, crypto, derivedKey)
  └── 6. return { blob, filename }
```

**Key design decisions:**
- Follows the same pattern as DevModeContext login flow (L873-883): rebuild genesis data,
  sort keys, verify seal.
- Uses `_` prefix for internal helpers (`_findGenesisBlock`, `_verifyGenesisSeal`) to
  indicate they are not part of the public API.
- Finds genesis via `b.type === 'genesis' || b.day_index === 0` for broad compatibility
  across different data format conventions.
- Gracefully handles missing genesis block (shows "No data to export" instead).
