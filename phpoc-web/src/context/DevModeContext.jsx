/**
 * DevModeContext — development mode provider + auth bypass.
 *
 * Design:
 *   ┌─────────────────────────────────────────────┐
 *   │  <AppContextProvider>                        │
 *   │    ├─ mode: 'dev' | 'production'            │
 *   │    ├─ crypto: DummyCryptoService | real      │
 *   │    ├─ sync:   DummySyncService | real        │
 *   │    ├─ storage: (from StoragePlugin factory)  │
 *   │    ├─ user:   { isAuthenticated, ... }       │
 *   │    └─ devBanner: visible in dev mode only    │
 *   └─────────────────────────────────────────────┘
 *
 * Storage selection:
 *   In dev mode, uses a MemoryBackend (in-memory, resets on refresh).
 *   In production, uses createStoragePlugin() to select the backend
 *   based on deployment config (IndexedDB, HttpBackend, etc.).
 *
 * Auth bypass:
 *   In 'dev' mode, the user is auto-authenticated. No passphrase prompt
 *   appears. The AuthScreen detects dev mode and immediately transitions
 *   to the Dashboard. A small "DEV MODE" banner floats at the top-right
 *   corner as a visual reminder.
 *
 * Switching to production:
 *   1. Remove DevModeProvider from the component tree
 *   2. Real CryptoService.create() loads WASM
 *   3. Auth screen prompts for passphrase → PBKDF2 → seed decryption
 *   4. Everything else works identically — components never know the difference
 *
 * Activation:
 *   - Default: dev mode (via URL param ?dev=true or localStorage flag)
 *   - Toggle in Settings screen for testing
 */

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { createDummyLedger } from '../services/DummyLedger.js';
import { createStoragePlugin } from '../sync/plugin_factory.js';

// --------------------------------------------------------------------------
// Context
// --------------------------------------------------------------------------

const DevModeContext = createContext(null);

// --------------------------------------------------------------------------
// Provider
// --------------------------------------------------------------------------

/**
 * @param {object} props
 * @param {React.ReactNode} props.children
 * @param {boolean} [props.defaultDevMode=true] — start in dev mode
 */
export function DevModeProvider({ children, defaultDevMode = true }) {
  const [mode, setMode] = useState(() => {
    // Check URL param first, then localStorage, then default
    const urlParams = new URLSearchParams(
      typeof window !== 'undefined' ? window.location.search : ''
    );
    if (urlParams.get('dev') === 'false') return 'production';
    if (urlParams.get('dev') === 'true') return 'dev';
    const stored = typeof localStorage !== 'undefined'
      ? localStorage.getItem('phpoc_dev_mode')
      : null;
    return stored !== null ? stored : (defaultDevMode ? 'dev' : 'production');
  });
  const isDev = mode === 'dev';

  const [services, setServices] = useState({ crypto: null, sync: null, storage: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Auth state — in dev mode, always authenticated
  const [user, setUser] = useState({
    isAuthenticated: isDev,
    deviceId: isDev ? 'dev-dummy-001' : null,
    masterKeyCached: isDev,
  });

  // Bootstrap services on mount
  useEffect(() => {
    let cancelled = false;

    async function boot() {
      setLoading(true);
      setError(null);

      try {
        if (isDev) {
          const { crypto, sync } = await createDummyLedger();
          if (!cancelled) {
            setServices({ crypto, sync, storage: sync._storage });
            setUser({
              isAuthenticated: true,
              deviceId: 'dev-dummy-001',
              masterKeyCached: true,
            });
          }
        } else {
          // Production boot — real WASM + config-driven StoragePlugin
          // *** FUTURE: implement real CryptoService.create() here ***
          // For now, attempt storage bootstrap so the UI can show
          // which backend would be used:
          const storage = await createStoragePlugin({ deployment: 'standalone' });
          if (!cancelled) {
            setServices({ crypto: null, sync: null, storage });
            setUser({
              isAuthenticated: false,
              deviceId: null,
              masterKeyCached: false,
            });
          }
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
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

  const contextValue = {
    mode,
    isDev,
    toggleMode,
    loading,
    error,
    services,
    user,
    login: useCallback(async () => {
      // In dev mode, login is automatic. In production, this would
      // prompt for passphrase and authenticate.
      if (isDev) return true;
      throw new Error('Production auth not yet implemented');
    }, [isDev]),
    logout: useCallback(() => {
      if (services.crypto) {
        services.crypto.clearMasterKey();
      }
      setUser({ isAuthenticated: false, deviceId: null, masterKeyCached: false });
    }, [services.crypto]),
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
 *   services: { crypto: object|null, sync: object|null, storage: object|null },
 *   user: { isAuthenticated: boolean, deviceId: string|null, masterKeyCached: boolean },
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
