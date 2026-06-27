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
import { computeDisplayStatus, STATUS_READY, STATUS_NOT_SYNCED, STATUS_OFFLINE, STATUS_REAUTH_NEEDED, STATUS_SYNCING } from '../../sync/display_status.js';

// ── Aliases (kept for local brevity) ────────────────────────────────
const STATUS_REAUTH = STATUS_REAUTH_NEEDED;

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
  const { services, commitEntries, triggerReauth, reauthActive, isAutoSyncing } = useApp();
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
  const [deleting, setDeleting] = useState({});

  // ── Inline editing state (stopped entries only, keyed by entry_id) ─
  const [editTags, setEditTags] = useState({});
  const [editTagInputs, setEditTagInputs] = useState({});
  const [editComments, setEditComments] = useState({});
  const [editEndTimes, setEditEndTimes] = useState({});  // entry_id → end_epoch (ms)
  const [editPauses, setEditPauses] = useState({});        // entry_id → pauses[]
  const [saving, setSaving] = useState({});
  const saveTimers = useRef({});

  // ── Pause adder state (per-entry inline form) ──────────────────
  const [addingPauseFor, setAddingPauseFor] = useState(null); // entry_id or null
  const [newPauseStart, setNewPauseStart] = useState('');     // HH:MM string
  const [newPauseStop, setNewPauseStop] = useState('');       // HH:MM string (optional)

  // ── Sync status ─────────────────────────────────────────────────
  const [remoteStatus, setRemoteStatus] = useState(STATUS_READY);
  const [syncing, setSyncing] = useState(false);
  const [lastSyncResult, setLastSyncResult] = useState(null);

  // ── Genesis mismatch override ───────────────────────────────────
  const [overrideConfirmInput, setOverrideConfirmInput] = useState('');
  const [clearingRemote, setClearingRemote] = useState(false);
  const [overrideError, setOverrideError] = useState(null);

  // Display status: SYNCING (manual or auto) > remote status > NOT_SYNCED
  // (entries pending commit). When remote sync succeeded (READY), show the
  // remote status even if entries exist — "Not Synced" only appears when
  // sync hasn't run or has warnings.
  const displayStatus = computeDisplayStatus({
    syncing,
    isAutoSyncing,
    remoteStatus,
    hasEntries: allEntries.length > 0,
  });

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
      setEditEndTimes({});
      setEditPauses({});
      setAddingPauseFor(null);
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
        setEditEndTimes((s) => { const { [entryId]: _, ...rest } = s; return rest; });
        setEditPauses((s) => { const { [entryId]: _, ...rest } = s; return rest; });
        if (addingPauseFor === entryId) setAddingPauseFor(null);
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
        setEditEndTimes((prev) => {
          if (prev[entry.entry_id] !== undefined) return prev;
          return { ...prev, [entry.entry_id]: entry.end_epoch };
        });
        setEditPauses((prev) => {
          if (prev[entry.entry_id] !== undefined) return prev;
          return { ...prev, [entry.entry_id]: (entry.pauses || []).map((p) => ({ ...p })) };
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
      e.stopPropagation();
      addTag(entryId);
    }
  }, [addTag]);

  // ── End time helpers ──────────────────────────────────────────

  /**
   * Convert epoch ms → HH:MM string (local time).
   */
  const epochToTimeStr = useCallback((epoch) => {
    if (!epoch) return '';
    const d = new Date(epoch);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }, []);

  /**
   * Convert HH:MM + start_epoch date → epoch ms.
   */
  const timeStrToEpoch = useCallback((timeStr, startEpoch) => {
    if (!timeStr || !startEpoch) return null;
    const [h, m] = timeStr.split(':').map(Number);
    if (isNaN(h) || isNaN(m)) return null;
    const d = new Date(startEpoch);
    d.setHours(h, m, 0, 0);
    return d.getTime();
  }, []);

  /**
   * Save end time for an entry via sync.modify().
   * Recalculates duration: duration = (newEnd - start_epoch) - total_pause_ms.
   */
  const saveEndTime = useCallback(async (entryId, newEndEpoch) => {
    const entry = allEntries.find((e) => e.entry_id === entryId);
    if (!entry || entry.is_active) return;
    if (newEndEpoch === null || newEndEpoch === undefined) return;

    setSaving((s) => ({ ...s, [entryId]: true }));
    try {
      // Recalculate duration accounting for pauses
      const pauses = editPauses[entryId] || entry.pauses || [];
      let totalPauseMs = 0;
      for (const p of pauses) {
        if (p.pause_start != null && p.pause_stop != null) {
          totalPauseMs += p.pause_stop - p.pause_start;
        }
      }
      const newDuration = Math.max(0, (newEndEpoch - entry.start_epoch) - totalPauseMs);

      await sync.modify(entry.entry_index, {
        end_epoch: newEndEpoch,
        duration: newDuration,
      });
      setAllEntries((prev) => prev.map((e) =>
        e.entry_id === entryId ? { ...e, end_epoch: newEndEpoch, duration: newDuration } : e
      ));
    } catch (err) {
      console.warn('Failed to save end time:', err);
    } finally {
      setSaving((s) => ({ ...s, [entryId]: false }));
    }
  }, [allEntries, editPauses, sync]);

  /**
   * Quick-adjust end time by an offset in minutes.
   */
  const quickAdjustEndTime = useCallback((entryId, offsetMinutes) => {
    const currentEnd = editEndTimes[entryId];
    if (currentEnd === undefined || currentEnd === null) return;
    const newEnd = currentEnd + offsetMinutes * 60000;
    // Clamp: end time cannot be before start time
    const entry = allEntries.find((e) => e.entry_id === entryId);
    const earliest = entry ? entry.start_epoch + 60000 : currentEnd - 3600000; // min 1 min duration
    const clamped = Math.max(newEnd, earliest);
    setEditEndTimes((prev) => ({ ...prev, [entryId]: clamped }));
    saveEndTime(entryId, clamped);
  }, [editEndTimes, allEntries, saveEndTime]);

  const handleEndTimeChange = useCallback((entryId, timeStr) => {
    const entry = allEntries.find((e) => e.entry_id === entryId);
    if (!entry) return;
    const newEpoch = timeStrToEpoch(timeStr, entry.start_epoch);
    if (newEpoch !== null) {
      setEditEndTimes((prev) => ({ ...prev, [entryId]: newEpoch }));
      saveEndTime(entryId, newEpoch);
    }
  }, [allEntries, timeStrToEpoch, saveEndTime]);

  /**
   * Format ms duration → editable string like "1h 15m" or "45m".
   */
  const formatDurationEditable = useCallback((ms) => {
    if (!ms || ms <= 0) return '0m';
    const totalMin = Math.round(ms / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h > 0 && m > 0) return `${h}h ${m}m`;
    if (h > 0) return `${h}h`;
    return `${m}m`;
  }, []);

  /**
   * Parse a duration string → total ms.
   * Supports: "1h30m", "1h 30m", "90m", "1.5h", "45", "1:30"
   * Returns null if unparseable.
   */
  const parseDurationStr = useCallback((str) => {
    const s = str.trim().toLowerCase();
    if (!s) return null;

    // Raw minutes: "45"
    if (/^\d+$/.test(s)) {
      return parseInt(s, 10) * 60000;
    }

    // HH:MM format: "1:30"
    const colonMatch = s.match(/^(\d+):(\d{1,2})$/);
    if (colonMatch) {
      return (parseInt(colonMatch[1], 10) * 60 + parseInt(colonMatch[2], 10)) * 60000;
    }

    let total = 0;
    // Hours: "1.5h", "1h"
    const hMatch = s.match(/([\d.]+)\s*h/);
    if (hMatch) {
      total += Math.round(parseFloat(hMatch[1]) * 60 * 60000);
    }
    // Minutes: "30m"
    const mMatch = s.match(/(\d+)\s*m/);
    if (mMatch) {
      total += parseInt(mMatch[1], 10) * 60000;
    }
    if (total > 0) return total;
    return null;
  }, []);

  /**
   * Handle duration change: parse string, compute new end_epoch.
   * end_epoch = start_epoch + duration_ms + total_pause_ms
   */
  const handleDurationChange = useCallback((entryId, durationStr) => {
    const entry = allEntries.find((e) => e.entry_id === entryId);
    if (!entry) return;

    const durationMs = parseDurationStr(durationStr);
    if (durationMs === null) return;

    // Account for pauses
    const pauses = editPauses[entryId] || entry.pauses || [];
    let totalPauseMs = 0;
    for (const p of pauses) {
      if (p.pause_start != null && p.pause_stop != null) {
        totalPauseMs += p.pause_stop - p.pause_start;
      }
    }

    const newEnd = entry.start_epoch + durationMs + totalPauseMs;
    setEditEndTimes((prev) => ({ ...prev, [entryId]: newEnd }));
    saveEndTime(entryId, newEnd);
  }, [allEntries, editPauses, parseDurationStr, saveEndTime]);

  // ── Pause helpers ─────────────────────────────────────────────

  /**
   * Save pauses for an entry via sync.modify().
   * Recalculates duration.
   */
  const savePauses = useCallback(async (entryId, pauses) => {
    const entry = allEntries.find((e) => e.entry_id === entryId);
    if (!entry || entry.is_active) return;
    setSaving((s) => ({ ...s, [entryId]: true }));
    try {
      // Recalculate duration
      const endEpoch = editEndTimes[entryId] !== undefined ? editEndTimes[entryId] : entry.end_epoch;
      let totalPauseMs = 0;
      for (const p of pauses) {
        if (p.pause_start != null && p.pause_stop != null) {
          totalPauseMs += p.pause_stop - p.pause_start;
        }
      }
      const newDuration = endEpoch
        ? Math.max(0, (endEpoch - entry.start_epoch) - totalPauseMs)
        : 0;

      await sync.modify(entry.entry_index, { pauses, duration: newDuration });
      setAllEntries((prev) => prev.map((e) =>
        e.entry_id === entryId ? { ...e, pauses, duration: newDuration } : e
      ));
    } catch (err) {
      console.warn('Failed to save pauses:', err);
    } finally {
      setSaving((s) => ({ ...s, [entryId]: false }));
    }
  }, [allEntries, editEndTimes, sync]);

  const removePause = useCallback((entryId, pauseIndex) => {
    const current = editPauses[entryId];
    if (!current) return;
    const updated = current.filter((_, i) => i !== pauseIndex);
    setEditPauses((prev) => ({ ...prev, [entryId]: updated }));
    savePauses(entryId, updated);
  }, [editPauses, savePauses]);

  const addPause = useCallback((entryId) => {
    const entry = allEntries.find((e) => e.entry_id === entryId);
    if (!entry) return;

    const startStr = newPauseStart.trim();
    if (!startStr) return;

    const pauseStart = timeStrToEpoch(startStr, entry.start_epoch);
    if (pauseStart === null) return;

    let pauseStop = null;
    const stopStr = newPauseStop.trim();
    if (stopStr) {
      pauseStop = timeStrToEpoch(stopStr, entry.start_epoch);
      if (pauseStop === null) return;
      // Ensure stop > start
      if (pauseStop <= pauseStart) {
        pauseStop = pauseStart + 60000; // min 1 min pause
      }
    }

    const current = editPauses[entryId] || [];
    const newPause = { pause_start: pauseStart, pause_stop: pauseStop };
    // Insert sorted by pause_start
    const insertIdx = current.findIndex((p) => p.pause_start > pauseStart);
    const updated = insertIdx === -1
      ? [...current, newPause]
      : [...current.slice(0, insertIdx), newPause, ...current.slice(insertIdx)];

    setEditPauses((prev) => ({ ...prev, [entryId]: updated }));
    setAddingPauseFor(null);
    setNewPauseStart('');
    setNewPauseStop('');
    savePauses(entryId, updated);
  }, [allEntries, newPauseStart, newPauseStop, editPauses, timeStrToEpoch, savePauses]);

  const cancelAddPause = useCallback(() => {
    setAddingPauseFor(null);
    setNewPauseStart('');
    setNewPauseStop('');
  }, []);

  // ── Delete entry from staging ───────────────────────────────

  const handleDelete = useCallback(async (entryId, entryIndex, e) => {
    e?.stopPropagation();
    const entry = allEntries.find((x) => x.entry_id === entryId);
    if (!entry) return;

    setDeleting((s) => ({ ...s, [entryId]: true }));
    try {
      await sync.remove(entryIndex);
      // Remove from local state
      setAllEntries((prev) => prev.filter((e) => e.entry_id !== entryId));
      setSelectedIds((prev) => { const n = new Set(prev); n.delete(entryId); return n; });
      setExpandedIds((prev) => { const n = new Set(prev); n.delete(entryId); return n; });
      // Clean up editing state
      setEditTags((s) => { const { [entryId]: _, ...rest } = s; return rest; });
      setEditTagInputs((s) => { const { [entryId]: _, ...rest } = s; return rest; });
      setEditComments((s) => { const { [entryId]: _, ...rest } = s; return rest; });
      setEditEndTimes((s) => { const { [entryId]: _, ...rest } = s; return rest; });
      setEditPauses((s) => { const { [entryId]: _, ...rest } = s; return rest; });
    } catch (err) {
      console.warn('Failed to delete entry:', err);
    } finally {
      setDeleting((s) => ({ ...s, [entryId]: false }));
    }
  }, [allEntries, sync]);

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
  // Mirrors the CLI `sync` command: check_and_sync → commit to ledger.
  // Step 1: sync staging blob with remote (pull/merge/push).
  // Step 2: commit all completed (not active) entries to the ledger.

  const handleSyncNow = useCallback(async () => {
    if (!sync || syncing) return;
    setSyncing(true);
    setRemoteStatus(STATUS_SYNCING);
    setLastSyncResult(null);
    try {
      // Step 1 — sync staging with remote
      const result = await sync.checkAndSync();
      if (result === STATUS_REAUTH) {
        triggerReauth();
        setRemoteStatus(STATUS_REAUTH);
        setLastSyncResult('Authentication required. Enter your passphrase.');
        return;
      }
      if (result === 'GENESIS_MISMATCH') {
        setRemoteStatus(result);
        setLastSyncResult('GENESIS_MISMATCH');
        return;
      }
      setRemoteStatus(result);

      // Step 2 — commit all completed entries to the ledger.
      // Re-read entries fresh (allEntries from the closure may be stale
      // if checkAndSync modified staging via merge).
      const freshEntries = await sync.readEntries();
      const stoppedIds = freshEntries
        .filter((e) => !e.is_active && !e.committed)
        .map((e) => e.entry_id);

      if (stoppedIds.length > 0) {
        setCommitting(true);
        try {
          const commitResult = await commitEntries(stoppedIds);
          if (commitResult && commitResult.committedEntryIds && commitResult.committedEntryIds.length > 0) {
            setCommitResult({
              type: 'success',
              message: `Committed ${commitResult.committedEntryIds.length} entry${commitResult.committedEntryIds.length !== 1 ? 'ies' : 'y'}`,
              count: commitResult.committedEntryIds.length,
              blockIndex: commitResult.blockIndex,
            });
            // Remove committed from selection
            setSelectedIds((prev) => {
              const next = new Set(prev);
              for (const id of commitResult.committedEntryIds) next.delete(id);
              return next;
            });
            setExpandedIds((prev) => {
              const next = new Set(prev);
              for (const id of commitResult.committedEntryIds) next.delete(id);
              return next;
            });
          }
          await refreshEntries();
        } catch (err) {
          setCommitError(err.message || 'Commit failed');
        } finally {
          setCommitting(false);
        }
      }

      setLastSyncResult(result === STATUS_READY ? 'Sync completed' : result);
    } catch (err) {
      setRemoteStatus(STATUS_OFFLINE);
      setLastSyncResult(`Error: ${err.message}`);
    } finally {
      setSyncing(false);
    }
  }, [sync, syncing, triggerReauth, allEntries, commitEntries, refreshEntries]);

  // ── Clear Remote & Overwrite (genesis mismatch override) ────────
  // Deletes all blobs from the remote R2 bucket via HTTP DELETE,
  // then re-syncs to push the local ledger as authoritative.

  const handleClearAndOverwrite = useCallback(async () => {
    if (!sync || overrideConfirmInput !== 'DELETE') return;
    setClearingRemote(true);
    setOverrideError(null);
    try {
      await sync.clearRemote();

      // Clear the override UI state
      setOverrideConfirmInput('');

      // Re-run sync — remote is now empty, genesis will be compatible
      setSyncing(true);
      setRemoteStatus(STATUS_SYNCING);
      setLastSyncResult(null);

      const result = await sync.checkAndSync();
      if (result === STATUS_REAUTH) {
        triggerReauth();
        setRemoteStatus(STATUS_REAUTH);
        setLastSyncResult('Authentication required. Enter your passphrase.');
        return;
      }
      setRemoteStatus(result);

      // Commit completed entries
      const freshEntries = await sync.readEntries();
      const stoppedIds = freshEntries
        .filter((e) => !e.is_active && !e.committed)
        .map((e) => e.entry_id);

      if (stoppedIds.length > 0) {
        setCommitting(true);
        try {
          const commitResult = await commitEntries(stoppedIds);
          if (commitResult?.committedEntryIds?.length > 0) {
            setCommitResult({
              type: 'success',
              message: `Committed ${commitResult.committedEntryIds.length} entry${commitResult.committedEntryIds.length !== 1 ? 'ies' : 'y'}`,
              count: commitResult.committedEntryIds.length,
              blockIndex: commitResult.blockIndex,
            });
            setSelectedIds((prev) => {
              const next = new Set(prev);
              for (const id of commitResult.committedEntryIds) next.delete(id);
              return next;
            });
            setExpandedIds((prev) => {
              const next = new Set(prev);
              for (const id of commitResult.committedEntryIds) next.delete(id);
              return next;
            });
          }
          await refreshEntries();
        } catch (err) {
          setCommitError(err.message || 'Commit failed');
        } finally {
          setCommitting(false);
        }
      }

      setLastSyncResult(result === STATUS_READY ? 'Remote cleared and sync completed' : result);
    } catch (err) {
      setOverrideError(err.message || 'Failed to clear remote');
      setRemoteStatus(STATUS_OFFLINE);
    } finally {
      setClearingRemote(false);
      setSyncing(false);
    }
  }, [sync, overrideConfirmInput, triggerReauth, commitEntries, refreshEntries]);

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

  // When reauth overlay dismisses, clear the REAUTH_NEEDED error so the
  // user sees a clean slate. They can press "Sync Now" to retry (the
  // master key is now cached so it should succeed).
  const prevReauthRef = useRef(false);
  useEffect(() => {
    if (prevReauthRef.current && !reauthActive) {
      setRemoteStatus(STATUS_NOT_SYNCED);
      setLastSyncResult(null);
    }
    prevReauthRef.current = reauthActive;
  }, [reauthActive]);

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
          <div className="sync-pill-details" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
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

            {/* ── Delete from staging ──────────────────────────── */}
            <div className="sync-pill-delete-row">
              <button
                type="button"
                className="btn btn-danger btn-xs sync-pill-delete-btn"
                onClick={(e) => handleDelete(entry.entry_id, entry.entry_index, e)}
                disabled={deleting[entry.entry_id]}
                title="Remove this entry from staging (not yet synced)"
              >
                {deleting[entry.entry_id] ? '⋯' : '🗑 Delete from staging'}
              </button>
            </div>

            {/* ── End time adjustment ─────────────────────────── */}
            <EndTimeEditor
              entry={entry}
              editEndTimes={editEndTimes}
              editPauses={editPauses}
              epochToTimeStr={epochToTimeStr}
              formatDurationEditable={formatDurationEditable}
              onEndTimeChange={handleEndTimeChange}
              onDurationChange={handleDurationChange}
              onQuickAdjust={quickAdjustEndTime}
              saving={isSaving}
            />

            {/* ── Pauses section ──────────────────────────────── */}
            <PausesEditor
              entry={entry}
              editPauses={editPauses}
              addingPauseFor={addingPauseFor}
              newPauseStart={newPauseStart}
              newPauseStop={newPauseStop}
              epochToTimeStr={epochToTimeStr}
              saving={isSaving}
              onRemovePause={removePause}
              onStartAddPause={setAddingPauseFor}
              onSetPauseStart={setNewPauseStart}
              onSetPauseStop={setNewPauseStop}
              onAddPause={addPause}
              onCancelAddPause={cancelAddPause}
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
              lastSyncResult === 'Sync completed' || lastSyncResult === STATUS_READY || lastSyncResult === 'Remote cleared and sync completed'
                ? 'sync-result-ok'
                : lastSyncResult.startsWith('Authentication required')
                ? 'sync-result-reauth'
                : 'sync-result-error'
            }`}>
              {lastSyncResult === 'Sync completed' || lastSyncResult === STATUS_READY
                ? '✓ Sync completed successfully'
                : lastSyncResult === 'Remote cleared and sync completed'
                ? '✓ Remote cleared and sync completed'
                : lastSyncResult.startsWith('Authentication required')
                ? `🔐 ${lastSyncResult}`
                : `⚠ ${lastSyncResult}`
              }
            </div>
          )}

          {/* Genesis mismatch — Clear Remote & Overwrite */}
          {lastSyncResult === 'GENESIS_MISMATCH' && (
            <div className="sync-result-override">
              <div className="override-warning">
                <Icons.syncPending size={16} />
                <span>The remote ledger has a <strong>different genesis block</strong> from this device. It belongs to a different recovery seed.</span>
              </div>

              <p className="override-description">
                To use this device's ledger with this remote, you must clear all
                data from the remote bucket. This will <strong>permanently delete</strong> all
                entries, staging data, and device cookies stored on the remote.
              </p>

              <div className="form-group">
                <label className="form-label" htmlFor="override-confirm">
                  Type <code>DELETE</code> to confirm:
                </label>
                <input
                  id="override-confirm"
                  type="text"
                  className="form-input override-confirm-input"
                  placeholder="DELETE"
                  value={overrideConfirmInput}
                  onChange={(e) => {
                    setOverrideConfirmInput(e.target.value);
                    setOverrideError(null);
                  }}
                  disabled={clearingRemote}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>

              {overrideError && (
                <p className="form-status form-status-error">{overrideError}</p>
              )}

              <button
                className="btn btn-danger btn-override"
                onClick={handleClearAndOverwrite}
                disabled={overrideConfirmInput !== 'DELETE' || clearingRemote}
              >
                {clearingRemote
                  ? '↻ Clearing Remote...'
                  : '⚠ Clear Remote & Overwrite'
                }
              </button>
            </div>
          )}

          <p className="sync-hint">
            Syncs staging with remote, then commits completed entries to the ledger.
            Staging changes auto-sync to remote in the background.
          </p>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// EndTimeEditor — inline end-time adjustment for a stopped entry
// ═══════════════════════════════════════════════════════════════════

function EndTimeEditor({
  entry,
  editEndTimes,
  editPauses,
  epochToTimeStr,
  formatDurationEditable,
  onEndTimeChange,
  onDurationChange,
  onQuickAdjust,
  saving,
}) {
  const entryId = entry.entry_id;
  const currentEnd = editEndTimes[entryId];
  const timeStr = epochToTimeStr(currentEnd);

  // Compute active duration (net of pauses)
  const pauses = editPauses[entryId] || entry.pauses || [];
  let totalPauseMs = 0;
  for (const p of pauses) {
    if (p.pause_start != null && p.pause_stop != null) {
      totalPauseMs += p.pause_stop - p.pause_start;
    }
  }
  const endEpoch = currentEnd ?? entry.end_epoch;
  const activeDurationMs = endEpoch
    ? Math.max(0, (endEpoch - entry.start_epoch) - totalPauseMs)
    : 0;

  const [durationInput, setDurationInput] = useState(formatDurationEditable(activeDurationMs));

  // Keep duration input in sync when end time changes externally
  useEffect(() => {
    setDurationInput(formatDurationEditable(activeDurationMs));
  }, [activeDurationMs, formatDurationEditable]);

  const handleDurationKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      onDurationChange(entryId, durationInput);
    }
  };

  const handleDurationBlur = () => {
    onDurationChange(entryId, durationInput);
  };

  return (
    <div className="sync-pill-endtime">
      <div className="sync-pill-endtime-row">
        <span className="sync-pill-endtime-label">End</span>
        <div className="sync-pill-endtime-controls">
          <input
            type="time"
            className="sync-pill-time-input"
            value={timeStr}
            onChange={(e) => onEndTimeChange(entryId, e.target.value)}
            aria-label={`End time for ${entry.title}`}
          />
          <button
            type="button"
            className="btn btn-ghost btn-xs sync-pill-quick-btn"
            onClick={() => onQuickAdjust(entryId, -5)}
            title="Subtract 5 minutes"
          >
            −5m
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-xs sync-pill-quick-btn"
            onClick={() => onQuickAdjust(entryId, 5)}
            title="Add 5 minutes"
          >
            +5m
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-xs sync-pill-quick-btn"
            onClick={() => onQuickAdjust(entryId, 15)}
            title="Add 15 minutes"
          >
            +15m
          </button>
        </div>
      </div>
      <div className="sync-pill-endtime-row">
        <span className="sync-pill-endtime-label">Duration</span>
        <input
          type="text"
          className="sync-pill-time-input sync-pill-duration-input"
          value={durationInput}
          onChange={(e) => setDurationInput(e.target.value)}
          onKeyDown={handleDurationKeyDown}
          onBlur={handleDurationBlur}
          placeholder="e.g. 1h30m"
          aria-label={`Active duration for ${entry.title}`}
        />
      </div>
      {saving && <span className="saving-spinner" />}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// PausesEditor — inline pause management for a stopped entry
// ═══════════════════════════════════════════════════════════════════

function PausesEditor({
  entry,
  editPauses,
  addingPauseFor,
  newPauseStart,
  newPauseStop,
  epochToTimeStr,
  saving,
  onRemovePause,
  onStartAddPause,
  onSetPauseStart,
  onSetPauseStop,
  onAddPause,
  onCancelAddPause,
}) {
  const entryId = entry.entry_id;
  const pauses = editPauses[entryId] || [];
  const isAdding = addingPauseFor === entryId;

  /**
   * Format a pause duration in minutes.
   */
  const fmtPauseDuration = (start, stop) => {
    if (stop == null) return 'open';
    const mins = Math.round((stop - start) / 60000);
    if (mins < 60) return `${mins}m`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  };

  return (
    <div className="sync-pill-pauses">
      <span className="sync-pill-pauses-label">Pauses</span>

      {/* Existing pauses list */}
      {pauses.length > 0 && (
        <div className="sync-pill-pauses-list">
          {pauses.map((p, i) => (
            <div key={i} className="sync-pill-pause-item">
              <span className="sync-pill-pause-icon">⏸</span>
              <span className="sync-pill-pause-times">
                {epochToTimeStr(p.pause_start)}
                {p.pause_stop != null
                  ? ` – ${epochToTimeStr(p.pause_stop)}`
                  : ' – …'}
              </span>
              <span className="sync-pill-pause-dur">
                ({fmtPauseDuration(p.pause_start, p.pause_stop)})
              </span>
              <button
                type="button"
                className="sync-pill-pause-remove"
                onClick={() => onRemovePause(entryId, i)}
                title="Remove this pause"
                aria-label={`Remove pause at ${epochToTimeStr(p.pause_start)}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add pause inline form */}
      {isAdding ? (
        <div className="sync-pill-pause-add-form">
          <span className="sync-pill-pause-add-label">Start</span>
          <input
            type="time"
            className="sync-pill-time-input sync-pill-pause-time-input"
            value={newPauseStart}
            onChange={(e) => onSetPauseStart(e.target.value)}
            aria-label="Pause start time"
          />
          <span className="sync-pill-pause-add-label">End</span>
          <input
            type="time"
            className="sync-pill-time-input sync-pill-pause-time-input"
            value={newPauseStop}
            onChange={(e) => onSetPauseStop(e.target.value)}
            placeholder="optional"
            aria-label="Pause end time (optional)"
          />
          <div className="sync-pill-pause-add-actions">
            <button
              type="button"
              className="btn btn-primary btn-xs"
              onClick={() => onAddPause(entryId)}
              disabled={!newPauseStart.trim()}
            >
              Save
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              onClick={onCancelAddPause}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="btn btn-ghost btn-xs sync-pill-pause-add-btn"
          onClick={() => {
            onSetPauseStart('');
            onSetPauseStop('');
            onStartAddPause(entryId);
          }}
        >
          + Add pause
        </button>
      )}

      {saving && <span className="saving-spinner" />}
    </div>
  );
}
