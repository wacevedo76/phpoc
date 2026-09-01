/**
 * book_switcher_web.test.mjs — Commonplace Book Switcher (Slice 2) test suite.
 *
 * Ports the Flutter `book_switcher_test.dart` contract (13 assertions, groups
 * A–D) from docs/planning/flutter/COMMONPLACE_BOOK_SWITCHER_PHASE1.md to
 * phpoc-web. Vitest + @testing-library/react.
 *
 * Phase 2 (RED): `src/commonplace/book.js` + `src/components/layout/BookSwitcher.jsx`
 * are stubs that throw "not implemented"; `AppLayout` does not yet render the
 * switcher — so every test fails until Phase 3 implements them.
 *
 * Usage:
 *   npx vitest run test/book_switcher_web.test.mjs
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';

import { Book, getBookMode, setBookMode, BOOK_MODE_KEY } from '../src/commonplace/book.js';
import BookSwitcher from '../src/components/layout/BookSwitcher.jsx';
import AppLayout from '../src/components/layout/AppLayout.jsx';

// ── localStorage mock (mirrors rekey_settings_web.test.mjs) ──────────

const localStorageStore = new Map();
const localStorageMock = {
  getItem: vi.fn((key) => localStorageStore.get(key) ?? null),
  setItem: vi.fn((key, val) => { localStorageStore.set(key, val); }),
  removeItem: vi.fn((key) => { localStorageStore.delete(key); }),
};
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true });

// ── AppLayout render helper ───────────────────────────────────────────

function renderAppLayout(child = React.createElement('div')) {
  return render(
    React.createElement(
      AppLayout,
      { currentScreen: 'dashboard', onNavigate: () => {}, onLogoutRequest: () => {} },
      child,
    ),
  );
}

// ═══════════════════════════════════════════════════════════════════
// Group A: Book identity + labels (2)
// ═══════════════════════════════════════════════════════════════════

describe('A: Book identity + labels', () => {
  it('BS-A1: Book.ledger and Book.commonplace have the correct labels', () => {
    expect(Book.ledger.label).toBe('PH Ledger');
    expect(Book.commonplace.label).toBe('PH Commonplace Book');
  });

  it('BS-A2: Book has exactly two values', () => {
    expect(Book.values).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group B: book-mode persistence (4)
// ═══════════════════════════════════════════════════════════════════

describe('B: book-mode persistence', () => {
  beforeEach(() => {
    localStorageStore.clear();
    localStorageMock.setItem.mockClear();
  });

  it('BS-B1: defaults to "ledger" when nothing is persisted', () => {
    expect(getBookMode()).toBe('ledger');
  });

  it('BS-B2: selecting commonplace updates the stored mode', () => {
    setBookMode('commonplace');
    expect(getBookMode()).toBe('commonplace');
  });

  it('BS-B3: selection is persisted under phpoc_book_mode in localStorage', () => {
    setBookMode('commonplace');
    expect(localStorageMock.setItem).toHaveBeenCalledWith(BOOK_MODE_KEY, 'commonplace');
    expect(localStorageStore.get(BOOK_MODE_KEY)).toBe('commonplace');
  });

  it('BS-B4: unknown/missing key maps back to Book.ledger', () => {
    expect(Book.fromKey(null)).toBe(Book.ledger);
    expect(Book.fromKey('unknown')).toBe(Book.ledger);
    // fromKey returns the SAME reference as the identity constants (mirrors
    // Flutter enum `values`); guards against re-introducing a duplicate literal.
    expect(Book.fromKey('ledger')).toBe(Book.ledger);
    expect(Book.fromKey('commonplace')).toBe(Book.commonplace);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group C: BookSwitcher component (5)
// ═══════════════════════════════════════════════════════════════════

describe('C: BookSwitcher component', () => {
  beforeEach(() => {
    localStorageStore.clear();
    localStorageMock.setItem.mockClear();
  });

  it('BS-C1: renders the active book label (Ledger default)', () => {
    render(React.createElement(BookSwitcher));
    expect(screen.getByText('PH Ledger')).toBeInTheDocument();
  });

  it('BS-C2: clicking opens a menu listing both books', () => {
    render(React.createElement(BookSwitcher));
    fireEvent.click(screen.getByRole('button', { name: 'PH Ledger' }));
    expect(screen.getByText('PH Commonplace Book')).toBeInTheDocument();
  });

  it('BS-C3: selecting Commonplace updates the label and persists', () => {
    render(React.createElement(BookSwitcher));
    fireEvent.click(screen.getByRole('button', { name: 'PH Ledger' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'PH Commonplace Book' }));
    // Title bar now shows the Commonplace label.
    expect(screen.getByText('PH Commonplace Book')).toBeInTheDocument();
    // Selection persisted under the 'commonplace' string key.
    expect(localStorageStore.get(BOOK_MODE_KEY)).toBe('commonplace');
  });

  it('BS-C4: a single instance renders exactly one switcher bar', () => {
    render(React.createElement(BookSwitcher));
    expect(screen.getAllByTestId('book-switcher')).toHaveLength(1);
  });

  it('BS-C5: the switcher renders above the page content', () => {
    const { container } = renderAppLayout(
      React.createElement('div', { 'data-testid': 'page-content' }, 'PAGE'),
    );
    const switcher = container.querySelector('[data-testid="book-switcher"]');
    const content = container.querySelector('.app-content');
    expect(switcher).toBeInTheDocument();
    expect(content).toBeInTheDocument();
    // The switcher node must precede the content node in document order.
    expect(
      switcher.compareDocumentPosition(content) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group D: AppLayout integration (2)
// ═══════════════════════════════════════════════════════════════════

describe('D: AppLayout integration', () => {
  beforeEach(() => {
    localStorageStore.clear();
  });

  it('BS-D1: AppLayout renders a BookSwitcher above the page child', () => {
    renderAppLayout(React.createElement('div', { 'data-testid': 'page-child' }, 'CHILD'));
    expect(screen.getByTestId('book-switcher')).toBeInTheDocument();
    expect(screen.getByTestId('page-child')).toBeInTheDocument();
  });

  it('BS-D2: bottom nav still has 6 tabs + Logout', () => {
    renderAppLayout();
    ['Home', 'History', 'Tags', 'Profile', 'Sync', 'Settings'].forEach((label) => {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Logout' })).toBeInTheDocument();
  });
});
