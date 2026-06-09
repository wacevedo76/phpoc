/**
 * ledger_import.js — Import ledger entries from a signed JSON file.
 *
 * Parses, validates, and decrypts an exported ledger file. The caller
 * (UI layer) is responsible for writing the returned entries to storage
 * and refreshing the UI.
 *
 * Validation flow:
 *   1. Parse JSON → validate structural fields
 *   2. Verify seal = HMAC(JSON.stringify(entries), masterKey)
 *   3. Recompute each entry's SHA-256 hash → compare
 *   4. Any failure → throw (reject entirely, no partial import)
 *
 * @module ledger_import
 */

/**
 * Import entries from an exported ledger file.
 *
 * @param {Blob|File} file - The exported .json file (Blob or File).
 * @param {object} crypto - CryptoService instance with verifySeal() and sha256().
 * @param {string} masterKey - 64-char hex master key.
 * @returns {Promise<{entries: Array, count: number}>} Parsed and verified entries.
 * @throws {Error} On any validation failure (seal mismatch, bad hash, missing fields).
 */
export async function importLedger(file, crypto, masterKey) {
  // ── Validation ──────────────────────────────────────────────────
  if (!masterKey) {
    throw new Error('importLedger: masterKey is required');
  }

  if (typeof crypto.verifySeal !== 'function') {
    throw new Error('importLedger: crypto must provide verifySeal()');
  }

  // ── Parse file ──────────────────────────────────────────────────
  let parsed;
  try {
    const text = await file.text();
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      'importLedger: invalid or unreadable file — ' + err.message
    );
  }

  // ── Structural validation ───────────────────────────────────────
  if (typeof parsed.format_version !== 'string' || !parsed.format_version) {
    throw new Error(
      'importLedger: missing or invalid format_version in file'
    );
  }

  if (!Array.isArray(parsed.entries)) {
    throw new Error(
      'importLedger: missing or invalid entries array in file'
    );
  }

  if (typeof parsed.seal !== 'string' || !parsed.seal) {
    throw new Error(
      'importLedger: missing or invalid seal in file'
    );
  }

  // ── Seal verification ───────────────────────────────────────────
  // Seal covers JSON.stringify(entries) only — NOT wrapper metadata
  const entriesJson = JSON.stringify(parsed.entries);
  const sealValid = crypto.verifySeal(entriesJson, parsed.seal, masterKey);

  if (!sealValid) {
    throw new Error(
      'importLedger: seal verification failed — file may be tampered ' +
      'or opened with the wrong passphrase'
    );
  }

  // ── Entry hash re-validation ────────────────────────────────────
  for (let i = 0; i < parsed.entries.length; i++) {
    const entry = parsed.entries[i];

    // Build the canonical data (all fields except hash, sorted keys)
    const hashData = {};
    for (const key of Object.keys(entry).sort()) {
      if (key !== 'hash') {
        hashData[key] = entry[key];
      }
    }
    const expectedHash = crypto.sha256(JSON.stringify(hashData));

    if (entry.hash !== expectedHash) {
      throw new Error(
        `importLedger: entry hash mismatch at index ${i} ` +
        `("${entry.title || 'untitled'}") — file may be corrupted`
      );
    }
  }

  // ── Success ─────────────────────────────────────────────────────
  return {
    entries: parsed.entries,
    count: parsed.entries.length,
  };
}
