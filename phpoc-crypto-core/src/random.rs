//! Secure random byte generation.
//!
//! Wraps ring::rand for cryptographically secure random bytes.
//! Supports WASM via the `getrandom` feature.

use ring::rand::{SecureRandom, SystemRandom};

/// Generate `len` cryptographically secure random bytes.
///
/// Uses `ring::rand::SystemRandom` which sources from:
/// - Linux: `getrandom()` syscall
/// - macOS/iOS: `SecRandomCopyBytes`
/// - WebAssembly: `getrandom` crate (seeds from `crypto.getRandomValues`)
/// - Windows: `BCryptGenRandom`
///
/// # Arguments
/// * `len` - Number of random bytes to generate.
///
/// # Returns
/// A `Vec<u8>` containing `len` random bytes.
///
/// # Panics
/// Panics if the system random number generator fails (extremely rare).
pub fn random_bytes(len: usize) -> Vec<u8> {
    let rng = SystemRandom::new();
    let mut bytes = vec![0u8; len];
    rng.fill(&mut bytes)
        .expect("system random number generator failed");
    bytes
}

/// Generate a 32-byte (256-bit) random seed, base64-encoded.
///
/// Per PHPSPEC §2.2:
/// 32 random bytes → base64 encoded → 44-character seed string.
///
/// # Returns
/// Base64-encoded 44-character seed string (with padding).
pub fn generate_seed() -> String {
    use base64::Engine;
    let bytes = random_bytes(32);
    base64::engine::general_purpose::STANDARD.encode(&bytes)
}

/// Generate a random UUID v4 string.
///
/// Returns a standard format UUID: `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`
pub fn generate_uuid_v4() -> String {
    let bytes = random_bytes(16);

    // Set version (4) and variant bits per RFC 4122
    let mut uuid_bytes = [0u8; 16];
    uuid_bytes.copy_from_slice(&bytes);
    uuid_bytes[6] = (uuid_bytes[6] & 0x0f) | 0x40; // version 4
    uuid_bytes[8] = (uuid_bytes[8] & 0x3f) | 0x80; // variant

    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        uuid_bytes[0], uuid_bytes[1], uuid_bytes[2], uuid_bytes[3],
        uuid_bytes[4], uuid_bytes[5],
        uuid_bytes[6], uuid_bytes[7],
        uuid_bytes[8], uuid_bytes[9],
        uuid_bytes[10], uuid_bytes[11], uuid_bytes[12], uuid_bytes[13], uuid_bytes[14], uuid_bytes[15],
    )
}

/// Generate a random device specifier (32-char hex).
///
/// Used for device cookies per SESSION_HANDFF.md cookie format.
pub fn generate_device_specifier() -> String {
    let bytes = random_bytes(16);
    hex::encode(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_random_bytes_length() {
        assert_eq!(random_bytes(0).len(), 0);
        assert_eq!(random_bytes(16).len(), 16);
        assert_eq!(random_bytes(32).len(), 32);
    }

    #[test]
    fn test_random_bytes_different_each_time() {
        let a = random_bytes(32);
        let b = random_bytes(32);
        assert_ne!(a, b);
    }

    #[test]
    fn test_generate_seed() {
        let seed = generate_seed();
        assert_eq!(seed.len(), 44); // 32 bytes base64 = 44 chars with padding
        // Should be valid base64
        use base64::Engine;
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&seed)
            .unwrap();
        assert_eq!(decoded.len(), 32);
    }

    #[test]
    fn test_generate_seed_different_each_time() {
        assert_ne!(generate_seed(), generate_seed());
    }

    #[test]
    fn test_generate_uuid_v4_format() {
        let uuid = generate_uuid_v4();
        // Format: 8-4-4-4-12 = 36 chars
        assert_eq!(uuid.len(), 36);
        assert_eq!(uuid.chars().filter(|&c| c == '-').count(), 4);
        // Version nibble should be '4'
        assert_eq!(&uuid[14..15], "4");
        // Variant nibble should be 8, 9, a, or b
        let variant = &uuid[19..20];
        assert!(
            variant == "8" || variant == "9" || variant == "a" || variant == "b"
        );
    }

    #[test]
    fn test_generate_device_specifier() {
        let spec = generate_device_specifier();
        assert_eq!(spec.len(), 32); // 16 bytes hex = 32 chars
        assert_ne!(spec, generate_device_specifier());
    }
}
