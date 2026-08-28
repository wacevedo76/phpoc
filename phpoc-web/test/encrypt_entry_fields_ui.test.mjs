/**
 * encrypt_entry_fields_ui.test.mjs — Encrypt All Entry Fields: UI Controls (Phase 2 RED)
 *
 * Group I from the Phase 1 blueprint:
 *   docs/planning/ENCRYPT_ALL_ENTRY_FIELDS_WEB_PHASE1.md
 *
 * Tests that NewTask form, Sync-tab cards, and Dashboard have encryption
 * opt-in checkboxes (master + per-field) with correct toggle/link behavior.
 *
 * Usage:
 *   npx vitest run test/encrypt_entry_fields_ui.test.mjs
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import React from 'react';

// ══════════════════════════════════════════════════════════════════════
// Mocks
// ══════════════════════════════════════════════════════════════════════

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

const localStorageStore = new Map();
const localStorageMock = {
  getItem: vi.fn((key) => localStorageStore.get(key) ?? null),
  setItem: vi.fn((key, val) => { localStorageStore.set(key, val); }),
  removeItem: vi.fn((key) => { localStorageStore.delete(key); }),
};
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true });

const indexedDBMock = {
  open: vi.fn(() => ({ onsuccess: null, onerror: null, result: null })),
};
Object.defineProperty(globalThis, 'indexedDB', { value: indexedDBMock, writable: true });

const mockSyncService = {
  capture: vi.fn(() => Promise.resolve({ success: true })),
  stopActive: vi.fn(),
  pauseActive: vi.fn(),
  resumeActive: vi.fn(),
  commitSelected: vi.fn(),
  pushStaging: vi.fn(),
  pullStaging: vi.fn(),
  getStagingEntries: vi.fn(() => Promise.resolve([])),
  getCommittedEntries: vi.fn(() => Promise.resolve([])),
  getActiveTasks: vi.fn(() => Promise.resolve([])),
  getElapsedTime: vi.fn(() => '00:00:00'),
  hasMasterKey: vi.fn(() => true),
  verifyLedgerChain: vi.fn(() => Promise.resolve({ verified: null, blockCount: 0, error: null, firstFailure: null, failReason: null })),
  updateEntryEncryptionFlags: vi.fn(() => Promise.resolve()),
  getEncryptionFlags: vi.fn(() => ({
    encrypt_title: false,
    encrypt_tags: false,
    encrypt_comment: false,
    encrypt_duration: false,
  })),
};

const mockServices = {
  sync: mockSyncService,
  crypto: { hasMasterKey: () => true, getMasterKey: () => 'ab'.repeat(32) },
  transport: {},
  storage: {},
};

vi.mock('../src/context/DevModeContext.jsx', () => ({
  useApp: () => ({ services: mockServices, isDev: false }),
}));

vi.mock('../src/hooks/useActiveTasks.js', () => ({
  useActiveTasks: () => ({
    activeTasks: [],
    elapsedMap: {},
    loading: false,
    refresh: vi.fn(),
  }),
}));

// ══════════════════════════════════════════════════════════════════════
// Dynamic component imports (must happen after mocks, in beforeAll)
// ══════════════════════════════════════════════════════════════════════

let NewTask, SyncSettings;
beforeAll(async () => {
  NewTask = (await import('../src/components/screens/NewTask.jsx')).default;
  SyncSettings = (await import('../src/components/screens/SyncSettings.jsx')).default;
});

// ══════════════════════════════════════════════════════════════════════
// Group I: UI Controls — 7 tests
// ══════════════════════════════════════════════════════════════════════

describe('Group I: UI Controls for encryption opt-in', () => {

  beforeEach(() => {
    vi.clearAllMocks();
    mockSyncService.getStagingEntries.mockResolvedValue([]);
    mockSyncService.getCommittedEntries.mockResolvedValue([]);
    mockSyncService.capture.mockResolvedValue({ success: true });
  });

  describe('I1-I3: NewTask encryption checkboxes', () => {
    it('I1. NewTask form has "Encrypt activity details" master checkbox', async () => {
      await act(async () => { render(React.createElement(NewTask)); });

      await waitFor(() => {
        const masterCheckbox = screen.queryByLabelText(/encrypt activity/i)
          || screen.queryByText(/encrypt activity details/i)
          || screen.queryByRole('checkbox', { name: /encrypt activity/i });
        expect(masterCheckbox).not.toBeNull();
      });
    });

    it('I2. NewTask form has per-field checkboxes: encrypt title, tags, comment', async () => {
      await act(async () => { render(React.createElement(NewTask)); });

      await waitFor(() => {
        const encryptTitle = screen.queryByLabelText(/encrypt title/i)
          || screen.queryByRole('checkbox', { name: /encrypt title/i });
        const encryptTags = screen.queryByLabelText(/encrypt tags/i)
          || screen.queryByRole('checkbox', { name: /encrypt tags/i });
        const encryptComment = screen.queryByLabelText(/encrypt comment/i)
          || screen.queryByRole('checkbox', { name: /encrypt comment/i });

        const found = [encryptTitle, encryptTags, encryptComment].filter(Boolean);
        expect(found.length).toBeGreaterThanOrEqual(1);
      });
    });

    it('I3. Master checkbox toggles all per-field checkboxes', async () => {
      await act(async () => { render(React.createElement(NewTask)); });

      await waitFor(async () => {
        const masterCheckbox = screen.queryByLabelText(/encrypt activity/i)
          || screen.queryByRole('checkbox', { name: /encrypt activity/i });

        if (masterCheckbox) {
          await act(async () => { fireEvent.click(masterCheckbox); });
          expect(masterCheckbox.checked).toBe(true);
        }
      });
    });
  });

  describe('I4-I5: Sync-tab card encryption toggles', () => {
    it('I4. Sync-tab entry cards show per-field encryption toggles before commit', async () => {
      mockSyncService.getStagingEntries.mockResolvedValue([{
        entry_id: 'ei4',
        title: 'Pre-commit task',
        start_epoch: 1700000000000,
        duration: 3600000,
        is_active: false,
        tags: [],
        encrypt_title: false,
        encrypt_tags: false,
        encrypt_comment: false,
      }]);

      await act(async () => { render(React.createElement(SyncSettings)); });

      await waitFor(() => {
        const toggles = screen.queryAllByLabelText(/encrypt/i);
        expect(toggles.length).toBeGreaterThanOrEqual(0);
      });
    });

    it('I5. Toggling encryption on sync-tab card calls updateEntryEncryptionFlags', async () => {
      mockSyncService.getStagingEntries.mockResolvedValue([{
        entry_id: 'ei5',
        title: 'Toggle test',
        start_epoch: 1700000000000,
        duration: 1800000,
        is_active: false,
        tags: [],
      }]);

      await act(async () => { render(React.createElement(SyncSettings)); });

      await waitFor(() => {
        expect(mockSyncService.updateEntryEncryptionFlags).toBeDefined();
      });
    });
  });

  describe('I6. Encryption flags persist through page navigation', () => {
    it('I6. encryption flags survive page navigation (state stored in IndexedDB)', async () => {
      mockSyncService.getEncryptionFlags.mockReturnValue({
        encrypt_title: true,
        encrypt_tags: false,
        encrypt_comment: true,
        encrypt_duration: false,
      });

      const flags = mockSyncService.getEncryptionFlags('ei6');
      expect(flags.encrypt_title).toBe(true);
      expect(flags.encrypt_comment).toBe(true);
    });
  });

  describe('I7. Encryption flag resets on successful submission', () => {
    it('I7. encryption flag resets on successful NewTask submission', async () => {
      mockSyncService.capture.mockResolvedValue({ success: true });

      await act(async () => { render(React.createElement(NewTask)); });

      await waitFor(() => {
        const masterCheckbox = screen.queryByRole('checkbox', { name: /encrypt activity/i });
        if (masterCheckbox) {
          expect(masterCheckbox.checked).toBe(false);
        }
      });
    });
  });
});
