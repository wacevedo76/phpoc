import React, { useState, useCallback } from 'react';
import { useApp } from '../../context/DevModeContext.jsx';
import { Icons } from '../ui/Icons.jsx';

/**
 * NewTask — standalone task creation screen.
 *
 * Alternative entry point to start a task (the Dashboard also has
 * a new-task form in its lower pane). This screen gives more space
 * for the form and can include quick-add presets later.
 */
export default function NewTask() {
  const { services } = useApp();
  const sync = services.sync;

  const [title, setTitle] = useState('');
  const [tags, setTags] = useState('');
  const [comment, setComment] = useState('');
  const [status, setStatus] = useState(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = useCallback(async (e) => {
    e.preventDefault();
    if (!title.trim() || !sync) return;

    setStatus('Starting...');
    setSuccess(false);

    try {
      const tagList = tags.split(',')
        .map(t => t.trim())
        .filter(Boolean);

      const hash = await sync.capture({
        title: title.trim(),
        startEpoch: Date.now(),
        tags: tagList,
        comment: comment.trim() || null,
      });

      setStatus(`✓ "${title.trim()}" started!`);
      setSuccess(true);

      // Reset form after 2 seconds
      setTimeout(() => {
        setTitle('');
        setTags('');
        setComment('');
        setStatus(null);
        setSuccess(false);
      }, 2000);
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    }
  }, [title, tags, comment, sync]);

  return (
    <div className="screen">
      <div className="screen-header">
        <h2 className="screen-title">New Task</h2>
      </div>

      <form className="new-task-form new-task-form-full" onSubmit={handleSubmit}>
        <div className="form-group">
          <label htmlFor="nt-title" className="form-label">Title</label>
          <input
            id="nt-title"
            type="text"
            className="form-input form-input-lg"
            placeholder="What are you working on?"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
          />
        </div>

        <div className="form-group">
          <label htmlFor="nt-tags" className="form-label">
            Tags <span className="form-label-hint">(comma-separated)</span>
          </label>
          <input
            id="nt-tags"
            type="text"
            className="form-input"
            placeholder="e.g. coding, work, project-x"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
          />
        </div>

        <div className="form-group">
          <label htmlFor="nt-comment" className="form-label">Comment (optional)</label>
          <textarea
            id="nt-comment"
            className="form-input form-textarea"
            rows={3}
            placeholder="Add a note..."
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
        </div>

        {status && (
          <p className={`form-status ${success ? 'form-status-ok' : status.startsWith('Error') ? 'form-status-error' : ''}`}>
            {status}
          </p>
        )}

        <button
          type="submit"
          className="btn btn-primary btn-start btn-start-lg"
          disabled={!title.trim() || !!success}
        >
          <Icons.play size={16} /> Start Task
        </button>
      </form>
    </div>
  );
}
