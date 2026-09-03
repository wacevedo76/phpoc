/**
 * commonplace_pull_service.js — Commonplace sealed-chain pull (ADR-031 remote-sync).
 *
 * Pulls the full Commonplace chain from the remote Worker/R2 blob store under
 * the `commonplace/...` prefix, importing it append-only onto the local chain:
 *   - reads the plaintext `commonplace/hash_index.json` to discover the remote
 *     block count;
 *   - pulls each `commonplace/blocks/NNNNNN.json`, deobfuscates with the master
 *     key, and JSON-parses it into a chain map;
 *   - validates the assembled chain (genesis-first, seals, prev_hash linkage,
 *     per-entry content hashes) via `CommonplaceChain.verifyBlocks`;
 *   - merges via `CommonplaceChain.reconcileRemoteChain` (skip identical, append
 *     a bridging tail, report — never write — a conflict).
 *
 * Mirrors Flutter's `CommonplacePullService` (web delta: plain `{ blocksPulled,
 * failedBlocks }` result object; no background-isolate offload seam).
 */

import { bytesToBase64 } from '../sync/base64.js';
import {
  chainBlockPath,
  readRemoteHashIndex,
  pullRemoteHasMore,
} from '../sync/chain_transport_helpers.js';
import {
  REMOTE_COMMONPLACE_BLOCKS_PREFIX,
  REMOTE_COMMONPLACE_HASH_INDEX,
} from '../sync/keys.js';

export class CommonplacePullService {
  /**
   * @param {object} opts
   * @param {object} opts.crypto - CryptoService-like (hasMasterKey/getMasterKey/deobfuscateBlob).
   * @param {object|null} opts.transport - Transport with `pull(path)`; null = local-only.
   * @param {import('./commonplace_chain.js').CommonplaceChain} opts.chain
   * @param {import('./commonplace_storage.js').CommonplaceStorage} opts.storage
   */
  constructor({ crypto, transport, chain, storage }) {
    this.crypto = crypto;
    this.transport = transport;
    this.chain = chain;
    this.storage = storage;
    /** @type {Promise<{blocksPulled:number, failedBlocks:number[]}>|null} */
    this._inFlightPull = null;
    /** @type {Promise<{blocksPulled:number}>|null} */
    this._inFlightFreshness = null;
  }

  /**
   * Pull all remote blocks and import them append-only onto [chain].
   *
   * Throws without a cached master key. Returns `{ blocksPulled: 0 }` as a
   * no-op when [transport] is null (local-only mode). Concurrent calls are
   * serialized.
   *
   * @returns {Promise<{blocksPulled:number, failedBlocks:number[]}>}
   */
  async pullAll() {
    if (!this.crypto.hasMasterKey()) {
      throw new Error('No master key cached. Call setMasterKey() first.');
    }
    const mkHex = this.crypto.getMasterKey();

    if (!this.transport) {
      return { blocksPulled: 0, failedBlocks: [] };
    }

    if (this._inFlightPull) return this._inFlightPull;

    this._inFlightPull = this._doPullAll(mkHex);
    try {
      return await this._inFlightPull;
    } finally {
      this._inFlightPull = null;
    }
  }

  async _doPullAll(mkHex) {
    const t = this.transport;
    const failedBlocks = [];

    // Step 1: pull the plaintext hash index to discover the block count.
    const hashIndex = await readRemoteHashIndex({
      transport: t,
      hashIndexPath: REMOTE_COMMONPLACE_HASH_INDEX,
    });
    if (!hashIndex || hashIndex.length === 0) {
      return { blocksPulled: 0, failedBlocks: [] };
    }

    // Step 2: fetch + deobfuscate + parse each block in ascending index order.
    const remoteBlocks = [];
    for (let i = 0; i < hashIndex.length; i++) {
      const block = await this._fetchDecodeBlock(t, mkHex, i, failedBlocks);
      if (block != null) remoteBlocks.push(block);
    }

    // Step 3: validate the assembled remote chain before importing.
    if (remoteBlocks.length > 0) {
      if (remoteBlocks[0].type !== 'commonplace_genesis') {
        failedBlocks.push(...remoteBlocks.map((_, i) => i));
        return { blocksPulled: 0, failedBlocks };
      }
      if (!this.chain.verifyBlocks(remoteBlocks)) {
        failedBlocks.push(...remoteBlocks.map((_, i) => i));
        return { blocksPulled: 0, failedBlocks };
      }
    }

    // Step 4: append-only import (skip identical, append bridging tail,
    // report conflict without writing).
    let appended = 0;
    if (remoteBlocks.length > 0) {
      const reconcile = await this.chain.reconcileRemoteChain(remoteBlocks);
      if (reconcile.hasConflicts) {
        failedBlocks.push(...reconcile.conflictedIndices);
        return { blocksPulled: 0, failedBlocks };
      }
      appended = reconcile.appended;
    }

    return { blocksPulled: appended, failedBlocks };
  }

  /**
   * Pull the remote Commonplace chain only when it has grown past the local
   * chain (freshness detector — mirrors the ledger's ADR-030 rule).
   *
   * Compares the plaintext remote block count (`commonplace/hash_index.json`
   * length) against [localBlockCount]: absent/empty or not greater → 0; greater
   * → the number of new blocks available (returned as `blocksPulled`).
   *
   * @param {{localBlockCount: number}} opts
   * @returns {Promise<{blocksPulled:number}>}
   */
  async pullIfRemoteHasMore({ localBlockCount }) {
    if (!this.crypto.hasMasterKey()) {
      throw new Error('No master key cached. Call setMasterKey() first.');
    }
    const t = this.transport;
    if (!t) {
      return { blocksPulled: 0 };
    }

    if (this._inFlightFreshness) return this._inFlightFreshness;

    this._inFlightFreshness = this._doPullIfRemoteHasMore(t, localBlockCount);
    try {
      return await this._inFlightFreshness;
    } finally {
      this._inFlightFreshness = null;
    }
  }

  async _doPullIfRemoteHasMore(t, localBlockCount) {
    const fresh = await pullRemoteHasMore({
      transport: t,
      hashIndexPath: REMOTE_COMMONPLACE_HASH_INDEX,
      localBlockCount,
    });
    return { blocksPulled: fresh };
  }

  /**
   * Fetch, deobfuscate, and parse a single block from the remote.
   * Returns the parsed block map on success, or null on failure (appending to
   * [failedBlocks]).
   */
  async _fetchDecodeBlock(t, mkHex, index, failedBlocks) {
    const path = chainBlockPath(REMOTE_COMMONPLACE_BLOCKS_PREFIX, index);

    let raw;
    try {
      raw = await t.pull(path);
      if (raw === null || raw === undefined) {
        failedBlocks.push(index);
        return null;
      }
    } catch (_) {
      failedBlocks.push(index);
      return null;
    }

    let decoded;
    try {
      decoded = this.crypto.deobfuscateBlob(bytesToBase64(raw), mkHex);
    } catch (_) {
      failedBlocks.push(index);
      return null;
    }

    try {
      return JSON.parse(decoded);
    } catch (_) {
      failedBlocks.push(index);
      return null;
    }
  }
}
