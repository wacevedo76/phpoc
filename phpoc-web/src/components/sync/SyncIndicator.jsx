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
 */
export default function SyncIndicator({ status, compact = false }) {
  const config = {
    READY:         { icon: Icons.syncReady, label: 'Synced',      className: 'sync-ready' },
    NOT_SYNCED:    { icon: Icons.syncPending, label: 'Not synced', className: 'sync-pending' },
    PENDING:       { icon: Icons.syncPending, label: 'Pending...',  className: 'sync-pending' },
    SYNCING:       { icon: Icons.syncing, label: 'Syncing...',  className: 'sync-syncing' },
    OFFLINE:       { icon: Icons.offline, label: 'Offline',     className: 'sync-offline' },
    REAUTH_NEEDED: { icon: Icons.reauthNeeded, label: 'Re-auth',    className: 'sync-reauth' },
  };

  const c = config[status] || config.OFFLINE;

  if (compact) {
    return (
      <span className={`sync-dot ${c.className}`} title={c.label}>
        <c.icon size={14} />
      </span>
    );
  }

  return (
    <div className={`sync-indicator ${c.className}`}>
      <span className="sync-icon"><c.icon size={20} /></span>
      <span className="sync-label">{c.label}</span>
    </div>
  );
}
