# Architectural Decision Records — PH Ledger

Each entry captures a significant architectural decision: the context, the decision, the rationale, and any consequences.

---

## ADR-001: Sovereign Key Model (Seed → Master → Sub-Keys)

**Date:** 2026-04 (initial design)
**Status:** ✅ Adopted

### Context
The ledger needs a cryptographic root of trust that is:
- Recoverable if the passphrase is forgotten (but the seed is saved)
- Rotatable without re-encrypting the entire ledger
- Capable of deriving independent sub-keys for different purposes (encryption, integrity, identity)

### Decision
A 256-bit **Recovery Seed** (32 bytes from `/dev/urandom`, base64-encoded) is the ultimate root secret. The seed is encrypted with a Passphrase-Derived Key (PDK) using PBKDF2 and stored in the genesis block. On authentication, the seed is decrypted and used to derive sub-keys:

```
Seed (32 bytes)
  ├── SHA-256 → Master Key (32 bytes)
  │      ├── HMAC(master_key, "encryption-key") → encryption_key (AES-CTR)
  │      ├── HMAC(master_key, "integrity-key") → integrity_key (HMAC-SHA256)
  │      └── HMAC(master_key, "identity-secret") → identity_secret (Ed25519 proxy)
  └── Master Key is cached in RAM (/dev/shm) during session
```

### Rationale
- The seed is the single secret a user must backup. Everything derives from it.
- Sub-key separation limits blast radius: compromising the encryption key doesn't reveal the identity secret.
- The passphrase only protects the seed at rest. Changing the passphrase only re-encrypts the seed — no ledger data is touched.

### Consequences
- **Positive:** Full recovery from seed. Passphrase changes are cheap. Sub-keys are independent.
- **Negative:** The seed is a single point of failure. Losing it means permanent data loss.

---

## ADR-002: Encrypt-then-MAC (AES-CTR + HMAC-SHA256)

**Date:** 2026-04-28 (R1 resolution)
**Status:** ✅ Adopted

### Context
The initial AES-CTR encryption had no authentication tag. CTR mode is malleable — an attacker can flip ciphertext bits to predictably change the decrypted plaintext. This breaks integrity guarantees for a tamper-evident ledger.

### Decision
Every encrypted field appends an HMAC-SHA256 authentication tag computed over the ciphertext:

```
ciphertext = AES_CTR(plaintext, nonce) | nonce | HMAC(integrity_key, ciphertext | nonce)
```

On decryption:
1. Verify HMAC first — reject if tampered
2. Decrypt AES-CTR only if HMAC matches

### Rationale
- Encrypt-then-MAC is the standard defense against chosen-ciphertext attacks.
- HMAC verification must happen before decryption to prevent timing side-channels on the comparison.
- The `integrity_key` is a separate sub-key (see ADR-001), so compromising the encryption key doesn't allow forging auth tags.

### Consequences
- **Positive:** Tampered ciphertexts are detected and rejected. Chain integrity is preserved.
- **Negative:** ~48 bytes overhead per encrypted field (32 bytes HMAC + 16 bytes nonce). Minimal.

---

## ADR-003: Identity Ed25519 Proxy (HMAC-SHA256)

**Date:** 2026-04-28 (R2 resolution)
**Status:** ✅ Adopted (temporary — see Future)

### Context
Every block in the chain must be signed by an identity key to prove authorship. However, the project has a **zero external dependency** commitment, and real Ed25519 requires the `cryptography` or `nacl` package.

### Decision
Until external dependencies are allowed, identity is implemented as an **HMAC-SHA256 proxy**:

```
identity_secret = HMAC(master_key, "identity-secret")
signature = HMAC(identity_secret, block_hash)
```

The "public key" is `SHA-256(identity_secret)` — anyone who knows the public key can verify signatures by recomputing the HMAC.

The identity secret has an **in-ledger fallback** stored in genesis (`identity_secret_enc_fallback`), encrypted with the Master Key. This means the identity is recoverable even if `identity.json` is lost.

### Rationale
- Zero-dep constraint forces a proxy solution. HMAC-SHA256 is available in the Python stdlib.
- The in-ledger fallback makes identity survival independent of the identity file.

### Consequences
- **Positive:** Identity works without any external package. Recoverable from ledger alone.
- **Negative:** This is not real asymmetric cryptography. The "public key" is a hash that only allows verification, not separate signing/encryption roles. Real Ed25519 should replace this when the dep constraint is relaxed (see ROADMAP §1).

---

## ADR-004: PBKDF2 600K Iterations

**Date:** 2026-04-28 (R3 resolution)
**Status:** ✅ Adopted

### Context
The initial PBKDF2 iteration count was below current security standards (100K). OWASP 2026 recommends 600K for PBKDF2-HMAC-SHA256.

### Decision
Increased PBKDF2 iterations from 100,000 to 600,000 in the passphrase-derived key derivation.

### Rationale
- Follows OWASP 2026 recommendations for PBKDF2-HMAC-SHA256.
- The 6x slowdown (~0.5s → ~3s on modern hardware) is acceptable for authentication that happens once per boot session.

### Consequences
- **Positive:** Stronger resistance to brute-force passphrase cracking.
- **Negative:** Slightly longer auth time (~3 seconds).

---

## ADR-005: Plaintext Content Hash (Extensible All-Keys Iterator)

**Date:** 2026-04-30 (R4 + P0 / v0.4.0)
**Status:** ✅ Adopted

### Context
Entries needed a content proof that:
- Survives re-encryption (same plaintext → same hash, different ciphertext)
- Allows reconciliation without trust
- Automatically covers any future fields without manual spec updates

### Decision (v0.4.0+)
`_compute_content_hash()` iterates **all keys** in the entry data dictionary:

```python
content = {}
for key, value in data.items():
    if key == "content_hash":
        continue
    if key.endswith("_enc") and value is not None and value != "":
        content[key] = decrypt_fn(value)
    elif isinstance(value, list):
        content[key] = sorted(value)
    else:
        content[key] = value
json_content = json.dumps(content, sort_keys=True)
content_hash = hashlib.sha256(json_content.encode()).hexdigest()
```

**Legacy algorithm (v0.3.0):** Hardcoded 9-field dictionary.

`verify()` uses a **try-both approach** — tries extensible first, falls back to legacy. Handles mixed-version ledgers without format_version dependency.

### Rationale
- All-keys iterator automatically covers future fields — no code changes needed when new fields are added.
- Try-both approach means `verify()` works regardless of the format_version each individual entry was created under.

### Consequences
- **Positive:** Future-proof. New fields are automatically included in the content proof.
- **Negative:** Requires v0.3.0→v0.4.0 migration to recompute content hashes for existing entries (handled by `scripts/migrate_format_version.py`).

---

## ADR-006: Zero External Dependencies (Pure Python Stdlib)

**Date:** 2026-04 (initial design)
**Status:** ✅ Adopted (core engine)

### Context
The project must be usable by anyone without `pip install`. A single `git clone` should suffice to run the entire tool. This is especially important for mobile/web implementations that need to implement the format independently.

### Decision
The core engine (ledger operations, crypto, storage, CLI) uses **only Python 3.x standard library modules**: `hashlib`, `hmac`, `json`, `os`, `argparse`, `copy`, `struct`, `base64`, `tempfile`, etc.

The AES-CTR implementation is hand-rolled (~180 lines). HMAC-SHA256 is used instead of real Ed25519 (see ADR-003).

### Rationale
- Removes all friction for a new user: clone and run.
- Forces the format to be simple enough that anyone can re-implement it without a dependency manager.
- Mobile/embedded implementations are inherently independent of Python — they need the format spec, not the Python code.

### Consequences
- **Positive:** Zero friction. Platform-agnostic format.
- **Negative:** Hand-rolled AES has no side-channel resistance. No real asymmetric crypto. These are acceptable for a personal ledger but would not pass a security audit for enterprise use.

---

## ADR-007: Hierarchical Lock Chain

**Date:** 2026-04 (initial design)
**Status:** ✅ Adopted

### Context
The ledger needed a structure that provides integrity verification without traversing the entire chain for every operation. It also needed to support archiving (splitting off old data).

### Decision
The chain is structured as a tree:

```
Genesis (sealed + signed, identity fallback embedded)
  └── Year Summary (sealed + signed)
        └── Month Summary (sealed + signed)
              └── Day (sealed + signed)
                    └── Entries (hashed individually + content_hash)
```

Each block contains:
- `prev_hash`: HMAC-SHA256 of the previous block's canonical JSON
- `day_hash` / `month_hash` / `year_hash`: HMAC-SHA256 of its own contents
- `signature`: Identity HMAC over the block hash

### Rationale
- Partial traversal: you can verify a single day without reading the entire chain.
- Split at any summary boundary (year or month) for archiving or export — each segment is independently verifiable.
- Entry-level hashes mean re-encrypting one entry doesn't cascade beyond that day block.

### Consequences
- **Positive:** Efficient verification, clean archiving, independent blocks.
- **Negative:** More blocks = more filesystem operations during sync.

---

## ADR-008: Blind Index (Plaintext Aggregator)

**Date:** 2026-04 (initial design)
**Status:** ✅ Adopted

### Context
Reputation queries (`phpoc rep`) need to answer "how much time did I spend on activity X over the last N days?" without decrypting every entry.

### Decision
A separate `index.json` file stores aggregated plaintext data:

```json
{
  "2026-05-04": {
    "Working": 3600000,
    "Coffee": 1800000
  },
  "2026-05-05": {
    "Running": 2700000
  }
}
```

- Keys are activity titles (plaintext — the title is not encrypted in entries either)
- Values are total milliseconds per day
- Queried by date range without touching the ledger

### Rationale
- The title and total duration per day are the minimum data needed for rep queries.
- Titles are already visible in the staging area and chain structure — not a new leak.
- The blind index can be fully rebuilt from the chain if lost or corrupted.

### Consequences
- **Positive:** Fast reputation queries without decryption. Rebuildable from chain.
- **Negative:** The index leaks activity titles and daily totals. Acceptable — this is what the user sees in the CLI anyway.

---

## ADR-009: Staging as Plaintext Scratchpad (with NoAuth)

**Date:** 2026-04 (initial design)
**Status:** ✅ Adopted (current — will evolve with D2)

### Context
Users should be able to quickly capture activities without typing their passphrase. Authentication should only be required when committing to the immutable ledger.

### Decision
Staging (`staging.json`) is a local plaintext file. Entries are stored with a `plain:` prefix instead of encryption:

```json
{
  "title": "plain:Coffee with Alice",
  "startTime_enc": "plain:2026-05-04T10:00:00"
}
```

When syncing to the ledger, the `plain:` entries are encrypted with the Master Key and sealed into a day block. `NoAuthCryptoManager` handles the plaintext case.

### Rationale
- Quick capture without auth is the primary UX requirement for a habit tracker.
- The staging-to-ledger boundary is where authentication is enforced.
- The `plain:` prefix convention allows the system to distinguish staged entries from partially-encrypted legacy entries.

### Consequences
- **Positive:** Fast entry. No friction for the most common operation.
- **Negative:** Multi-device staging is an attack vector — this is the problem D2 is designed to solve (shared encrypted staging).

---

## ADR-010: Revert Instead of Prune

**Date:** 2026-04-29 (fix for earlier prune)
**Status:** ✅ Adopted

### Context
The original design used "prune" — removing a specific day block from the middle of the chain. This broke `prev_hash` linkages and required chain repair.

### Decision
`revert <count>` replaces prune. It removes the last N day blocks from the end of the chain and restores their entries to staging in plaintext format.

```
Ledger: [Day 1] → [Day 2] → [Day 3] → [Day 4]
revert 2:
Ledger: [Day 1] → [Day 2]
Staging restored: Day 3 entries, Day 4 entries (as plain:)
```

Encrypted fields from reverted blocks are converted back to `plain:` format for staging.

### Rationale
- Truncating from the end preserves the chain's integrity — no broken `prev_hash` links.
- Reverting is a rollback, not a deletion from history (the reverted data is visible in the chain head witness / future export).
- A delete-from-middle feature would need a different mechanism (chain splitting at summary boundaries + archiving).

### Consequences
- **Positive:** Chain integrity is always preserved. Simple, predictable behavior.
- **Negative:** Can only revert contiguous blocks from the end. Cannot remove a specific day from the middle.

---

## ADR-011: Format Versioning (format_version in Genesis)

**Date:** 2026-04-29 (P1 / PHPSPEC.md)
**Status:** ✅ Adopted

### Context
The ledger format will evolve over time. There must be a mechanism for:
- Detecting the format version of an existing ledger
- Migrating ledgers forward without data loss
- Backward compatibility for verification

### Decision
- `format_version` field in the genesis block (e.g., `"0.3.0"`, `"0.4.0"`)
- Explicit versioning policy in PHPSPEC §9.3
- One-time migration script (`scripts/migrate_format_version.py`) that handles:
  - v0.2.0 → v0.3.0 (add format_version, cascade seals)
  - v0.3.0 → v0.4.0 (recompute content hashes with extensible algorithm, cascade seals)
- `verify()` uses try-both approach to handle mixed-version ledgers

### Rationale
- Explicit versioning prevents silent format drift.
- The migration script is one-time — a ledger is upgraded atomically.
- Try-both verification means partially-migrated ledgers (some entries v0.3.0, some v0.4.0) can be verified without format_version lookup.

### Consequences
- **Positive:** Clear migration path. Backward-compatible verification.
- **Negative:** Requires running the migration script when upgrading between format versions.

---

## ADR-012: Chain Splitting at Summary Boundaries

**Date:** 2026-04-29 (P1 / PHPSPEC.md §9.4.5)
**Status:** ✅ Adopted (foundation — implementation deferred to P2)

### Context
Portable Export requires extracting a verifiable segment of the chain without the full ledger. Archiving requires splitting off old data into a separate file.

### Decision
The chain can be split at any summary block boundary (year or month). A summary block is a full chain link — splitting at it produces two independently verifiable segments:

| Segment | Contents | Verifies? |
|---------|----------|-----------|
| Active | Genesis → ... → Summary | ✅ Internal chain intact |
| Archive/Export | Summary → Next → ... | ✅ Starts with valid seal, prev_hash omitted |

### Rationale
- Summary blocks are natural partition boundaries that already exist in the chain structure.
- No new block types needed — splitting is a mechanical operation on existing data.
- The recipient of an export can verify the segment's internal chain without the full ledger.

### Consequences
- **Positive:** Foundation for Portable Export (P2) and Archival Automation (P8).
- **Negative:** None — the mechanism is purely additive (no changes to existing data).

---

## ADR-013: Encryption Suffix Convention (`_enc`)

**Date:** 2026-04-29 (P1 / PHPSPEC.md)
**Status:** ✅ Adopted

### Context
The entry schema has multiple fields that may be encrypted. Rather than hardcoding a set of "encrypted fields," the system needs a convention that allows any field to be encrypted without schema changes.

### Decision
Any field may be encrypted by appending `_enc` to its name. The plaintext field name without `_enc` is the logical field name.

```json
{
  "startTime_enc": "<encrypted>",
  "endTime_enc": "<encrypted>",
  "metadata_enc": "<encrypted>",
  "comment_enc": "<encrypted>",
  "title": "plaintext"    ← title is intentionally not encrypted
}
```

The content hash algorithm decrypts all `*_enc` fields before hashing (see ADR-005).

### Rationale
- New encrypted fields can be added without schema changes or migration.
- The `_enc` suffix is self-documenting in the JSON.
- The content hash automatically covers any `*_enc` field via the all-keys iterator.

### Consequences
- **Positive:** Extensible encryption. No hardcoded field lists.
- **Negative:** Fields that should never be encrypted (like `title` for blind index queries) must be explicitly kept plaintext by convention.

---

## ADR-014: Session RAM Cache (`/dev/shm`)

**Date:** 2026-04-28 (R1 implementation)
**Status:** ✅ Adopted (will evolve with D2)

### Context
Re-entering the passphrase for every operation is prohibitive. The Master Key must be cached for the session duration.

### Decision
The Master Key is written to a RAM-backed file (`/dev/shm/phpoc_session`, chmod 600) on successful authentication. Subsequent operations read the key from this file without prompting for the passphrase.

The cache is cleared on:
- Process exit
- Explicit logout (future — see D2)
- System reboot (`/dev/shm` is volatile)

### Rationale
- `/dev/shm` is available on all Linux systems as a tmpfs. No external dependencies.
- chmod 600 restricts access to the current user.
- Volatile memory ensures the key doesn't persist across reboots.

### Consequences
- **Positive:** Once-per-boot passphrase entry.
- **Negative:** No locking — concurrent processes could race (low risk in single-user CLI). Session cache is local to a device — does not support cross-device session management (see D2).

---

## ADR-015: Multi-Device Shared Encrypted Staging

**Date:** 2026-05-04 (D2 discussion)
**Status:** 🔮 Design direction (not yet implemented)

### Context
Portable Export enables cross-device sharing. But the staging area — currently a local plaintext scratchpad (ADR-009) — becomes an attack vector in a multi-device world. A shared staging area that's accessible from multiple devices must be encrypted, and device sessions must be mutually exclusive.

### Decision
**Direction B:** Shared encrypted staging with a single active session cookie.

| Decision | Detail |
|----------|--------|
| Staging encryption | Entire staging blob is encrypted with the Master Key. |
| Session model | Single active device at a time. Cookie in remote staging is the source of truth. |
| Cookie invalidation | 3 ways: timeout (~30 min default), new auth on another device (overwrites + increments seq), explicit `logout`. |
| Cookie structure | `{device_id, seq (monotonically increasing), issued_at, expires_at}` |
| Write authorization | Every write includes the seq. Remote rejects writes with stale seq — eliminates TOCTOU race. |
| Auth requirement | Auth needed for first interaction on any device. Sync always requires fresh passphrase. |
| Local cache | On auth, pull remote staging → local cache. All `add`/`end`/`pause`/`unpause` push to both. |
| Offline behavior (Q1) | Lenient. Local writes accumulate. On reconnect: unlocked days reconcile, locked days warn-and-discard. |
| Logout | Clears remote cookie only. Does not push staging data (remote already has latest). |
| Offline view/list | Warns "Network Unavailable — Local staging only", displays ledger + local cached staging. |
| Device ID field | Default field in every entry (never optional). Randomized encryption. HMAC proof for attribution. |

### Staging Transport (ADR-015a)

**Decision:** Git remote as the first transport via an `AbstractStagingTransport` interface. Multiple transports available long-term. Multi-staging reconciliation deferred until after mobile POC.

### Staging Obfuscation (ADR-015b)

**Decision:** The staging blob on the remote is a fixed-size padded encrypted blob to prevent metadata leakage.

| Class | Ceiling |
|-------|---------|
| 64K | Light usage |
| 128K | Light-moderate |
| 256K | Moderate |
| 512K | Heavy usage (with comments) |

Random filler bytes pad to class ceiling before encryption. User-configurable. Backward-compatible with unpadded blobs.

### Rationale
- Staging must be shared for multi-device workflows but encrypted to prevent habit profiling.
- Single active session prevents split-brain writes.
- Sequence numbers make the system AI-agent-proof — sub-millisecond races are detected and rejected.
- Fixed-size padding removes timing and volume signals from git metadata.

### Consequences
- **Positive:** Multi-device support with strong security guarantees. AI-agent compatible.
- **Negative:** Introduces network dependency for staging (mitigated by offline-lenient mode). More complex than local-only staging.
- **Open questions:** Q6 (evicted device write behavior), Q7 (device identity mechanism), D3 (offline sync reconciliation).

---

## Summary by Layer

| Layer | ADRs |
|-------|------|
| **Key Management** | ADR-001 (Sovereign Key), ADR-004 (PBKDF2 600K) |
| **Encryption** | ADR-002 (Encrypt-then-MAC), ADR-013 (`_enc` suffix) |
| **Identity** | ADR-003 (Ed25519 Proxy) |
| **Chain Structure** | ADR-007 (Hierarchical Lock Chain), ADR-012 (Chain Splitting) |
| **Content Integrity** | ADR-005 (Extensible Content Hash), ADR-010 (Revert) |
| **Queryability** | ADR-008 (Blind Index) |
| **Staging** | ADR-009 (Plaintext Scratchpad), ADR-015 (Multi-Device Encrypted) |
| **Versioning** | ADR-011 (Format Versioning) |
| **Dependencies** | ADR-006 (Zero External Deps) |
| **Session** | ADR-014 (RAM Cache), ADR-015 (Cookie + Seq Model) |
