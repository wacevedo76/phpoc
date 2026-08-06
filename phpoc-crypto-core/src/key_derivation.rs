//! Key derivation — PBKDF2 passphrase-to-PDK, Master Key from seed, sub-key derivation.
//!
//! Implements PHPSPEC §2 (Key Derivation & Identity):
//! - `derive_pdk()`: PBKDF2-HMAC-SHA256(passphrase, "session-salt", 600K, 32)
//! - `derive_master_key()`: base64-decode the seed (PHPSPEC §2.3)
//! - `derive_sub_key()`: HMAC-SHA256(master_key, salt) truncated (PHPSPEC §2.6)

use ring::pbkdf2;
use ring::hmac;

use crate::{Result, CryptoError, PDK_SALT, PBKDF2_ITERATIONS, PBKDF2_ITERATIONS_LEGACY};

/// Number of PBKDF2 iterations to use.
///
/// - Default: 600,000 (OWASP 2026 recommendation)
/// - Legacy: 100,000 (for genesis blocks created before commit e25a26c, 2026-04-28)
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PdkIterations {
    Standard,
    Legacy,
}

impl PdkIterations {
    pub fn value(&self) -> u32 {
        match self {
            PdkIterations::Standard => PBKDF2_ITERATIONS,
            PdkIterations::Legacy => PBKDF2_ITERATIONS_LEGACY,
        }
    }
}

/// Derive a Passphrase-Derived Key (PDK) from a user passphrase.
///
/// Per PHPSPEC §2.4:
/// `PDK = PBKDF2-HMAC-SHA256(passphrase, "session-salt", 600000, 32)`
///
/// # Arguments
/// * `passphrase` - The user's passphrase.
/// * `iterations` - Iteration count (Standard=600K, Legacy=100K for pre-R3 genesis).
///
/// # Returns
/// A 32-byte PDK used to encrypt/decrypt the recovery seed.
pub fn derive_pdk(passphrase: &str, iterations: PdkIterations) -> [u8; 32] {
    let mut key = [0u8; 32];
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        std::num::NonZeroU32::new(iterations.value()).unwrap(),
        PDK_SALT,
        passphrase.as_bytes(),
        &mut key,
    );
    key
}

/// Derive the Master Key from a recovery seed.
///
/// Per PHPSPEC §2.3:
/// The Master Key is simply the raw bytes of the base64-decoded seed.
/// `master_key = base64_decode(seed)` — 32 bytes.
///
/// # Arguments
/// * `seed` - Base64-encoded 32-byte recovery seed (44 characters with padding).
///
/// # Returns
/// 32-byte Master Key.
///
/// Handles both standard 32-byte base64 seeds and Flutter-style seeds
/// which may have spurious trailing padding or be 33 bytes with a leading
/// 0x00 byte (the extra byte is stripped automatically).
pub fn derive_master_key(seed: &str) -> Result<[u8; 32]> {
    use base64::Engine;

    // Try STANDARD first (handles proper = padding)
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(seed)
        .or_else(|_| {
            // Retry without padding using URL_SAFE_NO_PAD
            let cleaned = seed.trim_end_matches('=');
            base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(cleaned)
        })
        .map_err(|e| CryptoError::InvalidBase64(e.to_string()))?;

    // Handle 33-byte seeds: strip leading 0x00 (Flutter MK serialization quirk)
    let decoded = if decoded.len() == 33 && decoded[0] == 0x00 {
        &decoded[1..]
    } else {
        &decoded[..]
    };

    if decoded.len() != 32 {
        return Err(CryptoError::InvalidKeyLength);
    }

    let mut key = [0u8; 32];
    key.copy_from_slice(decoded);
    Ok(key)
}

/// Derive a sub-key from the Master Key via HMAC-SHA256.
///
/// Per PHPSPEC §2.6:
/// `sub_key = HMAC-SHA256(master_key, salt)[:length]`
///
/// # Arguments
/// * `master_key` - 32-byte Master Key.
/// * `salt` - Per-operation random salt or fixed salt for domain separation.
/// * `length` - Desired output length in bytes (typically 16 or 32).
///
/// # Returns
/// Derived sub-key of the requested length.
pub fn derive_sub_key(master_key: &[u8; 32], salt: &[u8], length: usize) -> Vec<u8> {
    let signing_key = hmac::Key::new(hmac::HMAC_SHA256, master_key);
    let signature = hmac::sign(&signing_key, salt);
    signature.as_ref()[..length.min(signature.as_ref().len())].to_vec()
}

/// Derive a fixed-length sub-key as a 16-byte array.
///
/// Convenience wrapper for encryption sub-keys (AES-128 needs 16 bytes).
pub fn derive_sub_key_16(master_key: &[u8; 32], salt: &[u8]) -> [u8; 16] {
    let derived = derive_sub_key(master_key, salt, 16);
    let mut key = [0u8; 16];
    key.copy_from_slice(&derived);
    key
}

/// Derive a fixed-length sub-key as a 32-byte array.
///
/// Convenience wrapper for HMAC integrity keys (32 bytes).
pub fn derive_sub_key_32(master_key: &[u8; 32], salt: &[u8]) -> [u8; 32] {
    let derived = derive_sub_key(master_key, salt, 32);
    let mut key = [0u8; 32];
    key.copy_from_slice(&derived);
    key
}

/// Derive an encryption sub-key with a domain-separated integrity key salt.
///
/// Per PHPSPEC §3.3:
/// - Encryption key: `HMAC(MK, salt)[:16]`
/// - Integrity key: `HMAC(MK, salt || "-integrity")`
///
/// # Arguments
/// * `master_key` - 32-byte Master Key.
/// * `salt` - 16-byte random salt for key diversification.
///
/// # Returns
/// `(enc_key_16, integrity_key_32)` — the encryption and integrity sub-keys.
pub fn derive_encryption_keys(
    master_key: &[u8; 32],
    salt: &[u8; 16],
) -> ([u8; 16], [u8; 32]) {
    let enc_key = derive_sub_key_16(master_key, salt);

    // Integrity key uses salt + domain separator
    let mut integrity_salt = salt.to_vec();
    integrity_salt.extend_from_slice(crate::INTEGRITY_DOMAIN_SEPARATOR);
    let integrity_key = derive_sub_key_32(master_key, &integrity_salt);

    (enc_key, integrity_key)
}

/// Derive the blob obfuscation sub-key.
///
/// Per remote_sync.py:
/// `blob_key = HMAC-SHA256(MK, "blob-obfuscation")[:16]`
pub fn derive_blob_key(master_key: &[u8; 32]) -> [u8; 16] {
    derive_sub_key_16(master_key, crate::BLOB_SUBKEY_PREFIX)
}

/// Derive the sealing sub-key for block seals.
///
/// Per PHPSPEC §5.2:
/// `seal_key = HMAC-SHA256(MK, "integrity-key-salt")`
pub fn derive_seal_key(master_key: &[u8; 32]) -> [u8; 32] {
    derive_sub_key_32(master_key, crate::SEAL_KEY_SALT)
}

/// Derive a PDK with a custom salt (per-user salt support).
///
/// Per PHPSPEC §2.4 (updated):
/// `salt = SHA-256(hex_pub_key_bytes)[:16]`
/// `PDK = PBKDF2-HMAC-SHA256(passphrase, salt, 600000, 32)`
///
/// # Arguments
/// * `passphrase` - The user's passphrase.
/// * `salt` - 16-byte per-user salt (SHA-256(identity_pub_key_hex)[:16]).
/// * `iterations` - Iteration count (Standard=600K, Legacy=100K).
///
/// # Returns
/// A 32-byte PDK.
pub fn derive_pdk_with_salt(
    passphrase: &str,
    salt: &[u8; 16],
    iterations: PdkIterations,
) -> [u8; 32] {
    let mut key = [0u8; 32];
    pbkdf2::derive(
        pbkdf2::PBKDF2_HMAC_SHA256,
        std::num::NonZeroU32::new(iterations.value()).unwrap(),
        salt.as_slice(),
        passphrase.as_bytes(),
        &mut key,
    );
    key
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_derive_pdk_standard() {
        let pdk = derive_pdk("test-passphrase", PdkIterations::Standard);
        assert_eq!(pdk.len(), 32);
        // PDK should be deterministic
        let pdk2 = derive_pdk("test-passphrase", PdkIterations::Standard);
        assert_eq!(pdk, pdk2);
    }

    #[test]
    fn test_derive_pdk_different_passphrases() {
        let pdk1 = derive_pdk("passphrase-a", PdkIterations::Standard);
        let pdk2 = derive_pdk("passphrase-b", PdkIterations::Standard);
        assert_ne!(pdk1, pdk2);
    }

    #[test]
    fn test_derive_pdk_legacy_vs_standard() {
        let standard = derive_pdk("test", PdkIterations::Standard);
        let legacy = derive_pdk("test", PdkIterations::Legacy);
        // Different iteration counts produce different keys
        assert_ne!(standard, legacy);
    }

    // ═════════════════════════════════════════════════════════════════
    // Group F: Per-User PBKDF2 Salt — RED tests (I-05 Phase 2)
    // ═════════════════════════════════════════════════════════════════

    const PER_USER_SALT: &[u8; 16] = b"0123456789abcdef";

    #[test]
    fn test_F1_derive_pdk_with_custom_salt() {
        // F1: derive_pdk_with_salt(passphrase, salt, iterations) accepts custom salt.
        let pdk = derive_pdk_with_salt("test-passphrase", PER_USER_SALT, PdkIterations::Standard);
        assert_eq!(pdk.len(), 32);
    }

    #[test]
    fn test_F2_same_passphrase_and_salt_deterministic() {
        // F2: Same passphrase + same salt → deterministic PDK.
        let pdk1 = derive_pdk_with_salt("secure-pass", PER_USER_SALT, PdkIterations::Standard);
        let pdk2 = derive_pdk_with_salt("secure-pass", PER_USER_SALT, PdkIterations::Standard);
        assert_eq!(pdk1, pdk2);
    }

    #[test]
    fn test_F3_same_passphrase_different_salt_different_pdk() {
        // F3: Same passphrase + different salt → different PDK.
        let other_salt: &[u8; 16] = b"fedcba9876543210";
        let pdk1 = derive_pdk_with_salt("secure-pass", PER_USER_SALT, PdkIterations::Standard);
        let pdk2 = derive_pdk_with_salt("secure-pass", other_salt, PdkIterations::Standard);
        assert_ne!(pdk1, pdk2);
    }

    #[test]
    fn test_F4_old_salt_session_salt_backward_compat() {
        // F4: Old derive_pdk (no salt param) still works for backward compat.
        // The old function uses the 12-byte PDK_SALT; the new function takes
        // 16-byte per-user salts. Both are valid; old callers keep working.
        let pdk_old = derive_pdk("test", PdkIterations::Standard);
        assert_eq!(pdk_old.len(), 32);

        // Verify deterministic: same function, same inputs → same output
        let pdk_old2 = derive_pdk("test", PdkIterations::Standard);
        assert_eq!(pdk_old, pdk_old2);

        // Per-user salt must produce different PDK than old fixed salt
        let pdk_new = derive_pdk_with_salt("test", PER_USER_SALT, PdkIterations::Standard);
        assert_ne!(pdk_old, pdk_new,
            "Per-user salt PDK must differ from old fixed-salt PDK");
    }

    #[test]
    fn test_F5_legacy_iterations_with_custom_salt() {
        // F5: Legacy iterations (100K) still work with custom salt.
        let pdk = derive_pdk_with_salt("test", PER_USER_SALT, PdkIterations::Legacy);
        assert_eq!(pdk.len(), 32);
    }

    // F6 is tested via WASM bindings in the web test suite (pbkdf2_salt_test.mjs).
    // The WASM binding derive_pdk(passphrase, salt_hex, iterations) is the
    // target API that JS/TS callers will use.

    // ═════════════════════════════════════════════════════════════════

    #[test]
    fn test_derive_master_key() {
        // 32 bytes base64-encoded = 44 chars with padding
        let seed = "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=";
        let mk = derive_master_key(seed).unwrap();
        assert_eq!(mk.len(), 32);
        // All bytes should be 0x42
        assert!(mk.iter().all(|&b| b == 0x42));
    }

    #[test]
    fn test_derive_master_key_invalid_seed() {
        assert!(derive_master_key("too-short").is_err());
    }

    #[test]
    fn test_derive_sub_key_different_salts() {
        let mk = [0xABu8; 32];
        let salt1 = b"salt-one";
        let salt2 = b"salt-two";
        let k1 = derive_sub_key(&mk, salt1, 16);
        let k2 = derive_sub_key(&mk, salt2, 16);
        assert_ne!(k1, k2);
    }

    #[test]
    fn test_derive_encryption_keys() {
        let mk = [0xABu8; 32];
        let salt = [0x01u8; 16];
        let (enc_key, int_key) = derive_encryption_keys(&mk, &salt);
        assert_eq!(enc_key.len(), 16);
        assert_eq!(int_key.len(), 32);
        // Encryption and integrity keys must be different
        assert_ne!(&enc_key[..], &int_key[..16]);
    }

    #[test]
    fn test_derive_blob_key() {
        let mk = [0xABu8; 32];
        let bk = derive_blob_key(&mk);
        assert_eq!(bk.len(), 16);
        // Deterministic
        assert_eq!(bk, derive_blob_key(&mk));
    }

    #[test]
    fn test_derive_seal_key() {
        let mk = [0xABu8; 32];
        let sk = derive_seal_key(&mk);
        assert_eq!(sk.len(), 32);
        // Deterministic
        assert_eq!(sk, derive_seal_key(&mk));
    }
}
