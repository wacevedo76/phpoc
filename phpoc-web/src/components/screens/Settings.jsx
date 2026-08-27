import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useApp } from '../../context/DevModeContext.jsx';
import { Icons } from '../ui/Icons.jsx';
import PassphraseModal from '../modals/PassphraseModal.jsx';

/**
 * Lightweight check: does IndexedDB hold existing ledger or staging data?
 * Returns { blocksCount, stagingCount } or null if IndexedDB unavailable.
 */
async function probeExistingData() {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open('phpoc-sync');
      req.onsuccess = (event) => {
        const db = event.target.result;
        try {
          const tx = db.transaction('keyval', 'readonly');
          const store = tx.objectStore('keyval');
          const blocksReq = store.get('ledger:blocks');
          const stagingReq = store.get('entries');
          let blocksCount = 0, stagingCount = 0;
          tx.oncomplete = () => resolve({ blocksCount, stagingCount });
          tx.onerror = () => resolve(null);
          blocksReq.onsuccess = () => {
            const v = blocksReq.result;
            blocksCount = Array.isArray(v) ? v.length : 0;
          };
          stagingReq.onsuccess = () => {
            const v = stagingReq.result;
            stagingCount = Array.isArray(v) ? v.length : 0;
          };
        } catch { resolve(null); }
      };
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

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
  const { mode, isDev, toggleMode, services, exportLedger: exportLedgerAction, importLedger: importLedgerAction, validateImport, confirmImport, exportLedgerFull: exportLedgerFullAction, rekey } = useApp();

  // Seed from localStorage — onboarding populates these before the user
  // ever reaches Settings, so the useState initializer always has fresh values.
  const [workerUrl, setWorkerUrl] = React.useState(
    () => localStorage.getItem('phpoc_worker_url') || ''
  );
  const [apiKey, setApiKey] = React.useState(
    () => localStorage.getItem('phpoc_api_key') || ''
  );
  const [justSaved, setJustSaved] = React.useState(false);

  // ── Genesis gate status ───────────────────────────────────────
  const [genesisStatus, setGenesisStatus] = useState('idle');
  // 'idle' | 'checking' | 'compatible' | 'incompatible' | 'offline' | 'error'
  const [genesisReason, setGenesisReason] = useState(null);
  const [genesisStats, setGenesisStats] = useState(null);

  // ── Import / Export state ─────────────────────────────────────
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportError, setExportError] = useState('');
  const [showImportModal, setShowImportModal] = useState(false);
  const [importFile, setImportFile] = useState(null);
  const [importSeed, setImportSeed] = useState('');
  const [importPassphrase, setImportPassphrase] = useState('');
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState(null);
  // ── Single-phase import with inline confirmation ─────────────
  const [importPhase, setImportPhase] = useState('form'); // 'form' | 'executing'
  const [keepStaging, setKeepStaging] = useState(true);
  const [confirmDestroy, setConfirmDestroy] = useState(false);
  const [existingInfo, setExistingInfo] = useState(null); // { blocksCount, stagingCount } | null
  const fileInputRef = useRef(null);

  // Probe existing data when import modal opens
  useEffect(() => {
    if (showImportModal) {
      setConfirmDestroy(false);
      setKeepStaging(true);
      probeExistingData().then(setExistingInfo);
    }
  }, [showImportModal]);

  const handleExport = useCallback(async (passphrase) => {
    setExportError('');
    try {
      await exportLedgerAction(passphrase);
      setShowExportModal(false);
    } catch (err) {
      setExportError(err.message || 'Export failed');
    }
  }, [exportLedgerAction]);

  const handleImportFileChange = useCallback((e) => {
    const file = e.target.files?.[0];
    if (file) {
      setImportFile(file);
      setImportError(null);
    }
  }, []);

  // ── Submit: validate + confirm in one flow ────────────────────
  const handleImportSubmit = useCallback(async (e) => {
    e?.preventDefault();
    if (!importFile || !importPassphrase.trim() || !importSeed.trim()) {
      setImportError('Please select a file and enter your passphrase and recovery seed.');
      return;
    }
    setImporting(true);
    setImportError(null);
    setImportPhase('executing');
    try {
      // Validate file first (read-only, throws on failure)
      await validateImport(importFile, importPassphrase.trim(), importSeed.trim());
      // Execute the destructive import
      await confirmImport({ keepStaging });
      handleResetImport();
    } catch (err) {
      setImportError(err.message);
      setImportPhase('form');
    }
    setImporting(false);
  }, [importFile, importPassphrase, importSeed, keepStaging, validateImport, confirmImport]);

  // ── Export current ledger before import ───────────────────────
  const handlePreImportExport = useCallback(async () => {
    try {
      await exportLedgerFullAction();
    } catch (err) {
      setImportError('Export failed: ' + err.message);
    }
  }, [exportLedgerFullAction]);

  const handleResetImport = useCallback(() => {
    setShowImportModal(false);
    setImportFile(null);
    setImportSeed('');
    setImportPassphrase('');
    setImportError(null);
    setImportPhase('form');
    setConfirmDestroy(false);
    setKeepStaging(true);
  }, []);

  const handleCancelImport = useCallback(() => {
    handleResetImport();
  }, [handleResetImport]);

  // ── Re-key (Security & Recovery) state ─────────────────────────
  const [showRekeyModal, setShowRekeyModal] = useState(false);
  const [rekeyOldPassphrase, setRekeyOldPassphrase] = useState('');
  const [rekeyNewPassphrase, setRekeyNewPassphrase] = useState('');
  const [rekeyAcknowledge, setRekeyAcknowledge] = useState(false);
  const [rekeySavedSeed, setRekeySavedSeed] = useState(false);
  const [rekeySeedConfirm, setRekeySeedConfirm] = useState('');
  const [rekeyNewSeed, setRekeyNewSeed] = useState('');
  const [rekeyError, setRekeyError] = useState('');
  const [rekeyBusy, setRekeyBusy] = useState(false);
  const [rekeyDone, setRekeyDone] = useState(false);

  // Open the re-key flow and mint the fresh seed up front (reveal-gate).
  const handleOpenRekey = useCallback(() => {
    setShowRekeyModal(true);
    setRekeyOldPassphrase('');
    setRekeyNewPassphrase('');
    setRekeyAcknowledge(false);
    setRekeySavedSeed(false);
    setRekeySeedConfirm('');
    setRekeyError('');
    setRekeyBusy(false);
    setRekeyDone(false);
    try {
      const crypto = services?.crypto;
      if (crypto && typeof crypto.generateSeed === 'function') {
        setRekeyNewSeed(crypto.generateSeed());
      } else {
        setRekeyNewSeed('');
        setRekeyError('Failed to generate a new recovery seed — crypto is not ready.');
      }
    } catch (err) {
      setRekeyNewSeed('');
      setRekeyError('Failed to generate a new recovery seed: ' + (err?.message || 'error'));
    }
  }, [services]);

  const handleCancelRekey = useCallback(() => {
    setShowRekeyModal(false);
  }, []);

  const handleConfirmRekey = useCallback(async () => {
    if (!rekey) {
      setRekeyError('Re-key is not available in this build.');
      return;
    }
    setRekeyBusy(true);
    setRekeyError('');
    try {
      await rekey({
        oldPassphrase: rekeyOldPassphrase,
        newPassphrase: rekeyNewPassphrase,
        newSeed: rekeyNewSeed,
      });
      setRekeyDone(true);
    } catch (err) {
      setRekeyError(err?.message || 'Re-key failed.');
    } finally {
      setRekeyBusy(false);
    }
  }, [rekey, rekeyOldPassphrase, rekeyNewPassphrase, rekeyNewSeed]);

  const genesisCheckSeq = useRef(0);

  const checkGenesis = async (url, apiKeyValue) => {
    const seq = ++genesisCheckSeq.current;
    setGenesisStatus('checking');
    setGenesisReason(null);
    setGenesisStats(null);

    try {
      const { GenesisGate, createRemoteTransport } = await import('@sync/index.js');
      const blocks = (await services.storage.get('ledger:blocks')) || [];
      const masterKey = services.crypto.getMasterKey();

      // A newer check superseded this one while awaiting — drop out.
      if (seq !== genesisCheckSeq.current) return;

      if (blocks.length === 0 || !masterKey) {
        // No local ledger or not authenticated — nothing to compare.
        setGenesisStatus('idle');
        return;
      }

      const transport = createRemoteTransport({
        deployment: 'saas',
        config: { baseUrl: url, apiKey: apiKeyValue },
      });

      if (!transport) {
        setGenesisStatus('error');
        setGenesisReason('Invalid Worker URL');
        return;
      }

      const result = await GenesisGate.check(
        blocks, transport, services.crypto, masterKey
      );

      // Stale result — a newer check already ran; ignore it.
      if (seq !== genesisCheckSeq.current) return;

      if (result.compatible) {
        setGenesisStatus('compatible');
        setGenesisStats(result.stats);
      } else if (result.reason === 'network_error' || result.reason === 'auth_failure') {
        // Transient errors — show as offline (orange), not incompatible (red).
        setGenesisStatus('offline');
        setGenesisReason(
          result.reason === 'auth_failure'
            ? 'Authentication failed. Check your API key.'
            : 'Network error'
        );
      } else {
        setGenesisStatus('incompatible');
        setGenesisReason(result.reason);
      }

      // Push new transport into SyncService so Sync Now uses it.
      services.sync?.reconfigure(transport);
    } catch (err) {
      if (seq !== genesisCheckSeq.current) return;
      setGenesisStatus('offline');
      setGenesisReason(err.message || 'Network error');
    }
  };

  const handleSaveRemote = async (e) => {
    e.preventDefault();
    const prevUrl = localStorage.getItem('phpoc_worker_url') || '';
    const prevApiKey = localStorage.getItem('phpoc_api_key') || '';

    // Clear URL: reset genesis status + disconnect transport
    if (!workerUrl.trim()) {
      localStorage.removeItem('phpoc_worker_url');
      localStorage.removeItem('phpoc_api_key');
      setWorkerUrl('');
      setApiKey('');
      setGenesisStatus('idle');
      setGenesisReason(null);
      setGenesisStats(null);
      setJustSaved(true);
      services.sync?.reconfigure(null);
      setTimeout(() => setJustSaved(false), 2000);
      return;
    }

    const urlChanged = workerUrl !== prevUrl;
    const apiKeyChanged = apiKey !== prevApiKey;

    // Persist config synchronously (before any await) so rapid re-saves
    // and re-submits observe the saved URL/key and skip redundant checks.
    localStorage.setItem('phpoc_worker_url', workerUrl);
    if (apiKey) localStorage.setItem('phpoc_api_key', apiKey);
    setJustSaved(true);
    setTimeout(() => setJustSaved(false), 2000);

    // Genesis check runs only when the URL or API key actually changed.
    if (!(urlChanged || apiKeyChanged)) return;
    if (!services.crypto || !services.sync || !services.storage) return;

    await checkGenesis(workerUrl, apiKey);
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
            <button
              type="submit"
              className="btn btn-primary btn-sm"
            >
              {justSaved ? '✓ Saved' : 'Check & Save'}
            </button>
          </form>

          {/* Genesis gate status indicator */}
          {genesisStatus !== 'idle' && (
            <div className={`genesis-status genesis-status-${genesisStatus}`} role="status" style={{ marginTop: '0.75rem' }}>
              {genesisStatus === 'checking' && (
                <p className="settings-hint" aria-live="polite" style={{ color: '#666' }}>
                  ⏳ Checking genesis compatibility…
                </p>
              )}
              {genesisStatus === 'compatible' && (
                <div style={{
                  background: '#e8f5e9',
                  border: '1px solid #4caf50',
                  borderRadius: '8px',
                  padding: '0.75rem',
                }}>
                  <p style={{ margin: 0, color: '#2e7d32', fontWeight: 600 }}>
                    ✅ Genesis compatible
                  </p>
                  {genesisStats && (
                    <p style={{ margin: '0.25rem 0 0', fontSize: '0.8rem', color: '#388e3c' }}>
                      Remote has {genesisStats.remoteEntries} committed entries. Ready to sync.
                    </p>
                  )}
                </div>
              )}
              {genesisStatus === 'incompatible' && (
                <div style={{
                  background: '#ffebee',
                  border: '1px solid #e53935',
                  borderRadius: '8px',
                  padding: '0.75rem',
                }}>
                  <p style={{ margin: 0, color: '#c62828', fontWeight: 600 }}>
                    ⚠️ Genesis incompatible
                  </p>
                  {genesisReason && (
                    <p style={{ margin: '0.25rem 0 0', fontSize: '0.8rem', color: '#b71c1c' }}>
                      Reason: {genesisReason}
                    </p>
                  )}
                </div>
              )}
              {genesisStatus === 'offline' && (
                <div style={{
                  background: '#fff3e0',
                  border: '1px solid #e67e22',
                  borderRadius: '8px',
                  padding: '0.75rem',
                }}>
                  <p style={{ margin: 0, color: '#e65100', fontWeight: 600 }}>
                    🔌 Cannot reach remote
                  </p>
                  {genesisReason && (
                    <p style={{ margin: '0.25rem 0 0', fontSize: '0.8rem', color: '#bf360c' }}>
                      {genesisReason}
                    </p>
                  )}
                </div>
              )}
              {genesisStatus === 'error' && (
                <div style={{
                  background: '#ffebee',
                  border: '1px solid #e53935',
                  borderRadius: '8px',
                  padding: '0.75rem',
                }}>
                  <p style={{ margin: 0, color: '#c62828', fontWeight: 600 }}>
                    ❌ Error
                  </p>
                  {genesisReason && (
                    <p style={{ margin: '0.25rem 0 0', fontSize: '0.8rem', color: '#b71c1c' }}>
                      {genesisReason}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
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
            <button className="btn btn-primary btn-sm" onClick={() => { setExportError(''); setShowExportModal(true); }}>
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

          {/* Import entries from another ledger */}
          <div className="settings-action-row" style={{ marginTop: '0.75rem' }}>
            <div className="settings-action-info">
              <strong>📋 Import entries from another ledger</strong>
              <p className="settings-hint">
                Import entries from a different ledger by providing its recovery seed.
                Entries are re-encrypted and appended to your current ledger.
              </p>
            </div>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => {
                // Navigate to /import — use the AppLayout's onNavigate
                // which is accessible via window.__navigate or direct location change.
                // For now, dispatch a custom event that AppLayout handles.
                window.dispatchEvent(new CustomEvent('navigate', { detail: 'import' }));
              }}
            >
              Import Entries
            </button>
          </div>
        </section>

        {/* Security & Recovery */}
        <section className="settings-section">
          <h3 className="settings-section-title">Security &amp; Recovery</h3>
          <div className="settings-action-row">
            <div className="settings-action-info">
              <strong>Recovery Seed Re-key</strong>
              <p className="settings-hint">
                Generate a fresh recovery seed and re-encrypt your ledger under a new master key.
                This is the only way to nullify a leaked seed.
              </p>
            </div>
            <button className="btn btn-warning btn-sm" onClick={handleOpenRekey}>
              Re-key to new Recovery Seed
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
            <div className="auth-overlay-card" style={{ maxWidth: '460px' }}>
              {/* ── Phase 1: Upload + Authenticate ──────────────── */}
              {importPhase === 'form' && (
                <>
                  <h2 className="auth-title" style={{ fontSize: '1.2rem', marginBottom: '0.5rem' }}>📥 Import Ledger</h2>
                  <p className="auth-subtitle">
                    Select an exported ledger file and authenticate.
                  </p>

                  {/* ── Destroy warning (only if existing data) ────── */}
                  {existingInfo && (existingInfo.blocksCount > 0 || existingInfo.stagingCount > 0) && (
                    <>
                      <div style={{
                        background: '#fff3e0',
                        border: '1px solid #e67e22',
                        borderRadius: '8px',
                        padding: '0.75rem',
                        marginBottom: '0.75rem',
                      }}>
                        <p style={{ margin: 0, fontSize: '0.9rem', color: '#e65100' }}>
                          <strong>⚠️ The ledger currently in use will be destroyed.</strong>
                        </p>
                        {existingInfo.blocksCount > 0 && (
                          <p style={{ margin: '0.25rem 0 0', fontSize: '0.8rem', color: '#bf360c' }}>
                            {existingInfo.blocksCount} committed block{existingInfo.blocksCount !== 1 ? 's' : ''} will be replaced.
                          </p>
                        )}
                        {existingInfo.stagingCount > 0 && (
                          <p style={{ margin: '0.25rem 0 0', fontSize: '0.8rem', color: '#bf360c' }}>
                            {existingInfo.stagingCount} uncommitted staging entr{existingInfo.stagingCount !== 1 ? 'ies' : 'y'} will be lost unless preserved below.
                          </p>
                        )}
                      </div>

                      {/* Export offer */}
                      <div style={{ marginBottom: '0.75rem' }}>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={handlePreImportExport}
                          style={{ width: '100%' }}
                        >
                          📤 Export current ledger before proceeding
                        </button>
                      </div>

                      {/* Required destroy acknowledgment */}
                      <div style={{
                        background: '#ffebee',
                        border: '1px solid #e53935',
                        borderRadius: '8px',
                        padding: '0.75rem',
                        marginBottom: '0.75rem',
                      }}>
                        <label style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: '0.5rem',
                          cursor: 'pointer',
                          fontSize: '0.9rem',
                          color: '#c62828',
                        }}>
                          <input
                            type="checkbox"
                            checked={confirmDestroy}
                            onChange={(e) => setConfirmDestroy(e.target.checked)}
                            style={{ marginTop: '0.15rem', flexShrink: 0 }}
                          />
                          <span>
                            <strong>I understand</strong> this will destroy my existing ledger and replace it with the imported file.
                          </span>
                        </label>
                      </div>

                      {/* Staging persistence option */}
                      {existingInfo.stagingCount > 0 && (
                        <div style={{
                          background: '#e8f5e9',
                          border: '1px solid #4caf50',
                          borderRadius: '8px',
                          padding: '0.75rem',
                          marginBottom: '0.75rem',
                        }}>
                          <label style={{
                            display: 'flex',
                            alignItems: 'flex-start',
                            gap: '0.5rem',
                            cursor: 'pointer',
                            fontSize: '0.9rem',
                            color: '#2e7d32',
                          }}>
                            <input
                              type="checkbox"
                              checked={keepStaging}
                              onChange={(e) => setKeepStaging(e.target.checked)}
                              style={{ marginTop: '0.15rem', flexShrink: 0 }}
                            />
                            <span>
                              Keep <strong>{existingInfo.stagingCount}</strong> uncommitted staging entr{existingInfo.stagingCount !== 1 ? 'ies' : 'y'} after import.
                            </span>
                          </label>
                        </div>
                      )}
                    </>
                  )}

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
                        className="btn btn-primary btn-sm"
                        style={{ flex: 1 }}
                        disabled={
                          importing ||
                          !importFile ||
                          !importPassphrase.trim() ||
                          !importSeed.trim() ||
                          (existingInfo && (existingInfo.blocksCount > 0 || existingInfo.stagingCount > 0) && !confirmDestroy)
                        }
                      >
                        {importing ? 'Validating...' : 'Import Ledger'}
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
                </>
              )}

              {/* ── Phase 2: Executing (spinner) ───────────────── */}
              {importPhase === 'executing' && (
                <div style={{ textAlign: 'center', padding: '2rem 0' }}>
                  <div className="loading-spinner" />
                  <p style={{ marginTop: '1rem', color: '#666' }}>Importing ledger...</p>
                </div>
              )}
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
            errorMessage={exportError}
          />
        )}

        {/* Re-key modal (Security & Recovery) */}
        {showRekeyModal && (
          <div className="auth-overlay" onClick={(e) => { if (e.target === e.currentTarget) handleCancelRekey(); }}>
            <div className="auth-overlay-card" style={{ maxWidth: '500px' }}>
              <h2 className="auth-title" style={{ fontSize: '1.2rem', marginBottom: '0.5rem' }}>
                🔄 Re-key Recovery Seed
              </h2>
              <p className="auth-subtitle">
                Generate a fresh recovery seed and re-encrypt your entire ledger under a new
                master key. The old seed will no longer decrypt anything.
              </p>

              {rekeyError && (
                <p className="auth-error-msg" role="alert">
                  {rekeyError}
                </p>
              )}

              <div className="form-group">
                <label className="auth-label" htmlFor="rekey-old-passphrase">Current Passphrase</label>
                <input
                  id="rekey-old-passphrase"
                  type="password"
                  className="auth-input"
                  value={rekeyOldPassphrase}
                  onChange={(e) => setRekeyOldPassphrase(e.target.value)}
                  disabled={rekeyBusy}
                />
              </div>

              <div className="form-group">
                <label className="auth-label" htmlFor="rekey-new-passphrase">New Passphrase</label>
                <input
                  id="rekey-new-passphrase"
                  type="password"
                  className="auth-input"
                  value={rekeyNewPassphrase}
                  onChange={(e) => setRekeyNewPassphrase(e.target.value)}
                  disabled={rekeyBusy}
                />
              </div>

              {rekeyNewSeed && (
                <div style={{
                  background: '#fff3e0',
                  border: '1px solid #e67e22',
                  borderRadius: '8px',
                  padding: '0.75rem',
                  marginBottom: '0.75rem',
                }}>
                  <p style={{ margin: 0, fontSize: '0.85rem', color: '#e65100' }}>
                    <strong>Save this new Recovery Seed now.</strong> It will be shown only once.
                  </p>
                  <code style={{ display: 'block', marginTop: '0.4rem', wordBreak: 'break-all' }}>
                    {rekeyNewSeed}
                  </code>
                </div>
              )}

              <label style={{
                display: 'flex', alignItems: 'flex-start', gap: '0.5rem',
                cursor: 'pointer', fontSize: '0.9rem', color: '#2e7d32', marginBottom: '0.75rem',
              }}>
                <input
                  type="checkbox"
                  checked={rekeySavedSeed}
                  onChange={(e) => setRekeySavedSeed(e.target.checked)}
                  disabled={rekeyBusy}
                  style={{ marginTop: '0.15rem', flexShrink: 0 }}
                />
                <span>I have saved my new Recovery Seed</span>
              </label>

              <div className="form-group">
                <label className="auth-label" htmlFor="rekey-seed-confirm">Type your new Recovery Seed to confirm</label>
                <input
                  id="rekey-seed-confirm"
                  type="text"
                  className="auth-input"
                  value={rekeySeedConfirm}
                  onChange={(e) => setRekeySeedConfirm(e.target.value)}
                  disabled={rekeyBusy}
                />
              </div>

              <label style={{
                display: 'flex', alignItems: 'flex-start', gap: '0.5rem',
                cursor: 'pointer', fontSize: '0.9rem', color: '#c62828', marginBottom: '0.75rem',
              }}>
                <input
                  type="checkbox"
                  checked={rekeyAcknowledge}
                  onChange={(e) => setRekeyAcknowledge(e.target.checked)}
                  disabled={rekeyBusy}
                  style={{ marginTop: '0.15rem', flexShrink: 0 }}
                />
                <span>Acknowledge</span>
              </label>

              {rekeyDone && (
                <div style={{
                  background: '#e8f5e9', border: '1px solid #4caf50', borderRadius: '8px',
                  padding: '0.75rem', marginBottom: '0.75rem',
                }}>
                  <p style={{ margin: 0, color: '#2e7d32', fontWeight: 600 }}>
                    ✅ Re-key complete. Keep your new Recovery Seed safe.
                  </p>
                </div>
              )}

              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  style={{ flex: 1 }}
                  onClick={handleConfirmRekey}
                  disabled={
                    rekeyBusy ||
                    !rekeyOldPassphrase.trim() ||
                    !rekeyAcknowledge ||
                    !rekeySavedSeed ||
                    rekeySeedConfirm !== rekeyNewSeed
                  }
                >
                  {rekeyBusy ? 'Re-keying…' : 'Re-key'}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  style={{ flex: 1 }}
                  onClick={handleCancelRekey}
                  disabled={rekeyBusy}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
