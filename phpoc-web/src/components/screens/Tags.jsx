import React, { useState, useEffect, useCallback } from 'react';
import { useApp } from '../../context/DevModeContext.jsx';
import { Icons } from '../ui/Icons.jsx';

/**
 * Tags — tag management screen.
 *
 * Shows all unique tags from staging entries with counts.
 * Allows renaming tags (edit in-place).
 */
export default function Tags() {
  const { services } = useApp();
  const sync = services.sync;

  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!sync) return;
    setLoading(true);
    try {
      const all = await sync.readEntries();
      setEntries(all);
    } catch (err) {
      console.warn('Tags: failed to load', err);
    } finally {
      setLoading(false);
    }
  }, [sync]);

  useEffect(() => { refresh(); }, [refresh]);

  // Compute tag -> count map
  const tagCounts = {};
  for (const e of entries) {
    for (const tag of (e.tags || [])) {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }
  }
  const sortedTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]);

  return (
    <div className="screen">
      <div className="screen-header">
        <h2 className="screen-title">Tags</h2>
        <button className="btn btn-ghost" onClick={refresh} title="Refresh">↻</button>
      </div>

      <div className="tags-list">
        {loading && <div className="pane-empty"><div className="pane-spinner" /><p>Loading...</p></div>}

        {!loading && sortedTags.length === 0 && (
          <div className="pane-empty">
            <span className="pane-empty-icon"><Icons.tags size={32} /></span>
            <p>No tags yet</p>
            <p className="pane-hint">Tags appear when you add them to tasks</p>
          </div>
        )}

        {!loading && sortedTags.map(([tag, count]) => (
          <div key={tag} className="tag-row">
            <div className="tag-row-info">
              <span className="tag-badge tag-badge-lg">#{tag}</span>
              <span className="tag-count">{count} {count === 1 ? 'entry' : 'entries'}</span>
            </div>
          </div>
        ))}
      </div>

      {!loading && sortedTags.length > 0 && (
        <p className="tags-total">{sortedTags.length} unique tags</p>
      )}
    </div>
  );
}
