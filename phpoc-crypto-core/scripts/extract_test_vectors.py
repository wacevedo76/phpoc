#!/usr/bin/env python3
"""
Extract crypto test vectors from the CLI reference implementation.

Produces tests/crypto_test_vectors.json for validating the Rust
phpoc-crypto-core crate against known Python outputs.

Run from the phpoc-crypto-core directory:
    python3 scripts/extract_test_vectors.py

Or from the project root:
    python3 phpoc-crypto-core/scripts/extract_test_vectors.py
"""

import hashlib
import hmac
import json
import os
import sys


def derive_pdk(passphrase: str, iterations: int = 600_000) -> str:
    """PBKDF2-HMAC-SHA256 per PHPSPEC §2.4."""
    key = hashlib.pbkdf2_hmac(
        'sha256',
        passphrase.encode('utf-8'),
        b"session-salt",
        iterations,
        32
    )
    return key.hex()


def hmac_sha256(key_hex: str, data_hex: str) -> str:
    """HMAC-SHA256 returning hex."""
    key = bytes.fromhex(key_hex)
    data = bytes.fromhex(data_hex)
    return hmac.new(key, data, hashlib.sha256).hexdigest()


def sha256(data_hex: str) -> str:
    """SHA-256 returning hex."""
    data = bytes.fromhex(data_hex)
    return hashlib.sha256(data).hexdigest()


def generate_test_vectors() -> dict:
    """Generate test vectors matching the CLI's crypto primitives."""
    vectors = {
        "pbkdf2": [],
        "aes_ctr": [],
        "hmac_sha256": [],
        "sha256": [],
        "blob_obfuscation": [],
    }

    # --- PBKDF2 vectors ---
    pbkdf2_cases = [
        ("test-passphrase", 600_000),
        ("test-passphrase", 100_000),  # legacy
        ("", 600_000),                  # empty passphrase
        ("My Super Secure Passphrase! 🔐", 600_000),
        ("a" * 100, 600_000),          # long passphrase
    ]
    for passphrase, iterations in pbkdf2_cases:
        vectors["pbkdf2"].append({
            "passphrase": passphrase,
            "iterations": iterations,
            "expected_hex": derive_pdk(passphrase, iterations),
        })

    # --- HMAC-SHA256 vectors ---
    hmac_cases = [
        ("00" * 32, "48656c6c6f", "HMAC of 'Hello'"),
        ("ab" * 32, "54657374", "HMAC of 'Test'"),
        ("00" * 32, "", "HMAC of empty string"),
    ]
    for key_hex, data_hex, note in hmac_cases:
        vectors["hmac_sha256"].append({
            "key_hex": key_hex,
            "data_hex": data_hex,
            "expected_hex": hmac_sha256(key_hex, data_hex),
            "note": note,
        })

    # --- SHA-256 vectors ---
    sha256_cases = [
        ("48656c6c6f", "SHA-256 of 'Hello'"),
        ("", "SHA-256 of empty string"),
        ("54686520717569636b2062726f776e20666f78", "SHA-256 of 'The quick brown fox'"),
    ]
    for data_hex, note in sha256_cases:
        vectors["sha256"].append({
            "data_hex": data_hex,
            "expected_hex": sha256(data_hex),
            "note": note,
        })

    # --- AES-CTR vectors (roundtrip only — ciphertext is non-deterministic) ---
    aes_ctr_cases = [
        ("ab" * 32, "Hello, PHPOC!"),
        ("ab" * 32, ""),
        ("ab" * 32, "日本語 Español 🔐"),
        ("00" * 32, "All zeros key"),
        ("ff" * 32, "All ones key"),
    ]
    for mk_hex, plaintext in aes_ctr_cases:
        vectors["aes_ctr"].append({
            "master_key_hex": mk_hex,
            "plaintext": plaintext,
            "note": "Roundtrip test — ciphertext is non-deterministic due to random salt/nonce",
        })

    # --- Blob obfuscation vectors (roundtrip only) ---
    blob_cases = [
        ("ab" * 32, '{"device_id":"abc","entries":[]}'),
        ("ab" * 32, '{"device_id":"abc","entries":[],"version":1}'),
        ("00" * 32, '{}'),
    ]
    for mk_hex, plaintext in blob_cases:
        vectors["blob_obfuscation"].append({
            "master_key_hex": mk_hex,
            "plaintext": plaintext,
            "note": "Roundtrip test — obfuscation is non-deterministic",
        })

    return vectors


def main():
    # Determine output path
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.dirname(script_dir)  # phpoc-crypto-core/
    output_path = os.path.join(project_root, "tests", "crypto_test_vectors.json")

    vectors = generate_test_vectors()

    with open(output_path, "w") as f:
        json.dump(vectors, f, indent=2)
        f.write("\n")

    total = sum(len(v) for v in vectors.values())
    print(f"✅ Generated {total} test vectors → {output_path}")

    # Print summary
    for category, cases in vectors.items():
        print(f"   {category}: {len(cases)} vectors")


if __name__ == "__main__":
    main()
