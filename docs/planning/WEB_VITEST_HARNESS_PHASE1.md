# Web Vitest Harness Hygiene (Phase 1 blueprint)

> **Spec:** `docs/planning/WEB_FLUTTER_PARITY_SPEC.md` §P4
> **Inventory:** `WEB_TEST_BASELINE_FAILURES.md`
> **Status:** ✅ Phases 1–4 complete (2026-08-28). Root cause diagnosed; fix surface verified; GREEN
> achieved. Scope expanded during Phase 3: 8 node suites were mis-named `*.test.mjs` (still matched the
> first glob) and 2 vitest files had a `verifyLedgerChain` mock gap.

## Purpose

Make `npx vitest run` in `phpoc-web/` report only real test results. Today `vite.config.js`
`test.include` has **two** globs; the second (`**/*_test.?(c|m)[jt]s?(x)`) pulls the `node --test`
suites into vitest, producing 77 non-green noise files plus 3 genuine load errors.

## Root-Cause Analysis (verified 2026-08-28)

1. **`sync_indicator_test.mjs`** — not broken under node (32/32 GREEN). The ENOENT is vitest-only:
   vitest rewrites `import.meta.url` to a non-`file://` URL so `readFileSync(new URL(…).pathname)`
   reads `/src/...`. Fixed by the glob change alone — no file edit.
2. **`ledger_merge_test.mjs`** — genuinely broken under node ("local chain validation failed:
   block 1 seal"). Commit `1938392` updated `buildGenesisBlock` to `selectSealFields` but **missed
   `buildDayBlock`**; also its local `computeEntryHash` uses unsorted `JSON.stringify` vs the
   canonical sorted `jsonSortIndent2`. Fix = 2 lines.
3. **`genesis_gate_test.mjs`** — genuinely broken under node (`result.stats` undefined). Written
   pre-ADR-029a; both block builders seal full content, and 5 cases (A2/C2/D1/F4/G4) assert
   "different identity → genesis mismatch" even though ADR-029a moves `identity` outside the seal.
   Fix = 6 edits.

## Fix Scope (all test-only; no change to tested modules)

| # | File | Change |
|---|------|--------|
| 1 | `vite.config.js` | Single `test.include` glob (drop `**/*_test.*`) |
| 2 | `test/ledger_merge_test.mjs` | `buildDayBlock` seals `selectSealFields`; `computeEntryHash` delegates to canonical `utils.js` |
| 3 | `test/genesis_gate_test.mjs` | Both builders seal `selectSealFields`; B5 seal-verify loop uses `selectSealFields`; 5 identity-mismatch fixtures → `date`-based genesis |
| 4 | 8 node suites `*.test.mjs` → `*_test.mjs` | Rename so the single glob no longer discovers them (`i01_key_rotation_web`, `i02a_field_token_wasm`, `i02_index_encryption`, `i02_staging_keys`, `i09_device_attribution`, `onboarding_cloud_conflict`, `worker_connect_blocks_format`, `worker_connect_fullchain_regression`) |
| 5 | `test/encrypt_entry_fields_{ui,display}.test.mjs` | Add `verifyLedgerChain` stub to `mockSyncService` (kills 3 unhandled rejections from `SyncSettings.jsx`) |

## Test Groups

### Group A: Harness config — 2 assertions (vitest meta-test)
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| A1 | `test.include` is a single-element array | Only vitest suites discovered | Prevents node suites re-entering vitest |
| A2 | The single glob matches `*.{test,spec}.*`, not `*_test.*` | Node suites stay under `node` | Encodes acceptance criterion 1 |

### Group B: `sync_indicator_test.mjs` — 32 assertions (node, regression guard)
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| B1–B32 | Status→config mapping (6 statuses, compact, fallback) | Guard SyncIndicator mapping | Confirm vitest ENOENT is not a real bug |

### Group C: `ledger_merge_test.mjs` — 105 assertions (node, 2-line fixture fix)
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| C1 | `buildDayBlock` seal verifies against `_verifyChain` | Fixture matches ADR-029a whitelist | Crash root cause |
| C2 | Entry hash via canonical sorted JSON | Fixture matches `verifyEntryHash` | Second fixture mismatch |
| C3–C105 | Merge fork/dedup/summary/order/integrity/stats | Full `LedgerMerge.merge` coverage | Already correct; fixtures only stale |

### Group D: `genesis_gate_test.mjs` — 218 assertions (node, 6-edit fix)
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| D1 | Genesis/day fixtures seal whitelist | Match `_verifyBlockData` | Crash root cause |
| D2 | B5 seal-verify loop uses `selectSealFields` | Recompute over closed set | Matches verifier (1938392 parity) |
| D3–D7 | A2/C2/D1/F4/G4 mismatch via `date` | Genuine whitelisted-field mismatch | ADR-029a: identity outside seal |
| D8–D218 | Typed errors, merge, hash-index T1/T2, edges | Full `GenesisGate.check` coverage | Already correct; fixtures/semantics stale |

### Group E: Vitest cleanliness — run-level
| ID | Assertion | Purpose | Rationale |
|----|-----------|---------|-----------|
| E1 | `npx vitest run` reports 0 genuine failures | Real result only | Acceptance criterion 3 |
| E2 | Output has no "No test suite found" / node `*_test` noise | Harness clean | Acceptance criterion 1–2 |
| E3 | Node suites still GREEN under `node --experimental-vm-modules` | `node --test` path intact | Acceptance criterion 3 |

## Out of Scope (unchanged)
- Renaming node suites *to* vitest conventions (`*_test.mjs` → `*.test.mjs`). (The reverse — renaming 8
  mis-named `*.test.mjs` node suites *to* `*_test.mjs` — was added to scope after discovery.)
- Any change to tested modules (`merge.js`, `genesis_gate.js`, `seal_fields.js`, `utils.js`, `SyncIndicator.jsx`).
