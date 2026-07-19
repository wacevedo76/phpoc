/**
 * settings_genesis_component_test.mjs — Settings Genesis Gate Component Tests (TDD RED).
 *
 * Renders Settings.jsx via Vitest + @testing-library/react and exercises the
 * actual handleSaveRemote handler. Uses mocked DevModeContext provider,
 * mock GenesisGate, mock transport, and mock storage/crypto services.
 *
 * Coverage (30 tests):
 *   Category B: React Component Integration — 20 tests (B1–B6)
 *   Category E: Edge Cases & Regressions — 6 tests (E1–E6)
 *   Category F: Accessibility & A11Y — 4 tests (F1–F4)
 *
 * Status: 🔴 PHASE RED — Tests created. All expected to fail where features
 * are missing (accessibility attributes, role="status", aria-live="polite").
 * Some existing behavior tests may already pass (status card rendering).
 *
 * Usage:
 *   npx vitest run test/settings_genesis_component.test.mjs
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import React from 'react';

// ── Mock @sync/index.js (dynamic import inside handleSaveRemote) ──────

const mockGenesisCheck = vi.fn();
const mockCreateTransport = vi.fn();

vi.mock('@sync/index.js', () => ({
  GenesisGate: {
    check: (...args) => mockGenesisCheck(...args),
  },
  createRemoteTransport: (...args) => mockCreateTransport(...args),
  // Barrel re-exports needed by DevModeContext (not exercised in genesis tests)
  SyncService: class {},
  SyncResult: {},
  IndexedDBBackend: class {},
  SessionStorageBackend: class {},
  createTransportFromDeployment: vi.fn(),
  WorkerImportSource: class {},
  HttpTransport: class {},
}));

// Also mock the barrel exports that DevModeContext imports at module level
vi.mock('../src/sync/index.js', () => ({
  GenesisGate: { check: (...args) => mockGenesisCheck(...args) },
  createRemoteTransport: (...args) => mockCreateTransport(...args),
  SyncService: class {},
  SyncResult: {},
  IndexedDBBackend: class {},
  SessionStorageBackend: class {},
  createTransportFromDeployment: vi.fn(),
  WorkerImportSource: class {},
  HttpTransport: class {},
}));

// ── Mock fetch (ping step in handleSaveRemote) ──────────────────────

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

// ── Mock localStorage ────────────────────────────────────────────────

const localStorageStore = new Map();
const localStorageMock = {
  getItem: vi.fn((key) => localStorageStore.get(key) ?? null),
  setItem: vi.fn((key, val) => { localStorageStore.set(key, val); }),
  removeItem: vi.fn((key) => { localStorageStore.delete(key); }),
};
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true });

// ── Mock indexedDB (needed by probeExistingData in Settings) ──────────

const indexedDBMock = {
  open: vi.fn(() => ({
    onsuccess: null,
    onerror: null,
    result: null,
  })),
};
Object.defineProperty(globalThis, 'indexedDB', { value: indexedDBMock, writable: true });

// ── Test constants ────────────────────────────────────────────────────

const MASTER_KEY = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const VALID_URL = 'https://test-worker.workers.dev';
const VALID_API_KEY = 'test-api-key';

// ── Mock services factory ─────────────────────────────────────────────

function createMockServices(opts = {}) {
  const {
    masterKey = MASTER_KEY,
    ledgerBlocks = [],
  } = opts;

  const storage = new Map();
  storage.set('ledger:blocks', ledgerBlocks);

  return {
    crypto: {
      getMasterKey: () => masterKey,
    },
    sync: {
      checkAndSync: vi.fn(),
      reconfigure: vi.fn(),
    },
    storage: {
      get: vi.fn((key) => Promise.resolve(storage.get(key))),
      set: vi.fn((key, val) => { storage.set(key, val); return Promise.resolve(); }),
      delete: vi.fn(() => Promise.resolve()),
    },
  };
}

// ── Context wrapper (own context, not imported from DevModeContext) ────

// Settings.jsx uses useApp() which calls useContext on the context from
// DevModeContext.jsx. That module has deep import chains that can't be
// easily mocked — so we mock useApp() itself at the module level.

const mockUseApp = vi.fn();

vi.mock('../src/context/DevModeContext.jsx', () => ({
  useApp: () => mockUseApp(),
}));

// Dynamic import of Settings (must happen after mocks are set up)
let Settings;
beforeAll(async () => {
  const mod = await import('../src/components/screens/Settings.jsx');
  Settings = mod.default;
});

function setUseAppReturn(overrides = {}) {
  const {
    services = createMockServices({ ledgerBlocks: [], masterKey: null }),
    isDev = false,
    toggleMode = vi.fn(),
    exportLedger = vi.fn(),
    importLedger = vi.fn(),
    validateImport = vi.fn(),
    confirmImport = vi.fn(),
    exportLedgerFull = vi.fn(),
  } = overrides;

  mockUseApp.mockReturnValue({
    mode: isDev ? 'dev' : 'production',
    isDev,
    toggleMode,
    services,
    exportLedger,
    importLedger,
    validateImport,
    confirmImport,
    exportLedgerFull,
  });
}

// ── Helpers ───────────────────────────────────────────────────────────

const ZERO_HASH = '0'.repeat(64);

/** Build a minimal genesis block with the given master key */
function buildGenesisBlock(opts = {}) {
  const {
    username = 'testuser',
    email = 'test@example.com',
    date = '2026-01-01',
    formatVersion = '0.3.0',
    masterKey = MASTER_KEY,
  } = opts;

  return {
    type: 'genesis',
    format_version: formatVersion,
    day_index: 0,
    date,
    identity: {
      username,
      email,
      recovery_seed_enc: 'enc:mockseed',
      identity_pub_key: 'mockpubkey0000000000000000000000000000000000000000000000000000',
      identity_secret_enc_fallback: 'enc:mocksecret',
    },
    prev_hash: ZERO_HASH,
    entries: [],
    day_hash: 'mockhash-genesis-0000000000000000000000000000000000000000000000000000000000',
  };
}

/** Build a two-block chain (genesis + day) */
function buildChain(masterKey = MASTER_KEY) {
  const genesis = buildGenesisBlock({ masterKey });
  const day = {
    type: 'day',
    day_index: 1,
    date: '2026-06-20',
    prev_hash: genesis.day_hash,
    entries: [],
    day_hash: 'mockhash-day-000000000000000000000000000000000000000000000000000000000000',
  };
  return [genesis, day];
}

/** Fill the Worker URL field and submit the Save form */
async function saveSettings(url, apiKey = '') {
  const urlInput = screen.getByLabelText('Worker URL');
  const apiKeyInput = screen.getByLabelText('API Key');
  const saveBtn = screen.getByRole('button', { name: /save/i });

  await act(async () => {
    fireEvent.change(urlInput, { target: { value: url } });
    fireEvent.change(apiKeyInput, { target: { value: apiKey } });
    fireEvent.click(saveBtn);
  });
}

/** Fill the Worker URL field and submit the Save form (non-act version for waitFor) */
async function saveSettingsNoAct(url, apiKey = '') {
  const urlInput = screen.getByLabelText('Worker URL');
  const apiKeyInput = screen.getByLabelText('API Key');
  const saveBtn = screen.getByRole('button', { name: /save/i });

  fireEvent.change(urlInput, { target: { value: url } });
  fireEvent.change(apiKeyInput, { target: { value: apiKey } });
  fireEvent.click(saveBtn);
}

// ═══════════════════════════════════════════════════════════════════════
//  CATEGORY B: React Component Integration (20 tests)
// ═══════════════════════════════════════════════════════════════════════

describe('B1 — Save: Compatible Genesis', () => {
  beforeEach(() => {
    localStorageStore.clear();
    mockGenesisCheck.mockReset();
    mockCreateTransport.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
  });

  it('B1.1: Compatible status renders green badge', async () => {
    const chain = buildChain(MASTER_KEY);
    const services = createMockServices({ masterKey: MASTER_KEY, ledgerBlocks: chain });
    setUseAppReturn({ services });
    mockCreateTransport.mockReturnValue({});
    mockGenesisCheck.mockResolvedValue({ compatible: true, stats: { remoteEntries: 5, local: 2, remote: 5, merged: 7 } });

    render(React.createElement(Settings));

    await act(async () => {
      await saveSettings(VALID_URL, VALID_API_KEY);
    });

    await waitFor(() => {
      expect(screen.getByText('✅ Genesis compatible')).toBeInTheDocument();
    });
  });

  it('B1.2: Compatible status persists after save', async () => {
    const chain = buildChain(MASTER_KEY);
    const services = createMockServices({ masterKey: MASTER_KEY, ledgerBlocks: chain });
    setUseAppReturn({ services });
    mockCreateTransport.mockReturnValue({});
    mockGenesisCheck.mockResolvedValue({ compatible: true, stats: { remoteEntries: 3 } });

    render(React.createElement(Settings));

    // First save
    await act(async () => {
      await saveSettings(VALID_URL, VALID_API_KEY);
    });

    await waitFor(() => {
      expect(screen.getByText('✅ Genesis compatible')).toBeInTheDocument();
    });

    // Second save with same URL (should not re-check, status stays)
    mockGenesisCheck.mockClear();
    localStorageStore.set('phpoc_worker_url', VALID_URL);
    localStorageStore.set('phpoc_api_key', VALID_API_KEY);

    const saveBtn = screen.getByRole('button', { name: /save/i });
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    // Genesis check should NOT have been called again (unchanged URL)
    expect(mockGenesisCheck).not.toHaveBeenCalled();
    // Status should still be visible
    expect(screen.getByText('✅ Genesis compatible')).toBeInTheDocument();
  });

  it('B1.3: Compatible status shows stats text', async () => {
    const chain = buildChain(MASTER_KEY);
    const services = createMockServices({ masterKey: MASTER_KEY, ledgerBlocks: chain });
    setUseAppReturn({ services });
    mockCreateTransport.mockReturnValue({});
    mockGenesisCheck.mockResolvedValue({ compatible: true, stats: { remoteEntries: 42 } });

    render(React.createElement(Settings));

    await act(async () => {
      await saveSettings(VALID_URL, VALID_API_KEY);
    });

    await waitFor(() => {
      expect(screen.getByText(/Remote has 42 committed entries/)).toBeInTheDocument();
    });
    expect(screen.getByText(/Ready to sync/)).toBeInTheDocument();
  });
});

describe('B2 — Save: Incompatible Genesis', () => {
  beforeEach(() => {
    localStorageStore.clear();
    mockGenesisCheck.mockReset();
    mockCreateTransport.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
  });

  it('B2.1: Incompatible status renders red badge', async () => {
    const chain = buildChain(MASTER_KEY);
    const services = createMockServices({ masterKey: MASTER_KEY, ledgerBlocks: chain });
    setUseAppReturn({ services });
    mockCreateTransport.mockReturnValue({});
    mockGenesisCheck.mockResolvedValue({ compatible: false, reason: 'genesis_mismatch' });

    render(React.createElement(Settings));

    await act(async () => {
      await saveSettings(VALID_URL, VALID_API_KEY);
    });

    await waitFor(() => {
      expect(screen.getByText('⚠️ Genesis incompatible')).toBeInTheDocument();
    });
  });

  it('B2.2: Incompatible status shows reason', async () => {
    const chain = buildChain(MASTER_KEY);
    const services = createMockServices({ masterKey: MASTER_KEY, ledgerBlocks: chain });
    setUseAppReturn({ services });
    mockCreateTransport.mockReturnValue({});
    mockGenesisCheck.mockResolvedValue({ compatible: false, reason: 'genesis_mismatch' });

    render(React.createElement(Settings));

    await act(async () => {
      await saveSettings(VALID_URL, VALID_API_KEY);
    });

    await waitFor(() => {
      expect(screen.getByText(/Reason: genesis_mismatch/)).toBeInTheDocument();
    });
  });

  it('B2.3: auth_failure shows offline orange card, not incompatible red', async () => {
    const chain = buildChain(MASTER_KEY);
    const services = createMockServices({ masterKey: MASTER_KEY, ledgerBlocks: chain });
    setUseAppReturn({ services });
    mockCreateTransport.mockReturnValue({});
    mockGenesisCheck.mockResolvedValue({ compatible: false, reason: 'auth_failure' });

    render(React.createElement(Settings));

    await act(async () => {
      await saveSettings(VALID_URL, VALID_API_KEY);
    });

    await waitFor(() => {
      // Auth failure routes to offline (orange card), not incompatible (red card)
      expect(screen.getByText('🔌 Cannot reach remote')).toBeInTheDocument();
      expect(screen.getByText('Authentication failed. Check your API key.')).toBeInTheDocument();
      // Must NOT show the incompatible red card
      expect(screen.queryByText('⚠️ Genesis incompatible')).not.toBeInTheDocument();
    });
  });
});

describe('B3 — Save: Network Error', () => {
  beforeEach(() => {
    localStorageStore.clear();
    mockGenesisCheck.mockReset();
    mockCreateTransport.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
  });

  it('B3.1: Offline status renders orange badge', async () => {
    const chain = buildChain(MASTER_KEY);
    const services = createMockServices({ masterKey: MASTER_KEY, ledgerBlocks: chain });
    setUseAppReturn({ services });
    // GenesisGate.check throws → caught as offline
    mockCreateTransport.mockReturnValue({});
    mockGenesisCheck.mockRejectedValue(new Error('Network failure'));

    render(React.createElement(Settings));

    await act(async () => {
      await saveSettings(VALID_URL, VALID_API_KEY);
    });

    await waitFor(() => {
      expect(screen.getByText('🔌 Cannot reach remote')).toBeInTheDocument();
    });
  });

  it('B3.2: Offline status shows error message', async () => {
    const chain = buildChain(MASTER_KEY);
    const services = createMockServices({ masterKey: MASTER_KEY, ledgerBlocks: chain });
    setUseAppReturn({ services });
    mockCreateTransport.mockReturnValue({});
    mockGenesisCheck.mockRejectedValue(new Error('Connection refused'));

    render(React.createElement(Settings));

    await act(async () => {
      await saveSettings(VALID_URL, VALID_API_KEY);
    });

    await waitFor(() => {
      expect(screen.getByText('🔌 Cannot reach remote')).toBeInTheDocument();
      expect(screen.getByText('Connection refused')).toBeInTheDocument();
    });
  });
});

describe('B4 — Save: Error State', () => {
  beforeEach(() => {
    localStorageStore.clear();
    mockGenesisCheck.mockReset();
    mockCreateTransport.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
  });

  it('B4.1: Error status renders red badge with reason', async () => {
    const chain = buildChain(MASTER_KEY);
    const services = createMockServices({ masterKey: MASTER_KEY, ledgerBlocks: chain });
    setUseAppReturn({ services });
    // null transport → error branch
    mockCreateTransport.mockReturnValue(null);

    render(React.createElement(Settings));

    // Fill form and submit — handleSaveRemote is async so we wait for the UI update
    const urlInput = screen.getByLabelText('Worker URL');
    const apiKeyInput = screen.getByLabelText('API Key');
    const saveBtn = screen.getByRole('button', { name: /save/i });

    await act(async () => {
      fireEvent.change(urlInput, { target: { value: 'https://bad-url.workers.dev' } });
      fireEvent.change(apiKeyInput, { target: { value: VALID_API_KEY } });
      fireEvent.click(saveBtn);
    });

    // After the dynamic import resolves (mocked synchronously), the error
    // status should render. Use waitFor to allow microtask flush.
    await waitFor(() => {
      expect(screen.getByText('❌ Error')).toBeInTheDocument();
    });
    expect(screen.getByText('Invalid Worker URL')).toBeInTheDocument();
  });
});

describe('B5 — Status Transitions', () => {
  beforeEach(() => {
    localStorageStore.clear();
    mockGenesisCheck.mockReset();
    mockCreateTransport.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
  });

  it('B5.1: Checking → compatible transition', async () => {
    const chain = buildChain(MASTER_KEY);
    const services = createMockServices({ masterKey: MASTER_KEY, ledgerBlocks: chain });
    setUseAppReturn({ services });
    mockCreateTransport.mockReturnValue({});

    // Delay the genesis check so we can observe "checking" state
    let resolveCheck;
    mockGenesisCheck.mockImplementation(() =>
      new Promise((resolve) => { resolveCheck = resolve; })
    );

    render(React.createElement(Settings));

    // Submit without act wrapping to allow state updates
    const urlInput = screen.getByLabelText('Worker URL');
    const apiKeyInput = screen.getByLabelText('API Key');
    const saveBtn = screen.getByRole('button', { name: /save/i });

    await act(async () => {
      fireEvent.change(urlInput, { target: { value: VALID_URL } });
      fireEvent.change(apiKeyInput, { target: { value: VALID_API_KEY } });
      fireEvent.click(saveBtn);
    });

    // Should show checking state
    expect(screen.getByText('⏳ Checking genesis compatibility…')).toBeInTheDocument();

    // Resolve the check
    await act(async () => {
      resolveCheck({ compatible: true, stats: { remoteEntries: 10 } });
    });

    // Should transition to compatible
    await waitFor(() => {
      expect(screen.getByText('✅ Genesis compatible')).toBeInTheDocument();
    });
    expect(screen.queryByText('⏳ Checking genesis compatibility…')).not.toBeInTheDocument();
  });

  it('B5.2: Checking → incompatible transition', async () => {
    const chain = buildChain(MASTER_KEY);
    const services = createMockServices({ masterKey: MASTER_KEY, ledgerBlocks: chain });
    setUseAppReturn({ services });
    mockCreateTransport.mockReturnValue({});

    let resolveCheck;
    mockGenesisCheck.mockImplementation(() =>
      new Promise((resolve) => { resolveCheck = resolve; })
    );

    render(React.createElement(Settings));

    const urlInput = screen.getByLabelText('Worker URL');
    const apiKeyInput = screen.getByLabelText('API Key');
    const saveBtn = screen.getByRole('button', { name: /save/i });

    await act(async () => {
      fireEvent.change(urlInput, { target: { value: VALID_URL } });
      fireEvent.change(apiKeyInput, { target: { value: VALID_API_KEY } });
      fireEvent.click(saveBtn);
    });

    expect(screen.getByText('⏳ Checking genesis compatibility…')).toBeInTheDocument();

    await act(async () => {
      resolveCheck({ compatible: false, reason: 'genesis_mismatch' });
    });

    await waitFor(() => {
      expect(screen.getByText('⚠️ Genesis incompatible')).toBeInTheDocument();
    });
    expect(screen.queryByText('⏳ Checking genesis compatibility…')).not.toBeInTheDocument();
  });

  it('B5.3: Clear URL → status disappears', async () => {
    const chain = buildChain(MASTER_KEY);
    const services = createMockServices({ masterKey: MASTER_KEY, ledgerBlocks: chain });
    setUseAppReturn({ services });
    mockCreateTransport.mockReturnValue({});
    mockGenesisCheck.mockResolvedValue({ compatible: true, stats: { remoteEntries: 5 } });

    render(React.createElement(Settings));

    // First save with URL to get compatible status
    await act(async () => {
      await saveSettings(VALID_URL, VALID_API_KEY);
    });

    await waitFor(() => {
      expect(screen.getByText('✅ Genesis compatible')).toBeInTheDocument();
    });

    // Clear URL and save
    await act(async () => {
      await saveSettings('', '');
    });

    // Status card should be gone
    await waitFor(() => {
      expect(screen.queryByText('✅ Genesis compatible')).not.toBeInTheDocument();
      expect(screen.queryByText('⚠️ Genesis incompatible')).not.toBeInTheDocument();
      expect(screen.queryByText('🔌 Cannot reach remote')).not.toBeInTheDocument();
      expect(screen.queryByText('❌ Error')).not.toBeInTheDocument();
      expect(screen.queryByText('⏳ Checking genesis compatibility…')).not.toBeInTheDocument();
    });
  });

  it('B5.4: Compatible → idle on clear URL', async () => {
    const chain = buildChain(MASTER_KEY);
    const services = createMockServices({ masterKey: MASTER_KEY, ledgerBlocks: chain });
    setUseAppReturn({ services });
    mockCreateTransport.mockReturnValue({});
    mockGenesisCheck.mockResolvedValue({ compatible: true, stats: { remoteEntries: 5 } });

    render(React.createElement(Settings));

    await act(async () => {
      await saveSettings(VALID_URL, VALID_API_KEY);
    });
    await waitFor(() => {
      expect(screen.getByText('✅ Genesis compatible')).toBeInTheDocument();
    });

    // Clear URL
    await act(async () => {
      await saveSettings('', '');
    });

    // No status card rendered (idle state)
    expect(screen.queryByText('✅ Genesis compatible')).not.toBeInTheDocument();
  });

  it('B5.5: Incompatible → idle on clear URL', async () => {
    const chain = buildChain(MASTER_KEY);
    const services = createMockServices({ masterKey: MASTER_KEY, ledgerBlocks: chain });
    setUseAppReturn({ services });
    mockCreateTransport.mockReturnValue({});
    mockGenesisCheck.mockResolvedValue({ compatible: false, reason: 'genesis_mismatch' });

    render(React.createElement(Settings));

    await act(async () => {
      await saveSettings(VALID_URL, VALID_API_KEY);
    });
    await waitFor(() => {
      expect(screen.getByText('⚠️ Genesis incompatible')).toBeInTheDocument();
    });

    // Clear URL
    await act(async () => {
      await saveSettings('', '');
    });

    expect(screen.queryByText('⚠️ Genesis incompatible')).not.toBeInTheDocument();
  });
});

describe('B6 — Save Button Feedback', () => {
  beforeEach(() => {
    localStorageStore.clear();
    mockGenesisCheck.mockReset();
    mockCreateTransport.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
  });

  it('B6.1: Save button shows "✓ Saved" after submit', async () => {
    // No ledger → skips genesis check, just saves
    const services = createMockServices({ ledgerBlocks: [], masterKey: null });
    setUseAppReturn({ services });

    render(React.createElement(Settings));

    await act(async () => {
      await saveSettings(VALID_URL, VALID_API_KEY);
    });

    // Button should show saved state
    expect(screen.getByText('✓ Saved')).toBeInTheDocument();
  });

  it('B6.2: "✓ Saved" reverts after timeout (2 seconds)', async () => {
    vi.useFakeTimers();
    const services = createMockServices({ ledgerBlocks: [], masterKey: null });
    setUseAppReturn({ services });

    render(React.createElement(Settings));

    await act(async () => {
      await saveSettings(VALID_URL, VALID_API_KEY);
    });

    expect(screen.getByText('✓ Saved')).toBeInTheDocument();

    // Advance past the 2-second timeout
    await act(async () => {
      vi.advanceTimersByTime(2500);
    });

    expect(screen.queryByText('✓ Saved')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();

    vi.useRealTimers();
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  CATEGORY E: Edge Cases & Regressions (6 tests)
// ═══════════════════════════════════════════════════════════════════════

describe('E — Edge Cases & Regressions', () => {
  beforeEach(() => {
    localStorageStore.clear();
    mockGenesisCheck.mockReset();
    mockCreateTransport.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
  });

  it('E1: Double-save with same data — no duplicate check', async () => {
    const chain = buildChain(MASTER_KEY);
    const services = createMockServices({ masterKey: MASTER_KEY, ledgerBlocks: chain });
    setUseAppReturn({ services });
    mockCreateTransport.mockReturnValue({});
    mockGenesisCheck.mockResolvedValue({ compatible: true, stats: { remoteEntries: 3 } });

    render(React.createElement(Settings));

    // First save
    await act(async () => {
      await saveSettings(VALID_URL, VALID_API_KEY);
    });
    await waitFor(() => {
      expect(screen.getByText('✅ Genesis compatible')).toBeInTheDocument();
    });

    const callCount = mockGenesisCheck.mock.calls.length;

    // Second save with identical data
    const saveBtn = screen.getByRole('button', { name: /save/i });
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    // Genesis check should NOT have been called again
    expect(mockGenesisCheck.mock.calls.length).toBe(callCount);
    // Status should still be visible
    expect(screen.getByText('✅ Genesis compatible')).toBeInTheDocument();
  });

  it('E2: Rapid URL changes — only last check result renders', async () => {
    const chain = buildChain(MASTER_KEY);
    const services = createMockServices({ masterKey: MASTER_KEY, ledgerBlocks: chain });
    setUseAppReturn({ services });
    mockCreateTransport.mockReturnValue({});

    // First URL: incompatible
    // Second URL: compatible
    let resolveFirst, resolveSecond;
    mockGenesisCheck
      .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }))
      .mockImplementationOnce(() => new Promise((r) => { resolveSecond = r; }));

    render(React.createElement(Settings));

    const urlInput = screen.getByLabelText('Worker URL');
    const apiKeyInput = screen.getByLabelText('API Key');
    const saveBtn = screen.getByRole('button', { name: /save/i });

    // First save
    await act(async () => {
      fireEvent.change(urlInput, { target: { value: 'https://first.workers.dev' } });
      fireEvent.change(apiKeyInput, { target: { value: 'key1' } });
      fireEvent.click(saveBtn);
    });

    // Change URL and save again (before first resolves)
    await act(async () => {
      fireEvent.change(urlInput, { target: { value: 'https://second.workers.dev' } });
      fireEvent.change(apiKeyInput, { target: { value: 'key2' } });
      fireEvent.click(saveBtn);
    });

    // Resolve both — second should be the one that renders
    await act(async () => {
      resolveFirst({ compatible: false, reason: 'genesis_mismatch' });
      resolveSecond({ compatible: true, stats: { remoteEntries: 7 } });
    });

    await waitFor(() => {
      expect(screen.getByText('✅ Genesis compatible')).toBeInTheDocument();
    });
  });

  it('E3: Genesis check in-flight dedup — only one network call', async () => {
    const chain = buildChain(MASTER_KEY);
    const services = createMockServices({ masterKey: MASTER_KEY, ledgerBlocks: chain });
    setUseAppReturn({ services });
    mockCreateTransport.mockReturnValue({});

    let resolveCheck;
    mockGenesisCheck.mockImplementation(
      () => new Promise((resolve) => { resolveCheck = resolve; })
    );

    render(React.createElement(Settings));

    const saveBtn = screen.getByRole('button', { name: /save/i });

    // Rapid double-save
    await act(async () => {
      const urlInput = screen.getByLabelText('Worker URL');
      fireEvent.change(urlInput, { target: { value: VALID_URL } });
      fireEvent.click(saveBtn);
      fireEvent.click(saveBtn);
    });

    // Only one genesis check should have been initiated
    expect(mockGenesisCheck.mock.calls.length).toBe(1);

    // Resolve it
    await act(async () => {
      resolveCheck({ compatible: true, stats: { remoteEntries: 2 } });
    });

    await waitFor(() => {
      expect(screen.getByText('✅ Genesis compatible')).toBeInTheDocument();
    });
  });

  it('E4: Save with empty API key — still runs genesis check', async () => {
    const chain = buildChain(MASTER_KEY);
    const services = createMockServices({ masterKey: MASTER_KEY, ledgerBlocks: chain });
    setUseAppReturn({ services });
    mockCreateTransport.mockReturnValue({});
    mockGenesisCheck.mockResolvedValue({ compatible: true, stats: { remoteEntries: 0 } });

    render(React.createElement(Settings));

    // Save with URL but empty API key
    await act(async () => {
      await saveSettings(VALID_URL, '');
    });

    await waitFor(() => {
      expect(mockGenesisCheck).toHaveBeenCalledTimes(1);
      expect(screen.getByText('✅ Genesis compatible')).toBeInTheDocument();
    });
  });

  it('E5: GenesisGate throws unexpected error → offline with message', async () => {
    const chain = buildChain(MASTER_KEY);
    const services = createMockServices({ masterKey: MASTER_KEY, ledgerBlocks: chain });
    setUseAppReturn({ services });
    mockCreateTransport.mockReturnValue({});
    mockGenesisCheck.mockRejectedValue(new Error('Internal crypto error: invalid curve'));

    render(React.createElement(Settings));

    await act(async () => {
      await saveSettings(VALID_URL, VALID_API_KEY);
    });

    await waitFor(() => {
      expect(screen.getByText('🔌 Cannot reach remote')).toBeInTheDocument();
      expect(screen.getByText('Internal crypto error: invalid curve')).toBeInTheDocument();
    });
  });

  it('E6: localStorage persist works after save', async () => {
    const services = createMockServices({ ledgerBlocks: [], masterKey: null });
    setUseAppReturn({ services });

    render(React.createElement(Settings));

    await act(async () => {
      await saveSettings(VALID_URL, VALID_API_KEY);
    });

    expect(localStorageMock.setItem).toHaveBeenCalledWith('phpoc_worker_url', VALID_URL);
    expect(localStorageMock.setItem).toHaveBeenCalledWith('phpoc_api_key', VALID_API_KEY);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  CATEGORY F: Accessibility & A11Y (4 tests)
// ═══════════════════════════════════════════════════════════════════════

describe('F — Accessibility & A11Y', () => {
  beforeEach(() => {
    localStorageStore.clear();
    mockGenesisCheck.mockReset();
    mockCreateTransport.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
  });

  it('F1: Checking hint has aria-live="polite"', async () => {
    const chain = buildChain(MASTER_KEY);
    const services = createMockServices({ masterKey: MASTER_KEY, ledgerBlocks: chain });
    setUseAppReturn({ services });
    mockCreateTransport.mockReturnValue({});

    // Delay genesis check so we can observe checking state
    let resolveCheck;
    mockGenesisCheck.mockImplementation(
      () => new Promise((resolve) => { resolveCheck = resolve; })
    );

    render(React.createElement(Settings));

    const urlInput = screen.getByLabelText('Worker URL');
    const apiKeyInput = screen.getByLabelText('API Key');
    const saveBtn = screen.getByRole('button', { name: /save/i });

    await act(async () => {
      fireEvent.change(urlInput, { target: { value: VALID_URL } });
      fireEvent.change(apiKeyInput, { target: { value: VALID_API_KEY } });
      fireEvent.click(saveBtn);
    });

    // The checking text element must have aria-live="polite" for screen readers
    const checkingEl = screen.getByText('⏳ Checking genesis compatibility…');
    expect(checkingEl).toHaveAttribute('aria-live', 'polite');

    await act(async () => {
      resolveCheck({ compatible: true, stats: { remoteEntries: 3 } });
    });
  });

  it('F2: Compatible status is perceivable by color-blind users', async () => {
    const chain = buildChain(MASTER_KEY);
    const services = createMockServices({ masterKey: MASTER_KEY, ledgerBlocks: chain });
    setUseAppReturn({ services });
    mockCreateTransport.mockReturnValue({});
    mockGenesisCheck.mockResolvedValue({ compatible: true, stats: { remoteEntries: 5 } });

    render(React.createElement(Settings));

    await act(async () => {
      await saveSettings(VALID_URL, VALID_API_KEY);
    });

    await waitFor(() => {
      // Status must use text + icon, not color alone
      const statusCard = screen.getByText('✅ Genesis compatible').closest('div');
      expect(statusCard).toBeInTheDocument();
      // Card must have a border (structural differentiation, not just background color).
      // React inline styles produce a style attribute string; check it directly.
      const styleAttr = statusCard.getAttribute('style') || '';
      expect(styleAttr).toMatch(/border:\s*1px solid/);
    });
  });

  it('F3: Incompatible status is perceivable by color-blind users', async () => {
    const chain = buildChain(MASTER_KEY);
    const services = createMockServices({ masterKey: MASTER_KEY, ledgerBlocks: chain });
    setUseAppReturn({ services });
    mockCreateTransport.mockReturnValue({});
    mockGenesisCheck.mockResolvedValue({ compatible: false, reason: 'genesis_mismatch' });

    render(React.createElement(Settings));

    await act(async () => {
      await saveSettings(VALID_URL, VALID_API_KEY);
    });

    await waitFor(() => {
      // Status must use icon + text + border, not color alone
      const statusCard = screen.getByText('⚠️ Genesis incompatible').closest('div');
      expect(statusCard).toBeInTheDocument();
      const styleAttr = statusCard.getAttribute('style') || '';
      expect(styleAttr).toMatch(/border:\s*1px solid/);
      // Also must have a reason message
      expect(screen.getByText(/Reason: genesis_mismatch/)).toBeInTheDocument();
    });
  });

  it('F4: Status cards have role="status"', async () => {
    const chain = buildChain(MASTER_KEY);
    const services = createMockServices({ masterKey: MASTER_KEY, ledgerBlocks: chain });
    setUseAppReturn({ services });
    mockCreateTransport.mockReturnValue({});
    mockGenesisCheck.mockResolvedValue({ compatible: true, stats: { remoteEntries: 5 } });

    render(React.createElement(Settings));

    await act(async () => {
      await saveSettings(VALID_URL, VALID_API_KEY);
    });

    await waitFor(() => {
      // The genesis status container must have role="status" for ARIA live-region behavior
      const statusContainer = screen.getByText('✅ Genesis compatible').closest('.genesis-status');
      expect(statusContainer).toHaveAttribute('role', 'status');
    });
  });
});
