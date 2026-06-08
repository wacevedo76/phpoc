import React from 'react';

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
 *   │  [Home] [Hx] [Tags] [Sync]  │ ← Bottom tab nav
 *   │  [Settings]                  │
 *   └──────────────────────────────┘
 */
export default function AppLayout({ currentScreen, onNavigate, children }) {
  const tabs = [
    { id: 'dashboard',   label: 'Home',     icon: '🏠' },
    { id: 'history',     label: 'History',  icon: '📋' },
    { id: 'new-task',    label: 'New',      icon: '➕' },
    { id: 'tags',        label: 'Tags',     icon: '🏷️' },
    { id: 'profile',     label: 'Profile',  icon: '👤' },
    { id: 'sync',        label: 'Sync',     icon: '🔄' },
    { id: 'settings',    label: 'Settings', icon: '⚙️' },
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
            <span className="nav-tab-icon">{tab.icon}</span>
            <span className="nav-tab-label">{tab.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
