import React, { useState, useRef, useCallback } from 'react';
import { useApp } from '../../context/DevModeContext.jsx';
import { Icons } from '../ui/Icons.jsx';
import PassphraseModal from '../modals/PassphraseModal.jsx';

/**
 * Settings — app configuration screen.
 *
 * Options:
 *   - Dev mode toggle
 *   - Remote Worker URL (placeholder)
 *   - API Key (placeholder)
 *   - About / version info
 *   - Placeholder for Chain Verification (Phase 3)
 *   - Placeholder for Recovery (Phase 3)
 */
export default function Settings() {
  const { mode, isDev, toggleMode, services } = useApp();

  const [workerUrl, setWorkerUrl] = React.useState(
    () => localStorage.getItem('phpoc_worker_url') || ''
  );
  const [apiKey, setApiKey] = React.useState(
    () => localStorage.getItem('phpoc_api_key') || ''
  );
  const [saved, setSaved] = React.useState(false);

  // ── Import / Export state ─────────────────────────────────────
  const [showExportModal, setShowExportModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [importFile, setImportFile] = useState(null);
  const [importSeed, setImportSeed] = useState('');
  const [importPassphrase, setImportPassphrase] = useState('');
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState(null);
  const fileInputRef = useRef(null);

  const handleExport = useCallback(async (passphrase) => {
    try {
      await services.exportLedger(passphrase);
      setShowExportModal(false);
    } catch (err) {
      throw err; // PassphraseModal shows the error
    }
  }, [services]);

  const handleImportFileChange = useCallback((e) => {
    const file = e.target.files?.[0];
    if (file) {
      setImportFile(file);
      setImportError(null);
    }
  }, []);

  const handleImportSubmit = useCallback(async (e) => {
    e?.preventDefault();
    if (!importFile || !importPassphrase.trim() || !importSeed.trim()) {
      setImportError('Please select a file and enter your passphrase and recovery seed.');
      return;
    }
    setImporting(true);
    setImportError(null);
    try {
      await services.importLedger(importFile, importPassphrase.trim(), importSeed.trim());
      setShowImportModal(false);
      setImportFile(null);
      setImportSeed('');
      setImportPassphrase('');
    } catch (err) {
      setImportError(err.message);
      setImporting(false);
    }
  }, [importFile, importPassphrase, importSeed, services]);

  const handleCancelImport = useCallback(() => {
    setShowImportModal(false);
    setImportFile(null);
    setImportSeed('');
    setImportPassphrase('');
    setImportError(null);
  }, []);

  const handleSaveRemote = (e) => {
    e.preventDefault();
    if (workerUrl) localStorage.setItem('phpoc_worker_url', workerUrl);
    if (apiKey) localStorage.setItem('phpoc_api_key', apiKey);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="screen">
      <div className="screen-header">
        <h2 className="screen-title">Settings</h2>
      </div>

      <div className="settings-sections">
        {/* Dev Mode */}
        <section className="settings-section">
          <h3 className="settings-section-title">Developer Mode</h3>
          <div className="settings-toggle-row">
            <span>{isDev ? <><Icons.devMode size={16} /> Dev Mode (dummy data)</> : <><Icons.production size={16} /> Production Mode</>}</span>
            <button
              className={`btn btn-sm ${isDev ? 'btn-warning' : 'btn-secondary'}`}
              onClick={toggleMode}
            >
              Switch to {isDev ? 'Production' : 'Dev'}
            </button>
          </div>
          <p className="settings-hint">
            Dev mode uses in-memory dummy data and bypasses authentication.
            Refreshing the page resets all data.
          </p>
        </section>

        {/* Remote Configuration */}
        <section className="settings-section">
          <h3 className="settings-section-title">Remote Sync</h3>
          <form onSubmit={handleSaveRemote} className="settings-form">
            <div className="form-group">
              <label className="form-label" htmlFor="worker-url">Worker URL</label>
              <input
                id="worker-url"
                type="url"
                className="form-input"
                placeholder="https://your-worker.workers.dev"
                value={workerUrl}
                onChange={(e) => setWorkerUrl(e.target.value)}
              />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="api-key">API Key</label>
              <input
                id="api-key"
                type="password"
                className="form-input"
                placeholder="Shared API key"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </div>
            <button type="submit" className="btn btn-primary btn-sm">
              {saved ? '✓ Saved' : 'Save'}
            </button>
          </form>
        </section>

        {/* Data Management */}
        <section className="settings-section">
          <h3 className="settings-section-title">Data Management</h3>

          {/* Export */}
          <div className="settings-action-row">
            <div className="settings-action-info">
              <strong>📤 Export ledger</strong>
              <p className="settings-hint">
                Download your entries as a signed JSON file.
              </p>
            </div>
            <button className="btn btn-primary btn-sm" onClick={() => setShowExportModal(true)}>
              Export
            </button>
          </div>

          {/* Import */}
          <div className="settings-action-row" style={{ marginTop: '0.75rem' }}>
            <div className="settings-action-info">
              <strong>📥 Import ledger</strong>
              <p className="settings-hint">
                Replace all data with entries from an exported ledger file.
              </p>
            </div>
            <button className="btn btn-secondary btn-sm" onClick={() => setShowImportModal(true)}>
              Import
            </button>
          </div>
        </section>

        {/* Chain Verification (Phase 3 placeholder) */}
        <section className="settings-section settings-section-disabled">
          <h3 className="settings-section-title"><Icons.lock size={16} /> Chain Verification</h3>
          <p className="settings-hint">Verify ledger chain integrity. Available after ledger sync is implemented.</p>
          <button className="btn btn-secondary btn-sm" disabled>Verify Chain</button>
        </section>

        {/* Recovery (Phase 3 placeholder) */}
        <section className="settings-section settings-section-disabled">
          <h3 className="settings-section-title"><Icons.lock size={16} /> Recover from Seed</h3>
          <p className="settings-hint">Restore your ledger from a recovery seed. Available after ledger sync is implemented.</p>
          <button className="btn btn-secondary btn-sm" disabled>Recover</button>
        </section>

        {/* About */}
        <section className="settings-section">
          <h3 className="settings-section-title">About</h3>
          <div className="settings-about">
            <p><strong>PH Ledger</strong> — Zero-knowledge time tracking</p>
            <p>Version: 0.1.0 (Web Prototype)</p>
            <p>Crypto: phpoc-crypto-core (WASM) / Dummy (Dev Mode)</p>
            <p>Mode: <strong>{isDev ? <><Icons.devMode size={14} /> Dev</> : <><Icons.production size={14} /> Production</>}</strong></p>
          </div>
        </section>
        {/* Import inline form modal */}
        {showImportModal && (
          <div className="auth-overlay" onClick={(e) => { if (e.target === e.currentTarget) handleCancelImport(); }}>
            <div className="auth-overlay-card">
              <h2 className="auth-title" style={{ fontSize: '1.2rem', marginBottom: '0.5rem' }}>📥 Import Ledger</h2>
              <p className="auth-subtitle">
                Select an exported ledger file and authenticate.
              </p>
              <p className="auth-hint" style={{ marginBottom: '0.75rem', color: '#e67e22' }}>
                ⚠ This will replace all current data.
              </p>

              <form className="auth-form" onSubmit={handleImportSubmit}>
                <div className="form-group">
                  <label className="auth-label">Ledger File</label>
                  <input
                    type="file"
                    accept=".json"
                    onChange={handleImportFileChange}
                    ref={fileInputRef}
                    className="form-input"
                    style={{ padding: '0.4rem' }}
                    disabled={importing}
                  />
                  {importFile && (
                    <p style={{ fontSize: '0.8rem', color: '#666', marginTop: '0.25rem' }}>
                      Selected: {importFile.name}
                    </p>
                  )}
                </div>

                <div className="form-group">
                  <label htmlFor="settings-import-seed" className="auth-label">Recovery Seed</label>
                  <input
                    id="settings-import-seed"
                    type="text"
                    className="auth-input"
                    placeholder="Base64 recovery seed"
                    value={importSeed}
                    onChange={(e) => setImportSeed(e.target.value)}
                    disabled={importing}
                  />
                </div>

                <div className="form-group">
                  <label htmlFor="settings-import-passphrase" className="auth-label">Passphrase</label>
                  <input
                    id="settings-import-passphrase"
                    type="password"
                    className="auth-input"
                    placeholder="Enter your passphrase"
                    value={importPassphrase}
                    onChange={(e) => setImportPassphrase(e.target.value)}
                    disabled={importing}
                  />
                </div>

                {importError && <p className="auth-error-msg">{importError}</p>}

                <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                  <button
                    type="submit"
                    className="auth-btn"
                    style={{ flex: 1 }}
                    disabled={importing || !importFile || !importPassphrase.trim() || !importSeed.trim()}
                  >
                    {importing ? 'Importing...' : 'Import'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={handleCancelImport}
                    style={{ flex: 1 }}
                    disabled={importing}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Export passphrase modal */}
        {showExportModal && (
          <PassphraseModal
            title="📤 Export Ledger"
            description="Enter your passphrase to export your ledger data."
            onSubmit={handleExport}
            onCancel={() => setShowExportModal(false)}
          />
        )}
      </div>
    </div>
  );
}
