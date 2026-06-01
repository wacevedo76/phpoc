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

use crate::key_derivation::derive_blob_key;
use crate::random::random_bytes;
use crate::{CryptoError, Result, BLOB_TIERS, TIER_64K, TIER_128K, TIER_256K, TIER_512K};

/// AES-128-CTR cipher type for blob encryption.
type Aes128Ctr = Ctr64BE<aes::Aes128>;

/// Select the smallest obfuscation tier that fits `plaintext_size`.
///
/// Returns tier size in bytes (65536, 131072, 262144, or 524288).
///
/// # Errors
/// Returns `CryptoError::BlobTooLarge` if the blob exceeds 512K.
fn select_tier(plaintext_size: usize) -> Result<usize> {
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
    let padded_size = tier - 4; // Reserve 4 bytes for original length

    // Pad with random bytes
    let mut padded = plaintext.to_vec();
    if padded_size > padded.len() {
        let padding_needed = padded_size - padded.len();
        padded.extend_from_slice(&random_bytes(padding_needed));
    }

    // Prepend original length (big-endian u32)
    let mut padded_with_len = (plaintext.len() as u32).to_be_bytes().to_vec();
    padded_with_len.extend_from_slice(&padded);

    // Derive blob key and encrypt
    let blob_key = derive_blob_key(master_key);
    let salt: [u8; 16] = random_bytes(16).try_into().expect("16 bytes");
    let nonce: [u8; 8] = random_bytes(8).try_into().expect("8 bytes");

    // Derive encryption key from salt using blob sub-key
    let enc_key = crate::key_derivation::derive_sub_key_16(&blob_key, &salt);
    let integrity_key = {
        let mut int_salt = salt.to_vec();
        int_salt.extend_from_slice(crate::INTEGRITY_DOMAIN_SEPARATOR);
        crate::key_derivation::derive_sub_key_32(&blob_key, &int_salt)
    };

    // AES-CTR encrypt
    let mut ciphertext = padded_with_len;
    let iv = build_blob_iv(&nonce);
    let mut cipher = Aes128Ctr::new(&enc_key.into(), &iv.into());
    cipher.apply_keystream(&mut ciphertext);

    // Encrypt-then-MAC auth tag
    let tag = {
        use ring::hmac;
        let mut auth_data = nonce.to_vec();
        auth_data.extend_from_slice(&ciphertext);
        let signing_key = hmac::Key::new(hmac::HMAC_SHA256, &integrity_key);
        let signature = hmac::sign(&signing_key, &auth_data);
        signature.as_ref().to_vec()
    };

    // Assemble: salt(16) + nonce(8) + ciphertext + tag(32)
    let mut output = salt.to_vec();
    output.extend_from_slice(&nonce);
    output.extend_from_slice(&ciphertext);
    output.extend_from_slice(&tag);

    Ok(output)
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

    // Derive keys
    let blob_key = derive_blob_key(master_key);
    let enc_key = crate::key_derivation::derive_sub_key_16(&blob_key, &salt);
    let integrity_key = {
        let mut int_salt = salt.to_vec();
        int_salt.extend_from_slice(crate::INTEGRITY_DOMAIN_SEPARATOR);
        crate::key_derivation::derive_sub_key_32(&blob_key, &int_salt)
    };

    // Verify auth tag
    {
        use ring::hmac;
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

/// Build a 16-byte CTR IV from an 8-byte nonce.
fn build_blob_iv(nonce: &[u8; 8]) -> [u8; 16] {
    let mut iv = [0u8; 16];
    iv[..8].copy_from_slice(nonce);
    iv
}

#[cfg(test)]
mod tests {
    use super::*;

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
        // Create data that exceeds 64K
        let large_data = vec![b'A'; 65_000];
        let obfuscated = obfuscate_blob(&large_data, &mk).unwrap();
        assert!(obfuscated.len() >= TIER_128K);

        let deobfuscated = deobfuscate_blob(&obfuscated, &mk).unwrap();
        assert_eq!(deobfuscated, large_data);
    }
}
