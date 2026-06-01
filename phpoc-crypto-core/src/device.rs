//! Device identity — HMAC proof of device ownership.
//!
//! Implements the device identity protocol from device_identity.py:
//! - `device_proof()`: HMAC-SHA256(MK, "phpoc:device:" + device_id)
//! - `get_device_id()`: HMAC-SHA256(MK, "device:id") — derived device ID
//! - `get_device_secret()`: HMAC-SHA256(MK, "device:secret") — for cross-device attribution
//!
//! The device proof system prevents impersonation: an attacker needs
//! *both* the UUID and the master key to forge a device identity.

use ring::hmac;

use crate::hmac_utils::{hmac_hex, hmac_raw};
use crate::DEVICE_PROOF_PREFIX;

/// Compute a cryptographically verifiable device proof.
///
/// Per device_identity.py:
/// `proof = HMAC-SHA256(MK, "phpoc:device:" + device_id).hexdigest()`
///
/// This proves that the device knows the Master Key without revealing it.
///
/// # Arguments
/// * `master_key` - 32-byte Master Key.
/// * `device_id` - The device's UUID v4 string.
///
/// # Returns
/// 64-character hex string HMAC-SHA256 proof.
pub fn device_proof(master_key: &[u8; 32], device_id: &str) -> String {
    let data = format!("{}{}", std::str::from_utf8(DEVICE_PROOF_PREFIX).unwrap(), device_id);
    hmac_hex(master_key, data.as_bytes())
}

/// Verify a device proof against a device_id and master key.
///
/// # Arguments
/// * `device_id` - The claimed device UUID.
/// * `proof` - The hex-encoded proof to verify.
/// * `master_key` - 32-byte Master Key.
///
/// # Returns
/// `true` if the proof is valid for this device_id and master_key.
pub fn verify_device_proof(
    device_id: &str,
    proof: &str,
    master_key: &[u8; 32],
) -> bool {
    let expected = device_proof(master_key, device_id);
    // Constant-time comparison
    let expected_bytes = match hex::decode(&expected) {
        Ok(b) => b,
        Err(_) => return false,
    };
    let proof_bytes = match hex::decode(proof) {
        Ok(b) => b,
        Err(_) => return false,
    };
    hmac::verify(
        &hmac::Key::new(hmac::HMAC_SHA256, master_key),
        format!("{}{}", std::str::from_utf8(DEVICE_PROOF_PREFIX).unwrap(), device_id).as_bytes(),
        &proof_bytes,
    )
    .is_ok()
}

/// Derive an opaque device identifier from the Master Key.
///
/// Per PHPSPEC §2.8:
/// `device_id = HMAC-SHA256(MK, "device:id").hexdigest()`
///
/// This means a device has no identity until the user authenticates on it.
/// The same device (same MK) always produces the same device ID.
/// Unlike a UUID, this is deterministic from the key — no config storage needed.
///
/// # Arguments
/// * `master_key` - 32-byte Master Key.
///
/// # Returns
/// 64-character hex string device identifier.
pub fn get_device_id(master_key: &[u8; 32]) -> String {
    hmac_hex(master_key, b"device:id")
}

/// Derive a device secret for cross-device entry attribution.
///
/// Per PHPSPEC §2.8:
/// `device_secret = HMAC-SHA256(MK, "device:secret")`
///
/// Used as the HMAC key for `device_proof` attribution in ledger entries.
/// Not stored in the ledger — only the authorized user can recompute it.
///
/// # Arguments
/// * `master_key` - 32-byte Master Key.
///
/// # Returns
/// 32-byte device secret.
pub fn get_device_secret(master_key: &[u8; 32]) -> Vec<u8> {
    hmac_raw(master_key, b"device:secret")
}

/// Check if a remote device identity matches the local device.
///
/// Per PHPSPEC:
/// 1. Verify the remote's proof is valid (proves they know MK)
/// 2. Check if it's the same physical device by comparing IDs
///
/// # Arguments
/// * `remote_device_id` - Device ID from remote blob.
/// * `remote_device_proof` - Proof from remote blob.
/// * `local_device_id` - This device's ID.
/// * `master_key` - 32-byte Master Key.
///
/// # Returns
/// `true` if remote was last touched by THIS device (no re-auth needed).
pub fn check_remote_identity(
    remote_device_id: &str,
    remote_device_proof: &str,
    local_device_id: &str,
    master_key: &[u8; 32],
) -> bool {
    // First verify the remote's proof is valid (proves they know MK)
    if !verify_device_proof(remote_device_id, remote_device_proof, master_key) {
        return false;
    }
    // Then check if it's the same physical device
    remote_device_id == local_device_id
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_device_proof_deterministic() {
        let mk = [0xABu8; 32];
        let device_id = "550e8400-e29b-41d4-a716-446655440000";

        let p1 = device_proof(&mk, device_id);
        let p2 = device_proof(&mk, device_id);
        assert_eq!(p1, p2);
        assert_eq!(p1.len(), 64);
    }

    #[test]
    fn test_device_proof_different_devices() {
        let mk = [0xABu8; 32];
        let id1 = "550e8400-e29b-41d4-a716-446655440000";
        let id2 = "550e8400-e29b-41d4-a716-446655440001";

        assert_ne!(device_proof(&mk, id1), device_proof(&mk, id2));
    }

    #[test]
    fn test_device_proof_different_keys() {
        let mk1 = [0xABu8; 32];
        let mk2 = [0xCDu8; 32];
        let device_id = "550e8400-e29b-41d4-a716-446655440000";

        assert_ne!(device_proof(&mk1, device_id), device_proof(&mk2, device_id));
    }

    #[test]
    fn test_verify_device_proof_valid() {
        let mk = [0xABu8; 32];
        let device_id = "test-device-uuid";
        let proof = device_proof(&mk, device_id);

        assert!(verify_device_proof(device_id, &proof, &mk));
    }

    #[test]
    fn test_verify_device_proof_invalid() {
        let mk = [0xABu8; 32];
        let device_id = "real-device";
        let fake_proof = "0000000000000000000000000000000000000000000000000000000000000000";

        assert!(!verify_device_proof(device_id, fake_proof, &mk));
    }

    #[test]
    fn test_get_device_id_deterministic() {
        let mk = [0xABu8; 32];
        assert_eq!(get_device_id(&mk), get_device_id(&mk));
        assert_eq!(get_device_id(&mk).len(), 64);
    }

    #[test]
    fn test_get_device_secret() {
        let mk = [0xABu8; 32];
        let secret = get_device_secret(&mk);
        assert_eq!(secret.len(), 32);
        // Deterministic
        assert_eq!(get_device_secret(&mk), get_device_secret(&mk));
    }

    #[test]
    fn test_check_remote_identity_same_device() {
        let mk = [0xABu8; 32];
        let device_id = "my-device";

        let proof = device_proof(&mk, device_id);
        assert!(check_remote_identity(device_id, &proof, device_id, &mk));
    }

    #[test]
    fn test_check_remote_identity_different_device() {
        let mk = [0xABu8; 32];
        let local_id = "device-a";
        let remote_id = "device-b";

        let proof = device_proof(&mk, remote_id);
        assert!(!check_remote_identity(remote_id, &proof, local_id, &mk));
    }

    #[test]
    fn test_check_remote_identity_bad_proof() {
        let mk = [0xABu8; 32];
        let device_id = "my-device";
        let bad_proof = "0000000000000000000000000000000000000000000000000000000000000000";

        assert!(!check_remote_identity(device_id, bad_proof, device_id, &mk));
    }
}
