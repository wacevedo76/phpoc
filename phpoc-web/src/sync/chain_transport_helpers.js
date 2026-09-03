/**
 * chain_transport_helpers.js — shared sealed-chain transport helpers (ADR-031).
 *
 * Pure orchestration helpers for pushing/pulling a sealed chain under an R2
 * `<blocksPrefix>` layout (`<prefix>/NNNNNN.json` + a plaintext
 * `<hashIndexPath>`). Mirrors Flutter's `chain_transport_helpers.dart` so the
 * activity ledger and Commonplace book serialize + upload + freshness-check
 * their blocks identically (D9 / cross-client parity).
 *
 * Web delta: `crypto.obfuscateBlob(plaintext, mkHex)` returns a base64 string
 * (the Rust `obfuscate_blob` binding), so `base64ToBytes` converts it to the
 * `Uint8Array` the web `transport.push(path, bytes)` interface expects.
 */

import { base64ToBytes } from './base64.js';

const _textDecoder = new TextDecoder();
const _textEncoder = new TextEncoder();

/**
 * Build the remote block-file path for a chain [index] under [blocksPrefix]
 * (e.g. `ledger/blocks/` or `commonplace/blocks/` → `.../000042.json`).
 *
 * @param {string} blocksPrefix
 * @param {number} index
 * @returns {string}
 */
export function chainBlockPath(blocksPrefix, index) {
  return `${blocksPrefix}${String(index).padStart(6, '0')}.json`;
}

/** Encode a string as UTF-8 bytes for transport. */
export function textBytes(s) {
  return _textEncoder.encode(s);
}

/**
 * Fetch + parse the plaintext hash index (block hashes in chain order).
 * Returns `null` when absent, malformed, or not an array; otherwise returns
 * the (possibly empty) array.
 *
 * @param {object} opts
 * @param {object} opts.transport - Transport with `pull(path)`.
 * @param {string} opts.hashIndexPath
 * @returns {Promise<string[]|null>}
 */
export async function readRemoteHashIndex({ transport, hashIndexPath }) {
  try {
    const raw = await transport.pull(hashIndexPath);
    if (raw === null || raw === undefined) return null;
    const parsed = JSON.parse(_textDecoder.decode(raw));
    if (!Array.isArray(parsed)) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

/**
 * Serialize + obfuscate + push each payload blob to
 * `<blocksPrefix>/NNNNNN.json`, then a plaintext `<hashIndexPath>` JSON array
 * of the successfully pushed block hashes in chain order.
 *
 * A block's `payload.index` (not its list position) selects the remote
 * filename, so callers may push chain maps whose keys differ from their
 * sort/order. The hash-index push is best-effort and non-fatal (it is
 * rebuildable from the pushed blocks).
 *
 * @param {object} opts
 * @param {object} opts.crypto - CryptoService-like with `obfuscateBlob(plaintext, mkHex) → base64`.
 * @param {object} opts.transport - Transport with `push(path, Uint8Array)`.
 * @param {string} opts.mkHex - Master key hex.
 * @param {string} opts.blocksPrefix
 * @param {string} opts.hashIndexPath
 * @param {Array<{index: number, hash: string, serialized: string}>} opts.payloads
 * @returns {Promise<{pushed: number, failedBlocks: number[], blockHashes: string[]}>}
 */
export async function pushChainPayloads({
  crypto,
  transport,
  mkHex,
  blocksPrefix,
  hashIndexPath,
  payloads,
}) {
  let pushed = 0;
  const failedBlocks = [];
  const blockHashes = [];

  for (const payload of payloads) {
    const obfuscatedB64 = crypto.obfuscateBlob(payload.serialized, mkHex);
    const bytes = base64ToBytes(obfuscatedB64);
    const path = chainBlockPath(blocksPrefix, payload.index);
    try {
      await transport.push(path, bytes);
      pushed++;
      blockHashes.push(payload.hash);
    } catch (_) {
      failedBlocks.push(payload.index);
    }
  }

  // Push the plaintext hash index (best-effort, non-fatal).
  try {
    await transport.push(hashIndexPath, textBytes(JSON.stringify(blockHashes)));
  } catch (_) {
    // Non-fatal — the hash index is rebuildable from the chain.
  }

  return { pushed, failedBlocks, blockHashes };
}

/**
 * Freshness detector shared by the sealed-chain pull services (ADR-030/031).
 * Fetches the plaintext `<hashIndexPath>` and compares its length against
 * [localBlockCount]:
 *   - remote absent/empty or not greater → 0 fresh blocks;
 *   - remote greater → the number of new blocks available.
 *
 * A network/auth failure or a missing/empty index is treated as "no change"
 * (fail-safe) so a freshness hiccup never fails an ownership handoff.
 *
 * @param {object} opts
 * @param {object} opts.transport
 * @param {string} opts.hashIndexPath
 * @param {number} opts.localBlockCount
 * @returns {Promise<number>} Fresh block count (0 = no change).
 */
export async function pullRemoteHasMore({ transport, hashIndexPath, localBlockCount }) {
  const hashIndex = await readRemoteHashIndex({ transport, hashIndexPath });
  if (!hashIndex || hashIndex.length === 0) return 0;
  const freshCount = hashIndex.length - localBlockCount;
  return freshCount > 0 ? freshCount : 0;
}
