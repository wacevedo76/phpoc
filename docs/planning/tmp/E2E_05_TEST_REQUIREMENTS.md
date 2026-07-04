# E2E-05 Test Requirements — Seal/Hash Mismatch

> **Phase 1 — Exploratory**  |  **Phase 2 — RED tests:** ✅ Complete (Jul 4)
> **Bug:** Export computes seal over raw JS objects; import recomputes over JSON-parsed objects. Seal payloads differ (54 bytes), causing correct credentials to fail verification.
> **Impact:** Roundtrip (export→import) and onboarding import both fail.
> **E2E plan ref:** `docs/planning/BROWSER_E2E_TEST_PLAN.md` — E2E-05 & E2E-07

---

## Test Groups

### Group A: Seal Consistency (Core Fix)

**Purpose:** The seal value written to the export file must be identical to the seal recomputed from the file's parsed content.

| # | Assertion | Rationale |
|---|-----------|-----------|
| A1 | `exportLedgerFull(blocks, staging, crypto, mk)` → `importLedger(blob, crypto, mk)` — seal verification passes | Core roundtrip: same mk, same data, seal must match |
| A2 | Same data exported twice produces the same seal (except `exported_at`) | Seal must be deterministic and independent of runtime state |
| A3 | Seal computed from `JSON.parse(await blob.text())` matches the seal in the blob | The seal must be verifiable from the file's own parsed content — this is the tautology test |
| A4 | Seal PAIRS with data: changing ANY field (ledger or staging) produces a different seal | Tamper detection: seal must cover all data |
| A5 | Seal is master-key-specific: different `masterKey` → different seal for same data | Key isolation: wrong key must fail |
| A6 | Import with wrong master key → seal verification fails → error thrown | Security: no silent acceptance with wrong key |
| A7 | Roundtrip seal matches when blocks contain `format_version` field (real genesis shape) | The real genesis block has `format_version: "0.3.0"` — this field must be handled consistently |
| A8 | Roundtrip seal matches when blocks contain `signature` field (real genesis shape) | Real genesis blocks have `signature` — must not cause drift |
| A9 | Roundtrip seal matches when identity object has nested crypto fields (`recovery_seed_enc`, `identity_pub_key`, `identity_secret_enc_fallback`) | Real identity is larger than mock — deep nesting must survive roundtrip |

### Group B: Staging Entry Shape Variants

**Purpose:** Staging entries have different field sets depending on state (active vs stopped). The full set of fields the seal payload sees must be identical on both export and import.

| # | Assertion | Rationale |
|---|-----------|-----------|
| B1 | Active entry (no `end_device_uuid`, `end_epoch: null`) roundtrips with seal intact | Active entries lack the `end_device_uuid` key entirely; both sides must agree on key presence |
| B2 | Stopped entry (`end_device_uuid` present, `end_epoch` set) roundtrips with seal intact | Stopped entries have extra keys; must not drift |
| B3 | Mixed active+stopped staging roundtrips with seal intact | Different entry shapes coexist in same export — seal must handle heterogeneous arrays |
| B4 | Staging entries with `committed`, `block_index`, `entry_index` extra fields roundtrip correctly | These are added by `LocalCache.append()` after hash computation — must be included in seal payload |
| B5 | Staging entry with `metadata: {}` (empty object) vs absent `metadata` — both roundtrip correctly | Edge case: empty objects can serialize differently across parsers |
| B6 | Staging entry with `comment: null` vs absent comment — both roundtrip correctly | `null` is JSON-preserved but absent key is not — must handle both |

### Group C: JSON Serialization Roundtrip Boundary

**Purpose:** The seal computation must be invariant across the `JSON.stringify → JSON.parse` boundary. This is the root cause of the bug.

| # | Assertion | Rationale |
|---|-----------|-----------|
| C1 | `jsonSort(rawJsObject)` equals `jsonSort(JSON.parse(JSON.stringify(rawJsObject)))` for all entry/block shapes used in export | This is the fundamental invariant that's currently broken |
| C2 | When `jsonSort` throws on a value (e.g., `undefined`), the export must not silently produce a different seal | `jsonSort` crashes on `undefined` values — any path that allows `undefined` into the seal payload is a bug |
| C3 | `JSON.stringify(sealPayload)` output is deterministically related to `jsonSort(sealPayload)` output | If the fix switches to sealing over `JSON.stringify` output instead of `jsonSort` output, verify consistency |
| C4 | No field that appears in `Object.keys()` of a raw block/staging entry is silently dropped in the import seal check | Every key in the raw objects must survive the roundtrip or be explicitly excluded from the seal on both sides |
| C5 | Empty arrays (`[]`) and empty objects (`{}`) produce consistent seal contributions | Edge serialization: `jsonSort([])` vs `JSON.stringify([])` |

### Group D: Entry Hash Consistency

**Purpose:** Each staging entry's `hash` field must be independently verifiable after import.

| # | Assertion | Rationale |
|---|-----------|-----------|
| D1 | Import re-validates every entry hash — all entries must match | Hash chain integrity: no entry accepted without hash validation |
| D2 | Entry hash covers ALL fields except `hash` itself (sorted keys) | Re-computation during import uses same field set as export's recomputation |
| D3 | Entry hash mismatch at any index → reject entire import (no partial acceptance) | Security: all-or-nothing validation |
| D4 | Entry hashes recomputed during export (via `exportLedgerFull`) match what import expects | Export recomputes hashes to include extra fields (`committed`, `block_index`, etc.) — import must agree on hash formula |
| D5 | Entry hash for entries without extra fields (no `committed`, `block_index`, etc.) still validates | Simplest case must work |

### Group E: Chain Import (Raw Format) — No Regression

**Purpose:** Fix must not break raw chain (CLI `ledger.json`) import. Chain import uses per-block seal verification, not the export-level seal.

| # | Assertion | Rationale |
|---|-----------|-----------|
| E1 | Genesis block seal verification still works with `block_hash` (new format) and `day_hash` (old format) | I-17 backward compatibility |
| E2 | Day/month/year block seal verification unchanged | Non-export code path |
| E3 | Entry hash validation inside day blocks unchanged | Block-level entry hashes use `jsonSort(entry.data)` — must still match |
| E4 | `prev_hash` chain linkage check unchanged | Structural integrity |
| E5 | `format_version` excluded from block seal check | I-07 invariant — block seals exclude `format_version`; export-level seal may or may not |

### Group F: Edge Cases & Error Handling

| # | Assertion | Rationale |
|---|-----------|-----------|
| F1 | Empty ledger + empty staging → roundtrip succeeds | Minimal data must work |
| F2 | Genesis-only chain + empty staging → roundtrip succeeds | Single-block export must work |
| F3 | Export with 100+ blocks → roundtrip succeeds | Large data must not accumulate drift |
| F4 | Tampered seal (any modification after export) → import rejects | Tamper detection |
| F5 | Tampered entry hash (modify hash but leave data intact) → import rejects | Entry-level tamper detection |
| F6 | Corrupted JSON (mid-file truncation) → import rejects gracefully | Malformed file handling |
| F7 | `importLedger` with `null`/`undefined` masterKey → throws immediately | Input validation |

### Group G: Real Data Reproduction

**Purpose:** Reproduce the exact E2E-05 failure with a test fixture that matches the shape of real IndexedDB data.

| # | Assertion | Rationale |
|---|-----------|-----------|
| G1 | Build fixture matching `testdata/e2e_export.phpledger` shape: genesis with `format_version` + `signature` + crypto identity, one stopped staging entry with `end_device_uuid`, one active staging entry without `end_device_uuid` | Exact reproduction of the failing scenario |
| G2 | `exportLedgerFull` with G1 fixture → `importLedger` → seal verification passes (currently FAILS) | Direct reproduction of E2E-05 bug |
| G3 | `importLedger` with actual `testdata/e2e_export.phpledger` file → seal verification passes (currently FAILS) | Verify fix works on the real export file |
| G4 | G1 fixture roundtrip: all fields preserved including `format_version`, `signature`, identity crypto fields, optional staging fields | Full fidelity check |

---

## Summary

- **Total assertion categories:** 7 groups, 38 assertions
- **Core fix area:** Group A (seal consistency) + Group G (real data reproduction)
- **Regression guard:** Groups B–F
- **Current passing tests NOT affected:** The 84 existing roundtrip tests use mock data with simpler shapes (no `format_version`, no `signature`, no crypto identity fields, no missing keys for active entries). These tests pass because the mock data doesn't trigger the discrepancy. They must continue to pass after the fix.

---

## Phase 2 RED Test Results (Jul 4)

**File:** `phpoc-web/test/ledger_seal_consistency_test.mjs` — 154 assertions, 1 intentional RED

| Group | Assertions | Pass | RED | Notes |
|-------|-----------|------|-----|-------|
| G | 35 | 35 | 0 | G1 fixture, G2 roundtrip, G3 structural validation, G4 fidelity |
| A | 17 | 17 | 0 | Seal consistency, determinism, key isolation, format_version/signature/identity |
| B | 19 | 19 | 0 | Active/stopped/mixed staging shapes, extra fields, empty/absent metadata |
| C | 6 | 5 | **1** | C2: jsonSort({a: undefined}) throws TypeError |
| D | 10 | 10 | 0 | Entry hash validation, mismatch rejection, hash field coverage |
| E | 11 | 11 | 0 | Raw chain import, block_hash/day_hash compat, chain linkage, format_version exclusion |
| F | 13 | 13 | 0 | Empty data, tampered seal/hash, corrupt JSON, null/undefined masterKey |
| **Total** | **111** | **110** | **1** | `ledger_seal_consistency_test` summary count: 154 (includes G1 fixture assertions) |

### Key Findings

1. **G2 passes**: Export→import roundtrip with G1 fixture is internally consistent when both sides use `jsonSort` + MockCrypto. The JS logic is correct.

2. **C2 is RED**: `jsonSort({a: undefined})` crashes because `_jsonDumps` has no handler for `typeof undefined`. If `undefined` values ever leak into seal payloads (e.g., from IndexedDB structured cloning), the export silently breaks.

3. **G3 reveals root cause**: The real export file has entry hashes computed with `JSON.stringify()` (NOT `jsonSort()`). The current import code validates with `jsonSort()`, causing hash mismatch. Two sub-patterns detected:
   - Stopped entries: hash = `SHA256(JSON.stringify(all_fields_except_hash))`
   - Active entries: hash = `SHA256(JSON.stringify(core_fields_only_no_committed_block_index))`

### GREEN Phase Direction

1. **Fix jsonSort undefined handling** — add `if (obj === undefined) return 'null';` (or skip the key) in `_jsonDumps`
2. **Backward-compatible hash validation in importLedger** — try `jsonSort` first, fall back to `JSON.stringify` for old-format entries
3. **Seal verification** — same dual-path: try `jsonSort` first, fall back to `JSON.stringify` for the seal payload
4. **0 regressions** — all 110 passing tests + 197 existing must stay green
