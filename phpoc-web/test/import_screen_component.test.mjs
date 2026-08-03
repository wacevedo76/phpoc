/**
 * import_screen_component.test.mjs — ImportScreen Component Tests.
 *
 * Tier 2 React component tests for the ImportScreen state machine.
 * Covers: form fields, button gating, preview/import flows,
 * conflict display, success/error states, and service-unavailable banner.
 *
 * Matches Phase 1 blueprint Group L assertions (L1–L8) plus edge cases.
 *
 * Usage:
 *   npx vitest run test/import_screen_component.test.mjs
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';

// Use createElement — .mjs files don't get JSX transform
const h = React.createElement;

// ══════════════════════════════════════════════════════════════════════
// Mocks
// ══════════════════════════════════════════════════════════════════════

const MOCK_MASTER_KEY = 'a'.repeat(64);

const mockImportService = {
  dryRun: vi.fn(),
  import: vi.fn(),
  _parseChainBuffer: vi.fn(),
};

// Construable stubs for the classes ImportScreen instantiates
class MockImportService {
  constructor() { return mockImportService; }
}

class mockLedgerChain {
  constructor() {
    this.readAll = vi.fn().mockResolvedValue([]);
  }
}

const mockUseApp = vi.fn();

vi.mock('../src/context/DevModeContext.jsx', () => ({
  useApp: () => mockUseApp(),
}));

vi.mock('../src/services/import_service.js', () => ({
  ImportService: MockImportService,
}));

vi.mock('../src/ledger/chain.js', () => ({
  LedgerChain: mockLedgerChain,
}));

// Dynamic import after mocks
let ImportScreen;
beforeAll(async () => {
  const mod = await import('../src/components/screens/ImportScreen.jsx');
  ImportScreen = mod.default;
});

// ══════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════

function createMockServices(overrides = {}) {
  return {
    crypto: {
      getMasterKey: () => MOCK_MASTER_KEY,
      deriveMasterKey: (seed) => 'derived-' + seed,
      encrypt: (text) => 'enc:' + text,
      decrypt: (text) => text.replace(/^enc:/, ''),
      sha256: (text) => 'sha256:' + text,
      seal: (data) => 'seal:' + JSON.stringify(data),
    },
    storage: {
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
    },
    ...overrides,
  };
}

function setServicesAvailable() {
  mockUseApp.mockReturnValue({
    services: createMockServices(),
    isDev: false,
  });
}

function setServicesUnavailable() {
  mockUseApp.mockReturnValue({
    services: { crypto: null, storage: null },
    isDev: false,
  });
}

function setDevMode() {
  mockUseApp.mockReturnValue({
    services: { crypto: null, storage: null },
    isDev: true,
  });
}

function renderImportScreen() {
  return render(h(ImportScreen));
}

/** Enter a seed in the recovery seed field. */
function fillSeed(value = 'test-seed-1234567890') {
  const input = screen.getByLabelText(/recovery seed/i);
  fireEvent.change(input, { target: { value } });
}

/** Select a file via the file picker.  arrayBuffer() is stubbed so
 *  it can be called multiple times (preview + import phases). */
function selectFile(filename = 'ledger.json') {
  const file = new File(['{}'], filename, { type: 'application/json' });
  // Stub arrayBuffer to always return fresh bytes (preview consumes it first)
  file.arrayBuffer = vi.fn().mockResolvedValue(new Uint8Array([123, 125]).buffer);
  const input = document.querySelector('input[type="file"]');
  Object.defineProperty(input, 'files', { value: [file] });
  fireEvent.change(input);
}

/** Click the "Preview Import" button and wait for async. */
async function clickPreview() {
  fireEvent.click(screen.getByRole('button', { name: /preview import/i }));
  await waitFor(() => {});
}

/** Set up a successful dryRun. */
function mockDryRunSuccess(preview = null) {
  const p = preview || {
    entryCount: 3,
    dateRange: { first: '2026-01-01', last: '2026-01-03' },
    conflicts: [],
  };
  mockImportService.dryRun.mockResolvedValue(p);
  mockImportService._parseChainBuffer.mockReturnValue([{ type: 'genesis' }]);
}

/** Set up dryRun to throw. */
function mockDryRunError(message = 'Preview failed') {
  mockImportService.dryRun.mockRejectedValue(new Error(message));
  mockImportService._parseChainBuffer.mockReturnValue([{ type: 'genesis' }]);
}

/** Full flow: render, select file, fill seed, click preview, wait. */
async function goToPreview(previewData) {
  mockDryRunSuccess(previewData);
  renderImportScreen();
  selectFile();
  fillSeed();
  await clickPreview();
  await waitFor(() => {});
}

// ══════════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════════

describe('ImportScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setServicesAvailable();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── L1: Seed text field ────────────────────────────────────────

  describe('L1 — Seed field', () => {
    it('shows a recovery seed text field of type password', () => {
      renderImportScreen();
      const input = screen.getByLabelText(/recovery seed/i);
      expect(input).toBeInTheDocument();
      expect(input.type).toBe('password');
    });
  });

  // ── L2: File picker ────────────────────────────────────────────

  describe('L2 — File picker', () => {
    it('shows a file input accepting .json', () => {
      renderImportScreen();
      const input = document.querySelector('input[type="file"]');
      expect(input).toBeInTheDocument();
      expect(input.accept).toBe('.json');
    });
  });

  // ── L3: Preview button gating (disabled) ───────────────────────

  describe('L3 — Preview button gating (disabled)', () => {
    it('disables Preview button when seed and file are both empty', () => {
      renderImportScreen();
      const btn = screen.getByRole('button', { name: /preview import/i });
      expect(btn).toBeDisabled();
    });
  });

  // ── L4: Seed / file enables Preview ────────────────────────────

  describe('L4 — Seed or file enables Preview', () => {
    it('enables Preview button when seed text is entered', () => {
      renderImportScreen();
      fillSeed();
      const btn = screen.getByRole('button', { name: /preview import/i });
      expect(btn).not.toBeDisabled();
    });

    it('enables Preview button when a file is selected (no seed)', () => {
      renderImportScreen();
      selectFile();
      const btn = screen.getByRole('button', { name: /preview import/i });
      expect(btn).not.toBeDisabled();
    });
  });

  // ── L5: Preview triggers dryRun + loading state ────────────────

  describe('L5 — Preview calls dryRun + shows spinner', () => {
    it('shows loading spinner after clicking Preview', async () => {
      mockDryRunSuccess();
      renderImportScreen();
      selectFile();
      fillSeed();

      fireEvent.click(screen.getByRole('button', { name: /preview import/i }));

      await waitFor(() => {
        expect(screen.getByText(/analyzing source ledger/i)).toBeInTheDocument();
      });
    });

    it('calls dryRun with seed and parsed chain', async () => {
      mockDryRunSuccess();
      mockImportService._parseChainBuffer.mockReturnValue([{ type: 'genesis' }, { type: 'day' }]);
      renderImportScreen();
      selectFile('test.json');
      fillSeed('my-seed');

      await clickPreview();

      await waitFor(() => {
        expect(mockImportService.dryRun).toHaveBeenCalledWith(
          'my-seed',
          [{ type: 'genesis' }, { type: 'day' }]
        );
      });
    });
  });

  // ── L6: Preview panel displays ─────────────────────────────────

  describe('L6 — Preview panel displays', () => {
    it('shows entry count and date range after dry-run', async () => {
      mockDryRunSuccess({
        entryCount: 5,
        dateRange: { first: '2026-06-01', last: '2026-06-05' },
        conflicts: [],
      });
      renderImportScreen();
      selectFile();
      fillSeed();

      await clickPreview();

      await waitFor(() => {
        expect(document.body.textContent).toContain('5 entries found');
        expect(document.body.textContent).toContain('2026-06-01');
        expect(document.body.textContent).toContain('2026-06-05');
      });
    });

    it('shows singular "1 entry" when count is 1', async () => {
      mockDryRunSuccess({
        entryCount: 1,
        dateRange: { first: '2026-07-01', last: '2026-07-01' },
        conflicts: [],
      });
      renderImportScreen();
      selectFile();
      fillSeed();

      await clickPreview();

      await waitFor(() => {
        expect(document.body.textContent).toContain('1 entry found');
      });
    });

    it('shows "Import N Entries" button for clean import', async () => {
      mockDryRunSuccess({
        entryCount: 5,
        dateRange: { first: '2026-01-01', last: '2026-01-05' },
        conflicts: [],
      });
      renderImportScreen();
      selectFile();
      fillSeed();

      await clickPreview();

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /import 5 entries/i })).toBeInTheDocument();
      });
    });
  });

  // ── L7: Conflict display ───────────────────────────────────────

  describe('L7 — Conflict display', () => {
    it('shows conflict warning when dates overlap', async () => {
      await goToPreview({
        entryCount: 3,
        dateRange: { first: '2026-01-01', last: '2026-01-03' },
        conflicts: ['2026-01-01', '2026-01-02'],
      });

      expect(screen.getByText(/2 date conflicts/i)).toBeInTheDocument();
      expect(screen.getByText(/2026-01-01, 2026-01-02/)).toBeInTheDocument();
    });

    it('shows "Import Anyway" when conflicts exist', async () => {
      await goToPreview({
        entryCount: 3,
        dateRange: { first: '2026-01-01', last: '2026-01-03' },
        conflicts: ['2026-01-01'],
      });

      expect(screen.getByRole('button', { name: /import anyway/i })).toBeInTheDocument();
    });

    it('calls import with force:true when "Import Anyway" clicked', async () => {
      await goToPreview({
        entryCount: 3,
        dateRange: { first: '2026-01-01', last: '2026-01-03' },
        conflicts: ['2026-01-01'],
      });
      mockImportService.import.mockResolvedValue({
        migratedCount: 3, skippedCount: 0, newBlockCount: 1,
      });

      fireEvent.click(screen.getByRole('button', { name: /import anyway/i }));

      await waitFor(() => {
        expect(mockImportService.import).toHaveBeenCalledWith(
          'test-seed-1234567890',
          expect.any(Array),
          { force: true }
        );
      });
    });

    it('"Cancel" returns to initial state', async () => {
      await goToPreview({
        entryCount: 3,
        dateRange: { first: '2026-01-01', last: '2026-01-03' },
        conflicts: [],
      });

      fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

      await waitFor(() => {
        expect(screen.getByLabelText(/recovery seed/i)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /preview import/i })).toBeInTheDocument();
      });
    });
  });

  // ── L8: Import success state ───────────────────────────────────

  describe('L8 — Import success state', () => {
    beforeEach(() => {
      mockImportService.import.mockResolvedValue({
        migratedCount: 7,
        skippedCount: 2,
        newBlockCount: 3,
      });
    });

    it('shows migrated count after import', async () => {
      await goToPreview({
        entryCount: 9,
        dateRange: { first: '2026-01-01', last: '2026-01-09' },
        conflicts: [],
      });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /import 9 entries/i }));
      });

      await waitFor(() => {
        expect(document.body.textContent).toContain('7 entries imported');
      }, { timeout: 5000 });
    });

    it('shows skipped count when duplicates exist', async () => {
      await goToPreview({
        entryCount: 9,
        dateRange: { first: '2026-01-01', last: '2026-01-09' },
        conflicts: [],
      });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /import 9 entries/i }));
      });

      await waitFor(() => {
        expect(document.body.textContent).toContain('2 skipped as duplicates');
      }, { timeout: 5000 });
    });

    it('shows new block count', async () => {
      await goToPreview({
        entryCount: 9,
        dateRange: { first: '2026-01-01', last: '2026-01-09' },
        conflicts: [],
      });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /import 9 entries/i }));
      });

      await waitFor(() => {
        expect(document.body.textContent).toContain('3 new day blocks');
      }, { timeout: 5000 });
    });

    it('shows "Import Another" after success', async () => {
      await goToPreview({
        entryCount: 9,
        dateRange: { first: '2026-01-01', last: '2026-01-09' },
        conflicts: [],
      });

      fireEvent.click(screen.getByRole('button', { name: /import 9 entries/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /import another/i })).toBeInTheDocument();
      });
    });

    it('"Import Another" resets to initial state', async () => {
      await goToPreview({
        entryCount: 9,
        dateRange: { first: '2026-01-01', last: '2026-01-09' },
        conflicts: [],
      });

      fireEvent.click(screen.getByRole('button', { name: /import 9 entries/i }));
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /import another/i })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /import another/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /preview import/i })).toBeInTheDocument();
      });
    });
  });

  // ── Error handling ─────────────────────────────────────────────

  describe('Error handling', () => {
    it('shows error + Try Again / Start Over on dryRun failure', async () => {
      mockDryRunError('Source ledger is corrupted');
      renderImportScreen();
      selectFile();
      fillSeed();

      await clickPreview();

      await waitFor(() => {
        expect(screen.getByText(/source ledger is corrupted/i)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /start over/i })).toBeInTheDocument();
      });
    });

    it('"Try Again" preserves seed and returns to initial form', async () => {
      mockDryRunError('test error');
      renderImportScreen();
      selectFile();
      fillSeed('my-seed');

      await clickPreview();

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /try again/i }));

      await waitFor(() => {
        const seedInput = screen.getByLabelText(/recovery seed/i);
        expect(seedInput.value).toBe('my-seed');
        expect(screen.getByRole('button', { name: /preview import/i })).toBeInTheDocument();
      });
    });

    it('"Start Over" clears seed/file and returns to initial', async () => {
      mockDryRunError('test error');
      renderImportScreen();
      selectFile();
      fillSeed('my-seed');

      await clickPreview();

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /start over/i })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /start over/i }));

      await waitFor(() => {
        const seedInput = screen.getByLabelText(/recovery seed/i);
        expect(seedInput.value).toBe('');
        expect(screen.getByRole('button', { name: /preview import/i })).toBeDisabled();
      });
    });
  });

  // ── Service unavailable ────────────────────────────────────────

  describe('Service unavailable', () => {
    it('shows warning when crypto/storage services are not loaded', () => {
      setServicesUnavailable();
      renderImportScreen();
      expect(screen.getByText(/services not available/i)).toBeInTheDocument();
      expect(screen.getByText(/complete onboarding/i)).toBeInTheDocument();
    });

    it('shows dev-specific message in dev mode', () => {
      setDevMode();
      renderImportScreen();
      expect(screen.getByText(/dev mode/i)).toBeInTheDocument();
    });

    it('does not render form fields when services unavailable', () => {
      setServicesUnavailable();
      renderImportScreen();
      expect(screen.queryByLabelText(/recovery seed/i)).not.toBeInTheDocument();
    });

    it('does not render form fields in dev mode', () => {
      setDevMode();
      renderImportScreen();
      expect(screen.queryByLabelText(/recovery seed/i)).not.toBeInTheDocument();
    });
  });

  // ── File selection feedback ────────────────────────────────────

  describe('File selection feedback', () => {
    it('shows selected filename after file pick', () => {
      renderImportScreen();
      selectFile('my-2026-ledger.json');
      expect(screen.getByText(/my-2026-ledger.json/)).toBeInTheDocument();
    });
  });
});
