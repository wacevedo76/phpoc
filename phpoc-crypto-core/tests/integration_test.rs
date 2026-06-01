//! Integration tests for phpoc-crypto-core.
//!
//! Validates the full crypto pipeline end-to-end against test vectors
//! extracted from the CLI reference implementation.

use phpoc_crypto_core::*;
use serde::{Deserialize, Serialize};

/// Test vector structure matching crypto_test_vectors.json.
#[derive(Debug, Deserialize, Serialize)]
struct CryptoTestVectors {
    pbkdf2: Vec<Pbkdf2Vector>,
    aes_ctr: Vec<AesCtrVector>,
    hmac_sha256: Vec<HmacVector>,
    sha256: Vec<Sha256Vector>,
    blob_obfuscation: Vec<BlobVector>,
}

#[derive(Debug, Deserialize, Serialize)]
struct Pbkdf2Vector {
    passphrase: String,
    iterations: u32,
    expected_hex: String,
}

#[derive(Debug, Deserialize, Serialize)]
struct AesCtrVector {
    master_key_hex: String,
    plaintext: String,
    /// The decrypted output must match `plaintext`.
    /// Ciphertext is non-deterministic (random salt/nonce),
    /// so we only test decrypt(ciphertext) == plaintext.
    #[allow(dead_code)]
    note: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct HmacVector {
    key_hex: String,
    data_hex: String,
    expected_hex: String,
}

#[derive(Debug, Deserialize, Serialize)]
struct Sha256Vector {
    data_hex: String,
    expected_hex: String,
}

#[derive(Debug, Deserialize, Serialize)]
struct BlobVector {
    master_key_hex: String,
    plaintext: String,
    /// Obfuscation is non-deterministic, so we test roundtrip.
    #[allow(dead_code)]
    note: Option<String>,
}

/// Load test vectors from the JSON file.
fn load_test_vectors() -> CryptoTestVectors {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/crypto_test_vectors.json"
    );
    let content = std::fs::read_to_string(path)
        .expect("crypto_test_vectors.json not found. Run scripts/extract_test_vectors.py first.");
    serde_json::from_str(&content)
        .expect("Failed to parse crypto_test_vectors.json")
}

#[test]
fn test_pbkdf2_vectors() {
    let vectors = load_test_vectors();
    for (i, v) in vectors.pbkdf2.iter().enumerate() {
        let iterations = if v.iterations == 600_000 {
            key_derivation::PdkIterations::Standard
        } else {
            key_derivation::PdkIterations::Legacy
        };
        let pdk = key_derivation::derive_pdk(&v.passphrase, iterations);
        let hex = hex::encode(pdk);
        assert_eq!(
            hex, v.expected_hex,
            "PBKDF2 vector {} failed for passphrase: {}",
            i, v.passphrase
        );
    }
}

#[test]
fn test_aes_ctr_roundtrip() {
    let vectors = load_test_vectors();
    for (i, v) in vectors.aes_ctr.iter().enumerate() {
        let mk_hex = hex::decode(&v.master_key_hex).unwrap();
        let mk: [u8; 32] = mk_hex.try_into().unwrap();

        let ciphertext = aes_ctr::encrypt(&v.plaintext, &mk);
        let decrypted = aes_ctr::decrypt(&ciphertext, &mk).unwrap();

        assert_eq!(
            decrypted, v.plaintext,
            "AES-CTR vector {} roundtrip failed",
            i
        );
    }
}

#[test]
fn test_hmac_vectors() {
    let vectors = load_test_vectors();
    for (i, v) in vectors.hmac_sha256.iter().enumerate() {
        let key = hex::decode(&v.key_hex).unwrap();
        let data = hex::decode(&v.data_hex).unwrap();
        let result = hmac_utils::hmac_hex(&key, &data);
        assert_eq!(
            result, v.expected_hex,
            "HMAC-SHA256 vector {} failed",
            i
        );
    }
}

#[test]
fn test_sha256_vectors() {
    let vectors = load_test_vectors();
    for (i, v) in vectors.sha256.iter().enumerate() {
        let data = hex::decode(&v.data_hex).unwrap();
        let result = digest::sha256_hex(&data);
        assert_eq!(
            result, v.expected_hex,
            "SHA-256 vector {} failed",
            i
        );
    }
}

#[test]
fn test_blob_roundtrip() {
    let vectors = load_test_vectors();
    for (i, v) in vectors.blob_obfuscation.iter().enumerate() {
        let mk_hex = hex::decode(&v.master_key_hex).unwrap();
        let mk: [u8; 32] = mk_hex.try_into().unwrap();

        let plaintext = v.plaintext.as_bytes();
        let obfuscated = blob::obfuscate_blob(plaintext, &mk).unwrap();
        let deobfuscated = blob::deobfuscate_blob(&obfuscated, &mk).unwrap();

        assert_eq!(
            deobfuscated,
            plaintext,
            "Blob obfuscation vector {} roundtrip failed",
            i
        );
    }
}

#[test]
fn test_full_encrypt_decrypt_seal_roundtrip() {
    let master_key = [0x42u8; 32];
    let identity_secret = [0xDEu8; 32];
    let plaintext = "The quick brown fox jumps over the lazy dog";

    // Encrypt
    let ciphertext = aes_ctr::encrypt(plaintext, &master_key);
    assert_ne!(ciphertext, plaintext);
    assert!(ciphertext.is_ascii());

    // Decrypt
    let decrypted = aes_ctr::decrypt(&ciphertext, &master_key).unwrap();
    assert_eq!(decrypted, plaintext);

    // Seal
    let seal = hmac_utils::seal(plaintext, &master_key);
    assert_eq!(seal.len(), 64);
    assert!(hmac_utils::verify_seal(plaintext, &seal, &master_key));

    // Sign
    let signature = hmac_utils::sign(plaintext, &identity_secret);
    assert_eq!(signature.len(), 64);
    assert!(hmac_utils::verify_signature(plaintext, &signature, &identity_secret));

    // Device proof
    let device_id = "my-device-uuid";
    let proof = device::device_proof(&master_key, device_id);
    assert_eq!(proof.len(), 64);
    assert!(device::verify_device_proof(device_id, &proof, &master_key));

    // Content hash
    let entry_data = serde_json::json!({
        "title": "Test",
        "duration": 1000,
        "tags": ["a", "b"]
    });
    let entry_hash = digest::compute_entry_hash(&entry_data).unwrap();
    assert_eq!(entry_hash.len(), 64);

    // Derive keys
    let seed = random::generate_seed();
    let mk = key_derivation::derive_master_key(&seed).unwrap();
    assert_eq!(mk.len(), 32);

    // Blob obfuscation
    let blob_data = b"{\"device_id\":\"abc\",\"entries\":[1,2,3]}";
    let obfuscated = blob::obfuscate_blob(blob_data, &master_key).unwrap();
    let deobfuscated = blob::deobfuscate_blob(&obfuscated, &master_key).unwrap();
    assert_eq!(deobfuscated, blob_data);
}
