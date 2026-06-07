/**
 * IndexedDBBackend — IndexedDB-backed StorageBackend using idb-keyval.
 *
 * Uses `idb-keyval` for a simple get/set/delete API over IndexedDB.
 * Data survives tab close, browser restart, and site navigations.
 * Storage is effectively unlimited (browser-dependent, typically >50MB).
 *
 * The default store name is 'phpoc-sync' to namespace within the app's
 * broader IndexedDB usage (if any).
 *
 * Usage:
 *   import { IndexedDBBackend } from './indexeddb_storage.js';
 *   const storage = new IndexedDBBackend();
 *   await storage.set('cookie', { device_specifier: 'abc', creation_time: 123 });
 *   const cookie = await storage.get('cookie');
 *
 * Browser support: Chrome 24+, Firefox 16+, Safari 8+, Edge 12+
 * Node.js: requires fake-indexeddb polyfill or use MemoryBackend for tests.
 */

import { get, set, del, clear, createStore } from 'idb-keyval';

export class IndexedDBBackend {
  /**
   * @param {string} [storeName='phpoc-sync'] - IndexedDB store name.
   */
  constructor(storeName = 'phpoc-sync') {
    /** @private */
    this._store = createStore('phpoc-db', storeName);
  }

  /**
   * Retrieve a value by key.
   * @param {string} key
   * @returns {Promise<any|undefined>}
   */
  async get(key) {
    try {
      return await get(key, this._store);
    } catch (err) {
      throw new Error(
        `IndexedDBBackend: error reading key "${key}": ${err.message}`
      );
    }
  }

  /**
   * Store a value by key.
   * @param {string} key
   * @param {any} value - Must be structured-clonable.
   * @returns {Promise<void>}
   */
  async set(key, value) {
    try {
      await set(key, value, this._store);
    } catch (err) {
      throw new Error(
        `IndexedDBBackend: error writing key "${key}": ${err.message}`
      );
    }
  }

  /**
   * Remove a key and its value.
   * @param {string} key
   * @returns {Promise<void>}
   */
  async remove(key) {
    try {
      await del(key, this._store);
    } catch (err) {
      throw new Error(
        `IndexedDBBackend: error deleting key "${key}": ${err.message}`
      );
    }
  }

  /**
   * Remove all keys in the store (factory reset).
   * @returns {Promise<void>}
   */
  async clear() {
    try {
      await clear(this._store);
    } catch (err) {
      throw new Error(
        `IndexedDBBackend: error clearing store: ${err.message}`
      );
    }
  }
}
