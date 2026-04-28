# Roadmap Blocks — PH Ledger (phpoc)

> Issues that directly block or materially impact planned roadmap items.
> Cross-references [DESIGN_GOALS.md](DESIGN_GOALS.md) for affected design goals,
> [BACKLOG.md](BACKLOG.md) for details, and [ROADMAP.md](ROADMAP.md) for affected features.

---

## ~~🔴 R1 — AES-CTR Malleability (No Authentication Tag)~~ ✅ RESOLVED

**Backlog ID:** R1 (BACKLOG.md)

**Resolution (2026-04-28, branch `R1-AES-CTR-Malleability`):**

Implemented encrypt-then-MAC using HMAC-SHA256 within `CryptoManager.encrypt()` / `decrypt()` in `security/crypto.py`:

- **Approach:** HMAC-SHA256 tag over `(nonce || ciphertext)` using a derived integrity sub-key (`salt + b"-integrity"`). No new dependencies.
- **Why this over AES-GCM:** Preserves zero-dependency commitment. AES-GCM can replace this later (~20 lines) when optional dependencies are introduced (e.g., for Ed25519 signatures).
- **Format change:**
  - **Old:** `salt(16) + nonce(8) + ciphertext`
  - **New:** `salt(16) + nonce(8) + ciphertext + tag(32)`
- **Backward compatibility:** `decrypt()` detects format by byte-length. Old encrypted fields remain decryptable.
- **Tamper detection:** Raises `ValueError` on tag mismatch.

**What this unblocks:**
- ✅ Reconciliation / Chain-Bridging — auth tag prevents silent ciphertext corruption during re-keying
- ✅ Remote Sync (git-based) — encrypted fields are safe against intermediary tampering
- ✅ Shareable Export — entry-level integrity can be assured

All 16 existing tests pass. Manual tamper test confirms rejection.

**Remaining caveat:** Entry hashes still cover ciphertext, not plaintext (R4). The auth tag protects ciphertext integrity; plaintext content proofs remain a separate design decision for Reconciliation.

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

### Design Goals Impacted

| Goal | Impact |
|---|---|
| [Recovery & Identity](DESIGN_GOALS.md#5-recovery--identity) | Identity recovery is not possible; identity portability requires manual multi-file backup |
| [Cryptographic Integrity](DESIGN_GOALS.md#1-cryptographic-integrity--immutability) | Blocks after identity loss are unsigned, breaking the signature chain |

### Roadmap Items Blocked

| Roadmap Item | Priority | Why It's Blocked |
|---|---|---|
| **Single-file export** (`phpoc export --combined`) | 🔮 Low | The planned design merges identity into Genesis for portability. The current split-file design means users must back up two files. A ledger-only backup (`ledger.json`) is incomplete — the identity is orphaned. |
| **Remote Sync (git-based)** | 🔜 Medium | The roadmap design sketch says "commit as-is since it's already encrypted." If only `ledger.json` is synced (the natural git-commit pattern), pulling onto a new machine results in unsigned blocks. The receiving machine has no identity key. |
| **Real Ed25519 signatures** | 🔮 Low | Real Ed25519 keys are more sensitive than HMAC secrets — losing the private key is permanent. An in-ledger fallback becomes essential before real signatures can be safely adopted. |

### Resolution Path

1. **Embed a fallback copy** of the encrypted identity secret inside the genesis block's `identity` field (e.g., `identity_secret_enc_fallback`). The `init` flow already reads from `identity.json`; add a duplicate write into the genesis JSON. On `recover`, do the same. `_get_identity_secret()` would try `identity.json` first, then fall back to the genesis.
2. **Add a warning** on `init` that `identity.json` must be backed up.
3. **Optionally add** a `phpoc recover --regenerate-identity` sub-command that generates a new identity key, re-signs all existing blocks, and stores the new key in both `identity.json` and the genesis fallback.

---

## ~~🟡 R3 — PBKDF2 Iteration Count Below Current Standards~~ ✅ RESOLVED

**Backlog ID:** R3 (BACKLOG.md)

**Resolution (2026-04-28, branch `R1-AES-CTR-Malleability`):**

Bumped production PBKDF2 iterations from 100,000 to 600,000 in:
- `main.py` — `init` command (line 107) and `recover` command (line 140)
- `security/auth.py` — `PassphraseAuthenticator.authenticate()` (line 57)

**Performance impact:**
- CLI: ~75ms additional latency on first auth per session. Cached in RAM after first auth — subsequent commands have zero overhead.
- Mobile (future): PBKDF2 MUST be called through a native crypto module. 600K iterations in native iOS/Android code completes in ~60-120ms, which is acceptable.
- Test suite remains at 100 iterations for CI speed (acceptable per original design).

**scrypt tradeoff considered:**
- Memory-hard (N=2^14, r=8, p=1 requires ~16MB heap) — stronger against GPU/ASIC brute-force
- Rejected for now: adds complexity for mobile (heap allocation) without immediate need
- Documented as an acceptable future alternative

**What this unblocks:**
- ✅ Remote Sync (git-based) — PDK-wrapped seed now meets OWASP 2026 recommendations

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

### Design Goal Impacted

| Goal | Impact |
|---|---|
| [Cryptographic Integrity](DESIGN_GOALS.md#1-cryptographic-integrity--immutability) | No mechanism exists to verify plaintext content after re-encryption |

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
| **Reconciliation / Chain-Bridging** | 🔜 Medium | ~~R1~~ ✅, R4 (content proof design) |
| **Remote Sync (git-based)** | 🔜 Medium | ~~R1~~ ✅, R2 (identity fallback), ~~R3~~ ✅ |
| **Archival Automation** | 🔜 Medium | None |
| **Real Ed25519 signatures** | 🔮 Low | R2 (identity fallback — private key loss is permanent without in-ledger copy) |
| **Shareable Export** (`phpoc export --public`) | 🔮 Low | ~~R1~~ ✅ |
| **Single-file export** | 🔮 Low | R2 (identity fallback) |
| **Plausible deniability mode** | 🔮 Low | None |

### Quick Wins (No New Dependencies, Minimal Code)

1. ~~**R1 mitigation:**~~ ✅ Done — encrypt-then-MAC tag added to `CryptoManager.encrypt()` / `decrypt()`
2. ~~**R3 fix:**~~ ✅ Done — PBKDF2 iterations bumped to 600K
3. **R2 mitigation:** Embed encrypted identity secret in genesis block `identity` field (~5 lines in `factory.py` and `_get_identity_secret()`)

These changes unblock all current roadmap items except the R4 design decision for Reconciliation.
