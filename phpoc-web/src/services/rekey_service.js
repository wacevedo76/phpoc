/**
 * RekeyService — C-2 Full Seed Replacement (re-key) for phpoc-web.
 *
 * The only operation that nullifies a leaked/compromised recovery seed:
 * mint a fresh 32-byte CSPRNG seed → derive a new Master Key → re-encrypt +
 * re-seal the entire local ledger chain under the new MK → rewrite the
 * genesis recovery-seed + identity-secret fallback → re-encrypt the
 * passphrase tokens + device cookie → rotate the cookie specifier → push the
 * rewritten chain to remote (when a sync is wired).
 *
 * Design (option (a), PHPSPEC §2.3):
 *   - `deriveMasterKey(newSeed)` returns the raw base64-decoded 32 seed bytes
 *     as hex → the new seed's raw bytes become the new Master Key.
 *   - `key_version` is NOT bumped (option (a) parity with Flutter/Python hard
 *     rotate). No new block fields are introduced.
 *   - The identity secret is device-scoped and INDEPENDENT of the MK: it is
 *     preserved across re-key, and every block's `identity_seal` is re-signed
 *     over the new block hash with the SAME identity secret (via crypto.sign).
 *
 * Web-specific deltas (vs Flutter/Python):
 *   - Dual seed storage: `phpoc_seed` + genesis `recovery_seed_enc` + the two
 *     passphrase tokens (`phpoc_passphrase_hash`, `phpoc_pdk_token`) are all
 *     rewritten.
 *   - Entry `hash` is ciphertext-bound on web (computeEntryHash hashes the
 *     encrypted data dict), so every entry hash is recomputed after re-encrypt.
 *     `content_hash` is plaintext-bound and carried through unchanged.
 *
 * Seal inputs follow the ADR-029/029a closed whitelist (`seal_fields.js`);
 * `identity`, `identity_seal`, hash keys, `format_version`, and `key_version`
 * are never seal inputs.
 */

import { computeSeal } from '../ledger/seal_fields.js';
import { computeEntryHash, getBlockHash } from '../ledger/utils.js';

// ── Storage keys (web contract) ────────────────────────────────────────────
const STORED_SEED_KEY = 'phpoc_seed';
const STORED_PASSPHRASE_HASH_KEY = 'phpoc_passphrase_hash';
const PDK_TOKEN_KEY = 'phpoc_pdk_token';
const IDENTITY_SECRET_KEY = 'phpoc_identity_secret';
const BLOCKS_KEY = 'ledger:blocks';
const COOKIE_KEY = 'cookie';
const REKEYED_KEY = 'phpoc_rekeyed';
const BACKUP_KEY = 'phpoc_rekey_backup';
const VERIFY_TOKEN = 'phpoc_pdk_verify';
const PBKDF2_ITERATIONS = 600000;

/** Return the hash key of a block irrespective of its type. */
function hashKeyFor(block) {
  if (block.block_hash !== undefined) return 'block_hash';
  if (block.day_hash !== undefined) return 'day_hash';
  if (block.month_hash !== undefined) return 'month_hash';
  return 'year_hash';
}

export class RekeyService {
  /**
   * @param {object} deps
   * @param {object} deps.crypto - CryptoService-like (encrypt/decrypt/seal/sign/
   *        sha256/deriveMasterKey/derivePdk/generateSeed/generateDeviceSpecifier).
   * @param {import('../sync/storage.js').StorageBackend} deps.storage - Key-value store.
   * @param {object|null} [deps.sync] - Optional SyncService with `pushLedgerBlocks`.
   * @param {object|null} [deps.ledgerExport] - Optional ledger export helper.
   */
  constructor({ crypto, storage, sync = null, ledgerExport = null }) {
    this.crypto = crypto;
    this.storage = storage;
    this.sync = sync || null;
    this.ledgerExport = ledgerExport || null;
    this._lastNewSeed = null;
    this._revealPending = false;
  }

  /**
   * Mint a fresh 32-byte recovery seed (base64, 44 chars), guaranteed to
   * differ from `currentSeed`.
   * @param {string|null} [currentSeed=null]
   * @returns {string} base64-encoded 44-character seed.
   */
  mintNewSeed(currentSeed = null) {
    let seed = this.crypto.generateSeed();
    while (currentSeed && seed === currentSeed) {
      seed = this.crypto.generateSeed();
    }
    return seed;
  }

  /**
   * Deterministic fingerprint of a seed (SHA-256 hex, 64 chars) for drift
   * detection and double-run guards.
   * @param {string} seed - base64 recovery seed.
   * @returns {string}
   */
  seedFingerprint(seed) {
    return this.crypto.sha256(seed);
  }

  /**
   * Snapshot the current chain (blocks array) as a JSON string.
   * @returns {Promise<string>}
   */
  async preflightSnapshot() {
    const blocks = (await this.storage.get(BLOCKS_KEY)) || [];
    return JSON.stringify(blocks);
  }

  /**
   * Write a recovery backup (blocks + seed) before any mutation, and return
   * the backup key + the full snapshot.
   * @returns {Promise<{backupKey: string, snapshot: string}>}
   */
  async preflightSnapshotAndWrite() {
    const blocks = (await this.storage.get(BLOCKS_KEY)) || [];
    const seed = await this.storage.get(STORED_SEED_KEY);
    const backup = {
      version: 1,
      taken_at: Date.now(),
      blocks,
      seed,
    };
    const backupKey = `${BACKUP_KEY}:${Date.now()}`;
    await this.storage.set(backupKey, backup);
    return { backupKey, snapshot: JSON.stringify(backup) };
  }

  /**
   * Whether a re-key marker already exists (prevents double-run).
   * @returns {Promise<boolean>}
   */
  async hasRekeyed() {
    return !!(await this.storage.get(REKEYED_KEY));
  }

  /**
   * Two-step seed reveal, step 1: never leaks the raw seed; only marks that a
   * reveal is pending. The raw seed is surfaced solely via confirmReveal().
   * @returns {Promise<null>}
   */
  async revealSecretStep1() {
    this._revealPending = true;
    return null;
  }

  /**
   * Two-step seed reveal, step 2: returns the one-time new seed, only if
   * step 1 was invoked first.
   * @returns {string|null}
   */
  confirmReveal() {
    if (!this._revealPending) return null;
    this._revealPending = false;
    return this._lastNewSeed || null;
  }

  /**
   * Verify the current passphrase against the stored verification tokens
   * (fast sha256(PDK:seed) hash, then the PDK-encrypted token fallback).
   * @private
   */
  async _verifyPassphrase(passphrase, seed) {
    if (!passphrase) return false;
    const pdk = this.crypto.derivePdk(passphrase, PBKDF2_ITERATIONS);

    const storedHash = await this.storage.get(STORED_PASSPHRASE_HASH_KEY);
    if (storedHash) {
      return this.crypto.sha256(pdk + ':' + seed) === storedHash;
    }

    const pdkToken = await this.storage.get(PDK_TOKEN_KEY);
    if (pdkToken) {
      try {
        return this.crypto.decrypt(pdkToken, pdk) === VERIFY_TOKEN;
      } catch {
        return false;
      }
    }

    // No token stored — cannot verify (legacy ledger); allow through.
    return true;
  }

  /** Rotate the device-cookie specifier so old-MK sessions re-auth. @private */
  async _rotateDeviceCookie() {
    const cookie = await this.storage.get(COOKIE_KEY);
    if (!cookie || typeof cookie !== 'object') return;
    cookie.device_specifier = this.crypto.generateDeviceSpecifier();
    cookie.creation_time = Date.now();
    await this.storage.set(COOKIE_KEY, cookie);
  }

  /** Recover the device-scoped identity secret (key-independent). @private */
  async _recoverIdentitySecret(blocks, oldMk) {
    const stored = await this.storage.get(IDENTITY_SECRET_KEY);
    if (stored) return stored;
    const genesis = blocks[0];
    if (genesis && genesis.identity && genesis.identity.identity_secret_enc_fallback) {
      return this.crypto.decrypt(genesis.identity.identity_secret_enc_fallback, oldMk);
    }
    return null;
  }

  /**
   * Re-encrypt + re-seal every block under the new key set. Built fully in
   * memory (D4 atomic swap) so a mid-loop throw leaves the persisted chain
   * untouched.
   * @private
   */
  _rebuildBlocks(blocks, { newSeed, oldMk, newMk, newPdk, identitySecret }) {
    const rebuilt = [];
    for (let i = 0; i < blocks.length; i++) {
      const block = JSON.parse(JSON.stringify(blocks[i]));

      // Genesis: rewrite the seed envelope + identity-secret fallback under
      // the new key set. identity_pub_key is key-independent and preserved.
      if (block.type === 'genesis' && block.identity) {
        block.identity.recovery_seed_enc = this.crypto.encrypt(newSeed, newPdk);
        if (identitySecret) {
          block.identity.identity_secret_enc_fallback = this.crypto.encrypt(
            identitySecret, newMk,
          );
        }
      }

      // Re-encrypt every entry `_enc` field (old MK → new MK) and recompute
      // the ciphertext-bound entry hash. content_hash (plaintext) is invariant.
      if (Array.isArray(block.entries)) {
        for (const entry of block.entries) {
          if (!entry || !entry.data) continue;
          const data = entry.data;
          for (const [key, value] of Object.entries(data)) {
            if (key.endsWith('_enc') && value !== null && value !== undefined && value !== '') {
              const plain = this.crypto.decrypt(value, oldMk);
              data[key] = this.crypto.encrypt(plain, newMk);
            }
          }
          entry.hash = computeEntryHash(data, this.crypto);
        }
      }

      // Cascade prev_hash (genesis keeps the all-zero anchor).
      if (i > 0) {
        block.prev_hash = getBlockHash(rebuilt[i - 1]);
      }

      // Re-seal under the new MK + re-sign with the same identity secret.
      const hashKey = hashKeyFor(block);
      block[hashKey] = computeSeal(block, this.crypto, newMk);
      if (identitySecret && block.identity_seal) {
        block.identity_seal = this.crypto.sign(block[hashKey], identitySecret);
      }

      rebuilt.push(block);
    }
    return rebuilt;
  }

  /**
   * Rewrite the stored seed + passphrase tokens under the new key set (R5).
   * @private
   */
  async _persistNewKeySet(newSeed, newPdk) {
    await this.storage.set(STORED_SEED_KEY, newSeed);
    await this.storage.set(PDK_TOKEN_KEY, this.crypto.encrypt(VERIFY_TOKEN, newPdk));
    await this.storage.set(
      STORED_PASSPHRASE_HASH_KEY,
      this.crypto.sha256(newPdk + ':' + newSeed),
    );
  }

  /** Persist the one-time re-key marker (B4 double-run guard). @private */
  async _recordRekeyMarker(newSeed) {
    await this.storage.set(REKEYED_KEY, {
      seed_fingerprint: this.seedFingerprint(newSeed),
      rekeyed_at: Date.now(),
    });
  }

  /**
   * Push the rewritten chain (full replace) when a sync is wired.
   * @returns {Promise<boolean>} true when a push was issued.
   * @private
   */
  async _pushRewrittenChain() {
    if (this.sync && typeof this.sync.pushLedgerBlocks === 'function') {
      await this.sync.pushLedgerBlocks({ forceAll: true });
      return true;
    }
    return false;
  }

  /**
   * Re-key the entire ledger under a freshly-minted seed (option (a)).
   *
   * @param {object} args
   * @param {string} args.oldPassphrase - Current passphrase (two-secret gate).
   * @param {string} args.newPassphrase - New passphrase for the new seed envelope.
   * @param {string} [args.newSeed] - Optional pre-minted seed (minted if omitted).
   * @returns {Promise<{newSeed: string, newMasterKey: string, backupKey: string,
   *   remotePushed: boolean, seedFingerprint: string}>}
   */
  async rekey({ oldPassphrase, newPassphrase, newSeed } = {}) {
    // B3: refuse to double-run once a re-key marker exists.
    if (await this.hasRekeyed()) {
      throw new Error('Ledger already re-keyed — refusing to double-run.');
    }

    // R1 gate: an unlocked session (cached MK) is required.
    const oldMk = this.crypto.getMasterKey();
    if (!oldMk) {
      throw new Error('Session not unlocked — unlock before re-keying.');
    }

    const blocks = (await this.storage.get(BLOCKS_KEY)) || [];
    if (!Array.isArray(blocks) || blocks.length === 0) {
      throw new Error('No ledger chain to re-key.');
    }

    const oldSeed = await this.storage.get(STORED_SEED_KEY);
    if (!oldSeed) {
      throw new Error('No stored recovery seed — cannot re-key.');
    }

    // Two-secret gate: verify the current passphrase.
    if (!(await this._verifyPassphrase(oldPassphrase, oldSeed))) {
      throw new Error('Incorrect passphrase.');
    }

    // Identity secret is device-scoped and key-independent — preserve it.
    const identitySecret = await this._recoverIdentitySecret(blocks, oldMk);

    // D5: backup before any write.
    const { backupKey } = await this.preflightSnapshotAndWrite();

    // R3/R4: fresh seed + new key set.
    const newSeedValue = newSeed || this.mintNewSeed(oldSeed);
    const newMk = this.crypto.deriveMasterKey(newSeedValue);
    const newPdk = this.crypto.derivePdk(newPassphrase, PBKDF2_ITERATIONS);

    // Re-encrypt + re-seal the whole chain in memory (D4 atomic swap).
    const newBlocks = this._rebuildBlocks(blocks, {
      newSeed: newSeedValue,
      oldMk,
      newMk,
      newPdk,
      identitySecret,
    });

    // D4: single atomic local write.
    await this.storage.set(BLOCKS_KEY, newBlocks);

    // R5: rewrite seed + passphrase tokens, and persist the B4 marker.
    await this._persistNewKeySet(newSeedValue, newPdk);
    await this._recordRekeyMarker(newSeedValue);

    // P3: rotate the device cookie specifier.
    await this._rotateDeviceCookie();

    // P1: push the rewritten chain (full replace) when a sync is wired.
    const remotePushed = await this._pushRewrittenChain();

    // P6: the live key set is now the NEW MK (old MK retired).
    this.crypto.setMasterKey(newMk);
    this._lastNewSeed = newSeedValue;

    return {
      newSeed: newSeedValue,
      newMasterKey: newMk,
      backupKey,
      remotePushed,
      seedFingerprint: this.seedFingerprint(newSeedValue),
    };
  }
}
