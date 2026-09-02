/**
 * CommonplaceSettingsScreen — settings surface for the Commonplace Book
 * (Commonplace Slice 4).
 *
 * Renders in Commonplace mode when `currentScreen === 'settings'` (see
 * BookBody). Mirrors the ledger Settings surface but scoped to the Commonplace
 * chain: Worker URL / API Key (shared localStorage), Verify, Push (stub),
 * Backup / Restore, Re-key (two-secret gate), and Clear All Data (both books).
 *
 * Dependencies are drawn from `useApp()` (rekey / wipeLedger / services) while
 * the Commonplace `service` is prop-injected — so it is testable against a
 * mock service. `useApp()` is read defensively (the routing/swap test renders
 * this screen outside a `<DevModeProvider>`), so a missing provider degrades
 * to no-op actions instead of throwing.
 */

import React, { useState, useRef } from 'react';
import { useApp } from '../../context/DevModeContext.jsx';
import RekeyModal from '../modals/RekeyModal.jsx';
import { useRekeyFlow } from '../../hooks/useRekeyFlow.js';

/**
 * Read the app context without throwing. The routing test renders this screen
 * outside a provider; in that case every context-derived action is a no-op.
 */
function useAppSafe() {
  try {
    return useApp();
  } catch {
    return null;
  }
}

export default function CommonplaceSettingsScreen({ service }) {
  const app = useAppSafe();
  const rekey = app?.rekey;
  const wipeLedger = app?.wipeLedger;
  const services = app?.services || {};

  // ── Worker config (shared localStorage with the ledger Settings) ──
  const [workerUrl, setWorkerUrl] = useState(
    () => localStorage.getItem('phpoc_worker_url') || ''
  );
  const [apiKey, setApiKey] = useState(
    () => localStorage.getItem('phpoc_api_key') || ''
  );
  const [justSaved, setJustSaved] = useState(false);

  // ── Verify ─────────────────────────────────────────────────────
  const [verifyResult, setVerifyResult] = useState(null); // 'valid'|'invalid'|'empty'
  const [verifying, setVerifying] = useState(false);

  // ── Push (stub) ────────────────────────────────────────────────
  const [pushMessage, setPushMessage] = useState(null);

  // ── Restore dialog ─────────────────────────────────────────────
  const [showRestoreDialog, setShowRestoreDialog] = useState(false);
  const [restoreFile, setRestoreFile] = useState(null);

  // ── Clear All Data dialog ──────────────────────────────────────
  const [showClearDialog, setShowClearDialog] = useState(false);

  // ── Re-key modal (shared `useRekeyFlow` hook) ───────────────
  const rekeyFlow = useRekeyFlow({
    rekey,
    generateSeed: services?.crypto?.generateSeed,
  });

  // ── Worker config ──────────────────────────────────────────────
  const handleSave = (e) => {
    e.preventDefault();
    if (workerUrl.trim()) {
      localStorage.setItem('phpoc_worker_url', workerUrl);
    } else {
      localStorage.removeItem('phpoc_worker_url');
    }
    if (apiKey) {
      localStorage.setItem('phpoc_api_key', apiKey);
    } else {
      localStorage.removeItem('phpoc_api_key');
    }
    setJustSaved(true);
  };

  // ── Verify ─────────────────────────────────────────────────────
  const handleVerify = async () => {
    setVerifying(true);
    try {
      const count = await service.getEntryCount();
      const ok = await service.verify();
      if (count === 0) {
        setVerifyResult('empty');
      } else if (ok) {
        setVerifyResult('valid');
      } else {
        setVerifyResult('invalid');
      }
    } catch {
      setVerifyResult('invalid');
    } finally {
      setVerifying(false);
    }
  };

  // ── Push (stub) ────────────────────────────────────────────────
  const handlePush = () => {
    setPushMessage('Push is not implemented yet — coming soon.');
  };

  // ── Backup / Restore ───────────────────────────────────────────
  const handleBackup = async () => {
    try {
      const json = await service.exportForBackup();
      // Best-effort client-side download (harmless where Blob/URL are absent).
      try {
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'commonplace-backup.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch {
        /* no-op */
      }
    } catch {
      /* no-op */
    }
  };

  const handleRestoreConfirm = async () => {
    let json = '';
    if (restoreFile) {
      try {
        json = await restoreFile.text();
      } catch {
        json = '';
      }
    }
    await service.restoreFromBackup(json);
    setShowRestoreDialog(false);
    setRestoreFile(null);
  };

  // ── Clear All Data ─────────────────────────────────────────────
  const handleClearConfirm = async () => {
    if (typeof wipeLedger === 'function') {
      await wipeLedger();
    }
    setShowClearDialog(false);
  };

  const fileInputRef = useRef(null);

  return (
    <div className="screen" data-testid="commonplace-settings-screen">
      <div className="screen-header">
        <h2 className="screen-title">Commonplace Settings</h2>
      </div>

      <div className="settings-sections">
        {/* Remote configuration (shared localStorage) */}
        <section className="settings-section">
          <h3 className="settings-section-title">Remote Sync</h3>
          <form onSubmit={handleSave} className="settings-form">
            <div className="form-group">
              <label className="form-label" htmlFor="cp-worker-url">Worker URL</label>
              <input
                id="cp-worker-url"
                data-testid="commonplace-worker-url"
                type="url"
                className="form-input"
                placeholder="Worker URL"
                value={workerUrl}
                onChange={(e) => setWorkerUrl(e.target.value)}
              />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="cp-api-key">API Key</label>
              <input
                id="cp-api-key"
                data-testid="commonplace-api-key"
                type="password"
                className="form-input"
                placeholder="Shared API key"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </div>
            <button type="submit" className="btn btn-primary btn-sm">
              {justSaved ? '✓ Saved' : 'Check & Save'}
            </button>
          </form>
        </section>

        {/* Integrity */}
        <section className="settings-section">
          <h3 className="settings-section-title">Integrity</h3>
          <div className="settings-action-row">
            <div className="settings-action-info">
              <strong>Chain integrity</strong>
              <p className="settings-hint">
                Check that every block seal, entry hash, and content hash in the
                Commonplace chain is valid.
              </p>
            </div>
            <button
              className="btn btn-secondary btn-sm"
              onClick={handleVerify}
              disabled={verifying}
            >
              Verify Commonplace
            </button>
          </div>
          {verifyResult && (
            <p className="settings-hint" aria-live="polite">
              {verifyResult === 'valid' && '✅ Chain verified — all blocks valid.'}
              {verifyResult === 'invalid' && '❌ Verification failed — chain is invalid or corrupt.'}
              {verifyResult === 'empty' && 'No entries — your Commonplace book is empty.'}
            </p>
          )}
        </section>

        {/* Cloud */}
        <section className="settings-section">
          <h3 className="settings-section-title">Cloud</h3>
          <div className="settings-action-row">
            <div className="settings-action-info">
              <strong>Cloud sync</strong>
              <p className="settings-hint">
                Upload your sealed Commonplace chain to the remote Worker.
              </p>
            </div>
            <button className="btn btn-secondary btn-sm" onClick={handlePush}>
              Push Commonplace to Cloud
            </button>
          </div>
          {pushMessage && <p className="settings-hint" aria-live="polite">{pushMessage}</p>}
        </section>

        {/* Backup & Restore */}
        <section className="settings-section">
          <h3 className="settings-section-title">Backup &amp; Restore</h3>
          <div className="settings-action-row">
            <div className="settings-action-info">
              <strong>Backup</strong>
              <p className="settings-hint">
                Download your sealed Commonplace chain as a JSON file.
              </p>
            </div>
            <button className="btn btn-primary btn-sm" onClick={handleBackup}>
              Backup Commonplace
            </button>
          </div>
          <div className="settings-action-row" style={{ marginTop: '0.75rem' }}>
            <div className="settings-action-info">
              <strong>Restore</strong>
              <p className="settings-hint">
                Replace your Commonplace book from a backup file.
              </p>
            </div>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setShowRestoreDialog(true)}
            >
              Restore Commonplace
            </button>
          </div>
        </section>

        {/* Security */}
        <section className="settings-section">
          <h3 className="settings-section-title">Security</h3>
          <div className="settings-action-row">
            <div className="settings-action-info">
              <strong>Recovery Seed Re-key</strong>
              <p className="settings-hint">
                Re-encrypt your Commonplace book under a fresh recovery seed.
              </p>
            </div>
            <button className="btn btn-warning btn-sm" onClick={rekeyFlow.open}>
              Re-key to new Recovery Seed
            </button>
          </div>
          <div className="settings-action-row" style={{ marginTop: '0.75rem' }}>
            <div className="settings-action-info">
              <strong>Delete all data</strong>
              <p className="settings-hint">
                Permanently delete your Commonplace book and activity ledger.
              </p>
            </div>
            <button
              className="btn btn-danger btn-sm"
              onClick={() => setShowClearDialog(true)}
            >
              Clear All Data
            </button>
          </div>
        </section>
      </div>

      {/* Restore confirm dialog */}
      {showRestoreDialog && (
        <div
          className="auth-overlay"
          onClick={(e) => { if (e.target === e.currentTarget) setShowRestoreDialog(false); }}
        >
          <div className="auth-overlay-card" style={{ maxWidth: '440px' }}>
            <h2 className="auth-title" style={{ fontSize: '1.2rem', marginBottom: '0.5rem' }}>
              Restore Commonplace
            </h2>
            <p className="auth-subtitle">
              ⚠️ This will replace your Commonplace book.
            </p>
            <div className="form-group">
              <label className="auth-label" htmlFor="cp-restore-file">Backup file</label>
              <input
                id="cp-restore-file"
                type="file"
                accept=".json,application/json"
                className="form-input"
                ref={fileInputRef}
                onChange={(e) => setRestoreFile(e.target.files?.[0] || null)}
              />
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                style={{ flex: 1 }}
                onClick={handleRestoreConfirm}
              >
                Confirm Restore
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                style={{ flex: 1 }}
                onClick={() => setShowRestoreDialog(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Clear All Data confirm dialog */}
      {showClearDialog && (
        <div
          className="auth-overlay"
          onClick={(e) => { if (e.target === e.currentTarget) setShowClearDialog(false); }}
        >
          <div className="auth-overlay-card" style={{ maxWidth: '440px' }}>
            <h2 className="auth-title" style={{ fontSize: '1.2rem', marginBottom: '0.5rem' }}>
              ⚠️ Clear All Data
            </h2>
            <p className="auth-subtitle">
              This will permanently delete your Commonplace book and activity ledger.
            </p>
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                style={{ flex: 1 }}
                onClick={handleClearConfirm}
              >
                Yes, clear everything
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                style={{ flex: 1 }}
                onClick={() => setShowClearDialog(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Re-key modal (two-secret gate) */}
      {rekeyFlow.show && (
        <RekeyModal
          idPrefix="cp"
          description="Generate a fresh recovery seed and re-encrypt your Commonplace book under a new master key. The old seed will no longer decrypt anything."
          error={rekeyFlow.error}
          done={rekeyFlow.done}
          busy={rekeyFlow.busy}
          oldPassphrase={rekeyFlow.oldPassphrase}
          newPassphrase={rekeyFlow.newPassphrase}
          newSeed={rekeyFlow.newSeed}
          savedSeed={rekeyFlow.savedSeed}
          acknowledge={rekeyFlow.acknowledge}
          seedConfirm={rekeyFlow.seedConfirm}
          onOldPassphraseChange={rekeyFlow.setOldPassphrase}
          onNewPassphraseChange={rekeyFlow.setNewPassphrase}
          onSavedSeedChange={rekeyFlow.setSavedSeed}
          onAcknowledgeChange={rekeyFlow.setAcknowledge}
          onSeedConfirmChange={rekeyFlow.setSeedConfirm}
          onConfirm={rekeyFlow.confirm}
          onCancel={rekeyFlow.cancel}
        />
      )}
    </div>
  );
}
