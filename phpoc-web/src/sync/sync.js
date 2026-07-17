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
import { getOrCreateDeviceUuid, getOrCreateDeviceSecret, deriveDeviceId } from './device_uuid.js';
import {
  GenesisGate,
  GenesisMismatchError,
  NetworkGenesisError,
  AuthGenesisError,
  InvalidChainError,
  InvalidGenesisError,
  InvalidFormatError,
} from './genesis_gate.js';
import { base64ToBytes, bytesToBase64 } from './base64.js';
import { rawCommittedEntryToDTO, rawEntryToDTO } from './entry_dto.js';
import {
  REMOTE_STAGING_BLOB,
  REMOTE_DEVICE_COOKIE,
  REMOTE_LEDGER_BLOCKS_PREFIX,
  REMOTE_LEDGER_INDEX,
  REMOTE_HASH_INDEX,
  REMOTE_HASH_INDEX_SHA256,
  REMOTE_STAGING_HASH_INDEX,
  REMOTE_STAGING_HASH_INDEX_SHA256,
  LOCAL_COOKIE,
  LOCAL_LEDGER_BLOCKS,
  LOCAL_LEDGER_INDEX,
  LOCAL_HASH_INDEX,
  LOCAL_STAGING_HASH_INDEX,
} from './keys.js';
import { buildHashIndex } from './hash_index.js';
import { buildStagingHashIndex, compareStagingHashIndexes, computeHashForIndex } from './staging_hash_index.js';

/** @typedef {'READY'|'OFFLINE'|'REAUTH_NEEDED'|'GENESIS_MISMATCH'} SyncCheckResult */

export const SyncResult = Object.freeze({
  READY: 'READY',
  OFFLINE: 'OFFLINE',
  REAUTH_NEEDED: 'REAUTH_NEEDED',
  GENESIS_MISMATCH: 'GENESIS_MISMATCH',
});

const DEFAULT_COOKIE_TTL = 30; // minutes

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
    /** @private — stats from the last genesis-gate merge (null = no merge yet) */
    this._lastMergeStats = null;
    /** @private — remote cookie from fast-path phase (avoids duplicate pull) */
    this._lastRemoteCookie = null;

    /** @private — cached device UUID to avoid repeated storage/WASM calls */
    this._deviceId = null;
  }

  // ------------------------------------------------------------------
  // Local staging CRUD (no remote calls)
  // ------------------------------------------------------------------

  /**
   * Resolve the local device UUID via I-09 device_local_secret.
   *
   * Derives device_id from MK + device_local_secret (HMAC-SHA256).
   * The secret is a UUID4 persisted in storage, generated on first use.
   * No WASM getDeviceId(MK) fallback — the secret must exist.
   *
   * Returns null when MK is unavailable (pre-auth state).
   *
   * @returns {Promise<string|null>}
   * @private
   */
  async _getDeviceId() {
    if (this._deviceId) return this._deviceId;

    // Get or create the per-device secret (UUID4, persisted)
    let secret;
    try {
      secret = await getOrCreateDeviceSecret(this._storage);
    } catch {
      // Storage read/write failed — try legacy device_uuid as fallback
      try {
        secret = await getOrCreateDeviceUuid(this._storage);
        // If legacy returned a suffixed UUID, strip the suffix for derivation
        if (secret && typeof secret === 'string' && secret.includes('-web')) {
          secret = secret.replace(/-web$/, '');
        }
      } catch {
        return null;
      }
    }

    if (!secret) return null;

    // Require MK for derivation
    const mk = this._crypto.getMasterKey();
    if (!mk) return null;

    try {
      const coreId = await deriveDeviceId(mk, secret);
      // Append client-type suffix (Bug 3a fix)
      const deviceId = `${coreId}-web`;
      this._deviceId = deviceId;
      return deviceId;
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
    const stagingCompleted = entries.filter((e) => !e.is_active && !e.committed);

    // Read committed entries from the ledger chain, deduplicating by entry_id
    // (primary) with title+date fallback for entries committed on different
    // devices with different UUIDs but representing the same activity.
    const committedDTOs = [];
    const committedIds = new Set();
    const committedTitleDateKeys = new Set();
    try {
      const blocks = (await this._storage.get(LOCAL_LEDGER_BLOCKS)) || [];
      for (let bi = 0; bi < blocks.length; bi++) {
        const block = blocks[bi];
        if (!block.entries || !Array.isArray(block.entries)) continue;
        for (const raw of block.entries) {
          const dto = rawCommittedEntryToDTO(raw, this._crypto);
          if (dto) {
            const eid = dto.entry_id;
            // Primary dedup: skip if same entry_id already seen
            if (eid && committedIds.has(eid)) continue;
            // Fallback dedup: skip if same title+date already seen
            // (catches cross-device duplicates with different entry UUIDs)
            const tdKey = `${dto.title || ''}::${dto.date || ''}`;
            if (committedTitleDateKeys.has(tdKey)) continue;
            dto.committed = true;
            dto.block_index = bi;
            committedDTOs.push(dto);
            if (eid) committedIds.add(eid);
            committedTitleDateKeys.add(tdKey);
          }
        }
      }
    } catch (err) {
      console.warn('getCompleted: could not read committed entries:', err.message);
    }

    // Deduplicate: exclude staging entries whose entry_id already appears
    // in the committed ledger chain (same entry committed + still in staging).
    const dedupedStaging = stagingCompleted.filter(
      (e) => !e.entry_id || !committedIds.has(e.entry_id)
    );

    return [...committedDTOs, ...dedupedStaging];
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
      const localCookie = await this._storage.get(LOCAL_COOKIE);
      if (!localCookie?.device_specifier) return;
      await this._storage.set(LOCAL_COOKIE, {
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
   * @returns {Promise<SyncCheckResult>}
   */
  async checkAndSync() {
    if (!this._remote) {
      return SyncResult.READY;
    }

    // ── Genesis Gate ────────────────────────────────────────────
    const genesisResult = await this._genesisGatePhase();
    if (genesisResult !== null) return genesisResult;

    // ── Fast Path ───────────────────────────────────────────────
    const fastResult = await this._fastPathPhase();
    if (fastResult !== null) return fastResult;

    // ── Auth Gate ───────────────────────────────────────────────
    return this._authGatePhase();
  }

  // ── checkAndSync phases ──────────────────────────────────────────

  /**
   * Genesis gate phase: verify remote ledger shares same genesis block.
   * Only runs when a local ledger exists. On success, persists any merged
   * chain and returns null (continue to fast path). On mismatch/error,
   * returns a SyncCheckResult (short-circuit).
   * @returns {Promise<SyncCheckResult|null>}
   * @private
   */
  async _genesisGatePhase() {
    const masterKey = this._crypto.getMasterKey();
    if (!masterKey || this._genesisCompatible !== null) return null;

    const blocks = (await this._storage.get(LOCAL_LEDGER_BLOCKS)) || [];
    if (blocks.length === 0) return null;

    if (!this._genesisCheckPromise) {
      this._genesisCheckPromise = GenesisGate.check(
        blocks, this._transport, this._crypto, masterKey
      );
    }

    let result;
    try {
      result = await this._genesisCheckPromise;
    } catch (err) {
        this._genesisCheckPromise = null;
      if (err instanceof GenesisMismatchError) {
        this._genesisCompatible = false; // Cache negative result
        return SyncResult.GENESIS_MISMATCH;
      }
      if (
        err instanceof NetworkGenesisError ||
        err instanceof AuthGenesisError ||
        err instanceof InvalidChainError ||
        err instanceof InvalidGenesisError ||
        err instanceof InvalidFormatError
      ) {
        return null; // Transient — fall through to offline/auth handling
      }
      throw err; // Unexpected
    }
    this._genesisCheckPromise = null;

    if (result.compatible === false) {
      this._genesisCompatible = false;
      return SyncResult.GENESIS_MISMATCH;
    }

    // Genesis compatible — persist merged chain and push when needed
    if (result.merged) {
      try {
        await this._storage.set(LOCAL_LEDGER_BLOCKS, result.mergedChain);
        if (result.index) {
          await this._storage.set(LOCAL_LEDGER_INDEX, result.index);
        }
        if (result.stats) {
          this._lastMergeStats = result.stats;
        }
        // Build and cache hash index locally for next Tier 1 fast path
        try {
          const hashIndex = buildHashIndex(result.mergedChain);
          await this._storage.set(LOCAL_HASH_INDEX, hashIndex);
        } catch {
          // Non-critical — hash index is rebuildable from chain
        }
        await this.pushLedgerBlocks({ forceAll: true });
      } catch (err) {
        console.warn('Failed to persist merged ledger chain:', err.message);
      }
    } else {
      // No merge needed (genesis compatible, chains identical or local
      // extends remote), but push hash index to remote so Tier 1 fast
      // path works on the next unlock. This fixes the hash index
      // bootstrap gap: after import/onboarding, the hash index files
      // were never pushed to remote. Only hash index files are pushed —
      // block files are NOT pushed (no merge needed).
      try {
        const currentBlocks = await this._storage.get(LOCAL_LEDGER_BLOCKS);
        if (currentBlocks && currentBlocks.length > 0) {
          const hi = buildHashIndex(currentBlocks);
          const hiJson = JSON.stringify(hi);
          await this._transport.push(REMOTE_HASH_INDEX, new TextEncoder().encode(hiJson));
          const hiSha256 = this._crypto.sha256(hiJson);
          await this._transport.push(REMOTE_HASH_INDEX_SHA256, new TextEncoder().encode(hiSha256));
          await this._storage.set(LOCAL_HASH_INDEX, hi);
        }
      } catch (err) {
        console.warn('Failed to push hash index (bootstrap):', err.message);
      }
    }

    this._genesisCompatible = true;
    return null;
  }

  /**
   * Fast path: local cookie valid → pull remote cookie → specifier match → READY.
   * Returns SyncCheckResult on match/OFFLINE, or null to fall through to auth gate.
   * @returns {Promise<SyncCheckResult|null>}
   * @private
   */
  async _fastPathPhase() {
    if (this._genesisCompatible === false) {
      return SyncResult.GENESIS_MISMATCH;
    }

    const localCookie = await DeviceCookie.isValidLocally(
      this._storage,
      this._cookieTtlMinutes
    );

    if (!localCookie) return null; // Fall through to auth gate

    let remoteCookieRaw;
    try {
      remoteCookieRaw = await this._remote.pullCookie();
      // Cache for reuse in _reconcileAndClaim (avoids duplicate pull)
      this._lastRemoteCookie = remoteCookieRaw;
    } catch {
      return SyncResult.OFFLINE;
    }

    if (!remoteCookieRaw) return null; // No remote cookie — fall through

    const remoteCookie = DeviceCookie.parseRemote(remoteCookieRaw);
    if (remoteCookie && DeviceCookie.matches(localCookie, remoteCookie)) {
      // Same device session — fast path
      await this._pushOnFastPath(localCookie);
      return SyncResult.READY;
    }

    // Remote cookie parsed but specifiers differ → auth gate with mismatch flag.
    // Store mismatch state so _authGatePhase can read it without re-fetching.
    if (remoteCookie) {
      this._specifierMismatch = true;
    }

    return null; // Fall through to auth gate
  }

  /**
   * Auth gate: decide READY, REAUTH_NEEDED, or delegate to _reconcileAndClaim.
   * @returns {Promise<SyncCheckResult>}
   * @private
   */
  async _authGatePhase() {
    const specifierMismatch = this._specifierMismatch === true;
    this._specifierMismatch = false;

    // Check local cookie TTL (re-check in case _fastPathPhase was skipped)
    const localCookie = await DeviceCookie.isValidLocally(
      this._storage,
      this._cookieTtlMinutes
    );

    // TTL expired or no local cookie — always force auth.
    // No cookie is created here: cookie creation only happens after
    // explicit re-authentication via _reconcileAndClaim.  The cookie
    // is the source of truth, not the cached crypto key.
    if (!localCookie) {
      return SyncResult.REAUTH_NEEDED;
    }

    // No master key — force auth regardless of cookie state.
    const mk = this._crypto.getMasterKey();
    if (!mk) {
      return SyncResult.REAUTH_NEEDED;
    }

    // Specifier mismatch: different device wrote last — require explicit
    // re-authentication (matches Python behavior). The previous approach
    // of implicit reconcile caused unbounded unlock latency because it
    // always pulled the full staging blob.
    if (specifierMismatch) {
      return SyncResult.REAUTH_NEEDED;
    }

    // No mismatch — same-device scenario: proceed to reconcile for
    // cross-client merge (Bug 3a fix). Different clients on same device
    // must merge entries.
    return this._reconcileAndClaim(mk);
  }

  // ------------------------------------------------------------------
  // Reconcile and claim
  // ------------------------------------------------------------------

  /**
   * After successful auth: claim staging ownership for this device.
   *
   * Pulls remote cookie to discover which device last wrote, then
   * reconciles via _reconcileDifferentDevice (pull, merge, push, new cookie).
   *
   * @param {string} masterKeyHex - 64-char hex master key.
   * @returns {Promise<SyncCheckResult>}
   * @private
   */
  async _reconcileAndClaim(masterKeyHex) {
    // ── Genesis Gate ────────────────────────────────────────────
    // When called directly (e.g. from performReauth), genesis may
    // not have been checked yet. Use the _genesisCompatible cache
    // (false = mismatch, true = compatible, null = unchecked).
    if (this._genesisCompatible === false) {
      return SyncResult.GENESIS_MISMATCH;
    }
    if (this._remote && this._genesisCompatible === null) {
      const genesisResult = await this._genesisGatePhase();
      if (genesisResult !== null) return genesisResult;
    }

    // Reuse cookie from _fastPathPhase to avoid duplicate network call
    let remoteCookieRaw = this._lastRemoteCookie;
    this._lastRemoteCookie = null;

    if (remoteCookieRaw === undefined || remoteCookieRaw === null) {
      try {
        remoteCookieRaw = await this._remote.pullCookie();
      } catch {
        return SyncResult.OFFLINE;
      }
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

    // Bug 3a fix: Always pull + merge, even for same device UUID.
    // Same-device doesn't mean local-is-authoritative — the remote
    // may have entries from a different client. Client-type suffix
    // ({uuid}-cli vs {uuid}-web) guarantees distinct identities.
    return this._reconcileDifferentDevice(masterKeyHex, localDeviceUuid);
  }

  /**
   * Pull remote blob, reconcile, push merged entries, create cookie.
   * @returns {Promise<SyncCheckResult>}
   * @private
   */
  async _reconcileDifferentDevice(masterKeyHex, localDeviceUuid) {
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
        const remoteDTOs = remoteBlob.entries
          .map((raw) => rawEntryToDTO(raw))
          .filter(Boolean);
        const merged = mergeEntries(localEntries, remoteDTOs);
        // Filter committed entries — same as CLI service.py:505-507:
        // "merged = [e for e in merged if not e.get('committed')]"
        const uncommitted = merged.filter((e) => !e.committed);
        await this._local.writeEntries(uncommitted);
      } catch (err) {
        console.warn('Merge failed, pushing local blob:', err.message);
      }
    }

    // Push the (merged or local) blob to remote
    await this.pushBlobOnly(masterKeyHex, localDeviceUuid);

    // After pushBlobOnly already published the hash index, also pull
    // and cache it locally so future Tier 1 checks are instantaneous
    try {
      await this._pullAndCacheStagingHashIndex(masterKeyHex);
    } catch {
      // Non-critical — rebuildable from entries
    }

    // Create new device cookie (fresh specifier, local + remote)
    try {
      await DeviceCookie.destroyLocally(this._storage);
      this._deviceId = null; // Invalidate cached deviceId
      const remoteCookie = await DeviceCookie.create(
        localDeviceUuid,
        this._storage,
        this._crypto
      );
      if (remoteCookie) {
        await this._pushRemoteCookie(remoteCookie);
      }
    } catch {
      // Non-critical: cookie creation failure doesn't block READY
    }

    return SyncResult.READY;
  }

  // ------------------------------------------------------------------
  // Cookie push helper
  // ------------------------------------------------------------------

  /**
   * Push a remote cookie dict to the transport.
   * Encodes {device_uuid, device_specifier} as JSON bytes.
   * @param {{ device_uuid: string, device_specifier: string }} remoteCookie
   * @private
   */
  async _pushRemoteCookie(remoteCookie) {
    const cookieBytes = new TextEncoder().encode(JSON.stringify(remoteCookie));
    await this._remote.pushCookie(cookieBytes);
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
      // Reuse existing device specifier when available — prevents
      // re-rolling on every same-device write which causes spurious
      // cookie mismatches for the CLI.
      const existingCookie = await this._storage.get(LOCAL_COOKIE);
      let specifier;

      if (existingCookie?.device_specifier) {
        // Same-device write — reuse existing specifier, only update creation_time
        specifier = existingCookie.device_specifier;
        await this._storage.set(LOCAL_COOKIE, {
          device_specifier: specifier,
          creation_time: Date.now(),
        });
      } else {
        // First push after onboarding/re-auth — generate new specifier
        const remoteCookie = await DeviceCookie.create(
          deviceId, this._storage, this._crypto
        );
        specifier = remoteCookie?.device_specifier;
      }

      // Push remote cookie with the specifier (old or new).
      // Remote format: {device_uuid, device_specifier} — no creation_time.
      if (specifier) {
        await this._pushRemoteCookie({ device_uuid: deviceId, device_specifier: specifier });
      }
    } catch (err) {
      console.warn('Device cookie push failed:', err.message);
    }

    this._lastPushAt = Date.now();

    // Push staging hash index (best-effort, non-fatal)
    await this._pushStagingHashIndex(entries);
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
      await this._pushRemoteCookie(remoteCookie);
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

    // Push staging hash index (best-effort, non-fatal)
    await this._pushStagingHashIndex(entries);
  }

  // ------------------------------------------------------------------
  // Staging hash index push
  // ------------------------------------------------------------------

  /**
   * Push staging hash index + sha256 to remote.
   *
   * Builds the hash index from current entries, pushes both the encrypted
   * hash_index.json and its sha256 to remote for Tier 1/Tier 2 fast path.
   * Best-effort — failures are logged but never thrown.
   *
   * @param {Array} entries - Current staging entry DTOs.
   * @returns {Promise<void>}
   * @private
   */
  async _pushStagingHashIndex(entries) {
    if (!this._remote) return;

    const mk = this._crypto.getMasterKey();
    if (!mk) return;

    try {
      // Build index from entries
      const hashIndex = buildStagingHashIndex(entries);
      const indexJson = JSON.stringify(hashIndex);

      // Encrypt the hash index JSON before pushing (D3)
      const obfuscatedB64 = this._crypto.obfuscateBlob(indexJson, mk);
      const indexBytes = base64ToBytes(obfuscatedB64);
      await this._transport.push(REMOTE_STAGING_HASH_INDEX, indexBytes);

      // Push SHA-256 of the ENCRYPTED blob for Tier 1 comparison
      // The worker computes over the encrypted blob — it never sees the plaintext
      const sha256 = this._crypto.sha256(new TextDecoder().decode(indexBytes));
      await this._transport.push(REMOTE_STAGING_HASH_INDEX_SHA256, new TextEncoder().encode(sha256));

      // Cache locally for next Tier 1 comparison
      await this._local.writeHashIndex(hashIndex);
    } catch (err) {
      console.warn('pushStagingHashIndex: failed:', err.message);
    }
  }

  /**
   * Pull remote staging hash index, decrypt, and cache locally.
   *
   * Best-effort — if the remote doesn't have a hash index (legacy),
   * builds one from local entries and pushes it (bootstrap).
   *
   * @param {string} mk - Master key hex.
   * @returns {Promise<void>}
   * @private
   */
  async _pullAndCacheStagingHashIndex(mk) {
    if (!this._remote) return;

    try {
      const rawBytes = await this._transport.pull(REMOTE_STAGING_HASH_INDEX);
      if (rawBytes !== null) {
        // Decrypt: deobfuscateBlob(base64, mk) → JSON string
        const b64 = bytesToBase64(rawBytes);
        const plaintext = this._crypto.deobfuscateBlob(b64, mk);
        const remoteIndex = JSON.parse(plaintext);
        await this._local.writeHashIndex(remoteIndex);
      } else {
        // No remote hash index — bootstrap from local entries
        const entries = await this._local.readEntries();
        await this._pushStagingHashIndex(entries);
      }
    } catch {
      // Non-critical — hash index is rebuildable
    }
  }

  // ------------------------------------------------------------------
  // Ledger block sync
  // ------------------------------------------------------------------

  /**
   * Push local ledger blocks to remote.
   *
   * Lists remote indices via transport.listFiles('ledger/blocks/'),
   * then pushes only blocks whose index is not already on remote.
   * Blocks are JSON-serialized then obfuscated via crypto.obfuscateBlob().
   * Index is pushed after blocks.
   *
   * Skipped when: no transport, no master key, or no local blocks.
   * Errors are logged but never thrown — push is best-effort.
   *
   * @param {{ forceAll?: boolean }} [opts]
   * @returns {Promise<number>} Number of blocks pushed (0 = nothing to do or error).
   */
  async pushLedgerBlocks(opts = {}) {
    const forceAll = opts.forceAll === true;

    if (!this._remote) return 0;

    const mk = this._crypto.getMasterKey();
    if (!mk) return 0;

    const blocks = (await this._storage.get(LOCAL_LEDGER_BLOCKS)) || [];
    if (blocks.length === 0) return 0;

    // Discover remote indices (skip when force-pushing all blocks)
    /** @type {Set<number>} */
    let remoteIndices = new Set();
    if (!forceAll) {
      try {
        const remoteFiles = await this._transport.listFiles(REMOTE_LEDGER_BLOCKS_PREFIX);
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
    }

    // Push blocks in natural chain order (enumerate-style, matching
    // the Python CLI's push_blocks). Using day_index-based sorting
    // would scramble summary blocks (month_summary / year_summary)
    // which have no day_index and would default to _blockIdx = 0
    // — the same as genesis — corrupting the remote chain.
    console.log('[pushLedgerBlocks FIXED] using enumerate order, total blocks:', blocks.length);

    // Genesis collision guard: if the remote already has a genesis at index 0
    // and it differs from the local genesis, abort the push. Pushing day blocks
    // that chain from a different genesis than what's on remote would corrupt
    // the remote chain, making it unimportable by other clients.
    if (!forceAll && remoteIndices.has(0) && blocks.length > 0) {
      try {
        const raw = await this._transport.pull(`${REMOTE_LEDGER_BLOCKS_PREFIX}000000.json`);
        if (raw) {
          const b64 = btoa(String.fromCharCode(...raw));
          const plaintext = this._crypto.deobfuscateBlob(b64, mk);
          const remoteGenesis = JSON.parse(plaintext);
          const remoteHash = remoteGenesis.block_hash || remoteGenesis.day_hash || '';
          const localHash = blocks[0].block_hash || blocks[0].day_hash || '';
          if (remoteHash && localHash && remoteHash !== localHash) {
            console.error(
              '[pushLedgerBlocks] GENESIS COLLISION: local genesis does not match remote. ' +
              'Aborting push to prevent chain corruption. ' +
              'Clear the remote bucket first, or import the existing remote ledger.'
            );
            throw new Error(
              'Genesis collision: remote has a different genesis. ' +
              'Clear the remote or import the existing ledger before pushing.'
            );
          }
        }
      } catch (err) {
        if (err.message && err.message.includes('Genesis collision')) throw err;
        // Pull/deobfuscation failed — may be using a different key, which is
        // itself a sign of incompatible chains. Warn but don't block (the chain
        // verification on the other side will catch it).
        console.warn('[pushLedgerBlocks] Could not verify remote genesis:', err.message);
      }
    }

    let pushed = 0;
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const fileIdx = i;

      if (!forceAll && remoteIndices.has(fileIdx)) continue;

      try {
        const json = JSON.stringify(block);
        const obfuscatedB64 = this._crypto.obfuscateBlob(json, mk);
        const bytes = base64ToBytes(obfuscatedB64);
        const path = `${REMOTE_LEDGER_BLOCKS_PREFIX}${String(fileIdx).padStart(6, '0')}.json`;
        await this._transport.push(path, bytes);
        pushed++;
      } catch (err) {
        console.warn('pushLedgerBlocks: push failed for block', fileIdx, ':', err.message);
      }
    }

    // Push index
    if (pushed > 0) {
      try {
        const index = await this._storage.get(LOCAL_LEDGER_INDEX);
        if (index) {
          const json = JSON.stringify(index);
          const obfuscatedB64 = this._crypto.obfuscateBlob(json, mk);
          const bytes = base64ToBytes(obfuscatedB64);
          await this._transport.push(REMOTE_LEDGER_INDEX, bytes);
        }
      } catch (err) {
        console.warn('pushLedgerBlocks: index push failed:', err.message);
      }
    }

    // Push hash index artifacts whenever blocks exist (best-effort, non-fatal).
    // Always pushed regardless of whether new blocks were transferred — the
    // hash index enables Tier 1 fast path on next unlock. Only skipped when
    // there are no blocks at all (handled by early return above).
    if (blocks.length > 0) {
      try {
        const hi = buildHashIndex(blocks);
        const hiJson = JSON.stringify(hi);
        // Hash index JSON is plain text — NOT obfuscated (no privacy risk, just seals)
        await this._transport.push(REMOTE_HASH_INDEX, new TextEncoder().encode(hiJson));
        // SHA-256 companion for Tier 1 fast path
        const hiSha256 = this._crypto.sha256(hiJson);
        await this._transport.push(REMOTE_HASH_INDEX_SHA256, new TextEncoder().encode(hiSha256));
        // Also cache locally for next Tier 1 check
        await this._storage.set(LOCAL_HASH_INDEX, hi);
      } catch (err) {
        console.warn('pushLedgerBlocks: hash index push failed:', err.message);
      }
    }

    return pushed;
  }

  // ------------------------------------------------------------------
  // Diagnostics
  // ------------------------------------------------------------------

  /**
   * Current genesis compatibility state.
   * null = unchecked, true = compatible, false = mismatch.
   * @returns {boolean|null}
   */
  get genesisCompatible() {
    return this._genesisCompatible;
  }

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
   * Stats from the last genesis-gate merge, or null if no merge occurred.
   * @returns {{ forkIndex: number, localEntries: number, remoteEntries: number,
   *             duplicatesSkipped: number, mergedEntries: number,
   *             newBlockCount: number }|null}
   */
  get lastMergeStats() {
    return this._lastMergeStats;
  }

  /**
   * Clear all known keys from the remote R2 bucket.
   *
   * Used when the user wants to overwrite a remote ledger with a
   * different genesis (genesis mismatch override). Deletes staging
   * blob, cookie, and all ledger block files via HTTP DELETE and
   * resets the genesis compatibility gate.
   *
   * @returns {Promise<void>}
   * @throws {Error} If remote transport is not configured.
   */
  async clearRemote() {
    if (!this._remote || !this._transport) {
      throw new Error('No remote transport configured');
    }

    let failures = 0;
    let blockFileCount = 0;

    // Delete ledger block files
    try {
      const files = await this._transport.listFiles(REMOTE_LEDGER_BLOCKS_PREFIX);
      if (files && files.length > 0) {
        blockFileCount = files.length;
        for (const filename of files) {
          try {
            await this._transport.delete(REMOTE_LEDGER_BLOCKS_PREFIX + filename);
          } catch (err) {
            failures++;
            console.warn(`clearRemote: failed to delete ${REMOTE_LEDGER_BLOCKS_PREFIX}${filename}: ${err.message}`);
          }
        }
      }
      try {
        await this._transport.delete(REMOTE_LEDGER_INDEX);
      } catch { /* may not exist */ }
    } catch (err) {
      failures++;
      console.warn(`clearRemote: failed to list ledger blocks: ${err.message}`);
    }

    // Delete staging blob, cookie, and hash index files
    const stagingKeys = [
      REMOTE_STAGING_BLOB,
      REMOTE_DEVICE_COOKIE,
      REMOTE_HASH_INDEX,
      REMOTE_HASH_INDEX_SHA256,
      REMOTE_STAGING_HASH_INDEX,
      REMOTE_STAGING_HASH_INDEX_SHA256,
    ];
    for (const key of stagingKeys) {
      try {
        await this._transport.delete(key);
      } catch (err) {
        failures++;
        console.warn(`clearRemote: failed to delete ${key}: ${err.message}`);
      }
    }

    if (failures >= 2 + blockFileCount) {
      throw new Error('Failed to clear any remote keys. The remote may be unreachable.');
    }

    this._genesisCompatible = null;
    this._transport.resetCache();
  }

  /**
   * [DEBUG] Check whether hash index files exist on the remote.
   * Temporary helper for hash_index bootstrap gap debugging.
   * @returns {Promise<{hashIndexJson: boolean, hashIndexSha256: boolean}>}
   */
  async _debugCheckHashIndex() {
    if (!this._transport) return { hashIndexJson: false, hashIndexSha256: false };
    const [hiJson, hiSha] = await Promise.all([
      this._transport.pull(REMOTE_HASH_INDEX).then(b => b !== null).catch(() => false),
      this._transport.pull(REMOTE_HASH_INDEX_SHA256).then(b => b !== null).catch(() => false),
    ]);
    return { hashIndexJson: hiJson, hashIndexSha256: hiSha };
  }
}
