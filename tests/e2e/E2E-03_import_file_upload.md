# E2E-03: Import File Upload

> **Status:** READY — C5 resolved 2026-07-16 (React 18 picks up native events)
> **Prerequisites:** Vivaldi browser running, dev server on localhost:5173, ledger already set up

## Setup

1. Start dev server: `cd phpoc-web && npx vite --host 0.0.0.0 --port 5173 &`
2. Open browser: `agent_browser open http://localhost:5173/`
3. Ensure a ledger is already created (Settings tab should be visible in nav)

## Test Steps

### Step 1: Navigate to Settings → Import

```
agent_browser snapshot -i
# Find the Settings button @ref and click it
agent_browser click @e<settings>
# Find the Import button
agent_browser click @e<import>
```

### Step 2: Upload file via DataTransfer (C5 workaround)

```js
// agent_browser eval --stdin:
const input = document.querySelector('input[type="file"]');
const content = JSON.stringify({
  version: "0.4.0",
  genesis: { username: "e2e", email: "", timestamp: 1700000000000 },
  chain: []
});
const dt = new DataTransfer();
dt.items.add(new File([content], 'e2e-ledger.json', { type: 'application/json' }));
input.files = dt.files;
input.dispatchEvent(new Event('change', { bubbles: true }));
input.dispatchEvent(new Event('input', { bubbles: true }));
```

### Step 3: Verify file selected

```
agent_browser snapshot -i
# Expected: button text shows "e2e-ledger.json" instead of "No file chosen"
# Expected: generic text shows "Selected: e2e-ledger.json"
```

**Assertion:** File name must appear in the UI after Step 2.

### Step 4: Fill seed and passphrase

```
agent_browser fill @e<recovery-seed> "g92sVRVPPxN4uRffWHBBkHskcEtCQvhaTO9GJJxWhlY="
agent_browser fill @e<passphrase> "NewPass456!"
```

### Step 5: Verify Import button enabled

```
agent_browser snapshot -i
# Expected: Import Ledger button is NOT [disabled]
```

**Assertion:** Import button must be enabled when file + seed + passphrase are all provided.

### Step 6: Click Import

```
agent_browser click @e<import-ledger>
```

### Step 7: Verify result

```
agent_browser snapshot -i
```

**Assertion:** Either:
- Success: modal closes, navigated to Dashboard
- Same-genesis rejection: error message "A ledger with this genesis already exists" shown (if the test ledger's genesis collides with the existing one)
- Auth error: "seal verification failed" shown (if seed/passphrase don't match the export file)

### Step 8: Test auth errors

Repeat Steps 1-5 with:
- **Wrong passphrase:** Correct seed, passphrase = "WrongPass123!" → Expected: "seal verification failed"
- **Wrong seed:** Seed = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", correct passphrase → Expected: "seal verification failed"

### Step 9: Test missing fields

Repeat Steps 1-5 leaving each field blank one at a time:
- No file → Import button should stay [disabled]
- No seed → Import button should stay [disabled]
- No passphrase → Import button should stay [disabled]
