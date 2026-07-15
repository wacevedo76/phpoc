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
 * Dev mode (`?dev=true`) and production mode follow the same boot path
 * with real WASM crypto. The `isDev` flag is available for future dev-only
 * UI features (badges, debug panels, verbose logging). No mock services
 * or dummy crypto are used — all cryptography goes through the Rust WASM
 * core (phpoc-crypto-core).
 */

import React, { createContext, useContext, useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { SyncService, SyncResult, IndexedDBBackend, SessionStorageBackend, createTransportFromDeployment, GenesisGate, WorkerImportSource, HttpTransport } from '@sync/index.js';
import { createAutoSync } from '../hooks/useAutoSync.js';
import { createCookieMonitor } from '../hooks/useCookieMonitor.js';
import { exportLedger, exportLedgerFull } from '../services/ledger_export.js';
import { exportWithAuth } from '../services/export_auth.js';
import { importLedger } from '../services/ledger_import.js';

// ── Context ──────────────────────────────────────────────────────────

const AppContext = createContext(null);

// ── Constants ─────────────────────────────────────────────────────────

const PBKDF2_ITERATIONS = 600000;
const STORED_SEED_KEY = 'phpoc_seed';
const STORED_PASSPHRASE_HASH_KEY = 'phpoc_passphrase_hash';
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
 * Attempt to create a storage backend. Cascading fallback:
 *   1. IndexedDBBackend — persistent, survives browser restart (normal)
 *   2. SessionStorageBackend — survives page refresh, lost on tab close
 *      (private/incognito browsing)
 *   3. In-memory Map — lost on ANY page refresh (last resort)
 *
 * Caches the fallback instance across calls so data survives
 * logout/login within the same page session.
 */
let _cachedFallbackStorage = null;
let _storageStatus = null; // 'persistent' | 'session' | 'memory'

async function createStorage() {
  // Return cached fallback if already created
  if (_cachedFallbackStorage) return _cachedFallbackStorage;

  // ── 1. Try IndexedDB (persistent) ──
  try {
    const backend = new IndexedDBBackend('phpoc-sync');
    await backend.list(); // probe
    _storageStatus = 'persistent';
    return backend;
  } catch {
    // IndexedDB unavailable — try sessionStorage
  }

  // ── 2. Try SessionStorage (survives refresh in private browsing) ──
  try {
    const backend = new SessionStorageBackend('phpoc:');
    await backend.list(); // probe
    _cachedFallbackStorage = backend;
    _storageStatus = 'session';
    console.warn(
      '[PHPOC] IndexedDB unavailable — using sessionStorage fallback.',
      'Data will survive page refreshes but is lost when you close this tab/window.',
    );
    return backend;
  } catch {
    // sessionStorage also unavailable — fall back to in-memory
  }

  // ── 3. Last resort: in-memory Map ──
  console.warn(
    '[PHPOC] IndexedDB and sessionStorage unavailable — using in-memory fallback.',
    'ALL DATA WILL BE LOST on page refresh.',
  );
  if (!_cachedFallbackStorage) {
    _cachedFallbackStorage = new FallbackStorage();
  }
  _storageStatus = 'memory';
  return _cachedFallbackStorage;
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

  // ── Auto-sync wrapper ────────────────────────────────────────────
  // Wraps sync mutation methods (capture/end/pause/unpause/modify/remove)
  // with debounced pushToRemote so every staging change auto-syncs to
  // the remote Worker for cross-device consistency.
  const autoSyncRef = useRef(null);
  const prevRawSyncRef = useRef(null);
  const [isAutoSyncing, setIsAutoSyncing] = useState(false);

  // Build the effective services object with auto-sync wrapped sync.
  // All components access services.sync — by replacing it here,
  // every mutation call automatically triggers a debounced push.
  const effectiveServices = useMemo(() => {
    const rawSync = services.sync;
    if (!rawSync) {
      // No sync yet (boot/landing/onboarding/auth phases) — pass through
      return services;
    }

    // Only recreate the auto-sync wrapper if rawSync instance changed
    if (prevRawSyncRef.current !== rawSync) {
      if (autoSyncRef.current) {
        autoSyncRef.current.dispose();
      }
      autoSyncRef.current = createAutoSync(rawSync, {
        debounceMs: 500,
        onSyncingChange: setIsAutoSyncing,
      });
      prevRawSyncRef.current = rawSync;
    }

    // Use a Proxy so prototype methods (getCompleted, markCommitted,
    // getMasterKey, pushToRemote, etc.) pass through to the real
    // SyncService. Spreading `...rawSync` only copies own properties
    // — class methods live on the prototype and would be lost.
    const autoSync = autoSyncRef.current;
    const proxyHandler = {
      get(target, prop, receiver) {
        // Override mutation methods with auto-sync wrapped versions
        if (prop === 'capture') return autoSync.capture;
        if (prop === 'end') return autoSync.end;
        if (prop === 'pause') return autoSync.pause;
        if (prop === 'unpause') return autoSync.unpause;
        if (prop === 'modify') return autoSync.modify;
        if (prop === 'remove') return autoSync.remove;
        // Expose isSyncing for UI indicators
        if (prop === 'isAutoSyncing') return autoSync.isSyncing();
        // Expose dispose for cleanup
        if (prop === '_autoSyncDispose') return autoSync.dispose;
        // Everything else passes through to the real SyncService.
        // Use receiver so `this` inside prototype methods resolves
        // through the proxy (needed for this._local, this._storage, etc.)
        return Reflect.get(target, prop, receiver);
      },
    };
    const wrappedSync = new Proxy(rawSync, proxyHandler);

    return { ...services, sync: wrappedSync };
  }, [services]);

  // ── TTL warning banner state ───────────────────────────────────
  // Shown when the cookie is within 5 minutes of expiry.
  // Cleared on logout or when the user logs in.
  const [ttlWarning, setTtlWarning] = useState(false);

  const dismissTtlWarning = useCallback(() => {
    setTtlWarning(false);
  }, []);

  // ── Re-auth overlay state ─────────────────────────────────────
  // { active: boolean, reason: 'ttl_expired' | 'sync_settings' | null }
  // active=true triggers the ReauthOverlay in App.jsx.
  // reason tracks what triggered it for UI messaging.
  const [reauthState, setReauthState] = useState({ active: false, reason: null });

  const triggerReauth = useCallback((reason) => {
    if (typeof reason !== 'string' || !reason) {
      throw new Error('triggerReauth requires a non-empty reason string');
    }
    setReauthState({ active: true, reason });
  }, []);

  const dismissReauth = useCallback(() => {
    setReauthState({ active: false, reason: null });
  }, []);

  // After successful re-auth, restart cookie monitor (it was disposed
  // in handleTtlExpiry). Incrementing the version forces the useEffect
  // to recreate the monitor with the fresh cookie.
  const restartCookieMonitor = useCallback(() => {
    setCookieMonitorVersion((v) => v + 1);
  }, []);

  // ── TTL expiry handler ─────────────────────────────────────────
  // Called by the cookie monitor when TTL expires. Instead of forcing
  // a full logout to the landing screen, clears the MK and triggers
  // the re-auth overlay so the user can re-authenticate inline.
  // Must be defined BEFORE the cookie monitor useEffect below.
  const handleTtlExpiry = useCallback(() => {
    // Dispose cookie TTL monitor (stops polling)
    if (cookieMonitorRef.current) {
      cookieMonitorRef.current.dispose();
      cookieMonitorRef.current = null;
    }
    if (services.crypto) {
      services.crypto.clearMasterKey();
    }
    setTtlWarning(false);
    // Trigger re-auth overlay instead of full logout
    // Services (storage, sync reference) stay alive so re-auth can
    // call _reconcileAndClaim to pull/merge/push/create cookie.
    setReauthState({ active: true, reason: 'ttl_expired' });
  }, [services.crypto]);

  // ── Cookie TTL monitor ─────────────────────────────────────────
  // Monitors the local device cookie TTL. When the cookie expires,
  // clears the master key and triggers the re-auth overlay.
  //
  // cookieMonitorVersion forces recreation after re-auth success.
  // The monitor is disposed in handleTtlExpiry; when re-auth creates
  // a fresh cookie, we increment the version to restart monitoring.
  const cookieMonitorRef = useRef(null);
  const [cookieMonitorVersion, setCookieMonitorVersion] = useState(0);

  useEffect(() => {
    // Only run the monitor when services are fully bootstrapped
    if (phase !== 'ready') {
      if (cookieMonitorRef.current) {
        cookieMonitorRef.current.dispose();
        cookieMonitorRef.current = null;
      }
      return;
    }

    const crypto = effectiveServices?.crypto;
    const storage = effectiveServices?.storage;
    if (!crypto || !storage) return;

    // Dispose any previous monitor instance before creating a new one
    if (cookieMonitorRef.current) {
      cookieMonitorRef.current.dispose();
    }

    const monitor = createCookieMonitor(storage, crypto, {
      cookieTtlMinutes: 30,
      pollIntervalMs: 60_000,
      warningThresholdMinutes: 5,
      onWarning: () => setTtlWarning(true),
      onExpired: handleTtlExpiry,
    });

    cookieMonitorRef.current = monitor;
    monitor.start();

    return () => {
      monitor.dispose();
      cookieMonitorRef.current = null;
    };
  }, [phase, effectiveServices?.crypto, effectiveServices?.storage, handleTtlExpiry, cookieMonitorVersion]);

  // Clean up auto-sync on unmount (cancels pending debounce)
  useEffect(() => {
    return () => {
      if (autoSyncRef.current) {
        autoSyncRef.current.dispose();
      }
    };
  }, []);

  // ── Loading / error ───────────────────────────────────────────────
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [hasExistingData, setHasExistingData] = useState(false);

  // ── Genesis mismatch state (surfaced from bootstrapServices) ───
  const [genesisMismatch, setGenesisMismatch] = useState(false);

  // ── Identity info (loaded during bootstrap) ───────────────────────
  const [identityInfo, setIdentityInfo] = useState({ username: null, email: null });

  // ── Boot phase ───────────────────────────────────────────────────
  const bootAttempted = useRef(false);

  // ── Pending import state (carries data from validate to confirm) ──
  const pendingImportRef = useRef(null);

  // Tracks whether real WASM crypto loaded successfully.
  // 'wasm' = real crypto, 'fallback' = WASM failed — operations blocked.
  const [cryptoStatus, setCryptoStatus] = useState('wasm');

  // Tracks storage quality: 'persistent' (IndexedDB), 'session' (SessionStorage),
  // or 'memory' (in-memory Map, data lost on refresh).
  const [storageStatus, setStorageStatus] = useState('persistent');

  useEffect(() => {
    if (bootAttempted.current) return;
    bootAttempted.current = true;

    async function boot() {
      try {
        const storage = await createStorage();
        setStorageStatus(_storageStatus);

        // ── Check for existing data ──
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

    // Create remote transport from deployment config.
    // Falls back to null (local-only) on invalid config.
    const transport = createTransportFromDeployment();

    const sync = new SyncService(storage, crypto, transport, {
      cookieTtlMinutes: 30,
    });

    // Load identity info
    const [loadedUsername, loadedEmail] = await Promise.all([
      storage.get(USERNAME_KEY),
      storage.get(EMAIL_KEY),
    ]);
    setIdentityInfo({ username: loadedUsername || null, email: loadedEmail || null });

    // Run checkAndSync for local-only (no transport = READY)
    // Genesis gate runs inside checkAndSync if transport is configured.
    // Mismatches are surfaced to the user via genesisMismatch state —
    // they must explicitly decide to clear remote via SyncSettings.
    try {
      const syncResult = await sync.checkAndSync();
      if (syncResult === SyncResult.GENESIS_MISMATCH) {
        console.warn('Genesis mismatch — remote ledger differs from local.');
        setGenesisMismatch(true);
      }
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

    // Initialize crypto service — real WASM only, no fallback
    const { CryptoService } = await import('../crypto/index.js');
    const crypto = await CryptoService.create();
    setCryptoStatus('wasm');

    // ── Passphrase verification (Phase 6 P1 Step 1) ──
    // The WASM authenticate() ignores the passphrase (derives MK
    // directly from seed), so the master key is always correct.
    // We verify the passphrase independently using PBKDF2-derived
    // tokens. Two-tier: fast hash check, then PDK-encrypted token.
    const storedHash = await storage.get(STORED_PASSPHRASE_HASH_KEY);
    if (storedHash) {
      const pdk = crypto.derivePdk(passphrase, PBKDF2_ITERATIONS);
      const computedHash = crypto.sha256(pdk + ':' + seed);
      if (computedHash !== storedHash) {
        throw new Error('Incorrect passphrase.');
      }
    } else {
      // No stored hash — legacy ledger or first login after fix.
      // Use PDK-encrypted verification token as fallback. The PDK
      // depends on the passphrase, unlike the master key.
      const PDK_TOKEN_KEY = 'phpoc_pdk_token';
      const pdkToken = await storage.get(PDK_TOKEN_KEY);
      if (pdkToken) {
        // Verification token exists — verify passphrase via PDK
        const pdk = crypto.derivePdk(passphrase, PBKDF2_ITERATIONS);
        try {
          const decrypted = crypto.decrypt(pdkToken, pdk);
          if (decrypted !== 'phpoc_pdk_verify') {
            throw new Error('Incorrect passphrase.');
          }
        } catch {
          throw new Error('Incorrect passphrase.');
        }
      }
      // No hash AND no PDK token → first-ever login after this fix.
      // We cannot verify the passphrase (seed = MK, always valid).
      // Accept the passphrase and bootstrap verification for next time.
    }

    // Derive master key
    let masterKey;
    try {
      masterKey = crypto.authenticate(passphrase, seed, PBKDF2_ITERATIONS);
    } catch (err) {
      throw new Error(`Authentication failed: ${err.message}`);
    }

    crypto.setMasterKey(masterKey);

    // Bootstrap all services
    await bootstrapServices({ crypto, masterKey, storage });

    // Store/refresh passphrase verification tokens (Phase 6 P1 Step 1)
    try {
      const pdk = crypto.derivePdk(passphrase, PBKDF2_ITERATIONS);
      // Fast hash check: sha256(PDK + seed)
      const passphraseHash = crypto.sha256(pdk + ':' + seed);
      await storage.set(STORED_PASSPHRASE_HASH_KEY, passphraseHash);
      // PDK-encrypted token: fallback verification that depends on the
      // passphrase (unlike master key which = seed regardless).
      const pdkToken = crypto.encrypt('phpoc_pdk_verify', pdk);
      await storage.set('phpoc_pdk_token', pdkToken);
    } catch (_) { /* non-critical */ }
  }, []);

  /**
   * Create a brand new ledger.
   * Generates seed, stores it, derives master key, sets up genesis.
   */
  const createNewLedger = useCallback(async (passphrase, username = '', email = '') => {
    setLoading(true);

    // Initialize crypto service — real WASM only, no fallback
    const { CryptoService } = await import('../crypto/index.js');
    const crypto = await CryptoService.create();
    setCryptoStatus('wasm');

    // Phase A: Check if remote already has ledger data before creating new.
    // Prevents accidentally overwriting an existing remote ledger.
    try {
      const checkTransport = createTransportFromDeployment();
      if (checkTransport) {
        const remoteFiles = await checkTransport.listFiles('ledger/blocks/');
        if (remoteFiles && remoteFiles.length > 0) {
          const proceed = window.confirm(
            `A ledger already exists on the remote server (${remoteFiles.length} blocks found).\n\n` +
            'Creating a new ledger will leave the remote data orphaned — ' +
            'the new ledger will have a different genesis and cannot sync ' +
            'with the existing remote data.\n\n' +
            'Consider importing from the remote instead.\n\n' +
            'Create a new ledger anyway?'
          );
          if (!proceed) {
            setLoading(false);
            return;
          }
        }
      }
    } catch {
      // Network error — proceed with creation
    }

    // Generate seed
    const seed = crypto.generateSeed();

    // Derive master key
    const masterKey = crypto.authenticate(passphrase, seed, PBKDF2_ITERATIONS);

    // Get storage and clear any existing data
    const storage = await createStorage();
    await storage.clear();

    // Clear remote sync settings — a new ledger has no remote config
    localStorage.removeItem('phpoc_worker_url');
    localStorage.removeItem('phpoc_api_key');

    // Store seed for future logins
    await storage.set(STORED_SEED_KEY, seed);

    // Store passphrase validation tokens (Phase 6 P1 Step 1)
    try {
      const pdk = crypto.derivePdk(passphrase, PBKDF2_ITERATIONS);
      const passphraseHash = crypto.sha256(pdk + ':' + seed);
      await storage.set(STORED_PASSPHRASE_HASH_KEY, passphraseHash);
      // PDK-encrypted token for fallback verification
      const pdkToken = crypto.encrypt('phpoc_pdk_verify', pdk);
      await storage.set('phpoc_pdk_token', pdkToken);
    } catch (_) { /* non-critical */ }

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
   * Validate an import file — read-only, no storage modifications.
   *
   * Runs all five validation gates (parse → seal → hash → genesis) plus
   * reads existing ledger state for the confirmation UI. Returns enough
   * info for the caller to show destroy warnings, staging counts, and
   * export offers BEFORE any destructive operation.
   *
   * Stores validation result in pendingImportRef for the subsequent
   * confirmImport() call.
   *
   * @returns {Promise<{
   *   needsConfirmation: boolean,
   *   genesisCheck: 'same'|'different'|'new',
   *   stagingCount: number,
   *   blocksCount: number,
   *   importEntryCount: number,
   *   formatVersion: string,
   * }>}
   */
  const validateImport = useCallback(async (file, passphrase, seed) => {
    setLoading(true);

    // Initialize crypto — real WASM only, no fallback
    const { CryptoService } = await import('../crypto/index.js');
    const crypto = await CryptoService.create();
    setCryptoStatus('wasm');

    // Derive master key
    const masterKey = crypto.authenticate(passphrase, seed, PBKDF2_ITERATIONS);

    // Import and verify (returns { entries, count, genesisHash, formatVersion, ledger })
    const result = await importLedger(file, crypto, masterKey);

    // Read existing data for confirmation UI
    const storage = await createStorage();
    const existingBlocks = await storage.get('ledger:blocks') || [];
    const stagingEntries = await storage.get(ENTRIES_KEY) || [];
    const existingGenesisHash = Array.isArray(existingBlocks) && existingBlocks.length > 0
      ? existingBlocks[0].day_hash
      : null;

    const hasExistingData = existingBlocks.length > 0 || stagingEntries.length > 0;

    // ── Genesis identity check ────────────────────────────────────
    let genesisCheck = 'new';
    if (result.genesisHash && existingGenesisHash) {
      genesisCheck = result.genesisHash === existingGenesisHash ? 'same' : 'different';
    }

    if (genesisCheck === 'same') {
      setLoading(false);
      throw new Error(
        'This ledger shares your identity but merge is not yet supported. ' +
        'Export from your most recent device instead, or use a different import file.'
      );
    }

    // Store validation result for confirmImport()
    pendingImportRef.current = {
      file,
      passphrase,
      seed,
      crypto,
      masterKey,
      result,
      storage,
      existingBlocks,
      stagingEntries,
      existingGenesisHash,
      genesisCheck,
    };

    setLoading(false);

    return {
      needsConfirmation: hasExistingData,
      genesisCheck,
      stagingCount: stagingEntries.length,
      blocksCount: existingBlocks.length,
      importEntryCount: result.count,
      formatVersion: result.formatVersion,
    };
  }, []);

  /**
   * Execute a confirmed import — clears storage, writes imported data,
   * optionally preserves existing staging entries, and bootstraps services.
   *
   * Must be called after a successful validateImport().
   *
   * @param {{ keepStaging?: boolean }} opts
   */
  const confirmImport = useCallback(async (opts = {}) => {
    const pending = pendingImportRef.current;
    if (!pending) {
      throw new Error('No pending import — call validateImport() first.');
    }

    const { crypto, masterKey, result, stagingEntries, seed } = pending;
    const { keepStaging = false } = opts;

    setLoading(true);

    // Save staging entries before clear if user wants to keep them
    let savedStaging = [];
    if (keepStaging && stagingEntries.length > 0) {
      savedStaging = stagingEntries;
    }

    // Clear existing data
    const storage = await createStorage();
    await storage.clear();

    // Clear remote sync settings — imported ledger may have different remote config
    localStorage.removeItem('phpoc_worker_url');
    localStorage.removeItem('phpoc_api_key');

    // Write seed for future logins
    await storage.set(STORED_SEED_KEY, seed);

    // Write staging entries: merge saved existing + imported
    // Imported entries take precedence on entry_id collision
    const importedIds = new Set(result.entries.map(e => e.entry_id));
    const mergedStaging = [
      ...savedStaging.filter(s => !importedIds.has(s.entry_id)),
      ...result.entries,
    ];
    await storage.set(ENTRIES_KEY, mergedStaging);

    // Write committed chain for v2 imports
    if (result.ledger && Array.isArray(result.ledger) && result.ledger.length > 0) {
      await storage.set('ledger:blocks', result.ledger);
    }

    // Write identity info from genesis block if available
    if (result.ledger && result.ledger.length > 0) {
      const genesis = result.ledger[0];
      if (genesis.type === 'genesis' && genesis.identity) {
        if (genesis.identity.username) {
          await storage.set(USERNAME_KEY, genesis.identity.username);
        }
        if (genesis.identity.email) {
          await storage.set(EMAIL_KEY, genesis.identity.email);
        }
      }
    }

    // Clear pending import
    pendingImportRef.current = null;

    // Bootstrap all services
    await bootstrapServices({ crypto, masterKey, storage });

    // Store passphrase verification tokens for future logins
    try {
      const pdk = crypto.derivePdk(pending.passphrase, PBKDF2_ITERATIONS);
      const passphraseHash = crypto.sha256(pdk + ':' + seed);
      await storage.set(STORED_PASSPHRASE_HASH_KEY, passphraseHash);
      const pdkToken = crypto.encrypt('phpoc_pdk_verify', pdk);
      await storage.set('phpoc_pdk_token', pdkToken);
    } catch (_) { /* non-critical */ }
  }, []);

  /**
   * Connect to an existing Worker-hosted ledger.
   *
   * Verifies the passphrase against the fetched genesis block, derives
   * the master key, writes the chain to storage, saves remote config,
   * and bootstraps all services.
   *
   * @param {object} opts
   * @param {string} opts.baseUrl - Worker URL
   * @param {string} opts.apiKey - API key
   * @param {string} opts.passphrase - User's passphrase
   * @param {string} opts.userSeed - Recovery seed
   * @param {string} opts.format - 'blocks' (canonical ledger/blocks/ format)
   */
  const connectToWorker = useCallback(async ({ baseUrl, apiKey, passphrase, userSeed, genesisBlock, chain, format }) => {
    setLoading(true);

    // ── 1. Initialize crypto — real WASM only, no fallback ────────
    const { CryptoService } = await import('../crypto/index.js');
    const crypto = await CryptoService.create();
    setCryptoStatus('wasm');

    // ── CLI block format: fetch + deobfuscate + assemble chain ──
    if (format !== 'blocks') {
      setLoading(false);
      throw new Error('Only blocks-format onboarding is supported.');
    }

    if (!userSeed) {
      setLoading(false);
      throw new Error('Recovery seed is required for CLI-format ledgers.');
    }

    // Derive master key from passphrase + user seed
    let masterKey;
    try {
      masterKey = crypto.authenticate(passphrase, userSeed, PBKDF2_ITERATIONS);
    } catch (err) {
      setLoading(false);
      throw new Error(`Authentication failed: ${err.message}`);
    }
    crypto.setMasterKey(masterKey);

    // Create transport to fetch blocks
    const transport = new HttpTransport({
      baseUrl: baseUrl.trim(),
      apiKey: apiKey || null,
    });

    // List and fetch all blocks
    let blockFiles;
    try {
      blockFiles = await transport.listFiles('ledger/blocks/');
    } catch (err) {
      setLoading(false);
      throw new Error(`Failed to list ledger blocks: ${err.message}`);
    }

    if (!blockFiles || blockFiles.length === 0) {
      setLoading(false);
      throw new Error('No ledger blocks found on remote.');
    }

    // Sort by sequence number (000000.json, 000001.json, ...)
    blockFiles.sort();

    // Fetch and deobfuscate each block
    const assembledChain = [];
    for (const filename of blockFiles) {
      const path = `ledger/blocks/${filename}`;
      let raw;
      try {
        raw = await transport.pull(path);
      } catch (err) {
        setLoading(false);
        throw new Error(`Failed to fetch block ${filename}: ${err.message}`);
      }

      if (raw === null || raw === undefined) {
        setLoading(false);
        throw new Error(`Block ${filename} not found on remote.`);
      }

      // Deobfuscate: convert bytes to base64, then deobfuscate via WASM
      let block;
      try {
        const b64 = btoa(String.fromCharCode(...raw));
        const plaintext = crypto.deobfuscateBlob(b64, masterKey);
        block = JSON.parse(plaintext);
      } catch (err) {
        setLoading(false);
        throw new Error(`Failed to deobfuscate block ${filename}. Wrong passphrase or seed.`);
      }

      assembledChain.push(block);
    }

    chain = assembledChain;
    genesisBlock = assembledChain.length > 0 ? assembledChain[0] : null;

    // Validate genesis block
    if (!genesisBlock || genesisBlock.type !== 'genesis') {
      setLoading(false);
      throw new Error('Remote ledger does not have a valid genesis block.');
    }

    // Verify genesis seal (I-17: genesis uses block_hash, pre-I-17 uses day_hash)
    try {
      const { jsonSort } = await import('../ledger/utils.js');
      const hashKey = genesisBlock.block_hash ? 'block_hash' : 'day_hash';
      const checkData = {};
      for (const [k, v] of Object.entries(genesisBlock)) {
        if (k !== hashKey && k !== 'signature') {
          checkData[k] = v;
        }
      }
      const sealData = jsonSort(checkData);
      const valid = crypto.verifySeal(sealData, genesisBlock[hashKey], masterKey);
      if (!valid) {
        throw new Error('Seal verification failed');
      }
    } catch (err) {
      setLoading(false);
      throw new Error('Wrong passphrase for this ledger.');
    }

    // Verify chain integrity (prev_hash linkage across all blocks)
    try {
      for (let i = 1; i < assembledChain.length; i++) {
        const prev = assembledChain[i - 1];
        const curr = assembledChain[i];
        const prevHash = prev.block_hash || prev.day_hash || prev.month_hash || prev.year_hash || '';
        if (curr.prev_hash !== prevHash) {
          throw new Error(
            `Chain linkage broken at block ${i}: ` +
            `prev_hash ${curr.prev_hash?.slice(0, 8)}… ≠ expected ${prevHash.slice(0, 8)}…`
          );
        }
      }
    } catch (err) {
      setLoading(false);
      throw err;
    }

    // ── Write everything to storage ────────────────────────────
    const storage = await createStorage();
    await storage.clear();

    await storage.set(STORED_SEED_KEY, userSeed);

    if (genesisBlock.identity) {
      if (genesisBlock.identity.username) {
        await storage.set(USERNAME_KEY, genesisBlock.identity.username);
      }
      if (genesisBlock.identity.email) {
        await storage.set(EMAIL_KEY, genesisBlock.identity.email);
      }
    }

    await storage.set('ledger:blocks', chain);

    // ── Save remote config ─────────────────────────────────────
    localStorage.setItem('phpoc_worker_url', baseUrl);
    if (apiKey) {
      localStorage.setItem('phpoc_api_key', apiKey);
    } else {
      localStorage.removeItem('phpoc_api_key');
    }
    localStorage.setItem('phpoc_deployment', 'saas');

    // ── Bootstrap services ─────────────────────────────────────
    await bootstrapServices({ crypto, masterKey, storage });

    // Store passphrase verification tokens for future logins
    try {
      const pdk = crypto.derivePdk(passphrase, PBKDF2_ITERATIONS);
      const passphraseHash = crypto.sha256(pdk + ':' + userSeed);
      await storage.set(STORED_PASSPHRASE_HASH_KEY, passphraseHash);
      const pdkToken = crypto.encrypt('phpoc_pdk_verify', pdk);
      await storage.set('phpoc_pdk_token', pdkToken);
    } catch (_) { /* non-critical */ }
  }, []);

  /**
   * Import a ledger from cloud storage (Worker → R2).
   *
   * Fetches a backup file from a Worker's `backups/` prefix, validates
   * the export seal and entry hashes, and writes the imported chain +
   * staging entries to local storage.
   *
   * Two auth paths:
   *   - passphrase_only: Genesis block has `recovery_seed_enc` → PDK derive,
   *     decrypt seed, derive master key, verify seal.
   *   - passphrase_seed: No encrypted seed → user provides seed directly,
   *     derive master key via PBKDF2, verify seal.
   *
   * @param {object} opts
   * @param {string} opts.baseUrl - Worker URL
   * @param {string} opts.apiKey - API key
   * @param {string} opts.filename - Backup filename on remote
   * @param {string} opts.passphrase - User's passphrase
   * @param {string|null} opts.seed - Recovery seed (null if passphrase-only)
   * @param {object|null} opts.genesisBlock - Genesis block (for seal verification)
   * @param {string} opts.authMode - 'passphrase_only' | 'passphrase_seed'
   */
  const importFromCloud = useCallback(async ({ baseUrl, apiKey, filename, source: importSource, passphrase, seed, genesisBlock, authMode }) => {
    setLoading(true);

    // ── 1. Initialize crypto — real WASM only, no fallback ───────
    const { CryptoService } = await import('../crypto/index.js');
    const crypto = await CryptoService.create();
    setCryptoStatus('wasm');

    // ── 2. Create transport and import source ────────────────────
    const transport = new HttpTransport({
      baseUrl: baseUrl.trim(),
      apiKey: apiKey || null,
    });
    const source = new WorkerImportSource(transport, crypto);

    // ── 3. Fetch and parse the backup (or chain) ──────────────────
    let importResult;
    try {
      // Determine master key based on auth mode
      let masterKey;

      if (authMode === 'passphrase_only' && genesisBlock) {
        // ── Passphrase-only: PDK → decrypt seed → master key ──
        let pdk;
        try {
          pdk = crypto.derivePdk(passphrase, PBKDF2_ITERATIONS);
        } catch (err) {
          setLoading(false);
          throw new Error(`Failed to derive key: ${err.message}`);
        }

        let decryptedSeed;
        try {
          decryptedSeed = crypto.decrypt(genesisBlock.identity.recovery_seed_enc, pdk);
          if (!decryptedSeed || decryptedSeed.length < 10) {
            throw new Error('Decrypted seed is invalid');
          }
        } catch (err) {
          setLoading(false);
          throw new Error('Wrong passphrase for this backup.');
        }

        try {
          masterKey = crypto.authenticate(passphrase, decryptedSeed, PBKDF2_ITERATIONS);
        } catch (err) {
          setLoading(false);
          throw new Error(`Authentication failed: ${err.message}`);
        }
      } else {
        // ── Passphrase+seed: direct authenticate ──
        if (!seed || !seed.trim()) {
          setLoading(false);
          throw new Error('Recovery seed is required for this backup.');
        }

        try {
          masterKey = crypto.authenticate(passphrase, seed.trim(), PBKDF2_ITERATIONS);
        } catch (err) {
          setLoading(false);
          throw new Error(`Authentication failed: ${err.message}`);
        }
      }

      crypto.setMasterKey(masterKey);

      // ── Fetch: chain or backup ──────────────────────────────
      if (importSource === 'chain') {
        // Pull the full chain from ledger/blocks/ (ph sync format)
        const chain = await WorkerImportSource.fetchChain(transport, crypto, masterKey);
        importResult = WorkerImportSource._validateRawChain(chain, crypto, masterKey);
      } else {
        // Traditional backup file import
        importResult = await source.fetchAndValidate(filename, masterKey);
      }
    } catch (err) {
      setLoading(false);
      throw err;
    }

    // ── 4. Verify genesis seal (passphrase-only path) ────────────
    // Extra check: if genesis was pre-fetched, verify it matches
    // the import data we just validated.
    if (authMode === 'passphrase_only' && genesisBlock && importResult.genesisBlock) {
      const fetchedGenesisHash = importResult.genesisBlock.day_hash;
      const expectedGenesisHash = genesisBlock.day_hash;
      if (fetchedGenesisHash !== expectedGenesisHash) {
        setLoading(false);
        throw new Error('Genesis block mismatch — backup may have been modified.');
      }
    }

    // ── 5. Write everything to storage ──────────────────────────
    const storage = await createStorage();
    await storage.clear();

    // Store seed for future logins
    if (authMode === 'passphrase_only' && genesisBlock) {
      // Re-derive to get the seed string for storage
      const pdk = crypto.derivePdk(passphrase, PBKDF2_ITERATIONS);
      const storedSeed = crypto.decrypt(genesisBlock.identity.recovery_seed_enc, pdk);
      await storage.set(STORED_SEED_KEY, storedSeed);
    } else if (seed) {
      await storage.set(STORED_SEED_KEY, seed.trim());
    }

    // Store identity info from genesis
    if (importResult.genesisBlock && importResult.genesisBlock.identity) {
      const ident = importResult.genesisBlock.identity;
      if (ident.username) await storage.set(USERNAME_KEY, ident.username);
      if (ident.email) await storage.set(EMAIL_KEY, ident.email);
    }

    // Write ledger chain
    if (importResult.ledger && Array.isArray(importResult.ledger) && importResult.ledger.length > 0) {
      await storage.set('ledger:blocks', importResult.ledger);
    }

    // Write staging entries
    if (importResult.entries && importResult.entries.length > 0) {
      await storage.set(ENTRIES_KEY, importResult.entries);
    }

    // ── 6. Save remote config ────────────────────────────────────
    localStorage.setItem('phpoc_worker_url', baseUrl.trim());
    if (apiKey) {
      localStorage.setItem('phpoc_api_key', apiKey.trim());
    } else {
      localStorage.removeItem('phpoc_api_key');
    }
    localStorage.setItem('phpoc_deployment', 'saas');

    // ── 7. Bootstrap services ────────────────────────────────────
    const masterKey = crypto.getMasterKey();
    await bootstrapServices({ crypto, masterKey, storage });
  }, []);

  /**
   * Import a ledger from an exported file (one-shot convenience).
   *
   * For enhanced UX with confirmation dialogs, use validateImport() +
   * confirmImport() instead. This function auto-confirms and is kept
   * for backward compatibility with OnboardingScreen.
   *
   * @deprecated Prefer validateImport() + confirmImport() for import flows
   *   that show destroy warnings and staging persistence options.
   */
  const importLedgerAction = useCallback(async (file, passphrase, seed) => {
    await validateImport(file, passphrase, seed);
    await confirmImport({ keepStaging: false });
  }, [validateImport, confirmImport]);

  /**
   * Export the current ledger.
   * Authenticates with passphrase, then triggers a file download.
   */
  const exportLedgerAction = useCallback(async (passphrase) => {
    const { crypto: existingCrypto, storage: existingStorage } = services;

    if (existingCrypto) {
      // ── Fast path: services already loaded (called from Settings) ──
      const blocks = await existingStorage.get('ledger:blocks');
      const result = await exportWithAuth({
        crypto: existingCrypto,
        storage: existingStorage,
        passphrase,
        blocks: blocks || [],
      });
      triggerDownload(result.blob, result.filename);
      return;
    }

    // ── Slow path: services not loaded (called from Onboarding) ──
    // Load on demand: create storage, init crypto, export with auth.
    const storage = await createStorage();

    const { CryptoService } = await import('../crypto/index.js');
    const crypto = await CryptoService.create();
    setCryptoStatus('wasm');

    const blocks = await storage.get('ledger:blocks');

    const result = await exportWithAuth({
      crypto,
      storage,
      passphrase,
      blocks: blocks || [],
    });
    triggerDownload(result.blob, result.filename);
  }, [services]);

  /**
   * Export the full ledger (committed chain only) for backup before import.
   *
   * Works in two modes:
   *   1. Services loaded (called from Settings) — uses services.crypto/storage
   *   2. Pending import (called from confirmation dialog) — uses pendingImportRef data
   */
  const exportLedgerFullAction = useCallback(async () => {
    // ── Mode 1: Pending import data (confirmation dialog) ──
    const pending = pendingImportRef.current;
    if (pending) {
      const { crypto, masterKey, existingBlocks } = pending;
      const blocks = existingBlocks || [];
      if (blocks.length === 0) {
        throw new Error('No data to export.');
      }
      const blob = await exportLedgerFull(blocks, crypto, masterKey);
      const timestamp = new Date().toISOString().slice(0, 10);
      triggerDownload(blob, `ph-ledger-full-export-${timestamp}.json`);
      return;
    }

    // ── Mode 2: Services loaded (Settings) ──
    const { crypto: existingCrypto, storage: existingStorage } = services;
    if (!existingCrypto || !existingStorage) {
      throw new Error('Services not loaded — cannot export.');
    }
    const masterKey = existingCrypto.getMasterKey();
    if (!masterKey) {
      throw new Error('Not authenticated — cannot export.');
    }
    const blocks = await existingStorage.get('ledger:blocks') || [];
    if (blocks.length === 0) {
      throw new Error('No data to export.');
    }
    const blob = await exportLedgerFull(blocks, existingCrypto, masterKey);
    const timestamp = new Date().toISOString().slice(0, 10);
    triggerDownload(blob, `ph-ledger-full-export-${timestamp}.json`);
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
    // Dispose cookie TTL monitor (stops polling before clearing MK)
    if (cookieMonitorRef.current) {
      cookieMonitorRef.current.dispose();
      cookieMonitorRef.current = null;
    }
    if (services.crypto) {
      services.crypto.clearMasterKey();
    }
    setTtlWarning(false);
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
    const toCommit = entries.filter((e) => entryIds.includes(e.entry_id) && !e.committed);
    if (toCommit.length === 0) return;

    // Create LedgerEngine
    const { LedgerEngine } = await import('../ledger/engine.js');
    const masterKey = crypto.getMasterKey();
    const engine = new LedgerEngine(crypto, storage, masterKey);

    // Commit
    const result = await engine.commit(toCommit);
    if (result && result.committedEntryIds.length > 0) {
      await sync.markCommitted(result.committedEntryIds, result.blockIndex);
      // Push committed blocks and updated staging blob to remote
      await sync.pushLedgerBlocks();
      const mk = crypto.getMasterKey();
      if (mk) {
        // Push updated staging blob with committed flags to remote.
        // Best-effort — merge_engine.js preserves the local committed flag
        // so a stale remote blob won't revert committed entries.
        await sync.pushBlobOnly(mk).catch((err) => {
          console.warn('commitEntries: pushBlobOnly failed, committed flags not yet on remote:', err.message);
        });
      }
    }
    return result;
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

    // Services (populated when ready) — sync is auto-sync wrapped
    // so every capture/end/pause/unpause/modify/remove call triggers
    // a debounced pushToRemote
    services: effectiveServices,

    // Crypto status
    cryptoStatus,

    // Auto-sync status (true during debounced pushToRemote)
    isAutoSyncing,

    // Storage backend quality
    storageStatus,

    // Auth state (derived from phase)
    user: {
      isAuthenticated: phase === 'ready',
      deviceId: phase === 'ready' && effectiveServices.crypto?.hasMasterKey?.()
        ? effectiveServices.crypto.getDeviceIdWithCachedKey?.() || 'unknown'
        : null,
      masterKeyCached: phase === 'ready' && !!effectiveServices.crypto?.hasMasterKey?.(),
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
    connectToWorker,
    importFromCloud,
    importLedger: importLedgerAction,
    validateImport,
    confirmImport,
    exportLedger: exportLedgerAction,
    exportLedgerFull: exportLedgerFullAction,
    logout,

    // Cookie TTL check
    checkCookieTtl,

    // Commit entries to ledger
    commitEntries,

    // Re-auth overlay
    reauthState,
    triggerReauth,
    dismissReauth,
    restartCookieMonitor,

    // TTL warning banner
    ttlWarning,
    dismissTtlWarning,

    // Genesis mismatch (surfaced from bootstrapServices)
    genesisMismatch,
    setGenesisMismatch,
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
 *   cryptoStatus: 'wasm'|'fallback',
 *   isAutoSyncing: boolean,
 *   storageStatus: 'persistent'|'session'|'memory',
 *   user: { isAuthenticated: boolean, deviceId: string|null, masterKeyCached: boolean, username: string|null, email: string|null },
 *   startLogin: () => void,
 *   startOnboarding: () => void,
 *   goBackToLanding: () => void,
 *   login: (passphrase: string) => Promise<void>,
 *   createNewLedger: (passphrase: string, username: string, email: string) => Promise<{seed: string} | void>,
 *   connectToWorker: (opts: {baseUrl: string, apiKey: string, passphrase: string, userSeed: string|null, genesisBlock: object|null, chain: object[]|null, format: string}) => Promise<void>,
 *   importFromCloud: (opts: {baseUrl: string, apiKey: string, filename: string|null, source?: 'backup'|'chain', passphrase: string, seed: string|null, genesisBlock: object|null, authMode: string}) => Promise<void>,
 *   importLedger: (file: File, passphrase: string, seed: string) => Promise<void>,
 *   validateImport: (file: File, passphrase: string, seed: string) => Promise<{needsConfirmation: boolean, genesisCheck: string, stagingCount: number, blocksCount: number, importEntryCount: number, formatVersion: string}>,
 *   confirmImport: (opts: {keepStaging?: boolean}) => Promise<void>,
 *   exportLedger: (passphrase: string) => Promise<void>,
 *   exportLedgerFull: () => Promise<void>,
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
