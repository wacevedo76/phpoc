import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useApp } from '../../context/DevModeContext.jsx';
import { Icons } from '../ui/Icons.jsx';
import { formatDisplayTitle } from '../../sync/display_title.js';

/**
 * History — completed entries with date/tag filter, inline editing for staging.
 *
 * Shows ended tasks from local staging, grouped by date.
 * Differentiates between not-committed (staging) and committed-to-ledger entries.
 * Tags and comments are hidden by default — click a card to expand.
 * Staging entries can have tags added/removed and comments edited inline.
 *
 * Committing entries to the ledger is handled by the Sync screen.
 */
export default function History() {
  const { services } = useApp();
  const sync = services.sync;

  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedIds, setExpandedIds] = useState(new Set());
  const [filterDate, setFilterDate] = useState(() => {
    const d = new Date();
    return d.toISOString().slice(0, 10);
  });
  const [filterTag, setFilterTag] = useState('');
  const [sortBy, setSortBy] = useState('start'); // 'start' | 'duration'

  // Inline editing state (staging entries only, keyed by entry_id)
  const [editTags, setEditTags] = useState({});
  const [editTagInputs, setEditTagInputs] = useState({});
  const [editComments, setEditComments] = useState({});
  const [saving, setSaving] = useState({});
  const saveTimers = useRef({});
  const [calendarCollapsed, setCalendarCollapsed] = useState(true);

  // ── Data loading ──────────────────────────────────────────────────

  const refresh = useCallback(async () => {
    if (!sync) return;
    setLoading(true);
    try {
      const completed = await sync.getCompleted();
      // Ensure every entry has a `date` field (computed from start_epoch if missing)
      const normalized = completed.map((e) => {
        if (e.date) return e;
        const epoch = e.start_epoch;
        if (epoch) {
          return { ...e, date: new Date(epoch).toISOString().slice(0, 10) };
        }
        return { ...e, date: 'unknown' };
      });
      setEntries(normalized);
      // Reset all editing state on refresh
      setEditTags({});
      setEditTagInputs({});
      setEditComments({});
    } catch (err) {
      console.warn('History: failed to load entries', err);
    } finally {
      setLoading(false);
    }
  }, [sync]);

  useEffect(() => { refresh(); }, [refresh]);

  // ── Expand/collapse — initialise / clear editing state ────────────

  const toggleExpand = useCallback((entryId) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(entryId)) {
        // Collapsing — clear any editing state for this entry
        next.delete(entryId);
        setEditTags((s) => { const { [entryId]: _, ...rest } = s; return rest; });
        setEditTagInputs((s) => { const { [entryId]: _, ...rest } = s; return rest; });
        setEditComments((s) => { const { [entryId]: _, ...rest } = s; return rest; });
      } else {
        next.add(entryId);
      }
      return next;
    });
  }, []);

  const handleCardClick = useCallback((entryId) => {
    toggleExpand(entryId);
  }, [toggleExpand]);

  // Initialise editing state when an entry is first expanded
  useEffect(() => {
    for (const entry of entries) {
      if (expandedIds.has(entry.entry_id) && !entry.committed) {
        setEditTags((prev) => {
          if (prev[entry.entry_id] !== undefined) return prev;
          return { ...prev, [entry.entry_id]: [...(entry.tags || [])] };
        });
        setEditComments((prev) => {
          if (prev[entry.entry_id] !== undefined) return prev;
          return { ...prev, [entry.entry_id]: entry.comment || '' };
        });
      }
    }
  }, [entries, expandedIds]);

  // ── Sync helpers ──────────────────────────────────────────────────

  /**
   * Save tags for an entry via sync.modify().
   */
  const saveTags = useCallback(async (entryId, tags) => {
    const entry = entries.find((e) => e.entry_id === entryId);
    if (!entry || entry.committed) return;
    setSaving((s) => ({ ...s, [entryId]: true }));
    try {
      await sync.modify(entry.entry_index, { tags });
      // Update local entry state
      setEntries((prev) => prev.map((e) =>
        e.entry_id === entryId ? { ...e, tags } : e
      ));
    } catch (err) {
      console.warn('Failed to save tags:', err);
    } finally {
      setSaving((s) => ({ ...s, [entryId]: false }));
    }
  }, [entries, sync]);

  /**
   * Save comment for an entry via sync.modify() — debounced.
   */
  const saveComment = useCallback(async (entryId, comment) => {
    const entry = entries.find((e) => e.entry_id === entryId);
    if (!entry || entry.committed) return;
    setSaving((s) => ({ ...s, [entryId]: true }));
    try {
      const finalComment = comment.trim() || null;
      await sync.modify(entry.entry_index, { comment: finalComment });
      setEntries((prev) => prev.map((e) =>
        e.entry_id === entryId ? { ...e, comment: finalComment } : e
      ));
    } catch (err) {
      console.warn('Failed to save comment:', err);
    } finally {
      setSaving((s) => ({ ...s, [entryId]: false }));
    }
  }, [entries, sync]);

  // ── Tag actions ───────────────────────────────────────────────────

  const removeTag = useCallback((entryId, tagToRemove) => {
    const current = editTags[entryId];
    if (!current) return;
    const updated = current.filter((t) => t !== tagToRemove);
    setEditTags((prev) => ({ ...prev, [entryId]: updated }));
    saveTags(entryId, updated);
  }, [editTags, saveTags]);

  const addTag = useCallback((entryId) => {
    const input = (editTagInputs[entryId] || '').trim().toLowerCase();
    if (!input) return;
    const current = editTags[entryId] || [];
    if (current.includes(input)) return; // no duplicates
    const updated = [...current, input].sort();
    setEditTags((prev) => ({ ...prev, [entryId]: updated }));
    setEditTagInputs((prev) => ({ ...prev, [entryId]: '' }));
    saveTags(entryId, updated);
  }, [editTagInputs, editTags, saveTags]);

  const handleTagInputKeyDown = useCallback((e, entryId) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addTag(entryId);
    }
  }, [addTag]);

  // ── Comment change (debounced save on blur) ───────────────────────

  const handleCommentChange = useCallback((entryId, value) => {
    setEditComments((prev) => ({ ...prev, [entryId]: value }));
    // Debounced auto-save after 800ms of no typing
    if (saveTimers.current[entryId]) {
      clearTimeout(saveTimers.current[entryId]);
    }
    saveTimers.current[entryId] = setTimeout(() => {
      saveComment(entryId, value);
    }, 800);
  }, [saveComment]);

  const handleCommentBlur = useCallback((entryId) => {
    const value = editComments[entryId];
    if (saveTimers.current[entryId]) {
      clearTimeout(saveTimers.current[entryId]);
    }
    saveComment(entryId, value || '');
  }, [editComments, saveComment]);

  // ── Calendar state ───────────────────────────────────────────────
  const today = useMemo(() => {
    const d = new Date();
    return d.toISOString().slice(0, 10);
  }, []);

  const [calendarYear, setCalendarYear] = useState(() => new Date().getFullYear());
  const [calendarMonth, setCalendarMonth] = useState(() => new Date().getMonth()); // 0-11

  // Reset calendar to today when entries load
  useEffect(() => {
    if (!loading && entries.length > 0) {
      const now = new Date();
      setCalendarYear(now.getFullYear());
      setCalendarMonth(now.getMonth());
    }
  }, [loading, entries.length]);

  // ── Compute dates that have entries (for calendar dots) ───────────
  const datesWithEntries = useMemo(() => {
    const set = new Set();
    for (const e of entries) {
      if (e.date) set.add(e.date);
    }
    return set;
  }, [entries]);

  // ── Calendar navigation helpers ───────────────────────────────────
  const calendarDays = useMemo(() => {
    const firstDay = new Date(calendarYear, calendarMonth, 1);
    const lastDay = new Date(calendarYear, calendarMonth + 1, 0);
    const startDow = firstDay.getDay(); // 0=Sun
    const totalDays = lastDay.getDate();

    const weeks = [];
    let week = [];

    // Pad leading empty cells
    for (let i = 0; i < startDow; i++) {
      week.push(null);
    }

    for (let day = 1; day <= totalDays; day++) {
      const dateStr = `${calendarYear}-${String(calendarMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      week.push({ day, dateStr, hasEntries: datesWithEntries.has(dateStr) });
      if (week.length === 7) {
        weeks.push(week);
        week = [];
      }
    }

    // Pad trailing empty cells
    if (week.length > 0) {
      while (week.length < 7) week.push(null);
      weeks.push(week);
    }

    return weeks;
  }, [calendarYear, calendarMonth, datesWithEntries]);

  const monthLabel = useMemo(() => {
    const d = new Date(calendarYear, calendarMonth, 1);
    return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }, [calendarYear, calendarMonth]);

  const dayHeaders = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

  const navigateMonth = useCallback((delta) => {
    setCalendarMonth((prev) => {
      let m = prev + delta;
      let y = calendarYear;
      if (m < 0) { m = 11; y--; }
      if (m > 11) { m = 0; y++; }
      setCalendarYear(y);
      return m;
    });
  }, [calendarYear]);

  const navigateYear = useCallback((delta) => {
    setCalendarYear((prev) => prev + delta);
  }, []);

  const goToToday = useCallback(() => {
    const now = new Date();
    setCalendarYear(now.getFullYear());
    setCalendarMonth(now.getMonth());
    setFilterDate(now.toISOString().slice(0, 10));
  }, []);

  // ── Filter ────────────────────────────────────────────────────────

  const filtered = entries.filter((e) => {
    if (filterDate && e.date !== filterDate) return false;
    if (filterTag) {
      const tagLower = filterTag.toLowerCase();
      if (!e.tags?.some(t => t.toLowerCase().includes(tagLower))) return false;
    }
    return true;
  });

  // Group by date (uncommitted entries first within each group)
  const grouped = {};
  for (const e of filtered) {
    const date = e.date || 'unknown';
    if (!grouped[date]) grouped[date] = [];
    grouped[date].push(e);
  }
  for (const date of Object.keys(grouped)) {
    grouped[date].sort((a, b) => {
      // Uncommitted entries always come first
      if (a.committed !== b.committed) return a.committed ? 1 : -1;
      // Then sort by the selected criterion
      if (sortBy === 'start') {
        return (a.start_epoch || 0) - (b.start_epoch || 0);
      }
      // duration: descending (longest first)
      return (b.duration || 0) - (a.duration || 0);
    });
  }

  // ── Formatters ────────────────────────────────────────────────────

  const formatDuration = (ms) => {
    if (!ms) return '0m';
    const minutes = Math.floor(ms / 60000);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}h ${mins}m`;
  };

  /**
   * Format epoch ms to a short time string (e.g. "2:14 PM").
   */
  const formatTime = (epoch) => {
    if (!epoch) return '';
    return new Date(epoch).toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  /**
   * Format a pause duration in ms as "Xm" or "Xh Ym".
   */
  const fmtPauseDuration = (start, stop) => {
    if (!start || !stop) return '';
    const ms = stop - start;
    if (ms <= 0) return '';
    const totalMin = Math.floor(ms / 60000);
    if (totalMin < 60) return `${totalMin}m`;
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
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

  // ── Render ────────────────────────────────────────────────────────

  const calendarIsToday = filterDate === today;

  return (
    <div className="screen">
      <div className="screen-header">
        <h2 className="screen-title">History</h2>
        <div className="screen-header-actions">
          <button className="btn btn-ghost" onClick={refresh} title="Refresh">
            ↻
          </button>
        </div>
      </div>

      {/* Calendar + Tag Filter */}
      <div className="history-filters">
        {/* Collapsible calendar */}
        <div className={`history-calendar-wrap${calendarCollapsed ? ' history-calendar-wrap-collapsed' : ''}`}>
          {calendarCollapsed ? (
            <button
              className="history-calendar-expand-bar"
              onClick={() => setCalendarCollapsed(false)}
              aria-label="Expand calendar"
            >
              <span className="history-calendar-expand-label">
                {monthLabel}
                {filterDate && !calendarIsToday && (
                  <span className="history-calendar-selected"> • {formatDateLabel(filterDate)}</span>
                )}
                {calendarIsToday && (
                  <span className="history-calendar-selected"> • Today</span>
                )}
              </span>
              <span className="history-calendar-expand-chevron">▼</span>
            </button>
          ) : (
            <>
              <div className="history-calendar-header">
                <span
                  className="calendar-month-label"
                  onClick={() => { setFilterDate(''); }}
                  title="Click to show all entries"
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter') setFilterDate(''); }}
                >
                  {monthLabel}
                </span>
                <button
                  className="btn btn-ghost btn-xs"
                  onClick={() => setCalendarCollapsed(true)}
                  aria-label="Collapse calendar"
                  title="Collapse"
                  style={{ opacity: 0.5, fontSize: '0.65rem' }}
                >
                  ▲
                </button>
              </div>
              <div className="history-calendar">
                {/* Month/Year navigation */}
                <div className="calendar-nav">
                  <button className="calendar-nav-btn" onClick={() => navigateYear(-1)} title="Previous year">
                    ◀◀
                  </button>
                  <button className="calendar-nav-btn" onClick={() => navigateMonth(-1)} title="Previous month">
                    ◀
                  </button>
                  <span
                    className="calendar-month-label"
                    onClick={() => { setFilterDate(''); }}
                    title="Click to show all entries"
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter') setFilterDate(''); }}
                  >
                    {monthLabel}
                  </span>
                  <button className="calendar-nav-btn" onClick={() => navigateMonth(1)} title="Next month">
                    ▶
                  </button>
                  <button className="calendar-nav-btn" onClick={() => navigateYear(1)} title="Next year">
                    ▶▶
                  </button>
                </div>

                {/* Day-of-week headers */}
                <div className="calendar-dow">
                  {dayHeaders.map((d) => (
                    <span key={d} className="calendar-dow-cell">{d}</span>
                  ))}
                </div>

                {/* Day grid */}
                <div className="calendar-grid">
                  {calendarDays.map((week, wi) => (
                    <div key={wi} className="calendar-week">
                      {week.map((cell, ci) => {
                        if (!cell) {
                          return <span key={`e-${wi}-${ci}`} className="calendar-day calendar-day-empty" />;
                        }
                        const { day, dateStr, hasEntries } = cell;
                        const isToday = dateStr === today;
                        const isSelected = dateStr === filterDate;
                        return (
                          <button
                            key={dateStr}
                            className={`calendar-day${
                              isToday ? ' calendar-day-today' : ''
                            }${
                              isSelected ? ' calendar-day-selected' : ''
                            }${
                              hasEntries ? ' calendar-day-has-entries' : ''
                            }`}
                            onClick={() => setFilterDate(isSelected ? '' : dateStr)}
                            title={hasEntries ? `${day} — has entries` : String(day)}
                          >
                            <span className="calendar-day-num">{day}</span>
                            {hasEntries && <span className="calendar-day-dot" />}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>

                {/* Today + clear shortcuts */}
                <div className="calendar-actions">
                  <button className="btn btn-ghost btn-sm" onClick={goToToday}>
                    Today
                  </button>
                  {filterDate && (
                    <button className="btn btn-ghost btn-sm" onClick={() => setFilterDate('')}>
                      Clear date
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Tag filter */}
        <div className="history-tag-filter">
          <input
            type="text"
            className="form-input form-input-sm"
            placeholder="Filter by tag..."
            value={filterTag}
            onChange={(e) => setFilterTag(e.target.value)}
            aria-label="Filter by tag"
          />
          {filterTag && (
            <button className="btn btn-ghost btn-sm" onClick={() => setFilterTag('')}>
              Clear
            </button>
          )}
        </div>

        {/* Sort toggle */}
        <div className="history-sort-toggle">
          <span className="history-sort-label">Sort:</span>
          <div className="history-sort-segment">
            <button
              className={`btn${sortBy === 'start' ? ' history-sort-active' : ''}`}
              onClick={() => setSortBy('start')}
            >
              By time
            </button>
            <button
              className={`btn${sortBy === 'duration' ? ' history-sort-active' : ''}`}
              onClick={() => setSortBy('duration')}
            >
              By duration
            </button>
          </div>
        </div>

        {uncommittedCount > 0 && (
          <span className="badge-staging-count" style={{ alignSelf: 'center' }}>
            {uncommittedCount} not committed
          </span>
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
              {dayEntries.map((entry) => {
                const isExpanded = expandedIds.has(entry.entry_id);
                const isEditable = !entry.committed;
                const currentTags = isEditable
                  ? (editTags[entry.entry_id] !== undefined ? editTags[entry.entry_id] : entry.tags || [])
                  : (entry.tags || []);
                const currentTagInput = editTagInputs[entry.entry_id] || '';
                const currentComment = isEditable
                  ? (editComments[entry.entry_id] !== undefined ? editComments[entry.entry_id] : entry.comment || '')
                  : (entry.comment || '');
                const isSaving = saving[entry.entry_id] || false;

                return (
                  <div
                    key={entry.entry_id}
                    className={`history-entry${
                      entry.committed ? ' history-entry-committed' : ' history-entry-staging'
                    }${
                      isExpanded ? ' history-entry-expanded' : ''
                    }`}
                    onClick={() => handleCardClick(entry.entry_id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleCardClick(entry.entry_id);
                      }
                    }}
                  >
                    <div className="history-entry-main">
                      <span className="history-entry-title">{formatDisplayTitle(entry)}</span>
                      {isSaving && <span className="saving-spinner" />}
                      <span className="history-entry-duration">{formatDuration(entry.duration)}</span>
                    </div>

                    {/* Expanded details: timestamps, tags, and comment */}
                    {isExpanded && (
                      <div className="history-entry-details" onClick={(e) => e.stopPropagation()}>
                        {/* Encryption indicator — lock icon only */}
                        <span className="history-encrypted-icon" title={entry.committed ? 'Data is encrypted in the ledger' : 'Data is obfuscated in staging'}>
                          <Icons.lock size={10} />
                        </span>

                        {/* Timestamps: start / end */}
                        <div className="history-entry-times">
                          <span className="history-time-row">
                            <span className="history-time-label">Started:</span>
                            <span className="history-data">{formatTime(entry.start_epoch)}</span>
                          </span>
                          {entry.end_epoch && (
                            <span className="history-time-row">
                              <span className="history-time-label">Ended:</span>
                              <span className="history-data">{formatTime(entry.end_epoch)}</span>
                            </span>
                          )}
                        </div>

                        {/* Pause intervals */}
                        {entry.pauses?.length > 0 && (
                          <div className="history-entry-pauses">
                            <span className="history-pauses-label">
                              {entry.pauses.length} pause{entry.pauses.length !== 1 ? 's' : ''}
                            </span>
                            {entry.pauses.map((p, i) => (
                              <div key={i} className="history-pause-item">
                                <span className="history-pause-icon">⏸</span>
                                <span className="history-pause-times history-data">
                                  {formatTime(p.pause_start)}
                                  {p.pause_stop != null
                                    ? ` – ${formatTime(p.pause_stop)}`
                                    : ' – …'}
                                </span>
                                {p.pause_stop != null && (
                                  <span className="history-pause-dur history-data">
                                    ({fmtPauseDuration(p.pause_start, p.pause_stop)})
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Tags — editable for staging, read-only for committed */}
                        <div className="history-entry-tags">
                          {currentTags.map((tag, i) => (
                            <span key={i} className="tag-badge">
                              #{tag}
                              {isEditable && (
                                <button
                                  className="tag-badge-remove"
                                  onClick={() => removeTag(entry.entry_id, tag)}
                                  title={`Remove #${tag}`}
                                  aria-label={`Remove tag ${tag}`}
                                >
                                  ×
                                </button>
                              )}
                            </span>
                          ))}
                          {isEditable && (
                            <span className="tag-add-wrapper">
                              <input
                                type="text"
                                className="tag-add-input"
                                placeholder="add a tag"
                                value={currentTagInput}
                                onChange={(e) =>
                                  setEditTagInputs((prev) => ({
                                    ...prev,
                                    [entry.entry_id]: e.target.value,
                                  }))
                                }
                                onKeyDown={(e) => handleTagInputKeyDown(e, entry.entry_id)}
                                onClick={(e) => e.stopPropagation()}
                              />
                            </span>
                          )}
                        </div>

                        {/* Comment — editable textarea for staging, read-only for committed */}
                        {isEditable ? (
                          <textarea
                            className="history-entry-comment-edit"
                            placeholder="Add a comment…"
                            value={currentComment}
                            onChange={(e) => handleCommentChange(entry.entry_id, e.target.value)}
                            onBlur={() => handleCommentBlur(entry.entry_id)}
                            onClick={(e) => e.stopPropagation()}
                            rows={3}
                          />
                        ) : (
                          currentComment && (
                            <p className="history-entry-comment">{currentComment}</p>
                          )
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
