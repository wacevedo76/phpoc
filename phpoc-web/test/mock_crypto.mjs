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
  seal(data, masterKeyHex) {
    return deterministicHash(data + masterKeyHex);
  }

  verifySeal(data, sealHex, masterKeyHex) {
    return this.seal(data, masterKeyHex) === sealHex;
  }

  sign(data, identitySecretHex) {
    return deterministicHash('sign:' + data + identitySecretHex);
  }

  verifySignature(data, signatureHex, identitySecretHex) {
    return this.sign(data, identitySecretHex) === signatureHex;
  }

  sha256(data) {
    return createHash('sha256').update(data, 'utf-8').digest('hex');
  }

  encrypt(plaintext, masterKeyHex) {
    return 'enc:' + deterministicHash(plaintext + masterKeyHex);
  }

  decrypt(ciphertextHex, _masterKeyHex) {
    if (ciphertextHex && ciphertextHex.startsWith('enc:')) {
      return ciphertextHex.slice(4);
    }
    return ciphertextHex;
  }
}
