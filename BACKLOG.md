# PH Ledger — Backlog

> Issues, observations, and recommendations identified during codebase review.
> Organized by severity. Each item references specific files and lines.
>
> **Roadmap-blocking issues are detailed in [`ROADMAP-BLOCKS.md`](ROADMAP-BLOCKS.md).**
> This document is the full backlog; ROADMAP-BLOCKS.md is a focused subset.

---

## 🚩 Roadblocks (Blocking or Impacting Planned Roadmap Items)

These issues directly affect the ability to implement roadmap features as designed.

### R1. AES-CTR Malleability — No Authentication Tag

**File:** `security/crypto.py` (class `PureAESCTR`, lines ~160-180)

AES-CTR without an authentication tag is malleable: an attacker who modifies ciphertext can predictably change the decrypted plaintext. This doesn't break current functionality (the HMAC seal on each block provides integrity at the block level), but it becomes a problem for:

- **Roadmap item: Reconciliation / Chain-Bridging** — When grafting orphaned blocks into the ledger, entry-level data integrity is checked only by individual entry hashes. If an entry's `startTime_enc` or `metadata_enc` ciphertext is manipulated, the entry hash will still match the tampered ciphertext — the entry `data` dict is hashed **after** encryption. This means a malleability attack on staged or orphaned entries could go undetected by the entry hash alone.
- **Roadmap item: Remote Sync (git-based)** — If ledger files are synced over git, they traverse third-party infrastructure (GitHub/GitLab). AES-CTR malleability means a malicious mirror could silently corrupt encrypted fields without breaking the block seals (which validate the block JSON structure, not the decrypted plaintext).

**Recommendation:** Either (a) use a standard AEAD construction (AES-GCM) when the zero-dep constraint is relaxed, or (b) add an HMAC tag over `(nonce || ciphertext)` using a separate integrity key (encrypt-then-MAC). This is a pre-condition for trustworthy reconciliation and remote sync.

**Severity:** 🔴 High — blocks 2 roadmap items (Reconciliation, Remote Sync)

**Resolution (2026-04-28, branch `R1-AES-CTR-Malleability`):**

Added encrypt-then-MAC to `CryptoManager.encrypt()` / `decrypt()` in `security/crypto.py`:

- **Approach:** Option (b) from recommendation — HMAC-SHA256 tag over `(nonce || ciphertext)` using a derived integrity sub-key (`salt + b"-integrity"`). No new dependencies.
- **Why this over AES-GCM:** Preserves the project's zero-dependency commitment for the core engine. AES-GCM can replace this later when optional dependencies are allowed (e.g., for Ed25519 signatures) with ~20 lines of change.
- **Format change:**
  - **Old:** `salt(16) + nonce(8) + ciphertext`
  - **New:** `salt(16) + nonce(8) + ciphertext + tag(32)`
- **Backward compatibility:** `decrypt()` detects the format by byte-length (old has no tag, new has 32-byte tag appended). Old encrypted fields remain decryptable.
- **Tamper detection:** Any modification to ciphertext produces a tag mismatch and raises `ValueError("Encrypted data integrity check failed: auth tag mismatch")`.
- **Entry hash caveat unchanged:** The entry hash still covers ciphertext (not plaintext). The auth tag ensures ciphertext integrity at rest, but entry-level *plaintext* content proofs (R4) remain a separate concern for Reconciliation.

All 16 existing tests pass. Manual tamper test confirms rejection.

---

### R2. Identity Recovery Has No Fallback if `identity.json` Is Lost

**File:** `main.py` (recover handler, lines ~90-110), `storage/file_store.py` (read_identity)

The `recover` command updates the encrypted seed in the genesis block with a new passphrase, but `identity.json` is never touched. The identity secret inside `identity.json` is encrypted with the Master Key (derived from the seed). Since the seed doesn't change during recovery, the identity can still be decrypted — **provided `identity.json` is still present**.

If `identity.json` is lost or corrupted:
- The user can recover their seed and passphrase
- Ledger blocks are still decryptable (Master Key works for AES-CTR)
- **But block signatures can no longer be verified** — the identity secret is gone
- `sync_day()` calls `_get_identity_secret()` which returns `None`
- New blocks are appended **unsigned**
- The ledger transitions from signed to unsigned blocks, breaking chain consistency

**Roadmap impact:**
- **Roadmap item: Single-file export** (`phpoc export --combined`) — This planned feature would merge identity into Genesis for portability. The current split-file design means users must back up two files (`ledger.json` + `identity.json`). If `identity.json` is lost, the export would be incomplete and signature verification for old blocks would be permanently broken.
- **Roadmap item: Remote Sync** — If only `ledger.json` is git-synced (as the roadmap design sketch suggests), the identity is left behind. Pulling the ledger onto a new machine without `identity.json` means unsigned blocks from that point forward.

**Recommendation:** Either (a) embed a copy of the encrypted identity secret inside the genesis block as a fallback (making the ledger self-contained), or (b) emit a strong warning during `init` that `identity.json` must be backed up, and add a `--regenerate-identity` recovery sub-command that signs all existing blocks with a new key.

**Severity:** 🔴 High — blocks 2 roadmap items (Single-file export, Remote Sync)

---

### R3. PBKDF2 Iteration Count Is Below Current Recommendations

**File:** `main.py` (line 62), `security/auth.py` (line 54)

Production code uses 100,000 PBKDF2-SHA256 iterations. OWASP currently recommends 600,000+ for PBKDF2-HMAC-SHA256. The test suite uses 100 iterations (acceptable for CI speed).

This is not a functional bug, but it weakens the passphrase-derived key that protects the Recovery Seed. A roadmap-compatible project (especially one planning Remote Sync where encrypted data traverses the network) should target 600,000+ iterations.

**Roadmap impact:**
- **Roadmap item: Remote Sync** — Ledger files synced via git are encrypted, but the passphrase-derived wrapping of the seed is the outermost security layer. Weak KDF parameters lower the cost of offline brute-force against a stolen ledger backup.

**Recommendation:** Bump to 600,000 iterations for SHA-256. Consider `hashlib.scrypt` for memory-hard derivation as a stronger alternative (still stdlib, no new dependencies).

**Severity:** 🟡 Medium — weakens security for planned Remote Sync feature

**Resolution (2026-04-28, branch `R1-AES-CTR-Malleability`):**

Bumped production PBKDF2 iterations from 100,000 to 600,000 in `main.py` (2 locations) and `security/auth.py` (1 location):

- **Performance impact:** ~75ms additional latency on first authentication per session (negligible for CLI). Key is cached in RAM after first auth, so subsequent commands are unaffected.
- **Mobile guidance:** Future React Native / native mobile implementations MUST call PBKDF2 through a native crypto module (not JS thread) to avoid UI freezes. 600K iterations in native code completes in ~60-120ms.
- **scrypt considered:** Rejected for now — memory-hard derivation (16MB per call) adds complexity for mobile without immediate benefit. Documented as an acceptable alternative for future use.
- **Tests unchanged:** Test suite remains at 100 iterations for CI speed (acceptable per original design note).

---

### R4. No Entry-Level Integrity Check During Reconciliation

**File:** `core/ledger.py` (sync_day, verify), `core/factory.py` (initialize)

Currently, entry hashes are computed as:
```python
entry_hash = hashlib.sha256(json.dumps(entry["data"], sort_keys=True).encode()).hexdigest()
```
This covers the `data` dict (which includes encrypted fields). The `verify()` method checks these entry hashes against the stored `hash` field.

For **Reconciliation / Chain-Bridging**, the roadmap design says:
> *"Verify import: check each block's seal, then seal the bridge"*

This verification only checks block-level seals, not entry-level content. If orphaned blocks are re-keyed (re-encrypted with a new Master Key), the entry hashes change and the chain of trust for individual entries is broken. The current architecture has no mechanism to verify that a re-keyed entry's encrypted content is the *same* plaintext as the original.

**Recommendation:** Before implementing Reconciliation, add a design decision: will the bridge accept re-encrypted entries (verifying only block seals), or will it require a content-hash proof (e.g., storing a plaintext hash of `startTime_enc || endTime_enc || metadata_enc` before encryption)? The latter is more rigorous but requires a new field in every entry.

**Severity:** 🟡 Medium — must be resolved before Reconciliation implementation begins

---

## 🐛 Bugs & Functional Issues

### B1. `list_habits()` Decrypts Metadata Without Checking for `None`

**File:** `cli/interface.py` (`_print_entry`, line ~150)

```python
meta_enc = data.get("metadata_enc")
meta = json.loads(self.ledger.crypto.decrypt(meta_enc)) if meta_enc else {}
```

`data.get("metadata_enc")` could return an empty string `""` (falsy), which would correctly fall through to `{}`. But if it returns the string `"plain:{}"` from `NoAuthCryptoManager`, the `decrypt()` call on `NoAuthCryptoManager` strips the prefix and returns `"{}"` which `json.loads` handles fine. So this works in practice, but is fragile — the truthiness check doesn't distinguish between "no metadata" and "metadata is a falsy non-None value."

**Recommendation:** Use `if meta_enc is not None` instead of `if meta_enc`.

**Severity:** 🟢 Low — works in current code, but is a latent bug

---

### B2. `test_list_staged` Has a Misleading Comment

**File:** `tests/test_modular.py` (`test_list_staged`, line ~145)

```python
# With real CryptoManager, data is encrypted, not plain
# self.assertTrue(staging_data[0]["data"]["startTime_enc"].startswith("plain:"))
```

This commented-out assertion is confusing. Since `setUp()` uses a real `CryptoManager`, the staged data is encrypted (not `"plain:"`). The test is correct as-is, but the comment implies uncertainty about the encryption state.

**Recommendation:** Remove the commented-out lines and the misleading comment. Optionally add a positive assertion: `self.assertFalse(staging_data[0]["data"]["startTime_enc"].startswith("plain:"))`.

**Severity:** 🟢 Low — cosmetic, does not affect test correctness

---

## 🧹 Code Quality & Maintainability

### Q1. Hand-Rolled AES Is a Maintenance and Audit Burden

**File:** `security/crypto.py` (lines ~1-180)

The pure-Python AES-CTR implementation is ~180 lines of manually-optimized S-box, ShiftRows, MixColumns, and key expansion. This is impressive for a PoC, but:
- No side-channel resistance (timing attacks)
- Difficult to audit compared to using `Crypto.Cipher` from `pycryptodome` or Python's `cryptography` package
- The `SBOX` and `RCON` tables must be manually kept in sync with the algorithm specification

**Roadmap note:** The roadmap already acknowledges this in the "Zero-Dependency Commitment" dev note — the core engine must remain stdlib-only, but optional features can add dependencies. If/when `Real Ed25519 signatures` (🔮 Low) is implemented, that will require an external package anyway, at which point swapping to `cryptography`'s AES-GCM would be natural.

**Recommendation:** Add a `# TODO` comment at the top of `PureAESCTR` noting that this implementation is for zero-dep bootstrapping only and should be replaced with `cryptography`'s AES-GCM for production use.

**Severity:** 🟢 Low — acceptable per the project's zero-dep commitment

---

### Q2. `capture_habit()` Collision Check Is O(n) Per Addition

**File:** `core/ledger.py` (`capture_habit`, line ~15)

```python
for entry in staging:
    if entry.get("start_epoch") == start_epoch:
        raise ValueError("Collision detected...")
```

This iterates the entire staging list on every `add start`/`add oneoff` call. For a single-user CLI tool with <1000 entries, this is negligible. But for the planned multi-device sync or mobile interface, staging could grow large.

**Recommendation:** No action needed for current scale. Add a note for future optimization if staging grows (e.g., use a `set` of `start_epoch` values tracked in-memory).

**Severity:** 🟢 Low — not an issue at current scale

---

### Q3. Session File Has No Locking

**File:** `security/auth.py` (`_cache_key`, line ~70)

```python
self.SESSION_FILE.write_bytes(key)
self.SESSION_FILE.chmod(0o600)
```

No file lock is used when writing the session cache. Two concurrent `main.py` processes could race on read/write, potentially corrupting the cached key (though the key is deterministic from the seed, so both processes would write the same bytes — the risk is a partial write).

**Recommendation:** For a single-user CLI tool this is acceptable. If multi-process use is anticipated, add a flock-based write or use an atomic tempfile + rename pattern.

**Severity:** 🟢 Low — unlikely to manifest in single-user CLI usage

---

### Q4. `test_overlap_detection` Test Name Does Not Match the Concept

**File:** `tests/test_modular.py` (method `test_overlap_detection`)

The test checks for start-time collision detection. The method name `test_overlap_detection` is accurate but the word "overlap" implies time-range overlap (e.g., one task spanning another's duration), whereas the actual check is exact-epoch collision. The docstring correctly says "Collision should raise ValueError."

**Recommendation:** Rename to `test_collision_detection` for clarity. Cosmetic.

**Severity:** 🟢 Low — cosmetic

---

## Summary

| ID | Issue | Severity | Affects Roadmap Items |
|---|---|---|---|
| R1 | AES-CTR malleability (no auth tag) | 🔴 High | Reconciliation, Remote Sync |
| R2 | `identity.json` has no in-ledger fallback | 🔴 High | Single-file export, Remote Sync |
| R3 | PBKDF2 iteration count too low | 🟡 Medium | Remote Sync |
| R4 | No entry-level content proof for reconciliation | 🟡 Medium | Reconciliation |
| B1 | `list_habits` fragile metadata check | 🟢 Low | — |
| B2 | Misleading test comment | 🟢 Low | — |
| Q1 | Hand-rolled AES | 🟢 Low | Real Ed25519 (future) |
| Q2 | O(n) collision check | 🟢 Low | — |
| Q3 | Session file race condition | 🟢 Low | — |
| Q4 | Test naming nit | 🟢 Low | — |

**Key takeaway:** The only **roadblocks** to the current roadmap (🔜 High/Medium) are:
1. **R1** — AES-CTR malleability must be addressed before safe Reconciliation or Remote Sync over third-party infrastructure
2. **R2** — Identity file dependency must be resolved before Single-file export or Remote Sync
3. **R4** — A content-integrity design decision is needed before implementing Reconciliation
