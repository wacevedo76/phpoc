/**
 * DevModeContext — development mode provider + auth bypass.
 *
 * In dev mode, bootstraps a full realistic stack:
 *   - DummyCryptoService (no WASM needed)
 *   - SyncService (real sync algorithm)
 *   - IndexedDBBackend (local cache, survives reloads)
 *   - MockRemoteBackend (simulated R2/S3, same interface as HttpTransport)
 *   - MockDataSeeder (generates 14 days of realistic staging entries)
 *
 * On first boot, the mock remote is seeded with a staging blob, device
 * cookie, and genesis block. The SyncService runs checkAndSync() to
 * pull the seeded data into the local cache, simulating a real sync
 * cycle. The result: a working app with realistic data that feels like
 * it's connected to a real remote backend.
 *
 * Switching to production (real Worker + WASM crypto):
 *   - Replace DummyCryptoService with real WASM CryptoService
 *   - Replace MockRemoteBackend with HttpTransport(workerUrl, apiKey)
 *   - Everything else works identically
 *
 * Dev mode activation: ?dev=true URL param, localStorage flag,
 * or toggle in Settings screen.
 */

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { DummyCryptoService } from '../services/DummyLedger.js';
import { SyncService, SyncResult, IndexedDBBackend, MockRemoteBackend } from '@sync/index.js';
import { seedMockRemote, inspectMockRemote } from '../services/MockDataSeeder.js';

// --------------------------------------------------------------------------
// Context
// --------------------------------------------------------------------------

const DevModeContext = createContext(null);

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/**
 * Detect whether dev mode should be active.
 */
function detectDevMode(defaultDevMode) {
  const urlParams = new URLSearchParams(
    typeof window !== 'undefined' ? window.location.search : ''
  );
  if (urlParams.get('dev') === 'false') return 'production';
  if (urlParams.get('dev') === 'true') return 'dev';
  const stored = typeof localStorage !== 'undefined'
    ? localStorage.getItem('phpoc_dev_mode')
    : null;
  return stored !== null ? stored : (defaultDevMode ? 'dev' : 'production');
}

// --------------------------------------------------------------------------
// Provider
// --------------------------------------------------------------------------

/**
 * @param {object} props
 * @param {React.ReactNode} props.children
 * @param {boolean} [props.defaultDevMode=true]
 */
export function DevModeProvider({ children, defaultDevMode = true }) {
  const [mode, setMode] = useState(() => detectDevMode(defaultDevMode));
  const isDev = mode === 'dev';

  const [services, setServices] = useState({
    crypto: null,
    sync: null,
    storage: null,
    mockRemote: null,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [devInfo, setDevInfo] = useState(null); // mock remote inspection data

  // Auth state
  const [user, setUser] = useState({
    isAuthenticated: isDev,
    deviceId: null,
    masterKeyCached: isDev,
  });

  // Track whether we've done the first sync (to avoid re-syncing on re-render)
  const didInitialSync = useRef(false);

  // Bootstrap services on mount or mode change
  useEffect(() => {
    let cancelled = false;

    async function boot() {
      setLoading(true);
      setError(null);
      didInitialSync.current = false;

      try {
        if (isDev) {
          // ── Dev mode: real SyncService + mock remote ──

          // 1. Create DummyCryptoService (no WASM needed)
          const crypto = await DummyCryptoService.create();
          crypto.setMasterKey('deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef');

          // 2. Create storage backends
          const storage = new IndexedDBBackend('phpoc-sync');
          const mockRemote = new MockRemoteBackend({ latencyMs: 30 });

          // 3. Seed mock remote with realistic data
          const deviceUuid = crypto.getDeviceId(crypto.getMasterKey());
          await seedMockRemote(mockRemote, crypto, {
            historyDays: 14,
            activeTasks: 2,
            deviceUuid,
          });

          // 4. Create real SyncService connected to mock remote
          const sync = new SyncService(storage, crypto, mockRemote, {
            cookieTtlMinutes: 60,
          });

          // 5. Bootstrap local cache: pull seeded data from mock remote
          //    We do this by setting up a matching cookie so checkAndSync()
          //    takes the fast path (same device, same specifier).
          const remoteCookieRaw = await mockRemote.pull('staging/blobs/device_cookie.bin');
          if (remoteCookieRaw) {
            const remoteCookie = JSON.parse(new TextDecoder().decode(remoteCookieRaw));
            // Create local cookie matching the remote one
            await storage.set('cookie', {
              device_specifier: remoteCookie.device_specifier,
              creation_time: Date.now(),
            });
          }

          // 6. Ensure CryptoService has master key cached
          crypto.setMasterKey('deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef');

          // 7. Run checkAndSync — fast path: cookie matches → READY
          //    Fast path pushes local (empty) blob to remote, which is fine
          //    because we already seeded the remote. But we want to PULL the
          //    seeded data INTO local. So we need a different approach:
          //
          //    Instead: manually pull the seeded blob and write to local cache.
          //    This simulates what would happen in a reconcile flow.
          const seededBlobBytes = await mockRemote.pull('staging/blobs/current.json');
          if (seededBlobBytes) {
            const seededBlob = JSON.parse(new TextDecoder().decode(seededBlobBytes));
            if (seededBlob.entries && Array.isArray(seededBlob.entries)) {
              // Convert raw entries to DTOs and write to local cache
              const dtos = seededBlob.entries.map(raw => ({
                entry_id: raw.entry_id || '',
                title: raw.title || '',
                start_epoch: raw.start_epoch || 0,
                end_epoch: raw.end_epoch || null,
                duration: raw.duration || 0,
                is_active: raw.is_active || false,
                is_paused: raw.is_paused || false,
                pauses: raw.pauses || [],
                tags: raw.tags || [],
                comment: raw.comment || null,
                media: raw.media || [],
                device_uuid: raw.device_uuid || '',
                end_device_uuid: raw.end_device_uuid || '',
                metadata: raw.metadata || {},
                hash: raw.hash || '',
              }));
              await sync._local.writeEntries(dtos);
            }
          }

          // 8. Now checkAndSync should return READY (cookie match + data in local)
          try {
            const result = await sync.checkAndSync(300);
            if (result === SyncResult.REAUTH_NEEDED) {
              // Shouldn't happen with our cookie setup, but handle gracefully
              console.warn('Dev mode: checkAndSync returned REAUTH_NEEDED — continuing anyway');
            }
          } catch (syncErr) {
            console.warn('Dev mode: checkAndSync warning:', syncErr.message);
          }

          // 9. Inspect mock remote for dev info display
          try {
            const info = await inspectMockRemote(mockRemote);
            if (!cancelled) setDevInfo(info);
          } catch {
            // Non-critical
          }

          if (!cancelled) {
            setServices({
              crypto,
              sync,
              storage,
              mockRemote,
            });
            setUser({
              isAuthenticated: true,
              deviceId: deviceUuid,
              masterKeyCached: true,
            });
          }
        } else {
          // ── Production mode — not yet implemented ──
          throw new Error('Production mode not yet implemented. Use dev mode.');
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message);
          // Fall back to basic dummy services so the UI still works
          try {
            const fallbackCrypto = new DummyCryptoService();
            const { DummySyncService } = await import('../services/DummyLedger.js');
            const fallbackSync = new DummySyncService(fallbackCrypto);
            if (!cancelled) {
              setServices({
                crypto: fallbackCrypto,
                sync: fallbackSync,
                storage: fallbackSync._storage,
                mockRemote: null,
              });
              setUser({
                isAuthenticated: true,
                deviceId: 'dev-dummy-fallback',
                masterKeyCached: true,
              });
            }
          } catch {
            // Last-resort fallback: leave services null, show error
          }
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    boot();
    return () => { cancelled = true; };
  }, [mode]);

  // Toggle dev/production
  const toggleMode = useCallback(() => {
    const next = mode === 'dev' ? 'production' : 'dev';
    setMode(next);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('phpoc_dev_mode', next);
    }
  }, [mode]);

  // Login
  const login = useCallback(async () => {
    if (isDev) return true;
    throw new Error('Production auth not yet implemented');
  }, [isDev]);

  // Logout
  const logout = useCallback(() => {
    if (services.crypto) {
      services.crypto.clearMasterKey();
    }
    setUser({ isAuthenticated: false, deviceId: null, masterKeyCached: false });
  }, [services.crypto]);

  // Inspect mock remote (for dev tools)
  const refreshDevInfo = useCallback(async () => {
    if (services.mockRemote) {
      try {
        const info = await inspectMockRemote(services.mockRemote);
        setDevInfo(info);
      } catch {
        // ignore
      }
    }
  }, [services.mockRemote]);

  const contextValue = {
    mode,
    isDev,
    toggleMode,
    loading,
    error,
    services,
    user,
    devInfo,
    refreshDevInfo,
    login,
    logout,
  };

  return (
    <DevModeContext.Provider value={contextValue}>
      {children}
    </DevModeContext.Provider>
  );
}

// --------------------------------------------------------------------------
// Hook
// --------------------------------------------------------------------------

/**
 * Access the app context — services, auth state, dev mode controls.
 *
 * @returns {{
 *   mode: 'dev'|'production',
 *   isDev: boolean,
 *   toggleMode: () => void,
 *   loading: boolean,
 *   error: string|null,
 *   services: { crypto: object|null, sync: object|null, storage: object|null, mockRemote: object|null },
 *   user: { isAuthenticated: boolean, deviceId: string|null, masterKeyCached: boolean },
 *   devInfo: object|null,
 *   refreshDevInfo: () => Promise<void>,
 *   login: () => Promise<boolean>,
 *   logout: () => void,
 * }}
 */
export function useApp() {
  const ctx = useContext(DevModeContext);
  if (!ctx) {
    throw new Error('useApp() must be used within a <DevModeProvider>');
  }
  return ctx;
}
