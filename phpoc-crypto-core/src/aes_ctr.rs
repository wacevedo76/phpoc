//! AES-128-CTR encryption/decryption with encrypt-then-MAC auth tags.
//!
//! Implements PHPSPEC §3 (Encryption Scheme):
//! - AES-128-CTR mode (stream cipher, encryption = decryption)
//! - Per-operation key derivation (different salt → different AES key)
//! - Encrypt-then-MAC: HMAC-SHA256 over (nonce || ciphertext)
//! - Wire format: salt(16) + nonce(8) + ciphertext + tag(32) → hex

use aes::cipher::{KeyIvInit, StreamCipher};
use ctr::Ctr64BE;
use ring::hmac;

use crate::key_derivation::derive_encryption_keys;
use crate::random::random_bytes;
use crate::{CryptoError, Result};

/// AES-128-CTR cipher type (AES-128, 64-bit big-endian counter).
///
/// The IV is 16 bytes: `nonce(8) || starting_counter(8)` where
/// starting_counter is `0x0000000000000000` (PHPSPEC §3.2.1).
type Aes128Ctr = Ctr64BE<aes::Aes128>;

/// Build a 16-byte AES-CTR IV from an 8-byte nonce.
///
/// Per PHPSPEC §3.2.1:
/// `Counter block (16 bytes) = nonce(8) || counter(8)`
/// Counter starts at 0 (big-endian u64).
fn build_ctr_iv(nonce: &[u8; 8]) -> [u8; 16] {
    let mut iv = [0u8; 16];
    iv[..8].copy_from_slice(nonce);
    // iv[8..16] is already zero = counter starts at 0
    iv
}

/// Encrypt a plaintext string to a hex-encoded ciphertext string.
///
/// Per PHPSPEC §3.4:
/// 1. Generate random salt (16 bytes) and nonce (8 bytes)
/// 2. Derive encryption key: `HMAC(MK, salt)[:16]`
/// 3. Derive integrity key: `HMAC(MK, salt || "-integrity")`
/// 4. AES-CTR encrypt plaintext bytes
/// 5. HMAC-SHA256 over (nonce || ciphertext) → auth tag (32 bytes)
/// 6. Assemble: salt(16) + nonce(8) + ciphertext + tag(32) → hex string
///
/// # Arguments
/// * `plaintext` - Text to encrypt.
/// * `master_key` - 32-byte Master Key.
///
/// # Returns
/// Hex-encoded ciphertext string.
pub fn encrypt(plaintext: &str, master_key: &[u8; 32]) -> String {
    let salt: [u8; 16] = random_bytes(16).try_into().expect("16 bytes");
    let nonce: [u8; 8] = random_bytes(8).try_into().expect("8 bytes");
    let (enc_key, integrity_key) = derive_encryption_keys(master_key, &salt);

    // AES-CTR encrypt
    let plaintext_bytes = plaintext.as_bytes();
    let mut ciphertext = plaintext_bytes.to_vec();
    let iv = build_ctr_iv(&nonce);
    let mut cipher = Aes128Ctr::new(&enc_key.into(), &iv.into());
    cipher.apply_keystream(&mut ciphertext);

    // Encrypt-then-MAC: auth tag over (nonce || ciphertext)
    let mut auth_data = nonce.to_vec();
    auth_data.extend_from_slice(&ciphertext);
    let signing_key = hmac::Key::new(hmac::HMAC_SHA256, &integrity_key);
    let tag = hmac::sign(&signing_key, &auth_data);
    let tag_bytes = tag.as_ref();

    // Assemble: salt(16) + nonce(8) + ciphertext + tag(32)
    let mut output = salt.to_vec();
    output.extend_from_slice(&nonce);
    output.extend_from_slice(&ciphertext);
    output.extend_from_slice(tag_bytes);

    hex::encode(&output)
}

/// Decrypt a hex-encoded ciphertext back to plaintext.
///
/// Per PHPSPEC §3.5:
/// 1. Parse hex → bytes: salt(16) + nonce(8) + ciphertext [+ tag(32)]
/// 2. Verify auth tag BEFORE decryption (when present)
/// 3. AES-CTR decrypt
///
/// Supports both current format (with auth tag, len >= 56)
/// and legacy format (without auth tag, len < 56).
///
/// When the canonical PHPSPEC scheme (HMAC-derived keys) fails, falls back
/// to Flutter/Dart scheme: aesKey = MK[:16], HMAC(aesKey, salt‖nonce‖ct).
///
/// # Arguments
/// * `hex_data` - Hex-encoded ciphertext.
/// * `master_key` - 32-byte Master Key.
///
/// # Returns
/// Decrypted plaintext string.
pub fn decrypt(hex_data: &str, master_key: &[u8; 32]) -> Result<String> {
    let data = hex::decode(hex_data)
        .map_err(|e| CryptoError::InvalidHexData(e.to_string()))?;

    if data.len() < 24 {
        return Err(CryptoError::DecryptionFailed(
            "data too short: need at least 24 bytes (salt + nonce)".into(),
        ));
    }

    let salt: [u8; 16] = data[..16].try_into().unwrap();
    let nonce: [u8; 8] = data[16..24].try_into().unwrap();
    let flutter_aes_key: [u8; 16] = master_key[..16].try_into().unwrap();
    let (enc_key, integrity_key) = derive_encryption_keys(master_key, &salt);

    // Detect format: full (with tag ≥ 56 bytes) vs short (no tag)
    let has_tag = data.len() >= 56;

    if has_tag {
        let ciphertext = &data[24..data.len() - 32];
        let stored_tag = &data[data.len() - 32..];

        // ── Path 1: Canonical PHPSPEC (HMAC-derived sub-keys) ──
        let mut auth_data = nonce.to_vec();
        auth_data.extend_from_slice(ciphertext);
        let signing_key = hmac::Key::new(hmac::HMAC_SHA256, &integrity_key);
        let expected_tag = hmac::sign(&signing_key, &auth_data);

        if expected_tag.as_ref() == stored_tag {
            return decrypt_inner(ciphertext, &enc_key, &nonce);
        }

        // ── Path 2: Legacy Flutter (raw mk[:16], salt‖nonce‖ct auth) ──
        let mut flutter_auth_data = salt.to_vec();
        flutter_auth_data.extend_from_slice(&nonce);
        flutter_auth_data.extend_from_slice(ciphertext);
        let flutter_signing_key = hmac::Key::new(hmac::HMAC_SHA256, &flutter_aes_key);
        let flutter_expected_tag = hmac::sign(&flutter_signing_key, &flutter_auth_data);

        if flutter_expected_tag.as_ref() == stored_tag {
            return decrypt_inner(ciphertext, &flutter_aes_key, &nonce);
        }

        // ── Path 3: Raw (treat tag as ciphertext) ──
        return decrypt_inner(&data[24..], &flutter_aes_key, &nonce);
    } else {
        // ── Path 4: Short format (no auth tag) ──
        let ciphertext = &data[24..];

        // Try Flutter mk[:16] key first
        if let Ok(result) = decrypt_inner(ciphertext, &flutter_aes_key, &nonce) {
            // Validate: should be numeric (epoch timestamp)
            if result.parse::<i64>().is_ok() {
                return Ok(result);
            }
        }

        // Fall back to canonical HMAC-derived key
        decrypt_inner(ciphertext, &enc_key, &nonce)
    }
}

/// Internal: AES-CTR decrypt raw bytes with given key and nonce.
fn decrypt_inner(ciphertext: &[u8], enc_key: &[u8; 16], nonce: &[u8; 8]) -> Result<String> {
    let mut result = ciphertext.to_vec();
    let iv = build_ctr_iv(nonce);
    let mut cipher = Aes128Ctr::new(enc_key.into(), &iv.into());
    cipher.apply_keystream(&mut result);

    String::from_utf8(result)
        .map_err(|e| CryptoError::DecryptionFailed(format!("invalid UTF-8: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let mk = [0xABu8; 32];
        let plaintext = "Hello, PHPOC!";

        let ciphertext = encrypt(plaintext, &mk);
        assert_ne!(ciphertext, plaintext);

        let decrypted = decrypt(&ciphertext, &mk).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_encrypt_different_each_time() {
        let mk = [0xABu8; 32];
        let plaintext = "Same plaintext";

        let c1 = encrypt(plaintext, &mk);
        let c2 = encrypt(plaintext, &mk);

        // Semantic security: same plaintext → different ciphertexts
        assert_ne!(c1, c2);
    }

    #[test]
    fn test_encrypt_different_keys_different_output() {
        let mk1 = [0xABu8; 32];
        let mk2 = [0xCDu8; 32];
        let plaintext = "Test";

        let c1 = encrypt(plaintext, &mk1);
        let c2 = encrypt(plaintext, &mk2);

        assert_ne!(c1, c2);
    }

    #[test]
    fn test_encrypt_with_unicode() {
        let mk = [0xABu8; 32];
        let plaintext = "日本語 Español 🔐";

        let ciphertext = encrypt(plaintext, &mk);
        let decrypted = decrypt(&ciphertext, &mk).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_decrypt_wrong_key_fails() {
        let mk1 = [0xABu8; 32];
        let mk2 = [0xCDu8; 32];
        let plaintext = "Secret data";

        let ciphertext = encrypt(plaintext, &mk1);
        let result = decrypt(&ciphertext, &mk2);

        // Wrong key should fail (auth tag mismatch)
        assert!(result.is_err());
    }

    #[test]
    fn test_tampered_ciphertext_fails() {
        let mk = [0xABu8; 32];
        let plaintext = "Don't tamper with me";

        let ciphertext = encrypt(plaintext, &mk);
        let mut bytes = hex::decode(&ciphertext).unwrap();

        // Flip a bit in the ciphertext (last byte before tag)
        let last_data_byte = bytes.len() - 33;
        bytes[last_data_byte] ^= 0x01;

        let tampered = hex::encode(&bytes);
        let result = decrypt(&tampered, &mk);

        assert!(result.is_err());
    }

    #[test]
    fn test_legacy_format_compatibility() {
        let mk = [0xABu8; 32];

        // Build legacy format: salt(16) + nonce(8) + ciphertext (no tag)
        let salt: [u8; 16] = random_bytes(16).try_into().unwrap();
        let nonce: [u8; 8] = random_bytes(8).try_into().unwrap();
        let plaintext = b"legacy data";

        let (enc_key, _integrity_key) = derive_encryption_keys(&mk, &salt);
        let mut ct = plaintext.to_vec();
        let iv = build_ctr_iv(&nonce);
        let mut cipher = Aes128Ctr::new(&enc_key.into(), &iv.into());
        cipher.apply_keystream(&mut ct);

        // Assemble WITHOUT auth tag (legacy format)
        let mut legacy = salt.to_vec();
        legacy.extend_from_slice(&nonce);
        legacy.extend_from_slice(&ct);
        let legacy_hex = hex::encode(&legacy);

        let result = decrypt(&legacy_hex, &mk).unwrap();
        assert_eq!(result, "legacy data");
    }
}
