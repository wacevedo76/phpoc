import React, { useState, useEffect, useCallback } from 'react';
import { useApp } from '../../context/DevModeContext.jsx';

/**
 * UserProfile — user identity, device info, stats, and gateway to Configuration.
 *
 * Sections:
 *   1. Avatar / identity card (device label, device UUID, auth status)
 *   2. Sync + session summary
 *   3. Quick stats from the local ledger (entry counts, active/paused)
 *   4. "Open Configuration" button → navigates to Configuration sub-screen
 *
 * Props:
 *   @param {function} onNavigateToConfig — () => void, called when user taps
 *          "Open Configuration"
 */
export default function UserProfile({ onNavigateToConfig, onLogoutRequest }) {
  const { services, user, isDev, logout } = useApp();
  const sync = services.sync;

  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  // Derive an avatar initial from device label or fallback
  const avatarInitial = React.useMemo(() => {
    if (user.deviceId && user.deviceId !== 'dev-dummy-001') {
      return user.deviceId.charAt(0).toUpperCase();
    }
    return 'D'; // Dev mode default
  }, [user.deviceId]);

  // Load stats on mount
  useEffect(() => {
    let cancelled = false;

    async function loadStats() {
      if (!sync) return;
      setLoading(true);
      try {
        const entries = await sync.readEntries();
        if (cancelled) return;
        const active = entries.filter((e) => e.is_active);
        const paused = active.filter((e) => e.is_paused);
        const completed = entries.filter((e) => !e.is_active);
        const uniqueTags = new Set();
        for (const e of entries) {
          for (const t of (e.tags || [])) uniqueTags.add(t);
        }

        // Total tracked time from completed entries
        const totalMs = completed.reduce((sum, e) => sum + (e.duration || 0), 0);
        const totalHours = Math.floor(totalMs / 3600000);
        const totalMinutes = Math.floor((totalMs % 3600000) / 60000);

        setStats({
          totalEntries: entries.length,
          activeCount: active.length,
          pausedCount: paused.length,
          completedCount: completed.length,
          uniqueTags: uniqueTags.size,
          totalHours,
          totalMinutes,
        });
      } catch (err) {
        if (!cancelled) console.warn('Profile: failed to load stats', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadStats();
    return () => { cancelled = true; };
  }, [sync]);

  const formatDuration = (h, m) => {
    if (h === 0 && m === 0) return '0m';
    if (h === 0) return `${m}m`;
    if (m === 0) return `${h}h`;
    return `${h}h ${m}m`;
  };

  return (
    <div className="screen">
      <div className="screen-header">
        <h2 className="screen-title">Profile</h2>
      </div>

      <div className="profile-scroll">
        {/* ── Identity Card ── */}
        <div className="profile-identity-card">
          <div className="profile-avatar">
            {avatarInitial}
          </div>
          <div className="profile-identity-info">
            <h3 className="profile-device-label">
              {user.deviceId === 'dev-dummy-001' ? 'Development Device' : 'My Device'}
            </h3>
            <span className="profile-device-id">{user.deviceId || 'Unknown'}</span>
          </div>
        </div>

        {/* ── Auth & Sync Status ── */}
        <div className="profile-status-row">
          <div className="profile-status-item">
            <span className="profile-status-dot profile-status-authenticated" />
            <div>
              <p className="profile-status-label">Authentication</p>
              <p className="profile-status-value">
                {user.isAuthenticated ? 'Authenticated' : 'Not authenticated'}
              </p>
            </div>
          </div>
          <div className="profile-status-item">
            <span className={`profile-status-dot ${user.masterKeyCached ? 'profile-status-authenticated' : 'profile-status-inactive'}`} />
            <div>
              <p className="profile-status-label">Master Key</p>
              <p className="profile-status-value">
                {user.masterKeyCached ? 'Cached in memory' : 'Not cached'}
              </p>
            </div>
          </div>
        </div>

        {/* ── Quick Stats ── */}
        <section className="profile-section">
          <h3 className="profile-section-title">Activity Stats</h3>
          {loading ? (
            <div className="profile-loading">
              <div className="pane-spinner" />
            </div>
          ) : stats ? (
            <div className="profile-stats-grid">
              <div className="profile-stat-card">
                <span className="profile-stat-number">{stats.activeCount}</span>
                <span className="profile-stat-label">
                  Active {stats.activeCount === 1 ? 'Task' : 'Tasks'}
                  {stats.pausedCount > 0 && (
                    <span className="profile-stat-sub">
                      {' '}({stats.pausedCount} paused)
                    </span>
                  )}
                </span>
              </div>
              <div className="profile-stat-card">
                <span className="profile-stat-number">{stats.completedCount}</span>
                <span className="profile-stat-label">
                  {stats.completedCount === 1 ? 'Entry' : 'Entries'}
                </span>
              </div>
              <div className="profile-stat-card">
                <span className="profile-stat-number">{stats.uniqueTags}</span>
                <span className="profile-stat-label">
                  {stats.uniqueTags === 1 ? 'Tag' : 'Tags'}
                </span>
              </div>
              <div className="profile-stat-card">
                <span className="profile-stat-number">
                  {formatDuration(stats.totalHours, stats.totalMinutes)}
                </span>
                <span className="profile-stat-label">Tracked</span>
              </div>
            </div>
          ) : (
            <p className="profile-empty">No data yet.</p>
          )}
        </section>

        {/* ── Session ── */}
        <section className="profile-section">
          <h3 className="profile-section-title">Session</h3>
          <div className="profile-detail-list">
            <div className="profile-detail-row">
              <span className="profile-detail-label">Status</span>
              <span className="profile-detail-value">
                <span className="profile-status-dot profile-status-authenticated" />
                {' '}Authenticated
              </span>
            </div>
          </div>
          <button
            className="btn btn-danger btn-sm"
            style={{ marginTop: '1rem' }}
            onClick={() => {
              logout();
              if (onLogoutRequest) onLogoutRequest();
            }}
          >
            🔒 Lock & Re-authenticate
          </button>
        </section>

        {/* ── Device Info ── */}
        <section className="profile-section">
          <h3 className="profile-section-title">Device</h3>
          <div className="profile-detail-list">
            <div className="profile-detail-row">
              <span className="profile-detail-label">Mode</span>
              <span className="profile-detail-value">
                {isDev ? '🛠️ Development (dummy data)' : '🔒 Production'}
              </span>
            </div>
            <div className="profile-detail-row">
              <span className="profile-detail-label">Device ID</span>
              <span className="profile-detail-value profile-detail-mono">
                {user.deviceId || '—'}
              </span>
            </div>
            <div className="profile-detail-row">
              <span className="profile-detail-label">Browser</span>
              <span className="profile-detail-value">
                {typeof navigator !== 'undefined'
                  ? navigator.userAgent.split('/')[0].split(' ').slice(-1)[0]
                  : '—'}
              </span>
            </div>
            <div className="profile-detail-row">
              <span className="profile-detail-label">Platform</span>
              <span className="profile-detail-value">
                {typeof navigator !== 'undefined' ? navigator.platform : '—'}
              </span>
            </div>
          </div>
        </section>

        {/* ── Configuration Gateway ── */}
        <section className="profile-section profile-section-action">
          <div className="profile-config-card">
            <div className="profile-config-icon">⚙️</div>
            <div className="profile-config-text">
              <h3 className="profile-config-title">Configuration</h3>
              <p className="profile-config-desc">
                Remote sync, auth timeouts, device identity, storage paths, and
                all other user-configurable settings from the CLI.
              </p>
            </div>
            <button
              className="btn btn-primary"
              onClick={onNavigateToConfig}
              aria-label="Open Configuration"
            >
              Open
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
