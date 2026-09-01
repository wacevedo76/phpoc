import React, { useState } from 'react';
import { Book, getBookMode, setBookMode } from '../../commonplace/book.js';

/**
 * BookSwitcher — persistent title bar showing the active book with a pull-down
 * to switch between "PH Ledger" and "PH Commonplace Book".
 *
 * Rendered once by the shell (`AppLayout`) above each screen's content, so all
 * main pages share one instance. Selecting a book updates local state + persists
 * the choice to localStorage (`phpoc_book_mode`); page content is not swapped
 * until the Commonplace screens are built (Slice 3).
 */
export default function BookSwitcher() {
  const [book, setBook] = useState(() => Book.fromKey(getBookMode()));
  const [open, setOpen] = useState(false);

  const select = (b) => {
    if (b.key === book.key) {
      setOpen(false);
      return;
    }
    setBook(b);
    setBookMode(b.key);
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
