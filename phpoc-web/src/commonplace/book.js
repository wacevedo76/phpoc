/**
 * book.js — Book identity + selection persistence (Commonplace Slice 2).
 *
 * Mirrors Flutter `book_switcher.dart` (`Book` enum) + `AppPreferences`
 * `getBookMode`/`setBookMode`. Web persistence uses localStorage under a single
 * `phpoc_book_mode` key (mirrors the `phpoc_worker_url` / `phpoc_dev_mode`
 * localStorage convention).
 */

export const BOOK_MODE_KEY = 'phpoc_book_mode';

/**
 * The two "books" a user can view within phpoc.
 *
 * - `Book.ledger` — the main activity ledger (PH Ledger).
 * - `Book.commonplace` — the personal thematic library (Commonplace Book).
 *
 * This slice introduces the identity + selection state only: the switcher bar
 * is rendered above each main page, but page content stays on the ledger until
 * the Commonplace screens are built (Slice 3).
 */
// Single source of truth for the two book identities, so `Book.ledger` /
// `Book.commonplace` and `Book.values` share the SAME object references
// (mirrors Flutter's enum `values` — `fromKey('ledger') === Book.ledger`).
const LEDGER = { key: 'ledger', label: 'PH Ledger' };
const COMMONPLACE = { key: 'commonplace', label: 'PH Commonplace Book' };

export const Book = {
  ledger: LEDGER,
  commonplace: COMMONPLACE,
  values: [LEDGER, COMMONPLACE],
  /** Map a persisted key string back to a Book; defaults to Book.ledger. */
  fromKey(key) {
    return Book.values.find((b) => b.key === key) || Book.ledger;
  },
};

function defaultStorage() {
  return typeof localStorage !== 'undefined' ? localStorage : null;
}

/**
 * Read the active book mode ('ledger' default, or 'commonplace').
 * `storage` is injectable for tests; defaults to `localStorage`.
 */
export function getBookMode(storage = defaultStorage()) {
  if (!storage) return Book.ledger.key;
  return storage.getItem(BOOK_MODE_KEY) || Book.ledger.key;
}

/**
 * Persist the active book mode under `BOOK_MODE_KEY`.
 */
export function setBookMode(mode, storage = defaultStorage()) {
  if (!storage) return;
  storage.setItem(BOOK_MODE_KEY, mode);
}
