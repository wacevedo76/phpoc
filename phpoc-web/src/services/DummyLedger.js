/**
 * DummyLedger — development-only mock data + service layer.
 *
 * Provides:
 *   - DummyCryptoService: mimics CryptoService interface without WASM
 *   - DummySyncService: wraps a MemoryBackend pre-populated with sample data
 *   - createDummyLedger(): factory to bootstrap the dev environment
 *
 * When DEV_MODE is active, these replace the real WASM-backed services.
 * Every screen component receives the same service interface — it never
 * needs to know if it's talking to real crypto or dummy data.
 */

import { MemoryBackend } from '../sync/storage.js';
import { LocalCache } from '../sync/local_cache.js';

// --------------------------------------------------------------------------
// Deterministic helpers — stable output for reproducible dev experience
// --------------------------------------------------------------------------

let _idCounter = 0;
function nextId() {
  _idCounter++;
  const hex = _idCounter.toString(16).padStart(12, '0');
  return `00000000-0000-4000-a000-${hex}00000000`;
}

function _btoa(str) {
  return typeof btoa === 'function'
    ? btoa(str)
    : Buffer.from(str).toString('base64');
}

function _atob(b64) {
  return typeof atob === 'function'
    ? atob(b64)
    : Buffer.from(b64, 'base64').toString('utf-8');
}

function _utf8Encode(str) {
  return new TextEncoder().encode(str);
}

function _utf8Decode(bytes) {
  return new TextDecoder().decode(bytes);
}

function _bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function deterministicHash(data) {
  // Simple djb2 hash → hex string (stable, no WASM needed)
  let hash = 5381;
  const str = typeof data === 'string' ? data : JSON.stringify(data);
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return (hash >>> 0).toString(16).padStart(64, '0');
}

// --------------------------------------------------------------------------
// DummyCryptoService
// --------------------------------------------------------------------------

class DummyCryptoService {
  constructor() {
    this._masterKey = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    this._ready = true;
  }

  // Singleton pattern (matches real CryptoService)
  static async create() {
    if (DummyCryptoService._instance) return DummyCryptoService._instance;
    DummyCryptoService._instance = new DummyCryptoService();
    return DummyCryptoService._instance;
  }
  static _instance = null;
  static reset() { DummyCryptoService._instance = null; }

  isReady() { return this._ready; }

  // Master key cache
  setMasterKey(hex) { this._masterKey = hex; }
  getMasterKey() { return this._masterKey; }
  hasMasterKey() { return !!this._masterKey; }
  clearMasterKey() { this._masterKey = null; }

  // Key derivation (no-ops in dummy mode)
  derivePdk(passphrase, iterations) { return deterministicHash(passphrase + iterations); }
  deriveMasterKey(seed) { return deterministicHash(seed); }
  deriveBlobKey(mk) { return deterministicHash(mk + 'blob'); }
  deriveSealKey(mk) { return deterministicHash(mk + 'seal'); }

  // AES encrypt/decrypt (dummy — just wraps in a marker)
  encrypt(plaintext, mk) { return `dummy_enc:${_btoa(plaintext)}`; }
  decrypt(ciphertextHex, mk) {
    if (ciphertextHex.startsWith('dummy_enc:')) {
      return _atob(ciphertextHex.slice(10));
    }
    return ciphertextHex;
  }
  encryptWithCachedKey(plaintext) { return this.encrypt(plaintext, this._masterKey); }
  decryptWithCachedKey(ct) { return this.decrypt(ct, this._masterKey); }

  // HMAC sealing
  seal(data, mk) { return deterministicHash(data + mk); }
  verifySeal(data, seal, mk) { return this.seal(data, mk) === seal; }
  mac(data, secret) { return deterministicHash(data + secret); }
  verifyMac(data, mac, secret) { return this.mac(data, secret) === mac; }

  // SHA-256
  sha256(data) { return deterministicHash(data); }

  // Blob obfuscation (no-op passthrough in dummy mode)
  obfuscateBlob(plaintext, mk) { return _btoa(plaintext); }
  deobfuscateBlob(b64, mk) { return _atob(b64); }
  obfuscateBlobWithCachedKey(plaintext) { return this.obfuscateBlob(plaintext, this._masterKey); }
  deobfuscateBlobWithCachedKey(b64) { return this.deobfuscateBlob(b64, this._masterKey); }

  // Random generation (deterministic in dummy mode)
  generateSeed() { return 'REVNT0RFU19ERUJVR19TRUVEX1dPTlRfV09SSw==' + _idCounter; }
  generateUuid() { return nextId(); }
  generateDeviceSpecifier() { return deterministicHash('specifier' + _idCounter); }

  // Device identity
  getDeviceId(mk) { return deterministicHash(mk + 'device'); }
  deviceProof(mk, deviceId) { return deterministicHash(mk + deviceId); }
  verifyDeviceProof(deviceId, proof, mk) { return this.deviceProof(mk, deviceId) === proof; }
  getDeviceIdWithCachedKey() { return this.getDeviceId(this._masterKey); }

  // Auth convenience
  authenticate(passphrase, seed, iterations) {
    return this.deriveMasterKey(this.derivePdk(passphrase, iterations) + seed);
  }
}

// --------------------------------------------------------------------------
// DummySyncService
// --------------------------------------------------------------------------

/**
 * A minimal SyncService-like object for development.
 *
 * Implements the same public API as SyncService (capture, end, pause,
 * unpause, readEntries, getActive, getCompleted, getPendingSync) but
 * works with a plain MemoryBackend + DummyCryptoService. No remote
 * transport, no cookies, no auth gate — just local CRUD with dummy data.
 */
class DummySyncService {
  constructor(crypto) {
    this._crypto = crypto;
    this._storage = new MemoryBackend();
    this._local = new LocalCache(this._storage, crypto);
  }

  /** Pre-populate with sample entries for development. */
  async seed() {
    const now = Date.now();

    // Active task #1 — running for ~25 min
    await this._local.append({
      title: 'Coding Practice',
      startEpoch: now - 25 * 60 * 1000,
      isActive: true,
      tags: ['coding', 'practice'],
      deviceUuid: 'dev-dummy-001',
    });

    // Active task #2 — running for ~1h 12min, currently paused
    const entry2 = await this._local.append({
      title: 'Reading',
      startEpoch: now - 72 * 60 * 1000,
      isActive: true,
      tags: ['reading', 'learning'],
      deviceUuid: 'dev-dummy-001',
    });
    // Add pause for Reading
    const entries = await this._local.readEntries();
    const readingIdx = entries.findIndex(e => e.title === 'Reading');
    if (readingIdx >= 0) {
      await this._local.addPause(readingIdx, now - 15 * 60 * 1000);
    }

    // Completed task from earlier today
    await this._local.append({
      title: 'Morning Exercise',
      startEpoch: now - 6 * 60 * 60 * 1000,
      endEpoch: now - 5.5 * 60 * 60 * 1000,
      isActive: false,
      tags: ['fitness', 'health'],
      deviceUuid: 'dev-dummy-001',
    });

    // Completed task from yesterday
    await this._local.append({
      title: 'Project Planning',
      startEpoch: now - 24 * 60 * 60 * 1000,
      endEpoch: now - 23.5 * 60 * 60 * 1000,
      isActive: false,
      tags: ['work', 'planning'],
      deviceUuid: 'dev-dummy-001',
    });
  }

  // ------------------------------------------------------------------
  // Local CRUD — delegate to LocalCache
  // ------------------------------------------------------------------

  async capture(params) {
    const hash = await this._local.append({ ...params, isActive: true });
    return hash;
  }

  async end(title, endEpoch, comment) {
    const entries = await this._local.readEntries();
    const idx = entries.findIndex(e => e.title === title && e.is_active);
    if (idx === -1) throw new Error(`No active task: ${title}`);

    if (entries[idx].is_paused) {
      await this._local.closePause(idx, endEpoch);
    }

    await this._local.update(idx, {
      end_epoch: endEpoch,
      is_active: false,
      end_device_uuid: 'dev-dummy-001',
    });

    const updated = await this._local.readEntries();
    const duration = LocalCache.computeDuration(
      updated[idx].start_epoch, endEpoch, updated[idx].pauses
    );
    await this._local.update(idx, { duration });
    if (comment) await this._local.update(idx, { comment });
  }

  async pause(title, pauseEpoch) {
    const entries = await this._local.readEntries();
    const idx = entries.findIndex(e => e.title === title && e.is_active);
    if (idx === -1) throw new Error(`No active task: ${title}`);
    await this._local.addPause(idx, pauseEpoch);
  }

  async unpause(title, unpauseEpoch) {
    const entries = await this._local.readEntries();
    const idx = entries.findIndex(e => e.title === title && e.is_active);
    if (idx === -1) throw new Error(`No active task: ${title}`);
    await this._local.closePause(idx, unpauseEpoch);
  }

  async readEntries() { return this._local.readEntries(); }
  async getActive() { return (await this._local.readEntries()).filter(e => e.is_active); }
  async getCompleted() { return (await this._local.readEntries()).filter(e => !e.is_active); }
  async getPendingSync() {
    return (await this._local.readEntries()).filter(e => !e.is_active && !e.is_paused);
  }

  // Unused in dev mode — no-ops
  async modify(idx, fields) { await this._local.update(idx, fields); }
  async remove(idx) { await this._local.delete(idx); }
  async removeSynced(indices) {
    if (indices?.length) {
      const sorted = [...indices].sort((a, b) => b - a);
      for (const i of sorted) await this._local.delete(i);
    }
  }

  // Remote stubs
  async checkAndSync() { return 'READY'; }
  async pushToRemote() { /* no-op */ }
  async pushBlobOnly() { /* no-op */ }
  async checkRemotePing() { return false; }
  get isRemoteAvailable() { return false; }
  get lastPushAt() { return 0; }
}

// --------------------------------------------------------------------------
// Factory
// --------------------------------------------------------------------------

/**
 * Bootstrap a full development ledger with dummy services + sample data.
 *
 * Usage (in App.jsx):
 *   const { crypto, sync } = await createDummyLedger();
 *   // ... provide via context ...
 */
export async function createDummyLedger() {
  const crypto = await DummyCryptoService.create();
  const sync = new DummySyncService(crypto);
  await sync.seed();
  return { crypto, sync };
}

export { DummyCryptoService, DummySyncService };
