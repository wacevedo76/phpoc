import React from 'react';
import { useApp } from '../../context/DevModeContext.jsx';

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
            <span>{isDev ? '🛠️ Dev Mode (dummy data)' : '🔒 Production Mode'}</span>
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

        {/* Chain Verification (Phase 3 placeholder) */}
        <section className="settings-section settings-section-disabled">
          <h3 className="settings-section-title">🔒 Chain Verification</h3>
          <p className="settings-hint">Verify ledger chain integrity. Available after ledger sync is implemented.</p>
          <button className="btn btn-secondary btn-sm" disabled>Verify Chain</button>
        </section>

        {/* Recovery (Phase 3 placeholder) */}
        <section className="settings-section settings-section-disabled">
          <h3 className="settings-section-title">🔒 Recover from Seed</h3>
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
            <p>Mode: <strong>{isDev ? '🛠️ Dev' : '🔒 Production'}</strong></p>
          </div>
        </section>
      </div>
    </div>
  );
}
