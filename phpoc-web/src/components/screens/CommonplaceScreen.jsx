/**
 * CommonplaceScreen — the Commonplace Book surface (Commonplace Slice 3).
 *
 * Lists committed passages, shows a verification badge + entry count, renders
 * an empty state, expands a passage on click, opens the add-entry sheet, and
 * filters by topic via the tag index. Receives its `service` as a **prop**
 * (not a context/provider) so it is testable against a mock service.
 *
 * "Edit is add-not-in-place" (D5): there is no in-place edit affordance — the
 * only mutation path is `AddEntrySheet` adding a brand-new entry.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import AddEntrySheet from './AddEntrySheet.jsx';
import TopicIndex from './TopicIndex.jsx';

/** Whether an entry belongs to a topic (or the "untagged" bucket). */
function matchesTopic(entry, topic) {
  if (topic === 'untagged') {
    return !entry.tags || entry.tags.length === 0;
  }
  return Array.isArray(entry.tags) && entry.tags.includes(topic);
}

export default function CommonplaceScreen({ service }) {
  const [entries, setEntries] = useState([]);
  const [verified, setVerified] = useState(true);
  const [tagIndex, setTagIndex] = useState({});
  const [showAdd, setShowAdd] = useState(false);
  const [activeTopic, setActiveTopic] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set());

  const load = useCallback(async () => {
    const nextEntries = await service.readEntries();
    setEntries(nextEntries);
    setTagIndex(await service.buildTagIndex());
    setVerified(await service.verify());
  }, [service]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSave = useCallback(
    async (payload) => {
      await service.addEntry(payload);
      setShowAdd(false);
      await load();
    },
    [service, load],
  );

  const toggleExpand = useCallback((title) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(title)) next.delete(title);
      else next.add(title);
      return next;
    });
  }, []);

  const selectTopic = useCallback((tag) => {
    setActiveTopic((prev) => (prev === tag ? null : tag));
  }, []);

  const visibleEntries = useMemo(() => {
    if (!activeTopic) return entries;
    return entries.filter((entry) => matchesTopic(entry, activeTopic));
  }, [entries, activeTopic]);

  return (
    <div className="commonplace-screen" data-testid="commonplace-screen">
      <header className="commonplace-header">
        <h1>Commonplace</h1>
        <span className="commonplace-count">{entries.length} entries</span>
        <span
          className={
            'commonplace-verify-badge ' +
            (verified ? 'commonplace-verify-ok' : 'commonplace-verify-bad')
          }
          data-testid="commonplace-verify-badge"
        >
          {verified ? 'verified' : 'failed'}
        </span>
        <button
          type="button"
          className="commonplace-add-button"
          aria-label="Add entry"
          onClick={() => setShowAdd(true)}
        >
          Add entry
        </button>
      </header>

      {entries.length === 0 && !showAdd ? (
        <div className="commonplace-empty">
          <p>Your Commonplace is empty</p>
          <p className="commonplace-empty-prompt">Add your first passage to begin.</p>
        </div>
      ) : (
        <TopicIndex
          tagIndex={tagIndex}
          activeTopic={activeTopic}
          onSelect={selectTopic}
        />
      )}

      <ul className="commonplace-entries">
        {visibleEntries.map((entry) => {
          const isExpanded = expanded.has(entry.title);
          return (
            <li
              key={entry.title}
              className="commonplace-entry"
              data-testid="commonplace-entry"
            >
              <button
                type="button"
                className="commonplace-entry-title"
                onClick={() => toggleExpand(entry.title)}
              >
                {entry.title}
              </button>
              <p
                className="commonplace-entry-passage"
                data-testid="commonplace-entry-passage"
                data-expanded={isExpanded ? 'true' : 'false'}
              >
                {entry.entry}
              </p>
              {(entry.tags || []).map((tag) => (
                <span key={tag} className="commonplace-tag">#{tag}</span>
              ))}
            </li>
          );
        })}
      </ul>

      {showAdd && (
        <AddEntrySheet onSave={handleSave} onCancel={() => setShowAdd(false)} />
      )}
    </div>
  );
}
