/**
 * reauth.js — Re-authentication logic (pure function, no React).
 *
 * Used by ReauthOverlay.jsx and callable from non-React contexts.
 * Performs the full re-auth flow: derive MK → _reconcileAndClaim.
 */

import { SyncResult } from './sync.js';

const PBKDF2_ITERATIONS = 600000;

/**
 * Execute the re-authentication flow: derive MK → reconcile.
 *
 * Flow:
 *   1. Validate passphrase (non-empty)
 *   2. Read stored seed from storage
 *   3. Derive master key via crypto.authenticate(passphrase, seed, iterations)
 *   4. Clear any stale MK, then set the new one
 *   5. Call sync._reconcileAndClaim(mk) — pulls remote, merges, pushes,
 *      creates fresh device cookie
 *   6. Return { success: true, genesisMismatch: boolean }
 *
 * Genesis mismatch is NOT an auth/sync failure. The user authenticated
 * successfully but the remote ledger has a different genesis block.
 * Callers should surface the "Clear Remote & Overwrite" flow.
 *
 * On failure: clears MK and throws with a user-facing error message.
 *
 * @param {string} passphrase - User's passphrase (will be trimmed)
 * @param {object} storage - Storage backend with async get(key) method
 * @param {object} crypto - CryptoService with authenticate(), setMasterKey(),
 *   clearMasterKey(), getMasterKey(), hasMasterKey()
 * @param {object} sync - SyncService with _reconcileAndClaim(mk) method
 * @param {number} [iterations=600000] - PBKDF2 iterations
 * @returns {Promise<{success: boolean, genesisMismatch: boolean}>}
 * @throws {Error} With user-facing message on failure
 */
export async function performReauth(passphrase, storage, crypto, sync, iterations = PBKDF2_ITERATIONS) {
  // 1. Validate input
  const trimmed = (passphrase || '').trim();
  if (!trimmed) {
    throw new Error('Passphrase cannot be empty.');
  }

  // 2. Read stored seed
  let seed;
  try {
    seed = await storage.get('phpoc_seed');
  } catch (err) {
    throw new Error('Could not read stored recovery seed. The ledger may be corrupted.');
  }
  if (!seed) {
    throw new Error('No recovery seed found. The ledger may be corrupted.');
  }

  // 3. Derive master key
  let masterKey;
  try {
    masterKey = crypto.authenticate(trimmed, seed, iterations);
  } catch (err) {
    throw new Error(`Authentication failed: ${err.message}`);
  }

  // 4. Set master key (clear any stale MK first)
  try {
    if (typeof crypto.clearMasterKey === 'function') {
      crypto.clearMasterKey();
    }
    crypto.setMasterKey(masterKey);
  } catch (err) {
    throw new Error(`Failed to initialize crypto session: ${err.message}`);
  }

  // 5. Reconcile and claim staging ownership
  // This pulls remote blob, merges with local, pushes merged result,
  // and creates a fresh device cookie with updated TTL.
  // The genesis gate runs inside _reconcileAndClaim before any blob ops.
  let reconcileResult;
  try {
    reconcileResult = await sync._reconcileAndClaim(masterKey);
  } catch (err) {
    // Reconcile failed — clear MK so user can retry with fresh state
    try {
      if (typeof crypto.clearMasterKey === 'function') {
        crypto.clearMasterKey();
      }
    } catch {
      // Best-effort cleanup
    }
    throw new Error(
      `Sync failed: ${err.message || 'Could not reconcile with remote staging.'}`
    );
  }

  // 6. Check for genesis mismatch (non-error, user must resolve separately)
  if (reconcileResult === SyncResult.GENESIS_MISMATCH) {
    return { success: true, genesisMismatch: true };
  }

  return { success: true, genesisMismatch: false };
}
