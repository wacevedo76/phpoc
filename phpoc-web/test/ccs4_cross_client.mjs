/**
 * ccs4_cross_client.mjs — Cross-Client E2E parity harness (CCS-4).
 *
 * Bridges the Web (JS) engine to the Python parity suite. Three roles:
 *
 *   1. **Pure parity** (Groups A–D): called as a standalone CLI from
 *      `tests/test_ccs4_cross_client.py` via `node` subprocess. Reads one
 *      JSON operation from stdin, writes a JSON result to stdout. Helps
 *      assert Python ↔ JS byte-for-byte agreement of canonical-row
 *      serialization, hash index, merge, and device-id/proof derivation.
 *
 *   2. **Import exports**: re-exports the canonical Web functions so the
 *      same helper can be exercised with `node --test` if needed.
 *
 *   3. **Live blob round-trip port** (Group E): a pure-Node port of the
 *      documented blob-obfuscation protocol (PHPSPEC §8.9 / reference §4),
 *      so a JS client can de-obfuscate/re-obfuscate a CLI-written canonical
 *      blob with byte-identical output — no WASM dependency in the harness.
 *
 * Protocol for the CLI (stdin → stdout):
 *   stdin (one line):  { "op": "dtoToCanonicalRow", "dto": {...},
 *                        "deviceId": "...", "now": 123 }
 *   stdout (one line): the JSON result of the op.
 *
 *   Supports ops:
 *     dtoToCanonicalRow   → canonical row (JS side)
 *     canonicalRowToDTO   → DTO (row-level contract)
 *     rowHashIndexBuild   → [{activity_id, activity_status}, ...] sorted
 *     rowHashCompute      → compact-SHA-256 of an index (canonical contract)
 *     mergeRows           → merged rows
 *     deriveDeviceId      → HMAC(mk, "phpoc:device:"+secret) hex (Web Crypto)
 *     deobfuscate         → {bytes: <base64>, json: <string>} of obfuscated blob
 *     obfuscateDeterministic → byte-identical obfuscation with explicit salt/nonce
 *
 * Sample:
 *   echo '{"op":"mergeRows","local":[...],"remote":[...]}' | node ccs4_cross_client.mjs
 */

import { createHash, createCipheriv, createHmac } from 'crypto';
import { dtoToCanonicalRow } from '../src/sync/remote_sync.js';
import { canonicalRowToDTO } from '../src/sync/entry_dto.js';
import { mergeRows } from '../src/sync/row_sync.js';
import { deriveDeviceId } from '../src/sync/device_uuid.js';

// ---------------------------------------------------------------------------
// Canonical row-level hash index (CCS-4 canonical contract).
//
// The Python reference `StagingHashIndex.build` produces
// `[{activity_id, activity_status}, ...]` sorted by activity_id, and
// `computeHash` hashes `json.dumps(index, separators=(",",":"), sort_keys=True)`.
// This is the byte-identical contract all three clients must agree on.
// (Flutter's current `json.encode` default-spaced separators are a known
// divergence — CCS-4 B2 — surfaced for Phase 3 convergence.)
// ---------------------------------------------------------------------------

/**
 * Build a row-level hash index array from canonical staging rows.
 * Entries missing activity_id are skipped; output sorted by activity_id.
 * @param {Array|null} rows
 * @returns {{activity_id:string, activity_status:string}[]}
 */
function buildRowHashIndex(rows) {
  if (!rows || !Array.isArray(rows)) return [];
  const out = [];
  for (const row of rows) {
    const aid = row && row.activity_id;
    if (aid) out.push({ activity_id: aid, activity_status: row.activity_status || 'active' });
  }
  out.sort((a, b) => (a.activity_id < b.activity_id ? -1 : a.activity_id > b.activity_id ? 1 : 0));
  return out;
}

/**
 * Compute the canonical SHA-256 of a row-level hash index.
 * Compact separators, keys sorted — must equal the Python reference.
 * @param {Array|null} index
 * @returns {string} 64-char lowercase hex.
 */
function computeRowHash(index) {
  const sorted = buildRowHashIndex(index); // sorts by activity_id
  const json = JSON.stringify(sorted, Object.keys(sorted[0] || {}).sort());
  return createHash('sha256').update(json, 'utf-8').digest('hex');
}

/**
 * Stable JSON.stringify matching Python json.dumps(..., sort_keys=True)
 * with compact separators, at any nesting depth.
 * @param {*} value
 * @returns {string}
 */
function compactSortJson(value) {
  if (Array.isArray(value)) return '[' + value.map(compactSortJson).join(',') + ']';
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const parts = keys.map((k) => `${JSON.stringify(k)}:${compactSortJson(value[k])}`);
    return '{' + parts.join(',') + '}';
  }
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}

// ---------------------------------------------------------------------------
// Blob obfuscation port (PHPSPEC §8.9 / reference §4). Byte-identical to the
// Python `RemoteStagingSync._obfuscate_core` / `_deobfuscate`.
//   format: salt(16) + nonce(8) + _ct + tag(32)
//   blob_key      = HMAC-SHA256(mk, "blob-obfuscation")[:16]
//   enc_key       = HMAC-SHA256(blob_key, salt)[:16]
//   integrity_key = HMAC-SHA256(blob_key, salt + "-integrity")[:16]
//   AES-128-CTR over payload = struct.pack(">I", len(plain)) + padded
//   tag = HMAC-SHA256(integrity_key, nonce + ciphertext)
// Padding: tier ceiling minus 4 bytes; deterministic mode zero-fills.
// ---------------------------------------------------------------------------

const TIERS = [64 * 1024, 128 * 1024, 256 * 1024, 512 * 1024];

function selectTier(len) {
  for (const t of TIERS) if (len <= t) return t;
  throw new Error(`blob too large: ${len}`);
}

function deriveBlobKey(masterKeyBytes) {
  return createHmac('sha256', masterKeyBytes).update('blob-obfuscation', 'utf-8').digest().subarray(0, 16);
}

/** Base64 (url-safe) in → Uint8Array out */
function b64ToBytes(b64) {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}
/** Uint8Array → base64 (standard) out */
function bytesToB64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

/**
 * Obfuscate plaintext bytes (Uint8Array) with a master key (bytes) and
 * explicit salt/nonce. Deterministic zero-fill padding. Returns Uint8Array.
 */
function obfuscateCore(plain, masterKeyBytes, salt, nonce) {
  const tier = selectTier(plain.length);
  const paddedSize = tier - 4; // reserve 4 bytes for original length
  let payload;
  if (paddedSize > plain.length) {
    const fill = Buffer.alloc(paddedSize - plain.length, 0); // zero-fill
    payload = Buffer.concat([plain, fill]);
  } else {
    payload = plain;
  }
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(plain.length, 0);
  const fullPayload = Buffer.concat([lenBuf, payload]);

  const blobKey = deriveBlobKey(masterKeyBytes);
  const encKey = createHmac('sha256', blobKey).update(salt).digest().subarray(0, 16);
  const integrityKey = createHmac('sha256', blobKey).update(Buffer.concat([Buffer.from(salt), Buffer.from('-integrity')])).digest().subarray(0, 16);

  // AES-128-CTR: nonce(8) + zero-64-bit counter. Verify byte-parity with
  // Python PureAESCTR (nonce + big-endian counter block).
  const iv = Buffer.concat([Buffer.from(nonce), Buffer.alloc(8, 0)]);
  const cipher = createCipheriv('aes-128-ctr', encKey, iv);
  cipher.setAutoPadding(false);
  const ct = Buffer.concat([cipher.update(fullPayload), cipher.final()]);

  const tag = createHmac('sha256', integrityKey).update(Buffer.concat([Buffer.from(nonce), ct])).digest();

  return new Uint8Array(Buffer.concat([Buffer.from(salt), Buffer.from(nonce), ct, tag]));
}

/**
 * De-obfuscate a blob. Returns plaintext bytes, or null on integrity failure.
 */
function deobfuscate(obfuscated, masterKeyBytes) {
  try {
    const bytes = Buffer.from(obfuscated);
    const salt = bytes.subarray(0, 16);
    const nonce = bytes.subarray(16, 24);
    const ct = bytes.subarray(24, bytes.length - 32);
    const storedTag = bytes.subarray(bytes.length - 32);

    const blobKey = deriveBlobKey(masterKeyBytes);
    const encKey = createHmac('sha256', blobKey).update(salt).digest().subarray(0, 16);
    const integrityKey = createHmac('sha256', blobKey).update(Buffer.concat([salt, Buffer.from('-integrity')])).digest().subarray(0, 16);

    const expectedTag = createHmac('sha256', integrityKey).update(Buffer.concat([nonce, ct])).digest();
    if (!expectedTag.equals(storedTag)) return null;

    const iv = Buffer.concat([nonce, Buffer.alloc(8, 0)]);
    const decipher = createCipheriv('aes-128-ctr', encKey, iv);
    decipher.setAutoPadding(false);
    const decrypted = Buffer.concat([decipher.update(ct), decipher.final()]);

    const len = decrypted.readUInt32BE(0);
    return decrypted.subarray(4, 4 + len);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Op dispatch
// ---------------------------------------------------------------------------

async function run(op, args) {
  switch (op) {
    case 'dtoToCanonicalRow': {
      const row = dtoToCanonicalRow(args.dto, args.deviceId, args.now);
      return row;
    }
    case 'canonicalRowToDTO': {
      return canonicalRowToDTO(args.row);
    }
    case 'rowHashIndexBuild': {
      return buildRowHashIndex(args.rows);
    }
    case 'rowHashCompute': {
      // Canonical: sort by activity_id, then compact-sort JSON, then SHA-256.
      return computeRowHash(args.index);
    }
    case 'mergeRows': {
      return mergeRows(args.local, args.remote);
    }
    case 'deriveDeviceId': {
      const id = await deriveDeviceId(args.mkHex, args.secret);
      return { deviceId: id };
    }
    case 'deviceProof': {
      // device_proof = HMAC(mk_raw, "phpoc:device:" + device_id)
      const mkBytes = b64ToBytes(args.mkB64);
      const proof = createHmac('sha256', mkBytes)
        .update('phpoc:device:' + args.deviceId, 'utf-8')
        .digest('hex');
      return { deviceProof: proof };
    }
    case 'deobfuscate': {
      const plain = deobfuscate(b64ToBytes(args.blobB64), b64ToBytes(args.mkB64));
      if (plain === null) return { ok: false };
      const jsonText = Buffer.from(plain).toString('utf-8');
      let parsed = null;
      try { parsed = JSON.parse(jsonText); } catch { /* leave null */ }
      return { ok: true, json: jsonText, parsed, bytesB64: Buffer.from(plain).toString('base64') };
    }
    case 'obfuscateDeterministic': {
      const plain = Buffer.from(args.plainB64, 'base64');
      const salt = Buffer.from(args.saltHex, 'hex');
      const nonce = Buffer.from(args.nonceHex, 'hex');
      const out = obfuscateCore(plain, b64ToBytes(args.mkB64), salt, nonce);
      return { blobB64: bytesToB64(out) };
    }
    default:
      throw new Error(`unknown op: ${op}`);
  }
}

// ── CLI mode: read one JSON line from stdin, write one JSON line to stdout ─
async function main() {
  let input = '';
  process.stdin.setEncoding('utf-8');
  for await (const chunk of process.stdin) input += chunk;
  let req;
  try {
    req = JSON.parse(input.trim());
  } catch (e) {
    console.error('ccs4_cross_client: invalid stdin JSON:', e.message);
    process.exit(2);
  }
  try {
    const result = await run(req.op, req);
    console.log(JSON.stringify({ ok: true, result }));
  } catch (e) {
    console.error('ccs4_cross_client error:', e && e.message);
    console.log(JSON.stringify({ ok: false, error: (e && String(e)) || 'unknown' }));
    process.exitCode = 3;
  }
}

// Only run main() when invoked directly (not imported).
if (process.argv[1] && process.argv[1].endsWith('ccs4_cross_client.mjs')) {
  main();
}

export {
  buildRowHashIndex,
  computeRowHash,
  compactSortJson,
  obfuscateCore,
  deobfuscate,
  dtoToCanonicalRow,
  canonicalRowToDTO,
  mergeRows,
  deriveDeviceId,
};
