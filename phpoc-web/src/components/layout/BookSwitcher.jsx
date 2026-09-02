import React, { useState } from 'react';
import { Book } from '../../commonplace/book.js';
import { useBookMode } from '../../commonplace/book_mode.jsx';

/**
 * BookSwitcher — persistent title bar showing the active book with a pull-down
 * to switch between "PH Ledger" and "PH Commonplace Book".
 *
 * Rendered once by the shell (`AppLayout`) above each screen's content, so all
 * main pages share one instance. Selecting a book updates the shared book-mode
 * state (via `useBookMode`) — so `BookBody` swaps the page content reactively —
 * and persists the choice to localStorage (`phpoc_book_mode`). When rendered
 * without a `BookModeProvider`, `useBookMode` falls back to a local state that
 * still persists the selection.
 */
export default function BookSwitcher() {
  const { book, setBook } = useBookMode();
  const [open, setOpen] = useState(false);

  const select = (b) => {
    if (b.key === book.key) {
      setOpen(false);
      return;
    }
    setBook(b);
    setOpen(false);
  };

  return (
    <div className="book-switcher" data-testid="book-switcher">
      <button
        type="button"
        className="book-switcher-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="book-switcher-label">{book.label}</span>
        <span className="book-switcher-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="book-switcher-menu" role="menu">
          {Book.values.map((b) => (
            <button
              key={b.key}
              type="button"
              role="menuitem"
              className={`book-switcher-item${b.key === book.key ? ' book-switcher-item-active' : ''}`}
              onClick={() => select(b)}
            >
              {b.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
