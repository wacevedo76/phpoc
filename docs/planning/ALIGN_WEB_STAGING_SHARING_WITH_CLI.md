# Plan: Align phpoc-web Staging Sharing with CLI Behavior

> **Status:** ✅ Complete — Phase 1a (Stages 1.1–1.5) implemented.
> **Created:** 2026-06-29
> **Updated:** 2026-07-04 — Stage 1.5: test coverage consolidation (47 tests, 8 error-path additions, audit complete)
> **Goal:** Make the web client's staging sharing behavior identical to the CLI's
> multi-machine sharing pattern: auth → update cookie → update TTL → pull remote
> staging → compare with local → reconcile if necessary.

---

## Context

The CLI (`docs/design/workflows/cli/CLI_Staging_Interaction-Workflow.md`) and the
Cross-Device protocol (`docs/design/workflows/Cross_Device_Staging-Workflow.md`)
share the same underlying staging protocol — both push/pull the same R2 paths,
use identical merge logic, device cookies, and obfuscation. However, the **auth
gate behavior** and **re-auth flow** differ between the two implementations.

### How the CLI Handles Cross-Machine Staging

When Machine B (CLI) starts up and Machine A wrote to staging:

```
ph add start "Task"
  │
  ├─ check_and_sync() → cookie mismatch or no cookie → REAUTH_NEEDED
  ├─ auth.login() → user enters passphrase → MK derived
  ├─ StagingService._reconcile_and_claim(mk):
  │     ├─ pullCookie() → discover remote device_uuid ≠ local
  │     ├─ pullBlob(mk) → deobfuscate remote staging
  │     ├─ MergeEngine.merge(local, remote)
  │     ├─ write_entries(merged) → update local staging.json
  │     ├─ push_blob_only(mk) → push merged to R2
  │     └─ DeviceCookie.create(device_id) + push_cookie()
  │         → fresh specifier, updated TTL → READY ✅
  └─ Proceed with local write
```

**Key behaviors:**
1. `check_and_sync()` returns `REAUTH_NEEDED` when **no local cookie exists** — even if a valid MK is cached (the cookie is the truth, not the crypto key)
2. The caller handles `REAUTH_NEEDED` by prompting for passphrase, deriving MK, rebuilding `StagingService` with fresh crypto, then calling `_reconcile_and_claim(mk)`
3. `_reconcile_and_claim()` always pulls remote blob (on Case B), merges, pushes merged result, AND creates a fresh device cookie with updated TTL
4. After reconcile succeeds, the command proceeds — no logout, no landing screen redirect

### How the Web Currently Handles It

```
Web app loads (no cookie, cached MK from earlier login):
  │
  ├─ checkAndSync():
  │     ├─ Genesis gate runs inline → GENESIS_MISMATCH possible
  │     ├─ No local cookie? → MK cached?
  │     │     └─ Yes → _reconcileAndClaim(mk)  ← AUTO-RECONCILE (no re-auth!)
  │     └─ Specifier mismatch → REAUTH_NEEDED ✅ (correct)
  │
  ├─ bootstrapServices() (login path):
  │     ├─ checkAndSync() runs
  │     └─ If no cookie → DeviceCookie.create('local', ...) ← fallback cookie
  │
  ├─ handleTtlExpiry (cookie expires):
  │     └─ Full logout → landing screen ← DESTRUCTIVE
  │
  └─ SyncSettings "Sync Now":
        └─ checkAndSync() → REAUTH_NEEDED
              → "Authentication required. Log out and log back in." ← NO RE-AUTH FLOW
```

## Behavioral Gaps

### Gap A: Web auto-reconciles when MK cached and no cookie exists

| | CLI (`service.py`) | Web (`sync.js`) |
|---|---|---|
| **No local cookie** | Always `REAUTH_NEEDED` | If MK cached → `_reconcileAndClaim(mk)` (bypasses auth) |
| **Rationale** | Cookie is the truth — session cache insufficient | Optimization for fresh device after onboarding |

**Root cause** (`phpoc-web/src/sync/sync.js` lines ~527-534):
```js
if (!localCookie) {
    const mk = this._crypto.getMasterKey();
    if (mk) {
        return this._reconcileAndClaim(mk);  // ← bypasses REAUTH_NEEDED
    }
    return SyncResult.REAUTH_NEEDED;
}
```

**CLI equivalent** (`domain/staging/service.py` lines ~539-541):
```python
if local_cookie is None:
    return SyncCheckResult.REAUTH_NEEDED  # ← always
```

### Gap B: Web has no re-auth + reconcile flow

When the web DOES return `REAUTH_NEEDED` (specifier mismatch), both SyncSettings
and the cookie TTL monitor lack a re-auth path:

- **SyncSettings**: Shows static message "Log out and log back in" — no passphrase prompt, no rebuild, no reconcile
- **TTL expiry**: Calls `handleTtlExpiry` → full logout to landing screen — destroys session instead of reconciling

**CLI equivalent** (`main.py` lines ~640-672):
```python
result = staging_service.check_and_sync()
if result == SyncCheckResult.REAUTH_NEEDED:
    if not auth.login():              # ← prompt for passphrase
        exit(1)
    mk = auth.get_key()
    fresh_crypto = CryptoManager(mk)  # ← rebuild with fresh crypto
    staging_service = StagingService(...)
    staging_service._reconcile_and_claim(mk)  # ← reconcile
    # rebuild ledger_engine + cli with fresh crypto
    # continue with the command
```

### Gap C: Web's genesis gate runs inline in `checkAndSync()`

| | CLI | Web |
|---|---|---|
| **Genesis check location** | `ph sync` orchestrator (`_sync_ledger_blocks()`) | Inside `checkAndSync()` |
| **Returns** | `SyncCheckResult` has 3 values: `READY`, `OFFLINE`, `REAUTH_NEEDED` | `SyncResult` has 4: adds `GENESIS_MISMATCH` |
| **Impact** | Staging sync is unblocked by genesis issues | Staging sync returns `GENESIS_MISMATCH` before blob ops |

This is a design divergence. The CLI keeps genesis verification scoped to `ph sync`
(ledger commit operations). The web runs it every time `checkAndSync()` is called
(every staging operation). This could be left as-is for now since both approaches
are valid, but it introduces an extra return value the re-auth flow must handle.

### Gap D: Web creates fallback cookie on bootstrap

`bootstrapServices()` creates `DeviceCookie.create('local', storage, crypto)` when
no cookie exists, to prevent the TTL monitor from clearing the MK. This is a web-only
workaround. The CLI handles this by returning `REAUTH_NEEDED` and letting the user
re-authenticate.

## Plan

### Phase 1: Align `checkAndSync()` Auth Gate (sync.js) ✅

**Status:** ✅ Implemented in `d351c05` (2026-06-30). Test requirements documented at
`docs/planning/tmp/STAGE_1_1_TEST_REQUIREMENTS.md`.

**Change:** Remove the MK-cached bypass. When no local cookie exists, always return
`REAUTH_NEEDED` regardless of whether a master key is cached.

**File:** `phpoc-web/src/sync/sync.js` ~lines 527-534

**Before:**
```js
if (!localCookie) {
    const mk = this._crypto.getMasterKey();
    if (mk) {
        return this._reconcileAndClaim(mk);
    }
    return SyncResult.REAUTH_NEEDED;
}
```

**After:**
```js
if (!localCookie) {
    return SyncResult.REAUTH_NEEDED;
}
```

**Test impact:** Group K (Transport Reconfiguration) and Group M (Genesis Merge) tests
in `sync_service_test.mjs` may need updates. Any test that relied on the bypass
path will now see `REAUTH_NEEDED` instead of direct reconcile.

**Risk:** Low. The reconcile path is unchanged — it just requires explicit auth first.
This matches the CLI behavior exactly.

### Phase 2: Add Re-Auth + Reconcile Flow to Web

The web needs a **passphrase re-auth component** that:
1. Shows a passphrase input overlay (not a full login screen)
2. Derives the MK from passphrase + stored seed (same as `login()` but without clearing services)
3. Calls `sync._reconcileAndClaim(mk)` — which pulls remote blob, merges, pushes, creates fresh cookie
4. On success: dismiss overlay, resume operation
5. On failure: show error, allow retry

**New component:** `ReauthOverlay.jsx` (or restore the concept that was removed in 2026-06-28, but with reconcile logic)

**Wire into:**

| Trigger | Current behavior | New behavior |
|---|---|---|
| `checkAndSync()` → `REAUTH_NEEDED` (SyncSettings "Sync Now") | Static message "Log out and log back in" | Show re-auth overlay → derive MK → `_reconcileAndClaim(mk)` → re-run `checkAndSync()` |
| `checkAndSync()` → `REAUTH_NEEDED` (auto-sync / page load) | N/A (not currently called on page load except bootstrap) | Show re-auth overlay → reconcile → auto-sync continues |
| Cookie TTL expiry | Full logout to landing screen | Show re-auth overlay → reconcile → continue (same as CLI TTL expiry on `ph view`) |

**Note on TTL expiry:** The CLI returns `REAUTH_NEEDED` on TTL expiry for both read
and write commands. The web's cookie monitor currently calls `handleTtlExpiry` which
is destructive (logout). Instead, it should trigger the re-auth overlay. If the user
dismisses without authenticating, then fall back to read-only mode (clear MK, show
entries that don't need decryption).

**File changes:**
- **New:** `phpoc-web/src/components/overlays/ReauthOverlay.jsx` — passphrase prompt
- **Modified:** `phpoc-web/src/context/DevModeContext.jsx` — add `triggerReauth` state + handler, change `handleTtlExpiry` to trigger re-auth instead of logout
- **Modified:** `phpoc-web/src/components/screens/SyncSettings.jsx` — replace static message with re-auth trigger
- **Modified:** `phpoc-web/src/App.jsx` — render `ReauthOverlay` when re-auth is active

### Phase 3: Remove Fallback Cookie on Bootstrap

Once `checkAndSync()` consistently returns `REAUTH_NEEDED` when no cookie exists,
the fallback cookie creation in `bootstrapServices()` is no longer needed.

**File:** `phpoc-web/src/context/DevModeContext.jsx` ~lines 405-425

**Change:** Remove the `DeviceCookie.create('local', ...)` block. The cookie TTL
monitor should handle the no-cookie case gracefully (skip check, don't expire).

**Alternative:** Keep it for local-only (no transport) case — the CLI also creates
a local cookie via `DeviceCookie.create_local()` for TTL tracking. Only remove
the web-specific `'local'` deviceUuid fallback — replace with proper device UUID.

### Phase 4: Handle `GENESIS_MISMATCH` in Re-Auth Flow (if kept inline)

If genesis gate stays inline in `checkAndSync()`, the re-auth flow must handle
`GENESIS_MISMATCH` as a return value:

| `checkAndSync()` returns | Re-auth overlay action |
|---|---|
| `READY` | Dismiss overlay, resume |
| `OFFLINE` | Show offline warning, allow local-only continuation |
| `REAUTH_NEEDED` | Show passphrase prompt |
| `GENESIS_MISMATCH` | Show genesis mismatch panel (existing "Clear Remote & Overwrite" flow) |

### Phase 5: Test Coverage

| Test group | Scope |
|---|---|
| `checkAndSync()` no-cookie → `REAUTH_NEEDED` | Verify MK bypass removed; always returns `REAUTH_NEEDED` when no cookie |
| `ReauthOverlay` component tests | Passphrase input → MK derivation → `_reconcileAndClaim()` call → dismiss |
| `SyncSettings` re-auth integration | "Sync Now" → `REAUTH_NEEDED` → re-auth → retry → `READY` |
| `DevModeContext` re-auth state | `triggerReauth` → overlay visible → auth success → services updated → overlay hidden |
| TTL expiry → re-auth | Cookie monitor `onExpired` → re-auth overlay → not full logout |
| Cross-device scenario (E2E) | CLI writes → Web loads → cookie mismatch → re-auth → merge → entries visible |

### Files to Touch (Summary)

| File | Phase | Change |
|---|---|---|
| `phpoc-web/src/sync/sync.js` | 1 | Remove MK bypass: no cookie → `REAUTH_NEEDED` always |
| `phpoc-web/src/components/overlays/ReauthOverlay.jsx` | 2 | **NEW** — Passphrase prompt component |
| `phpoc-web/src/context/DevModeContext.jsx` | 2, 3 | Add `triggerReauth` state + handler; change TTL expiry; remove fallback cookie |
| `phpoc-web/src/components/screens/SyncSettings.jsx` | 2 | Replace static REAUTH message with re-auth trigger |
| `phpoc-web/src/App.jsx` | 2 | Render `ReauthOverlay` |
| `phpoc-web/test/sync_service_test.mjs` | 5 | Update tests for new auth gate behavior |
| `phpoc-web/test/reauth_ttl_test.mjs` | 5 | Update TTL tests for re-auth overlay instead of full logout |
| `phpoc-web/test/reauth_integration_test.mjs` | 5 | Update or add integration tests |
| **NEW** `phpoc-web/test/reauth_overlay_test.mjs` | 5 | Component tests for ReauthOverlay |

### What Does NOT Change

- **Merge engine** — identical algorithm, no changes needed
- **Device cookie format** — identical across CLI/Web
- **Blob obfuscation** — identical (WASM ↔ Python)
- **Remote paths** — same R2 keys
- **`_reconcileAndClaim()` internals** — Case A/B logic is already correct
- **Auto-sync (`useAutoSync`)** — push mechanics unchanged; gate behavior changes upstream
- **Export/import flow** — no staging sharing involved

### Phase Dependencies

```
Phase 1 (align auth gate)
    │
    ▼
Phase 2 (add re-auth overlay)
    │
    ├──▶ Phase 3 (remove fallback cookie)
    │
    └──▶ Phase 4 (handle GENESIS_MISMATCH in re-auth)
              │
              ▼
         Phase 5 (test coverage)
```

Phases 1–2 are the critical path. Phase 3 is a cleanup enabled by Phase 1.
Phase 4 is a consideration based on whether genesis gate remains inline or
is separated (deferred decision). Phase 5 runs alongside implementation.

### Comparison to CLI Behavior (Goal State)

| Behavior | CLI | Web (after plan) |
|---|---|---|
| No cookie + cached MK → checkAndSync result | `REAUTH_NEEDED` | `REAUTH_NEEDED` ✅ |
| Specifier mismatch → checkAndSync result | `REAUTH_NEEDED` | `REAUTH_NEEDED` ✅ (already correct) |
| `REAUTH_NEEDED` → user flow | Passphrase prompt → MK derivation → rebuild + reconcile | Passphrase overlay → MK derivation → reconcile ✅ |
| After reconcile → cookie created? | Yes (fresh specifier) | Yes (fresh specifier) ✅ (already correct) |
| After reconcile → TTL updated? | Yes (creation_time = now) | Yes (creation_time = now) ✅ (already correct) |
| TTL expired → user flow | `REAUTH_NEEDED` → passphrase prompt | Re-auth overlay → reconcile (not full logout) ✅ |
| Pull remote blob on reconcile? | Yes (Case B: different device) | Yes (Case B: different device) ✅ (already correct) |
| Merge remote + local? | Yes (MergeEngine.merge) | Yes (mergeEntries) ✅ (already correct) |
| Genesis gate in checkAndSync? | No (in `ph sync`) | Yes (inline) ⚠️ (deferred — Phase 4) |

### Deferred Decisions

1. **Separate genesis gate from `checkAndSync()`?** — The CLI runs genesis
   verification during `ph sync`, not staging operations. Moving it out of
   the web's `checkAndSync()` would:
   - Simplify the SyncCheckResult enum (remove `GENESIS_MISMATCH`)
   - Make staging sync always proceed regardless of genesis state
   - Require a separate genesis check call in `SyncSettings` "Sync Now" flow
   - This is a larger refactor — defer to a separate plan if needed.

2. **Fallback cookie for local-only?** — The web creates a `'local'` deviceUuid
   cookie to prevent TTL monitor false positives. The CLI creates
   `DeviceCookie.create_local()` with proper UUID generation. After Phase 1,
   decide whether to:
   - Port `create_local()` to the web (proper UUID from WASM)
   - Or let the TTL monitor handle no-cookie gracefully
   - Or keep the web-specific fallback for local-only only
