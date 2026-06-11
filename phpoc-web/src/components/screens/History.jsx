import React, { useState, useEffect, useCallback } from 'react';
import { useApp } from '../../context/DevModeContext.jsx';
import { Icons } from '../ui/Icons.jsx';

/**
 * History — completed entries with date/tag filter.
 *
 * Shows ended tasks from local staging, grouped by date.
 * Differentiates between staging-only entries and entries committed to the ledger.
 * Supports batch committing staging entries to the ledger chain.
 */
export default function History() {
  const { services, commitEntries } = useApp();
  const sync = services.sync;

  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [committing, setCommitting] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [filterDate, setFilterDate] = useState('');
  const [filterTag, setFilterTag] = useState('');

  const refresh = useCallback(async () => {
    if (!sync) return;
    setLoading(true);
    try {
      const completed = await sync.getCompleted();
      setEntries(completed);
    } catch (err) {
      console.warn('History: failed to load entries', err);
    } finally {
      setLoading(false);
    }
  }, [sync]);

  useEffect(() => { refresh(); }, [refresh]);

  // ── Commit handler ─────────────────────────────────────────────────

  const handleCommit = useCallback(async () => {
    if (selectedIds.size === 0 || committing) return;
    setCommitting(true);
    try {
      const ids = Array.from(selectedIds);
      await commitEntries(ids);
      setSelectedIds(new Set());
      await refresh();
    } catch (err) {
      console.error('Commit failed:', err);
    } finally {
      setCommitting(false);
    }
  }, [commitEntries, selectedIds, committing, refresh]);

  const handleCommitAll = useCallback(async () => {
    const uncommitted = entries.filter((e) => !e.committed).map((e) => e.entry_id);
    if (uncommitted.length === 0 || committing) return;
    setCommitting(true);
    try {
      await commitEntries(uncommitted);
      await refresh();
    } catch (err) {
      console.error('Commit all failed:', err);
    } finally {
      setCommitting(false);
    }
  }, [commitEntries, entries, committing, refresh]);

  // Toggle selection
  const toggleSelect = useCallback((id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Filter
  const filtered = entries.filter((e) => {
    if (filterDate && e.date !== filterDate) return false;
    if (filterTag) {
      const tagLower = filterTag.toLowerCase();
      if (!e.tags?.some(t => t.toLowerCase().includes(tagLower))) return false;
    }
    return true;
  });

  // Group by date (staging entries first within each date group)
  const grouped = {};
  for (const e of filtered) {
    const date = e.date || 'unknown';
    if (!grouped[date]) grouped[date] = [];
    grouped[date].push(e);
  }
  // Sort each date group: staging first (committed=false), then committed
  for (const date of Object.keys(grouped)) {
    grouped[date].sort((a, b) => {
      if (a.committed !== b.committed) return a.committed ? 1 : -1;
      return 0;
    });
  }

  const formatDuration = (ms) => {
    if (!ms) return '0m';
    const minutes = Math.floor(ms / 60000);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}h ${mins}m`;
  };

  const formatDateLabel = (dateStr) => {
    const d = new Date(dateStr + 'T00:00:00');
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    if (dateStr === today.toISOString().slice(0, 10)) return 'Today';
    if (dateStr === yesterday.toISOString().slice(0, 10)) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  };

  const uncommittedCount = entries.filter((e) => !e.committed).length;

  return (
    <div className="screen">
      <div className="screen-header">
        <h2 className="screen-title">History</h2>
        <div className="screen-header-actions">
          {uncommittedCount > 0 && (
            <>
              <button
                className="btn btn-primary btn-sm"
                onClick={handleCommit}
                disabled={selectedIds.size === 0 || committing}
                title={selectedIds.size > 0
                  ? `Commit ${selectedIds.size} selected staging entr${selectedIds.size === 1 ? 'y' : 'ies'}`
                  : 'Select entries to commit'}
              >
                {committing ? 'Committing…' : `Commit (${selectedIds.size})`}
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={handleCommitAll}
                disabled={committing}
                title={`Commit all ${uncommittedCount} staging entr${uncommittedCount === 1 ? 'y' : 'ies'}`}
              >
                Commit All
              </button>
            </>
          )}
          <button className="btn btn-ghost" onClick={refresh} title="Refresh">
            ↻
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="history-filters">
        <input
          type="date"
          className="form-input form-input-sm"
          value={filterDate}
          onChange={(e) => setFilterDate(e.target.value)}
          aria-label="Filter by date"
        />
        <input
          type="text"
          className="form-input form-input-sm"
          placeholder="Filter by tag..."
          value={filterTag}
          onChange={(e) => setFilterTag(e.target.value)}
          aria-label="Filter by tag"
        />
        {(filterDate || filterTag) && (
          <button className="btn btn-ghost btn-sm" onClick={() => { setFilterDate(''); setFilterTag(''); }}>
            Clear
          </button>
        )}
        {uncommittedCount > 0 && (
          <span className="badge-staging-count">{uncommittedCount} staging</span>
        )}
      </div>

      {/* Entries */}
      <div className="history-list">
        {loading && <div className="pane-empty"><div className="pane-spinner" /><p>Loading...</p></div>}

        {!loading && Object.keys(grouped).length === 0 && (
          <div className="pane-empty">
            <span className="pane-empty-icon"><Icons.clipboard size={32} /></span>
            <p>No completed entries yet</p>
            <p className="pane-hint">Tasks will appear here after you stop them</p>
          </div>
        )}

        {!loading && Object.entries(grouped).map(([date, dayEntries]) => (
          <div key={date} className="history-day">
            <h3 className="history-date-header">{formatDateLabel(date)}</h3>
            <div className="history-entries">
              {dayEntries.map((entry) => (
                <div
                  key={entry.entry_id}
                  className={`history-entry${entry.committed ? '' : ' history-entry-staging'}`}
                  onClick={() => !entry.committed && toggleSelect(entry.entry_id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!entry.committed) toggleSelect(entry.entry_id); }}}
                >
                  {/* Status badge */}
                  <div className="history-entry-status">
                    {entry.committed ? (
                      <span className="badge-committed" title={`Committed in block ${entry.block_index}`}>
                        <Icons.syncReady size={14} /> Committed
                      </span>
                    ) : (
                      <span className="badge-staging">
                        <Icons.history size={14} /> Staging
                        {selectedIds.has(entry.entry_id) && (
                          <span className="badge-selected-indicator"> ✓</span>
                        )}
                      </span>
                    )}
                  </div>

                  <div className="history-entry-main">
                    <span className="history-entry-title">{entry.title}</span>
                    <span className="history-entry-duration">{formatDuration(entry.duration)}</span>
                  </div>
                  {entry.tags?.length > 0 && (
                    <div className="history-entry-tags">
                      {entry.tags.map((tag, i) => (
                        <span key={i} className="tag-badge">#{tag}</span>
                      ))}
                    </div>
                  )}
                  {entry.comment && (
                    <p className="history-entry-comment">{entry.comment}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
