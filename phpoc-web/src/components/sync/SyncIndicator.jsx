import React from 'react';
import { Icons } from '../ui/Icons.jsx';

/**
 * SyncIndicator — visual sync status badge.
 *
 * Shows one of:
 *   READY         — remote synced, all good
 *   NOT_SYNCED    — uncommitted entries in staging
 *   PENDING       — local changes not yet pushed
 *   OFFLINE        — remote unreachable
 *   REAUTH_NEEDED — device mismatch, passphrase required
 *
 * Props:
 *   @param {'READY'|'NOT_SYNCED'|'OFFLINE'|'REAUTH_NEEDED'|'PENDING'|'SYNCING'} status
 *   @param {boolean} [compact=false] — compact mode (just the dot)
 *   @param {Function} [onReauth] — callback when REAUTH_NEEDED indicator is clicked
 */
export default function SyncIndicator({ status, compact = false, onReauth }) {
  const config = {
    READY:              { icon: Icons.syncReady, label: 'Synced',          className: 'sync-ready' },
    NOT_SYNCED:         { icon: Icons.syncPending, label: 'Not synced',     className: 'sync-pending' },
    PENDING:            { icon: Icons.syncPending, label: 'Pending...',      className: 'sync-pending' },
    SYNCING:            { icon: Icons.syncing, label: 'Syncing...',      className: 'sync-syncing' },
    OFFLINE:            { icon: Icons.offline, label: 'Offline',         className: 'sync-offline' },
    REAUTH_NEEDED:      { icon: Icons.reauthNeeded, label: 'Re-auth',        className: 'sync-reauth' },
    GENESIS_MISMATCH:   { icon: Icons.syncPending, label: 'Genesis mismatch', className: 'sync-pending' },
  };

  const c = config[status] || config.OFFLINE;

  if (compact) {
    return (
      <span className={`sync-dot ${c.className}`} title={c.label}>
        <c.icon size={14} />
      </span>
    );
  }

  const isReauth = status === 'REAUTH_NEEDED' && typeof onReauth === 'function';

  return (
    <div
      className={`sync-indicator ${c.className}${isReauth ? ' sync-indicator-clickable' : ''}`}
      onClick={isReauth ? onReauth : undefined}
      onKeyDown={isReauth ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onReauth(); } } : undefined}
      role={isReauth ? 'button' : undefined}
      tabIndex={isReauth ? 0 : undefined}
      title={isReauth ? 'Click to re-authenticate' : undefined}
    >
      <span className="sync-icon"><c.icon size={20} /></span>
      <span className="sync-label">{c.label}</span>
    </div>
  );
}
