/**
 * RekeyModal — shared two-secret recovery-seed re-key dialog.
 *
 * Presentational component used by both the ledger `Settings` screen and the
 * Commonplace `CommonplaceSettingsScreen`. All state lives in the caller via
 * `useRekeyFlow()`; this component only renders the gate and forwards changes.
 *
 * Gate (mirrors the C-2 reveal-gate, option (a)):
 *   - current passphrase + new passphrase
 *   - freshly-generated seed surfaced once ("Save this new Recovery Seed now")
 *   - "I have saved my new Recovery Seed" checkbox
 *   - type-back confirmation of the new seed
 *   - "Acknowledge" checkbox
 *   - "Re-key" is disabled until passphrase + saved-seed + acknowledge + seed-match
 *   - error (role="alert") + success ("Re-key complete") feedback
 */

import React from 'react';

export default function RekeyModal({
  description,
  error,
  done,
  busy,
  oldPassphrase,
  newPassphrase,
  newSeed,
  savedSeed,
  acknowledge,
  seedConfirm,
  onOldPassphraseChange,
  onNewPassphraseChange,
  onSavedSeedChange,
  onAcknowledgeChange,
  onSeedConfirmChange,
  onConfirm,
  onCancel,
  idPrefix = '',
}) {
  const p = idPrefix ? idPrefix + '-' : '';

  return (
    <div className="auth-overlay" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="auth-overlay-card" style={{ maxWidth: '500px' }}>
        <h2 className="auth-title" style={{ fontSize: '1.2rem', marginBottom: '0.5rem' }}>
          🔄 Re-key Recovery Seed
        </h2>
        <p className="auth-subtitle">{description}</p>

        {error && (
          <p className="auth-error-msg" role="alert">
            {error}
          </p>
        )}

        <div className="form-group">
          <label className="auth-label" htmlFor={`${p}rekey-old-passphrase`}>Current Passphrase</label>
          <input
            id={`${p}rekey-old-passphrase`}
            type="password"
            className="auth-input"
            value={oldPassphrase}
            onChange={(e) => onOldPassphraseChange(e.target.value)}
            disabled={busy}
          />
        </div>

        <div className="form-group">
          <label className="auth-label" htmlFor={`${p}rekey-new-passphrase`}>New Passphrase</label>
          <input
            id={`${p}rekey-new-passphrase`}
            type="password"
            className="auth-input"
            value={newPassphrase}
            onChange={(e) => onNewPassphraseChange(e.target.value)}
            disabled={busy}
          />
        </div>

        {newSeed && (
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
              {newSeed}
            </code>
          </div>
        )}

        <label style={{
          display: 'flex', alignItems: 'flex-start', gap: '0.5rem',
          cursor: 'pointer', fontSize: '0.9rem', color: '#2e7d32', marginBottom: '0.75rem',
        }}>
          <input
            type="checkbox"
            checked={savedSeed}
            onChange={(e) => onSavedSeedChange(e.target.checked)}
            disabled={busy}
            style={{ marginTop: '0.15rem', flexShrink: 0 }}
          />
          <span>I have saved my new Recovery Seed</span>
        </label>

        <div className="form-group">
          <label className="auth-label" htmlFor={`${p}rekey-seed-confirm`}>Type your new Recovery Seed to confirm</label>
          <input
            id={`${p}rekey-seed-confirm`}
            type="text"
            className="auth-input"
            value={seedConfirm}
            onChange={(e) => onSeedConfirmChange(e.target.value)}
            disabled={busy}
          />
        </div>

        <label style={{
          display: 'flex', alignItems: 'flex-start', gap: '0.5rem',
          cursor: 'pointer', fontSize: '0.9rem', color: '#c62828', marginBottom: '0.75rem',
        }}>
          <input
            type="checkbox"
            checked={acknowledge}
            onChange={(e) => onAcknowledgeChange(e.target.checked)}
            disabled={busy}
            style={{ marginTop: '0.15rem', flexShrink: 0 }}
          />
          <span>Acknowledge</span>
        </label>

        {done && (
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
            onClick={onConfirm}
            disabled={
              busy ||
              !oldPassphrase.trim() ||
              !acknowledge ||
              !savedSeed ||
              seedConfirm !== newSeed
            }
          >
            {busy ? 'Re-keying…' : 'Re-key'}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            style={{ flex: 1 }}
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
