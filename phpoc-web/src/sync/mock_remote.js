/**
 * MockRemoteBackend — in-browser simulation of R2/S3 blob storage.
 *
 * Implements the same transport contract as HttpTransport:
 *   pull(path)       → Promise<Uint8Array | null>   (null on 404)
 *   push(path, data) → Promise<void>
 *   listFiles(prefix)→ Promise<string[]>
 *   resetCache()     → void
 *
 * Instead of making HTTP requests, it stores blobs in an IndexedDB
 * partition (or any StorageBackend). This lets the real SyncService
 * run against a simulated remote without any network infrastructure.
 *
 * R2-like behaviors included:
 *   - Configurable latency (default 50ms)
 *   - ETag tracking (content-addressed hashes)
 *   - 404 on missing paths
 *   - Path-prefix listing
 *   - Toggle-able error simulation
 *
 * Usage:
 *   import { MockRemoteBackend } from './mock_remote.js';
 *   const remote = new MockRemoteBackend();
 *   await remote.push('staging/blobs/current.json', data);
 *   const bytes = await remote.pull('staging/blobs/current.json');
 *   const files = await remote.listFiles('staging/blobs/');
 *
 * Testing (with MemoryBackend):
 *   const memStorage = new MemoryBackend();
 *   const remote = new MockRemoteBackend({ storage: memStorage });
 */

import { createStore, get, set, del, keys, clear as idbClear } from 'idb-keyval';

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/**
 * Compute a hex SHA-256 hash from bytes, using Web Crypto API.
 * Falls back to a simple djb2 hash when SubtleCrypto is unavailable.
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<string>}
 */
async function computeEtag(bytes) {
  if (typeof crypto !== 'undefined' && crypto.subtle?.digest) {
    try {
      const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    } catch {
      // Fall through to fallback
    }
  }

  // Simple djb2 fallback — deterministic, no hashing API needed
  let hash = 5381;
  for (let i = 0; i < bytes.length; i++) {
    hash = ((hash << 5) + hash) + bytes[i];
    hash = hash & hash;
  }
  return (hash >>> 0).toString(16).padStart(64, '0');
}

/**
 * Deep clone bytes via structured clone.
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
function cloneBytes(bytes) {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(bytes);
    } catch {
      // Fall through
    }
  }
  return new Uint8Array(bytes);
}

// --------------------------------------------------------------------------
// MockRemoteBackend
// --------------------------------------------------------------------------

export class MockRemoteBackend {
  /**
   * @param {object} [options]
   * @param {import('./storage.js').StorageBackend} [options.storage]
   *   Custom storage backend (e.g., MemoryBackend for tests).
   *   Defaults to an IndexedDB store named 'phpoc-mock-remote'.
   * @param {number} [options.latencyMs=50]
   *   Simulated network latency in ms. Set to 0 for instant ops.
   * @param {number} [options.errorRate=0]
   *   Probability (0-1) of simulated network errors.
   * @param {boolean} [options.etagsEnabled=true]
   *   Whether to simulate ETag-based conditional responses.
   */
  constructor(options = {}) {
    const {
      storage,
      latencyMs = 50,
      errorRate = 0,
      etagsEnabled = true,
    } = options;

    /** @private */
    this._storage = storage || null;
    /** @private */
    this._idbStore = storage
      ? null
      : createStore('phpoc-db', 'phpoc-mock-remote');
    /** @private */
    this._latencyMs = latencyMs;
    /** @private */
    this._errorRate = errorRate;
    /** @private */
    this._etagsEnabled = etagsEnabled;

    // ETag cache for conditional GETs (same pattern as HttpTransport)
    /** @private @type {Map<string, { etag: string, body: Uint8Array }>} */
    this._etagCache = new Map();

    // Maintain a key index so listFiles() works with any backend
    /** @private @type {Set<string>} */
    this._keyIndex = new Set();

    // Track request history for inspection
    /** @private @type {Array<{ method: string, path: string }>} */
    this._requestLog = [];
  }

  // ------------------------------------------------------------------
  // Transport interface
  // ------------------------------------------------------------------

  get isHttp() { return false; }
  get isMock() { return true; }

  /**
   * Simulate GET — pull a blob by path.
   *
   * Returns null on 404. Supports ETag-based conditional GET:
   * if the caller has a cached ETag (via previous pull), returns cached
   * body as a 304 simulation when the content hasn't changed.
   *
   * @param {string} path - Remote path (e.g., "staging/blobs/current.json").
   * @returns {Promise<Uint8Array|null>}
   * @throws {Error} On simulated network errors.
   */
  async pull(path) {
    await this._simulateLatency();
    this._simulateError(`pull(${path})`);

    this._logRequest('GET', path);

    // Check ETag cache first (simulate conditional GET)
    const cached = this._etagCache.get(path);
    if (cached) {
      const stored = await this._readBlob(path);
      if (stored && stored.etag === cached.etag) {
        // 304 Not Modified — return cached body
        return cached.body;
      }
      // Stale cache entry — remove and proceed
      this._etagCache.delete(path);
    }

    // Fetch from storage
    const stored = await this._readBlob(path);
    if (!stored) {
      return null; // 404
    }

    // Update ETag cache
    if (this._etagsEnabled && stored.etag) {
      this._etagCache.set(path, {
        etag: stored.etag,
        body: cloneBytes(stored.data),
      });
    }

    return cloneBytes(stored.data);
  }

  /**
   * Simulate PUT — push a blob by path.
   *
   * @param {string} path - Remote path.
   * @param {Uint8Array} data - Blob bytes.
   * @returns {Promise<void>}
   * @throws {Error} On simulated network errors.
   */
  async push(path, data) {
    await this._simulateLatency();
    this._simulateError(`push(${path})`);

    this._logRequest('PUT', path);

    const etag = await computeEtag(data);

    await this._writeBlob(path, {
      data: cloneBytes(data),
      etag,
      createdAt: Date.now(),
    });

    // Track key for listFiles support
    this._keyIndex.add(path);

    // Clear ETag cache for this path (server has newer data)
    this._etagCache.delete(path);
  }

  /**
   * Simulate LIST — list filenames under a prefix.
   *
   * @param {string} prefix - Remote path prefix (e.g., "ledger/blocks/").
   * @returns {Promise<string[]>} List of matching paths.
   * @throws {Error} On simulated network errors.
   */
  async listFiles(prefix) {
    await this._simulateLatency();
    this._simulateError(`listFiles(${prefix})`);

    this._logRequest('LIST', prefix);

    // Use the key index maintained by push()/seed()
    const keys = [];
    for (const key of this._keyIndex) {
      if (key.startsWith(prefix)) {
        keys.push(key);
      }
    }

    return keys.sort();
  }

  /**
   * Simulate DELETE — remove a blob by path.
   *
   * @param {string} path - Remote path (e.g., "staging/blobs/current.json").
   * @returns {Promise<void>}
   * @throws {Error} On simulated network errors.
   */
  async delete(path) {
    await this._simulateLatency();
    this._simulateError(`delete(${path})`);

    this._logRequest('DELETE', path);

    // Remove from storage
    if (this._idbStore) {
      try {
        await del(path, this._idbStore);
      } catch {
        // Already gone — fine
      }
    } else if (this._storage) {
      try {
        await this._storage.remove(path);
      } catch {
        // Already gone — fine
      }
    }

    // Remove from key index
    this._keyIndex.delete(path);

    // Clear ETag cache for this path
    this._etagCache.delete(path);
  }

  /**
   * Clear the ETag cache (mimics HttpTransport.resetCache).
   */
  resetCache() {
    this._etagCache.clear();
  }

  // ------------------------------------------------------------------
  // Mock-specific helpers (for dev tools, seeding, and testing)
  // ------------------------------------------------------------------

  /**
   * Seed initial data into the mock remote.
   *
   * Accepts an array of {path, data} entries. String data is encoded
   * as UTF-8 bytes automatically.
   *
   * @param {Array<{path: string, data: Uint8Array|string}>} entries
   */
  async seed(entries) {
    if (!Array.isArray(entries)) {
      entries = [entries];
    }
    for (const { path, data } of entries) {
      const bytes = typeof data === 'string'
        ? new TextEncoder().encode(data)
        : data;
      await this.push(path, bytes);
    }
  }

  /**
   * Remove all data from mock remote (factory reset).
   */
  async clear() {
    if (this._idbStore) {
      try {
        await idbClear(this._idbStore);
      } catch {
        // ignore
      }
    } else if (this._storage) {
      if (typeof this._storage.clear === 'function') {
        await this._storage.clear();
      } else {
        // Remove each known key
        for (const key of this._keyIndex) {
          await this._storage.remove(key);
        }
      }
    }
    this._etagCache.clear();
    this._keyIndex.clear();
    this._requestLog = [];
  }

  /**
   * Get a snapshot of all stored blobs for inspection.
   *
   * @returns {Promise<Array<{path: string, size: number, etag: string, createdAt: number}>>}
   */
  async dump() {
    const result = [];
    for (const key of this._keyIndex) {
      const stored = await this._readBlob(key);
      if (stored) {
        result.push({
          path: key,
          size: stored.data?.length || 0,
          etag: stored.etag || '',
          createdAt: stored.createdAt || 0,
        });
      }
    }
    return result.sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Configure simulated latency.
   *
   * @param {number} ms - Round-trip latency in milliseconds.
   */
  setLatency(ms) {
    this._latencyMs = Math.max(0, ms);
  }

  /**
   * Configure simulated error rate.
   *
   * @param {number} rate - Probability (0-1) of random network errors.
   */
  setErrorRate(rate) {
    this._errorRate = Math.max(0, Math.min(1, rate));
  }

  /**
   * Return a copy of the request log for inspection.
   *
   * @returns {Array<{ method: string, path: string, timestamp: number }>}
   */
  getRequestLog() {
    return [...this._requestLog];
  }

  /**
   * Clear the request log.
   */
  clearRequestLog() {
    this._requestLog = [];
  }

  // ------------------------------------------------------------------
  // Internal: storage read/write
  // ------------------------------------------------------------------

  /**
   * Read a blob record from the underlying storage.
   * @private
   */
  async _readBlob(path) {
    if (this._idbStore) {
      try {
        return await get(path, this._idbStore);
      } catch {
        return null;
      }
    }
    if (this._storage) {
      try {
        return await this._storage.get(path);
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * Write a blob record to the underlying storage.
   * @private
   */
  async _writeBlob(path, record) {
    if (this._idbStore) {
      await set(path, record, this._idbStore);
    } else if (this._storage) {
      await this._storage.set(path, record);
    }
  }

  // ------------------------------------------------------------------
  // Internal: latency / error simulation
  // ------------------------------------------------------------------

  /**
   * Simulate network latency with jitter.
   * @private
   */
  async _simulateLatency() {
    if (this._latencyMs > 0) {
      const jitter = this._latencyMs * 0.3 * (Math.random() * 2 - 1);
      const delay = Math.max(0, this._latencyMs + jitter);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  /**
   * Simulate random network errors.
   * @private
   * @throws {Error} If random roll falls within error rate.
   */
  _simulateError(context) {
    if (this._errorRate > 0 && Math.random() < this._errorRate) {
      const errors = [
        'Network error: connection refused',
        'Network error: timeout exceeded',
        'Internal server error (500)',
        'Service unavailable (503)',
        'Network error: DNS resolution failed',
      ];
      const msg = errors[Math.floor(Math.random() * errors.length)];
      throw new Error(`MockRemoteBackend: ${msg} (${context})`);
    }
  }

  /**
   * Record a request in the log.
   * @private
   */
  _logRequest(method, path) {
    this._requestLog.push({ method, path, timestamp: Date.now() });
  }
}
