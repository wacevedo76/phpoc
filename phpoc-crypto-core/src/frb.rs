//! flutter_rust_bridge API — Dart-accessible wrappers around phpoc-crypto-core.
//!
//! Mirrors `wasm.rs` but uses `flutter_rust_bridge` for FFI instead of
//! `wasm-bindgen`. All 23 exported functions are auto-generated into
//! `frb_generated.dart` by `flutter_rust_bridge_codegen generate`.

use base64::Engine;
use crate::{aes_ctr, blob, device, digest, hmac_utils, key_derivation, random, CryptoError};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Decode a hex string into a 32-byte array, returning a `CryptoError`.
fn decode_hex_32(hex_str: &str) -> Result<[u8; 32], CryptoError> {
    let bytes = hex::decode(hex_str)
        .map_err(|e| CryptoError::InvalidHexData(format!("invalid hex: {}", e)))?;
    if bytes.len() != 32 {
        return Err(CryptoError::InvalidKeyLength);
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&bytes);
    Ok(key)
}

/// Decode a hex string into a 16-byte array, returning a `CryptoError`.
fn decode_hex_16(hex_str: &str) -> Result<[u8; 16], CryptoError> {
    let bytes = hex::decode(hex_str)
        .map_err(|e| CryptoError::InvalidHexData(format!("invalid hex: {}", e)))?;
    if bytes.len() != 16 {
        return Err(CryptoError::InvalidKeyLength);
    }
    let mut key = [0u8; 16];
    key.copy_from_slice(&bytes);
    Ok(key)
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

/// Derive a Passphrase-Derived Key (PDK) via PBKDF2-HMAC-SHA256.
///
/// Returns hex-encoded 32-byte PDK (64 hex chars).
pub fn derive_pdk(passphrase: String, iterations: u32) -> String {
    let iters = if iterations == 100_000 {
        key_derivation::PdkIterations::Legacy
    } else {
        key_derivation::PdkIterations::Standard
    };
    let key = key_derivation::derive_pdk(&passphrase, iters);
    hex::encode(key)
}

/// Derive a PDK with a custom per-user salt.
///
/// Returns hex-encoded 32-byte PDK (64 hex chars).
pub fn derive_pdk_with_salt(
    passphrase: String,
    salt_hex: String,
    iterations: u32,
) -> Result<String, CryptoError> {
    let salt = decode_hex_16(&salt_hex)?;
    let iters = if iterations == 100_000 {
        key_derivation::PdkIterations::Legacy
    } else {
        key_derivation::PdkIterations::Standard
    };
    let key = key_derivation::derive_pdk_with_salt(&passphrase, &salt, iters);
    Ok(hex::encode(key))
}

/// Derive the 32-byte Master Key from a base64-encoded recovery seed.
///
/// Returns hex-encoded 64-char master key.
pub fn derive_master_key(seed: String) -> Result<String, CryptoError> {
    let mk = key_derivation::derive_master_key(&seed)?;
    Ok(hex::encode(mk))
}

/// Derive the blob obfuscation sub-key (16 bytes → 32 hex chars).
pub fn derive_blob_key(master_key_hex: String) -> Result<String, CryptoError> {
    let mk = decode_hex_32(&master_key_hex)?;
    let bk = key_derivation::derive_blob_key(&mk);
    Ok(hex::encode(bk))
}

/// Derive the sealing sub-key (32 bytes → 64 hex chars).
pub fn derive_seal_key(master_key_hex: String) -> Result<String, CryptoError> {
    let mk = decode_hex_32(&master_key_hex)?;
    let sk = key_derivation::derive_seal_key(&mk);
    Ok(hex::encode(sk))
}

/// Derive the field-level encryption key (16 bytes → 32 hex chars).
pub fn derive_field_key(master_key_hex: String) -> Result<String, CryptoError> {
    let mk = decode_hex_32(&master_key_hex)?;
    let field_key = key_derivation::derive_sub_key_16(&mk, b"phpoc-staging-keys-v1");
    Ok(hex::encode(field_key))
}

// ---------------------------------------------------------------------------
// AES-128-CTR encryption / decryption
// ---------------------------------------------------------------------------

/// Encrypt plaintext with the given master key.
///
/// Returns hex-encoded ciphertext (salt + nonce + ciphertext + auth tag).
pub fn encrypt(plaintext: String, master_key_hex: String) -> Result<String, CryptoError> {
    let mk = decode_hex_32(&master_key_hex)?;
    Ok(aes_ctr::encrypt(&plaintext, &mk))
}

/// Decrypt a hex-encoded ciphertext with the given master key.
///
/// Returns the original plaintext.
pub fn decrypt(ciphertext_hex: String, master_key_hex: String) -> Result<String, CryptoError> {
    let mk = decode_hex_32(&master_key_hex)?;
    aes_ctr::decrypt(&ciphertext_hex, &mk)
}

// ---------------------------------------------------------------------------
// HMAC-SHA256 sealing & verification
// ---------------------------------------------------------------------------

/// Compute an HMAC-SHA256 block seal.
///
/// Returns 64-char hex seal.
pub fn seal(data: String, master_key_hex: String) -> Result<String, CryptoError> {
    let mk = decode_hex_32(&master_key_hex)?;
    Ok(hmac_utils::seal(&data, &mk))
}

/// Verify an HMAC-SHA256 block seal.
///
/// Returns `true` if the seal is valid, `false` otherwise.
pub fn verify_seal(data: String, seal_hex: String, master_key_hex: String) -> bool {
    let mk = match decode_hex_32(&master_key_hex) {
        Ok(k) => k,
        Err(_) => return false,
    };
    hmac_utils::verify_seal(&data, &seal_hex, &mk)
}

/// Sign data with the identity secret (HMAC-SHA256 signature).
///
/// Returns 64-char hex signature.
pub fn sign(data: String, identity_secret_hex: String) -> Result<String, CryptoError> {
    let secret = decode_hex_32(&identity_secret_hex)?;
    Ok(hmac_utils::sign(&data, &secret))
}

/// Verify an HMAC-SHA256 identity signature.
pub fn verify_signature(data: String, signature_hex: String, identity_secret_hex: String) -> bool {
    let secret = match decode_hex_32(&identity_secret_hex) {
        Ok(k) => k,
        Err(_) => return false,
    };
    hmac_utils::verify_signature(&data, &signature_hex, &secret)
}

/// Compute a generic HMAC-SHA256 with an arbitrary hex-encoded key.
///
/// Returns 64-char lowercase hex HMAC-SHA256.
pub fn hmac_hex(key_hex: String, data: String) -> Result<String, CryptoError> {
    let key_bytes = hex::decode(&key_hex)
        .map_err(|e| CryptoError::InvalidHexData(format!("invalid hex key: {}", e)))?;
    Ok(hmac_utils::hmac_hex(&key_bytes, data.as_bytes()))
}

// ---------------------------------------------------------------------------
// SHA-256 hashing
// ---------------------------------------------------------------------------

/// Compute SHA-256 hash of a string.
///
/// Returns 64-char lowercase hex string.
pub fn sha256(data: String) -> String {
    digest::sha256_string(&data)
}

/// Derive the identity public key from a hex-encoded identity secret.
///
/// Per PHPSPEC §2.7.1 the secret is 32 raw bytes; the hex string is decoded
/// to bytes before SHA-256 (NOT hashed as a UTF-8 string). Mirrors the WASM
/// `identity_pub_key` binding (raw-bytes semantics) for the Flutter side.
pub fn identity_pub_key(identity_secret_hex: String) -> Result<String, CryptoError> {
    digest::identity_pub_key_hex(&identity_secret_hex)
}

// ---------------------------------------------------------------------------
// Blob obfuscation
// ---------------------------------------------------------------------------

/// Obfuscate a staging blob for remote transport.
///
/// Returns base64-encoded obfuscated bytes.
pub fn obfuscate_blob(plaintext: String, master_key_hex: String) -> Result<String, CryptoError> {
    let mk = decode_hex_32(&master_key_hex)?;
    let obfuscated = blob::obfuscate_blob(plaintext.as_bytes(), &mk)?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&obfuscated))
}

/// Deobfuscate a staging blob after pulling from remote.
///
/// Returns original plaintext JSON string.
pub fn deobfuscate_blob(obfuscated_b64: String, master_key_hex: String) -> Result<String, CryptoError> {
    let mk = decode_hex_32(&master_key_hex)?;
    let obfuscated = base64::engine::general_purpose::STANDARD
        .decode(&obfuscated_b64)
        .map_err(|e| CryptoError::InvalidBase64(e.to_string()))?;
    let plaintext = blob::deobfuscate_blob(&obfuscated, &mk)
        .ok_or(CryptoError::BlobDeobfuscationFailed(
            "blob deobfuscation failed: wrong key or corrupted data".into()
        ))?;
    String::from_utf8(plaintext)
        .map_err(|e| CryptoError::DecryptionFailed(format!("invalid UTF-8 in decrypted blob: {}", e)))
}

// ---------------------------------------------------------------------------
// Random generation
// ---------------------------------------------------------------------------

/// Generate a 32-byte (256-bit) recovery seed, base64-encoded (44 chars).
pub fn generate_seed() -> String {
    random::generate_seed()
}

/// Generate a random UUID v4 string (36 chars).
pub fn generate_uuid_v4() -> String {
    random::generate_uuid_v4()
}

/// Generate a random device specifier (32-char hex).
pub fn generate_device_specifier() -> String {
    random::generate_device_specifier()
}

// ---------------------------------------------------------------------------
// Device identity
// ---------------------------------------------------------------------------

/// Compute a device proof: HMAC-SHA256(MK, "phpoc:device:" + device_id).
///
/// Returns 64-char hex string.
pub fn device_proof(master_key_hex: String, device_id: String) -> Result<String, CryptoError> {
    let mk = decode_hex_32(&master_key_hex)?;
    Ok(device::device_proof(&mk, &device_id))
}

/// Verify a device proof.
pub fn verify_device_proof(
    device_id: String,
    proof_hex: String,
    master_key_hex: String,
) -> bool {
    let mk = match decode_hex_32(&master_key_hex) {
        Ok(k) => k,
        Err(_) => return false,
    };
    device::verify_device_proof(&device_id, &proof_hex, &mk)
}

/// Derive a deterministic device ID from the master key.
///
/// Returns 64-char hex string.
pub fn get_device_id(master_key_hex: String) -> Result<String, CryptoError> {
    let mk = decode_hex_32(&master_key_hex)?;
    Ok(device::get_device_id(&mk))
}

// ---------------------------------------------------------------------------
// Convenience — full auth flow
// ---------------------------------------------------------------------------

/// Full authentication flow: derive master key from seed.
///
/// In Phase 3 this delegates to `derive_master_key`. The full PDK-based
/// auth (passphrase → PDK → decrypt seed → decode to MK) is handled by
/// the CryptoService wrapper layer on the Dart side.
pub fn authenticate(
    _passphrase: String,
    seed: String,
    _iterations: u32,
) -> Result<String, CryptoError> {
    derive_master_key(seed)
}
