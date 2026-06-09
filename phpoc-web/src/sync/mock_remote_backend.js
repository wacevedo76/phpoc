/**
 * MockRemoteBackend — in-browser simulation of R2/S3 storage.
 *
 * For development and testing without an actual Cloudflare Worker.
 * Simulates:
 *   - Configurable latency (default 50ms read, 100ms write)
 *   - ETag-based conditional responses (304 Not Modified)
 *   - 404 on missing keys
 *   - 404 on list() for non-existent prefixes
 *   - Configurable error rate for testing failure modes
 *
 * The StoragePlugin contract requires get() to return the original value
 * type. MockRemoteBackend tracks the original value type alongside the
 * stored bytes, so strings round-trip as strings, objects as objects, etc.
 *
 * getWithMeta() is the low-level interface — it always returns Uint8Array
 * for the data field (simulating an HTTP binary body).
 *
 * Usage:
 *   import { MockRemoteBackend } from '@sync/mock_remote_backend.js';
 *   const remote = new MockRemoteBackend({ latencyMs: 50 });
 *   await remote.set('ledger/blocks/0.json', data);
 *   const data = await remote.get('ledger/blocks/0.json');
 *   const keys = await remote.list('ledger/');
 */

import { MemoryBackend } from './storage.js';

/** @typedef {'uint8'|'string'|'object'} ValueType */

export class MockRemoteBackend {
  /**
   * @param {object} [options]
   * @param {number} [options.latencyMs=50] — Simulated network latency in ms.
   * @param {number} [options.writeLatencyMs=100] — Write latency (default 2x read).
   * @param {number} [options.errorRate=0] — Fraction of requests that fail (0.0–1.0).
   * @param {number} [options.seed=42] — Seed for deterministic error simulation.
   */
  constructor({ latencyMs = 50, writeLatencyMs, errorRate = 0, seed = 42 } = {}) {
    /** @private — Map<key, Uint8Array> */
    this._store = new MemoryBackend();
    /** @private — Map<key, ValueType> */
    this._types = new Map();
    /** @private — Map<key, string> etag (quoted) */
    this._etags = new Map();
    /** @private */
    this._latencyMs = latencyMs;
    /** @private */
    this._writeLatencyMs = writeLatencyMs ?? latencyMs * 2;
    /** @private */
    this._errorRate = errorRate;
    /** @private */
    this._seed = seed;
  }

  get name() { return 'Mock Remote'; }
  get deployment() { return 'mock'; }
  get isRemote() { return true; }

  // ------------------------------------------------------------------
  // Low-level API (simulates raw HTTP binary body)
  // ------------------------------------------------------------------

  /**
   * Simulate a GET — always returns Uint8Array in data field.
   * Sends 304 if If-None-Match matches current ETag.
   *
   * @param {string} key
   * @param {{ ifNoneMatch?: string }} [options]
   * @returns {Promise<{ data: Uint8Array|null, etag: string|null, status: number }>}
   */
  async getWithMeta(key, { ifNoneMatch } = {}) {
    await this._simulateLatency(this._latencyMs);
    this._maybeThrow();

    const raw = await this._store.get(key);
    const currentEtag = this._etags.get(key) || null;

    if (raw === undefined) {
      return { data: null, etag: null, status: 404 };
    }

    if (ifNoneMatch && ifNoneMatch === currentEtag) {
      return { data: null, etag: currentEtag, status: 304 };
    }

    return { data: raw, etag: currentEtag, status: 200 };
  }

  /**
   * Simulate a PUT — stores bytes and generates an ETag.
   *
   * @param {string} key
   * @param {Uint8Array|string|any} value
   * @returns {Promise<{ etag: string }>}
   */
  async setWithMeta(key, value) {
    await this._simulateLatency(this._writeLatencyMs);
    this._maybeThrow();

    const { bytes } = this._encode(value);
    await this._store.set(key, bytes);

    const etag = await this._computeEtag(bytes);
    this._etags.set(key, `"${etag}"`);

    return { etag: `"${etag}"` };
  }

  // ------------------------------------------------------------------
  // StoragePlugin interface (preserves original value types)
  // ------------------------------------------------------------------

  /**
   * Retrieve a value by key, returning the original type.
   *
   * @param {string} key
   * @returns {Promise<any|undefined>}
   */
  async get(key) {
    await this._simulateLatency(this._latencyMs);
    this._maybeThrow();

    const raw = await this._store.get(key);
    if (raw === undefined) return undefined;

    const type = this._types.get(key) || 'uint8';
    return this._decode(raw, type);
  }

  /**
   * Store a value by key. Type is tracked for faithful round-trip.
   *
   * @param {string} key
   * @param {Uint8Array|string|any} value
   * @returns {Promise<void>}
   */
  async set(key, value) {
    const { bytes, type } = this._encode(value);
    await this._simulateLatency(this._writeLatencyMs);
    this._maybeThrow();
    await this._store.set(key, bytes);
    this._types.set(key, type);

    const etag = await this._computeEtag(bytes);
    this._etags.set(key, `"${etag}"`);
  }

  /**
   * Remove a key.
   * @param {string} key
   * @returns {Promise<void>}
   */
  async delete(key) {
    await this._simulateLatency(this._latencyMs);
    this._maybeThrow();
    await this._store.delete(key);
    this._types.delete(key);
    this._etags.delete(key);
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
   * List keys matching prefix.
   * @param {string} [prefix='']
   * @returns {Promise<string[]>}
   */
  async list(prefix = '') {
    await this._simulateLatency(this._latencyMs);
    this._maybeThrow();
    return this._store.list(prefix);
  }

  /**
   * Clear all data, types, and ETags.
   * @returns {Promise<void>}
   */
  async clear() {
    await this._store.clear();
    this._types.clear();
    this._etags.clear();
  }

  /**
   * Reset ETag cache only (keep data).
   */
  resetCache() {
    this._etags.clear();
  }

  /**
   * Get the current ETag for a key, if any.
   * @param {string} key
   * @returns {string|null}
   */
  getEtag(key) {
    return this._etags.get(key) || null;
  }

  // ------------------------------------------------------------------
  // Private: encode/decode preserving value types
  // ------------------------------------------------------------------

  /**
   * Encode a value to Uint8Array, tracking the original type.
   * @param {any} value
   * @returns {{ bytes: Uint8Array, type: ValueType }}
   * @private
   */
  _encode(value) {
    if (value instanceof Uint8Array) {
      return { bytes: value, type: 'uint8' };
    }
    if (typeof value === 'string') {
      return { bytes: new TextEncoder().encode(value), type: 'string' };
    }
    // Objects and other types — serialize to JSON bytes
    return {
      bytes: new TextEncoder().encode(JSON.stringify(value)),
      type: 'object',
    };
  }

  /**
   * Decode bytes back to the original value type.
   * @param {Uint8Array} bytes
   * @param {ValueType} type
   * @returns {any}
   * @private
   */
  _decode(bytes, type) {
    switch (type) {
      case 'uint8':
        return bytes;
      case 'string':
        return new TextDecoder().decode(bytes);
      case 'object':
        try {
          return JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          // JSON parse can fail for binary data stored as object
          return bytes;
        }
      default:
        return bytes;
    }
  }

  /** @private */
  async _computeEtag(data) {
    let hash = 5381;
    for (let i = 0; i < data.length; i++) {
      hash = ((hash << 5) + hash) + data[i];
      hash = hash & hash;
    }
    return (hash >>> 0).toString(16).padStart(32, '0');
  }

  /** @private */
  async _simulateLatency(ms) {
    if (ms > 0) {
      await new Promise(r => setTimeout(r, ms));
    }
  }

  /** @private */
  _maybeThrow() {
    if (this._errorRate > 0) {
      this._seed = (this._seed * 1103515245 + 12345) & 0x7fffffff;
      const r = this._seed / 0x7fffffff;
      if (r < this._errorRate) {
        throw new Error('MockRemoteBackend: simulated network error');
      }
    }
  }
}
