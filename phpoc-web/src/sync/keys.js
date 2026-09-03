/**
 * Canonical storage path constants.
 *
 * Single source of truth for all remote-storage and local-storage keys
 * used across sync, genesis gate, remote sync, and clear-remote flows.
 * Must match the CLI constants in:
 *   domain/staging/remote_sync.py
 *   domain/ledger/remote_sync.py
 */

// ── Remote paths (Worker → R2) ─────────────────────────────────────

export const REMOTE_STAGING_BLOB = 'staging/blob';
export const REMOTE_DEVICE_COOKIE = 'staging/blobs/device_cookie.bin';
export const REMOTE_LEDGER_BLOCKS_PREFIX = 'ledger/blocks/';
export const REMOTE_LEDGER_INDEX = 'ledger/index.json';
export const REMOTE_HASH_INDEX = 'ledger/hash_index.json';
export const REMOTE_HASH_INDEX_SHA256 = 'ledger/hash_index.sha256';
export const REMOTE_STAGING_HASH_INDEX = 'staging/hash_index.json';
export const REMOTE_STAGING_HASH_INDEX_SHA256 = 'staging/hash_index.sha256';

// ── Commonplace sealed-chain R2 paths (ADR-031 remote-sync slice) ──
// Genesis at `commonplace/blocks/000000.json`, day blocks follow in chain
// order. The hash index is plaintext (mirrors `ledger/hash_index.json`).
export const REMOTE_COMMONPLACE_BLOCKS_PREFIX = 'commonplace/blocks/';
export const REMOTE_COMMONPLACE_HASH_INDEX = 'commonplace/hash_index.json';

// ── Local storage keys (IndexedDB / in-memory) ─────────────────────

export const LOCAL_COOKIE = 'cookie';
export const LOCAL_LEDGER_BLOCKS = 'ledger:blocks';
export const LOCAL_LEDGER_INDEX = 'ledger:index';
export const LOCAL_HASH_INDEX = 'ledger:hash_index';
export const LOCAL_STAGING_HASH_INDEX = 'staging:hash_index';
