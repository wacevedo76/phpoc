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
 *   onWipe()                    — Async callback that wipes all local data
 *     (mirror of Flutter authService.wipeLedger). Called after the user
 *     confirms the wipe confirmation dialog. Only shown on the full-screen
 *     login (not the re-auth overlay). Must throw on failure so the error
 *     state is shown.
 *   overlay                    — If true, renders as overlay (re-auth).
 *                                If false/omitted, renders full-screen.
 */
export default function AuthScreen({ onAuthenticated, onWipe, overlay = false }) {
  const [passphrase, setPassphrase] = useState('');
  const [authError, setAuthError] = useState(null);
  const [authing, setAuthing] = useState(false);
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [wiping, setWiping] = useState(false);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [wipeError, setWipeError] = useState(null);
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

  // Show the wipe confirmation dialog (full-screen login only).
  const handleWipeClick = useCallback(() => {
    setWipeError(null);
    setConfirmWipe(true);
  }, []);

  // Execute the wipe (mirror of Flutter unlock screen _executeWipe).
  const handleWipeConfirm = useCallback(async () => {
    if (!onWipe) return;
    setWiping(true);
    setWipeError(null);
    try {
      await onWipe();
      // Parent handles the redirect to a fresh landing.
    } catch (err) {
      setWipeError(err.message || 'Failed to wipe ledger.');
      setWiping(false);
    }
  }, [onWipe]);

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
          <div className="password-input-row">
            <input
              id="auth-passphrase"
              ref={inputRef}
              type={showPassphrase ? 'text' : 'password'}
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
            <button
              type="button"
              className="password-toggle"
              aria-label={showPassphrase ? 'Hide passphrase' : 'Show passphrase'}
              onClick={() => setShowPassphrase((v) => !v)}
              disabled={authing}
              title={showPassphrase ? 'Hide passphrase' : 'Show passphrase'}
            >
              {showPassphrase ? '🙈' : '👁️'}
            </button>
          </div>

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

        {!overlay && onWipe && (
          <>
            <button
              type="button"
              className="auth-btn auth-btn--wipe"
              disabled={authing || wiping}
              onClick={handleWipeClick}
            >
              {wiping ? 'Wiping...' : 'Wipe Ledger'}
            </button>
            {wipeError && (
              <p className="auth-error-msg">{wipeError}</p>
            )}
          </>
        )}
      </div>

      {confirmWipe && onWipe && (
        <div className="auth-overlay" role="dialog" aria-modal="true" aria-labelledby="wipe-dialog-title">
          <div className="auth-overlay-card">
            <h2 className="auth-title" id="wipe-dialog-title">Wipe Ledger</h2>
            <p className="auth-subtitle" style={{ textAlign: 'left' }}>
              This will permanently delete all local data:
              <br />• All ledger entries and blocks
              <br />• All staging data
              <br />• Your master key and credentials
              <br />
              <br />Cloud data (R2) will <strong>NOT</strong> be affected.
            </p>
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
              <button
                type="button"
                className="auth-btn"
                style={{ flex: 1, background: 'transparent', color: 'var(--text-primary)', border: '1px solid var(--border-color)' }}
                onClick={() => setConfirmWipe(false)}
                disabled={wiping}
              >
                Cancel
              </button>
              <button
                type="button"
                className="auth-btn"
                style={{ flex: 1, background: 'var(--accent-red)' }}
                onClick={handleWipeConfirm}
                disabled={wiping}
              >
                {wiping ? 'Wiping...' : 'Wipe Ledger'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
