/**
 * ledger_export.js — Export ledger entries to an encrypted, signed JSON file.
 *
 * Auth-gated: caller must provide a masterKey (obtained from passphrase
 * prompt → crypto.authenticate()). In dev mode (DummyCryptoService), any
 * passphrase is accepted — UX convention.
 *
 * File format:
 *   { format_version, exported_at, entries, seal }
 *
 * Integrity:
 *   - Seal = HMAC-SHA256 of JSON.stringify(entries) using master key
 *   - Seal covers entries only — file wrapper metadata (exported_at,
 *     format_version) sits outside the sealed region
 *   - Entry hashes are preserved as-is
 *
 * @module ledger_export
 */

/**
 * Export a list of staging entries to a signed JSON Blob suitable for
 * browser download via <a download>.
 *
 * @param {import('../sync/local_cache.js').StagingEntry[]} entries
 *        Array of staging entry DTOs (as returned by readEntries()).
 * @param {object} crypto - CryptoService instance with seal() and sha256().
 * @param {string} masterKey - 64-char hex master key.
 * @returns {Blob} application/json Blob ready for file download.
 * @throws {Error} If entries is not an array, crypto lacks seal(),
 *         or masterKey is missing/empty.
 */
export async function exportLedger(entries, crypto, masterKey) {
  // ── Validation ──────────────────────────────────────────────────
  if (!Array.isArray(entries)) {
    throw new Error('exportLedger: entries must be an array');
  }

  if (typeof crypto.seal !== 'function') {
    throw new Error('exportLedger: crypto must provide seal()');
  }

  if (!masterKey) {
    throw new Error('exportLedger: masterKey is required');
  }

  // ── Build the export payload ────────────────────────────────────
  const payload = {
    format_version: '1',
    exported_at: new Date().toISOString(),
    entries: entries,
    seal: '', // placeholder, computed below
  };

  // Seal covers JSON.stringify(entries) only — NOT the wrapper metadata
  const entriesJson = JSON.stringify(entries);
  payload.seal = crypto.seal(entriesJson, masterKey);

  // ── Serialize and return Blob ───────────────────────────────────
  const json = JSON.stringify(payload, null, 2);
  return new Blob([json], { type: 'application/json' });
}
