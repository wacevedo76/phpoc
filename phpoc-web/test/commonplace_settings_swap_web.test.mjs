/**
 * commonplace_settings_swap_web.test.mjs — Commonplace Settings routing
 * (Slice 4) — Group S (6) from
 * docs/planning/COMMONPLACE_BOOK_SETTINGS_WEB_PHASE1.md. Phase 2 (RED).
 *
 * Vitest + @testing-library/react. Renders `BookModeProvider` + `AppLayout` +
 * `BookBody` and proves the shell routes `currentScreen === 'settings'` to a
 * Commonplace-mode Settings surface (the fix for the over-swap bug: Slice 3's
 * `BookBody` replaces the ENTIRE ledger screen with `CommonplaceScreen` whenever
 * the book is `commonplace`, so Settings is unreachable in Commonplace mode).
 *
 * Future DOM contract (drives Phase 3):
 *   - `BookBody({ ledgerScreen, commonplaceService, currentScreen = 'dashboard' })`
 *     in Commonplace mode renders:
 *       - `currentScreen === 'settings'`  → `CommonplaceSettingsScreen` (NEW)
 *         whose root carries `data-testid="commonplace-settings-screen"`.
 *       - `currentScreen === 'dashboard'` → `CommonplaceScreen`
 *         (root `data-testid="commonplace-screen"`).
 *       - any other screen → the passed `ledgerScreen` node (pass-through).
 *     In ledger mode it always renders `ledgerScreen` (unchanged).
 *   - The ledger placeholder carries `data-testid="ledger-screen"`.
 *
 * RED in Phase 2: S2/S3/S4/S5 fail — `BookBody` ignores `currentScreen` and
 * swaps every Commonplace-mode screen to `CommonplaceScreen`, so the settings
 * testid is absent (S2/S3/S4) and history/tags/sync never render the ledger
 * node (S5). S1 and S6 are ledger-mode regression guards that already pass.
 *
 * Run: npx vitest run test/commonplace_settings_swap_web.test.mjs
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';

import { BOOK_MODE_KEY } from '../src/commonplace/book.js';
import { BookModeProvider } from '../src/commonplace/book_mode.jsx';
import AppLayout from '../src/components/layout/AppLayout.jsx';
import BookBody from '../src/components/layout/BookBody.jsx';

// ── localStorage mock (mirrors commonplace_swap_web.test.mjs) ────────

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
          currentScreen,
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
// Group S: Settings routing / book-scoped content swap (6)
// ═══════════════════════════════════════════════════════════════════

describe('S: Settings routing / book-scoped content swap', () => {
  beforeEach(() => {
    localStorageStore.clear();
  });

  it('S1: ledger book + settings renders the ledger Settings (not Commonplace)', async () => {
    renderShell({ currentScreen: 'settings' });
    expect(await screen.findByTestId('ledger-screen')).toBeInTheDocument();
    expect(screen.queryByTestId('commonplace-settings-screen')).not.toBeInTheDocument();
    expect(screen.queryByTestId('commonplace-screen')).not.toBeInTheDocument();
  });

  it('S2: commonplace book + settings renders CommonplaceSettingsScreen (not CommonplaceScreen)', async () => {
    localStorageStore.set(BOOK_MODE_KEY, 'commonplace');
    renderShell({ currentScreen: 'settings' });

    expect(await screen.findByTestId('commonplace-settings-screen')).toBeInTheDocument();
    expect(screen.queryByTestId('commonplace-screen')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ledger-screen')).not.toBeInTheDocument();
  });

  it('S3: commonplace book on settings keeps the Settings nav tab highlighted (index 5 of 6)', async () => {
    localStorageStore.set(BOOK_MODE_KEY, 'commonplace');
    renderShell({ currentScreen: 'settings' });
    await screen.findByTestId('commonplace-settings-screen');

    expect(screen.getByRole('button', { name: 'Settings' }).className).toContain('nav-tab-active');
    // The nav still shows all 6 tabs in Commonplace mode.
    ['Home', 'History', 'Tags', 'Profile', 'Sync', 'Settings'].forEach((label) => {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    });
  });

  it('S4: switching book commonplace → ledger while on settings renders the ledger Settings', async () => {
    localStorageStore.set(BOOK_MODE_KEY, 'commonplace');
    renderShell({ currentScreen: 'settings' });
    await screen.findByTestId('commonplace-settings-screen');

    switchTo('PH Ledger');

    expect(await screen.findByTestId('ledger-screen')).toBeInTheDocument();
    expect(screen.queryByTestId('commonplace-settings-screen')).not.toBeInTheDocument();
    expect(screen.queryByTestId('commonplace-screen')).not.toBeInTheDocument();
  });

  it('S5: commonplace mode swaps only dashboard + settings; history/tags/sync stay ledger', async () => {
    localStorageStore.set(BOOK_MODE_KEY, 'commonplace');

    let view = renderShell({ currentScreen: 'dashboard' });
    expect(await screen.findByTestId('commonplace-screen')).toBeInTheDocument();
    expect(screen.queryByTestId('ledger-screen')).not.toBeInTheDocument();
    view.unmount();

    for (const screenName of ['history', 'tags', 'sync']) {
      view = renderShell({ currentScreen: screenName });
      expect(await screen.findByTestId('ledger-screen')).toBeInTheDocument();
      expect(screen.queryByTestId('commonplace-screen')).not.toBeInTheDocument();
      expect(screen.queryByTestId('commonplace-settings-screen')).not.toBeInTheDocument();
      view.unmount();
    }
  });

  it('S6: ledger book Settings is isolated (no Commonplace content leaks in)', async () => {
    renderShell({ currentScreen: 'settings' });
    await screen.findByTestId('ledger-screen');

    expect(screen.queryByTestId('commonplace-settings-screen')).not.toBeInTheDocument();
    expect(screen.queryByTestId('commonplace-screen')).not.toBeInTheDocument();
    // No Commonplace-specific affordances/verbiage from the Commonplace surface.
    expect(screen.queryByText('Verify Commonplace')).not.toBeInTheDocument();
    expect(screen.queryByText('Push Commonplace to Cloud')).not.toBeInTheDocument();
    expect(screen.queryByText('Clear All Data')).not.toBeInTheDocument();
  });
});
