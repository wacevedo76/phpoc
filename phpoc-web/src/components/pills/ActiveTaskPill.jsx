import React from 'react';

/**
 * ActiveTaskPill — pill-shaped button representing one active activity.
 *
 * Layout inside the pill (top-to-bottom, left-to-right):
 *
 *   ┌──────────────────────────────┐
 *   │       Coding Practice        │  ← Title (top half)
 *   │        ⏸️      ⏹️           │  ← Pause/Play (left)  Stop (right)
 *   └──────────────────────────────┘
 *
 * Props:
 *   @param {object} task — StagingEntry object (title, start_epoch, is_paused, pauses, tags)
 *   @param {function} onPause — (taskTitle) => void
 *   @param {function} onResume — (taskTitle) => void
 *   @param {function} onStop — (taskTitle) => void
 *   @param {number} elapsedMs — computed elapsed time in ms
 */
export default function ActiveTaskPill({ task, onPause, onResume, onStop, elapsedMs }) {
  const [stopping, setStopping] = React.useState(false);

  const handleStop = (e) => {
    e.stopPropagation();
    if (stopping) return;
    setStopping(true);
    onStop(task.title);
  };

  const handlePauseResume = (e) => {
    e.stopPropagation();
    if (task.is_paused) {
      onResume(task.title);
    } else {
      onPause(task.title);
    }
  };

  // Format elapsed time as HH:MM:SS or MM:SS
  const formatElapsed = (ms) => {
    if (ms < 0) ms = 0;
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  };

  const tagEls = task.tags?.length > 0 && (
    <div className="pill-tags">
      {task.tags.slice(0, 2).map((tag, i) => (
        <span key={i} className="pill-tag">#{tag}</span>
      ))}
      {task.tags.length > 2 && <span className="pill-tag-more">+{task.tags.length - 2}</span>}
    </div>
  );

  return (
    <div className={`active-task-pill ${task.is_paused ? 'pill-paused' : 'pill-active'}`}>
      {/* Top half: Title + elapsed + tags */}
      <div className="pill-top">
        <div className="pill-title-row">
          <span className="pill-title">{task.title}</span>
          {task.is_paused && <span className="pill-paused-badge">PAUSED</span>}
        </div>
        <span className="pill-elapsed">{formatElapsed(elapsedMs)}</span>
        {tagEls}
      </div>

      {/* Bottom half: Pause/Play (left) | Stop (right) */}
      <div className="pill-bottom">
        <button
          className="pill-btn pill-pause-btn"
          onClick={handlePauseResume}
          title={task.is_paused ? 'Resume' : 'Pause'}
          aria-label={task.is_paused ? 'Resume task' : 'Pause task'}
        >
          {task.is_paused ? '▶' : '⏸'}
        </button>
        <div className="pill-divider" />
        <button
          className="pill-btn pill-stop-btn"
          onClick={handleStop}
          disabled={stopping}
          title="Stop task"
          aria-label="Stop task"
        >
          ⏹
        </button>
      </div>
    </div>
  );
}
