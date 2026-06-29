# Browser E2E Test Plan

> **Status:** In Progress — 2026-06-28
> **Browser:** Vivaldi (Chromium-based) via agent_browser on port 9222
> **App URL:** `http://localhost:5174/?dev=false`
> **Test ledger:** William Acevedo / william.acevedo@gmail.com, 1 genesis block, 2 staging entries

## Credentials

| Field | Value |
|-------|-------|
| Passphrase | `VZQKp6TrIBK/GUtsjoof75HRyzd7w8S0` |
| Recovery Seed | `Qy2OER5EbUcsL7PWp+e24hSTE/CAN/OOEF7fgDIGEsw=` |
| Export file | `testdata/e2e_export.phpledger` (v2 format, 2.7KB) |

## Test Results Summary

| Test | Status | Notes |
|------|--------|-------|
| E2E-01: Export Flow | ✅ PASS | Dialog, cancel, confirm, valid v2 JSON output |
| E2E-02: Import Dialog UI | ✅ PASS | All gating rules verified |
| E2E-03: Import File Upload | ⚠️ PARTIAL | File upload via eval works; React onChange doesn't fire from programmatic fill (known limitation C5) |
| E2E-04: Import Auth Errors | ⏳ PENDING | |
| E2E-05: Roundtrip | 🔴 FAILED | **BUG: Seal/hash mismatch** — raw JS objects vs JSON-parsed objects differ by 54 bytes |
| E2E-06: Export Wrong Passphrase | ⏳ PENDING | |
| E2E-07: Onboarding Import | ⏳ PENDING | |

## Detailed Results

### E2E-01: Export Flow (Settings → Export) ✅

| Step | Action | Expected | Result |
|------|--------|----------|--------|
| 1 | Click Export on Settings | Passphrase modal opens | ✅ |
| 2 | Cancel | Modal closes, back to Settings | ✅ |
| 3 | Export → fill passphrase → Confirm | Dialog closes | ✅ |
| 4 | Verify export data | Valid v2 JSON with ledger + staging + seal | ✅ (2.7KB, 1 genesis block + 2 staging entries) |

### E2E-02: Import Dialog UI (Settings → Import) ✅

| Step | Action | Expected | Result |
|------|--------|----------|--------|
| 1 | Click Import | Dialog with file/seed/passphrase fields | ✅ |
| 2 | Import disabled initially | [disabled] attribute shown | ✅ |
| 3 | Fill seed + passphrase, no file | Import still disabled | ✅ |
| 4 | Cancel → dialog closes | Modal dismisses | ✅ |
| 5 | Re-open, upload file (via eval) + seed + passphrase | Import enabled | ✅ |

### E2E-03: Import File Upload ⚠️ PARTIAL

| Step | Action | Expected | Result |
|------|--------|----------|--------|
| 1 | Upload via `input.files = dt.files` + dispatchEvent | File name "e2e_export.phpledger" shown | ✅ (via eval) |
| 2 | Fill seed + passphrase | Import enabled | ✅ |
| 3 | Click Import Ledger (UI) | Error: "invalid or unreadable file" | ⚠️ React `importFile` state not updated by programmatic fill |
| 4 | Same-genesis rejection (direct `importLedger` call via eval) | "merge is not yet supported" | ✅ (via eval) |
| 5 | Import with seed+passphrase (via eval) | "seal verification failed" | 🔴 See E2E-05 bug |

### E2E-05: Roundtrip 🔴 BUG FOUND

**Root Cause:** The export computes the seal and entry hashes over raw JavaScript objects, but the import reads JSON-parsed objects (which drop `undefined` values). The raw JSON is 2158 bytes; the parsed JSON is 2104 bytes. The 54-byte difference causes seal verification to fail.

**Evidence:**
- `sealFromRaw` (matches export): `d5f1a2ca638bfb17c9ef0edd63bfee90f757b471630dd6eb04a7ad09cbb53b34`
- `sealFromParsed` (import computes): `846790e63cda62f2f8e7adf4220cda3e676bb3380a7577dc50fedfe0f74be81c`
- Entry hash mismatch at index 0: `ab48738f...` (stored) ≠ `31e93fa3...` (recomputed from parsed JSON)

**Fix needed:** The seal must be computed over the exact JSON string that will be written to the file (`JSON.stringify` output), not over the raw JavaScript objects. Or the seal/entry hashes must be recomputed during export to match the serialized form.

## Known Limitations

- **C5 (from handoff):** agent_browser `fill` sets DOM `.value` but doesn't trigger React `onChange` for file inputs. Workaround: use `eval` to set `input.files` via `DataTransfer` + dispatch `input`/`change` events. This updates the file list on the DOM element but the React `importFile` state remains stale because React's synthetic event system isn't triggered.
- **Blob downloads:** `wait --download` doesn't capture programmatic blob URL downloads (`a.click()` on `URL.createObjectURL`). Workaround: use `eval` to call export functions directly and capture blob data.
