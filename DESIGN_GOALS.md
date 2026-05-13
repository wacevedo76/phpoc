# PH Ledger (phpoc) — Design Goals

This document outlines the vision and core architectural mandates for the Personal History Protocol (PHPOC).
Each goal cross-references the [Roadmap](ROADMAP.md) for planned features and
[Roadmap Blocks](ROADMAP-BLOCKS.md) for unresolved issues that block or impact that goal.

See [VISION.md](VISION.md) for the full protocol pitch.

---

## 0. Protocol Vision — Platform-Free Personal Data

### The Problem

Every social platform builds a model of you — who you follow, what you click, who your friends are, what you search for. They mix everything (friends, family, ads, politics, products) into one opaque algorithm optimized for engagement, not clarity. **This mixing isn't a bug. It's the business model.**

PHPOC inverts this: **compartmentalization at the data format level**, not the UI level.

### The Solution

Personal History Protocol is an **open, encrypted, self-sovereign ledger format** for tracking what you actually *do* with your time. Not what you scroll. What you *do*.

Your ledger lives on your device. You control exactly which parts a platform can see — a date range, a blind index summary, a single activity type. A platform literally cannot mix your family feed with ads based on your practice habits, because it doesn't have both datasets.

### What This Makes Possible

- **Friends & Family — pure, no ads:** Share a read-only view of a specific section. The platform sees *only that*.
- **Finding your people — by proof, not hashtags:** *"Show me people who have logged 500+ hours of woodworking in the past 2 years."* Verifiable, not self-declared.
- **Reputation without gatekeepers:** Your ledger is a living resume. A potential collaborator verifies a signed range. No certification middleman needed.
- **Honest comparisons:** Anonymous, opt-in aggregate metrics help you gauge where you stand — without a platform mining your data.

### What This Is Not

- **Not a social network.** PHPOC is a data format. Social networks are one possible viewer.
- **Not a blockchain.** No distributed consensus, no mining, no tokens. The chain is a local cryptographic structure.
- **Not a replacement for platforms.** It's a replacement for *giving platforms everything*.

### Status

PHPOC exists as a **reference implementation** (CLI tool in pure Python, zero external deps). The next step is to extract the **format specification** so anyone can implement a reader, writer, or viewer — on mobile, on wearable, in a browser.

> **Tagline:** *"Know thyself." — and share only what you choose.*
> **Pitch:** *"Your history shouldn't be an algorithm's inventory."*

---

## 1. Cryptographic Integrity & Immutability

- **Hierarchical Chain of Trust:** A nested hash chain where the Genesis hash locks the Year, the Year locks the Month, the Month locks the Day, and the Day locks individual Tasks.
- **Self-Bootstrapping:** The ledger is a "living object" where each block's validity depends on the previous block's seal.
- **Tamper Evidence:** Any modification to historical records triggers a verification failure across the entire downstream chain.
- **Real Ed25519 Signatures:** Move beyond the current HMAC-SHA256 proxy to real Ed25519 key pairs, enabling third-party verifiability and portable identity across devices. ([Roadmap: Real Ed25519](ROADMAP.md#6-recovery--identity)) — **No block.**
- **Third-Party Verifiability:** A signed ledger export can be verified by anyone holding the public key, without revealing the passphrase or private key. Supports the "Right to Share" by providing irrefutable proof of authentic data.
- **Non-Habit Activity Support:** The existing ledger data model supports any activity type (social events, family time, creative work, etc.) through flexible `tags`, `comment`, and `media` fields. No structural changes needed.
- **Media Witness Linkage:** Content hashes (SHA-256 of video/audio/photos) linked to specific activities, proving a piece of media was created during a tracked activity. ([Roadmap: Media Witness](ROADMAP.md#3-privacy--anti-forensics)) — **No block.**

### Blocked By
| Block ID | Issue | Impacts |
|---|---|---|
| ~~[R1](ROADMAP-BLOCKS.md#-r1--aes-ctr-malleability-no-authentication-tag)~~ | ~~AES-CTR malleability (no auth tag)~~ | ✅ Resolved — encrypt-then-MAC added |
| ~~[R2](ROADMAP-BLOCKS.md#-r2--identity-file-identityjson-has-no-in-ledger-fallback)~~ | ~~Identity file has no in-ledger fallback~~ | ✅ Resolved — genesis fallback embedded |

---

## 2. Privacy & Anti-Forensics

- **Zero-Knowledge Architecture:** Only the user with the master passphrase can decrypt data; the system itself has no "backdoor."
- **Pattern-of-Life Protection:** Sensitive timestamps (`startTime`, `endTime`) are encrypted to prevent profiling. "Blind Indexing" is used to allow reputation queries without exposing exact timing to bad actors.
- **Encrypted Metadata:** All activity-specific details are secured at rest, including in the local staging area.
- **Per-Entry Shareability (planned):** An optional `is_public` flag on each entry, included in the hash for tamper-proofing, enabling selective export of shareable activities. Supports the "Right to Share" — you control the narrative, verifiably.
- **Shareable Export (planned):** A `phpoc export --range` command that produces a standalone, verifiable chain segment. The output format mirrors the concepts from Personal History's verifiable journal.

### Blocked By
| Block ID | Issue | Impacts |
|---|---|---|
| ~~[R1](ROADMAP-BLOCKS.md#-r1--aes-ctr-malleability-no-authentication-tag)~~ | ~~AES-CTR malleability (no auth tag)~~ | ✅ Resolved — encrypt-then-MAC added |

---

## 3. Scalability & Durability

- **Partitionable Ledger:** Supports truncation and archiving (e.g., archiving 2024 to a separate file) without breaking the cryptographic thread.
- **I/O Optimization:** Hierarchical summary hashes prevent the need to traverse the entire history for single-day verification.
- **Data Sovereignty:** The ledger is "Data-Reconstructible." If the file is lost but activity blocks are found, history can be reconstructed assuming the user has the Passphrase and Genesis root.
- **Remote Sync (planned):** Git-backed encrypted backup of the ledger, enabling cross-device access. ⚠️ [All blockers resolved](ROADMAP-BLOCKS.md#summary).

### Blocked By
| Block ID | Issue | Impacts |
|---|---|---|
| ~~[R1](ROADMAP-BLOCKS.md#-r1--aes-ctr-malleability-no-authentication-tag)~~ | ~~AES-CTR malleability (no auth tag)~~ | ✅ Resolved |
| ~~[R2](ROADMAP-BLOCKS.md#-r2--identity-file-identityjson-has-no-in-ledger-fallback)~~ | ~~Identity file has no in-ledger fallback~~ | ✅ Resolved |
| ~~[R3](ROADMAP-BLOCKS.md#-r3--pbkdf2-iteration-count-below-current-standards)~~ | ~~PBKDF2 iteration count below standards~~ | ✅ Resolved |

---

## 4. User Experience & Accessibility (Reference Implementation)

- **Lazy Authentication (RAM Caching):** Session-memory caching allows for "once-per-day" authentication, keeping daily tracking frictionless.
- **Modular Interfaces:** The core is a "Headless Engine" usable by CLI, Web (e.g., Django), or Mobile interfaces. Staging is served by `StagingService` (decoupled from view layer).
- **Storage Independence:** The storage layer is abstracted (5 split interfaces: `AbstractStagingStore`, `AbstractLedgerStore`, `AbstractIndexStore`, `AbstractIdentityStore`, `AbstractConfigStore`) to support local JSON, SQL databases, or remote syncing.
- **Device Identity:** Multi-device support via `AbstractDeviceIdentityProvider` — each device gets a random UUID4 (persisted in config) with HMAC-SHA256 proof derived from the master key.
- **Staging Merge Engine:** `MergeEngine` deduplicates cross-device entries by `(title, start_epoch)`, remote wins on ties — ensures additive, non-conflicting sync.
- **General Activity Tracking:** The system is not limited to "habits." Any personal activity (meals, social events, creative work, exercise, learning, family time, etc.) can be tracked using title, tags, duration, comment, and media links. This fulfills the original Personal History vision of a complete life journal.
- **Rich Date Filtering:** `--date`, `--week`, `--month`, `--year`, `--from`, `--to` with flexible formats and chaining via intersection.
- **Shareable Proof:** A portable export (planned) provides a verifiable, privacy-controlled snapshot of selected life events.

### Blocked By
None.

---

## 5. Recovery & Identity

- **Recovery Seed:** Mitigation for lost passphrases via a user-controlled, 256-bit entropy seed (24-word/base64 equivalent).
- **Sovereign Key Model:** All encryption and sealing are rooted in the Seed. The passphrase acts only as a "Vault Key" to unlock the Seed.
- **Identity Signatures:** Every block in the ledger is signed by a local Identity Key. Currently uses HMAC-SHA256 as a zero-dependency proxy; planned upgrade to real Ed25519 for third-party verifiability.
- **Identity Fallback:** Encrypted identity secret embedded in genesis block — ledger is self-contained and portable.
- **Ed25519 Identity (planned):** Generate, store, and use real Ed25519 key pairs. Public key is shareable; private key is encrypted alongside the existing HMAC identity secret. Enables third-party verification of exported ledger snapshots.

### Blocked By
| Block ID | Issue | Impacts |
|---|---|---|
| ~~[R2](ROADMAP-BLOCKS.md#-r2--identity-file-identityjson-has-no-in-ledger-fallback)~~ | ~~Identity file has no in-ledger fallback~~ | ✅ Resolved — genesis fallback embedded |

---

## Cross-Reference Summary

| Block ID | Title | Priority | Status | Blocks |
|---|---|---|---|---|
| R1 | AES-CTR Malleability | 🔴 High | ✅ Resolved | Reconciliation, Remote Sync, Export |
| R2 | Identity Fallback | 🔴 High | ✅ Resolved | Remote Sync, Export, Identity recovery |
| R3 | KDF Strength | 🟡 Medium | ✅ Resolved | Remote Sync |
| R4 | Content Proof | 🟡 Medium | ✅ Resolved | Reconciliation |
