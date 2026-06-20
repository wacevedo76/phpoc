/**
 * ledger_export.js — Export ledger data to an encrypted, signed JSON file.
 *
 * Two export modes:
 *   - exportLedger()     — exports staging entries only (v1 format)
 *   - exportLedgerFull() — exports committed chain + staging (v2 format)
 *
 * Auth-gated: caller must provide a masterKey (obtained from passphrase
 * prompt → crypto.authenticate()). In dev mode (DummyCryptoService), any
 * passphrase is accepted — UX convention.
 *
 * File format (v1 — staging only):
 *   { format_version, exported_at, entries, seal }
 *
 * File format (v2 — full ledger):
 *   { format_version, exported_at, ledger, staging, seal }
 *
 * Integrity:
 *   - v1: Seal = HMAC of jsonSort(entries) using master key
 *   - v2: Seal = HMAC of jsonSort({ledger, staging}) using master key
 *   - Seal covers the data only — wrapper metadata (exported_at,
 *     format_version) sits outside the sealed region
 *   - Entry/block hashes are preserved as-is
 *   - PURE READ: no staging entries are committed during export
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

  // Seal covers jsonSort(entries) only — NOT the wrapper metadata
  const entriesJson = jsonSort(entries);
  payload.seal = crypto.seal(entriesJson, masterKey);

  // ── Serialize and return Blob ───────────────────────────────────
  const json = JSON.stringify(payload, null, 2);
  return new Blob([json], { type: 'application/json' });
}

/**
 * Export the full ledger — committed blocks + staging entries — to a
 * signed JSON Blob suitable for browser download.
 *
 * PURE READ OPERATION: does NOT commit staging entries. Exports
 * everything as-is: the committed block chain and any uncommitted
 * staging entries, each in separate arrays.
 *
 * @param {object[]} blocks — Committed ledger blocks (genesis, day, month_summary).
 *        Each block has: type, day_index, date, prev_hash, entries[], day_hash, etc.
 * @param {object[]} staging — Uncommitted staging entries (from LocalCache.readEntries()).
 *        May be empty array if all entries are committed.
 * @param {object} crypto - CryptoService instance with seal().
 * @param {string} masterKey - 64-char hex master key.
 * @returns {Blob} application/json Blob ready for file download.
 * @throws {Error} If blocks or staging is not an array, crypto lacks seal(),
 *         or masterKey is missing/empty.
 */
export async function exportLedgerFull(blocks, staging, crypto, masterKey) {
  // ── Validation ──────────────────────────────────────────────────
  if (!Array.isArray(blocks)) {
    throw new Error('exportLedgerFull: blocks must be an array');
  }

  if (!Array.isArray(staging)) {
    throw new Error('exportLedgerFull: staging must be an array');
  }

  if (typeof crypto.seal !== 'function') {
    throw new Error('exportLedgerFull: crypto must provide seal()');
  }

  if (!masterKey) {
    throw new Error('exportLedgerFull: masterKey is required');
  }

  // ── Build the export payload ────────────────────────────────────
  const payload = {
    format_version: '2',
    exported_at: new Date().toISOString(),
    ledger: blocks,
    staging: staging,
    seal: '', // placeholder, computed below
  };

  // Seal covers BOTH ledger and staging — the combined state
  const sealData = { ledger: blocks, staging: staging };
  payload.seal = crypto.seal(jsonSort(sealData), masterKey);

  // ── Serialize and return Blob ───────────────────────────────────
  const json = JSON.stringify(payload, null, 2);
  return new Blob([json], { type: 'application/json' });
}
