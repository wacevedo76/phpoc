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
- **Positive:** `ph recover` now automatically caches the master key after re-sealing the ledger (fix: commit 389e268). Previously the session cache held a stale key after recover, causing all subsequent commands to fail decryption until the user ran `ph login` to refresh it.
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
| **Key Management** | ADR-001 (Sovereign Key), ADR-004 (PBKDF2 600K), ADR-026 (Key Rotation) |
| **Encryption** | ADR-002 (Encrypt-then-MAC), ADR-013 (`_enc` suffix) |
| **Identity** | ADR-003 (Ed25519 Proxy) |
| **Chain Structure** | ADR-007 (Hierarchical Lock Chain), ADR-012 (Chain Splitting) |
| **Content Integrity** | ADR-005 (Extensible Content Hash), ADR-010 (Revert) |
| **Queryability** | ADR-008 (Blind Index) |
| **Staging** | ADR-009 (Plaintext Scratchpad), ADR-015 (Multi-Device Encrypted) |
| **Versioning** | ADR-011 (Format Versioning) |
| **Dependencies** | ADR-006 (Zero External Deps) |
| **Session** | ADR-014 (RAM Cache), ADR-015 (Cookie + Seq Model) |
| **Configuration** | ADR-016 (XDG Base Directories), ADR-017 (Commented Template), ADR-018 (Config CLI), ADR-019 (Priority Chain CLI Flag + Config Data Dir) |
| **Sync / Transport** | ADR-021 (Sync Optimization), ADR-022 (Device Cookie), ADR-023 (Serverless HTTP Transport), ADR-024 (Hash Index Fast Path), ADR-025 (Row-Level Staging Sync) |

---

## ADR-016: XDG Base Directory Compliance (Config / Data Separation)

**Date:** 2026-05-13
**Status:** ✅ Adopted

### Context
The original code stored everything in `~/.config/personal_history_poc/` — a single flat directory for config, ledger data, staging, identity, and index files. As the project matured, this became ambiguous: config files belong in a config directory, data files belong in a data directory. The XDG Base Directory Specification provides the standard convention for this split on Linux.

### Decision
Adopt the XDG Base Directory Specification with two independent resolution chains. Both chains consult CLI flags, environment variables, config file values, and defaults in priority order:

**Config file** (`config.json`):
1. `--config` CLI flag (per-invocation override)
2. `$PHPOC_CONFIG` environment variable (per-session override)
3. `$XDG_CONFIG_HOME/phpoc/config.json`
4. `~/.config/phpoc/config.json` (default)

**Data directory** (ledger, staging, index, identity):
1. `--dir` CLI flag (per-invocation override)
2. `$PHPOC_DATA_DIR` environment variable (per-session override)
3. `storage.data_dir` in config.json (persistent per-ledger setting, set via `phpoc config set storage.data_dir <path>`)
4. `$XDG_DATA_HOME/phpoc/`
5. `~/.local/share/phpoc/` (default)
6. `~/.config/personal_history_poc/` (legacy auto-fallback — detected if new path doesn't exist yet)

The config file path is resolved by `storage/implementations/file_config.py:_resolve_config_path()`. The data directory is resolved by `_resolve_data_dir(config_manager=<ConfigManager|None>, overridden_dir=<Path|None>)`.

### Rationale
- XDG is the standard Linux convention — every GUI app, many CLI tools, and the OS itself use it.
- Separating config from data means users can back up data without config, nuke config without losing data.
- The legacy path (`personal_history_poc`) is detected automatically, so existing users see no disruption.
- A full priority chain gives users maximum flexibility: CLI flags for one-off overrides, env vars for session-wide use, config file for persistent settings, XDG defaults for normal use, and legacy auto-detect for existing users.

### Consequences
- **Positive:** Standard path conventions. Clean separation of concerns. Backward-compatible via auto-detection. Full priority chain for power users.
- **Negative:** Existing users with `~/.config/personal_history_poc/` will stay there until they manually move their data.

---

## ADR-017: Commented Config Template (`//`-Prefix Convention)

**Date:** 2026-05-13
**Status:** ✅ Adopted

### Context
Users need a way to discover and configure all available settings without reading source code. A blank or auto-generated config file with just active settings doesn't show what's possible. The standard approach — a comprehensive template with every setting documented inline — is the most user-friendly.

### Decision
The `phpoc config init` command generates a fully-commented config file template at the resolved config path. The template has these properties:

1. **Every setting is present**, with its default value, on a `//`-prefixed line.
2. **Inline comments** explain what each setting does in natural language.
3. **Stripping all `//` lines produces valid JSON** — the parser can read it as-is.
4. **To change a setting, the user uncomments the line** by removing the leading `//` and edits the value.
5. **Section structure is preserved** with section header comments.

### Example
```json
  // How long to cache the passphrase before re-prompting
  // "cache_timeout_minutes": 30,
  // Set false to allow no-auth mode for add/start/end
  // "passphrase_required": true
```

To set a 60-minute timeout, the user edits:
```json
  // How long to cache the passphrase before re-prompting
  "cache_timeout_minutes": 60,
  // Set false to allow no-auth mode for add/start/end
  // "passphrase_required": true
```

### Rationale
- Discovery: users see all available settings without reading source or docs.
- Safety: defaults are preserved on every line — the template is a complete reference.
- Simplicity: "uncomment to activate" is the easiest possible mental model. No hunting for the right section, no remembering the exact key name.

### Consequences
- **Positive:** Self-documenting config. No need for a separate config docs page.
- **Negative:** Template must be regenerated if new settings are added in a future version. The template overwrites any custom config — users are warned to back up their active config before regenerating.

---

## ADR-018: CLI Config Subcommand Tree

**Date:** 2026-05-13
**Status:** ✅ Adopted

### Context
Users need runtime access to config values without editing the file. Common operations: view current config, read one value, change one value, generate the commented template.

### Decision
The `config` CLI subcommand has four actions:

```
phpoc config show              — print the full active config (merged with defaults) as JSON
phpoc config get <key>         — read a single value by dot path (e.g. auth.cache_timeout_minutes)
phpoc config set <key> <val>   — write a single value (JSON-parseable or plain string)
phpoc config init              — generate the commented template at the config path
```

- `show` and `get` read the merged config (user values overlayed on defaults).
- `set` writes the provided value at the dot-path location. Nested keys are created automatically.
- `init` calls `_config_generate_template()` which writes the full commented template, overwriting any existing file.
- All config commands skip authentication — configuring the tool should not require the passphrase.

Additionally, the top-level `--config <path>` flag overrides the config file resolution, useful for testing or multiple profiles.

### Rationale
- `show`/`get`/`set` cover all common read-write operations without a text editor.
- `init` handles the generative case — useful for first-time setup, or regenerating after a version upgrade.
- Skipping auth for config is pragmatic: the user is at the terminal and owns the filesystem already.

### Consequences
- **Positive:** Full config management from the CLI. Useful for scripting and automation.
- **Negative:** `set` currently writes the value directly — it does not merge with defaults. The user must provide the full path. This matches `git config` and similar tools.


---

## ADR-019: CLI `--dir` Flag + Config `storage.data_dir` — Data Directory Priority Chain

**Date:** 2026-05-14
**Status:** ✅ Adopted

### Context
After implementing XDG base directory compliance (ADR-016), users needed more flexibility in choosing where their ledger data lives. Two use cases emerged:

1. **Per-invocation override**: "I want to look at my work ledger for a minute without changing my default."
2. **Persistent re-targeting**: "I want to move my data to a new directory and set that as my default going forward."

The existing env-var-based override (`$PHPOC_DATA_DIR`) covered sessions but was too coarse for one-off queries and too ephemeral for persistent changes. The config file had no notion of a data directory — it only handled its own location.

### Decision
Add two new mechanisms that slot into the existing resolution chain (ADR-016):

**1. `--dir` CLI flag** — accepted at the top-level by `main.py` for every command:

```
phpoc --dir /mnt/work-ledger verify
phpoc --dir ./test-env init
```

Internally, `_resolve_data_dir()` now accepts an `overridden_dir` parameter. When set, it returns immediately without consulting any other source.

**2. `storage.data_dir` config key** — wired into `_resolve_data_dir()` between env var and XDG defaults:

```python
def _resolve_data_dir(config_manager=None, overridden_dir=None):
    # Priority 1: explicit override (--dir flag)
    if overridden_dir:
        return Path(overridden_dir)
    # Priority 2: environment variable
    env_dir = os.environ.get("PHPOC_DATA_DIR")
    if env_dir:
        return Path(env_dir)
    # Priority 3: config file (must be wired explicitly)
    if config_manager:
        cfg_path = config_manager.get("storage.data_dir")
        if cfg_path:
            return Path(cfg_path)
    # Priority 4: XDG default
    xdg_data = os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share"
    candidate = Path(xdg_data) / "phpoc"
    if candidate.exists():
        return candidate
    # Priority 5: legacy fallback
    legacy = Path.home() / ".config" / "personal_history_poc"
    if legacy.exists():
        return legacy
    return candidate
```

Setting via config is done with the standard config CLI:

```
phpoc config set storage.data_dir /mnt/work-ledger
```

**Full priority chain (high → low):**

1. `--dir` CLI flag (per-invocation)
2. `$PHPOC_DATA_DIR` env var (per-session)
3. `storage.data_dir` in config.json (persistent)
4. `$XDG_DATA_HOME/phpoc/` (XDG default)
5. `~/.local/share/phpoc/` (XDG fallback)
6. `~/.config/personal_history_poc/` (legacy auto-detect)

### Rationale
- CLI flags are the highest priority by convention — they are explicitly typed by the user for this exact invocation.
- Environment variables are good for sessions but clutter `.bashrc`; `storage.data_dir` in the config file is the proper persistent mechanism.
- XDG defaults are always the baseline; legacy auto-detect preserves backward compatibility.
- No files are moved automatically when changing `storage.data_dir` — it's a pointer, not a migration.

### Consequences
- **Positive:** Full flexibility from ephemeral (CLI flag) to persistent (config key). No new subcommands. All tests pass (941).
- **Negative:** Users who change `storage.data_dir` must manually move their ledger files. A future `migrate` subcommand could automate this. `--dir` flag doesn't change the config file path — config and data remain independent per ADR-016.

---

## ADR-020: Day-Boundary Spanning Activities — Display Marker + Filter Inclusion (Fix A+B)

**Date:** 2026-05-14
**Status:** ✅ Implemented and merged

---

## ADR-021: Sync Optimization — Stable Entry IDs + Single-Pull Freshness

**Date:** 2026-05-21
**Status:** ✅ Implemented

### Context
The original staging sync design had three performance problems:

1. **Triple pull:** Every mutating command (`capture`, `end`, `pause`, `unpause`)
   called `check_and_sync()` which did:
   - `check_remote_available()` — a full `transport.pull()` with wall-clock timeout
   - `check_device()` — another full `transport.pull()` + deobfuscation just for `device_id`
   - `self._remote.pull()` — a third pull for the actual merge data

   Result: **3 transport pulls per command**, each involving `git pull --rebase`,
   file read, AES-CTR decryption, and JSON parse.

2. **No freshness tracking:** Every `check_and_sync()` pulled regardless of whether
   the remote had actually changed. Same-device scenarios (the common case)
   pulled and decrypted for nothing.

3. **Title-based dedup:** The merge engine used `(title, start_epoch)` as its
   dedup key. When two devices started the same-named task (e.g. "Coding") at
   different milliseconds, both survived as separate entries. End/pause by title
   could hit the wrong entry in cross-device flows. No stable reference existed
   for a specific entry across devices.

### Decision
Three complementary changes:

**A) Single-pull `check_and_sync()`:** One transport pull, one deobfuscation, one
   JSON parse. The pulled blob dict is used for device check, freshness check,
   AND merge data — all from the same `pull()` call. Catches exceptions as
   `OFFLINE`; returns `READY` (nothing to merge) on `None`.

**B) Freshness-based pull skip:** Two new mechanisms:
   - `_last_push_at` timestamp on `StagingService` (ms epoch, updated on every
     successful `push_to_remote()`)
   - `_needs_full_pull(remote_blob)` method:
     - Different `device_id` → always pull (cross-device data)
     - Same device + `remote_updated_at > _last_push_at` → pull (concurrent
       terminal or other instance pushed)
     - Same device + `remote_updated_at <= _last_push_at` → skip (assume synced)

**C) Stable entry IDs:** Every entry gets a UUID (`entry_id`) on creation:
   - Generated in `LocalStagingCache.append()` via `str(uuid.uuid4())`
   - Persisted in `data["entry_id"]` field in the raw entry
   - Included in DTOs from `read_entries()` and preserved in `write_entries()`
   - `MergeEngine.merge()` uses `entry_id` as primary dedup key
   - Fallback to `(title, start_epoch)` for backward compatibility with entries
     created before the change

### Rationale
- **Single pull:** Eliminates 2 redundant transport round-trips per command.
  The device check no longer needs its own pull — `device_id` is the first
  field in the blob dict.
- **Freshness skip:** The common case is a single user on one device repeatedly
  capturing entries. No remote changes in between means no merge needed.
  The `git pull --rebase` + AES decrypt + JSON parse on every command was
  the main latency source.
- **Stable IDs:** Cross-device operations need a stable handle. Title matching
  is ambiguous (two "Coding" tasks running) and epoch matching is fragile
  (different devices can create at different milliseconds). The `entry_id` is
  the definitive reference for end/pause/modify operations across devices.

### Consequences
- **Positive:**
  - ~3x reduction in transport calls per command
  - Most commands (same device, no remote change) skip the merge entirely
  - Cross-device entry lifecycle works correctly (create on A, end on B, A sees
    it as ended after pull)
  - Merge engine handles concurrent terminals on the same device
  - Backward compatible — all 1049 tests pass (1025 original + 24 new)
- **Negative:**
  - `_last_push_at` is in-memory only. If the process restarts without pushing,
    the freshness check starts fresh (`_last_push_at = 0`), which is safe but
    slightly less optimal (one extra merge on first command after restart).
  - Entries created before this change have `entry_id = ""` and fall back to
    the old dedup behavior. They're migrated on next write_entries cycle
    (generates a new UUID), but that's a silent mutation.

### ADR-015b consequences updated
  The obfuscation design (ADR-015b) remains unchanged. The single-pull
  optimization means the obfuscated blob is now decrypted once per command
  instead of up to three times.

---

## Summary by Layer

| Layer | ADRs |
|-------|------|
| **Key Management** | ADR-001 (Sovereign Key), ADR-004 (PBKDF2 600K), ADR-026 (Key Rotation) |
| **Encryption** | ADR-002 (Encrypt-then-MAC), ADR-013 (`_enc` suffix) |
| **Identity** | ADR-003 (Ed25519 Proxy) |
| **Chain Structure** | ADR-007 (Hierarchical Lock Chain), ADR-012 (Chain Splitting) |
| **Content Integrity** | ADR-005 (Extensible Content Hash), ADR-010 (Revert) |
| **Queryability** | ADR-008 (Blind Index) |
| **Staging** | ADR-009 (Plaintext Scratchpad), ADR-015 (Multi-Device Encrypted) |
| **Versioning** | ADR-011 (Format Versioning) |
| **Dependencies** | ADR-006 (Zero External Deps) |
| **Session** | ADR-014 (RAM Cache), ADR-015 (Cookie + Seq Model) |
| **Configuration** | ADR-016 (XDG Base Directories), ADR-017 (Commented Template), ADR-018 (Config CLI), ADR-019 (Priority Chain CLI Flag + Config Data Dir) |
| **Sync / Staging** | ADR-021 (Sync Optimization: Stable IDs + Freshness Pull), ADR-022 (Device Cookie Fast-Path), ADR-023 (Serverless HTTP Transport), ADR-024 (Hash Index Fast Path), ADR-025 (Row-Level Staging Sync) |

### Context
Activities that cross midnight (e.g., 23:30 → 01:30) are stored under their start date only. This creates two problems:

1. **Display ambiguity** — `[23:30 - 01:30]` shows a next-day end time with no visual indicator.
2. **Date filter blind spot** — `list synced --date 2026-04-29` misses the activity even though 2 hours of it happened on the 29th.

Three approaches were considered (see [BACKLOG P11](BACKLOG.md#-p11-day-boundary-spanning-activities)).

### Decision
Adopt **Fix A + Fix B** — a combined display-layer solution with no data model changes:

**Fix A — Display marker:** `_print_entry` in `phpoc_cli/interface.py` appends a `⏭` marker to any entry whose end date (UTC) differs from its start date:

```
[23:30 - 01:30] Late Night Coding (120m) ⏭
```

**Fix B — Filter inclusion:** When rendering a date-filtered view (e.g., `--date 2026-04-29`), peek at the previous day's day block and surface any entries that span *into* the target date. A dedup guard prevents the entry from appearing twice when its original date is also in the filter range.

**Key design rules:**
- Spanning check uses `stop_epoch > start_epoch` guard (see Issue 5) — end-before-start entries are invalid, not spanning.
- Fix B only peeks **one day back** — multi-day-span entries (e.g., Apr 28→30) are not surfaced when filtering for intermediate dates.
- No end time → no spanning check.
- Content hash, chain integrity, blind index — unaffected. This is purely a view-layer change.

### Rationale
- **Fix C (split at sync)** was rejected — the ledger is immutable truth; splitting for display corrupts entry count and content hash integrity.
- Fix A is zero-risk (display-only, no new decryption paths).
- Fix B addresses the user-facing blind spot without touching the chain structure.
- Dedup via `original_date not in filter_range` is simple and doesn't require tracking seen entries.
- The ledger remains the authoritative data model; view logic is the only thing that changes.

### Consequences
- **Positive:** Clear visual cue for spanning entries. Date filters find activities that belong to the filtered day. Zero data model changes. 32 new tests (972 total). No regression.
- **Negative:** The `⏭` marker is display-only — tools reading raw JSON won't see it (they compute dates independently). Fix B adds a decrypt-and-compare step per previous-day entry during filtered listing.
- **Implementation scope:** `phpoc_cli/interface.py:_print_entry()` (marker), `phpoc_cli/interface.py:list_habits()` (peek logic), `phpoc_cli/cli_parsers.py:parse_time_input()` (hour wrapping + auto-advance). No engine/chain/staging changes.
- **All 972 tests pass.** 2 files changed, 104 lines added.

---

## ADR-015: Remote Ledger Sync (Append-Only Block Files)

**Date:** 2026-05-22
**Status:** ✅ Implemented (pending tests)

### Context
The ledger is local-only. To enable cross-device `ph list all`, the ledger
needs to be synced to a remote. Unlike staging (which is a single mutable
blob with merge conflicts), the ledger is append-only — blocks are never
edited or deleted.

### Decision
The ledger is synced to the same git repo as staging
(`github.com:wacevedo76/phpoc-staging.git`) using an append-log design:

```
staging/blobs/current.json   (existing — mutable, merge-needed)
ledger/
  blocks/
    000000.json                 (genesis — pushed once)
    000001.json                 (obfuscated single day block)
    000002.json
    ...
  index.json                    (lightweight summary)
```

Each block is stored as an individual obfuscated file using the same
AES-CTR + tiered-padding scheme as `RemoteStagingSync`. Block sequence
numbers (`000000`..`0000NN`) serve as filenames, naturally handling
multi-sync-per-day.

Push/pull logic:
- **Push:** List remote files → find missing indices → obfuscate + push each
- **Pull:** List remote files → find missing indices → deobfuscate → verify
  `prev_hash` linkage → return new blocks for local append

The index file is pushed as a separate obfuscated blob (`ledger/index.json`)
for lightweight remote queries without downloading blocks.

### Transport changes
- `AbstractStagingTransport` gains `list_files(prefix)` (default `[]`)
- `GitStagingTransport.list_files()` implemented via
  `git ls-tree -r HEAD --name-only -- <prefix>`

### Auth + safety
- `ph sync remote_ledger` forces re-auth before any operation
- Displays a sync summary (local count vs remote count, which blocks
  will be pushed/pulled)
- Requires explicit `y/N` confirmation before executing

### Rationale
- Append-only means no merge conflicts — each block is independent
- Sequence-numbered filenames avoid any date-level contention
- Reuses existing `RemoteStagingSync` obfuscation (same master key
  sub-key derivation) — no new crypto primitives
- `list_files` via `git ls-tree` avoids needing a separate index file
  for sync tracking (reducing write conflicts)

### Consequences
- **Positive:** Cross-device ledger sync is now possible. Genesis is pushed
  once, enabling clone-and-recover on new devices. Chain verification on
  pull prevents corrupted remotes from poisoning local data.
- **Negative:** The `list_files()` method requires a local git clone with
  up-to-date HEAD (adds a `git pull` before every `ls-tree`). Push/pull
  latency scales linearly with the number of missing block files (O(N)
  pull operations).
- **Implementation scope:** `domain/ledger/remote_sync.py` (new, 286
  lines), `core/sync/transport.py` (+`list_files`), `core/sync/git_transport.py`
  (+`list_files` +`_has_local_commits`), `main.py` (+`remote_ledger` subcommand
  with auth/review/confirm). No changes to engine, chain, or staging.

---

## ADR-022: Device Cookie — Deterministic HMAC Fast-Path Identity Check

**Date:** 2026-05-24
**Status:** ✅ Implemented

### Context

`check_and_sync()` needs to read the `device_id` from the remote staging blob to
decide whether auth is required. But the staging blob is encrypted with the master
key — you need the master key (which requires auth) to decrypt it. This creates a
**circular dependency**:

```
Want to know if auth is needed?
  → Need device_id from remote blob
  → Need master key to decrypt blob
  → Need auth to get master key
  → But we were trying to decide if auth is needed!
```

When decryption failed (e.g. stale key after `ph recover`), the old code silently
returned `None` from `pull()`, which `check_and_sync()` interpreted as "no remote blob"
→ proceeded without merging → overwrote the remote. This was the root cause of the
Session 2 data loss incident.

A secondary concern: the full staging blob is ~64KB+ and requires AES-CTR decryption
with integrity verification. Checking it on every command to determine "same device?"
is wasteful — we need a tiny, fast, keyed identity token.

### Decision

Introduce a **Device Cookie**: a deterministic 32-byte HMAC token that serves as a
fast-path identity check, eliminating the circular dependency while requiring only
32 bytes of remote data transfer.

```python
cookie_key = HMAC-SHA256(master_key, b"phpoc:cookie-key")
cookie = HMAC-SHA256(cookie_key, device_id + ":" + epoch_ms)
```

**Key properties:**

| Property | How it's achieved |
|---|---|
| **Deterministic** | HMAC-SHA256 is pure: same (mk, device_id, epoch_ms) → identical 32 bytes |
| **No decryption needed** | Cookie comparison is byte-for-byte (`hmac.compare_digest`) — no AES, no IV, no nonce |
| **Cannot be forged** | Needs master key to generate matching HMAC |
| **No profiling on remote** | Remote stores only 32 HMAC bytes — no device_id, no epoch |
| **TTL-enforced locally** | Plaintext `created_at` epoch in local-only sidecar (`device_cookie.meta`); never pushed |
| **Tiny network cost** | 32 bytes vs ~64KB+ staging blob (~2000× smaller) |

### Flow

```
check_and_sync():
  1. Local cookie valid? (TTL check against plaintext epoch)
     ├── No cookie / expired → destroy locally, fall through to slow path ↓
     └── Valid → pull remote cookie (32 bytes, no decrypt)
         ├── Cookies match? → READY (same device, same session → in sync)
         └── No match / no remote cookie → fall through to slow path ↓

  2. Slow path: pull + decrypt staging blob, device check, auth, merge

push_to_remote():
  1. Destroy stale local cookie
  2. DeviceCookie.create(mk, device_id, data_dir) → deterministic 32 bytes
  3. push_cookie(cookie_bytes) → remote (FIRST, before blob)
  4. push(entries, device_id, master_key) → staging blob
```

### Local file layout

```
~/.local/share/phpoc/
  ├── device_cookie.bin        ← Encrypted (HMAC) 32 bytes → pushed to remote
  └── device_cookie.meta       ← Plaintext: {"created_at": epoch_ms} → LOCAL ONLY
```

### Implementation

```
domain/
  cookie/
    __init__.py
    device_cookie.py           ← DeviceCookie class (pure utility, transport-agnostic)
  staging/
    remote_sync.py             ← pull_cookie(), push_cookie() via abstract transport
    service.py                 ← Fast-path in check_and_sync(), cookie in push_to_remote()
```

The `DeviceCookie` class is a pure utility with no transport dependency. It:
- Derives a cookie-specific sub-key from the master key (HMAC-SHA256 with `phpoc:cookie-key` prefix)
- Computes the deterministic cookie value via `HMAC(cookie_key, device_id + ":" + epoch_ms)`
- Writes two local files: encrypted cookie bytes + plaintext metadata
- Reads and validates TTL from the plaintext metadata
- Compares cookies via `hmac.compare_digest()` (timing-safe)
- Cleans up expired cookies automatically

The remote transport layer (`RemoteStagingSync`) handles pulling/pushing the cookie
bytes to/from remote via the abstract `AbstractStagingTransport` interface — no
dependency on git, GitHub, or any specific transport. The remote path is a simple
path string (`staging/blobs/device_cookie.bin`) — any transport supporting
hierarchical paths can use it.

### Cookie push ordering

The cookie is pushed **before** the staging blob. This matters for transport
implementations that store the last pushed data in a single slot (e.g. mock
transports in tests). Pushing cookie first ensures the staging blob is the final
write, preserving test compatibility.

### Rationale

1. **HMAC over deterministic encryption (AES-SIV):** HMAC is simpler, works with
   any key size, and we never need to decrypt the cookie — only compare. The 32-byte
   output is indistinguishable from random bytes to an attacker.

2. **TTL kill switch:** The plaintext epoch is only stored locally. If
   `device_cookie.meta` is deleted or corrupted, the cookie is treated as expired.
   There is no way for a stale session to persist beyond the TTL.

3. **No pull if local cookie missing/expired:** The TTL check is purely local — no
   network round-trip needed. Expired cookies are simply ignored, falling through
   to the slow path.

4. **Separated from staging reconciliation:** The cookie only answers "same device,
   same session?". If the cookie doesn't match, the system falls through to the
   full staging reconciliation flow (ADR-015a). The two concerns are independent.

### Consequences

- **Positive:**
  - Eliminates circular dependency — no more silent blob overwrites on key mismatch
  - ~2000× reduction in data transferred for identity check (32 bytes vs 64KB+)
  - No new crypto primitives — reuses existing HMAC-SHA256
  - Fully transport-agnostic — works with git, S3, HTTP, or any `pull/push` transport
  - Zero-regression test suite (1049 tests run, 2 pre-existing failures)

- **Negative:**
  - Adds two small files to the local data directory (negligible)
  - Cookie must be pushed before every staging push — one extra remote write per
    staging write (32 bytes, negligible cost)
  - The `cookie.ttl_minutes` config adds one more setting to maintain

- **Open questions:**
  - Staging reconciliation when cookie doesn't match — currently falls through to
    existing device-check + merge flow, but the reconciliation strategy needs formal
    definition (replace local? remote wins? merge with conflicts?)

### Implementation scope
- `domain/cookie/device_cookie.py` — new, 140 lines
- `domain/cookie/__init__.py` — new, package init
- `domain/staging/remote_sync.py` — +`pull_cookie()` + `push_cookie()` + `REMOTE_COOKIE_PATH`
- `domain/staging/service.py` — cookie fast-path + cookie creation on push
- `security/config_manager.py` — +`cookie.ttl_minutes`, +`cookie.enabled` defaults
- `main.py` — pass cookie config to `StagingService` constructor
- `tests/test_remote_config_wiring.py` — update for cookie push calls

---

## ADR-023: Serverless HTTP Transport — Replace git/SSH with Cloudflare Worker + R2

**Date:** 2026-05-24
**Status:** 🔮 Design direction — next implementation phase

### Context

The current transport is `GitStagingTransport` which shells out to `git` over SSH.
This produces two critical problems:

1. **~5s latency per command** — SSH handshake + `git pull --rebase` dominates every
   remote operation, even the 32-byte Device Cookie fast path.
2. **No mobile client possible** — git/SSH requires a full git installation and SSH
   keys. Mobile platforms have neither.

The Device Cookie benchmark (2026-05-24) measured:

```
Cookie check cycle — 5 runs
  Average total:  5121.0 ms
  Min total:      4911.3 ms
  Max total:      5331.0 ms

Phase averages:
  Local TTL check:      0.119 ms    ← essentially free
  Remote pull (git):  5120.900 ms   ← THE bottleneck (SSH handshake)
  Timing-safe cmp:      0.007 ms    ← essentially free
```

99.9% of the latency is SSH connection setup, not data transfer.

### Decision

Replace `GitStagingTransport` with a **stateless serverless HTTP transport**:

```
┌──────────────┐     HTTPS      ┌──────────────┐     S3 API      ┌────────┐
│  Python CLI  │ ──── GET/PUT ──►│  Cloudflare  │ ──── GET/PUT ──►│  R2    │
│  (or mobile) │ ◄─── HTTP ─────│    Worker    │ ◄─── S3 ────────│ Bucket │
└──────────────┘                └──────────────┘                 └────────┘
```

**The Worker** (~40 lines of TypeScript) is a stateless pass-through:
- `GET /{path}` → read from R2 bucket, return with `ETag` header
- `PUT /{path}` → write request body to R2 bucket
- `GET /?prefix={prefix}` → list objects by prefix
- No business logic, no crypto, no session state

**The Python side** gets a new `HttpStagingTransport` (~100 lines):
- Implements the same `AbstractStagingTransport` interface
- Uses `urllib.request` (stdlib — zero deps)
- Sends `If-None-Match` with cached ETag → gets `304 Not Modified` → returns cached data
- First request: TLS handshake (~100ms). Subsequent: HTTP keep-alive (~10-50ms)

**The bucket** (Cloudflare R2, or any S3-compatible) stores everything:
```
phpoc-data/
├── staging/blobs/
│   ├── current.json         ← Encrypted staging blob
│   └── device_cookie.bin    ← 32-byte HMAC cookie
└── ledger/
    ├── blocks/              ← Sequence-numbered day blocks
    │   ├── 000000.json
    │   ├── 000001.json
    │   └── ...
    └── index.json           ← Lightweight summary
```

Both Remote Staging and Remote Ledger sync use the **same bucket, same Worker,
same transport** — no changes to domain logic needed.

### Cost

At personal scale (~1000 commands/month):

| Provider | Storage (2MB) | Requests | Egress | Total |
|----------|--------------|----------|--------|-------|
| Cloudflare R2 | $0.00 (free tier) | Free | Free | **$0.00/mo** |
| AWS S3 | $0.000046 | ~$0.006 | ~$0.00 | **~$0.01/mo** |

Both offer free tiers that cover this usage indefinitely.

### Rationale

1. **Stateless serverless** — The Worker has no state. Every request is
   self-contained. No sessions, no databases, no background processes. Scales
   to zero when not in use.

2. **Mobile-ready** — The exact same HTTP API the Python CLI uses is what a
   React Native, Flutter, or native mobile app calls. Mobile devices don't
   need git or SSH.

3. **ETag-based freshness** — The HTTP `304 Not Modified` response is the
   protocol-level equivalent of the Device Cookie fast path. Zero bytes
   transferred when nothing changed.

4. **Preserves all domain logic** — `AbstractStagingTransport` abstracts the
   transport. Swapping `GitStagingTransport` for `HttpStagingTransport` is a
   1-line change in `main.py`. All 1049 tests continue to pass.

5. **Platform independence** — The Worker itself is TypeScript (learned
   incrementally on a tiny project), but clients can be Python, TypeScript,
   Swift, Kotlin, or anything that speaks HTTP.

6. **Existing infra** — User already has Cloudflare and AWS accounts. R2 and
   S3 are 5-minute setups.

### Consequences

- **Positive:**
  - CLI latency drops from ~5000ms to ~50-100ms
  - Mobile client becomes possible with zero new backend work
  - Same infrastructure serves staging AND ledger
  - No git/SSH dependency — deploy once, forget
  - Free at personal scale

- **Negative:**
  - Must deploy and maintain a Worker (trivial — ~40 lines, no dependencies)
  - Must migrate existing remote data from git to R2 (one-time, scriptable)
  - Loses accidental backup benefit of git history (mitigated by local ledger)
  - Requires HTTPS (TLS certificate) — provided free by Cloudflare

- **Open questions:**
  - Authentication: pre-shared API key in the Worker, or per-request HMAC
    signature (same crypto already in the codebase)?
  - Staging reconciliation strategy must be defined before mobile app writes
    can be reliable (deferred — see Phase 1 below)

### Migration plan

**Phase 1: Worker + Python CLI (this week)**
1. Create R2 bucket (`phpoc-data`)
2. Deploy Worker (GET/PUT/LIST with API key auth)
3. Write `HttpStagingTransport` in Python
4. Push all existing staging + ledger data from git to R2 via the Worker
5. Update `main.py` to use `HttpStagingTransport`
6. Verify CLI works end-to-end with ~100ms latency

**Phase 2: Mobile MVP (next)**
1. Re-implement crypto primitives (PBKDF2, AES-CTR, HMAC-SHA256) in mobile
   framework of choice
2. Build basic staging read/write via Worker HTTP API
3. Device Cookie for identity
4. Minimal UI (start/stop/view activities)

**Phase 3: Staging reconciliation + Ledger sync**
1. Define reconciliation strategy (remote source of truth)
2. Add ledger block push/pull to mobile

### Implementation scope
- `core/sync/http_transport.py` — new, ~100 lines
- `core/sync/transport.py` — unchanged (interface already exists)
- `main.py` — 1-line change (`HttpStagingTransport` instead of `GitStagingTransport`)
- `phpoc_cli/interface.py` — remove `git pull --rebase` fallbacks (no longer needed)
- `domain/` — unchanged (all domain logic is transport-agnostic)
- `tests/` — add `test_http_transport.py` (~20 tests against a mock HTTP server)

---

## ADR-024: Hash Index Fast Path — Login/Reauth Sync Speedup

**Date:** 2026-07-01
**Status:** ✅ Implemented (web client + CLI)

### Context

Every login (web) and unlock (CLI) triggers a full ledger chain pull from the remote —
up to N sequential HTTP GETs for N blocks. The common case (re-login from same device,
no new data) wastes dozens of round trips to discover "nothing changed." For a 105-block
chain, this meant 105+ HTTP requests with TCP+TLS handshake overhead, compounded by
Cloudflare Worker cold starts. Total latency: 4–30+ seconds.

The `pushLedgerBlocks()` call in the web client ran on every login regardless of
whether the merge produced new data — pushing 4+ HTTP PUTs (block, index, hash_index,
hash_index.sha256) redundantly. The `pullCookie()` call was duplicated (once in
fast-path phase, again in reconcile). And `_genesisCompatible` was never cached to
`true`, causing repeated genesis re-checks within a session.

### Decision

**A plaintext hash index** is stored on the remote. It contains block seal hashes
(already public data embedded in each encrypted block) and a SHA-256 checksum. The
index is NOT encrypted — requires no master key to read.

**Three-tier genesis check:**

| Tier | What | Network cost | When it applies |
|---|---|---|---|
| Tier 1 | Pull `hash_index.sha256`, compare to local SHA-256 | 1 GET | Chains identical (re-login) |
| Tier 2 | Pull `hash_index.json`, find fork point via seal comparison | 1–2 GETs | Remote extends local (other device added blocks) |
| Fallback | Full chain pull (all block files) | N GETs | First sync, divergent chains, missing/tampered index |

**Hash index format (plaintext, language-agnostic):**

```
ledger/hash_index.json   → ["abc123…", "def456…", …]
ledger/hash_index.sha256 → "1a2b3c…"
```

Each element in the array is `block.day_hash || block.month_hash || block.year_hash`.
Both the web client (JavaScript `hash_index.js`) and CLI (Python `remote_sync.py`)
produce identical output.

**Push gate in web client (`merged` flag):**

`GenesisGate.check()` returns a `merged` boolean alongside the merged chain. The
caller gates `pushLedgerBlocks()` on `merged` (not `mergedChain`, which was always
truthy). This eliminates redundant pushes on identical-chain logins:

| Return path | `merged` | Push needed? |
|---|---|---|
| Tier 1 SHA-256 match | `false` | No |
| Tier 2 linear_local | `false` | No |
| Empty remote | `true` | Yes (bootstrap) |
| Full pull + merge | `newBlockCount > 0 \|\| remote longer` | Only when merge changed data |

**Additional web client optimizations:**

| Optimization | What | Impact |
|---|---|---|
| Cookie caching | `_lastRemoteCookie` stores fast-path pull result; `_reconcileAndClaim()` reuses it | Eliminates 1 HTTP GET |
| Genesis caching | `_genesisCompatible = true` after successful check | Prevents redundant re-check within session |
| `clearRemote()` cleanup | Also deletes hash_index files | Prevents stale index residue after clear |

### Rationale

- **Plaintext is safe:** The hash index contains only block seals — already public data
  stored as plaintext within encrypted block files. An attacker who can list R2 objects
  already has access to `day_hash` fields in the encrypted blocks.
- **One-time bootstrap cost:** On first sync (or after `clearRemote`), one full chain
  pull bootstraps the index. Every subsequent login hits Tier 1.
- **Tamper detection:** If SHA-256 doesn't match the index, or pulled blocks don't match
  the seals at Tier 2, the system falls through to full pull. A corrupted index is
  treated as absent.
- **Self-healing:** Both clients push hash_index files after every successful sync.
  If deleted, the next sync rebuilds them.
- **Cross-client mutual benefit:** Web pushes the index; CLI's next sync hits Tier 1.
  CLI pushes the index; web's next login hits Tier 1. No coordination needed.
- **No new crypto primitives:** Plain JSON array + SHA-256. Both languages have these
  in their standard libraries.

### Consequences

- **Positive:**
  - Login/unlock drops from N network round trips to 1 in the common case
  - 105-block chain: ~10–30s → ~0.1s for re-login
  - 4+ unnecessary HTTP PUTs eliminated per web login
  - 1 unnecessary HTTP GET eliminated per web login
  - Both clients benefit from each other's index pushes

- **Negative:**
  - Introduces 2 new files on the remote (~2KB for 105 blocks — negligible)
  - Bootstrap gap: first-ever sync from any device must do one full pull (unavoidable —
    you can't know the remote's block seals without pulling at least once)
  - `clearRemote()` must also delete hash_index files (already implemented)

### Implementation

| Layer | File | What |
|---|---|---|
| Web sync | `phpoc-web/src/sync/hash_index.js` | `buildHashIndex()`, `compareHashIndexes()` |
| Web sync | `phpoc-web/src/sync/genesis_gate.js` | `merged` flag on all six return paths |
| Web sync | `phpoc-web/src/sync/sync.js` | Gated push on `merged`, cookie cache, genesis cache, clearRemote cleanup, `_debugCheckHashIndex()` |
| Web UI | `phpoc-web/src/components/screens/SyncSettings.jsx` | Clear Remote button + overlay, hash index debug panel |
| CLI sync | `domain/ledger/remote_sync.py` | `push_hash_index()`, `pull_hash_index()`, `_get_block_hash()`, `compare_hash_indexes()` |
| CLI sync | `core/sync/orchestrator.py` | Tier 1 SHA-256 fast path, Tier 2 fork-aware pull, `push_hash_index()` after sync + merge |

### Tests

- Web: 248 sync_service + 218 genesis_gate = 466 pass, 0 fail
- CLI: 1554 Python tests pass, 0 fail

### Related

- ADR-015 (Multi-Device Shared Encrypted Staging) — cookie/blob reconciliation is the
  remaining sync latency component not addressed by this decision
- ADR-022 (Device Cookie Fast-Path) — the cookie check happens before the genesis gate;
  the hash index fast path is additive, not a replacement
- `docs/planning/BACKLOG.md` P5 (CLI Unlock Latency) — partially resolved

---

## ADR-025: Row-Level Staging Sync — LWW Resolution Model

**Date:** 2026-07-08
**Status:** 🔮 Design direction — implementation plan defined (`docs/planning/ROW_LEVEL_STAGING_SYNC_PLAN.md`)

### Context

The staging area is currently a single monolithic encrypted blob pushed/pulled as
one unit (ADR-015b). Phase 3 work introduced `activity_id` (stable 10-char
CSPRNG identifiers) and a staging hash index for fast cross-client reconciliation.

The next architectural shift converts staging from a flat blob to a **row-per-activity
database** (SQLite on CLI, IndexedDB object store on web). This eliminates the need
for a separate staging hash index — the rows themselves ARE the index — and enables
100×+ smaller sync payloads (pull only changed rows instead of 64KB–512KB blob).

This ADR defines the **sync resolution model** for row-level staging. The model
covers all 8 conflict/merge scenarios that arise when two clients operate on the
same logical staging area via a remote row store.

### Decision

**Core principle: Last-Writer-Wins by `updated_at`.** Every staging row carries an
`updated_at` timestamp. Resolution is always LWW — the row with the newer timestamp
wins, whether it's local or remote.

**The 8-resolution scenario table:**

| # | Situation | Resolution |
|---|---|---|
| 1 | Same id, status differs, remote `updated_at` newer | Pull full row from remote → overwrite local |
| 2 | Same id, status differs, local `updated_at` newer | Push local row to remote in push phase |
| 3 | Same id, same status, `updated_at` differs | LWW on full row (pull or push, whichever is newer). `updated_at` is the single version signal — no separate content hash needed in manifest. |
| 4 | In remote manifest, not in local | Pull full activity row to local |
| 5 | In local, not in remote manifest, **in ledger hash index** | Delete from local staging (committed elsewhere) |
| 6 | In local, not in remote manifest, **not in ledger hash index** | Push to remote (genuinely new activity) |
| 7 | Remote empty (all committed) | Fast path: clear local staging, done |
| 8 | Committed on device A, device B unaware | Resolved by scenario 5 — ledger hash index pull reveals committed status |

**Sync cycle flow (per-connect):**

```
1. Cookie fast path (ADR-022) — unchanged, guards entry to sync
2. Pull remote staging manifest  →  [{activity_id, status, updated_at}, ...]
3. Pull ledger hash index        →  {entry_id → committed_at} (inline, always fresh)
4. Diff + LWW resolution:
   a. Compare manifest rows to local rows by activity_id
   b. For each difference, apply scenario table above
5. Push local changes to remote  →  PUT rows with updated_at guard
   a. Worker rejects if incoming updated_at ≤ stored updated_at → 409 Conflict
   b. Client re-pulls manifest on 409 and retries resolution
6. Return control to user — staging sync complete
```

**Async ledger sync follows independently:**

```
7+. Pull new ledger blocks (background, does not block user)
8+. Verify chain integrity
9+. Update local ledger + ledger hash index
```

**Push guard (Worker-side):**

The Worker rejects `PUT /storage/staging/rows/{activity_id}` when the incoming
`updated_at` is less than or equal to the currently stored `updated_at`. This
prevents older writes from overwriting newer data on a timing race. Client treats
`409 Conflict` as a signal to re-pull the manifest and re-resolve.

**Ledger hash index as tombstone mechanism:**

No ghost rows are stored in the staging database. Instead, the ledger hash index
(already maintained per ADR-024) is pulled inline during the staging sync cycle.
It answers the question "has this entry been committed?" — which is the same
information a traditional tombstone row would provide, without polluting the
staging DB.

**Staging vs ledger separation:**

| | Staging Sync | Ledger Sync |
|---|---|---|
| **Frequency** | Every connect/reconnect | Periodic / background |
| **Latency budget** | Must be fast (user waiting) | Can be slow (async) |
| **Data volume** | Small (manifest ~500B, changed rows only) | Large (full block blobs) |
| **Criticality** | Blocks user workflow | Doesn't block |
| **Bridge** | Ledger hash index (inline pull, tiny) | — |

### Rationale

- **LWW by `updated_at`:** Single-actor reality. Humans realistically operate one
device at a time. LWW is the simplest model that handles the rare cross-device
overlap correctly.
- **No content hash in manifest:** `updated_at` doubles as content version signal.
Any change to the activity blob bumps `updated_at`. No need for a separate hash.
- **Push guard (409):** Minimal server-side enforcement (numeric comparison, no
version tokens). Prevents the worst-class race (B's newer write overwritten by
A's older arriving-later write) at near-zero complexity cost.
- **Ledger hash index stays:** Immutable blocks can't be queried row-by-row.
The hash index remains the fast lookup for "is this committed?" and doubles as
the tombstone mechanism, avoiding ghost rows in staging.
- **Pull-side races accepted:** Between manifest fetch and row pulls, remote
state can change. Single-user reality makes this vanishingly unlikely;
any inconsistency self-corrects on the next sync cycle.
- **Async ledger sync:** Staging is the hot path (user is waiting). Ledger blocks
can arrive in the background. The ledger hash index is the only bridge needed
inline — and it's tiny.

### Consequences

- **Positive:**
  - Staging sync payloads shrink 100×+ (changed rows only vs full blob)
  - Hash index for staging becomes unnecessary — rows ARE the index
  - Ledger hash index serves double duty (commit lookup + tombstone signal)
  - Clean separation: staging sync is blocking and fast; ledger sync is async
  - Push guard prevents data regression from transport-level race conditions
  - Single-actor LWW is the simplest correct model for this use case

- **Negative:**
  - Requires Worker protocol redesign (new REST endpoints for row-level ops)
  - Per-row `updated_at` requires reliable clock sources on all clients (acceptable
    for single-user; clock skew across devices is bounded to seconds)
  - Migration from blob-based staging to row-based staging needed on both CLI and web
  - Worker must implement `updated_at` comparison guard (trivial numeric check, but
    new endpoint behavior to test)

- **Open questions:**
  - Clock skew tolerance: how far apart can two devices' clocks be before LWW
    produces the wrong winner? Mitigated by single-user reality.
  - Worker protocol specifics (endpoint paths, per-row obfuscation format) deferred
    to implementation plan.

### Implementation Plan

Detailed implementation rules and step-by-step phases are defined in:
`docs/planning/ROW_LEVEL_STAGING_SYNC_PLAN.md`

### Related

- ADR-015 (Multi-Device Shared Encrypted Staging) — the original shared staging model;
  this ADR replaces its blob-level sync with row-level sync
- ADR-015b (Staging Obfuscation) — per-row obfuscation format to be designed for
  the new Worker endpoints
- ADR-021 (Sync Optimization) — stable entry IDs and freshness tracking remain;
  row-level sync extends these to the staging DB
- ADR-022 (Device Cookie Fast-Path) — unchanged, still guards entry to sync cycle
- ADR-024 (Hash Index Fast Path) — ledger hash index is reused as tombstone mechanism
- `docs/planning/STAGING_ACTIVITY_ID_IMPLEMENTATION_AND_EXECUTION_PLAN.md` — Phase 3
  activity_id + staging hash index work that this design supersedes (staging hash index
  becomes redundant)

---

## ADR-026: Key Rotation — Versioned Master Keys

**Date:** 2026-07-17
**Status:** 🔮 Design direction — I-01 Phase 1
**Depends on:** I-04 ✅ (seal naming), I-06 ✅ (content_hash required)

### Context

The current architecture has a single Master Key (MK) that protects every entry,
block seal, index file, staging entry, and device cookie for the entire lifetime
of the ledger (ADR-001). The Seed _is_ the MK — 32 raw bytes. There is no
mechanism to rotate keys.

This is the single largest architectural gap in the protocol (BACKLOG §I-01,
🔴 Critical). If the MK is ever compromised — via memory dump, session cache
extraction, brute-forced passphrase, or lost/stolen device — all historical
_and_ future data is permanently exposed with no remediation path.

Key rotation must satisfy every top-level directive:

| Directive | Requirement |
|-----------|-------------|
| D2 (Zero-Knowledge) | Old data must still be decryptable by the authorized user after rotation |
| D4 (Chain of Trust) | Block seals and identity MACs must verify across key versions |
| D5 (Append-Only) | Historical blocks are never modified (soft rotation); hard rotation is an explicit migration with backup |
| D8 (Recoverability) | The Recovery Seed must still recover the entire ledger, including data under rotated keys |
| D9 (Backward Compat) | Existing ledgers must continue to work — rotation is opt-in |

### Decision

**Three-part design: versioned MK derivation, per-block key_version, and dual
rotation modes (soft/hard).**

#### 1. Versioned Master Key Derivation

Instead of seed = MK, the seed now derives versioned master keys via HMAC:

```python
# Seed is the root — still 32 raw bytes from base64 decode
seed = base64.b64decode(seed_string)

# Versioned master keys — domain-separated, deterministic
def derive_mk(seed: bytes, version: int) -> bytes:
    return hmac.new(seed, f"phpoc:mk:v{version}".encode(), hashlib.sha256).digest()

MK_v1 = derive_mk(seed, 1)  # 32 bytes
MK_v2 = derive_mk(seed, 2)  # 32 bytes — after first rotation
MK_vN = derive_mk(seed, N)  # 32 bytes — after N-1 rotations
```

**Backward compatibility:** The existing seed = MK behavior is equivalent to
`key_version = 1`. An existing ledger has `MK = seed` (the raw seed bytes).
After adopting this ADR, `MK_v1 = HMAC(seed, "phpoc:mk:v1")` — a different
value. This means **the first rotation is also a key change from the
original seed-as-MK to the derived MK_v1.**

This is the correct behavior: the original seed-as-MK design is `key_version = 0`
(implicit). The first explicit rotation moves to `key_version = 1` with a proper
derived MK. The seed still recovers everything — it just goes through the HMAC
step.

**Why HMAC over SHA-256?** HMAC-SHA256 with the seed as key and a versioned
message provides domain separation that SHA-256 alone does not. It prevents
an attacker who knows MK_v2 from computing MK_v1 or MK_v3 — the HMAC is
non-invertible without the seed.

#### 2. key_version Field

**Genesis block** carries the _current active_ key version:

```json
{
  "type": "genesis",
  "format_version": "0.5.0",
  "key_version": 2,
  ...
}
```

**Day blocks** carry the key version used to encrypt their entries:

```json
{
  "type": "day",
  "day_index": 42,
  "key_version": 1,
  "entries": [ ... ],
  ...
}
```

- If a day block has no `key_version` field, it defaults to the genesis
  `key_version` (backward compatibility with pre-rotation ledgers).
- Genesis `key_version` is always the highest (most recent) version.
- New blocks always use genesis `key_version`.
- Summary blocks (year/month) also carry `key_version` for consistency
  (their seals use the versioned MK, same as day blocks).

**Identity secret is version-independent.** The identity secret is a random
32-byte value, not derived from the MK. It is encrypted with the _current_
MK for storage in genesis (`identity_secret_enc_fallback`). On rotation,
this encrypted envelope is re-encrypted with the new MK. The identity
secret itself never changes — old block identity MACs remain valid.

#### 3. Per-Version Sub-Key Derivation

All sub-keys are derived from the versioned MK:

```python
# encryption sub-key (per operation)
enc_key = HMAC(MK_vN, random_16_byte_salt, sha256)[:16]

# integrity sub-key (per operation)
integrity_key = HMAC(MK_vN, random_16_byte_salt + b"-integrity", sha256)[:32]

# block sealing sub-key (fixed salt — per version)
seal_key = HMAC(MK_vN, b"integrity-key-salt", sha256)[:32]

# index encryption key
index_key = HMAC(MK_vN, b"phpoc-blind-index-v1", sha256)[:16]

# field token key
field_key = HMAC(MK_vN, b"phpoc-staging-keys-v1", sha256)[:16]

# device cookie key
cookie_key = HMAC(MK_vN, b"phpoc:cookie-key", sha256)[:32]
```

This means **every derived key changes with version.** Block seals computed
under MK_v1 will not verify with MK_v2. The system must select the correct
MK version per block.

#### 4. Session Key Material

On authentication, the system derives **all MKs from v1 through the current
genesis key_version** and caches them:

```python
mks = {}
for v in range(1, genesis_key_version + 1):
    mks[v] = derive_mk(seed, v)
```

This is cheap: each derivation is one HMAC-SHA256 (~microseconds). For a
ledger with 3 key versions, it's 3 HMACs. The cache lives in the session
RAM cache (ADR-014) and is cleared on logout/reboot.

**Sub-key caches per version** may also be pre-derived for the hot path
(encryption, sealing, index ops all use the current MK version). Old
versions are derived on-demand during verification or when reading old
blocks.

#### 5. Dual Rotation Modes

##### Soft Rotation (Lazy — `ph rotate-keys`)

1. Increment genesis `key_version` from N to N+1
2. Derive MK_(N+1) from seed
3. Re-encrypt `identity_secret_enc_fallback` with MK_(N+1)
4. Re-encrypt staging entries (if any) with MK_(N+1)
5. Rebuild and re-encrypt blind index with MK_(N+1)
6. Recompute device cookie with MK_(N+1)
7. Re-seal genesis with MK_(N+1) sealing sub-key
8. Recompute identity MAC on genesis

**Existing blocks are NOT touched.** They remain under their original
key_version. New blocks will use `key_version: N+1`.

**Pros:** Fast (O(1) — only genesis + staging + index). Non-destructive.
Old blocks can be archived later to naturally phase out old keys.

**Cons:** Old MKs must be retained for as long as old blocks exist.
Compromise of an old MK still exposes data from that key version's era.

##### Hard Rotation (Full — `ph rotate-keys --full`)

1. Perform soft rotation steps 1–7
2. For every day block in the chain:
   a. Decrypt all entry fields with the block's current MK version
   b. Re-encrypt all entry fields with MK_(N+1)
   c. Update `key_version` to N+1
   d. Recompute entry hashes
3. Re-seal every block with MK_(N+1) sealing sub-key (changes day_hash)
4. Re-link the chain (all prev_hash values change — cascading rewrite)
5. Recompute identity MACs on every block
6. Backup the old chain before overwriting

**Pros:** Old MKs can be securely discarded. Full cryptographic hygiene.
Every byte of ciphertext is protected by the new key.

**Cons:** O(entries) — re-encrypts every entry. Changes every block hash.
Requires full chain rewrite. Only practical for ledgers with < ~100K entries.

#### 6. Recovery Flow

Recovery (`ph recover`) with the seed:

1. Prompt for new passphrase
2. Derive new PDK from new passphrase
3. Re-encrypt seed with new PDK → update `recovery_seed_enc` in genesis
4. Derive ALL MK versions from the seed (up to genesis `key_version`)
   — unchanged because the seed is unchanged
5. Re-seal genesis with current MK version
6. Cache all MKs in session

**No entry data changes during recovery.** The seed is the root — all
MK versions derive from it deterministically.

#### 7. Verify Across Versions

`verify()` must handle multi-version chains:

```python
def verify(self):
    # ...
    for block in ledger:
        kv = block.get("key_version", genesis_key_version)
        mk = self._get_mk(kv)  # from session cache
        seal_key = derive_seal_key(mk)

        # Verify block seal uses versioned key
        if not verify_seal_with_key(block, seal_key):
            return False

        # For day blocks: decrypt entries with versioned MK
        if block["type"] == "day":
            for entry in block["entries"]:
                if not verify_entry(entry, mk):
                    return False

    return True
```

**Backward compatibility:** Existing ledgers have no `key_version` field.
`verify()` defaults missing `key_version` to the genesis value. For pre-ADR
ledgers where seed = MK, the system treats them as `key_version = 0` and
uses the seed directly as MK (the current behavior). After the first
rotation, `key_version = 1` with the HMAC-derived MK.

### Rationale

**Why versioned derivation instead of new random keys?**
Deterministic derivation from the seed means the seed still recovers
everything (D8). If we generated independent random keys per rotation,
we'd need to encrypt each old key under the new key and store them all —
a key tree that grows linearly with versions and is fragile (lose the
latest envelope, lose everything). The seed is the single secret a user
must safeguard (ADR-001) — keeping it as the root preserves simplicity.

**Why HMAC over SHA-256?**
HMAC-SHA256(seed, message) is a PRF (pseudorandom function) when the key
is uniform random. SHA-256 alone without keying is not — an attacker who
knows SHA-256(seed || "v2") might have an advantage in computing
SHA-256(seed || "v1") via length-extension or structure. HMAC eliminates
this class of attack. The seed is the HMAC key; the version tag is the
message. Non-invertibility is guaranteed by the PRF property.

**Why soft rotation as default?**
Soft rotation is the practical default: fast, safe, non-destructive. Most
users will do soft rotations periodically (e.g., yearly) and old blocks
will naturally age out through archiving (ADR-012, split at year
boundaries). Hard rotation is for the "I think my key was compromised"
scenario, where re-encrypting everything is worth the cost.

**Why not per-entry key_version?**
Entries within a day block all share the same key version (the block's
version). Per-entry versioning would add complexity without benefit: all
entries in a block are sealed together at the same time. If we ever need
mixed-version entries (e.g., partial re-encryption), we can add it later
without breaking the format — `key_version` on the entry would override
the block default.

**Why sub-keys change with MK version?**
The sub-key derivation salt (`b"integrity-key-salt"`, etc.) is fixed.
If the MK doesn't change, sub-keys don't change — same as today. But if
sub-keys _didn't_ change with MK version, key rotation would be
meaningless: an attacker who knows the old MK could derive the same
sub-keys and decrypt new data. Making sub-keys version-dependent ensures
that MK_v1 cannot derive the keys used by MK_v2.

### Consequences

- **Positive:**
  - Single largest architectural gap closed — key rotation is now possible
  - Seed still recovers everything (D8 preserved)
  - Existing ledgers work unchanged (D9 preserved)
  - Soft rotation is near-instant (O(1) blocks touched)
  - Hard rotation provides full cryptographic hygiene when needed
  - Identity secret is version-independent — old block signatures stay valid
  - Content hashes are unaffected (they're over plaintext, not ciphertext)

- **Negative:**
  - First rotation changes the MK (from raw seed to HMAC-derived MK_v1) —
    a subtle but necessary one-time shift
  - All sub-keys change per version — block seals, index encryption, staging
    encryption, device cookies must all be re-derived
  - verify() must select the correct MK per block (adds a dict lookup)
  - Hard rotation rewrites the entire chain (backup required; D5 requires
    explicit migration with backup, not in-place destruction)
  - `format_version` bump required for `key_version` field support
  - `identity_secret_enc_fallback` must be re-encrypted on every rotation

- **Open questions:**
  - Staging entries under old key versions after soft rotation: should they
    be re-encrypted eagerly or lazily? Proposal: eagerly on soft rotation
    (staging is mutable, small, and a re-encrypt is cheap).
  - Maximum key versions? Proposal: no hard limit. A personal ledger might
    see 5–10 versions over its lifetime. Derivation cost is negligible.
  - User interface for `ph rotate-keys`: require passphrase re-entry for
    safety (like `ph sync remote_ledger` forces re-auth).

### Implementation Scope

| Layer | File | Change |
|-------|------|--------|
| **Spec** | `PHPSPEC.md` §2, §4, §5 | Document `key_version` field, versioned MK derivation, dual rotation modes |
| **Crypto** | `security/crypto.py` | `derive_mk(seed, version)` function; `CryptoManager` accepts optional `key_version` |
| **Key mgmt** | `security/auth.py` | On auth: derive all MKs v1..N, cache in session |
| **Chain** | `domain/ledger/chain.py` | `key_version` on block build; per-block MK selection in `verify()` |
| **Engine** | `domain/ledger/engine.py` | `key_version` passthrough from genesis to block build |
| **Rotation** | `phpoc_cli/rotate_keys.py` (new) | `ph rotate-keys` command: soft + hard modes |
| **Index** | `domain/ledger/index_manager.py` | Rebuild index with versioned index key on rotation |
| **Staging** | `domain/staging/service.py` | Re-encrypt staging with new MK on rotation |
| **Cookie** | `domain/cookie/device_cookie.py` | Re-derive cookie with new MK on rotation |
| **Web** | `phpoc-web/src/` | JS equivalents: `deriveMk()`, `keyVersion` in blocks, multi-MK cache |
| **Migration** | `scripts/migrate_key_version.py` (new) | Add `key_version: 1` to existing genesis, derive MK_v1, re-seal |

### Related

- ADR-001 (Sovereign Key Model) — seed as root; this ADR extends it with versioned derivation
- ADR-005 (Content Hash) — content_hash survives re-encryption; key to hard rotation
- ADR-007 (Hierarchical Lock Chain) — block linkage via prev_hash; hard rotation rewrites chain
- ADR-011 (Format Versioning) — `format_version` bump required for `key_version` field
- I-04 (seal naming) ✅ — prerequisite; `identity_seal` field name cleared for this work
- I-06 (content_hash required) ✅ — prerequisite; hard rotation relies on verifiable content_hash
- BACKLOG §I-01 — the issue this ADR addresses

## ADR-027: Flutter Navigation — go_router

**Date:** 2026-07-17
**Status:** ✅ Adopted

### Context

The Flutter mobile app needs a navigation and routing system that supports:

1. **Phase-based auth gating** — different screens based on app lifecycle state
   (boot → loading, locked → unlock, ready → dashboard). Modeled on the web
   app's phase-based `currentScreen` state machine.

2. **Persistent bottom navigation** — 4 tabs (Dashboard, History, Sync, Settings)
   that preserve scroll state when switching tabs.

3. **Deep linking** — Android/iOS can open the app to a specific screen via a URL
   or notification tap.

4. **Back-button handling** — correct system back behavior across auth gates
   and tab transitions.

5. **Web URL compatibility** — if the app is later deployed to web (Flutter web
   target), routes should map cleanly to browser URLs.

### Options Considered

| | go_router | auto_route | Raw Navigator 2.0 |
|---|---|---|---|
| **Maintainer** | Flutter team (Google) | Community (Milad Akarie) | Built into Flutter |
| **Core model** | URL-first — path patterns map to screens | Type-first — codegen produces typed route classes | Manual RouterDelegate + RouteInformationParser |
| **Auth gating** | `redirect` callback on every navigation | `AutoRouteGuard` class, attached per route | Hand-written |
| **Bottom nav** | `StatefulShellRoute` (built-in, preserves tab state) | `AutoTabsRouter` | Hand-written |
| **Code gen required** | No (optional typed routes via `go_router_builder`) | Yes (`build_runner`) | No |
| **Deep links** | Built-in | Built-in | Hand-written |
| **Navigation calls** | Strings: `context.go('/history')` | Typed: `HistoryRoute().push(context)` | N/A |

### Decision

**Use go_router.** It is maintained by the Flutter team, requires zero code
 generation by default, `ShellRoute` maps directly to our bottom nav, and the
 `redirect` callback implements the phase-based auth gating identically to the
 web app's lifecycle state machine.

### Rationale

**Flutter-team maintenance.** go_router is published under the `flutter.dev`
verified publisher, listed in the official Flutter navigation docs, and declared
feature-complete (bug fixes continue, API is stable). It is the lowest-risk
choice for a multi-year project.

**No additional code generation.** The project already uses `riverpod_generator`,
`freezed`, `json_serializable`, and `drift_dev` — four codegen tools in the
build pipeline. Adding `auto_route_generator` would be a fifth, increasing build
complexity and introducing another generated-file-sync failure mode (stale
`.gr.dart` after merges or SDK bumps).

**Right-sized for 6 screens.** auto_route's compile-time-checked navigation is
valuable for apps with 30+ screens where fat-fingering a route string is a real
risk. PH Ledger has 6 screens. The go_router weakness (stringly-typed paths) is
mitigated by keeping all path strings in a single constants file.

**ShellRoute matches our UX.** The bottom navigation bar with 4 tabs that
preserve state across switches is exactly what `ShellRoute` (specifically
`StatefulShellRoute.indexedStack`) provides. This is the standard Flutter
pattern and maps cleanly to the web app's `AppLayout` component.

**Phase-based redirect matches the web.** The web app uses a `currentScreen`
state machine. go_router's `redirect` callback implements the same logic declaratively:

```dart
redirect: (context, state) {
  if (phase == AppPhase.boot) return '/loading';
  if (phase == AppPhase.auth) return '/unlock';
  if (phase == AppPhase.ready && state.matchedLocation == '/unlock') return '/';
  return null; // allow navigation
}
```

### Consequences

- **Positive:**
  - Lowest setup cost — already scaffolded and passing tests
  - Stable API — feature-complete, no churn expected
  - Deep links and web URLs work out of the box
  - `ShellRoute` handles tab state preservation without custom code
  - Largest community — most examples, most Stack Overflow answers
  - No additional codegen dependency

- **Negative:**
  - Navigation targets are strings, not types — a typo in `context.go('/histroy')`
    compiles but crashes at runtime. Mitigated by path constants file.
  - Flutter team declared go_router feature-complete — major new features will
    come from community packages, not core
  - Migrating to another router later would require rewriting the route layer
    (~120 lines in the current scaffold, so manageable)

### Related

- FLUTTER_ARCHITECTURE.md §7 — Navigation & Routing design
- FLUTTER_AXIOMS.md — Axioms C2 (navigation state owned by go_router, not Riverpod)
- app_router.dart — Implementation in the scaffold
- B1 (Dependency Direction) — routing is presentation-layer, owned by `routing/`

## ADR-028: Flutter Storage — Drift (SQLite) + SharedPreferences

**Date:** 2026-07-17
**Status:** ✅ Adopted

### Context

The Flutter mobile app needs on-device persistence for:

1. **Staging entries** — frequent CRUD (capture, end, pause, modify, remove).
   Dashboard queries active tasks reactively. History queries by date range.

2. **Ledger blocks** — append-mostly, queried by index during chain
   verification. Must survive app restarts.

3. **Blind index** — queried by date + tag for history filtering.
   Rebuildable from the chain.

4. **Preferences** — Worker URL, API key, device UUID, device cookie.
   Infrequent reads/writes. Some values are sensitive (API key).

5. **Master key** — derived at unlock, must never touch persistent storage.

The data is relational: entries belong to blocks, blocks form a linked chain
(via `prev_hash`), index entries reference blocks and entries. This is a
natural fit for SQL, not for a key-value or document store.

### Options Considered

Table data from the 2026 Flutter database landscape (Luci Studio guide):

| | Drift | sqflite | ObjectBox | SharedPreferences |
|---|---|---|---|---|
| **Model** | ORM over SQLite | Raw SQLite wrapper | NoSQL object store | Key-value |
| **Type safety** | Compile-time checked | Runtime SQL strings | Compile-time | N/A |
| **Reactive queries** | Built-in (streams auto-update) | Manual re-query | Manual | N/A |
| **Migrations** | Built-in, testable | Manual SQL | UID-based, fragile | N/A |
| **Relationships** | Joins, foreign keys | Your SQL | Limited (NoSQL) | None |
| **Codegen** | Yes (`build_runner`) | No | Yes | No |
| **Web support** | ✅ | ❌ | ❌ | ✅ |
| **Maintenance** | Healthy — Simon Binder + Stream/PowerSync sponsorship | Healthy — stable baseline | Healthy — commercial | Healthy — Flutter team |

### Decision

**Drift (SQLite) for entries, blocks, and blind index.**
**SharedPreferences for configuration values** (Worker URL, device UUID, cookie).
**flutter_secure_storage for the Worker API key.**
**In-memory only for the Master Key** (never written to disk; zeroed on lock).

```
┌──────────────────────────────────────────────────────────┐
│  In-Memory (RAM only)                                    │
│  ┌──────────────────────────────────────────────────┐    │
│  │ Master Key (32 bytes) — zeroed on lock/logout    │    │
│  └──────────────────────────────────────────────────┘    │
│                                                          │
│  SharedPreferences / flutter_secure_storage               │
│  ┌──────────────────────────────────────────────────┐    │
│  │ Worker URL │ Device UUID │ Cookie │ API Key 🔐   │    │
│  └──────────────────────────────────────────────────┘    │
│                                                          │
│  Drift / SQLite                                          │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐   │
│  │ entries     │  │ blocks       │  │ index_entries │   │
│  │ (staging)   │  │ (ledger)     │  │ (blind index) │   │
│  └─────────────┘  └──────────────┘  └───────────────┘   │
└──────────────────────────────────────────────────────────┘
```

### Schema

```sql
-- Staging entries: mutable scratchpad
CREATE TABLE entries (
  entry_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  start_epoch INTEGER NOT NULL,
  end_epoch INTEGER,           -- NULL = still running
  is_active INTEGER NOT NULL DEFAULT 1,
  committed INTEGER NOT NULL DEFAULT 0,
  device_uuid TEXT,
  content_hash TEXT,
  metadata_enc TEXT,           -- encrypted JSON, base64
  tags TEXT,                   -- JSON array ["coding", "work"]
  pauses TEXT,                 -- JSON array of {start, end}
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_entries_active ON entries(is_active);
CREATE INDEX idx_entries_committed ON entries(committed);
CREATE INDEX idx_entries_start ON entries(start_epoch);

-- Ledger blocks: append-mostly, immutable
CREATE TABLE blocks (
  block_id TEXT PRIMARY KEY,
  block_type TEXT NOT NULL,    -- genesis, year, month, day
  block_index INTEGER NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  data_enc TEXT NOT NULL,      -- encrypted JSON, base64
  identity_seal TEXT,
  prev_hash TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_blocks_type ON blocks(block_type);
CREATE INDEX idx_blocks_index ON blocks(block_index);

-- Blind index: derived cache, rebuildable from chain
CREATE TABLE index_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  block_id TEXT REFERENCES blocks(block_id),
  date TEXT NOT NULL,          -- YYYY-MM-DD
  tag TEXT,
  entry_id TEXT NOT NULL
);

CREATE INDEX idx_index_date ON index_entries(date);
CREATE INDEX idx_index_tag ON index_entries(tag);
```

### Rationale

**Why Drift over sqflite?**

The project already uses `build_runner` for Riverpod, Freezed, and
json_serializable — Drift's codegen is not a new dependency, it's the
same tool. In exchange, we get:

- Compile-time-checked queries — rename a column, the query breaks at
  build time, not at 2 AM on a user's phone
- Reactive streams — `watch()` turns any query into a live-updating
  stream, which maps directly to the dashboard's need to reflect
  changes immediately
- Testable migrations — Drift exports schema snapshots and generates
  migration tests that verify old data survives upgrades

**Why not ObjectBox?**

ObjectBox's headline feature is built-in data sync, which would replace
the Worker protocol, merge engine, genesis gate, and device cookie
system — all of which are already designed, tested, and proven in the
web and CLI codebases. Adopting ObjectBox's sync would mean rewriting
our sync layer to fit its model. And our data is relational (entries →
blocks → chain), which SQL models naturally.

**Why not Isar or Hive?**

Both were abandoned by their original author. Community forks exist but
carry maintenance risk — a stalled fork on a new Dart SDK version means
a migration under deadline. The lesson of the 2022–2025 Flutter database
landscape is that maintenance is the most important feature of a
persistence library. Drift is actively maintained and commercially
sponsored.

**Why JSON columns for tags and pauses?**

Tags and pauses are small, append-only lists. A separate join table
would be correct for a many-to-many relationship, but PH Ledger's tags
are a handful per entry (< 10) and pauses are 0–2 per entry. JSON
storage avoids join overhead for data that is always read/written
together with its parent entry. The blind index handles the "find all
entries with tag X" query.

**Why SharedPreferences for config instead of a `settings` table?**

Configuration values are single keys read at startup (Worker URL) or
during sync (cookie, API key). They don't participate in relationships,
queries, or reactive updates. A full SQL table for ~5 rows is overhead.
`flutter_secure_storage` for the API key uses Android's
EncryptedSharedPreferences and iOS's Keychain — OS-level protection
for a credential.

**Why in-memory for the Master Key?**

D3 of FLUTTER_AXIOMS: the master key exists only in RAM. It is never
written to disk, never stored in SharedPreferences, never persisted.
On lock/logout, it is zeroed. This is the same model as the CLI's
session cache (`/dev/shm`) and the web's IndexedDB-cached encrypted
seed (which requires the passphrase to decrypt).

### Consequences

- **Positive:**
  - Type-safe queries — column renames caught at build time
  - Reactive UI — dashboard auto-updates when entries change
  - Testable migrations — schema changes are explicit and verified
  - SQLite is battle-tested — the most proven embedded database
  - No new codegen tool — same `build_runner` as Riverpod/Freezed
  - Clear separation: structured data → Drift, config → SharedPreferences,
    secrets → in-memory

- **Negative:**
  - Drift adds a codegen step — but the project already has four codegen
    dependencies, so this is the 5th, not the 1st
  - Must think in SQL/tables — simpler than IndexedDB's schema-less model,
    but more ceremony than a pure key-value store
  - Migrations must be tested — each schema change requires a migration
    test. Drift's tooling makes this straightforward, but it's work that
    key-value stores avoid
  - Two JSON columns (tags, pauses) are denormalized — if we ever need
    to query by tag without the blind index, we'd need to refactor

### Related

- FLUTTER_ARCHITECTURE.md §8 — Data Layer design
- FLUTTER_AXIOMS.md — Axioms D1 (SQLite is source of truth), D2 (encrypted
  at rest), D3 (MK in memory only), D6 (Worker is dumb)
- RELEASE_CHECKLIST.md §2.4 — Rust crypto cross-compilation targets
- ADR-001 (Sovereign Key Model) — MK derivation from seed
- ADR-009 (Local-First) — local storage is authoritative; remote is mirror
- lib/data/storage/database.dart — Current provider stub (to be replaced
  with full Drift database class)

---

## ADR-029: Canonical Block-Seal Field Set (Cross-Client Convergence)

**Date:** 2026-08-09
**Status:** ✅ Adopted (Choice 3 from `CANONICAL_SEAL-FIELD_Design.md`)

### Context

A 0.4.0-migrated ledger (`2303-2026-08-08-Ledger-after-4-migration.json`, 129 blocks,
270 entries) verifies under Python (`chain.verify()` → True) but fails to verify on the
phpoc-flutter phone build (0/129 block seals). Diagnosis isolated the failure to the
block-seal field set: the four implementations seal over different fields.

At `format_version ≥ 0.4.0`, every block carries an HMAC-SHA256 seal over a canonical
subset of its fields. That subset is currently inconsistent across clients:

| # | Client | Seal includes | Excludes |
|---|--------|---------------|----------|
| A | Python `chain.py:450` | all fields | `{hash_key, identity_seal, signature, format_version, key_version}` |
| B | Web `chain.js:528` | all fields | `{hash_key, signature, identity_seal}` (does NOT exclude `format_version`/`key_version`) |
| C | Flutter Phase-4 `_sealFields` | `{type, day_index, date, prev_hash, entries}` (fixed whitelist) | everything else |
| D | Migration tool `_seal_block` | all fields (Python convention) | `{hash_key, identity_seal, signature, format_version, key_version}` |

On the migrated ledger the only differing field is **`original_hash`** (the provenance
hash the migration writes on every block before re-sealing). The Phase-4 refactor
(`a5b124e`) narrowed Flutter's verification to a 5-field whitelist that excludes it
by omission. PHPSPEC does not define a 5-field whitelist; its seal definition
("HMAC over a block's content, excluding the seal field itself") implies an open set.

### Options Considered

1. **Open set: all fields except `{hash_key, identity_seal, signature, format_version,
   key_version}`** (Python/migration). Includes `original_hash`. No re-migration needed.
   But future/client-specific block fields silently enter the seal → cross-client
   breakage on every schema addition (the failure class that caused this incident).

2. **Open set: all fields except `{hash_key, signature, identity_seal}`** (Web's current).
   Includes `format_version` and `key_version` in the seal — these are mutated by
   rotation/migration, so seals break on every key rotation / format bump. Rejected.

3. **Closed whitelist including `original_hash`** — `{type, day_index, date, prev_hash,
   entries, original_hash}`. Explicit, rotation-safe, provenance-tamper-covered, but
   requires re-migrating the ledger and updating all three clients + the migration tool.

4. **Closed whitelist excluding `original_hash`** (current Flutter Phase-4) —
   `{type, day_index, date, prev_hash, entries}`. Tightest, but leaves provenance
   outside the seal and still requires re-migration + updating Python/Web.

### Decision

**Adopt Option 3: a closed canonical whitelist.**

```
SEAL_FIELDS = { type, day_index, date, prev_hash, entries, original_hash }
```

All four implementations (Python, Web, Flutter, migration tool) seal over **exactly these
six fields**, in that canonical role, using `json.dumps(seal_data, sort_keys=True)`
(Python) / byte-equivalent `jsonSort` (Dart) with space-separated separators. Fields
outside the whitelist — `format_version`, `key_version`, `identity`, `identity_seal`,
`signature`, and any future metadata — are **never** part of the block seal.

`original_hash` is included so provenance (proof that a block is unchanged from its source
chain) is itself tamper-covered. `format_version` / `key_version` are excluded so key
rotation and format bumps do not invalidate seals.

### Rationale

- **Predictability (D4):** a closed set means future fields never silently invalidate
  cross-client seals — the exact failure class from this incident.
- **Provenance integrity:** `original_hash` is sealed, so the migration's provenance
  guarantee is authenticated, not merely stored.
- **Rotation/format-safe:** `format_version` / `key_version` stay out of the seal, fixing
  Web's latent exclusion bug and avoiding key-rotation breakage.
- **Deterministic contract:** six fixed, named fields identical across all four
  implementations and documentable in PHPSPEC with shared canonical test vectors.
- **Consistency:** preserves the Phase-4 `_sealFields` closed-set design while correcting
  its single omission (`original_hash`).

### Consequences

- **Positive:** verified-elsewhere ledgers verify on Flutter; one canonical contract across
  all clients; provenance tamper-covered; rotation/format bumps don't break seals; the
  web exclusion bug is removed.
- **Negative / effort:**
  - Requires updating PHPSPEC, Python `chain.py`, Web `chain.js`, Flutter `chain.dart`,
    and the migration tool (`phpoc_cli/migrate_format.py`, standalone `migrate-format.py`)
    to the same 6-field whitelist.
  - Requires **re-migrating** the current 0.4.0 ledger to restamp all 129 block seals
    (`original_hash` retained in its field; `format_version`/`key_version`/etc. stay
    non-sealed). Original is backed up — consistent with D5/D9.
  - Requires new cross-client canonical seal test vectors shared by Python/Web/Flutter.
- **Backward compatibility (D9):** pre-0.4.0 ledgers and pre-existing 0.4.0 blocks that do
  not carry `original_hash` still verify, because the whitelist only *includes fields that
  are present* (`original_hash` is optional-if-absent; the other five are present on all
  canonical block types).

### Related

- `docs/design/CANONICAL_SEAL-FIELD_Design.md` — full cross-client divergence analysis and
  option comparison
- `docs/spec/PHPSPEC.md` — block structure; seal definition (to be updated with whitelist)
- ADR-005 (Extensible Content Hash) — content-hash open-set; seal field-set is a separate,
  closed contract
- ADR-007 (Chain of Trust), ADR-011 (Backward Compatibility)
- Verifiers: `domain/ledger/chain.py`, `phpoc-web/src/ledger/chain.js`,
  `phpoc-flutter/lib/data/ledger/chain.dart`; migration tool `phpoc_cli/migrate_format.py`

---

## ADR-029a: Canonical Block-Seal Field Set Is Type-Aware (Amends ADR-029)

**Date:** 2026-08-09
**Status:** ✅ Adopted (per-type amendment to ADR-029; see `SEAL_FIELDS_TYPE_AWARE_AMENDMENT.md`)

### Context

ADR-029 fixed a single closed 6-field whitelist for **all** block types:

```
SEAL_FIELDS = { type, day_index, date, prev_hash, entries, original_hash }
```

That flat rule is correct for `genesis` and `day` blocks but structurally **cannot** be the
seal-input rule for summary blocks, which carry `month`/`year` and **no** `day_index`/`entries`.
On a `month_summary`/`year_summary` the flat whitelist selects only `{type, date, prev_hash,
original_hash}` and drops the block's identity field (`month`/`year`) from the seal.

Ground truth from the four implementations shows summary blocks already diverge cross-client:
Python/Web/migration seal `month`/`year` (open-set) while Flutter's `_sealFields` drops them.
So the ADR-029 claim that the *only* differing field is `original_hash` is **false for summaries**.

The security stakes: per PHPSPEC §4.2 and D5, a summary is the **chain split/archive trust
anchor** — loading a multi-year ledger modularly relies on the summary's `month`/`year` being
authentic. Leaving them outside the seal permits re-labeling a partition boundary without
violating verification, and the "re-derive from sealed day blocks" mitigation is unusable in a
modular design where adjacent blocks may not be loaded.

### Options Considered

1. **Strict ADR-029 (flat whitelist):** summaries drop `month`/`year` from the seal. Keep the
   single 6-field constant, but `month`/`year` become non-authenticated metadata.
   Rejected: breaks existing cross-client summary parity, leaves partition identity unprotected.
2. **Type-aware closed whitelist (this amendment):** one frozen per-type field set; `genesis`/`day`
   unchanged, summaries seal their `month`/`year`. Preserves the closed-set and `original_hash`
   properties while sealing the summary's partition identity.
3. **Open-set for summaries:** seal all summary fields. Reintroduces the open-set failure class
   (future/client fields silently enter the seal). Rejected.

### Decision

Adopt Option 2 — a closed, **type-aware** seal-input field set:

| Block type | Seal-input fields (closed) |
|-----------|-----------------------------|
| `genesis`  | `type, day_index, date, prev_hash, entries, original_hash` |
| `day`      | `type, day_index, date, prev_hash, entries, original_hash` |
| `month_summary` | `type, month, prev_hash, date, original_hash` |
| `year_summary`  | `type, year, prev_hash, date, original_hash` |

Selection/serialization:

```
rendered  = { k: v for k, v in block.items() if k in SEAL_FIELDS[block["type"]] }
json.dumps(rendered, sort_keys=True)   # or byte-equal jsonSort (Dart)
```

- `original_hash` stays optional-presence on all four types (sealed when present; absent on
  new/pre-0.4.0 blocks).
- A block type with no entry in the map is verification-invalid (reject).
- Fields outside the per-type set are **never** sealed (`format_version`, `key_version`, `identity`,
  `identity_seal`, `signature`, the hash keys, and any future/client-specific field).

### Rationale

- **Partition integrity (D5):** the summary's `month`/`year` identity is the split/archive trust
  anchor; sealing it prevents undetected re-labeling of chain boundaries in modular loading.
- **Closes a real divergence:** Python/Web/migration and Flutter already disagree on summary seals;
  this makes cross-client summary verification converge to one rule.
- **Preserves closed-set contract (D4):** per-type sets are explicit and frozen; no open-set rule,
  no silent future-field leakage.
- **Backward compatible (D9):** `genesis`/`day` unchanged (identical to ADR-029). Summaries carry
  `month`/`year`/`date`/`prev_hash` in all current formats, so the per-type set selects them
  consistently after re-migration.

### Consequences

- **Positive:** summary partition identity is tamper-covered; fixes a real pre-existing
  cross-client summary divergence; enables modular/split-chain integrity (D5).
- **Negative / effort:** the whitelist is no longer a single constant — cross-client per-type
  tables must be identical and tested (Phase 6 vectors per block type); existing migrated ledgers'
  summary seals must be re-stamped onto the exact per-type set during re-migration (backup first,
  D5/D9). `Python Ph-3` verification must route all ~13 seal sites across 8 files through the table
  to clear the 55 regressions exposed by the partial change.
- **Fixture correction:** hand-built test summaries that carry fixture-only variants
  (`month_index`, `day_count`, `total_duration` — not real ledger fields) must be corrected to the
  real `{type, month, prev_hash, date}` shape so tests reflect production.

### Related

- ADR-029 (this amendment refines its flat whitelist for summary blocks)
- `docs/design/CANONICAL_SEAL-FIELD_Design.md`
- `docs/planning/SEAL_FIELDS_TYPE_AWARE_AMENDMENT.md` (per-type table + rationale)
- `docs/planning/CANONICAL_SEALFIELD_PYTHON_PHASE1.md` (Phase 1 blueprint — A7/C3/C4 to update)
- PHPSPEC `docs/spec/PHPSPEC.md` §4.1–§4.3, §4.2 (partition point) — to document the per-type set

---

## ADR-030: Ledger Auto-Pull on Ownership-Handoff Reauth

**Date:** 2026-08 (Phase 1 blueprint `docs/planning/LEDGER_AUTO_PULL_ON_REAUTH_PLAN.md`)
**Status:** ✅ Implemented (Flutter + Web; 4-phase TDD complete 2026-08-11) — Flutter blueprint `docs/planning/LEDGER_AUTO_PULL_ON_REAUTH_PLAN.md`; Web parity port blueprint `docs/planning/WEB_LEDGER_AUTO_PULL_PHASE1.md`.

### Context

A user works across devices (Flutter, Web, CLI). On picking up a device and
re-authenticating, they expect to see **both** the ledger's last state _and_ the
staging scratchpad's last state — running activities still running, and committed
history reflected. The staging auto-sync path (ADR-025 / ROW_LEVEL_STAGING_SYNC_PLAN)
already handles staging pull+merge, but the **ledger** is not refreshed as part of
the reauth/claim handoff: committed blocks only reach a device via a separate manual
"Push Ledger to Cloud" + `LedgerPullService` step.

Two binding contracts frame the decision:

- **D11 (Staging/Ledger Separation):** committing is a user-initiated **move** —
  staged entries are sealed into a block and removed from staging. This sanctions the
  user requirement that committed activities are wiped from staging, locally and remote.
- **D5 (Append-Only):** blocks are appended, never edited in place. Therefore _"did the
  ledger change?"_ reduces to _"did the block count / final hash change?"_.

And an ownership-security requirement: **reauth on device switch is mandatory**
(consented by the user) — a stale, previously-used device must not be able to modify
staging/ledger without re-authenticating. Ledger auto-pull is therefore gated to the
ownership-handoff moment, not every sync.

### Decision

1. **Refresh the remote ledger only on an ownership-handoff reauth** — i.e.,
   `checkAndSync()` triggering REAUTH via a **cookie specifier mismatch**, or a
   **fresh no-cookie reconcile-and-claim**. It must **NOT** run on a valid-cookie
   fast path (same device, TTL valid) nor on a **TTL-expiry with an unchanged
   specifier** (same device aging out) — those are not handoffs and must not incur a
   chain re-download.
2. **Freshness detector = plain block-count via `ledger/hash_index.json`** (plaintext
   array of block hashes, no MK/decryption needed). `LedgerPullService` already reads
   it. The auto-pull compares remote hash-index length to local block count:
   - **equal** → no ledger change since last sync → skip the block download (avoids
     the waste of re-pulling an unchanged chain).
   - **remote greater** → pull only the missing `ledger/blocks/*.json` files.
   - Block-count equality is sufficient for now (append-only ⇒ count is monotonic); a
     final-hash equality check is recorded as a future hardening if needed.
3. **Ordering for Scenario-5 cleanup:** pull+verify the ledger **first**, then
   reconcile staging using the local ledger hash index to delete committed-in-ledger
   rows. **Fail-safe:** if the ledger pull/verify fails, **keep** local staging rows
   (never delete on unverified info).
4. **Committing device cleanup:** a user-initiated "Commit to Ledger" seals the new
   block, **auto-pushes the new ledger to Remote** (same action), and **removes the
   committed rows from staging** (local + remote). This realizes D11's move semantics.
5. **Cross-client gate parity (§12):** "pull remote ledger on ownership-handoff reauth"
   is added as a protocol rule so CLI/Web/Flutter produce identical outcomes. The
   Flutter implementation is the concrete first target; CLI/Web parity is follow-on.

### Rationale

- **Matches user intent (D1/D6):** a device sees the ledger's last authentic state
after reauth without a manual/additional push step, which is the cross-device usage
they specified.
- **Avoids the same-device re-download** the user explicitly did not want: no ledger
pull on TTL-expiry-with-matching-specifier, no pull on the valid-cookie fast path.
- **D5 append-only makes block-count a sound freshness signal** — cheap (plaintext,
O(1)) and correct, without storing a separate "last modified" timestamp.
- **Security preserved:** pull is gated to genuine ownership handoffs (specifier
mismatch / fresh claim); REAUTH consent stays. Wrong-MK devices still cannot decrypt
committed blocks.
- **D11 honored:** ledger auto-pull never promotes staging into the ledger; it only
brings committed blocks into the local ledger. Committed-staging wipe is the
reverse-and-sanctioned direction.
- **D8/D9:** pulling committed blocks is backward compatible — it heals a stale device
to the canonical chain.

### Consequences

- **Positive:** after reauth on a new device, the ledger reflects its last state and
staging is reconciled against the now-current ledger (Scenario 5/6 cleanup).
- **Effort:** new gating in `checkAndSync` (distinguish specifier-mismatch from
TTL-expiry-with-same-specifier by preserving the prior specifier), a `LedgerPullService`
invocation at the handoff point, a `MergeEngine` scenario-5/6 ledger-hash-index check,
and wiring ledger auto-push + staging wipe into `commitEntries`.
- **Divergence note (not resolved here):** ADR-022/ADR-001 describe **deterministic
MK-derived** cookie/device identity, while the Flutter impl currently uses a **random
`device_specifier`** (`DeviceCookie._generateSpecifier`) and `deriveMasterKey(seed)` =
hex(seed bytes). This ADR does not change that; it only gates ledger pull on whichever
specifier semantics are active.

### Related

- ADR-022 (device cookie), ADR-025 (row-level staging), ADR-024 (hash index fast path)
- `docs/reference/CROSS_CLIENT_STAGE_SYNCING_REFERENCE.md` §12 (identical gate across clients)
- `docs/planning/LEDGER_AUTO_PULL_ON_REAUTH_PLAN.md`
- `docs/planning/ROW_LEVEL_STAGING_SYNC_PLAN.md` (8-scenario LWW table; Scenario 5/6)
