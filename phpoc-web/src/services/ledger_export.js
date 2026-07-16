/**
 * ledger_export.js — Export ledger data to an encrypted, signed JSON file.
 *
 * Two export modes:
 *   - exportLedger()     — exports staging entries only (v1 format)
 *   - exportLedgerFull() — exports committed chain only (v2 format)
 *
 * Auth-gated: caller must provide a masterKey (obtained from passphrase
 * prompt → crypto.authenticate()). In dev mode (DummyCryptoService), any
 * passphrase is accepted — UX convention.
 *
 * File format (v1 — staging only):
 *   { format_version, exported_at, entries, seal }
 *
 * File format (v2 — committed chain only):
 *   { format_version, exported_at, ledger, seal }
 *
 * Integrity:
 *   - v1: Seal = HMAC of jsonSort(entries) using master key
 *   - v2: Seal = HMAC of JSON.stringify(ledger) using master key
 *   - Seal covers the data only — wrapper metadata (exported_at,
 *     format_version) sits outside the sealed region
 *   - Block hashes are preserved as-is
 *   - PURE READ: no staging entries are committed during export
 *
 * D11 (Staging-Ledger Separation): v2 exports ONLY committed ledger blocks.
 * Staging entries are never included in ledger exports.
 *
 * @module ledger_export
 */

import { jsonSort } from '../ledger/utils.js';

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
  _validateExportInputs('exportLedger', entries, crypto, masterKey);

  // ── Recompute entry hashes ─────────────────────────────────────
  // LocalCache.append() may add committed, block_index, entry_index,
  // and end_device_uuid AFTER the original hash was computed. Recompute
  // each hash to cover ALL current fields except `hash` so the import
  // hash validation passes.
  const entriesWithFreshHashes = entries.map(entry => {
    const { hash: _, ...hashData } = entry;
    return { ...entry, hash: crypto.sha256(jsonSort(hashData)) };
  });

  // ── Build the export payload ────────────────────────────────────
  const payload = {
    format_version: '1',
    exported_at: new Date().toISOString(),
    entries: entriesWithFreshHashes,
    seal: '', // placeholder, computed below
  };

  // Seal covers jsonSort(entriesWithFreshHashes) — NOT the wrapper metadata
  const entriesJson = jsonSort(entriesWithFreshHashes);
  payload.seal = crypto.seal(entriesJson, masterKey);

  // ── Serialize and return Blob ───────────────────────────────────
  const json = JSON.stringify(payload, null, 2);
  return new Blob([json], { type: 'application/json' });
}

/**
 * Export the committed ledger chain to a sealed JSON Blob.
 *
 * PURE READ OPERATION: does NOT commit staging entries. Exports
 * the committed block chain plus optional staging entries for full
 * fidelity roundtrip (staging included only when caller provides it).
 *
 * @param {object[]} blocks — Committed ledger blocks (genesis, day, month_summary).
 *        Each block has: type, day_index, date, prev_hash, entries[], day_hash, etc.
 * @param {object} crypto - CryptoService instance with seal().
 * @param {string} masterKey - 64-char hex master key.
 * @param {object[]} [staging] - Optional staging entries to include in export.
 * @returns {Blob} application/json Blob ready for file download.
 * @throws {Error} If blocks is not an array, crypto lacks seal(),
 *         or masterKey is missing/empty.
 */
export async function exportLedgerFull(blocks, crypto, masterKey, staging = null) {
  _validateExportInputs('exportLedgerFull', blocks, crypto, masterKey);

  // ── Build the export payload ────────────────────────────────────
  const payload = {
    format_version: '2',
    exported_at: new Date().toISOString(),
    ledger: blocks,
    seal: '', // placeholder, computed below
  };

  // Include staging if provided (optional, for full-fidelity roundtrip)
  if (Array.isArray(staging)) {
    payload.staging = staging;
  }

  // Seal covers the committed ledger chain only (D11)
  payload.seal = crypto.seal(JSON.stringify(blocks), masterKey);

  // ── Serialize and return Blob ───────────────────────────────────
  const json = JSON.stringify(payload, null, 2);
  return new Blob([json], { type: 'application/json' });
}

// ── Shared helpers ────────────────────────────────────────────────

/**
 * Validate inputs common to all export functions.
 * @param {string} fnName — caller name for error messages.
 * @param {Array} data — the data array to export (entries or blocks).
 * @param {object} crypto — CryptoService with seal().
 * @param {string} masterKey — 64-char hex master key.
 */
function _validateExportInputs(fnName, data, crypto, masterKey) {
  const label = fnName === 'exportLedger' ? 'entries' : 'blocks';
  if (!Array.isArray(data)) {
    throw new Error(`${fnName}: ${label} must be an array`);
  }
  if (typeof crypto.seal !== 'function') {
    throw new Error(`${fnName}: crypto must provide seal()`);
  }
  if (!masterKey) {
    throw new Error(`${fnName}: masterKey is required`);
  }
}
