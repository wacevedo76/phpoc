/**
 * TopicIndex — tag chips + counts + filter (Commonplace Slice 3).
 *
 * Renders one chip per distinct tag (plus an "untagged" bucket when present)
 * labelled `"{tag} ({count})"`. Clicking a chip toggles the topic filter:
 * selecting it restricts the entry list; clicking it again clears the filter.
 */

import React from 'react';

export default function TopicIndex({ tagIndex = {}, activeTopic = null, onSelect }) {
  const tags = Object.keys(tagIndex);

  if (tags.length === 0) return null;

  return (
    <div className="commonplace-topic-index" data-testid="commonplace-topic-index">
      {tags.map((tag) => (
        <button
          key={tag}
          type="button"
          className={
            'commonplace-topic-chip' +
            (activeTopic === tag ? ' commonplace-topic-chip-active' : '')
          }
          onClick={() => onSelect(tag)}
        >
          {tag} ({tagIndex[tag]})
        </button>
      ))}
    </div>
  );
}
