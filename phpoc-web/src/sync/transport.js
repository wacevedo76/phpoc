/**
 * HttpTransport — JS HTTP transport for remote staging/blob sync.
 *
 * Port of core/sync/http_transport.py to JS using fetch().
 *
 * Contract:
 *   pull(path)          → Promise<Uint8Array | null>   (null on 404)
 *   push(path, data)    → Promise<void>
 *   listFiles(prefix)   → Promise<string[]>
 *   resetCache()        → void
 *   isHttp              → boolean (always true)
 *
 * ETag caching:
 *   - On a successful 200 response with an ETag header, the transport caches
 *     both the ETag and the response body for that path.
 *   - Subsequent pull() for the same path sends If-None-Match with the
 *     cached ETag.
 *   - If server responds 304, the cached body is returned — zero bytes transferred.
 *   - If server responds 200 with a new body + ETag, both cache entries are updated.
 *   - push() for a path clears that path's cache (the server now has newer data).
 *   - resetCache() clears all cached ETags.
 */

export class HttpTransport {
  constructor({ baseUrl, apiKey } = {}) {
    if (!baseUrl) {
      throw new Error('HttpTransport: baseUrl must not be empty');
    }
    if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
      throw new Error(
        `HttpTransport: baseUrl must start with http:// or https://, got: ${baseUrl}`
      );
    }

    // Normalize: strip trailing slash for consistent URL joining
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey || null;

    // ETag cache: Map<path, { etag: string, body: Uint8Array }>
    this._etagCache = new Map();
  }

  // ------------------------------------------------------------------
  // Public interface
  // ------------------------------------------------------------------

  get isHttp() {
    return true;
  }

  /**
   * Fetch blob from remote via HTTP GET.
   *
   * @param {string} path - Remote path (e.g., "staging/blobs/current.json").
   *   Leading slash is normalized away.
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<Uint8Array|null>} Blob bytes, or null if 404.
   * @throws {Error} On network errors, non-404 4xx, or 5xx.
   */
  async pull(path, { timeoutMs } = {}) {
    const url = this._buildURL(path);

    const headers = {};
    this._addApiKey(headers);

    // Send If-None-Match if we have a cached ETag for this path
    const cached = this._etagCache.get(path);
    if (cached) {
      headers['If-None-Match'] = cached.etag;
    }

    let response;
    try {
      response = await fetch(url, { method: 'GET', headers });
    } catch (err) {
      throw new Error(
        `HttpTransport: network error pulling ${path}: ${err.message}`
      );
    }

    // 304 Not Modified — return cached body
    if (response.status === 304) {
      if (cached) {
        return cached.body;
      }
      // No cache entry (shouldn't happen if we sent If-None-Match, but be safe)
      return null;
    }

    // Read body bytes as raw binary. arrayBuffer() preserves bytes exactly —
    // no charset decoding, no UTF-8 interpretation. Required for encrypted/
    // obfuscated blobs where bytes >127 are meaningful binary, not text.
    let body;
    try {
      body = new Uint8Array(await response.arrayBuffer());
    } catch (err) {
      throw new Error(
        `HttpTransport: error reading response for ${path}: ${err.message}`
      );
    }

    // 200 OK — cache ETag if present and return body
    if (response.status === 200) {
      const etag = response.headers.get('ETag');
      if (etag) {
        this._etagCache.set(path, { etag, body });
      }
      return body;
    }

    // 404 Not Found — return null
    if (response.status === 404) {
      return null;
    }

    // Non-404 error status
    throw new Error(
      `HttpTransport: HTTP ${response.status} pulling ${path}`
    );
  }

  /**
   * Write blob to remote via HTTP PUT.
   *
   * @param {string} path - Remote path (e.g., "staging/blobs/current.json").
   * @param {Uint8Array} data - Blob bytes to write.
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<void>}
   * @throws {Error} On network errors or non-2xx responses.
   */
  async push(path, data, { timeoutMs } = {}) {
    const url = this._buildURL(path);

    const headers = {
      'Content-Type': 'application/octet-stream',
    };
    this._addApiKey(headers);

    let response;
    try {
      response = await fetch(url, {
        method: 'PUT',
        headers,
        body: data,
      });
    } catch (err) {
      throw new Error(
        `HttpTransport: network error pushing ${path}: ${err.message}`
      );
    }

    // 2xx success — clear cache for this path (server has newer data)
    if (response.status >= 200 && response.status < 300) {
      this._etagCache.delete(path);
      return;
    }

    // Non-2xx error
    throw new Error(
      `HttpTransport: HTTP ${response.status} pushing ${path}`
    );
  }

  /**
   * List filenames under a prefix via HTTP GET with ?prefix= query.
   *
   * @param {string} prefix - Remote directory prefix (e.g., "ledger/blocks/").
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<string[]>} List of filenames. Empty if no files match.
   * @throws {Error} On network errors, invalid JSON, or non-array response.
   */
  async listFiles(prefix, { timeoutMs } = {}) {
    // Build query string manually to avoid URLSearchParams encoding
    // slashes in the prefix (the Worker expects literal slashes).
    const url = `${this.baseUrl}/?prefix=${prefix}`;

    const headers = {};
    this._addApiKey(headers);

    let response;
    try {
      response = await fetch(url, { method: 'GET', headers });
    } catch (err) {
      throw new Error(
        `HttpTransport: network error listing ${prefix}: ${err.message}`
      );
    }

    // 404 — empty prefix
    if (response.status === 404) {
      return [];
    }

    // Non-200 error
    if (response.status !== 200) {
      throw new Error(
        `HttpTransport: HTTP ${response.status} listing ${prefix}`
      );
    }

    // Parse JSON response
    let parsed;
    try {
      parsed = await response.json();
    } catch (err) {
      throw new Error(
        `HttpTransport: invalid JSON from list_files(${prefix}): ${err.message}`
      );
    }

    if (!Array.isArray(parsed)) {
      throw new Error(
        `HttpTransport: expected JSON array from list_files(${prefix}), got ${typeof parsed}`
      );
    }

    return parsed;
  }

  /**
   * Clear all cached ETags and bodies.
   *
   * Used after transport swap to ensure the next pull is a clean request.
   */
  resetCache() {
    this._etagCache.clear();
  }

  // ------------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------------

  /**
   * Build the full URL from base URL and remote path.
   *
   * Handles trailing slash on base URL and leading slash on path.
   *
   * @param {string} path - Remote path, possibly starting with /.
   * @returns {string} Full URL (e.g., "https://example.com/staging/blobs/x.json").
   */
  _buildURL(path) {
    const base = this.baseUrl.replace(/\/+$/, '');
    const cleanPath = path.replace(/^\/+/, '');
    return `${base}/${cleanPath}`;
  }

  /**
   * Add X-Api-Key header to headers object if API key is configured.
   *
   * @param {object} headers - Headers object to add the key to.
   */
  _addApiKey(headers) {
    if (this.apiKey) {
      headers['X-Api-Key'] = this.apiKey;
    }
  }
}
