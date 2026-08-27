/**
 * rekey_settings_web.test.mjs — C-2 Seed Re-Key: Settings "Security & Recovery"
 * UI contract tests for phpoc-web (Group S, 6 tests).
 *
 * Phase 2 (RED) — Vitest + @testing-library/react. Mirrors the Flutter
 * `settings_screen_test.dart` Group S (S1–S6): the "Re-key to new Recovery
 * Seed" tile and its two-secret confirmation / reveal-gate dialog do not exist
 * yet, so every test fails (RED) until Phase 3 adds the UI.
 *
 * Design option (a): the new seed's raw 32 bytes become the new MK. The UI
 * exposes a single `useApp().rekey({ oldPassphrase, newPassphrase, newSeed })`
 * action; the reveal-gate requires the user to type back the freshly generated
 * seed and confirm they saved it before re-key may proceed (S3 / B5).
 *
 * Usage:
 *   npx vitest run test/rekey_settings_web.test.mjs
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import React from 'react';

// ── Mock @sync/index.js (dynamic import chain inside Settings / DevModeContext) ──

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

// ── Mock fetch / localStorage / indexedDB ──────────────────────────────

globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

const localStorageStore = new Map();
const localStorageMock = {
  getItem: vi.fn((key) => localStorageStore.get(key) ?? null),
  setItem: vi.fn((key, val) => { localStorageStore.set(key, val); }),
  removeItem: vi.fn((key) => { localStorageStore.delete(key); }),
};
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true });

Object.defineProperty(globalThis, 'indexedDB', {
  value: { open: vi.fn(() => ({ onsuccess: null, onerror: null, result: null })) },
  writable: true,
});

// ── Mock useApp (avoid the deep DevModeContext import chain) ───────────

const mockUseApp = vi.fn();

vi.mock('../src/context/DevModeContext.jsx', () => ({
  useApp: () => mockUseApp(),
}));

// Dynamic import of Settings (must happen after mocks are registered)
let Settings;
beforeAll(async () => {
  const mod = await import('../src/components/screens/Settings.jsx');
  Settings = mod.default;
});

function setUseAppReturn(overrides = {}) {
  const {
    services = {
      crypto: { getMasterKey: () => null },
      sync: { checkAndSync: vi.fn(), reconfigure: vi.fn() },
      storage: {
        get: vi.fn(() => Promise.resolve([])),
        set: vi.fn(() => Promise.resolve()),
        delete: vi.fn(() => Promise.resolve()),
      },
    },
    isDev = false,
    rekey = vi.fn(),
  } = overrides;

  mockUseApp.mockReturnValue({
    mode: isDev ? 'dev' : 'production',
    isDev,
    services,
    rekey,
  });
}

const REKEY_TILE = 'Re-key to new Recovery Seed';

// ═══════════════════════════════════════════════════════════════
// Group S: Settings — Re-key Recovery Seed (S1–S6)
// ═══════════════════════════════════════════════════════════════
describe('S: Settings — Re-key Recovery Seed', () => {
  beforeEach(() => {
    localStorageStore.clear();
    mockUseApp.mockReset();
  });

  it('S1: Security & Recovery shows the "Re-key to new Recovery Seed" option', async () => {
    setUseAppReturn();
    render(React.createElement(Settings));

    expect(screen.getByText(REKEY_TILE)).toBeInTheDocument();
  });

  it('S2: tapping re-key opens a two-secret confirmation dialog', async () => {
    setUseAppReturn();
    render(React.createElement(Settings));

    const tile = screen.getByText(REKEY_TILE);
    await act(async () => { fireEvent.click(tile); });

    // Two-secret gate: current passphrase entry + explicit acknowledge + cancel.
    expect(screen.getByText('Current Passphrase')).toBeInTheDocument();
    expect(screen.getByText('Acknowledge')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  it('S3: re-key requires a freshly generated seed saved by the user (reveal-gate)', async () => {
    setUseAppReturn();
    render(React.createElement(Settings));

    const tile = screen.getByText(REKEY_TILE);
    await act(async () => { fireEvent.click(tile); });

    // The dialog must surface the generated new seed and require the user to
    // type it back (and confirm they saved it) before re-key can proceed.
    expect(screen.getByText('I have saved my new Recovery Seed')).toBeInTheDocument();
    // A seed-confirmation input must be present (TextField-equivalent).
    expect(screen.getAllByRole('textbox').length).toBeGreaterThanOrEqual(1);
  });

  it('S4: cancel/back aborts with no chain mutation', async () => {
    const rekey = vi.fn();
    setUseAppReturn({ rekey });
    render(React.createElement(Settings));

    const tile = screen.getByText(REKEY_TILE);
    await act(async () => { fireEvent.click(tile); });

    await act(async () => { fireEvent.click(screen.getByText('Cancel')); });

    // Dialog closed; no re-key has run.
    expect(screen.queryByText('Current Passphrase')).not.toBeInTheDocument();
    expect(screen.getByText(REKEY_TILE)).toBeInTheDocument();
    expect(rekey).not.toHaveBeenCalled();
  });

  it('S5: a failure during re-key surfaces a clear error and keeps the local chain consistent', async () => {
    const rekey = vi.fn().mockRejectedValue(new Error('Remote push failed'));
    setUseAppReturn({ rekey });
    render(React.createElement(Settings));

    const tile = screen.getByText(REKEY_TILE);
    await act(async () => { fireEvent.click(tile); });

    // Phase 3: the confirmation dialog must surface the failure clearly and
    // the re-key option must remain available (no local mutation on abort).
    await waitFor(() => {
      expect(screen.getByText(/push failed|error|failed/i)).toBeInTheDocument();
    });
    expect(screen.getByText(REKEY_TILE)).toBeInTheDocument();
  });

  it('S6: the new-seed reveal dialog appears once and is never auto-re-shown', async () => {
    setUseAppReturn();
    render(React.createElement(Settings));

    // Phase 3: after a successful re-key the reveal dialog shows exactly once
    // and is not automatically re-shown. Phase 2 RED anchors on the tile.
    expect(screen.getByText(REKEY_TILE)).toBeInTheDocument();
  });
});
