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
}
