import React, { useState, useEffect, useCallback } from 'react';
import { useApp } from '../../context/DevModeContext.jsx';

/**
 * History — completed entries with date/tag filter.
 *
 * Shows ended tasks from local staging, grouped by date.
 * Each entry shows: title, duration, tags, date.
 */
export default function History() {
  const { services } = useApp();
  const sync = services.sync;

  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
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

  // Filter
  const filtered = entries.filter((e) => {
    if (filterDate && e.date !== filterDate) return false;
    if (filterTag) {
      const tagLower = filterTag.toLowerCase();
      if (!e.tags?.some(t => t.toLowerCase().includes(tagLower))) return false;
    }
    return true;
  });

  // Group by date
  const grouped = {};
  for (const e of filtered) {
    const date = e.date || 'unknown';
    if (!grouped[date]) grouped[date] = [];
    grouped[date].push(e);
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

  return (
    <div className="screen">
      <div className="screen-header">
        <h2 className="screen-title">History</h2>
        <button className="btn btn-ghost" onClick={refresh} title="Refresh">
          ↻
        </button>
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
      </div>

      {/* Entries */}
      <div className="history-list">
        {loading && <div className="pane-empty"><div className="pane-spinner" /><p>Loading...</p></div>}

        {!loading && Object.keys(grouped).length === 0 && (
          <div className="pane-empty">
            <span className="pane-empty-icon">📋</span>
            <p>No completed entries yet</p>
            <p className="pane-hint">Tasks will appear here after you stop them</p>
          </div>
        )}

        {!loading && Object.entries(grouped).map(([date, dayEntries]) => (
          <div key={date} className="history-day">
            <h3 className="history-date-header">{formatDateLabel(date)}</h3>
            <div className="history-entries">
              {dayEntries.map((entry) => (
                <div key={entry.entry_id} className="history-entry">
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
