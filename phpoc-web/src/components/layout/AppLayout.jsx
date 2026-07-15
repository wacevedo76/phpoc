import React from 'react';
import { Icons } from '../ui/Icons.jsx';

/**
 * AppLayout — navigation shell + routing.
 *
 * Structure:
 *   ┌──────────────────────────────┐
 *   │  Dev Mode Banner (dev only)  │
 *   ├──────────────────────────────┤
 *   │  Screen Content              │
 *   │                              │
 *   │                              │
 *   ├──────────────────────────────┤
 *   │ [Home] [Hx] [New] [Tags]    │ ← Bottom tab nav
 *   │ [Profile] [Sync] [Settings] ││ │
 *   └──────────────────────────────┘ │
 *                            Lock btn─┘
 */
export default function AppLayout({ currentScreen, onNavigate, children, onLogoutRequest }) {
  const tabs = [
    { id: 'dashboard',   label: 'Home',     icon: Icons.dashboard },
    { id: 'history',     label: 'History',  icon: Icons.history },
    { id: 'tags',        label: 'Tags',     icon: Icons.tags },
    { id: 'profile',     label: 'Profile',  icon: Icons.profile },
    { id: 'sync',        label: 'Sync',     icon: Icons.sync },
    { id: 'settings',    label: 'Settings', icon: Icons.settings },
  ];

  return (
    <div className="app-layout">
      <main className="app-content">
        {children}
      </main>

      <nav className="app-nav">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`nav-tab ${currentScreen === tab.id ? 'nav-tab-active' : ''}`}
            onClick={() => onNavigate(tab.id)}
            title={tab.label}
          >
            <span className="nav-tab-icon"><tab.icon size={20} /></span>
            <span className="nav-tab-label">{tab.label}</span>
          </button>
        ))}
        <div className="nav-separator" />
        <button
          className="nav-tab nav-tab-logout"
          onClick={onLogoutRequest}
          title="Logout"
        >
          <span className="nav-tab-icon"><Icons.logout size={20} /></span>
          <span className="nav-tab-label">Logout</span>
        </button>
      </nav>
    </div>
  );
}
