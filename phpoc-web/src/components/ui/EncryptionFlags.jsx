import React from 'react';

/**
 * EncryptionFlags — reusable encryption checkbox group for task creation forms.
 *
 * Renders a master "Encrypt activity details" checkbox that toggles all
 * per-field checkboxes, plus individual checkboxes for title, tags, and comment.
 *
 * Props are state/updater pairs so the parent retains control of encryption
 * flags for capture-param construction.
 */

export default function EncryptionFlags({
  encryptAll, setEncryptAll,
  encryptTitle, setEncryptTitle,
  encryptTags, setEncryptTags,
  encryptComment, setEncryptComment,
}) {
  const handleMasterChange = (e) => {
    const val = e.target.checked;
    setEncryptAll(val);
    setEncryptTitle(val);
    setEncryptTags(val);
    setEncryptComment(val);
  };

  return (
    <div className="form-group">
      <label className="form-label">
        <input
          type="checkbox"
          checked={encryptAll}
          onChange={handleMasterChange}
          aria-label="Encrypt activity details"
        />
        {' '}Encrypt activity details
      </label>
      {!encryptAll && (
        <div className="encrypt-per-field">
          <label className="encrypt-field-label">
            <input
              type="checkbox"
              checked={encryptTitle}
              onChange={(e) => setEncryptTitle(e.target.checked)}
              aria-label="Encrypt title"
            />
            {' '}Encrypt title
          </label>
          <label className="encrypt-field-label">
            <input
              type="checkbox"
              checked={encryptTags}
              onChange={(e) => setEncryptTags(e.target.checked)}
              aria-label="Encrypt tags"
            />
            {' '}Encrypt tags
          </label>
          <label className="encrypt-field-label">
            <input
              type="checkbox"
              checked={encryptComment}
              onChange={(e) => setEncryptComment(e.target.checked)}
              aria-label="Encrypt comment"
            />
            {' '}Encrypt comment
          </label>
        </div>
      )}
    </div>
  );
}
