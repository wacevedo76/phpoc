/**
 * display_title — title display helpers for encrypted entries.
 *
 * Pure logic extracted from ActiveTaskPill, History, and SyncSettings
 * for consistency and testability.
 */

// ── Constants ─────────────────────────────────────────────────────────

/** Placeholder shown when an encrypted title cannot be displayed. */
export const ENCRYPTED_PLACEHOLDER = '[encrypted]';

// ── Display helpers ───────────────────────────────────────────────────

/**
 * Return the display title for an entry, showing the placeholder when
 * the entry has encrypted fields and no plaintext title is available.
 *
 * @param {object} entry — Entry with optional has_encrypted_fields / title / title_enc
 * @returns {string} Displayable title or placeholder
 */
export function formatDisplayTitle(entry) {
  if (entry.has_encrypted_fields && !entry.title) {
    return ENCRYPTED_PLACEHOLDER;
  }
  return entry.title || '';
}
