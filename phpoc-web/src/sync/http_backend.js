/**
 * HttpBackend — StoragePlugin backed by an HTTP server (bridge or Worker).
 *
 * Wraps HttpTransport as a StoragePlugin, so the SyncService and LedgerEngine
 * can use an HTTP remote as their storage layer without any code changes.
 *
 * This serves three deployment targets:
 *   - **Companion bridge server** (Python, ~50 lines) for local network / LAN
 *   - **Docker / LXC** with bundled bridge server
 *   - **Cloudflare Worker → R2** (SaaS)
 *
 * Storage paths on the remote server follow the CLI constants:
 *   staging/blobs/current.json
 *   staging/blobs/device_cookie.bin
 *   ledger/blocks/{seq}.json
 *   ledger/index.json
 *
 * Usage:
 *   import { HttpBackend } from '@sync/http_backend.js';
 *   const storage = new HttpBackend({ baseUrl: 'http://localhost:8080' });
 *   await storage.set('staging/blobs/current.json', blobData);
 *   const data = await storage.get('staging/blobs/current.json');
 *   const paths = await storage.list('ledger/blocks/');
 */

import { HttpTransport } from './transport.js';

export class HttpBackend {
  /**
   * @param {object} options
   * @param {string} options.baseUrl — Base URL of the bridge server or Worker.
   * @param {string} [options.apiKey] — Optional X-Api-Key header value.
   */
  constructor({ baseUrl, apiKey } = {}) {
    if (!baseUrl) {
      throw new Error('HttpBackend: baseUrl must not be empty');
    }
    /** @private */
    this._transport = new HttpTransport({ baseUrl, apiKey });
  }

  get name() { return 'HTTP Backend'; }
  get deployment() { return 'saas'; }
  get isRemote() { return true; }

  /**
   * Retrieve a value by storage path.
   *
   * Maps to a GET via HttpTransport.pull().
   * Returns undefined on 404 (matching the StoragePlugin contract).
   *
   * @param {string} key — Storage path (e.g. "staging/blobs/current.json").
   * @returns {Promise<Uint8Array|undefined>}
   */
  async get(key) {
    const body = await this._transport.pull(key);
    return body ?? undefined;
  }

  /**
   * Store a value by storage path.
   *
   * Maps to a PUT via HttpTransport.push().
   * Accepts Uint8Array, string, or any JSON-serializable value (auto-encoded).
   *
   * @param {string} key — Storage path.
   * @param {any} value — Uint8Array, string, or JSON-serializable object.
   * @returns {Promise<void>}
   */
  async set(key, value) {
    let data;
    if (value instanceof Uint8Array) {
      data = value;
    } else if (typeof value === 'string') {
      data = new TextEncoder().encode(value);
    } else {
      // JSON-serializable object → encode as UTF-8 JSON
      data = new TextEncoder().encode(JSON.stringify(value));
    }
    await this._transport.push(key, data);
  }

  /**
   * Remove a key — not supported on remote backends.
   *
   * HTTP storage is append-only by design. This is a no-op for remote
   * storage; the cookie TTL and block overwrite-by-sequence-number
   * provide the equivalent lifecycle.
   *
   * @param {string} key
   * @returns {Promise<void>}
   */
  async delete(key) {
    // No-op: remote storage is append-only
  }

  /**
   * Alias for delete().
   * @param {string} key
   * @returns {Promise<void>}
   */
  async remove(key) {
    return this.delete(key);
  }

  /**
   * List all keys matching the given prefix.
   *
   * Maps to HttpTransport.listFiles(prefix).
   *
   * @param {string} [prefix='']
   * @returns {Promise<string[]>}
   */
  async list(prefix = '') {
    return this._transport.listFiles(prefix);
  }

  /**
   * Clear all entries — not supported on remote backends.
   * @returns {Promise<void>}
   */
  async clear() {
    // No-op: remote storage is append-only
  }

  /**
   * Access the underlying HttpTransport for direct pull/push/listFiles
   * when needed (e.g., by RemoteSync for blob obfuscation layers).
   * @returns {HttpTransport}
   */
  get transport() {
    return this._transport;
  }

  /**
   * Reset ETag cache on the underlying transport.
   */
  resetCache() {
    this._transport.resetCache();
  }
}
