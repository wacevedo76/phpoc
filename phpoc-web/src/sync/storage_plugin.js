/**
 * StoragePlugin — abstract interface for all storage backends.
 *
 * The entire sync/ledger layer depends on this interface, never on a
 * concrete backend. This allows transparent swapping across deployments:
 *
 *   | Deployment         | Backend              | Multi-user |
 *   |--------------------|----------------------|------------|
 *   | Standalone PWA     | IndexedDBBackend     | Single     |
 *   | Local / LAN        | HttpBackend (bridge) | Single     |
 *   | Docker / LXC       | HttpBackend (bridge) | Single     |
 *   | SaaS               | HttpBackend (Worker) | Multi-tenant |
 *
 * Every method returns a Promise so the interface works with async backends
 * (IndexedDB, HTTP, native storage via FFI).
 *
 * @interface
 */
export class StoragePlugin {
  /**
   * Human-readable name for config display (e.g. "IndexedDB", "HTTP Bridge").
   * @type {string}
   */
  get name() {
    throw new Error('StoragePlugin.name not implemented');
  }

  /**
   * Deployment type identifier (e.g. "standalone", "lan", "saas").
   * @type {string}
   */
  get deployment() {
    throw new Error('StoragePlugin.deployment not implemented');
  }

  /**
   * True if this backend connects to a remote server (network required).
   * @type {boolean}
   */
  get isRemote() {
    throw new Error('StoragePlugin.isRemote not implemented');
  }

  /**
   * Retrieve a value by key.
   * @param {string} key
   * @returns {Promise<any|undefined>} The stored value, or undefined if not found.
   */
  async get(key) {
    throw new Error('StoragePlugin.get() not implemented');
  }

  /**
   * Store a value by key.
   * @param {string} key
   * @param {any} value — Must be structured-clonable (JSON-serializable).
   * @returns {Promise<void>}
   */
  async set(key, value) {
    throw new Error('StoragePlugin.set() not implemented');
  }

  /**
   * Remove a single key and its value.
   * @param {string} key
   * @returns {Promise<void>}
   */
  async delete(key) {
    throw new Error('StoragePlugin.delete() not implemented');
  }

  /**
   * List all keys matching the given prefix.
   * @param {string} [prefix=''] — Optional prefix to filter keys.
   * @returns {Promise<string[]>} Array of matching keys.
   */
  async list(prefix = '') {
    throw new Error('StoragePlugin.list() not implemented');
  }

  /**
   * Remove all keys (factory reset).
   * @returns {Promise<void>}
   */
  async clear() {
    throw new Error('StoragePlugin.clear() not implemented');
  }
}
