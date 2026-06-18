/**
 * Sync module — barrel export for all sync primitives.
 *
 * Usage:
 *   import { SyncService, SyncResult, DeviceCookie,
 *            mergeEntries, RemoteSync, BLOB_KEY_MISMATCH,
 *            LocalCache, StorageBackend, MemoryBackend,
 *            IndexedDBBackend, MockRemoteBackend } from './sync/index.js';
 */

export { SyncService, SyncResult } from './sync.js';
export { DeviceCookie } from './cookie.js';
export { mergeEntries } from './merge_engine.js';
export { RemoteSync, BLOB_KEY_MISMATCH } from './remote_sync.js';
export { LocalCache } from './local_cache.js';
export { StorageBackend, MemoryBackend } from './storage.js';
export { IndexedDBBackend } from './indexeddb_storage.js';
export { HttpBackend } from './http_backend.js';
export { MockRemoteBackend } from './mock_remote.js';
export { createStoragePlugin, createRemoteTransport, createTransportFromDeployment, detectDeployment } from './plugin_factory.js';
