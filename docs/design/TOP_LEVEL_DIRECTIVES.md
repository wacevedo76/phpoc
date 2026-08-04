# Top-Level Directives — PH Ledger (phpoc)

> **Role:** This document is the first read-in for every architectural discussion,
> design decision, and code change. `SESSION_HANDOFF.md` refers here for the
> binding principles that all work must satisfy.

---

## D1 — Protocol Sovereignty

**The user owns their data. PHPOC is an open data format, not a platform.**

- The ledger lives on the user's device. No server holds the user's data — the
  server is a passive transport, not a data owner.
- The format specification (`PHPSPEC.md`) is the authoritative contract. Any
  conforming implementation can read, write, or verify a PHPOC ledger.
- No feature may require a specific platform, service, or provider to function
  core operations. Optional transports (git, HTTP, R2) are interchangeable.

**Blocks:** Platform lock-in, proprietary data models, server-held secrets.

---

## D2 — Zero-Knowledge Architecture

**Only the user can decrypt their data. The system has no backdoor.**

- All entry data (timestamps, metadata, durations, comments, media hashes) is
  encrypted at rest with AES-CTR + HMAC-SHA256 authentication tags.
- The passphrase never leaves the device. It derives a key (PBKDF2, 600K iterations)
  that unlocks the Recovery Seed stored in the genesis block.
- The Recovery Seed is the root of all cryptographic material — all sub-keys
  (encryption, integrity, identity) derive from it.
- No plaintext secrets (passphrases, seeds, keys, recovery phrases) may ever be
  logged, telemetry, or network-transmitted.

**Blocks:** Server-side decryption, admin backdoors, "we can see your data"
features.

---

## D3 — Zero External Dependencies (Core Engine)

**The core engine uses only Python 3.x standard library modules.**

- `hashlib`, `hmac`, `json`, `os`, `argparse`, `copy`, `struct`, `base64`,
  `tempfile` — no `pip install` required.
- The format must be simple enough for anyone to re-implement without a
  dependency manager.
- This constraint applies to the Python CLI core (`phpoc_cli/`, `core/`, `domain/`,
  `security/`, `storage/`). External implementations (phpoc-web, phpoc-crypto-core,
  worker) are independent packages with their own dependency policies.
- When a zero-dep constraint blocks a feature (e.g., real Ed25519 signatures),
  the feature is deferred or implemented as a proxy until the constraint is
  relaxed by an explicit directive.

**Blocks:** PyPI dependencies in core engine code, `pip install` required for
basic ledger operations.

---

## D4 — Cryptographic Chain of Trust

**Every block is signed. Every block links to its predecessor. Tampering is**
**detectable and fatal.**

- Hierarchical lock chain: Genesis → Year Summary → Month Summary → Day → Entries.
- `prev_hash` links every block to its predecessor. Breaking one link invalidates
  the entire downstream chain.
- Every block carries an identity signature (HMAC-SHA256 proxy).
- Every entry carries a `content_hash` computed over all plaintext fields
  (extensible all-keys iterator). Re-encryption does not change the content hash.
- Block signing and content hashing are mandatory. No block may lack a signature.
  No entry may lack a content hash after format v0.4.0+.
- `verify` must detect every form of tampering: modified ciphertext, replaced
  block, reordered entries, forged signatures.

**Blocks:** Unsigned blocks, unverifiable data, silent corruption.

---

## D5 — Append-Only Immutability

**The ledger is append-only truth. Never edit, delete, or rewrite historical data.**

- Blocks are added at the end of the chain. Existing blocks are never modified.
- `revert` removes contiguous blocks from the end only — preserving chain integrity
  for remaining blocks. Reverted data is restored to staging (not deleted).
- Chain splitting at summary boundaries (year/month) is the mechanism for archiving
  and portable export — not pruning from the middle.
- Migration operations (e.g., format version bumps) produce a new chain with the
  same logical data. The original is backed up, never destroyed in place.
- The chain is the source of truth. Staging is a mutable scratchpad. The blind
  index is a derived cache, always rebuildable from the chain.

**Blocks:** In-place edits, middle-of-chain deletion, destructive migrations
without backup, "soft delete" of history.

---

## D6 — Local-First Data Sovereignty

**The ledger lives on the user's device. The network is optional.**

- All core operations (add, end, list, verify, rep, recover) work fully offline.
- The local ledger is the authoritative copy. Remote sync is a convenience, not
  a requirement.
- Staging entries are captured locally without authentication. Auth is required
  only when sealing into the immutable ledger.
- The blind index is local, queried locally, and rebuildable from the local chain.
- Remote staging is an encrypted shared scratchpad — it augments local staging,
  never replaces it.

**Blocks:** "Cloud-first" architecture, requiring internet for core operations,
remote-only data stores.

---

## D7 — Compartmentalization at the Format Level

**The data format enforces separation. A viewer sees only what they are**
**authorized to see — by mathematical constraint, not policy.**

- Each entry is independently encrypted. Granting access to one entry does not
  grant access to any other.
- The Recovery Seed derives independent sub-keys for encryption, integrity, and
  identity. Compromising one sub-key does not reveal another.
- Selective sharing (export by range, by tag, blind index summaries) exposes
  only the minimum data needed for the use case.
- Platforms built on PHPOC cannot mix datasets by accident — the format prevents
  it at the cryptographic layer.

**Blocks:** Unencrypted data fields (except `title`, which is intentionally
plaintext for blind index queries), shared keys across purposes, "view everything"
permissions.

---

## D8 — Recoverability

**A user who knows their Recovery Seed can reconstruct their entire ledger from**
**genesis alone.**

- The Recovery Seed (32 bytes, base64-encoded) is the single secret a user must
  safeguard. Everything derives from it.
- The seed is encrypted with the passphrase-derived key (PDK) and stored in the
  genesis block. The genesis block is the cryptographic root of the chain.
- Identity secret is embedded in genesis as an in-ledger fallback — the ledger
  is fully self-contained and portable without external files.
- Recovery (`ph recover` or equivalent) re-seals genesis with a new passphrase
  without touching any entry data. All content hashes remain valid.
- The blind index is rebuildable from the chain. The identity file (`identity.json`)
  is reconstructible from genesis. No external file is irreplaceable.

**Blocks:** Seed-dependent external state, recovery flows that re-encrypt entries,
identity that cannot survive identity.json loss.

---

## D9 — Backward Compatibility

**No breaking changes to existing ledgers. Migration is always optional and**
**non-destructive.**

- New fields are always optional — existing blocks retain their structure.
- New format versions include explicit one-time migration scripts. Migration
  creates a backup, transforms data, and validates the result.
- Verification supports mixed-version ledgers (try-both approach for content
  hashes, fallback for legacy `day_hash` in genesis).
- The `format_version` field in genesis enables tooling to detect and handle
  versioned ledgers.
- Archive/export operations are opt-in. The default behavior preserves all data.

**Blocks:** Breaking schema changes, mandatory migrations, silent format drift.

---

## D10 — Testing Integrity

**Every change is verified. Tests are the gatekeeper.**

- Chain integrity is verified after every modification in tests.
- Recovery flow is tested with known deterministic seeds.
- The test suite must pass before any change is considered complete.
- New features require new tests. Bug fixes require regression tests.
- File-based storage tests use real I/O (RAM-backed or temp dirs) — storage
  layer is not mocked away.

**Blocks:** Untested code, silent regressions, mock-only storage tests.

---

## D11 — Staging/Ledger Separation

**Staging is always separate from the ledger. At no time is staging embedded into the**
**ledger. The ledger is staging-free.**

- Staging is a mutable scratchpad for active and uncommitted entries. The ledger
  is the immutable record of committed history.
- The only path from staging to ledger is explicit user action: review, decide,
  and commit. No automated or implicit promotion.
- Exporting, verifying, or listing the ledger must never include staging entries.
  Staging entries have no `content_hash`, no block seal, no chain linkage — they
  are structurally incompatible with the ledger.
- The `plain:` prefix in staging entries signals their uncommitted state. An entry
  with `plain:` fields must never appear in a day block, and an entry in a day block
  must never carry `plain:` fields.
- When committing, staging entries are encrypted and sealed into a new day block
  appended to the chain. The staging entries are removed from staging. This is a
  move operation, not a copy.

**Blocks:** Automated staging-to-ledger promotion, ledger exports containing
staging entries, staging data appearing inside sealed blocks, "unified"
staging+ledger views that blur the boundary.

---

## Cross-Reference

| Directive | Primary Docs |
|---|---|
| D1 — Protocol Sovereignty | `VISION.md`, `PHPSPEC.md`, DESIGN_GOALS §0 |
| D2 — Zero-Knowledge | ADR-001, ADR-002, ADR-013, DESIGN_GOALS §2 |
| D3 — Zero External Deps | ADR-006 |
| D4 — Chain of Trust | ADR-007, ADR-005, ADR-002, DESIGN_GOALS §1 |
| D5 — Append-Only | ADR-010, ADR-012, DESIGN_GOALS §3 |
| D6 — Local-First | ADR-009, ADR-014, ADR-015, DESIGN_GOALS §3 |
| D7 — Compartmentalization | ADR-001, ADR-013, ADR-008, DESIGN_GOALS §2 |
| D8 — Recoverability | ADR-001, ADR-003, DESIGN_GOALS §5 |
| D9 — Backward Compat | ADR-011, ADR-005, ROADMAP §Compatibility Policy |
| D10 — Testing Integrity | ROADMAP §Testing Philosophy |
| D11 — Staging/Ledger Separation | ADR-009, ADR-015, DESIGN_GOALS §4 |

---

## Decision Checklist

When making an architectural decision, confirm:

- [ ] Does this keep the user in control of their data? (D1)
- [ ] Does this preserve zero-knowledge — can the system still not read user data? (D2)
- [ ] Does this avoid adding external dependencies to the core engine? (D3)
- [ ] Does this maintain cryptographic integrity — can the chain still be verified end-to-end? (D4)
- [ ] Is this append-only — no editing, deleting, or rewriting history? (D5)
- [ ] Does this work offline — can the user do this without internet? (D6)
- [ ] Does this preserve compartmentalization — one key, one purpose? (D7)
- [ ] Can a user recover from genesis alone with the seed? (D8)
- [ ] Is this backward-compatible — existing ledgers still work? (D9)
- [ ] Are tests included that verify chain integrity after the change? (D10)
- [ ] Is staging kept completely separate from the ledger — no staging entries in ledger exports or blocks? (D11)
