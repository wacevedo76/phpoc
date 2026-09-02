/**
 * commonplace_swap_web.test.mjs — Commonplace content-swap test suite (Phase 2 RED).
 *
 * Group R (6) from docs/planning/COMMONPLACE_BOOK_UI_WEB_PHASE1.md. Vitest +
 * @testing-library/react. Renders `BookModeProvider` + `AppLayout` + `BookBody`
 * with a mock `CommonplaceService`, proving the shell swaps the body between the
 * ledger screen and `CommonplaceScreen` as the book selection changes.
 *
 * Phase 2 (RED): `src/commonplace/book_mode.jsx` (BookModeProvider/useBookMode),
 * `src/components/layout/BookBody.jsx`, and the `CommonplaceScreen` it renders do
 * not exist yet, so every test fails on import. In Phase 3, `BookSwitcher` is
 * modified to consume `useBookMode()` (dropping its local useState), so selecting
 * a book re-renders `BookBody` reactively.
 *
 * DOM contract (drives Phase 3):
 *   - `BookBody({ ledgerScreen, commonplaceService })` returns `CommonplaceScreen`
 *     when the active book is `commonplace`, else the `ledgerScreen` node.
 *   - `CommonplaceScreen` root carries `data-testid="commonplace-screen"`.
 *   - The ledger placeholder carries `data-testid="ledger-screen"`.
 *
 * Run: npx vitest run test/commonplace_swap_web.test.mjs
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';

import { BOOK_MODE_KEY } from '../src/commonplace/book.js';
import { BookModeProvider } from '../src/commonplace/book_mode.jsx';
import AppLayout from '../src/components/layout/AppLayout.jsx';
import BookBody from '../src/components/layout/BookBody.jsx';

// ── localStorage mock (mirrors book_switcher_web.test.mjs) ──────────

const localStorageStore = new Map();
const localStorageMock = {
  getItem: vi.fn((key) => localStorageStore.get(key) ?? null),
  setItem: vi.fn((key, val) => { localStorageStore.set(key, val); }),
  removeItem: vi.fn((key) => { localStorageStore.delete(key); }),
};
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true });

// ── Mock CommonplaceService ─────────────────────────────────────────

function makeMockService(entries = []) {
  return {
    readEntries: vi.fn(async () => [...entries]),
    verify: vi.fn(() => true),
    buildTagIndex: vi.fn(() => ({})),
    getEntryCount: vi.fn(() => entries.length),
    getLastHash: vi.fn(() => 'hash-tip'),
    ensureGenesis: vi.fn(async () => {}),
    addEntry: vi.fn(async () => {}),
  };
}

function renderShell({ currentScreen = 'dashboard', service = makeMockService() } = {}) {
  return render(
    React.createElement(
      BookModeProvider,
      null,
      React.createElement(
        AppLayout,
        { currentScreen, onNavigate: () => {}, onLogoutRequest: () => {} },
        React.createElement(BookBody, {
          ledgerScreen: React.createElement('div', { 'data-testid': 'ledger-screen' }, 'Ledger Page'),
          commonplaceService: service,
        }),
      ),
    ),
  );
}

function switchTo(menuLabel) {
  const triggerLabel = menuLabel === 'PH Ledger' ? 'PH Commonplace Book' : 'PH Ledger';
  fireEvent.click(screen.getByRole('button', { name: triggerLabel }));
  fireEvent.click(screen.getByRole('menuitem', { name: menuLabel }));
}

// ═══════════════════════════════════════════════════════════════════
// Group R: Content swap by book (6)
// ═══════════════════════════════════════════════════════════════════

describe('R: Content swap by book', () => {
  beforeEach(() => {
    localStorageStore.clear();
  });

  it('R1: with Book.ledger active, the shell renders the ledger page (not CommonplaceScreen)', async () => {
    renderShell();
    expect(await screen.findByTestId('ledger-screen')).toBeInTheDocument();
    expect(screen.queryByTestId('commonplace-screen')).not.toBeInTheDocument();
  });

  it('R2: with Book.commonplace active, the shell renders CommonplaceScreen instead of the ledger page', async () => {
    renderShell();
    switchTo('PH Commonplace Book');

    expect(await screen.findByTestId('commonplace-screen')).toBeInTheDocument();
    expect(screen.queryByTestId('ledger-screen')).not.toBeInTheDocument();
  });

  it('R3: the BookSwitcher bar still renders above the page in both book modes', async () => {
    const { container } = renderShell();
    await screen.findByTestId('ledger-screen');

    const switcher = container.querySelector('[data-testid="book-switcher"]');
    const content = container.querySelector('.app-content');
    expect(switcher).toBeInTheDocument();
    expect(content).toBeInTheDocument();
    expect(
      switcher.compareDocumentPosition(content) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // Switch to Commonplace — the shared switcher persists.
    switchTo('PH Commonplace Book');
    await screen.findByTestId('commonplace-screen');
    expect(screen.getByTestId('book-switcher')).toBeInTheDocument();
  });

  it('R4: the bottom nav still shows 6 tabs + Logout in the Commonplace book', async () => {
    localStorageStore.set(BOOK_MODE_KEY, 'commonplace');
    renderShell();
    await screen.findByTestId('commonplace-screen');

    ['Home', 'History', 'Tags', 'Profile', 'Sync', 'Settings'].forEach((label) => {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Logout' })).toBeInTheDocument();
  });

  it('R5: switching book commonplace → ledger restores the ledger page', async () => {
    localStorageStore.set(BOOK_MODE_KEY, 'commonplace');
    renderShell();
    await screen.findByTestId('commonplace-screen');

    switchTo('PH Ledger');

    expect(await screen.findByTestId('ledger-screen')).toBeInTheDocument();
    expect(screen.queryByTestId('commonplace-screen')).not.toBeInTheDocument();
  });

  it('R6: the active tab (nav-tab-active) is preserved when switching books', async () => {
    renderShell({ currentScreen: 'history' });
    expect(screen.getByRole('button', { name: 'History' }).className).toContain('nav-tab-active');

    switchTo('PH Commonplace Book');
    await screen.findByTestId('commonplace-screen');

    expect(screen.getByRole('button', { name: 'History' }).className).toContain('nav-tab-active');
  });
});
