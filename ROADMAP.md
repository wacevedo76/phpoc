# Roadmap — Personal History Protocol (PHPOC)

PH Ledger (phpoc) — planned features organized by protocol layer.
See [VISION.md](VISION.md) for the full protocol pitch, [DESIGN_GOALS.md](DESIGN_GOALS.md) for architectural mandates,
[ROADMAP-BLOCKS.md](ROADMAP-BLOCKS.md) for blocker history, and [BACKLOG.md](BACKLOG.md) for detailed task tracking.

## Legend
- ✅ = Completed
- 🔜 = Planned
- 🔮 = Future consideration

---

## 0. Protocol Layer — Platform-Free Personal Data

The top-level goal for PHPOC: establish it as an **open data format** for portable, encrypted, self-sovereign activity history — not just a CLI tool. Multiple implementations (laptop, mobile, wearable, web viewer) all interoperate through a shared format spec.

| Item | Status | Priority | Notes |
|---|---|---|---|
| **VISION.md** — Protocol pitch written | ✅ | — | Captures the "why" and the social use cases |
| **Format Specification** (`PHPSPEC.md`) — Document the block structure, encryption scheme, chain validation, content hash algorithm, blind index, and staging area as a standalone spec | ✅ | — | Enables anyone to implement a reader/writer without reverse-engineering Python. Cross-refs: [DESIGN_GOALS §1](DESIGN_GOALS.md#1-cryptographic-integrity--immutability), [BACKLOG P1](BACKLOG.md#p1-format-specification-phpspecmd). Includes `format_version` field in genesis (§4.1), explicit versioning policy (§9.3), and one-time migration script (`scripts/migrate_format_version.py`). |
| **Portable Export** (`phpoc export --range`) — Produce a standalone, verifiable chain segment file | 🔜 | **Highest** | The primitive needed for cross-device sharing and social use cases. Chain splitting mechanics documented in [PHPSPEC §9.4.5](PHPSPEC.md#945-chain-splitting-at-summary-boundaries). Cross-refs: [DESIGN_GOALS §2](DESIGN_GOALS.md#2-privacy--anti-forensics), [BACKLOG P2](BACKLOG.md#p2-portable-export) |
| **Remote Sync (git-based)** — Push/pull encrypted ledger via git | 🔜 | **High** | Enables laptop ↔ phone sync. ✅ All blockers resolved (R1, R2, R3, R4). Cross-refs: [DESIGN_GOALS §3](DESIGN_GOALS.md#3-scalability--durability), [BACKLOG P3](BACKLOG.md#p3-remote-sync-git-based) |
| **Laptop reference implementation polish** — CLI kinks, UX improvements, reliability | 🔜 | **High** | The CLI is the first-class reference. Must be solid before downstream porting. Cross-refs: [BACKLOG P4](BACKLOG.md#p4-cli-kinks--ux-polish) |
| **Mobile POC** (Swift/Kotlin) — Minimal ledger reader/ writer | 🔮 | Medium | Proves the format works cross-platform. Blind index writes (no full decryption) for wearable. |
| **Wearable POC** (watchOS/WearOS) — Blind index writes only | 🔮 | Medium | Minimal footprint: log duration + activity type, no full decryption needed |
| **Web reader** — Static HTML/JS page that renders an exported ledger segment | 🔮 | Medium | Shareable lens into your history, no app store required |
| **Cross-device trust** — Verify chain segments signed by another device's sovereign key | 🔮 | Medium | Prerequisite for multi-device identity |
| **Social primitive: verifiable claims** — Share a signed range as proof of consistency | 🔮 | Low | "I've practiced 300+ hours this year" — verifiable without revealing content |

### Blocked By

None. No new roadblocks identified. All historical blockers (R1–R4) resolved.

---

## 1. Cryptographic Integrity & Immutability

| Item | Status | Priority | Notes |
|---|---|---|---|
| Hierarchical Lock Chain (Genesis → Year → Month → Day → Task) | ✅ | — | Implemented, tested |
| Block signing with Ed25519-proxy (HMAC-SHA256) | ✅ | — | Every block signed |
| Verify command | ✅ | — | Full chain + entry hash + content_hash verification |
| Tamper detection | ✅ | — | Any modification breaks downstream chain |
| Encrypt-then-MAC auth tag (HMAC-SHA256) | ✅ | — | Added per [R1 resolution](ROADMAP-BLOCKS.md#-r1--aes-ctr-malleability-no-authentication-tag) |
| Plaintext content hash per entry (content_hash) | ✅ | — | Added per [R4 resolution](ROADMAP-BLOCKS.md#-r4--no-entry-level-content-proof-for-reconciliation) |
| Identity fallback in genesis | ✅ | — | Added per [R2 resolution](ROADMAP-BLOCKS.md#-r2--identity-file-identityjson-has-no-in-ledger-fallback) |
| **Real Ed25519 signatures** (move beyond HMAC proxy) | 🔮 | Low | Requires cryptography package; current proxy is zero-dep. [No block](ROADMAP-BLOCKS.md) |
| **Hardware-backed identity (TPM/SE)** | 🔮 | Low | Future-proofing for mobile/embedded |

### Blocked By
None.

---

## 2. Scalability & Durability

| Item | Status | Priority | Notes |
|---|---|---|---|
| Partitionable chain design | ✅ | — | Each block independently sealed |
| Year/Month summary blocks | ✅ | — | I/O optimization for partial traversals |
| PBKDF2 600K iterations (OWASP 2026) | ✅ | — | Per [R3 resolution](ROADMAP-BLOCKS.md#-r3--pbkdf2-iteration-count-below-current-standards) |
| **Remote Sync (git-based)** | 🔜 | **High** | Listed above in §0. ✅ All blockers resolved. |
| **Archival automation** (`phpoc archive --year X`) | 🔜 | Medium | Move old years to separate file. [No block](ROADMAP-BLOCKS.md) |
| **Reconciliation / Chain-Bridging** | 🔜 | Medium | Restore chain from orphaned blocks. ✅ All blockers resolved. |
| **Database backend** (SQLite, etc.) | 🔮 | Low | Via AbstractLedgerStore |
| **Multi-device sync** (CRDT-based) | 🔮 | Low | Conflict-free merging across devices |

### Blocked By
None — all historical blockers (R1, R2, R3, R4) resolved.

---

## 3. Privacy & Anti-Forensics

| Item | Status | Priority | Notes |
|---|---|---|---|
| Encrypted timestamps (AES-CTR + auth tag) | ✅ | — | startTime_enc, endTime_enc |
| Encrypted metadata | ✅ | — | metadata_enc in every entry |
| Blind duration index (index.json) | ✅ | — | Reputation queries without decryption |
| Recovery Seed with encryption (PDK) | ✅ | — | Seed encrypted with passphrase-derived key |
| **Media Witness linkage** | 🔜 | Medium | Content hashes linked to activities. [No block](ROADMAP-BLOCKS.md) |
| **Plausible deniability mode** | 🔮 | Low | Decoy passphrase reveals fake history. [No block](ROADMAP-BLOCKS.md) |

### Blocked By
None.

---

## 4. User Experience & Accessibility (Reference Implementation)

| Item | Status | Priority | Notes |
|---|---|---|---|
| Lazy authentication (RAM cache) | ✅ | — | Once-per-boot passphrase |
| Staging area (plain-text NoAuth) | ✅ | — | Quick task entry without auth |
| Active task view (`phpoc view`) | ✅ | — | Shows running tasks with start time |
| List with source filtering (`all/synced/staged`) | ✅ | — | |
| Reputation with date range (`--from`/`--to`) | ✅ | — | Blind index filtered queries |
| Rich date filtering (`--date`, `--week`, `--month`, `--year`) | ✅ | — | Flexible formats, chaining via intersection |
| **Day-boundary spanning (display marker + filter peek)** | 🟡 | Medium | Fix A+B (ADR-020). 32 tests written, impl pending. Branch `P11-Day-Boundary-Span` |
| **Tab-completion / auto-suggest** | 🔮 | Low | Shell completions for titles |
| **Export to CSV/JSON (decrypted)** | 🔮 | Low | For interoperability |

### Blocked By
None.

---

## 5. Recovery & Identity

| Item | Status | Priority | Notes |
|---|---|---|---|
| Recovery Seed generation (256-bit) | ✅ | — | 32 bytes urandom → base64 |
| Seed → Master Key derivation | ✅ | — | Direct SHA-256 of seed bytes |
| Passphrase-based seed unlock | ✅ | — | PBKDF2(passphrase) → AES decrypt seed |
| `phpoc recover` command | ✅ | — | Seed → new passphrase → re-seal Genesis |
| Identity file (identity.json) | ✅ | — | Encrypted secret + pub key |
| Identity fallback in genesis block | ✅ | — | Per [R2 resolution](ROADMAP-BLOCKS.md#-r2--identity-file-identityjson-has-no-in-ledger-fallback) |
| **Single-file export** (`phpoc export --combined`) | 🔮 | Low | Merge identity into Genesis for portability |
| **Multi-identity support** (aliases/permissions) | 🔮 | Low | Multiple signing keys per ledger |
| **AI-agent verifiable reports** | 🔮 | Low | Signed third-party verification of habits |

### Blocked By
None.

---

## Priority Summary

| Priority | Item | Dependencies |
|---|---|---|
| ✅ Done | Format Spec (PHPSPEC.md) | — |
| 🥇 Highest | Portable Export (`export --range`) | Format Spec (done) — chain split mechanics in PHPSPEC §9.4.5 |
| 🥇 High | Remote Sync (git-based) | None — all blockers resolved |
| 🥇 High | CLI kinks & UX polish | None — can start now |
| 🥈 Medium | Mobile POC reader/writer | Format Spec, Portable Export |
| 🥈 Medium | Wearable POC (blind index writes) | Format Spec |
| 🥈 Medium | Web viewer (static HTML) | Portable Export |
| 🥈 Medium | Archival Automation | None — can start now |
| 🥈 Medium | Reconciliation / Chain-Bridging | None — all blockers resolved |
| 🥈 Medium | Media Witness linkage | None — can start now |
| 🥉 Low | Real Ed25519 signatures | External dep evaluation |
| 🥉 Low | Shareable / Single-file Export | None |
| 🥉 Low | Multi-device sync (CRDT) | Remote Sync first |
| 🥉 Low | Plausible deniability, Tab completion, etc. | None |

---

## Dev Notes

### Compatibility Policy
- **No breaking changes to existing ledgers** (v0.x → v1.0)
- New fields are always optional in existing block types
- Archive/export operations are opt-in
- File format versions tracked internally for migration tooling

### Zero-Dependency Commitment
- Core engine: 100% Python standard library
- Optional features (e.g., `git sync`) may require system git
- Web/mobile interfaces are separate packages (no constraint)

### Testing Philosophy
- RAM-backed disk tests for speed
- Test against real file I/O (no mocking storage layer)
- Verify chain integrity after every modification
- Test recovery flow with known seeds for determinism
