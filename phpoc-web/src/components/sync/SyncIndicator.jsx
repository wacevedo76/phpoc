import React from 'react';

/**
 * SyncIndicator — visual sync status badge.
 *
 * Shows one of:
 *   🟢 READY         — remote synced, all good
 *   🟡 PENDING       — local changes not yet pushed
 *   🔶 OFFLINE        — remote unreachable
 *   🔴 REAUTH_NEEDED — device mismatch, passphrase required
 *
 * Props:
 *   @param {'READY'|'OFFLINE'|'REAUTH_NEEDED'|'PENDING'|'SYNCING'} status
 *   @param {boolean} [compact=false] — compact mode (just the dot)
 */
export default function SyncIndicator({ status, compact = false }) {
  const config = {
    READY:         { emoji: '🟢', label: 'Synced',      className: 'sync-ready' },
    PENDING:       { emoji: '🟡', label: 'Pending...',  className: 'sync-pending' },
    SYNCING:       { emoji: '🔄', label: 'Syncing...',  className: 'sync-syncing' },
    OFFLINE:       { emoji: '🔶', label: 'Offline',     className: 'sync-offline' },
    REAUTH_NEEDED: { emoji: '🔴', label: 'Re-auth',    className: 'sync-reauth' },
  };

  const c = config[status] || config.OFFLINE;

  if (compact) {
    return (
      <span className={`sync-dot ${c.className}`} title={c.label}>
        {c.emoji}
      </span>
    );
  }

  return (
    <div className={`sync-indicator ${c.className}`}>
      <span className="sync-icon">{c.emoji}</span>
      <span className="sync-label">{c.label}</span>
    </div>
  );
}
