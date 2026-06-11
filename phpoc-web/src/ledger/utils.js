/**
 * Ledger utilities — shared helpers for chain, engine, and summary policy.
 *
 * Extracted during Phase 1 refactoring to eliminate duplication across
 * chain.js, engine.js, and summary_policy.js.
 */

import { createHash } from 'crypto';

/**
 * Recursively sort the keys of an object for deterministic JSON serialization.
 */
export function sortKeys(obj) {
  if (obj === null || obj === undefined || typeof obj !== 'object') {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(sortKeys);
  }
  return Object.keys(obj).sort().reduce((acc, key) => {
    acc[key] = sortKeys(obj[key]);
    return acc;
  }, {});
}

/**
 * Deterministic JSON serialization: compact, with sorted keys.
 */
export function jsonSort(data) {
  return JSON.stringify(sortKeys(data));
}

/**
 * Compute SHA-256 hex digest of pretty-printed JSON.
 * Matches the test convention (2-space indentation).
 */
export function computeEntryHash(data) {
  return createHash('sha256').update(JSON.stringify(data, null, 2), 'utf-8').digest('hex');
}

/**
 * Return the hash of a block irrespective of its type.
 *
 * Handles day_hash, month_hash, and year_hash — the three hash keys
 * used by different block types (day, month_summary, year_summary).
 *
 * @param {object} block
 * @returns {string|undefined}
 */
export function getBlockHash(block) {
  return block.day_hash || block.month_hash || block.year_hash;
}
