# Session History — 2026-07-15

> Archived from `SESSION_HANDOFF.md` — all items resolved this session.

## 15. ✅ WEB STAGING COMMITTED-FLAG LOSS (B-01)
4-phase TDD complete. 27 assertions → 28 RED → 103 GREEN → 2 refactors.
Plan: `docs/planning/COMMIT_PUSH_WIRING_TESTS.md`

## 16. ✅ 3 Pre-existing Web Test Regressions — All Fixed

| Bug | Root cause | Fix type | Result |
|---|---|---|---|
| 16a `commit_push_integration_test.mjs` | 3 test-infra bugs: storage format mismatch, genesis date causing summary block insertion, missing `decryptWithCachedKey` on MockCrypto | Test-only | 60/60 |
| 16b `ledger_roundtrip_test.mjs` | `exportLedgerFull` signature mismatch (test passed 4 args, function took 3) + import hash validation gap (`entry_index` exclusion + `jsonSort` fallback) | Production + test | 84/84 |
| 16c `worker_connect_onboarding_test.mjs` | `buildGenesisBlock` missing `format_version: '0.3.0'` field | Test-only | 65/65 |

Plan: `docs/planning/LEDGER_ROUNDTRIP_PHASE1.md` (16b only; 16a and 16c were 1-line fixes)

## 17. ✅ Production: Committed Flags Lost on Page Reload

Root cause: `mergeEntries` unconditionally overwrote local `committed=true` with remote `committed=false` when `pushBlobOnly` failed silently.

**Fix chain:**
1. `merge_engine.js` — preserve `committed` + `block_index` from local on merge
2. `DevModeContext.jsx` — log push failures instead of silently swallowing
3. `sync_test.mjs` — +4 unit tests (1g–1j) covering all committed flag quadrants
4. `ledger_import.js` — hash validation fix (exclude `entry_index`, use `jsonSort`)

**Files changed:** `merge_engine.js`, `DevModeContext.jsx`, `ledger_import.js`, `ledger_export.js`, `sync_test.mjs` (+4 tests)

## Full Suite Results (end of session)

| Suite | Tests |
|---|---|
| `sync_test.mjs` | 76/76 |
| `sync_service_test.mjs` | 276/276 |
| `committed_flag_integration_test.mjs` | 22/22 |
| `commit_push_integration_test.mjs` | 60/60 |
| `ledger_roundtrip_test.mjs` | 84/84 |
| `worker_connect_onboarding_test.mjs` | 65/65 |
| **Total** | **583/583 GREEN** |
