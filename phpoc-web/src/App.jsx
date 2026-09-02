import React, { useState, useCallback, useEffect, Component } from 'react';
import { DevModeProvider, useApp } from './context/DevModeContext.jsx';
import LandingScreen from './components/screens/LandingScreen.jsx';
import OnboardingScreen from './components/screens/OnboardingScreen.jsx';
import AuthScreen from './components/screens/AuthScreen.jsx';
import Dashboard from './components/screens/Dashboard.jsx';
import History from './components/screens/History.jsx';
import Tags from './components/screens/Tags.jsx';
import Settings from './components/screens/Settings.jsx';
import SyncSettings from './components/screens/SyncSettings.jsx';
import LedgerSync from './components/screens/LedgerSync.jsx';
import UserProfile from './components/screens/UserProfile.jsx';
import Configuration from './components/screens/Configuration.jsx';
import ImportScreen from './components/screens/ImportScreen.jsx';
import AppLayout from './components/layout/AppLayout.jsx';
import BookBody from './components/layout/BookBody.jsx';
import ReauthOverlay from './components/overlays/ReauthOverlay.jsx';
import { performReauth } from './sync/reauth.js';
import { BookModeProvider } from './commonplace/book_mode.jsx';

import './App.css';

/**
 * ErrorBoundary — catches render errors and shows diagnostics instead of a blank screen.
 */
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('App crashed:', error, errorInfo);
    this.setState({ errorInfo });
  }

  render() {
    if (this.state.error) {
      return (
        <div className="app-error" style={{ padding: '2rem', maxWidth: 600, margin: '2rem auto' }}>
          <h2>⚠ Something went wrong</h2>
          <p style={{ color: '#c62828', fontWeight: 600 }}>
            {this.state.error.message || String(this.state.error)}
          </p>
          {this.state.errorInfo && (
            <details style={{ marginTop: '1rem', fontSize: '0.85rem', color: '#666' }}>
              <summary>Stack trace</summary>
              <pre style={{
                background: '#f5f5f5',
                padding: '0.75rem',
                borderRadius: 4,
                overflowX: 'auto',
                fontSize: '0.8rem',
              }}>
                {this.state.errorInfo.componentStack}
              </pre>
            </details>
          )}
          <button
            className="btn btn-primary"
            onClick={() => {
              this.setState({ error: null, errorInfo: null });
              window.location.reload();
            }}
            style={{ marginTop: '1rem' }}
          >
            Reload page
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

/**
 * AppInner — renders the correct screen based on the current phase.
 *
 * Phase flow:
 *   boot        → Loading spinner
 *   landing     → LandingScreen (existing data: login vs onboarding)
 *   onboarding  → OnboardingScreen (import / new / export)
 *   auth        → AuthScreen (passphrase entry for login)
 *   ready       → Main app with navigation
 *
 * IMPORTANT: All hooks must be at the top level, before any early returns.
 * React hooks cannot be called conditionally.
 */
function AppInner() {
  // ── All hooks at the top, unconditionally ─────────────────────────
  const {
    phase,
    loading,
    error,
    isDev,
    hasExistingData,
    services,
    user,
    startLogin,
    startOnboarding,
    goBackToLanding,
    login,
    createNewLedger,
    connectToWorker,
    importFromCloud,
    importLedger,
    validateImport,
    confirmImport,
    exportLedger,
    exportLedgerFull,
    logout,
    wipeLedger,
    cryptoStatus,
    storageStatus,
    ttlWarning,
    dismissTtlWarning,
    reauthState,
    triggerReauth,
    dismissReauth,
    restartCookieMonitor,
    genesisMismatch,
    setGenesisMismatch,
  } = useApp();

  const [currentScreen, setCurrentScreen] = useState('dashboard');
  const [profileSubview, setProfileSubview] = useState('profile');

  const handleNavigate = useCallback((screen) => {
    setCurrentScreen(screen);
    if (screen !== 'profile') {
      setProfileSubview('profile');
    }
  }, []);

  // Listen for window-level navigate events (e.g., from Settings)
  useEffect(() => {
    const onCustomNavigate = (e) => handleNavigate(e.detail);
    window.addEventListener('navigate', onCustomNavigate);
    return () => window.removeEventListener('navigate', onCustomNavigate);
  }, [handleNavigate]);

  const handleLogout = useCallback(() => {
    logout();
  }, [logout]);

  // ── Recovery seed display (one-time after new ledger creation) ──
  const [recoverySeed, setRecoverySeed] = useState(null);
  const [seedConfirmed, setSeedConfirmed] = useState(false);

  const handleNewLedger = useCallback(async (passphrase, username, email) => {
    const result = await createNewLedger(passphrase, username, email);
    if (result?.seed) {
      setRecoverySeed(result.seed);
      setSeedConfirmed(false);
    }
  }, [createNewLedger]);

  const handleSeedConfirmed = useCallback(() => {
    setSeedConfirmed(true);
    setRecoverySeed(null);
  }, []);

  // ── Phase-based routing (early returns, no hooks below) ─────────

  // Boot phase
  if (phase === 'boot') {
    return (
      <div className="app-loading">
        <div className="loading-spinner" />
        <p>Initializing PH Ledger...</p>
      </div>
    );
  }

  // Error state (before landing/onboarding)
  if (error && phase !== 'ready') {
    return (
      <div className="app-error">
        <h2>⚠ Startup Error</h2>
        <p>{error}</p>
        <p className="error-hint">Try refreshing the page or check the browser console.</p>
      </div>
    );
  }

  // Landing phase — existing data found
  if (phase === 'landing') {
    return (
      <LandingScreen
        hasExistingData={hasExistingData}
        loading={loading}
        onLogin={startLogin}
        onOnboarding={startOnboarding}
      />
    );
  }

  // Onboarding phase — first-time setup or fresh start
  if (phase === 'onboarding') {
    return (
      <OnboardingScreen
        hasExistingData={hasExistingData}
        onBack={goBackToLanding}
        onImport={importLedger}
        onValidateImport={validateImport}
        onConfirmImport={confirmImport}
        onNewLedger={handleNewLedger}
        onWorkerConnect={connectToWorker}
        onImportFromCloud={importFromCloud}
        onExport={exportLedger}
        onExportFull={exportLedgerFull}
      />
    );
  }

  // Auth phase — passphrase entry for login
  if (phase === 'auth') {
    return (
      <AuthScreen
        onAuthenticated={async (passphrase) => {
          try {
            await login(passphrase);
          } catch (err) {
            throw err;
          }
        }}
        onWipe={async () => {
          await wipeLedger();
        }}
      />
    );
  }

  // ── Ready phase — main app ──────────────────────────────────────
  const renderScreen = () => {
    switch (currentScreen) {
      case 'dashboard':
        return <Dashboard />;
      case 'history':
        return <History />;
      case 'tags':
        return <Tags />;
      case 'sync':
        return <SyncSettings />;
      case 'profile':
        if (profileSubview === 'configuration') {
          return <Configuration onBack={() => setProfileSubview('profile')} />;
        }
        return (
          <UserProfile
            onNavigateToConfig={() => setProfileSubview('configuration')}
            onLogoutRequest={handleLogout}
          />
        );
      case 'settings':
        return <Settings />;
      case 'import':
        return <ImportScreen />;
      case 'ledger':
        return <LedgerSync />;
      default:
        return <Dashboard />;
    }
  };

  return (
    <>
      {/* Crypto fallback warning */}
      {cryptoStatus === 'fallback' && !isDev && (
        <div className="crypto-fallback-banner">
          ⚠ <strong>WASM crypto unavailable</strong> — using fallback encryption.
          Your data is <strong>not cryptographically protected</strong>.
          Check the browser console for details.
        </div>
      )}
      {/* Storage quality warning */}
      {storageStatus === 'memory' && !isDev && (
        <div className="storage-fallback-banner storage-fallback-banner--memory">
          ⚠ <strong>Storage unavailable</strong> — using in-memory storage.
          <strong>All data will be lost on page refresh.</strong>
          Private/incognito browsing may cause this.
        </div>
      )}
      {storageStatus === 'session' && !isDev && (
        <div className="storage-fallback-banner storage-fallback-banner--session">
          ℹ <strong>Session-only storage</strong> — data survives page refreshes
          but will be lost when you close this tab/window.
        </div>
      )}
      <BookModeProvider>
        <AppLayout currentScreen={currentScreen} onNavigate={handleNavigate} onLogoutRequest={handleLogout}>
          <BookBody ledgerScreen={renderScreen()} commonplaceService={services.commonplaceService} />
        </AppLayout>
      </BookModeProvider>

      {/* TTL warning banner: shown 5 minutes before cookie expires */}
      {ttlWarning && (
        <div className="ttl-warning-banner">
          <span className="ttl-warning-icon">⚠</span>
          Session expires soon — save your work.
          <button
            className="btn btn-sm btn-ghost"
            onClick={dismissTtlWarning}
            style={{ marginLeft: 'auto', fontSize: '0.8rem' }}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Re-auth overlay: shown when cookie TTL expires or sync returns REAUTH_NEEDED */}
      {reauthState.active && (
        <ReauthOverlay
          onAuthenticated={async (passphrase) => {
            // performReauth derives MK, calls _reconcileAndClaim to pull/merge/push,
            // and creates a fresh device cookie with updated TTL.
            const result = await performReauth(
              passphrase,
              services.storage,
              services.crypto,
              services.sync,
            );

            // Check for genesis mismatch (re-auth succeeded but remote
            // ledger has a different genesis block). Surface the
            // "Clear Remote & Overwrite" flow via context state.
            if (result.genesisMismatch) {
              setGenesisMismatch(true);
            }

            // On success: dismiss overlay, restart cookie monitor
            dismissReauth();
            // Cookie monitor was disposed in handleTtlExpiry.
            // Increment version to force recreation with fresh cookie.
            restartCookieMonitor();
          }}
          onCancel={() => {
            // User dismissed re-auth — if TTL expired, they go to landing
            if (reauthState.reason === 'ttl_expired') {
              // Services were preserved, but MK is cleared.
              // If user cancels, they need to re-login fully.
              logout();
            } else {
              dismissReauth();
            }
          }}
        />
      )}

      {/* Recovery seed overlay: one-time display after new ledger creation */}
      {recoverySeed && !seedConfirmed && (
        <div className="seed-overlay-backdrop">
          <div className="seed-overlay">
            <h2 className="seed-overlay-title">🔐 Your Recovery Seed</h2>
            <p className="seed-overlay-instruction">
              Write this down and keep it somewhere safe. You'll need it to
              recover your ledger if you lose access to this device.
            </p>
            <div className="seed-overlay-code">
              <code>{recoverySeed}</code>
            </div>
            <p className="seed-overlay-warning">
              ⚠ If you lose your recovery seed, your data cannot be recovered.
            </p>
            <button
              className="btn btn-primary"
              onClick={handleSeedConfirmed}
              style={{ marginTop: '1rem' }}
            >
              I've saved it
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * App — wrapped with DevModeProvider for application lifecycle.
 */
export default function App() {
  return (
    <ErrorBoundary>
      <DevModeProvider defaultDevMode={false}>
        <AppInner />
      </DevModeProvider>
    </ErrorBoundary>
  );
}
