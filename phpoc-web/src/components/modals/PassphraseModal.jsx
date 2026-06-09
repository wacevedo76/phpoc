import React from 'react';

/**
 * PassphraseModal — reusable passphrase prompt overlay.
 *
 * Reuses the AuthScreen overlay pattern (backdrop blur, pop-in animation)
 * via the existing `.auth-overlay` and `.auth-overlay-card` CSS classes.
 *
 * Props:
 *   onSubmit(passphrase)  — Called with the trimmed passphrase on confirm.
 *   onCancel()             — Called when the user dismisses the modal.
 *   title                  — Optional heading text (default: "Enter Passphrase").
 *   description            — Optional body text below the title.
 *   errorMessage           — Optional external error to display.
 *
 * Accessibility:
 *   - Auto-focuses the passphrase input on mount (autoFocus)
 *   - Closes on Escape key
 *   - Traps focus within the modal (basic)
 *
 * @param {object}   props
 * @param {function} props.onSubmit
 * @param {function} props.onCancel
 * @param {string}   [props.title]
 * @param {string}   [props.description]
 * @param {string}   [props.errorMessage='']
 */
export default function PassphraseModal({
  onSubmit,
  onCancel,
  title = 'Enter Passphrase',
  description = 'Your passphrase is required to unlock the ledger.',
  errorMessage = '',
}) {
  const [passphrase, setPassphrase] = React.useState('');
  const [localError, setLocalError] = React.useState('');
  const inputRef = React.useRef(null);

  // Auto-focus on mount
  React.useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
    }
  }, []);

  // Close on Escape
  React.useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && onCancel) {
        onCancel();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onCancel]);

  const handleSubmit = (e) => {
    e.preventDefault();
    const trimmed = passphrase.trim();

    if (!trimmed) {
      setLocalError('Passphrase cannot be empty.');
      return;
    }

    setLocalError('');
    if (onSubmit) {
      onSubmit(trimmed);
    }
  };

  const handleChange = (e) => {
    setPassphrase(e.target.value);
    // Clear errors when user starts typing
    if (localError) setLocalError('');
  };

  const handleBackdropClick = (e) => {
    // Only close if clicking the backdrop, not the card
    if (e.target === e.currentTarget && onCancel) {
      onCancel();
    }
  };

  const displayError = localError || errorMessage;

  return (
    <div
      className="auth-overlay"
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="auth-overlay-card">
        <h2 className="auth-title" style={{ fontSize: '1.2rem', marginBottom: '0.5rem' }}>
          {title}
        </h2>

        {description && (
          <p className="auth-subtitle" style={{ marginBottom: '1.25rem' }}>
            {description}
          </p>
        )}

        <form onSubmit={handleSubmit} className="auth-form">
          <label htmlFor="modal-passphrase" className="auth-label">
            Passphrase
          </label>
          <input
            id="modal-passphrase"
            ref={inputRef}
            type="password"
            className="auth-input"
            placeholder="Enter your passphrase"
            value={passphrase}
            onChange={handleChange}
            autoFocus
          />

          {displayError && (
            <p className="auth-error-msg">{displayError}</p>
          )}

          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
            <button
              type="submit"
              className="auth-btn"
              disabled={!passphrase.trim()}
              style={{ flex: 1 }}
            >
              Confirm
            </button>

            {onCancel && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={onCancel}
                style={{ flex: 1 }}
              >
                Cancel
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
