import React, { useState, useCallback } from 'react';
import { useApp } from '../../context/DevModeContext.jsx';
import SyncIndicator from '../sync/SyncIndicator.jsx';

/**
 * SyncSettings — sync status and manual sync trigger screen.
 *
 * Shows:
 *   - Current sync status (READY / OFFLINE / REAUTH_NEEDED)
 *   - Last push timestamp
 *   - Remote availability
 *   - Manual "Sync Now" button
 */
export default function SyncSettings() {
  const { services } = useApp();
  const sync = services.sync;

  const [status, setStatus] = useState('READY');
  const [syncing, setSyncing] = useState(false);
  const [lastSyncResult, setLastSyncResult] = useState(null);

  const handleSyncNow = useCallback(async () => {
    if (!sync || syncing) return;
    setSyncing(true);
    setStatus('SYNCING');
    setLastSyncResult(null);
    try {
      const result = await sync.checkAndSync();
      setStatus(result);
      setLastSyncResult(result);
    } catch (err) {
      setStatus('OFFLINE');
      setLastSyncResult(`Error: ${err.message}`);
    } finally {
      setSyncing(false);
    }
  }, [sync, syncing]);

  const formatTime = (ts) => {
    if (!ts) return 'Never';
    return new Date(ts).toLocaleTimeString();
  };

  return (
    <div className="screen">
      <div className="screen-header">
        <h2 className="screen-title">Sync</h2>
        <SyncIndicator status={status} />
      </div>

      <div className="sync-details">
        {/* Status */}
        <div className="sync-detail-row">
          <span className="sync-detail-label">Status</span>
          <SyncIndicator status={status} />
        </div>

        {/* Last push */}
        <div className="sync-detail-row">
          <span className="sync-detail-label">Last push</span>
          <span className="sync-detail-value">{formatTime(sync?.lastPushAt)}</span>
        </div>

        {/* Remote availability */}
        <div className="sync-detail-row">
          <span className="sync-detail-label">Remote</span>
          <span className="sync-detail-value">
            {sync?.isRemoteAvailable ? '✅ Configured' : '⬜ Not configured'}
          </span>
        </div>

        {/* Last sync result */}
        {lastSyncResult && (
          <div className={`sync-result ${lastSyncResult === 'READY' ? 'sync-result-ok' : 'sync-result-error'}`}>
            {lastSyncResult === 'READY'
              ? '✓ Sync completed successfully'
              : `⚠ ${lastSyncResult}`
            }
          </div>
        )}

        {/* Sync Now button */}
        <button
          className="btn btn-primary btn-sync-now"
          onClick={handleSyncNow}
          disabled={syncing || !sync}
        >
          {syncing ? '↻ Syncing...' : '↻ Sync Now'}
        </button>

        <p className="sync-hint">
          Syncs local staging entries with the remote blob.
          Background auto-sync coming in Phase 2.
        </p>
      </div>
    </div>
  );
}
