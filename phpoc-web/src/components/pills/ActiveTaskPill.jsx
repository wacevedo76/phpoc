import React, { useMemo } from 'react';
import { Icons } from '../ui/Icons.jsx';

/**
 * Format epoch ms to a short time string (e.g. "2:14 PM").
 */
function formatTime(epoch) {
  if (!epoch) return '';
  return new Date(epoch).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * ActiveTaskPill — pill-shaped button representing one active activity.
 *
 * Layout inside the pill (top-to-bottom, left-to-right):
 *
 *   ┌──────────────────────────────┐
 *   │  Coding Practice    01:23:45 │  ← Title + elapsed
 *   │  Started 2:14 PM  ⏸ 3:30 PM │  ← Start time + pause state
 *   │  ─────────────────────────── │
 *   │  ▶       │       ⏹          │  ← Pause/Play (left)  Stop (right)
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

  // Compute pause info: current active pause (if paused) and completed pause count
  const pauseInfo = useMemo(() => {
    const pauses = task.pauses || [];
    const completedPauses = pauses.filter(p => p.pause_stop != null);
    const activePause = pauses.find(p => p.pause_stop == null);
    return { completedPauses, activePause, totalPauses: pauses.length };
  }, [task.pauses]);

  const tagEls = task.tags?.length > 0 && (
    <div className="pill-tags">
      {task.tags.slice(0, 2).map((tag, i) => (
        <span key={i} className="pill-tag">#{tag}</span>
      ))}
      {task.tags.length > 2 && <span className="pill-tag-more">+{task.tags.length - 2}</span>}
    </div>
  );

  // Timestamps row: lock icon + start time + pause state (labels dim, values colored)
  const timestampEls = (
    <div className="pill-timestamps">
      <span className="pill-encrypted-icon" title="Data is encrypted in the ledger">
        <Icons.lock size={9} />
      </span>
      <span className="pill-start-time" title={`Started ${new Date(task.start_epoch).toLocaleString()}`}>
        <span className="pill-label">Started</span>{' '}
        <span className="pill-data">{formatTime(task.start_epoch)}</span>
      </span>
      {task.is_paused && pauseInfo.activePause && (
        <span className="pill-pause-now" title={`Paused at ${new Date(pauseInfo.activePause.pause_start).toLocaleString()}`}>
          <span className="pill-label">⏸ Paused</span>{' '}
          <span className="pill-data">{formatTime(pauseInfo.activePause.pause_start)}</span>
        </span>
      )}
      {pauseInfo.completedPauses.length > 0 && (
        <span className="pill-pause-count" title={`${pauseInfo.completedPauses.length} pause(s) completed`}>
          {pauseInfo.completedPauses.length} pause{pauseInfo.completedPauses.length !== 1 ? 's' : ''}
        </span>
      )}
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
        {timestampEls}
      </div>

      {/* Bottom half: Pause/Play (left) | Stop (right) */}
      <div className="pill-bottom">
        <button
          className="pill-btn pill-pause-btn"
          onClick={handlePauseResume}
          title={task.is_paused ? 'Resume' : 'Pause'}
          aria-label={task.is_paused ? 'Resume task' : 'Pause task'}
        >
          {task.is_paused ? <Icons.play size={16} /> : <Icons.pause size={16} />}
        </button>
        <div className="pill-divider" />
        <button
          className="pill-btn pill-stop-btn"
          onClick={handleStop}
          disabled={stopping}
          title="Stop task"
          aria-label="Stop task"
        >
          <Icons.stop size={16} />
        </button>
      </div>
    </div>
  );
}
