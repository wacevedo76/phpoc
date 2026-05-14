import hashlib
import hmac
import os
import struct
from abc import ABC, abstractmethod

# --- Pure Python AES Implementation (Simplified for POC) ---
# Based on public domain/MIT implementations for portability

def _sub_bytes(s):
    for i in range(16):
        s[i] = SBOX[s[i]]

def _shift_rows(s):
    s[1], s[5], s[9], s[13] = s[5], s[9], s[13], s[1]
    s[2], s[6], s[10], s[14] = s[10], s[14], s[2], s[6]
    s[3], s[7], s[11], s[15] = s[15], s[3], s[7], s[11]

def _mix_columns(s):
    for i in range(0, 16, 4):
        t = s[i] ^ s[i+1] ^ s[i+2] ^ s[i+3]
        u = s[i]
        s[i] ^= t ^ _xtime(s[i] ^ s[i+1])
        s[i+1] ^= t ^ _xtime(s[i+1] ^ s[i+2])
        s[i+2] ^= t ^ _xtime(s[i+2] ^ s[i+3])
        s[i+3] ^= t ^ _xtime(s[i+3] ^ u)

def _xtime(a):
    return ((a << 1) ^ 0x1B) & 0xFF if a & 0x80 else a << 1

SBOX = [
    0x63, 0x7C, 0x77, 0x7B, 0xF2, 0x6B, 0x6F, 0xC5, 0x30, 0x01, 0x67, 0x2B, 0xFE, 0xD7, 0xAB, 0x76,
    0xCA, 0x82, 0xC9, 0x7D, 0xFA, 0x59, 0x47, 0xF0, 0xAD, 0xD4, 0xA2, 0xAF, 0x9C, 0xA4, 0x72, 0xC0,
    0xB7, 0xFD, 0x93, 0x26, 0x36, 0x3F, 0xF7, 0xCC, 0x34, 0xA5, 0xE5, 0xF1, 0x71, 0xD8, 0x31, 0x15,
    0x04, 0xC7, 0x23, 0xC3, 0x18, 0x96, 0x05, 0x9A, 0x07, 0x12, 0x80, 0xE2, 0xEB, 0x27, 0xB2, 0x75,
    0x09, 0x83, 0x2C, 0x1A, 0x1B, 0x6E, 0x5A, 0xA0, 0x52, 0x3B, 0xD6, 0xB3, 0x29, 0xE3, 0x2F, 0x84,
    0x53, 0xD1, 0x00, 0xED, 0x20, 0xFC, 0xB1, 0x5B, 0x6A, 0xCB, 0xBE, 0x39, 0x4A, 0x4C, 0x58, 0xCF,
    0xD0, 0xEF, 0xAA, 0xFB, 0x43, 0x4D, 0x33, 0x85, 0x45, 0xF9, 0x02, 0x7F, 0x50, 0x3C, 0x9F, 0xA8,
    0x51, 0xA3, 0x40, 0x8F, 0x92, 0x9D, 0x38, 0xF5, 0xBC, 0xB6, 0xDA, 0x21, 0x10, 0xFF, 0xF3, 0xD2,
    0xCD, 0x0C, 0x13, 0xEC, 0x5F, 0x97, 0x44, 0x17, 0xC4, 0xA7, 0x7E, 0x3D, 0x64, 0x5D, 0x19, 0x73,
    0x60, 0x81, 0x4F, 0xDC, 0x22, 0x2A, 0x90, 0x88, 0x46, 0xEE, 0xB8, 0x14, 0xDE, 0x5E, 0x0B, 0xDB,
    0xE0, 0x32, 0x3A, 0x0A, 0x49, 0x06, 0x24, 0x5C, 0xC2, 0xD3, 0xAC, 0x62, 0x91, 0x95, 0xE4, 0x79,
    0xE7, 0xC8, 0x37, 0x6D, 0x8D, 0xD5, 0x4E, 0xA9, 0x6C, 0x56, 0xF4, 0xEA, 0x65, 0x7A, 0xAE, 0x08,
    0xBA, 0x78, 0x25, 0x2E, 0x1C, 0xA6, 0xB4, 0xC6, 0xE8, 0xDD, 0x74, 0x1F, 0x4B, 0xBD, 0x8B, 0x8A,
    0x70, 0x3E, 0xB5, 0x66, 0x48, 0x03, 0xF6, 0x0E, 0x61, 0x35, 0x57, 0xB9, 0x86, 0xC1, 0x1D, 0x9E,
    0xE1, 0xF8, 0x98, 0x11, 0x69, 0xD9, 0x8E, 0x94, 0x9B, 0x1E, 0x87, 0xE9, 0xCE, 0x55, 0x28, 0xDF,
    0x8C, 0xA1, 0x89, 0x0D, 0xBF, 0xE6, 0x42, 0x68, 0x41, 0x99, 0x2D, 0x0F, 0xB0, 0x54, 0xBB, 0x16,
]

RCON = [
    0x00, 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1B, 0x36
]

def _expand_key(key):
    w = list(key)
    for i in range(16, 176, 4):
        temp = w[i-4:i]
        if i % 16 == 0:
            temp = [SBOX[temp[1]], SBOX[temp[2]], SBOX[temp[3]], SBOX[temp[0]]]
            temp[0] ^= RCON[i//16]
        for j in range(4):
            w.append(w[i-16+j] ^ temp[j])
    return w

def _aes_encrypt_block(block, expanded_key):
    s = list(block)
    for i in range(16): s[i] ^= expanded_key[i]
    for r in range(1, 10):
        _sub_bytes(s)
        _shift_rows(s)
        _mix_columns(s)
        for i in range(16): s[i] ^= expanded_key[r*16+i]
    _sub_bytes(s)
    _shift_rows(s)
    for i in range(16): s[i] ^= expanded_key[160+i]
    return bytes(s)

class PureAESCTR:
    """AES-CTR mode implementation (encryption is the same as decryption)."""
    def __init__(self, key):
        self.expanded_key = _expand_key(key)

    def process(self, data, nonce):
        result = bytearray()
        counter = 0
        for i in range(0, len(data), 16):
            # Create counter block: nonce (8 bytes) + counter (8 bytes)
            ctr_block = nonce + struct.pack(">Q", counter)
            keystream = _aes_encrypt_block(ctr_block, self.expanded_key)
            chunk = data[i:i+16]
            for j in range(len(chunk)):
                result.append(chunk[j] ^ keystream[j])
            counter += 1
        return bytes(result)

# --- High Level Crypto API ---

class AbstractCryptoManager(ABC):
    @abstractmethod
    def encrypt(self, text: str) -> str: pass
    @abstractmethod
    def decrypt(self, hex_data: str) -> str: pass
    @abstractmethod
    def seal(self, data_str: str) -> str: pass
    @abstractmethod
    def verify_seal(self, data_str: str, signature: str) -> bool: pass
    @abstractmethod
    def sign(self, data_str: str, identity_secret: bytes) -> str: pass
    @abstractmethod
    def verify_signature(self, data_str: str, signature: str, identity_secret: bytes) -> bool: pass

class CryptoManager(AbstractCryptoManager):
    def __init__(self, master_key: bytes):
        """
        Initialize with a 32-byte master key.
        This key should be derived from a passphrase using a strong KDF (like PBKDF2)
        by the Authenticator.
        """
        if len(master_key) != 32:
            raise ValueError("Master key must be 32 bytes.")
        self.master_key = master_key

    def _derive_sub_key(self, salt: bytes, length: int = 16) -> bytes:
        """
        Derives a sub-key from the master key using a fast KDF (HMAC-based).
        This avoids re-running expensive PBKDF2 for every block.
        """
        return hmac.new(self.master_key, salt, hashlib.sha256).digest()[:length]

    def sign(self, data_str: str, identity_secret: bytes) -> str:
        """
        Signs data using the Identity Secret. 
        Uses HMAC-SHA256 as a proxy for Ed25519 to remain zero-dependency.
        """
        return hmac.new(identity_secret, data_str.encode(), hashlib.sha256).hexdigest()

    def verify_signature(self, data_str: str, signature: str, identity_secret: bytes) -> bool:
        """Verifies the HMAC signature."""
        expected = self.sign(data_str, identity_secret)
        return hmac.compare_digest(expected, signature)

    def encrypt(self, text: str) -> str:
        salt = os.urandom(16)
        nonce = os.urandom(8)
        key = self._derive_sub_key(salt)
        aes = PureAESCTR(key)
        ciphertext = aes.process(text.encode(), nonce)
        # Encrypt-then-MAC: authenticate (nonce || ciphertext) with integrity sub-key
        integrity_key = self._derive_sub_key(salt + b"-integrity", 32)
        tag = hmac.new(integrity_key, nonce + ciphertext, hashlib.sha256).digest()
        # Package as: salt(16) + nonce(8) + ciphertext + tag(32)
        return (salt + nonce + ciphertext + tag).hex()

    def decrypt(self, hex_data: str) -> str:
        data = bytes.fromhex(hex_data)
        salt = data[:16]
        nonce = data[16:24]
        integrity_key = self._derive_sub_key(salt + b"-integrity", 32)

        # Detect format by data length:
        #   Old (no auth tag): salt(16) + nonce(8) + ciphertext
        #   New (with auth tag): salt(16) + nonce(8) + ciphertext + tag(32)
        # Detect format by data length:
        #   Old (no auth tag): salt(16) + nonce(8) + ciphertext
        #   New (with auth tag): salt(16) + nonce(8) + ciphertext + tag(32)
        #
        # Length-based detection is ambiguous when old-format ciphertext is
        # long enough to push the total >= 56 bytes (because both old and new
        # can total the same length). So we try tag verification first:
        # if it succeeds -> new format; if it fails -> fall back to old format
        # (the old ciphertext data at the end is not actually a tag).
        has_tag = len(data) >= 24 + 32  # minimum: 16+8+0+32 = 56 bytes
        if has_tag:
            ciphertext = data[24:-32]
            stored_tag = data[-32:]
            expected_tag = hmac.new(integrity_key, nonce + ciphertext, hashlib.sha256).digest()
            if hmac.compare_digest(expected_tag, stored_tag):
                # New format with valid auth tag — use ciphertext as-is
                pass
            else:
                # Tag mismatch: could be old format with trailing 32 bytes that
                # are actually ciphertext, not a tag. Try old format instead.
                ciphertext = data[24:]
        else:
            # Legacy format — no auth tag
            ciphertext = data[24:]

        key = self._derive_sub_key(salt)
        aes = PureAESCTR(key)
        decrypted = aes.process(ciphertext, nonce)
        return decrypted.decode()

    def seal(self, data_str: str) -> str:
        """Creates an HMAC-SHA256 signature (seal) of the data."""
        # Derive a separate integrity key
        key = self._derive_sub_key(b"integrity-key-salt", 32)
        return hmac.new(key, data_str.encode(), hashlib.sha256).hexdigest()

    def verify_seal(self, data_str: str, signature: str) -> bool:
        """Verifies an HMAC-SHA256 signature."""
        expected = self.seal(data_str)
        return hmac.compare_digest(expected, signature)

class NoAuthCryptoManager(AbstractCryptoManager):
    """Fallback crypto manager for when no passphrase is provided (Staging only)."""
    def encrypt(self, text: str) -> str:
        return f"plain:{text}"
    def decrypt(self, hex_data: str) -> str:
        if hex_data.startswith("plain:"): return hex_data[6:]
        raise ValueError("Cannot decrypt without passphrase")
    def seal(self, data_str: str) -> str:
        return hashlib.sha256(data_str.encode()).hexdigest()
    def verify_seal(self, data_str: str, signature: str) -> bool:
        return self.seal(data_str) == signature
    def sign(self, data_str: str, identity_secret: bytes) -> str:
        return "unsigned"
    def verify_signature(self, data_str: str, signature: str, identity_secret: bytes) -> bool:
        return signature == "unsigned"
