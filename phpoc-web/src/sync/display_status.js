/**
 * display_status — sync status constants + display status derivation.
 *
 * Pure logic extracted from SyncSettings.jsx for testability.
 */

// ── Status constants ──────────────────────────────────────────────────

export const STATUS_READY              = 'READY';
export const STATUS_NOT_SYNCED         = 'NOT_SYNCED';
export const STATUS_SYNCING            = 'SYNCING';
export const STATUS_OFFLINE            = 'OFFLINE';
export const STATUS_REAUTH_NEEDED      = 'REAUTH_NEEDED';
export const STATUS_GENESIS_MISMATCH   = 'GENESIS_MISMATCH';

// ── Display status derivation ─────────────────────────────────────────

/**
 * Compute the display status for the SyncIndicator.
 *
 * Priority order (first match wins):
 *   1. SYNCING — manual "Sync Now" or auto-sync debounce/push in progress
 *   2. NOT_SYNCED — uncommitted entries exist AND remote sync hasn't succeeded
 *   3. remoteStatus — passthrough (READY, OFFLINE, REAUTH_NEEDED, etc.)
 *
 * @param {object} opts
 * @param {boolean} opts.syncing — manual sync in progress (Sync Now button)
 * @param {boolean} opts.isAutoSyncing — auto-sync debounce/push in progress
 * @param {string}  opts.remoteStatus — last remote check result (one of STATUS_*)
 * @param {boolean} opts.hasEntries — true when uncommitted staging entries exist
 * @returns {string} One of the STATUS_* constants
 */
export function computeDisplayStatus({ syncing, isAutoSyncing, remoteStatus, hasEntries }) {
  if (syncing || isAutoSyncing) return STATUS_SYNCING;
  if (remoteStatus !== STATUS_READY && hasEntries) return STATUS_NOT_SYNCED;
  return remoteStatus;
}
