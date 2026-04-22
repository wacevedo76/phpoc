# PH Ledger - Design Goals

This document outlines the core architectural and security mandates for the Personal History (PH) Ledger.

## 1. Cryptographic Integrity & Immutability
- **Hierarchical Chain of Trust:** A nested hash chain where the Genesis hash locks the Year, the Year locks the Month, the Month locks the Day, and the Day locks individual Tasks.
- **Self-Bootstrapping:** The ledger is a "living object" where each block’s validity depends on the previous block's seal.
- **Tamper Evidence:** Any modification to historical records triggers a verification failure across the entire downstream chain.

## 2. Privacy & Anti-Forensics
- **Zero-Knowledge Architecture:** Only the user with the master passphrase can decrypt data; the system itself has no "backdoor."
- **Pattern-of-Life Protection:** Sensitive timestamps (`startTime`, `endTime`) are encrypted to prevent profiling. "Blind Indexing" is used to allow reputation queries without exposing exact timing to bad actors.
- **Encrypted Metadata:** All activity-specific details are secured at rest, including in the local staging area.

## 3. Scalability & Durability
- **Partitionable Ledger:** Supports truncation and archiving (e.g., archiving 2024 to a separate file) without breaking the cryptographic thread.
- **I/O Optimization:** Hierarchical summary hashes prevent the need to traverse the entire history for single-day verification.
- **Data Sovereignty:** The ledger is "Data-Reconstructible." If the file is lost but activity blocks are found, history can be reconstructed assuming the user has the Passphrase and Genesis root.

## 4. User Experience & Accessibility (Headless Engine)
- **Lazy Authentication (RAM Caching):** Session-memory caching allows for "once-per-day" authentication, keeping daily tracking frictionless.
- **Modular Interfaces:** The core is a "Headless Engine" usable by CLI, Web (e.g., Django), or Mobile interfaces.
- **Storage Independence:** The storage layer is abstracted (`AbstractLedgerStore`) to support local JSON, SQL databases, or remote syncing.

## 5. Recovery & Identity
- **Recovery Seed:** Mitigation for lost passphrases via a user-controlled, 256-bit entropy seed (24-word/base64 equivalent).
- **Sovereign Key Model:** All encryption and sealing are rooted in the Seed. The passphrase acts only as a "Vault Key" to unlock the Seed.
- **Identity Signatures:** Every block in the ledger is signed by a local Identity Key (Ed25519-proxy), ensuring origin-authentication for multi-device synchronization.
