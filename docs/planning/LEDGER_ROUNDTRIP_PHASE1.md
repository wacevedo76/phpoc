# Ledger Roundtrip — Test Exploration (Phase 1)

> **Plan:** N/A (standalone bug fix)
> **Purpose:** Blueprint of needed fixes to make `ledger_roundtrip_test.mjs` pass (currently RED, 0 passing in v2 sections due to crash).
> **Status:** 🔜 Phase 1 (test exploration)
> **Next Phase:** Phase 2 (RED: test definition — update test call signatures to match fixed API)

## Architecture Overview

```
exportLedgerFull(blocks, crypto, masterKey) → Blob
                   ↑ 3 args
Test calls: (blocks, staging, crypto, masterKey) → 4 args
                   ↑ staging passed as 'crypto' param, causes crash
```

`exportLedgerFull` exports committed chain blocks + seal in v2 format.
`importLedger` already supports optional `staging` field in v2 payloads (backward compat).
The test expects staging entries to roundtrip through v2 export, but `exportLedgerFull` doesn't include them.

## Root Cause

**Signature mismatch**: The test calls `exportLedgerFull(SAMPLE_BLOCKS, staging, crypto, MASTER_KEY)` but the function signature is `exportLedgerFull(blocks, crypto, masterKey)`. The `staging` array is passed where `crypto` is expected → `typeof [].seal !== 'function'` → crash at line 109.

## Fix Plan

Single production change: add optional `staging` parameter to `exportLedgerFull`.

```
exportLedgerFull(blocks, crypto, masterKey, staging = null)
```

- Include `staging` in payload only if non-null and non-empty
- Seal continues to cover `ledger` only (matches import's new v2 behavior)
- All 4 existing production callers unchanged (they pass 3 args, staging defaults to null)
- Update 4 test call sites to pass staging as 4th arg

## Test Groups

### Group A: v2 Roundtrip — Basic staging (section 8) — 6 assertions
| ID | Assertion | Purpose |
|----|-----------|---------|
| A1 | `exportLedgerFull(SAMPLE_BLOCKS, crypto, MASTER_KEY, staging)` returns Blob | 4th-arg staging accepted |
| A2 | `importLedger(blob, crypto, MASTER_KEY)` returns formatVersion="2" | v2 format roundtrips |
| A3 | `result.count === 2` | Staging count preserved |
| A4 | `result.entries` deep-equals input staging | Staging entries match |
| A5 | `result.ledger` deep-equals SAMPLE_BLOCKS | Blocks preserved |
| A6 | `result.genesisHash === SAMPLE_BLOCKS[0].day_hash` | Genesis hash extracted |

### Group B: v2 Roundtrip — Empty staging (section 9) — 3 assertions
| ID | Assertion | Purpose |
|----|-----------|---------|
| B1 | `result.count === 0` | Empty staging count |
| B2 | `result.entries` is `[]` | Empty array preserved |
| B3 | `result.ledger` deep-equals SAMPLE_BLOCKS | Blocks preserved with empty staging |

### Group C: v2 Roundtrip — Active staging (section 10) — 2 assertions
| ID | Assertion | Purpose |
|----|-----------|---------|
| C1 | `result.entries[0].is_active === true` | Active flag preserved |
| C2 | `result.entries[0].end_epoch === null` | Null end_epoch preserved |

### Group D: v2 Roundtrip — Genesis-only chain (section 13) — 4 assertions
| ID | Assertion | Purpose |
|----|-----------|---------|
| D1 | `result.formatVersion === "2"` | v2 format |
| D2 | `result.genesisHash` extracted from genesis block | Genesis hash |
| D3 | `result.ledger` deep-equals genesis-only blocks | Single block roundtripped |
| D4 | `result.entries === []` | No staging |

### Group E: v1 Roundtrip (sections 1–7, 11–12, 14) — already GREEN
No changes needed. v1 uses `exportLedger()` which doesn't touch `exportLedgerFull`.

## Summary

| Group | Assertions | Status |
|-------|-----------|--------|
| A (v2 basic staging) | 6 | 🔴 Crash (signature mismatch) |
| B (v2 empty staging) | 3 | 🔴 Crash |
| C (v2 active staging) | 2 | 🔴 Crash |
| D (v2 genesis-only) | 4 | 🔴 Crash |
| E (v1 roundtrips) | ~40 | 🟢 GREEN |
| **Total affected** | **15** | All v2-only |
| **Production change** | 1 function | `exportLedgerFull` + optional staging |
| **Test changes** | 4 call sites | Reorder args in sections 8, 9, 10, 13 |
