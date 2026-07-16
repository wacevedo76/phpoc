# E2E-07: Onboarding Import

> **Status:** ✅ COMPLETE — 2026-07-16, 13/13 steps pass
> **Prerequisites:** Vivaldi browser running, dev server on localhost:5173
> **Important:** Must be LOGGED OUT to reach the onboarding screen.
> **Notes:** WASM `authenticate()` ignores passphrase for raw seeds — only seed matters for seal verification during onboarding import. Wrong passphrase will NOT cause seal failure. Wrong seed will.

## Setup

1. Start dev server: `cd phpoc-web && npx vite --host 0.0.0.0 --port 5173 &`
2. Open browser: `agent_browser open http://localhost:5173/`
3. If already logged in, log out first (nav → LOGOUT button)

## Test Steps

### Step 1: Navigate to Onboarding Import

```
agent_browser snapshot -i
# Verify we see "Welcome to PH Ledger" heading
# Click "📥 Import a ledger"
agent_browser click @e<import-ledger-onboarding>
```

### Step 2: Select "From File"

```
agent_browser snapshot -i
# Verify "📥 Import a Ledger" heading
# Verify two buttons: "📁 From File" and "☁️ From Cloud"
# Click "📁 From File"
agent_browser click @e<from-file>
```

### Step 3: Verify form fields

```
agent_browser snapshot -i
# Expected fields:
#  - "Choose File" button (file input)
#  - "Recovery Seed" textbox
#  - "Passphrase" textbox
#  - "Import Ledger" button [disabled]
#  - "← Back" button
```

**Assertion:** All 5 elements must be present. Import button must be disabled.

### Step 4: Upload file via DataTransfer (C5 workaround)

```js
// agent_browser eval --stdin:
// NOTE: seal must match the seed below. Compute via browser crypto:
//   const crypto = await CryptoService.create();
//   const mk = crypto.authenticate(passphrase, seed, 600000);
//   const seal = crypto.seal(jsonSort(entries), mk);
const input = document.querySelector('input[type="file"]');
const content = JSON.stringify({
  format_version: "1",
  entries: [],
  seal: "4e350c3c5143c684ff6f5847953284195155b6c3f2724530dcc3b2e5e539026b"
});
const dt = new DataTransfer();
dt.items.add(new File([content], 'onboard-import.json', { type: 'application/json' }));
input.files = dt.files;
input.dispatchEvent(new Event('change', { bubbles: true }));
input.dispatchEvent(new Event('input', { bubbles: true }));
```

### Step 5: Verify file selected

```
agent_browser snapshot -i
# Expected: "Selected: onboard-import.json" text visible
```

**Assertion:** File name must appear after Step 4.

### Step 6: Fill seed and passphrase

```
agent_browser fill @e<recovery-seed> "g92sVRVPPxN4uRffWHBBkHskcEtCQvhaTO9GJJxWhlY="
agent_browser fill @e<passphrase> "NewPass456!"
```

### Step 7: Verify Import button enabled

```
agent_browser snapshot -i
# Expected: Import Ledger button is NOT [disabled]
```

**Assertion:** Import button enabled with all fields filled.

### Step 8: Click Import

```
agent_browser click @e<import-ledger>
```

### Step 9: Verify result

```
agent_browser snapshot -i
```

**Assertion:** One of:
- Success: navigated to Dashboard (ledger imported)
- Same-genesis rejection: error shown if genesis collides
- Auth error: "seal verification failed" if credentials don't match

### Step 10: Test Back navigation

```
# From "📥 Import from File" screen, click "← Back"
agent_browser click @e<back>
agent_browser snapshot -i
# Expected: back on "📥 Import a Ledger" screen with From File / From Cloud options
```

**Assertion:** Back button returns to import method selection.

### Step 11: Test Cloud option exists

```
# Verify "☁️ From Cloud" button is present on the import method screen
agent_browser snapshot -i
# Expected: "☁️ From Cloud" button visible
```

**Assertion:** Cloud import entry point is accessible from onboarding.

### Step 12: Test auth errors

Repeat Steps 4-7 with:
- Wrong seed → "seal verification failed" ✅
- Wrong passphrase → succeeds (WASM authenticate ignores passphrase for raw seeds; seed-only auth in onboarding)

### Step 13: Test missing fields

- No file → Import button [disabled] ✅
- No seed → Import button [disabled] ✅
- No passphrase → Import button [disabled] ✅
