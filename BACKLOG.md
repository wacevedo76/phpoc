# PH Ledger — Backlog

> Issues, features, and observations organized by priority.
>
> **Historical roadblocks (R1–R4) are marked resolved** and kept for context.
> New protocol-level items are prefixed with **P**.
>
> See [ROADMAP.md](ROADMAP.md) for the feature roadmap,
> [ROADMAP-BLOCKS.md](ROADMAP-BLOCKS.md) for blocker history,
> and [DESIGN_GOALS.md](DESIGN_GOALS.md) for architectural mandates.

---

## 🔴 P1. Format Specification (PHPSPEC.md)

**Type:** Protocol foundation
**Priority:** Highest — prerequisite for all cross-platform work
**Roadmap ref:** [§0 — Protocol Layer](ROADMAP.md#0-protocol-layer--platform-free-personal-data)
**Blocked by:** Nothing — can start now.

Extract the ledger format into a standalone specification document that anyone can implement without reverse-engineering the Python codebase.

**Scope:**
- Block types: Genesis, Year Summary, Month Summary, Day, Entry
- Block structure (JSON schema or binary layout)
- Chain validation rules (how seals chain, what breaks them)
- Encryption scheme (AES-CTR + HMAC-SHA256 auth tag)
- Key derivation: Seed → Master Key → sub-keys (encryption, integrity, identity)
- Content hash algorithm (canonical plaintext dict → SHA-256)
- Blind index format and query protocol
- Identity representation (current HMAC proxy + planned Ed25519)

**Out of scope:**
- CLI commands (separate from the format)
- Network protocol for sync (future)
- Social layer (future)

**Definition of done:**
- `PHPSPEC.md` exists in the repo root
- Covers all block types, encryption, chain validation, content hashing
- A reader unfamiliar with the Python code can implement a basic writer from the spec alone

---

## 🔴 P2. Portable Export

**Type:** Protocol primitive
**Priority:** High — needed for any cross-device or cross-person sharing
**Roadmap ref:** [§0 — Protocol Layer](ROADMAP.md#0-protocol-layer--platform-free-personal-data)
**Blocked by:** P1 (Format Spec)

A `phpoc export --range` command that produces a standalone, verifiable chain segment file.

**Scope:**
- `phpoc export --from YYYY-MM-DD --to YYYY-MM-DD` → produces a signed `.phpoc` segment
- Segment includes all blocks in the range plus the anchor block (where it links to main chain)
- Recipient can verify the segment against the user's public key without having the full ledger
- Optional: `--blind-only` exports just the blind index (minimal privacy, still verifiable)

**Not in scope:**
- Re-import of exported segments (that's Reconciliation, separate item)
- Social sharing protocol (future)

**Definition of done:**
- Export command works, produces valid chain segment
- Verification of exported segment works with `verify --segment`
- Tests cover edge cases: empty range, single day, across year boundary, encrypted vs blind-only

---

## 🔴 P3. Remote Sync (git-based)

**Type:** Infrastructure
**Priority:** High — enables laptop ↔ phone workflow
**Roadmap ref:** [§0 — Protocol Layer](ROADMAP.md#0-protocol-layer--platform-free-personal-data)
**Blocked by:** Nothing — all roadmap blockers (R1, R2, R3, R4) resolved.

Push/pull encrypted ledger blocks to/from a git remote.

**Design sketch:**
- Encrypt ledger JSON before commit (or commit as-is since it's already encrypted)
- Push to private git repo (GitHub, GitLab, self-hosted)
- `phpoc sync --remote` pushes, `phpoc sync --pull` pulls
- On pull, verify chain integrity of incoming blocks before merging

**Not in scope:**
- Conflict resolution across devices (future CRDT-based sync)
- Public sharing (future)

**Definition of done:**
- `phpoc sync --remote <url>` pushes ledger to remote
- `phpoc sync --pull` fetches and merges without breaking chain integrity
- Pulled blocks from another device pass `verify`

---

## 🟡 P4. CLI Kinks & UX Polish

**Type:** UX
**Priority:** High — CLI is the reference implementation
**Roadmap ref:** [§0 — Protocol Layer](ROADMAP.md#0-protocol-layer--platform-free-personal-data)
**Blocked by:** Nothing — can start now.

Keep iterating on the CLI until it feels solid for daily use.

**Candidate items:**
- Colored / formatted output for list, rep, view commands
- Table-aligned columns for readable listings
- Post-operation summaries ("Synced 3 entries. Chain verified.")
- `--help` text review and polish
- Error message clarity (especially around auth failures)
- Tab-completion / auto-suggest for activity titles
- Graceful handling of empty ledgers, missing files, etc.

**Definition of done:**
- Each item tracked as a separate issue/PR
- Daily-use workflow (add → view → sync → list → rep) feels polished and predictable

---

## 🟡 P5. Mobile POC (Swift / Kotlin)

**Type:** Cross-platform proof
**Priority:** Medium
**Roadmap ref:** [§0 — Protocol Layer](ROADMAP.md#0-protocol-layer--platform-free-personal-data)
**Blocked by:** P1 (Format Spec), P2 (Portable Export)

A minimal mobile implementation of the ledger format — enough to read an exported segment and write a basic entry (start + stop timer, log duration).

**Scope:**
- Minimal: read a `.phpoc` segment, display activities, verify chain
- Write: blind index entry (activity title + duration) — no full encryption needed initially
- Platform: either Swift (iOS) or Kotlin (Android) as the first target

**Not in scope:**
- Full encryption/decryption on device (can leverage platform crypto APIs)
- Sync protocol (use exported files or remote sync)
- Social features

**Definition of done:**
- Can open an exported segment from the CLI and display its entries
- Can create a new blind-indexed entry
- Chain verification passes on the mobile implementation

---

## 🟡 P6. Wearable POC (watchOS / WearOS)

**Type:** Cross-platform proof
**Priority:** Medium
**Roadmap ref:** [§0 — Protocol Layer](ROADMAP.md#0-protocol-layer--platform-free-personal-data)
**Blocked by:** P1 (Format Spec), P2 (Portable Export)

Minimal wearable companion: start/stop a timer, log duration + activity type. No full decryption needed — blind index writes only.

**Scope:**
- Single screen: pick activity title, start/stop timer
- On stop: write a blind-index-compatible entry (encrypt with device key, push to phone)
- Syncs with mobile companion via BLE or shared storage

**Not in scope:**
- Full ledger reading on watch
- Chain verification on watch

---

## 🟡 P7. Web Viewer (Static HTML/JS)

**Type:** Cross-platform proof
**Priority:** Medium
**Roadmap ref:** [§0 — Protocol Layer](ROADMAP.md#0-protocol-layer--platform-free-personal-data)
**Blocked by:** P2 (Portable Export)

A static HTML page that reads an exported `.phpoc` segment and renders it. No server needed. Works entirely client-side.

**Scope:**
- Drag-and-drop a `.phpoc` file
- Display entries in a timeline view
- Show chain verification status
- Optional: blind index summary chart

**Definition of done:**
- Single HTML file that works offline
- Renders an exported segment with all entries and chain status
- No dependencies (vanilla JS or minimal)

---

## 🟡 P8. Archival Automation

**Type:** Infrastructure
**Priority:** Medium
**Roadmap ref:** [§2 — Scalability](ROADMAP.md#2-scalability--durability)
**Blocked by:** Nothing — can start now.

`phpoc archive --year X` moves old year blocks to a separate file.

**Design sketch:**
- Extract all blocks for year X into `archive_X.json`
- Insert chain-break marker with year summary hash in main ledger
- `verify` accepts an archive path for full chain check

---

## 🟡 P9. Reconciliation / Chain-Bridging

**Type:** Infrastructure
**Priority:** Medium
**Roadmap ref:** [§2 — Scalability](ROADMAP.md#2-scalability--durability)
**Blocked by:** Nothing — all blockers (R1, R4) resolved.

Link orphaned activity blocks back to a master genesis.

**Design approach:**
- Import blocks as a new Genesis-independent sub-chain
- "Bridge" block links the orphaned chain tail to the main chain head
- Verify import: check each block's seal (with content_hash for entry-level integrity), then seal the bridge

---

## 🟡 P10. Media Witness Linkage

**Type:** Feature
**Priority:** Medium
**Roadmap ref:** [§3 — Privacy](ROADMAP.md#3-privacy--anti-forensics)
**Blocked by:** Nothing — can start now.

Link content hashes (SHA-256 of video/audio/photos) to specific activities.

**Design sketch:**
```json
{
  "title": "Guitar Practice",
  "media_hashes_enc": "encrypted[sha256_hash1, sha256_hash2]"
}
```

---

## 🟡 P11. Day-Boundary Spanning Activities

**Type:** Edge case / UX polish
**Priority:** Medium
**Roadmap ref:** [§4 — UX](ROADMAP.md#4-user-experience--accessibility-reference-implementation)
**Blocked by:** Nothing — can start now.

Activities that cross midnight (e.g., 23:30 → 03:30) are stored under their start date only.
This creates two issues:

### 1. Display Ambiguity
```
Date: 2026-04-28
  [23:30 - 03:30] Late Night Coding (240m)
```
`03:30` is the next day but there's no visual indicator. User sees "23:30 - 03:30" and may misinterpret.

### 2. Date Filter Misses Spanning Entries
`list synced --date 2026-04-29` would **not** show the activity above,
even though 4 hours of it happened on the 29th. The filter checks the day-block's date
("2026-04-28"), not the entry's end time.

**Potential fixes (choose one or combine):**
- **A — Display marker only:** Detect cross-day entries, append `⏭` or `(next day)`
- **B — Include spanning entries in filters:** When filtering by date range, also peek at
the previous day and include entries whose end date falls within range
- **C — Split at sync time:** Split crossing entries into two (one per day), like Toggl/Clockify

**Notes:**
- Fix A is trivial (`_print_entry` in `cli/interface.py`)
- Fix B requires decrypting entry timestamps during the filter pass (slightly more work,
still cheap)
- Fix C changes the sync data model (most invasive, cleanest result)

---

## 🔮 Future Items (Low Priority)

| ID | Item | Notes |
|---|---|---|
| F1 | Real Ed25519 signatures | Requires external crypto package |
| F2 | Shareable Export (`--public`) | Verifiable public snapshot of selected entries |
| F3 | Single-file export (`--combined`) | Merge identity into Genesis |
| F4 | Multi-device sync (CRDT) | Requires Remote Sync first |
| F5 | Plausible deniability mode | Decoy passphrase → fake history |
| F6 | Tab-completion / auto-suggest | Shell completions for titles |
| F7 | Export to CSV/JSON (decrypted) | Interoperability |
| F8 | Database backend (SQLite) | Via AbstractLedgerStore |
| F9 | Django web interface | Via modular headless engine |

---

## Historical Record: Resolved Roadblocks (R1–R4)

These were the four original roadmap blockers. All resolved.

### R1. AES-CTR Malleability — No Authentication Tag

**Status:** ✅ Resolved (2026-04-28)
**Resolution:** Added encrypt-then-MAC (HMAC-SHA256) to `CryptoManager.encrypt()`/`decrypt()`. Tag over `(nonce || ciphertext)` using derived integrity sub-key. Backward compatible via byte-length detection. Raises `ValueError` on tag mismatch.

### R2. Identity File (`identity.json`) Has No In-Ledger Fallback

**Status:** ✅ Resolved (2026-04-28)
**Resolution:** Embedded encrypted identity secret in genesis block's `identity_secret_enc_fallback` field. `_get_identity_secret()` tries identity.json first, falls back to genesis. `recover` handler updates the fallback.

### R3. PBKDF2 Iteration Count Below Current Standards

**Status:** ✅ Resolved (2026-04-28)
**Resolution:** Bumped production iterations 100K → 600K in `main.py` and `security/auth.py`. Follows OWASP 2026 recommendations for PBKDF2-HMAC-SHA256.

### R4. No Entry-Level Content Proof for Reconciliation

**Status:** ✅ Resolved (2026-04-28)
**Resolution:** Added `_compute_content_hash()` — SHA-256 of canonical plaintext dict before encryption. Stored as `content_hash` per entry. Survives re-keying. `verify()` checks content_hash when present.

---

## 🐛 Bugs & Code Quality (Open)

### B1. `list_habits()` Decrypts Metadata Without Checking for `None`

**File:** `cli/interface.py` (`_print_entry`)
Uses truthiness check `if meta_enc` instead of `if meta_enc is not None`. Works in practice but fragile.

**Severity:** 🟢 Low

### B2. Hand-Rolled AES Maintenance Burden

**File:** `security/crypto.py`
Pure Python AES-CTR is ~180 lines of manually-optimized S-box operations. No side-channel resistance. Should be replaced with `cryptography`'s AES-GCM when external deps are allowed (alongside Ed25519).

**Severity:** 🟢 Low — acceptable per zero-dep commitment

### B3. Session File Has No Locking

**File:** `security/auth.py`
Two concurrent `main.py` processes could race on read/write of the cached key file.

**Severity:** 🟢 Low — unlikely in single-user CLI usage

---

## Summary by Priority

| Priority | Items |
|---|---|
| 🔴 Highest | P1 (Format Spec) |
| 🔴 High | P2 (Portable Export), P3 (Remote Sync), P4 (CLI polish) |
| 🟡 Medium | P5 (Mobile), P6 (Wearable), P7 (Web Viewer), P8 (Archive), P9 (Reconciliation), P10 (Media Witness), P11 (Day-Boundary Span) |
| 🔮 Future | F1–F9 (Ed25519, Shareable Export, CRDT sync, etc.) |
| ✅ Resolved | R1–R4 (historical roadblocks) |
| 🟢 Low | B1–B3 (cosmetic bugs) |
