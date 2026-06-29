/**
 * onboarding_import_component.test.mjs — OnboardingScreen Import Form Component Tests.
 *
 * Tier 2 React component tests for the OnboardingScreen import form state machine.
 * Covers: file picker gating, destroy warning display, checkbox gates, error display,
 * and import source selection / back navigation.
 *
 * Usage:
 *   npx vitest run test/onboarding_import_component.test.mjs
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

// ══════════════════════════════════════════════════════════════════════
// IndexedDB Mock (probeExistingData)
// ══════════════════════════════════════════════════════════════════════

let _mockBlocks = 0;
let _mockStaging = 0;
let _openMock;

function buildMockDB(blocksCount, stagingCount) {
  return {
    transaction: () => {
      let txCompleteFn = null;
      const firedKeys = new Set();

      function maybeComplete() {
        if (firedKeys.size >= 2 && txCompleteFn) {
          txCompleteFn();
        }
      }

      return {
        objectStore: () => ({
          get: (key) => {
            const gr = { onsuccess: null };
            gr.result =
              key === 'ledger:blocks'
                ? blocksCount > 0
                  ? new Array(blocksCount).fill({})
                  : undefined
                : stagingCount > 0
                  ? new Array(stagingCount).fill({})
                  : undefined;

            setTimeout(() => {
              gr.onsuccess?.();
              firedKeys.add(key);
              maybeComplete();
            }, 0);
            return gr;
          },
        }),
        set oncomplete(fn) { txCompleteFn = fn; },
        set onerror(fn) {},
      };
    },
  };
}

function setupIndexedDBMock() {
  _openMock = vi.fn((name) => {
    const req = {};
    setTimeout(() => {
      req.onsuccess?.({ target: { result: buildMockDB(_mockBlocks, _mockStaging) } });
    }, 0);
    return req;
  });

  Object.defineProperty(globalThis, 'indexedDB', {
    value: { open: _openMock },
    writable: true,
    configurable: true,
  });
}

function teardownIndexedDBMock() {
  // Restore to a simple no-op indexedDB (or delete the property)
  try {
    delete globalThis.indexedDB;
  } catch {
    // Some environments don't allow delete — override with a safe stub
  }
}

// ══════════════════════════════════════════════════════════════════════
// Dynamic Import Mocks (transport/remote_import — only used by cloud flow)
// ══════════════════════════════════════════════════════════════════════

// Cloud import uses dynamic `import('../../sync/transport.js')` and
// `import('../../sync/remote_import.js')`. Since file import tests don't
// trigger cloud code paths, we stub them to prevent errors if the test
// environment tries to resolve unmatched dynamic imports.

vi.mock('../../sync/transport.js', () => ({
  HttpTransport: class {},
}));

vi.mock('../../sync/remote_import.js', () => ({
  WorkerImportSource: class {},
}));

// ══════════════════════════════════════════════════════════════════════
// Default Props Factory
// ══════════════════════════════════════════════════════════════════════

function defaultProps(overrides = {}) {
  return {
    hasExistingData: false,
    onImport: vi.fn(),
    onValidateImport: vi.fn(),
    onConfirmImport: vi.fn(),
    onNewLedger: vi.fn(),
    onWorkerConnect: vi.fn(),
    onImportFromCloud: vi.fn(),
    onExport: vi.fn(),
    onExportFull: vi.fn(),
    onBack: vi.fn(),
    error: '',
    ...overrides,
  };
}

// ══════════════════════════════════════════════════════════════════════
// Navigation Helpers
// ══════════════════════════════════════════════════════════════════════

/** Navigate from menu → import → file form. Returns after file form is visible. */
async function navigateToFileForm() {
  // Load the component (dynamic import after mocks)
  const { default: OnboardingScreen } = await import(
    '../src/components/screens/OnboardingScreen.jsx'
  );

  const props = defaultProps();
  render(React.createElement(OnboardingScreen, props));

  // Click "📥 Import a ledger"
  fireEvent.click(screen.getByText('📥 Import a ledger'));

  // Wait for import source selection to appear
  await waitFor(() => {
    expect(screen.getByText('📁 From File')).toBeInTheDocument();
  });

  // Click "📁 From File"
  fireEvent.click(screen.getByText('📁 From File'));

  // Wait for the file import form to appear (seed field is unique to file form)
  await waitFor(() => {
    expect(screen.getByLabelText('Recovery Seed')).toBeInTheDocument();
  });

  return { props };
}

/** Fill the import form fields */
function fillImportFields(overrides = {}) {
  const {
    seed = 'test-recovery-seed-base64',
    passphrase = 'test-passphrase',
  } = overrides;

  const seedInput = screen.getByLabelText('Recovery Seed');
  fireEvent.change(seedInput, { target: { value: seed } });

  const passphraseInput = screen.getByLabelText('Passphrase');
  fireEvent.change(passphraseInput, { target: { value: passphrase } });
}

/** Get the Import Ledger button */
function getImportButton() {
  return screen.getByRole('button', { name: 'Import Ledger' });
}

// ══════════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════════

describe('OnboardingScreen — Import Form', () => {
  beforeEach(() => {
    _mockBlocks = 0;
    _mockStaging = 0;
    setupIndexedDBMock();
  });

  afterEach(() => {
    teardownIndexedDBMock();
  });

  // ── I1: Import source selection ──────────────────────────────────

  describe('I1 — Import source selection', () => {
    it('I1.1: shows file and cloud options after clicking Import', async () => {
      const { default: OnboardingScreen } = await import(
        '../src/components/screens/OnboardingScreen.jsx'
      );
      render(React.createElement(OnboardingScreen, defaultProps()));

      expect(screen.getByText('📥 Import a ledger')).toBeInTheDocument();

      fireEvent.click(screen.getByText('📥 Import a ledger'));

      await waitFor(() => {
        expect(screen.getByText('📁 From File')).toBeInTheDocument();
        expect(screen.getByText('☁️ From Cloud')).toBeInTheDocument();
      });
    });

    it('I1.2: Back button returns to menu from source selection', async () => {
      const { default: OnboardingScreen } = await import(
        '../src/components/screens/OnboardingScreen.jsx'
      );
      render(React.createElement(OnboardingScreen, defaultProps()));

      fireEvent.click(screen.getByText('📥 Import a ledger'));

      await waitFor(() => {
        expect(screen.getByText('📁 From File')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('← Back'));

      await waitFor(() => {
        expect(screen.getByText('📥 Import a ledger')).toBeInTheDocument();
      });
    });
  });

  // ── I2: File picker gating — submit disabled without file ────────

  describe('I2 — File picker gating (disabled)', () => {
    it('I2.1: Import button disabled when no file selected', async () => {
      await navigateToFileForm();

      fillImportFields();
      // File is NOT selected

      const btn = getImportButton();
      expect(btn).toBeDisabled();
    });

    it('I2.2: Import button disabled when no passphrase', async () => {
      await navigateToFileForm();

      // Fill seed only
      fireEvent.change(screen.getByLabelText('Recovery Seed'), {
        target: { value: 'test-seed' },
      });

      const btn = getImportButton();
      expect(btn).toBeDisabled();
    });

    it('I2.3: Import button disabled when no recovery seed', async () => {
      await navigateToFileForm();

      // Fill passphrase only
      fireEvent.change(screen.getByLabelText('Passphrase'), {
        target: { value: 'test-passphrase' },
      });

      const btn = getImportButton();
      expect(btn).toBeDisabled();
    });
  });

  // ── I3: File picker gating — submit enabled with all fields ──────

  describe('I3 — File picker gating (enabled)', () => {
    it('I3.1: Import button enabled with file, seed, and passphrase', async () => {
      await navigateToFileForm();
      fillImportFields();

      // Select a file via the file input
      const file = new File(['{"test":true}'], 'test-ledger.json', {
        type: 'application/json',
      });
      const fileInput = document.querySelector('input[type="file"]');
      fireEvent.change(fileInput, { target: { files: [file] } });

      const btn = getImportButton();
      expect(btn).toBeEnabled();
    });
  });

  // ── I4: Destroy warning displayed when existing data ─────────────

  describe('I4 — Destroy warning with existing data', () => {
    beforeEach(() => {
      _mockBlocks = 2;
      _mockStaging = 3;
    });

    it('I4.1: shows destroy warning banner when existing blocks exist', async () => {
      await navigateToFileForm();

      // Wait for probeExistingData to resolve and state to update
      await waitFor(() => {
        expect(
          screen.getByText(/The ledger currently in use will be destroyed/i)
        ).toBeInTheDocument();
      });
    });

    it('I4.2: shows committed block count in destroy warning', async () => {
      await navigateToFileForm();

      await waitFor(() => {
        expect(
          screen.getByText(/2 committed blocks? will be replaced/i)
        ).toBeInTheDocument();
      });
    });

    it('I4.3: shows staging entry count in destroy warning', async () => {
      await navigateToFileForm();

      await waitFor(() => {
        expect(
          screen.getByText(/3 uncommitted staging entries will be lost/i)
        ).toBeInTheDocument();
      });
    });
  });

  // ── I5: Destroy warning NOT shown without existing data ──────────

  describe('I5 — No destroy warning without data', () => {
    it('I5.1: destroy warning absent when IndexedDB has no blocks', async () => {
      _mockBlocks = 0;
      _mockStaging = 0;

      await navigateToFileForm();

      // Wait a moment for probeExistingData to settle
      await waitFor(() => {
        expect(screen.getByLabelText('Recovery Seed')).toBeInTheDocument();
      });

      // The destroy warning should NOT be in the DOM
      expect(
        screen.queryByText(/The ledger currently in use will be destroyed/i)
      ).not.toBeInTheDocument();
    });

    it('I5.2: destroy warning absent when hasExistingData is false', async () => {
      // Override props to explicitly set hasExistingData=false
      const { default: OnboardingScreen } = await import(
        '../src/components/screens/OnboardingScreen.jsx'
      );
      const props = defaultProps({ hasExistingData: false });
      render(React.createElement(OnboardingScreen, props));

      fireEvent.click(screen.getByText('📥 Import a ledger'));
      await waitFor(() => screen.getByText('📁 From File'));
      fireEvent.click(screen.getByText('📁 From File'));
      await waitFor(() => screen.getByLabelText('Recovery Seed'));

      // Wait for probeExistingData to run
      await new Promise((r) => setTimeout(r, 50));

      expect(
        screen.queryByText(/The ledger currently in use will be destroyed/i)
      ).not.toBeInTheDocument();
    });
  });

  // ── I6: Confirm destroy checkbox gates submit ────────────────────

  describe('I6 — Confirm destroy checkbox gate', () => {
    beforeEach(() => {
      _mockBlocks = 2;
      _mockStaging = 0;
    });

    it('I6.1: verify "I understand" checkbox is required', async () => {
      await navigateToFileForm();

      // Wait for destroy warning to appear
      await waitFor(() => {
        expect(
          screen.getByText(/The ledger currently in use will be destroyed/i)
        ).toBeInTheDocument();
      });

      fillImportFields();
      const file = new File(['{}'], 'test.json', { type: 'application/json' });
      const fileInput = document.querySelector('input[type="file"]');
      fireEvent.change(fileInput, { target: { files: [file] } });

      // Button should still be disabled — checkbox not checked
      expect(getImportButton()).toBeDisabled();

      // Check the "I understand" checkbox
      const confirmCheckbox = screen.getByRole('checkbox', {
        name: /I understand.*this will destroy my existing ledger/i,
      });
      fireEvent.click(confirmCheckbox);

      // Now button should be enabled
      expect(getImportButton()).toBeEnabled();
    });

    it('I6.2: unchecking the box disables submit again', async () => {
      await navigateToFileForm();

      await waitFor(() => {
        expect(
          screen.getByText(/The ledger currently in use will be destroyed/i)
        ).toBeInTheDocument();
      });

      fillImportFields();
      const file = new File(['{}'], 'test.json', { type: 'application/json' });
      const fileInput = document.querySelector('input[type="file"]');
      fireEvent.change(fileInput, { target: { files: [file] } });

      const confirmCheckbox = screen.getByRole('checkbox', {
        name: /I understand.*this will destroy my existing ledger/i,
      });
      fireEvent.click(confirmCheckbox);
      expect(getImportButton()).toBeEnabled();

      // Uncheck
      fireEvent.click(confirmCheckbox);
      expect(getImportButton()).toBeDisabled();
    });
  });

  // ── I7: Keep staging checkbox with staging entries ───────────────

  describe('I7 — Keep staging checkbox', () => {
    beforeEach(() => {
      _mockBlocks = 1;
      _mockStaging = 4;
    });

    it('I7.1: keep staging checkbox appears with staging count', async () => {
      await navigateToFileForm();

      await waitFor(() => {
        // The "Keep" checkbox label text is split across multiple nodes
        // (<span>Keep <strong>4</strong> uncommitted staging entries after import.</span>)
        // Use getByRole to find the checkbox, then check the wrapping label's text
        const keepCheckbox = screen.getByRole('checkbox', { name: /Keep/i });
        expect(keepCheckbox).toBeInTheDocument();
        // Verify the full label text is correct
        const label = keepCheckbox.closest('label');
        expect(label.textContent).toMatch(/Keep\s+4\s+uncommitted staging entr/);
        expect(label.textContent).toMatch(/after import/);
      });
    });

    it('I7.2: keep staging checkbox is checked by default', async () => {
      await navigateToFileForm();

      await waitFor(() => {
        const keepBox = screen.getByRole('checkbox', { name: /Keep/i });
        expect(keepBox).toBeChecked();
      });
    });

    it('I7.3: keep staging checkbox absent when no staging entries', async () => {
      _mockStaging = 0;

      await navigateToFileForm();

      // Wait for probeExistingData to resolve
      await new Promise((r) => setTimeout(r, 50));

      expect(
        screen.queryByRole('checkbox', { name: /Keep/i })
      ).not.toBeInTheDocument();
    });
  });

  // ── I8: Error display — prop and local ───────────────────────────

  describe('I8 — Error display', () => {
    it('I8.1: displays error prop in import form', async () => {
      const { default: OnboardingScreen } = await import(
        '../src/components/screens/OnboardingScreen.jsx'
      );
      const props = defaultProps({ error: 'Genesis validation failed: bad seal' });
      render(React.createElement(OnboardingScreen, props));

      fireEvent.click(screen.getByText('📥 Import a ledger'));
      await waitFor(() => screen.getByText('📁 From File'));
      fireEvent.click(screen.getByText('📁 From File'));
      await waitFor(() => screen.getByLabelText('Recovery Seed'));

      expect(
        screen.getByText('Genesis validation failed: bad seal')
      ).toBeInTheDocument();
    });

    it('I8.2: error cleared when navigating back to source selection', async () => {
      const { default: OnboardingScreen } = await import(
        '../src/components/screens/OnboardingScreen.jsx'
      );
      const props = defaultProps({ error: 'Some error' });
      render(React.createElement(OnboardingScreen, props));

      fireEvent.click(screen.getByText('📥 Import a ledger'));
      await waitFor(() => screen.getByText('📁 From File'));
      fireEvent.click(screen.getByText('📁 From File'));
      await waitFor(() => screen.getByLabelText('Recovery Seed'));

      expect(screen.getByText('Some error')).toBeInTheDocument();

      // Go back to source selection
      fireEvent.click(screen.getByText('← Back'));
      await waitFor(() => screen.getByText('📁 From File'));

      // Error should be cleared (localError resets in useEffect on phase change)
      expect(screen.queryByText('Some error')).not.toBeInTheDocument();
    });

    it('I8.3: I8.3: error message uses auth-error-msg class', async () => {
      const { default: OnboardingScreen } = await import(
        '../src/components/screens/OnboardingScreen.jsx'
      );
      const props = defaultProps({ error: 'Test error' });
      render(React.createElement(OnboardingScreen, props));

      fireEvent.click(screen.getByText('📥 Import a ledger'));
      await waitFor(() => screen.getByText('📁 From File'));
      fireEvent.click(screen.getByText('📁 From File'));
      await waitFor(() => screen.getByLabelText('Recovery Seed'));

      const errorEl = screen.getByText('Test error');
      expect(errorEl).toHaveClass('auth-error-msg');
    });
  });

  // ── I9: Back navigation within import phases ─────────────────────

  describe('I9 — Back navigation', () => {
    it('I9.1: back from file form returns to source selection', async () => {
      await navigateToFileForm();

      // File form is shown — now go back
      fireEvent.click(screen.getByText('← Back'));

      await waitFor(() => {
        expect(screen.getByText('📁 From File')).toBeInTheDocument();
        expect(screen.getByText('☁️ From Cloud')).toBeInTheDocument();
      });
    });

    it('I9.2: back from source selection returns to menu', async () => {
      const { default: OnboardingScreen } = await import(
        '../src/components/screens/OnboardingScreen.jsx'
      );
      render(React.createElement(OnboardingScreen, defaultProps()));

      fireEvent.click(screen.getByText('📥 Import a ledger'));
      await waitFor(() => screen.getByText('📁 From File'));

      fireEvent.click(screen.getByText('← Back'));

      await waitFor(() => {
        expect(screen.getByText('📥 Import a ledger')).toBeInTheDocument();
      });
    });
  });
});
