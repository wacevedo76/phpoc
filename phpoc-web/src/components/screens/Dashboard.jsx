import React, { useState, useCallback } from 'react';
import { useApp } from '../../context/DevModeContext.jsx';
import { useActiveTasks } from '../../hooks/useActiveTasks.js';
import ActiveTaskPill from '../pills/ActiveTaskPill.jsx';
import { Icons } from '../ui/Icons.jsx';
import EncryptionFlags from '../ui/EncryptionFlags.jsx';

/**
 * Dashboard — main screen.
 *
 * Portrait layout:
 *   ┌───────────────────┐
 *   │  Active Tasks     │  ← Top half
 *   │  [Pill] [Pill]    │
 *   ├───────────────────┤
 *   │  Start New Task   │  ← Bottom half
 *   │  [title input]    │
 *   │  [tags] [Start]   │
 *   └───────────────────┘
 *
 * Landscape layout:
 *   ┌──────────┬────────┐
 *   │ Active   │ New    │
 *   │ Tasks    │ Task   │
 *   │ [Pill]   │ ...    │
 *   │ [Pill]   │        │
 *   └──────────┴────────┘
 *     Left        Right
 */
export default function Dashboard() {
  const { services, isDev } = useApp();
  const sync = services.sync;

  const { activeTasks, elapsedMap, loading, refresh } = useActiveTasks(sync);

  // New task form state
  const [newTitle, setNewTitle] = useState('');
  const [newTags, setNewTags] = useState('');
  const [newComment, setNewComment] = useState('');
  const [isOneOff, setIsOneOff] = useState(false);
  const [encryptTitle, setEncryptTitle] = useState(false);
  const [encryptTags, setEncryptTags] = useState(false);
  const [encryptComment, setEncryptComment] = useState(false);
  const [encryptAll, setEncryptAll] = useState(false);
  const [statusMsg, setStatusMsg] = useState(null);
  const [newTaskCollapsed, setNewTaskCollapsed] = useState(true);

  // Handle starting a new task
  const handleStartTask = useCallback(async (e) => {
    e?.preventDefault();
    if (!newTitle.trim()) return;
    if (!sync) return;

    const now = Date.now();

    try {
      const encFlags = {
        encrypt_title: encryptAll || encryptTitle,
        encrypt_tags: encryptAll || encryptTags,
        encrypt_comment: encryptAll || encryptComment,
      };

      if (isOneOff) {
        setStatusMsg(`Logging "${newTitle.trim()}"...`);
        await sync.capture({
          title: newTitle.trim(),
          startEpoch: now,
          endEpoch: now,
          isActive: false,
          comment: newComment.trim() || null,
          tags: newTags.split(',')
            .map(t => t.trim())
            .filter(Boolean),
          ...encFlags,
        });
      } else {
        setStatusMsg(`Starting "${newTitle.trim()}"...`);
        await sync.capture({
          title: newTitle.trim(),
          startEpoch: now,
          comment: newComment.trim() || null,
          tags: newTags.split(',')
            .map(t => t.trim())
            .filter(Boolean),
          ...encFlags,
        });
      }
      setNewTitle('');
      setNewTags('');
      setNewComment('');
      setIsOneOff(false);
      setEncryptTitle(false);
      setEncryptTags(false);
      setEncryptComment(false);
      setEncryptAll(false);
      setStatusMsg(null);
      setNewTaskCollapsed(true);
      await refresh();
    } catch (err) {
      setStatusMsg(`Error: ${err.message}`);
    }
  }, [newTitle, newTags, newComment, isOneOff, sync, refresh]);

  // Handle pause
  const handlePause = useCallback(async (title) => {
    if (!sync) return;
    try {
      await sync.pause(title, Date.now());
      await refresh();
    } catch (err) {
      console.warn('Pause failed:', err);
    }
  }, [sync, refresh]);

  // Handle resume
  const handleResume = useCallback(async (title) => {
    if (!sync) return;
    try {
      await sync.unpause(title, Date.now());
      await refresh();
    } catch (err) {
      console.warn('Resume failed:', err);
    }
  }, [sync, refresh]);

  // Handle stop
  const handleStop = useCallback(async (title) => {
    if (!sync) return;
    try {
      await sync.end(title, Date.now());
      await refresh();
    } catch (err) {
      console.warn('Stop failed:', err);
    }
  }, [sync, refresh]);

  const handleReveal = useCallback(async (entryId) => {
    if (!sync?.revealEncryptedFields) return;
    try {
      await sync.revealEncryptedFields(entryId);
      await refresh();
    } catch (err) {
      console.warn('Reveal failed:', err);
    }
  }, [sync, refresh]);

  return (
    <div className="dashboard">
      {/* === Active Tasks Pane (top / left) === */}
      <div className="dashboard-active">
        <div className="pane-header">
          <h2 className="pane-title">
            Active Tasks
            {activeTasks.length > 0 && (
              <span className="pane-count">{activeTasks.length}</span>
            )}
          </h2>
        </div>

        <div className="active-tasks-scroll">
          {loading && (
            <div className="pane-empty">
              <div className="pane-spinner" />
              <p>Loading tasks...</p>
            </div>
          )}

          {!loading && activeTasks.length === 0 && (
            <div className="pane-empty">
              <span className="pane-empty-icon"><Icons.clock size={32} /></span>
              <p>No active tasks</p>
              <p className="pane-hint">Start a new task below</p>
            </div>
          )}

          {!loading && activeTasks.length > 0 && (
            <div className="pill-grid">
              {activeTasks.map((task) => {
                const elapsedMs = elapsedMap[task.entry_id] || 0;
                return (
                  <ActiveTaskPill
                    key={task.entry_id}
                    task={task}
                    elapsedMs={elapsedMs}
                    onPause={handlePause}
                    onResume={handleResume}
                    onStop={handleStop}
                    onReveal={handleReveal}
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* === New Task Pane (bottom / right) === */}
      <div className={`dashboard-new-task${newTaskCollapsed ? ' dashboard-new-task-collapsed' : ''}`}>
        {newTaskCollapsed ? (
          <button
            className="new-task-expand-bar"
            onClick={() => setNewTaskCollapsed(false)}
            aria-label="Expand new task form"
          >
            <span className="new-task-expand-label">Start New Task</span>
            <span className="new-task-expand-chevron">▲</span>
          </button>
        ) : (
          <>
            <div className="pane-header new-task-pane-header">
              <h2 className="pane-title">Start New Task</h2>
              <button
                className="btn btn-ghost btn-xs new-task-collapse-btn"
                onClick={() => setNewTaskCollapsed(true)}
                aria-label="Collapse new task form"
                title="Collapse"
              >
                ▼
              </button>
            </div>

            <form className="new-task-form" onSubmit={handleStartTask}>
              <div className="form-group title-row">
                <label htmlFor="task-title" className="form-label">Title</label>
                <div className="title-input-group">
                  <input
                    id="task-title"
                    type="text"
                    className="form-input form-input-lg"
                    placeholder="What are you working on?"
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    autoFocus
                  />
                  <label className="oneoff-checkbox-label">
                    <input
                      type="checkbox"
                      className="oneoff-checkbox"
                      checked={isOneOff}
                      onChange={(e) => setIsOneOff(e.target.checked)}
                    />
                    <span className="oneoff-text">one-off</span>
                  </label>
                </div>
              </div>

              <div className="form-group">
                <label htmlFor="task-tags" className="form-label">
                  Tags <span className="form-label-hint">(comma-separated)</span>
                </label>
                <input
                  id="task-tags"
                  type="text"
                  className="form-input"
                  placeholder="e.g. coding, work, project-x"
                  value={newTags}
                  onChange={(e) => setNewTags(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label htmlFor="task-comment" className="form-label">
                  Comment <span className="form-label-hint">(optional)</span>
                </label>
                <textarea
                  id="task-comment"
                  className="form-input form-textarea"
                  rows={2}
                  placeholder="Add a note..."
                  value={newComment}
                  onChange={(e) => setNewComment(e.target.value)}
                />
              </div>

              <EncryptionFlags
                encryptAll={encryptAll} setEncryptAll={setEncryptAll}
                encryptTitle={encryptTitle} setEncryptTitle={setEncryptTitle}
                encryptTags={encryptTags} setEncryptTags={setEncryptTags}
                encryptComment={encryptComment} setEncryptComment={setEncryptComment}
              />

              {statusMsg && (
                <p className={`form-status ${statusMsg.startsWith('Error') ? 'form-status-error' : ''}`}>
                  {statusMsg}
                </p>
              )}

              <button
                type="submit"
                className="btn btn-primary btn-start"
                disabled={!newTitle.trim()}
              >
                {isOneOff ? (
                  <><Icons.check size={16} /> Log</>
                ) : (
                  <><Icons.play size={16} /> Start</>
                )}
              </button>
            </form>

            {isDev && (
              <div className="dev-mode-indicator">
                <Icons.devMode size={16} /> DEV MODE — Data is in-memory only
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
