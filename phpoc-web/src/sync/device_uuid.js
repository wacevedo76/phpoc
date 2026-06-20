/**
 * device_uuid.js — Per-device UUID generation and persistence.
 *
 * Generates a crypto.randomUUID() on first boot and persists it in
 * storage under key 'device_uuid'. On subsequent boots, reads the
 * persisted UUID. The UUID is permanent per device — it survives
 * logout, re-login, and passphrase changes.
 *
 * This replaces the WASM-derived device ID (HMAC(mk, "device:id"))
 * which produces the same UUID on every device with the same
 * passphrase, incorrectly causing multi-device scenarios to be
 * treated as single-device (skipping pull+merge).
 *
 * Migration: existing WASM-derived UUIDs (hex strings) are detected
 * via isWasmDerivedUuid() and replaced with a fresh UUID4.
 */

// UUID4 regex for validation
const UUID4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Get or create the device UUID.
 *
 * On first call: generates a crypto.randomUUID(), persists it in storage
 * under key 'device_uuid', and returns it.
 * On subsequent calls: reads the persisted UUID from storage.
 *
 * The UUID is permanent per device — it survives logout, re-login,
 * passphrase changes, and storage.clear() (the device UUID is excluded
 * from clear operations or re-created if missing after clear).
 *
 * Migration: if a WASM-derived UUID (hex string from HMAC) is found in
 * storage, it is automatically replaced with a new UUID4.
 *
 * @param {import('./storage_plugin.js').StoragePlugin} storage
 * @returns {Promise<string>} The device UUID.
 */
export async function getOrCreateDeviceUuid(storage) {
  // Check for existing UUID
  let existing;
  try {
    existing = await storage.get('device_uuid');
  } catch {
    existing = undefined;
  }

  // If exists and is NOT WASM-derived, return it
  if (existing && typeof existing === 'string' && !isWasmDerivedUuid(existing)) {
    return existing;
  }

  // Generate a fresh UUID4 (first boot or migration from WASM-derived)
  const newUuid = crypto.randomUUID();

  // Persist it
  await storage.set('device_uuid', newUuid);

  return newUuid;
}

/**
 * Check if a stored UUID is a WASM-derived (deterministic from MK) UUID.
 *
 * WASM-derived UUIDs from getDeviceId(MK) are hex strings (HMAC output),
 * not UUID4 format. UUID4 format is:
 *   xxxxxxxx-xxxx-4xxx-[89ab]xxx-xxxxxxxxxxxx
 *
 * @param {string} uuid
 * @returns {boolean} True if the UUID appears to be WASM-derived (hex string).
 */
export function isWasmDerivedUuid(uuid) {
  if (!uuid || typeof uuid !== 'string') return false;

  // UUID4 format means it's not WASM-derived
  if (UUID4_REGEX.test(uuid)) return false;

  // WASM-derived UUIDs from HMAC-SHA256 are exactly 64 hex characters.
  // Match pure hex strings of exactly 64 chars.
  if (/^[0-9a-f]{64}$/i.test(uuid)) return true;

  // Also match hyphenated hex: strip dashes and check for exactly 64 hex chars
  // (e.g., HMAC-SHA256 output formatted with dashes in a non-UUID4 pattern)
  const stripped = uuid.replace(/-/g, '');
  if (/^[0-9a-f]{64}$/i.test(stripped)) return true;

  // Default: if it doesn't look like UUID4 and isn't a known hex format,
  // conservatively treat it as not WASM-derived (don't trigger migration)
  return false;
}
