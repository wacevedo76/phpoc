# Plan: Stop Re-Rolling Device Cookie on Same-Device Writes

> **Status:** 🔜 Planning
> **Created:** 2026-06-29
> **Problem:** Web app's `pushToRemote()` creates a brand-new `device_specifier` on every write, causing the CLI to see a specifier mismatch and lock out read commands.

---

## Symptom

```
User starts task in web app → web pushes blob + NEW cookie → 
User runs `ph view` in CLI → cookie mismatch → REAUTH_NEEDED →
"Remote staging is held by a different device" → task doesn't show
```

## Root Cause

`pushToRemote()` in `phpoc-web/src/sync/sync.js` unconditionally calls `_pushCookie(deviceId)`, which calls `DeviceCookie.create()` — and `create()` always generates a **new random specifier**:

```js
// cookie.js line 56
static async create(deviceId, storage, crypto) {
  const specifier = crypto.generateDeviceSpecifier();  // ← NEW every time!
  // ...
}
```

The same physical device (same `device_uuid`) re-claims staging ownership on every single write. The cookie's `device_specifier` is supposed to be stable across a device session — it should only change on re-auth or when a genuinely different device takes over.

**Comparison to CLI:** The CLI's `push_blob_only()` (used during sync/reconcile) does NOT push a new cookie. The CLI only pushes a cookie during `_reconcile_and_claim()` Case B (different device). After that, the same device just pushes the blob via `push_blob_only()`. The specifier stays stable.

## Fix

### Web App: `_pushCookie()` → reuse existing specifier

When `pushToRemote()` fires and the local storage already has a valid cookie with a `device_specifier`:

1. Read the existing local cookie's specifier
2. Reuse it in the remote cookie (just update `creation_time`)
3. Only generate a NEW specifier when no local cookie exists (first push after onboarding/re-auth)

**File:** `phpoc-web/src/sync/sync.js` — `pushToRemote()` and `_pushCookie()`

**Before (problematic):**
```js
async pushToRemote(masterKeyHex) {
  if (!this._remote) return;
  const entries = await this._local.readEntries();
  const deviceId = await this._getDeviceId() || 'unknown';
  await this._remote.pushBlob(entries, deviceId, masterKeyHex);

  // Always destroys + creates new cookie — specifier changes every push
  try {
    await DeviceCookie.destroyLocally(this._storage);
    await this._pushCookie(deviceId);
  } catch (err) {
    console.warn('Device cookie push failed:', err.message);
  }
  this._lastPushAt = Date.now();
}

async _pushCookie(deviceId) {
  const remoteCookie = await DeviceCookie.create(
    deviceId, this._storage, this._crypto
  );  // ← generates NEW specifier every call
  if (remoteCookie) {
    const cookieBytes = new TextEncoder().encode(
      JSON.stringify(remoteCookie)
    );
    await this._remote.pushCookie(cookieBytes);
  }
}
```

**After (stable specifier):**
```js
async pushToRemote(masterKeyHex) {
  if (!this._remote) return;
  const entries = await this._local.readEntries();
  const deviceId = await this._getDeviceId() || 'unknown';
  await this._remote.pushBlob(entries, deviceId, masterKeyHex);

  // Push cookie with EXISTING specifier if available — don't re-roll
  try {
    const existingCookie = await this._storage.get('cookie');
    let specifier;
    if (existingCookie?.device_specifier) {
      specifier = existingCookie.device_specifier;
      // Update creation_time, keep specifier
      await this._storage.set('cookie', {
        device_specifier: specifier,
        creation_time: Date.now(),
      });
    } else {
      // First push — generate new specifier
      const remoteCookie = await DeviceCookie.create(
        deviceId, this._storage, this._crypto
      );
      specifier = remoteCookie?.device_specifier;
    }

    // Push remote cookie with the specifier (old or new)
    if (specifier) {
      const cookieBytes = new TextEncoder().encode(
        JSON.stringify({ device_uuid: deviceId, device_specifier: specifier })
      );
      await this._remote.pushCookie(cookieBytes);
    }
  } catch (err) {
    console.warn('Device cookie push failed:', err.message);
  }
  this._lastPushAt = Date.now();
}
```

### What stays in `_pushCookie()`?

`_pushCookie()` is still used by `_reconcileAndClaim()` Case B — the cross-device takeover path. That path intentionally creates a NEW specifier because a different device is claiming staging. No changes needed there.

**So:** `pushToRemote()` (same-device write) reuses the specifier. `_reconcileAndClaim()` Case B (cross-device) creates a new one. Correct semantics.

### CLI: No change needed

The CLI already reuses the specifier. `_push_on_fast_path()` calls `push_blob_only()` which doesn't push a cookie. `_reconcile_and_claim()` Case B calls `DeviceCookie.create()` which creates a fresh one — intentional for cross-device takeover. This is the correct behavior the web app should match.

## Edge Cases

| Scenario | Behavior |
|---|---|
| First push after onboarding (no local cookie) | Create new specifier (correct — first device claim) |
| Second push, same device, same session | Reuse existing specifier (fixed — was re-rolling) |
| Cross-device takeover (`_reconcileAndClaim` Case B) | Create new specifier (correct — new device) |
| TTL expired → re-auth → same device | Re-auth flow creates fresh cookie (new specifier) — correct, session boundary |
| Auto-sync debounce window | Multiple writes within 500ms → one push → specifier reused once (correct) |

## Test Impact

| Test group | Change |
|---|---|
| `_pushOnFastPath` tests | No change — fast path uses `pushBlobOnly`, doesn't push cookie |
| `pushToRemote` tests (if any) | Update to verify specifier stability across multiple pushes |
| `_reconcileAndClaim` Case B tests | No change — still creates new specifier for cross-device |
| Clear remote + re-push | Should reuse specifier after clear + re-onboard |

## Files to Touch

| File | Change |
|---|---|
| `phpoc-web/src/sync/sync.js` | Modify `pushToRemote()` to reuse existing specifier instead of calling `_pushCookie()` |
| `phpoc-web/test/sync_service_test.mjs` | Update any `pushToRemote` tests to verify specifier stability |

## Relation to Existing Plans

- **ALIGN_WEB_STAGING_SHARING_WITH_CLI.md** covers the auth gate + re-auth flow. This plan covers a different issue: cookie stability within the same device session. Both are needed but address different gaps.
- Once this fix is in place, the web app's cookie behavior matches the CLI's: same device = stable specifier, different device = new specifier.
