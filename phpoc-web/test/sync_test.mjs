/**
 * sync_test.mjs — Test suite for all sync modules.
 *
 * Tests the four layers bottom-up:
 *   1. mergeEngine          (pure function, no deps)
 *   2. DeviceCookie          (needs MemoryBackend + mock CryptoService)
 *   3. LocalCache            (needs MemoryBackend + mock CryptoService)
 *   4. RemoteSync            (needs mock transport + mock CryptoService)
 *
 * Runs with: node test/sync_test.mjs
 */

import { mergeEntries } from '../src/sync/merge_engine.js';
import { DeviceCookie } from '../src/sync/cookie.js';
import { MemoryBackend } from '../src/sync/storage.js';
import { LocalCache } from '../src/sync/local_cache.js';
import { RemoteSync, BLOB_KEY_MISMATCH } from '../src/sync/remote_sync.js';

// ── Stats ──────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { passed++; process.stdout.write('  ✓'); }
  else { failed++; process.stdout.write('  ✗'); }
  console.log(`  ${label}`);
}

function assertEq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; process.stdout.write('  ✓'); }
  else {
    failed++;
    process.stdout.write('  ✗');
    const gotStr = actual !== undefined ? JSON.stringify(actual).slice(0, 200) : 'undefined';
    const expStr = expected !== undefined ? JSON.stringify(expected).slice(0, 200) : 'undefined';
    console.log(`\n      got:      ${gotStr}`);
    console.log(`      expected: ${expStr}`);
  }
  console.log(`  ${label}`);
}

import { createHash } from 'crypto';

// ── Mock CryptoService (minimal: sha256, generateUuid, generateDeviceSpecifier) ──

class MockCrypto {
  constructor() {
    this._uuidCounter = 0;
    this._specCounter = 0;
  }
  sha256(data) {
    return createHash('sha256').update(data, 'utf-8').digest('hex');
  }
  generateUuid() {
    this._uuidCounter++;
    return `00000000-0000-0000-0000-${String(this._uuidCounter).padStart(12, '0')}`;
  }
  generateDeviceSpecifier() {
    this._specCounter++;
    return `spec${String(this._specCounter).padStart(31, '0')}`;
  }
  getMasterKey() { return this._mk || null; }
  setMasterKey(k) { this._mk = k; }
  hasMasterKey() { return !!this._mk; }
  getDeviceId(mk) { return `dev-${mk.slice(0, 8)}`; }
  obfuscateBlob(plaintext, mk) {
    // Simulate binary obfuscation: prepend a hash of the key so the result
    // is not valid UTF-8 text (starts with a non-ASCII byte).
    // The key hash is stored as the first 4 bytes for verification.
    const plainBytes = Buffer.from(plaintext, 'utf-8');
    const keyFingerprint = mk ? createHash('sha256').update(mk).digest().slice(0, 4) : Buffer.alloc(4);
    const obfuscated = Buffer.concat([keyFingerprint, plainBytes]);
    return obfuscated.toString('base64');
  }
  deobfuscateBlob(b64, mk) {
    try {
      const obfuscated = Buffer.from(b64, 'base64');
      // Verify key fingerprint (first 4 bytes)
      const storedFingerprint = obfuscated.slice(0, 4);
      if (mk) {
        const expectedFingerprint = createHash('sha256').update(mk).digest().slice(0, 4);
        if (!storedFingerprint.equals(expectedFingerprint)) {
          throw new Error('key mismatch');
        }
      }
      // Strip fingerprint and return plaintext
      return obfuscated.slice(4).toString('utf-8');
    } catch {
      throw new Error('deobfuscation failed');
    }
  }
  encrypt(plaintext, _masterKey) {
    return `enc:${plaintext}`;
  }
  encryptWithCachedKey(plaintext) {
    return `enc:${plaintext}`;
  }
  decrypt(ciphertextHex, _masterKey) {
    if (ciphertextHex && typeof ciphertextHex === 'string') {
      if (ciphertextHex.startsWith('enc:')) return ciphertextHex.slice(4);
      if (ciphertextHex.startsWith('plain:')) return ciphertextHex.slice(6);
    }
    return ciphertextHex;
  }
  decryptWithCachedKey(ciphertextHex) {
    return this.decrypt(ciphertextHex);
  }
}

// ══════════════════════════════════════════════════════════════════════
// 1. MergeEngine
// ══════════════════════════════════════════════════════════════════════
console.log('\n── MergeEngine ──');

// 1a. Empty merge
assertEq(mergeEntries([], []), [], 'merge empty lists');

// 1b. Single local entry
const local1 = [{ entry_id: 'id1', title: 'Coding', start_epoch: 1000 }];
const result1 = mergeEntries(local1, []);
assertEq(result1.length, 1, 'single local entry');
assertEq(result1[0].source, 'local', 'local entry has source=local');

// 1c. Remote overwrites local on tie (same entry_id)
const local2 = [{ entry_id: 'id1', title: 'Coding', start_epoch: 1000 }];
const remote2 = [{ entry_id: 'id1', title: 'Coding v2', start_epoch: 1000 }];
const result2 = mergeEntries(local2, remote2);
assertEq(result2.length, 1, 'dedup to one entry');
assertEq(result2[0].title, 'Coding v2', 'remote wins on tie');
assertEq(result2[0].source, 'remote', 'source=remote');

// 1d. Distinct entries from both sides
const local3 = [{ entry_id: 'id1', title: 'Coding', start_epoch: 1000 }];
const remote3 = [{ entry_id: 'id2', title: 'Reading', start_epoch: 2000 }];
const result3 = mergeEntries(local3, remote3);
assertEq(result3.length, 2, 'two distinct entries');
assertEq(result3[0].title, 'Coding', 'sorted by start_epoch');
assertEq(result3[1].title, 'Reading', 'second entry');

// 1e. Fallback dedup key (title + start_epoch when no entry_id)
const local4 = [{ title: 'Walk', start_epoch: 1000 }];
const remote4 = [{ title: 'Walk', start_epoch: 1000, duration: 30 }];
const result4 = mergeEntries(local4, remote4);
assertEq(result4.length, 1, 'fallback dedup works');
assertEq(result4[0].duration, 30, 'remote wins on fallback');

// 1f. Sort order
const entries5 = [
  { entry_id: 'a', start_epoch: 3000 },
  { entry_id: 'b', start_epoch: 1000 },
  { entry_id: 'c', start_epoch: 2000 },
];
const result5 = mergeEntries(entries5, []);
assertEq(result5[0].entry_id, 'b', 'sorted asc: first');
assertEq(result5[1].entry_id, 'c', 'sorted asc: middle');
assertEq(result5[2].entry_id, 'a', 'sorted asc: last');

// 1g. Local committed=true survives stale remote (committed=false on same key)
// Fix: committed flag is irreversible — local committed must not be downgraded
// by a stale remote blob (e.g. when pushBlobOnly failed after commit).
const local6 = [{ entry_id: 'id1', title: 'Coding', start_epoch: 1000, committed: true, block_index: 5 }];
const remote6 = [{ entry_id: 'id1', title: 'Coding', start_epoch: 1000, committed: false, block_index: null }];
const result6 = mergeEntries(local6, remote6);
assertEq(result6.length, 1, 'g. dedup to one entry');
assertEq(result6[0].committed, true, 'g. committed=true preserved from local');
assertEq(result6[0].block_index, 5, 'g. block_index preserved from local');
assertEq(result6[0].source, 'remote', 'g. source=remote (other fields overwritten)');

// 1h. Remote committed=true overwrites local committed=false (normal case)
const local7 = [{ entry_id: 'id1', title: 'Coding', start_epoch: 1000, committed: false, block_index: null }];
const remote7 = [{ entry_id: 'id1', title: 'Coding', start_epoch: 1000, committed: true, block_index: 3 }];
const result7 = mergeEntries(local7, remote7);
assertEq(result7.length, 1, 'h. dedup to one entry');
assertEq(result7[0].committed, true, 'h. committed=true from remote');
assertEq(result7[0].block_index, 3, 'h. block_index from remote');
assertEq(result7[0].source, 'remote', 'h. source=remote');

// 1i. Both committed — remote block_index wins, committed stays true
const local8 = [{ entry_id: 'id1', title: 'Coding', start_epoch: 1000, committed: true, block_index: 2 }];
const remote8 = [{ entry_id: 'id1', title: 'Coding', start_epoch: 1000, committed: true, block_index: 7 }];
const result8 = mergeEntries(local8, remote8);
assertEq(result8.length, 1, 'i. dedup to one entry');
assertEq(result8[0].committed, true, 'i. committed=true (both were true)');
assertEq(result8[0].block_index, 7, 'i. block_index from remote');
assertEq(result8[0].source, 'remote', 'i. source=remote');

// 1j. Neither committed — stays false
const local9 = [{ entry_id: 'id1', title: 'Coding', start_epoch: 1000, committed: false, block_index: null }];
const remote9 = [{ entry_id: 'id1', title: 'Coding', start_epoch: 1000, committed: false, block_index: null }];
const result9 = mergeEntries(local9, remote9);
assertEq(result9.length, 1, 'j. dedup to one entry');
assertEq(result9[0].committed, false, 'j. committed=false preserved');
assertEq(result9[0].block_index, null, 'j. block_index=null');
assertEq(result9[0].source, 'remote', 'j. source=remote');

// ══════════════════════════════════════════════════════════════════════
// 2. DeviceCookie
// ══════════════════════════════════════════════════════════════════════
console.log('\n── DeviceCookie ──');

const storage = new MemoryBackend();
const crypto = new MockCrypto();

// 2a. No cookie -> isValidLocally returns null
const noCookie = await DeviceCookie.isValidLocally(storage, 30);
assert(noCookie === null, 'no cookie returns null');

// 2b. Create cookie
const remoteCookie = await DeviceCookie.create('dev-123', storage, crypto);
assert(remoteCookie !== null, 'cookie created');
assertEq(remoteCookie.device_uuid, 'dev-123', 'remote cookie has device_uuid');
assert(remoteCookie.device_specifier && remoteCookie.device_specifier.length > 0, 'remote cookie has specifier');

// 2c. Local cookie exists after create
const localCookie = await DeviceCookie.isValidLocally(storage, 30);
assert(localCookie !== null, 'local cookie exists after create');
assertEq(localCookie.device_specifier, remoteCookie.device_specifier, 'local specifier matches remote specifier');

// 2d. matches() works
assert(DeviceCookie.matches(localCookie, remoteCookie), 'matches returns true for matching cookies');

// 2e. matches() returns false for different specifiers
const otherRemote = { device_uuid: 'dev-456', device_specifier: 'other-spec' };
assert(!DeviceCookie.matches(localCookie, otherRemote), 'matches returns false for different specifiers');

// 2f. parseRemote works
const rawBytes = new TextEncoder().encode(JSON.stringify(remoteCookie));
const parsed = DeviceCookie.parseRemote(rawBytes);
assert(parsed !== null, 'parseRemote returns object');
assertEq(parsed.device_uuid, 'dev-123', 'parseRemote: device_uuid');

// 2g. parseRemote returns null for invalid bytes
const badParsed = DeviceCookie.parseRemote(null);
assert(badParsed === null, 'parseRemote(null) returns null');
const badParsed2 = DeviceCookie.parseRemote(new TextEncoder().encode('not-json'));
assert(badParsed2 === null, 'parseRemote(invalid json) returns null');

// 2h. destroyLocally removes the cookie
await DeviceCookie.destroyLocally(storage);
const afterDestroy = await DeviceCookie.isValidLocally(storage, 30);
assert(afterDestroy === null, 'cookie gone after destroy');

// 2i. TTL expiry
const storage2 = new MemoryBackend();
const crypto2 = new MockCrypto();
await DeviceCookie.create('dev-123', storage2, crypto2);
// Force the cookie to be old
await storage2.set('cookie', {
  device_specifier: 'old-spec',
  creation_time: Date.now() - 31 * 60 * 1000, // 31 min ago
});
const expired = await DeviceCookie.isValidLocally(storage2, 30);
assert(expired === null, 'expired cookie returns null');

// ══════════════════════════════════════════════════════════════════════
// 3. LocalCache
// ══════════════════════════════════════════════════════════════════════
console.log('\n── LocalCache ──');

const cacheStorage = new MemoryBackend();
const cacheCrypto = new MockCrypto();
cacheCrypto.setMasterKey('abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234');
const cache = new LocalCache(cacheStorage, cacheCrypto);

// 3a. Empty read
const empty = await cache.readEntries();
assertEq(empty.length, 0, 'empty cache');

// 3b. Append entry
const hash1 = await cache.append({
  title: 'Coding',
  startEpoch: 1000,
  endEpoch: 2000,
  tags: ['work', 'dev'],
});
assert(typeof hash1 === 'string' && hash1.length === 10, 'append returns 10-char hash');

// 3c. Read back
const entries1 = await cache.readEntries();
assertEq(entries1.length, 1, 'one entry after append');
assertEq(entries1[0].title, 'Coding', 'entry title matches');
assertEq(entries1[0].tags.length, 2, 'tags preserved');
assertEq(entries1[0].entry_index, 0, 'entry_index set');

// 3d. Append second entry
await cache.append({
  title: 'Reading',
  startEpoch: 3000,
  endEpoch: 4000,
});
const entries2 = await cache.readEntries();
assertEq(entries2.length, 2, 'two entries');
assertEq(entries2[1].entry_index, 1, 'second entry_index=1');

// 3e. Update entry
await cache.update(0, { title: 'Coding v2', tags: ['work'] });
const entries3 = await cache.readEntries();
assertEq(entries3[0].title, 'Coding v2', 'title updated');
assertEq(entries3[0].tags.length, 1, 'tags updated');

// 3f. Delete entry
await cache.delete(1);
const entries4 = await cache.readEntries();
assertEq(entries4.length, 1, 'one entry after delete');

// 3g. Tag normalization
await cache.append({
  title: 'Test',
  startEpoch: 5000,
  tags: ['  Work ', 'WORK', 'Dev  ', 'Dev'],
});
const entries5c = await cache.readEntries();
const testEntry = entries5c.find(e => e.title === 'Test');
assertEq(testEntry.tags, ['dev', 'work'], 'tags normalized: lower, trim, dedup, sort');

// 3h. Collision detection
let collisionCaught = false;
try {
  await cache.append({ title: 'Dup', startEpoch: 5000 });
} catch (e) {
  collisionCaught = e.message.includes('Collision');
}
assert(collisionCaught, 'collision detected on same start_epoch');

// 3i. Pause management
await cache.append({
  title: 'PausedTask',
  startEpoch: 10000,
  isActive: true,
});
const pEntries = await cache.readEntries();
const pauseIdx = pEntries.findIndex(e => e.title === 'PausedTask');

await cache.addPause(pauseIdx, 11000);
const pAfterPause = await cache.readEntries();
assert(pAfterPause[pauseIdx].is_paused, 'entry marked paused');
assertEq(pAfterPause[pauseIdx].pauses.length, 1, 'one pause record');
assertEq(pAfterPause[pauseIdx].pauses[0].pause_start, 11000, 'pause start set');

await cache.closePause(pauseIdx, 11500);
const pAfterResume = await cache.readEntries();
assert(!pAfterResume[pauseIdx].is_paused, 'entry no longer paused');
assertEq(pAfterResume[pauseIdx].pauses[0].pause_stop, 11500, 'pause stop set');

// 3j. Duration computation
const dur = LocalCache.computeDuration(10000, 12000, [
  { pause_start: 11000, pause_stop: 11500 },
]);
assertEq(dur, 1500, 'duration = (12000-10000) - (11500-11000) = 1500');

// 3k. removeMultiple
await cache.append({ title: 'A', startEpoch: 20000 });
await cache.append({ title: 'B', startEpoch: 21000 });
await cache.append({ title: 'C', startEpoch: 22000 });
const allEntries = await cache.readEntries();
const indicesToRemove = allEntries
  .filter(e => e.title === 'A' || e.title === 'C')
  .map(e => e.entry_index);
await cache.removeMultiple(indicesToRemove);
const afterRemove = await cache.readEntries();
assertEq(afterRemove.length, allEntries.length - 2, 'two entries removed');
assert(!afterRemove.find(e => e.title === 'A'), 'A removed');
assert(!afterRemove.find(e => e.title === 'C'), 'C removed');

// ══════════════════════════════════════════════════════════════════════
// 4. RemoteSync (with mock transport)
// ══════════════════════════════════════════════════════════════════════
console.log('\n── RemoteSync ──');

class MockTransport {
  constructor() {
    this._store = new Map();
  }
  async pull(path) {
    return this._store.get(path) ?? null;
  }
  async push(path, data) {
    this._store.set(path, data);
  }
}

const rSyncCrypto = new MockCrypto();
rSyncCrypto.setMasterKey('mk-test-key-00000000000000000000000000000000');
const transport = new MockTransport();
const remoteSync = new RemoteSync(transport, rSyncCrypto);

// 4a. Pull from empty remote returns null
const emptyPull = await remoteSync.pullBlob();
assert(emptyPull === null, 'pull from empty remote returns null');

// 4b. Push then pull round-trip
const entries = [{ entry_id: 'e1', title: 'Test', start_epoch: 1000 }];
await remoteSync.pushBlob(entries, 'dev-123');
const pulled = await remoteSync.pullBlob();
assert(pulled !== null, 'pulled blob exists');
assertEq(pulled.device_id, 'dev-123', 'blob has device_id');
assertEq(pulled.entries.length, 1, 'blob has one entry');
// Bug 3b: entries are now in canonical format (PHPSPEC §8)
const rawEntry = pulled.entries[0];
assert(rawEntry.activity_id && rawEntry.activity && JSON.parse(rawEntry.activity).title === 'Test', 'entry preserved (canonical format)');

// 4c. Cookie push/pull
const cookieBytes = new TextEncoder().encode(
  JSON.stringify({ device_uuid: 'dev-123', device_specifier: 'abc' })
);
await remoteSync.pushCookie(cookieBytes);
const pulledCookie = await remoteSync.pullCookie();
assert(pulledCookie !== null, 'pulled cookie exists');
const parsedCookie = JSON.parse(new TextDecoder().decode(pulledCookie));
assertEq(parsedCookie.device_uuid, 'dev-123', 'cookie device_uuid preserved');

// 4d. checkRemoteAvailable
const available = await remoteSync.checkRemoteAvailable();
assert(available, 'remote is available');

// 4e. BLOB_KEY_MISMATCH for undecryptable blob
const badKeyCrypto = new MockCrypto();
badKeyCrypto.setMasterKey('different-key-0000000000000000000000000000000');
const badRemoteSync = new RemoteSync(transport, badKeyCrypto);
const mismatch = await badRemoteSync.pullBlob();
assert(mismatch === BLOB_KEY_MISMATCH, 'wrong key returns BLOB_KEY_MISMATCH');

// Make the obfuscation fail by storing non-obfuscated bytes that
// deobfuscateBlob can't handle
const badTransport = new MockTransport();
const impossibleCrypto = new MockCrypto();
impossibleCrypto.deobfuscateBlob = () => { throw new Error('fail'); };
impossibleCrypto.setMasterKey('some-key');
const badRS = new RemoteSync(badTransport, impossibleCrypto);
await badTransport.push('staging/blob',
  new TextEncoder().encode('garbage-bytes-that-arent-obfuscated')
);
const badPull = await badRS.pullBlob();
assert(badPull === BLOB_KEY_MISMATCH, 'corrupt bytes returns BLOB_KEY_MISMATCH');

// ══════════════════════════════════════════════════════════════════════
// Summary
// ══════════════════════════════════════════════════════════════════════
console.log(`\n── Results ──`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
