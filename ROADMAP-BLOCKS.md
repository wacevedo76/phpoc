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

## ~~🔴 R2 — Identity File (`identity.json`) Has No In-Ledger Fallback~~ ✅ RESOLVED

**Backlog ID:** R2 (BACKLOG.md)

**Resolution (2026-04-28, branch `R2-identity-fallback`):**

Embedded a copy of the encrypted identity secret inside the genesis block's `identity.identity_secret_enc_fallback` field:

- **`core/factory.py`:** During `init`, writes `encrypted_identity` to both `identity.json` and the new `identity_secret_enc_fallback` field in genesis.
- **`core/ledger.py` (`_get_identity_secret()`):** Tries `identity.json` → decrypt. Falls back to genesis fallback → decrypt. Returns `None` if neither exists (graceful degradation).
- **`main.py` (`recover` handler):** Reads the encrypted identity from `identity.json` and copies it into the genesis fallback during re-seal.
- **Existing ledgers:** No migration needed. If the fallback field is absent, `_get_identity_secret()` simply returns `None` as before. New `init` or `recover` on upgraded code populates it.
- **All 16 tests pass.** Manual test confirms all three paths: normal, fallback, and absent.

**What this unblocks:**
- ✅ Single-file export — identity can be reconstructed from genesis alone
- ✅ Remote Sync (git-based) — syncing `ledger.json` carries identity
- ✅ Real Ed25519 signatures — private key loss no longer fatal

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

## ~~🟡 R4 — No Entry-Level Content Proof for Reconciliation~~ ✅ RESOLVED

**Backlog ID:** R4 (BACKLOG.md)

**Resolution (2026-04-28, branch `R4-content-proof-design`):**

Chose **Option 2 (plaintext content hash proof)** — the rigorous approach:

- **`_compute_content_hash()`** — New static method that hashes a canonical dict of resolved plaintext fields (title, start epoch, end epoch, metadata JSON, pauses JSON, tags, comment, media, duration).
- **`sync_day()` / `sync_day_with_selection()`** — Both now resolve plaintext values *before* encryption, compute the `content_hash` from them, then encrypt. The `content_hash` field is stored in entry data and covered by the entry hash.
- **`verify()`** — Extended to verify `content_hash` on entries that have it. Decrypts encrypted fields, reconstructs the canonical plaintext dict, and compares hashes. Old entries without `content_hash` are silently skipped.
- **Format:** New `content_hash` field (64 hex chars) in each synced entry's data dict.
- **Overhead:** ~64 bytes per entry. Negligible at realistic scale (~2MB over 10 years at 20 entries/day).
- **Backward compatible:** Old entries lack `content_hash` but continue to verify with existing checks.
- **Reconciliation path:** When grafting orphaned blocks, decrypt entry fields and check `content_hash` to prove plaintext integrity. Re-keying changes entry hash but `content_hash` remains valid.

All 16 tests pass. Manual tamper test confirms `content_hash` mismatch is detected.

---

## Summary

| Roadmap Item | Priority | Blockers |
|---|---|---|
| **Media Witness linkage** | 🔜 High | None |
| **Reconciliation / Chain-Bridging** | 🔜 Medium | ~~R1~~ ✅, ~~R4~~ ✅ — unblocked |
| **Remote Sync (git-based)** | 🔜 Medium | ~~R1~~ ✅, ~~R2~~ ✅, ~~R3~~ ✅ |
| **Archival Automation** | 🔜 Medium | None |
| **Real Ed25519 signatures** | 🔮 Low | ~~R2~~ ✅ — no longer blocked |
| **Shareable Export** (`phpoc export --public`) | 🔮 Low | ~~R1~~ ✅ |
| **Single-file export** | 🔮 Low | ~~R2~~ ✅ — identity embedded in genesis |
| **Plausible deniability mode** | 🔮 Low | None |
| **Multi-device staging sync** | 🔜 Medium | Phase 2 ✅ — `StagingService` + `MergeEngine` + `DeviceIdentityProvider` |
| **Ledger Engine refactor** | 🔜 Medium | Phase 3 ✅ — 5 files in `domain/ledger/` (chain, engine, index, summaries) |
| **Sync Orchestrator** | 🔮 Low | Phase 4 ✅ — `core/sync/` package: orchestrator, decision, transport |

### Quick Wins (No New Dependencies, Minimal Code) — ✅ All Done

1. ~~**R1 (AES-CTR auth tag):**~~ ✅ Done — encrypt-then-MAC
2. ~~**R3 (PBKDF2 600K):**~~ ✅ Done — iterations bumped
3. ~~**R2 (identity fallback):**~~ ✅ Done — genesis fallback
4. ~~**R4 (content proof):**~~ ✅ Done — plaintext content hash
5. ~~**Multi-device staging:**~~ ✅ Done — Phase 2: `domain/staging/` + `security/device_identity.py`

All four roadmap blockers are resolved. All roadmap items are now **unblocked**. Architectural migration is through Phase 4 (31 files, 779 tests, 0 regressions).
