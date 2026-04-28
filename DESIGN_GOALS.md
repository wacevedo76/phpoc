# PH Ledger (phpoc) — Design Goals

This document outlines the core architectural and security mandates for the Personal History Ledger (phpoc).
Each goal cross-references the [Roadmap](ROADMAP.md) for planned features and
[Roadmap Blocks](ROADMAP-BLOCKS.md) for unresolved issues that block or impact that goal.

---

## 1. Cryptographic Integrity & Immutability

- **Hierarchical Chain of Trust:** A nested hash chain where the Genesis hash locks the Year, the Year locks the Month, the Month locks the Day, and the Day locks individual Tasks.
- **Self-Bootstrapping:** The ledger is a "living object" where each block's validity depends on the previous block's seal.
- **Tamper Evidence:** Any modification to historical records triggers a verification failure across the entire downstream chain.
- **Real Ed25519 Signatures:** Move beyond the current HMAC-SHA256 proxy to real Ed25519 key pairs, enabling third-party verifiability and portable identity across devices. ([Roadmap: Real Ed25519](ROADMAP.md#1-cryptographic-integrity--immutability)) — **No block.**
- **Third-Party Verifiability:** A signed ledger export can be verified by anyone holding the public key, without revealing the passphrase or private key. Supports the "Right to Share" by providing irrefutable proof of authentic data.
- **Non-Habit Activity Support:** The existing ledger data model supports any activity type (social events, family time, creative work, etc.) through flexible `tags`, `comment`, and `media` fields. No structural changes needed.
- **Media Witness Linkage:** Content hashes (SHA-256 of video/audio/photos) linked to specific activities, proving a piece of media was created during a tracked activity. ([Roadmap: Media Witness](ROADMAP.md#1-cryptographic-integrity--immutability)) — **No block.**

### Blocked By
| Block ID | Issue | Impacts |
|---|---|---|
| [R1](ROADMAP-BLOCKS.md#-r1--aes-ctr-malleability-no-authentication-tag) | AES-CTR malleability (no auth tag) | Reconciliation, Remote Sync |
| [R2](ROADMAP-BLOCKS.md#-r2--identity-file-identityjson-has-no-in-ledger-fallback) | Identity file has no in-ledger fallback | Single-file export, Remote Sync |

---

## 2. Privacy & Anti-Forensics

- **Zero-Knowledge Architecture:** Only the user with the master passphrase can decrypt data; the system itself has no "backdoor."
- **Pattern-of-Life Protection:** Sensitive timestamps (`startTime`, `endTime`) are encrypted to prevent profiling. "Blind Indexing" is used to allow reputation queries without exposing exact timing to bad actors.
- **Encrypted Metadata:** All activity-specific details are secured at rest, including in the local staging area.
- **Per-Entry Shareability (planned):** An optional `is_public` flag on each entry, included in the hash for tamper-proofing, enabling selective export of shareable activities. Supports the "Right to Share" — you control the narrative, verifiably.
- **Shareable Export (planned):** A `phpoc export --public` command that walks the ledger, collects `is_public` entries, strips encrypted fields, and produces a signed JSON file a third party can verify. The output format mirrors the concepts from Personal History's verifiable journal.

### Blocked By
| Block ID | Issue | Impacts |
|---|---|---|
| [R1](ROADMAP-BLOCKS.md#-r1--aes-ctr-malleability-no-authentication-tag) | AES-CTR malleability (no auth tag) | Export integrity guarantees |

---

## 3. Scalability & Durability

- **Partitionable Ledger:** Supports truncation and archiving (e.g., archiving 2024 to a separate file) without breaking the cryptographic thread.
- **I/O Optimization:** Hierarchical summary hashes prevent the need to traverse the entire history for single-day verification.
- **Data Sovereignty:** The ledger is "Data-Reconstructible." If the file is lost but activity blocks are found, history can be reconstructed assuming the user has the Passphrase and Genesis root.
- **Remote Sync (planned):** Git-backed encrypted backup of the ledger, enabling cross-device access. ⚠️ [Blocked by R1, R2, R3](ROADMAP-BLOCKS.md).

### Blocked By
| Block ID | Issue | Impacts |
|---|---|---|
| [R1](ROADMAP-BLOCKS.md#-r1--aes-ctr-malleability-no-authentication-tag) | AES-CTR malleability (no auth tag) | Remote Sync |
| [R2](ROADMAP-BLOCKS.md#-r2--identity-file-identityjson-has-no-in-ledger-fallback) | Identity file has no in-ledger fallback | Remote Sync |
| [R3](ROADMAP-BLOCKS.md#-r3--pbkdf2-iteration-count-below-current-standards) | PBKDF2 iteration count below standards | Remote Sync |

---

## 4. User Experience & Accessibility (Headless Engine)

- **Lazy Authentication (RAM Caching):** Session-memory caching allows for "once-per-day" authentication, keeping daily tracking frictionless.
- **Modular Interfaces:** The core is a "Headless Engine" usable by CLI, Web (e.g., Django), or Mobile interfaces.
- **Storage Independence:** The storage layer is abstracted (`AbstractLedgerStore`) to support local JSON, SQL databases, or remote syncing.
- **General Activity Tracking:** The system is not limited to "habits." Any personal activity (meals, social events, creative work, exercise, learning, family time, etc.) can be tracked using title, tags, duration, comment, and media links. This fulfills the original Personal History vision of a complete life journal.
- **Shareable Proof:** A shareable export format (planned) provides a verifiable, privacy-controlled snapshot of selected life events — the practical realization of the "Right to Share."

### Blocked By
None.

---

## 5. Recovery & Identity

- **Recovery Seed:** Mitigation for lost passphrases via a user-controlled, 256-bit entropy seed (24-word/base64 equivalent).
- **Sovereign Key Model:** All encryption and sealing are rooted in the Seed. The passphrase acts only as a "Vault Key" to unlock the Seed.
- **Identity Signatures:** Every block in the ledger is signed by a local Identity Key. Currently uses HMAC-SHA256 as a zero-dependency proxy; planned upgrade to real Ed25519 for third-party verifiability.
- **Ed25519 Identity (planned):** Generate, store, and use real Ed25519 key pairs. Public key is shareable; private key is encrypted alongside the existing HMAC identity secret. Enables third-party verification of exported ledger snapshots.

### Blocked By
| Block ID | Issue | Impacts |
|---|---|---|
| [R2](ROADMAP-BLOCKS.md#-r2--identity-file-identityjson-has-no-in-ledger-fallback) | Identity file has no in-ledger fallback | Export portability, identity recovery |

---

## Cross-Reference Summary

| Block ID | Title | Priority | Blocks |
|---|---|---|---|
| [R1](ROADMAP-BLOCKS.md#-r1--aes-ctr-malleability-no-authentication-tag) | AES-CTR Malleability | 🔴 High | Reconciliation, Remote Sync, Export integrity |
| [R2](ROADMAP-BLOCKS.md#-r2--identity-file-identityjson-has-no-in-ledger-fallback) | Identity Fallback | 🔴 High | Remote Sync, Single-file export, Identity recovery |
| [R3](ROADMAP-BLOCKS.md#-r3--pbkdf2-iteration-count-below-current-standards) | KDF Strength | 🟡 Medium | Remote Sync |
| [R4](ROADMAP-BLOCKS.md#-r4--no-entry-level-content-proof-for-reconciliation) | Content Proof Design | 🟡 Medium | Reconciliation |
