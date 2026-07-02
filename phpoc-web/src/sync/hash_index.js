/**
 * Hash Index — data structure and fork detection for incremental sync.
 *
 * Provides:
 *   buildHashIndex(chain)    → string[] — extracts block seals in chain order
 *   compareHashIndexes(l,r)  → { forkType, forkIndex } — detects divergence
 *
 * The hash index is an array of block seals (day_hash, month_hash, or
 * year_hash) in chain order. It enables GenesisGate to skip pulling
 * the full remote chain when ledgers are already in sync (Tier 1) and
 * to detect fork points for incremental pulls (Tier 2).
 *
 * Architecture: ONBOARDING_UNLOCK_REAUTH_SPEEDUP_STRATEGY.md
 */

import { getBlockHash } from '../ledger/utils.js';

/**
 * Build a hash index array from a ledger chain.
 *
 * Maps each block to its seal hash (day_hash for day/genesis blocks,
 * month_hash for month_summary blocks, year_hash for year_summary blocks).
 * Preserves chain order — index N corresponds to block[N].
 *
 * @param {object[]} chain - Ledger chain (array of block dicts).
 * @returns {string[]} Array of seal hashes in chain order. Empty if null/empty.
 */
export function buildHashIndex(chain) {
  if (!chain || !Array.isArray(chain)) return [];
  return chain.map(block => getBlockHash(block));
}

/**
 * Compare local and remote hash indexes to detect fork type.
 *
 * Walks both arrays element-by-element until a mismatch is found.
 * Handles null inputs defensively (treated as empty arrays).
 *
 * Fork types:
 *   'none'             — identical (or both empty)
 *   'linear_remote'    — remote extends local (common prefix + extra blocks)
 *   'linear_local'     — local extends remote (common prefix + extra blocks)
 *   'divergent'        — mismatch at a shared index after genesis
 *   'genesis_mismatch' — mismatch at index 0 (different genesis)
 *
 * @param {string[]|null} local - Local hash index (array of hex seal hashes).
 * @param {string[]|null} remote - Remote hash index (array of hex seal hashes).
 * @returns {{ forkType: string, forkIndex?: number }}
 */
export function compareHashIndexes(local, remote) {
  // Defensive: treat null as empty
  const l = local || [];
  const r = remote || [];

  // Both empty → same
  if (l.length === 0 && r.length === 0) {
    return { forkType: 'none' };
  }

  // One side empty → linear extension
  if (l.length === 0) {
    return { forkType: 'linear_remote', forkIndex: 0 };
  }
  if (r.length === 0) {
    return { forkType: 'linear_local', forkIndex: 0 };
  }

  // Genesis mismatch check (index 0)
  if (l[0] !== r[0]) {
    return { forkType: 'genesis_mismatch', forkIndex: 0 };
  }

  // Walk common prefix — find first differing index
  const minLen = Math.min(l.length, r.length);
  for (let i = 1; i < minLen; i++) {
    if (l[i] !== r[i]) {
      return { forkType: 'divergent', forkIndex: i };
    }
  }

  // No divergence in shared range — check for linear extension
  if (r.length > l.length) {
    return { forkType: 'linear_remote', forkIndex: l.length };
  }
  if (l.length > r.length) {
    return { forkType: 'linear_local', forkIndex: r.length };
  }

  // Identical
  return { forkType: 'none' };
}
