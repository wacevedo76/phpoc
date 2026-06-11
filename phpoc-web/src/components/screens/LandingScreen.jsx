import React from 'react';

/**
 * LandingScreen — entry landing when existing IndexedDB data is detected.
 *
 * Presents the user with two paths:
 *   1. Log in to the existing ledger (prompt for passphrase)
 *   2. Start fresh (navigate to Onboarding with import/new/export choices)
 *
 * Props:
 *   onLogin()              — User chose to log in to existing ledger
 *   onOnboarding()         — User chose the onboarding path
 *   hasExistingData        — Whether IndexedDB has existing ledger data
 *   loading                — Whether we're still checking IndexedDB
 */
export default function LandingScreen({ onLogin, onOnboarding, hasExistingData, loading }) {
  if (loading) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <div className="auth-spinner" />
          <p>Checking for existing ledger...</p>
        </div>
      </div>
    );
  }

  if (!hasExistingData) {
    // No existing data — go straight to onboarding
    // (This component shouldn't render in this state, but handle gracefully)
    return null;
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-logo">⏱</div>
        <h1 className="auth-title">PH Ledger</h1>
        <p className="auth-subtitle">Zero-knowledge time tracking</p>

        <p className="landing-prompt">
          An existing ledger was found. What would you like to do?
        </p>

        <div className="landing-actions">
          <button
            className="auth-btn"
            onClick={onLogin}
          >
            🔓 Log in to this ledger
          </button>

          <button
            className="btn btn-secondary btn-landing"
            onClick={onOnboarding}
          >
            🚀 Onboarding
          </button>
        </div>
      </div>
    </div>
  );
}
