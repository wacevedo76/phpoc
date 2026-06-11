/**
 * Sync — unified sync screen.
 *
 * Portrait layout (default):
 *   ┌──────────────────────────────┐
 *   │  Sync                    [↻] │  ← Screen header
 *   ├──────────────────────────────┤
 *   │  [☐] ✓ Completed Task   12m │  ← Compact pills for stopped
 *   │  #tag1  #tag2          [×]… │     entries (expandable)
 *   │  ┌────────────────────────┐  │
 *   │  │ [+tag]                │  │
 *   │  │ Add a comment…        │  │
 *   │  └────────────────────────┘  │
 *   │  🔴 ▶ Active Task       5m  │  ← Active entries (compact)
 *   │  (scrollable)               │
 *   ├──────────────────────────────┤
 *   │  [Commit Selected (N)]       │  ← Sync button
 *   │  [Commit All (N)]            │
 *   ├──────────────────────────────┤
 *   │  Status    ● Synced          │  ← Sync status info
 *   │  Last push 2:30 PM           │
 *   │  Remote    ✅ Configured     │
 *   └──────────────────────────────┘
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useApp } from '../../context/DevModeContext.jsx';
import { useActiveTasks } from '../../hooks/useActiveTasks.js';
import SyncIndicator from '../sync/SyncIndicator.jsx';
import { Icons } from '../ui/Icons.jsx';

// ── Constants ────────────────────────────────────────────────────────

const STATUS_READY = 'READY';
const STATUS_NOT_SYNCED = 'NOT_SYNCED';
const STATUS_OFFLINE = 'OFFLINE';
const STATUS_REAUTH = 'REAUTH_NEEDED';
const STATUS_SYNCING = 'SYNCING';

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Format duration ms → human-readable.
 */
function formatDuration(ms) {
  if (!ms) return '0m';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

/**
 * Format a timestamp to a short time string.
 */
function formatTime(ts) {
  if (!ts) return 'Never';
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ── Sync Screen Component ────────────────────────────────────────────

export default function SyncSettings() {
  const { services, commitEntries } = useApp();
  const sync = services.sync;

  // ── Active tasks (for live elapsed timer on running entries) ─────
  const { elapsedMap: activeElapsedMap, refresh: refreshActive } = useActiveTasks(sync);

  // ── All entries state ───────────────────────────────────────────
  const [allEntries, setAllEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [expandedIds, setExpandedIds] = useState(new Set());
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState(null);
  const [commitResult, setCommitResult] = useState(null);

  // ── Inline editing state (stopped entries only, keyed by entry_id) ─
  const [editTags, setEditTags] = useState({});
  const [editTagInputs, setEditTagInputs] = useState({});
  const [editComments, setEditComments] = useState({});
  const [saving, setSaving] = useState({});
  const saveTimers = useRef({});

  // ── Sync status ─────────────────────────────────────────────────
  const [remoteStatus, setRemoteStatus] = useState(STATUS_READY);
  const [syncing, setSyncing] = useState(false);
  const [lastSyncResult, setLastSyncResult] = useState(null);

  // Display status: SYNCING > NOT_SYNCED (staging entries exist) > remote status
  const displayStatus = syncing ? STATUS_SYNCING
    : allEntries.length > 0 ? STATUS_NOT_SYNCED
    : remoteStatus;

  // Debounce timer for commit error/reset
  const errorTimer = useRef(null);

  // ── Load entries ────────────────────────────────────────────────

  const refreshEntries = useCallback(async () => {
    if (!sync) return;
    setLoading(true);
    try {
      const entries = await sync.readEntries();
      // Only show uncommitted entries (both active and stopped)
      const uncommitted = entries.filter((e) => !e.committed);
      setAllEntries(uncommitted);

      // Prune selectedIds: remove any that are no longer in the list
      setSelectedIds((prev) => {
        const validIds = new Set(uncommitted.map((e) => e.entry_id));
        const next = new Set();
        for (const id of prev) {
          if (validIds.has(id)) next.add(id);
        }
        return next;
      });

      // Prune expandedIds: remove entries no longer in list
      setExpandedIds((prev) => {
        const validIds = new Set(uncommitted.map((e) => e.entry_id));
        const next = new Set();
        for (const id of prev) {
          if (validIds.has(id)) next.add(id);
        }
        return next;
      });

      // Reset editing state
      setEditTags({});
      setEditTagInputs({});
      setEditComments({});
    } catch (err) {
      console.warn('Sync: failed to load entries', err);
    } finally {
      setLoading(false);
    }
  }, [sync]);

  useEffect(() => { refreshEntries(); }, [refreshEntries, refreshActive]);

  // ── Selection ───────────────────────────────────────────────────

  const toggleSelect = useCallback((entryId, e) => {
    e?.stopPropagation();
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(entryId)) {
        next.delete(entryId);
      } else {
        next.add(entryId);
      }
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(allEntries.map((e) => e.entry_id)));
  }, [allEntries]);

  const deselectAll = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  // ── Expand / Collapse ──────────────────────────────────────────

  const toggleExpand = useCallback((entryId) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(entryId)) {
        // Collapsing — clear editing state for this entry
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
    for (const entry of allEntries) {
      if (expandedIds.has(entry.entry_id) && !entry.is_active) {
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
  }, [allEntries, expandedIds]);

  // ── Inline editing helpers ──────────────────────────────────────

  /**
   * Save tags for an entry via sync.modify().
   */
  const saveTags = useCallback(async (entryId, tags) => {
    const entry = allEntries.find((e) => e.entry_id === entryId);
    if (!entry || entry.is_active) return;
    setSaving((s) => ({ ...s, [entryId]: true }));
    try {
      await sync.modify(entry.entry_index, { tags });
      // Update local entry state
      setAllEntries((prev) => prev.map((e) =>
        e.entry_id === entryId ? { ...e, tags } : e
      ));
    } catch (err) {
      console.warn('Failed to save tags:', err);
    } finally {
      setSaving((s) => ({ ...s, [entryId]: false }));
    }
  }, [allEntries, sync]);

  /**
   * Save comment for an entry via sync.modify() — debounced.
   */
  const saveComment = useCallback(async (entryId, comment) => {
    const entry = allEntries.find((e) => e.entry_id === entryId);
    if (!entry || entry.is_active) return;
    setSaving((s) => ({ ...s, [entryId]: true }));
    try {
      const finalComment = comment.trim() || null;
      await sync.modify(entry.entry_index, { comment: finalComment });
      setAllEntries((prev) => prev.map((e) =>
        e.entry_id === entryId ? { ...e, comment: finalComment } : e
      ));
    } catch (err) {
      console.warn('Failed to save comment:', err);
    } finally {
      setSaving((s) => ({ ...s, [entryId]: false }));
    }
  }, [allEntries, sync]);

  // ── Tag actions ─────────────────────────────────────────────────

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

  // ── Comment change (debounced save on blur) ─────────────────────

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

  // ── Commit ──────────────────────────────────────────────────────

  const handleCommit = useCallback(async (entryIds) => {
    if (!entryIds || entryIds.length === 0) return;
    if (!services.crypto) {
      setCommitError('Crypto service not available');
      return;
    }

    // Filter out active (still running) entries — can't commit those
    const stoppedIds = entryIds.filter((id) => {
      const e = allEntries.find((x) => x.entry_id === id);
      return e && !e.is_active;
    });
    if (stoppedIds.length === 0) {
      setCommitResult({
        type: 'info',
        message: 'Can only commit completed entries. Stop active tasks first.',
      });
      return;
    }

    setCommitting(true);
    setCommitError(null);
    setCommitResult(null);

    try {
      const result = await commitEntries(stoppedIds);
      if (result && result.committedEntryIds && result.committedEntryIds.length > 0) {
        setCommitResult({
          type: 'success',
          message: `Committed ${result.committedEntryIds.length} entry${result.committedEntryIds.length !== 1 ? 'ies' : 'y'} (block ${result.blockIndex})`,
          count: result.committedEntryIds.length,
          blockIndex: result.blockIndex,
        });
        // Remove committed entries from selection
        setSelectedIds((prev) => {
          const next = new Set(prev);
          for (const id of result.committedEntryIds) {
            next.delete(id);
          }
          return next;
        });
        // Collapse committed entries
        setExpandedIds((prev) => {
          const next = new Set(prev);
          for (const id of result.committedEntryIds) {
            next.delete(id);
          }
          return next;
        });
      } else {
        setCommitResult({
          type: 'info',
          message: 'No entries were committed (they may already be committed or the data was unchanged).',
        });
      }
      // Refresh after commit
      await refreshEntries();
    } catch (err) {
      setCommitError(err.message || 'Commit failed');
      setCommitResult(null);
    } finally {
      setCommitting(false);
    }
  }, [commitEntries, services.crypto, refreshEntries, allEntries]);

  const handleCommitSelected = useCallback(() => {
    handleCommit(Array.from(selectedIds));
  }, [handleCommit, selectedIds]);

  const handleCommitAll = useCallback(() => {
    handleCommit(allEntries.map((e) => e.entry_id));
  }, [handleCommit, allEntries]);

  // ── Sync Now ────────────────────────────────────────────────────

  const handleSyncNow = useCallback(async () => {
    if (!sync || syncing) return;
    setSyncing(true);
    setRemoteStatus(STATUS_SYNCING);
    setLastSyncResult(null);
    try {
      const result = await sync.checkAndSync();
      setRemoteStatus(result);
      setLastSyncResult(result === STATUS_READY ? 'Sync completed' : result);
    } catch (err) {
      setRemoteStatus(STATUS_OFFLINE);
      setLastSyncResult(`Error: ${err.message}`);
    } finally {
      setSyncing(false);
    }
  }, [sync, syncing]);

  // ── Auto-clear commit error after 8 seconds ─────────────────────

  useEffect(() => {
    if (commitError || commitResult) {
      if (errorTimer.current) clearTimeout(errorTimer.current);
      errorTimer.current = setTimeout(() => {
        setCommitError(null);
        setCommitResult(null);
      }, 8000);
    }
    return () => {
      if (errorTimer.current) clearTimeout(errorTimer.current);
    };
  }, [commitError, commitResult]);

  // ── Compute live elapsed for all entries ────────────────────────
  // Use the activeElapsedMap for running entries, compute static
  // duration for completed entries.

  const computeElapsed = useCallback((entry) => {
    if (entry.is_active) {
      return activeElapsedMap[entry.entry_id] || 0;
    }
    return entry.duration || 0;
  }, [activeElapsedMap]);

  // ── Render entry pill ───────────────────────────────────────────

  const renderCompactPill = (entry) => {
    const isSelected = selectedIds.has(entry.entry_id);
    const isExpanded = expandedIds.has(entry.entry_id);
    const elapsed = computeElapsed(entry);
    const isRunning = entry.is_active && !entry.is_paused;
    const isPaused = entry.is_active && entry.is_paused;
    const canCommit = !entry.is_active; // only stopped entries can be committed
    const tags = entry.tags || [];
    const visibleTags = tags.slice(0, 3);
    const extraTagCount = tags.length - 3;

    // Editing state for this entry (only for stopped, expanded entries)
    const currentTags = canCommit && editTags[entry.entry_id] !== undefined
      ? editTags[entry.entry_id]
      : tags;
    const currentTagInput = editTagInputs[entry.entry_id] || '';
    const currentComment = canCommit && editComments[entry.entry_id] !== undefined
      ? editComments[entry.entry_id]
      : (entry.comment || '');
    const isSaving = saving[entry.entry_id] || false;

    return (
      <div
        key={entry.entry_id}
        className={`sync-pill ${
          canCommit ? 'sync-pill-commitable' : 'sync-pill-not-commitable'
        } ${isSelected ? 'sync-pill-selected' : ''} ${
          isRunning ? 'sync-pill-running' : ''
        } ${isPaused ? 'sync-pill-paused' : ''} ${
          isExpanded ? 'sync-pill-expanded' : ''
        }`}
        onClick={() => {
          if (canCommit) handleCardClick(entry.entry_id);
        }}
        role={canCommit ? 'button' : undefined}
        tabIndex={canCommit ? 0 : undefined}
        onKeyDown={(e) => {
          if (canCommit && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            handleCardClick(entry.entry_id);
          }
        }}
        title={canCommit ? 'Click to expand details' : 'Task still running — stop it first to commit'}
      >
        {/* ── Main row (always visible) ────────────────────────── */}
        <div className="sync-pill-main">
          {/* Checkbox — only for commitable (stopped) entries */}
          {canCommit && (
            <div className="sync-pill-check" onClick={(e) => toggleSelect(entry.entry_id, e)}>
              <span className={`sync-pill-checkbox ${isSelected ? 'sync-pill-checked' : ''}`}>
                {isSelected && '✓'}
              </span>
            </div>
          )}

          {/* Status dot */}
          <div className="sync-pill-status-dot">
            {isRunning && <Icons.play size={12} />}
            {isPaused && <Icons.pause size={12} />}
            {canCommit && <Icons.stop size={12} />}
          </div>

          {/* Lock icon for non-commitable entries */}
          {!canCommit && (
            <div className="sync-pill-lock-indicator">
              <Icons.lock size={12} />
            </div>
          )}

          {/* Title + inline tags hint */}
          <div className="sync-pill-info">
            <span className="sync-pill-title">{entry.title}</span>
            {!isExpanded && tags.length > 0 && (
              <span className="sync-pill-tags">
                {visibleTags.map((t, i) => (
                  <span key={i} className="sync-pill-tag">#{t}</span>
                ))}
                {extraTagCount > 0 && (
                  <span className="sync-pill-tag-more">+{extraTagCount}</span>
                )}
              </span>
            )}
            {!isExpanded && !tags.length && entry.comment && (
              <span className="sync-pill-comment-preview">{entry.comment}</span>
            )}
          </div>

          {/* Duration / elapsed */}
          <div className="sync-pill-duration">
            {isRunning && <span className="sync-pill-live-dot" />}
            <span className={`sync-pill-time ${isRunning ? 'sync-pill-time-live' : ''}`}>
              {formatDuration(elapsed)}
            </span>
          </div>

          {/* Expand indicator */}
          {canCommit && (
            <span className={`sync-pill-chevron ${isExpanded ? 'sync-pill-chevron-up' : ''}`}>
              ▶
            </span>
          )}
        </div>

        {/* ── Expanded details: tags and comment (stopped entries only) ── */}
        {canCommit && isExpanded && (
          <div className="sync-pill-details" onClick={(e) => e.stopPropagation()}>
            {/* Tags — editable */}
            <div className="sync-pill-detail-tags">
              {currentTags.map((tag, i) => (
                <span key={i} className="tag-badge">
                  #{tag}
                  <button
                    className="tag-badge-remove"
                    onClick={() => removeTag(entry.entry_id, tag)}
                    title={`Remove #${tag}`}
                    aria-label={`Remove tag ${tag}`}
                  >
                    ×
                  </button>
                </span>
              ))}
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
                />
              </span>
              {isSaving && <span className="saving-spinner" />}
            </div>

            {/* Comment — editable textarea */}
            <textarea
              className="sync-pill-comment-edit"
              placeholder="Add a comment…"
              value={currentComment}
              onChange={(e) => handleCommentChange(entry.entry_id, e.target.value)}
              onBlur={() => handleCommentBlur(entry.entry_id)}
              rows={2}
            />
          </div>
        )}
      </div>
    );
  };

  // ── Main Render ─────────────────────────────────────────────────

  const uncommittedCount = allEntries.length;
  const selectedCount = selectedIds.size;
  const commitAllCount = allEntries.filter((e) => !e.is_active).length;

  return (
    <div className="screen">
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="screen-header">
        <h2 className="screen-title">Sync</h2>
        <div className="screen-header-actions">
          {commitResult && (
            <span className={`sync-result-inline ${
              commitResult.type === 'success' ? 'sync-result-inline-ok' : 'sync-result-inline-info'
            }`}>
              {commitResult.message}
            </span>
          )}
          <button className="btn btn-ghost" onClick={refreshEntries} title="Refresh">
            <Icons.sync size={16} />
          </button>
        </div>
      </div>

      {/* ── Sync area: entries + commit buttons + status ──────── */}
      <div className="sync-area">
        {/* ── Entries list ─────────────────────────────────────── */}
        <div className="sync-entries-scroll">
          {loading && (
            <div className="pane-empty">
              <div className="pane-spinner" />
              <p>Loading entries...</p>
            </div>
          )}

          {!loading && allEntries.length === 0 && (
            <div className="pane-empty">
              <span className="pane-empty-icon"><Icons.syncReady size={32} /></span>
              <p>All caught up!</p>
              <p className="pane-hint">All entries have been committed to the ledger</p>
            </div>
          )}

          {!loading && allEntries.length > 0 && (
            <div className="sync-compact-pills">
              {allEntries.map(renderCompactPill)}
            </div>
          )}
        </div>

        {/* ── Commit buttons ───────────────────────────────────── */}
        {allEntries.length > 0 && (
          <div className="sync-commit-bar">
            {/* Selection controls */}
            <div className="sync-commit-selection">
              <span className="sync-commit-count">
                {selectedCount} of {uncommittedCount} selected
              </span>
              {selectedCount > 0 && selectedCount < uncommittedCount && (
                <button className="btn btn-ghost btn-sm" onClick={selectAll}>
                  Select all
                </button>
              )}
              {selectedCount > 0 && (
                <button className="btn btn-ghost btn-sm" onClick={deselectAll}>
                  Clear
                </button>
              )}
            </div>

            {/* Action buttons */}
            <div className="sync-commit-actions">
              <button
                className="btn btn-primary btn-sync-commit"
                onClick={handleCommitSelected}
                disabled={selectedCount === 0 || committing}
              >
                {committing ? '↻ Committing...' : `Commit Selected${selectedCount > 0 ? ` (${selectedCount})` : ''}`}
              </button>
              <button
                className="btn btn-secondary btn-sync-commit"
                onClick={handleCommitAll}
                disabled={commitAllCount === 0 || committing}
              >
                {committing ? '↻ Committing...' : `Commit All${commitAllCount > 0 ? ` (${commitAllCount})` : ''}`}
              </button>
            </div>

            {/* Commit error */}
            {commitError && (
              <div className="sync-result sync-result-error">
                ⚠ {commitError}
              </div>
            )}
          </div>
        )}

        {/* ── Status section ───────────────────────────────────── */}
        <div className="sync-details">
          <div className="sync-detail-row">
            <span className="sync-detail-label">Status</span>
            <SyncIndicator status={displayStatus} />
          </div>

          <div className="sync-detail-row">
            <span className="sync-detail-label">Last push</span>
            <span className="sync-detail-value">{formatTime(sync?.lastPushAt)}</span>
          </div>

          <div className="sync-detail-row">
            <span className="sync-detail-label">Remote</span>
            <span className="sync-detail-value sync-detail-remote">
              {sync?.isRemoteAvailable ? '✅ Configured' : '⬜ Not configured'}
            </span>
          </div>

          {/* Sync Now button */}
          <button
            className="btn btn-primary btn-sync-now"
            onClick={handleSyncNow}
            disabled={syncing || !sync || !sync.isRemoteAvailable}
          >
            {syncing ? '↻ Syncing...' : '↻ Sync Now'}
          </button>

          {/* Last sync result */}
          {lastSyncResult && (
            <div className={`sync-result ${
              lastSyncResult === 'Sync completed' || lastSyncResult === STATUS_READY
                ? 'sync-result-ok'
                : 'sync-result-error'
            }`}>
              {lastSyncResult === 'Sync completed' || lastSyncResult === STATUS_READY
                ? '✓ Sync completed successfully'
                : `⚠ ${lastSyncResult}`
              }
            </div>
          )}

          <p className="sync-hint">
            Syncs local staging entries with the remote blob.
            Background auto-sync coming in Phase 2.
          </p>
        </div>
      </div>
    </div>
  );
}
