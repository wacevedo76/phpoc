# SyncService Transport Reconfiguration — Tradeoff Analysis

> **Status:** ✅ DECIDED — Solution B implemented  
> **Date:** 2026-06-25  
> **Resolution:** `reconfigure(transport)` method on SyncService, called from Settings after genesis check. 6 new tests (Group K, all GREEN). Browser E2E verified.  
> **Context:** Settings Genesis Gate E2E testing (Category C, C2 failure)  
> **Bug:** Changing Worker URL/API key in Settings updates `localStorage` but does not update the SyncService's transport instance. The SyncService is configured during bootstrap and caches its `HttpTransport` + `RemoteSync` wrapper. After Settings → Save → navigate to Sync → "Sync Now", the SyncService still uses the stale transport. `checkAndSync()` returns OFFLINE because the transport pulls from the old config.

---

## Architecture Context

```
Bootstrap (DevModeContext.bootstrapServices)
  → createTransportFromDeployment() → reads localStorage → HttpTransport(baseUrl, apiKey)
  → new SyncService(storage, crypto, transport)
       → this._transport = transport         // stored once
       → this._remote = new RemoteSync(...)  // built once

Settings Save (handleSaveRemote)
  → localStorage.setItem('phpoc_worker_url', ...)  // updates store
  → BUT: SyncService._transport NOT updated        // 🐛 the bug

Sync Now (checkAndSync)
  → GenesisGate.check(blocks, this._transport, ...)  // uses STALE transport
  → this._remote.*(...)                                // uses STALE transport
```

**Two things are stale:** `this._transport` (raw HttpTransport, used for genesis checks and ledger push) and `this._remote` (RemoteSync wrapper, used for staging blob operations). Both are built once in the constructor and never refreshed. Any fix must handle both objects.

### Current code paths that use stale transport

| File | Method | Transport usage |
|------|--------|-----------------|
| `sync.js:432` | `checkAndSync()` | `GenesisGate.check(blocks, this._transport, ...)` |
| `sync.js:464-558` | `checkAndSync()` | `this._remote.*` for staging blob operations |
| `sync.js:917` | `pushLedgerBlocks()` | `this._transport.listFiles()` + `this._transport.push()` |
| `sync.js:816-880` | `pushToRemote()` | `this._remote.pushBlob()` |

---

## Solution A: SyncService reads config from localStorage on each operation

The SyncService re-reads `localStorage` internally before every network call, creating a new transport + RemoteSync if the config changed.

### What changes

```js
// New private method
_resolveTransport() {
  const url = localStorage.getItem('phpoc_worker_url') || '';
  const key = localStorage.getItem('phpoc_api_key') || null;
  const cacheKey = `${url}::${key}`;
  
  if (this._transportCacheKey === cacheKey) {
    return { transport: this._transport, remote: this._remote };
  }
  
  // Config changed — recreate
  this._transport = url ? new HttpTransport({ baseUrl: url, apiKey: key }) : null;
  this._remote = this._transport ? new RemoteSync(this._transport, this._crypto) : null;
  this._transportCacheKey = cacheKey;
  this.resetGenesisGate();  // invalidate genesis cache on config change
  
  return { transport: this._transport, remote: this._remote };
}

// In every method that uses transport:
async checkAndSync(timeoutMs = 500) {
  const { transport, remote } = this._resolveTransport();
  // ... use transport/remote instead of this._transport/this._remote
}
```

### Pros

- **Zero cross-component coordination.** Settings writes to localStorage, SyncService picks it up. No wiring needed.
- **Survives any config source.** If config ever comes from URL params, IndexedDB, or a future React Native module — as long as it lands in localStorage before SyncService reads, it works.
- **No props drilling.** Settings → DevModeContext → SyncService chain not needed.
- **Self-healing after bootstrap.** If `createTransportFromDeployment()` created a null transport (no Worker configured at bootstrap), later Settings changes are picked up without re-bootstrap.

### Cons

- **Hidden dependency on global mutable state.** SyncService constructor says `(storage, crypto, transport)` but the transport parameter becomes only an initial value, silently overridden by localStorage reads. Violates principle of least surprise.
- **Synchronous localStorage reads on every operation.** `localStorage.getItem()` is sync and blocks the main thread. Realistically microsecond-level, but a code smell for a service that otherwise avoids global state.
- **Testing burden.** Every test that creates a SyncService with a mock transport must either set `localStorage` before the test (polluting global state between tests), mock `window.localStorage` (extra setup per test file), or add a `_bypassLocalStorage` flag just for tests (leaks test concerns into production code). The current 60+ SyncService tests would need retrofitting.
- **Timing edge cases.** If Settings hasn't finished writing to localStorage when SyncService reads (rapid save→sync clicks), SyncService gets the old config. Unlikely in practice (React batches state, localStorage writes are sync) but adds a class of bugs that doesn't exist with explicit injection.
- **Caching invalidation complexity.** SyncService must track when localStorage changed to avoid creating a new transport on every network call. Adds `_transportCacheKey` state and comparison logic to an otherwise stateless read path.
- **Genesis gate coupling.** `this._genesisCompatible` cache must be invalidated when transport changes (different remote → different genesis). SyncService must detect config drift and call `resetGenesisGate()` internally, coupling transport resolution to genesis logic.

---

## Solution B: Expose `reconfigure(transport)` on SyncService

DevModeContext calls `sync.reconfigure(newTransport)` when it detects Settings changes.

### What changes

**SyncService** (~10 lines):

```js
/**
 * Replace the active transport with a new one.
 * Call after Settings changes the Worker URL or API key.
 * Invalidates genesis gate cache since the remote may differ.
 *
 * @param {HttpTransport|null} transport
 */
reconfigure(transport) {
  this._transport = transport || null;
  this._remote = transport 
    ? new RemoteSync(transport, this._crypto) 
    : null;
  this.resetGenesisGate();
}
```

**Settings.jsx** `handleSaveRemote` (~3 lines added after genesis check):

```js
// After saving config, push the new transport into SyncService
if (services.sync?.reconfigure) {
  const newTransport = createRemoteTransport({ 
    deployment: 'saas', 
    config: { baseUrl: workerUrl, apiKey } 
  });
  services.sync.reconfigure(newTransport);
}
```

### Pros

- **Clean constructor contract.** `new SyncService(storage, crypto, transport)` means exactly what it says. No hidden global state.
- **Trivially testable.** Tests call `sync.reconfigure(mockTransport2)` — no localStorage mocking, no global state leakage. Existing 60+ tests unchanged.
- **Explicit lifecycle.** Reconfiguration is an intentional, traceable action. Loggable, guardable, debuggable.
- **Genesis gate invalidation is natural.** `reconfigure()` calls `resetGenesisGate()` inline — no need to detect config drift in a separate layer.
- **No synchronous localStorage reads in hot paths.** Transport resolved once, passed by reference.
- **Safe null fallback.** `reconfigure(null)` gracefully degrades to local-only mode — same behavior as constructor.
- **Follows existing codebase pattern.** SyncService already exposes `resetGenesisGate()` (line 978) for explicit cache invalidation. `reconfigure()` extends this pattern naturally.

### Cons

- **Cross-component wiring.** Settings → DevModeContext → SyncService requires a communication path. Settings already accesses `services` from context (`useApp()`), so the simplest approach is Settings calling `services.sync.reconfigure(newTransport)` directly — but this couples Settings to SyncService's method signature.
- **Settings must create the transport.** Settings already imports and calls `createRemoteTransport()` for the genesis check (line 203 of Settings.jsx). The transport creation is already happening — the result is just discarded after the check. Saving and reusing it for `reconfigure()` reuses existing work.
- **New paths to miss.** If Worker config changes from another source (URL param, future import flow, direct IndexedDB manipulation), each source must also call `reconfigure()`. Mitigation: document in SyncService JSDoc that transport changes require calling `reconfigure()`.
- **Bootstrap coupling.** `bootstrapServices()` creates transport → creates SyncService. If bootstrap is refactored, the `reconfigure()` contract must be preserved.

---

## Solution C (Hybrid): DevModeContext watches localStorage, calls `reconfigure()`

DevModeContext owns config-change detection (watching localStorage), SyncService exposes clean `reconfigure()`.

### What changes

**DevModeContext** adds a mechanism (e.g., `useEffect` polling or a callback from Settings) to detect localStorage changes and call `syncRef.current.reconfigure(newTransport)`.

**SyncService** gets the same `reconfigure()` method as Solution B.

### Pros

- Keeps SyncService clean (same as B)
- Keeps Settings simple (just writes to localStorage, no knowledge of DevModeContext internals)
- Centralizes config-change detection in the component that already owns service lifecycle

### Cons

- Polling or event-based detection adds complexity in DevModeContext
- localStorage `storage` event only fires for cross-tab changes, not same-tab — needs manual comparison
- DevModeContext is already large (~1400 lines) — adding config-watching further increases its responsibility
- Equivalent to Solution B with an extra indirection layer — if Settings already calls `handleSaveRemote`, it can just as easily call `reconfigure()` at the end

---

## Recommendation: Solution B — `reconfigure()` method

**Rationale:**

1. **Follows existing codebase pattern.** SyncService already has `resetGenesisGate()` for explicit cache invalidation. `reconfigure()` extends this same pattern.

2. **Settings already creates the transport.** `handleSaveRemote` line 203 calls `createRemoteTransport()` for the genesis check. The transport object is already constructed — it's just discarded after the check. Passing it to `reconfigure()` reuses existing work (3 lines added).

3. **Testable without global state.** All 60+ SyncService tests pass mock transports. Solution A would require retrofitting them. Solution B leaves them untouched.

4. **Settings→SyncService coupling is minimal.** Settings already calls `services.sync.checkAndSync()` indirectly. Adding `services.sync.reconfigure(newTransport)` is the same access pattern.

5. **Self-documenting.** `reconfigure()` with JSDoc makes the transport lifecycle explicit — anyone reading SyncService knows transport can change and what happens when it does (genesis cache cleared, RemoteSync recreated).

### Implementation plan (estimated ~15 LOC across 2 files)

| File | Change | LOC |
|------|--------|-----|
| `phpoc-web/src/sync/sync.js` | Add `reconfigure(transport)` method | +10 |
| `phpoc-web/src/components/screens/Settings.jsx` | Call `reconfigure()` after genesis check | +3 |
| `phpoc-web/test/sync_service_test.mjs` | Add 3 tests (reconfigure updates transport, null degrades, genesis cache cleared) | +30 |

---

## Decision Pending

- [x] Choose Solution A, B, or C (recommendation: B) → **Chose B**
- [x] Implement chosen solution → **16 LOC across 2 files**
- [x] Re-run Category C E2E test C2 → **PASS** (Sync Now uses new transport)
- [x] Re-run full test suite for regressions → **207 JS assertions, 0 failures**
