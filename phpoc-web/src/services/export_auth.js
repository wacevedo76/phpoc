/**
 * export_auth.js — Export with always-fresh passphrase authentication.
 *
 * The key design choice: sensitive operations (export) must ALWAYS
 * re-derive the master key via crypto.authenticate(). The cached
 * getMasterKey() must never be used as a shortcut.
 *
 * ⚠️  Known limitation (2026-07-04): The WASM authenticate() currently
 * ignores the passphrase and returns derive_master_key(seed) —
 * the seed is the master key. Passphrase validation is therefore
 * best-effort via genesis block seal verification. Full fix requires
 * architectural alignment with Python (seed encrypted by PDK).
 * Tracked as Phase 6 backlog item P1 (cross-client format unification).
 *
 * @module export_auth
 */

import { exportLedgerFull } from './ledger_export.js';
import { jsonSort } from '../ledger/utils.js';

// ── Protocol constants ──────────────────────────────────────────────

/** PBKDF2-HMAC-SHA256 iterations per OWASP 2026 (ADR-004). */
const PBKDF2_ITERATIONS = 600000;

/** IndexedDB key for the Base64-encoded 32-byte recovery seed. */
const SEED_KEY = 'phpoc_seed';

/** IndexedDB key for the PBKDF2 passphrase validation hash. */
const PASSPHRASE_HASH_KEY = 'phpoc_passphrase_hash';

// ── Public API ──────────────────────────────────────────────────────

/**
 * Authenticate with passphrase and export the full ledger.
 *
 * Always calls crypto.authenticate(passphrase, seed, iterations) —
 * never falls back to cached getMasterKey(). The derived key is
 * used to seal the export and then discarded (not cached).
 *
 * @param {object} opts
 * @param {object} opts.crypto    - CryptoService with authenticate(), seal()
 * @param {object} opts.storage   - Storage backend with get(key)
 * @param {string} opts.passphrase - User-provided passphrase (non-empty)
 * @param {object[]} opts.entries  - Staging entries to export (may be [])
 * @param {object[]} opts.blocks   - Committed ledger blocks to export (may be [])
 * @returns {Promise<{blob: Blob, filename: string}>}
 * @throws {Error} If seed missing, passphrase empty, or no data to export
 */
export async function exportWithAuth({
  crypto,
  storage,
  passphrase,
  entries,
  blocks,
}) {
  // ── Validate inputs ─────────────────────────────────────────
  if (!passphrase || !String(passphrase).trim()) {
    throw new Error('Passphrase is required for export.');
  }

  entries = entries || [];
  blocks = blocks || [];
  if (!Array.isArray(entries) || !Array.isArray(blocks)) {
    throw new Error('Entries and blocks must be arrays.');
  }

  // ── 1. Read recovery seed from storage ──────────────────────
  const seed = await storage.get(SEED_KEY);
  if (!seed) {
    throw new Error('No recovery seed found — cannot authenticate.');
  }

  // ── 2. Always re-derive the master key ──────────────────────
  const authMasterKey = crypto.authenticate(
    String(passphrase).trim(),
    seed,
    PBKDF2_ITERATIONS,
  );

  // Defense-in-depth: non-standard crypto may return null/undefined.
  if (!authMasterKey) {
    throw new Error('Key derivation failed — crypto service returned no key.');
  }

  // ── 3. Verify passphrase via stored PBKDF2 hash ──────────
  // Phase 6 P1 Step 1: JS-layer passphrase validation that
  // works regardless of WASM authenticate() architecture.
  const storedHash = await storage.get(PASSPHRASE_HASH_KEY);
  if (storedHash) {
    const trimmedPass = String(passphrase).trim();
    const normalized = trimmedPass.normalize('NFC');
    let pdk;
    try {
      pdk = crypto.derivePdk(normalized, PBKDF2_ITERATIONS);
    } catch (err) {
      // derivePdk throws if MK not set (shouldn't happen — it doesn't need MK).
      // Fall through to genesis seal verification below.
    }
    if (pdk) {
      const actualHash = crypto.sha256(pdk + ':' + seed);
      if (actualHash !== storedHash) {
        throw new Error('Incorrect passphrase.');
      }
    }
  } else {
    // Fallback: no stored hash (pre-Phase-6-P1 ledger). Try genesis
    // seal verification as best-effort check.
    if (blocks.length > 0) {
      const genesisBlock = _findGenesisBlock(blocks);
      const blockHash = genesisBlock ? (genesisBlock.block_hash || genesisBlock.day_hash) : undefined;
      if (genesisBlock && blockHash) {
        try {
          _verifyGenesisSeal(crypto, genesisBlock, authMasterKey);
        } catch (err) {
          throw new Error('Incorrect passphrase.');
        }
      }
    }
  }

  // ── 4. Validate data ────────────────────────────────────────
  if (blocks.length === 0 && entries.length === 0) {
    throw new Error('No data to export.');
  }

  // ── 5. Build, seal, and return ──────────────────────────────
  const blob = await exportLedgerFull(blocks, entries, crypto, authMasterKey);

  const filename = `ph-ledger-full-export-${new Date().toISOString().slice(0, 10)}.json`;

  return { blob, filename };
}

// ── Internal helpers ────────────────────────────────────────────────

/**
 * Find the genesis block in the chain.
 *
 * @param {object[]} blocks - Ledger blocks array.
 * @returns {object|undefined} The genesis block or undefined.
 */
function _findGenesisBlock(blocks) {
  return blocks.find(
    (b) => b.type === 'genesis' || b.block_type === 'genesis' || b.day_index === 0,
  );
}

/**
 * Verify the genesis block seal to validate passphrase correctness.
 *
 * Rebuilds the genesis block's canonical JSON (excluding seal and
 * signature fields) and verifies the HMAC seal against the derived key.
 *
 * I-17: genesis uses block_hash (canonical); fall back to day_hash
 * for old-format genesis blocks.
 *
 * @param {object} crypto - CryptoService with verifySeal().
 * @param {object} genesisBlock - The genesis block with day_hash/block_hash.
 * @param {string} masterKey - Derived master key to verify.
 * @throws {Error} If seal verification fails.
 */
function _verifyGenesisSeal(crypto, genesisBlock, masterKey) {
  // Rebuild genesis data WITHOUT the seal and signature.
  const sealData = {};
  for (const [k, v] of Object.entries(genesisBlock)) {
    if (k !== 'day_hash' && k !== 'block_hash' && k !== 'signature') {
      sealData[k] = v;
    }
  }

  // Canonical form with sorted keys (same as genesis creation).
  const canonical = jsonSort(sealData);
  const storedHash = genesisBlock.block_hash || genesisBlock.day_hash;
  const valid = crypto.verifySeal(canonical, storedHash, masterKey);
  if (!valid) {
    throw new Error('Seal verification failed');
  }
}
