/**
 * commonplace_push_service.js — Commonplace sealed-chain push (ADR-031 remote-sync).
 *
 * Pushes the full Commonplace chain (genesis + day blocks) to the remote
 * Worker/R2 blob store under the `commonplace/...` prefix:
 *   - each block serialized to sorted-keys, space-free PHPSPEC JSON
 *     (`jsonSortNoSpaces`), obfuscated with the shared master key, and
 *     uploaded to `commonplace/blocks/NNNNNN.json` (genesis at `000000`);
 *   - `commonplace/hash_index.json` — a plaintext JSON array of block hashes
 *     in chain order (mirrors the ledger's `ledger/hash_index.json` 1:1).
 *
 * Push is idempotent — repeated pushes overwrite the same remote files.
 * Mirrors Flutter's `CommonplacePushService` (web delta: plain `{ pushed,
 * failedBlocks }` result object instead of a Dart `PushResult`; no StateError
 * class — a plain `Error` is thrown).
 */

import { jsonSortNoSpaces } from '../ledger/utils.js';
import { pushChainPayloads } from '../sync/chain_transport_helpers.js';
import {
  REMOTE_COMMONPLACE_BLOCKS_PREFIX,
  REMOTE_COMMONPLACE_HASH_INDEX,
} from '../sync/keys.js';

export class CommonplacePushService {
  /**
   * @param {object} opts
   * @param {object} opts.crypto - CryptoService-like (hasMasterKey/getMasterKey/obfuscateBlob).
   * @param {object} opts.transport - Transport with `push(path, Uint8Array)`.
   * @param {import('./commonplace_chain.js').CommonplaceChain} opts.chain
   */
  constructor({ crypto, transport, chain }) {
    this.crypto = crypto;
    this.transport = transport;
    this.chain = chain;
    /** @type {Promise<{pushed:number, failedBlocks:number[]}>|null} */
    this._pendingPush = null;
  }

  /**
   * Push every block in the chain (genesis + day blocks) to the remote.
   *
   * Throws when no master key is cached (obfuscation is impossible without it)
   * and when the chain is empty (pushing zero blocks would wipe the remote
   * hash_index). Concurrent calls are serialized — the second caller waits for
   * the first and receives the same result.
   *
   * @returns {Promise<{pushed:number, failedBlocks:number[]}>}
   */
  async pushAll() {
    if (this._pendingPush) return this._pendingPush;

    if (!this.crypto.hasMasterKey()) {
      throw new Error('No master key cached. Call setMasterKey() first.');
    }
    const mkHex = this.crypto.getMasterKey();

    this._pendingPush = this._doPushAll(mkHex);
    try {
      return await this._pendingPush;
    } finally {
      this._pendingPush = null;
    }
  }

  /**
   * Push an explicit list of blocks (chain maps) at their 0-based chain
   * positions (commit auto-push path).
   *
   * @param {object[]} blocks
   * @returns {Promise<{pushed:number, failedBlocks:number[]}>}
   */
  async pushBlocks(blocks) {
    if (!this.crypto.hasMasterKey()) {
      throw new Error('No master key cached. Call setMasterKey() first.');
    }
    const mkHex = this.crypto.getMasterKey();
    return this._pushChainBlocks(mkHex, blocks);
  }

  async _doPushAll(mkHex) {
    const blocks = await this.chain.readAll();
    if (blocks.length === 0) {
      throw new Error(
        'Cannot push an empty Commonplace chain — it has no blocks. ' +
        'Bootstrap a genesis first via CommonplaceService.ensureGenesis().'
      );
    }
    return this._pushChainBlocks(mkHex, blocks);
  }

  /**
   * Shared transport loop (delegates to `pushChainPayloads`): serialize +
   * obfuscate + push each block at its 0-based chain position, then push the
   * plaintext hash index (successfully pushed block hashes in chain order).
   */
  async _pushChainBlocks(mkHex, blocks) {
    const payloads = blocks.map((block, i) => ({
      index: i,
      hash: this.chain.getBlockHashFor(block),
      serialized: jsonSortNoSpaces(block),
    }));

    const { pushed, failedBlocks } = await pushChainPayloads({
      crypto: this.crypto,
      transport: this.transport,
      mkHex,
      blocksPrefix: REMOTE_COMMONPLACE_BLOCKS_PREFIX,
      hashIndexPath: REMOTE_COMMONPLACE_HASH_INDEX,
      payloads,
    });

    return { pushed, failedBlocks };
  }
}
