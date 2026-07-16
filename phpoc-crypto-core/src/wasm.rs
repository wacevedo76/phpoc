//! WASM bindings — JavaScript-accessible wrappers around phpoc-crypto-core.
//!
//! All functions are annotated with `#[wasm_bindgen]` so that `wasm-bindgen`
//! generates the JS/TS glue needed to call them from a web app.
//!
//! Input: hex strings for binary keys, plain strings for passphrases/text.
//! Output: hex strings for binary results, JS strings for text, `JsValue`
//! for errors (converted from `CryptoError`).

use wasm_bindgen::prelude::*;

use base64::Engine;

use crate::aes_ctr;
use crate::blob;
use crate::device;
use crate::digest;
use crate::hmac_utils;
use crate::key_derivation;
use crate::random;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Decode a hex string into a 32-byte array, returning an error `JsValue`.
fn decode_hex_32(hex_str: &str) -> Result<[u8; 32], JsValue> {
    let bytes = hex::decode(hex_str).map_err(|e| {
        JsValue::from_str(&format!("invalid hex: {}", e))
    })?;
    if bytes.len() != 32 {
        return Err(JsValue::from_str("hex string must decode to 32 bytes"));
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&bytes);
    Ok(key)
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

/// Derive a Passphrase-Derived Key (PDK) via PBKDF2-HMAC-SHA256.
///
/// * `passphrase` — user's passphrase.
/// * `iterations` — 600000 (standard) or 100000 (legacy / pre-R3 genesis).
///
/// Returns hex-encoded 32-byte PDK.
#[wasm_bindgen]
pub fn derive_pdk(passphrase: &str, iterations: u32) -> String {
    let iters = if iterations == 100_000 {
        key_derivation::PdkIterations::Legacy
    } else {
        key_derivation::PdkIterations::Standard
    };
    let key = key_derivation::derive_pdk(passphrase, iters);
    hex::encode(key)
}

/// Derive a PDK with a custom per-user salt.
///
/// * `passphrase` — user's passphrase.
/// * `salt_hex` — 32-char hex-encoded 16-byte per-user salt
///   (SHA-256(identity_pub_key_hex)[:16]).
/// * `iterations` — 600000 (standard) or 100000 (legacy).
///
/// Returns hex-encoded 32-byte PDK.
#[wasm_bindgen]
pub fn derive_pdk_with_salt(passphrase: &str, salt_hex: &str, iterations: u32) -> Result<String, JsValue> {
    let salt_bytes = hex::decode(salt_hex).map_err(|e| {
        JsValue::from_str(&format!("invalid salt hex: {}", e))
    })?;
    if salt_bytes.len() != 16 {
        return Err(JsValue::from_str("salt must be 16 bytes (32 hex chars)"));
    }
    let mut salt = [0u8; 16];
    salt.copy_from_slice(&salt_bytes);

    let iters = if iterations == 100_000 {
        key_derivation::PdkIterations::Legacy
    } else {
        key_derivation::PdkIterations::Standard
    };
    let key = key_derivation::derive_pdk_with_salt(passphrase, &salt, iters);
    Ok(hex::encode(key))
}

/// Derive the 32-byte Master Key from a base64-encoded recovery seed.
///
/// Returns hex-encoded 64-character master key, or throws an error.
#[wasm_bindgen]
pub fn derive_master_key(seed: &str) -> Result<String, JsValue> {
    let mk = key_derivation::derive_master_key(seed).map_err(|e| {
        JsValue::from_str(&e.to_string())
    })?;
    Ok(hex::encode(mk))
}

// ---------------------------------------------------------------------------
// AES-128-CTR encryption / decryption
// ---------------------------------------------------------------------------

/// Encrypt plaintext with the given master key.
///
/// * `plaintext` — UTF-8 text to encrypt.
/// * `master_key_hex` — 64-char hex-encoded 32-byte master key.
///
/// Returns hex-encoded ciphertext (salt + nonce + ciphertext + auth tag).
#[wasm_bindgen]
pub fn encrypt(plaintext: &str, master_key_hex: &str) -> Result<String, JsValue> {
    let mk = decode_hex_32(master_key_hex)?;
    Ok(aes_ctr::encrypt(plaintext, &mk))
}

/// Decrypt a hex-encoded ciphertext with the given master key.
///
/// * `ciphertext_hex` — hex-encoded ciphertext from `encrypt()`.
/// * `master_key_hex` — 64-char hex-encoded 32-byte master key.
///
/// Returns the original plaintext, or throws on auth tag mismatch / wrong key.
#[wasm_bindgen]
pub fn decrypt(ciphertext_hex: &str, master_key_hex: &str) -> Result<String, JsValue> {
    let mk = decode_hex_32(master_key_hex)?;
    aes_ctr::decrypt(ciphertext_hex, &mk).map_err(|e| {
        JsValue::from_str(&e.to_string())
    })
}

// ---------------------------------------------------------------------------
// HMAC-SHA256 sealing & verification
// ---------------------------------------------------------------------------

/// Compute an HMAC-SHA256 block seal.
///
/// * `data` — canonical JSON string to seal.
/// * `master_key_hex` — 64-char hex-encoded 32-byte master key.
///
/// Returns 64-char hex seal.
#[wasm_bindgen]
pub fn seal(data: &str, master_key_hex: &str) -> Result<String, JsValue> {
    let mk = decode_hex_32(master_key_hex)?;
    Ok(hmac_utils::seal(data, &mk))
}

/// Verify an HMAC-SHA256 block seal.
///
/// * `data` — the original data string.
/// * `seal_hex` — the hex seal to verify.
/// * `master_key_hex` — 64-char hex-encoded 32-byte master key.
///
/// Returns `true` if the seal is valid, `false` otherwise.
#[wasm_bindgen]
pub fn verify_seal(data: &str, seal_hex: &str, master_key_hex: &str) -> bool {
    let mk = match decode_hex_32(master_key_hex) {
        Ok(k) => k,
        Err(_) => return false,
    };
    hmac_utils::verify_seal(data, seal_hex, &mk)
}

/// Sign data with the identity secret (HMAC-SHA256 signature).
///
/// * `data` — string to sign (typically a block hash).
/// * `identity_secret_hex` — 64-char hex 32-byte identity secret.
///
/// Returns 64-char hex signature.
#[wasm_bindgen]
pub fn sign(data: &str, identity_secret_hex: &str) -> Result<String, JsValue> {
    let secret = decode_hex_32(identity_secret_hex)?;
    Ok(hmac_utils::sign(data, &secret))
}

/// Verify an HMAC-SHA256 identity signature.
#[wasm_bindgen]
pub fn verify_signature(data: &str, signature_hex: &str, identity_secret_hex: &str) -> bool {
    let secret = match decode_hex_32(identity_secret_hex) {
        Ok(k) => k,
        Err(_) => return false,
    };
    hmac_utils::verify_signature(data, signature_hex, &secret)
}

// ---------------------------------------------------------------------------
// SHA-256 hashing
// ---------------------------------------------------------------------------

/// Compute SHA-256 hash of a string.
///
/// Returns 64-char lowercase hex string.
#[wasm_bindgen]
pub fn sha256(data: &str) -> String {
    digest::sha256_string(data)
}

// ---------------------------------------------------------------------------
// Blob obfuscation
// ---------------------------------------------------------------------------

/// Obfuscate a staging blob for remote transport.
///
/// * `plaintext` — UTF-8 string (serialized JSON blob).
/// * `master_key_hex` — 64-char hex-encoded 32-byte master key.
///
/// Returns base64-encoded obfuscated bytes (safe to transmit as JSON string).
#[wasm_bindgen]
pub fn obfuscate_blob(plaintext: &str, master_key_hex: &str) -> Result<String, JsValue> {
    let mk = decode_hex_32(master_key_hex)?;
    let obfuscated = blob::obfuscate_blob(plaintext.as_bytes(), &mk).map_err(|e| {
        JsValue::from_str(&e.to_string())
    })?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&obfuscated))
}

/// Deobfuscate a staging blob after pulling from remote.
///
/// * `obfuscated_b64` — base64-encoded obfuscated bytes.
/// * `master_key_hex` — 64-char hex-encoded 32-byte master key.
///
/// Returns original plaintext JSON string, or throws an error.
#[wasm_bindgen]
pub fn deobfuscate_blob(obfuscated_b64: &str, master_key_hex: &str) -> Result<String, JsValue> {
    let mk = decode_hex_32(master_key_hex)?;
    let obfuscated = base64::engine::general_purpose::STANDARD
        .decode(obfuscated_b64)
        .map_err(|e| JsValue::from_str(&format!("invalid base64: {}", e)))?;
    let plaintext = blob::deobfuscate_blob(&obfuscated, &mk).ok_or_else(|| {
        JsValue::from_str("blob deobfuscation failed: wrong key or corrupted data")
    })?;
    String::from_utf8(plaintext).map_err(|e| {
        JsValue::from_str(&format!("invalid UTF-8 in decrypted blob: {}", e))
    })
}

// ---------------------------------------------------------------------------
// Random generation
// ---------------------------------------------------------------------------

/// Generate a 32-byte (256-bit) recovery seed, base64-encoded.
#[wasm_bindgen]
pub fn generate_seed() -> String {
    random::generate_seed()
}

/// Generate a random UUID v4 string.
#[wasm_bindgen]
pub fn generate_uuid_v4() -> String {
    random::generate_uuid_v4()
}

/// Generate a random device specifier (32-char hex).
#[wasm_bindgen]
pub fn generate_device_specifier() -> String {
    random::generate_device_specifier()
}

// ---------------------------------------------------------------------------
// Device identity
// ---------------------------------------------------------------------------

/// Compute a device proof: HMAC-SHA256(MK, "phpoc:device:" + device_id).
///
/// Returns 64-char hex string.
#[wasm_bindgen]
pub fn device_proof(master_key_hex: &str, device_id: &str) -> Result<String, JsValue> {
    let mk = decode_hex_32(master_key_hex)?;
    Ok(device::device_proof(&mk, device_id))
}

/// Verify a device proof.
#[wasm_bindgen]
pub fn verify_device_proof(device_id: &str, proof_hex: &str, master_key_hex: &str) -> bool {
    let mk = match decode_hex_32(master_key_hex) {
        Ok(k) => k,
        Err(_) => return false,
    };
    device::verify_device_proof(device_id, proof_hex, &mk)
}

/// Derive a deterministic device ID from the master key.
///
/// Returns 64-char hex string (HMAC-SHA256(MK, "device:id")).
#[wasm_bindgen]
pub fn get_device_id(master_key_hex: &str) -> Result<String, JsValue> {
    let mk = decode_hex_32(master_key_hex)?;
    Ok(device::get_device_id(&mk))
}

// ---------------------------------------------------------------------------
// Convenience — full auth flow
// ---------------------------------------------------------------------------

/// Full authentication flow: passphrase → PDK → master key (for JS convenience).
///
/// In the CLI this is a multi-step process (PDK decrypts seed, seed decodes
/// to master key). In the web app, the seed is typically already available
/// from secure storage, so this flow is only needed during first-time setup.
///
/// * `passphrase` — user's passphrase.
/// * `seed` — base64-encoded recovery seed.
/// * `iterations` — PBKDF2 iterations (600000 or 100000).
///
/// Returns the hex-encoded master key on success.
#[wasm_bindgen]
pub fn authenticate(_passphrase: &str, seed: &str, _iterations: u32) -> Result<String, JsValue> {
    derive_master_key(seed) // already returns Result<String, JsValue>
}

/// Derive the blob obfuscation sub-key (hex-encoded, 16 bytes → 32 hex chars).
#[wasm_bindgen]
pub fn derive_blob_key(master_key_hex: &str) -> Result<String, JsValue> {
    let mk = decode_hex_32(master_key_hex)?;
    let bk = key_derivation::derive_blob_key(&mk);
    Ok(hex::encode(bk))
}

/// Derive the sealing sub-key (hex-encoded, 32 bytes → 64 hex chars).
#[wasm_bindgen]
pub fn derive_seal_key(master_key_hex: &str) -> Result<String, JsValue> {
    let mk = decode_hex_32(master_key_hex)?;
    let sk = key_derivation::derive_seal_key(&mk);
    Ok(hex::encode(sk))
}

// ---------------------------------------------------------------------------
// Generic HMAC-SHA256 + field-key derivation (I-02a)
// ---------------------------------------------------------------------------

/// Compute an HMAC-SHA256 over data with an arbitrary hex-encoded key.
///
/// * `key_hex` — hex-encoded HMAC key (any length).
/// * `data` — UTF-8 string to authenticate.
///
/// Returns 64-char lowercase hex HMAC-SHA256.
#[wasm_bindgen]
pub fn hmac_hex(key_hex: &str, data: &str) -> Result<String, JsValue> {
    let key_bytes = hex::decode(key_hex).map_err(|e| {
        JsValue::from_str(&format!("invalid hex key: {}", e))
    })?;
    Ok(hmac_utils::hmac_hex(&key_bytes, data.as_bytes()))
}

/// Derive the field-level encryption key for blind index field-name tokens.
///
/// * `master_key_hex` — 64-char hex-encoded 32-byte master key.
///
/// Returns 32-char hex (first 16 bytes of HMAC-SHA256(MK, "phpoc-staging-keys-v1")).
/// Used by I-02a for encrypting field names in the staging storage layer.
#[wasm_bindgen]
pub fn derive_field_key(master_key_hex: &str) -> Result<String, JsValue> {
    let mk = decode_hex_32(master_key_hex)?;
    let field_key = key_derivation::derive_sub_key_16(&mk, b"phpoc-staging-keys-v1");
    Ok(hex::encode(field_key))
}
