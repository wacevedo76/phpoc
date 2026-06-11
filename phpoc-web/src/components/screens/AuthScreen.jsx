import React, { useState, useEffect, useRef, useCallback } from 'react';

/**
 * AuthScreen — passphrase entry screen for login & re-auth.
 *
 * Used in two contexts:
 *   1. Login (phase === 'auth' in App.jsx) — full screen, first auth
 *   2. Re-auth overlay (cookie TTL expired) — blurred backdrop overlay
 *
 * Props:
 *   onAuthenticated(passphrase) — Async callback. Called with trimmed
 *     passphrase. Must throw on failure so the error state is shown.
 *     The caller (App.jsx) handles the actual auth logic.
 *   overlay                    — If true, renders as overlay (re-auth).
 *                                If false/omitted, renders full-screen.
 */
export default function AuthScreen({ onAuthenticated, overlay = false }) {
  const [passphrase, setPassphrase] = useState('');
  const [authError, setAuthError] = useState(null);
  const [authing, setAuthing] = useState(false);
  const inputRef = useRef(null);

  // Auto-focus on mount
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
    }
  }, []);

  // Close on Escape (overlay only)
  useEffect(() => {
    if (!overlay) return;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        // On overlay, Escape dismisses (handled by parent via onCancel)
        // For now, no-op — App.jsx controls overlay visibility
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [overlay]);

  const handleSubmit = useCallback(async (e) => {
    e.preventDefault();
    const trimmed = passphrase.trim();
    if (!trimmed) {
      setAuthError('Passphrase cannot be empty.');
      return;
    }

    setAuthing(true);
    setAuthError(null);

    try {
      await onAuthenticated(trimmed);
      // If we get here, auth succeeded — parent handles the transition
    } catch (err) {
      setAuthError(err.message || 'Authentication failed.');
      setAuthing(false);
    }
  }, [passphrase, onAuthenticated]);

  const containerClass = overlay ? 'auth-overlay' : 'auth-screen';
  const cardClass = overlay ? 'auth-overlay-card' : 'auth-card';

  return (
    <div className={containerClass}>
      <div className={cardClass}>
        <div className="auth-logo">⏱</div>
        <h1 className="auth-title">PH Ledger</h1>
        <p className="auth-subtitle">
          {overlay
            ? 'Session expired — please re-authenticate'
            : 'Zero-knowledge time tracking'}
        </p>

        <form onSubmit={handleSubmit} className="auth-form">
          <label htmlFor="auth-passphrase" className="auth-label">
            Passphrase
          </label>
          <input
            id="auth-passphrase"
            ref={inputRef}
            type="password"
            className="auth-input"
            placeholder="Enter your passphrase"
            value={passphrase}
            onChange={(e) => {
              setPassphrase(e.target.value);
              if (authError) setAuthError(null);
            }}
            disabled={authing}
            autoFocus
          />

          {authing && (
            <p className="auth-hint" style={{ textAlign: 'center', margin: '0.5rem 0' }}>
              <span className="auth-spinner" style={{ display: 'inline-block', width: 16, height: 16 }} />
              {' '}Decrypting...
            </p>
          )}

          {authError && (
            <p className="auth-error-msg">{authError}</p>
          )}

          <button
            type="submit"
            className="auth-btn"
            disabled={authing || !passphrase.trim()}
          >
            {authing ? 'Unlocking...' : 'Unlock'}
          </button>
        </form>
      </div>
    </div>
  );
}
