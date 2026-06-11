/**
 * IndexManager — blind index of durations by date and title.
 *
 * A lightweight key-value cache mapping dates to title-to-duration maps.
 * Derived from the ledger chain and can be fully rebuilt if lost.
 *
 * Uses StorageBackend key convention "ledger:index".
 *
 * Usage:
 *   import { IndexManager } from './index_manager.js';
 *   const index = new IndexManager(store);
 *   index.update('2026-01-15', 'Morning Run', 3600000);
 *   const result = index.query('2026-01-01', '2026-01-31');
 */

const INDEX_KEY = 'ledger:index';

export class IndexManager {
  /**
   * @param {import('../sync/storage.js').StorageBackend} store - StorageBackend instance.
   */
  constructor(store) {
    this.store = store;
    /** @type {object} Internal cache: {date: {title: total_duration_ms}} */
    this._cache = {};
  }

  /**
   * Write in-memory cache back to store.
   * @returns {Promise<void>}
   */
  _flush() {
    return this.store.set(INDEX_KEY, JSON.parse(JSON.stringify(this._cache)));
  }

  /**
   * Reload cache from the underlying store.
   *
   * Call this when an external component may have written to the
   * store directly (e.g., legacy code paths). Uses the StorageBackend
   * interface uniformly — no direct _store access.
   *
   * @returns {Promise<void>}
   */
  async reload() {
    this._cache = {};
    const stored = await this.store.get(INDEX_KEY);
    if (stored && typeof stored === 'object') {
      this._cache = JSON.parse(JSON.stringify(stored));
    }
  }

  /**
   * Return a copy of the full index.
   * @returns {object} Deep copy of {date: {title: total_duration_ms}}.
   */
  getAll() {
    return JSON.parse(JSON.stringify(this._cache));
  }

  /**
   * Add or subtract duration for a title on a given date.
   *
   * If durationDelta is negative and causes the total to go to
   * zero or below, the title entry is removed from that date's
   * dict. If the date dict becomes empty, the date is removed.
   *
   * @param {string} date - ISO date string (YYYY-MM-DD).
   * @param {string} title - Activity title.
   * @param {number} durationDelta - Duration in ms to add (positive) or subtract (negative).
   */
  update(date, title, durationDelta) {
    if (!this._cache[date]) {
      if (durationDelta <= 0) {
        return;
      }
      this._cache[date] = {};
    }

    const old = this._cache[date][title] || 0;
    const newVal = old + durationDelta;

    if (newVal <= 0) {
      // Remove the title entry; if date is now empty, remove the date too
      delete this._cache[date][title];
      if (Object.keys(this._cache[date]).length === 0) {
        delete this._cache[date];
      }
    } else {
      this._cache[date][title] = newVal;
    }

    return this._flush();
  }

  /**
   * Aggregate durations by title over a date range.
   *
   * @param {string} fromDate - Start date (inclusive), ISO format.
   * @param {string} toDate - End date (inclusive), ISO format.
   * @returns {object} Dict of {title: total_ms} over the range. Empty if no data.
   */
  query(fromDate, toDate) {
    if (fromDate > toDate) {
      return {};
    }

    const result = {};
    for (const [dateStr, titles] of Object.entries(this._cache)) {
      if (fromDate <= dateStr && dateStr <= toDate) {
        for (const [title, duration] of Object.entries(titles)) {
          result[title] = (result[title] || 0) + duration;
        }
      }
    }
    return result;
  }

  /**
   * Clear all index data.
   */
  clear() {
    this._cache = {};
    return this._flush();
  }
}
