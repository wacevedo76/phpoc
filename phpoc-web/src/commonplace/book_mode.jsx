/**
 * book_mode.jsx — Reactive shared book-mode state (Commonplace Slice 3).
 *
 * The web mirror of Flutter's Riverpod `bookProvider` / `AppPreferences.bookMode`
 * ValueNotifier: a small React context that both `BookSwitcher` and `BookBody`
 * consume so selecting a book re-renders the body reactively.
 *
 * `useBookMode()` degrades gracefully when no provider is present (e.g.
 * `BookSwitcher` rendered standalone in Slice 2 tests) by falling back to a
 * local state that still persists the choice to localStorage.
 */

import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';
import { Book, getBookMode, setBookMode as persistBookMode } from './book.js';

const BookModeContext = createContext(null);

/**
 * Local book state seeded from `getBookMode()` (localStorage) whose setter
 * also persists the choice. Shared by `BookModeProvider` and the `useBookMode`
 * fallback so the state + persistence behavior lives in one place.
 */
function usePersistedBookState() {
  const [book, setBook] = useState(() => Book.fromKey(getBookMode()));

  const selectBook = useCallback((next) => {
    setBook(next);
    persistBookMode(next.key);
  }, []);

  return { book, setBook: selectBook };
}

/**
 * Provide shared book-mode state to the subtree. Initial state is read from
 * `getBookMode()` (localStorage, default `ledger`).
 */
export function BookModeProvider({ children }) {
  const { book, setBook } = usePersistedBookState();

  const value = useMemo(() => ({ book, setBook }), [book, setBook]);

  return <BookModeContext.Provider value={value}>{children}</BookModeContext.Provider>;
}

/**
 * Read the active book + a setter. Returns `{ book, setBook }`.
 *
 * Inside a `BookModeProvider` this is the shared reactive state. Outside one,
 * it falls back to a local state (still persisting to localStorage) so the
 * `BookSwitcher` remains independently usable. The local hook runs
 * unconditionally (Rules of Hooks); its result is only used without a provider.
 */
export function useBookMode() {
  const ctx = useContext(BookModeContext);
  const local = usePersistedBookState();

  if (ctx) {
    return { book: ctx.book, setBook: ctx.setBook };
  }
  return local;
}
