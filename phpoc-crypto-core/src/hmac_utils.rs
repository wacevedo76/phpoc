//! HMAC-SHA256 utilities — sealing, signing, signature verification.
//!
//! Implements parts of PHPSPEC §5 (Chain Validation):
//! - `seal()`: HMAC-SHA256 block seal (PHPSPEC §5.2)
//! - `verify_seal()`: Verify block seal
//! - `sign()`: Identity signature (PHPSPEC §5.3)
//! - `verify_signature()`: Verify identity signature

use ring::hmac;

use crate::key_derivation::derive_seal_key;

/// Compute an HMAC-SHA256 seal over data using the Master Key.
///
/// Per PHPSPEC §5.2:
/// `seal_key = HMAC-SHA256(MK, "integrity-key-salt")`
/// `seal = HMAC-SHA256(seal_key, data)`
///
/// # Arguments
/// * `data` - The data string to seal (typically canonical JSON).
/// * `master_key` - 32-byte Master Key.
///
/// # Returns
/// Hex-encoded 64-character HMAC-SHA256 seal.
pub fn seal(data: &str, master_key: &[u8; 32]) -> String {
    let seal_key = derive_seal_key(master_key);
    let signing_key = hmac::Key::new(hmac::HMAC_SHA256, &seal_key);
    let signature = hmac::sign(&signing_key, data.as_bytes());
    hex::encode(signature.as_ref())
}

/// Verify an HMAC-SHA256 seal against data.
///
/// # Arguments
/// * `data` - The original data string.
/// * `expected_seal` - The hex-encoded seal to verify against.
/// * `master_key` - 32-byte Master Key.
///
/// # Returns
/// `true` if the seal matches, `false` otherwise.
pub fn verify_seal(data: &str, expected_seal: &str, master_key: &[u8; 32]) -> bool {
    // Constant-time comparison via ring's hmac
    let expected_bytes = match hex::decode(expected_seal) {
        Ok(b) => b,
        Err(_) => return false,
    };
    hmac::verify(
        &hmac::Key::new(hmac::HMAC_SHA256, &derive_seal_key(master_key)),
        data.as_bytes(),
        &expected_bytes,
    )
    .is_ok()
}

/// Sign data using the identity secret.
///
/// Per PHPSPEC §2.7.1:
/// `signature = HMAC-SHA256(identity_secret, data)`
///
/// This is an HMAC-based proxy for Ed25519 to remain zero-dependency.
///
/// # Arguments
/// * `data` - The data string to sign (typically a block hash).
/// * `identity_secret` - 32-byte identity secret.
///
/// # Returns
/// Hex-encoded 64-character HMAC-SHA256 signature.
pub fn sign(data: &str, identity_secret: &[u8; 32]) -> String {
    let signing_key = hmac::Key::new(hmac::HMAC_SHA256, identity_secret);
    let signature = hmac::sign(&signing_key, data.as_bytes());
    hex::encode(signature.as_ref())
}

/// Verify an HMAC-SHA256 identity signature.
///
/// # Arguments
/// * `data` - The original data string.
/// * `signature` - The hex-encoded signature to verify.
/// * `identity_secret` - 32-byte identity secret.
///
/// # Returns
/// `true` if the signature matches, `false` otherwise.
pub fn verify_signature(data: &str, signature: &str, identity_secret: &[u8; 32]) -> bool {
    let sig_bytes = match hex::decode(signature) {
        Ok(b) => b,
        Err(_) => return false,
    };
    hmac::verify(
        &hmac::Key::new(hmac::HMAC_SHA256, identity_secret),
        data.as_bytes(),
        &sig_bytes,
    )
    .is_ok()
}

/// Compute a generic HMAC-SHA256 with an arbitrary key.
///
/// Useful for device proof computation and other HMAC operations
/// that don't use the sealing or identity key derivation paths.
///
/// # Arguments
/// * `key` - Any byte slice to use as HMAC key.
/// * `data` - The data to authenticate.
///
/// # Returns
/// Hex-encoded HMAC-SHA256 (64 hex chars).
pub fn hmac_hex(key: &[u8], data: &[u8]) -> String {
    let signing_key = hmac::Key::new(hmac::HMAC_SHA256, key);
    let signature = hmac::sign(&signing_key, data);
    hex::encode(signature.as_ref())
}

/// Compute a generic HMAC-SHA256 returning raw bytes.
pub fn hmac_raw(key: &[u8], data: &[u8]) -> Vec<u8> {
    let signing_key = hmac::Key::new(hmac::HMAC_SHA256, key);
    let signature = hmac::sign(&signing_key, data);
    signature.as_ref().to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_seal_deterministic() {
        let mk = [0xABu8; 32];
        let data = r#"{"type":"genesis","date":"2026-01-01"}"#;

        let s1 = seal(data, &mk);
        let s2 = seal(data, &mk);

        assert_eq!(s1, s2);
        assert_eq!(s1.len(), 64); // SHA-256 hex = 64 chars
    }

    #[test]
    fn test_seal_different_data_different_seal() {
        let mk = [0xABu8; 32];
        let s1 = seal("data-a", &mk);
        let s2 = seal("data-b", &mk);
        assert_ne!(s1, s2);
    }

    #[test]
    fn test_seal_different_key_different_seal() {
        let mk1 = [0xABu8; 32];
        let mk2 = [0xCDu8; 32];
        let data = "same data";
        assert_ne!(seal(data, &mk1), seal(data, &mk2));
    }

    #[test]
    fn test_verify_seal_valid() {
        let mk = [0xABu8; 32];
        let data = r#"{"entries":[],"type":"day"}"#;
        let s = seal(data, &mk);
        assert!(verify_seal(data, &s, &mk));
    }

    #[test]
    fn test_verify_seal_invalid() {
        let mk = [0xABu8; 32];
        let data = "real data";
        let s = seal(data, &mk);
        assert!(!verify_seal("tampered data", &s, &mk));
    }

    #[test]
    fn test_verify_seal_wrong_key() {
        let mk1 = [0xABu8; 32];
        let mk2 = [0xCDu8; 32];
        let data = "test data";
        let s = seal(data, &mk1);
        assert!(!verify_seal(data, &s, &mk2));
    }

    #[test]
    fn test_sign_and_verify() {
        let identity = [0xDEu8; 32];
        let data = "block_hash_here";

        let sig = sign(data, &identity);
        assert_eq!(sig.len(), 64);

        assert!(verify_signature(data, &sig, &identity));
    }

    #[test]
    fn test_sign_different_data_fails() {
        let identity = [0xDEu8; 32];
        let sig = sign("real data", &identity);
        assert!(!verify_signature("fake data", &sig, &identity));
    }

    #[test]
    fn test_hmac_hex() {
        let key = b"test-key";
        let data = b"test-data";
        let h1 = hmac_hex(key, data);
        let h2 = hmac_hex(key, data);
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64);
    }

    #[test]
    fn test_hmac_raw_length() {
        let result = hmac_raw(b"key", b"data");
        assert_eq!(result.len(), 32);
    }
}
