import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useApp } from '../../context/DevModeContext.jsx';
import { ImportService } from '../../services/import_service.js';
import { LedgerChain } from '../../ledger/chain.js';

const PHASES = {
  INITIAL: 'initial',
  PREVIEWING: 'previewing',
  PREVIEW: 'preview',
  IMPORTING: 'importing',
  DONE: 'done',
  ERROR: 'error',
};

/**
 * ImportScreen — import entries from another ledger.
 *
 * Full pipeline: seed + file input → dry-run preview → import.
 *
 * State machine:
 *   INITIAL → (Preview) → PREVIEWING → PREVIEW → (Import) → IMPORTING → DONE
 *                                                       ↳ ERROR (retry → INITIAL)
 */
export default function ImportScreen() {
  const { services, isDev } = useApp();
  const [phase, setPhase] = useState(PHASES.INITIAL);
  const [seed, setSeed] = useState('');
  const [sourceFile, setSourceFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const fileInputRef = useRef(null);

  // ── Build ImportService from live services ─────────────────────
  const importSvc = useMemo(() => {
    if (!services.crypto || !services.storage) return null;
    const mk = services.crypto.getMasterKey();
    if (!mk) return null;
    const chain = new LedgerChain(services.crypto, services.storage, mk);
    return new ImportService({ targetCrypto: services.crypto, targetChain: chain });
  }, [services.crypto, services.storage]);

  // ── Derived: is the Preview button enabled? ───────────────────
  const canPreview = seed.trim().length > 0 || sourceFile !== null;

  // ── Handlers ───────────────────────────────────────────────────

  const handleFileChange = useCallback((e) => {
    const file = e.target.files?.[0];
    if (file) {
      setSourceFile(file);
      setError('');
    }
  }, []);

  const handlePreview = useCallback(async () => {
    if (!importSvc) {
      setError('Crypto services not available. Please log in again.');
      setPhase(PHASES.ERROR);
      return;
    }

    setPhase(PHASES.PREVIEWING);
    setError('');

    try {
      let sourceChain;

      if (sourceFile) {
        // Read file into buffer, then parse
        const buffer = await sourceFile.arrayBuffer();
        sourceChain = importSvc._parseChainBuffer(new Uint8Array(buffer));
      } else {
        // Seed-only: user must also have a file (for now, require file)
        if (!sourceFile) {
          throw new Error('Please select a source ledger file (ledger.json).');
        }
      }

      const p = await importSvc.dryRun(seed.trim(), sourceChain);
      setPreview(p);
      setPhase(PHASES.PREVIEW);
    } catch (err) {
      setError(err.message || 'Preview failed');
      setPhase(PHASES.ERROR);
    }
  }, [importSvc, sourceFile, seed]);

  const handleImport = useCallback(async (force = false) => {
    if (!importSvc) return;

    setPhase(PHASES.IMPORTING);
    setError('');

    try {
      const buffer = await sourceFile.arrayBuffer();
      const sourceChain = importSvc._parseChainBuffer(new Uint8Array(buffer));
      const r = await importSvc.import(seed.trim(), sourceChain, { force });
      setResult(r);
      setPhase(PHASES.DONE);
    } catch (err) {
      setError(err.message || 'Import failed');
      setPhase(PHASES.ERROR);
    }
  }, [importSvc, sourceFile, seed]);

  const handleReset = useCallback(() => {
    setPhase(PHASES.INITIAL);
    setSeed('');
    setSourceFile(null);
    setPreview(null);
    setResult(null);
    setError('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const handleRetry = useCallback(() => {
    setPhase(PHASES.INITIAL);
    setPreview(null);
    setResult(null);
    setError('');
  }, []);

  // ── Render helpers ─────────────────────────────────────────────

  const renderInitial = () => (
    <>
      <section className="settings-section">
        <h3 className="settings-section-title">Source Ledger</h3>

        <div className="form-group">
          <label className="form-label" htmlFor="import-seed">Recovery Seed</label>
          <input
            id="import-seed"
            type="password"
            className="form-input"
            placeholder="Base64 recovery seed (44 characters)"
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
          />
        </div>

        <div className="form-group">
          <label className="form-label">Ledger File</label>
          <input
            type="file"
            accept=".json"
            onChange={handleFileChange}
            ref={fileInputRef}
            className="form-input"
            style={{ padding: '0.4rem' }}
          />
          {sourceFile && (
            <p style={{ fontSize: '0.8rem', color: '#666', marginTop: '0.25rem' }}>
              Selected: {sourceFile.name}
            </p>
          )}
        </div>

        <button
          className="btn btn-primary btn-sm"
          disabled={!canPreview}
          onClick={handlePreview}
          style={{ marginTop: '0.75rem' }}
        >
          Preview Import
        </button>
      </section>
    </>
  );

  const renderPreviewing = () => (
    <section className="settings-section" style={{ textAlign: 'center', padding: '2rem 0' }}>
      <div className="loading-spinner" />
      <p style={{ marginTop: '0.75rem', color: '#666' }}>
        Analyzing source ledger…
      </p>
    </section>
  );

  const renderPreview = () => {
    if (!preview) return null;
    const hasConflicts = preview.conflicts && preview.conflicts.length > 0;
    return (
      <section className="settings-section">
        <h3 className="settings-section-title">Import Preview</h3>

        <div style={{
          background: '#e8f5e9',
          border: '1px solid #4caf50',
          borderRadius: '8px',
          padding: '0.75rem',
          marginBottom: '0.75rem',
        }}>
          <p style={{ margin: 0, fontSize: '1rem', color: '#2e7d32' }}>
            <strong>{preview.entryCount}</strong> entr{preview.entryCount !== 1 ? 'ies' : 'y'} found
          </p>
          {preview.dateRange.first && (
            <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: '#388e3c' }}>
              Date range: {preview.dateRange.first} — {preview.dateRange.last}
            </p>
          )}
        </div>

        {hasConflicts && (
          <div style={{
            background: '#fff3e0',
            border: '1px solid #e67e22',
            borderRadius: '8px',
            padding: '0.75rem',
            marginBottom: '0.75rem',
          }}>
            <p style={{ margin: 0, fontSize: '0.9rem', color: '#e65100' }}>
              <strong>⚠ {preview.conflicts.length} date conflict{preview.conflicts.length !== 1 ? 's' : ''}</strong>
            </p>
            <p style={{ margin: '0.25rem 0 0', fontSize: '0.8rem', color: '#bf360c' }}>
              These dates already exist in your ledger: {preview.conflicts.join(', ')}
            </p>
          </div>
        )}

        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
          {hasConflicts ? (
            <button
              className="btn btn-warning btn-sm"
              onClick={() => handleImport(true)}
              style={{ flex: 1 }}
            >
              Import Anyway
            </button>
          ) : (
            <button
              className="btn btn-primary btn-sm"
              onClick={() => handleImport(false)}
              style={{ flex: 1 }}
            >
              Import {preview.entryCount} Entr{preview.entryCount !== 1 ? 'ies' : 'y'}
            </button>
          )}
          <button
            className="btn btn-secondary btn-sm"
            onClick={handleReset}
            style={{ flex: 1 }}
          >
            Cancel
          </button>
        </div>
      </section>
    );
  };

  const renderImporting = () => (
    <section className="settings-section" style={{ textAlign: 'center', padding: '2rem 0' }}>
      <div className="loading-spinner" />
      <p style={{ marginTop: '0.75rem', color: '#666' }}>
        Importing entries…
      </p>
    </section>
  );

  const renderDone = () => {
    if (!result) return null;
    return (
      <section className="settings-section">
        <h3 className="settings-section-title">✅ Import Complete</h3>

        <div style={{
          background: '#e8f5e9',
          border: '1px solid #4caf50',
          borderRadius: '8px',
          padding: '0.75rem',
          marginBottom: '0.75rem',
        }}>
          <p style={{ margin: 0, fontSize: '1rem', color: '#2e7d32' }}>
            <strong>{result.migratedCount}</strong> entr{result.migratedCount !== 1 ? 'ies' : 'y'} imported
            {result.skippedCount > 0 && (
              <span> ({result.skippedCount} skipped as duplicate{result.skippedCount !== 1 ? 's' : ''})</span>
            )}
          </p>
          <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: '#388e3c' }}>
            {result.newBlockCount} new day block{result.newBlockCount !== 1 ? 's' : ''} added to your ledger.
          </p>
        </div>

        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
          <button
            className="btn btn-primary btn-sm"
            onClick={handleReset}
            style={{ flex: 1 }}
          >
            Import Another
          </button>
        </div>
      </section>
    );
  };

  const renderError = () => (
    <section className="settings-section">
      <div style={{
        background: '#ffebee',
        border: '1px solid #e53935',
        borderRadius: '8px',
        padding: '0.75rem',
        marginBottom: '0.75rem',
      }}>
        <p style={{ margin: 0, color: '#c62828', fontWeight: 600 }}>
          {error}
        </p>
      </div>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button
          className="btn btn-primary btn-sm"
          onClick={handleRetry}
          style={{ flex: 1 }}
        >
          Try Again
        </button>
        <button
          className="btn btn-secondary btn-sm"
          onClick={handleReset}
          style={{ flex: 1 }}
        >
          Start Over
        </button>
      </div>
    </section>
  );

  const renderServiceUnavailable = () => (
    <section className="settings-section">
      <div style={{
        background: '#fff3e0',
        border: '1px solid #e67e22',
        borderRadius: '8px',
        padding: '0.75rem',
      }}>
        <p style={{ margin: 0, color: '#e65100', fontWeight: 600 }}>
          ⚠ Services not available
        </p>
        <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: '#bf360c' }}>
          {isDev
            ? 'Dev mode: use Production mode with a real ledger.'
            : 'Please complete onboarding and log in before importing.'}
        </p>
      </div>
    </section>
  );

  // ── Main render ────────────────────────────────────────────────

  return (
    <div className="screen">
      <div className="screen-header">
        <h2 className="screen-title">Import Entries</h2>
      </div>

      <div className="settings-sections">
        <section className="settings-section">
          <h3 className="settings-section-title">Import from Another Ledger</h3>
          <p className="settings-hint">
            Import entries from another ledger by providing its recovery seed and
            exported ledger file. Your current ledger will be the target — entries
            are re-encrypted and appended as new day blocks. A dry-run preview
            shows what will be imported before you confirm.
          </p>
        </section>

        {!importSvc ? renderServiceUnavailable() : (
          <>
            {(phase === PHASES.INITIAL) && renderInitial()}
            {phase === PHASES.PREVIEWING && renderPreviewing()}
            {phase === PHASES.PREVIEW && renderPreview()}
            {phase === PHASES.IMPORTING && renderImporting()}
            {phase === PHASES.DONE && renderDone()}
            {phase === PHASES.ERROR && renderError()}
          </>
        )}
      </div>
    </div>
  );
}
