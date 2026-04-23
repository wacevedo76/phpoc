# Roadmap Blocks — PH Ledger (phpoc)

> Issues that directly block or materially impact planned roadmap items.
> Cross-references `BACKLOG.md` for details and `ROADMAP.md` for affected features.

---

## 🔴 R1 — AES-CTR Malleability (No Authentication Tag)

**Backlog ID:** R1 (BACKLOG.md)

### The Problem

The `PureAESCTR` implementation in `security/crypto.py` encrypts data fields (`startTime_enc`, `endTime_enc`, `metadata_enc`) using AES-CTR mode **without an authentication tag**. AES-CTR is a stream cipher mode — ciphertext can be bit-flipped to predictably alter the decrypted plaintext. There is no integrity check on individual encrypted fields.

### Why It Worked Until Now

Block-level HMAC seals (`day_hash`, `month_hash`, `year_hash`) provide integrity for the ledger **structure** — the JSON blob that gets sealed includes the ciphertext as-is. If someone tampers with a ciphertext byte, the block seal breaks and `verify()` catches it.

However, the **entry hash** (`entry["hash"] = sha256(json.dumps(entry["data"]))`) is computed **after** encryption. This means:
- The entry hash covers the ciphertext, not the plaintext
- A manipulated ciphertext still matches its own entry hash
- The block seal covers the entry hash + ciphertext — so the block remains valid

The plaintext can be silently corrupted and the block will still verify.

### Roadmap Items Blocked

| Roadmap Item | Priority | Why It's Blocked |
|---|---|---|
| **Reconciliation / Chain-Bridging** | 🔜 Medium | Orphaned blocks being grafted in may be re-keyed (re-encrypted). Entry hashes change on re-encryption, so the plaintext content of re-keyed entries cannot be verified against the originals without an authentication tag. |
| **Remote Sync (git-based)** | 🔜 Medium | Ledger files synced via git traverse third-party infrastructure (GitHub/GitLab, CDN, mirror servers). AES-CTR malleability means a malicious intermediary could corrupt encrypted timestamps without breaking block-level seals. The user decrypts silently wrong data. |

### Resolution Path

1. **Short-term (zero-dep compatible, minimal change):** Use encrypt-then-MAC within the existing `CryptoManager.encrypt()` output — append an HMAC-SHA256 tag over `(nonce || ciphertext)` using a derived integrity sub-key. Verify on decrypt. This adds ~36 bytes per encrypted field and no new dependencies.
2. **Long-term (when dep constraint is relaxed):** Replace `PureAESCTR` with `cryptography`'s AES-GCM (authenticated encryption, zero additional code).

---

## 🔴 R2 — Identity File (`identity.json`) Has No In-Ledger Fallback

**Backlog ID:** R2 (BACKLOG.md)

### The Problem

The identity secret (32-byte Ed25519-proxy signing key) is stored **only** in `identity.json`, a separate file alongside `ledger.json`. It is encrypted with the Master Key (derived from the Recovery Seed). During `recover`, the seed and passphrase are updated but `identity.json` is **never touched** — this works because the Master Key doesn't change.

If `identity.json` is lost or corrupted:
- The Master Key still works (seed → MK), so existing blocks remain decryptable
- `_get_identity_secret()` returns `None` → `sync_day()` appends **unsigned** blocks
- The ledger transitions from signed blocks to unsigned blocks mid-chain
- Signature verification for old blocks is permanently broken (secret is gone)
- No recovery path exists within the current design

### Roadmap Items Blocked

| Roadmap Item | Priority | Why It's Blocked |
|---|---|---|
| **Single-file export** (`phpoc export --combined`) | 🔮 Low | The planned design merges identity into Genesis for portability. The current split-file design means users must back up two files. A ledger-only backup (`ledger.json`) is incomplete — the identity is orphaned. |
| **Remote Sync (git-based)** | 🔜 Medium | The roadmap design sketch says "commit as-is since it's already encrypted." If only `ledger.json` is synced (the natural git-commit pattern), pulling onto a new machine results in unsigned blocks. The receiving machine has no identity key. |

### Resolution Path

1. **Embed a fallback copy** of the encrypted identity secret inside the genesis block's `identity` field (e.g., `identity_secret_enc_fallback`). The `init` flow already reads from `identity.json`; add a duplicate write into the genesis JSON. On `recover`, do the same. `_get_identity_secret()` would try `identity.json` first, then fall back to the genesis.
2. **Add a warning** on `init` that `identity.json` must be backed up.
3. **Optionally add** a `phpoc recover --regenerate-identity` sub-command that generates a new identity key, re-signs all existing blocks, and stores the new key in both `identity.json` and the genesis fallback.

---

## 🟡 R3 — PBKDF2 Iteration Count Below Current Standards

**Backlog ID:** R3 (BACKLOG.md)

### The Problem

The production code uses **100,000** iterations of PBKDF2-HMAC-SHA256 to derive the passphrase key (PDK) that wraps the Recovery Seed.

Current OWASP recommendation: **600,000+ iterations** for PBKDF2-HMAC-SHA256.
NIST SP 800-132: recommends at least 10,000 (2010-era guidance, now considered low).

The test suite uses 100 iterations, which is fine for CI performance.

### Roadmap Item Affected

| Roadmap Item | Priority | Why It's an Issue |
|---|---|---|
| **Remote Sync (git-based)** | 🔜 Medium | Encrypted ledger files pushed to a git remote are exposed to the repository host (GitHub, GitLab, etc.). The outermost layer of defense is the PDK-wrapped seed. With only 100K iterations, offline brute-force against a stolen ledger backup is ~6x cheaper than it should be per current standards. |

### Resolution Path

1. Bump production iterations from `100,000` to `600,000` (or higher). This adds ~10-20ms to `init` and first authentication each boot — negligible for UX.
2. Consider `hashlib.scrypt` (stdlib, memory-hard) as a stronger alternative. A scrypt target of `N=2^14, r=8, p=1` would add significant memory cost to brute-force while still being stdlib-only.

---

## 🟡 R4 — No Entry-Level Content Proof for Reconciliation

**Backlog ID:** R4 (BACKLOG.md)

### The Problem

The current architecture computes entry hashes as:
```python
entry_hash = sha256(json.dumps(entry["data"], sort_keys=True))
```
Where `entry["data"]` includes the **encrypted** fields (`startTime_enc`, `endTime_enc`, `metadata_enc`). This means the entry hash is a hash of ciphertext, not plaintext.

For the designed Reconciliation flow ("Bridge" block linking orphaned chain), block-level seals are verified. But:

- If orphaned entries are re-encrypted with a new Master Key (re-keying), the entry hash changes
- The new hash breaks any pre-existing chain-of-trust for individual entries
- The current `verify()` entry-hash loop cannot distinguish between "content was re-keyed" and "content was tampered with"

### Roadmap Item Blocked

| Roadmap Item | Priority | Why It's Blocked |
|---|---|---|
| **Reconciliation / Chain-Bridging** | 🔜 Medium | The roadmap says "Verify import: check each block's seal, then seal the bridge." This is insufficient for re-keyed entries — block-level verification alone cannot prove that re-encrypted entries contain the original plaintext. A content-integrity design decision is required before implementation begins. |

### Resolution Path

Before implementing Reconciliation, decide on one of:

1. **Import-only (no re-keying):** Orphaned blocks are imported as-is, without re-encryption. The Master Key must be the same. Simple but limits use cases.
2. **Plaintext content hash proof:** Store a SHA-256 hash of the pre-encryption plaintext (`startTime_enc || endTime_enc || metadata_enc` + nonce exclusion) as a new field in each entry. When re-keying, re-compute the entry hash and verify against the stored plaintext hash. This is the rigorous approach.
3. **Trust the bridge block:** Accept that block-level seals are sufficient. The bridge block attests "I verified these blocks were valid before re-keying." Weaker assurance but simpler.

---

## Summary

| Roadmap Item | Priority | Blockers |
|---|---|---|
| **Media Witness linkage** | 🔜 High | None |
| **Reconciliation / Chain-Bridging** | 🔜 Medium | R1 (AES-CTR malleability), R4 (content proof design) |
| **Remote Sync (git-based)** | 🔜 Medium | R1 (AES-CTR malleability), R2 (identity fallback), R3 (KDF strength) |
| **Archival Automation** | 🔜 Medium | None |
| **Single-file export** | 🔮 Low | R2 (identity fallback) |
| **Real Ed25519 signatures** | 🔮 Low | None (independent of these issues) |
| **Plausible deniability mode** | 🔮 Low | None |

### Quick Wins (No New Dependencies, Minimal Code)

1. **R3 fix:** Bump PBKDF2 iterations to 600K (one constant change in `main.py` and `auth.py`)
2. **R1 mitigation:** Add encrypt-then-MAC tag to `CryptoManager.encrypt()` output (~30 lines, HMAC-SHA256, no new deps)
3. **R2 mitigation:** Embed encrypted identity secret in genesis block `identity` field (~5 lines in `factory.py` and `_get_identity_secret()`)

These three changes unblock all current roadmap items except the R4 design decision for Reconciliation.
