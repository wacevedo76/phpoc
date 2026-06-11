import React, { useState, useRef, useEffect } from 'react';

/**
 * OnboardingScreen — first-time setup or fresh-start flow.
 *
 * Presents three options:
 *   1. Import a ledger (file picker → passphrase → verify → load)
 *   2. Begin a new ledger (passphrase confirmation → generate seed → create)
 *   3. Export current ledger (passphrase auth → download) — only if data exists
 *
 * Props:
 *   hasExistingData   — Whether IndexedDB has existing ledger data
 *   onImport(file, passphrase, seed)    — Import a ledger file with auth
 *   onNewLedger(passphrase)             — Create a brand new ledger
 *   onExport(passphrase)                — Export current ledger (auth-gated)
 *   onBack()                             — Return to landing screen
 *   error                                — Error message from parent
 */
export default function OnboardingScreen({
  hasExistingData,
  onImport,
  onNewLedger,
  onExport,
  onBack,
  error,
}) {
  // ── Phase tracking ──────────────────────────────────────────────
  // 'menu' | 'import' | 'new-ledger' | 'export'
  const [phase, setPhase] = useState('menu');
  const fileInputRef = useRef(null);

  // ── Shared error display ────────────────────────────────────────
  const [localError, setLocalError] = useState('');
  const displayError = error || localError;

  // Reset local error when switching phases
  useEffect(() => {
    setLocalError('');
  }, [phase]);

  // ── Phase: Import ───────────────────────────────────────────────
  const [importFile, setImportFile] = useState(null);
  const [importPassphrase, setImportPassphrase] = useState('');
  const [importSeed, setImportSeed] = useState('');
  const [importing, setImporting] = useState(false);

  const handleFileSelected = (e) => {
    const file = e.target.files?.[0];
    if (file) setImportFile(file);
  };

  const handleImportSubmit = async (e) => {
    e.preventDefault();
    if (!importFile || !importPassphrase.trim() || !importSeed.trim()) {
      setLocalError('Please select a file and enter your passphrase and recovery seed.');
      return;
    }
    setImporting(true);
    setLocalError('');
    try {
      await onImport(importFile, importPassphrase.trim(), importSeed.trim());
    } catch (err) {
      setLocalError(err.message);
      setImporting(false);
    }
  };

  // ── Phase: New Ledger ──────────────────────────────────────────
  const [newUsername, setNewUsername] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPassphrase, setNewPassphrase] = useState('');
  const [newPassphraseConfirm, setNewPassphraseConfirm] = useState('');
  const [creating, setCreating] = useState(false);

  const handleNewLedgerSubmit = async (e) => {
    e.preventDefault();
    if (!newUsername.trim()) {
      setLocalError('Please enter a username.');
      return;
    }
    if (!newPassphrase.trim()) {
      setLocalError('Passphrase cannot be empty.');
      return;
    }
    if (newPassphrase !== newPassphraseConfirm) {
      setLocalError('Passphrases do not match.');
      return;
    }
    setCreating(true);
    setLocalError('');
    try {
      await onNewLedger(newPassphrase.trim(), newUsername.trim(), newEmail.trim());
    } catch (err) {
      setLocalError(err.message);
      setCreating(false);
    }
  };

  // ── Phase: Export ───────────────────────────────────────────────
  const [exportPassphrase, setExportPassphrase] = useState('');
  const [exporting, setExporting] = useState(false);

  const handleExportSubmit = async (e) => {
    e.preventDefault();
    if (!exportPassphrase.trim()) {
      setLocalError('Passphrase cannot be empty.');
      return;
    }
    setExporting(true);
    setLocalError('');
    try {
      await onExport(exportPassphrase.trim());
    } catch (err) {
      setLocalError(err.message);
      setExporting(false);
    }
  };

  // ── Phase: Menu ────────────────────────────────────────────────
  const renderMenu = () => (
    <div className="auth-card">
      <h1 className="auth-title" style={{ fontSize: '1.4rem' }}>
        {hasExistingData ? 'Start Fresh?' : 'Welcome to PH Ledger'}
      </h1>
      <p className="auth-subtitle">
        {hasExistingData
          ? 'Choose what you would like to do with a new ledger.'
          : 'Let\'s get you set up.'}
      </p>

      <div className="landing-actions">
        <button className="auth-btn" onClick={() => setPhase('import')}>
          📥 Import a ledger
        </button>
        <button className="auth-btn" onClick={() => setPhase('new-ledger')}>
          ✨ Begin a new ledger
        </button>
        {hasExistingData && (
          <button className="btn btn-secondary btn-landing" onClick={() => setPhase('export')}>
            📤 Export current ledger
          </button>
        )}
      </div>

      {hasExistingData && (
        <p className="auth-hint" style={{ marginTop: '1rem', textAlign: 'center' }}>
          Importing or creating a new ledger will erase all current data.
        </p>
      )}

      <div style={{ textAlign: 'center', marginTop: '1rem' }}>
        <button className="btn btn-secondary btn-sm" onClick={onBack}>
          ← Back
        </button>
      </div>
    </div>
  );

  // ── Phase: Import ──────────────────────────────────────────────
  const renderImport = () => (
    <div className="auth-card">
      <h2 className="auth-title" style={{ fontSize: '1.2rem' }}>📥 Import a Ledger</h2>
      <p className="auth-subtitle">
        Select an exported ledger file and authenticate to import.
      </p>
      {hasExistingData && (
        <p className="auth-hint" style={{ marginBottom: '0.75rem', color: '#e67e22' }}>
          ⚠ This will replace all current data in the app.
        </p>
      )}

      <form className="auth-form" onSubmit={handleImportSubmit}>
        <div className="form-group">
          <label className="auth-label">Ledger File</label>
          <input
            type="file"
            accept=".json"
            onChange={handleFileSelected}
            ref={fileInputRef}
            className="form-input"
            style={{ padding: '0.4rem' }}
          />
          {importFile && (
            <p style={{ fontSize: '0.8rem', color: '#666', marginTop: '0.25rem' }}>
              Selected: {importFile.name}
            </p>
          )}
        </div>

        <div className="form-group">
          <label htmlFor="import-seed" className="auth-label">Recovery Seed</label>
          <input
            id="import-seed"
            type="text"
            className="auth-input"
            placeholder="Base64 recovery seed from export"
            value={importSeed}
            onChange={(e) => setImportSeed(e.target.value)}
            disabled={importing}
          />
        </div>

        <div className="form-group">
          <label htmlFor="import-passphrase" className="auth-label">Passphrase</label>
          <input
            id="import-passphrase"
            type="password"
            className="auth-input"
            placeholder="Enter your passphrase"
            value={importPassphrase}
            onChange={(e) => setImportPassphrase(e.target.value)}
            disabled={importing}
          />
        </div>

        {displayError && <p className="auth-error-msg">{displayError}</p>}

        <button
          type="submit"
          className="auth-btn"
          disabled={importing || !importFile || !importPassphrase.trim() || !importSeed.trim()}
        >
          {importing ? 'Importing...' : 'Import'}
        </button>
      </form>

      <div style={{ textAlign: 'center', marginTop: '0.75rem' }}>
        <button className="btn btn-secondary btn-sm" onClick={() => setPhase('menu')}>
          ← Back
        </button>
      </div>
    </div>
  );

  // ── Phase: New Ledger ──────────────────────────────────────────
  const renderNewLedger = () => (
    <div className="auth-card">
      <h2 className="auth-title" style={{ fontSize: '1.2rem' }}>✨ Begin a New Ledger</h2>
      <p className="auth-subtitle">
        Enter your details and choose a passphrase to protect your ledger.
      </p>
      {hasExistingData && (
        <p className="auth-hint" style={{ marginBottom: '0.75rem', color: '#e67e22' }}>
          ⚠ This will replace all current data in the app.
        </p>
      )}

      <form className="auth-form" onSubmit={handleNewLedgerSubmit}>
        <div className="form-group">
          <label htmlFor="new-username" className="auth-label">Username</label>
          <input
            id="new-username"
            type="text"
            className="auth-input"
            placeholder="e.g. alice"
            value={newUsername}
            onChange={(e) => setNewUsername(e.target.value)}
            disabled={creating}
            autoFocus
          />
        </div>

        <div className="form-group">
          <label htmlFor="new-email" className="auth-label">Email</label>
          <input
            id="new-email"
            type="email"
            className="auth-input"
            placeholder="e.g. alice@example.com"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            disabled={creating}
          />
        </div>

        <div className="form-group">
          <label htmlFor="new-passphrase" className="auth-label">Passphrase</label>
          <input
            id="new-passphrase"
            type="password"
            className="auth-input"
            placeholder="Choose a strong passphrase"
            value={newPassphrase}
            onChange={(e) => setNewPassphrase(e.target.value)}
            disabled={creating}
          />
        </div>

        <div className="form-group">
          <label htmlFor="new-passphrase-confirm" className="auth-label">Confirm Passphrase</label>
          <input
            id="new-passphrase-confirm"
            type="password"
            className="auth-input"
            placeholder="Re-enter your passphrase"
            value={newPassphraseConfirm}
            onChange={(e) => setNewPassphraseConfirm(e.target.value)}
            disabled={creating}
          />
        </div>

        {displayError && <p className="auth-error-msg">{displayError}</p>}

        <button
          type="submit"
          className="auth-btn"
          disabled={creating || !newUsername.trim() || !newPassphrase.trim() || !newPassphraseConfirm.trim()}
        >
          {creating ? 'Creating...' : 'Create Ledger'}
        </button>
      </form>

      <div style={{ textAlign: 'center', marginTop: '0.75rem' }}>
        <button className="btn btn-secondary btn-sm" onClick={() => setPhase('menu')}>
          ← Back
        </button>
      </div>
    </div>
  );

  // ── Phase: Export ──────────────────────────────────────────────
  const renderExport = () => (
    <div className="auth-card">
      <h2 className="auth-title" style={{ fontSize: '1.2rem' }}>📤 Export Ledger</h2>
      <p className="auth-subtitle">
        Authenticate to export your ledger data as a signed JSON file.
      </p>

      <form className="auth-form" onSubmit={handleExportSubmit}>
        <div className="form-group">
          <label htmlFor="export-passphrase" className="auth-label">Passphrase</label>
          <input
            id="export-passphrase"
            type="password"
            className="auth-input"
            placeholder="Enter your passphrase"
            value={exportPassphrase}
            onChange={(e) => setExportPassphrase(e.target.value)}
            disabled={exporting}
            autoFocus
          />
        </div>

        {displayError && <p className="auth-error-msg">{displayError}</p>}

        <button
          type="submit"
          className="auth-btn"
          disabled={exporting || !exportPassphrase.trim()}
        >
          {exporting ? 'Exporting...' : 'Export'}
        </button>
      </form>

      <div style={{ textAlign: 'center', marginTop: '0.75rem' }}>
        <button className="btn btn-secondary btn-sm" onClick={() => setPhase('menu')}>
          ← Back
        </button>
      </div>
    </div>
  );

  // ── Render ──────────────────────────────────────────────────────
  return (
    <div className="auth-screen">
      {phase === 'menu' && renderMenu()}
      {phase === 'import' && renderImport()}
      {phase === 'new-ledger' && renderNewLedger()}
      {phase === 'export' && renderExport()}
    </div>
  );
}
