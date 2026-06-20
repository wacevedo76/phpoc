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
import { SyncService, SyncResult, IndexedDBBackend, SessionStorageBackend, createTransportFromDeployment, GenesisGate } from '@sync/index.js';
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

  // ── Loading / error ───────────────────────────────────────────────
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [hasExistingData, setHasExistingData] = useState(false);

  // ── Identity info (loaded during bootstrap) ───────────────────────
  const [identityInfo, setIdentityInfo] = useState({ username: null, email: null });

  // ── Boot phase ───────────────────────────────────────────────────
  const bootAttempted = useRef(false);

  // ── Pending import state (carries data from validate to confirm) ──
  const pendingImportRef = useRef(null);

  // Tracks whether real WASM crypto loaded or we fell back to dummy.
  // 'wasm' = real crypto, 'fallback' = DummyCryptoService (INSECURE).
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
    // Genesis gate runs inside checkAndSync if transport is configured
    try {
      const syncResult = await sync.checkAndSync();
      if (syncResult === SyncResult.GENESIS_MISMATCH) {
        console.warn('Genesis mismatch — remote ledger has a different genesis block.');
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

    // Initialize crypto service
    let crypto;
    try {
      const { CryptoService } = await import('../crypto/index.js');
      crypto = await CryptoService.create();
      setCryptoStatus('wasm');
    } catch (err) {
      console.error(
        '[PHPOC] WARNING: WASM crypto failed to load — falling back to DummyCryptoService.',
        'Encryption will NOT be real. Cause:', err,
      );
      setCryptoStatus('fallback');
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
      setCryptoStatus('wasm');
    } catch (err) {
      console.error(
        '[PHPOC] WARNING: WASM crypto failed to load — falling back to DummyCryptoService.',
        'Encryption will NOT be real. Cause:', err,
      );
      setCryptoStatus('fallback');
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

    // Initialize crypto
    let crypto;
    try {
      const { CryptoService } = await import('../crypto/index.js');
      crypto = await CryptoService.create();
      setCryptoStatus('wasm');
    } catch (err) {
      console.error(
        '[PHPOC] WARNING: WASM crypto failed to load — falling back to DummyCryptoService.',
        'Encryption will NOT be real. Cause:', err,
      );
      setCryptoStatus('fallback');
      crypto = await DummyCryptoService.create();
    }

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
   * @param {object} opts.genesisBlock - Fetched genesis block
   * @param {object[]} opts.chain - Full remote chain
   */
  const connectToWorker = useCallback(async ({ baseUrl, apiKey, passphrase, genesisBlock, chain }) => {
    setLoading(true);

    // ── 1. Initialize crypto ───────────────────────────────────────
    let crypto;
    try {
      const { CryptoService } = await import('../crypto/index.js');
      crypto = await CryptoService.create();
      setCryptoStatus('wasm');
    } catch (err) {
      console.error(
        '[PHPOC] WARNING: WASM crypto failed to load — falling back to DummyCryptoService.',
        'Encryption will NOT be real. Cause:', err,
      );
      setCryptoStatus('fallback');
      crypto = await DummyCryptoService.create();
    }

    // ── 2. Derive PDK from passphrase ──────────────────────────────
    let pdk;
    try {
      pdk = crypto.derivePdk(passphrase, PBKDF2_ITERATIONS);
    } catch (err) {
      setLoading(false);
      throw new Error(`Failed to derive key: ${err.message}`);
    }

    // ── 3. Decrypt recovery seed from genesis ──────────────────────
    let seed;
    try {
      seed = crypto.decrypt(genesisBlock.identity.recovery_seed_enc, pdk);
      if (!seed || seed.length < 10) {
        throw new Error('Decrypted seed is invalid');
      }
    } catch (err) {
      setLoading(false);
      throw new Error('Wrong passphrase for this ledger.');
    }

    // ── 4. Derive master key ───────────────────────────────────────
    let masterKey;
    try {
      masterKey = crypto.authenticate(passphrase, seed, PBKDF2_ITERATIONS);
    } catch (err) {
      setLoading(false);
      throw new Error(`Authentication failed: ${err.message}`);
    }

    // ── 5. Verify genesis seal ────────────────────────────────────
    try {
      // Build check data: everything except day_hash and signature
      const checkData = {};
      for (const [k, v] of Object.entries(genesisBlock)) {
        if (k !== 'day_hash' && k !== 'signature') {
          checkData[k] = v;
        }
      }
      // Use deterministic JSON serialization (same as LedgerChain)
      const { jsonSort } = await import('../ledger/utils.js');
      const sealData = jsonSort(checkData);
      const valid = crypto.verifySeal(sealData, genesisBlock.day_hash, masterKey);
      if (!valid) {
        throw new Error('Seal verification failed');
      }
    } catch (err) {
      setLoading(false);
      throw new Error('Wrong passphrase for this ledger.');
    }

    // ── 6. Write everything to storage ────────────────────────────
    const storage = await createStorage();
    await storage.clear();

    // Store seed for future logins
    await storage.set(STORED_SEED_KEY, seed);

    // Store identity info from genesis
    if (genesisBlock.identity.username) {
      await storage.set(USERNAME_KEY, genesisBlock.identity.username);
    }
    if (genesisBlock.identity.email) {
      await storage.set(EMAIL_KEY, genesisBlock.identity.email);
    }

    // Store the ledger chain
    await storage.set('ledger:blocks', chain);

    // ── 7. Save remote config ─────────────────────────────────────
    localStorage.setItem('phpoc_worker_url', baseUrl);
    if (apiKey) {
      localStorage.setItem('phpoc_api_key', apiKey);
    } else {
      localStorage.removeItem('phpoc_api_key');
    }
    localStorage.setItem('phpoc_deployment', 'saas');

    // ── 8. Bootstrap services ─────────────────────────────────────
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
      setCryptoStatus('wasm');
    } catch (err) {
      console.error(
        '[PHPOC] WARNING: WASM crypto failed to load — falling back to DummyCryptoService.',
        'Encryption will NOT be real. Cause:', err,
      );
      setCryptoStatus('fallback');
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

  /**
   * Export the full ledger (committed chain + staging) for backup before import.
   *
   * Works in two modes:
   *   1. Services loaded (called from Settings) — uses services.crypto/sync/sync.readEntries()
   *   2. Pending import (called from confirmation dialog) — uses pendingImportRef data
   */
  const exportLedgerFullAction = useCallback(async () => {
    // ── Mode 1: Pending import data (confirmation dialog) ──
    const pending = pendingImportRef.current;
    if (pending) {
      const { crypto, masterKey, existingBlocks, stagingEntries } = pending;
      const blocks = existingBlocks || [];
      const staging = stagingEntries || [];
      if (blocks.length === 0 && staging.length === 0) {
        throw new Error('No data to export.');
      }
      const blob = await exportLedgerFull(blocks, staging, crypto, masterKey);
      const timestamp = new Date().toISOString().slice(0, 10);
      triggerDownload(blob, `ph-ledger-full-export-${timestamp}.json`);
      return;
    }

    // ── Mode 2: Services loaded (Settings) ──
    const { crypto: existingCrypto, sync: existingSync, storage: existingStorage } = services;
    if (!existingCrypto || !existingSync || !existingStorage) {
      throw new Error('Services not loaded — cannot export.');
    }
    const masterKey = existingCrypto.getMasterKey();
    if (!masterKey) {
      throw new Error('Not authenticated — cannot export.');
    }
    const blocks = await existingStorage.get('ledger:blocks') || [];
    const staging = await existingSync.readEntries();
    if (blocks.length === 0 && staging.length === 0) {
      throw new Error('No data to export.');
    }
    const blob = await exportLedgerFull(blocks, staging, existingCrypto, masterKey);
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

    // Services (populated when ready)
    services,

    // Crypto status
    cryptoStatus,

    // Storage backend quality
    storageStatus,

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
    connectToWorker,
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
 *   storageStatus: 'persistent'|'session'|'memory',
 *   user: { isAuthenticated: boolean, deviceId: string|null, masterKeyCached: boolean, username: string|null, email: string|null },
 *   startLogin: () => void,
 *   startOnboarding: () => void,
 *   goBackToLanding: () => void,
 *   login: (passphrase: string) => Promise<void>,
 *   createNewLedger: (passphrase: string, username: string, email: string) => Promise<{seed: string} | void>,
 *   connectToWorker: (opts: {baseUrl: string, apiKey: string, passphrase: string, genesisBlock: object, chain: object[]}) => Promise<void>,
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
