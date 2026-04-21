# Personal History Project: Session Handoff

## Core Mandates
- **Cross-Platform Portability:** Python-native crypto, zero binary dependencies.
- **Software-Agnostic Format:** Plain-text JSON ledger, cryptographically verifiable.
- **Privacy-First:** Encrypted sensitivity (start/stop/metadata), public metadata (titles/durations).
- **Identity:** Low-friction, passphrase-derived keys (KDF).
- **Integrity:** HMAC-based sealing, immutable historical chain.

## Current Status
- **Modular Architecture:** Project split into core, security, storage, and cli modules.
- **Features:** Active task tracking (start/end), reputation summary with date filtering, tamper detection.
- **Validation:** RAM-backed, integration-heavy `unittest` suite.

## Sync Authentication Strategies
1. **Authenticated Transport (Lowest Friction):** Rely on ledger's internal integrity (`verify()`). Accept file changes only if `verify()` passes locally.
2. **Signed-Sync (Medium Friction):** Generate a local Ed25519 identity key to sign ledger updates. Prevents unauthorized actors from pushing changes.
3. **HMAC-Challenge (Highest Friction):** Use master passphrase to generate dynamic sync tokens.

## Next Steps
- [ ] **Sync Module:** Implement `sync/git_sync.py` leveraging Strategy 2 (Signed-Sync).
- [ ] **Identity Export:** Implement command to export/import the identity keypair for multi-machine synchronization.
- [ ] **Ledger Pruning:** Define strategies for archiving historical ledger segments to manage file growth.

---
*Status: Architecture fully modularized. Ready for sync/identity implementation.*
