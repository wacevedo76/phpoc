/**
 * ReauthOverlay — Passphrase re-authentication overlay.
 *
 * Shown when:
 *   - Cookie TTL expires (monitor fires onExpired)
 *   - checkAndSync() returns REAUTH_NEEDED (SyncSettings "Sync Now")
 *
 * Unlike the full AuthScreen (login), this overlay:
 *   - Keeps services alive (storage, sync reference preserved)
 *   - Derives MK from passphrase + stored seed
 *   - Calls sync._reconcileAndClaim(mk) to pull/merge/push/create cookie
 *   - On success: dismisses and lets the caller resume
 *   - On cancel: dismisses without clearing session state
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';

// ── ReauthOverlay Component ──────────────────────────────────────────

/**
 * Re-authentication overlay.
 *
 * Props:
 *   onAuthenticated(passphrase) — async callback. The overlay calls this
 *     with the trimmed passphrase. Should call performReauth() internally
 *     and throw on failure so error state is shown.
 *   onCancel() — called when user clicks Cancel. Parent should dismiss
 *     the overlay.
 */
export default function ReauthOverlay({ onAuthenticated, onCancel }) {
  const [passphrase, setPassphrase] = useState('');
  const [authError, setAuthError] = useState(null);
  const [authing, setAuthing] = useState(false);
  const inputRef = useRef(null);
  const errorId = 'reauth-error';

  // Auto-focus on mount
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
    }
  }, []);

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
      // Success — parent handles dismiss
    } catch (err) {
      setAuthError(err.message || 'Authentication failed.');
      setAuthing(false);
    }
  }, [passphrase, onAuthenticated]);

  return (
    <div className="auth-overlay">
      <div className="auth-overlay-card">
        <div className="auth-logo">⏱</div>
        <h1 className="auth-title">PH Ledger</h1>
        <p className="auth-subtitle">
          Session expired — please re-authenticate
        </p>

        <form onSubmit={handleSubmit} className="auth-form">
          <label htmlFor="reauth-passphrase" className="auth-label">
            Passphrase
          </label>
          <input
            id="reauth-passphrase"
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
            aria-describedby={authError ? errorId : undefined}
            autoFocus
          />

          {authing && (
            <p className="auth-hint" style={{ textAlign: 'center', margin: '0.5rem 0' }}>
              <span className="auth-spinner" style={{ display: 'inline-block', width: 16, height: 16 }} />
              {' '}Decrypting...
            </p>
          )}

          {authError && (
            <p id={errorId} className="auth-error-msg" role="alert">
              {authError}
            </p>
          )}

          <button
            type="submit"
            className="auth-btn"
            disabled={authing || !passphrase.trim()}
          >
            {authing ? 'Unlocking...' : 'Unlock'}
          </button>

          {onCancel && (
            <button
              type="button"
              className="auth-btn auth-btn-cancel"
              onClick={onCancel}
              disabled={authing}
            >
              Cancel
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
