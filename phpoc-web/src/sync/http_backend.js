/**
 * HttpBackend — StorageBackend adapter wrapping a Transport.
 *
 * Bridges the binary Transport interface (pull/push/listFiles/delete working
 * with Uint8Array) to the structured StorageBackend interface (get/set/remove/
 * clear/list working with JSON-serializable values).
 *
 * This enables use of a remote HTTP backend (Worker or bridge server) wherever
 * the code expects a StorageBackend (e.g., as a local cache or as a sync
 * endpoint in single-backend deployments).
 *
 * Usage:
 *   import { HttpBackend } from './http_backend.js';
 *   import { HttpTransport } from './transport.js';
 *
 *   const transport = new HttpTransport({ baseUrl: 'https://api.phpoc.app' });
 *   const backend = new HttpBackend({ transport });
 *
 *   await backend.set('staging/blobs/current.json', { entries: [...] });
 *   const blob = await backend.get('staging/blobs/current.json');
 *   const files = await backend.list('ledger/blocks/');
 *   await backend.remove('staging/blobs/old.json');
 *
 * The transport must implement:
 *   pull(path)       → Promise<Uint8Array | null>   (null on 404)
 *   push(path, data) → Promise<void>
 *   delete(path)     → Promise<void>
 *   listFiles(prefix)→ Promise<string[]>
 *   resetCache()     → void
 *
 * This matches HttpTransport and MockRemoteBackend.
 */

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Encode a JSON value as a Uint8Array for transport push.
 *
 * @param {any} value - Must be JSON-serializable.
 * @returns {Uint8Array} UTF-8 encoded bytes.
 */
function encodeValue(value) {
  const json = JSON.stringify(value);
  return new TextEncoder().encode(json);
}

/**
 * Decode a Uint8Array from transport pull into a JSON value.
 *
 * @param {Uint8Array} bytes
 * @returns {any} Parsed JSON value.
 */
function decodeBytes(bytes) {
  const json = new TextDecoder().decode(bytes);
  return JSON.parse(json);
}

// ── HttpBackend ──────────────────────────────────────────────────────

export class HttpBackend {
  /**
   * @param {object} options
   * @param {object} options.transport - Must implement pull/push/delete/listFiles.
   */
  constructor({ transport } = {}) {
    if (!transport) {
      throw new Error(
        'HttpBackend: transport is required'
      );
    }

    // Validate required methods
    const required = ['pull', 'push', 'delete', 'listFiles'];
    for (const method of required) {
      if (typeof transport[method] !== 'function') {
        throw new Error(
          `HttpBackend: transport must implement ${method}()`
        );
      }
    }

    /** @private */
    this._transport = transport;
  }

  // ------------------------------------------------------------------
  // StorageBackend interface
  // ------------------------------------------------------------------

  /**
   * Retrieve a JSON value by remote path key.
   *
   * Maps to transport.pull(key). If the remote returns null (404),
   * returns undefined to match the StorageBackend contract.
   *
   * @param {string} key - Remote path (e.g., "staging/blobs/current.json").
   * @returns {Promise<any|undefined>} Parsed JSON value, or undefined if not found.
   * @throws {Error} On network errors or invalid JSON response.
   */
  async get(key) {
    const bytes = await this._transport.pull(key);
    if (bytes === null) {
      return undefined;
    }
    try {
      return decodeBytes(bytes);
    } catch (err) {
      throw new Error(
        `HttpBackend.get(${key}): invalid JSON response: ${err.message}`
      );
    }
  }

  /**
   * Store a JSON value at a remote path key.
   *
   * Serializes the value to JSON, encodes as UTF-8 bytes, and pushes
   * to the transport.
   *
   * @param {string} key - Remote path (e.g., "staging/blobs/current.json").
   * @param {any} value - Must be JSON-serializable.
   * @returns {Promise<void>}
   * @throws {Error} On serialization failure or network errors.
   */
  async set(key, value) {
    let bytes;
    try {
      bytes = encodeValue(value);
    } catch (err) {
      throw new Error(
        `HttpBackend.set(${key}): value not JSON-serializable: ${err.message}`
      );
    }
    await this._transport.push(key, bytes);
  }

  /**
   * Remove a remote blob by path key.
   *
   * Maps to transport.delete(key). Does not throw if the key did not exist.
   *
   * @param {string} key - Remote path to delete.
   * @returns {Promise<void>}
   */
  async remove(key) {
    await this._transport.delete(key);
  }

  /**
   * Clear is not supported for remote storage.
   *
   * Remote storage is a shared resource shared across sessions,
   * devices, and potentially users. Clearing it would destroy data
   * that other clients depend on.
   *
   * @throws {Error} Always throws — not supported.
   */
  async clear() {
    throw new Error(
      'HttpBackend.clear() is not supported for remote storage. ' +
      'Use remove() to delete individual keys.'
    );
  }

  /**
   * List remote paths matching a prefix.
   *
   * Maps to transport.listFiles(prefix).
   *
   * @param {string} prefix - Path prefix to filter by.
   * @returns {Promise<string[]>} Matching paths in sorted order.
   */
  async list(prefix) {
    return this._transport.listFiles(prefix);
  }
}
