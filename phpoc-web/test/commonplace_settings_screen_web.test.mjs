/**
 * commonplace_settings_screen_web.test.mjs — CommonplaceSettingsScreen UI
 * contract (Slice 4) — Groups W (4), P (2), V (3), B4 (1), C (4), X (3),
 * R8 (1) from docs/planning/COMMONPLACE_BOOK_SETTINGS_WEB_PHASE1.md.
 * Phase 2 (RED).
 *
 * Vitest + @testing-library/react. The target `src/components/screens/
 * CommonplaceSettingsScreen.jsx` does not exist yet, so it is imported
 * defensively: when absent, a `() => null` stub is substituted and every
 * assertion below fails as an *element-not-found* failure — never an
 * `ERR_MODULE_NOT_FOUND`.
 *
 * DOM contract (drives Phase 3) — `CommonplaceSettingsScreen({ service })`:
 *   - root: `data-testid="commonplace-settings-screen"`, title "Commonplace Settings"
 *   - Worker URL input:  `data-testid="commonplace-worker-url"`
 *   - API Key input:     `data-testid="commonplace-api-key"`
 *   - Save button:       "Check & Save" (persists to localStorage)
 *   - "Verify Commonplace" button → service.verify(); result text:
 *       valid → /verified/i ; invalid → /failed|invalid/i ; empty → /no entries|empty/i
 *   - "Push Commonplace to Cloud" button → "coming soon"/"not implemented" message
 *   - "Backup Commonplace" → service.exportForBackup()
 *   - "Restore Commonplace" → confirm dialog
 *       ("This will replace your Commonplace book." / "Confirm Restore" / "Cancel")
 *   - "Re-key to new Recovery Seed" → two-secret gate
 *       ("Current Passphrase" + "I have saved my new Recovery Seed" + textbox)
 *   - "Clear All Data" (danger styling) → confirm dialog
 *       ("Yes, clear everything" / "Cancel") → useApp().wipeLedger()
 *   - Uses `useApp()` for services + rekey + wipeLedger (service is prop-injected).
 *
 * Run: npx vitest run test/commonplace_settings_screen_web.test.mjs
 */

import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';

// ── Mock @sync/index.js (dynamic import chain inside DevModeContext) ──

vi.mock('@sync/index.js', () => ({
  GenesisGate: { check: vi.fn() },
  createRemoteTransport: vi.fn(),
  SyncService: class {},
  SyncResult: {},
  IndexedDBBackend: class {},
  SessionStorageBackend: class {},
  createTransportFromDeployment: vi.fn(),
  WorkerImportSource: class {},
  HttpTransport: class {},
}));

vi.mock('../src/sync/index.js', () => ({
  GenesisGate: { check: vi.fn() },
  createRemoteTransport: vi.fn(),
  SyncService: class {},
  SyncResult: {},
  IndexedDBBackend: class {},
  SessionStorageBackend: class {},
  createTransportFromDeployment: vi.fn(),
  WorkerImportSource: class {},
  HttpTransport: class {},
}));

// ── Mock fetch / localStorage / indexedDB ────────────────────────────

globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

const localStorageStore = new Map();
const localStorageMock = {
  getItem: vi.fn((key) => localStorageStore.get(key) ?? null),
  setItem: vi.fn((key, val) => { localStorageStore.set(key, val); }),
  removeItem: vi.fn((key) => { localStorageStore.set(key, null); }),
};
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true });

Object.defineProperty(globalThis, 'indexedDB', {
  value: { open: vi.fn(() => ({ onsuccess: null, onerror: null, result: null })) },
  writable: true,
});

// ── Mock useApp (avoid the deep DevModeContext import chain) ─────────

const mockUseApp = vi.fn();
vi.mock('../src/context/DevModeContext.jsx', () => ({
  useApp: () => mockUseApp(),
}));

// Defensive dynamic import of the future screen (Phase 2: stub → RED).
// The path is a VARIABLE so Vite's import-analysis cannot statically resolve the
// missing module at transform time; the runtime import() throws and is caught.
const SCREEN_PATH = '../src/components/screens/CommonplaceSettingsScreen.jsx';
let CommonplaceSettingsScreen;
beforeAll(async () => {
  try {
    const mod = await import(/* @vite-ignore */ SCREEN_PATH);
    CommonplaceSettingsScreen = mod.default;
  } catch {
    // Phase 2 RED: module absent → every element query below fails.
    CommonplaceSettingsScreen = function Stub() { return null; };
  }
});

// ── Test doubles ────────────────────────────────────────────────────

function makeStorageMock() {
  const map = new Map();
  return {
    _map: map,
    get: vi.fn(async (k) => map.get(k)),
    set: vi.fn(async (k, v) => { map.set(k, v); }),
    delete: vi.fn(async (k) => { map.delete(k); }),
    clear: vi.fn(async () => { map.clear(); }),
  };
}

function makeMockService(overrides = {}) {
  return {
    verify: vi.fn(async () => true),
    exportForBackup: vi.fn(async () => JSON.stringify({ type: 'commonplace_chain', genesis: {}, blocks: [] })),
    restoreFromBackup: vi.fn(async () => {}),
    readEntries: vi.fn(async () => []),
    getEntryCount: vi.fn(async () => 0),
    ...overrides,
  };
}

function setUseAppReturn(overrides = {}) {
  const {
    services = {
      crypto: { getMasterKey: () => null, generateSeed: () => 'MOCK_SEED' },
      sync: { checkAndSync: vi.fn(), reconfigure: vi.fn() },
      storage: makeStorageMock(),
    },
    mode = 'production',
    isDev = false,
    rekey = vi.fn(),
    wipeLedger = vi.fn(),
  } = overrides;

  mockUseApp.mockReturnValue({
    mode,
    isDev,
    toggleMode: vi.fn(),
    services,
    rekey,
    wipeLedger,
    exportLedger: vi.fn(),
    importLedger: vi.fn(),
    validateImport: vi.fn(),
    confirmImport: vi.fn(),
    exportLedgerFull: vi.fn(),
  });
}

function renderScreen(service = makeMockService()) {
  return render(React.createElement(CommonplaceSettingsScreen, { service }));
}

/** Seed both books + worker creds and a faithful wipeLedger (mirrors DevModeContext.wipeLedger). */
function setupClearAll({ seedLedger = true, seedCommonplace = true } = {}) {
  const storage = makeStorageMock();
  if (seedLedger) storage._map.set('ledger:blocks', [{ type: 'genesis' }]);
  if (seedCommonplace) storage._map.set('commonplace:blocks', [{ type: 'commonplace_genesis' }]);
  localStorageStore.set('phpoc_worker_url', 'https://example.workers.dev');
  localStorageStore.set('phpoc_api_key', 'secret-key');

  // Faithful stand-in for DevModeContext.wipeLedger (storage.clear() + cred removal).
  const wipeLedger = vi.fn(async () => {
    await storage.clear();
    localStorage.removeItem('phpoc_worker_url');
    localStorage.removeItem('phpoc_api_key');
  });

  setUseAppReturn({ services: { crypto: {}, sync: {}, storage }, wipeLedger });
  return { storage, wipeLedger };
}

// ═══════════════════════════════════════════════════════════════════
// Group W: Worker config (shared localStorage) (4)
// ═══════════════════════════════════════════════════════════════════

describe('W: Worker config (shared localStorage)', () => {
  beforeEach(() => {
    localStorageStore.clear();
    mockUseApp.mockReset();
  });

  it('W1: shows the Worker URL from localStorage["phpoc_worker_url"]', async () => {
    localStorageStore.set('phpoc_worker_url', 'https://example.workers.dev');
    setUseAppReturn();
    renderScreen();

    expect(await screen.findByTestId('commonplace-worker-url')).toHaveValue('https://example.workers.dev');
  });

  it('W2: saving the Worker URL writes localStorage["phpoc_worker_url"]', async () => {
    setUseAppReturn();
    renderScreen();

    fireEvent.change(screen.getByTestId('commonplace-worker-url'), {
      target: { value: 'https://new.example.workers.dev' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(localStorageStore.get('phpoc_worker_url')).toBe('https://new.example.workers.dev');
    });
  });

  it('W3: saving the API Token writes localStorage["phpoc_api_key"]', async () => {
    setUseAppReturn();
    renderScreen();

    fireEvent.change(screen.getByTestId('commonplace-api-key'), {
      target: { value: 'shared-api-token' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(localStorageStore.get('phpoc_api_key')).toBe('shared-api-token');
    });
  });

  it('W4: the ledger Settings (same localStorage) shows the URL saved in Commonplace settings', async () => {
    setUseAppReturn();
    const cpView = renderScreen();
    fireEvent.change(screen.getByTestId('commonplace-worker-url'), {
      target: { value: 'https://cross.example.workers.dev' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(localStorageStore.get('phpoc_worker_url')).toBe('https://cross.example.workers.dev');
    });

    // Unmount the Commonplace screen so only the ledger Settings' input holds
    // the value (both screens share the same localStorage key).
    cpView.unmount();
    const Settings = (await import('../src/components/screens/Settings.jsx')).default;
    const { unmount } = render(React.createElement(Settings));
    expect(screen.getByDisplayValue('https://cross.example.workers.dev')).toBeInTheDocument();
    unmount();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group P: Push Commonplace to Cloud (stub) (2)
// ═══════════════════════════════════════════════════════════════════

describe('P: Push Commonplace to Cloud (stub)', () => {
  beforeEach(() => {
    localStorageStore.clear();
    mockUseApp.mockReset();
    globalThis.fetch.mockClear();
  });

  it('P1: shows a "Push Commonplace to Cloud" affordance', async () => {
    setUseAppReturn();
    renderScreen();
    expect(await screen.findByText('Push Commonplace to Cloud')).toBeInTheDocument();
  });

  it('P2: tapping it shows "not implemented / coming soon" and performs no network push', async () => {
    setUseAppReturn();
    renderScreen();

    await act(async () => {
      fireEvent.click(screen.getByText('Push Commonplace to Cloud'));
    });

    expect(await screen.findByText(/coming soon|not implemented/i)).toBeInTheDocument();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group V: Verify Commonplace (3)
// ═══════════════════════════════════════════════════════════════════

describe('V: Verify Commonplace', () => {
  beforeEach(() => {
    localStorageStore.clear();
    mockUseApp.mockReset();
  });

  it('V1: shows "Verify Commonplace" (not "Verify Ledger")', async () => {
    setUseAppReturn();
    renderScreen();

    expect(await screen.findByText('Verify Commonplace')).toBeInTheDocument();
    expect(screen.queryByText('Verify Ledger')).not.toBeInTheDocument();
  });

  it('V2: tapping "Verify Commonplace" calls service.verify()', async () => {
    const service = makeMockService();
    setUseAppReturn();
    renderScreen(service);

    await act(async () => {
      fireEvent.click(screen.getByText('Verify Commonplace'));
    });

    await waitFor(() => expect(service.verify).toHaveBeenCalled());
  });

  it('V3: valid chain → positive; invalid chain → failure; empty chain → empty-state', async () => {
    // (a) valid
    let service = makeMockService({ verify: vi.fn(async () => true), getEntryCount: vi.fn(async () => 2) });
    setUseAppReturn();
    let view = renderScreen(service);
    await act(async () => { fireEvent.click(screen.getByText('Verify Commonplace')); });
    expect(await screen.findByText(/verified/i)).toBeInTheDocument();
    view.unmount();

    // (b) invalid
    service = makeMockService({ verify: vi.fn(async () => false), getEntryCount: vi.fn(async () => 2) });
    view = renderScreen(service);
    await act(async () => { fireEvent.click(screen.getByText('Verify Commonplace')); });
    expect(await screen.findByText(/failed|invalid|corrupt/i)).toBeInTheDocument();
    view.unmount();

    // (c) empty
    service = makeMockService({ verify: vi.fn(async () => true), getEntryCount: vi.fn(async () => 0) });
    view = renderScreen(service);
    await act(async () => { fireEvent.click(screen.getByText('Verify Commonplace')); });
    expect(await screen.findByText(/no entries|empty/i)).toBeInTheDocument();
    view.unmount();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group B4: Restore Commonplace confirm guard (1)
// ═══════════════════════════════════════════════════════════════════

describe('B4: Restore Commonplace confirm guard', () => {
  beforeEach(() => {
    localStorageStore.clear();
    mockUseApp.mockReset();
  });

  it('B4: Restore Commonplace is guarded by a confirm dialog (no restore before confirm)', async () => {
    const service = makeMockService();
    setUseAppReturn();
    renderScreen(service);

    await act(async () => {
      fireEvent.click(screen.getByText('Restore Commonplace'));
    });

    expect(await screen.findByText(/This will replace your Commonplace book/i)).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
    // Guard holds: merely opening the dialog must not restore.
    expect(service.restoreFromBackup).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByText('Confirm Restore'));
    });

    await waitFor(() => expect(service.restoreFromBackup).toHaveBeenCalledTimes(1));
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group C: Clear All Data (both books) (4)
// ═══════════════════════════════════════════════════════════════════

describe('C: Clear All Data (both books)', () => {
  beforeEach(() => {
    localStorageStore.clear();
    mockUseApp.mockReset();
  });

  it('C1: wipeLedger clears both ledger:blocks and commonplace:blocks (plus worker creds)', async () => {
    const { storage } = setupClearAll();
    renderScreen();

    await act(async () => { fireEvent.click(screen.getByText('Clear All Data')); });
    await act(async () => { fireEvent.click(screen.getByText('Yes, clear everything')); });

    await waitFor(() => {
      expect(storage._map.get('ledger:blocks')).toBeUndefined();
      expect(storage._map.get('commonplace:blocks')).toBeUndefined();
      expect(localStorageStore.get('phpoc_worker_url')).toBeNull();
      expect(localStorageStore.get('phpoc_api_key')).toBeNull();
    });
  });

  it('C2: shows "Clear All Data" with a confirm dialog + danger styling', async () => {
    setUseAppReturn();
    renderScreen();

    const button = screen.getByText('Clear All Data');
    expect(button).toBeInTheDocument();
    expect(button.className).toMatch(/danger|warning/i);

    await act(async () => { fireEvent.click(button); });

    expect(await screen.findByText('Yes, clear everything')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  it('C3: confirming Clear All Data wipes both books and closes the dialog (clean state)', async () => {
    const { storage, wipeLedger } = setupClearAll();
    renderScreen();

    await act(async () => { fireEvent.click(screen.getByText('Clear All Data')); });
    await act(async () => { fireEvent.click(screen.getByText('Yes, clear everything')); });

    await waitFor(() => expect(wipeLedger).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(storage._map.get('ledger:blocks')).toBeUndefined();
      expect(storage._map.get('commonplace:blocks')).toBeUndefined();
    });
    // Dialog closed (the real app's wipeLedger also returns to the landing phase).
    expect(screen.queryByText('Yes, clear everything')).not.toBeInTheDocument();
  });

  it('C4: Clear All Data is safe when no Commonplace chain exists (first-run)', async () => {
    const { wipeLedger } = setupClearAll({ seedCommonplace: false });
    renderScreen();

    await act(async () => { fireEvent.click(screen.getByText('Clear All Data')); });
    await act(async () => { fireEvent.click(screen.getByText('Yes, clear everything')); });

    await waitFor(() => expect(wipeLedger).toHaveBeenCalledTimes(1));
    // No crash: the screen is still rendered (no error boundary triggered).
    expect(screen.getByTestId('commonplace-settings-screen')).toBeInTheDocument();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group X: Exclusions (3)
// ═══════════════════════════════════════════════════════════════════

describe('X: Exclusions', () => {
  beforeEach(() => {
    localStorageStore.clear();
    mockUseApp.mockReset();
  });

  it('X1: does NOT render "Import Ledger", "Import entries from another ledger", or "Migrate Encryption"', async () => {
    setUseAppReturn();
    renderScreen();

    expect(await screen.findByTestId('commonplace-settings-screen')).toBeInTheDocument();
    expect(screen.queryByText(/Import Ledger/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Import entries from another ledger/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Migrate Encryption/i)).not.toBeInTheDocument();
  });

  it('X2: does NOT render a duplicate "Worker / API Key" registration section', async () => {
    setUseAppReturn();
    renderScreen();

    await screen.findByTestId('commonplace-settings-screen');
    expect(screen.getAllByTestId('commonplace-worker-url')).toHaveLength(1);
    expect(screen.getAllByTestId('commonplace-api-key')).toHaveLength(1);
  });

  it('X3: no secrets/URLs hardcoded — inputs are empty with empty localStorage', async () => {
    setUseAppReturn();
    renderScreen();

    expect(await screen.findByTestId('commonplace-worker-url')).toHaveValue('');
    expect(screen.getByTestId('commonplace-api-key')).toHaveValue('');
    expect(screen.queryByText(/https?:\/\//)).not.toBeInTheDocument();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group R8: re-key reachable from Commonplace settings (1)
// ═══════════════════════════════════════════════════════════════════

describe('R8: re-key reachable from Commonplace settings', () => {
  beforeEach(() => {
    localStorageStore.clear();
    mockUseApp.mockReset();
  });

  it('R8: re-key opens the same two-secret gate (old passphrase + new-seed confirm)', async () => {
    setUseAppReturn();
    renderScreen();

    await act(async () => {
      fireEvent.click(screen.getByText('Re-key to new Recovery Seed'));
    });

    expect(await screen.findByText('Current Passphrase')).toBeInTheDocument();
    expect(screen.getByText('I have saved my new Recovery Seed')).toBeInTheDocument();
    expect(screen.getAllByRole('textbox').length).toBeGreaterThanOrEqual(1);
  });
});
