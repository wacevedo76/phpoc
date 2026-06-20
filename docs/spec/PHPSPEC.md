# Personal History Protocol — Format Specification

> **Version:** 0.3.0 (working tree)
> **Status:** Draft

This document defines the Personal History Protocol (PHPOC) ledger format — the block structure, encryption scheme, key derivation, chain validation, content hashing, and auxiliary data structures.

## Table of Contents

1. [Overview & Terminology](#1-overview--terminology)
2. [Key Derivation & Identity](#2-key-derivation--identity)
3. [Encryption Scheme](#3-encryption-scheme)
4. [Block Types (JSON Schema)](#4-block-types-json-schema)
5. [Chain Validation](#5-chain-validation)
6. [Content Hash Algorithm](#6-content-hash-algorithm)
7. [Blind Index](#7-blind-index)
8. [Staging Area](#8-staging-area)
9. [Implementation Considerations](#9-implementation-considerations)
10. [Appendix: Example Ledger](#10-appendix-example-ledger)

---

## 1. Overview & Terminology

### 1.1 Protocol Goals

PHPOC is an **open, encrypted, self-sovereign ledger format** for tracking personal activity history. Its core design principles:

- **Local-first.** The ledger lives on the user's device. Encrypted. Signed. Chained.
- **Portable.** The same format works across laptop, phone, wearable — any device that can read/write JSON and perform standard cryptographic operations.
- **Verifiable.** Every entry is content-hashed and linked into an immutable chain. Tampering is detectable.
- **Shareable by design.** The owner controls exactly which segments are shared — a date range, a blind index summary, a single activity type.
- **Zero external dependencies.** The reference implementation uses only standard library cryptography (Python stdlib). The format itself requires only AES-CTR, HMAC-SHA256, PBKDF2, and SHA-256 — all widely available across platforms.

### 1.2 Chain Hierarchy

```
┌──────────────────────────────────────┐
│            Genesis Block             │  ← One per ledger. Identity, root key.
│  prev_hash: 0x000...000              │
│  day_hash:  0xabc...def  ────────────│──┐
└──────────────────────────────────────┘  │
                                          ▼
┌──────────────────────────────────────┐
│         Year Summary Block           │  ← Optional. Created on year transition.
│  prev_hash: 0xabc...def              │
│  year_hash: 0x111...222  ────────────│──┐
└──────────────────────────────────────┘  │
                                          ▼
┌──────────────────────────────────────┐
│         Month Summary Block          │  ← Optional. Created on month transition.
│  prev_hash: 0x111...222              │
│  month_hash: 0x333...444  ───────────│──┐
└──────────────────────────────────────┘  │
                                          ▼
┌──────────────────────────────────────┐
│             Day Block                │  ← Contains entries. Created per sync date.
│  prev_hash: 0x333...444              │
│  day_hash:  0x555...666  ────────────│──┐
│  entries: [entry_0, entry_1, ...]    │  │
└──────────────────────────────────────┘  │
                                          ▼
                                     ┌────────┐
                                     │ Entry  │ ← Individual activity record.
                                     │ title  │   Content hashed, timestamps
                                     │ start  │   encrypted, metadata encrypted.
                                     │ end    │
                                     │ content│
                                     │ _hash  │
                                     └────────┘
```

Each block's `prev_hash` field references the hash of the immediately preceding block, forming a cryptographic chain. The Genesis block is the root with `prev_hash = "0" * 64`.

### 1.3 File Layout

A PHPOC ledger consists of the following files:

**Everything lives under a single data directory — resolved via priority chain:**

| Priority | Source | Notes |
|---|---|---|
| 1 (highest) | `--dir` CLI flag | `phpoc --dir /path verify` — per-invocation |
| 2 | `$PHPOC_DATA_DIR` env var | Per-session override |
| 3 | `storage.data_dir` in config | Persistent — set via `phpoc config set storage.data_dir <path>` |
| 4 | `$XDG_DATA_HOME/phpoc/` | Default: `~/.local/share/phpoc/` |
| 5 (lowest) | `~/.config/personal_history_poc/` | Legacy — auto-detected if new path doesn't exist |

**Config file path — resolved independently:**

| Priority | Source | Notes |
|---|---|---|
| 1 (highest) | `--config` CLI flag | Per-invocation |
| 2 | `$PHPOC_CONFIG` env var | Per-session |
| 3 | `$XDG_CONFIG_HOME/phpoc/config.json` | Default: `~/.config/phpoc/config.json` |

**Data files (in the resolved data directory):**

| File | Purpose | Canonical? |
|------|---------|------------|
| `ledger.json` | The chain — array of blocks (Genesis, summaries, days) | ✅ **Primary format** |
| `index.json` | Blind duration index — rebuildable from chain | 🔄 Optional cache |
| `identity.json` | Identity secret (encrypted) — redundant with genesis fallback | ⚠️ Optional convenience |
| `staging.json` | Mutable unsynced entries (transient, not part of format) | ❌ Not part of spec |

**The ledger chain (`ledger.json`) is the single canonical data file.** It is self-contained — identity is embedded in the Genesis block via `identity_secret_enc_fallback`. All other files are auxiliary caches or transient state.

### 1.4 Terminology

| Term | Definition |
|------|------------|
| **Seed** | 256 bits of entropy (32 bytes), base64-encoded. The root cryptographic secret. |
| **Master Key (MK)** | 32 bytes — the decoded Seed. Derives all sub-keys. |
| **Passphrase-Derived Key (PDK)** | Key derived via PBKDF2 from the user's passphrase. Only used to encrypt/decrypt the Seed. |
| **Block** | A JSON object in the ledger chain. One of: genesis, year_summary, month_summary, day. |
| **Seal** | An HMAC-SHA256 over a block's content (excluding the seal field itself). Proves block integrity. |
| **Signature** | An HMAC-SHA256 over a block's seal hash, using the identity secret. Proves authorship. |
| **Entry** | An individual activity record inside a Day block. Contains timestamps, title, duration, metadata. |
| **Content Hash** | SHA-256 of a canonical plaintext representation of an entry. Survives re-encryption. |
| **Blind Index** | A JSON dictionary mapping dates to activity-titled duration sums. Enables private reputation queries without decryption. |
| **Staging** | A mutable area for unsynced entries. Entries use `plain:` prefix so they can be viewed without authentication. |

---

## 2. Key Derivation & Identity

### 2.1 Sovereign Key Model

PHPOC uses a **rooted key hierarchy**:

```
User Passphrase
      │
      ▼  PBKDF2-HMAC-SHA256(passphrase, "session-salt", 600000, 32)
Passphrase-Derived Key (PDK) ───── encrypts/decrypts ───▶ Recovery Seed (base64)
                                                                 │
                                                                 ▼  base64 decode
                                                            Master Key (32 bytes)
                                                                 │
                                  ┌──────────────────────────────┼──────────────────────────────┐
                                  ▼                              ▼                              ▼
                          Encryption Sub-Key             Integrity Sub-Key            Sealing Sub-Key
                          (16 bytes, AES-CTR)           (32 bytes, HMAC-SHA256)      (32 bytes, HMAC-SHA256)

                                                                             ┌──────────────────────┐
                                                                             │  Identity Secret      │
                                                                             │  (32 bytes, os.urandom,│
                                                                             │  stored encrypted     │
                                              ┌──────────────────────────────┤  with Master Key)     │
                                              ▼                              └──────────────────────┘
                                       Identity Signature
                                       (HMAC-SHA256)
```

The passphrase is a **vault key** — it unlocks the Seed but is never used to encrypt ledger data directly. This means:

- **Changing the passphrase** re-encrypts only the Seed (one field in genesis). All data remains encrypted under the unchanged Master Key.
- **Recovery** with the Seed bypasses the old passphrase entirely. The Seed is the true root secret.
- **The Seed is the Master Key.** They are the same 32 bytes, just in different encodings (base64 vs raw).

### 2.2 Seed Generation

```python
import secrets, base64
random_bytes = secrets.token_bytes(32)  # 256 bits
seed = base64.b64encode(random_bytes).decode('utf-8')
```

| Property | Value |
|----------|-------|
| Entropy | 256 bits |
| Encoding | Base64 (standard alphabet) |
| Length | 44 characters (with padding) |
| Source | Cryptographically secure PRNG (`secrets.token_bytes` or equivalent) |

### 2.3 Seed → Master Key

The Master Key is simply the raw bytes of the Seed:

```python
master_key = base64.b64decode(seed)  # 32 bytes
```

No key stretching or derivation is applied here — the Seed already has full 256-bit entropy.

### 2.4 Passphrase-Derived Key (PDK)

The PDK is derived from the user's passphrase and a fixed salt. It is used **only** to encrypt or decrypt the Seed (stored in the genesis block's `recovery_seed_enc` field).

```python
import hashlib
pdk = hashlib.pbkdf2_hmac(
    'sha256',                      # hash algorithm
    passphrase.encode('utf-8'),    # password bytes
    b"session-salt",                # salt (hardcoded)
    600000,                        # iterations (OWASP 2026 recommendation)
    32                             # output length in bytes
)
```

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Algorithm | PBKDF2-HMAC-SHA256 | Widely available, standard library |
| Salt | `b"session-salt"` | Fixed per application — uniqueness comes from passphrase entropy |
| Iterations | 600,000 | OWASP 2026 recommended minimum for PBKDF2-HMAC-SHA256 |
| Output | 32 bytes (256 bits) | Matches AES-256 key size |

> **Note on salt:** The salt is fixed (not per-user) because the PDK only protects the Seed, which is itself encrypted and stored inside the ledger. An attacker already has the encrypted Seed. A per-user salt would add no security here — the KDF work factor (600K iterations) is the protection.

### 2.5 Seed Encryption with PDK

The Seed (as a base64 string) is encrypted with the PDK and stored in the genesis block:

```python
from security.crypto import CryptoManager
temp_crypto = CryptoManager(pdk)
encrypted_seed = temp_crypto.encrypt(seed_string)
```

The full encryption scheme (AES-CTR + HMAC-SHA256 auth tag) is described in [§3 Encryption Scheme](#3-encryption-scheme). The encrypted seed is stored as a hex-encoded string in the genesis field `identity.recovery_seed_enc`.

### 2.6 Sub-Key Derivation from Master Key

All cryptographic operations on ledger data use **sub-keys** derived from the Master Key (not the Master Key itself). This provides cryptographic separation between different operations.

```python
import hmac, hashlib

def derive_sub_key(master_key: bytes, salt: bytes, length: int = 16) -> bytes:
    """Derive a sub-key via HMAC-SHA256(master_key, salt), truncated to `length`."""
    return hmac.new(master_key, salt, hashlib.sha256).digest()[:length]
```

| Sub-Key | Salt | Length | Purpose |
|---------|------|--------|---------|
| Encryption | `random 16-byte salt` (per operation) | 16 bytes | AES-128-CTR encryption key |
| Integrity | `random 16-byte salt + b"-integrity"` (per operation) | 32 bytes | HMAC-SHA256 auth tag over ciphertext |
| Sealing | `b"integrity-key-salt"` (fixed) | 32 bytes | HMAC-SHA256 block seal |

> **Why AES-128 and not AES-256?** Each encryption operation derives a unique 16-byte key from the 32-byte Master Key via HMAC. The effective security level is 256 bits (the Master Key entropy), with per-operation key diversification. The 16-byte AES key is sufficient for CTR mode — the bottleneck is the Master Key, not the block cipher key size.

### 2.7 Identity Representation

The current identity system uses **HMAC-SHA256 as a proxy for Ed25519** to remain zero-dependency. This is sufficient for single-device usage (tamper detection, authorship proof). A future version should upgrade to real Ed25519 for third-party verifiability.

#### 2.7.1 Identity Secret & Signing

```python
import os, hmac, hashlib

identity_secret = os.urandom(32)  # 32 bytes, high entropy
identity_pub_key = hashlib.sha256(identity_secret).hexdigest()  # public identifier

def sign(data_str: str, identity_secret: bytes) -> str:
    """Sign data using HMAC-SHA256 as Ed25519 proxy."""
    return hmac.new(identity_secret, data_str.encode(), hashlib.sha256).hexdigest()

def verify_signature(data_str: str, signature: str, identity_secret: bytes) -> bool:
    expected = sign(data_str, identity_secret)
    return hmac.compare_digest(expected, signature)
```

The identity secret is a 32-byte random value. The public key is `SHA-256(identity_secret)`. This is not a true asymmetric key pair — anyone who knows the identity secret can both sign and verify. True public-key cryptography (Ed25519) is planned.

#### 2.7.2 Identity Storage

The identity secret is stored in two places for redundancy:

**1. Ledger genesis block (canonical):** The encrypted identity secret is embedded in the genesis block under `identity.identity_secret_enc_fallback`. This makes the ledger fully self-contained — a user can recover their identity from just `ledger.json` + their passphrase.

```json
{
  "type": "genesis",
  "identity": {
    "username": "alice",
    "email": "alice@example.com",
    "recovery_seed_enc": "<hex: seed encrypted with PDK>",
    "identity_pub_key": "<sha256 of identity secret>",
    "identity_secret_enc_fallback": "<hex: identity secret encrypted with Master Key>"
  }
}
```

**2. Identity file (optional cache):** `identity.json` stores the same encrypted secret for faster access:

```json
{
  "identity_secret_enc": "<hex: identity secret encrypted with Master Key>"
}
```

**Lookup order:** Implementations should try `identity.json` first (fast path), then fall back to the genesis block's `identity_secret_enc_fallback`.

### 2.8 Device Identity

Multi-device setups require per-entry device attribution. A **plug-in device identity provider** generates opaque, deterministic device identifiers from the Master Key. The interface is:

```python
class DeviceIdentityProvider(ABC):
    @abstractmethod
    def get_device_id(self, mk: bytes) -> str: ...
    @abstractmethod
    def get_device_secret(self, mk: bytes) -> bytes: ...
```

| Method | Returns | Purpose |
|--------|---------|---------|
| `get_device_id` | Opaque string | Stored in each entry's `device_id_enc` field. Obfuscated — reveals nothing about the device to an attacker. |
| `get_device_secret` | 32 bytes | Used as the HMAC key for `device_proof` attribution (see §4.5). Not stored in the ledger — only the authorized user can recompute it. |

**Default implementation:** Both values are derived from the Master Key via HMAC:

```python
import hmac, hashlib

def get_device_id(mk: bytes) -> str:
    return hmac.new(mk, b"device:id", hashlib.sha256).hexdigest()

def get_device_secret(mk: bytes) -> bytes:
    return hmac.new(mk, b"device:secret", hashlib.sha256).digest()
```

This means a device has no identity until the user authenticates on it. The same device (same MK) always produces the same device ID — allowing the user to correlate entries across syncs without storing device metadata.

**Pluggable:** Users who want stronger device identity (TPM-backed, biometric, hardware-specific) can provide an alternative implementation. The format itself only requires a stable, opaque identifier per device.

> **Privacy note:** `device_id_enc` in the ledger entry is encrypted with AES-CTR using a random nonce per operation (§3.2). Two entries from the same device produce different ciphertexts. An attacker cannot correlate entries by device without the Master Key.

### 2.9 Recovery Flow

To recover a ledger when the passphrase is lost (but the Seed is known):

1. **User provides the Recovery Seed** (base64 string)
2. **Derive Master Key:** `master_key = base64.b64decode(seed)`
3. **Derive new PDK:** `pdk = PBKDF2(new_passphrase, "session-salt", 600000, 32)`
4. **Re-encrypt Seed:** `encrypted_seed = CryptoManager(pdk).encrypt(seed_string)`
5. **Update genesis:** Replace `identity.recovery_seed_enc` with the new encrypted seed
6. **Reseal genesis:** Recompute `day_hash` using the Master Key (unchanged)
7. **Persist** `ledger.json`

All ledger data remains encrypted under the same Master Key — only the seed's encryption envelope changes.

> **To change a passphrase knowing the old passphrase** (without the Seed), the implementation must first decrypt the Seed using the old PDK, then re-encrypt with the new PDK. This is a straightforward extension — the primitives are identical to the recovery flow.

---

## 3. Encryption Scheme

### 3.1 Overview

PHPOC encrypts entry fields individually using **AES-128-CTR** combined with an **encrypt-then-MAC** authentication tag (HMAC-SHA256). Every encryption produces a unique binary package:

```
┌──────────────────────────────────────────────────────────────────┐
│ salt (16 bytes) │ nonce (8 bytes) │ ciphertext │ auth tag (32 bytes) │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼  hex-encoded
                    Stored as a hex string
```

#### 3.1.1 Field Encryption Convention

Any JSON string field in an entry may be encrypted. Encryption is indicated by an `_enc` suffix on the field name. An encrypted field's value is a hex-encoded ciphertext string (as defined in [§3.4 Wire Format](#34-wire-format)). An unencrypted field's value is the plain JSON value.

```
"startTime_enc": "<hex ciphertext>"    ← encrypted
"title": "Guitar Practice"             ← plaintext (no _enc suffix)
"title_enc": "<hex ciphertext>"        ← also valid if encrypted
```

**Encrypted fields (reference implementation):** The reference PHPOC CLI encrypts these fields at sync time:

| Field | Content |
|-------|---------|
| `startTime_enc` | Encrypted epoch milliseconds (e.g., `"1714000000000"`) |
| `endTime_enc` | Encrypted epoch milliseconds, or `null` if task is still active |
| `metadata_enc` | Encrypted JSON object (e.g., `{"note": "Great session"}`) |
| `pauses_enc` | Encrypted JSON array of pause intervals |

**Any field may be encrypted.** The wire format (§3.4) handles arbitrary plaintext. An implementation could encrypt `title`, `comment`, `tags`, or any other field by storing it as `{field}_enc`. The encryption and decryption procedures are identical regardless of which field is being protected.

> **Note for implementers:** Encrypting fields that the blind index (see [§7](#7-blind-index)) or display logic depends on (e.g., `title`) may require additional infrastructure to maintain functionality. The reference implementation keeps `title` plaintext to enable fast listing and blind index queries.

### 3.2 AES-CTR Mode

AES-CTR (Counter mode) turns AES into a stream cipher by encrypting successive counter blocks:

```
ciphertext = plaintext XOR AES_encrypt(key, nonce || counter)
```

Because CTR mode is symmetric (encryption = decryption), the same function handles both operations.

#### 3.2.1 Counter Block Construction

```
Counter block (16 bytes):
┌──────────┬──────────┐
│ nonce    │ counter  │
│ (8 bytes)│ (8 bytes)│
└──────────┴──────────┘
```

- **Nonce:** 8 random bytes, unique per encryption operation. Generated fresh via CSPRNG.
- **Counter:** Big-endian 64-bit unsigned integer, starting at 0 and incrementing for each 16-byte block of plaintext.

#### 3.2.2 Encryption Key

The AES-128 key is derived per-operation:

```python
import hmac, hashlib

# Derive 16-byte encryption sub-key from Master Key + per-operation salt
salt = os.urandom(16)
enc_key = hmac.new(master_key, salt, hashlib.sha256).digest()[:16]
```

This means **every encryption uses a different AES key** (different salt → different HMAC output), even for the same plaintext. Combined with a random nonce, this guarantees semantic security — no two ciphertexts are identical.

### 3.3 Encrypt-then-MAC Auth Tag

To prevent ciphertext malleability (a known weakness of raw CTR mode), every encryption is followed by an HMAC-SHA256 authentication tag over the nonce and ciphertext:

```python
# Integrity key derived from Master Key + same salt + domain separator
integrity_key = hmac.new(master_key, salt + b"-integrity", hashlib.sha256).digest()  # 32 bytes

# Authenticate: nonce || ciphertext
tag = hmac.new(integrity_key, nonce + ciphertext, hashlib.sha256).digest()  # 32 bytes
```

The `b"-integrity"` domain separator ensures the integrity key is distinct from the encryption key, even though both are derived from the same salt.

### 3.4 Wire Format

Every encrypted value is assembled into a binary buffer and hex-encoded for JSON storage:

```
Offset  Size   Field
──────  ────   ────────────────────────────────────────
 0      16     salt (random bytes for key derivation)
16       8     nonce (random bytes for CTR mode)
24       N     ciphertext (plaintext XOR keystream)
24+N    32     auth tag (HMAC-SHA256 over nonce || ciphertext)

Total: 56 + N bytes → hex string of length 112 + 2N
```

#### 3.4.1 Encryption Pseudocode

```python
def encrypt(plaintext: str, master_key: bytes) -> str:
    salt = os.urandom(16)
    nonce = os.urandom(8)
    
    # Derive encryption key
    enc_key = hmac.new(master_key, salt, hashlib.sha256).digest()[:16]
    
    # AES-CTR encrypt
    ciphertext = aes_ctr_encrypt(plaintext.encode('utf-8'), enc_key, nonce)
    
    # Compute auth tag
    integrity_key = hmac.new(master_key, salt + b"-integrity", hashlib.sha256).digest()
    tag = hmac.new(integrity_key, nonce + ciphertext, hashlib.sha256).digest()
    
    # Assemble and hex-encode
    return (salt + nonce + ciphertext + tag).hex()
```

### 3.5 Decryption & Verification

```python
def decrypt(hex_data: str, master_key: bytes) -> str:
    data = bytes.fromhex(hex_data)
    
    salt = data[:16]
    nonce = data[16:24]
    
    # Detect format:
    #   New: salt(16) + nonce(8) + ciphertext + tag(32)
    #   Legacy: salt(16) + nonce(8) + ciphertext
    has_tag = len(data) >= 56  # 16 + 8 + 0 + 32 = minimum with tag
    
    if has_tag:
        ciphertext = data[24:-32]
        stored_tag = data[-32:]
        
        # Verify auth tag BEFORE decrypting
        integrity_key = hmac.new(master_key, salt + b"-integrity", hashlib.sha256).digest()
        expected_tag = hmac.new(integrity_key, nonce + ciphertext, hashlib.sha256).digest()
        
        if not hmac.compare_digest(expected_tag, stored_tag):
            raise ValueError("Auth tag mismatch: ciphertext has been tampered with")
    else:
        # Legacy format — no auth tag (backward compatibility)
        ciphertext = data[24:]
    
    # Derive encryption key and decrypt
    enc_key = hmac.new(master_key, salt, hashlib.sha256).digest()[:16]
    plaintext = aes_ctr_decrypt(ciphertext, enc_key, nonce)
    
    return plaintext.decode('utf-8')
```

> **Security note:** The auth tag is verified **before** decryption. This prevents timing attacks and ensures corrupted data is rejected early.

### 3.6 AES-CTR Implementation Notes

A pure-Python AES implementation is ~180 lines of hand-rolled S-box operations. Implementations targeting production should use platform-native AES (e.g., Python's `cryptography` library, CommonCrypto on iOS, `javax.crypto` on Android). The relevant parameters:

| Parameter | Value |
|-----------|-------|
| Key size | 128 bits (derived from 256-bit Master Key) |
| Mode | CTR (Counter) |
| Nonce size | 8 bytes (64 bits) |
| Counter size | 8 bytes (64 bits, big-endian) |
| No padding | CTR mode does not require padding |
| IV/Counter initial value | `nonce || 0x0000000000000000` |

### 3.7 Legacy Format Detection

The auth tag was added in v0.2.0 (roadblock R1 resolution). Older ciphertexts lack the 32-byte tag and are shorter by exactly 32 bytes. Implementations can detect the format by length:

| Format | Minimum Length | Detection |
|--------|---------------|-----------|
| With auth tag (current) | 56 bytes (28 hex chars of data) | `len(data) >= 56` from raw bytes |
| Without auth tag (legacy) | 24 bytes (12 hex chars of data) | `len(data) < 56` |

> Implementations **must** support both formats for decryption. New encryptions **must** always include the auth tag.

---

## 4. Block Types (JSON Schema)

The ledger is a JSON array of block objects. Blocks are ordered chronologically — the array order *is* the chain order. Each block type has a `type` discriminator field.

```
ledger.json ::= [Block, ...]
Block ::= GenesisBlock | YearSummaryBlock | MonthSummaryBlock | DayBlock
```

Every block has these common fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | ✅ | Block type discriminator: `"genesis"`, `"year_summary"`, `"month_summary"`, `"day"` |
| `prev_hash` | string (hex) | ✅ | SHA-256-like hash of the preceding block (64 hex chars). For Genesis, `"0" * 64`. |
| `date` | string | ✅ | ISO date when this block was created: `"YYYY-MM-DD"` |
| `{type}_hash` | string (hex) | ✅ | The block's seal (HMAC-SHA256). Field name varies by type (see below). |
| `signature` | string (hex) | ⚠️ Optional | Identity signature over the block hash (HMAC-SHA256). |

---

### 4.1 Genesis Block

The first block in every ledger. Created once during `phpoc init`. Contains the user's identity, the encrypted recovery seed, and the encrypted identity secret fallback.

#### Schema

```json
{
  "type": "genesis",
  "format_version": "0.3.0",
  "day_index": 0,
  "date": "2026-01-01",
  "identity": {
    "username": "alice",
    "email": "alice@example.com",
    "recovery_seed_enc": "<hex: seed encrypted with PDK>",
    "identity_pub_key": "<hex: SHA-256 of identity secret>",
    "identity_secret_enc_fallback": "<hex: identity secret encrypted with Master Key>"
  },
  "prev_hash": "0000000000000000000000000000000000000000000000000000000000000000",
  "entries": [],
  "day_hash": "<hex: seal of this block>",
  "signature": "<hex: identity signature over day_hash>"
}
```

#### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | ✅ | Always `"genesis"` |
| `format_version` | string | ✅ | Ledger format version (e.g., `"0.3.0"`). Absence implies `"0.2.0"` (pre-spec). |
| `day_index` | integer | ✅ | Always `0` — reserved for Genesis |
| `date` | string | ✅ | Creation date (YYYY-MM-DD) |
| `identity` | object | ✅ | Identity container (see below) |
| `prev_hash` | string | ✅ | All zeros — 64 hex characters |
| `entries` | array | ✅ | Always `[]` for genesis |
| `day_hash` | string | ✅ | HMAC-SHA256 seal of this block (see §5.2) |
| `signature` | string | ⚠️ | Identity signature over `day_hash` |

#### Identity Object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `username` | string | ✅ | Display name
| `email` | string | ✅ | Contact email
| `recovery_seed_enc` | string | ✅ | Seed (base64) encrypted with PDK, hex-encoded |
| `identity_pub_key` | string | ✅ | `SHA-256(identity_secret)` as hex |
| `identity_secret_enc_fallback` | string | ✅ | Identity secret encrypted with Master Key, hex-encoded |

> The `day_hash` field name on a genesis block is a historical convention — it uses the same field name as Day blocks, not a `genesis_hash` field. Implementations should treat `day_hash`, `year_hash`, and `month_hash` uniformly as "the seal of this block."

---

### 4.2 Year Summary Block

An optional marker block inserted when a sync crosses a year boundary (e.g., syncing entries on 2026-01-03 when the last block was dated 2025-12-31). It carries no entries — its purpose is to partition the chain.

#### Schema

```json
{
  "type": "year_summary",
  "year": 2025,
  "prev_hash": "<hex: previous block's hash>",
  "date": "2026-01-03",
  "year_hash": "<hex: seal of this block>",
  "signature": "<hex: identity signature>"
}
```

#### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | ✅ | Always `"year_summary"` |
| `year` | integer | ✅ | The year being closed (e.g., `2025`) |
| `prev_hash` | string | ✅ | Hash of the preceding block |
| `date` | string | ✅ | Date of the *next* sync (not the year end) |
| `year_hash` | string | ✅ | HMAC-SHA256 seal of this block |
| `signature` | string | ⚠️ | Identity signature over `year_hash` |

**Insertion condition:** Created when `curr_date.year > prev_date.year` and the previous block is not already a year_summary.

**Partition point:** The year summary serves as a clean cut point for splitting or archiving the chain. Because it has a `year_hash` that the next block references via `prev_hash`, the chain can be split here — the segment before remains fully verifiable, and the segment after is independently verifiable starting from this block (see §9.4.5).

---

### 4.3 Month Summary Block

An optional marker block inserted when a sync crosses a month boundary. Like the year summary, it partitions the chain with no entries.

#### Schema

```json
{
  "type": "month_summary",
  "month": "2025-12",
  "prev_hash": "<hex: previous block's hash>",
  "date": "2026-01-03",
  "month_hash": "<hex: seal of this block>",
  "signature": "<hex: identity signature>"
}
```

#### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | ✅ | Always `"month_summary"` |
| `month` | string | ✅ | The month being closed in `YYYY-MM` format |
| `prev_hash` | string | ✅ | Hash of the preceding block |
| `date` | string | ✅ | Date of the *next* sync |
| `month_hash` | string | ✅ | HMAC-SHA256 seal of this block |
| `signature` | string | ⚠️ | Identity signature over `month_hash` |

**Insertion condition:** Created when `curr_date.month > prev_date.month` and the previous block is not already a month_summary.

**Partition point:** Like the year summary, the month summary is a clean cut point for splitting or archiving the chain. The same mechanics apply — the chain can be split at any summary block boundary, year or month (see §9.4.5).

---

### 4.4 Day Block

The primary data block. Contains a list of entries for a single date. Created during each sync operation.

#### Schema

```json
{
  "type": "day",
  "day_index": 42,
  "date": "2026-01-15",
  "prev_hash": "<hex: previous block's hash>",
  "entries": [
    { "hash": "<hex>", "data": { ... } },
    { "hash": "<hex>", "data": { ... } }
  ],
  "day_hash": "<hex: seal of this block>",
  "signature": "<hex: identity signature>"
}
```

#### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | ✅ | Always `"day"` (or absent — day is the default type) |
| `day_index` | integer | ✅ | Monotonically increasing counter (`1`-based). Resets to `1` after a summary block. |
| `date` | string | ✅ | Date of the entries: `YYYY-MM-DD` |
| `prev_hash` | string | ✅ | Hash of the preceding block (summary or previous day) |
| `entries` | array | ✅ | Array of entry objects (see §4.5). May be empty. |
| `day_hash` | string | ✅ | HMAC-SHA256 seal of this block |
| `signature` | string | ⚠️ | Identity signature over `day_hash` |

> **`day_index` semantics:** The index increments monotonically across consecutive day blocks. When a summary block (year or month) intervenes, the next day block resets to `1`. This lets verifiers detect missing day blocks within a summary period.

---

### 4.5 Entry

An individual activity record stored inside a Day block's `entries` array. Each entry consists of a `hash` (integrity check) and `data` (the actual content).

#### Schema

```json
{
  "hash": "<hex: SHA-256 of JSON-sorted data>",
  "data": {
    "title": "Guitar Practice",
    "duration": 3600000,
    "is_active": false,
    "is_paused": false,
    "startTime_enc": "<hex ciphertext>",
    "endTime_enc": "<hex ciphertext>",
    "pauses_enc": "<hex ciphertext>",
    "metadata_enc": "<hex ciphertext>",
    "tags": ["music", "learning"],
    "media": [],
    "content_hash": "<hex: SHA-256 of canonical plaintext>",
    "comment": "Practiced scales and arpeggios"
  }
}
```

#### Entry-level Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `hash` | string (hex) | ✅ | `SHA-256(json.dumps(data, sort_keys=True))` — see §5.4 |
| `data` | object | ✅ | The entry payload (see below) |

#### Data Fields

| Field | Type | Required | Encrypted? | Description |
|-------|------|----------|------------|-------------|
| `title` | string | ✅ | No (ref impl) | Activity name (e.g., `"Guitar Practice"`). Plaintext for blind indexing. |
| `duration` | integer | ✅ | No | Active duration in milliseconds (wall time minus pauses) |
| `is_active` | boolean | ✅ | No | Whether the task is still running (staging only; always `false` in ledger) |
| `is_paused` | boolean | ✅ | No | Whether the task is currently paused (staging only; always `false` in ledger) |
| `startTime_enc` | string | ✅ | ✅ | Encrypted epoch milliseconds as string (e.g., `"1714000000000"`) |
| `endTime_enc` | string, null | ⚠️ | ✅ | Encrypted epoch milliseconds, or `null` if task was never ended |
| `pauses_enc` | string | ✅ | ✅ | Encrypted JSON array of pause objects |
| `metadata_enc` | string | ✅ | ✅ | Encrypted JSON object (arbitrary metadata) |
| `tags` | array[string] | ✅ | No | Sorted list of lowercase, deduplicated tags (e.g., `["learning", "music"]`) |
| `media` | array | ✅ | No | Array of media references (strings). Currently a stub — reserved for future use. |
| `content_hash` | string (hex) | ⚠️ | No | SHA-256 of canonical plaintext representation — see §6 |
| `comment` | string | ❌ | No | Free-text comment. Optional, may be absent. |
| `device_id_enc` | string | ✅ | ✅ | Opaque device identifier (AES-CTR encrypted). Reveals nothing to an attacker. |
| `transitions_enc` | string | ❌ | ✅ | Encrypted action trail — present when a task was paused/unpaused/ended by a different device than the one that started it (see below). Optional. |
| `device_proof` | string (hex) | ❌ | No | HMAC-SHA256 device attribution proof. `HMAC(device_secret, "entry:" + entry_index)`. Only the authorized user can recompute and attribute. Optional. |

#### Transition Object Format (inside `transitions_enc`)

When a task is paused, unpaused, or ended by a different device than the one that started it, each action is recorded as a transition. The entire array is encrypted as a single block:

```json
[
  {
    "action": "pause",
    "ts_enc": "<hex ciphertext>",
    "device_id_enc": "<hex ciphertext>"
  },
  {
    "action": "end",
    "ts_enc": "<hex ciphertext>",
    "device_id_enc": "<hex ciphertext>"
  }
]
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | string | ✅ | One of `"pause"`, `"resume"`, `"end"` |
| `ts_enc` | string | ✅ | Encrypted epoch milliseconds of the action |
| `device_id_enc` | string | ✅ | Encrypted device identifier of the device that performed the action |

> **Purpose:** The transitions trail enables auditability — the user can later determine which device paused a running task or ended it. Both `ts_enc` and `device_id_enc` use randomized per-entry encryption (different nonce each time), so they leak nothing to an attacker.

#### Pause Object Format (inside `pauses_enc`)

```json
[
  {
    "pause_index": 1,
    "pause_start": 1714000000000,
    "pause_stop": 1714001800000,
    "comment": "Phone call"
  },
  {
    "pause_index": 2,
    "pause_start": 1714003600000,
    "pause_stop": null
  }
]
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `pause_index` | integer | ✅ | 1-based index of this pause interval |
| `pause_start` | integer | ✅ | Epoch milliseconds when pause began |
| `pause_stop` | integer, null | ✅ | Epoch milliseconds when pause ended, or `null` if ongoing |
| `comment` | string | ❌ | Reason for the pause |

> **Note on `endTime_enc` vs `duration`:** `duration` is the *active* time (wall time minus pauses). It can be computed from `startTime_enc`, `endTime_enc`, and `pauses_enc`. The stored `duration` is a cache for fast display.

---

### 4.6 Block Type Summary

| Block Type | type value | Hash Field | Inserted | Contents |
|------------|------------|------------|----------|----------|
| Genesis | `"genesis"` | `day_hash` | On `init` | Identity, encrypted seed, identity fallback |
| Year Summary | `"year_summary"` | `year_hash` | On year boundary | `year`, `prev_hash` |
| Month Summary | `"month_summary"` | `month_hash` | On month boundary | `month`, `prev_hash` |
| Day | `"day"` (or absent) | `day_hash` | On every sync | Entries array, `day_index`, `date` |

---

## 5. Chain Validation

The ledger chain is validated in two passes: **structural** (block linkage, seals) and **content-level** (entry hashes, content hashes).

### 5.1 prev_hash Linkage

The chain is a singly-linked list where each block references the previous block's hash. The hash of a block is the value of its type-specific hash field:

| Block Type | Hash Field |
|------------|------------|
| Genesis | `day_hash` |
| Year Summary | `year_hash` |
| Month Summary | `month_hash` |
| Day | `day_hash` |

**Validation rule:** For every block at index `i > 0`:

```
prev_hash(block[i]) == hash_field(block[i-1])
```

Where `hash_field(block)` resolves to `block["day_hash"]`, `block["year_hash"]`, or `block["month_hash"]` depending on `block["type"]`.

**Genesis rule:** `block[0]["prev_hash"]` must equal `"0" * 64` (64 zero hex characters).

### 5.2 Block Sealing (HMAC-SHA256)

Every block carries a cryptographic **seal** — an HMAC-SHA256 computed over the block's content with the seal field itself and the `signature` field excluded.

The seal is computed using the **sealing sub-key** derived from the Master Key:

```python
import hmac, hashlib, json

def compute_seal(block: dict, master_key: bytes) -> str:
    # Determine the hash field for this block type
    hash_key = {
        "genesis": "day_hash",
        "year_summary": "year_hash",
        "month_summary": "month_hash",
        "day": "day_hash",
    }.get(block.get("type", "day"))
    
    # Exclude the seal field and the identity signature
    check_data = {k: v for k, v in block.items() if k not in (hash_key, "signature")}
    
    # Canonical JSON (sorted keys, no extra whitespace)
    data_str = json.dumps(check_data, sort_keys=True)
    
    # Derive sealing sub-key (fixed salt)
    seal_key = hmac.new(master_key, b"integrity-key-salt", hashlib.sha256).digest()
    
    # Compute HMAC
    return hmac.new(seal_key, data_str.encode('utf-8'), hashlib.sha256).hexdigest()
```

**Validation rule:** `compute_seal(block, master_key) == block[hash_key]`

> The sealing sub-key is distinct from encryption/integrity sub-keys because it uses a fixed salt (`b"integrity-key-salt"`) rather than a per-operation random salt.

### 5.3 Identity Signatures

When the identity secret is available (see §2.7.2), each block may carry an identity signature over its seal:

```python
def compute_signature(block_hash: str, identity_secret: bytes) -> str:
    return hmac.new(identity_secret, block_hash.encode('utf-8'), hashlib.sha256).hexdigest()

# Verify:
#   compute_signature(block[hash_key], identity_secret) == block["signature"]
```

**Validation rule:** If the block has a `signature` field (non-empty) and the identity secret is available, verify that the signature matches. If the identity secret is unavailable, skip signature verification.

> **On signature absence:** Signatures are optional. A valid ledger may have unsigned blocks. Verification should succeed whether or not signatures are present — treat missing signatures as "skip" rather than "fail."

### 5.4 Entry Hash Verification

Each entry in a Day block's `entries` array has a `hash` field computed as:

```python
def compute_entry_hash(data: dict) -> str:
    return hashlib.sha256(
        json.dumps(data, sort_keys=True).encode()
    ).hexdigest()
```

**Validation rule:** For every entry in every Day block:

```
compute_entry_hash(entry["data"]) == entry["hash"]
```

This ensures that no part of an entry's data (encrypted or plaintext) has been altered. Changing any field — a single byte in a ciphertext, a tag value, a duration — will change the entry hash.

### 5.5 Content Hash Verification

The content hash (`content_hash` in `entry["data"]`) is an optional integrity check that survives re-encryption. While the entry hash (§5.4) would change if ciphertext fields are re-encrypted (e.g., by a different key), the content hash is computed from **plaintext values** and remains stable.

#### Algorithm (v0.4.0+)

Starting with format v0.4.0, the content hash uses an **extensible algorithm** that iterates over **all** keys in the entry's data dict. This means any future fields added to the activity object are automatically covered without a spec update:

```python
def compute_content_hash(entry_data: dict, decrypt_fn) -> str:
    """Compute extensible content hash from all entry data fields.

    Iterates all keys in the entry's data dict:
    - Fields ending in ``_enc`` are decrypted via *decrypt_fn*
    - List fields are sorted for deterministic output
    - The ``content_hash`` field itself is excluded
    - All other fields are included as-is

    ``sort_keys=True`` normalizes JSON key ordering, making the hash
    independent of insertion order.
    """
    content = {}
    for key, value in entry_data.items():
        if key == "content_hash":
            continue
        if key.endswith("_enc") and value is not None and value != "":
            content[key] = decrypt_fn(value)
        elif isinstance(value, list):
            content[key] = sorted(value)
        else:
            content[key] = value
    return hashlib.sha256(
        json.dumps(content, sort_keys=True).encode()
    ).hexdigest()
```

> **For ledgers at v0.3.0 or earlier**, the legacy algorithm (hardcoded 9-field canonical dict, described in §6) is used instead. See §9.3 for version detection.

#### Validation rule

If `content_hash` is present in `entry["data"]`:

```
compute_content_hash(entry["data"], decrypt) == entry["data"]["content_hash"]
```

If `content_hash` is absent, skip this check (legacy entries).

#### Why Two Hashes?

| Hash | Scope | Changes on re-encryption? | Extensible? | Purpose |
|------|-------|--------------------------|-------------|---------|
| `entry.hash` | Encrypted data dict | ✅ Yes | ✅ Auto (covers all keys) | Tamper detection of stored data |
| `entry.data.content_hash` | Plaintext values | ❌ No | ✅ Auto (v0.4.0+) | Proof of content that survives key rotation |

Both hashes should be verified during a full chain check.

### 5.6 Full Verification Algorithm

```python
def verify(ledger: list, master_key: bytes, identity_secret: bytes = None) -> bool:
    for i in range(1, len(ledger)):
        current = ledger[i]
        prev = ledger[i - 1]
        
        # 5.1: Check prev_hash linkage
        prev_hash = _get_block_hash(prev)  # day_hash, year_hash, or month_hash
        if current["prev_hash"] != prev_hash:
            return False
        
        # 5.2: Check block seal
        if not _verify_seal(current, master_key):
            return False
        
        # 5.3: Check identity signature (if available)
        if identity_secret and current.get("signature"):
            if not _verify_signature(current, identity_secret):
                return False
        
        # 5.4 & 5.5: Check entry hashes and content hashes
        if current.get("type", "day") == "day":
            for entry in current.get("entries", []):
                if not _verify_entry_hash(entry):
                    return False
                if "content_hash" in entry["data"]:
                    if not _verify_content_hash(entry["data"], master_key):
                        return False
    
    return True
```

> **Performance note (v0.4.0+):** The extensible content hash decrypts **all** `*_enc` fields in the data dict — including any future ones. For large ledgers with many encrypted fields, implementations may wish to make this an opt-in deep check. Legacy (pre-v0.4.0) content hashes only decrypt the four standard fields (`startTime_enc`, `endTime_enc`, `metadata_enc`, `pauses_enc`).

---

## 6. Content Hash Algorithm

The content hash is a SHA-256 digest of a canonical plaintext representation of an entry. It survives re-encryption because it is computed from resolved plaintext values, not from ciphertext.

The algorithm used depends on the ledger's format version:

| Format Version | Algorithm | Coverage |
|----------------|-----------|----------|
| v0.3.0 and earlier | Legacy (hardcoded 9 fields) | Fixed set: startTime, endTime, metadata, pauses, tags, comment, media, title, duration |
| v0.4.0+ | Extensible (iterates all keys) | **All** data fields, including any future additions |

### 6.1 Extensible Algorithm (v0.4.0+)

The extensible algorithm iterates over **all** keys in the entry's data dict, making it automatically forward-compatible with any future fields:

```python
def compute_content_hash(entry_data: dict, decrypt_fn) -> str:
    """Compute extensible content hash from all entry data fields.

    - Fields ending in ``_enc`` are decrypted via *decrypt_fn*
    - List fields are sorted for deterministic output
    - The ``content_hash`` field itself is excluded
    - All other fields are included as-is

    ``sort_keys=True`` normalizes JSON key ordering.
    """
    content = {}
    for key, value in entry_data.items():
        if key == "content_hash":
            continue
        if key.endswith("_enc") and value is not None and value != "":
            content[key] = decrypt_fn(value)
        elif isinstance(value, list):
            content[key] = sorted(value)
        else:
            content[key] = value
    return hashlib.sha256(
        json.dumps(content, sort_keys=True).encode()
    ).hexdigest()
```

**General normalization rules:**

| Aspect | Rule |
|--------|------|
| `*_enc` fields | Decrypted via *decrypt_fn* before inclusion |
| List fields (e.g., `tags`, `media`) | Sorted alphabetically |
| `content_hash` | Excluded (prevents circular dependency) |
| All other fields | Included as-is (strings, numbers, booleans, nulls) |
| Key ordering | `sort_keys=True` normalizes to alphabetical order |

> This hash is stable across key rotation, re-encryption, and format version changes — as long as the plaintext values are identical, the content hash will be identical.

### 6.2 Legacy Algorithm (pre-v0.4.0)

Ledgers at format version v0.3.0 or earlier use a hardcoded 9-field canonical dict. This algorithm is **not extensible** — any fields added beyond the predefined set are ignored by the content hash.

#### Canonical Dict Construction

```python
def build_content_dict(data: dict, decrypted: PlaintextValues) -> dict:
    return {
        "title": data.get("title", ""),
        "startTime": str(decrypted.start_epoch),
        "endTime": decrypted.end_time_string,  # "" if absent
        "metadata": decrypted.metadata_json,    # "{}" if empty
        "pauses": decrypted.pauses_json,        # "[]" if absent
        "tags": sorted(data.get("tags", [])),
        "comment": data.get("comment", ""),
        "media": sorted(data.get("media", [])),
        "duration": data.get("duration", 0),
    }
```

**Normalization rules:**

| Field | Normalization |
|-------|---------------|
| `startTime` | Epoch milliseconds as string (e.g., `"1714000000000"`) |
| `endTime` | Epoch milliseconds as string, or empty string `""` if no end time |
| `metadata` | Raw JSON string as stored (e.g., `"{\"note\":\"Great\"}"`), or `"{}"` |
| `pauses` | Raw JSON string of pause array, or `"[]"` |
| `tags` | Sorted alphabetically |
| `comment` | Empty string `""` if absent |
| `media` | Sorted alphabetically |
| `duration` | Integer milliseconds |

#### Algorithm

```python
def compute_content_hash_legacy(
    title: str,
    start_epoch: int,
    end_time_str: str,       # epoch ms as string, or ""
    metadata_json: str,      # serialized JSON
    pauses_json: str,        # serialized JSON
    tags: list,
    comment: str,
    media: list,
    duration: int
) -> str:
    content = {
        "title": title,
        "startTime": str(start_epoch),
        "endTime": end_time_str if end_time_str else "",
        "metadata": metadata_json if metadata_json else "{}",
        "pauses": pauses_json if pauses_json else "[]",
        "tags": sorted(tags),
        "comment": comment if comment else "",
        "media": sorted(media),
        "duration": duration,
    }
    return hashlib.sha256(
        json.dumps(content, sort_keys=True).encode()
    ).hexdigest()
```

> **Migration note:** Existing ledgers can be upgraded to v0.4.0 using the migration script (`scripts/migrate_format_version.py`), which recomputes all content hashes using the new algorithm and cascades the resulting changes through the full chain.

---

## 7. Blind Index

The blind index (`index.json`) is an optional auxiliary file that enables fast reputation queries without decrypting entry data. It stores per-date, per-title duration aggregates.

### 7.1 Format

```json
{
  "2026-01-01": {
    "Guitar Practice": 3600000,
    "Reading": 1800000
  },
  "2026-01-02": {
    "Guitar Practice": 2700000,
    "Coding": 7200000
  }
}
```

Top-level keys are ISO dates (`YYYY-MM-DD`). Values are objects mapping activity titles to total active duration in milliseconds for that date.

### 7.2 Update Rules

- **On sync:** For each entry being synced, add its `duration` to `index[date][title]`.
- **On revert:** Subtract the reverted entry's `duration` from `index[date][title]`. If the result is zero or negative, remove the title entry. If the date dict becomes empty, remove the date entry.
- **On re-sync:** Same as first sync — durations are additive.

### 7.3 Query Protocol

The blind index supports queries without decryption:

```
> phpoc rep 30
--- Reputation Summary ---
Coding: 7200m
Guitar Practice: 5400m
Reading: 1200m
```

Filter by date range by iterating over index keys:

```python
def query_index(index: dict, from_date: str, to_date: str) -> dict:
    result = {}
    for date_str, activities in index.items():
        if from_date and date_str < from_date:
            continue
        if to_date and date_str > to_date:
            continue
        for title, duration in activities.items():
            result[title] = result.get(title, 0) + duration
    return result
```

### 7.4 Rebuilding from Chain

Since the blind index is a derived cache, it can be rebuilt from the ledger chain:

```python
def rebuild_index(ledger: list, master_key: bytes) -> dict:
    index = {}
    for block in ledger:
        if block.get("type", "day") != "day":
            continue
        for entry in block.get("entries", []):
            data = entry["data"]
            # Decrypt timestamps to determine date
            start_val = decrypt(data["startTime_enc"], master_key)
            start_epoch = int(start_val)
            date_str = time.strftime("%Y-%m-%d", time.gmtime(start_epoch // 1000))
            title = data["title"]
            duration = data["duration"]
            
            if date_str not in index:
                index[date_str] = {}
            index[date_str][title] = index[date_str].get(title, 0) + duration
    return index
```

> **Privacy note:** The blind index reveals activity titles and total durations per date, but not exact timestamps or metadata. This is the trade-off for fast, no-decryption queries.

---

## 8. Staging Area

The staging area (`staging.json`) is a **transient, mutable** buffer for entries that have not yet been synced to the immutable ledger. It is not part of the canonical ledger format — its structure is an implementation detail of the reference CLI.

### 8.1 Format

```json
[
  {
    "hash": "<hex: SHA-256 of data dict>",
    "data": {
      "title": "Guitar Practice",
      "duration": 0,
      "is_active": true,
      "is_paused": false,
      "startTime_enc": "plain:1714000000000",
      "endTime_enc": null,
      "pauses_enc": "plain:[]",
      "metadata_enc": "plain:{}",
      "tags": ["music"],
      "media": []
    },
    "start_epoch": 1714000000000
  }
]
```

### 8.2 `plain:` Prefix Convention

Staging entries use a special `plain:` prefix on encrypted fields instead of real ciphertext. This allows:

- **Viewing** entries without authentication (the CLI uses `NoAuthCryptoManager` for `add` commands)
- **Editing** entries without re-encryption (end times, comments)
- **Decrypting** by stripping the `plain:` prefix and using the value as-is

```python
def decrypt_staging_field(value: str) -> str:
    if value.startswith("plain:"):
        return value[6:]
    return decrypt(value)  # real decryption
```

### 8.3 Sync Pipeline

During sync, staging entries are:

1. **Normalized** — any stray encrypted data (from a revert or stale context) is decrypted back to `plain:` format. If decryption fails, the entry is skipped with a warning.
2. **Encrypted** — `plain:` prefix is replaced with real AES-CTR + auth tag ciphertext.
3. **Content hashed** — `content_hash` is computed from resolved plaintext and added to the data.
4. **Packed** — grouped by date and written into Day blocks in the ledger.
5. **Removed** — synced entries (and any marked for removal) are deleted from staging.

### 8.4 Staging vs Ledger

| Aspect | Staging | Ledger |
|--------|---------|--------|
| Mutable? | ✅ Yes (add, edit, delete) | ❌ No (append-only after creation) |
| Encrypted? | ❌ `plain:` prefix | ✅ Real AES-CTR + auth tag |
| Authenticated? | ❌ No (anyone can read) | ✅ Yes (requires Master Key) |
| Transient? | ✅ Yes (deleted after sync) | ❌ No (persistent) |
| Canonical? | ❌ No | ✅ Yes |

> The staging format is **not** part of the PHPOC protocol specification. Implementations may use any internal buffer for unsynced entries. The `plain:` convention and JSON array format described here are specific to the reference CLI and provided for interoperability.

### 8.5 Multi-Device Remote Staging

In a multi-device setup, staging is **shared across devices** via a remote transport. The remote blob is the authoritative source; local staging is a cache.

#### Timeline Model

Staging entries are timestamped and additive. Since real-world tasks don't start or end at the same millisecond on two devices, there are no write conflicts. No session cookie, no mutual exclusion, no eviction.

**Workflow:**

```
check device_id → re-auth if mismatch → modify local → push to remote → pull remote → local == remote
```

1. Device A auths → derives device ID from MK → compares with remote blob's `device_id_enc`. Mismatch? Re-auth. Match? Proceed.
2. Device A appends entry to local staging → serializes → encrypts obfuscation blob → pushes via transport → pulls back → local and remote are identical.
3. Device B auths → device ID mismatch → re-auth → pulls remote blob → merges entries from all devices (sorted by timestamp) → appends new entry → pushes.

#### Remote Blob Structure

The shared staging blob is a single encrypted file stored on the remote:

```json
{
  "device_id_enc": "<hex: encrypted device identifier>",
  "staging": [ ...entries... ],
  "version": 1
}
```

| Field | Type | Description |
|-------|------|-------------|
| `device_id_enc` | string (hex) | Encrypted opaque device ID of the last device that touched staging. Local device checks this on every interaction; re-auth if mismatch. |
| `staging` | array | Array of staging entries (same format as §8.1) from all devices, merged by timestamp. |
| `version` | integer | Schema version for forward compatibility. Currently `1`. |

#### Transport Interface

```python
class AbstractStagingTransport(ABC):
    @abstractmethod
    def pull(self, remote_path: str) -> bytes: ...
    @abstractmethod
    def push(self, remote_path: str, data: bytes) -> None: ...
```

Minimal two-method interface. Git is the first implementation with the blob stored at `staging/blobs/` in the remote repo. Additional transports (HTTP, local network) can be implemented behind the same interface.

#### Blob Obfuscation

The serialized staging blob is obfuscated before being pushed to the remote:

```
Serialized JSON → pad to next class ceiling (random fill) → encrypt → push to remote
```

Fixed-size tiers keep the blob size constant for a given usage level, preventing traffic analysis:

| Class | Max Plaintext |
|-------|---------------|
| 64K | Very light usage |
| 128K | Light usage |
| 256K | Moderate usage |
| 512K | Heavy usage (lengthy comments) |

Random filler bytes pad actual data to the next class ceiling before encryption. Cross-class transitions (e.g., 64K→128K) leak one bit of information (a threshold was crossed), but once in a class the daily size is stable.

#### Offline Behavior

- Device writes entries to **local cache** when offline.
- On reconnect: push queued entries → pull remote blob → merge (appended by timestamp, no conflict).
- On `sync` (staging → ledger): entries for days already committed by another device are silently discarded with a warning.

#### Device Attribution in Staging

Staging entries carry the same `device_id_enc` and `transitions_enc` fields as ledger entries (see §4.5). These are populated at staging time (using `plain:` prefix for unencrypted staging) and encrypted into real ciphertext at sync time.

---

## 9. Implementation Considerations

### 9.1 Handling `plain:` Prefix

The `plain:` prefix appears in staging entries and in entries restored via `revert`. Implementations importing staging entries must handle both formats:

```python
def resolve_field(value: str) -> str:
    """Return the plaintext value regardless of format."""
    if value is None:
        return ""
    if value.startswith("plain:"):
        return value[6:]
    # Real encrypted ciphertext — requires decryption
    return decrypt(value)
```

After sync, all `plain:` prefixes are replaced with real ciphertext in the ledger.

### 9.2 Legacy Ciphertext (No Auth Tag)

As described in [§3.7](#37-legacy-format-detection), ciphertexts created before the auth tag was added lack the final 32-byte HMAC tag. Implementations must detect and handle both formats:

| Age | Wire Format | Detection |
|-----|-------------|-----------|
| Current | `salt(16) + nonce(8) + ciphertext + tag(32)` | `len(bytes) >= 56` |
| Legacy (pre-R1) | `salt(16) + nonce(8) + ciphertext` | `len(bytes) < 56` |

> **Backward compatibility:** New encryptions always include the auth tag. Legacy ciphertexts without the tag are still decryptable — the tag is verified only when present.

### 9.3 Format Evolution & Versioning

Every ledger has an explicit format version stored in the genesis block's `format_version` field (added in v0.3.0 of the spec). This field is **included in the block seal** (see §5.2), making it cryptographically binding.

#### Version Detection

| Version | Detection |
|---------|-----------|
| **0.2.0** | Implicit — genesis has no `format_version` field. Pre-spec ledgers created before this document. |
| **0.3.0** | Explicit — `format_version` present in genesis. Uses hardcoded 9-field content hash algorithm (§6.2). |
| **0.4.0+** | Explicit — `format_version` present in genesis. Uses extensible content hash algorithm (§6.1). |

#### Feature to Version Mapping

| Feature | Version Added | Detection |
|---------|---------------|-----------|
| Auth tag (encrypt-then-MAC) | v0.2.0 | Ciphertext length ≥ 56 bytes |
| `content_hash` (legacy, 9-field) | v0.2.0 | Presence of field in entry data; `format_version < 0.4.0` |
| `identity_secret_enc_fallback` | v0.2.0 | Presence of field in genesis identity |
| `pauses_enc` | v0.3.0 | Presence of field in entry data |
| `tags`, `media` | v0.3.0 | Presence of fields in entry data |
| `format_version` (explicit) | v0.3.0 | Presence of field in genesis |
| `content_hash` (extensible, all-keys) | v0.4.0 | Presence of field in entry data; `format_version >= 0.4.0` |

#### Policy for Future Changes

- New fields must be optional (absent = old format)
- Old ledgers must remain readable without migration
- Encryption/decryption must accept both old and new wire formats
- `format_version` in genesis MUST be updated when backward-incompatible changes are made
- The content hash algorithm (v0.4.0+) automatically covers new data fields without requiring spec updates or version bumps for simple field additions

#### One-Time Migration (v0.2.0 → v0.3.0)

Ledgers created before this spec (implicit v0.2.0) can be upgraded by adding `format_version` to genesis. Because `format_version` is included in the block seal, adding it changes `day_hash`, which **cascades through the entire chain**:

Ledgers created before this spec (implicit v0.2.0) can be upgraded by adding `format_version` to genesis. Because `format_version` is included in the block seal, adding it changes `day_hash`, which **cascades through the entire chain**:

```python
def upgrade_020_to_030(ledger: list, master_key, identity_secret=None) -> list:
    """One-time migration: add format_version to genesis, recompute all seals."""
    genesis = dict(ledger[0])
    genesis["format_version"] = "0.2.0"  # version this ledger was actually created with
    
    new_ledger = [genesis]
    for i in range(1, len(ledger)):
        block = dict(ledger[i])
        # Update prev_hash to match the newly-sealed previous block
        prev_block = new_ledger[-1]
        prev_hash = _get_block_hash(prev_block)  # day_hash, year_hash, or month_hash
        block["prev_hash"] = prev_hash
        # Recompute this block's seal with the updated prev_hash
        block[hash_key] = compute_seal(block, master_key)
        if identity_secret and block.get("signature"):
            block["signature"] = compute_signature(block[hash_key], identity_secret)
        new_ledger.append(block)
    
    return new_ledger
```

> **Note:** This migration rewrites every block in the ledger. For small single-user ledgers this is instantaneous. The `format_version` is set to `"0.2.0"` (the version the data was actually created with), not the current spec version — this preserves accurate provenance.

A standalone migration script is provided at `scripts/migrate_format_version.py`. Run with `--help` for usage details.

#### Migration (v0.3.0 → v0.4.0)

Ledgers at format v0.3.0 can be upgraded to v0.4.0 to adopt the extensible content hash algorithm. This migration:

1. **Bumps** `format_version` in genesis from `"0.3.0"` to `"0.4.0"`
2. **Recomputes** every entry's `content_hash` using the new all-keys algorithm (§6.1)
3. **Recomputes** every entry's `hash` (the entry hash covers the data dict, which includes `content_hash`)
4. **Cascades** through all block seals — changed entries → changed day blocks → changed prev_hash linkage → changed seals throughout the entire chain

The migration script at `scripts/migrate_format_version.py` handles this automatically:

```bash
# Preview changes
python3 scripts/migrate_format_version.py --dry-run

# Apply migration (writes to ledger.json.migrated)
python3 scripts/migrate_format_version.py

# Apply in-place (creates ledger.json.bak backup)
python3 scripts/migrate_format_version.py --in-place
```

> **Backward compatibility:** After migration, the `verify()` function checks `format_version` to select the correct content hash algorithm. Old ledgers without the migration remain fully verifiable using the legacy algorithm.

### 9.4 Edge Cases

#### 9.4.1 `endTime_enc` is `null`
An entry with `endTime_enc: null` means the task was started but never explicitly ended. The `duration` field should reflect whatever active time was captured. Display logic should show the task as "in progress" or with a missing end time.

#### 9.4.2 Empty `entries` Array
A Day block with `entries: []` is valid but unusual — it would only occur if a sync operation was triggered with no completed entries. Verifiers should accept empty entry lists.

#### 9.4.3 Consecutive Summary Blocks
If a ledger is synced infrequently, multiple summary blocks may appear consecutively (e.g., a year summary followed immediately by a month summary if crossing both boundaries in one sync). This is valid — the chain handles any sequence of summary/day blocks.

#### 9.4.4 `day_index` Reset
After a summary block, `day_index` resets to `1`. Verifiers should check that `day_index` increments by 1 between consecutive day blocks, but should not fail if a gap exists (e.g., due to a revert or skipped sync day).

#### 9.4.5 Chain Splitting at Summary Boundaries

The chain can be split at any summary block boundary (year or month). This is the foundation for archiving (splitting off old data into a separate file) and portable export (extracting a verifiable segment).

**Mechanics:**

A summary block is a full chain link:

```
... ──▶ [Prev Block]
              │
              │  prev_hash = <prev block's hash>
              ▼
        [Summary Block]     ← cut point
              │
              │  next block's prev_hash = summary's {year|month}_hash
              ▼
        [Next Block] ──▶ ...
```

Splitting at the summary block produces two independently verifiable segments:

| Segment | Contents | Verifies? |
|---------|----------|-----------|
| **Left (active)** | Genesis → ... → Summary block | ✅ `prev_hash` chain is intact from genesis through the summary |
| **Right (archive/export)** | Summary block → Next block → ... | ✅ Summary's `prev_hash` links to omitted predecessor (but segment starts with a valid seal) |

**Practical implications:**

- **Archiving by year:** Cut at the year summary block for the boundary year. The active ledger ends with the year summary; the archived file starts with it.
- **Archiving by month:** Same mechanism, cut at a month summary block instead. Useful for finer-grained partitioning.
- **Portable export:** Extract a range of blocks that includes the anchor (boundary) summary block. The recipient verifies the segment's internal chain without needing the full ledger.
- **Verification after split:** The remaining chain is fully verifiable — the summary block at the cut point still has a valid seal and a `prev_hash` pointing to the block before it.

### 9.5 Security Considerations

- **The Seed is the root secret.** Losing the Seed means permanent data loss. The passphrase only protects the Seed at rest.
- **Auth tag verification must happen before decryption** to prevent timing attacks on the HMAC comparison.
- **Sub-key separation** ensures that compromising one sub-key (e.g., the encryption key for one entry) does not reveal the Master Key or other sub-keys.
- **The blind index leaks activity titles and total daily durations.** It should not be shared without considering what information it reveals.

---

## 10. Appendix: Example Ledger

Below is a complete annotated ledger with three blocks: Genesis, Month Summary, and a Day block containing two entries. Cryptographic values are replaced with descriptive placeholders for readability.

### Block 0: Genesis

```json
{
  "type": "genesis",
  "format_version": "0.3.0",
  "day_index": 0,
  "date": "2026-04-01",
  "identity": {
    "username": "alice",
    "email": "alice@example.com",
    "recovery_seed_enc": "<hex: 32-byte seed encrypted with passphrase-derived key>",
    "identity_pub_key": "<hex: SHA-256 of identity secret>",
    "identity_secret_enc_fallback": "<hex: identity secret encrypted with Master Key>"
  },
  "prev_hash": "0000000000000000000000000000000000000000000000000000000000000000",
  "entries": [],
  "day_hash": "abc123def456...",
  "signature": "sig_abc123..."
}
```

**Notes:**
- `prev_hash` is 64 zero-hex characters, marking this as the root block.
- `day_index` is always `0` for genesis.
- `entries` is always an empty array.
- `day_hash` is the HMAC-SHA256 seal of this block (see §5.2).
- `signature` is over `day_hash` using the identity secret.

---

### Block 1: Month Summary

Inserted because the first sync happened in a different month from genesis creation.

```json
{
  "type": "month_summary",
  "month": "2026-04",
  "prev_hash": "abc123def456...",
  "date": "2026-05-01",
  "month_hash": "def456abc123...",
  "signature": "sig_def456..."
}
```

**Notes:**
- `prev_hash` references the genesis `day_hash`.
- `month` is the month being closed (`2026-04`), not the new month.
- `date` is the date of the *next* sync (`2026-05-01`), not the month end.
- No `entries` field — summary blocks carry no data.

---

### Block 2: Day

```json
{
  "type": "day",
  "day_index": 1,
  "date": "2026-05-01",
  "prev_hash": "def456abc123...",
  "entries": [
    {
      "hash": "a1b2c3d4...",
      "data": {
        "title": "Morning Meditation",
        "duration": 1200000,
        "is_active": false,
        "is_paused": false,
        "startTime_enc": "<hex: ciphertext of '1714514400000'>",
        "endTime_enc": "<hex: ciphertext of '1714515600000'>",
        "pauses_enc": "<hex: ciphertext of '[]'>",
        "metadata_enc": "<hex: ciphertext of '{"mood":"calm"}'>",
        "device_id_enc": "<hex: ciphertext of opaque device ID>",
        "device_proof": "<hex: HMAC for device attribution>",
        "tags": ["mindfulness", "morning"],
        "media": [],
        "content_hash": "f1e2d3c4...",
        "comment": "Felt well-rested"
      }
    },
    {
      "hash": "b2c3d4e5...",
      "data": {
        "title": "Deep Work Session",
        "duration": 5400000,
        "is_active": false,
        "is_paused": false,
        "startTime_enc": "<hex: ciphertext of '1714516200000'>",
        "endTime_enc": "<hex: ciphertext of '1714523400000'>",
        "pauses_enc": "<hex: ciphertext of '[" +
          "{\"pause_index\":1,\"pause_start\":1714518000000,\"pause_stop\":1714518300000,\"comment\":\"Water break\"}," +
          "{\"pause_index\":2,\"pause_start\":1714521000000,\"pause_stop\":1714521300000}" +
        "]'>",
        "metadata_enc": "<hex: ciphertext of '{"project":"feature-X"}'>",
        "device_id_enc": "<hex: ciphertext of opaque device ID>",
        "device_proof": "<hex: HMAC for device attribution>",
        "tags": ["coding", "work"],
        "media": [],
        "content_hash": "g3h4i5j6...",
        "comment": null
      }
    }
  ],
  "day_hash": "789abc012def...",
  "signature": "sig_789abc..."
}
```

**Notes:**
- `day_index` is `1` — the first day block after a summary block (reset).
- `prev_hash` references the month summary's `month_hash`.
- Each entry's `hash` is `SHA-256` of its `data` dict (sorted keys).
- `content_hash` is `SHA-256` of the canonical plaintext (see §6) — stable across re-encryption.
- `startTime_enc` and `endTime_enc` contain encrypted epoch ms strings.
- `pauses_enc` contains the encrypted JSON array of pause objects.
- `metadata_enc` contains the encrypted JSON metadata object.
- The second entry has two pauses: a 5-minute water break and an uncommented 5-minute break.
- The second entry has `comment: null` — showing that optional fields may be explicitly null.
- Both entries include `device_id_enc` (encrypted device identifier) and `device_proof` (HMAC attribution key) — default fields in multi-device setups. In single-device mode these fields may be absent.
- Transitions (`transitions_enc`) are omitted here since both entries were created and ended on the same device. See §4.5 for transition format.

---

### Chain Integrity Summary

```
Block 0 (genesis):   day_hash   = abc123def456...
                     prev_hash  = 000000000000... (root)
                         │
                         ▼ (referenced by prev_hash)
Block 1 (month):     month_hash = def456abc123...
                     prev_hash  = abc123def456...  ✓ matches genesis day_hash
                         │
                         ▼ (referenced by prev_hash)
Block 2 (day):       day_hash   = 789abc012def...
                     prev_hash  = def456abc123...  ✓ matches month_summary month_hash
                     entries[0].hash = SHA-256(entries[0].data)  ✓ self-consistent
                     entries[1].hash = SHA-256(entries[1].data)  ✓ self-consistent
```

> **Verification:** Any consumer with the Master Key and (optionally) the identity secret can traverse this chain and independently verify every seal, signature, entry hash, and content hash. No external state or network access required.

---

*End of PHPOC Format Specification v0.3.0* 
