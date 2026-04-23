# Roadmap

PH Ledger (phpoc) — Planned features organized by design goal from DESIGN_GOALS.md.

## Legend
- ✅ = Completed
- 🔜 = Planned
- 🔮 = Future consideration

---

## 1. Cryptographic Integrity & Immutability

| Item | Status | Priority | Notes |
|---|---|---|---|
| Hierarchical Lock Chain (Genesis → Year → Month → Day → Task) | ✅ | — | Implemented, tested |
| Block signing with Ed25519-proxy (HMAC-SHA256) | ✅ | — | Every block signed |
| Verify command | ✅ | — | Full chain + entry hash verification |
| Tamper detection | ✅ | — | Any modification breaks downstream chain |
| **Real Ed25519 signatures** (move beyond HMAC proxy) | 🔮 | Low | Requires cryptography package; current proxy is zero-dep |
| **Hardware-backed identity (TPM/SE)** | 🔮 | Low | Future-proofing for mobile/embedded |

---

## 2. Privacy & Anti-Forensics

| Item | Status | Priority | Notes |
|---|---|---|---|
| Encrypted timestamps (AES-CTR) | ✅ | — | startTime_enc, endTime_enc |
| Encrypted metadata (AES-CTR) | ✅ | — | metadata_enc in every entry |
| Blind duration index (index.json) | ✅ | — | Reputation queries without decryption |
| Recovery Seed with encryption (PDK) | ✅ | — | Seed encrypted with passphrase-derived key |
| **Media Witness linkage** | 🔜 | High | Content hashes linked to activities — see below |
| **Plausible deniability mode** | 🔮 | Low | Decoy passphrase reveals fake history |

---

## 3. Scalability & Durability

| Item | Status | Priority | Notes |
|---|---|---|---|
| Partitionable chain design | ✅ | — | Each block independently sealed |
| Year/Month summary blocks | ✅ | — | I/O optimization for partial traversals |
| **Archival automation** (`phpoc archive --year X`) | 🔜 | Medium | Move old years to separate file |
| **Reconciliation / Chain-Bridging** | 🔜 | Medium | Restore chain from orphaned blocks |
| **Remote sync** (`sync/git_sync.py`) | 🔜 | Medium | Git-backed encrypted backup |
| **Database backend** (SQLite, etc.) | 🔮 | Low | Via AbstractLedgerStore |
| **Multi-device sync** (CRDT-based) | 🔮 | Low | Conflict-free merging across devices |

---

## 4. User Experience & Accessibility

| Item | Status | Priority | Notes |
|---|---|---|---|
| Lazy authentication (RAM cache) | ✅ | — | Once-per-boot passphrase |
| Staging area (plain-text NoAuth) | ✅ | — | Quick task entry without auth |
| Active task view (`phpoc view`) | ✅ | — | Shows running tasks with start time |
| List with source filtering (`all/synced/staged`) | ✅ | — | Added in current working tree |
| Reputation with date range (`--from`/`--to`) | ✅ | — | Blind index filtered queries |
| **Tab-completion / auto-suggest** | 🔮 | Low | Shell completions for titles |
| **Django web interface** | 🔮 | Low | Via modular headless engine |
| **Mobile app (React Native)** | 🔮 | Low | Via modular headless engine |
| **Export to CSV/JSON (decrypted)** | 🔮 | Low | For interoperability |

---

## 5. Recovery & Identity

| Item | Status | Priority | Notes |
|---|---|---|---|
| Recovery Seed generation (256-bit) | ✅ | — | 32 bytes urandom → base64 |
| Seed → Master Key derivation | ✅ | — | Direct SHA-256 of seed bytes |
| Passphrase-based seed unlock | ✅ | — | PBKDF2(passphrase) → AES decrypt seed |
| `phpoc recover` command | ✅ | — | Seed → new passphrase → re-seal Genesis |
| Identity file (identity.json) | ✅ | — | Encrypted secret + pub key |
| **Single-file export** (`phpoc export --combined`) | 🔮 | Low | Merge identity into Genesis for portability |
| **Multi-identity support** (aliases/permissions) | 🔮 | Low | Multiple signing keys per ledger |
| **AI-agent verifiable reports** | 🔮 | Low | Signed third-party verification of habits |

---

## Detailed Backlog

### 🔜 High Priority — Next Up

#### Media Linkage
Link content hashes (SHA-256 of video/audio/photos) to specific activities.

**Design sketch:**
```json
{
  "title": "Guitar Practice",
  "media_hashes_enc": "encrypted[sha256_hash1, sha256_hash2]"
}
```

**In scope:**
- Content Integrity: Prove a piece of media was created during a tracked activity
- Portable: Hashes stored encrypted alongside activity metadata
- Verifiable: Third parties can check content hash matches without decrypting

**Not in scope (yet):**
- File storage / content hosting (just hash linking)
- Thumbnail generation

---

### 🔜 Medium Priority

#### Reconciliation Logic (Chain-Bridging)
Link orphaned activity blocks back to a master genesis.

**Use case:** User has activity blocks from a previous/external system; wants to graft them into the ledger without losing the chain of trust.

**Design approach:**
- Import blocks as a new Genesis-independent sub-chain
- "Bridge" block links the orphaned chain tail to the main chain head
- Verify import: check each block's seal, then seal the bridge

#### Remote Sync (git-based)
Backup signed ledger blocks to a git remote.

**Design approach:**
- Encrypt ledger JSON before commit (or commit as-is since it's already encrypted)
- Push to private git repo (GitHub, GitLab, self-hosted)
- `phpoc sync --remote` pushes, `phpoc sync --pull` pulls

#### Archival Automation
Move old year data to separate file.

**Design approach:**
- `phpoc archive --year 2024` → creates `archive_2024.json`
- Strip corresponding blocks from `ledger.json`
- Insert chain-break marker with year summary hash
- Verify still works: provide archive file path for full chain check

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
- Web/mobile interfaces are separate packages

### Testing Philosophy
- RAM-backed disk tests for speed
- Test against real file I/O (no mocking storage layer)
- Verify chain integrity after every modification
- Test recovery flow with known seeds for determinism
