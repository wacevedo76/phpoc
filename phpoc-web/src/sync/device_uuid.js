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

// Client-type suffix for cross-client identity (Bug 3a fix).
// CLI uses '-cli', web uses '-web'. Ensures CLI and web always
// have distinct device identities — no same-device overwrite risk.
const CLIENT_TYPE = 'web';

// UUID4 regex for validation
const UUID4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// UUID4-with-suffix regex: standard UUID4 followed by '-web' or '-cli'
const UUID4_WITH_SUFFIX_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-[a-z]+$/i;

// Hex regex for WASM-derived device IDs (64 hex chars)
const HEX64_REGEX = /^[0-9a-f]{64}$/i;

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

  // If exists and is already a suffixed UUID (e.g., '...-web'), return as-is
  if (existing && typeof existing === 'string' && UUID4_WITH_SUFFIX_REGEX.test(existing)) {
    return existing;
  }

  // If exists and is a bare UUID4 (no suffix), append the client suffix
  if (existing && typeof existing === 'string' && UUID4_REGEX.test(existing)) {
    const suffixed = existing + '-' + CLIENT_TYPE;
    await storage.set('device_uuid', suffixed);
    return suffixed;
  }

  // If exists and is WASM-derived (hex string), migrate to UUID4-web
  if (existing && typeof existing === 'string' && isWasmDerivedUuid(existing)) {
    const newUuid = crypto.randomUUID() + '-' + CLIENT_TYPE;
    await storage.set('device_uuid', newUuid);
    return newUuid;
  }

  // Generate a fresh UUID4 with client suffix (first boot)
  const newUuid = crypto.randomUUID() + '-' + CLIENT_TYPE;

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
  if (HEX64_REGEX.test(uuid)) return true;

  // Also match hyphenated hex: strip dashes and check for exactly 64 hex chars
  // (e.g., HMAC-SHA256 output formatted with dashes in a non-UUID4 pattern)
  const stripped = uuid.replace(/-/g, '');
  if (/^[0-9a-f]{64}$/i.test(stripped)) return true;

  // Default: if it doesn't look like UUID4 and isn't a known hex format,
  // conservatively treat it as not WASM-derived (don't trigger migration)
  return false;
}

// ── I-09: device_local_secret support ───────────────────────────

/**
 * Try to extract a valid UUID4 secret from an existing value.
 *
 * Handles three cases:
 * 1. Clean UUID4 → return as-is
 * 2. Suffixed UUID4 (uuid4-web) → extract core, persist, return
 * 3. Invalid/hex → generate fresh UUID4, persist, return
 *
 * @param {string} existing - Raw value from storage.
 * @param {import('./storage.js').StorageBackend} storage
 * @returns {Promise<{secret: string, wasNew: boolean}|null>}
 *   Resolved secret or null if the value is falsy (caller should
 *   try migration or fresh generation).
 * @private
 */
async function _tryExtractExistingSecret(existing, storage) {
  if (!existing || typeof existing !== 'string') return null;

  // Clean UUID4 — return as-is
  if (UUID4_REGEX.test(existing)) {
    return { secret: existing, wasNew: false };
  }

  // Suffixed UUID4 (e.g., uuid4-web) — extract core
  if (UUID4_WITH_SUFFIX_REGEX.test(existing)) {
    const parts = existing.split('-');
    const coreUuid = parts.slice(0, 5).join('-');
    if (UUID4_REGEX.test(coreUuid)) {
      await storage.set('device_local_secret', coreUuid);
      return { secret: coreUuid, wasNew: false };
    }
  }

  // Invalid format (WASM hex or garbage) — regenerate
  const newSecret = crypto.randomUUID();
  await storage.set('device_local_secret', newSecret);
  return { secret: newSecret, wasNew: true };
}

/**
 * Try to migrate from legacy device_uuid when no device_local_secret exists.
 *
 * @param {import('./storage.js').StorageBackend} storage
 * @returns {Promise<string|null>} UUID4 secret or null if no legacy UUID found.
 * @private
 */
async function _tryMigrateFromDeviceUuid(storage) {
  let oldUuid;
  try {
    oldUuid = await storage.get('device_uuid');
  } catch {
    return null;
  }
  if (!oldUuid || typeof oldUuid !== 'string') return null;

  // Suffixed UUID (uuid4-web) → extract core
  if (UUID4_WITH_SUFFIX_REGEX.test(oldUuid)) {
    const parts = oldUuid.split('-');
    const coreUuid = parts.slice(0, 5).join('-');
    if (UUID4_REGEX.test(coreUuid)) {
      await storage.set('device_local_secret', coreUuid);
      return coreUuid;
    }
  }

  // Bare UUID4 → adopt directly
  if (UUID4_REGEX.test(oldUuid)) {
    await storage.set('device_local_secret', oldUuid);
    return oldUuid;
  }

  return null;
}

/**
 * Get or create the per-device local secret for device ID derivation.
 *
 * I-09: The device_local_secret is a UUID4 generated on first auth and
 * persisted in storage under key 'device_local_secret'. It binds the
 * device ID to both the MK and a per-device random secret.
 *
 * Migration:
 * - Existing device_local_secret (valid UUID4) → returned as-is
 * - Existing device_local_secret (WASM hex) → regenerated as UUID4
 * - Existing device_local_secret with suffix (uuid4-web) → core extracted
 * - No device_local_secret + old device_uuid (UUID4) → migrated to new key
 * - No device_local_secret + old device_uuid (WASM hex) → new UUID4 generated
 * - Fresh install → new UUID4 generated
 *
 * The secret survives logout — it is stored under a key separate from
 * session data.
 *
 * @param {import('./storage.js').StorageBackend} storage
 * @returns {Promise<string>} The device-local UUID4 secret.
 */
export async function getOrCreateDeviceSecret(storage) {
  let existing;
  try {
    existing = await storage.get('device_local_secret');
  } catch {
    existing = undefined;
  }

  // Try existing value first
  const result = await _tryExtractExistingSecret(existing, storage);
  if (result) return result.secret;

  // No existing secret — try migrating from legacy device_uuid
  const migrated = await _tryMigrateFromDeviceUuid(storage);
  if (migrated) return migrated;

  // Fresh install — generate new UUID4
  const newSecret = crypto.randomUUID();
  await storage.set('device_local_secret', newSecret);
  return newSecret;
}

/**
 * Derive a device ID from MK + per-device secret (I-09).
 *
 * Uses Web Crypto API: HMAC-SHA256(MK, "phpoc:device:" + secret).
 * Cross-platform compatible with Python derive_device_id() and
 * Rust device::derive_device_id().
 *
 * @param {string} mk - 64-char hex master key.
 * @param {string} secret - Per-device UUID4 secret string.
 * @returns {Promise<string>} 64-char hex device ID.
 */
export async function deriveDeviceId(mk, secret) {
  // Decode hex MK to raw bytes
  const mkBytes = new Uint8Array(mk.length / 2);
  for (let i = 0; i < mk.length; i += 2) {
    mkBytes[i / 2] = parseInt(mk.substring(i, i + 2), 16);
  }

  // Build message: "phpoc:device:" + device_local_secret
  const msg = new TextEncoder().encode('phpoc:device:' + secret);

  // Import MK as HMAC key
  const key = await crypto.subtle.importKey(
    'raw', mkBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );

  // HMAC-SHA256
  const sig = await crypto.subtle.sign('HMAC', key, msg);

  // Convert to hex
  const bytes = new Uint8Array(sig);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}
