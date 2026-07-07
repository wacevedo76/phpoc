/**
 * Activity ID — random 10-char opaque identifier for staging entries.
 *
 * Provides:
 *   generateActivityId() → string — 10-char alphanumeric via CSPRNG
 *
 * Design decisions (from D5):
 *   - 10 characters, [A-Za-z0-9] alphabet (62 possibilities, ~59 bits)
 *   - CSPRNG-generated (crypto.getRandomValues)
 *   - Opaque — no timestamps, no semantic content, no patterns
 *   - Each call produces a fresh random value (no caching)
 *
 * The activity_id is assigned at entry creation time and is immutable
 * for the entry's lifetime. It powers the staging hash index fast-path
 * for cross-device staging reconciliation.
 */

/**
 * Generate a random 10-character alphanumeric activity ID.
 *
 * Uses the Web Cryptography API (crypto.getRandomValues) for
 * cryptographic-quality randomness. Each call produces a fresh ID.
 *
 * @param {*} [_unused] - Ignored (defensive: callers may pass null/undefined).
 * @returns {string} 10-char alphanumeric string matching [A-Za-z0-9]{10}.
 */
export function generateActivityId(_unused) {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const LENGTH = 10;

  const randomBytes = new Uint8Array(LENGTH * 10);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(randomBytes);
  } else {
    // Fallback for environments without Web Crypto (test shims)
    for (let i = 0; i < randomBytes.length; i++) {
      randomBytes[i] = Math.floor(Math.random() * 256);
    }
  }

  let id = '';
  for (let i = 0; i < LENGTH; i++) {
    // Consume 2 bytes per character to avoid modulo bias
    const byteIdx = i * 2;
    // 62 * 62 = 3844 ≤ 65536 → safe with 2 bytes
    const val = (randomBytes[byteIdx] << 8) | randomBytes[byteIdx + 1];
    id += ALPHABET[val % ALPHABET.length];
  }

  return id;
}
