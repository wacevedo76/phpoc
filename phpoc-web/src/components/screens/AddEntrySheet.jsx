/**
 * AddEntrySheet — add-entry capture form (Commonplace Slice 3).
 *
 * Captures title / passage / tags / optional ad-hoc note and validates on Save:
 * a blank title → "Please enter a title"; a blank passage → "The passage cannot
 * be empty". On success it calls `onSave({ title, entry, tags, adHoc })` — the
 * tags are split on commas (trimmed, case preserved; the service normalizes
 * them later) and the ad-hoc note becomes `{ note }`. Cancel calls `onCancel`.
 *
 * "Edit is add-not-in-place" (D5): this sheet only ever ADDS a new entry.
 */

import React, { useState } from 'react';

export default function AddEntrySheet({ onSave, onCancel }) {
  const [title, setTitle] = useState('');
  const [passage, setPassage] = useState('');
  const [tags, setTags] = useState('');
  const [adHocNote, setAdHocNote] = useState('');
  const [error, setError] = useState(null);

  const handleSave = () => {
    const trimmedTitle = title.trim();
    const trimmedPassage = passage.trim();

    if (!trimmedTitle) {
      setError('Please enter a title');
      return;
    }
    if (!trimmedPassage) {
      setError('The passage cannot be empty');
      return;
    }

    const tagList = tags
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    const adHoc = adHocNote.trim() ? { note: adHocNote.trim() } : undefined;

    onSave({ title: trimmedTitle, entry: trimmedPassage, tags: tagList, adHoc });
  };

  return (
    <div className="commonplace-add-sheet" data-testid="commonplace-add-sheet">
      <h2>Add a Commonplace entry</h2>

      <label htmlFor="cp-title">Title</label>
      <input
        id="cp-title"
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />

      <label htmlFor="cp-passage">Passage</label>
      <textarea
        id="cp-passage"
        value={passage}
        onChange={(e) => setPassage(e.target.value)}
      />

      <label htmlFor="cp-tags">Tags</label>
      <input
        id="cp-tags"
        type="text"
        value={tags}
        onChange={(e) => setTags(e.target.value)}
      />

      <label htmlFor="cp-adhoc">Ad-hoc note (optional)</label>
      <input
        id="cp-adhoc"
        type="text"
        value={adHocNote}
        onChange={(e) => setAdHocNote(e.target.value)}
      />

      {error && (
        <div className="commonplace-error" role="alert">{error}</div>
      )}

      <div className="commonplace-add-actions">
        <button type="button" className="btn btn-primary" onClick={handleSave}>
          Save
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
