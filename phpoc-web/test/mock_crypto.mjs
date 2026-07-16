/**
 * mock_crypto.mjs — Shared deterministic MockCrypto for ledger test suites.
 *
 * Provides a single, consistent MockCrypto class used by:
 *   - ledger_chain_test.mjs
 *   - ledger_engine_test.mjs
 *   - summary_policy_test.mjs
 *
 * All methods are deterministic (djb2-based) so test vectors are reproducible.
 */

import { createHash } from 'crypto';

/**
 * Deterministic hash function (djb2 variant) for reproducible test vectors.
 */
export function deterministicHash(data) {
  let hash = 5381;
  const str = typeof data === 'string' ? data : JSON.stringify(data);
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return (hash >>> 0).toString(16).padStart(64, '0');
}

export class MockCrypto {
  constructor() {
    this._mk = null;
  }

  getMasterKey() { return this._mk; }
  setMasterKey(k) { this._mk = k; }

  seal(data, masterKeyHex) {
    return deterministicHash(data + masterKeyHex);
  }

  /**
   * Seal a block (JSON object). Sorts keys, removes signature,
   * then calls seal(). Used by test chain builders.
   */
  sealBlock(block, masterKeyHex) {
    const mk = masterKeyHex || this._mk || 'deadbeef';
    // Strip day_hash and signature fields before sealing (spec behavior)
    const content = {};
    for (const [k, v] of Object.entries(block)) {
      if (k !== 'day_hash' && k !== 'month_hash' && k !== 'year_hash' && k !== 'signature') {
        content[k] = v;
      }
    }
    // Sort keys for deterministic JSON
    const sorted = {};
    for (const k of Object.keys(content).sort()) {
      sorted[k] = content[k];
    }
    return this.seal(JSON.stringify(sorted), mk);
  }

  verifySeal(data, sealHex, masterKeyHex) {
    return this.seal(data, masterKeyHex) === sealHex;
  }

  mac(data, identitySecretHex) {
    return deterministicHash('sign:' + data + identitySecretHex);
  }

  verifyMac(data, macHex, identitySecretHex) {
    return this.mac(data, identitySecretHex) === macHex;
  }

  sha256(data) {
    return createHash('sha256').update(data, 'utf-8').digest('hex');
  }

  encrypt(plaintext, masterKeyHex) {
    const mk = masterKeyHex || this._mk || 'no-key';
    // Prefix with key fingerprint + plaintext for reversible mock encryption
    const fingerprint = deterministicHash(mk).slice(0, 8);
    return `enc:${fingerprint}:${plaintext}`;
  }

  decrypt(ciphertextHex, _masterKeyHex) {
    if (ciphertextHex && ciphertextHex.startsWith('enc:')) {
      // Format: enc:<fingerprint>:<plaintext>
      const parts = ciphertextHex.split(':');
      return parts.slice(2).join(':') || ciphertextHex.slice(4);
    }
    return ciphertextHex;
  }

  /**
   * Obfuscate a plaintext blob for remote storage (mock).
   * Returns base64-encoded obfuscation for transport push.
   */
  obfuscateBlob(plaintext, masterKeyHex) {
    const obf = 'obf:' + plaintext;
    return Buffer.from(obf).toString('base64');
  }

  /**
   * Deobfuscate a base64-encoded blob from remote storage (mock).
   * Returns plaintext.
   */
  deobfuscateBlob(b64, masterKeyHex) {
    const obf = Buffer.from(b64, 'base64').toString('utf-8');
    if (obf.startsWith('obf:')) {
      return obf.slice(4);
    }
    // Try plaintext JSON directly
    return obf;
  }

  /**
   * Decrypt with the cached master key (for committed entry DTOs).
   */
  decryptWithCachedKey(ciphertextHex) {
    return this.decrypt(ciphertextHex);
  }

  /**
   * Encrypt with the cached master key (single-arg version).
   */
  encryptWithCachedKey(plaintext) {
    return this.encrypt(plaintext);
  }

  /**
   * Check if a master key is set.
   */
  hasMasterKey() {
    return !!this._mk;
  }

  generateSeed() {
    return 'MOCK_SEED_' + Math.random().toString(36).slice(2);
  }

  deriveMasterKey(seed) {
    return this.sha256(seed);
  }

  derivePdk(passphrase, iterations) {
    return this.sha256(passphrase + String(iterations));
  }
}
