/**
 * CryptoService — Single entry point for all phpoc-crypto-core WASM operations.
 *
 * Wraps all 20 exported WASM functions with:
 *   - Async singleton initialization
 *   - Ready-guards (throws if called before init completes)
 *   - In-memory master key caching (tab lifetime, non-serializable)
 *   - Error normalization (WASM throws raw strings → proper Error)
 *   - JS-idiomatic camelCase naming
 *
 * Usage:
 *   const crypto = await CryptoService.create();
 *   const mk = crypto.deriveMasterKey(seed);
 *   crypto.setMasterKey(mk);
 *   const ct = crypto.encrypt('hello', crypto.getMasterKey());
 *   crypto.clearMasterKey();
 *
 * Browser path resolution:
 *   WASM artifacts are copied to src/crypto/wasm/ and bundled by Vite.
 *   The .wasm binary is auto-fetched via wasm-bindgen's default init
 *   using new URL() — Vite rewrites this to the hashed output asset.
 */

// ---------------------------------------------------------------------------
// Lazy import — the WASM module is loaded only when create() is called.
// Dynamic import keeps the bundler from pulling it in at parse time.
// ---------------------------------------------------------------------------
let wasmModule = null;

export class CryptoService {
  /** @type {boolean} */
  #ready = false;

  /**
   * Master key cache — held in a closure variable, NOT on the instance.
   * This prevents accidental serialization (JSON.stringify, structured clone)
   * and makes the key invisible to property enumeration.
   * @type {string|null}
   */
  #masterKey = null;

  // -----------------------------------------------------------------------
  // Singleton constructor — private; use CryptoService.create().
  // -----------------------------------------------------------------------
  constructor() {}

  // -----------------------------------------------------------------------
  // Factory / lifecycle
  // -----------------------------------------------------------------------

  /**
   * Create (or return) the singleton CryptoService instance.
   *
   * Safe to call multiple times — the WASM module is initialized only once.
   * Subsequent calls return the already-initialized singleton.
   *
   * In the browser, WASM is auto-fetched relative to this module's URL.
   * In Node.js (testing), pass the WASM binary bytes directly:
   *
   *   const fs = require('fs');
   *   const wasmBytes = fs.readFileSync('.../phpoc_crypto_core_bg.wasm');
   *   const crypto = await CryptoService.create({ wasmBytes });
   *
   * @param {object} [options]
   * @param {BufferSource|WebAssembly.Module} [options.wasmModule] - Pre-loaded
   *        WASM bytes or module for Node.js environments where fetch is unavailable.
   * @returns {Promise<CryptoService>}
   */
  static async create(options = {}) {
    if (CryptoService.#instance) {
      return CryptoService.#instance;
    }

    const service = new CryptoService();
    await service.#init(options);
    CryptoService.#instance = service;
    return service;
  }

  /** @type {CryptoService|null} */
  static #instance = null;

  /**
   * Reset the singleton (for testing). After calling this, the next
   * create() will load the WASM module fresh.
   */
  static reset() {
    CryptoService.#instance = null;
  }

  /**
   * Initialize the WASM module.
   *
   * Two init paths:
   *   1. Browser (default) — uses wasm-bindgen's async `init()`, which
   *      fetches the .wasm file relative to the JS glue module URL.
   *   2. Node.js / testing — accepts WASM bytes directly and uses
   *      `initSync()` (no fetch needed).
   *
   * @param {object} options
   * @param {BufferSource|WebAssembly.Module} [options.wasmModule] - Optional
   *        WASM binary for Node.js environments.
   * @private
   */
  async #init(options = {}) {
    if (this.#ready) return;

    // Dynamic import ensures the wasm-bindgen glue is loaded on demand.
    const mod = await import('./wasm/phpoc_crypto_core.js');

    wasmModule = mod;

    if (options.wasmModule) {
      // Node.js / test path: use initSync with provided bytes
      mod.initSync({ module: options.wasmModule });
    } else {
      // Browser path: auto-fetch the .wasm relative to the JS module
      const initFn = mod.default;
      await initFn();
    }

    this.#ready = true;
  }

  /**
   * Whether the WASM module has been initialized and is ready for calls.
   * @returns {boolean}
   */
  isReady() {
    return this.#ready;
  }

  /**
   * Ensure WASM is initialized before any crypto operation.
   * @private
   */
  #guard() {
    if (!this.#ready) {
      throw new Error(
        'CryptoService not initialized. Await CryptoService.create() first.',
      );
    }
  }

  /**
   * Normalize an error thrown by a WASM function.
   * WASM functions throw raw strings (from JsValue). Wrap in an Error.
   * If it's already an Error, pass it through.
   * @private
   * @param {unknown} err
   * @returns {Error}
   */
  #normalizeError(err) {
    if (err instanceof Error) return err;
    if (typeof err === 'string') return new Error(err);
    return new Error(String(err));
  }

  /**
   * Wraps a zero-argument WASM call with ready guard + error normalization.
   * @private
   */
  #call0(fnName) {
    this.#guard();
    try {
      return wasmModule[fnName]();
    } catch (err) {
      throw this.#normalizeError(err);
    }
  }

  /**
   * Wraps a one-argument WASM call.
   * @private
   */
  #call1(fnName, a) {
    this.#guard();
    try {
      return wasmModule[fnName](a);
    } catch (err) {
      throw this.#normalizeError(err);
    }
  }

  /**
   * Wraps a two-argument WASM call.
   * @private
   */
  #call2(fnName, a, b) {
    this.#guard();
    try {
      return wasmModule[fnName](a, b);
    } catch (err) {
      throw this.#normalizeError(err);
    }
  }

  /**
   * Wraps a three-argument WASM call.
   * @private
   */
  #call3(fnName, a, b, c) {
    this.#guard();
    try {
      return wasmModule[fnName](a, b, c);
    } catch (err) {
      throw this.#normalizeError(err);
    }
  }

  // -----------------------------------------------------------------------
  // Master key cache
  // -----------------------------------------------------------------------

  /**
   * Cache the master key in memory for the lifetime of this tab/session.
   *
   * The key is stored in a private field and is not accessible via
   * property enumeration, JSON.stringify, or structured clone.
   *
   * @param {string} hex - 64-char hex-encoded 32-byte master key.
   */
  setMasterKey(hex) {
    this.#masterKey = hex;
  }

  /**
   * Retrieve the cached master key.
   * @returns {string|null} The hex-encoded master key, or null if not set.
   */
  getMasterKey() {
    return this.#masterKey;
  }

  /**
   * Whether a master key is currently cached.
   * @returns {boolean}
   */
  hasMasterKey() {
    return this.#masterKey !== null;
  }

  /**
   * Clear the cached master key from memory.
   *
   * Call on logout, tab blur (for security-conscious apps), or when
   * the session expires. Does NOT clear the WASM module — only the key.
   */
  clearMasterKey() {
    this.#masterKey = null;
  }

  // -----------------------------------------------------------------------
  // Key derivation (3)
  // -----------------------------------------------------------------------

  /**
   * PBKDF2-HMAC-SHA256 passphrase → PDK.
   * @param {string} passphrase
   * @param {number} iterations - 600000 (standard) or 100000 (legacy/pre-R3).
   * @returns {string} Hex-encoded 32-byte PDK.
   */
  derivePdk(passphrase, iterations) {
    return this.#call2('derive_pdk', passphrase, iterations);
  }

  /**
   * Base64 recovery seed → 32-byte master key.
   * @param {string} seed - Base64-encoded 32-byte seed.
   * @returns {string} Hex-encoded 64-char master key.
   */
  deriveMasterKey(seed) {
    return this.#call1('derive_master_key', seed);
  }

  /**
   * Derive the blob obfuscation sub-key.
   * @param {string} masterKeyHex - 64-char hex master key.
   * @returns {string} Hex-encoded 16-byte blob key (32 hex chars).
   */
  deriveBlobKey(masterKeyHex) {
    return this.#call1('derive_blob_key', masterKeyHex);
  }

  /**
   * Derive the sealing sub-key for block seals.
   * @param {string} masterKeyHex - 64-char hex master key.
   * @returns {string} Hex-encoded 32-byte seal key (64 hex chars).
   */
  deriveSealKey(masterKeyHex) {
    return this.#call1('derive_seal_key', masterKeyHex);
  }

  // -----------------------------------------------------------------------
  // AES-128-CTR encrypt / decrypt (2)
  // -----------------------------------------------------------------------

  /**
   * Encrypt plaintext with the given master key.
   * @param {string} plaintext - UTF-8 text to encrypt.
   * @param {string} masterKeyHex - 64-char hex master key.
   * @returns {string} Hex-encoded ciphertext (salt + nonce + ct + tag).
   */
  encrypt(plaintext, masterKeyHex) {
    return this.#call2('encrypt', plaintext, masterKeyHex);
  }

  /**
   * Decrypt ciphertext with the given master key.
   * @param {string} ciphertextHex - Hex-encoded ciphertext from encrypt().
   * @param {string} masterKeyHex - 64-char hex master key.
   * @returns {string} Original plaintext.
   * @throws {Error} On auth tag mismatch or wrong key.
   */
  decrypt(ciphertextHex, masterKeyHex) {
    return this.#call2('decrypt', ciphertextHex, masterKeyHex);
  }

  /**
   * Encrypt plaintext using the CACHED master key.
   * Convenience wrapper — skips passing the key on every call.
   * @param {string} plaintext
   * @returns {string}
   * @throws {Error} If no master key is cached.
   */
  encryptWithCachedKey(plaintext) {
    const mk = this.#requireMasterKey();
    return this.encrypt(plaintext, mk);
  }

  /**
   * Decrypt ciphertext using the CACHED master key.
   * @param {string} ciphertextHex
   * @returns {string}
   * @throws {Error} If no master key is cached.
   */
  decryptWithCachedKey(ciphertextHex) {
    const mk = this.#requireMasterKey();
    return this.decrypt(ciphertextHex, mk);
  }

  /**
   * @private
   * @returns {string}
   */
  #requireMasterKey() {
    const mk = this.#masterKey;
    if (!mk) {
      throw new Error(
        'No master key cached. Call setMasterKey() or provide the key explicitly.',
      );
    }
    return mk;
  }

  // -----------------------------------------------------------------------
  // HMAC-SHA256 sealing & verification (4)
  // -----------------------------------------------------------------------

  /**
   * Compute an HMAC-SHA256 block seal.
   *
   * Uses key derivation: seal_key = HMAC(MK, "integrity-key-salt"),
   * then seal = HMAC(seal_key, data). This is the PHPSPEC §5.2 path.
   *
   * @param {string} data - Canonical JSON string to seal.
   * @param {string} masterKeyHex - 64-char hex master key.
   * @returns {string} 64-char hex seal.
   */
  seal(data, masterKeyHex) {
    return this.#call2('seal', data, masterKeyHex);
  }

  /**
   * Verify an HMAC-SHA256 block seal.
   * @param {string} data - Original data string.
   * @param {string} sealHex - The hex seal to verify.
   * @param {string} masterKeyHex - 64-char hex master key.
   * @returns {boolean}
   */
  verifySeal(data, sealHex, masterKeyHex) {
    return this.#call3('verify_seal', data, sealHex, masterKeyHex);
  }

  /**
   * Sign data using an identity secret (raw HMAC — no key derivation).
   * @param {string} data - String to sign.
   * @param {string} identitySecretHex - 64-char hex identity secret.
   * @returns {string} 64-char hex signature.
   */
  sign(data, identitySecretHex) {
    return this.#call2('sign', data, identitySecretHex);
  }

  /**
   * Verify an identity signature.
   * @param {string} data - Original data string.
   * @param {string} signatureHex - Hex signature to verify.
   * @param {string} identitySecretHex - 64-char hex identity secret.
   * @returns {boolean}
   */
  verifySignature(data, signatureHex, identitySecretHex) {
    return this.#call3('verify_signature', data, signatureHex, identitySecretHex);
  }

  // -----------------------------------------------------------------------
  // SHA-256 (1)
  // -----------------------------------------------------------------------

  /**
   * Compute SHA-256 hash of a string.
   * @param {string} data
   * @returns {string} 64-char lowercase hex.
   */
  sha256(data) {
    return this.#call1('sha256', data);
  }

  /**
   * Derive the identity public key from a hex-encoded identity secret.
   *
   * Per PHPSPEC §2.7.1 the secret is 32 raw bytes; the hex string is decoded
   * to bytes before SHA-256 (NOT hashed as a UTF-8 string). Delegates to the
   * `identity_pub_key` WASM binding (hex-decode → 32 bytes → SHA-256).
   * @param {string} identitySecretHex - 64-char hex-encoded 32-byte secret.
   * @returns {string} 64-char lowercase hex.
   * @throws {Error} On invalid hex / wrong length.
   */
  identityPubKey(identitySecretHex) {
    return this.#call1('identity_pub_key', identitySecretHex);
  }

  // -----------------------------------------------------------------------
  // Generic HMAC-SHA256 + field-key derivation (I-02a)
  // -----------------------------------------------------------------------

  /**
   * Compute HMAC-SHA256 with an arbitrary hex-encoded key.
   * @param {string} keyHex - Hex-encoded HMAC key.
   * @param {string} data - Data string to authenticate.
   * @returns {string} 64-char lowercase hex HMAC-SHA256.
   */
  hmacHex(keyHex, data) {
    return this.#call2('hmac_hex', keyHex, data);
  }

  /**
   * Derive the field-level encryption key for blind index field-name tokens.
   *
   * HMAC-SHA256(MK, "phpoc-staging-keys-v1")[:16] — returns 32 hex chars.
   * Used by LocalCache._fieldToken() to produce MK-dependent field tokens.
   *
   * @param {string} masterKeyHex - 64-char hex master key.
   * @returns {string} 32-char hex field key.
   */
  deriveFieldKey(masterKeyHex) {
    return this.#call1('derive_field_key', masterKeyHex);
  }

  // -----------------------------------------------------------------------
  // Blob obfuscation (2)
  // -----------------------------------------------------------------------

  /**
   * Obfuscate a staging blob for remote transport.
   * @param {string} plaintext - Serialized JSON blob string.
   * @param {string} masterKeyHex - 64-char hex master key.
   * @returns {string} Base64-encoded obfuscated bytes.
   */
  obfuscateBlob(plaintext, masterKeyHex) {
    return this.#call2('obfuscate_blob', plaintext, masterKeyHex);
  }

  /**
   * Deobfuscate a staging blob after pulling from remote.
   * @param {string} obfuscatedB64 - Base64-encoded obfuscated bytes.
   * @param {string} masterKeyHex - 64-char hex master key.
   * @returns {string} Original JSON string.
   */
  deobfuscateBlob(obfuscatedB64, masterKeyHex) {
    return this.#call2('deobfuscate_blob', obfuscatedB64, masterKeyHex);
  }

  /**
   * Obfuscate using the CACHED master key.
   * @param {string} plaintext
   * @returns {string}
   */
  obfuscateBlobWithCachedKey(plaintext) {
    const mk = this.#requireMasterKey();
    return this.obfuscateBlob(plaintext, mk);
  }

  /**
   * Deobfuscate using the CACHED master key.
   * @param {string} obfuscatedB64
   * @returns {string}
   */
  deobfuscateBlobWithCachedKey(obfuscatedB64) {
    const mk = this.#requireMasterKey();
    return this.deobfuscateBlob(obfuscatedB64, mk);
  }

  // -----------------------------------------------------------------------
  // Random generation (3)
  // -----------------------------------------------------------------------

  /**
   * Generate a 32-byte recovery seed.
   * @returns {string} Base64-encoded 44-character seed.
   */
  generateSeed() {
    return this.#call0('generate_seed');
  }

  /**
   * Generate a random UUID v4.
   * @returns {string} UUID string (36 chars, e.g. "550e8400-...").
   */
  generateUuid() {
    return this.#call0('generate_uuid_v4');
  }

  /**
   * Generate a random device specifier.
   * @returns {string} 32-char random hex string.
   */
  generateDeviceSpecifier() {
    return this.#call0('generate_device_specifier');
  }

  // -----------------------------------------------------------------------
  // Device identity (3)
  // -----------------------------------------------------------------------

  /**
   * Derive a deterministic device ID from the master key.
   * @param {string} masterKeyHex - 64-char hex master key.
   * @returns {string} 64-char hex device ID.
   */
  getDeviceId(masterKeyHex) {
    return this.#call1('get_device_id', masterKeyHex);
  }

  /**
   * Compute a device proof.
   * @param {string} masterKeyHex - 64-char hex master key.
   * @param {string} deviceId - Device ID from getDeviceId().
   * @returns {string} 64-char hex proof.
   */
  deviceProof(masterKeyHex, deviceId) {
    return this.#call2('device_proof', masterKeyHex, deviceId);
  }

  /**
   * Verify a device proof.
   * @param {string} deviceId
   * @param {string} proofHex
   * @param {string} masterKeyHex
   * @returns {boolean}
   */
  verifyDeviceProof(deviceId, proofHex, masterKeyHex) {
    return this.#call3('verify_device_proof', deviceId, proofHex, masterKeyHex);
  }

  /**
   * Convenience: get device ID from the CACHED master key.
   * @returns {string}
   */
  getDeviceIdWithCachedKey() {
    const mk = this.#requireMasterKey();
    return this.getDeviceId(mk);
  }

  // -----------------------------------------------------------------------
  // Convenience (1)
  // -----------------------------------------------------------------------

  /**
   * Full authentication convenience: passphrase + seed → master key.
   *
   * In the CLI, this is a multi-step process:
   *   passphrase → PBKDF2 → PDK → decrypt seed → master key
   *
   * In the web app, the seed is typically already available from
   * secure storage, so this is a simple wrapper.
   *
   * @param {string} passphrase - User's passphrase.
   * @param {string} seed - Base64-encoded recovery seed.
   * @param {number} iterations - PBKDF2 iterations (600000 or 100000).
   * @returns {string} Hex-encoded 64-char master key.
   */
  authenticate(passphrase, seed, iterations) {
    return this.#call3('authenticate', passphrase, seed, iterations);
  }
}

// ── ADR-026: versioned key derivation (Web Crypto API) ────────────

/**
 * Derive a versioned Master Key from the Recovery Seed (ADR-026).
 *
 * Uses Web Crypto API (crypto.subtle) for browser/Node.js portability.
 * - version=0 returns the raw seed (pre-ADR backward compat)
 * - version>=1 uses HMAC-SHA256(seed, "phpoc:mk:v{N}")
 *
 * @param {Uint8Array} seed - 32-byte recovery seed.
 * @param {number} version - Key version (0 = raw seed, 1+ = HMAC-derived).
 * @returns {Promise<Uint8Array>} 32-byte versioned master key.
 */
export async function deriveMk(seed, version) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) {
    throw new Error('Seed must be a 32-byte Uint8Array');
  }
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw new TypeError(`version must be an int, got ${typeof version}`);
  }
  if (version === 0) {
    return seed;
  }
  const key = await crypto.subtle.importKey(
    'raw', seed,
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );
  const data = new TextEncoder().encode(`phpoc:mk:v${version}`);
  const sig = await crypto.subtle.sign('HMAC', key, data);
  return new Uint8Array(sig);
}

/**
 * CryptoManager — lightweight JS crypto manager for key version tracking.
 *
 * Mirrors the Python CryptoManager's key_version attribute for
 * sub-key derivation context. Used by chain verification and
 * session cache.
 */
export class CryptoManager {
  /**
   * @param {string} masterKeyHex - 64-char hex-encoded master key.
   * @param {number} [keyVersion=0] - Key version for tracking.
   */
  constructor(masterKeyHex, keyVersion = 0) {
    this.masterKey = masterKeyHex;
    this.keyVersion = keyVersion;
  }
}
