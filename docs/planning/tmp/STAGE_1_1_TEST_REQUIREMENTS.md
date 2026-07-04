# Stage 1.1 — Test Requirements (Exploratory Phase)

> **Status:** ✅ Implementation already complete (removed in `d351c05`, 2026-06-30).
> **This doc:** Captures what Stage 1.1 asserts and why, for TDD traceability.
> **Plan source:** `docs/planning/ALIGN_WEB_STAGING_SHARING_WITH_CLI.md` Phase 1.

---

## What Stage 1.1 Does

Remove the MK-cached bypass in `checkAndSync()`. When no local device cookie
exists, always return `REAUTH_NEEDED` — regardless of whether a master key
is cached in memory. The cookie is the **sole source of truth** for session
validity. A cached crypto key is not a substitute for a valid device cookie.

**Before (removed in `d351c05`):**
```js
if (!localCookie) {
    const mk = this._crypto.getMasterKey();
    if (mk) {
        return this._reconcileAndClaim(mk);  // ← bypasses REAUTH_NEEDED
    }
    return SyncResult.REAUTH_NEEDED;
}
```

**After (current):**
```js
if (!localCookie) {
    return SyncResult.REAUTH_NEEDED;
}
```

The CLI has always enforced this rule:
```python
# domain/staging/service.py line ~543
if local_cookie is None:
    return SyncCheckResult.REAUTH_NEEDED  # always — no crypto bypass
```

---

## Core Principle: Cookie Is Truth

| Principle | Rationale |
|-----------|-----------|
| **Cookie = session authority** | The device cookie (specifier + TTL) is the only reliable signal that this device session is valid. Cached crypto keys outlive sessions and don't carry device identity. |
| **MK ≠ session proof** | A cached master key means the user's passphrase was valid at some point — it does not mean the device has a valid staging session cookie. The MK alone can't prove which device wrote last or if the TTL is valid. |
| **Explicit re-auth for cross-device** | When a different device wrote staging, the user must explicitly enter their passphrase to consent to merging. Skipping this step via cached MK (the bypass) hides the merge from the user. |
| **CLI parity** | The CLI has always returned `REAUTH_NEEDED` when no local cookie exists, regardless of cached crypto. The web must match this behavior for cross-client interoperability. |

---

## Test Assertions & Rationales

### A2 — No local cookie, no remote cookie, no MK → REAUTH_NEEDED

**What it asserts:**
```
Given: no local cookie, no remote cookie, no master key cached
When:  checkAndSync() is called
Then:  returns REAUTH_NEEDED
```

**Rationale:** Baseline sanity check. Without any session state at all, sync cannot
proceed. This was already correct before Stage 1.1 and remains correct after.

**Test file:** `phpoc-web/test/sync_service_test.mjs` Group A
**Status:** ✅ Existing, passes

---

### A2b — No local cookie + MK cached → REAUTH_NEEDED (no bypass) ⬅ KEY TEST

**What it asserts:**
```
Given: no local cookie, master key IS cached
When:  checkAndSync() is called
Then:  returns REAUTH_NEEDED (NOT READY, NOT _reconcileAndClaim)
```

**Rationale:** This is the **critical assertion** that Stage 1.1 exists to enforce.
Even though a valid master key is in memory (user has authenticated before), the
absence of a local device cookie means the session isn't established. The cookie
is the truth — not the cached key.

A cached MK without a cookie means one of:
- User was logged out / session was destroyed (cookie cleared, MK uncleared)
- A different device wrote to staging (cookie mismatch resolved, old cookie removed)
- Fresh onboarding completed but cookie not yet created

In all cases, the correct behavior is to demand explicit re-authentication so the
user's passphrase-derived MK can be used to pull the remote cookie, check the
remote specifier, and trigger the correct merge path (Case A or Case B).

**What the old bypass would do:** Automatically call `_reconcileAndClaim(mk)` without
user consent — pulling remote blob, merging, and claiming the remote cookie all
silently. This hid cross-device merges from the user.

**Test file:** `phpoc-web/test/sync_service_test.mjs` Group A
**Status:** ✅ Existing, passes

---

### H1 — No local cookie + remote reachable + no MK → REAUTH_NEEDED

**What it asserts:**
```
Given: no local cookie, no MK, remote transport reachable
When:  checkAndSync() is called
Then:  returns REAUTH_NEEDED
```

**Rationale:** Even when the remote is fully reachable, if there's no local session
state at all, auth is required. The remote's availability doesn't substitute for
local session credentials.

**Test file:** `phpoc-web/test/sync_service_test.mjs` Group H
**Status:** ✅ Existing, passes

---

### H2 — Empty specifier in local cookie → REAUTH_NEEDED

**What it asserts:**
```
Given: local cookie exists but device_specifier is empty string
When:  checkAndSync() is called
Then:  returns REAUTH_NEEDED
```

**Rationale:** An empty specifier is a malformed cookie — treated as invalid by
`DeviceCookie.isValidLocally()`. This falls through to the same `!localCookie`
branch in `_authGatePhase`, returning `REAUTH_NEEDED`. This is a defense-in-depth
assertion ensuring the cookie parsing doesn't accidentally treat empty specifiers
as valid.

**Test file:** `phpoc-web/test/sync_service_test.mjs` Group H
**Status:** ✅ Existing, passes

---

### H4 — Valid cookie within TTL + no MK → REAUTH_NEEDED

**What it asserts:**
```
Given: valid local cookie with good TTL, but no MK cached
When:  checkAndSync() is called
Then:  returns REAUTH_NEEDED
```

**Rationale:** A valid cookie without a master key means the crypto session was
destroyed (e.g., user logged out) but the cookie survived. Without MK, blob
decryption is impossible, so auth is required. This is handled by a separate
check (`!mk` → REAUTH_NEEDED) in `_authGatePhase`, not the `!localCookie` branch,
but it's part of the same auth gate logic.

**Test file:** `phpoc-web/test/sync_service_test.mjs` Group H
**Status:** ✅ Existing, passes

---

### H7 — MK cleared by TTL monitor → REAUTH_NEEDED

**What it asserts:**
```
Given: valid local cookie with good TTL, MK is cleared mid-session (TTL monitor)
When:  checkAndSync() is called
Then:  returns REAUTH_NEEDED
```

**Rationale:** Simulates the cookie TTL monitor clearing the MK when the TTL expires.
After MK is gone, `checkAndSync()` must demand re-authentication. This validates
that the TTL monitor → logout → re-auth chain works end-to-end with the auth gate.

**Test file:** `phpoc-web/test/sync_service_test.mjs` Group H
**Status:** ✅ Existing, passes

---

## Edge Cases Verified

| Edge case | Expected | Covered by |
|-----------|----------|------------|
| No cookie + MK cached + remote has same-device cookie | `REAUTH_NEEDED` | A2b |
| No cookie + MK cached + remote has different-device cookie | `REAUTH_NEEDED` | A2b (same path) |
| No cookie + MK cached + remote unreachable | `REAUTH_NEEDED` | A2b (transport state doesn't change auth gate) |
| No cookie + MK cached + genesis mismatch detected | `REAUTH_NEEDED` → genesis gate runs first, returns `GENESIS_MISMATCH` before auth gate | Genesis gate short-circuits |
| TTL-expired cookie (stale specifier) + MK cached | `REAUTH_NEEDED` | A4 + H7 |
| No cookie at all + no transport | `READY` (local-only) | Early return in `checkAndSync()` before auth gate |

---

## What Stage 1.1 Does NOT Change

| Unchanged behavior | Why |
|--------------------|-----|
| **Specifier mismatch → READY or REAUTH_NEEDED** | Different code path (C1/C2). Same device UUID can reconcile; different UUID requires auth. |
| **Cookie within TTL + matching specifier → READY** | Fast path in `_fastPathPhase` — unchanged. |
| **`_reconcileAndClaim()` internals** | Case A/B logic unchanged. Just harder to reach without explicit auth. |
| **Genesis gate logic** | Runs before auth gate, unchanged. |
| **Push-only (same device) path** | Only reached after explicit auth now, but behavior identical. |

---

## Test Suite Summary

All relevant assertions are in `phpoc-web/test/sync_service_test.mjs`:

| Test ID | Group | Assertion | Status |
|---------|-------|-----------|--------|
| A2 | Auth gate | No cookie at all → `REAUTH_NEEDED` | ✅ Pass |
| A2b | Auth gate | No cookie + cached MK → `REAUTH_NEEDED` (no bypass) | ✅ Pass |
| A3 | Auth gate | Valid cookie + no remote + no MK → `REAUTH_NEEDED` | ✅ Pass |
| A4 | Auth gate | Expired cookie → `REAUTH_NEEDED` | ✅ Pass |
| H1 | Edge | No cookie + no MK → `REAUTH_NEEDED` | ✅ Pass |
| H2 | Edge | Empty specifier → `REAUTH_NEEDED` | ✅ Pass |
| H4 | Edge | Valid cookie + no MK → `REAUTH_NEEDED` | ✅ Pass |
| H7 | Edge | MK cleared by TTL → `REAUTH_NEEDED` | ✅ Pass |
| C1/C2 | Mismatch | Specifier mismatch → READY or REAUTH_NEEDED | ✅ Pass |

**Total:** 10 assertions covering the no-cookie → REAUTH_NEEDED behavior.
**No new tests needed** for Stage 1.1 — the existing test suite fully validates the behavior.

---

## Implementation Status

**Stage 1.1 implementation:** ✅ Complete

The MK bypass was removed during commit `d351c05` (2026-06-30): "refactor(phpoc-web):
extract sync utilities + split checkAndSync into phases". The `_authGatePhase()`
method was extracted from the monolithic `checkAndSync()` and the bypass was
explicitly removed:

```diff
-    if (!localCookie) {
-      const mk = this._crypto.getMasterKey();
-      if (mk) {
-        return this._reconcileAndClaim(mk);
-      }
-      return SyncResult.REAUTH_NEEDED;
-    }
+    if (!localCookie) {
+      return SyncResult.REAUTH_NEEDED;
+    }
```

The comment "The cookie is the source of truth, not the cached crypto key.
This matches the CLI behavior." was moved to the method docstring.
