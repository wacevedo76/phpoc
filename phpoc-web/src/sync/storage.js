/**
 * StorageBackend — abstract interface for local key-value storage.
 *
 * The SyncService depends on this interface, never on a concrete storage
 * implementation. This allows transparent swapping:
 *   - IndexedDBBackend  → browser (production web)
 *   - MemoryBackend     → Node.js testing
 *   - Flutter           → native platform storage (Keychain + Hive/sqflite)
 *
 * Each method returns a Promise so the interface works with any async backend.
 */

export class StorageBackend {
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
  async remove(key) {
    throw new Error('StorageBackend.remove() not implemented');
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

  async get(key) {
    return this._store.get(key);
  }

  async set(key, value) {
    this._store.set(key, value);
  }

  async remove(key) {
    this._store.delete(key);
  }

  async clear() {
    this._store.clear();
  }
}
