# PH Ledger — Session Handoff

## Current State
- **Branch:** `main` — all blockers resolved, working tree clean
- **Tests:** 16/16 passing (test_modular: 12, test_hierarchy: 2, test_recovery: 2)
- **Dependencies:** Pure Python 3.x standard library — zero external deps

## Resolved Blockers (This Session)

All four roadmap blockers resolved across 3 branches, merged into `main`:

| Blocker | Resolution | Branch | Files Changed |
|---------|-----------|--------|--------------|
| **R1** — AES-CTR Malleability | Encrypt-then-MAC: HMAC-SHA256 tag over `(nonce \|\| ciphertext)` using derived integrity sub-key. Backward compat via byte-length detection. | `R1-AES-CTR-Malleability` | `security/crypto.py` |
| **R3** — PBKDF2 600K | Bumped iterations 100K → 600K in `main.py` (2 locs) and `security/auth.py`. Tests stay at 100 for CI speed. | `R1-AES-CTR-Malleability` | `main.py`, `security/auth.py` |
| **R2** — Identity Fallback | Embedded `identity_secret_enc_fallback` in genesis block. `_get_identity_secret()` tries `identity.json` first, falls back to genesis. `recover` handler updates fallback. | `R2-identity-fallback` | `core/factory.py`, `core/ledger.py`, `main.py` |
| **R4** — Content Proof | Chose Option 2 (plaintext content hash). New `_compute_content_hash()` method. Sync flows resolve plaintext before encryption, compute hash, then encrypt. `verify()` checks `content_hash` when present. | `R4-content-proof-design` | `core/ledger.py` |

## Crypto Architecture Checklist
| Feature | Status | Notes |
|---|---|---|
| Sovereign Key Model (Seed → Master Key) | ✅ | Seed generated from 32 bytes urandom |
| Passphrase wraps Seed (PDK encrypted) | ✅ | PBKDF2(passphrase, "session-salt") at **600K iterations** (OWASP 2026) |
| Identity Ed25519-proxy (HMAC-SHA256) | ✅ | Secret encrypted with Master Key; fallback in genesis |
| Block signing (all block types) | ✅ | Genesis, Day, Month/Year Summary |
| Encrypted timestamps (start/end) | ✅ | AES-CTR with unique nonce per field + HMAC-SHA256 auth tag |
| Encrypt-then-MAC (auth tag) | ✅ | Added — tampered ciphertext raises ValueError |
| Plaintext content hash (content_hash) | ✅ | Per-entry SHA-256 of canonical plaintext fields; survives re-encryption |
| Blind duration index (index.json) | ✅ | Fast rep queries without decryption |
| Session RAM cache (/dev/shm) | ✅ | One auth per boot |

## Chain Structure
```
Genesis (sealed + signed, identity fallback embedded)
  └── Year Summary (sealed + signed)
        └── Month Summary (sealed + signed)
              └── Day (sealed + signed)
                    └── Entries (hashed individually + content_hash)
```

## CLI Commands
| Command | Auth Required | Description |
|---|---|---|
| `init` | No | Creates ledger + identity + seed |
| `recover` | No (seed) | Seed-based passphrase reset |
| `add start <title>` | Optional | Starts active task |
| `add end <title>` | Optional | Ends active task |
| `add oneoff` | Optional | Captures completed task |
| `view` | Optional | Shows running tasks |
| `sync` | Yes | Commits staging → immutable ledger |
| `verify` | Yes | Full chain integrity check (incl. content_hash) |
| `rep [days] [--from] [--to]` | Yes | Blind-index reputation summary |
| `list {all,synced,staged} [days]...` | Yes | Decrypted detailed listing |

## Roadmap — All Unblocked

| Item | Priority | Notes |
|------|----------|-------|
| **Media Witness linkage** | 🔜 High | Link content hashes to activities. No blockers. |
| **Reconciliation / Chain-Bridging** | 🔜 Medium | R1+R4 resolved. content_hash enables plaintext verification after re-keying. |
| **Remote Sync (git-based)** | 🔜 Medium | R1+R2+R3 resolved. Encrypted fields have auth tags; identity travels with ledger; KDF meets OWASP. |
| **Archival Automation** | 🔜 Medium | `phpoc archive --year X`. No blockers. |
| **Real Ed25519 signatures** | 🔮 Low | R2 resolved — key loss no longer permanent. |
| **Shareable Export** | 🔮 Low | R1 resolved — entry-level integrity assured. |
| **Single-file export** | 🔮 Low | R2 resolved — identity in genesis. |

## Architecture Notes
- Cloud-folder sync strategy preferred (Dropbox/iCloud/etc) — no provider-specific code needed
- Storage layer already abstracted via `AbstractLedgerStore`
- `NoAuthCryptoManager` unchanged (local per-device staging convenience)

See `CHANGELOG.md` for full history and `ROADMAP.md` / `ROADMAP-BLOCKS.md` for detailed planning.
