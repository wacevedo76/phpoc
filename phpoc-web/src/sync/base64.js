/**
 * Base64 ↔ Uint8Array conversion utilities.
 *
 * Works in browser (atob/btoa) and Node.js (Buffer).
 * Shared by sync.js, remote_sync.js, genesis_gate.js.
 */

/**
 * Convert base64 string to Uint8Array.
 * @param {string} b64
 * @returns {Uint8Array}
 */
export function base64ToBytes(b64) {
  if (typeof atob !== 'undefined') {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

/**
 * Convert Uint8Array to base64 string.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToBase64(bytes) {
  if (typeof btoa !== 'undefined') {
    return btoa(String.fromCharCode(...bytes));
  }
  return Buffer.from(bytes).toString('base64');
}
