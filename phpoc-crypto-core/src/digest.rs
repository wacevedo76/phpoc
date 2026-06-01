//! SHA-256 digest utilities — content hashing, entry hashing, identity pub key.
//!
//! Implements parts of PHPSPEC §6 (Content Hash Algorithm) and §2.7 (Identity):
//! - Content hash (canonical plaintext, survives re-encryption)
//! - Entry hash (SHA-256 of sorted JSON data dict)
//! - Identity public key (SHA-256 of identity secret)

use ring::digest;

use crate::{CryptoError, Result};

/// Compute SHA-256 hash of raw bytes, returning a lowercase hex string.
///
/// # Arguments
/// * `data` - Bytes to hash.
///
/// # Returns
/// 64-character lowercase hex string.
pub fn sha256_hex(data: &[u8]) -> String {
    let d = digest::digest(&digest::SHA256, data);
    hex::encode(d.as_ref())
}

/// Compute SHA-256 hash of a string, returning a lowercase hex string.
pub fn sha256_string(data: &str) -> String {
    sha256_hex(data.as_bytes())
}

/// Compute an entry's hash from its JSON data dict.
///
/// Per PHPSPEC §5.4:
/// `entry_hash = SHA-256(json.dumps(data, sort_keys=True))`
///
/// # Arguments
/// * `json_value` - A serde_json::Value representing the entry's data dict.
///
/// # Returns
/// 64-character hex string entry hash.
pub fn compute_entry_hash(json_value: &serde_json::Value) -> Result<String> {
    let canonical = serde_json::to_string(json_value)
        .map_err(|e| CryptoError::DecryptionFailed(format!("JSON serialization: {}", e)))?;
    Ok(sha256_string(&canonical))
}

/// Compute an extensible content hash from entry data.
///
/// Per PHPSPEC §6.1 (v0.4.0+):
/// Iterates all keys in the entry's data dict:
/// - Fields ending in `_enc` are decrypted via `decrypt_fn`
/// - List fields are sorted for deterministic output
/// - The `content_hash` field itself is excluded
/// - All other fields are included as-is
///
/// # Arguments
/// * `entry_data` - A serde_json::Value representing the entry's data dict.
/// * `decrypt_fn` - Closure that decrypts an `_enc` field value (hex → plaintext).
///
/// # Returns
/// 64-character hex string content hash.
pub fn compute_content_hash(
    entry_data: &serde_json::Value,
    decrypt_fn: &dyn Fn(&str) -> Result<String>,
) -> Result<String> {
    use serde_json::Value;

    let obj = entry_data.as_object()
        .ok_or_else(|| CryptoError::DecryptionFailed("entry data is not an object".into()))?;

    let mut content = serde_json::Map::new();

    for (key, value) in obj {
        if key == "content_hash" {
            continue;
        }

        let resolved = if key.ends_with("_enc") {
            if let Some(s) = value.as_str() {
                if !s.is_empty() {
                    let decrypted = decrypt_fn(s)?;
                    Value::String(decrypted)
                } else {
                    Value::String(String::new())
                }
            } else {
                Value::Null
            }
        } else if let Some(arr) = value.as_array() {
            let mut sorted: Vec<&Value> = arr.iter().collect();
            sorted.sort_by(|a, b| a.to_string().cmp(&b.to_string()));
            Value::Array(sorted.into_iter().cloned().collect())
        } else {
            value.clone()
        };

        content.insert(key.clone(), resolved);
    }

    let canonical = serde_json::to_string(&Value::Object(content))
        .map_err(|e| CryptoError::DecryptionFailed(format!("JSON serialization: {}", e)))?;

    Ok(sha256_string(&canonical))
}

/// Compute legacy content hash (pre-v0.4.0, hardcoded 9 fields).
///
/// Per PHPSPEC §6.2: Uses a fixed set of 9 fields from plaintext values.
#[allow(clippy::too_many_arguments)]
pub fn compute_content_hash_legacy(
    title: &str,
    start_epoch: u64,
    end_time_str: &str,
    metadata_json: &str,
    pauses_json: &str,
    tags: &[String],
    comment: &str,
    media: &[String],
    duration: u64,
) -> String {
    let mut sorted_tags = tags.to_vec();
    sorted_tags.sort();
    let mut sorted_media = media.to_vec();
    sorted_media.sort();

    use serde_json::json;
    let content = json!({
        "title": title,
        "startTime": start_epoch.to_string(),
        "endTime": if end_time_str.is_empty() { "" } else { end_time_str },
        "metadata": if metadata_json.is_empty() { "{}" } else { metadata_json },
        "pauses": if pauses_json.is_empty() { "[]" } else { pauses_json },
        "tags": sorted_tags,
        "comment": if comment.is_empty() { "" } else { comment },
        "media": sorted_media,
        "duration": duration,
    });

    compute_entry_hash(&content).unwrap_or_default()
}

/// Derive an identity public key from the identity secret.
///
/// Per PHPSPEC §2.7.1:
/// `identity_pub_key = SHA-256(identity_secret).hexdigest()`
///
/// # Arguments
/// * `identity_secret` - 32-byte identity secret.
///
/// # Returns
/// 64-character hex string.
pub fn identity_pub_key(identity_secret: &[u8; 32]) -> String {
    sha256_hex(identity_secret)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_sha256_hex() {
        let result = sha256_string("hello");
        assert_eq!(result.len(), 64);
        // Known SHA-256 of "hello"
        assert_eq!(
            result,
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }

    #[test]
    fn test_sha256_deterministic() {
        assert_eq!(sha256_string("test"), sha256_string("test"));
    }

    #[test]
    fn test_entry_hash_stable() {
        let data = json!({
            "title": "Guitar Practice",
            "duration": 3600000,
            "tags": ["music"]
        });
        let h1 = compute_entry_hash(&data).unwrap();
        let h2 = compute_entry_hash(&data).unwrap();
        assert_eq!(h1, h2);
    }

    #[test]
    fn test_entry_hash_changes_with_data() {
        let d1 = json!({"title": "A", "duration": 1000});
        let d2 = json!({"title": "B", "duration": 1000});
        assert_ne!(
            compute_entry_hash(&d1).unwrap(),
            compute_entry_hash(&d2).unwrap()
        );
    }

    #[test]
    fn test_identity_pub_key() {
        let secret = [0xABu8; 32];
        let pk = identity_pub_key(&secret);
        assert_eq!(pk.len(), 64);
        // Deterministic
        assert_eq!(pk, identity_pub_key(&secret));
    }

    #[test]
    fn test_content_hash_extensible() {
        let entry_data = json!({
            "title": "Coding",
            "duration": 3600000,
            "tags": ["work"],
            "startTime_enc": "plain:1714000000000",
        });

        let decrypt_fn = |s: &str| -> Result<String> {
            if let Some(plain) = s.strip_prefix("plain:") {
                Ok(plain.to_string())
            } else {
                Err(CryptoError::DecryptionFailed("mock decrypt failed".into()))
            }
        };

        let hash = compute_content_hash(&entry_data, &decrypt_fn).unwrap();
        assert_eq!(hash.len(), 64);
    }
}
