/**
 * SyncService — unified sync gate + local I/O for staging entries.
 *
 * Port of domain/staging/service.py to JS.
 *
 * The SyncService is the central point for all staging operations:
 *
 *   1. Local CRUD — capture/end/pause/unpause/modify/remove entries
 *      in the local staging cache. Low-latency (no remote calls).
 *
 *   2. Sync gate — checkAndSync() is the single entry point for remote
 *      staging sync. Uses device cookie (TTL + specifier) to decide
 *      fast path vs auth gate. No crypto key consulted for auth
 *      decisions — the cookie is the truth.
 *
 *   3. Push — pushToRemote() serialises local entries, obfuscates via
 *      CryptoService, and pushes to the remote transport.
 *
 *   4. Device Cookie — checkAndSync() uses a fast-path cookie check to
 *      avoid pulling the full staging blob when the same device session
 *      was the last writer.
 *
 * Auth gate flow:
 *     1. No remote? → READY
 *     2. Local cookie TTL valid? → pull remote cookie
 *        ├─ Match → READY (push blob + optional touch)
 *        ├─ Mismatch → REAUTH_NEEDED
 *        └─ No remote cookie → continue
 *     3. No local cookie / expired → REAUTH_NEEDED
 *     4. No remote cookie (local valid, have master key):
 *        → _reconcileAndClaim()
 *          ├─ Same device_uuid → push blob (no pull)
 *          └─ Different → pull blob → reconcile → push merged
 *        → Create new cookie → READY
 *
 * SyncCheckResult:
 *   'READY'           — remote synced, proceed
 *   'OFFLINE'         — remote unreachable, local only
 *   'REAUTH_NEEDED'   — device mismatch, passphrase required
 */

import { DeviceCookie } from './cookie.js';
import { RemoteSync, BLOB_KEY_MISMATCH } from './remote_sync.js';
import { mergeEntries } from './merge_engine.js';
import { LocalCache } from './local_cache.js';
import { getOrCreateDeviceUuid } from './device_uuid.js';
import { GenesisGate } from './genesis_gate.js';

/** @typedef {'READY'|'OFFLINE'|'REAUTH_NEEDED'|'GENESIS_MISMATCH'} SyncCheckResult */

export const SyncResult = Object.freeze({
  READY: 'READY',
  OFFLINE: 'OFFLINE',
  REAUTH_NEEDED: 'REAUTH_NEEDED',
  GENESIS_MISMATCH: 'GENESIS_MISMATCH',
});

const DEFAULT_COOKIE_TTL = 30; // minutes

// ------------------------------------------------------------------
// Internal helpers
// ------------------------------------------------------------------

/**
 * Convert base64 string to Uint8Array.
 * Works in browser (atob) and Node.js (Buffer).
 * @param {string} b64
 * @returns {Uint8Array}
 */
function _base64ToBytes(b64) {
  if (typeof atob !== 'undefined') {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

export class SyncService {
  /**
   * @param {import('./storage.js').StorageBackend} storage - Storage backend.
   * @param {import('../crypto/index.js').CryptoService} crypto - WASM CryptoService.
   * @param {import('./transport.js').HttpTransport} [transport] - HTTP transport.
   *        Null/undefined disables remote operations.
   * @param {object} [options]
   * @param {number} [options.cookieTtlMinutes=30]
   */
  constructor(storage, crypto, transport, options = {}) {
    /** @private */
    this._storage = storage;
    /** @private */
    this._crypto = crypto;
    /** @private */
    this._transport = transport || null;
    /** @private */
    this._cookieTtlMinutes = options.cookieTtlMinutes ?? DEFAULT_COOKIE_TTL;

    // Build sub-modules
    /** @private */
    this._local = new LocalCache(storage, crypto);
    /** @private */
    this._remote = transport
      ? new RemoteSync(transport, crypto)
      : null;

    /** @private ms timestamp of last push (for diagnostics) */
    this._lastPushAt = 0;

    /** @private — genesis compatibility cache (null = unchecked) */
    this._genesisCompatible = null;
    /** @private — genesis check promise for in-flight dedup */
    this._genesisCheckPromise = null;
  }

  // ------------------------------------------------------------------
  // Local staging CRUD (no remote calls)
  // ------------------------------------------------------------------

  /**
   * Resolve the local device UUID.
   *
   * First checks storage for a per-device UUID (persisted via
   * getOrCreateDeviceUuid). If found and not WASM-derived, returns it.
   * Falls back to WASM getDeviceId(MK) only as last resort (legacy).
   *
   * @returns {Promise<string|null>}
   * @private
   */
  async _getDeviceId() {
    // Preferred path: per-device UUID from storage (survives logout/re-login)
    try {
      const storedUuid = await getOrCreateDeviceUuid(this._storage);
      return storedUuid;
    } catch {
      // Storage read failed — fall through to WASM path
    }

    // Fallback: WASM-derived UUID (HMAC from master key)
    const mk = this._crypto.getMasterKey();
    if (!mk) return null;
    try {
      return this._crypto.getDeviceId(mk);
    } catch {
      return null;
    }
  }

  /**
   * Add a new staging entry locally. No remote sync.
   *
   * @param {object} params
   * @param {string} params.title
   * @param {number} params.startEpoch
   * @param {number} [params.endEpoch]
   * @param {boolean} [params.isActive=true]
   * @param {string[]} [params.tags]
   * @param {string} [params.comment]
   * @returns {Promise<string>} Entry hash prefix.
   */
  async capture(params) {
    const deviceUuid = await this._getDeviceId() || '';
    const hash = await this._local.append({ ...params, deviceUuid });
    await this._touchLocalCookie();
    return hash;
  }

  /**
   * End an active task. Local-only write.
   *
   * @param {string} title
   * @param {number} endEpoch - ms timestamp.
   * @param {string} [comment]
   * @throws {Error} If no active task found with that title.
   */
  async end(title, endEpoch, comment) {
    const entries = await this._local.readEntries();
    const foundIndex = entries.findIndex(
      (e) => e.title === title && e.is_active
    );
    if (foundIndex === -1) {
      throw new Error(`No active task found for: ${title}`);
    }

    const entry = entries[foundIndex];

    // Auto-unpause if currently paused
    if (entry.is_paused) {
      await this._local.closePause(foundIndex, endEpoch);
    }

    const endDeviceUuid = await this._getDeviceId() || '';
    await this._local.update(foundIndex, {
      end_epoch: endEpoch,
      is_active: false,
      end_device_uuid: endDeviceUuid,
    });

    // Recompute duration
    const updated = await this._local.readEntries();
    const e = updated[foundIndex];
    const duration = LocalCache.computeDuration(
      e.start_epoch,
      endEpoch,
      e.pauses
    );
    await this._local.update(foundIndex, { duration });

    if (comment != null) {
      await this._local.update(foundIndex, { comment });
    }

    await this._touchLocalCookie();
  }

  /**
   * Pause an active task.
   *
   * @param {string} title
   * @param {number} pauseEpoch - ms timestamp.
   * @throws {Error} If no active task found with that title.
   */
  async pause(title, pauseEpoch) {
    const entries = await this._local.readEntries();
    const foundIndex = entries.findIndex(
      (e) => e.title === title && e.is_active
    );
    if (foundIndex === -1) {
      throw new Error(`No active task found for: ${title}`);
    }
    await this._local.addPause(foundIndex, pauseEpoch);
    await this._touchLocalCookie();
  }

  /**
   * Unpause a paused task (resume).
   *
   * @param {string} title
   * @param {number} unpauseEpoch - ms timestamp.
   * @throws {Error} If no active task found with that title.
   */
  async unpause(title, unpauseEpoch) {
    const entries = await this._local.readEntries();
    const foundIndex = entries.findIndex(
      (e) => e.title === title && e.is_active
    );
    if (foundIndex === -1) {
      throw new Error(`No active task found for: ${title}`);
    }
    await this._local.closePause(foundIndex, unpauseEpoch);
    await this._touchLocalCookie();
  }

  /**
   * Modify a staged entry's fields in-place.
   *
   * @param {number} entryIndex
   * @param {object} fields - {title?, tags?, comment?}
   */
  async modify(entryIndex, fields) {
    await this._local.update(entryIndex, fields);
    await this._touchLocalCookie();
  }

  /**
   * Delete a staged entry.
   *
   * @param {number} entryIndex
   */
  async remove(entryIndex) {
    await this._local.delete(entryIndex);
    await this._touchLocalCookie();
  }

  /**
   * Remove multiple staged entries by index.
   *
   * @param {number[]} indices
   */
  async removeSynced(indices) {
    if (indices && indices.length > 0) {
      await this._local.removeMultiple(indices);
      await this._touchLocalCookie();
    }
  }

  /**
   * Read all staging entries as decrypted DTOs.
   * @returns {Promise<import('./local_cache.js').StagingEntry[]>}
   */
  async readEntries() {
    return this._local.readEntries();
  }

  /**
   * Return only active (not completed) entries.
   * @returns {Promise<import('./local_cache.js').StagingEntry[]>}
   */
  async getActive() {
    const entries = await this._local.readEntries();
    return entries.filter((e) => e.is_active);
  }

  /**
   * Return only completed (ended) entries — both staging and committed.
   * @returns {Promise<import('./local_cache.js').StagingEntry[]>}
   */
  async getCompleted() {
    const entries = await this._local.readEntries();
    const stagingCompleted = entries.filter((e) => !e.is_active);

    // Also read committed entries from the ledger chain
    const committedDTOs = [];
    try {
      const blocks = (await this._storage.get('ledger:blocks')) || [];
      for (let bi = 0; bi < blocks.length; bi++) {
        const block = blocks[bi];
        if (!block.entries || !Array.isArray(block.entries)) continue;
        for (const raw of block.entries) {
          const dto = this._rawCommittedEntryToDTO(raw);
          if (dto) {
            dto.committed = true;
            dto.block_index = bi;
            committedDTOs.push(dto);
          }
        }
      }
    } catch (err) {
      // Decryption may fail if master key isn't cached yet;
      // staging entries will still show.
      console.warn('getCompleted: could not read committed entries:', err.message);
    }

    return [...committedDTOs, ...stagingCompleted];
  }

  /**
   * Return completed, non-paused entries ready for ledger sync.
   * @returns {Promise<import('./local_cache.js').StagingEntry[]>}
   */
  async getPendingSync() {
    const entries = await this._local.readEntries();
    return entries.filter((e) => !e.is_active && !e.is_paused);
  }

  /**
   * Mark entries as committed to the ledger.
   * @param {string[]} entryIds - Entry UUIDs to mark.
   * @param {number} blockIndex - Ledger block index.
   */
  async markCommitted(entryIds, blockIndex) {
    return this._local.markCommitted(entryIds, blockIndex);
  }

  // ------------------------------------------------------------------
  // Cookie helpers
  // ------------------------------------------------------------------

  /**
   * Update the local cookie's creation_time to now, extending TTL.
   * No remote cookie is pushed. Safe to call on every command.
   * @private
   */
  async _touchLocalCookie() {
    try {
      const localCookie = await this._storage.get('cookie');
      if (!localCookie?.device_specifier) return;
      await this._storage.set('cookie', {
        device_specifier: localCookie.device_specifier,
        creation_time: Date.now(),
      });
    } catch {
      // Non-critical
    }
  }

  /**
   * Push local blob and touch cookie on fast path.
   *
   * Called when local and remote cookie specifiers match (same device
   * session). Pushes the local staging blob to remote, then touches
   * the local cookie to extend TTL. The device_specifier is never
   * regenerated — same device, same specifier. The remote cookie is
   * never pushed (it already has the matching specifier).
   *
   * @param {object} localCookie
   * @private
   */
  async _pushOnFastPath(localCookie) {
    const mk = this._crypto.getMasterKey();
    if (mk) {
      await this.pushBlobOnly(mk);
    }
    await this._touchLocalCookie();
  }

  // ------------------------------------------------------------------
  // Sync gate (single point of entry for remote staging sync)
  // ------------------------------------------------------------------

  /**
   * Event-driven remote check with Device Cookie as the truth.
   *
   * Genesis gate runs before any blob sync to verify the remote
   * ledger shares the same genesis block. If genesis is incompatible,
   * returns GENESIS_MISMATCH and no blob operations proceed.
   *
   * @param {number} [timeoutMs=500] - Unused in this port; the
   *   underlying transport handles timeouts.
   * @returns {Promise<SyncCheckResult>}
   */
  async checkAndSync(timeoutMs = 500) {
    if (!this._remote) {
      return SyncResult.READY;
    }

    // ------------------------------------------------------------------
    // GENESIS GATE: Verify remote ledger shares same genesis block.
    // Only runs when a local ledger exists — if there are no committed
    // blocks yet, there's nothing to protect and gate is skipped.
    // ------------------------------------------------------------------
    const masterKey = this._crypto.getMasterKey();
    if (masterKey && this._genesisCompatible === null) {
      const blocks = (await this._storage.get('ledger:blocks')) || [];
      if (blocks.length > 0) {
        if (!this._genesisCheckPromise) {
          this._genesisCheckPromise = (async () => {
            try {
              const result = await GenesisGate.check(
                blocks, this._transport, this._crypto, masterKey
              );
              this._genesisCompatible = result.compatible;
              return result;
            } catch {
              // Network error during genesis check — don't cache, retry next time
              return null;
            }
          })();
        }

        const result = await this._genesisCheckPromise;
        this._genesisCheckPromise = null;

        if (result === null) {
          // Network error — genesis not cached, fall through to OFFLINE below
        } else if (result.compatible === false) {
          return SyncResult.GENESIS_MISMATCH;
        } else if (result.compatible === true) {
          // Genesis compatible — persist merged chain to storage.
          // Previously a known gap: merge result was computed but
          // never written, so every checkAndSync() re-merged.
          if (result.mergedChain) {
            try {
              await this._storage.set('ledger:blocks', result.mergedChain);
              if (result.index) {
                await this._storage.set('ledger:index', result.index);
              }
            } catch (err) {
              console.warn('Failed to persist merged ledger chain:', err.message);
            }
          }
        }
      }
    }

    // ------------------------------------------------------------------
    // FAST PATH: Local cookie valid → remote cookie match → READY
    // ------------------------------------------------------------------
    const localCookie = await DeviceCookie.isValidLocally(
      this._storage,
      this._cookieTtlMinutes
    );

    let specifierMismatch = false;

    if (localCookie) {
      let remoteCookieRaw;
      try {
        remoteCookieRaw = await this._remote.pullCookie();
      } catch {
        return SyncResult.OFFLINE;
      }

      if (remoteCookieRaw) {
        const remoteCookie = DeviceCookie.parseRemote(remoteCookieRaw);
        if (remoteCookie && DeviceCookie.matches(localCookie, remoteCookie)) {
          // Same device session — fast path
          await this._pushOnFastPath(localCookie);
          return SyncResult.READY;
        }
        if (remoteCookie) {
          // Remote cookie parsed but specifiers differ
          specifierMismatch = true;
        }
        // else: remote cookie can't parse — treat as no remote cookie,
        // fall through to auth gate
      }
    }

    // ------------------------------------------------------------------
    // AUTH GATE
    // ------------------------------------------------------------------

    // Specifier mismatch ALWAYS forces auth, regardless of cached crypto key.
    if (specifierMismatch) {
      return SyncResult.REAUTH_NEEDED;
    }

    // TTL expired or no local cookie — force auth UNLESS the master key
    // is already cached (fresh device after onboarding/login). In that case
    // proceed to _reconcileAndClaim to establish a first-time cookie and sync.
    if (!localCookie) {
      const mk = this._crypto.getMasterKey();
      if (mk) {
        return this._reconcileAndClaim(mk);
      }
      return SyncResult.REAUTH_NEEDED;
    }

    // No remote cookie — proceed with reconcile if we have a master key
    const mk = this._crypto.getMasterKey();
    if (!mk) {
      return SyncResult.REAUTH_NEEDED;
    }

    // Reconcile and claim staging ownership
    return this._reconcileAndClaim(mk);
  }

  // ------------------------------------------------------------------
  // Reconcile and claim
  // ------------------------------------------------------------------

  /**
   * After successful auth: claim staging ownership for this device.
   *
   * Called from checkAndSync()'s auth gate. Pulls remote cookie to
   * check device_uuid, then:
   *
   *   Same device that last wrote → push local blob (authoritative)
   *     and touch local cookie (update creation_time, keep specifier,
   *     no remote cookie push).
   *
   *   Different device / first time → pull remote blob, reconcile
   *     (merge remote entries into local), push merged blob, then
   *     create a fresh device cookie (new specifier, local + remote).
   *
   * @param {string} masterKeyHex - 64-char hex master key.
   * @returns {Promise<SyncCheckResult>}
   * @private
   */
  async _reconcileAndClaim(masterKeyHex) {
    // Pull remote cookie to discover which device last wrote
    let remoteCookieRaw;
    try {
      remoteCookieRaw = await this._remote.pullCookie();
    } catch {
      return SyncResult.OFFLINE;
    }

    let remoteDeviceUuid = '';
    let remoteCookieSpecifier = '';

    if (remoteCookieRaw) {
      const remoteCookie = DeviceCookie.parseRemote(remoteCookieRaw);
      if (remoteCookie) {
        remoteDeviceUuid = remoteCookie.device_uuid || '';
        remoteCookieSpecifier = remoteCookie.device_specifier || '';
      }
    }

    const localDeviceUuid = await this._getDeviceId() || '';

    if (remoteDeviceUuid && remoteDeviceUuid === localDeviceUuid) {
      // Case A — Same device that last wrote: push only, touch cookie
      await this.pushBlobOnly(masterKeyHex, localDeviceUuid);

      // Touch local cookie: update creation_time, keep specifier,
      // no remote cookie push (remote already has matching specifier).
      if (remoteCookieSpecifier) {
        try {
          await this._storage.set('cookie', {
            device_specifier: remoteCookieSpecifier,
            creation_time: Date.now(),
          });
        } catch {
          // Non-critical
        }
      }
    } else {
      // Case B — Different device or first-time setup: pull, reconcile, push
      let remoteBlob;
      try {
        remoteBlob = await this._remote.pullBlob(masterKeyHex);
      } catch {
        return SyncResult.OFFLINE;
      }

      // If remote blob exists but can't be decrypted (wrong master key),
      // DON'T overwrite it — abort and signal OFFLINE.
      if (remoteBlob === BLOB_KEY_MISMATCH) {
        console.warn(
          'Remote staging blob exists but cannot be decrypted ' +
          '(wrong master key). Aborting to avoid data loss.'
        );
        return SyncResult.OFFLINE;
      }

      if (remoteBlob && Array.isArray(remoteBlob.entries)) {
        try {
          const localEntries = await this._local.readEntries();
          // Convert remote raw entries to DTOs before merge
          const remoteDTOs = remoteBlob.entries
            .map((raw) => this._rawEntryToDTO(raw))
            .filter(Boolean);
          const merged = mergeEntries(localEntries, remoteDTOs);
          await this._local.writeEntries(merged);
        } catch (err) {
          // Merge failure — push local as-is
          console.warn('Merge failed, pushing local blob:', err.message);
        }
      }

      // Push the (merged or local) blob to remote
      await this.pushBlobOnly(masterKeyHex, localDeviceUuid);

      // Create new device cookie (fresh specifier, local + remote)
      try {
        await DeviceCookie.destroyLocally(this._storage);
        const remoteCookie = await DeviceCookie.create(
          localDeviceUuid,
          this._storage,
          this._crypto
        );
        if (remoteCookie) {
          const cookieBytes = new TextEncoder().encode(
            JSON.stringify(remoteCookie)
          );
          await this._remote.pushCookie(cookieBytes);
        }
      } catch {
        // Non-critical: cookie creation failure doesn't block READY
      }
    }

    return SyncResult.READY;
  }

  // ------------------------------------------------------------------
  // Raw entry → DTO conversion
  // ------------------------------------------------------------------

  /**
   * Decrypt and convert a raw committed entry from a ledger block into a DTO.
   * Unlike staging entries (which use plain: prefixed values), committed
   * entries have encrypted hex fields that must be decrypted first.
   * @param {object} rawEntry - Raw entry dict with `data`, `hash`
   * @returns {object|null} Decrypted DTO, or null if decryption fails.
   * @private
   */
  _rawCommittedEntryToDTO(rawEntry) {
    try {
      const data = rawEntry.data || {};

      // Decrypt timestamp fields from hex ciphertext
      const startEpochStr = data.startTime_enc
        ? this._crypto.decryptWithCachedKey(data.startTime_enc)
        : null;
      const startEpoch = startEpochStr ? parseInt(startEpochStr, 10) : null;
      if (!startEpoch) return null;

      const endEpochStr = data.endTime_enc
        ? this._crypto.decryptWithCachedKey(data.endTime_enc)
        : null;
      const endEpoch = endEpochStr ? parseInt(endEpochStr, 10) : null;

      // Decrypt metadata
      let metadata = {};
      if (data.metadata_enc) {
        try {
          const metaStr = this._crypto.decryptWithCachedKey(data.metadata_enc);
          metadata = JSON.parse(metaStr);
        } catch { /* ignore corrupt metadata */ }
      }

      const dateStr = new Date(startEpoch).toISOString().slice(0, 10);

      return {
        entry_id: data.entry_id || rawEntry.hash || '',
        entry_index: -1, // committed entries have no staging index
        title: data.title || '',
        start_epoch: startEpoch,
        end_epoch: endEpoch,
        duration: data.duration || 0,
        is_active: false,
        is_paused: false,
        pauses: [],
        tags: data.tags || [],
        comment: data.comment || null,
        media: [],
        metadata,
        date: dateStr,
        source: 'ledger',
        hash: rawEntry.hash || '',
        device_uuid: data.device_uuid || '',
        end_device_uuid: data.end_device_uuid || '',
      };
    } catch {
      return null;
    }
  }

  /**
   * Convert a single raw staging entry (from remote blob) to a DTO.
   *
   * Remote blob entries are stored in raw format with encrypted fields.
   * Since the deobfuscated blob is plain JSON (decrypted), the fields
   * are already plain text (the `plain:` prefix convention from the CLI).
   *
   * @param {object} rawEntry - Raw entry dict with `data`, `hash`, etc.
   * @returns {object|null} Decrypted DTO, or null if corrupt.
   * @private
   */
  _rawEntryToDTO(rawEntry) {
    try {
      const data = rawEntry.data || {};

      // Parse timestamps from plain: prefix format
      const startEpochStr = data.startTime_enc || '';
      const startEpoch = this._parsePlainInt(startEpochStr);
      if (startEpoch == null) return null;

      const endEpochStr = data.endTime_enc;
      const endEpoch = endEpochStr ? this._parsePlainInt(endEpochStr) : null;

      const pausesRaw = data.pauses_enc || 'plain:[]';
      const pauses = this._parsePlainJSON(pausesRaw) || [];

      const metadataRaw = data.metadata_enc || 'plain:{}';
      const metadata = this._parsePlainJSON(metadataRaw) || {};

      const dateStr = new Date(startEpoch).toISOString().slice(0, 10);

      return {
        entry_id: data.entry_id || '',
        title: data.title || '',
        start_epoch: startEpoch,
        end_epoch: endEpoch,
        duration: data.duration || 0,
        is_active: data.is_active || false,
        is_paused: data.is_paused || false,
        pauses,
        tags: data.tags || [],
        comment: data.comment || null,
        media: data.media || [],
        metadata,
        date: dateStr,
        source: 'remote',
        hash: rawEntry.hash || '',
        device_uuid: data.device_uuid || '',
        end_device_uuid: data.end_device_uuid || '',
      };
    } catch {
      return null;
    }
  }

  /**
   * Parse a `plain:` prefixed string as an integer.
   * @param {string} str - e.g. "plain:1714000000000"
   * @returns {number|null}
   * @private
   */
  _parsePlainInt(str) {
    if (!str || typeof str !== 'string') return null;
    if (str.startsWith('plain:')) {
      return parseInt(str.slice(6), 10);
    }
    // Could be an already-decrypted value (just a number string)
    return parseInt(str, 10);
  }

  /**
   * Parse a `plain:` prefixed string as JSON.
   * @param {string} str - e.g. 'plain:[{"pause_start":...}]'
   * @returns {any|null}
   * @private
   */
  _parsePlainJSON(str) {
    if (!str || typeof str !== 'string') return null;
    if (str.startsWith('plain:')) {
      try {
        return JSON.parse(str.slice(6));
      } catch {
        return null;
      }
    }
    try {
      return JSON.parse(str);
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------
  // Push to remote
  // ------------------------------------------------------------------

  /**
   * Serialize local staging, push via transport, and create device cookie.
   *
   * Pushes the staging blob FIRST, then the device cookie. Order matters:
   * if the blob push fails, the cookie is unchanged and the next
   * checkAndSync will find matching cookies and retry the blob push.
   * If the cookie push fails after the blob succeeds, the cookie mismatch
   * triggers reconcile which pulls the correct (updated) blob.
   *
   * @param {string} masterKeyHex - 64-char hex master key.
   */
  async pushToRemote(masterKeyHex) {
    if (!this._remote) return;

    const entries = await this._local.readEntries();
    const deviceId = await this._getDeviceId() || 'unknown';

    // Push blob FIRST
    await this._remote.pushBlob(entries, deviceId, masterKeyHex);

    // Push cookie SECOND (soft failure)
    try {
      await DeviceCookie.destroyLocally(this._storage);
      await this._pushCookie(deviceId);
    } catch (err) {
      console.warn('Device cookie push failed:', err.message);
    }

    this._lastPushAt = Date.now();
  }

  /**
   * Create a fresh device cookie and push it to remote.
   *
   * Only write operations that produce new staging data should call this.
   * Sync-only operations must NOT push the cookie — the remote cookie is
   * the authoritative record of which device last wrote.
   *
   * @param {string} deviceId
   * @private
   */
  async _pushCookie(deviceId) {
    const remoteCookie = await DeviceCookie.create(
      deviceId,
      this._storage,
      this._crypto
    );
    if (remoteCookie) {
      const cookieBytes = new TextEncoder().encode(
        JSON.stringify(remoteCookie)
      );
      await this._remote.pushCookie(cookieBytes);
    }
  }

  /**
   * Push only the staging blob to remote, WITHOUT creating/pushing a cookie.
   *
   * Used by sync operations that should reconcile data but not claim
   * ownership of the remote cookie. The remote cookie is only updated
   * by real write operations.
   *
   * @param {string} masterKeyHex - 64-char hex master key.
   * @param {string} [deviceId] - Optional device ID. When provided, skips
   *   the internal _getDeviceId() call (avoiding redundant lookups).
   */
  async pushBlobOnly(masterKeyHex, deviceId) {
    if (!this._remote) return;

    const entries = await this._local.readEntries();
    const effectiveDeviceId = deviceId || (await this._getDeviceId()) || 'unknown';
    await this._remote.pushBlob(entries, effectiveDeviceId, masterKeyHex);
    this._lastPushAt = Date.now();
  }

  // ------------------------------------------------------------------
  // Ledger block sync
  // ------------------------------------------------------------------

  /**
   * Push local ledger blocks to remote that don't exist there yet.
   *
   * Lists remote indices via transport.listFiles('ledger/blocks/'),
   * then pushes only blocks whose index is not already on remote.
   * Blocks are JSON-serialized then obfuscated via crypto.obfuscateBlob().
   * Index is pushed after blocks.
   *
   * Skipped when: no transport, no master key, or no local blocks.
   * Errors are logged but never thrown — push is best-effort.
   *
   * @returns {Promise<number>} Number of blocks pushed (0 = nothing to do or error).
   */
  async pushLedgerBlocks() {
    // ---- Skip conditions ----
    if (!this._remote) return 0;

    const mk = this._crypto.getMasterKey();
    if (!mk) return 0;

    const blocks = (await this._storage.get('ledger:blocks')) || [];
    if (blocks.length === 0) return 0;

    // ---- Discover remote indices ----
    /** @type {Set<number>} */
    let remoteIndices;
    try {
      const remoteFiles = await this._transport.listFiles('ledger/blocks/');
      remoteIndices = new Set(
        remoteFiles
          .filter(f => f.endsWith('.json'))
          .map(f => parseInt(f.replace('.json', ''), 10))
          .filter(n => !isNaN(n))
      );
    } catch (err) {
      console.warn('pushLedgerBlocks: listFiles failed:', err.message);
      return 0;
    }

    // ---- Push new blocks (in ascending index order) ----
    // Use day_index (LedgerEngine) with index fallback (test helpers / genesis).
    const _blockIdx = (b) => b.day_index ?? b.index ?? 0;
    const sorted = [...blocks].sort((a, b) => _blockIdx(a) - _blockIdx(b));
    let pushed = 0;
    for (const block of sorted) {
      const idx = block.day_index ?? block.index;
      if (idx == null) continue;

      if (remoteIndices.has(idx)) continue;

      try {
        const json = JSON.stringify(block);
        const obfuscatedB64 = this._crypto.obfuscateBlob(json, mk);
        const bytes = _base64ToBytes(obfuscatedB64);
        const path = `ledger/blocks/${String(idx).padStart(6, '0')}.json`;
        await this._transport.push(path, bytes);
        pushed++;
      } catch (err) {
        console.warn('pushLedgerBlocks: push failed for block', idx, ':', err.message);
      }
    }

    // ---- Push index ----
    if (pushed > 0) {
      try {
        const index = await this._storage.get('ledger:index');
        if (index) {
          const json = JSON.stringify(index);
          const obfuscatedB64 = this._crypto.obfuscateBlob(json, mk);
          const bytes = _base64ToBytes(obfuscatedB64);
          await this._transport.push('ledger/index.json', bytes);
        }
      } catch (err) {
        console.warn('pushLedgerBlocks: index push failed:', err.message);
      }
    }

    return pushed;
  }

  // ------------------------------------------------------------------
  // Diagnostics
  // ------------------------------------------------------------------

  /**
   * Reset genesis compatibility cache.
   * Call when changing remote transport URL or API key.
   */
  resetGenesisGate() {
    this._genesisCompatible = null;
    this._genesisCheckPromise = null;
  }

  /**
   * Replace the active transport with a new one.
   *
   * Call after Settings changes the Worker URL or API key so that
   * subsequent sync operations use the new remote endpoint. Passing
   * null gracefully degrades to local-only mode.
   *
   * Side effects:
   * - Rebuilds the internal RemoteSync wrapper from the new transport
   * - Invalides the genesis gate cache (different remote may have
   *   different genesis)
   *
   * @param {import('./transport.js').HttpTransport|null} transport
   */
  reconfigure(transport) {
    this._transport = transport || null;
    this._remote = transport
      ? new RemoteSync(transport, this._crypto)
      : null;
    this.resetGenesisGate();
  }

  /**
   * Quick reachability check.
   * @returns {Promise<boolean>}
   */
  async checkRemotePing(timeoutMs = 500) {
    if (!this._remote) return false;
    try {
      await this._remote.pullCookie();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Whether remote transport is configured.
   * @returns {boolean}
   */
  get isRemoteAvailable() {
    return this._remote !== null;
  }

  /**
   * Return the cached master key, or null if not unlocked.
   * @returns {string|null}
   */
  getMasterKey() {
    return this._crypto.getMasterKey();
  }

  /**
   * Timestamp of the last push (ms epoch).
   * @returns {number}
   */
  get lastPushAt() {
    return this._lastPushAt;
  }

  /**
   * Clear all known keys from the remote R2 bucket.
   *
   * Used when the user wants to overwrite a remote ledger with a
   * different genesis (genesis mismatch override). Deletes the three
   * known paths (ledger:blocks, staging:blob, cookie:json) via HTTP DELETE
   * and resets the genesis compatibility gate so the next syncStart
   * treats the remote as empty.
   *
   * @returns {Promise<void>}
   * @throws {Error} If remote transport is not configured.
   */
  async clearRemote() {
    if (!this._remote || !this._transport) {
      throw new Error('No remote transport configured');
    }

    const keys = ['ledger:blocks', 'staging:blob', 'cookie:json'];
    let failures = 0;

    for (const key of keys) {
      try {
        await this._transport.delete(key);
      } catch (err) {
        failures++;
        console.warn(`clearRemote: failed to delete ${key}: ${err.message}`);
      }
    }

    if (failures === keys.length) {
      throw new Error('Failed to clear any remote keys. The remote may be unreachable.');
    }

    // Reset genesis gate so next checkAndSync re-evaluates compatibility
    this._genesisCompatible = null;

    // Clear ETag cache so next pull is a fresh request
    this._transport.resetCache();
  }
}
