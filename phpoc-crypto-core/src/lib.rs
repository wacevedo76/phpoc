//! # phpoc-crypto-core
//!
//! Portable cryptography library for the Personal History Protocol (PHPOC).
//!
//! Implements all cryptographic primitives specified in PHPSPEC.md:
//! - PBKDF2-HMAC-SHA256 passphrase derivation
//! - AES-128-CTR encrypt/decrypt with encrypt-then-MAC auth tags
//! - HMAC-SHA256 sealing, signing, sub-key derivation
//! - SHA-256 hashing
//! - Blob obfuscation (tiered padding + encryption)
//! - Device identity HMAC proofs
//!
//! Compiled to WASM (web), .a (iOS), and .so (Android).

pub mod aes_ctr;
pub mod key_derivation;
pub mod hmac_utils;
pub mod digest;
pub mod random;
pub mod blob;
pub mod device;

/// WASM bindings — only compiled when targeting WebAssembly.
#[cfg(feature = "wasm")]
/// flutter_rust_bridge generated code — AUTO INJECTED BY flutter_rust_bridge.
pub mod frb_generated;

/// WASM bindings — only compiled when targeting WebAssembly.
#[cfg(feature = "wasm")]
pub mod wasm;

/// Result type alias for crate operations.
pub type Result<T> = std::result::Result<T, CryptoError>;

/// Error types for crypto operations.
#[derive(Debug, Clone)]
pub enum CryptoError {
    InvalidKeyLength,
    DecryptionFailed(String),
    AuthTagMismatch,
    InvalidHexData(String),
    InvalidBase64(String),
    BlobTooLarge { size: usize, max: usize },
    BlobDeobfuscationFailed(String),
    SealingKeyMissing,
}

impl std::fmt::Display for CryptoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CryptoError::InvalidKeyLength => write!(f, "key must be 32 bytes"),
            CryptoError::DecryptionFailed(msg) => write!(f, "decryption failed: {}", msg),
            CryptoError::AuthTagMismatch => write!(f, "auth tag mismatch: ciphertext tampered"),
            CryptoError::InvalidHexData(msg) => write!(f, "invalid hex data: {}", msg),
            CryptoError::InvalidBase64(msg) => write!(f, "invalid base64: {}", msg),
            CryptoError::BlobTooLarge { size, max } => {
                write!(f, "blob size {} exceeds max tier {} (512K)", size, max)
            }
            CryptoError::BlobDeobfuscationFailed(msg) => {
                write!(f, "blob deobfuscation failed: {}", msg)
            }
            CryptoError::SealingKeyMissing => write!(f, "cannot seal: no master key provided"),
        }
    }
}

impl std::error::Error for CryptoError {}

/// Obfuscation tier sizes in bytes (matching PHPSPEC §8.5 and remote_sync.py).
pub const TIER_64K: usize = 64 * 1024;
pub const TIER_128K: usize = 128 * 1024;
pub const TIER_256K: usize = 256 * 1024;
pub const TIER_512K: usize = 512 * 1024;

/// All blob obfuscation tiers, ascending.
pub const BLOB_TIERS: [usize; 4] = [TIER_64K, TIER_128K, TIER_256K, TIER_512K];

/// Salt for PDK derivation (matching PHPSPEC §2.4).
pub const PDK_SALT: &[u8] = b"session-salt";

/// Salt for block sealing sub-key (matching PHPSPEC §5.2).
pub const SEAL_KEY_SALT: &[u8] = b"integrity-key-salt";

/// Prefix for blob obfuscation sub-key (matching remote_sync.py).
pub const BLOB_SUBKEY_PREFIX: &[u8] = b"blob-obfuscation";

/// Domain separator for integrity sub-key derivation (matching PHPSPEC §3.3).
pub const INTEGRITY_DOMAIN_SEPARATOR: &[u8] = b"-integrity";

/// Device proof prefix (matching device_identity.py).
pub const DEVICE_PROOF_PREFIX: &[u8] = b"phpoc:device:";

/// Default PBKDF2 iterations (OWASP 2026 recommendation).
pub const PBKDF2_ITERATIONS: u32 = 600_000;

/// Legacy PBKDF2 iterations for pre-R3 genesis blocks (100K fallback).
pub const PBKDF2_ITERATIONS_LEGACY: u32 = 100_000;
