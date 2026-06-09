import React, { useState, useCallback, useEffect } from 'react';
import { DevModeProvider, useApp } from './context/DevModeContext.jsx';
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
import SyncIndicator from './components/sync/SyncIndicator.jsx';

import './App.css';

/**
 * App — root component.
 *
 * Flow:
 *   1. DevModeProvider bootstraps services (dummy or real)
 *   2. If not authenticated → AuthScreen
 *   3. If authenticated → AppLayout with navigation
 *
 * Screen routing:
 *   dashboard  → main view (active tasks + new task form)
 *   new-task   → standalone new task form (alternate entry)
 *   history    → completed entries with filters
 *   tags       → tag management
 *   sync       → sync status/control
 *   settings   → app configuration
 *   ledger     → ledger sync (Phase 3)
 */
function AppInner() {
  const { loading, error, user } = useApp();
  const [currentScreen, setCurrentScreen] = useState('dashboard');
  const [profileSubview, setProfileSubview] = useState('profile'); // 'profile' | 'configuration'
  const [authenticated, setAuthenticated] = useState(user.isAuthenticated);
  const [hasBeenAuthenticated, setHasBeenAuthenticated] = useState(user.isAuthenticated);

  // Sync with context auth state
  useEffect(() => {
    if (user.isAuthenticated) {
      setAuthenticated(true);
      setHasBeenAuthenticated(true);
    } else {
      setAuthenticated(false);
    }
  }, [user.isAuthenticated]);

  const handleNavigate = useCallback((screen) => {
    setCurrentScreen(screen);
    // Reset profile subview when navigating away and back
    if (screen !== 'profile') {
      setProfileSubview('profile');
    }
  }, []);

  const handleAuthenticated = useCallback(() => {
    setAuthenticated(true);
    setHasBeenAuthenticated(true);
  }, []);

  const handleLogoutOverlay = useCallback(() => {
    setAuthenticated(false);
    // hasBeenAuthenticated stays true → overlay mode
  }, []);

  // Loading state
  if (loading) {
    return (
      <div className="app-loading">
        <div className="loading-spinner" />
        <p>Initializing PH Ledger...</p>
      </div>
    );
  }

  // Error state
  if (error && !user.isAuthenticated) {
    return (
      <div className="app-error">
        <h2>⚠ Startup Error</h2>
        <p>{error}</p>
        <p className="error-hint">Try refreshing the page or check the browser console.</p>
      </div>
    );
  }

  // Auth gate — full screen on first launch, overlay on re-auth
  if (!authenticated && !hasBeenAuthenticated) {
    return (
      <AuthScreen onAuthenticated={handleAuthenticated} />
    );
  }

  // Main app — render current screen inside AppLayout
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
            onLogoutRequest={handleLogoutOverlay}
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
    <AppLayout currentScreen={currentScreen} onNavigate={handleNavigate} onLogoutRequest={handleLogoutOverlay}>
      {renderScreen()}
      {/* Re-auth overlay: shown when authenticated drops while app was running */}
      {!authenticated && hasBeenAuthenticated && (
        <AuthScreen overlay onAuthenticated={handleAuthenticated} />
      )}
    </AppLayout>
  );
}

/**
 * App — wrapped with DevModeProvider for dev/auth bypass.
 */
export default function App() {
  return (
    <DevModeProvider defaultDevMode={true}>
      <AppInner />
    </DevModeProvider>
  );
}
