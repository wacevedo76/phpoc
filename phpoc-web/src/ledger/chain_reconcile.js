/**
 * chain_reconcile.js — shared append-only chain-merge core (ADR-029/029a/030/031).
 *
 * Mirrors Flutter's `chain_reconcile.dart` `reconcileChainCore`: a **pure
 * function** (no I/O, no instance state) so the sealed chains share one
 * reconciliation implementation instead of diverging (D9). Callers supply:
 *
 *   - `local`          — the local chain read as block maps;
 *   - `remoteBlocks`   — the remote chain blocks to merge;
 *   - `blockHash`      — the per-type hash resolver (`getBlockHash` /
 *                        `getBlockHashFor`);
 *   - `genesisType`    — the chain's genesis block type;
 *   - `appendBlocks`   — appends a list of block maps to the local chain
 *                        (async on web, where the store write is awaited).
 *
 * Semantics (preserved exactly from the original implementations):
 *   - a remote block identical (same hash) to the local one is skipped;
 *   - a remote tail that bridges the last local block is appended in order;
 *   - same index / different hash, a non-bridging tip, or a non-genesis-first
 *     block on an empty chain is reported as a conflict and **never written**
 *     (a stale device never clobbers the remote canonical chain).
 */

/**
 * @param {object} opts
 * @param {object[]} opts.local
 * @param {object[]} opts.remoteBlocks
 * @param {(block: object) => string} opts.blockHash
 * @param {string} opts.genesisType
 * @param {(blocks: object[]) => Promise<void>} opts.appendBlocks
 * @returns {Promise<{conflictedIndices: number[], appended: number}>}
 */
export async function reconcileChainCore({
  local,
  remoteBlocks,
  blockHash,
  genesisType,
  appendBlocks,
}) {
  const conflicted = [];
  let appended = 0;

  for (let i = 0; i < remoteBlocks.length; i++) {
    const remote = remoteBlocks[i];

    if (i < local.length) {
      // Same ordinal exists locally: skip if identical, else conflict.
      if (blockHash(local[i]) === blockHash(remote)) continue;
      conflicted.push(i);
      return { conflictedIndices: conflicted, appended };
    }

    // Remote block extends beyond the local tail.
    const toAppend = remoteBlocks.slice(i);
    if (i === 0) {
      // No local blocks at all — only a genesis can start a chain.
      if (toAppend[0].type !== genesisType) {
        conflicted.push(0);
        return { conflictedIndices: conflicted, appended };
      }
      await appendBlocks(toAppend);
      appended = toAppend.length;
      break;
    }

    // The introduced remote block must bridge to the last local block;
    // otherwise the remote fork diverged earlier → conflict, no write.
    const expectedPrev = blockHash(local[i - 1]);
    const actualPrev = remote.prev_hash || '';
    if (expectedPrev && actualPrev !== expectedPrev) {
      conflicted.push(i);
      return { conflictedIndices: conflicted, appended };
    }
    await appendBlocks(toAppend);
    appended = toAppend.length;
    break;
  }

  return { conflictedIndices: conflicted, appended };
}
