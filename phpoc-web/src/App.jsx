import React, { useState, useCallback } from 'react';
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
import NewTask from './components/screens/NewTask.jsx';
import UserProfile from './components/screens/UserProfile.jsx';
import Configuration from './components/screens/Configuration.jsx';
import AppLayout from './components/layout/AppLayout.jsx';

import './App.css';

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
    hasExistingData,
    services,
    user,
    startLogin,
    startOnboarding,
    goBackToLanding,
    login,
    createNewLedger,
    importLedger,
    exportLedger,
    logout,
  } = useApp();

  const [currentScreen, setCurrentScreen] = useState('dashboard');
  const [profileSubview, setProfileSubview] = useState('profile');
  const [reauthOverlay, setReauthOverlay] = useState(false);

  const handleNavigate = useCallback((screen) => {
    setCurrentScreen(screen);
    if (screen !== 'profile') {
      setProfileSubview('profile');
    }
  }, []);

  const handleLogout = useCallback(() => {
    logout();
    setReauthOverlay(false);
  }, [logout]);

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
        onNewLedger={createNewLedger}
        onExport={exportLedger}
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
      />
    );
  }

  // ── Ready phase — main app ──────────────────────────────────────
  const renderScreen = () => {
    switch (currentScreen) {
      case 'dashboard':
        return <Dashboard />;
      case 'new-task':
        return <NewTask />;
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
      case 'ledger':
        return <LedgerSync />;
      default:
        return <Dashboard />;
    }
  };

  return (
    <>
      <AppLayout currentScreen={currentScreen} onNavigate={handleNavigate} onLogoutRequest={handleLogout}>
        {renderScreen()}
      </AppLayout>

      {/* Re-auth overlay: triggered when cookie TTL expires */}
      {reauthOverlay && (
        <AuthScreen
          overlay
          onAuthenticated={async (passphrase) => {
            try {
              await login(passphrase);
              setReauthOverlay(false);
            } catch (err) {
              throw err;
            }
          }}
        />
      )}
    </>
  );
}

/**
 * App — wrapped with DevModeProvider for application lifecycle.
 */
export default function App() {
  return (
    <DevModeProvider defaultDevMode={false}>
      <AppInner />
    </DevModeProvider>
  );
}
