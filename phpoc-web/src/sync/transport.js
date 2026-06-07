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
 */

export class HttpTransport {
  constructor({ baseUrl, apiKey } = {}) {
    throw new Error('HttpTransport: not yet implemented');
  }

  get isHttp() {
    throw new Error('HttpTransport: not yet implemented');
  }

  async pull(path, { timeoutMs } = {}) {
    throw new Error('HttpTransport.pull: not yet implemented');
  }

  async push(path, data, { timeoutMs } = {}) {
    throw new Error('HttpTransport.push: not yet implemented');
  }

  async listFiles(prefix, { timeoutMs } = {}) {
    throw new Error('HttpTransport.listFiles: not yet implemented');
  }

  resetCache() {
    throw new Error('HttpTransport.resetCache: not yet implemented');
  }
}
