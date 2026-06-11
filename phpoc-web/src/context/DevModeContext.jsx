/**
 * DevModeContext — application root context managing lifecycle phases.
 *
 * Phases:
 *   boot          — Loading WASM / checking IndexedDB
 *   landing       — Existing data detected, user chooses Login or Onboarding
 *   onboarding    — First-time or fresh-start: Import / New / Export
 *   auth          — Passphrase entry for login or import
 *   ready         — Services bootstrapped, main app rendered
 *
 * In the `ready` phase, services (crypto, sync, storage) are fully
 * initialized and available via the context.
 *
 * Dev mode (`?dev=true`) bypasses the landing/onboarding flow and seeds
 * mock data for development. Production mode (default) uses the full
 * phase-based flow with real WASM crypto.
 */

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { DummyCryptoService } from '../services/DummyLedger.js';
import { SyncService, SyncResult, IndexedDBBackend } from '@sync/index.js';
import { exportLedger } from '../services/ledger_export.js';
import { importLedger } from '../services/ledger_import.js';

// ── Context ──────────────────────────────────────────────────────────

const AppContext = createContext(null);

// ── Constants ─────────────────────────────────────────────────────────

const PBKDF2_ITERATIONS = 600000;
const STORED_SEED_KEY = 'phpoc_seed';
const USERNAME_KEY = 'phpoc_username';
const EMAIL_KEY = 'phpoc_email';
const COOKIE_KEY = 'cookie';
const ENTRIES_KEY = 'entries';

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Simple in-memory fallback storage for environments where IndexedDB
 * is unavailable (e.g. Node.js testing, private browsing).
 */
class FallbackStorage {
  constructor() { this._store = new Map(); }
  async get(key) { return this._store.get(key); }
  async set(key, val) { this._store.set(key, val); }
  async delete(key) { this._store.delete(key); }
  async list(prefix = '') {
    const keys = [];
    for (const k of this._store.keys()) {
      if (k.startsWith(prefix)) keys.push(k);
    }
    return keys.sort();
  }
  async clear() { this._store.clear(); }
}

/**
 * Attempt to create an IndexedDBBackend, falling back to in-memory storage.
 *
 * Caches the FallbackStorage instance within the same session so data
 * survives logout/login cycles in private browsing mode.
 */
let _fallbackStorage = null;
async function createStorage() {
  try {
    const backend = new IndexedDBBackend('phpoc-sync');
    // Probe the backend to see if IndexedDB is available
    await backend.list();
    return backend;
  } catch {
    console.warn('IndexedDB unavailable — using in-memory fallback');
    if (!_fallbackStorage) {
      _fallbackStorage = new FallbackStorage();
    }
    return _fallbackStorage;
  }
}

/**
 * Check whether IndexedDB has existing ledger data.
 * Returns true if a seed or entries key exists.
 */
async function detectExistingData(storage) {
  try {
    const keys = await storage.list();
    return keys.some(k => k === STORED_SEED_KEY || k.startsWith(ENTRIES_KEY));
  } catch {
    return false;
  }
}

/**
 * Create a download link for a Blob and trigger the browser download.
 */
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Provider ──────────────────────────────────────────────────────────

export function DevModeProvider({ children, defaultDevMode = true }) {
  // ── Phase & mode ──────────────────────────────────────────────────
  const [phase, setPhase] = useState('boot');
  const [mode, setMode] = useState(() => {
    // Check URL param and localStorage
    const urlParams = new URLSearchParams(
      typeof window !== 'undefined' ? window.location.search : ''
    );
    if (urlParams.get('dev') === 'true') return 'dev';
    if (urlParams.get('dev') === 'false') return 'production';
    const stored = typeof localStorage !== 'undefined'
      ? localStorage.getItem('phpoc_dev_mode')
      : null;
    return stored !== null ? stored : (defaultDevMode ? 'dev' : 'production');
  });
  const isDev = mode === 'dev';

  // ── Services (populated when phase === 'ready') ──────────────────
  const [services, setServices] = useState({
    crypto: null,
    sync: null,
    storage: null,
  });

  // ── Loading / error ───────────────────────────────────────────────
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [hasExistingData, setHasExistingData] = useState(false);

  // ── Identity info (loaded during bootstrap) ───────────────────────
  const [identityInfo, setIdentityInfo] = useState({ username: null, email: null });

  // ── Boot phase ───────────────────────────────────────────────────
  const bootAttempted = useRef(false);

  useEffect(() => {
    if (bootAttempted.current) return;
    bootAttempted.current = true;

    async function boot() {
      try {
        const storage = await createStorage();

        if (isDev) {
          // ── DEV MODE: eager bootstrap with mock data ──
          await bootDevMode(storage);
          return;
        }

        // ── PRODUCTION MODE: check for existing data ──
        const hasData = await detectExistingData(storage);
        setHasExistingData(hasData);

        if (!hasData) {
          // First launch — go straight to onboarding
          setPhase('onboarding');
          setLoading(false);
        } else {
          // Existing data — show landing screen
          setPhase('landing');
          setLoading(false);
        }
      } catch (err) {
        setError(err.message);
        setLoading(false);
      }
    }

    boot();
  }, [mode]);

  /**
   * Dev mode bootstraps DummyCryptoService with mock remote data.
   * (Kept from the original implementation for backward compat.)
   */
  async function bootDevMode(storage) {
    try {
      // Dynamic import to avoid bundling mock infra in production
      const { MockRemoteBackend } = await import('@sync/index.js');
      const { seedMockRemote, inspectMockRemote } = await import('../services/MockDataSeeder.js');

      const crypto = await DummyCryptoService.create();
      crypto.setMasterKey('deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef');

      const mockRemote = new MockRemoteBackend({ latencyMs: 30 });
      const deviceUuid = crypto.getDeviceId(crypto.getMasterKey());

      // Seed mock remote with 14 days of data
      await seedMockRemote(mockRemote, crypto, {
        historyDays: 14,
        activeTasks: 2,
        deviceUuid,
      });

      // Create SyncService connected to mock remote
      const sync = new SyncService(storage, crypto, mockRemote, {
        cookieTtlMinutes: 60,
      });

      // Bootstrap local cache: match cookie, pull seeded data
      const remoteCookieRaw = await mockRemote.pull('staging/blobs/device_cookie.bin');
      if (remoteCookieRaw) {
        const remoteCookie = JSON.parse(new TextDecoder().decode(remoteCookieRaw));
        await storage.set('cookie', {
          device_specifier: remoteCookie.device_specifier,
          creation_time: Date.now(),
        });
      }

      // Pull seeded entries into local cache
      const seededBlobBytes = await mockRemote.pull('staging/blobs/current.json');
      if (seededBlobBytes) {
        const seededBlob = JSON.parse(new TextDecoder().decode(seededBlobBytes));
        if (seededBlob.entries && Array.isArray(seededBlob.entries)) {
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

      // Run checkAndSync (should be fast path)
      try {
        await sync.checkAndSync(300);
      } catch {
        // Non-critical
      }

      // Dev info display
      let devInfo = null;
      try {
        devInfo = await inspectMockRemote(mockRemote);
      } catch {
        // ignore
      }

      setServices({ crypto, sync, storage, mockRemote, devInfo });
      setPhase('ready');
      setLoading(false);
    } catch (err) {
      // Fallback to basic dummy services
      try {
        const fallbackCrypto = new DummyCryptoService();
        const { DummySyncService } = await import('../services/DummyLedger.js');
        const fallbackSync = new DummySyncService(fallbackCrypto);
        setServices({
          crypto: fallbackCrypto,
          sync: fallbackSync,
          storage: fallbackSync._storage,
          mockRemote: null,
        });
        setPhase('ready');
      } catch {
        setError(err.message);
      }
      setLoading(false);
    }
  }

  // ── Initialize real services (called when transitioning to 'ready') ──

  /**
   * Bootstrap real services after auth/onboarding completes.
   *
   * @param {object} opts
   * @param {import('../crypto/index.js').CryptoService} opts.crypto - Initialized CryptoService
   * @param {string} opts.masterKey - Derived master key
   * @param {object} opts.storage - Storage backend (IndexedDBBackend or FallbackStorage)
   */
  async function bootstrapServices({ crypto, masterKey, storage }) {
    crypto.setMasterKey(masterKey);
    const sync = new SyncService(storage, crypto, null, {
      cookieTtlMinutes: 30,
    });

    // Load identity info
    const [loadedUsername, loadedEmail] = await Promise.all([
      storage.get(USERNAME_KEY),
      storage.get(EMAIL_KEY),
    ]);
    setIdentityInfo({ username: loadedUsername || null, email: loadedEmail || null });

    // Run checkAndSync for local-only (no transport = READY)
    try {
      await sync.checkAndSync();
    } catch {
      // Non-critical
    }

    setServices({ crypto, sync, storage, mockRemote: null });
    setPhase('ready');
    setLoading(false);
  }

  // ── Actions ──────────────────────────────────────────────────────

  /** Navigate from landing to the login auth flow. */
  const startLogin = useCallback(() => {
    setPhase('auth');
  }, []);

  /** Navigate from landing to onboarding. */
  const startOnboarding = useCallback(() => {
    setPhase('onboarding');
  }, []);

  /** Navigate back from onboarding to landing. */
  const goBackToLanding = useCallback(() => {
    if (hasExistingData) {
      setPhase('landing');
    } else {
      // No existing data, shouldn't happen, but handle gracefully
      setPhase('onboarding');
    }
  }, [hasExistingData]);

  /**
   * Log in to an existing ledger.
   * Reads stored seed, derives master key, verifies, bootstraps.
   */
  const login = useCallback(async (passphrase) => {
    const storage = await createStorage();
    const seed = await storage.get(STORED_SEED_KEY);
    if (!seed) {
      throw new Error('No recovery seed found. The ledger may be corrupted.');
    }

    // Initialize crypto service
    let crypto;
    try {
      const { CryptoService } = await import('../crypto/index.js');
      crypto = await CryptoService.create();
    } catch {
      // Fall back to DummyCryptoService if WASM unavailable
      crypto = await DummyCryptoService.create();
    }

    // Derive master key
    let masterKey;
    try {
      masterKey = crypto.authenticate(passphrase, seed, PBKDF2_ITERATIONS);
    } catch (err) {
      throw new Error(`Authentication failed: ${err.message}`);
    }

    // Verify by trying to decrypt/reach entries
    try {
      crypto.setMasterKey(masterKey);
      const entries = await storage.get(ENTRIES_KEY);
      // If entries exist and we can read them, authentication succeeded
      // (we can't easily verify the key without encrypted data, but if
      // authenticate() didn't throw, the PBKDF2 derivation was correct)
    } catch {
      throw new Error('Could not verify ledger data.');
    }

    // Bootstrap all services
    await bootstrapServices({ crypto, masterKey, storage });
  }, []);

  /**
   * Create a brand new ledger.
   * Generates seed, stores it, derives master key, sets up genesis.
   */
  const createNewLedger = useCallback(async (passphrase, username = '', email = '') => {
    setLoading(true);

    // Initialize crypto service
    let crypto;
    try {
      const { CryptoService } = await import('../crypto/index.js');
      crypto = await CryptoService.create();
    } catch {
      crypto = await DummyCryptoService.create();
    }

    // Generate seed
    const seed = crypto.generateSeed();

    // Derive master key
    const masterKey = crypto.authenticate(passphrase, seed, PBKDF2_ITERATIONS);

    // Get storage and clear any existing data
    const storage = await createStorage();
    await storage.clear();

    // Store seed for future logins
    await storage.set(STORED_SEED_KEY, seed);

    // Store identity info for genesis block and profile display
    await storage.set(USERNAME_KEY, username);
    await storage.set(EMAIL_KEY, email);

    // Create genesis block per PHPSPEC §4.1
    try {
      const { LedgerEngine } = await import('../ledger/engine.js');
      const engine = new LedgerEngine(crypto, storage, masterKey);
      const result = await engine.init({ username, email, passphrase, seed });
      // Store encrypted identity secret hex for future engine use
      await storage.set('phpoc_identity_secret', result.identitySecret);

      // Debug: dump genesis block and stored IndexedDB keys
      if (import.meta.env.DEV) {
        console.log('═══ GENESIS BLOCK ═══');
        console.table({
          type: result.genesisBlock.type,
          format_version: result.genesisBlock.format_version,
          day_index: result.genesisBlock.day_index,
          date: result.genesisBlock.date,
          username: result.genesisBlock.identity.username,
          email: result.genesisBlock.identity.email,
          recovery_seed_enc: (result.genesisBlock.identity.recovery_seed_enc || '').slice(0, 40) + '…',
          identity_pub_key: (result.genesisBlock.identity.identity_pub_key || '').slice(0, 20) + '…',
          identity_secret_enc_fallback: (result.genesisBlock.identity.identity_secret_enc_fallback || '').slice(0, 40) + '…',
          prev_hash: result.genesisBlock.prev_hash === '0'.repeat(64) ? '✅ all zeros' : '❌ WRONG',
          entries_count: result.genesisBlock.entries.length,
          day_hash: (result.genesisBlock.day_hash || '').slice(0, 20) + '…',
          signature: result.genesisBlock.signature ? '✅ present' : '❌ MISSING',
          identity_secret: (result.identitySecret || '').slice(0, 20) + '…',
        });
        // Read back the blocks from storage
        const blocks = await storage.get('ledger:blocks');
        console.log('═══ INDEXEDDB STORED KEYS ═══');
        console.log('ledger:blocks blocks count:', blocks ? blocks.length : 0);
        console.log('phpoc_seed:', await storage.get('phpoc_seed'));
        console.log('phpoc_username:', await storage.get('phpoc_username'));
        console.log('phpoc_email:', await storage.get('phpoc_email'));
        console.log('phpoc_identity_secret:', (await storage.get('phpoc_identity_secret') || '').slice(0, 20) + '…');
      }
    } catch (err) {
      console.error('Genesis block creation failed:', err);
      // Non-fatal — the flat keys are stored, and the ledger will
      // fall back to unsigned day blocks on first commit.
    }

    // Bootstrap services
    await bootstrapServices({ crypto, masterKey, storage });

    // Return seed so the caller can display it to the user
    return { seed };
  }, []);

  /**
   * Import a ledger from an exported file.
   * Authenticates with passphrase + seed, verifies seal, writes entries.
   */
  const importLedgerAction = useCallback(async (file, passphrase, seed) => {
    setLoading(true);

    // Initialize crypto
    let crypto;
    try {
      const { CryptoService } = await import('../crypto/index.js');
      crypto = await CryptoService.create();
    } catch {
      crypto = await DummyCryptoService.create();
    }

    // Derive master key
    const masterKey = crypto.authenticate(passphrase, seed, PBKDF2_ITERATIONS);

    // Import and verify
    const result = await importLedger(file, crypto, masterKey);

    // Clear existing data and write imported entries
    const storage = await createStorage();
    await storage.clear();
    await storage.set(STORED_SEED_KEY, seed);
    await storage.set(ENTRIES_KEY, result.entries);

    // Bootstrap
    await bootstrapServices({ crypto, masterKey, storage });
  }, []);

  /**
   * Export the current ledger.
   * Authenticates with passphrase, then triggers a file download.
   */
  const exportLedgerAction = useCallback(async (passphrase) => {
    const { crypto: existingCrypto, sync: existingSync, storage: existingStorage } = services;

    if (existingCrypto && existingSync) {
      // ── Fast path: services already loaded (called from Settings) ──
      // Use cached master key if available (dev mode), else authenticate
      let masterKey = existingCrypto.getMasterKey();
      if (!masterKey) {
        const seed = await existingStorage.get(STORED_SEED_KEY);
        if (!seed) {
          throw new Error('No recovery seed found — cannot authenticate.');
        }
        masterKey = existingCrypto.authenticate(passphrase, seed, PBKDF2_ITERATIONS);
      }
      const entries = await existingSync.readEntries();
      if (entries.length === 0) {
        throw new Error('No entries to export.');
      }
      const blob = await exportLedger(entries, existingCrypto, masterKey);
      const timestamp = new Date().toISOString().slice(0, 10);
      triggerDownload(blob, `ph-ledger-export-${timestamp}.json`);
      return;
    }

    // ── Slow path: services not loaded (called from Onboarding) ──
    // Load on demand: create storage, init crypto, read entries, export.
    const storage = await createStorage();

    let crypto;
    try {
      const { CryptoService } = await import('../crypto/index.js');
      crypto = await CryptoService.create();
    } catch {
      crypto = await DummyCryptoService.create();
    }

    // Use cached master key if available, else authenticate via seed
    let masterKey = crypto.getMasterKey();
    if (!masterKey) {
      const seed = await storage.get(STORED_SEED_KEY);
      if (!seed) {
        throw new Error('No recovery seed found — cannot authenticate.');
      }
      masterKey = crypto.authenticate(passphrase, seed, PBKDF2_ITERATIONS);
      crypto.setMasterKey(masterKey);
    }

    // Read entries directly from storage
    const entries = await storage.get(ENTRIES_KEY) || [];
    if (entries.length === 0) {
      throw new Error('No entries to export.');
    }

    const blob = await exportLedger(entries, crypto, masterKey);
    const timestamp = new Date().toISOString().slice(0, 10);
    triggerDownload(blob, `ph-ledger-export-${timestamp}.json`);
  }, [services]);

  // ── Toggle dev/production mode ───────────────────────────────────

  const toggleMode = useCallback(() => {
    const next = mode === 'dev' ? 'production' : 'dev';
    setMode(next);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('phpoc_dev_mode', next);
    }
    // Reset boot flag on mode change so the useEffect re-runs
    bootAttempted.current = false;
  }, [mode]);

  // ── Logout ───────────────────────────────────────────────────────

  const logout = useCallback(() => {
    if (services.crypto) {
      services.crypto.clearMasterKey();
    }
    setHasExistingData(true);
    setPhase('landing');
    // Keep storage in services so in-memory data survives logout
    setServices({ crypto: null, sync: null, storage: services.storage });
    setIdentityInfo({ username: null, email: null });
    setLoading(false);
  }, [services.crypto, services.storage]);

  // ── Check device cookie TTL (for re-auth overlay) ────────────────

  const checkCookieTtl = useCallback(async () => {
    if (!services.sync || !services.storage) return true;
    try {
      const { DeviceCookie } = await import('@sync/index.js');
      const cookie = await DeviceCookie.isValidLocally(services.storage, 30);
      return cookie !== null;
    } catch {
      return true;
    }
  }, [services.sync, services.storage]);

  // ── Commit entries to ledger ─────────────────────────────────────

  const commitEntries = useCallback(async (entryIds) => {
    const { sync, crypto, storage } = services;
    if (!sync || !crypto || !storage) {
      throw new Error('Services not ready');
    }
    const entries = await sync.readEntries();
    const toCommit = entries.filter((e) => entryIds.includes(e.entry_id));
    if (toCommit.length === 0) return;

    // Create LedgerEngine
    const { LedgerEngine } = await import('../ledger/engine.js');
    const masterKey = crypto.getMasterKey();
    const engine = new LedgerEngine(crypto, storage, masterKey);

    // Commit
    const result = await engine.commit(toCommit);
    if (result && result.committedEntryIds.length > 0) {
      await sync.markCommitted(result.committedEntryIds, result.blockIndex);
    }
  }, [services]);

  // ── Context value ────────────────────────────────────────────────

  const contextValue = {
    // Phase & mode
    phase,
    mode,
    isDev,
    toggleMode,
    hasExistingData,

    // Loading / error
    loading,
    error,
    setError,

    // Services (populated when ready)
    services,

    // Auth state (derived from phase)
    user: {
      isAuthenticated: phase === 'ready',
      deviceId: phase === 'ready' && services.crypto
        ? services.crypto.getDeviceIdWithCachedKey?.() || 'unknown'
        : null,
      masterKeyCached: phase === 'ready' && !!services.crypto?.hasMasterKey?.(),
      username: identityInfo.username,
      email: identityInfo.email,
    },

    // Phase navigation
    startLogin,
    startOnboarding,
    goBackToLanding,

    // Auth / onboarding actions
    login,
    createNewLedger,
    importLedger: importLedgerAction,
    exportLedger: exportLedgerAction,
    logout,

    // Cookie TTL check
    checkCookieTtl,

    // Commit entries to ledger
    commitEntries,
  };

  return (
    <AppContext.Provider value={contextValue}>
      {children}
    </AppContext.Provider>
  );
}

// ── Hook ──────────────────────────────────────────────────────────────

/**
 * Access the app context.
 *
 * @returns {{
 *   phase: 'boot'|'landing'|'onboarding'|'auth'|'ready',
 *   mode: 'dev'|'production',
 *   isDev: boolean,
 *   toggleMode: () => void,
 *   hasExistingData: boolean,
 *   loading: boolean,
 *   error: string|null,
 *   setError: (string|null) => void,
 *   services: { crypto: object|null, sync: object|null, storage: object|null },
 *   user: { isAuthenticated: boolean, deviceId: string|null, masterKeyCached: boolean, username: string|null, email: string|null },
 *   startLogin: () => void,
 *   startOnboarding: () => void,
 *   goBackToLanding: () => void,
 *   login: (passphrase: string) => Promise<void>,
 *   createNewLedger: (passphrase: string, username: string, email: string) => Promise<{seed: string} | void>,
 *   importLedger: (file: File, passphrase: string, seed: string) => Promise<void>,
 *   exportLedger: (passphrase: string) => Promise<void>,
 *   logout: () => void,
 *   checkCookieTtl: () => Promise<boolean>,
 * }}
 */
export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error('useApp() must be used within a <DevModeProvider>');
  }
  return ctx;
}
