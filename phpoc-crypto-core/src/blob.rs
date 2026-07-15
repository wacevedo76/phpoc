//! Blob obfuscation — tiered padding + AES-CTR encryption for remote staging.
//!
//! Implements PHPSPEC §8.5 and remote_sync.py:
//! - Pad serialized JSON to next tier ceiling with random bytes
//! - Encrypt using blob sub-key derived from Master Key
//! - On pull: decrypt, strip padding by reading original-size prefix
//!
//! Wire format: salt(16) + nonce(8) + original_len(4) + padded_data + tag(32)

use aes::cipher::{KeyIvInit, StreamCipher};
use ctr::Ctr64BE;
use ring::hmac;

use crate::key_derivation::derive_blob_key;
use crate::random::random_bytes;
use crate::{CryptoError, Result, BLOB_TIERS, INTEGRITY_DOMAIN_SEPARATOR, TIER_512K};

/// AES-128-CTR cipher type for blob encryption.
type Aes128Ctr = Ctr64BE<aes::Aes128>;

/// Select the smallest obfuscation tier that fits `plaintext_size`.
///
/// Returns tier size in bytes (65536, 131072, 262144, or 524288).
///
/// # Errors
/// Returns `CryptoError::BlobTooLarge` if the blob exceeds 512K.
pub fn select_tier(plaintext_size: usize) -> Result<usize> {
    for tier in &BLOB_TIERS {
        if plaintext_size <= *tier {
            return Ok(*tier);
        }
    }
    Err(CryptoError::BlobTooLarge {
        size: plaintext_size,
        max: TIER_512K,
    })
}

// -- Shared helpers for both obfuscation paths ---------------------------------

/// Derive encryption and integrity keys from blob key + salt.
///
/// Per `remote_sync.py` `_derive_blob_encryption_keys()`:
///   - `enc_key = HMAC-SHA256(blob_key, salt)[:16]`
///   - `integrity_key = HMAC-SHA256(blob_key, salt || "-integrity")[:16]`
fn derive_blob_encryption_keys(blob_key: &[u8; 16], salt: &[u8; 16]) -> ([u8; 16], [u8; 16]) {
    let enc_key = {
        let bk = hmac::Key::new(hmac::HMAC_SHA256, blob_key);
        let sig = hmac::sign(&bk, salt);
        let bytes = sig.as_ref();
        let mut k = [0u8; 16];
        k.copy_from_slice(&bytes[..16]);
        k
    };
    let integrity_key = {
        let mut int_salt = salt.to_vec();
        int_salt.extend_from_slice(INTEGRITY_DOMAIN_SEPARATOR);
        let bk = hmac::Key::new(hmac::HMAC_SHA256, blob_key);
        let sig = hmac::sign(&bk, &int_salt);
        let bytes = sig.as_ref();
        let mut k = [0u8; 16];
        k.copy_from_slice(&bytes[..16]);
        k
    };
    (enc_key, integrity_key)
}

/// AES-CTR encrypt payload and append an HMAC-SHA256 auth tag.
fn encrypt_and_tag(
    mut payload: Vec<u8>,
    enc_key: &[u8; 16],
    integrity_key: &[u8; 16],
    nonce: &[u8; 8],
) -> Vec<u8> {
    let iv = build_blob_iv(nonce);
    let mut cipher = Aes128Ctr::new(enc_key.into(), &iv.into());
    cipher.apply_keystream(&mut payload);

    let mut auth_data = nonce.to_vec();
    auth_data.extend_from_slice(&payload);
    let signing_key = hmac::Key::new(hmac::HMAC_SHA256, integrity_key);
    let signature = hmac::sign(&signing_key, &auth_data);

    payload.extend_from_slice(signature.as_ref());
    payload
}

/// Core obfuscation: pad to tier, encrypt with explicit salt/nonce.
///
/// This is the shared engine behind `obfuscate_blob()` (random salt/nonce)
/// and `obfuscate_blob_deterministic()` (explicit salt/nonce + zero-fill).
/// Callers supply padding bytes and salt/nonce.
fn obfuscate_blob_core(
    plaintext: &[u8],
    master_key: &[u8; 32],
    padding_bytes: &[u8],
    salt: &[u8; 16],
    nonce: &[u8; 8],
) -> Result<Vec<u8>> {
    let tier = select_tier(plaintext.len())?;
    let padded_size = tier - 4; // Reserve 4 bytes for original length

    // Build: original_len(4) + plaintext + padding
    let mut payload = Vec::with_capacity(padded_size + 4);
    payload.extend_from_slice(&(plaintext.len() as u32).to_be_bytes());
    payload.extend_from_slice(plaintext);
    if !padding_bytes.is_empty() {
        payload.extend_from_slice(padding_bytes);
    }

    let blob_key = derive_blob_key(master_key);
    let (enc_key, integrity_key) = derive_blob_encryption_keys(&blob_key, salt);
    let ciphertext_and_tag = encrypt_and_tag(payload, &enc_key, &integrity_key, nonce);

    // Assemble: salt(16) + nonce(8) + ciphertext + tag(32)
    let mut output = salt.to_vec();
    output.extend_from_slice(nonce);
    output.extend_from_slice(&ciphertext_and_tag);
    Ok(output)
}

/// Obfuscate a staging blob for remote transport.
///
/// Per remote_sync.py `_obfuscate()`:
/// 1. Select tier (64K, 128K, 256K, 512K) based on plaintext size
/// 2. Pad to `tier - 4` bytes (reserving space for original length prefix)
/// 3. Prepend original length as big-endian u32
/// 4. Encrypt with blob sub-key: `HMAC(MK, "blob-obfuscation")[:16]`
/// 5. Encrypt-then-MAC auth tag
///
/// Output format:
/// `salt(16) + nonce(8) + ciphertext(N+4) + tag(32)`
///
/// # Arguments
/// * `plaintext` - Serialized blob bytes.
/// * `master_key` - 32-byte Master Key.
///
/// # Returns
/// Obfuscated bytes ready for transport.
pub fn obfuscate_blob(plaintext: &[u8], master_key: &[u8; 32]) -> Result<Vec<u8>> {
    let tier = select_tier(plaintext.len())?;
    let padded_size = tier - 4;
    let padding_needed = padded_size.saturating_sub(plaintext.len());
    let padding = if padding_needed > 0 {
        random_bytes(padding_needed)
    } else {
        Vec::new()
    };
    let salt: [u8; 16] = random_bytes(16).try_into().expect("16 bytes");
    let nonce: [u8; 8] = random_bytes(8).try_into().expect("8 bytes");
    obfuscate_blob_core(plaintext, master_key, &padding, &salt, &nonce)
}

/// Deobfuscate a staging blob after pulling from remote.
///
/// Per remote_sync.py `_deobfuscate()`:
/// 1. Parse: salt(16) + nonce(8) + ciphertext + tag(32)
/// 2. Verify auth tag
/// 3. Decrypt
/// 4. Read original length from first 4 bytes
/// 5. Return original plaintext bytes
///
/// # Arguments
/// * `obfuscated` - Raw obfuscated bytes from transport.
/// * `master_key` - 32-byte Master Key.
///
/// # Returns
/// Original plaintext bytes, or `None` if deobfuscation fails.
pub fn deobfuscate_blob(obfuscated: &[u8], master_key: &[u8; 32]) -> Option<Vec<u8>> {
    if obfuscated.len() < 56 {
        return None;
    }

    let salt: [u8; 16] = obfuscated[..16].try_into().ok()?;
    let nonce: [u8; 8] = obfuscated[16..24].try_into().ok()?;
    let ciphertext = &obfuscated[24..obfuscated.len() - 32];
    let stored_tag = &obfuscated[obfuscated.len() - 32..];

    let blob_key = derive_blob_key(master_key);
    let (enc_key, integrity_key) = derive_blob_encryption_keys(&blob_key, &salt);

    // Verify auth tag
    {
        let mut auth_data = nonce.to_vec();
        auth_data.extend_from_slice(ciphertext);
        let signing_key = hmac::Key::new(hmac::HMAC_SHA256, &integrity_key);
        if hmac::verify(&signing_key, &auth_data, stored_tag).is_err() {
            return None;
        }
    }

    // Decrypt
    let mut decrypted = ciphertext.to_vec();
    let iv = build_blob_iv(&nonce);
    let mut cipher = Aes128Ctr::new(&enc_key.into(), &iv.into());
    cipher.apply_keystream(&mut decrypted);

    // Read original length (first 4 bytes, big-endian u32)
    if decrypted.len() < 4 {
        return None;
    }
    let original_len = u32::from_be_bytes([
        decrypted[0],
        decrypted[1],
        decrypted[2],
        decrypted[3],
    ]) as usize;

    if 4 + original_len > decrypted.len() {
        return None;
    }

    Some(decrypted[4..4 + original_len].to_vec())
}

/// Obfuscate a staging blob with explicit salt, nonce, and deterministic padding.
///
/// Produces byte-identical output across implementations when called with the
/// same (plaintext, master_key, salt, nonce). Uses zero-fill padding instead
/// of random bytes for reproducibility.
///
/// Used for cross-platform test vector validation. Production code should
/// use `obfuscate_blob()` which uses random salt/nonce/padding.
///
/// # Arguments
/// * `plaintext` - Serialized blob bytes.
/// * `master_key` - 32-byte Master Key.
/// * `salt` - 16-byte explicit salt (bypasses random_bytes).
/// * `nonce` - 8-byte explicit nonce (bypasses random_bytes).
///
/// # Returns
/// Obfuscated bytes: salt(16) + nonce(8) + ciphertext + tag(32).
pub fn obfuscate_blob_deterministic(
    plaintext: &[u8],
    master_key: &[u8; 32],
    salt: &[u8; 16],
    nonce: &[u8; 8],
) -> Result<Vec<u8>> {
    let tier = select_tier(plaintext.len())?;
    let padded_size = tier - 4;
    let padding_needed = padded_size.saturating_sub(plaintext.len());
    let padding: Vec<u8> = std::iter::repeat(0u8).take(padding_needed).collect();
    obfuscate_blob_core(plaintext, master_key, &padding, salt, nonce)
}

/// Build a 16-byte CTR IV from an 8-byte nonce (zero-extended).
///
/// AES-CTR requires a 16-byte initialization vector. We use an 8-byte
/// random nonce padded with 8 zero bytes, matching remote_sync.py's
/// `PureAESCTR` which passes the 8-byte nonce directly to pyaes.
fn build_blob_iv(nonce: &[u8; 8]) -> [u8; 16] {
    let mut iv = [0u8; 16];
    iv[..8].copy_from_slice(nonce);
    iv
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{TIER_64K, TIER_128K};

    #[test]
    fn test_select_tier() {
        assert_eq!(select_tier(0).unwrap(), TIER_64K);
        assert_eq!(select_tier(100).unwrap(), TIER_64K);
        assert_eq!(select_tier(64 * 1024).unwrap(), TIER_64K);
        assert_eq!(select_tier(64 * 1024 + 1).unwrap(), TIER_128K);
        assert_eq!(select_tier(128 * 1024).unwrap(), TIER_128K);
        assert_eq!(select_tier(512 * 1024).unwrap(), TIER_512K);
        assert!(select_tier(512 * 1024 + 1).is_err());
    }

    #[test]
    fn test_obfuscate_deobfuscate_roundtrip() {
        let mk = [0xABu8; 32];
        let plaintext = b"{\"device_id\":\"abc\",\"entries\":[]}";

        let obfuscated = obfuscate_blob(plaintext, &mk).unwrap();
        assert!(obfuscated.len() >= TIER_64K); // Padded to next tier

        let deobfuscated = deobfuscate_blob(&obfuscated, &mk).unwrap();
        assert_eq!(deobfuscated, plaintext);
    }

    #[test]
    fn test_obfuscate_different_each_time() {
        let mk = [0xABu8; 32];
        let data = b"same data";

        let o1 = obfuscate_blob(data, &mk).unwrap();
        let o2 = obfuscate_blob(data, &mk).unwrap();

        // Different salt/nonce → different ciphertext
        assert_ne!(o1, o2);
    }

    #[test]
    fn test_deobfuscate_wrong_key_fails() {
        let mk1 = [0xABu8; 32];
        let mk2 = [0xCDu8; 32];
        let data = b"secret blob";

        let obfuscated = obfuscate_blob(data, &mk1).unwrap();
        assert!(deobfuscate_blob(&obfuscated, &mk2).is_none());
    }

    #[test]
    fn test_deobfuscate_tampered_fails() {
        let mk = [0xABu8; 32];
        let data = b"important data";

        let mut obfuscated = obfuscate_blob(data, &mk).unwrap();
        // Flip a bit in the ciphertext
        obfuscated[30] ^= 0x01;

        assert!(deobfuscate_blob(&obfuscated, &mk).is_none());
    }

    #[test]
    fn test_deobfuscate_short_data() {
        let mk = [0xABu8; 32];
        assert!(deobfuscate_blob(b"too short", &mk).is_none());
    }

    #[test]
    fn test_blob_tier_128k() {
        let mk = [0xABu8; 32];
        // Create data that exceeds 64K (65,536) to trigger 128K tier
        let large_data = vec![b'A'; 66_000];
        let obfuscated = obfuscate_blob(&large_data, &mk).unwrap();
        assert!(obfuscated.len() >= TIER_128K);

        let deobfuscated = deobfuscate_blob(&obfuscated, &mk).unwrap();
        assert_eq!(deobfuscated, large_data);
    }
}
