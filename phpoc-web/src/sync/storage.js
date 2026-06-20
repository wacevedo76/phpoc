/**
 * StorageBackend — abstract interface for local key-value storage.
 *
 * The SyncService depends on this interface, never on a concrete storage
 * implementation. This allows transparent swapping:
 *   - IndexedDBBackend  → browser (production web)
 *   - MemoryBackend     → Node.js testing
 *   - Flutter           → native platform storage (Keychain + Hive/sqflite)
 *
 * Implements the StoragePlugin interface from storage_plugin.js.
 * Each method returns a Promise so the interface works with any async backend.
 */

import { StoragePlugin } from './storage_plugin.js';

export class StorageBackend extends StoragePlugin {
  get name() { return 'StorageBackend'; }
  get deployment() { return 'standalone'; }
  get isRemote() { return false; }

  /**
   * Retrieve a value by key.
   * @param {string} key
   * @returns {Promise<any|undefined>} The stored value, or undefined if not found.
   */
  async get(key) {
    throw new Error('StorageBackend.get() not implemented');
  }

  /**
   * Store a value by key.
   * @param {string} key
   * @param {any} value - Must be structured-clonable (JSON-serializable).
   * @returns {Promise<void>}
   */
  async set(key, value) {
    throw new Error('StorageBackend.set() not implemented');
  }

  /**
   * Remove a key and its value.
   * @param {string} key
   * @returns {Promise<void>}
   */
  async delete(key) {
    throw new Error('StorageBackend.delete() not implemented');
  }

  /**
   * Alias for delete() — backward compat with older callers.
   * @param {string} key
   * @returns {Promise<void>}
   */
  async remove(key) {
    return this.delete(key);
  }

  /**
   * List all keys matching the given prefix.
   * @param {string} [prefix='']
   * @returns {Promise<string[]>}
   */
  async list(prefix = '') {
    throw new Error('StorageBackend.list() not implemented');
  }

  /**
   * Remove all keys (factory reset).
   * @returns {Promise<void>}
   */
  async clear() {
    throw new Error('StorageBackend.clear() not implemented');
  }

  /**
   * List keys matching a prefix.
   * @param {string} prefix - Key prefix to filter by.
   * @returns {Promise<string[]>} Matching keys in sorted order.
   */
  async list(prefix) {
    throw new Error('StorageBackend.list() not implemented');
  }
}


/**
 * MemoryBackend — in-memory Map for Node.js testing.
 *
 * Data survives only as long as the process lives. Perfect for tests.
 * Also useful as a fallback when IndexedDB is unavailable.
 */
export class MemoryBackend extends StorageBackend {
  constructor() {
    super();
    /** @type {Map<string, any>} */
    this._store = new Map();
  }

  get name() { return 'Memory'; }

  async get(key) {
    return this._store.get(key);
  }

  async set(key, value) {
    this._store.set(key, value);
  }

  async delete(key) {
    this._store.delete(key);
  }

  async list(prefix = '') {
    const keys = [];
    for (const key of this._store.keys()) {
      if (key.startsWith(prefix)) keys.push(key);
    }
    return keys.sort();
  }

  async clear() {
    this._store.clear();
  }

  async list(prefix) {
    const keys = [];
    for (const key of this._store.keys()) {
      if (key.startsWith(prefix)) {
        keys.push(key);
      }
    }
    return keys.sort();
  }
}


/**
 * SessionStorageBackend — sessionStorage-based storage for private browsing.
 *
 * Uses `window.sessionStorage` which survives page refreshes within a
 * single browsing session (tab/window). Data is lost when the tab/window
 * is closed. Better than in-memory Map when IndexedDB is unavailable
 * (e.g. private/incognito browsing).
 *
 * Falls back to an in-memory Map if sessionStorage is also unavailable.
 */
export class SessionStorageBackend extends StorageBackend {
  /** @param {string} [prefix='phpoc:'] - Key prefix to namespace storage. */
  constructor(prefix = 'phpoc:') {
    super();
    this._prefix = prefix;
    /** @type {Map<string, any>|null} */
    this._fallback = null;
  }

  get name() { return this._fallback ? 'Memory (sessionStorage unavailable)' : 'SessionStorage'; }

  /** @private */
  _isAvailable() {
    if (this._fallback) return false;
    try {
      const testKey = this._prefix + '__test__';
      window.sessionStorage.setItem(testKey, '1');
      window.sessionStorage.removeItem(testKey);
      return true;
    } catch {
      return false;
    }
  }

  /** @private */
  _getStore() {
    if (this._fallback) return this._fallback;
    if (!this._isAvailable()) {
      this._fallback = new Map();
      return this._fallback;
    }
    return window.sessionStorage;
  }

  /** @private */
  _fullKey(key) {
    return this._prefix + key;
  }

  async get(key) {
    const store = this._getStore();
    if (store instanceof Map) return store.get(key);
    try {
      const raw = store.getItem(this._fullKey(key));
      return raw !== null ? JSON.parse(raw) : undefined;
    } catch {
      return undefined;
    }
  }

  async set(key, value) {
    const store = this._getStore();
    if (store instanceof Map) { store.set(key, value); return; }
    try {
      store.setItem(this._fullKey(key), JSON.stringify(value));
    } catch (err) {
      // QuotaExceededError or sessionStorage unavailable mid-session
      if (!this._fallback) {
        this._fallback = new Map();
        // Migrate existing data from sessionStorage to Map
        for (let i = 0; i < store.length; i++) {
          const k = store.key(i);
          if (k && k.startsWith(this._prefix)) {
            try {
              this._fallback.set(k.slice(this._prefix.length), JSON.parse(store.getItem(k)));
            } catch { /* skip corrupt entries */ }
          }
        }
      }
      this._fallback.set(key, value);
    }
  }

  async delete(key) {
    const store = this._getStore();
    if (store instanceof Map) { store.delete(key); return; }
    try {
      store.removeItem(this._fullKey(key));
    } catch { /* ignore */ }
  }

  async list(prefix = '') {
    const store = this._getStore();
    const keys = [];
    if (store instanceof Map) {
      for (const k of store.keys()) {
        if (k.startsWith(prefix)) keys.push(k);
      }
    } else {
      for (let i = 0; i < store.length; i++) {
        const rawKey = store.key(i);
        if (rawKey && rawKey.startsWith(this._prefix)) {
          const k = rawKey.slice(this._prefix.length);
          if (k.startsWith(prefix)) keys.push(k);
        }
      }
    }
    return keys.sort();
  }

  async clear() {
    const store = this._getStore();
    if (store instanceof Map) { store.clear(); return; }
    // Only remove our own prefixed keys
    const toRemove = [];
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k && k.startsWith(this._prefix)) toRemove.push(k);
    }
    for (const k of toRemove) store.removeItem(k);
  }
}
