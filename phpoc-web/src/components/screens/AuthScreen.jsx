import React from 'react';
import { useApp } from '../../context/DevModeContext.jsx';

/**
 * AuthScreen — passphrase entry screen.
 *
 * In DEV MODE, the user is auto-authenticated immediately. In production,
 * this screen would:
 *   1. Prompt for passphrase
 *   2. Run PBKDF2-600K via WASM (background thread with spinner)
 *   3. Decrypt the recovery seed
 *   4. Derive master key → cache in memory
 *   5. Call checkAndSync() to reconcile remote staging
 *   6. Transition to Dashboard
 *
 * For now, dev mode auto-redirects with a brief flash message.
 */
export default function AuthScreen({ onAuthenticated }) {
  const { isDev, loading, error, login, user } = useApp();
  const [passphrase, setPassphrase] = React.useState('');
  const [authError, setAuthError] = React.useState(null);
  const [authing, setAuthing] = React.useState(false);

  // Dev mode: auto-authenticate immediately
  React.useEffect(() => {
    if (isDev && !loading && user.isAuthenticated) {
      // Briefly show the auth screen branding, then transition
      const timer = setTimeout(() => onAuthenticated(), 300);
      return () => clearTimeout(timer);
    }
  }, [isDev, loading, user.isAuthenticated, onAuthenticated]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!passphrase.trim()) return;
    setAuthing(true);
    setAuthError(null);
    try {
      const ok = await login(passphrase.trim());
      if (ok) onAuthenticated();
    } catch (err) {
      setAuthError(err.message);
    } finally {
      setAuthing(false);
    }
  };

  if (loading) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <div className="auth-spinner" />
          <p>Initializing...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="auth-screen">
        <div className="auth-card auth-error">
          <h2>Startup Error</h2>
          <p>{error}</p>
          <p className="auth-hint">Check the console for details.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-logo">⏱</div>
        <h1 className="auth-title">PH Ledger</h1>
        <p className="auth-subtitle">Zero-knowledge time tracking</p>

        {isDev && (
          <div className="auth-dev-banner">
            🔧 Dev Mode — auto-authenticating...
          </div>
        )}

        {!isDev && (
          <form onSubmit={handleSubmit} className="auth-form">
            <label htmlFor="passphrase" className="auth-label">
              Passphrase
            </label>
            <input
              id="passphrase"
              type="password"
              className="auth-input"
              placeholder="Enter your passphrase"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              autoFocus
              disabled={authing}
            />
            {authError && <p className="auth-error-msg">{authError}</p>}
            <button
              type="submit"
              className="auth-btn"
              disabled={authing || !passphrase.trim()}
            >
              {authing ? 'Decrypting...' : 'Unlock'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
