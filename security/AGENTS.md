# Security Module

## Purpose
All cryptographic operations for the PH Ledger — encryption/decryption, HMAC signing, key derivation, device identity, authentication, passphrase management, recovery, and config management.

## Ownership
- `crypto.py` — `CryptoManager`, `NoAuthCryptoManager`, `AbstractCryptoManager`: AES-CTR, HMAC-SHA256, pure Python implementation
- `auth.py` — Passphrase and Recovery authenticators
- `device_identity.py` — `DeviceIdentity`, `AbstractDeviceIdentityProvider`
- `recovery.py` — `RecoveryManager`: seed generation, encryption, key derivation
- `config_manager.py` — Config file management with XDG resolution

## Local Contracts
- **Zero external dependencies** — pure Python stdlib only, even for AES implementation
- Master Key = 32 bytes from base64-decoded seed via `RecoveryManager.seed_to_key`
- Encrypt-then-MAC auth tag (HMAC-SHA256) on all ciphertexts
- PBKDF2 600K iterations (OWASP 2026 standard)
- `NoAuthCryptoManager` uses `"plain:..."` prefix for staging format
- `CryptoManager` uses full encryption with auth tags for ledger entries

## Work Guidance
- Never weaken cryptographic parameters — follow OWASP standards
- All encryption must include HMAC-SHA256 auth tags
- Seed generation uses `os.urandom(32)`
- Config file path: XDG-resolved (`~/.config/phpoc/config.json` by default)
- Data directory: XDG-resolved (`~/.local/share/phpoc/` by default)

## Verification
- Tests: `test_recovery.py`, `test_recovery_verify.py`, `test_phase2_device_identity.py`, `test_phase7_config_integration.py`, `test_remote_config_wiring.py`

## Child DOX Index
None — flat directory structure.
