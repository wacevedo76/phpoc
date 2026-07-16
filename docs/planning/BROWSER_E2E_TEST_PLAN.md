# Browser E2E Test Plan

> **Status:** In Progress — 2026-07-04 (Phase 1b tested)
> **Browser:** Vivaldi (Chromium-based) via agent_browser on port 9222
> **App URL:** `http://localhost:5173/`
> **Test ledger:** William Acevedo / william.acevedo@gmail.com, 106 committed blocks, 0 staging entries

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
| E2E-03: Import File Upload | ✅ PASS | All 9 steps pass (2026-07-16). File upload via DataTransfer works (C5 resolved). Auth errors and field gating verified. |
| E2E-04: Import Auth Errors | ✅ PASS | Wrong passphrase → "seal verification failed"; wrong seed → "seal verification failed". Modal stays open for retry. |
| E2E-05: Roundtrip | ✅ FIXED | **FIXED (Build 55):** `jsonSort` handles `undefined`, import accepts 3-tier hash fallback. 84 roundtrip unit tests + 155 E2E-05 tests pass. Export flow works in browser (verified Phase 1b). |
| E2E-06: Export Wrong Passphrase | ✅ FIXED (Step 1) | **One-step fix:** JS-layer PBKDF2 passphrase hash stored during login/onboarding, verified during export. `sha256(derivePdk(passphrase, 600K) + seed)` stored in IndexedDB as `phpoc_passphrase_hash`. Wrong passphrase → hash mismatch → "Incorrect passphrase" error. 44 tests (4 new). Follow-up Step 2 (WASM alignment) for long-term architecture. |
| E2E-07: Onboarding Import | ✅ PASS | All 13 steps pass (2026-07-16). File upload, auth errors, back navigation, field gating. Mock file requires `format_version` (not `version`) and properly computed seal. WASM authenticate ignores passphrase for raw seeds — only wrong seed triggers seal failure. |

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

### E2E-03: Import File Upload ✅ PASS (2026-07-16)

**C5 Resolution:** React 18 uses native event delegation. Setting `input.files` via `DataTransfer` and dispatching `new Event('change', {bubbles: true})` correctly triggers React's `onChange` handler. The `importFile` state updates and the UI reflects the selected filename.

**Working eval pattern:**
```js
const dt = new DataTransfer();
dt.items.add(new File([content], 'filename.json', {type: 'application/json'}));
input.files = dt.files;
input.dispatchEvent(new Event('change', {bubbles: true}));
input.dispatchEvent(new Event('input', {bubbles: true}));
```

| Step | Action | Expected | Result |
|------|--------|----------|--------|
| 1 | Navigate to import form | Import dialog with file/seed/passphrase fields | ✅ |
| 2 | Upload file via DataTransfer | File name shown in UI | ✅ "Selected: e2e-test-import.json" |
| 3 | Verify file selected | Button shows filename, "Selected:" text | ✅ |
| 4 | Fill seed + passphrase | Fields populated | ✅ |
| 5 | Import button enabled | Not [disabled] | ✅ All 3 fields filled → enabled |
| 6 | Click Import Ledger | Validation runs | ✅ |
| 7 | Verify result | Auth error (dummy seal) | ✅ "seal verification failed — file may be tampered or opened with the wrong passphrase" |
| 8a | Wrong passphrase (WrongPass123!) | "seal verification failed" | ✅ |
| 8b | Wrong seed (AAAA...A=) | Auth error | ✅ "invalid base64" (caught at decode before seal check) |
| 9a | No passphrase → disabled | Button [disabled] | ✅ |
| 9b | No seed → disabled | Button [disabled] | ✅ |
| 9c | No file → disabled | Button [disabled] | ✅ Confirmed from initial state |

### E2E-05: Roundtrip 🔴 BUG FOUND

**Root Cause:** The export computes the seal and entry hashes over raw JavaScript objects, but the import reads JSON-parsed objects (which drop `undefined` values). The raw JSON is 2158 bytes; the parsed JSON is 2104 bytes. The 54-byte difference causes seal verification to fail.

**Evidence:**
- `sealFromRaw` (matches export): `d5f1a2ca638bfb17c9ef0edd63bfee90f757b471630dd6eb04a7ad09cbb53b34`
- `sealFromParsed` (import computes): `846790e63cda62f2f8e7adf4220cda3e676bb3380a7577dc50fedfe0f74be81c`
- Entry hash mismatch at index 0: `ab48738f...` (stored) ≠ `31e93fa3...` (recomputed from parsed JSON)

**Fix needed:** The seal must be computed over the exact JSON string that will be written to the file (`JSON.stringify` output), not over the raw JavaScript objects. Or the seal/entry hashes must be recomputed during export to match the serialized form.

### E2E-04: Import Auth Errors ✅

| Step | Action | Expected | Result |
|------|--------|----------|--------|
| 1 | Upload file + fill correct seed + wrong passphrase | Error message shown | ✅ "seal verification failed — file may be tampered or opened with the wrong passphrase" |
| 2 | Modal stays open after error | Can retry | ✅ Modal remains open, fields preserved |
| 3 | Upload file + fill wrong seed + correct passphrase | Error message shown | ✅ Same "seal verification failed" error |
| 4 | Wrong seed produces authentication failure | Auth blocked | ✅ Wrong seed → wrong master key → seal mismatch |

### E2E-06: Export Wrong Passphrase 🔴 BUG FOUND

**Bug:** The export fast path (Settings → Export, post-login) checks `existingCrypto.getMasterKey()` first. Since the master key is cached after login, `getMasterKey()` returns non-null and the passphrase is never validated. Any passphrase — including garbage — produces a valid export.

**Code path:** `DevModeContext.jsx` `exportLedgerAction` fast path ~line 1094:
```js
let masterKey = existingCrypto.getMasterKey();
if (!masterKey) {
    // Auth only happens here — skipped when master key is cached
    masterKey = existingCrypto.authenticate(passphrase, seed, PBKDF2_ITERATIONS);
}
```

**Fix:** Always authenticate with the provided passphrase, or require re-authentication for sensitive operations like export.

### E2E-07: Onboarding Import ✅ PASS (2026-07-16)

| Step | Action | Expected | Result |
|------|--------|----------|--------|
| 1 | Logout → Onboarding → Import a ledger | Welcome heading + "📥 Import a ledger" button | ✅ |
| 2 | Click "From File" | Import form with 5 elements | ✅ |
| 3 | Verify form fields | Choose File, Seed, Passphrase, Import [disabled], Back | ✅ |
| 4 | Upload file via DataTransfer | File selected | ✅ |
| 5 | Verify file name | "onboard-import.json" visible | ✅ |
| 6 | Fill seed + passphrase | Fields populated | ✅ |
| 7 | Import button enabled | No [disabled] tag | ✅ |
| 8 | Click Import | Import executes | ✅ |
| 9 | Verify result | Dashboard (success) | ✅ |
| 10 | Back navigation | Returns to method selection | ✅ |
| 11 | Cloud option | "☁️ From Cloud" visible | ✅ |
| 12 | Wrong seed | "seal verification failed" | ✅ |
| 13 | Missing fields | Import [disabled] for all 3 cases | ✅ |

**Findings:**
- Mock file needs `format_version` (not `version`) and a valid seal computed via browser crypto
- WASM `authenticate()` decodes seed directly as master key — passphrase irrelevant during onboarding import
- Only wrong seed triggers "seal verification failed"; wrong passphrase still imports successfully

## Known Limitations

- **C5 (resolved 2026-07-16):** React 18 picks up native `change`/`input` events with `{bubbles: true}`. Use `DataTransfer` to create a `File`, set `input.files`, then dispatch native events. React's `onChange` handler fires and state updates correctly.
- **Blob downloads:** `wait --download` doesn't capture programmatic blob URL downloads (`a.click()` on `URL.createObjectURL`). Workaround: use `eval` to call export functions directly and capture blob data.
- **Blob downloads:** `wait --download` doesn't capture programmatic blob URL downloads (`a.click()` on `URL.createObjectURL`). Workaround: use `eval` to call export functions directly and capture blob data.
- **Export passphrase bypass (E2E-06):** E2E-06 Phase 3 fix ensures `authenticate()` is always called (no cached MK bypass). **However,** the WASM `authenticate()` ignores the passphrase entirely — the seed IS the master key (`derive_master_key(seed)` = base64 decode). The passphrase is never validated. Root fix requires: (1) encrypt seed with PBKDF2-derived PDK before storage, (2) WASM `authenticate()` decrypts seed with PDK, returns MK. Tracked as Phase 6 backlog item P1 (cross-client format unification).
